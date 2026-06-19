/**
 * SoulExtractor - 会话结束时自动提取可沉淀的长期记忆候选
 *
 * 过滤噪音（工具调用、系统消息、思考片段），只保留用户请求和 Leader 最终回复中的关键信息。
 */

/** 通用消息接口，兼容 BusMessage 和 CommandLogMessage */
export interface SoulMessage {
  type?: string;
  content?: unknown;
  from?: string;
  to?: string;
  payload?: unknown;
}

export interface SoulExtractedEntry {
  category: 'preference' | 'decision' | 'architecture' | 'norm' | 'other';
  content: string;
  scope: 'user' | 'project';
}

export interface SoulExtractResult {
  entries: SoulExtractedEntry[];
  soulPath?: string;
}

/**
 * 消息类型白名单：只处理用户和 agent/leader 消息
 */
const ALLOWED_TYPES = new Set(['user', 'agent', 'leader', 'success', 'request', 'response']);

/**
 * 提取文本内容：支持 string, array, object
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return (content as { text?: string }).text || JSON.stringify(content);
  }
  return '';
}

/**
 * 噪音关键词：用于过滤不重要的内容
 */
const NOISE_PATTERNS = [
  /^工具结果?/i,
  /^调用\s+\w+/i,
  /^running\b/i,
  /^done\b/i,
  /^会话\s+\w+\s+(已创建|已删除|已完成)/i,
  /^Leader mode\s*->/i,
  /^Permission state/i,
  /^Leader:\s*(Thinking|Context Managing|Calling LLM)/i,
];

function isNoiseMessage(msg: SoulMessage): boolean {
  const msgType = msg.type || '';
  if (!ALLOWED_TYPES.has(msgType)) {
    return true;
  }
  const content = extractTextContent(msg.content);
  return NOISE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * 分类：不做关键词猜测，统一标记为 'other'。
 * 真正的分类应在上游由 LLM 结构化输出决定，或在下游由 MemoryManager 按需标注。
 */
function categorizeContent(_content: string): SoulExtractedEntry['category'] {
  return 'other';
}

/**
 * 判断 scope：默认 'project'。
 * 用户级记忆需由 LLM 显式标注，不做关键词推断。
 */
function determineScope(_content: string, _msgType: string): 'user' | 'project' {
  return 'project';
}

/**
 * 从会话消息中提取长期记忆候选
 *
 * 过滤掉工具调用日志、系统消息、思考片段，
 * 只保留用户请求和 Leader 最终回复，并分类提取。
 */
export function extractSoulContent(messages: SoulMessage[]): SoulExtractedEntry[] {
  const entries: SoulExtractedEntry[] = [];

  for (const msg of messages) {
    if (isNoiseMessage(msg)) {
      continue;
    }

    const content = extractTextContent(msg.content).trim();
    if (content.length < 20) {
      continue; // 太短的内容不记录
    }

    const category = categorizeContent(content);
    const scope = determineScope(content, msg.type || '');

    entries.push({
      category,
      content,
      scope,
    });
  }

  return entries;
}

/**
 * 格式化长期记忆条目正文。函数名保留旧 soul 口径，供兼容调用。
 */
export function formatSoulEntry(entry: SoulExtractedEntry, timestamp: string): string {
  const categoryLabel = {
    preference: '偏好',
    decision: '决策',
    architecture: '架构',
    norm: '规范',
    other: '记录',
  }[entry.category];

  return `\n\n## [${timestamp}] ${categoryLabel}\n\n${entry.content}\n`;
}
