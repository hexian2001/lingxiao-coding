import { tuiTheme } from '../theme.js';

export const tuiColors = {
  text: tuiTheme.semantic.text.primary,
  muted: tuiTheme.semantic.text.secondary,
  subtle: tuiTheme.semantic.panel.help,
  heading: tuiTheme.semantic.panel.title,
  accent: tuiTheme.semantic.text.accent,
  accentAlt: tuiTheme.semantic.runtime.leader,
  border: tuiTheme.semantic.border.default,
  borderFocus: tuiTheme.semantic.border.focused,
  success: tuiTheme.semantic.status.completed,
  warning: tuiTheme.semantic.status.warning,
  danger: tuiTheme.semantic.status.failed,
  inputText: tuiTheme.semantic.text.primary,
} as const;

export const tuiGlyphs = {
  leader: '✦',
  agent: '●',
  user: '>',
  thinking: '·',
  tool: '⚙',
  success: '✓',
  error: '✕',
  // 列表标记(unicode 符号,非 emoji):ul 一级圆点 / 嵌套空心圆
  ulBullet: '•',
  ulBulletNested: '◦',
} as const;
