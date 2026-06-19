import JSZip from 'jszip';

export type OfficeThemeName = 'executive' | 'deep_space' | 'consulting' | 'minimal' | 'warm';

export interface OfficeTheme {
  name: OfficeThemeName;
  title: string;
  primary: string;
  secondary: string;
  accent: string;
  accent2: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  // ── 视觉增强字段 ──
  gradientFrom: string;    // 渐变起始色
  gradientTo: string;      // 渐变结束色
  shadow: string;          // 阴影色（纯黑或纯白）
  decoration: string;      // 装饰性几何元素颜色（半透明）
  cardFill: string;        // 卡片背景色
  fontHeading: string;     // 标题字体
  fontBody: string;        // 正文字体
}

export const OFFICE_THEMES: Record<OfficeThemeName, OfficeTheme> = {
  executive: {
    name: 'executive',
    title: 'Executive',
    primary: '0F172A',
    secondary: '334155',
    accent: '0EA5A4',
    accent2: '2563EB',
    background: 'F8FAFC',
    surface: 'FFFFFF',
    text: '111827',
    muted: '64748B',
    line: 'CBD5E1',
    gradientFrom: '0F172A',
    gradientTo: '1E3A5F',
    shadow: '000000',
    decoration: '0EA5A4',
    cardFill: 'FFFFFF',
    fontHeading: 'Aptos Display',
    fontBody: 'Aptos',
  },
  deep_space: {
    name: 'deep_space',
    title: 'Deep Space',
    primary: '101828',
    secondary: '1D2939',
    accent: '7C3AED',
    accent2: '06B6D4',
    background: 'F9FAFB',
    surface: 'FFFFFF',
    text: '111827',
    muted: '667085',
    line: 'D0D5DD',
    gradientFrom: '0B1121',
    gradientTo: '1A1040',
    shadow: '000000',
    decoration: '7C3AED',
    cardFill: 'F1F5F9',
    fontHeading: 'Aptos Display',
    fontBody: 'Aptos',
  },
  consulting: {
    name: 'consulting',
    title: 'Consulting',
    primary: '111827',
    secondary: '374151',
    accent: 'C2410C',
    accent2: '0369A1',
    background: 'FAFAF9',
    surface: 'FFFFFF',
    text: '1C1917',
    muted: '78716C',
    line: 'D6D3D1',
    gradientFrom: '1C1917',
    gradientTo: '44403C',
    shadow: '000000',
    decoration: 'C2410C',
    cardFill: 'FFFFFF',
    fontHeading: 'Aptos Display',
    fontBody: 'Aptos',
  },
  minimal: {
    name: 'minimal',
    title: 'Minimal',
    primary: '18181B',
    secondary: '3F3F46',
    accent: '10B981',
    accent2: '6366F1',
    background: 'FAFAFA',
    surface: 'FFFFFF',
    text: '18181B',
    muted: '71717A',
    line: 'D4D4D8',
    gradientFrom: '18181B',
    gradientTo: '27272A',
    shadow: '000000',
    decoration: '10B981',
    cardFill: 'FFFFFF',
    fontHeading: 'Aptos Display',
    fontBody: 'Aptos',
  },
  warm: {
    name: 'warm',
    title: 'Warm',
    primary: '1F2937',
    secondary: '4B5563',
    accent: 'B45309',
    accent2: '047857',
    background: 'FFFBF5',
    surface: 'FFFFFF',
    text: '1F2937',
    muted: '6B7280',
    line: 'E5E7EB',
    gradientFrom: '1F2937',
    gradientTo: '374151',
    shadow: '000000',
    decoration: 'B45309',
    cardFill: 'FFFFFF',
    fontHeading: 'Aptos Display',
    fontBody: 'Aptos',
  },
};

export function getOfficeTheme(name?: string): OfficeTheme {
  if (name && name in OFFICE_THEMES) return OFFICE_THEMES[name as OfficeThemeName];
  return OFFICE_THEMES.executive;
}

