/**
 * MCP Forge 核心编排器 — 需求分析→代码生成→沙箱验证→注册
 *
 * 契约: contract:mcp-forge-core v1 §2, §5
 *
 * 编排流水线:
 *   pending → analyzing → analyzed → generating → generated
 *   → validating → validated → registering → registered → completed
 *
 * 关键衔接点:
 *   - LLM 调用: 复用凌霄 LLM 路由 (ContentGenerator)
 *   - MCP 注册: MarketplaceService.upsertMcpServer()
 *   - 沙箱: SandboxRunner (child_process.spawn)
 *   - 配置: config.ts McpServerConfigSchema
 */

import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import type {
  ForgeJob,
  ForgeRequest,
  ForgeAnalysis,
  GeneratedCode,
  ValidationResult,
  RegisteredServer,
  ForgeEvent,
  ForgeEventListener,
  ForgeJobState,
  ForgeStepRecord,
  ForgeErrorData,
} from './types.js';
import { TERMINAL_STATES } from './types.js';
import { validateTransition, isTerminal } from './stateMachine.js';
import { ForgeError, ForgeErrorCode } from './errors.js';
import { CodeGenerator } from './CodeGenerator.js';
import { SandboxRunner } from './SandboxRunner.js';
import { InspectorValidator } from './InspectorValidator.js';
import { TemplateLibrary } from './TemplateLibrary.js';
import { upsertMcpServer, getInstalledMcpServers } from '../MarketplaceService.js';
import type { McpServerConfig } from '../../config.js';
import { config as runtimeConfig } from '../../config.js';

// ── 辅助 ──────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

function generateJobId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `forge_${timestamp}_${random}`;
}

/** 进度映射: 每个状态对应的进度百分比 */
const STATE_PROGRESS: Record<ForgeJobState, number> = {
  pending: 0,
  analyzing: 10,
  analyzed: 25,
  generating: 35,
  generated: 55,
  validating: 60,
  validation_skipped: 70,
  validated: 75,
  registering: 85,
  registered: 95,
  completed: 100,
  analysis_failed: 10,
  generation_failed: 35,
  validation_failed: 60,
  registration_failed: 85,
  cancelled: 0,
};

// ── 作业存储 (内存) ────────────────────────────────────────────────────────

const jobStore = new Map<string, ForgeJob>();

// ── McpForge 编排器 ────────────────────────────────────────────────────────

export interface McpForgeOptions {
  llmClient?: ContentGenerator;
  model?: string;
}

export class McpForge {
  private codeGenerator: CodeGenerator;
  private listeners: Map<string, Set<ForgeEventListener>> = new Map();

  constructor(options: McpForgeOptions = {}) {
    this.codeGenerator = new CodeGenerator({
      llmClient: options.llmClient,
      model: options.model,
    });
  }

  // ── 作业生命周期 ────────────────────────────────────────────────────────

