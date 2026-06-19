"""
gen_lingxiao_glyph.py — 生成「凌霄」块字字形，多字体变体。

每套变体用一种真实 CJK 字体渲染成 half-block 子像素位图（█ 全/▀ 上/▄ 下/空）。
默认（第 0 套）= 宋骨：明朝体三角顿笔、横细竖粗，密笔字也结构清晰可辨。
其余变体提供不同笔意（黑体方正、楷体手写笔锋），运行时随机择一。

确定性：纯字体光栅化，无随机，重复运行结果稳定，不要手改产物。
"""
from PIL import Image, ImageDraw, ImageFont
import os

# 变体定义：(slug, 中文名, 描述, 字体路径, face index, 字号 px, 二值阈值, 描边宽度)
# 半块分辨率下笔画一糊就连成墨团：一律不描边（stroke=0），并提阈值把笔画收细，
# 提字号换取更多子像素去刻画「凌霄」这种密笔字，保证可辨认。
# 默认（第 0 套）= 宋骨：明朝体三角顿笔、横细竖粗，结构清晰又有锋棱。
VARIANTS = [
    (
        'song', '宋骨',
        'Noto Serif CJK SC Bold · 明朝体三角顿笔，横细竖粗，锋棱锐利',
        '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 2, 34, 140, 0,
    ),
    (
        'hei', '黑石',
        'Noto Sans CJK SC Bold · 方正厚重，端凝如碑',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 2, 34, 140, 0,
    ),
    (
        'kai', '楷锋',
        '文鼎楷体 · 手写笔锋，撇捺出锋顿挫，剑气凌冽',
        '/usr/share/fonts/truetype/arphic-gkai00mp/gkai00mp.ttf', 0, 40, 128, 0,
    ),
]

TEXT = '凌霄'


def render(fp, idx, px, threshold, stroke):
    """渲染一套字形，返回 (lines, width_cells, height_cells, center_x, center_y)。"""
    font = ImageFont.truetype(fp, px, index=idx)
    tmp = Image.new('L', (10, 10))
    d = ImageDraw.Draw(tmp)
    bbox = d.textbbox((0, 0), TEXT, font=font, stroke_width=stroke)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    img = Image.new('L', (w + 4, h + 4), 0)
    d = ImageDraw.Draw(img)
    d.text((2 - bbox[0], 2 - bbox[1]), TEXT, fill=255, font=font,
           stroke_width=stroke, stroke_fill=255)
    W, H = img.size
    if H % 2 == 1:
        H += 1
        img = img.crop((0, 0, W, H))
    g = [[1 if img.getpixel((x, y)) >= threshold else 0 for x in range(W)] for y in range(H)]
    lines = []
    for ry in range(0, H, 2):
        row = []
        for x in range(W):
            t = g[ry][x]
            b = g[ry + 1][x] if ry + 1 < H else 0
            row.append('█' if t and b else '▀' if t else '▄' if b else ' ')
        lines.append(''.join(row).rstrip())
    while lines and lines[0].strip() == '':
        lines.pop(0)
    while lines and lines[-1].strip() == '':
        lines.pop()
    maxw = max(len(l) for l in lines)
    lines = [l.ljust(maxw) for l in lines]
    # 几何中心（x:cells, y:subpixel rows）
    lit = [(x, y) for y, row in enumerate(lines) for x, ch in enumerate(row)
           if ch in ('█', '▀', '▄')]
    cx = sum(c[0] for c in lit) / len(lit) + 0.5
    cy = (sum(c[1] for c in lit) / len(lit)) * 2 + 1
    return lines, maxw, len(lines), cx, cy, len(lit)


esc = lambda s: s.replace('\\', '\\\\').replace("'", "\\'")

variants_out = []
report = []
for slug, name, desc, fp, idx, px, th, stroke in VARIANTS:
    if not os.path.exists(fp):
        report.append('SKIP %s (font missing: %s)' % (slug, fp))
        continue
    lines, w, h, cx, cy, lit = render(fp, idx, px, th, stroke)
    variants_out.append((slug, name, desc, lines, w, h, cx, cy))
    report.append('%-6s %-8s %dx%d cells, lit=%d, center=(%.2f,%.2f)'
                  % (slug, name, w, h, lit, cx, cy))

if not variants_out:
    raise SystemExit('no glyph variants generated — all fonts missing')

