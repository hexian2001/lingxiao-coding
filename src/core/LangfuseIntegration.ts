/**
 * LangfuseIntegration — Langfuse 可观测性集成核心模块
 *
 * 职责：
 * - 初始化 OpenTelemetry SDK + LangfuseSpanProcessor
 * - 设置全局 undici 代理 dispatcher（解决 Node fetch 不读 HTTP_PROXY 的问题）
 * - 提供 recordGeneration 供 LlmGuard 注入 LLM 调用追踪
 * - 提供 recordAgentLifecycle 供 agent pool 注入生命周期事件
 * - 配置热加载（onConfigReload 回调）
 * - 错误隔离：SDK 故障不影响主流程
 *
 * 设计约束：
 * - enabled=false 时不初始化任何 OTel 组件，零副作用
 * - 所有 SDK 调用包裹在 try/catch 中，异常只记录不抛出
 * - 遵循 Langfuse skill 最佳实践：
 *   - 使用 startActiveObservation + asType: 'generation' 正确标记 observation 类型
 *   - 使用 propagateAttributes 设置 session_id / user_id / tags 传播到所有子 span
 *   - span 正确 end()（startActiveObservation 的 endOnExit 默认 true，但需确保 async 回调正确 await）
 *   - flush() 在 shutdown 时调用
 */

import { createRequire } from 'module';
import { coreLogger } from './Log.js';
import { getConfigValue } from '../config.js';
import type { EventEmitter } from './EventEmitter.js';
import { randomUUID } from 'crypto';

// ESM 环境下 require 不可用，通过 createRequire 兼容
const require = createRequire(import.meta.url);

export type LangfuseIntegrationStatus = 'uninitialized' | 'active' | 'disabled' | 'shutdown' | 'error';

export interface LangfuseConfig {
  enabled: boolean;
  baseUrl: string;
  secretKey: string;
  publicKey: string;
  traceLlmCalls: boolean;
  traceToolCalls: boolean;
  traceAgentLifecycle: boolean;
  sampleRate: number;
  maskSensitive: boolean;
  scoreEnabled: boolean;
}

