/**
 * 凌霄 HTML 办公主题系统 —— 单一事实源。
 *
 * 从 TUI 既定中式审美（src/tui/theme.ts 的松烟暖炭/宣纸暖白/剑金/朱砂 +
 * iconography.ts 的朱砂印 #c95a4a）下沉到 HTML 产物层，让 PPT/DOC/PDF/Web
 * 共用同一套设计 token。历史问题：中式审美只活在 TUI，HTML 系四个办公工具
 * 全无主题（见 mode-isolation 审计）。
 *
 * 设计原则（对齐 no-heuristics + 用户中式审美主张）：
 *   - 每套主题 = 一组 CSS custom properties（颜色/字体/间距/印章），纯数据。
 *   - 字体栈 CJK 优先（思源宋体/Noto Serif SC → 系统宋体 → serif fallback）。
 *   - 不硬编码业务样式；组件层只消费 token。
 *   - 8 套主题覆盖：水墨极简（默认）、朱砂典藏、青锋科技、金箔商务、宣纸纯净、
 *     编辑杂志、暗色高级、宣纸纯净。
 *
 * 桥接：OfficeTemplateRegistry 的每个预设通过 htmlThemeId 映射到本文件的主题，
 * 确保原生 PPTX/DOCX 和 HTML 产物共享同一套设计 DNA。
 */

/** 主题标识符。 */
export type HtmlOfficeThemeId =
  | 'ink-wash'
  | 'vermilion'
  | 'cyan-blade'
  | 'gold-leaf'
  | 'papyrus'
  | 'editorial'
  | 'dark-luxury';

/** 一套主题的设计 token（对应 CSS custom properties）。 */
export interface HtmlOfficeTheme {
  id: HtmlOfficeThemeId;
  /** 中文显示名。 */
  label: string;
  /** 一句话设计意图。 */
  intent: string;
  /** 主背景（纸色/墨色）。 */
  bg: string;
  /** 次背景（卡片/分区）。 */
  surface: string;
  /** 正文墨色。 */
  ink: string;
  /** 次级文字（注脚/辅助）。 */
  inkMuted: string;
  /** 强调色（青锋/朱砂等主调）。 */
  accent: string;
  /** 强调色压暗（hover/border）。 */
  accentStrong: string;
  /** 警示/印章红。 */
  seal: string;
  /** 装饰金箔。 */
  gold: string;
  /** 分隔线/边框。 */
  rule: string;
  /** 标题字体栈（CJK 优先）。 */
  fontTitle: string;
  /** 正文字体栈（CJK 优先）。 */
  fontBody: string;
  /** 等宽/代码字体栈。 */
  fontMono: string;
}

/**
 * CJK 优先字体栈。
 * 思源宋体（Source Han Serif / Noto Serif SC）→ 苹方/微软雅黑/系统宋体 → serif 兜底。
 * 英文配衬线（Lora/Crimson）与无衬线（Inter/系统）做次级。
 */
const CJK_SERIF_TITLE =
  '"Source Han Serif SC","Noto Serif SC","Songti SC","STSong","SimSun","Microsoft YaHei",serif';
const CJK_SERIF_BODY =
  '"Source Han Serif SC","Noto Serif SC","Songti SC","STSong","SimSun","Microsoft YaHei","Lora","Crimson Text",serif';
const CJK_SANS_BODY =
  '"Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei","Inter","Helvetica Neue",sans-serif';
const EDITORIAL_TITLE =
  'Georgia,"Source Han Serif SC","Noto Serif SC","Songti SC","STSong","SimSun",serif';
const MONO = '"JetBrains Mono","Fira Code","SF Mono","Cascadia Mono",Menlo,Consolas,monospace';

