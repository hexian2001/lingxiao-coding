/**
 * DesignAssetCatalog — 前端设计素材市场的数据引擎
 *
 * 目标:
 * - Web 市场和 design_asset 工具共享同一套目录加载、字段归一和排序逻辑
 * - 允许旧素材继续工作，同时把缺失描述、粗糙提示词和未分级资产提升到稳定格式
 * - 查询结果优先返回更完整、更可落地、更有审美约束的素材
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ASSET_CATEGORIES = [
  'button', 'card', 'background', 'navigation', 'form',
  'effect', 'layout', 'typography', 'icon', 'animation',
  'hero', 'footer', 'modal', 'table', 'badge',
] as const;

export const ASSET_THEMES = [
  'dark', 'light', 'glassmorphism', 'neumorphism', 'brutalist',
  'luxury', 'minimal', 'retro', 'cyberpunk', 'organic',
  'editorial', 'gradient', 'xianxia',
] as const;

export const ASSET_TIERS = ['signature', 'production', 'foundation'] as const;

export type AssetCategory = typeof ASSET_CATEGORIES[number];
export type AssetTheme = typeof ASSET_THEMES[number];
export type AssetTier = typeof ASSET_TIERS[number];

export interface AssetQuality {
  score: number;
  tier: AssetTier;
  complexity: 'drop-in' | 'component' | 'composition';
  density: 'quiet' | 'balanced' | 'rich';
}

export interface AssetPreviewHints {
  background: string;
  minHeight: number;
  surface: 'dark' | 'light' | 'transparent';
}

export interface DesignAsset {
  id: string;
  name: string;
  category: AssetCategory;
  themes: AssetTheme[];
  tags: string[];
  description: string;
  /**
   * 风格提示词 — 给 LLM 的精确描述，让模型能准确还原/扩展该素材的设计风格。
   * 包含色彩方向、排版风格、动效思路、适用场景、禁忌和实现约束。
   */
  stylePrompt: string;
  /** CSS 代码 */
  css: string;
  /** HTML 结构 (可选, 有的纯 CSS 素材不需要) */
  html?: string;
  /** React 组件代码 (可选) */
  react?: string;
  /** Tailwind 类名版本 (可选) */
  tailwind?: string;
  /** 设计说明 */
  designNotes?: string;
  /** 推荐场景 */
  useCases?: string[];
  /** 可访问性和工程落地提示 */
  accessibility?: string[];
  /** 可组合搭配的素材 ID 或 tag */
  pairsWith?: string[];
  /** 市场预览提示 */
  preview?: AssetPreviewHints;
  /** 策展质量信息 */
  quality?: AssetQuality;
  /** 来源文件，仅用于诊断和市场展示 */
  source?: { file: string; index: number };
}

export interface AssetQuery {
  category?: AssetCategory;
  theme?: AssetTheme;
  tags?: string[];
  style?: string;
  search?: string;
  tier?: AssetTier;
  limit?: number;
  format?: 'css' | 'html' | 'react' | 'tailwind';
}

export interface AssetQueryResult {
  total: number;
  returned: number;
  assets: DesignAsset[];
  query: AssetQuery;
}

export interface DesignTheme {
  id: AssetTheme;
  name: string;
  title: string;
  description: string;
  version?: string;
  category?: string;
  tags: string[];
  palette: Record<string, string>;
  previewHtml: string;
  prompt: string;
  previewFile: string;
  promptFile: string;
  source?: { dir: string; manifest: string };
}

export interface ThemeQuery {
  theme?: string;
  tags?: string[];
  search?: string;
  limit?: number;
}

export interface ThemeQueryResult {
  total: number;
  returned: number;
  themeSites: DesignTheme[];
  query: ThemeQuery;
}

export interface ThemeFacets {
  themes: Array<{ theme: AssetTheme; count: number }>;
  tags: Array<{ tag: string; count: number }>;
}

const MAX_QUERY_LIMIT = 200;
const DEFAULT_LIMIT = 5;

