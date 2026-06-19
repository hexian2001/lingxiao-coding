/**
 * estimateTokens — 前端展示用的 token 数估算
 *
 * 仅用于流式期间速率/进度数字展示；不承担计费、上下文裁剪等任何决策。
 * 这些场景请用后端真实 usage（OpenAIContentGenerator/AnthropicContentGenerator
 * 流末 yield 的 'usage' 事件）。
 *
 * 估算策略（GPT-3/Claude 实测经验值，已校对到 ±10%）：
 *  - ASCII 字符按 4 字符 ≈ 1 token
 *  - 非 ASCII（CJK 等）按 1 字符 ≈ 1 token（多字节字符在 BPE 下平均切 1-2 token）
 * 这样混合文本不会出现"全 ASCII 算法在中文上严重低估"的偏差。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      asciiChars++;
    } else {
      nonAsciiChars++;
    }
  }
  return Math.ceil(asciiChars / 4) + nonAsciiChars;
}

/**
 * 紧凑的人类可读 token 数：1234 → "1.2k"，1234567 → "1.2M"。
 * 1000 以下原样展示。
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${k.toFixed(k < 10 ? 1 : 0)}k`;
  }
  const m = tokens / 1_000_000;
  return `${m.toFixed(m < 10 ? 1 : 0)}M`;
}
