export type OfficeTemplatePresetId =
  | 'lingxiao_board'
  | 'enterprise_report'
  | 'product_strategy'
  | 'ink_wash'
  | 'vermilion'
  | 'cyan_blade'
  | 'gold_leaf'
  | 'editorial'
  | 'dark_luxury'
  | 'papyrus';

export type OfficeTemplatePalette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  line: string;
  inverseText: string;
};

export type OfficeThemeFonts = {
  heading: string;
  body: string;
  mono?: string;
};

export type OfficeSlideDefaults = {
  background: string;
  titleSize: number;
  bodySize: number;
  footerText: string;
  pageNumber: boolean;
};

export type OfficePageDefaults = {
  titleSize: number;
  heading1Size: number;
  heading2Size: number;
  bodySize: number;
  headerText: string;
  footerText: string;
};

export type OfficeCoverSpec = {
  kicker: string;
  titleAlign: 'left' | 'center';
  background: string;
  accentBand: string;
};

export type OfficeContentSpec = {
  titleTop: number;
  bodyTop: number;
  rule: 'top' | 'left' | 'none';
};

export type OfficeTemplatePreset = {
  id: OfficeTemplatePresetId;
  name: string;
  description: string;
  /** 映射到 HTML 主题系统（themes.ts）的 themeId，桥接原生 Office 与 HTML 产物。 */
  htmlThemeId: string;
  themeFonts: OfficeThemeFonts;
  palette: OfficeTemplatePalette;
  slideDefaults: OfficeSlideDefaults;
  pageDefaults: OfficePageDefaults;
  cover: OfficeCoverSpec;
  title: {
    eyebrow: string;
    maxLineChars: number;
  };
  content: OfficeContentSpec;
  footer: {
    left: string;
    right: string;
    showPageNumber: boolean;
  };
};

/**
 * CJK 优先字体栈常量（与 themes.ts 对齐）。
 * 原生 PPTX/DOCX 中字体名需用 Office 可识别的名称；
 * 当系统安装了思源字体时使用思源，否则回落到系统宋体/雅黑。
 */
const CJK_SERIF_HEADING = 'Source Han Serif SC, Noto Serif SC, Songti SC, STSong, SimSun, Microsoft YaHei, Georgia, serif';
const CJK_SERIF_BODY = 'Source Han Serif SC, Noto Serif SC, Songti SC, STSong, SimSun, Microsoft YaHei, Lora, serif';
const CJK_SANS_HEADING = 'Source Han Sans SC, Noto Sans SC, PingFang SC, Microsoft YaHei, Inter, Helvetica Neue, sans-serif';
const CJK_SANS_BODY = 'Source Han Sans SC, Noto Sans SC, PingFang SC, Microsoft YaHei, Inter, Helvetica Neue, sans-serif';
const MONO_FONT = 'JetBrains Mono, Fira Code, Cascadia Mono, Menlo, Consolas, monospace';