const CATEGORY_SET = new Set<string>(ASSET_CATEGORIES);
const THEME_SET = new Set<string>(ASSET_THEMES);
const TIER_SET = new Set<string>(ASSET_TIERS);

const CATEGORY_LABELS: Record<AssetCategory, string> = {
  button: '按钮',
  card: '卡片',
  background: '背景',
  navigation: '导航',
  form: '表单',
  effect: '特效',
  layout: '布局',
  typography: '排版',
  icon: '图标',
  animation: '动画',
  hero: '首屏',
  footer: '页脚',
  modal: '弹窗',
  table: '表格',
  badge: '徽章',
};

const THEME_LABELS: Record<AssetTheme, string> = {
  dark: '深色克制',
  light: '明亮通透',
  glassmorphism: '玻璃拟态',
  neumorphism: '新拟物',
  brutalist: '粗野主义',
  luxury: '奢华编辑',
  minimal: '极简系统',
  retro: '复古数字',
  cyberpunk: '赛博夜景',
  organic: '有机自然',
  editorial: '杂志排版',
  gradient: '高级渐变',
  xianxia: '东方玄幻',
};

const THEME_BACKGROUNDS: Record<AssetTheme, AssetPreviewHints> = {
  dark: { background: 'radial-gradient(circle at 50% 18%, #20262b 0%, #0d1113 58%, #080a0b 100%)', minHeight: 260, surface: 'dark' },
  light: { background: 'linear-gradient(135deg, #f7f9f6 0%, #e7ece7 100%)', minHeight: 260, surface: 'light' },
  glassmorphism: { background: 'radial-gradient(circle at 20% 0%, #9fb2bc 0%, transparent 32%), linear-gradient(135deg, #102027, #e7eef0)', minHeight: 260, surface: 'dark' },
  neumorphism: { background: 'linear-gradient(145deg, #e7ebe7, #cfd7d3)', minHeight: 260, surface: 'light' },
  brutalist: { background: 'linear-gradient(135deg, #f3f0dc 0%, #111111 100%)', minHeight: 260, surface: 'light' },
  luxury: { background: 'linear-gradient(145deg, #fbf8f1 0%, #e8e0d2 100%)', minHeight: 280, surface: 'light' },
  minimal: { background: 'linear-gradient(145deg, #101315 0%, #1b2022 100%)', minHeight: 260, surface: 'dark' },
  retro: { background: 'linear-gradient(135deg, #251b2f 0%, #f7c66f 100%)', minHeight: 260, surface: 'dark' },
  cyberpunk: { background: 'radial-gradient(circle at 72% 18%, #ff2bd6 0%, transparent 26%), linear-gradient(145deg, #070915 0%, #111827 100%)', minHeight: 260, surface: 'dark' },
  organic: { background: 'linear-gradient(135deg, #eef0df 0%, #bfd1b8 100%)', minHeight: 280, surface: 'light' },
  editorial: { background: 'linear-gradient(135deg, #fbfaf7 0%, #dedbd2 100%)', minHeight: 280, surface: 'light' },
  gradient: { background: 'linear-gradient(135deg, #192033 0%, #526f7b 48%, #f2c673 100%)', minHeight: 260, surface: 'dark' },
  xianxia: { background: 'radial-gradient(circle at 50% 0%, rgba(218,191,124,0.34), transparent 32%), linear-gradient(160deg, #0f1518 0%, #20332e 58%, #111719 100%)', minHeight: 280, surface: 'dark' },
};

const TIER_RANK: Record<AssetTier, number> = {
  signature: 0,
  production: 1,
  foundation: 2,
};

const SHOWCASE_CATEGORY_ORDER: AssetCategory[] = [
  'hero',
  'navigation',
  'card',
  'form',
  'table',
  'button',
  'layout',
  'background',
  'badge',
  'modal',
  'typography',
  'effect',
  'animation',
  'footer',
  'icon',
];

const SHOWCASE_THEME_ORDER: AssetTheme[] = [
  'luxury',
  'editorial',
  'xianxia',
  'minimal',
  'dark',
  'cyberpunk',
  'organic',
  'glassmorphism',
  'gradient',
  'brutalist',
  'light',
  'neumorphism',
  'retro',
];

