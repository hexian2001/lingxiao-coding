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
  workflowManager?: WorkflowManager;
  workflowEngine?: WorkflowEngine;
  scheduledTaskManager?: ScheduledTaskManager;
  /**
   * 黑板图惰性获取器 —— Leader 调用 blackboard(action="...") 统一入口时
   * 需要 context.blackboardGraph。黑板在 LeaderAgent 构造后期才 init，
   * 故用 getter 在执行时解析（而非构造时快照，否则永远是 null）。
   */
  getBlackboardGraph?: () => BlackboardGraph | null;
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
  private model: string;
  private workflowManager?: WorkflowManager;
  private workflowEngine?: WorkflowEngine;
  private scheduledTaskManager?: ScheduledTaskManager;
  private getBlackboardGraph?: () => BlackboardGraph | null;

  constructor(config: LeaderDirectToolsConfig) {
    this.toolRegistry = config.toolRegistry;
    this.db = config.db;
    this.sessionId = config.sessionId;
    this.workspace = config.workspace;
    this.emitter = config.emitter;
    this.bus = config.bus;
    this.contextManager = config.contextManager;
    this.llm = config.llm;
    this.model = config.model;
    this.workflowManager = config.workflowManager;
    this.workflowEngine = config.workflowEngine;
    this.scheduledTaskManager = config.scheduledTaskManager;
    this.getBlackboardGraph = config.getBlackboardGraph;
  }

  getDefinitions(toolNames?: string[]): ToolDefinition[] {
    return this.toolRegistry.getDefinitions(toolNames);
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
      model: this.model,
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