const BUILT_IN_TEMPLATES: Record<OfficeTemplatePresetId, OfficeTemplatePreset> = {
  // ── 原有 3 套：企业场景 ──
  lingxiao_board: {
    id: 'lingxiao_board',
    name: 'LingXiao Board',
    description: '董事会/经营会汇报模板，克制深色强调、白底信息密度和稳定页脚。',
    htmlThemeId: 'ink-wash',
    themeFonts: {
      heading: 'Aptos Display',
      body: 'Aptos',
      mono: 'Cascadia Mono',
    },
    palette: {
      bg: 'F8FAFC',
      surface: 'FFFFFF',
      text: '111827',
      muted: '667085',
      accent: '334155',
      accent2: 'A8B3C4',
      line: 'D5DCE8',
      inverseText: 'F8FAFC',
    },
    slideDefaults: {
      background: 'F8FAFC',
      titleSize: 24,
      bodySize: 15,
      footerText: 'LingXiao Office',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 48,
      heading1Size: 30,
      heading2Size: 26,
      bodySize: 22,
      headerText: 'LingXiao Office',
      footerText: 'Confidential',
    },
    cover: {
      kicker: 'BOARD BRIEFING',
      titleAlign: 'left',
      background: 'F8FAFC',
      accentBand: '334155',
    },
    title: {
      eyebrow: 'Decision Material',
      maxLineChars: 48,
    },
    content: {
      titleTop: 0.58,
      bodyTop: 1.68,
      rule: 'top',
    },
    footer: {
      left: 'LingXiao Office',
      right: 'Board material',
      showPageNumber: true,
    },
  },
  enterprise_report: {
    id: 'enterprise_report',
    name: 'Enterprise Report',
    description: '企业报告/方案书模板，低饱和蓝灰体系、清晰页眉页脚和报告型标题样式。',
    htmlThemeId: 'papyrus',
    themeFonts: {
      heading: 'Arial',
      body: 'Arial',
      mono: 'Cascadia Mono',
    },
    palette: {
      bg: 'FBFCFE',
      surface: 'FFFFFF',
      text: '172033',
      muted: '5F6C7B',
      accent: '1F4E79',
      accent2: 'B7C7D9',
      line: 'D9E1EA',
      inverseText: 'FFFFFF',
    },
    slideDefaults: {
      background: 'FBFCFE',
      titleSize: 23,
      bodySize: 14,
      footerText: 'Enterprise Report',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 46,
      heading1Size: 29,
      heading2Size: 25,
      bodySize: 22,
      headerText: 'Enterprise Report',
      footerText: 'Internal Use Only',
    },
    cover: {
      kicker: 'ENTERPRISE REPORT',
      titleAlign: 'center',
      background: 'FBFCFE',
      accentBand: '1F4E79',
    },
    title: {
      eyebrow: 'Executive Summary',
      maxLineChars: 52,
    },
    content: {
      titleTop: 0.56,
      bodyTop: 1.62,
      rule: 'left',
    },
    footer: {
      left: 'Enterprise Report',
      right: 'Internal use only',
      showPageNumber: true,
    },
  },
  product_strategy: {
    id: 'product_strategy',
    name: 'Product Strategy',
    description: '产品战略/路线图模板，墨色正文配低饱和靛蓝和琥珀点缀，适合策略叙事。',
    htmlThemeId: 'cyan-blade',
    themeFonts: {
      heading: 'Aptos Display',
      body: 'Aptos',
      mono: 'Cascadia Mono',
    },
    palette: {
      bg: 'FAFAFB',
      surface: 'FFFFFF',
      text: '18181B',
      muted: '6B7280',
      accent: '4F46E5',
      accent2: 'F3B63F',
      line: 'E4E4E7',
      inverseText: 'FFFFFF',
    },
    slideDefaults: {
      background: 'FAFAFB',
      titleSize: 25,
      bodySize: 15,
      footerText: 'Product Strategy',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 48,
      heading1Size: 30,
      heading2Size: 25,
      bodySize: 22,
      headerText: 'Product Strategy',
      footerText: 'Strategy Draft',
    },
    cover: {
      kicker: 'PRODUCT STRATEGY',
      titleAlign: 'left',
      background: 'FAFAFB',
      accentBand: '4F46E5',
    },
    title: {
      eyebrow: 'Strategy Narrative',
      maxLineChars: 46,
    },
    content: {
      titleTop: 0.62,
      bodyTop: 1.74,
      rule: 'top',
    },
    footer: {
      left: 'Product Strategy',
      right: 'Working draft',
      showPageNumber: true,
    },
  },

  // ── 新增 7 套：凌霄中式审美下沉 + 编辑/暗色高级 ──

  /** 墨韵：松烟暖炭为骨、宣纸暖白为肉、剑金为锋的极简水墨。 */
  ink_wash: {
    id: 'ink_wash',
    name: '墨韵',
    description: '极简水墨风，松烟暖炭为骨、宣纸暖白为肉、剑金为锋。适合内部分享/文化叙事/设计提案。',
    htmlThemeId: 'ink-wash',
    themeFonts: {
      heading: CJK_SERIF_HEADING,
      body: CJK_SERIF_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: 'F5F2EA',
      surface: 'EFEADF',
      text: '1F1B16',
      muted: '6B6258',
      accent: '8A6A2F',
      accent2: 'C9A86A',
      line: 'D9D2C4',
      inverseText: 'F5F2EA',
    },
    slideDefaults: {
      background: 'F5F2EA',
      titleSize: 26,
      bodySize: 15,
      footerText: 'LingXiao 墨韵',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 48,
      heading1Size: 30,
      heading2Size: 26,
      bodySize: 22,
      headerText: 'LingXiao 墨韵',
      footerText: '墨韵出品',
    },
    cover: {
      kicker: '墨韵 · INK WASH',
      titleAlign: 'left',
      background: 'F5F2EA',
      accentBand: '8A6A2F',
    },
    title: {
      eyebrow: '极简水墨',
      maxLineChars: 44,
    },
    content: {
      titleTop: 0.58,
      bodyTop: 1.68,
      rule: 'left',
    },
    footer: {
      left: 'LingXiao 墨韵',
      right: '墨韵出品',
      showPageNumber: true,
    },
  },

  /** 朱砂典藏：朱砂印为魂、墨底金线，典藏/年报/总结气场。 */
  vermilion: {
    id: 'vermilion',
    name: '朱砂',
    description: '朱砂典藏风，朱砂印为魂、墨底金线。适合年报/总结/典藏/品牌叙事。',
    htmlThemeId: 'vermilion',
    themeFonts: {
      heading: CJK_SERIF_HEADING,
      body: CJK_SERIF_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: '0E0C0A',
      surface: '171310',
      text: 'EFE6D6',
      muted: 'A89A82',
      accent: 'E5484D',
      accent2: 'D4B36A',
      line: '3A322A',
      inverseText: '0E0C0A',
    },
    slideDefaults: {
      background: '0E0C0A',
      titleSize: 26,
      bodySize: 15,
      footerText: 'LingXiao 朱砂',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 48,
      heading1Size: 30,
      heading2Size: 26,
      bodySize: 22,
      headerText: 'LingXiao 朱砂',
      footerText: '典藏出品',
    },
    cover: {
      kicker: '朱砂 · VERMILION',
      titleAlign: 'center',
      background: '0E0C0A',
      accentBand: 'E5484D',
    },
    title: {
      eyebrow: '典藏叙事',
      maxLineChars: 44,
    },
    content: {
      titleTop: 0.60,
      bodyTop: 1.70,
      rule: 'top',
    },
    footer: {
      left: 'LingXiao 朱砂',
      right: '典藏出品',
      showPageNumber: true,
    },
  },

  /** 青锋科技：青锋冷光暗色底，产品/技术/数据主题。 */
  cyan_blade: {
    id: 'cyan_blade',
    name: '青锋',
    description: '青锋科技风，青锋冷光暗色底。适合产品/技术/数据/路演主题。',
    htmlThemeId: 'cyan-blade',
    themeFonts: {
      heading: CJK_SANS_HEADING,
      body: CJK_SANS_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: '0B1116',
      surface: '121B22',
      text: 'E6EEF2',
      muted: '8FA3B0',
      accent: '5FE0C7',
      accent2: 'C9A86A',
      line: '243038',
      inverseText: '0B1116',
    },
    slideDefaults: {
      background: '0B1116',
      titleSize: 26,
      bodySize: 15,
      footerText: 'LingXiao 青锋',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 48,
      heading1Size: 30,
      heading2Size: 26,
      bodySize: 22,
      headerText: 'LingXiao 青锋',
      footerText: '青锋出品',
    },
    cover: {
      kicker: '青锋 · CYAN BLADE',
      titleAlign: 'left',
      background: '0B1116',
      accentBand: '5FE0C7',
    },
    title: {
      eyebrow: '科技叙事',
      maxLineChars: 46,
    },
    content: {
      titleTop: 0.60,
      bodyTop: 1.70,
      rule: 'left',
    },
    footer: {
      left: 'LingXiao 青锋',
      right: '青锋出品',
      showPageNumber: true,
    },
  },

  /** 金箔商务：暖纸金箔，提案/商业计划/咨询气场。 */
  gold_leaf: {
    id: 'gold_leaf',
    name: '金箔',
    description: '金箔商务风，暖纸金箔。适合提案/商业计划/咨询/融资气场。',
    htmlThemeId: 'gold-leaf',
    themeFonts: {
      heading: CJK_SERIF_HEADING,
      body: CJK_SANS_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: 'FBF7EE',
      surface: 'F4ECDB',
      text: '2A241A',
      muted: '766A54',
      accent: 'B0832E',
      accent2: 'C9A86A',
      line: 'E2D6BD',
      inverseText: 'FBF7EE',
    },
    slideDefaults: {
      background: 'FBF7EE',
      titleSize: 25,
      bodySize: 15,
      footerText: 'LingXiao 金箔',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 48,
      heading1Size: 30,
      heading2Size: 26,
      bodySize: 22,
      headerText: 'LingXiao 金箔',
      footerText: '金箔出品',
    },
    cover: {
      kicker: '金箔 · GOLD LEAF',
      titleAlign: 'center',
      background: 'FBF7EE',
      accentBand: 'B0832E',
    },
    title: {
      eyebrow: '商务提案',
      maxLineChars: 48,
    },
    content: {
      titleTop: 0.58,
      bodyTop: 1.66,
      rule: 'top',
    },
    footer: {
      left: 'LingXiao 金箔',
      right: '金箔出品',
      showPageNumber: true,
    },
  },

  /** 编辑杂志：大标题 + 多栏排版 + 引文块 + 图片叙事。 */
  editorial: {
    id: 'editorial',
    name: '编辑',
    description: '编辑杂志风，大标题 + 多栏排版 + 引文块 + 图片叙事。适合深度报告/白皮书/洞察文章。',
    htmlThemeId: 'editorial',
    themeFonts: {
      heading: 'Georgia, Source Han Serif SC, Noto Serif SC, Songti SC, STSong, serif',
      body: CJK_SANS_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: 'FFFFFF',
      surface: 'F5F5F0',
      text: '1A1A1A',
      muted: '666666',
      accent: '8B2C2C',
      accent2: 'D4A843',
      line: 'DDDDDD',
      inverseText: 'FFFFFF',
    },
    slideDefaults: {
      background: 'FFFFFF',
      titleSize: 28,
      bodySize: 15,
      footerText: 'LingXiao 编辑',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 52,
      heading1Size: 32,
      heading2Size: 27,
      bodySize: 22,
      headerText: 'LingXiao 编辑',
      footerText: '编辑出品',
    },
    cover: {
      kicker: 'EDITORIAL',
      titleAlign: 'left',
      background: 'FFFFFF',
      accentBand: '8B2C2C',
    },
    title: {
      eyebrow: '深度叙事',
      maxLineChars: 50,
    },
    content: {
      titleTop: 0.54,
      bodyTop: 1.60,
      rule: 'left',
    },
    footer: {
      left: 'LingXiao 编辑',
      right: '编辑出品',
      showPageNumber: true,
    },
  },

  /** 暗色高级：墨黑底 + 金/银强调 + 大量留白，品牌/战略/发布会。 */
  dark_luxury: {
    id: 'dark_luxury',
    name: '暗夜',
    description: '暗色高级风，墨黑底 + 金箔强调 + 大量留白。适合品牌/战略/发布会/高端叙事。',
    htmlThemeId: 'dark-luxury',
    themeFonts: {
      heading: CJK_SERIF_HEADING,
      body: CJK_SANS_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: '0B0E11',
      surface: '15191E',
      text: 'E8E4D8',
      muted: '8A857A',
      accent: 'C9A86A',
      accent2: '5FE0C7',
      line: '2A2E33',
      inverseText: '0B0E11',
    },
    slideDefaults: {
      background: '0B0E11',
      titleSize: 27,
      bodySize: 15,
      footerText: 'LingXiao 暗夜',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 50,
      heading1Size: 31,
      heading2Size: 26,
      bodySize: 22,
      headerText: 'LingXiao 暗夜',
      footerText: '暗夜出品',
    },
    cover: {
      kicker: 'DARK LUXURY',
      titleAlign: 'center',
      background: '0B0E11',
      accentBand: 'C9A86A',
    },
    title: {
      eyebrow: '品牌叙事',
      maxLineChars: 42,
    },
    content: {
      titleTop: 0.62,
      bodyTop: 1.74,
      rule: 'none',
    },
    footer: {
      left: 'LingXiao 暗夜',
      right: '暗夜出品',
      showPageNumber: true,
    },
  },

  /** 宣纸纯净：最低存在感，打印/长文档/学术/合同。 */
  papyrus: {
    id: 'papyrus',
    name: '宣纸',
    description: '宣纸纯净风，最低存在感。适合打印/长文档/学术/合同/规范文件。',
    htmlThemeId: 'papyrus',
    themeFonts: {
      heading: CJK_SERIF_HEADING,
      body: CJK_SERIF_BODY,
      mono: MONO_FONT,
    },
    palette: {
      bg: 'FFFFFF',
      surface: 'F7F6F3',
      text: '1A1A1A',
      muted: '5A5A5A',
      accent: '1A1A1A',
      accent2: 'C9A86A',
      line: 'D8D4CC',
      inverseText: 'FFFFFF',
    },
    slideDefaults: {
      background: 'FFFFFF',
      titleSize: 24,
      bodySize: 15,
      footerText: 'LingXiao 宣纸',
      pageNumber: true,
    },
    pageDefaults: {
      titleSize: 46,
      heading1Size: 29,
      heading2Size: 25,
      bodySize: 22,
      headerText: 'LingXiao 宣纸',
      footerText: '宣纸出品',
    },
    cover: {
      kicker: 'PAPYRUS',
      titleAlign: 'left',
      background: 'FFFFFF',
      accentBand: '1A1A1A',
    },
    title: {
      eyebrow: '纯净文档',
      maxLineChars: 52,
    },
    content: {
      titleTop: 0.56,
      bodyTop: 1.62,
      rule: 'left',
    },
    footer: {
      left: 'LingXiao 宣纸',
      right: '宣纸出品',
      showPageNumber: true,
    },
  },
};

