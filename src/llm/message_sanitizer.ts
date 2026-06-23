import type { ChatMessage, MessageContent, MessageContentPart, ToolCall } from './types.js';
import { isEmptyContent, contentToPlainText } from './types.js';

function cloneToolCallWithId(toolCall: ToolCall, fallbackId: string): ToolCall {
  return {
    ...toolCall,
    id: typeof toolCall.id === 'string' && toolCall.id.trim() ? toolCall.id : fallbackId,
    function: {
      ...toolCall.function,
    },
  };
}

function normalizeToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;

  const seen = new Set<string>();
  return toolCalls.map((toolCall, index) => {
    const baseId = typeof toolCall.id === 'string' && toolCall.id.trim()
      ? toolCall.id
      : `call_repaired_${index}`;
    let id = baseId;
    let suffix = 1;
    while (seen.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return cloneToolCallWithId(toolCall, id);
  });
}

function makeMissingToolResult(toolCall: ToolCall): ChatMessage {
  const toolName = toolCall.function?.name || 'unknown_tool';
  return {
    role: 'tool',
    tool_call_id: toolCall.id,
    content: `[tool result missing: ${toolName}]`,
  };
}

/**
 * 丢弃 arguments 非合法 JSON 的 tool_call（流式截断 / 双层 JSON 转义毒化历史的兜底）。
 *
 * 根因：worker emit 大参数工具（如 write_work_note 的完成报告）时流被砍
 * （max_tokens / idle abort / 断连），StreamingToolCallParser 把半截 JSON 当作
 * function.arguments 存下；该 assistant 消息进入历史后，每次回传都被 provider 以
 * `invalid function arguments json string (2013)` 拒绝。LlmGuard 受「不修改消息」
 * 约束（防剥离 thinking 破坏协议）不做任何修复 → 重试同请求必败 → 分类层又把 2013
 * 误判成可重试 → 无脑重试死循环，agent 永远卡在 emit 完成报告。
 *
 * 本函数在 provider 边界做确定性修复：arguments 解不开就丢该 tool_call；若 assistant
 * 消息因此变空（无 content 且无剩余 tool_call）则丢整条。配对的 tool_result 随后由
 * sanitizeOpenAIToolMessageSequence 的配对逻辑自动判为孤儿移除。
 *
 * 设计：纯确定性——解不开即丢，不尝试猜测/补全 JSON 语义（用户禁止启发式）。
 * 丢弃历史里一个已损坏的工具调用是无损的：模型只损失一次调用记录，可重新生成；
 * 远比把整个 agent 锁死在 400 死循环里强。
 */
function dropMalformedToolCallArguments(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      out.push(msg);
      continue;
    }
    const validToolCalls = msg.tool_calls.filter((tc) => {
      const args = tc.function?.arguments;
      // 零参调用（undefined / null / ''）合法。
      if (args === undefined || args === null || args === '') return true;
      // 已是非数组对象（上游解析过）→ 合法。
      if (typeof args === 'object' && !Array.isArray(args)) return true;
      // 字符串：必须能解析为 JSON 对象。两条损坏路径都拦在这里：
      //   1) 截断：半截 JSON → JSON.parse 抛错；
      //   2) 双层转义：arguments 被引号包成字符串值，JSON.parse 成功但结果是
      //      string/number 而非 object（OpenAI tool arguments 协议要求对象）。
      if (typeof args !== 'string') return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        return false;
      }
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    });

    if (validToolCalls.length === msg.tool_calls.length) {
      out.push(msg); // 全部合法，原样保留
      continue;
    }
    if (validToolCalls.length > 0) {
      // 部分损坏：保留合法的，丢损坏的
      out.push({ ...msg, tool_calls: validToolCalls });
      continue;
    }
    // 全部损坏：若仍有文本 content 则保留为纯文本 assistant，否则整条丢弃
    if (!isEmptyContent(msg.content)) {
      const { tool_calls: _dropped, ...rest } = msg;
      void _dropped;
      out.push({ ...rest });
    }
    // 整条丢弃（配对 tool_result 由后续 sanitizeOpenAIToolMessageSequence 清孤儿）
  }
  return out;
}

