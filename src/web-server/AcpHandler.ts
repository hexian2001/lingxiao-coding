import type { SessionManager } from '../core/SessionManager.js';
import type { DatabaseManager } from '../core/Database.js';
import type { ConnectionManager } from './ConnectionManager.js';
import { getEventEmitter, type EventEmitter } from '../core/EventEmitter.js';
import { config as runtimeConfig, saveSettings, ConfigSchema, setConfigValue } from '../config.js';
import { getTerminalSessionManager } from '../tools/implementations/TerminalSessionManager.js';
import { isTerminalSessionActiveStatus } from '../core/StateSemantics.js';
import { eventPayloadToSessionUpdateMessage } from '../contracts/adapters/EventAdapter.js';
import { getModelManager } from '../config/ModelManager.js';
import { t } from '../i18n.js';
import { VERSION } from '../version.js';
import { dispatchCallbackCommand, type CallbackCommandDispatcherContext } from '../commands/dispatcher.js';
import { isCallbackSlashCommand, isKnownSlashCommand, getSlashCommands } from '../commands/slash_registry.js';
import { extractAgentMention, isEmptyContent, type MessageContent } from '../llm/types.js';
import { MODE_REGISTRY, type ModeId } from '../contracts/modes.js';
import {
  buildMemoryMaintenanceStatus,
  currentMemoryProjectId,
  resolveMemoryWorkspace,
  runMemoryMaintenancePipeline,
} from '../memory/MemoryMaintenanceStatus.js';


/**
 * 会话级插件开关判定与映射。
 *
 * 仅 bughunt / office / workflow 三个插件按 sessionId 写状态（session-scoped），
 * 其余插件走全局禁用列表。pluginId / sessionKey / toolNames 全部派生自
 * src/contracts/modes.ts 的 MODE_REGISTRY（单一事实源），新增/修改模式只改那里。
 */

/** pluginId 是否为会话级模式插件（同时收窄为 ModeId 类型）。 */
function isSessionScopedPlugin(pluginId: string): pluginId is ModeId {
  return Object.prototype.hasOwnProperty.call(MODE_REGISTRY, pluginId);
}

/** 会话级模式插件的 session_state 开关键（调用方须先通过 isSessionScopedPlugin）。 */
function sessionScopedPluginKey(pluginId: ModeId): string {
  return MODE_REGISTRY[pluginId].sessionKey;
}

/** 会话级模式插件的专属工具名清单；非会话级插件返回空数组。 */
function getPluginToolNames(pluginId: string): readonly string[] {
  return MODE_REGISTRY[pluginId as ModeId]?.toolNames ?? [];
}

function buildPluginModeMetadata(pluginId: string) {
  const toolNames = getPluginToolNames(pluginId);
  return {
    pluginId,
    toolNames,
    toolCount: toolNames.length,
  };
}

function readDisabledPluginIds(): string[] {
  const list = runtimeConfig.plugins?.disabled_ids;
  return Array.isArray(list) ? Array.from(new Set(list)).filter((id) => typeof id === 'string' && id.length > 0) : [];
}

function persistDisabledPluginIds(ids: string[]): void {
  runtimeConfig.plugins = {
    ...(runtimeConfig.plugins || { disabled_ids: [], dirs: [] }),
    disabled_ids: Array.from(new Set(ids)).sort(),
  };
  ConfigSchema.parse(runtimeConfig);
  saveSettings(runtimeConfig);
}

type PermissionResolutionDecision = 'approved' | 'rejected' | 'allowAll';

interface PermissionResolutionRequest {
  requestId: string;
  decision: PermissionResolutionDecision;
}

