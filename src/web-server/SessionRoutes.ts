/**
 * SessionRoutes — 会话相关 API 路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { SessionManager } from '../core/SessionManager.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { isEmptyContent, type MessageContent } from '../llm/types.js';
import { config as runtimeConfig } from '../config.js';
import type { AuthFn } from './types.js';
import type { Task } from '../core/TaskBoard.js';
import { withDisplayState } from '../core/TaskDisplayState.js';
import { buildSessionAgentHistory } from './AgentHistoryRoutes.js';

interface SideThreadMeta {
  kind: 'side_thread';
  parentSessionId: string | null;
  workspace: string;
  inheritedUntil: number | null;
  createdAt: number;
}

function sideThreadMetaValue(value: unknown): SideThreadMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = value as Partial<SideThreadMeta>;
  if (meta.kind !== 'side_thread') return null;
  return {
    kind: 'side_thread',
    parentSessionId: typeof meta.parentSessionId === 'string' ? meta.parentSessionId : null,
    workspace: typeof meta.workspace === 'string' ? meta.workspace : '',
    inheritedUntil: typeof meta.inheritedUntil === 'number' ? meta.inheritedUntil : null,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
  };
}

export function registerSessionRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    sessionManager: SessionManager;
    requireServerToken: AuthFn;
    getActiveSessionId?: () => string | undefined;
  },
): void {
  const { repos, sessionManager, requireServerToken, getActiveSessionId } = deps;

  // 获取所有会话
  fastify.get('/api/sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const sessions = sessionManager.listSessions();
    const activeIds = new Set(sessionManager.getActiveSessionIds());
    return sessions.map((s) => {
      const isActive = activeIds.has(s.id);
      const interaction = isActive ? sessionManager.getInteractionRuntimeState(s.id) : null;
      return {
        ...s,
        isActive,
	        ...(interaction ? {
	          runtimeState: interaction.runtimeState,
	          turn: interaction.turn,
	        } : {}),
      };
    });
  });

  // 获取当前活跃会话
  fastify.get('/api/v1/sessions/active', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const activeSessionId = getActiveSessionId?.();
    if (activeSessionId) {
      const info = repos.sessions.get(activeSessionId);
      return { sessionId: activeSessionId, session: info || null, source: 'active_session' };
    }
    const activeIds = sessionManager.getActiveSessionIds();
    if (activeIds.length === 0) return { sessionId: null };
    const latestId = activeIds[activeIds.length - 1];
    const info = repos.sessions.get(latestId);
    return { sessionId: latestId, session: info || null, activeCount: activeIds.length, source: 'memory' };
  });

  fastify.get('/api/v1/sessions/side-thread', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { parentSessionId?: string; workspace?: string };
    const parentSessionId = query.parentSessionId || null;
    const workspace = query.workspace || '';

    try {
      const rows = repos.raw.getDb().prepare(
        'SELECT session_id, value, timestamp FROM session_state WHERE key = ? ORDER BY timestamp DESC'
      ).all(SESSION_KEYS.SIDE_THREAD_META) as Array<{ session_id: string; value: string; timestamp: number }>;

      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch { /* expected: malformed JSON in session_state */
          continue;
        }
        const meta = sideThreadMetaValue(parsed);
        if (!meta) continue;
        if ((meta.parentSessionId || null) !== parentSessionId) continue;
        if (workspace && meta.workspace && meta.workspace !== workspace) continue;
        const session = repos.sessions.get(row.session_id);
        if (!session || session.status === 'deleted') continue;
        return {
          data: {
            sessionId: row.session_id,
            parentSessionId: meta.parentSessionId,
            workspace: meta.workspace,
            inheritedUntil: meta.inheritedUntil,
            createdAt: meta.createdAt || row.timestamp,
            session,
          },
        };
      }

      return { data: null };
    } catch (err) {
      reply.status(500);
      return { error: err instanceof Error ? err.message : 'Failed to load side thread' };
    }
  });

  // 获取单个会话
  fastify.get('/api/sessions/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const info = repos.sessions.get(id);
    if (!info) { reply.status(404); return { error: 'Session not found' }; }
    const pendingPermission = repos.sessionState.get(id, SESSION_KEYS.PENDING_PERMISSION_REQUEST) || null;
    const interaction = sessionManager.getInteractionRuntimeState(id);
	    return {
	      session: info,
	      history: sessionManager.getSessionHistory(id),
	      pendingPermission,
	      runtime: interaction ? {
	        turn: interaction.turn,
	        runtimeState: interaction.runtimeState,
	      } : null,
    };
  });

  // 更新会话（重命名）
  fastify.put('/api/v1/sessions/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; summary?: string };
    if (Object.prototype.hasOwnProperty.call(body, 'summary')) {
      reply.status(400);
      return { error: 'summary is not accepted; use name' };
    }
    const name = body.name;
    if (!name?.trim()) {
      reply.status(400);
      return { error: 'name is required' };
    }
    try {
      const trimmed = name.trim();
      repos.sessions.updateName(id, trimmed);
      // 通知所有 UI（含其他 Web 标签页）名称已变更，实时刷新会话列表
      sessionManager.emitSessionRenamed(id, trimmed);
      return { success: true, id, name: trimmed };
    } catch (err) {
      reply.status(500);
      return { error: err instanceof Error ? err.message : 'Failed to update session' };
    }
  });

  // 创建会话
  fastify.post('/api/sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as {
      user_request?: MessageContent | object;
      workspace?: string;
      idle?: boolean;
      parentSessionId?: string;
      inheritParentConversation?: boolean;
      sideThread?: boolean;
    };
    const workspace = body.workspace || process.cwd();
    const rawRequest = body.user_request ?? 'New session';
    const userRequest = (typeof rawRequest === 'string' && !rawRequest.trim()) ? 'New session' : rawRequest;
    const idle = body.idle !== false;
    const sessionId = await sessionManager.createSession(userRequest, workspace, { idle });
    let inheritedUntil: number | null = null;
    if (body.parentSessionId && body.inheritParentConversation !== false) {
      const parentMessages = repos.messages.getConversationMessages(body.parentSessionId)
        .filter((message) => message.role !== 'tool');
      if (parentMessages.length > 0) {
        inheritedUntil = Math.max(
          ...parentMessages.map((message) => typeof message.timestamp === 'number' ? message.timestamp : 0),
        );
        repos.messages.replaceConversation(sessionId, parentMessages);
      }
    }
    if (body.sideThread) {
      const meta: SideThreadMeta = {
        kind: 'side_thread',
        parentSessionId: body.parentSessionId || null,
        workspace,
        inheritedUntil,
        createdAt: Date.now() / 1000,
      };
      repos.sessionState.set(sessionId, SESSION_KEYS.SIDE_THREAD_META, meta);
      repos.sessions.updateName(sessionId, 'Side chat');
    }
    return {
      id: sessionId,
      workspace,
      user_request: userRequest,
      status: 'active',
      parentSessionId: body.parentSessionId || null,
      inheritedUntil,
      sideThread: body.sideThread === true,
    };
  });

  // 获取会话任务
  fastify.get('/api/sessions/:id/tasks', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    return repos.tasks.listBySession(id).map((task) => {
      const normalized: Task = {
        id: task.id,
        session_id: task.session_id,
        subject: task.subject,
        description: typeof task.description === 'string' ? task.description : JSON.stringify(task.description),
        context: task.context,
        status: task.status as Task['status'],
        exitReason: task.exit_reason as Task['exitReason'],
        runGeneration: Number(task.run_generation ?? 0),
        agent_type: task.agent_type,
        assigned_agent: task.assigned_agent || '',
        blocked_by: task.blocked_by || [],
        blocks: task.blocks || [],
        working_directory: task.working_directory || '',
        write_scope: task.write_scope || [],
        result: task.result,
        orchestration: task.orchestration,
        created_at: task.created_at,
        updated_at: task.updated_at,
      };
      return withDisplayState(normalized);
    });
  });

  // 获取有黑板数据的会话列表
  fastify.get('/api/v1/graph-sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const sqlite = repos.raw.getDb();
      const rows = sqlite.prepare(
        'SELECT session_id, COUNT(*) as node_count FROM graph_nodes GROUP BY session_id ORDER BY node_count DESC'
      ).all() as Array<{ session_id: string; node_count: number }>;
      return { data: rows };
    } catch { /* expected: graph_nodes table may not exist */ return { data: [] }; }
  });

  // 获取黑板图状态
  fastify.get('/api/v1/sessions/:id/graph', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (runtimeConfig.blackboard?.enabled === false) return { enabled: false, nodes: [], edges: [] };
    const { id } = request.params as { id: string };
    try {
      const sqlite = repos.raw.getDb();
      const graphNodes = sqlite.prepare(
        'SELECT id, kind, session_id as sessionId, title, content, tags, created_by as createdBy, created_at as createdAt, superseded_by as supersededBy, confidence, intent_status as intentStatus, priority, evidence FROM graph_nodes WHERE session_id = ?',
      ).all(id);
      const graphEdges = sqlite.prepare(
        'SELECT id, session_id as sessionId, from_node_id as fromNodeId, to_node_id as toNodeId, edge_type as edgeType, created_at as createdAt, created_by as createdBy, metadata FROM graph_edges WHERE session_id = ?',
      ).all(id);
      for (const node of graphNodes as Array<{ tags?: string | string[]; evidence?: string | unknown[] }>) {
        if (typeof node.tags === 'string') { try { node.tags = JSON.parse(node.tags); } catch { /* expected: malformed JSON */ node.tags = []; } }
        if (typeof node.evidence === 'string') { try { node.evidence = JSON.parse(node.evidence); } catch { /* expected: malformed JSON */ node.evidence = []; } }
      }
      return { enabled: true, nodes: graphNodes, edges: graphEdges };
    } catch { /* expected: graph tables may not exist */ return { enabled: true, nodes: [], edges: [] }; }
  });

  // 获取黑板图分析 —
  // 优先从活跃 LeaderAgent 取真实分析结果（DispatcherEngine.analyze）
  // 不可用时现场用 GraphStore 加载快照 + DispatcherEngine 临时计算一遍
  fastify.get('/api/v1/sessions/:id/graph/analysis', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (runtimeConfig.blackboard?.enabled === false) return { enabled: false };
    const { id } = request.params as { id: string };

    // Path 1：活跃 session — 直接从 LeaderBlackboard 取
    try {
      const session = sessionManager.getSession(id);
      const lb = session?.leader?.getLeaderBlackboard?.();
      if (lb && lb.isEnabled()) {
        const analysis = lb.getBlackboardAnalysis();
        if (analysis) return { enabled: true, analysis };
      }
    } catch { /* expected: session may be disposed — fall through to Path 2 */
      // 继续走 Path 2
    }

    // Path 2：会话已结束 — 现场加载快照并跑一次 DispatcherEngine.analyze
    try {
      const { GraphStore } = await import('../core/blackboard/GraphStore.js');
      const { BlackboardGraph } = await import('../core/blackboard/BlackboardGraph.js');
      const { DispatcherEngine } = await import('../core/blackboard/DispatcherEngine.js');
      const store = new GraphStore(repos.raw.getDb());
      const graph = new BlackboardGraph(store);
      const snapshot = graph.getSnapshot(id);
      if (!snapshot.nodes.length) {
        return { enabled: true, analysis: null };
      }
      const engine = new DispatcherEngine();
      const analysis = engine.analyze(snapshot);
      return { enabled: true, analysis };
    } catch { /* expected: graph data may be missing or corrupt */
      return { enabled: true, analysis: null };
    }
  });

  // 获取会话消息
  fastify.get('/api/sessions/:id/messages', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    // 统一从 leader_conversation 读取消息。tool 行由前端按 tool_call_id
    // 合回对应 assistant 工具卡，不能过滤，否则截图等结构化工具结果刷新后会丢失。
    const messages = repos.messages.getConversationMessages(id);
    return messages;
  });

  // ── POST /api/sessions/import — 导入凌霄对话 JSON ──
  // 创建新会话并将导入的消息写入 leader_conversation，返回新会话 ID。
  fastify.post('/api/sessions/import', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as {
      messages?: Array<{
        role: string;
        content: string;
        thinkingContent?: string;
        toolCalls?: Array<{
          id: string;
          tool: string;
          input: unknown;
          result?: unknown;
          status: string;
        }>;
        timestamp?: number;
      }>;
      title?: string;
      workspace?: string;
    };

    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      reply.code(400);
      return { error: '导入失败：messages 字段缺失或为空。' };
    }

    const workspace = body.workspace || process.cwd();
    const title = body.title || `Imported ${new Date().toLocaleString()}`;

    // 创建新会话（idle 模式，不触发 LLM）
    const sessionId = await sessionManager.createSession(title, workspace, { idle: true });

    // 设置会话名称
    try { repos.sessions.updateName(sessionId, title); } catch { /* ignore */ }

    // 将导入的消息转换为 ConversationMessageRecord 格式并写入数据库
    const records = body.messages.map((msg, index) => {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const ts = (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp))
        ? msg.timestamp
        : Date.now() + index;

      // 构建 tool_calls（标准 OpenAI function-call 格式）
      let toolCalls: unknown[] | undefined;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        toolCalls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.tool,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        }));
      }

      // 构建 thinking blocks
      let thinking: unknown[] | undefined;
      if (msg.thinkingContent) {
        thinking = [{ type: 'text', text: msg.thinkingContent }];
      }

      return {
        role,
        content: msg.content || '',
        tool_calls: toolCalls,
        thinking,
        timestamp: ts,
      };
    });

    repos.messages.replaceConversation(sessionId, records);

    return {
      id: sessionId,
      workspace,
      title,
      messageCount: records.length,
      status: 'imported',
    };
  });

  // Debug: raw LLM context
  fastify.get('/api/sessions/:id/llm-messages', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return repos.messages.getConversation((request.params as { id: string }).id);
  });

  // 子 Agent 对话
  fastify.get('/api/sessions/:id/agents/:agentId/messages', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id, agentId } = request.params as { id: string; agentId: string };
    return repos.agentConversation.get(id, agentId);
  });

  // 批量获取 Agent 对话历史
  fastify.get('/api/sessions/:id/agents', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      const result = await buildSessionAgentHistory(repos, id);
      return { data: result };
    } catch (e) { reply.status(500); return { error: e instanceof Error ? e.message : 'Failed to load agent histories' }; }
  });

  // Agent 日志
  fastify.get('/api/sessions/:id/logs', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const { agent_id } = request.query as { agent_id?: string };
    return repos.agentLogs.listBySession(id, agent_id);
  });

  // Token 使用
  fastify.get('/api/sessions/:id/tokens', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return repos.tokenUsage.getSummary((request.params as { id: string }).id);
  });

  // 完成会话
  fastify.post('/api/sessions/:id/complete', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    sessionManager.completeSession(id, (request.body as { summary?: string })?.summary);
    return { success: true };
  });

  // 压缩上下文
  fastify.post('/api/v1/sessions/:id/compress', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      let session = sessionManager.getSession(id);
      if (!session) {
        const resumed = await sessionManager.resumeSession(id);
        if (!resumed) { reply.status(404); return { error: 'Session not found' }; }
        session = sessionManager.getSession(id);
      }
      // 统一走 leader.compactContext()：setMessages → forceCompact → 回写 conversation。
      const leader = session?.leader as { compactContext?: () => Promise<{ oldTokens: number; newTokens: number; compacted: boolean; compactType?: string; overflow?: boolean; archivePath?: string; inProgress?: boolean; threshold?: number }> } | undefined;
      if (typeof leader?.compactContext !== 'function') {
        reply.status(409);
        return { error: 'Leader not ready for compaction' };
      }
      const result = await leader.compactContext();
      return {
        success: true,
        oldTokens: result.oldTokens,
        newTokens: result.newTokens,
        compacted: result.compacted,
        compactType: result.compactType,
        overflow: result.overflow,
        archivePath: result.archivePath,
        inProgress: result.inProgress,
        threshold: result.threshold,
        skipped: !result.compacted && !result.overflow && !result.inProgress,
        reason: result.overflow
          ? 'Context still exceeds limit after compaction'
          : result.inProgress
            ? 'Context compression already in progress'
          : !result.compacted
            ? 'No compressible context found'
            : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(500);
      return { error: `Compression failed: ${message}` };
    }
  });

  // 发送用户输入
  fastify.post('/api/sessions/:id/input', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const message = (request.body as { message?: MessageContent })?.message;
    if (message === undefined || isEmptyContent(message)) { reply.status(400); return { error: 'message is required' }; }
    if (!sessionManager.getSession(id)) {
      const resumed = await sessionManager.resumeSession(id);
      if (!resumed) { reply.status(404); return { error: 'Session not found' }; }
    }
    await sessionManager.sendUserInput(id, message);
    return { success: true };
  });

  // 中断会话
  fastify.post('/api/sessions/:id/interrupt', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const ok = await sessionManager.interruptSession((request.params as { id: string }).id);
    if (!ok) { reply.status(404); return { error: 'Session not found' }; }
    return { success: true };
  });

  // 删除会话
  fastify.delete('/api/sessions/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const ok = await sessionManager.deleteSession((request.params as { id: string }).id);
      if (!ok) { reply.status(404); return { error: 'Session not found' }; }
      return { success: true };
    } catch (e) { reply.status(500); return { error: e instanceof Error ? e.message : 'Failed to delete session' }; }
  });
}