export function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function normalizeHex(value: string | undefined, fallback: string): string {
  const raw = String(value || '').replace(/^#/, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback;
}

export function slugFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function ensureExtension(filePath: string, ext: string): string {
  return filePath.toLowerCase().endsWith(ext) ? filePath : `${filePath}${ext}`;
}

export async function zipToBuffer(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// OOXML 原语组件库 — 供 Office XML 相关工具共享
// ═══════════════════════════════════════════════════════════════════════════════

/** OOXML preset geometry names */
export type OoxmlGeometry =
  | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon'
  | 'star5' | 'star6' | 'star7' | 'star4' | 'star8' | 'star10' | 'star12' | 'star16' | 'star24' | 'star32'
  | 'rightArrow' | 'leftArrow' | 'upArrow' | 'downArrow' | 'chevron'
  | 'line' | 'straightConnector1' | 'bentConnector2' | 'bentConnector4' | 'curvedConnector3'
  | 'arc' | 'chord' | 'cloud' | 'heart' | 'lightningBolt' | 'moon' | 'sun' | 'smileyFace'
  | 'wedgeRectCallout' | 'wedgeRoundRectCallout' | 'wedgeEllipseCallout' | 'cloudCallout'
  | 'flowChartProcess' | 'flowChartDecision' | 'flowChartTerminator' | 'flowChartDocument'
  | 'flowChartPredefinedProcess' | 'flowChartStoredData' | 'flowChartInternalStorage'
  | 'flowChartSequentialAccessStorage' | 'flowChartMagneticDisk' | 'flowChartDirectAccessStorage'
  | 'flowChartDisplay' | 'flowChartDelay' | 'flowChartAlternateProcess' | 'flowChartOffpageConnector'
  | 'foldedCorner' | 'frame' | 'halfFrame' | 'accentBorderCallout1' | 'accentBorderCallout2' | 'accentBorderCallout3'
  | 'actionButtonBackPrevious' | 'actionButtonForwardNext' | 'actionButtonBeginning' | 'actionButtonEnd'
  | 'actionButtonHome' | 'actionButtonInformation' | 'actionButtonReturn' | 'actionButtonMovie' | 'actionButtonHelp' | 'actionButtonSound'
  | 'can' | 'cube' | 'bevel' | 'donut' | 'noSmoking'
  | 'pie' | 'blockArc' | 'gear6' | 'gear9'
  | 'corner' | 'diagStripe' | 'plus' | 'plaque' | 'irregularSeal1' | 'irregularSeal2'
  | 'nonIsoscelesTrapezoid' | 'parallelogram' | 'trapezoid';

export interface OoxmlShapeOpts {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  geometry?: OoxmlGeometry;
  fill?: { type: 'solid'; color: string; opacity?: number }
    | { type: 'gradient'; from: string; to: string; angle?: number; opacity?: number }
    | { type: 'none' };
  line?: { color: string; width?: number; dash?: 'solid' | 'dash' | 'dot' | 'dashDot' } | 'none';
  radius?: number;       // 0-100, only for roundRect
  rotation?: number;     // degrees
  shadow?: { color?: string; blur?: number; dist?: number; angle?: number; alpha?: number };
}

/**
 * 通用 OOXML 形状生成器 — 支持 80+ 种几何体、渐变、阴影、圆角、旋转
 */
export function ooxmlShape(opts: OoxmlShapeOpts): string {
  const { id, name, x, y, w, h, geometry = 'rect', radius, rotation, shadow } = opts;
  const esc = (v: unknown) => xmlEscape(v);

  // Geometry
  const isRound = geometry === 'roundRect' || (radius && radius > 0);
  const prst = isRound ? 'roundRect' : geometry;
  const avLst = isRound && radius ? `<a:gd name="adj" fmla="val ${Math.min(Math.max(radius, 0), 100) * 1000}"/>` : '';

  // Transform
  let xfrm = `<a:xfrm${rotation ? ` rot="${rotation * 60000}"` : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;

  // Fill
  let fillXml = '';
  const fill = opts.fill ?? { type: 'solid', color: 'FFFFFF' };
  if (fill.type === 'none') {
    fillXml = '<a:noFill/>';
  } else if (fill.type === 'gradient') {
    const angle = (fill.angle ?? 0) * 60000;
    fillXml = `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${fill.from}">${fill.opacity != null && fill.opacity < 100 ? `<a:alpha val="${fill.opacity * 1000}"/>` : ''}</a:srgbClr></a:gs><a:gs pos="100000"><a:srgbClr val="${fill.to}"/></a:gs></a:gsLst><a:lin ang="${angle}" scaled="1"/></a:gradFill>`;
  } else {
    const alphaXml = fill.opacity != null && fill.opacity < 100 ? `<a:alpha val="${fill.opacity * 1000}"/>` : '';
    fillXml = `<a:solidFill><a:srgbClr val="${fill.color}">${alphaXml}</a:srgbClr></a:solidFill>`;
  }

  // Line
  let lineXml = '<a:ln><a:noFill/></a:ln>';
  if (opts.line && opts.line !== 'none') {
    const dashMap: Record<string, string> = { solid: 'solid', dash: 'dash', dot: 'sysDot', dashDot: 'sysDashDot' };
    const dash = opts.line.dash ? `<a:prstDash val="${dashMap[opts.line.dash] || 'solid'}"/>` : '<a:prstDash val="solid"/>';
    lineXml = `<a:ln w="${(opts.line.width ?? 1) * 12700}"><a:solidFill><a:srgbClr val="${opts.line.color}"/></a:solidFill>${dash}</a:ln>`;
  }

  // Shadow
  let shadowXml = '';
  if (shadow) {
    const blur = (shadow.blur ?? 4) * 12700;
    const dist = (shadow.dist ?? 2) * 12700;
    const angle = (shadow.angle ?? 270) * 60000;
    const alpha = (shadow.alpha ?? 25) * 1000;
    const color = shadow.color ?? '000000';
    shadowXml = `<a:effectLst><a:outerShdw blurRad="${blur}" dist="${dist}" dir="${angle}" algn="t" rotWithShape="0"><a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr></a:outerShdw></a:effectLst>`;
  }

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}<a:prstGeom prst="${prst}"><a:avLst>${avLst}</a:avLst></a:prstGeom>${fillXml}${lineXml}${shadowXml}</p:p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
}

