import type { DatabaseManager } from '../core/Database.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { ToolRegistry } from '../tools/Registry.js';
import type { ContextManager } from '../core/ContextManager.js';
import type { ToolDefinition } from '../llm/types.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ToolPermissionContext } from '../core/PermissionSystem.js';
import type { WorkflowManager } from '../core/workflow/WorkflowManager.js';
import type { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import type { BlackboardGraph } from '../core/blackboard/BlackboardGraph.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { evaluateSessionOrchestrationTierGate } from '../core/OrchestrationTierGates.js';
import { evaluateLeaderAutonomyToolGate, type LeaderAutonomyToolGateResult } from './leader/LeaderToolGates.js';

export interface LeaderDirectToolsConfig {
  toolRegistry: ToolRegistry;
  db: DatabaseManager;
  sessionId: string;
  workspace: string;
  emitter: EventEmitter;
  bus: MessageBus;
  contextManager: ContextManager;
  llm: ContentGenerator;
  model: string;
  /**
   * Current Leader model resolver. Direct tools may invoke LLM after a session-level
   * model switch, so do not rely on the constructor-time model snapshot.
   */
  getModel?: () => string;
  workflowManager?: WorkflowManager;
  workflowEngine?: WorkflowEngine;
  scheduledTaskManager?: ScheduledTaskManager;
  /**
   * 黑板图惰性获取器 —— Leader 调用 blackboard(action="...") 统一入口时
   * 需要 context.blackboardGraph。黑板在 LeaderAgent 构造后期才 init，
   * 故用 getter 在执行时解析（而非构造时快照，否则永远是 null）。
   */
  getBlackboardGraph?: () => BlackboardGraph | null;
  /** Running worker count for S1/S2 concurrency caps (AgentPool). */
  getRunningAgentCount?: () => number;
}

export class LeaderDirectToolsExecutor {
  private toolRegistry: ToolRegistry;
  private db: DatabaseManager;
  private sessionId: string;
  private workspace: string;
  private emitter: EventEmitter;
  private bus: MessageBus;
  private contextManager: ContextManager;
  private llm: ContentGenerator;
  private getModel: () => string;
  private workflowManager?: WorkflowManager;
  private workflowEngine?: WorkflowEngine;
  private scheduledTaskManager?: ScheduledTaskManager;
  private getBlackboardGraph?: () => BlackboardGraph | null;
  private getRunningAgentCount?: () => number;

  constructor(config: LeaderDirectToolsConfig) {
    this.toolRegistry = config.toolRegistry;
    this.db = config.db;
    this.sessionId = config.sessionId;
    this.workspace = config.workspace;
    this.emitter = config.emitter;
    this.bus = config.bus;
    this.contextManager = config.contextManager;
    this.llm = config.llm;
    this.getModel = config.getModel ?? (() => config.model);
    this.workflowManager = config.workflowManager;
    this.workflowEngine = config.workflowEngine;
    this.scheduledTaskManager = config.scheduledTaskManager;
    this.getBlackboardGraph = config.getBlackboardGraph;
    this.getRunningAgentCount = config.getRunningAgentCount;
  }

  getDefinitions(toolNames?: string[]): ToolDefinition[] {
    return this.toolRegistry.getDefinitions(toolNames);
  }

  private recordAutonomyDecision(toolName: string, gate: LeaderAutonomyToolGateResult): void {
    const gateResult = gate.ok
      ? 'allow'
      : gate.gateKind === 'confirmation_required'
        ? 'confirmation_required'
        : 'blocked';
    const trace = {
      toolName,
      decision: gate.decision,
      gateResult,
      gateKind: gate.ok ? null : gate.gateKind,
      recordedAt: Date.now(),
      source: 'leader_tool_gate',
    };
    this.db.setSessionState(this.sessionId, SESSION_KEYS.AUTONOMY_DECISION_TRACE, JSON.stringify(trace));
    this.emitter.emit('leader:autonomy_decision', {
      sessionId: this.sessionId,
      ...trace,
    });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    permissionContext: ToolPermissionContext
  ): Promise<string> {
    const { ok, content } = await this.executeStructured(name, args, permissionContext);
    return ok ? content : `ERROR: ${content}`;
  }

  /**
   * 结构化执行：返回 { ok, content }，让上层根据 ok 做副作用判断（如 team_manage(action="create") 设置 active team）
   * 而不是解析人类可读字符串前缀。
   */
  async executeStructured(
    name: string,
    args: Record<string, unknown>,
    permissionContext: ToolPermissionContext,
    toolCallId?: string
  ): Promise<{ ok: boolean; content: string }> {
    const autonomyGate = evaluateLeaderAutonomyToolGate({
      toolName: name,
      args,
      modes: resolveModeRuntimeProjection({
        sessionId: this.sessionId,
        db: this.db,
        blackboardAvailable: Boolean(this.getBlackboardGraph?.()),
        permissionContext,
      }),
      permissionContext,
    });
    this.recordAutonomyDecision(name, autonomyGate);
    if (!autonomyGate.ok) {
      return { ok: false, content: autonomyGate.message };
    }

    // AC4：S1/S2/S3 代码门控 — team_manage 等走 direct 路径时与纯函数同源 fail-closed
    const runningAgentCount = typeof this.getRunningAgentCount === 'function'
      ? this.getRunningAgentCount()
      : 0;
    const tierGate = evaluateSessionOrchestrationTierGate({
      toolName: name,
      args,
      sessionId: this.sessionId,
      db: this.db,
      runningAgentCount,
      blackboardAvailable: Boolean(this.getBlackboardGraph?.()),
      permissionContext,
    });
    if (!tierGate.ok) {
      return { ok: false, content: `[${tierGate.code}] ${tierGate.message}` };
    }

    const result = await this.toolRegistry.execute(name, args, {
      db: this.db,
      sessionId: this.sessionId,
      agentId: 'leader',
      agentName: 'leader',
      workspace: this.workspace,
      emitter: this.emitter,
      bus: this.bus,
      permissionContext,
      llm: this.llm,
      model: this.getModel(),
      workflowManager: this.workflowManager,
      workflowEngine: this.workflowEngine,
      scheduledTaskManager: this.scheduledTaskManager,
      toolRegistry: this.toolRegistry,
      blackboardGraph: this.getBlackboardGraph?.() ?? undefined,
      toolCallId,
    });

    if (result.success && name === 'file_read') {
      const filePath = typeof args.path === 'string' ? args.path : '';
      const fileContent = typeof result.data === 'string' ? result.data : '';
      if (filePath && fileContent) {
        this.contextManager.trackFileRead(filePath, fileContent);
      }
    }

    if (result.success && name === 'session_artifacts') {
      const action = typeof args.action === 'string' ? args.action : '';
      const artifact = typeof args.artifact === 'string' ? args.artifact : '';
      const payload = typeof result.data === 'string' ? result.data : '';
      if (action === 'read' && artifact && payload) {
        this.contextManager.trackFileRead(artifact, payload);
      }
    }

    if (!result.success) return { ok: false, content: result.error || 'unknown error' };
    const d = result.data;
    if (d === null || d === undefined) return { ok: true, content: '' };
    if (typeof d === 'string') return { ok: true, content: d };
    return { ok: true, content: JSON.stringify(d, null, 2) };
  }
}

export default LeaderDirectToolsExecutor;
