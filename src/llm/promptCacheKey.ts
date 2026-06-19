/**
 * promptCacheKey — 计算稳定 prompt_cache_key
 *
 * 用途：OpenAI / Codex / OpenAI API 协议端的请求路由键。OpenAI 官方文档
 * (https://platform.openai.com/docs/guides/prompt-caching) 说明：
 * 相同 prefix 的请求自动命中缓存，但不同 user_id / 调用方混在一起会
 * 让 hot-path 缓存桶被冲掉。`prompt_cache_key`（旧接口用 `user`）
 * 显式声明"我希望这一类请求共享缓存桶"，命中率会提升 30~50%。
 *
 * 凌霄场景下，同一个 (system_prompt, tools 集合) 是稳定前缀；leader
 * 与各 worker 的 system prompt 不同 — 因此把这两者哈希出来作为 key。
 * 历史 messages 不参与哈希，否则每轮新增 message 都会换桶，反而毁掉
 * 缓存。
 *
 * 注：prompt_cache_key 是不透明字符串，长度 ≤ 64。我们用 SHA-256
 * 截前 32 个 hex 字符（128 bit）。第三方 OpenAI API 服务一般会忽略
 * 未知字段，安全。
 */

import { createHash } from 'node:crypto';
import type { ChatMessage, ToolDefinition } from './types.js';
import { contentToPlainText } from './types.js';

const KEY_PREFIX = 'lx_';
const HASH_HEX_LEN = 32; // 128 bit

/**
 * 基于 system prompt + tools 集合 + model 计算稳定 cache key。
 *
 * 不取 user / assistant 消息，因为它们逐轮变化；要求"相同 leader 配置 →
 * 相同 key"才能让 OpenAI 的缓存桶聚拢。
 */
export function computePromptCacheKey(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  model: string,
): string {
  const hasher = createHash('sha256');
  hasher.update(`model:${model}\n`);

  // 取所有 system 消息的纯文本内容（一般只有 1 条，但允许多条）
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const text = contentToPlainText(m.content);
    hasher.update(`sys:${text}\n`);
  }

  // tools 集合的稳定签名：按名字排序，哈希 name + parameters schema。
  // description 不参与（经常改措辞但不影响行为），parameters 参与（决定 LLM 生成的 JSON 结构）。
  if (tools && tools.length > 0) {
    const sorted = [...tools].sort((a, b) => a.function.name.localeCompare(b.function.name));
    for (const t of sorted) {
      hasher.update(`tool:${t.function.name}:`);
      if (t.function.parameters) {
        hasher.update(JSON.stringify(t.function.parameters));
      }
      hasher.update('\n');
    }
  }

  return KEY_PREFIX + hasher.digest('hex').slice(0, HASH_HEX_LEN);
}