/** 全部主题（frozen 单一事实源）。 */
export const HTML_OFFICE_THEMES: Readonly<Record<HtmlOfficeThemeId, HtmlOfficeTheme>> = Object.freeze({
  /** 墨韵：默认。松烟暖炭为骨，宣纸暖白为肉，剑金为锋。极简水墨。 */
  'ink-wash': {
    id: 'ink-wash',
    label: '墨韵',
    intent: '松烟暖炭为骨、宣纸暖白为肉、剑金为锋的极简水墨',
    bg: '#F5F2EA',
    surface: '#EFEADF',
    ink: '#1F1B16',
    inkMuted: '#6B6258',
    accent: '#8A6A2F',
    accentStrong: '#6E531F',
    seal: '#C95A4A',
    gold: '#C9A86A',
    rule: '#D9D2C4',
    fontTitle: CJK_SERIF_TITLE,
    fontBody: CJK_SERIF_BODY,
    fontMono: MONO,
  },
  /** 朱砂典藏：朱砂印为魂，墨底金线，适合典藏/总结/年报。 */
  vermilion: {
    id: 'vermilion',
    label: '朱砂',
    intent: '朱砂印为魂、墨底金线，典藏/年报/总结气场',
    bg: '#0E0C0A',
    surface: '#171310',
    ink: '#EFE6D6',
    inkMuted: '#A89A82',
    accent: '#E5484D',
    accentStrong: '#C7363B',
    seal: '#E5484D',
    gold: '#D4B36A',
    rule: '#3A322A',
    fontTitle: CJK_SERIF_TITLE,
    fontBody: CJK_SERIF_BODY,
    fontMono: MONO,
  },
  /** 青锋科技：青锋冷光，适合产品/技术/数据。 */
  'cyan-blade': {
    id: 'cyan-blade',
    label: '青锋',
    intent: '青锋冷光，产品/技术/数据主题',
    bg: '#0B1116',
    surface: '#121B22',
    ink: '#E6EEF2',
    inkMuted: '#8FA3B0',
    accent: '#5FE0C7',
    accentStrong: '#3FC4AB',
    seal: '#E5484D',
    gold: '#C9A86A',
    rule: '#243038',
    fontTitle: CJK_SANS_BODY,
    fontBody: CJK_SANS_BODY,
    fontMono: MONO,
  },
  /** 金箔商务：暖纸金箔，适合提案/商业计划/咨询。 */
  'gold-leaf': {
    id: 'gold-leaf',
    label: '金箔',
    intent: '暖纸金箔，提案/商业计划/咨询气场',
    bg: '#FBF7EE',
    surface: '#F4ECDB',
    ink: '#2A241A',
    inkMuted: '#766A54',
    accent: '#B0832E',
    accentStrong: '#8C6620',
    seal: '#C95A4A',
    gold: '#C9A86A',
    rule: '#E2D6BD',
    fontTitle: CJK_SERIF_TITLE,
    fontBody: CJK_SANS_BODY,
    fontMono: MONO,
  },
  /** 宣纸纯净：最低存在感，适合打印/长文档/学术。 */
  papyrus: {
    id: 'papyrus',
    label: '宣纸',
    intent: '最低存在感，打印/长文档/学术',
    bg: '#FFFFFF',
    surface: '#F7F6F3',
    ink: '#1A1A1A',
    inkMuted: '#5A5A5A',
    accent: '#1A1A1A',
    accentStrong: '#000000',
    seal: '#C95A4A',
    gold: '#C9A86A',
    rule: '#D8D4CC',
    fontTitle: CJK_SERIF_TITLE,
    fontBody: CJK_SERIF_BODY,
    fontMono: MONO,
  },
  /** 编辑杂志：大标题 + 多栏排版 + 引文块 + 图片叙事。 */
  editorial: {
    id: 'editorial',
    label: '编辑',
    intent: '大标题 + 多栏排版 + 引文块 + 图片叙事，深度报告/白皮书/洞察',
    bg: '#FFFFFF',
    surface: '#F5F5F0',
    ink: '#1A1A1A',
    inkMuted: '#666666',
    accent: '#8B2C2C',
    accentStrong: '#6B1F1F',
    seal: '#8B2C2C',
    gold: '#D4A843',
    rule: '#DDDDDD',
    fontTitle: EDITORIAL_TITLE,
    fontBody: CJK_SANS_BODY,
    fontMono: MONO,
  },
  /** 暗色高级：墨黑底 + 金箔强调 + 大量留白，品牌/战略/发布会。 */
  'dark-luxury': {
    id: 'dark-luxury',
    label: '暗夜',
    intent: '墨黑底 + 金箔强调 + 大量留白，品牌/战略/发布会/高端叙事',
    bg: '#0B0E11',
    surface: '#15191E',
    ink: '#E8E4D8',
    inkMuted: '#8A857A',
    accent: '#C9A86A',
    accentStrong: '#A88A4E',
    seal: '#E5484D',
    gold: '#C9A86A',
    rule: '#2A2E33',
    fontTitle: CJK_SERIF_TITLE,
    fontBody: CJK_SANS_BODY,
    fontMono: MONO,
  },
});

export const DEFAULT_HTML_OFFICE_THEME: HtmlOfficeThemeId = 'ink-wash';

export function resolveHtmlOfficeTheme(id: string | undefined): HtmlOfficeTheme {
  if (id && (id in HTML_OFFICE_THEMES)) {
    return HTML_OFFICE_THEMES[id as HtmlOfficeThemeId];
  }
  return HTML_OFFICE_THEMES[DEFAULT_HTML_OFFICE_THEME];
}

export const ALL_HTML_OFFICE_THEME_IDS: readonly HtmlOfficeThemeId[] = Object.freeze(
  Object.keys(HTML_OFFICE_THEMES) as HtmlOfficeThemeId[],
);

/** 把主题 token 渲染成一段 :root CSS custom properties（供组件层 var(--lx-*) 消费）。 */
export function renderThemeCssVars(theme: HtmlOfficeTheme): string {
  return [
    `--lx-bg:${theme.bg};`,
    `--lx-surface:${theme.surface};`,
    `--lx-ink:${theme.ink};`,
    `--lx-ink-muted:${theme.inkMuted};`,
    `--lx-accent:${theme.accent};`,
    `--lx-accent-strong:${theme.accentStrong};`,
    `--lx-seal:${theme.seal};`,
    `--lx-gold:${theme.gold};`,
    `--lx-rule:${theme.rule};`,
    `--lx-font-title:${theme.fontTitle};`,
    `--lx-font-body:${theme.fontBody};`,
    `--lx-font-mono:${theme.fontMono};`,
  ].join('');
}