interface PermissionResolutionFallbackOptions {
  source: 'web';
  permissionResolution: PermissionResolutionRequest & {
    kind: 'permission_resolution';
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isPermissionResolutionDecision(value: unknown): value is PermissionResolutionDecision {
  return value === 'approved' || value === 'rejected' || value === 'allowAll';
}

function parsePermissionResolutionRequest(params?: Record<string, unknown>): PermissionResolutionRequest {
  const requestId = nonEmptyString(params?.requestId);
  const decision = params?.decision;
  if (!requestId || !isPermissionResolutionDecision(decision)) {
    throw new Error('requestId and decision are required');
  }
  return {
    requestId,
    decision,
  };
}

function requireOnlyStringParam(
  params: Record<string, unknown> | undefined,
  field: string,
  allowedFields: ReadonlySet<string>,
): string {
  const unsupported = Object.keys(params || {}).find((key) => !allowedFields.has(key));
  if (unsupported) throw new Error(`Unsupported parameter: ${unsupported}`);
  const value = nonEmptyString(params?.[field]);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

const MODEL_SWITCH_FIELDS = new Set(['model']);
const ETERNAL_GOAL_FIELDS = new Set(['action', 'description']);

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * 处理 ACP JSON-RPC 请求
 * 桥接 Web UI → 凌霄 SessionManager / PermissionSystem
 */
export class AcpHandler {
  private _scheduledTaskManager?: import('../core/ScheduledTaskManager.js').ScheduledTaskManager;

  constructor(
    private sessionManager: SessionManager,
    private db: DatabaseManager,
    private connectionManager: ConnectionManager,
    private onSessionFocus?: (sessionId: string) => void,
    private emitter: EventEmitter = getEventEmitter(),
  ) {}

  /** 注入 ScheduledTaskManager（由 server.ts 在创建后调用） */
  setScheduledTaskManager(stm: import('../core/ScheduledTaskManager.js').ScheduledTaskManager): void {
    this._scheduledTaskManager = stm;
  }

  /**
   * 处理 JSON-RPC 请求
   */
  async handle(request: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    try {
      let result: unknown;

      switch (method) {
        // === Session 操作 ===
        case 'initialize':
          result = {
            protocolVersion: '0.1.0',
            serverInfo: { name: 'lingxiao', version: VERSION },
            capabilities: {},
          };
          break;

        case 'session/new':
          result = await this.handleSessionNew(params);
          break;

        case 'session/load':
          result = await this.handleSessionLoad(params);
          break;

        case 'session/focus':
          result = await this.handleSessionFocus(params);
          break;

        case 'session/runtime_state':
          result = await this.handleSessionRuntimeState(params, sessionId);
          break;

        case 'session/prompt':
          result = await this.handleSessionPrompt(params, sessionId);
          break;

        case 'session/nudge':
          result = await this.handleSessionNudge(params, sessionId);
          break;

        case 'session/cancel':
          result = await this.handleSessionCancel(sessionId);
          break;

        // === 斜杠命令 ===
        case 'session/command':
          result = await this.handleSlashCommand(params, sessionId);
          break;

        case 'session/set_model':
          result = await this.handleSetModel(params, sessionId);
          break;

        case 'session/set_agent_model':
          result = await this.handleSetAgentModel(params, sessionId);
          break;

        case 'session/set_mode':
          result = await this.handleSetMode(params, sessionId);
          break;

        case 'session/set_control_mode':
          result = await this.handleSetControlMode(params, sessionId);
          break;

        case 'session/set_collaboration_mode':
          result = await this.handleSetCollaborationMode(params, sessionId);
          break;

        case 'session/set_execution_route':
          result = await this.handleSetExecutionRoute(params, sessionId);
          break;

        case 'session/set_eternal_goal':
          result = await this.handleSetEternalGoal(params, sessionId);
          break;

        case 'session/set_extended_thinking':
          result = await this.handleSetExtendedThinking(params, sessionId);
          break;

        case 'session/set_config_option':
          result = await this.handleSetConfigOption(params, sessionId);
          break;

        // === 权限审批 ===
        case '_lingxiao.ai/resolvePermission':
          result = await this.handleResolvePermission(params, sessionId);
          break;

        // === Plan 审批 ===
        case 'session/approvePlan':
          result = await this.handleApprovePlan(sessionId);
          break;

        case 'session/rejectPlan':
          result = await this.handleRejectPlan(params, sessionId);
          break;

        // === 用户信息 ===
        case '_lingxiao.ai/getUserInfo':
          result = { name: 'root', authenticated: true };
          break;

        // === 终端输入 ===
        case '_lingxiao.ai/terminalInput':
          result = await this.handleTerminalInput(params);
          break;

        // === 插件管理 ===
        case 'plugin/status':
          result = await this.handlePluginStatus(params);
          break;

        case 'plugin/enable':
          result = await this.handlePluginToggle(params, true);
          break;

        case 'plugin/disable':
          result = await this.handlePluginToggle(params, false);
          break;

        case 'commands/list':
          result = this.handleCommandsList(sessionId);
          break;

        case 'memory/status':
          result = this.handleMemoryStatus(params, sessionId);
          break;

        case 'memory/run':
          result = await this.handleMemoryRun(params, sessionId);
          break;

        default:
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }

      return { jsonrpc: '2.0', id: id ?? null, result };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async handleSessionNew(params?: Record<string, unknown>) {
    const workspace = (params?.cwd as string) || process.cwd();
    const prompt = (params?.prompt as string) || '';
    // idle=true: don't trigger LLM on session creation, wait for actual user message
    const sessionId = await this.sessionManager.createSession(prompt, workspace, { idle: true });

    const mm = getModelManager();
    const models = mm.getAllModels().map((m) => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider,
    }));

    return {
      sessionId,
      models,
      modes: ['strict', 'dev', 'networked', 'yolo'],
      configOptions: {},
      runtime: this.readRuntimeSnapshot(sessionId, 'acp_session_new'),
    };
  }

  private async handleSessionLoad(params?: Record<string, unknown>) {
    const sessionId = nonEmptyString(params?.sessionId);
    if (!sessionId) {
      throw new Error('sessionId is required');
    }

    const resumed = await this.sessionManager.resumeSession(sessionId);
    if (!resumed) {
      throw new Error('Session not found');
    }

    const info = this.db.getSession(sessionId);
    return {
      sessionId,
      session: info,
      history: this.sessionManager.getSessionHistory(sessionId),
      runtime: this.readRuntimeSnapshot(sessionId, 'acp_session_load'),
    };
  }

  private async handleSessionRuntimeState(params?: Record<string, unknown>, sessionId?: string) {
    const targetSessionId = nonEmptyString(params?.sessionId) || sessionId;
    if (!targetSessionId) {
      throw new Error('sessionId is required');
    }
    if (!this.sessionManager.getSession(targetSessionId)) {
      const resumed = await this.sessionManager.resumeSession(targetSessionId);
      if (!resumed) {
        throw new Error('Session not found');
      }
    }
    const snapshot = this.readRuntimeSnapshot(targetSessionId, 'acp_runtime_state');
    if (!snapshot) {
      throw new Error('Runtime state unavailable');
    }
    return { success: true, sessionId: targetSessionId, ...snapshot };
  }

  private readRuntimeSnapshot(sessionId: string, source: string) {
    const manager = this.sessionManager as Partial<SessionManager>;
    return manager.publishSessionRuntimeState?.(sessionId, { source })
      ?? manager.getInteractionRuntimeState?.(sessionId)
      ?? null;
  }

  private async handleSessionFocus(params?: Record<string, unknown>) {
    const targetSessionId = nonEmptyString(params?.sessionId);
    if (!targetSessionId) throw new Error('sessionId is required');

    // Ensure session is loaded into memory so SSE events route correctly
    if (!this.sessionManager.getSession(targetSessionId)) {
      await this.sessionManager.resumeSession(targetSessionId).catch(() => {});
    }
    const targetSession = this.db.getSession(targetSessionId);
    const focusPayload = {
      sessionId: targetSessionId,
      status: targetSession?.status as 'active' | 'completed' | 'failed' | 'interrupted' | undefined,
      workspace: targetSession?.workspace,
    };

    // 通知 TUI 切换会话
    this.onSessionFocus?.(targetSessionId);

    // 桥接到 EventEmitter，让同进程 TUI 感知 Web UI 的会话切换
    this.emitter.emit('session:focus', focusPayload);

    // 广播给所有 SSE 客户端，Web UI 其他标签页也可感知
    const stats = this.connectionManager.getStats();
    for (const { sessionId: sid } of stats.perSession) {
      this.connectionManager.broadcastToSession(sid, {
        method: 'session:focus',
        params: focusPayload,
      });
    }

    const runtime = this.readRuntimeSnapshot(targetSessionId, 'acp_session_focus');
    return { success: true, sessionId: targetSessionId, runtime };
  }

  private async handleSessionPrompt(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }

    // Auto-resume session if not in memory
    if (!this.sessionManager.getSession(sessionId)) {
      const resumed = await this.sessionManager.resumeSession(sessionId);
      if (!resumed) {
        throw new Error(t('error.session_not_found', sessionId));
      }
    }

    const prompt = params?.prompt;
    if (prompt === undefined || isEmptyContent(prompt)) {
      throw new Error('prompt is required');
    }

    // Support both string and structured content (array with image_url etc.)
    const message = prompt as MessageContent;
    // @<agent> routing is semantic, not wire-shape: an image attachment flips
    // prompt from string to array, yet the directive must still reach the agent.
    const mention = extractAgentMention(message);
    if (mention) {
      const result = await this.sessionManager.sendAgentInput(sessionId, mention.agentName, mention.rest);
      if (!result.ok) throw new Error(result.message);
      return { success: true, result };
    }
    await this.sessionManager.sendUserInput(sessionId, message, { interrupt: false, source: 'web' });
    return { success: true };
  }

  /**
   * 非打断式用户指导：注入消息到 Leader 下一轮 LLM 调用，不中断当前思考
   */
  private async handleSessionNudge(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    if (!this.sessionManager.getSession(sessionId)) {
      const resumed = await this.sessionManager.resumeSession(sessionId);
      if (!resumed) {
        throw new Error(t('error.session_not_found', sessionId));
      }
    }
    const prompt = params?.prompt;
    if (prompt === undefined || isEmptyContent(prompt)) {
      throw new Error('prompt is required');
    }
    const message = prompt as MessageContent;
    // @<agent> routing is semantic, not wire-shape: an image attachment flips
    // prompt from string to array, yet the directive must still reach the agent.
    const mention = extractAgentMention(message);
    if (mention) {
      const result = await this.sessionManager.sendAgentInput(sessionId, mention.agentName, mention.rest);
      if (!result.ok) throw new Error(result.message);
      return { success: true, result };
    }
    await this.sessionManager.sendUserInput(sessionId, message, { interrupt: false, source: 'web' });
    return { success: true };
  }

  private async handleSessionCancel(sessionId?: string) {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }

    // Auto-resume session if not in memory
    if (!this.sessionManager.getSession(sessionId)) {
      const resumed = await this.sessionManager.resumeSession(sessionId);
      if (!resumed) {
        return { success: false, error: 'Session not found' };
      }
    }

    const ok = await this.sessionManager.interruptSession(sessionId);
    return { success: ok };
  }

  /**
   * 斜杠命令分发 — 通过 dispatcher 执行 callback 类型命令
   */
  private async handleSlashCommand(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const command = params?.command as string;
    if (!command) throw new Error('command is required');

    // 验证是合法的斜杠命令
    const workspace = resolveMemoryWorkspace(this.db, sessionId, process.cwd());
    if (!isKnownSlashCommand(command, workspace)) {
      return { success: false, error: `Unknown command: ${command}` };
    }

    // callback 类型命令通过 dispatcher 执行
    if (isCallbackSlashCommand(command, workspace)) {
      const context: CallbackCommandDispatcherContext = {
        db: this.db,
        sessionManager: this.sessionManager,
        emitter: this.emitter,
        cwd: process.cwd(),
        getCurrentSessionId: () => sessionId,
        setCurrentSessionId: () => {},
        scheduledTaskManager: this._scheduledTaskManager,
      };
      try {
        const result = await dispatchCallbackCommand(command, context);
        if (result) {
          return { success: true, result };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // tui-local 类型命令需要特殊处理
    // /clear — 清空对话（DB + 内存）
    if (command === '/clear' || command === '/reset') {
      this.db.clearConversation(sessionId);
      // 清空内存中的消息历史
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        session.bus.clearHistory();
      }
      return { success: true, action: 'clear' };
    }

    // /compact — 压缩上下文（通过 Leader contextManager）
    if (command === '/compact') {
      try {
        const session = this.sessionManager.getSession(sessionId);
        if (session?.leader) {
          const leader = session.leader as unknown as { compactContext?: () => Promise<void> };
          // 必须走 leader.compactContext()：内部 setMessages → forceCompact → 回写 conversation。
          // 直接调 contextManager.forceCompact() 不会回写 Leader.conversation，会导致下一轮
          // LLM 调用还是把旧消息发出去。
          if (typeof leader.compactContext === 'function') {
            await leader.compactContext();
            return { success: true, action: 'compact' };
          }
        }
        return { success: false, error: 'Session not available for compaction' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // /stop — 中断会话
    if (command === '/stop') {
      const ok = await this.sessionManager.interruptSession(sessionId);
      return { success: ok, action: 'stop' };
    }

    // /approve — 批准待审批项
    if (command === '/approve') {
      await this.sessionManager.sendUserInput(sessionId, '/approve', { source: 'web' });
      return { success: true, action: 'approve' };
    }

    // /deny — 拒绝待处理请求
    if (command === '/deny') {
      await this.sessionManager.sendUserInput(sessionId, '/deny', { source: 'web' });
      return { success: true, action: 'deny' };
    }

    // /mode — 切换权限模式
    if (command === '/mode') {
      const mode = (params?.args as string)?.trim();
      if (mode) {
        const result = this.sessionManager.setPermissionMode(sessionId, mode);
        return { success: result.ok, message: result.message, action: 'mode' };
      }
      return { success: false, error: 'Usage: /mode <strict|dev|networked|yolo>' };
    }

    // /intervene — 发送干预消息
    if (command === '/intervene') {
      const msg = (params?.args as string)?.trim();
      if (msg) {
        await this.sessionManager.sendUserInput(sessionId, msg, { source: 'web' });
        return { success: true, action: 'intervene' };
      }
      return { success: false, error: 'Usage: /intervene <message>' };
    }

    // /language — 切换语言
    if (command === '/language') {
      const lang = (params?.args as string)?.trim();
      if (lang === 'zh' || lang === 'en') {
        // 同时刷新 UI 语言(currentLanguage)与会话语言(sessionLanguage)，
        // 使 prompt locale(getPromptLocale 读 session>current) 与前端显示同步生效。
        const { setLanguage, setSessionLanguage } = await import('../i18n.js');
        setLanguage(lang);
        setSessionLanguage(lang);
        return { success: true, action: 'language', language: lang };
      }
      return { success: false, error: 'Usage: /language <zh|en>' };
    }

    // 未识别的 tui-local 命令
    return { success: false, error: `Command ${command} is not supported in web UI` };
  }

  private async handleSetModel(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const model = requireOnlyStringParam(params, 'model', MODEL_SWITCH_FIELDS);

    const result = this.sessionManager.setModel(sessionId, model);
    if (!result.ok) throw new Error(result.message);
    return { success: true, model, message: result.message };
  }

  private async handleSetAgentModel(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const model = requireOnlyStringParam(params, 'model', MODEL_SWITCH_FIELDS);

    const result = this.sessionManager.setAgentModel(sessionId, model);
    if (!result.ok) throw new Error(result.message);
    return { success: true, model, message: result.message };
  }

  private async handleSetMode(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const modeId = params?.modeId as string;
    if (!modeId) throw new Error('modeId is required');

    const result = this.sessionManager.setPermissionMode(sessionId, modeId);
    if (!result.ok) throw new Error(result.message);
    return { success: true, mode: modeId, message: result.message };
  }

  private async handleSetControlMode(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const mode = params?.mode as string;
    if (mode !== 'manual' && mode !== 'eternal') {
      throw new Error(`invalid control mode: ${String(mode)}`);
    }

    const result = await this.sessionManager.setControlMode(sessionId, mode);
    if (!result.ok) throw new Error(result.message);
    return {
      success: true,
      mode,
      message: result.message,
      runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_control_mode'),
    };
  }

  private async handleSetCollaborationMode(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const mode = params?.mode as string;
    if (mode !== 'solo' && mode !== 'team') {
      throw new Error(`invalid collaboration mode: ${String(mode)}`);
    }

    const result = this.sessionManager.setCollaborationMode(sessionId, mode);
    if (!result.ok) throw new Error(result.message);
    return {
      success: true,
      mode,
      message: result.message,
      runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_collaboration_mode'),
    };
  }

  private async handleSetExecutionRoute(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const mode = params?.mode as string;
    if (mode !== 'auto' && mode !== 'direct' && mode !== 'hybrid' && mode !== 'delegate') {
      throw new Error(`invalid execution route preference: ${String(mode)}`);
    }

    const result = this.sessionManager.setExecutionRoutePreference(sessionId, mode);
    if (!result.ok) throw new Error(result.message);
    return {
      success: true,
      mode,
      message: result.message,
      runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_execution_route'),
    };
  }

  private async handleSetEternalGoal(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const unsupported = Object.keys(params || {}).find((key) => !ETERNAL_GOAL_FIELDS.has(key));
    if (unsupported) throw new Error(`Unsupported parameter: ${unsupported}`);
    const action = typeof params?.action === 'string' ? params.action.toLowerCase() : 'set';
    if (action === 'pause') {
      const result = await this.sessionManager.setEternalGoalPaused(sessionId, true);
      if (!result.ok) throw new Error(result.message);
      return {
        success: true,
        action,
        goal: result.goal,
        message: result.message,
        runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_eternal_goal'),
      };
    }
    if (action === 'resume') {
      const result = await this.sessionManager.setEternalGoalPaused(sessionId, false);
      if (!result.ok) throw new Error(result.message);
      return {
        success: true,
        action,
        goal: result.goal,
        message: result.message,
        runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_eternal_goal'),
      };
    }
    if (action === 'clear') {
      const result = await this.sessionManager.clearEternalGoal(sessionId);
      if (!result.ok) throw new Error(result.message);
      return {
        success: true,
        action: 'clear',
        goal: null,
        message: result.message,
        runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_eternal_goal'),
      };
    }
    if (action !== 'set') {
      throw new Error(`invalid eternal goal action: ${action}`);
    }
    const description = typeof params?.description === 'string' ? params.description.trim() : '';
    if (!description) throw new Error('description is required');
    const result = await this.sessionManager.setEternalGoal(sessionId, description);
    if (!result.ok) throw new Error(result.message);
    return {
      success: true,
      action: 'set',
      goal: result.goal,
      message: result.message,
      runtime: this.readRuntimeSnapshot(sessionId, 'acp_set_eternal_goal'),
    };
  }

  private async handleSetExtendedThinking(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const enabled = Boolean(params?.enabled);

    setConfigValue('llm.enable_extended_thinking', enabled);
    ConfigSchema.parse(runtimeConfig);
    saveSettings(runtimeConfig);

    const message = eventPayloadToSessionUpdateMessage('settings:changed', {
      sessionId,
      key: 'alwaysThinkingEnabled',
      configPath: 'llm.enable_extended_thinking',
      value: enabled,
    }, sessionId, { source: 'acp-handler' });
    if (message) {
      this.connectionManager.broadcastToSession(sessionId, message.message as unknown as Record<string, unknown>);
    }

    return {
      success: true,
      enabled,
      message: enabled ? 'Extended thinking enabled' : 'Extended thinking disabled',
    };
  }

  private async handleSetConfigOption(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const configId = params?.configId as string;
    if (!configId) throw new Error('configId is required');
    const value = params?.value;

    await this.db.setSessionState(sessionId, `config:${configId}`, JSON.stringify(value ?? null));
    return { success: true, configId, value };
  }

  private async handleResolvePermission(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');

    const resolution = parsePermissionResolutionRequest(params);

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      const fallback = resolution.decision === 'rejected' ? '/deny' : '/approve';
      const fallbackOptions: PermissionResolutionFallbackOptions = {
        source: 'web',
        permissionResolution: {
          kind: 'permission_resolution',
          ...resolution,
        },
      };
      await this.sessionManager.sendUserInput(sessionId, fallback, fallbackOptions);
      return { success: true, requestId: resolution.requestId, decision: resolution.decision };
    }

    session.leader.resolvePermissionFromWebUI(resolution.requestId, resolution.decision);
    return { success: true, requestId: resolution.requestId, decision: resolution.decision };
  }

  private async handleApprovePlan(sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    await this.sessionManager.sendUserInput(sessionId, '/approve');
    return { success: true };
  }

  private async handleRejectPlan(params?: Record<string, unknown>, sessionId?: string) {
    if (!sessionId) throw new Error('sessionId is required');
    const feedback = (params?.feedback as string) || '请重新规划';
    await this.sessionManager.sendUserInput(sessionId, feedback);
    return { success: true };
  }

  private async handleTerminalInput(params?: Record<string, unknown>) {
    const terminalId = params?.terminalId as string;
    const input = params?.input as string;
    if (!terminalId || input === undefined) {
      throw new Error('terminalId and input are required');
    }

    const manager = getTerminalSessionManager();
    const session = manager.getSession(terminalId);
    if (!session) {
      throw new Error(`Terminal session ${terminalId} not found`);
    }
    if (!isTerminalSessionActiveStatus(session.status)) {
      throw new Error(`Terminal session ${terminalId} is ${session.status}`);
    }

    const success = manager.writeToSession(terminalId, input);
    if (!success) {
      throw new Error(`Failed to write to terminal session ${terminalId}`);
    }
    return { success: true, terminalId };
  }

  private async handlePluginStatus(params?: Record<string, unknown>) {
    const pluginId = nonEmptyString(params?.pluginId);
    if (!pluginId) throw new Error('pluginId is required');
    const sessionId = nonEmptyString(params?.sessionId);
    if (isSessionScopedPlugin(pluginId) && !sessionId) {
      throw new Error(`${pluginId} is session-scoped; sessionId is required`);
    }
    if (isSessionScopedPlugin(pluginId) && sessionId) {
      const key = sessionScopedPluginKey(pluginId);
      return {
        enabled: this.db.getSessionState(sessionId, key) === 'true',
        ...buildPluginModeMetadata(pluginId),
      };
    }
    const disabledList = readDisabledPluginIds();
    return { enabled: !disabledList.includes(pluginId), ...buildPluginModeMetadata(pluginId) };
  }

  private async handlePluginToggle(params?: Record<string, unknown>, enable?: boolean) {
    const pluginId = nonEmptyString(params?.pluginId);
    if (!pluginId) throw new Error('pluginId is required');
    const sessionId = nonEmptyString(params?.sessionId);
    if (isSessionScopedPlugin(pluginId) && !sessionId) {
      throw new Error(`${pluginId} is session-scoped; sessionId is required`);
    }
    if (isSessionScopedPlugin(pluginId) && sessionId) {
      const key = sessionScopedPluginKey(pluginId);
      this.db.setSessionState(sessionId, key, String(enable ?? false));
      const metadata = buildPluginModeMetadata(pluginId);
      this.emitter.emit('plugin:toggled', { ...metadata, enabled: enable ?? false, sessionId });
      return { success: true, ...metadata, enabled: enable, sessionId };
    }

    const current = readDisabledPluginIds();
    if (enable) {
      const idx = current.indexOf(pluginId);
      if (idx >= 0) current.splice(idx, 1);
    } else {
      if (!current.includes(pluginId)) current.push(pluginId);
    }
    persistDisabledPluginIds(current);

    if (isSessionScopedPlugin(pluginId)) {
      this.emitter.emit('plugin:toggled', { ...buildPluginModeMetadata(pluginId), enabled: enable ?? false });
    }

    return { success: true, ...buildPluginModeMetadata(pluginId), enabled: enable };
  }

  /**
   * Return the full slash command list for web UI autocomplete.
   * Filters out tui-local-only commands and provides localized descriptions.
   */
  private handleCommandsList(sessionId?: string) {
    const workspace = resolveMemoryWorkspace(this.db, sessionId, process.cwd());
    const all = getSlashCommands(workspace);
    // Web supports callback commands + a few tui-local that AcpHandler handles directly
    const webSupportedTuiLocal = new Set(['/language', '/clear', '/stop']);
    const commands = all
      .filter(cmd => cmd.handledBy === 'callback' || webSupportedTuiLocal.has(cmd.name))
      .map(cmd => ({ name: cmd.name, desc: cmd.desc, usage: cmd.usage }));
    return { commands };
  }

  private handleMemoryStatus(params?: Record<string, unknown>, sessionId?: string) {
    const targetSessionId = nonEmptyString(params?.sessionId) || sessionId;
    const workspace = resolveMemoryWorkspace(this.db, targetSessionId, process.cwd());
    return { success: true, status: buildMemoryMaintenanceStatus(workspace) };
  }

  private async handleMemoryRun(params?: Record<string, unknown>, sessionId?: string) {
    const kind = params?.kind;
    if (kind !== 'dream' && kind !== 'distill') {
      throw new Error('kind must be dream or distill');
    }
    const targetSessionId = nonEmptyString(params?.sessionId) || sessionId;
    const workspace = resolveMemoryWorkspace(this.db, targetSessionId, process.cwd());
    return runMemoryMaintenancePipeline({
      kind,
      workspace,
      projectId: currentMemoryProjectId(this.sessionManager, targetSessionId),
      dbPath: this.db.getPath(),
      emitter: this.emitter,
      sessionId: targetSessionId,
      allowOverwrite: Boolean(params?.allowOverwrite),
    });
  }
}