export interface OoxmlTextBoxOpts {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize?: number;     // EMU (2400 = 24pt)
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontFace?: string;
  align?: 'l' | 'ctr' | 'r';
  valign?: 't' | 'ctr' | 'b';
  fill?: string | { type: 'gradient'; from: string; to: string; angle?: number };
  line?: string;
  radius?: number;
  margin?: number;       // EMU
  shadow?: { color?: string; blur?: number; dist?: number; alpha?: number };
  rotation?: number;
}

/**
 * 增强文本框 — 支持渐变背景、阴影、圆角、italic/underline
 */
export function ooxmlTextBox(opts: OoxmlTextBoxOpts): string {
  const { id, name, x, y, w, h, text, fontSize = 2400, color = '111827',
    bold, italic, underline, fontFace = 'Aptos', align = 'l', valign = 't',
    fill, line, radius, margin, shadow, rotation } = opts;
  const esc = (v: unknown) => xmlEscape(v);

  // Run properties
  const bAttr = bold ? ' b="1"' : '';
  const iAttr = italic ? ' i="1"' : '';
  const uAttr = underline ? ' u="sng"' : '';
  const rPr = `<a:rPr lang="zh-CN" sz="${fontSize}"${bAttr}${iAttr}${uAttr}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${fontFace}"/><a:ea typeface="${fontFace}"/></a:rPr>`;

  // Paragraphs
  const lines = String(text || '').split('\n').filter(Boolean);
  const paras = (lines.length ? lines : ['']).map(line =>
    `<a:p><a:pPr${align ? ` algn="${align}"` : ''}/><a:r>${rPr}<a:t>${esc(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${fontSize}"/></a:p>`
  ).join('');

  // Background fill
  let fillXml = '<a:noFill/>';
  if (fill) {
    if (typeof fill === 'string') {
      fillXml = `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`;
    } else {
      const angle = (fill.angle ?? 0) * 60000;
      fillXml = `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${fill.from}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${fill.to}"/></a:gs></a:gsLst><a:lin ang="${angle}" scaled="1"/></a:gradFill>`;
    }
  }

  // Line
  const lineXml = line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill><a:prstDash val="solid"/></a:ln>` : '<a:ln><a:noFill/></a:ln>';

  // Shadow
  let shadowXml = '';
  if (shadow) {
    const blur = (shadow.blur ?? 3) * 12700;
    const dist = (shadow.dist ?? 1) * 12700;
    const alpha = (shadow.alpha ?? 20) * 1000;
    shadowXml = `<a:effectLst><a:outerShdw blurRad="${blur}" dist="${dist}" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="${shadow.color ?? '000000'}"><a:alpha val="${alpha}"/></a:srgbClr></a:outerShdw></a:effectLst>`;
  }

  // Geometry & transform
  const prst = radius ? 'roundRect' : 'rect';
  const avLst = radius ? `<a:gd name="adj" fmla="val ${Math.min(Math.max(radius, 0), 100) * 1000}"/>` : '';
  const xfrm = `<a:xfrm${rotation ? ` rot="${rotation * 60000}"` : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
  const anchor = valign === 'ctr' ? 'ctr' : valign === 'b' ? 'b' : 't';
  const marginAttr = margin != null ? ` lIns="${margin}" tIns="${margin}" rIns="${margin}" bIns="${margin}"` : '';

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}<a:prstGeom prst="${prst}"><a:avLst>${avLst}</a:avLst></a:prstGeom>${fillXml}${lineXml}${shadowXml}</p:spPr><p:txBody><a:bodyPr wrap="square" anchor="${anchor}"${marginAttr}/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

export interface OoxmlImageOpts {
  id: number;
  name: string;
  relId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius?: number;
  shadow?: { color?: string; blur?: number; dist?: number; alpha?: number };
  border?: { color: string; width?: number };
}

/**
 * 增强图片 — 支持圆角裁剪、阴影、边框
 */
export function ooxmlImage(opts: OoxmlImageOpts): string {
  const { id, name, relId, x, y, w, h, radius, shadow, border } = opts;
  const esc = (v: unknown) => xmlEscape(v);

  // Clipping with roundRect if radius specified
  const prstGeom = radius ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(Math.max(radius, 0), 100) * 1000}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';

  // Border
  const lnXml = border
    ? `<a:ln w="${(border.width ?? 1) * 12700}"><a:solidFill><a:srgbClr val="${border.color}"/></a:solidFill><a:prstDash val="solid"/></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';

  // Shadow
  let effectXml = '';
  if (shadow) {
    const blur = (shadow.blur ?? 4) * 12700;
    const dist = (shadow.dist ?? 2) * 12700;
    const alpha = (shadow.alpha ?? 25) * 1000;
    effectXml = `<a:effectLst><a:outerShdw blurRad="${blur}" dist="${dist}" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="${shadow.color ?? '000000'}"><a:alpha val="${alpha}"/></a:srgbClr></a:outerShdw></a:effectLst>`;
  }

  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>${prstGeom}${lnXml}${effectXml}</p:spPr></p:pic>`;
}