function showcaseThemeRank(asset: Pick<DesignAsset, 'themes'>): number {
  const ranks = asset.themes
    .map(theme => SHOWCASE_THEME_ORDER.indexOf(theme))
    .filter(rank => rank >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : SHOWCASE_THEME_ORDER.length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function cleanLongText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[ \t]+\n/g, '\n').trim() : '';
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    const tag = cleanText(item).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
  return output;
}

function normalizeCategory(value: unknown): AssetCategory | null {
  const category = cleanText(value).toLowerCase();
  return CATEGORY_SET.has(category) ? category as AssetCategory : null;
}

function normalizeThemeList(value: unknown): AssetTheme[] {
  const themes = cleanList(value).filter((theme): theme is AssetTheme => THEME_SET.has(theme));
  return themes.length > 0 ? themes : ['minimal'];
}

function normalizeTier(value: unknown): AssetTier | null {
  const tier = cleanText(value).toLowerCase();
  return TIER_SET.has(tier) ? tier as AssetTier : null;
}

function normalizeTheme(value: unknown): AssetTheme | null {
  const theme = cleanText(value).toLowerCase();
  return THEME_SET.has(theme) ? theme as AssetTheme : null;
}

function cleanPalette(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const palette: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const color = cleanText(raw);
    if (key && color) palette[key] = color;
  }
  return palette;
}

function clampScore(score: number): number {
  return Math.max(50, Math.min(99, Math.round(score)));
}

function inferDensity(tags: string[], category: AssetCategory): AssetQuality['density'] {
  if (tags.some(tag => ['maximal', 'immersive', 'animated', 'ornamental', 'rich'].includes(tag))) return 'rich';
  if (['table', 'navigation', 'form', 'badge'].includes(category)) return 'quiet';
  return 'balanced';
}

function inferComplexity(asset: Pick<DesignAsset, 'category' | 'css' | 'html'>): AssetQuality['complexity'] {
  const lineCount = asset.css.split('\n').length + (asset.html?.split('\n').length ?? 0);
  if (['hero', 'layout', 'modal', 'table'].includes(asset.category) || lineCount > 55) return 'composition';
  if (asset.html || lineCount > 24) return 'component';
  return 'drop-in';
}

function buildDescription(
  name: string,
  category: AssetCategory,
  themes: AssetTheme[],
  tags: string[],
  rawDescription: unknown,
): string {
  const existing = cleanText(rawDescription);
  if (existing) return existing;

  const themeText = themes.map(theme => THEME_LABELS[theme]).join(' / ');
  const tagText = tags.slice(0, 4).join('、') || '高级界面';
  return `${name} 是一款 ${themeText} ${CATEGORY_LABELS[category]}素材，适合 ${tagText} 场景，强调清晰层级、克制质感和可直接落地的前端实现。`;
}

function buildPrompt(asset: {
  name: string;
  id: string;
  category: AssetCategory;
  themes: AssetTheme[];
  tags: string[];
  description: string;
  css: string;
}, rawPrompt: unknown): string {
  const existing = cleanLongText(rawPrompt);
  if (existing.includes('高级设计指令:')) return existing;

  const classHint = asset.css.match(/\.([A-Za-z0-9_-]+)/)?.[1] ?? asset.id;
  const themeText = asset.themes.map(theme => THEME_LABELS[theme]).join(' / ');
  const tagText = asset.tags.slice(0, 8).join(', ') || 'refined, production-ready';
  const original = existing ? `\n原始风格要点:\n${existing}` : '';

  return [
    `高级设计指令: ${asset.name}`,
    `定位: ${asset.description}`,
    `审美系统: ${themeText}; 标签: ${tagText}。画面必须靠比例、留白、层级、材质和微动效建立质感，避免廉价堆料。`,
    `实现约束: 使用命名空间 class "${classHint}" 附近的选择器组织代码; CSS 需要可复制、可局部嵌入、不会污染全局; 动效时长控制在 120ms-700ms，优先 cubic-bezier(0.16, 1, 0.3, 1)。`,
    `落地标准: 保持文字对比度、移动端稳定尺寸、hover/focus/active 状态完整; 用 1px 或 0.5px 边界、柔和阴影和真实信息层级替代夸张装饰。`,
    `禁忌: 禁止随机大渐变、过度圆角、厚重发光、无意义玻璃层、低对比小字和会导致布局跳动的动画。${original}`,
  ].join('\n');
}