/**
 * OpenAI-compatible APIs require every role='tool' message to immediately belong
 * to a preceding assistant message with matching tool_calls, and every assistant
 * tool_call must receive a tool response before normal conversation continues.
 *
 * Conversation history can be damaged by truncation, resume, interruption, or
 * provider/tool-call compatibility fallbacks. This function repairs the sequence
 * at the provider boundary so invalid history is never sent to the LLM.
 */
export function sanitizeOpenAIToolMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  // 先丢掉 arguments 非法 JSON 的 tool_call（流式截断/双层转义毒化历史），
  // 再让下方配对逻辑清理因此产生的孤儿 tool_result。
  const repaired = dropMalformedToolCallArguments(messages);
  const sanitized: ChatMessage[] = [];
  let pendingToolCalls: ToolCall[] = [];

  const flushMissingToolResults = () => {
    if (pendingToolCalls.length === 0) return;
    for (const toolCall of pendingToolCalls) {
      sanitized.push(makeMissingToolResult(toolCall));
    }
    pendingToolCalls = [];
  };

  for (const original of repaired) {
    const message: ChatMessage = {
      ...original,
      ...(original.tool_calls ? { tool_calls: normalizeToolCalls(original.tool_calls) } : {}),
    };

    if (message.role === 'tool') {
      if (pendingToolCalls.length === 0) {
        continue;
      }

      const matchIndex = message.tool_call_id
        ? pendingToolCalls.findIndex((toolCall) => toolCall.id === message.tool_call_id)
        : (pendingToolCalls.length === 1 ? 0 : -1);

      if (matchIndex === -1) {
        continue;
      }

      const [matchedToolCall] = pendingToolCalls.splice(matchIndex, 1);
      sanitized.push({
        ...message,
        tool_call_id: matchedToolCall.id,
      });
      continue;
    }

    // 只有 assistant 消息（新的 tool_calls 批次）才触发 flush；
    // system/user 消息可能由事件处理器在 tool 执行期间注入
    // （如 orchestration:dag_updated → [Orchestration] status=...），
    // 合法出现在 tool_call 和 tool_result 之间，不应触发 flush。
    if (message.role === 'assistant') {
      flushMissingToolResults();
      if (message.tool_calls?.length) {
        sanitized.push(message);
        pendingToolCalls = [...message.tool_calls];
        continue;
      }
    }

    sanitized.push(message);
  }

  flushMissingToolResults();
  return sanitized;
}

// ─── Shared Message Sanitization ─────────────────────────────────────────────

/**
 * 合并连续的 assistant 消息为一条。
 * 用于避免 LLM API 对连续同角色消息的拒绝。
 *
 * 合并策略：content 数组拼接，tool_calls 合并，thinking blocks 合并。
 */
export function mergeConsecutiveAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'assistant' && msg.role === 'assistant') {
      // Merge content
      last.content = concatContent(last.content, msg.content);
      // Merge tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
      }
      // Merge thinking
      if (msg.thinking && msg.thinking.length > 0) {
        last.thinking = [...(last.thinking || []), ...msg.thinking];
      }
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

/**
 * 移除没有对应 tool_use 的孤立 tool_result 消息。
/**
 * 合并连续 user 消息。
 *
 * 续写指令（CONTINUATION_PROMPT）和用户连续输入会产生连续 user 消息。
 * OpenAI-compatible API（尤其 GLM/Qwen/DashScope）要求 user/assistant 严格交替，
 * 连续 user 消息会触发 400 "messages 参数非法"。
 *
 * 合并策略：将连续 user 消息的 content 拼接为一条，保留第一条的 metadata。
 */
