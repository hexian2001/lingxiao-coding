/**
 * Leader user content builder
 *
 * 纯函数：根据用户原始 MessageContent 构造注入了 "用户请求:" 前缀
 * 以及工作区尾缀的 content。
 */

import {
  isContentPartArray,
  type MessageContent,
} from '../../llm/types.js';

/**
 * 为 Leader 的首条用户消息构造展示用 content：
 * - 字符串直接原样返回
 * - content part 数组的第一段 text 前面加 "用户请求: "
 * - 尾部追加工作区信息
 */
export function buildInitialUserContent(
  content: MessageContent,
  workspace: string,
): MessageContent {
  if (!isContentPartArray(content)) {
    return content;
  }

  const userContent = content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if (part.type === 'image_url') {
      return {
        type: 'image_url' as const,
        image_url: { ...part.image_url },
      };
    }
    return { ...part };
  });

  let prepended = false;
  for (let i = 0; i < userContent.length; i++) {
    const part = userContent[i];
    if (part.type === 'text') {
      userContent[i] = {
        type: 'text',
        text: `用户请求: ${part.text}`,
      };
      prepended = true;
      break;
    }
  }

  if (!prepended) {
    userContent.unshift({ type: 'text', text: '用户请求 (多模态)' });
  }

  userContent.push({
    type: 'text',
    text: `\n\n工作区: ${workspace}`,
  });

  return userContent;
}