function buildDesignNotes(asset: Pick<DesignAsset, 'category' | 'themes' | 'tags' | 'description'>, rawNotes: unknown): string {
  const existing = cleanLongText(rawNotes);
  if (existing) return existing;
  const themeText = asset.themes.map(theme => THEME_LABELS[theme]).join(' / ');
  return `适合作为 ${themeText} 体系里的 ${CATEGORY_LABELS[asset.category]}基元。保留核心比例和状态层级后，可替换品牌色、文案和数据内容。`;
}

function inferUseCases(asset: Pick<DesignAsset, 'category' | 'themes' | 'tags'>, rawUseCases: unknown): string[] {
  const existing = cleanList(rawUseCases);
  if (existing.length > 0) return existing;

  const byCategory: Record<AssetCategory, string[]> = {
    button: ['primary-action', 'conversion-flow', 'toolbar-action'],
    card: ['dashboard-panel', 'feature-list', 'content-summary'],
    background: ['app-shell', 'landing-section', 'presentation-cover'],
    navigation: ['workspace-nav', 'product-console', 'content-hierarchy'],
    form: ['settings-form', 'onboarding-flow', 'search-filter'],
    effect: ['micro-interaction', 'focus-treatment', 'brand-polish'],
    layout: ['dashboard-grid', 'landing-composition', 'content-system'],
    typography: ['editorial-heading', 'article-system', 'brand-statement'],
    icon: ['visual-language', 'toolbar-symbol', 'status-system'],
    animation: ['entrance-motion', 'state-transition', 'loading-feedback'],
    hero: ['landing-hero', 'campaign-cover', 'product-introduction'],
    footer: ['site-footer', 'legal-row', 'brand-close'],
    modal: ['confirmation-flow', 'detail-drawer', 'command-dialog'],
    table: ['data-console', 'admin-list', 'audit-log'],
    badge: ['status-indicator', 'metadata-label', 'notification-chip'],
  };
  const themeUseCase = asset.themes.includes('xianxia') ? ['fantasy-interface'] : [];
  return [...byCategory[asset.category].slice(0, 2), ...themeUseCase].slice(0, 3);
}

function inferAccessibility(asset: Pick<DesignAsset, 'category' | 'tags'>, rawAccessibility: unknown): string[] {
  const existing = cleanList(rawAccessibility);
  if (existing.length > 0) return existing;

  const notes = ['contrast-aa', 'stable-focus-state'];
  if (['button', 'form', 'navigation', 'modal'].includes(asset.category)) notes.push('keyboard-visible');
  if (asset.tags.includes('animated')) notes.push('reduced-motion-friendly');
  return notes;
}

function inferPreview(themes: AssetTheme[], rawPreview: unknown): AssetPreviewHints {
  const record = asRecord(rawPreview);
  const fallback = THEME_BACKGROUNDS[themes[0] ?? 'minimal'];
  const background = cleanText(record?.background) || fallback.background;
  const surface = cleanText(record?.surface);
  const minHeightRaw = Number(record?.minHeight);
  return {
    background,
    minHeight: Number.isFinite(minHeightRaw) ? Math.max(180, Math.min(520, Math.round(minHeightRaw))) : fallback.minHeight,
    surface: surface === 'dark' || surface === 'light' || surface === 'transparent' ? surface : fallback.surface,
  };
}

