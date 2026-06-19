/**
 * 退出横幅 — Ctrl+C / exit 时打印的告别画面。
 *
 * 复用首页的 凌霄 半块字形（DEFAULT_GLYPH = 楷锋 / 剑气凌冽），
 * 以品牌青锋渐变上色，并附会话 ID 与续接命令，方便用户复制重连。
 *
 * 纯函数：输入 (sessionId, binName, version) → ANSI 字符串。
 * 不读时钟、不随机，便于测试快照。
 */
import { Chalk } from 'chalk';
import { DEFAULT_GLYPH } from './glyph/lingxiaoGlyph.js';
import { composeWithSword } from './glyph/swordGlyph.js';
import { renderSealString, SEAL_CHAR } from '../design/iconography.js';
import { t } from '../../i18n.js';

export interface FarewellOptions {
  /** 当前会话 ID（用于生成续接命令）。空则省略续接行。 */
  sessionId?: string | null;
  /** CLI 可执行名，默认 lingxiao。 */
  binName?: string;
  /** 版本号，渲染在标题角标。 */
  version?: string;
  /** 是否启用颜色（非 TTY / NO_COLOR 时关闭）。 */
  color?: boolean;
}

// 凌霄金色渐变：底部不再压到棕黑，避免退出页在深色终端里糊成一团。
const GRADIENT = [
  '#fff8e0', '#fff0b8', '#f7dd94', '#f2c673',
  '#e6b84c', '#dba746', '#cc9340', '#bd8438',
  '#ad7834', '#9c7036', '#8c6a3b', '#7e6746',
  '#718087',
];

function colorForRow(rowIndex: number, total: number): string {
  if (total <= 1) return GRADIENT[0];
  const pos = rowIndex / (total - 1);
  const idx = Math.min(GRADIENT.length - 1, Math.round(pos * (GRADIENT.length - 1)));
  return GRADIENT[idx];
}

/**
 * 构建退出横幅文本（含尾随换行）。
 */
export function renderFarewellBanner(opts: FarewellOptions = {}): string {
  const useColor = opts.color !== false;
  const binName = opts.binName || 'lingxiao';
  const rows = composeWithSword(DEFAULT_GLYPH).rows;
  const pad = '  ';

  // 颜色决策权交给调用方（isTTY && !NO_COLOR）；启用时强制 chalk truecolor，
  // 不让 chalk 的环境探测在管道/重定向下把颜色吞掉。
  const ink = useColor ? new Chalk({ level: 3 }) : null;
  const paint = (s: string, hex: string, bold = false): string => {
    if (!ink) return s;
    const c = ink.hex(hex);
    return bold ? c.bold(s) : c(s);
  };
  const dim = (s: string): string => (ink ? ink.hex('#857c6e')(s) : s);
  const muted = (s: string): string => (ink ? ink.hex('#b3aa9b')(s) : s);
  const accent = (s: string): string => paint(s, '#f2c673', true);
  const resume = (s: string): string => paint(s, '#f3e3b0', true);

  const lines: string[] = [];
  lines.push('');

  // 字形主体（逐行青锋渐变）
  for (let i = 0; i < rows.length; i++) {
    lines.push(pad + paint(rows[i], colorForRow(i, rows.length)));
  }
  lines.push('');

  // 题字 / motto —— 朱砂「别」印盖于题字之首，一点朱砂收束会话。
  lines.push(pad + renderSealString(SEAL_CHAR.farewell, useColor) + ' ' + accent(t('tui.welcome.tagline')) + muted('  │  ') + muted(t('cli.farewell.motto')));

  // 会话 + 续接命令
  const sid = (opts.sessionId || '').trim();
  if (sid) {
    lines.push('');
    lines.push(pad + dim('╭─ ') + dim(t('cli.farewell.session') + '  ') + accent(sid));
    const resumeCmd = `${binName} --session ${sid}`;
    lines.push(pad + dim('╰─ ') + dim(t('cli.farewell.resume') + '  ') + resume(resumeCmd));
  }
  lines.push('');

  return lines.join('\n');
}
