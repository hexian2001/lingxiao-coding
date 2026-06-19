/**
 * 工具结果 / 输入参数 的「确定性」格式化纯函数。
 *
 * 设计铁律（项目约束）：语言推断与 JSON 判定全部走结构判定
 * （类型检查、trim 后首字符 `[`/`{`），禁止关键词匹配 / 硬编码阈值 / confidence。
 * 这样面对任意巨型项目的工具输出都能稳定归类，不依赖启发式猜测。
 *
 * 本模块无 React 依赖，可被 ToolOutputView / MessageBubble / AgentPanel 复用。
 */
import type { ToolUiKind } from './toolClassification';

/**
 * 扩展名 → Prism 语言的「全静态」映射（确定性）。
 * 覆盖凌霄工具链常见文件类型；未命中扩展名由调用方回退到 plaintext。
 */
const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', rb: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'markdown', markdown: 'markdown',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp',
  php: 'php', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r',
  graphql: 'graphql', gql: 'graphql',
  // 无扩展名的特殊文件名（全小写 basename 命中）
  dockerfile: 'dockerfile', makefile: 'makefile',
  // 纯文本类：明确落 plaintext（短路，跳过 PrismAsync tokenize）
  txt: 'plaintext', log: 'plaintext', env: 'bash', gitignore: 'bash',
};

/** 把可能是 JSON 字符串 / 对象的值解析成 record（复刻 MessageBubble 私有 helper）。 */
function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 从可能为 JSON 字符串 / 对象的值里取首个非空字符串字段（复刻 MessageBubble 私有 helper）。 */
function pickStringField(value: unknown, keys: string[]): string | null {
  const parsed = parseMaybeJsonObject(value);
  if (!parsed) return null;
  for (const key of keys) {
    const raw = parsed[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

/** 取路径末段 basename，兼容 Windows 反斜杠（复刻 MessageBubble 私有 helper）。 */
function basename(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return normalized || value;
}

/**
 * 从文件路径确定性推断 Prism 语言。
 * 取 basename → 小写 → 剥离 query/fragment → 先查扩展名，再查全名（Dockerfile/Makefile）。
 * 未命中返回 null（调用方回退 plaintext）。
 */
function extFromPath(path: string | null): string | null {
  const base = basename(path);
  if (!base) return null;
  const clean = base.toLowerCase().split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  if (dot >= 0 && dot < clean.length - 1) {
    return EXT_LANG_MAP[clean.slice(dot + 1)] ?? null;
  }
  return EXT_LANG_MAP[clean] ?? null;
}

/**
 * 确定性 JSON 解析：仅当 trim 后首字符为 `{` / `[` 才尝试 parse。
 * 用结构信号而非正则/关键词判定，避免误判普通文本。
 */
export function tryParseJson(text: string): unknown | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Leader「合成 settle」结果判定（复刻 MessageBubble isLeaderSyntheticToolSettleResult）。 */
function isLeaderSyntheticToolSettleResult(value: unknown): boolean {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as { kind?: unknown }).kind === 'leader_tool_settle';
  }
  if (typeof value !== 'string') return false;
  return value.startsWith('Leader became idle before this tool produced a final result:')
    || value.startsWith('Runtime snapshot reported idle before this tool produced a final result:');
}

/**
 * 把任意工具结果（unknown）规范化为展示文本。
 * - 合成 settle 结果 → ''（由调用方跳过渲染）
 * - 字符串 → 原样（不在这一步美化 JSON，把语言判定权留给 inferOutputLanguage）
 * - 含 `.message` 字符串的对象 → 取 message
 * - 其它 → JSON.stringify（缩进 2）
 */
export function coerceResultToString(result: unknown): string {
  if (result === undefined || result === null || result === '') return '';
  if (isLeaderSyntheticToolSettleResult(result)) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && !Array.isArray(result)) {
    const message = (result as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * 推断「工具结果」应使用的 Prism 语言（确定性优先级，首匹配胜出）：
 * 1. 结果文本是合法 JSON（`{`/`[` 起始）→ 'json'（覆盖后端序列化结果）
 * 2. read / file_create / file_edit → 按输入路径扩展名
 * 3. shell → 'bash'
 * 4. 其余 → 'plaintext'
 */
export function inferOutputLanguage(
  _toolName: string | undefined,
  kind: ToolUiKind,
  input: unknown,
  text: string,
): string {
  if (tryParseJson(text) !== null) return 'json';
  if (kind === 'read' || kind === 'file_create' || kind === 'file_edit') {
    const path = pickStringField(input, ['path', 'file', 'filePath', 'targetPath', 'filename']);
    const lang = extFromPath(path);
    if (lang) return lang;
  }
  if (kind === 'shell') return 'bash';
  return 'plaintext';
}

/**
 * 推断「输入参数」应使用的 Prism 语言。
 * 输入参数经 JSON.stringify 后几乎总是 JSON 文本 → 默认 'json'；
 * 仅当 input 本身是裸字符串且非 JSON 时回退 'plaintext'。
 * （shell 工具的 `{command:"..."}` 也是 JSON 结构，按 json 高亮最清晰，故不特殊处理。）
 */
export function inferInputLanguage(_toolName: string | undefined, _kind: ToolUiKind, input: unknown): string {
  if (typeof input === 'string') {
    return tryParseJson(input) !== null ? 'json' : 'plaintext';
  }
  return 'json';
}

/** 语言是否为 plaintext（含空值），组件侧据此短路，跳过 PrismAsync tokenize。 */
export function isPlaintext(lang: string): boolean {
  return !lang || lang === 'plaintext';
}