export function mergeConsecutiveUserMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && msg.role === 'user') {
      last.content = concatContent(last.content, msg.content);
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

/**
 * 将非首位 system 消息合并到相邻 user 消息。
 *
 * 外层 LLM 重试循环会往对话历史注入 `⚠️ [系统通知]` system 消息。
 * OpenAI-compatible API（尤其 GLM）只允许 system 出现在消息序列开头；
 * 中间 system 消息会触发 400。
 *
 * 策略：
 * - 首个 system 消息（在所有非 system 消息之前）保留原位
 * - 后续 system 消息：有前驱 user 则合并到前驱，否则创建新 user 消息
 * - 内容无损：只改 role，不丢内容
 */
export function coalesceMiddleSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let seenNonSystem = false;
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (!seenNonSystem) {
        out.push({ ...msg });
        continue;
      }
      // 中间 system 消息 → 转为 user content
      const text = contentToPlainText(msg.content);
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        last.content = concatContent(last.content, text);
      } else {
        out.push({ role: 'user', content: text });
      }
    } else {
      seenNonSystem = true;
      out.push({ ...msg });
    }
  }
  return out;
}

/**
 * GLM/Qwen 等模型拒绝只有 system 消息、没有 user 消息的请求（返回 400）。
 * 兜底：如果序列中没有 user 消息，把最后一条非 tool 消息转为 user。
 */
function ensureHasUserMessage(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const hasUser = messages.some(m => m.role === 'user');
  if (hasUser) return messages;
  // 从后往前找最后一条非 tool 消息，转为 user
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'tool') {
      messages[i] = { ...messages[i], role: 'user' };
      break;
    }
  }
  return messages;
}

/**
 * 统一消息序列净化管线（provider 无关）。
 *
 * 在每次 API 调用前执行，确保消息序列符合所有 provider 的格式要求：
 * 1. 合并连续 assistant 消息
 * 2. 合并连续 user 消息（防 GLM/Qwen 400）
 * 3. 合并中间 system 消息到相邻 user（防 GLM 400）
 * 4. 清理孤儿 tool result
 * 5. 填充空内容占位
 * 6. 修复 tool_call/tool_result 配对 + 丢弃 malformed arguments
 *
 * OpenAI 和 Anthropic ContentGenerator 都应调用此函数。
 */
export function sanitizeMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  const beforeCount = messages.length;
  const beforeRoles = countByRole(messages);

  const merged1 = mergeConsecutiveAssistantMessages(messages);
  const merged2 = mergeConsecutiveUserMessages(merged1);
  const coalesced = coalesceMiddleSystemMessages(merged2);
  const cleaned = cleanOrphanedToolCalls(coalesced);
  const contentSanitized = sanitizeMessageContent(cleaned);
  const toolSequenced = sanitizeOpenAIToolMessageSequence(contentSanitized);
  // GLM/Qwen 等模型拒绝只有 system 消息、没有 user 消息的请求（返回 400）。
  // 兜底：如果序列中没有 user 消息，把最后一条非 tool 消息转为 user。
  const final = ensureHasUserMessage(toolSequenced);

  const afterCount = final.length;
  const afterRoles = countByRole(final);

  // 如果有变化，打印统计日志
  if (afterCount !== beforeCount || JSON.stringify(beforeRoles) !== JSON.stringify(afterRoles)) {
    console.log(`[MessageSanitizer] before=${beforeCount} after=${afterCount} beforeRoles=${JSON.stringify(beforeRoles)} afterRoles=${JSON.stringify(afterRoles)}`);

    const mergedAssistants = beforeRoles.assistant - afterRoles.assistant;
    const mergedUsers = beforeRoles.user - afterRoles.user;
    const coalescedSystems = beforeRoles.system - afterRoles.system;
    const removedTools = beforeRoles.tool - afterRoles.tool;

    if (mergedAssistants > 0) console.log(`  mergedAssistants=${mergedAssistants}`);
    if (mergedUsers > 0) console.log(`  mergedUsers=${mergedUsers}`);
    if (coalescedSystems > 0) console.log(`  coalescedSystems=${coalescedSystems}`);
    if (removedTools > 0) console.log(`  removedOrphanTools=${removedTools}`);
  }

  return final;
}

