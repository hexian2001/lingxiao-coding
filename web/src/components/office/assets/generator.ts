/**
 * 修仙赛博角色生成器 — 32x48 像素修炼者
 * 角色穿道袍 + 灵气光环 + 五行配色
 */
import { Texture, Rectangle } from 'pixi.js';
import { getRoleColorKey } from './roleAffinity';

export interface CharacterColors {
  robe: string;    // 道袍主色
  robeDark: string; // 道袍暗部
  trim: string;    // 镶边/腰带
  hair: string;
  skin: string;
  glow: string;    // 灵气光
}

// 五行 + 灵 = 6 种修炼者配色
export const ROLE_COLORS: Record<string, CharacterColors> = {
  // 水行（research/explore）— 蓝袍碧水
  research: { robe:'#2266aa', robeDark:'#1a4d88', trim:'#88ddff', hair:'#224466', skin:'#ffe8d0', glow:'#44aaff' },
  explore: { robe:'#2277aa', robeDark:'#1a5588', trim:'#88ddff', hair:'#334455', skin:'#ffe8d0', glow:'#44ccff' },
  // 木行（coding/implement）— 绿袍翡翠
  coding: { robe:'#228844', robeDark:'#1a6633', trim:'#88ffaa', hair:'#334433', skin:'#ffe8d0', glow:'#44ff88' },
  implement: { robe:'#226633', robeDark:'#1a4a22', trim:'#88ffaa', hair:'#333322', skin:'#ffe8d0', glow:'#44ff66' },
  // 金行（plan/lead）— 金袍太虚
  plan: { robe:'#aa8822', robeDark:'#886611', trim:'#ffdd88', hair:'#886611', skin:'#ffe8d0', glow:'#ffcc44' },
  leader: { robe:'#cc8800', robeDark:'#996600', trim:'#ffdd00', hair:'#ffdd00', skin:'#ffe8d0', glow:'#ffff44' },
  // 火行（review/evaluate）— 红袍朱砂
  review: { robe:'#cc4444', robeDark:'#993333', trim:'#ff8888', hair:'#663333', skin:'#ffe8d0', glow:'#ff6644' },
  // 土行（test/qa）— 紫袍幽冥
  test: { robe:'#8844aa', robeDark:'#663388', trim:'#cc88ff', hair:'#442244', skin:'#ffe8d0', glow:'#aa44ff' },
  // 灵行（default）— 白袍灵修
  default: { robe:'#4477aa', robeDark:'#335588', trim:'#88bbee', hair:'#444444', skin:'#ffe8d0', glow:'#88ccff' },
};

const FW = 32, FH = 48;

function drawFrame(ctx: CanvasRenderingContext2D, ox: number, oy: number, col: CharacterColors, frame: number) {
  const px = (x: number, y: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1); };
  const rect = (x: number, y: number, w: number, h: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, w, h); };
  const bob = (frame === 1 || frame === 5) ? 1 : 0;
  const wf = frame === 2 ? 2 : frame === 3 ? -2 : 0;

  // === 灵气光环（头顶上方） ===
  rect(11, -2 + bob, 10, 1, col.glow); rect(12, -3 + bob, 8, 1, col.glow);
  rect(13, -4 + bob, 6, 1, col.glow);
  // === 头发 ===
  rect(10, 0 + bob, 12, 2, col.hair); rect(8, 2 + bob, 16, 2, col.hair);
  rect(6, 4 + bob, 20, 2, col.hair);
  // === 脸 ===
  rect(10, 6 + bob, 12, 7, col.skin);
  // 眼睛
  px(13, 7 + bob, '#111'); px(18, 7 + bob, '#111');
  px(14, 7 + bob, '#fff'); px(19, 7 + bob, '#fff');
  // 眉毛
  rect(12, 6 + bob, 3, 1, col.hair); rect(17, 6 + bob, 3, 1, col.hair);
  // 嘴
  px(15, 10 + bob, '#c88'); px(16, 10 + bob, '#c88');

  // === 脖子 + 道袍领口 ===
  rect(14, 13 + bob, 4, 1, col.skin);
  rect(11, 14 + bob, 10, 2, col.trim); // 镶边领口

  // === 道袍（宽袍大袖）===
  // 上半身
  rect(6, 16 + bob, 20, 5, col.robe);
  rect(7, 17 + bob, 18, 3, col.robeDark); // 暗部纹理
  // 左肩 + 左袖
  rect(3, 16 + bob, 4, 8, col.robe);
  rect(4, 17 + bob, 3, 6, col.robeDark);
  // 右肩 + 右袖
  rect(25, 16 + bob, 4, 8, col.robe);
  rect(26, 17 + bob, 3, 6, col.robeDark);
  // 腰带
  rect(8, 21 + bob, 16, 1, col.trim);
  // 下半身袍
  rect(7, 22 + bob, 18, 10, col.robe);
  rect(8, 23 + bob, 16, 6, col.robeDark);
  // 袍边
  rect(7, 31 + bob, 18, 1, col.trim);

  // Work 姿态：手臂前伸结印
  if (frame === 4 || frame === 5) {
    rect(16, 18 + bob, 10, 3, col.robe); // 右臂前伸
    px(26, 19 + bob, col.skin); // 手（结印）
    px(27, 19 + bob, col.skin);
  }

  // === 腿（袍内可见）===
  rect(9, 32 + bob, 4, 7, col.robeDark);
  rect(18, 32 + bob, 4, 7, col.robeDark);
  if (wf !== 0) { rect(9 + wf, 32 + bob, 4, 7, col.robeDark); rect(18 - wf, 32 + bob, 4, 7, col.robeDark); }
  // === 靴 ===
  rect(9, 39 + bob, 5, 3, '#222'); rect(18, 39 + bob, 5, 3, '#222');
  if (wf !== 0) { rect(9 + wf, 39 + bob, 5, 3, '#222'); rect(18 - wf, 38 + bob, 5, 3, '#222'); }

  // === 灵气粒子（道袍周围漂浮）===
  rect(3, 24 + bob, 1, 1, col.glow); rect(28, 22 + bob, 1, 1, col.glow);
  rect(4, 20 + bob, 1, 1, col.glow); rect(27, 19 + bob, 1, 1, col.glow);
}

export function generateCharacterSheet(colors: CharacterColors): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = FW * 6; canvas.height = FH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < 6; i++) drawFrame(ctx, i * FW, 0, colors, i);
  return canvas;
}

export function getColorsForRole(role: string): CharacterColors {
  return ROLE_COLORS[getRoleColorKey(role)] ?? ROLE_COLORS.default;
}

export function createTexturesFromSheet(canvas: HTMLCanvasElement): Texture[] {
  const bt = Texture.from({ resource: canvas, scaleMode: 'nearest' });
  const bs = bt.source;
  return Array.from({ length: 6 }, (_, i) => new Texture({ source: bs, frame: new Rectangle(i * FW, 0, FW, FH) }));
}
