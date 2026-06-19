/**
 * MetaTool — Leader 内部元工具基类
 *
 * 与普通 Tool 的区别：
 * 1. 使用 schema 直接提供 JSON Schema（不走 Zod 转换）
 * 2. 标记 visibility: 'leader' — 仅 Leader 可见
 * 3. execute() 通过 context.leaderToolsExecutor 委托给 LeaderToolsExecutor
 */

import type { JsonSchema, ToolContract, ToolContext, ToolResult } from '../contracts/types/Tool.js';
import type { ToolMetadata } from './ToolMetadata.js';

export abstract class MetaTool implements ToolContract {
  abstract readonly name: string;
  abstract readonly description: string;

  /** JSON Schema 定义 — 直接提供给 LLM，不走 Zod 转换 */
  abstract readonly schema: JsonSchema;

  readonly scope = 'leader' as const;

  readonly metadata: ToolMetadata = {
    tier: 'execute',
    category: 'orchestration',
    visibility: 'leader',
  };

  getSchema(): JsonSchema {
    return this.schema;
  }

  abstract execute(args: unknown, context?: ToolContext): Promise<ToolResult>;
}

export default MetaTool;