b = []
b.append('/**')
b.append(' * lingxiaoGlyph — 「凌霄」块字字形，多字体变体。')
b.append(' * 由 scripts/gen_lingxiao_glyph.py 光栅化真实字体生成（确定性，勿手改）。')
b.append(' * Half-block 子像素编码：█ 全 / ▀ 上 / ▄ 下 / 空格 空。每 cell 纵跨 2 子像素。')
b.append(' * 变体 0 = 宋骨（默认），明朝体三角顿笔、横细竖粗，密笔字也结构清晰。')
b.append(' */')
b.append('')
b.append('/** 单套字形变体：含位图与几何信息，供光场按所选字体居中。 */')
b.append('export interface GlyphVariant {')
b.append('  /** 稳定标识 */')
b.append('  readonly slug: string;')
b.append('  /** 中文名（剑域笔意） */')
b.append('  readonly name: string;')
b.append('  /** 描述 */')
b.append('  readonly desc: string;')
b.append('  /** 字形行（每行长度 = width） */')
b.append('  readonly rows: readonly string[];')
b.append('  /** 宽（cells） */')
b.append('  readonly width: number;')
b.append('  /** 高（cells，每 cell = 2 子像素行） */')
b.append('  readonly height: number;')
b.append('  /** 亮 cell 几何中心（x:cells, y:子像素行） */')
b.append('  readonly center: { readonly x: number; readonly y: number };')
b.append('}')
b.append('')

# 各变体常量
slug_consts = []
for i, (slug, name, desc, lines, w, h, cx, cy) in enumerate(variants_out):
    const = 'GLYPH_%s' % slug.upper()
    slug_consts.append(const)
    b.append('/** 变体「%s」— %s */' % (name, desc))
    b.append('const %s: GlyphVariant = {' % const)
    b.append("  slug: '%s'," % esc(slug))
    b.append("  name: '%s'," % esc(name))
    b.append("  desc: '%s'," % esc(desc))
    b.append('  rows: [')
    for l in lines:
        b.append("    '%s'," % esc(l))
    b.append('  ],')
    b.append('  width: %d,' % w)
    b.append('  height: %d,' % h)
    b.append('  center: { x: %.4f, y: %.4f },' % (cx, cy))
    b.append('};')
    b.append('')

b.append('/** 全部字形变体，运行时随机择一。索引 0 为默认（宋骨）。 */')
b.append('export const GLYPH_VARIANTS: readonly GlyphVariant[] = [%s];' % ', '.join(slug_consts))
b.append('')
b.append('/** 默认变体（宋骨）。 */')
b.append('export const DEFAULT_GLYPH: GlyphVariant = GLYPH_VARIANTS[0];')
b.append('')
b.append('/** 按 [0,1) 种子确定性选一套变体。 */')
b.append('export function pickGlyph(seed: number): GlyphVariant {')
b.append('  const n = GLYPH_VARIANTS.length;')
b.append('  const i = Math.floor(seed * n) % n;')
b.append('  return GLYPH_VARIANTS[i < 0 ? 0 : i];')
b.append('}')
b.append('')
b.append('// ── 向后兼容别名：旧代码/测试引用默认变体的扁平导出 ──')
b.append('/** 默认变体字形行。 */')
b.append('export const LINGXIAO_GLYPH: readonly string[] = DEFAULT_GLYPH.rows;')
b.append('')
b.append('/** 默认变体宽（cells）。 */')
b.append('export const GLYPH_WIDTH = DEFAULT_GLYPH.width;')
b.append('')
b.append('/** 默认变体高（cells，每 cell = 2 子像素行）。 */')
b.append('export const GLYPH_HEIGHT = DEFAULT_GLYPH.height;')
b.append('')
b.append('/** 默认变体几何中心（子像素坐标）。 */')
b.append('export const GLYPH_CENTER = DEFAULT_GLYPH.center;')
b.append('')
b.append('/** cell 含任意块像素即为「亮」。 */')
b.append('export function isLitCell(ch: string): boolean {')
b.append("  return ch === '\\u2588' || ch === '\\u2580' || ch === '\\u2584';")
b.append('}')
b.append('')
b.append('/** cell 上子像素点亮。 */')
b.append('export function topOn(ch: string): boolean {')
b.append("  return ch === '\\u2588' || ch === '\\u2580';")
b.append('}')
b.append('')
b.append('/** cell 下子像素点亮。 */')
b.append('export function bottomOn(ch: string): boolean {')
b.append("  return ch === '\\u2588' || ch === '\\u2584';")
b.append('}')
b.append('')

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        '..', 'src', 'tui', 'animation', 'glyph', 'lingxiaoGlyph.ts')
out_path = os.path.normpath(out_path)
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(b) + '\n')
print('WROTE', out_path)
for line in report:
    print(' ', line)
