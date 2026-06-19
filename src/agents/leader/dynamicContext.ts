/**
 * Leader dynamic context builder
 *
 * 抽离 Leader 的动态上下文装配：直觉快照 + 长期记忆索引 + 模式协议。
 * 作为独立 system 消息注入，以避免动态内容污染 Anthropic cache 的稳定核心。
 */

import {
  renderContextManifest,
  type ContextManifestSection,
} from '../../core/ContextManifest.js';

export interface DynamicContextInput {
  sessionId: string;
  /** 读取 intuition 快照（可能失败，返回 null 即忽略） */
  readIntuitionPrompt: () => string | null;
  /** 读取记忆索引 markdown（返回非空字符串才注入） */
  readMemoryIndex: () => string | null;
  /** 额外动态协议块，如 Office 模式协议 */
  sections?: ContextManifestSection[];
}

/**
 * 组合动态上下文为统一 Context Manifest：
 * - 两者都缺省返回 null（调用方应跳过注入）
 * - 有任一动态块时统一输出 Context Manifest，避免多套上下文标题并存
 */
export function buildDynamicContext(input: DynamicContextInput): string | null {
  let intuition: string | null = null;
  let memory: string | null = null;

  try {
    const value = input.readIntuitionPrompt();
    if (value?.trim()) {
      intuition = value.trim();
    }
  } catch {
    /* intuition context is optional */
  }

  try {
    const value = input.readMemoryIndex();
    if (value?.trim()) {
      memory = value.trim();
    }
  } catch {
    /* memory not available */
  }

  const sections = (input.sections ?? [])
    .filter((section) => section.title.trim() && section.content.trim());
  if (!intuition && !memory && sections.length === 0) {
    return null;
  }

  return renderContextManifest({
    scope: 'leader',
    // leader_init 槽：init/resume 一次性装配的动态上下文（直觉/记忆/mission/contract）。
    // 带 slot 才能被 SystemMessageSlot 单槽 in-place 管理，resume 从 DB 重建带回的旧
    // leader_init 残留也能被 collapseSystemSlots 收敛（每会话一条，不堆积）。
    slot: 'leader_init',
    sessionId: input.sessionId,
    intuition,
    persistentMemoryIndex: memory,
    sections,
  });
}