function scoreAsset(asset: Pick<DesignAsset, 'id' | 'description' | 'stylePrompt' | 'css' | 'html' | 'tags' | 'themes'>): number {
  let score = 62;
  if (asset.description.length >= 60) score += 8;
  if (asset.description.length >= 110) score += 4;
  if (asset.stylePrompt.length >= 360) score += 12;
  if (asset.stylePrompt.includes('禁忌')) score += 4;
  if (asset.css.split('\n').length >= 18) score += 7;
  if (asset.css.includes(':hover') || asset.css.includes(':focus')) score += 4;
  if (asset.css.includes('@media') || asset.css.includes('clamp(')) score += 3;
  if (asset.html) score += 6;
  if (asset.tags.length >= 5) score += 4;
  if (asset.themes.length >= 2) score += 2;
  if (asset.id.includes('signature') || asset.tags.includes('signature')) score += 8;
  return clampScore(score);
}

function normalizeQuality(asset: Pick<DesignAsset, 'category' | 'tags' | 'css' | 'html' | 'description' | 'stylePrompt' | 'themes' | 'id'>, rawQuality: unknown): AssetQuality {
  const record = asRecord(rawQuality);
  const suppliedScore = Number(record?.score);
  const computedScore = scoreAsset(asset);
  const score = clampScore(Number.isFinite(suppliedScore) ? Math.max(suppliedScore, computedScore) : computedScore);
  const rawTier = normalizeTier(record?.tier);
  const tier = rawTier ?? (score >= 92 ? 'signature' : score >= 82 ? 'production' : 'foundation');
  const rawComplexity = cleanText(record?.complexity);
  const complexity = rawComplexity === 'drop-in' || rawComplexity === 'component' || rawComplexity === 'composition'
    ? rawComplexity
    : inferComplexity(asset);
  const rawDensity = cleanText(record?.density);
  const density = rawDensity === 'quiet' || rawDensity === 'balanced' || rawDensity === 'rich'
    ? rawDensity
    : inferDensity(asset.tags, asset.category);
  return { score, tier, complexity, density };
}

export function normalizeDesignAsset(rawAsset: unknown, sourceFile = 'inline', index = 0): DesignAsset | null {
  const record = asRecord(rawAsset);
  if (!record) return null;

  const id = cleanText(record.id);
  const name = cleanText(record.name);
  const category = normalizeCategory(record.category);
  const css = cleanLongText(record.css);
  if (!id || !name || !category || !css) return null;

  const themes = normalizeThemeList(record.themes);
  const tags = cleanList(record.tags);
  const description = buildDescription(name, category, themes, tags, record.description);
  const baseForPrompt = { id, name, category, themes, tags, description, css };
  const stylePrompt = buildPrompt(baseForPrompt, record.stylePrompt);
  const html = cleanLongText(record.html) || undefined;

  const asset: DesignAsset = {
    id,
    name,
    category,
    themes,
    tags,
    description,
    stylePrompt,
    css,
    ...(html ? { html } : {}),
    ...(cleanLongText(record.react) ? { react: cleanLongText(record.react) } : {}),
    ...(cleanLongText(record.tailwind) ? { tailwind: cleanLongText(record.tailwind) } : {}),
    designNotes: buildDesignNotes({ category, themes, tags, description }, record.designNotes),
    useCases: inferUseCases({ category, themes, tags }, record.useCases),
    accessibility: inferAccessibility({ category, tags }, record.accessibility),
    pairsWith: cleanList(record.pairsWith),
    preview: inferPreview(themes, record.preview),
    quality: normalizeQuality({ id, category, themes, tags, description, stylePrompt, css, html }, record.quality),
    source: { file: sourceFile, index },
  };

  return asset;
}

export function normalizeDesignAssets(rawAssets: unknown[], sourceFile = 'inline'): DesignAsset[] {
  return rawAssets
    .map((asset, index) => normalizeDesignAsset(asset, sourceFile, index))
    .filter((asset): asset is DesignAsset => asset !== null);
}