function countByRole(messages: ChatMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    counts[msg.role] = (counts[msg.role] || 0) + 1;
  }
  return counts;
}

/**
 * 移除没有对应 tool_use 的孤立 tool_result 消息。
 * 发生在消息被压缩/截断后。
 *
 * 扫描所有 assistant 消息的 tool_calls，收集已知 id 集合，
 * 然后移除所有 role='tool' 且 tool_call_id 不在集合中的消息。
 */
export function cleanOrphanedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIds.add(tc.id);
      }
    }
  }

  return messages.filter(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      return toolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

// ─── Resume 历史自愈（治标层） ────────────────────────────────────────────────

/**
 * 中断占位结果：当历史里出现"assistant 发起了 tool_call 但配对 tool result 永久缺失"
 * 时，补上这条占位让序列自洽。
 *
 * 文案刻意区别于 provider 边界临时合成的 `[tool result missing]`：
 * - `missing` 是中性陈述，模型常反复试探、卡顿；
 * - 这里给的是「被中断」的确定因果 + 明确行动引导（重发 or 给结论），
 *   符合「失败类返回必须给可执行引导」的确定性约束。
 */
const INTERRUPTED_PLACEHOLDER =
  '[工具执行被中断，结果未保存。上次调用未完成；请基于当前状态判断是否需要重新发起该工具，或直接给出当前结论。]';

/**
 * 检测并修复历史里的「中断孤儿」——assistant 带 tool_calls，但对应的 role:'tool' 结果
 * 永久缺失（assistant 已落库、tool 结果未落库）。
 *
 * 根因：工具执行管线（ToolResponseProcessor）在 `persistAssistantMessage` 之后才
 * `persistToolMessage`，中间隔着慢工具执行（dispatch_agent spawn worker / shell / 网络）。
 * 进程在这段窗口被 kill（心跳误杀 / SIGTERM / OOM / 崩溃）或 `saveConversationMessage`
 * 抛错冒泡跳过后续，就会把「无配对 tool_call 的 assistant」永久写进 leader_conversation。
 * resume 加载后，provider 边界 sanitizer 每次发请求都临时合成 `[tool result missing]`
 * 占位（不写库）→ 脏历史每轮重新触发、模型反复看到 missing。
 *
 * 本函数在 resume 加载历史时调用，把检测到的孤儿补成明确语义占位并（由调用方）写回 DB，
 * 从此该段历史自洽——模型看到「被中断」而非反复 missing。
 *
 * 与 `sanitizeOpenAIToolMessageSequence` 的分工：
 * - sanitize：provider 边界只读内存修复，每次发请求临时净化（含 malformed arguments、
 *   反方向孤儿），不写库、不可持久化自愈；
 * - heal：持久化层一次性自愈，只增不删，聚焦「补缺失的 tool result」。
 *
 * 纯确定性：assistant 带 tool_calls 却缺配对 tool result ⟺ 进程级中断
 * （batch 内部异常已被 runToolCallsBatch 的 try/catch 兜底，不会产生这类孤儿）。
 */
export function healInterruptedToolCalls(messages: ChatMessage[]): {
  healed: ChatMessage[];
  addedCount: number;
} {
  const out: ChatMessage[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let addedCount = 0;

  const flushPending = () => {
    for (const toolCall of pendingToolCalls) {
      out.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: INTERRUPTED_PLACEHOLDER,
      });
      addedCount += 1;
    }
    pendingToolCalls = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      // 尝试与 pending tool_call 配对。配不上的反方向孤儿（有 result 无 call）保留原样，
      // 由 provider 边界 cleanOrphanedToolCalls 兜底清理——heal 只增不删。
      if (pendingToolCalls.length > 0 && message.tool_call_id) {
        const idx = pendingToolCalls.findIndex((tc) => tc.id === message.tool_call_id);
        if (idx >= 0) pendingToolCalls.splice(idx, 1);
      }
      out.push(message);
      continue;
    }

    // 非 tool 消息（assistant / user / system）出现前，上一组仍未配对的 tool_call 必然是
    // 中断产物：要么进程死在工具执行中途（末尾），要么被后续消息打断（中间）。
    flushPending();
    out.push(message);

    if (message.role === 'assistant' && message.tool_calls?.length) {
      pendingToolCalls = [...message.tool_calls];
    }
  }

  // 序列末尾仍有未配对 → 最典型的末尾中断（崩溃发生在最后一轮工具执行）。
  flushPending();

  return { healed: out, addedCount };
}