export interface LangfuseGenerationParams {
  model: string;
  status: 'ok' | 'error';
  latencyMs: number;
  input?: unknown;
  output?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  errorKind?: string;
  actor?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface LangfuseAgentLifecycleParams {
  event: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface LangfuseToolCallParams {
  toolName: string;
  args?: unknown;
  status: 'ok' | 'error';
  latencyMs: number;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  sessionId?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface LangfuseScoreParams {
  taskId?: string;
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  score: number;
  comment?: string;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalTraceEntry {
  id: string;
  timestamp: string;
  actor: string;
  model: string;
  status: 'ok' | 'error';
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorKind?: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  toolName?: string;
  entryType?: 'generation' | 'tool_call' | 'agent_lifecycle';
}

class LangfuseIntegrationImpl {
  private status: LangfuseIntegrationStatus = 'uninitialized';
  private sdk: unknown = null;
  private config: LangfuseConfig | null = null;
  private proxyDispatcherSet = false;
  /** In-memory ring buffer for local trace viewing (real-time, no remote round-trip) */
  private traceBuffer: LocalTraceEntry[] = [];
  private static TRACE_BUFFER_MAX = 500;
  /** Emitter reference for real-time SSE push */
  private emitter: EventEmitter | null = null;

  /**
   * 设置全局 undici 代理 dispatcher。
   *
   * Node.js 原生 fetch (undici) 不读 HTTP_PROXY/HTTPS_PROXY 环境变量。
   * LangfuseSpanProcessor 内部用 fetch 发送 trace 数据，因此需要
   * 通过 setGlobalDispatcher 注入代理。
   *
   * EnvHttpProxyAgent 自动读取 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量。
   * 如果没有代理环境变量，EnvHttpProxyAgent 等效于默认 dispatcher（直连）。
   */
  private setupProxyDispatcher(): void {
    if (this.proxyDispatcherSet) return;
    try {
      // Sync env vars from lingxiao proxy config so EnvHttpProxyAgent picks them up.
      // EnvHttpProxyAgent reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY at construction time.
      const { getConfiguredProxyUrl, getConfiguredNoProxy } = require('./ProxyConfig.js');
      // Langfuse 是 LLM 可观测性服务，优先使用 tools 代理，fallback 到 llm 代理
      const proxyUrl = getConfiguredProxyUrl('tools') || getConfiguredProxyUrl('llm');
      if (proxyUrl) {
        if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = proxyUrl;
        if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = proxyUrl;
        const noProxy = getConfiguredNoProxy();
        if (noProxy && !process.env.NO_PROXY) process.env.NO_PROXY = noProxy;
        coreLogger.info(`[Langfuse] Proxy env synced from config: ${proxyUrl}`);
      }

      const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
      setGlobalDispatcher(new EnvHttpProxyAgent());
      this.proxyDispatcherSet = true;
      coreLogger.info('[Langfuse] Global undici proxy dispatcher set (EnvHttpProxyAgent)');
    } catch {
      // undici not available or already set — non-fatal
      coreLogger.warn('[Langfuse] Failed to set proxy dispatcher, falling back to direct fetch');
    }
  }

  /**
   * 初始化 OTel SDK + Langfuse SpanProcessor
   */
  init(config: LangfuseConfig): void {
    if (!config.enabled) {
      this.status = 'disabled';
      return;
    }
    if (!config.secretKey || !config.publicKey) {
      coreLogger.warn('[Langfuse] enabled but missing secretKey/publicKey, staying disabled');
      this.status = 'disabled';
      return;
    }

    try {
      // Set environment variables for LangfuseSpanProcessor
      process.env.LANGFUSE_SECRET_KEY = config.secretKey;
      process.env.LANGFUSE_PUBLIC_KEY = config.publicKey;
      process.env.LANGFUSE_BASE_URL = config.baseUrl || 'https://cloud.langfuse.com';

      // Set up global proxy dispatcher BEFORE initializing OTel SDK,
      // so that LangfuseSpanProcessor's internal fetch calls go through proxy.
      this.setupProxyDispatcher();

      // Dynamic import to avoid loading OTel when disabled
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      const { LangfuseSpanProcessor } = require('@langfuse/otel');

      // 内存优化：限制 OTel BatchSpanProcessor 的 queue 上限和 flush 频率。
      // 默认 maxQueueSize=2048、每 5s flush，在多进程（daemon + N 个 worker）叠加下
      // 会缓存大量含完整 messages/args 的大 span → 内存堆积 → OOM kill。
      // 设较小的 flushAt（每次导出 25 个 span）和 flushInterval（1s），加快释放。
      if (!process.env.OTEL_BSP_MAX_QUEUE_SIZE) {
        process.env.OTEL_BSP_MAX_QUEUE_SIZE = '200';
      }
      const processor = new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl || 'https://cloud.langfuse.com',
        // Use immediate export mode for short-lived processes (CLI commands),
        // batched mode for long-running daemon. We detect via process type.
        exportMode: process.env.LINGXIAO_DAEMON === 'true' ? 'batched' : 'immediate',
        flushAt: 25,        // 每 25 个 span 导出一次（默认 512），减少内存驻留
        flushInterval: 1,   // 每 1 秒导出一次（默认 5s），加快释放
      });

      const sdk = new NodeSDK({
        spanProcessors: [processor],
      });
      sdk.start();
      this.sdk = sdk;
      this.config = config;
      this.status = 'active';

      coreLogger.info(`[Langfuse] Initialized — baseUrl=${config.baseUrl}, sampleRate=${config.sampleRate}, traceLlm=${config.traceLlmCalls}, traceAgent=${config.traceAgentLifecycle}`);
    } catch (e) {
      coreLogger.error(`[Langfuse] Init failed: ${e instanceof Error ? e.message : String(e)}`);
      this.status = 'error';
    }
  }

  /**
   * 优雅关闭，flush 残留 span
   */
  async shutdown(): Promise<void> {
    if (this.sdk && typeof (this.sdk as any).shutdown === 'function') {
      try {
        await (this.sdk as any).shutdown();
      } catch {
        // non-fatal
      }
    }
    this.sdk = null;
    this.status = 'shutdown';
  }

  /**
   * 强制 flush 所有待发送的 span
   */
  async flush(): Promise<void> {
    if (this.sdk && typeof (this.sdk as any).forceFlush === 'function') {
      try {
        await (this.sdk as any).forceFlush();
      } catch {
        // non-fatal
      }
    }
  }

  /**
   * 配置热加载回调
   */
  onReload(config: LangfuseConfig): void {
    const wasEnabled = this.status === 'active';
    const nowEnabled = config.enabled && !!config.secretKey && !!config.publicKey;

    if (wasEnabled && !nowEnabled) {
      coreLogger.info('[Langfuse] Config changed, shutting down');
      this.shutdown();
      return;
    }

    if (!wasEnabled && nowEnabled) {
      coreLogger.info('[Langfuse] Config changed, initializing');
      this.init(config);
      return;
    }

    if (wasEnabled && nowEnabled) {
      const old = this.config;
      if (old && (old.secretKey !== config.secretKey || old.publicKey !== config.publicKey || old.baseUrl !== config.baseUrl)) {
        coreLogger.info('[Langfuse] Credentials changed, reinitializing');
        this.shutdown().then(() => this.init(config));
      }
    }

    this.config = config;
  }

  /**
   * 设置全局 emitter 引用，用于实时推送 trace 事件到 SSE
   */
  setEmitter(emitter: EventEmitter): void {
    this.emitter = emitter;
  }

  /**
   * 获取本地 trace buffer（最近 TRACE_BUFFER_MAX 条）
   */
  getLocalTraces(limit = 100, sessionIdFilter?: string): LocalTraceEntry[] {
    const filtered = sessionIdFilter
      ? this.traceBuffer.filter(t => t.sessionId === sessionIdFilter)
      : this.traceBuffer;
    return filtered.slice(-limit).reverse();
  }

  /**
   * 获取本地 trace 统计
   */
  getLocalStats(): { total: number; errorCount: number; avgLatencyMs: number; totalTokens: number } {
    const total = this.traceBuffer.length;
    const errorCount = this.traceBuffer.filter(t => t.status === 'error').length;
    const latencies = this.traceBuffer.map(t => t.latencyMs).filter(l => l > 0);
    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((s, l) => s + l, 0) / latencies.length : 0;
    const totalTokens = this.traceBuffer.reduce((s, t) => s + t.totalTokens, 0);
    return { total, errorCount, avgLatencyMs, totalTokens };
  }

  /**
   * 当前状态
   */
  getStatus(): LangfuseIntegrationStatus {
    return this.status;
  }

  /**
   * 记录 LLM generation（供 LlmGuard 调用）
   *
   * 使用 @langfuse/tracing 的 startActiveObservation + asType: 'generation'
   * 正确标记 observation 类型为 generation（Langfuse 最佳实践）。
   * 使用 propagateAttributes 设置 sessionId/userId/tags 传播到所有子 span。
   */
  async recordGeneration(params: LangfuseGenerationParams): Promise<void> {
    // ── Local buffer + SSE push ALWAYS runs, even if OTel SDK failed ──
    // Local observability must not depend on external service availability.
    this.recordLocalTrace(params);

    if (this.status !== 'active') {
      coreLogger.info(`[Langfuse] recordGeneration SKIP remote: status=${this.status}`);
      return;
    }
    if (!this.config?.traceLlmCalls) {
      coreLogger.info('[Langfuse] recordGeneration SKIP remote: traceLlmCalls=false');
      return;
    }
    coreLogger.info(`[Langfuse] recordGeneration CALLED: model=${params.model}, actor=${params.actor}, status=${params.status}, hasUsage=${!!params.usage}, sessionId=${params.sessionId ?? 'none'}`);

    // Sampling
    if (this.config.sampleRate < 1.0 && Math.random() > this.config.sampleRate) return;

    // Truncate large payloads (LLM message history, tool args) to prevent
    // OTel BatchSpanProcessor queue memory buildup → OOM in multi-process setups.
    // 先截断再脱敏，减少脱敏递归的数据量。
    let input = this.truncatePayload(params.input);
    let output = this.truncatePayload(params.output);
    // Mask sensitive info if configured
    if (this.config.maskSensitive) {
      input = this.maskSensitive(input);
      output = this.maskSensitive(output);
    }

    try {
      const { startActiveObservation, propagateAttributes } = require('@langfuse/tracing');

      // startTime: set to when the LLM call started (now - latencyMs) so the
      // span duration correctly reflects the actual LLM call latency.
      const startTime = new Date(Date.now() - params.latencyMs);

      // CRITICAL: startActiveObservation MUST be called inside propagateAttributes
      // callback. propagateAttributes sets trace-level context (sessionId, userId,
      // tags, traceName) in the OTel async context. If startActiveObservation is
      // called outside the callback, the observation is created without a parent
      // trace → session/model/usage all become orphaned and Langfuse shows 0.
      const traceAttrs = {
        sessionId: params.sessionId,
        userId: params.agentId,
        tags: ['llm-call'],
        traceName: `llm-${params.actor || 'unknown'}`,
      };

      const doObserve = async (): Promise<void> => {
        await startActiveObservation(
          `llm-generation-${params.actor || 'unknown'}`,
          async (generation: any) => {
            generation.update({
              input,
              output,
              model: params.model,
              level: params.status === 'error' ? 'ERROR' : 'DEFAULT',
              statusMessage: params.errorKind || undefined,
              metadata: {
                actor: params.actor,
                sessionId: params.sessionId,
                agentId: params.agentId,
                taskId: params.taskId,
                latencyMs: params.latencyMs,
                errorKind: params.errorKind,
                ...params.metadata,
              },
              usageDetails: params.usage ? {
                input: params.usage.promptTokens ?? 0,
                output: params.usage.completionTokens ?? 0,
                total: params.usage.totalTokens ?? 0,
              } : undefined,
            });
          },
          { asType: 'generation', endOnExit: true, startTime },
        );
      };

      // If we have session/agent context, wrap the observation in propagateAttributes
      // so the trace gets proper session_id, user_id, tags, and trace name.
      if (params.sessionId || params.agentId) {
        try {
          // propagateAttributes may accept sync or async callback;
          // we pass an async callback and await the result.
          const result = propagateAttributes(traceAttrs, doObserve);
          if (result instanceof Promise) {
            await result;
          }
        } catch (e) {
          // If propagateAttributes fails, fall back to bare observation
          coreLogger.warn(`[Langfuse] propagateAttributes failed, falling back to bare observation: ${e instanceof Error ? e.message : String(e)}`);
          await doObserve();
        }
      } else {
        // No session context — just create the observation
        await doObserve();
      }
    } catch (e) {
      coreLogger.error(`[Langfuse] recordGeneration FAILED: ${e instanceof Error ? e.message : String(e)}`);
      // trace errors are non-fatal
    }
  }

  /**
   * Write trace to local ring buffer and emit SSE event.
   * This runs regardless of OTel/remote status — local observability
   * must not depend on external service availability.
   */
  private recordLocalTrace(params: LangfuseGenerationParams): void {
    try {
      const entry: LocalTraceEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        actor: params.actor || 'unknown',
        model: params.model,
        status: params.status,
        latencyMs: params.latencyMs,
        inputTokens: params.usage?.promptTokens ?? 0,
        outputTokens: params.usage?.completionTokens ?? 0,
        totalTokens: params.usage?.totalTokens ?? 0,
        errorKind: params.errorKind,
        agentId: params.agentId,
        taskId: params.taskId,
        sessionId: params.sessionId,
      };

      // Ring buffer: trim oldest when exceeding max
      this.traceBuffer.push(entry);
      if (this.traceBuffer.length > LangfuseIntegrationImpl.TRACE_BUFFER_MAX) {
        this.traceBuffer.shift();
      }

      // Emit to SSE bridge for real-time push
      if (this.emitter && params.sessionId) {
        this.emitter.emit('langfuse:trace', {
          sessionId: params.sessionId,
          trace: entry,
        });
      }
    } catch {
      // local buffer errors are non-fatal
    }
  }

  /**
   * 记录 Agent 生命周期事件
   *
   * 使用 startActiveObservation + asType: 'agent' 标记为 agent observation。
   * 在 agent 启动/完成/失败时调用。
   */
  async recordAgentLifecycle(params: LangfuseAgentLifecycleParams): Promise<void> {
    if (this.status !== 'active') return;
    if (!this.config?.traceAgentLifecycle) return;

    // Sampling
    if (this.config.sampleRate < 1.0 && Math.random() > this.config.sampleRate) return;

    try {
      const { startActiveObservation, propagateAttributes } = require('@langfuse/tracing');

      const isError = params.event === 'failed' || params.event === 'crashed' || params.event === 'terminated';

      const doObserve = async (): Promise<void> => {
        await startActiveObservation(
          `agent-${params.event}`,
          async (agent: any) => {
            agent.update({
              input: { event: params.event, agentName: params.agentName },
              output: params.metadata,
              level: isError ? 'ERROR' : 'DEFAULT',
              metadata: {
                agentId: params.agentId,
                agentName: params.agentName,
                taskId: params.taskId,
                sessionId: params.sessionId,
                event: params.event,
                ...params.metadata,
              },
            });
          },
          { asType: 'agent', endOnExit: true },
        );
      };

      // Same fix as recordGeneration: wrap observation inside propagateAttributes
      // so trace gets proper session_id, user_id, tags, and trace name.
      if (params.sessionId || params.agentId) {
        try {
          const result = propagateAttributes(
            {
              sessionId: params.sessionId,
              userId: params.agentId,
              tags: [`agent-${params.event}`],
              traceName: `agent-${params.agentName || params.agentId || 'unknown'}`,
            },
            doObserve,
          );
          if (result instanceof Promise) {
            await result;
          }
        } catch {
          await doObserve();
        }
      } else {
        await doObserve();
      }
    } catch {
      // trace errors are non-fatal
    }
  }

  /**
   * 记录工具调用（供 BaseAgentRuntime.executeToolCall 调用）
   */
  async recordToolCall(params: LangfuseToolCallParams): Promise<void> {
    // ── Local buffer ALWAYS ──
    try {
      const entry: LocalTraceEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        actor: params.agentName || params.agentId || 'unknown',
        model: 'tool',
        status: params.status,
        latencyMs: params.latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        errorKind: params.errorMessage,
        agentId: params.agentId,
        taskId: params.taskId,
        sessionId: params.sessionId,
        toolName: params.toolName,
        entryType: 'tool_call',
      };
      this.traceBuffer.push(entry);
      if (this.traceBuffer.length > LangfuseIntegrationImpl.TRACE_BUFFER_MAX) {
        this.traceBuffer.shift();
      }
      if (this.emitter && params.sessionId) {
        this.emitter.emit('langfuse:trace', { sessionId: params.sessionId, trace: entry });
      }
    } catch {
      // non-fatal
    }

    if (this.status !== 'active') return;
    if (!this.config?.traceToolCalls) return;
    if (this.config.sampleRate < 1.0 && Math.random() > this.config.sampleRate) return;

    try {
      const { startActiveObservation, propagateAttributes } = require('@langfuse/tracing');
      const doObserve = async (): Promise<void> => {
        await startActiveObservation(
          `tool-${params.toolName}`,
          async (span: any) => {
            span.update({
              input: this.truncatePayload(params.args),
              output: params.status === 'ok' ? undefined : params.errorMessage,
              level: params.status === 'error' ? 'ERROR' : 'DEFAULT',
              metadata: {
                toolName: params.toolName,
                agentId: params.agentId,
                agentName: params.agentName,
                taskId: params.taskId,
                sessionId: params.sessionId,
                latencyMs: params.latencyMs,
                ...params.metadata,
              },
            });
          },
          { asType: 'span', endOnExit: true },
        );
      };

      if (params.sessionId || params.agentId) {
        try {
          const result = propagateAttributes(
            { sessionId: params.sessionId, userId: params.agentId, tags: ['tool-call', `tool:${params.toolName}`], traceName: `tool-${params.toolName}` },
            doObserve,
          );
          if (result instanceof Promise) await result;
        } catch {
          await doObserve();
        }
      } else {
        await doObserve();
      }
    } catch {
      // trace errors are non-fatal
    }
  }

