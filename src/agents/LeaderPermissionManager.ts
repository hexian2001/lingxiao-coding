/**
 * LeaderPermissionManager
 * Manages tool permission context, permission requests, and resolution.
 * Extracted from LeaderAgent lines 1217–1434.
 */

import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { ChatMessage } from '../llm/types.js';
import {
  getLeaderDefaultPermissionContext,
  summarizePermissionContextForDisplay,
  type PermissionRequestPayload,
  type PermissionUpdate,
  type ToolPermissionContext,
} from '../core/PermissionSystem.js';
import {
  applyAndPersistPermissionUpdates,
  loadEffectivePermissionContext,
  type PermissionUpdateDestination,
} from '../core/PermissionStore.js';
import {
  createPermissionResponsePayload,
} from '../core/AgentProtocol.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { t } from '../i18n.js';

export interface LeaderPermissionManagerDeps {
  sessionId: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  bus: MessageBus;
  workspace: string;
  /** Called when a permission request causes the leader to wait for user input */
  setWaitingForUser: (waiting: boolean) => void;
  /** Add a message to the conversation and persist it */
  addAndPersistMessage: (msg: ChatMessage) => void;
}

export class LeaderPermissionManager {
  permissionContext: ToolPermissionContext;
  pendingPermissionRequest: PermissionRequestPayload | null = null;
  private pendingPermissionQueue: PermissionRequestPayload[] = [];
  private resolvedPermissionRequestIds = new Set<string>();
  /**
   * 已收到、尚未被 Leader LLM 应答的 worker 权限请求，按 requestId 索引。
   * 用途：Leader LLM 调 request_permission_update 时若漏传 worker_name / request_id，
   * 仍能据 toolName 反查恢复 source='worker'，避免 worker 永久阻塞在 waitForMessageType。
   */
  private pendingWorkerRequests = new Map<string, PermissionRequestPayload>();

  private sessionId: string;
  private db: DatabaseManager;
  private emitter: EventEmitter;
  private bus: MessageBus;
  private workspace: string;
  private setWaitingForUser: (waiting: boolean) => void;
  private addAndPersistMessage: (msg: ChatMessage) => void;

  constructor(deps: LeaderPermissionManagerDeps) {
    this.sessionId = deps.sessionId;
    this.db = deps.db;
    this.emitter = deps.emitter;
    this.bus = deps.bus;
    this.workspace = deps.workspace;
    this.setWaitingForUser = deps.setWaitingForUser;
    this.addAndPersistMessage = deps.addAndPersistMessage;
    this.permissionContext = getLeaderDefaultPermissionContext();
  }

  getPermissionContext(): ToolPermissionContext {
    return this.permissionContext;
  }

  emitPermissionMode(): void {
    this.emitter.emit('permission:mode_changed', {
      sessionId: this.sessionId,
      mode: this.permissionContext.mode,
      summary: summarizePermissionContextForDisplay(this.permissionContext),
    });
  }