export interface OoxmlLineOpts {
  id: number;
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  width?: number;        // inches
  dash?: 'solid' | 'dash' | 'dot' | 'dashDot';
  arrow?: 'none' | 'start' | 'end' | 'both';
}

/**
 * 线条/连接线 — 支持箭头、虚线
 */
export function ooxmlLine(opts: OoxmlLineOpts): string {
  const { id, name, x1, y1, x2, y2, color = '94A3B8', width = 0.02, dash = 'solid', arrow = 'none' } = opts;
  const esc = (v: unknown) => xmlEscape(v);
  const w = Math.abs(x2 - x1) || 1;
  const h = Math.abs(y2 - y1) || 1;
  const flipH = x2 < x1 ? ' flipH="1"' : '';
  const flipV = y2 < y1 ? ' flipV="1"' : '';
  const dashMap: Record<string, string> = { solid: 'solid', dash: 'dash', dot: 'sysDot', dashDot: 'sysDashDot' };

  // Arrowheads
  let headXml = '';
  if (arrow === 'start' || arrow === 'both') headXml += '<a:headEnd type="triangle" w="med" len="med"/>';
  if (arrow === 'end' || arrow === 'both') headXml += '<a:tailEnd type="triangle" w="med" len="med"/>';

  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${flipH}${flipV}><a:off x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}"/><a:ext cx="${w * 914400}" cy="${h * 914400}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${width * 12700}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:prstDash val="${dashMap[dash] || 'solid'}"/>${headXml}</a:ln></p:spPr></p:cxnSp>`;
}

// ── 复合组件 ─────────────────────────────────────────────────────────────────

/**
 * 渐变全屏背景
 */
export function gradientBackground(id: number, from: string, to: string, angle = 270): string {
  return ooxmlShape({
    id, name: 'gradient-bg', x: 0, y: 0,
    w: 13_333_500, h: 7_500_000,
    fill: { type: 'gradient', from, to, angle },
    line: 'none',
  });
}

/**
 * 卡片组件 — 圆角 + 阴影 + 可选顶部 accent 条
 */
export function cardShape(id: number, x: number, y: number, w: number, h: number, opts: {
  fill?: string;
  gradient?: { from: string; to: string; angle?: number };
  radius?: number;
  shadow?: boolean;
  accentTop?: string;
  accentLeft?: string;
} = {}): string {
  const { fill = 'FFFFFF', gradient, radius = 5, shadow = true, accentTop, accentLeft } = opts;
  const parts: string[] = [];

  // Card body
  parts.push(ooxmlShape({
    id, name: `card-${id}`, x, y, w, h,
    geometry: 'roundRect',
    fill: gradient ? { type: 'gradient', ...gradient } : { type: 'solid', color: fill },
    radius,
    shadow: shadow ? { blur: 6, dist: 3, alpha: 18 } : undefined,
  }));

  // Top accent strip
  if (accentTop) {
    parts.push(ooxmlShape({
      id: id + 1000, name: `card-accent-${id}`, x, y, w, h: 90_000,
      fill: { type: 'solid', color: accentTop },
      geometry: 'rect',
    }));
  }

  // Left accent bar
  if (accentLeft) {
    parts.push(ooxmlShape({
      id: id + 2000, name: `card-accent-l-${id}`, x, y, w: 90_000, h,
      fill: { type: 'solid', color: accentLeft },
      geometry: 'rect',
    }));
  }

  return parts.join('');
}

/**
 * 标签/徽章
 */
export function badgeShape(id: number, x: number, y: number, text: string, opts: {
  fill?: string;
  textColor?: string;
  fontSize?: number;
  radius?: number;
  w?: number;
  h?: number;
} = {}): string {
  const { fill = '0EA5A4', textColor = 'FFFFFF', fontSize = 850, radius = 30 } = opts;
  const lines = text.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length));
  const w = opts.w ?? Math.max(maxLen * fontSize * 0.6 + 200_000, 500_000);
  const h = opts.h ?? lines.length * fontSize * 1.4 + 100_000;
  return ooxmlTextBox({
    id, name: `badge-${id}`, x, y, w, h,
    text, fontSize, color: textColor, bold: true,
    fontFace: 'Aptos', align: 'ctr', valign: 'ctr',
    fill, radius, margin: 50_000,
  });
}

/**
 * 步骤编号圆圈（流程图用）
 */
export function stepCircle(id: number, x: number, y: number, stepNumber: number | string, opts: {
  size?: number;
  fill?: string;
  textColor?: string;
  fontSize?: number;
} = {}): string {
  const { size = 600_000, fill = '0EA5A4', textColor = 'FFFFFF', fontSize = 1800 } = opts;
  const parts: string[] = [];
  // Circle
  parts.push(ooxmlShape({
    id, name: `step-${id}`, x, y, w: size, h: size,
    geometry: 'ellipse',
    fill: { type: 'solid', color: fill },
    line: 'none',
  }));
  // Number text
  parts.push(ooxmlTextBox({
    id: id + 5000, name: `step-text-${id}`, x, y, w: size, h: size,
    text: String(stepNumber), fontSize, color: textColor, bold: true,
    fontFace: 'Aptos Display', align: 'ctr', valign: 'ctr',
  }));
  return parts.join('');
}

/**
 * 装饰性几何元素（半透明圆、三角、六边形等点缀背景）
 */
export function decorativeShape(id: number, x: number, y: number, w: number, h: number, opts: {
  geometry?: OoxmlGeometry;
  fill?: string;
  opacity?: number;
  rotation?: number;
} = {}): string {
  const { geometry = 'ellipse', fill = '0EA5A4', opacity = 8, rotation } = opts;
  return ooxmlShape({
    id, name: `deco-${id}`, x, y, w, h,
    geometry,
    fill: { type: 'solid', color: fill, opacity },
    line: 'none',
    rotation,
  });
}

/**
 * 进度条/指标条
 */
export function progressBar(id: number, x: number, y: number, w: number, h: number, opts: {
  progress?: number;      // 0-100
  bgColor?: string;
  fillColor?: string;
  radius?: number;
} = {}): string {
  const { progress = 50, bgColor = 'E5E7EB', fillColor = '0EA5A4', radius = 40 } = opts;
  const fillW = Math.round(w * Math.min(Math.max(progress, 0), 100) / 100);
  const parts: string[] = [];
  // Background bar
  parts.push(ooxmlShape({
    id, name: `prog-bg-${id}`, x, y, w, h,
    geometry: 'roundRect', radius,
    fill: { type: 'solid', color: bgColor },
    line: 'none',
  }));
  // Fill bar
  if (fillW > 0) {
    parts.push(ooxmlShape({
      id: id + 3000, name: `prog-fill-${id}`, x, y, w: fillW, h,
      geometry: 'roundRect', radius,
      fill: { type: 'solid', color: fillColor },
      line: 'none',
    }));
  }
  return parts.join('');
}

/**
 * 数字高亮卡片（指标页用）
 */
export function metricCard(id: number, x: number, y: number, w: number, h: number, opts: {
  value?: string;
  label?: string;
  detail?: string;
  theme?: OfficeTheme;
  accentColor?: string;
} = {}): string {
  const { value = '', label = '', detail, theme, accentColor } = opts;
  if (!theme) return '';
  const parts: string[] = [];
  // Card background
  parts.push(cardShape(id, x, y, w, h, {
    gradient: { from: theme.cardFill, to: theme.surface },
    shadow: true, radius: 5,
  }));
  // Accent top bar
  const accent = accentColor ?? theme.accent;
  parts.push(ooxmlShape({
    id: id + 100, name: `metric-accent-${id}`, x, y, w, h: 90_000,
    fill: { type: 'solid', color: accent },
    geometry: 'rect',
  }));
  // Value
  parts.push(ooxmlTextBox({
    id: id + 200, name: `metric-val-${id}`,
    x: x + 180_000, y: y + 250_000, w: w - 360_000, h: 500_000,
    text: value, fontSize: 3200, color: theme.primary, bold: true,
    fontFace: theme.fontHeading, align: 'l', valign: 't',
  }));
  // Label
  parts.push(ooxmlTextBox({
    id: id + 300, name: `metric-label-${id}`,
    x: x + 180_000, y: y + 800_000, w: w - 360_000, h: 280_000,
    text: label, fontSize: 1050, color: theme.muted, bold: true,
    fontFace: theme.fontBody, align: 'l', valign: 't',
  }));
  // Detail
  if (detail) {
    parts.push(ooxmlTextBox({
      id: id + 400, name: `metric-detail-${id}`,
      x: x + 180_000, y: y + 1_150_000, w: w - 360_000, h: 350_000,
      text: detail, fontSize: 900, color: theme.secondary,
      fontFace: theme.fontBody, align: 'l', valign: 't',
    }));
  }
  return parts.join('');
}

/**
 * Generate a complete ppt/theme/theme1.xml string for PPTX packages.
 * Without this file Office falls back to its built-in Calibri/Office Theme
 * and ignores custom colours defined in slides.
 */
export function buildThemeXml(theme: OfficeTheme): string {
  const { primary, background, accent, accent2, secondary, muted, line } = theme;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="LingXiao Theme">
  <a:themeElements>
    <a:clrScheme name="LingXiao">
      <a:dk1><a:srgbClr val="${primary}"/></a:dk1>
      <a:lt1><a:srgbClr val="${background}"/></a:lt1>
      <a:dk2><a:srgbClr val="${secondary}"/></a:dk2>
      <a:lt2><a:srgbClr val="FFFFFF"/></a:lt2>
      <a:accent1><a:srgbClr val="${accent}"/></a:accent1>
      <a:accent2><a:srgbClr val="${accent2}"/></a:accent2>
      <a:accent3><a:srgbClr val="${muted}"/></a:accent3>
      <a:accent4><a:srgbClr val="${line}"/></a:accent4>
      <a:accent5><a:srgbClr val="${accent}"/></a:accent5>
      <a:accent6><a:srgbClr val="${accent2}"/></a:accent6>
      <a:hlink><a:srgbClr val="${accent}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${accent2}"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="LingXiao">
      <a:majorFont>
        <a:latin typeface="Aptos Display" panose="020F0302020204030204"/>
        <a:ea typeface="Microsoft YaHei"/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Aptos" panose="020F0502020204030204"/>
        <a:ea typeface="Microsoft YaHei"/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="LingXiao">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs>
            <a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="0"/>
        </a:gradFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="0"/>
        </a:gradFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle>
          <a:effectLst>
            <a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">
              <a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr>
            </a:outerShdw>
          </a:effectLst>
        </a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:lumMod val="102000"/><a:satMod val="120000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="0"/>
        </a:gradFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`.replace(/\n\s*/g, '');
}