  /**
   * 记录任务评分（供 worker:complete 调用）
   */
  async recordScore(params: LangfuseScoreParams): Promise<void> {
    if (this.status !== 'active') return;
    if (!this.config?.scoreEnabled) return;
    if (!this.config?.secretKey || !this.config?.publicKey) return;

    try {
      const baseUrl = this.config.baseUrl || 'https://cloud.langfuse.com';
      const auth = Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString('base64');
      const body = {
        name: 'task-verdict',
        value: params.score,
        comment: params.comment || `${params.verdict} — task ${params.taskId || 'unknown'}`,
        dataType: 'NUMERIC',
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.metadata ?? {}),
      };
      const response = await fetch(`${baseUrl}/api/public/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        coreLogger.warn(`[Langfuse] recordScore HTTP ${response.status}`);
      }
    } catch (e) {
      coreLogger.warn(`[Langfuse] recordScore failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 截断大 payload 防止 OTel BatchSpanProcessor queue 内存堆积导致 OOM。
   * LLM messages 和 tool args 可能很大（对话历史、文件内容），每个 span 缓存一份，
   * batched 模式下累积到 queue，多进程叠加 → 系统内存耗尽 → OOM kill。
   * 截断到可调试的大小即可。
   */
  private truncatePayload(value: unknown, maxChars = 8000): unknown {
    if (typeof value === 'string') {
      return value.length > maxChars ? value.slice(0, maxChars) + '\n…[truncated]' : value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.truncatePayload(v, maxChars));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        // content/arguments/text/result/data 是大文本字段，单独限长
        const limit = /^(content|arguments|text|result|data)$/.test(k) ? Math.min(maxChars, 4000) : maxChars;
        result[k] = this.truncatePayload(v, limit);
      }
      return result;
    }
    return value;
  }

