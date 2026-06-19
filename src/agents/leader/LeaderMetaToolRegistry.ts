import type { ToolDefinition } from '../../llm/types.js';
import MetaTool from '../../tools/MetaTool.js';
import type { JsonSchema, ToolContext, ToolResult } from '../../contracts/types/Tool.js';
import type { ToolRegistry } from '../../tools/Registry.js';
import { BUGHUNT_TOOLS, LEADER_META_TOOLS } from '../../contracts/constants/leaderToolDefinitions.js';
import { findModeOfTool, MODE_REGISTRY } from '../../contracts/modes.js';
import { LeaderToolFailure } from './LeaderToolFailure.js';

function toRecordArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

export class LeaderMetaTool extends MetaTool {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  readonly scope = 'leader' as const;

  constructor(definition: ToolDefinition) {
    super();
    this.name = definition.function.name;
    this.description = definition.function.description;
    this.schema = definition.function.parameters as JsonSchema;
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const executor = context?.leaderToolsExecutor;
    if (!executor) {
      return {
        success: false,
        data: null,
        error: `Leader meta tool "${this.name}" requires leaderToolsExecutor in ToolContext`,
      };
    }

    // fail-closed：bughunt ledger 元工具（set_bughunt_dag / upsert_bughunt_finding /
    // get_bughunt_ledger）与其它会话级模式工具对称——模式未启用时返回结构化错误码，
    // 走与 Registry mode_forbidden 同一套 <MODE>_MODE_REQUIRED 语义。
    // Registry 的 modeDecisionForExecution 对 leader-scoped 工具同样会过一遍 policy，
    // 但 leader meta tool 经 LeaderToolsExecutor 直派，此处补一道确定性校验，杜绝漏网。
    const toolMode = findModeOfTool(this.name);
    if (toolMode) {
      const sessionId = context?.sessionId;
      const db = context?.db as { getSessionState?: (sid: string, key: string) => unknown } | undefined;
      const active = !!sessionId
        && typeof db?.getSessionState === 'function'
        && db.getSessionState(sessionId, MODE_REGISTRY[toolMode].sessionKey) === 'true';
      if (!active) {
        return {
          success: false,
          data: null,
          error: `MODE_TOOL_FORBIDDEN: ${toolMode.toUpperCase()}_MODE_REQUIRED`,
        };
      }
    }

    const output = await executor.execute(this.name, toRecordArgs(args));
    return { success: true, data: output };
  } catch (e: unknown) {
    // 确定性失败信号：底层方法 throw LeaderToolFailure 表示「未能完成主操作」。
    // 包成 { success: false }，下游 executeToolCall 自动加 ERROR: 前缀，
    // 杜绝「失败被当成成功」导致 LLM 幻觉已派发/已写入。
    if (e instanceof LeaderToolFailure) {
      return { success: false, data: null, error: e.message };
    }
    throw e; // 意料外异常照抛，绝不静默吞掉
  }
}

export function createLeaderMetaTools(): LeaderMetaTool[] {
  return [...LEADER_META_TOOLS, ...BUGHUNT_TOOLS].map((definition) => new LeaderMetaTool(definition));
}

export function registerLeaderMetaTools(registry: ToolRegistry): void {
  for (const tool of createLeaderMetaTools()) {
    registry.register(tool);
  }
}
