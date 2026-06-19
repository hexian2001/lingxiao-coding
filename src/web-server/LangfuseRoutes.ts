/**
 * LangfuseRoutes — Langfuse 连接测试、状态查询、trace 列表与会话列表路由
 *
 * 端点：
 * - GET  /api/v1/langfuse/status — 返回当前 Langfuse 配置状态
 * - GET  /api/v1/langfuse/traces — 查询 Langfuse trace 列表（支持 sessionId 过滤、includeObservations）
 * - GET  /api/v1/langfuse/sessions — 查询 Langfuse 会话列表（优先 sessions API，fallback 从 traces 聚合）
 * - GET  /api/v1/langfuse/local/traces — 查询本地实时 trace buffer（无需远程连接）
 * - GET  /api/v1/langfuse/local/stats — 本地 trace 统计摘要
 * - POST /api/v1/langfuse/test — 测试 Langfuse 服务连通性
 */

import type { FastifyInstance } from 'fastify';
import { getConfigValue } from '../config.js';
import { getConfiguredProxyUrl, getConfiguredNoProxy } from '../core/ProxyConfig.js';
import { langfuseIntegration } from '../core/LangfuseIntegration.js';
import type { AuthFn } from './types.js';

interface LangfuseRoutesDeps {
  requireServerToken: AuthFn;
}

interface LangfuseConfigSnapshot {
  enabled: boolean;
  baseUrl: string;
  secretKey: string;
  publicKey: string;
  traceLlmCalls: boolean;
  traceToolCalls: boolean;
  traceAgentLifecycle: boolean;
  sampleRate: number;
  maskSensitive: boolean;
}

function getLangfuseConfig(): LangfuseConfigSnapshot {
  const raw = getConfigValue('observability.langfuse') ?? {};
  const cfg = raw as Record<string, unknown>;
  return {
    enabled: cfg.enabled === true,
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : 'https://cloud.langfuse.com',
    secretKey: typeof cfg.secretKey === 'string' ? cfg.secretKey : '',
    publicKey: typeof cfg.publicKey === 'string' ? cfg.publicKey : '',
    traceLlmCalls: cfg.traceLlmCalls !== false,
    traceToolCalls: cfg.traceToolCalls === true,
    traceAgentLifecycle: cfg.traceAgentLifecycle !== false,
    sampleRate: typeof cfg.sampleRate === 'number' ? cfg.sampleRate : 1.0,
    maskSensitive: cfg.maskSensitive !== false,
  };
}

/**
 * 同步代理环境变量并设置全局 EnvHttpProxyAgent dispatcher。
 *
 * Node.js 原生 fetch (undici) 不读 HTTP_PROXY/HTTPS_PROXY 环境变量。
 * ProxyAgent (per-request dispatcher) 在某些环境下不工作。
 * EnvHttpProxyAgent 读取环境变量并正确代理，是验证过的可靠方案。
 *
 * 调用时机：每次 /test、/traces 和 /sessions 请求前确保 dispatcher 已设置。
 */
let proxyDispatcherInitialized = false;
function ensureProxyDispatcher(): void {
  if (proxyDispatcherInitialized) return;

  // 1. 从凌霄配置同步代理 URL 到环境变量
  // Langfuse 是 LLM 可观测性服务，优先使用 tools 代理，fallback 到 llm 代理
  const proxyUrl = getConfiguredProxyUrl('tools') || getConfiguredProxyUrl('llm');
  if (proxyUrl) {
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = proxyUrl;
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = proxyUrl;
    const noProxy = getConfiguredNoProxy();
    if (noProxy && !process.env.NO_PROXY) process.env.NO_PROXY = noProxy;
  }

  // 2. 设置全局 EnvHttpProxyAgent
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    proxyDispatcherInitialized = true;
  } catch {
    // undici not available — non-fatal, fetch will attempt direct connection
  }
}

// ---------------------------------------------------------------------------
// Langfuse API 调用公共 helper
// ---------------------------------------------------------------------------

interface LangfuseFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

/**
 * 调用 Langfuse API 的统一入口。
 * 封装 baseUrl 拼接、Basic auth、代理设置、超时控制和错误处理。
 * 所有 Langfuse 端点（traces / sessions / test）复用此函数。
 */
