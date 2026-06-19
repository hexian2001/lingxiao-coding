import { z } from 'zod';
import * as vm from 'node:vm';
import { inspect } from 'node:util';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';

const NodeReplSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('eval'),
    code: z.string().min(1).describe('要执行的 JavaScript，支持 await'),
    session: z.string().optional().default('default').describe('持久 REPL session 名称'),
    timeout_ms: z.number().int().min(50).max(30000).optional().default(5000),
  }),
  z.object({
    action: z.literal('reset'),
    session: z.string().optional().default('default'),
  }),
  z.object({
    action: z.literal('list_sessions'),
  }),
]);

interface ReplSession {
  context: vm.Context;
  createdAt: number;
  evalCount: number;
}

const sessions = new Map<string, ReplSession>();
// C5: sessions 按名字无界增长(每个不同 session 名一个 vm.Context)。FIFO oldest-first 封顶。
const MAX_REPL_SESSIONS = 16;

function evictOldReplSessions(): void {
  while (sessions.size > MAX_REPL_SESSIONS) {
    // Map 保留插入序,头部即最旧 session(按创建时间)。
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function createSession(context?: ToolContext): ReplSession {
  const output: string[] = [];
  const sandbox = {
    console: {
      log: (...args: unknown[]) => output.push(args.map((arg) => inspect(arg, { depth: 4 })).join(' ')),
      error: (...args: unknown[]) => output.push(args.map((arg) => inspect(arg, { depth: 4 })).join(' ')),
    },
    setTimeout,
    clearTimeout,
    structuredClone,
    URL,
    URLSearchParams,
    Math,
    JSON,
    Date,
    workspace: context?.workspace,
    __output: output,
  };
  return {
    context: vm.createContext(sandbox, { name: 'lingxiao-node-repl' }),
    createdAt: Date.now(),
    evalCount: 0,
  };
}

export class NodeReplTool extends Tool {
  readonly name = 'node_repl';
  readonly description = '持久 JavaScript REPL：在隔离 vm context 中执行 JS，支持 await、session reset/list。用于快速计算、解析 JSON、验证小段逻辑；属于执行类工具。';
  readonly parameters = NodeReplSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof NodeReplSchema>;
    if (params.action === 'list_sessions') {
      return {
        success: true,
        data: Array.from(sessions.entries()).map(([name, session]) => ({
          name,
          createdAt: session.createdAt,
          evalCount: session.evalCount,
        })),
      };
    }

    const sessionName = params.session || 'default';
    if (params.action === 'reset') {
      sessions.delete(sessionName);
      return { success: true, data: { reset: sessionName } };
    }

    const session = sessions.get(sessionName) || createSession(context);
    sessions.set(sessionName, session);
    evictOldReplSessions();
    const out = (session.context as unknown as { __output?: string[] }).__output;
    if (Array.isArray(out)) out.length = 0;

    try {
      const wrapped = `(async () => {\n${params.code}\n})()`;
      const result = await vm.runInContext(wrapped, session.context, { timeout: params.timeout_ms ?? 5000 });
      session.evalCount += 1;
      return {
        success: true,
        data: {
          session: sessionName,
          result: inspect(result, { depth: 6, maxArrayLength: 100 }),
          output: Array.isArray(out) ? out.join('\n') : '',
        },
      };
    } catch (error) {
      return {
        success: false,
        data: {
          session: sessionName,
          output: Array.isArray(out) ? out.join('\n') : '',
        },
        error: error instanceof Error ? error.stack || error.message : String(error),
      };
    }
  }
}

export default NodeReplTool;
