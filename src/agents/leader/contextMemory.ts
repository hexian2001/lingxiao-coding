/**
 * Leader context memory helpers
 *
 * appendContextMemoryIfChanged 的纯逻辑：
 * - 计算 memory items 指纹（用于「上下文记忆是否变化」去重）
 *
 * 历史上有 buildMemoryQuery / selectOpenTasksForMemory 用于 LLM 语义重排的查询，但该重排从未被
 * 任何调用方启用、属死代码且引入非确定性，已随 ContextMemoryIndex 的语义重排一并移除。
 */

export interface MemoryItemLite {
  id: string;
  score: number;
  timestamp?: number;
}

/**
 * 计算 memory items 指纹：id:score:timestamp 用 '|' 串联。空数组返回 ''。
 */
export function buildMemoryItemsFingerprint(items: MemoryItemLite[]): string {
  return items
    .map((item) => `${item.id}:${item.score}:${item.timestamp || 0}`)
    .join('|');
}