/**
 * 给消息数组分配严格递增的 timestamp，保证写回 DB 后 `ORDER BY timestamp` 读回顺序
 * 与数组顺序一致。
 *
 * 用于 resume 自愈后 `replaceConversation` 重写：补的占位没有原始 timestamp，
 * 若直接落库会被 `getConversationMessages` 按 timestamp 排到末尾（错乱）。本函数确保
 * 占位紧跟其 assistant（占位 ts = 前一条 ts + ε），原始消息尽量保留真实 ts（仅在
 * 与前一条不满足严格递增时微调）。
 *
 * 纯函数，不调用 Date.now（base 取首条消息 ts；resume 历史首条总有 ts）。
 */
export function resequenceTimestampsForPersistence(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const out: ChatMessage[] = [];
  // -Infinity 起步：首条消息直接取自身 ts（Math.max(orig, -Inf)=orig），原样保留；
  // 后续每条至少 +EPSILON，保证严格递增。epoch 秒级浮点（~1.7e9）精度约 0.0004s，
  // EPSILON=0.001 足以稳定区分，ORDER BY timestamp 读回顺序与数组一致。
  let lastTs = -Infinity;
  const EPSILON = 0.001;
  for (const msg of messages) {
    const orig = typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp) ? msg.timestamp : null;
    const ts = orig != null ? Math.max(orig, lastTs + EPSILON) : lastTs + EPSILON;
    lastTs = ts;
    out.push({ ...msg, timestamp: ts });
  }
  return out;
}

/**
 * 清理空消息内容，确保消息格式符合 API 要求。
 * 对不同角色的空消息使用合适的占位内容。
 */
export function sanitizeMessageContent(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  return messages.map(msg => {
    const sanitized = { ...msg };
    const empty = isEmptyContent(sanitized.content);

    if (sanitized.role === 'tool') {
      if (empty) sanitized.content = '(empty result)';
    } else if (sanitized.role === 'assistant') {
      if (sanitized.tool_calls && sanitized.tool_calls.length > 0) {
        if (empty) sanitized.content = null;
      } else {
        if (empty) sanitized.content = '(thinking...)';
      }
    } else if (sanitized.role === 'user' || sanitized.role === 'system') {
      if (empty) sanitized.content = '(empty)';
    }
    return sanitized;
  });
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function concatContent(a: MessageContent, b: MessageContent): MessageContent {
  // Normalize both to arrays for uniform concatenation
  const aParts = toContentParts(a);
  const bParts = toContentParts(b);

  // If both were originally strings and result is purely text, return string
  if (typeof a === 'string' && typeof b === 'string') {
    const aText = a || '';
    const bText = b || '';
    return aText && bText ? `${aText}\n${bText}` : aText || bText;
  }

  // If either is null/empty, return the other
  if (aParts.length === 0) return b;
  if (bParts.length === 0) return a;

  return [...aParts, ...bParts];
}

function toContentParts(content: MessageContent): MessageContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text' as const, text: content }] : [];
  }
  return content;
}