export function sortDesignAssets(assets: DesignAsset[]): DesignAsset[] {
  return [...assets].sort((a, b) => {
    const aQuality = a.quality ?? normalizeQuality(a, undefined);
    const bQuality = b.quality ?? normalizeQuality(b, undefined);
    return TIER_RANK[aQuality.tier] - TIER_RANK[bQuality.tier]
      || bQuality.score - aQuality.score
      || SHOWCASE_CATEGORY_ORDER.indexOf(a.category) - SHOWCASE_CATEGORY_ORDER.indexOf(b.category)
      || showcaseThemeRank(a) - showcaseThemeRank(b)
      || a.name.localeCompare(b.name);
  });
}

export function loadDesignAssetsFromDirectories(searchPaths: string[]): DesignAsset[] {
  const allAssets: DesignAsset[] = [];

  for (const dir of searchPaths) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
        if (Array.isArray(parsed)) {
          allAssets.push(...normalizeDesignAssets(parsed, file));
        }
      } catch {
        // Ignore malformed marketplace files; the rest of the bundled catalog should stay available.
      }
    }
    if (allAssets.length > 0) break;
  }

  return sortDesignAssets(allAssets);
}

export function normalizeDesignTheme(rawManifest: unknown, themeDir: string): DesignTheme | null {
  const record = asRecord(rawManifest);
  if (!record) return null;

  const id = normalizeTheme(record.id);
  const name = cleanText(record.name);
  const title = cleanText(record.title) || name;
  const description = cleanText(record.description);
  const previewFile = cleanText(record.preview) || 'preview.html';
  const promptFile = cleanText(record.prompt) || 'prompt.md';
  if (!id || !name || !title || !description) return null;

  const previewPath = join(themeDir, previewFile);
  const promptPath = join(themeDir, promptFile);
  if (!existsSync(previewPath) || !existsSync(promptPath)) return null;

  const previewHtml = cleanLongText(readFileSync(previewPath, 'utf8'));
  const prompt = cleanLongText(readFileSync(promptPath, 'utf8'));
  if (!previewHtml || !prompt) return null;

  return {
    id,
    name,
    title,
    description,
    ...(cleanText(record.version) ? { version: cleanText(record.version) } : {}),
    ...(cleanText(record.category) ? { category: cleanText(record.category) } : {}),
    tags: cleanList(record.tags),
    palette: cleanPalette(record.palette),
    previewHtml,
    prompt,
    previewFile,
    promptFile,
    source: { dir: themeDir, manifest: 'manifest.json' },
  };
}

export function loadDesignThemesFromDirectories(searchPaths: string[]): DesignTheme[] {
  const themes: DesignTheme[] = [];
  const seen = new Set<AssetTheme>();

  for (const root of searchPaths) {
    if (!existsSync(root)) continue;
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => SHOWCASE_THEME_ORDER.indexOf(a as AssetTheme) - SHOWCASE_THEME_ORDER.indexOf(b as AssetTheme) || a.localeCompare(b));

    for (const entry of entries) {
      const themeDir = join(root, entry);
      const manifestPath = join(themeDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
        const theme = normalizeDesignTheme(parsed, themeDir);
        if (theme && !seen.has(theme.id)) {
          seen.add(theme.id);
          themes.push(theme);
        }
      } catch {
        // Ignore malformed theme directories; valid bundled themes should still load.
      }
    }
    if (themes.length > 0) break;
  }

  return themes.sort((a, b) => SHOWCASE_THEME_ORDER.indexOf(a.id) - SHOWCASE_THEME_ORDER.indexOf(b.id) || a.name.localeCompare(b.name));
}

function tagMatches(asset: DesignAsset, expectedTags: string[]): boolean {
  const tagSet = new Set(asset.tags.map(tag => tag.toLowerCase()));
  return expectedTags.every(tag => tagSet.has(tag.toLowerCase()));
}

function searchScore(asset: DesignAsset, terms: string[]): number {
  const name = asset.name.toLowerCase();
  const id = asset.id.toLowerCase();
  const description = asset.description.toLowerCase();
  const prompt = asset.stylePrompt.toLowerCase();
  const tags = asset.tags.map(tag => tag.toLowerCase());
  const themes = asset.themes.map(theme => theme.toLowerCase());

  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (id === term || name === term) score += 80;
    if (id.includes(term)) score += 34;
    if (name.includes(term)) score += 32;
    if (asset.category.includes(term)) score += 22;
    if (themes.some(theme => theme.includes(term))) score += 20;
    if (tags.some(tag => tag === term)) score += 20;
    if (tags.some(tag => tag.includes(term))) score += 14;
    if (description.includes(term)) score += 10;
    if (prompt.includes(term)) score += 4;
  }

  return score;
}