/**
 * Inject theme1.xml into an existing PPTX ZIP buffer and register it
 * in the presentation relationships and content types.
 */
export async function injectPptxTheme(buf: Buffer, theme: OfficeTheme): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);

  // Add theme file
  zip.file('ppt/theme/theme1.xml', buildThemeXml(theme));

  // Update ppt/_rels/presentation.xml.rels
  const relsPath = 'ppt/_rels/presentation.xml.rels';
  const relsFile = zip.file(relsPath);
  const relsXml = relsFile ? await relsFile.async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  const themeRel = `<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`;
  const updatedRels = relsXml.includes('theme/theme1.xml')
    ? relsXml
    : relsXml.replace('</Relationships>', `${themeRel}</Relationships>`);
  zip.file(relsPath, updatedRels);

  // Update [Content_Types].xml
  const ctPath = '[Content_Types].xml';
  const ctFile = zip.file(ctPath);
  if (ctFile) {
    let ctXml = await ctFile.async('string');
    const themeOverride = `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`;
    if (!ctXml.includes('theme/theme1.xml')) {
      ctXml = ctXml.replace('</Types>', `${themeOverride}</Types>`);
    }
    // Remove phantom slideMaster declarations for files that do not exist.
    const actualMasters = new Set<string>();
    zip.folder('ppt/slideMasters')?.forEach((path: string) => {
      if (path.endsWith('.xml') && !path.includes('_rels')) actualMasters.add(path);
    });
    ctXml = ctXml.replace(
      /<Override PartName="\/ppt\/slideMasters\/slideMaster(\d+)\.xml"[^>]*\/>/g,
      (match: string, num: string) => actualMasters.has(`slideMaster${num}.xml`) ? match : '',
    );
    zip.file(ctPath, ctXml);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
