/**
 * 单槽 in-place system 消息更新机制。
 *
 * 治本「状态镜像类 system 注入每轮 append 堆积占满上下文」：把每轮刷新、最新值即权威的
 * system 消息（runtime manifest / memory manifest / 黑板分析等）收敛为单一可变槽——
 * 每轮只更新内容、不新增条目；resume 从 append-only DB 重建带回的历史残留也能收敛。
 *
 * 设计原则（用户铁律：禁止启发式）：
 * - 槽位定位用确定性精确匹配——manifestSlot 靠 TITLE 前缀 + 整行 `slot=X` 相等（见
 *   ContextManifest.isManifestSlotContent），prefix 靠字符串前缀。无关键词模糊匹配。
 * - 复刻 ContractPack collapse 范式（ContextManager.collapseRuntimeContractPackMessages）。
 * - 纯函数，不改入参数组，返回新数组 + changed 标志。
 */

import { contentToPlainText, type ChatMessage } from '../llm/types.js';
import { isManifestSlotContent } from './ContextManifest.js';

export type SystemSlotMatcher =
  | { kind: 'manifestSlot'; slot: string }
  | { kind: 'prefix'; prefix: string };

/**
 * 确定性匹配：内容是否属于该槽位。
 * - manifestSlot：TITLE 前缀 + 整行 `slot=<value>` 精确相等。
 * - prefix：trimStart 后精确前缀（黑板分析等独立 marker）。
 */
export function matchesSystemSlot(content: unknown, matcher: SystemSlotMatcher): boolean {
  if (matcher.kind === 'manifestSlot') {
    return isManifestSlotContent(content, matcher.slot);
  }
  return typeof content === 'string' && content.trimStart().startsWith(matcher.prefix);
}

function slotMessageMatches(msg: ChatMessage, matcher: SystemSlotMatcher): boolean {
  if (msg.role !== 'system') return false;
  if (matcher.kind === 'manifestSlot') {
    return isManifestSlotContent(msg.content, matcher.slot);
  }
  return contentToPlainText(msg.content).trimStart().startsWith(matcher.prefix);
}

/**
 * 每个 matcher 在 messages 中只保留最后一条匹配，删掉其余同槽消息。
 * 非 system 消息与非任何槽的 system 消息原样保留。纯函数。
 */
export function collapseSystemSlots(
  messages: ChatMessage[],
  matchers: readonly SystemSlotMatcher[],
): ChatMessage[] {
  if (matchers.length === 0) return messages;
  // 收集每个 matcher 最后一次出现的下标（保留位）。
  const keep = new Set<number>();
  for (const matcher of matchers) {
    let lastIndex = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (slotMessageMatches(messages[i], matcher)) lastIndex = i;
    }
    if (lastIndex >= 0) keep.add(lastIndex);
  }
  return messages.filter((msg, index) => {
    if (msg.role !== 'system') return true;
    let belongsToAnySlot = false;
    for (const matcher of matchers) {
      if (slotMessageMatches(msg, matcher)) { belongsToAnySlot = true; break; }
    }
    if (!belongsToAnySlot) return true;
    return keep.has(index);
  });
}

export interface UpsertSystemSlotResult {
  messages: ChatMessage[];
  /** 结构或内容发生变化（覆盖/追加/collapse 删除残留）时为 true。 */
  changed: boolean;
  /** 最终承载该槽内容的消息（覆盖的那条或新 append 的那条；内容未变时为保留的那条）。 */
  message: ChatMessage;
}

/**
 * 单槽 in-place 更新：
 * - 有匹配：collapse 掉更早的同槽残留，将最后一条的 content 覆盖为新值（保留原 timestamp，
 *   对齐 LeaderAgent.syncSystemPromptForCurrentMode 的 {...msg, content}）；内容未变则仅 collapse。
 * - 无匹配：append 一条新 system 消息。
 * 纯函数，不改入参数组。
 */
export function upsertSystemSlot(
  messages: ChatMessage[],
  matcher: SystemSlotMatcher,
  content: string,
): UpsertSystemSlotResult {
  // collapse 同时处理「更早同槽残留」（resume/历史堆积），无论是否命中都安全（无匹配则原样）。
  const collapsed = collapseSystemSlots(messages, [matcher]);

  // collapse 后重新定位最后一条同槽（下标可能因删除前移）。
  let targetIndex = -1;
  for (let i = collapsed.length - 1; i >= 0; i -= 1) {
    if (slotMessageMatches(collapsed[i], matcher)) { targetIndex = i; break; }
  }

  if (targetIndex < 0) {
    const appended: ChatMessage = { role: 'system', content, timestamp: Date.now() / 1000 };
    return {
      messages: [...collapsed, appended],
      changed: true,
      message: appended,
    };
  }

  const target = collapsed[targetIndex];
  if (target.content === content) {
    // 内容未变：仅当 collapse 真删了残留时才算 changed。
    return { messages: collapsed, changed: collapsed.length !== messages.length, message: target };
  }
  const updated = collapsed.slice();
  const replaced: ChatMessage = { ...target, content };
  updated[targetIndex] = replaced;
  return { messages: updated, changed: true, message: replaced };
}