  private maskSensitive(value: unknown): unknown {
    if (typeof value === 'string') {
      return value
        .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
        .replace(/pk-[a-zA-Z0-9_-]{10,}/g, 'pk-***')
        .replace(/Bearer\s+[a-zA-Z0-9_-]{10,}/gi, 'Bearer ***');
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.maskSensitive(v));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (/key|token|secret|password|apikey|api_key/i.test(k)) {
          result[k] = '***';
        } else {
          result[k] = this.maskSensitive(v);
        }
      }
      return result;
    }
    return value;
  }
}

export const langfuseIntegration = new LangfuseIntegrationImpl();

export function initLangfuse(config: LangfuseConfig): void {
  langfuseIntegration.init(config);
}

/**
 * 设置 emitter 引用用于实时 SSE 推送
 */
export function setLangfuseEmitter(emitter: EventEmitter): void {
  langfuseIntegration.setEmitter(emitter);
}

export async function shutdownLangfuse(): Promise<void> {
  await langfuseIntegration.shutdown();
}

/**
 * 从 runtime config 读取 langfuse 配置并返回 LangfuseConfig
 */
export function readLangfuseConfig(): LangfuseConfig {
  // 优先从 globalThis 读取（热加载后最新），fallback 到 config module export
  const raw = (globalThis as any).__lingxiao_config?.observability?.langfuse
    ?? (getConfigValue('observability.langfuse') as Record<string, unknown> | undefined)
    ?? {};
  return {
    enabled: raw.enabled === true,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : 'https://cloud.langfuse.com',
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey : '',
    publicKey: typeof raw.publicKey === 'string' ? raw.publicKey : '',
    traceLlmCalls: raw.traceLlmCalls !== false,
    traceToolCalls: raw.traceToolCalls === true,
    traceAgentLifecycle: raw.traceAgentLifecycle !== false,
    sampleRate: typeof raw.sampleRate === 'number' ? raw.sampleRate : 1.0,
    maskSensitive: raw.maskSensitive !== false,
    scoreEnabled: raw.scoreEnabled !== false,
  };
}