  /**
   * 创建新的 Forge 作业。
   */
  createJob(request: ForgeRequest): ForgeJob {
    // Validate request
    if (!request.description || request.description.trim().length === 0) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_INVALID_REQUEST,
        'Request description is required',
        { retryable: false },
      );
    }
    if (!request.serverName || request.serverName.trim().length === 0) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_INVALID_REQUEST,
        'Request serverName is required',
        { retryable: false },
      );
    }

    const job: ForgeJob = {
      id: generateJobId(),
      state: 'pending',
      request,
      createdAt: now(),
      updatedAt: now(),
      progress: 0,
      stepHistory: [],
    };

    jobStore.set(job.id, job);
    this.emitEvent(job, 'log', 'Job created');
    return job;
  }

  /**
   * 获取作业。
   */
  getJob(jobId: string): ForgeJob | undefined {
    return jobStore.get(jobId);
  }

  /**
   * 列出所有作业。
   */
  listJobs(): ForgeJob[] {
    return Array.from(jobStore.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 删除作业。
   */
  removeJob(jobId: string): boolean {
    return jobStore.delete(jobId);
  }

  /**
   * 取消作业。
   */
  cancel(jobId: string): ForgeJob {
    const job = this.requireJob(jobId);
    if (isTerminal(job.state)) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_STATE_VIOLATION,
        `Cannot cancel job in terminal state: ${job.state}`,
        { phase: job.state, retryable: false },
      );
    }

    this.transitionTo(job, 'cancelled');
    this.emitEvent(job, 'log', 'Job cancelled by user');
    return job;
  }

  /**
   * 重试失败的作业，从失败点恢复。
   */
  retry(jobId: string): ForgeJob {
    const job = this.requireJob(jobId);

    const retryTargets: Record<string, ForgeJobState> = {
      analysis_failed: 'analyzing',
      generation_failed: 'generating',
      validation_failed: 'validating',
      registration_failed: 'registering',
    };

    const target = retryTargets[job.state];
    if (!target) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_STATE_VIOLATION,
        `Cannot retry job in state: ${job.state}`,
        { phase: job.state, retryable: false },
      );
    }

    this.transitionTo(job, target);
    return job;
  }

  // ── 流水线推进 ──────────────────────────────────────────────────────────

  /**
   * 一键执行完整流水线: pending → completed
   * 遇到错误时停止并设置失败状态。
   */
  async runPipeline(jobId: string): Promise<ForgeJob> {
    const job = this.requireJob(jobId);

    // Run all stages until terminal
    while (!isTerminal(job.state)) {
      await this.advance(jobId);
      const updated = this.requireJob(jobId);
      if (isTerminal(updated.state) && updated.state !== 'completed') {
        // Failed or cancelled
        break;
      }
    }

    return this.requireJob(jobId);
  }

  /**
   * 执行下一步（根据当前状态自动决定）。
   */
  async advance(jobId: string): Promise<ForgeJob> {
    const job = this.requireJob(jobId);

    if (isTerminal(job.state)) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_STATE_VIOLATION,
        `Cannot advance job in terminal state: ${job.state}`,
        { phase: job.state, retryable: false },
      );
    }

    switch (job.state) {
      case 'pending':
        await this.runAnalysis(job);
        break;
      case 'analyzed':
        await this.runGeneration(job);
        break;
      case 'generated':
        await this.runValidation(job);
        break;
      case 'validated':
      case 'validation_skipped':
        await this.runRegistration(job);
        break;
      case 'registered':
        this.transitionTo(job, 'completed');
        this.emitEvent(job, 'log', 'Pipeline completed');
        break;
      default:
        throw new ForgeError(
          ForgeErrorCode.FORGE_STATE_VIOLATION,
          `advance() does not handle state: ${job.state}`,
          { phase: job.state, retryable: false },
        );
    }

    return job;
  }

  // ── 各阶段实现 ──────────────────────────────────────────────────────────

  /** 需求分析阶段 */
  private async runAnalysis(job: ForgeJob): Promise<void> {
    this.transitionTo(job, 'analyzing');
    this.emitEvent(job, 'log', 'Starting requirement analysis');

    try {
      const analysis = await this.codeGenerator.analyze(job.request);
      job.analysis = analysis;
      this.transitionTo(job, 'analyzed');
      this.emitEvent(job, 'log', `Analysis complete: ${analysis.tools.length} tools, template: ${analysis.templateId}`);
    } catch (err) {
      this.handleFailure(job, 'analysis_failed', err);
    }
  }

  /** 代码生成阶段 */
  private async runGeneration(job: ForgeJob): Promise<void> {
    if (!job.analysis) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_STATE_VIOLATION,
        'Cannot generate without analysis',
        { phase: job.state, retryable: false },
      );
    }

    this.transitionTo(job, 'generating');
    this.emitEvent(job, 'log', 'Starting code generation');

    try {
      const generatedCode = await this.codeGenerator.generate(job.analysis);
      job.generatedCode = generatedCode;
      this.transitionTo(job, 'generated');
      this.emitEvent(job, 'log', `Code generated: ${generatedCode.files.length} files in ${generatedCode.outputDir}`);
    } catch (err) {
      this.handleFailure(job, 'generation_failed', err);
    }
  }

  /** 沙箱验证 + Inspector 阶段 */
  private async runValidation(job: ForgeJob): Promise<void> {
    if (!job.generatedCode || !job.analysis) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_STATE_VIOLATION,
        'Cannot validate without generated code',
        { phase: job.state, retryable: false },
      );
    }

    // Check if validation should be skipped
    if (job.request.options?.skipValidation) {
      this.transitionTo(job, 'validation_skipped');
      this.emitEvent(job, 'log', 'Validation skipped (user option)');
      return;
    }

    this.transitionTo(job, 'validating');
    this.emitEvent(job, 'log', 'Starting sandbox validation');

    try {
      const timeoutMs = job.request.options?.sandboxTimeoutMs ?? 30000;
      const customEnv = job.request.options?.customEnv;

      // 1. Compile check
      this.emitEvent(job, 'log', 'Running compile check...');
      const compileResult = await SandboxRunner.compile(job.generatedCode, { timeoutMs, customEnv });
      if (!compileResult.success) {
        throw new ForgeError(
          ForgeErrorCode.FORGE_SANDBOX_CRASH,
          `Compile failed: ${compileResult.stderr.slice(0, 500)}`,
          { phase: 'validating', detail: compileResult.stderr },
        );
      }
      this.emitEvent(job, 'log', 'Compile check passed');

      // 2. Inspector validation (if not skipped)
      if (job.request.options?.skipInspector) {
        // Just verify the server starts
        this.emitEvent(job, 'log', 'Running startup check (Inspector skipped)...');
        const runResult = await SandboxRunner.run(job.generatedCode, { timeoutMs, customEnv });
        if (!runResult.success) {
          throw new ForgeError(
            ForgeErrorCode.FORGE_SANDBOX_STARTUP_FAILED,
            `Server failed to start: ${runResult.stderr.slice(0, 500)}`,
            { phase: 'validating', detail: runResult.stderr },
          );
        }

        job.validationResult = {
          sandboxCompiled: true,
          sandboxStarted: true,
          inspectorConnected: false,
          toolsDiscovered: [],
          errors: [],
          warnings: ['Inspector validation skipped by user option'],
          duration: runResult.duration,
        };
      } else {
        // Full Inspector validation
        this.emitEvent(job, 'log', 'Running Inspector validation (tools/list + tools/call)...');
        const result = await InspectorValidator.validate(
          job.generatedCode,
          job.analysis,
          { timeoutMs, customEnv },
        );
        job.validationResult = result;

        if (result.errors.length > 0) {
          throw new ForgeError(
            ForgeErrorCode.FORGE_VALIDATION_MISMATCH,
            `Validation errors: ${result.errors.join('; ')}`,
            { phase: 'validating', detail: result.errors.join('\n') },
          );
        }
      }

      this.transitionTo(job, 'validated');
      this.emitEvent(job, 'log', 'Validation passed');
    } catch (err) {
      this.handleFailure(job, 'validation_failed', err);
    }
  }

  /** 注册阶段 */
  private async runRegistration(job: ForgeJob): Promise<void> {
    if (!job.analysis || !job.generatedCode) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_STATE_VIOLATION,
        'Cannot register without analysis and generated code',
        { phase: job.state, retryable: false },
      );
    }

    // Check if auto-register is disabled
    if (job.request.options?.autoRegister === false) {
      this.transitionTo(job, 'registered');
      this.emitEvent(job, 'log', 'Registration skipped (autoRegister=false)');
      return;
    }

    this.transitionTo(job, 'registering');
    this.emitEvent(job, 'log', 'Starting MCP server registration');

    try {
      const analysis = job.analysis;
      const generatedCode = job.generatedCode;

      // Check for server ID conflict
      const existingServers = getInstalledMcpServers();
      if (existingServers.some(s => s.id === analysis.serverId)) {
        throw new ForgeError(
          ForgeErrorCode.FORGE_SERVER_ID_CONFLICT,
          `Server ID '${analysis.serverId}' already exists`,
          { phase: 'registering', retryable: false },
        );
      }

      // Build MCP server config
      const serverConfig = McpForge.buildServerConfig(analysis, generatedCode);
      const registered = upsertMcpServer(serverConfig);

      job.registeredServer = {
        serverId: analysis.serverId,
        transport: analysis.transport,
        config: registered as Record<string, unknown>,
        registeredAt: now(),
      };

      this.transitionTo(job, 'registered');
      this.emitEvent(job, 'log', `Server registered: ${analysis.serverId}`);
    } catch (err) {
      // If it's already a ForgeError, preserve it
      if (err instanceof ForgeError) {
        this.handleFailure(job, 'registration_failed', err);
      } else {
        this.handleFailure(job, 'registration_failed', new ForgeError(
          ForgeErrorCode.FORGE_REGISTRATION_FAILED,
          `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
          { phase: 'registering', detail: String(err) },
        ));
      }
    }
  }

  // ── 配置构建 ────────────────────────────────────────────────────────────

  /**
   * 根据分析和生成代码构建 MCP server 配置。
   */
  private static buildServerConfig(
    analysis: ForgeAnalysis,
    generatedCode: GeneratedCode,
  ): McpServerConfig {
    const cwd = generatedCode.outputDir;

    if (analysis.transport === 'stdio') {
      const template = TemplateLibrary.getTemplate(analysis.templateId);
      return {
        id: analysis.serverId,
        name: analysis.serverName,
        description: analysis.summary,
        enabled: true,
        transport: 'stdio',
        command: template.registrationConfig.command || (analysis.templateId === 'python-fastmcp-stdio' ? 'python3' : 'node'),
        args: template.registrationConfig.args || [generatedCode.entryPoint],
        env: {},
        cwd,
        origin: { plugin_id: 'lingxiao-forge' },
        installed_at: now(),
        updated_at: now(),
      } as McpServerConfig;
    } else {
      // streamable-http
      const template = TemplateLibrary.getTemplate(analysis.templateId);
      const port = '3000'; // Default; could be extracted from generated code
      const url = (template.registrationConfig.urlPattern || 'http://localhost:3000/mcp')
        .replace('{{PORT}}', port);
      return {
        id: analysis.serverId,
        name: analysis.serverName,
        description: analysis.summary,
        enabled: true,
        transport: 'streamable-http',
        url,
        headers: [],
        origin: { plugin_id: 'lingxiao-forge' },
        installed_at: now(),
        updated_at: now(),
      } as McpServerConfig;
    }
  }

  // ── 事件系统 ────────────────────────────────────────────────────────────

  /**
   * 添加事件监听器。
   */
  addEventListener(jobId: string, listener: ForgeEventListener): void {
    if (!this.listeners.has(jobId)) {
      this.listeners.set(jobId, new Set());
    }
    this.listeners.get(jobId)!.add(listener);
  }

  /**
   * 移除事件监听器。
   */
  removeEventListener(jobId: string, listener: ForgeEventListener): void {
    this.listeners.get(jobId)?.delete(listener);
  }

  private emitEvent(job: ForgeJob, type: ForgeEvent['type'], message: string, data?: Record<string, unknown>): void {
    const event: ForgeEvent = {
      jobId: job.id,
      type,
      state: job.state,
      progress: job.progress,
      message,
      timestamp: now(),
      data,
    };

    const listeners = this.listeners.get(job.id);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────────

  private requireJob(jobId: string): ForgeJob {
    const job = jobStore.get(jobId);
    if (!job) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_INVALID_REQUEST,
        `Job not found: ${jobId}`,
        { retryable: false },
      );
    }
    return job;
  }

  private transitionTo(job: ForgeJob, newState: ForgeJobState): void {
    validateTransition(job.state, newState);
    const oldState = job.state;
    job.state = newState;
    job.updatedAt = now();
    job.progress = STATE_PROGRESS[newState] ?? job.progress;

    const stepRecord: ForgeStepRecord = {
      state: newState,
      timestamp: now(),
      success: !newState.endsWith('_failed') && newState !== 'cancelled',
    };
    job.stepHistory.push(stepRecord);

    this.emitEvent(job, 'state_change', `State: ${oldState} → ${newState}`);
  }

  private handleFailure(job: ForgeJob, failedState: ForgeJobState, err: unknown): void {
    const forgeError = err instanceof ForgeError
      ? err
      : new ForgeError(
          ForgeErrorCode.FORGE_INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
          { phase: job.state, detail: String(err) },
        );

    job.error = {
      code: forgeError.code,
      message: forgeError.message,
      phase: forgeError.phase as ForgeJobState | undefined,
      detail: forgeError.detail,
      retryable: forgeError.retryable,
    };

    this.transitionTo(job, failedState);
    this.emitEvent(job, 'error', `Failed: ${forgeError.message}`, {
      code: forgeError.code,
      detail: forgeError.detail,
    });
  }
}

// ── 导出便捷实例 ────────────────────────────────────────────────────────────

let defaultInstance: McpForge | null = null;

export function getMcpForge(options?: McpForgeOptions): McpForge {
  if (!defaultInstance || options) {
    defaultInstance = new McpForge(options || {});
  }
  return defaultInstance;
}

// ── 导出子模块 ──────────────────────────────────────────────────────────────

export { TemplateLibrary } from './TemplateLibrary.js';
export { CodeGenerator } from './CodeGenerator.js';
export { SandboxRunner } from './SandboxRunner.js';
export { InspectorValidator } from './InspectorValidator.js';
export { ForgeError, ForgeErrorCode } from './errors.js';
export { validateTransition, canTransition, isTerminal } from './stateMachine.js';
export type * from './types.js';
