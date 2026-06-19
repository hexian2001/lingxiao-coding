/**
 * themeColors — 像素艺术赛博朋克配色 (Star-Office-UI 参考)
 * 深靛基底 · 七星辉光 · 霓虹法阵 · 像素纹理
 */
export interface OfficeThemeColors {
  background: number; wall: number; wallHighlight: number; wallShadow: number;
  floor: number; floorGrid: number; floorDither: number;
  carpet: number; carpetGrid: number; carpetDither: number;
  door: number; doorHandle: number;
  lobby: number; coding: number; planning: number; tooling: number;
  review: number; observability: number; corridor: number;
  areaLabel: number; areaLabelBg: number;
  spiritVein: number;
  glowWater: number; glowWood: number; glowMetal: number;
  glowFire: number; glowEarth: number; glowSpirit: number;
  gold: number; green: number; red: number; amber: number;
}

export const OFFICE_THEMES: Record<'dark' | 'light', OfficeThemeColors> = {
  dark: {
    // === 结构层（基底 #1a1a2e 深靛蓝）===
    background: 0x1a1a2e,       // 深靛蓝基底（Star-Office-UI 标准）
    wall: 0x1e2448,            // 墙壁（靛蓝偏深）
    wallHighlight: 0x2a3060,   // 壁纹高光
    wallShadow: 0x12162a,      // 壁纹阴影
    floor: 0x1c2040,           // 地板（比背景稍亮）
    floorGrid: 0x222850,       // 砖缝（明显可见）
    floorDither: 0x181c38,     // 抖动暗点
    carpet: 0x1e2444,          // 地毯底色
    carpetGrid: 0x283058,      // 毯格线
    carpetDither: 0x1a2040,    // 地毯抖动
    door: 0x4a3828,            // 门（暖棕木色）
    doorHandle: 0xffd700,      // 门把手（金色）
    // === 五行分区底色（有明显色相区分）===
    lobby: 0x1a3828,           // 木 — 深绿（更亮）
    coding: 0x1a2850,          // 水 — 深蓝（更饱和）
    planning: 0x382018,        // 金 — 深棕（更暖）
    tooling: 0x281a38,         // 土 — 深紫（更饱和）
    review: 0x381820,          // 火 — 深红（更饱和）
    observability: 0x183038,   // 灵 — 深青
    corridor: 0x1c2244,        // 回廊（比背景稍亮）
    // === 标签 ===
    areaLabel: 0xffd700,       // 区域名（金色）
    areaLabelBg: 0x0a0a18,     // 标签底色（深色半透明）
    // === 七星辉光（霓虹色相 + 高饱和度）===
    spiritVein: 0x44ffdd,      // 灵脉（灵青）
    glowWater: 0x66ccff,       // 水 · 天蓝
    glowWood: 0x55ff99,        // 木 · 翠绿
    glowMetal: 0xffcc44,       // 金 · 琥珀
    glowFire: 0xff5544,        // 火 · 珊瑚
    glowEarth: 0xbb55ff,       // 土 · 紫罗兰
    glowSpirit: 0x44ffdd,      // 灵 · 青绿
    // === 功能色 ===
    gold: 0xffd700,            // 金色强调
    green: 0x22c55e,           // 成功绿
    red: 0xe94560,             // 错误红
    amber: 0xf59e0b,           // 警告琥珀
  },
  light: {
    background: 0xf4f2ed,
    wall: 0xd4cec4, wallHighlight: 0xe4ded4, wallShadow: 0xc4beb4,
    floor: 0xedeae3, floorGrid: 0xe0dcd4, floorDither: 0xe8e5de,
    carpet: 0xe6e0d6, carpetGrid: 0xdcd6cc, carpetDither: 0xe2dcd2,
    door: 0xb0a898, doorHandle: 0x8b7355,
    lobby: 0xe2e8dc, coding: 0xe0e4f0, planning: 0xece4d8,
    tooling: 0xe6e2e8, review: 0xeadddd, observability: 0xdde4e8,
    corridor: 0xe6e3dc,
    areaLabel: 0x00664a, areaLabelBg: 0xffffff,
    spiritVein: 0x007055,
    glowWater: 0x1a5e8a, glowWood: 0x007040, glowMetal: 0xa06800,
    glowFire: 0xa02830, glowEarth: 0x5a2a90, glowSpirit: 0x007055,
    gold: 0x8b6914, green: 0x1a7a3a, red: 0xc0392b, amber: 0xcc8800,
  },
};
