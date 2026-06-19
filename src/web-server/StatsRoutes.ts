/**
 * StatsRoutes — 统计数据路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { AuthFn } from './types.js';
import { buildSessionAgentHistory } from './AgentHistoryRoutes.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolArgs(argsRaw: unknown): JsonRecord {
  if (typeof argsRaw === 'string') {
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(argsRaw) ? argsRaw : {};
}

function toolCallName(call: unknown): string {
  if (!isRecord(call)) return '';
  const fn = call.function;
  const functionName = isRecord(fn) ? fn.name : undefined;
  if (typeof functionName === 'string') return functionName;
  return typeof call.name === 'string' ? call.name : '';
}

function toolCallId(call: unknown): string | undefined {
  if (!isRecord(call)) return undefined;
  return typeof call.id === 'string' ? call.id : undefined;
}

function toolCallArguments(call: unknown): unknown {
  if (!isRecord(call)) return undefined;
  const fn = call.function;
  if (isRecord(fn) && 'arguments' in fn) return fn.arguments;
  return call.arguments;
}

function messageTimestamp(msg: { timestamp?: number } | undefined): number {
  return msg?.timestamp || 0;
}

function sessionCreatedAtSeconds(session: { created_at: number }): number {
  return session.created_at || Date.now() / 1000;
}

function sessionLastActiveSeconds(session: { created_at: number; last_active?: unknown }): number {
  return typeof session.last_active === 'number'
    ? session.last_active
    : sessionCreatedAtSeconds(session);
}

export function registerStatsRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    requireServerToken: AuthFn;
  },
): void {
  const { repos, requireServerToken } = deps;

  fastify.get('/api/v1/stats', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const sessions = repos.sessions.list();
      let totalMessages = 0;
      let totalToolCalls = 0;
      let toolSuccessCount = 0;
      let toolFailCount = 0;
      let linesAdded = 0;
      let linesDeleted = 0;
      let promptCount = 0;
      let totalWallMs = 0;
      let totalApiMs = 0;
      let totalToolMs = 0;
      let totalAgentActiveMs = 0;

      // Helper: does a tool-role message content look like a failure result?
      const looksLikeError = (content: unknown): boolean => {
        if (!content) return false;
        const s = typeof content === 'string' ? content : JSON.stringify(content);
        if (!s) return false;
        // Heuristics: tool errors usually start with "Error", contain {"error":...},
        // or say "failed" / "exception" near the beginning.
        const head = s.slice(0, 400).toLowerCase();
        return (
          head.startsWith('error') ||
          head.includes('"error"') ||
          head.includes('"success":false') ||
          head.includes('exception:') ||
          (head.includes('failed') && !head.includes('not failed'))
        );
      };

      // Helper: estimate net line delta from canonical write/structured_patch args.
      const countLines = (s: unknown): number => {
        if (typeof s !== 'string' || s.length === 0) return 0;
        return s.split('\n').length;
      };
      const lineDiff = (oldLines: number, newLines: number): { added: number; deleted: number } => ({
        added: Math.max(0, newLines - oldLines),
        deleted: Math.max(0, oldLines - newLines),
      });
      const canonicalPatchFields = new Set([
        'path',
        'dry_run',
        'search',
        'replace',
        'replace_all',
        'occurrence',
        'on_ambiguous',
        'start_line',
        'end_line',
        'insert_after_line',
        'insert_after',
        'insert_at',
        'content',
        'append',
        'prepend',
      ]);
      const isCanonicalPatchRecord = (value: unknown): value is JsonRecord => (
        isRecord(value) && Object.keys(value).every(key => canonicalPatchFields.has(key))
      );
      const canonicalHunksFromArgs = (args: JsonRecord): JsonRecord[] => {
        if (Array.isArray(args.hunks)) {
          return args.hunks.every(isCanonicalPatchRecord) ? args.hunks : [];
        }
        if (isCanonicalPatchRecord(args.hunks)) return [args.hunks];
        if (isCanonicalPatchRecord(args.hunk)) return [args.hunk];
        const topLevelHunkFields = [
          'search',
          'start_line',
          'end_line',
          'insert_after_line',
          'insert_after',
          'insert_at',
          'content',
          'append',
          'prepend',
        ];
        return topLevelHunkFields.some(field => args[field] !== undefined) && isCanonicalPatchRecord(args)
          ? [args]
          : [];
      };
      const isContentOnlyAppend = (hunk: JsonRecord): boolean => {
        const meaningfulKeys = Object.keys(hunk).filter((key) => (
          key !== 'path'
          && key !== 'dry_run'
          && !(key === 'replace_all' && hunk.replace_all === false)
        ));
        return meaningfulKeys.length === 1
          && meaningfulKeys[0] === 'content'
          && typeof hunk.content === 'string';
      };
      const diffLinesFromCanonicalHunk = (hunk: JsonRecord): { added: number; deleted: number } => {
        if (typeof hunk.search === 'string' && typeof hunk.replace === 'string') {
          return lineDiff(countLines(hunk.search), countLines(hunk.replace));
        }
        if (
          Number.isInteger(hunk.start_line)
          && Number.isInteger(hunk.end_line)
          && typeof hunk.replace === 'string'
          && (hunk.end_line as number) >= (hunk.start_line as number)
        ) {
          return lineDiff(
            (hunk.end_line as number) - (hunk.start_line as number) + 1,
            countLines(hunk.replace),
          );
        }
        if (
          typeof hunk.content === 'string'
          && (
            Number.isInteger(hunk.insert_after_line)
            || typeof hunk.insert_after === 'string'
            || hunk.insert_at === 'start'
            || hunk.insert_at === 'end'
            || hunk.append === true
            || hunk.prepend === true
            || isContentOnlyAppend(hunk)
          )
        ) {
          return { added: countLines(hunk.content), deleted: 0 };
        }
        return { added: 0, deleted: 0 };
      };
      const diffLinesFromCanonicalPatchArgs = (args: JsonRecord): { added: number; deleted: number } => {
        return canonicalHunksFromArgs(args).reduce<{ added: number; deleted: number }>((acc, hunk) => {
          const delta = diffLinesFromCanonicalHunk(hunk);
          acc.added += delta.added;
          acc.deleted += delta.deleted;
          return acc;
        }, { added: 0, deleted: 0 });
      };
      const diffLinesFromToolCall = (
        toolName: string,
        argsRaw: unknown,
      ): { added: number; deleted: number } => {
        const n = (toolName || '').toLowerCase();
        const writeLike = n.includes('write') || n.includes('create') || n.includes('append');
        const editLike = n.includes('edit') || n.includes('replace') || n.includes('patch');
        if (!writeLike && !editLike) return { added: 0, deleted: 0 };
        const args = parseToolArgs(argsRaw);
        if (writeLike) {
          const content = args.content ?? '';
          return { added: countLines(content), deleted: 0 };
        }
        return diffLinesFromCanonicalPatchArgs(args);
      };

      for (const s of sessions) {
        try {
          const msgs = repos.messages.getConversation(s.id);
          totalMessages += msgs.length;

          // Track tool call name by call_id so the matching tool-role result
          // can be attributed to the right tool for success/fail classification.
          const toolCallIdToName = new Map<string, string>();

          // Derive agent-active ms from gaps between consecutive messages that
          // involve the assistant. This is an approximation but reflects real
          // observed activity rather than a token×constant guess.
          const sortedMsgs = [...msgs].sort(
            (a, b) => messageTimestamp(a) - messageTimestamp(b),
          );

          for (let i = 0; i < sortedMsgs.length; i++) {
            const msg = sortedMsgs[i];
            if (msg.role === 'user') promptCount++;

            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
              totalToolCalls += msg.tool_calls.length;
              for (const call of msg.tool_calls) {
                const toolName = toolCallName(call);
                const callId = toolCallId(call);
                if (callId) toolCallIdToName.set(callId, toolName);
                const { added, deleted } = diffLinesFromToolCall(
                  toolName,
                  toolCallArguments(call),
                );
                linesAdded += added;
                linesDeleted += deleted;
              }
            }

            // Tool-role message = the result of a previous tool call.
            // Classify as success or failure by inspecting content, and
            // measure latency as the time since the preceding message.
            if (msg.role === 'tool') {
              if (looksLikeError(msg.content)) toolFailCount++;
              else toolSuccessCount++;
              const prev = sortedMsgs[i - 1];
              if (prev && typeof prev.timestamp === 'number' && typeof msg.timestamp === 'number') {
                const delta = (msg.timestamp - prev.timestamp) * 1000;
                if (delta > 0 && delta < 15 * 60 * 1000) totalToolMs += delta;
              }
            }

            // Assistant reply latency vs preceding user/tool message = API time.
            if (msg.role === 'assistant' && i > 0) {
              const prev = sortedMsgs[i - 1];
              if (
                prev &&
                typeof prev.timestamp === 'number' &&
                typeof msg.timestamp === 'number' &&
                (prev.role === 'user' || prev.role === 'tool')
              ) {
                const delta = (msg.timestamp - prev.timestamp) * 1000;
                if (delta > 0 && delta < 15 * 60 * 1000) {
                  totalApiMs += delta;
                  totalAgentActiveMs += delta;
                }
              }
            }
          }
        } catch {/* expected: best-effort cleanup */}
      }

      if (sessions.length > 0) {
        const earliest = Math.min(...sessions.map(sessionCreatedAtSeconds));
        const latest = Math.max(...sessions.map(sessionLastActiveSeconds));
        totalWallMs = (latest - earliest) * 1000;
      }

      return {
        data: {
          totalSessions: sessions.length,
          totalMessages,
          totalToolCalls,
          toolSuccessCount,
          toolFailCount,
          linesAdded,
          linesDeleted,
          promptCount,
          wallTimeMs: totalWallMs,
          apiTimeMs: totalApiMs,
          toolTimeMs: totalToolMs,
          agentActiveMs: totalAgentActiveMs,
        },
      };
    } catch (err) {
      // 聚合失败（DB 查询/记录损坏/算术）不应静默返回全零 —— 否则用户误以为数据丢失。
      console.warn('[StatsRoutes] 会话统计聚合失败，返回默认零值:', err instanceof Error ? err.message : String(err));
      return { data: { totalSessions: 0, totalMessages: 0 } };
    }
  });

  fastify.get('/api/v1/stats/models', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: repos.tokenUsage.getModelStats() };
  });

  fastify.get('/api/v1/stats/models/summary', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: repos.tokenUsage.getModelStatsAggregated() };
  });

  // 全局费用汇总 —— 复用 CLI /cost 的 calculateSessionCost / formatCostReport，
  // 让 Web 端 Cost 视图与 CLI 输出一致（命中率、节省额、按模型分摊）。
  fastify.get('/api/v1/stats/cost', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const { calculateSessionCost } = await import('../llm/CostService.js');
      const aggregated = repos.tokenUsage.getModelStatsAggregated();
      const summary = calculateSessionCost(aggregated.map(m => ({
        name: m.name,
        totalPrompt: m.totalPrompt,
        totalCompletion: m.totalCompletion,
        cacheRead: m.cacheRead,
        cacheCreation: m.cacheCreation,
      })));
      return { data: summary };
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'failed to compute cost summary',
      });
    }
  });

  fastify.get('/api/v1/stats/agents', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: repos.tokenUsage.getAgentStats() };
  });

  fastify.get('/api/v1/stats/tools', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: repos.messages.getToolStats() };
  });

  // Agent conversation history — for session resume
  fastify.get('/api/v1/sessions/:sessionId/agents', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId } = request.params as { sessionId: string };
    try {
      const result = await buildSessionAgentHistory(repos, sessionId);
      return { data: result };
    } catch (e) {
      reply.status(500);
      return { error: e instanceof Error ? e.message : 'Failed to load agent histories' };
    }
  });
}