function themeSearchScore(theme: DesignTheme, terms: string[]): number {
  const id = theme.id.toLowerCase();
  const name = theme.name.toLowerCase();
  const title = theme.title.toLowerCase();
  const description = theme.description.toLowerCase();
  const prompt = theme.prompt.toLowerCase();
  const tags = theme.tags.map(tag => tag.toLowerCase());

  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (id === term || name === term || title === term) score += 80;
    if (id.includes(term)) score += 36;
    if (name.includes(term) || title.includes(term)) score += 32;
    if (tags.some(tag => tag === term)) score += 24;
    if (tags.some(tag => tag.includes(term))) score += 16;
    if (description.includes(term)) score += 10;
    if (prompt.includes(term)) score += 4;
  }
  return score;
}

export class DesignThemeCatalog {
  private themes: DesignTheme[] = [];
  private byId = new Map<AssetTheme, DesignTheme>();
  private byTag = new Map<string, DesignTheme[]>();

  constructor(themes?: DesignTheme[]) {
    if (themes) this.loadThemes(themes);
  }

  loadThemes(themes: DesignTheme[]): void {
    const deduped = new Map<AssetTheme, DesignTheme>();
    for (const theme of themes) deduped.set(theme.id, theme);
    this.themes = [...deduped.values()].sort((a, b) => SHOWCASE_THEME_ORDER.indexOf(a.id) - SHOWCASE_THEME_ORDER.indexOf(b.id) || a.name.localeCompare(b.name));
    this.rebuildIndices();
  }

  private rebuildIndices(): void {
    this.byId.clear();
    this.byTag.clear();

    for (const theme of this.themes) {
      this.byId.set(theme.id, theme);
      for (const tag of theme.tags) {
        if (!this.byTag.has(tag)) this.byTag.set(tag, []);
        this.byTag.get(tag)!.push(theme);
      }
    }
  }

  get(id: AssetTheme): DesignTheme | undefined {
    return this.byId.get(id);
  }

  list(): DesignTheme[] {
    return [...this.themes];
  }

  search(search: string, limit = DEFAULT_LIMIT): DesignTheme[] {
    const terms = cleanText(search).toLowerCase().split(/\s+/).filter(Boolean);
    const max = Math.min(Math.max(1, limit), MAX_QUERY_LIMIT);
    if (terms.length === 0) return this.list().slice(0, max);

    return this.themes
      .map(theme => ({ theme, rank: themeSearchScore(theme, terms) }))
      .filter(item => item.rank > 0)
      .sort((a, b) => b.rank - a.rank || SHOWCASE_THEME_ORDER.indexOf(a.theme.id) - SHOWCASE_THEME_ORDER.indexOf(b.theme.id))
      .map(item => item.theme)
      .slice(0, max);
  }