  private auditPermission(event: {
    actor: 'leader' | 'worker' | 'user' | 'system';
    source: string;
    mode: ToolPermissionContext['mode'];
    toolName?: string;
    reason: string;
    requestId?: string;
    workerName?: string;
  }): void {
    const record = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...event,
    };
    try {
      this.db.updateSessionState<unknown[]>(
        this.sessionId,
        SESSION_KEYS.PERMISSION_AUDIT_LOG,
        (current) => {
          const list = Array.isArray(current) ? current : [];
          return [...list.slice(-199), record];
        },
      );
    } catch { /* tolerate */ }
    try {
      this.emitter.emit('permission:audit', record);
    } catch { /* tolerate */ }
  }

  loadPermissionContextFromState(): void {
    const loaded = loadEffectivePermissionContext(
      this.db,
      this.workspace,
      this.sessionId
    );
    const stored = this.db.getSessionState(this.sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT);
    this.permissionContext = stored == null ? getLeaderDefaultPermissionContext() : loaded;
    if (stored == null) {
      this.auditPermission({
        actor: 'leader',
        source: 'leader_default_permission_context',
        mode: this.permissionContext.mode,
        reason: 'session 未设置权限上下文，Leader 使用中心化默认权限模式。',
      });
    }
    this.emitPermissionMode();
  }

  applyPermissionUpdates(
    updates: PermissionUpdate[],
    destination: PermissionUpdateDestination = 'session'
  ): ToolPermissionContext {
    this.permissionContext = applyAndPersistPermissionUpdates(
      this.db,
      this.workspace,
      this.sessionId,
      updates,
      destination
    );
    for (const update of updates) {
      if (update.type === 'setMode' && update.mode === 'yolo') {
        this.auditPermission({
          actor: 'user',
          source: `permission_update:${destination}`,
          mode: 'yolo',
          reason: '权限更新将模式设置为 yolo。',
        });
      }
    }
    this.emitPermissionMode();
    return this.permissionContext;
  }

  private openPermissionGate(payload: PermissionRequestPayload): void {
    if (this.pendingPermissionRequest?.requestId === payload.requestId) {
      return;
    }
    if (this.pendingPermissionQueue.some((request) => request.requestId === payload.requestId)) {
      return;
    }
    if (this.pendingPermissionRequest) {
      this.pendingPermissionQueue.push(payload);
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: `权限请求已排队: ${payload.toolName}`,
      });
      return;
    }

    this.pendingPermissionRequest = payload;
    this.db.setSessionState(this.sessionId, SESSION_KEYS.PENDING_PERMISSION_REQUEST, payload);
    this.db.setSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_GATE, {
      kind: 'permission',
      requestId: payload.requestId,
      source: payload.source,
      toolName: payload.toolName,
      reason: payload.reason,
      workerName: payload.workerName,
    });
    this.emitter.emit('permission:request', {
      sessionId: this.sessionId,
      requestId: payload.requestId,
      source: payload.source,
      toolName: payload.toolName,
      reason: payload.reason,
      requestedMode: payload.requestedMode,
      requestedHosts: payload.requestedHosts,
      workerName: payload.workerName,
    });
    this.setWaitingForUser(true);
    this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
    this.db.setSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_INPUT, 'permission_request');
  }

  private openNextPermissionGate(): void {
    const next = this.pendingPermissionQueue.shift();
    if (!next) return;
    this.openPermissionGate(next);
  }

  private rememberResolvedPermissionRequest(requestId: string): void {
    this.resolvedPermissionRequestIds.add(requestId);
    if (this.resolvedPermissionRequestIds.size > 500) {
      const oldest = this.resolvedPermissionRequestIds.values().next().value;
      if (oldest) {
        this.resolvedPermissionRequestIds.delete(oldest);
      }
    }
  }

  private sendPermissionResponseToWorker(payload: PermissionRequestPayload, decision: 'approved' | 'rejected'): void {
    this.rememberResolvedPermissionRequest(payload.requestId);
    if (payload.source !== 'worker' || !payload.workerName) return;
    this.bus.send(
      `${this.sessionId}:leader`,
      `${this.sessionId}:${payload.workerName}`,
      'permission_response',
      createPermissionResponsePayload(payload.requestId, decision),
    );
    this.pendingWorkerRequests.delete(payload.requestId);
  }

  private closePermissionGate(payload: PermissionRequestPayload, decision: 'approved' | 'rejected' | 'allowAll'): void {
    this.pendingPermissionRequest = null;
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.PENDING_PERMISSION_REQUEST);
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_GATE);
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_INPUT);
    this.setWaitingForUser(false);
    this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
    this.emitter.emit('permission:resolved', {
      sessionId: this.sessionId,
      requestId: payload.requestId,
      decision,
      workerName: payload.workerName,
      toolName: payload.toolName,
    });
  }

  private approvePermissionAutomatically(payload: PermissionRequestPayload, source: string): void {
    const updates: PermissionUpdate[] = [];
    if (payload.requestedMode) {
      updates.push({ type: 'setMode', mode: payload.requestedMode });
    }
    if (payload.requestedHosts && payload.requestedHosts.length > 0) {
      updates.push({ type: 'replaceHosts', hosts: payload.requestedHosts });
    }
    this.applyPermissionUpdates(updates, payload.destination || 'session');
    this.auditPermission({
      actor: payload.source,
      source,
      mode: this.permissionContext.mode,
      toolName: payload.toolName,
      reason: payload.reason,
      requestId: payload.requestId,
      workerName: payload.workerName,
    });

    this.sendPermissionResponseToWorker(payload, 'approved');
  }

  requestPermissionUpdate(payload: PermissionRequestPayload, eternalMode: boolean): string {
    // 容错：Leader LLM 调 request_permission_update 时若漏传 worker_name / request_id，
    // 但 pendingWorkerRequests 里有未应答的 worker 请求，则按 requestId / toolName 反查恢复，
    // 防止"权限放行成功 → worker 永远等不到 permission_response"的死锁。
    payload = this.recoverWorkerContext(payload);

    // === Eternal 模式：自动批准权限请求（但 yolo 需用户确认） ===
    if (eternalMode) {
      // 安全上限：yolo 模式在无人值守时仍需用户确认
      if (payload.requestedMode === 'yolo') {
        // 走正常权限审批流程，不自动批准
      } else {
        this.approvePermissionAutomatically(payload, 'eternal_auto_approve');
        this.emitter.emit('permission:resolved', {
          sessionId: this.sessionId,
          requestId: payload.requestId,
          decision: 'approved',
          workerName: payload.workerName,
          toolName: payload.toolName,
        });
        return `[Eternal 自治模式] 权限已自动批准：${payload.toolName}（${payload.reason}）`;
      }
    }

    this.openPermissionGate(payload);

    return `权限请求已发起：
- source: ${payload.source}
- tool: ${payload.toolName}
- destination: ${payload.destination || 'session'}
- reason: ${payload.reason}

请回复 /approve 或 /deny。
如需更细粒度控制，可使用 /allow-tool、/deny-tool、/ask-tool 或 /mode。`;
  }

  resolvePendingPermissionFromUserInput(content: string): 'resolved' | 'pending' | 'none' {
    if (!this.pendingPermissionRequest) {
      return 'none';
    }

    const normalized = content.trim().toLowerCase();
    if (!['/approve', '/deny'].includes(normalized)) {
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: t('permission.status.waiting_approval'),
      });
      return 'pending';
    }

    const pending = this.pendingPermissionRequest;

    if (normalized === '/approve') {
      const updates: PermissionUpdate[] = [];
      if (pending.requestedMode) {
        updates.push({ type: 'setMode', mode: pending.requestedMode });
      }
      if (pending.requestedHosts && pending.requestedHosts.length > 0) {
        updates.push({ type: 'replaceHosts', hosts: pending.requestedHosts });
      }
      this.applyPermissionUpdates(updates, pending.destination || 'session');
      this.sendPermissionResponseToWorker(pending, 'approved');
      this.closePermissionGate(pending, 'approved');
      this.openNextPermissionGate();

      this.addAndPersistMessage({
        role: 'assistant',
        content: `权限已批准：${summarizePermissionContextForDisplay(this.permissionContext)}`,
      });
      return 'resolved';
    }

    this.sendPermissionResponseToWorker(pending, 'rejected');
    this.closePermissionGate(pending, 'rejected');
    this.openNextPermissionGate();
    this.addAndPersistMessage({
      role: 'assistant',
      content: `权限请求已拒绝：${pending.reason}`,
    });
    return 'resolved';
  }

  /**
   * 从 Web UI 直接解决权限请求（绕过文本输入解析）
   * 由 AcpHandler 调用，当用户在 Web UI 点击批准/拒绝时触发
   */
  resolvePermissionFromWebUI(requestId: string, decision: 'approved' | 'rejected' | 'allowAll'): void {
    if (!this.pendingPermissionRequest) return;
    if (this.pendingPermissionRequest.requestId !== requestId) return;

    const pending = this.pendingPermissionRequest;

    if (decision === 'allowAll') {
        // 全部允许：切换到 yolo 模式，后续所有工具调用无需再审批
        const updates: PermissionUpdate[] = [
          { type: 'setMode', mode: 'yolo' },
        ];
      this.applyPermissionUpdates(updates, 'session');
      this.auditPermission({
        actor: 'user',
        source: 'web_ui_allow_all',
        mode: 'yolo',
        toolName: pending.toolName,
        reason: pending.reason,
        requestId: pending.requestId,
        workerName: pending.workerName,
      });
    } else if (decision === 'approved') {
      const updates: PermissionUpdate[] = [];
      if (pending.requestedMode) {
        updates.push({ type: 'setMode', mode: pending.requestedMode });
      }
      if (pending.requestedHosts && pending.requestedHosts.length > 0) {
        updates.push({ type: 'replaceHosts', hosts: pending.requestedHosts });
      }
      this.applyPermissionUpdates(updates, pending.destination || 'session');
    }

    this.sendPermissionResponseToWorker(pending, (decision === 'approved' || decision === 'allowAll') ? 'approved' : 'rejected');
    this.closePermissionGate(pending, decision);
    this.openNextPermissionGate();
  }

  /**
   * 注册一条来自 worker 的 permission_request 控制消息。
   * 由 LeaderAgent 在主循环看到 controlMessage.kind === 'permission_request' 时调用。
   * 让 requestPermissionUpdate 的 recoverWorkerContext 能据此还原 source/workerName/requestId。
   */
  registerPendingWorkerRequest(payload: PermissionRequestPayload): void {
    if (!payload.requestId) return;
    this.pendingWorkerRequests.set(payload.requestId, payload);
  }

  receiveWorkerPermissionRequest(payload: PermissionRequestPayload, eternalMode: boolean): string {
    if (this.resolvedPermissionRequestIds.has(payload.requestId)) {
      return `权限请求已处理：${payload.toolName}`;
    }
    this.registerPendingWorkerRequest(payload);
    return this.requestPermissionUpdate(payload, eternalMode);
  }

  /**
   * 切到 eternal 模式时调用：把所有非 yolo 的 pending 权限请求一次性自动批准。
   *
   * 默认 requestPermissionUpdate 进 eternal 分支只对"新请求"自动批准，
   * 早就卡在那里的 manual 模式请求若不主动回放，worker 会等到 PERMISSION_TIMEOUT_MS。
   *
   * 返回回放的请求数。yolo 请求不动，仍等待人审。
   */
  replayPendingOnEternalEnable(): number {
    let replayed = 0;
    while (this.pendingPermissionRequest) {
      const pending = this.pendingPermissionRequest;
      if (pending.requestedMode === 'yolo') {
        break;
      }
      this.approvePermissionAutomatically(pending, 'eternal_replay_auto_approve');
      this.closePermissionGate(pending, 'approved');
      replayed += 1;
      this.openNextPermissionGate();
    }
    return replayed;
  }

  /**
   * 根据 pendingWorkerRequests 反查恢复 worker 上下文。
   * 触发条件：Leader LLM 在 request_permission_update 调用中漏传 worker_name / request_id，
   * 但实际有未应答的 worker 权限请求等待中。
   *
   * 优先级：
   *   1. payload.requestId 命中 pendingWorkerRequests → 用 pending 的 workerName / requestId / toolName
   *   2. payload.toolName 命中唯一一条 pending 请求 → 同上
   *   3. 都没命中 → 原样返回（视作 leader 自发请求）
   */
  private recoverWorkerContext(payload: PermissionRequestPayload): PermissionRequestPayload {
    if (payload.source === 'worker' && payload.workerName) {
      return payload;
    }
    if (this.pendingWorkerRequests.size === 0) {
      return payload;
    }

    let pending: PermissionRequestPayload | undefined;
    if (payload.requestId && this.pendingWorkerRequests.has(payload.requestId)) {
      pending = this.pendingWorkerRequests.get(payload.requestId);
    }
    if (!pending && payload.toolName) {
      const matches = Array.from(this.pendingWorkerRequests.values()).filter(p => p.toolName === payload.toolName);
      if (matches.length === 1) {
        pending = matches[0];
      }
    }
    if (!pending) {
      return payload;
    }

    return {
      ...payload,
      source: 'worker',
      workerName: pending.workerName,
      requestId: pending.requestId,
      toolName: payload.toolName || pending.toolName,
    };
  }
}