export function listOfficeTemplatePresets(): OfficeTemplatePreset[] {
  return Object.values(BUILT_IN_TEMPLATES).map(cloneTemplate);
}

export function getOfficeTemplatePresetIds(): OfficeTemplatePresetId[] {
  return Object.keys(BUILT_IN_TEMPLATES) as OfficeTemplatePresetId[];
}

export function resolveOfficeTemplatePreset(templateId?: string): OfficeTemplatePreset {
  const requested = normalizeTemplateId(templateId);
  if (requested && requested in BUILT_IN_TEMPLATES) {
    return cloneTemplate(BUILT_IN_TEMPLATES[requested as OfficeTemplatePresetId]);
  }

  return cloneTemplate(BUILT_IN_TEMPLATES.lingxiao_board);
}

export function isOfficeTemplatePresetId(value: string): value is OfficeTemplatePresetId {
  const normalized = normalizeTemplateId(value);
  return !!normalized && normalized in BUILT_IN_TEMPLATES;
}

export function officeTemplateMetadata(template: OfficeTemplatePreset): {
  templateId: OfficeTemplatePresetId;
  templateName: string;
  themeFonts: OfficeThemeFonts;
  colors: OfficeTemplatePalette;
  htmlThemeId: string;
} {
  return {
    templateId: template.id,
    templateName: template.name,
    themeFonts: { ...template.themeFonts },
    colors: { ...template.palette },
    htmlThemeId: template.htmlThemeId,
  };
}

function normalizeTemplateId(value?: string): string | undefined {
  return value?.trim().toLowerCase();
}

function cloneTemplate(template: OfficeTemplatePreset): OfficeTemplatePreset {
  return {
    ...template,
    themeFonts: { ...template.themeFonts },
    palette: { ...template.palette },
    slideDefaults: { ...template.slideDefaults },
    pageDefaults: { ...template.pageDefaults },
    cover: { ...template.cover },
    title: { ...template.title },
    content: { ...template.content },
    footer: { ...template.footer },
  };
}