  getTags(): Array<{ tag: string; count: number }> {
    return [...this.byTag.entries()]
      .map(([tag, themes]) => ({ tag, count: themes.length }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  get size(): number {
    return this.themes.length;
  }
}

export class DesignAssetCatalog {
  private assets: DesignAsset[] = [];
  /** category -> assets 索引 */
  private byCategory = new Map<AssetCategory, DesignAsset[]>();
  /** tag -> assets 索引 */
  private byTag = new Map<string, DesignAsset[]>();
  /** theme -> assets 索引 */
  private byTheme = new Map<AssetTheme, DesignAsset[]>();

  constructor(assets?: DesignAsset[]) {
    if (assets) this.loadAssets(assets);
  }

  loadAssets(assets: DesignAsset[]): void {
    const deduped = new Map<string, DesignAsset>();
    for (const asset of sortDesignAssets(normalizeDesignAssets(assets))) {
      const existing = deduped.get(asset.id);
      const existingScore = existing?.quality?.score ?? 0;
      const nextScore = asset.quality?.score ?? 0;
      if (!existing || nextScore > existingScore) deduped.set(asset.id, asset);
    }
    this.assets = sortDesignAssets([...deduped.values()]);
    this.rebuildIndices();
  }

  private rebuildIndices(): void {
    this.byCategory.clear();
    this.byTag.clear();
    this.byTheme.clear();

    for (const asset of this.assets) {
      if (!this.byCategory.has(asset.category)) this.byCategory.set(asset.category, []);
      this.byCategory.get(asset.category)!.push(asset);

      for (const tag of asset.tags) {
        if (!this.byTag.has(tag)) this.byTag.set(tag, []);
        this.byTag.get(tag)!.push(asset);
      }

      for (const theme of asset.themes) {
        if (!this.byTheme.has(theme)) this.byTheme.set(theme, []);
        this.byTheme.get(theme)!.push(asset);
      }
    }
  }

  /**
   * 查询素材库。category/theme/tags/tier 是 AND 过滤，search/style 是加权文本检索。
   */
  query(q: AssetQuery): AssetQueryResult {
    let candidates = this.assets;

    if (q.category) {
      candidates = this.byCategory.get(q.category) ?? [];
    }

    if (q.theme) {
      const themeSet = new Set((this.byTheme.get(q.theme) ?? []).map(asset => asset.id));
      candidates = candidates.filter(asset => themeSet.has(asset.id));
    }

    if (q.tags && q.tags.length > 0) {
      candidates = candidates.filter(asset => tagMatches(asset, q.tags!));
    }

    if (q.tier) {
      candidates = candidates.filter(asset => asset.quality?.tier === q.tier);
    }

    const styleTerms = cleanText(q.style).toLowerCase().split(/\s+/).filter(Boolean);
    if (styleTerms.length > 0) {
      candidates = candidates.filter(asset => searchScore(asset, styleTerms) > 0);
    }

    const searchTerms = cleanText(q.search).toLowerCase().split(/\s+/).filter(Boolean);
    if (searchTerms.length > 0) {
      candidates = candidates
        .map(asset => ({ asset, rank: searchScore(asset, searchTerms) }))
        .filter(item => item.rank > 0)
        .sort((a, b) => b.rank - a.rank || (b.asset.quality?.score ?? 0) - (a.asset.quality?.score ?? 0))
        .map(item => item.asset);
    } else {
      candidates = sortDesignAssets(candidates);
    }

    const total = candidates.length;
    const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), MAX_QUERY_LIMIT);
    const returned = candidates.slice(0, limit);

    return {
      total,
      returned: returned.length,
      assets: returned,
      query: q,
    };
  }

  /** 获取所有可用 category 及其素材数量 */
  getCategories(): Array<{ category: AssetCategory; count: number }> {
    return [...this.byCategory.entries()]
      .map(([category, assets]) => ({ category, count: assets.length }))
      .sort((a, b) => ASSET_CATEGORIES.indexOf(a.category) - ASSET_CATEGORIES.indexOf(b.category));
  }

  /** 获取所有可用 tag 及其素材数量 */
  getTags(): Array<{ tag: string; count: number }> {
    return [...this.byTag.entries()]
      .map(([tag, assets]) => ({ tag, count: assets.length }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** 获取所有可用 theme 及其素材数量 */
  getThemes(): Array<{ theme: AssetTheme; count: number }> {
    return [...this.byTheme.entries()]
      .map(([theme, assets]) => ({ theme, count: assets.length }))
      .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  }

  /** 获取所有可用质量分级及其数量 */
  getTiers(): Array<{ tier: AssetTier; count: number }> {
    const counts = new Map<AssetTier, number>();
    for (const asset of this.assets) {
      const tier = asset.quality?.tier ?? 'foundation';
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    return ASSET_TIERS.map(tier => ({ tier, count: counts.get(tier) ?? 0 }));
  }

  /** 素材总数 */
  get size(): number {
    return this.assets.length;
  }
}