async function langfuseFetch(
  path: string,
  cfg: LangfuseConfigSnapshot,
  timeoutMs = 15_000,
): Promise<LangfuseFetchResult> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + path;
  const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  const fetchOpts: RequestInit & { dispatcher?: unknown } = {
    method: 'GET',
    headers: { 'Authorization': `Basic ${auth}` },
    signal: controller.signal,
  };

  // Ensure global proxy dispatcher is set (EnvHttpProxyAgent reads env vars)
  ensureProxyDispatcher();

  try {
    const res = await fetch(url, fetchOpts);
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json();
      return { ok: true, status: res.status, data: json };
    } else {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `Langfuse returned status ${res.status}`,
      };
    }
  } catch (e: unknown) {
    clearTimeout(timeout);
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, data: null, error: message };
  }
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface LangfuseTrace {
  id: string;
  name?: string;
  sessionId?: string;
  session_id?: string;
  userId?: string;
  user_id?: string;
  timestamp?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface LangfuseObservation {
  id: string;
  [key: string]: unknown;
}

interface LangfuseSessionSummary {
  id: string;
  createdAt: string;
  traceCount: number;
  userId?: string;
  [key: string]: unknown;
}

export function registerLangfuseRoutes(
  fastify: FastifyInstance,
  deps: LangfuseRoutesDeps,
): void {
  const { requireServerToken } = deps;

  // GET /api/v1/langfuse/local/traces — 本地实时 trace buffer（无需远程连接）
  // Query: limit (default 100, max 500), sessionId (optional filter)
  fastify.get('/api/v1/langfuse/local/traces', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as Record<string, unknown>;
    const limit = Math.min(Number(query?.limit ?? 100), 500);
    const sessionId = typeof query?.sessionId === 'string' ? query.sessionId.trim() : undefined;
    const traces = langfuseIntegration.getLocalTraces(limit, sessionId);
    return { data: traces };
  });

  // GET /api/v1/langfuse/local/stats — 本地 trace 统计摘要
  fastify.get('/api/v1/langfuse/local/stats', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const stats = langfuseIntegration.getLocalStats();
    return { data: stats };
  });

  // GET /api/v1/langfuse/status — 返回当前 Langfuse 配置状态（密钥脱敏）
  fastify.get('/api/v1/langfuse/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const cfg = getLangfuseConfig();
    return {
      data: {
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl,
        secretKeyConfigured: cfg.secretKey.length > 0,
        publicKeyConfigured: cfg.publicKey.length > 0,
        traceLlmCalls: cfg.traceLlmCalls,
        traceToolCalls: cfg.traceToolCalls,
        traceAgentLifecycle: cfg.traceAgentLifecycle,
        sampleRate: cfg.sampleRate,
        maskSensitive: cfg.maskSensitive,
      },
    };
  });

  // GET /api/v1/langfuse/traces — 查询 Langfuse trace 列表
  // 代理 Langfuse API GET /api/public/traces，前端 LangfuseView 使用
  //
  // Query 参数：
  //   limit              — 返回条数上限，默认 50，最大 100
  //   sessionId          — 按 sessionId 过滤 trace（透传给 Langfuse API）
  //   includeObservations — 为 "true" 时为每条 trace 拉取 observation 详情
  fastify.get('/api/v1/langfuse/traces', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const cfg = getLangfuseConfig();

    if (!cfg.enabled || !cfg.secretKey || !cfg.publicKey) {
      return { data: [] };
    }

    try {
      const query = request.query as Record<string, unknown>;
      const limit = Math.min(Number(query?.limit ?? 50), 100);
      const sessionId = typeof query?.sessionId === 'string' ? query.sessionId.trim() : '';
      const includeObservations =
        query?.includeObservations === 'true' || query?.includeObservations === true;

      // 构建 Langfuse API URL，透传 sessionId
      let tracesPath = `/api/public/traces?limit=${limit}`;
      if (sessionId) {
        tracesPath += `&sessionId=${encodeURIComponent(sessionId)}`;
      }

      const result = await langfuseFetch(tracesPath, cfg);

      if (!result.ok) {
        return { data: [], error: result.error ?? `Langfuse returned status ${result.status}` };
      }

      const responseBody = result.data as { data?: unknown[]; meta?: unknown } | null;
      const traces = (responseBody?.data ?? []) as LangfuseTrace[];
      const meta = responseBody?.meta ?? null;

      // 如果请求包含 observation 详情，为每条 trace 并行拉取 observations
      if (includeObservations && Array.isArray(traces) && traces.length > 0) {
        const tracesWithObs = await Promise.all(
          traces.map(async (trace) => {
            if (!trace?.id) return trace;
            // Langfuse API: GET /api/public/observations?traceId=...
            // （/api/public/traces/{id}/observations 端点不存在，会 404）
            const obsResult = await langfuseFetch(
              `/api/public/observations?traceId=${encodeURIComponent(trace.id)}&limit=50`,
              cfg,
            );
            const observations: LangfuseObservation[] = obsResult.ok
              ? (((obsResult.data as { data?: unknown[] })?.data ?? []) as LangfuseObservation[])
              : [];
            return { ...trace, observations };
          }),
        );
        return { data: tracesWithObs, meta };
      }

      return { data: traces, meta };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: [], error: `Trace query failed: ${message}` };
    }
  });

  // GET /api/v1/langfuse/sessions — 查询 Langfuse 会话列表
  // 优先调用 Langfuse /api/public/sessions；不支持时从 traces 聚合。
  //
  // 返回结构：{ data: [{ id, createdAt, traceCount, userId, ... }], meta?, source? }
  // source="native" 表示直接从 sessions API 获取，"aggregated" 表示从 traces 聚合
  // 错误隔离：Langfuse 不可达时返回 { data: [], error: "..." }
  fastify.get('/api/v1/langfuse/sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const cfg = getLangfuseConfig();

    if (!cfg.enabled || !cfg.secretKey || !cfg.publicKey) {
      return { data: [] };
    }

    try {
      // 1. 尝试直接调用 Langfuse sessions 端点
      const sessionsResult = await langfuseFetch('/api/public/sessions?limit=50', cfg);

      if (sessionsResult.ok) {
        const responseBody = sessionsResult.data as { data?: unknown[]; meta?: unknown } | null;
        return {
          data: responseBody?.data ?? [],
          meta: responseBody?.meta ?? null,
          source: 'native',
        };
      }

      // 2. sessions 端点不可用（404 或其他错误），从 traces 聚合
      //    拉取最近 100 条 trace，按 sessionId 分组
      const tracesResult = await langfuseFetch('/api/public/traces?limit=100', cfg);

      if (!tracesResult.ok) {
        return {
          data: [],
          error: tracesResult.error ?? `Langfuse returned status ${tracesResult.status}`,
        };
      }

      const tracesBody = tracesResult.data as { data?: unknown[] } | null;
      const traces = (tracesBody?.data ?? []) as LangfuseTrace[];

      const sessionMap = new Map<string, LangfuseSessionSummary>();

      for (const trace of traces) {
        // Langfuse trace 中 sessionId 可能是 sessionId 或 session_id
        const sid =
          typeof trace.sessionId === 'string' ? trace.sessionId :
          typeof trace.session_id === 'string' ? trace.session_id :
          '';
        if (!sid) continue;

        if (!sessionMap.has(sid)) {
          sessionMap.set(sid, {
            id: sid,
            createdAt:
              typeof trace.timestamp === 'string' ? trace.timestamp :
              typeof trace.createdAt === 'string' ? trace.createdAt :
              new Date().toISOString(),
            traceCount: 0,
            userId:
              typeof trace.userId === 'string' ? trace.userId :
              typeof trace.user_id === 'string' ? trace.user_id :
              undefined,
          });
        }
        sessionMap.get(sid)!.traceCount++;
      }

      return {
        data: Array.from(sessionMap.values()),
        source: 'aggregated',
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: [], error: `Sessions query failed: ${message}` };
    }
  });

  // GET /api/v1/langfuse/traces/:traceId/observations — 获取单条 trace 的 observation 详情
  // 前端 trace 展开时懒加载调用此端点
  fastify.get('/api/v1/langfuse/traces/:traceId/observations', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const cfg = getLangfuseConfig();

    if (!cfg.enabled || !cfg.secretKey || !cfg.publicKey) {
      return { data: [] };
    }

    try {
      const traceId = (request.params as Record<string, unknown>)?.traceId;
      if (typeof traceId !== 'string' || !traceId) {
        return { data: [], error: 'Missing traceId' };
      }

      // Langfuse API: GET /api/public/observations?traceId=...
      // （/api/public/traces/{traceId}/observations 端点不存在，会 404）
      const result = await langfuseFetch(
        `/api/public/observations?traceId=${encodeURIComponent(traceId)}&limit=50`,
        cfg,
      );

      if (!result.ok) {
        return { data: [], error: result.error ?? `Langfuse returned status ${result.status}` };
      }

      const body = result.data as { data?: unknown[] } | null;
      return { data: body?.data ?? [] };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: [], error: `Observations query failed: ${message}` };
    }
  });

  // POST /api/v1/langfuse/test — 测试 Langfuse 服务连通性
  fastify.post('/api/v1/langfuse/test', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const cfg = getLangfuseConfig();

    if (!cfg.enabled) {
      return { success: false, error: 'Langfuse integration is not enabled' };
    }
    if (!cfg.secretKey || !cfg.publicKey) {
      return { success: false, error: 'Langfuse secretKey or publicKey is not configured' };
    }

    try {
      // Langfuse health endpoint: GET /api/public/health
      const result = await langfuseFetch('/api/public/health', cfg);

      if (result.ok) {
        return { success: true, message: 'Langfuse connection successful', statusCode: result.status };
      } else {
        return {
          success: false,
          error: result.error ?? `Langfuse returned status ${result.status}`,
          statusCode: result.status,
        };
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Connection failed: ${message}` };
    }
  });
}
