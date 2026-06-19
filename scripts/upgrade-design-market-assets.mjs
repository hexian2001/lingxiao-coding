import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS_DIR = join(process.cwd(), 'skills/bundled/design-market/assets');

const profiles = [
  {
    theme: 'dark',
    file: 'theme-dark.json',
    label: 'Nocturne Console',
    tone: 'deep operational interface',
    bg: 'radial-gradient(circle at 50% 0%, rgba(174,189,197,0.16), transparent 34%), linear-gradient(145deg, #0b0f11 0%, #171c1f 100%)',
    surface: '#111719',
    panel: 'rgba(239,242,241,0.055)',
    ink: '#eff2f1',
    muted: '#8c989a',
    accent: '#aebdc5',
    accent2: '#f2c673',
    onAccent: '#111719',
    border: 'rgba(210,219,222,0.16)',
    shadow: '0 24px 70px rgba(0,0,0,0.34)',
    radius: '14px',
  },
  {
    theme: 'light',
    file: 'theme-light.json',
    label: 'Pearl Workspace',
    tone: 'quiet daylight productivity',
    bg: 'linear-gradient(145deg, #fbfcf8 0%, #e9eee8 100%)',
    surface: '#ffffff',
    panel: 'rgba(82,111,123,0.06)',
    ink: '#172025',
    muted: '#667174',
    accent: '#526f7b',
    accent2: '#a77720',
    onAccent: '#ffffff',
    border: 'rgba(91,104,111,0.22)',
    shadow: '0 24px 60px rgba(48,75,86,0.14)',
    radius: '12px',
  },
  {
    theme: 'glassmorphism',
    file: 'theme-glassmorphism.json',
    label: 'Frosted Atrium',
    tone: 'layered translucent command surface',
    bg: 'radial-gradient(circle at 22% 0%, rgba(174,189,200,0.55), transparent 34%), radial-gradient(circle at 78% 10%, rgba(242,198,115,0.28), transparent 30%), linear-gradient(135deg, #102027, #d8e3e4)',
    surface: 'rgba(255,255,255,0.18)',
    panel: 'rgba(255,255,255,0.16)',
    ink: '#f8fbfa',
    muted: 'rgba(248,251,250,0.72)',
    accent: '#d9f3ff',
    accent2: '#f2c673',
    onAccent: '#102027',
    border: 'rgba(255,255,255,0.32)',
    shadow: '0 24px 70px rgba(8,19,25,0.25)',
    radius: '18px',
  },
  {
    theme: 'neumorphism',
    file: 'theme-neumorphism.json',
    label: 'Soft Instrument',
    tone: 'tactile low-contrast controls',
    bg: 'linear-gradient(145deg, #edf1ee 0%, #cbd5d2 100%)',
    surface: '#e6ece8',
    panel: '#dce5e0',
    ink: '#243033',
    muted: '#6b777a',
    accent: '#526f7b',
    accent2: '#9b7c33',
    onAccent: '#ffffff',
    border: 'rgba(255,255,255,0.72)',
    shadow: '10px 10px 24px rgba(72,84,87,0.18), -10px -10px 24px rgba(255,255,255,0.82)',
    radius: '22px',
  },
  {
    theme: 'brutalist',
    file: 'theme-brutalist.json',
    label: 'Museum Brutalist',
    tone: 'raw editorial grid with discipline',
    bg: 'linear-gradient(135deg, #f3f0dc 0%, #ece3bd 52%, #111111 52%, #111111 100%)',
    surface: '#f8f1cf',
    panel: '#111111',
    ink: '#111111',
    muted: '#4c4636',
    accent: '#e03b2f',
    accent2: '#111111',
    onAccent: '#fff7d6',
    border: '#111111',
    shadow: '10px 10px 0 rgba(0,0,0,0.92)',
    radius: '0px',
  },
  {
    theme: 'luxury',
    file: 'theme-luxury.json',
    label: 'Atelier Reserve',
    tone: 'quiet luxury editorial commerce',
    bg: 'linear-gradient(145deg, #fbf8f1 0%, #e6dac8 100%)',
    surface: '#fbf8f1',
    panel: '#efe4d2',
    ink: '#211b16',
    muted: '#7a6b5d',
    accent: '#9a7738',
    accent2: '#2f2520',
    onAccent: '#fbf8f1',
    border: 'rgba(154,119,56,0.34)',
    shadow: '0 28px 70px rgba(62,44,28,0.14)',
    radius: '8px',
  },
  {
    theme: 'minimal',
    file: 'theme-minimal.json',
    label: 'Monastic Product',
    tone: 'reduced product system',
    bg: 'linear-gradient(145deg, #101315 0%, #181d1f 100%)',
    surface: '#f7f8f5',
    panel: '#ecefeb',
    ink: '#151b1d',
    muted: '#667174',
    accent: '#111719',
    accent2: '#526f7b',
    onAccent: '#f7f8f5',
    border: 'rgba(21,27,29,0.16)',
    shadow: '0 22px 60px rgba(0,0,0,0.18)',
    radius: '10px',
  },
  {
    theme: 'retro',
    file: 'theme-retro.json',
    label: 'Analog Terminal',
    tone: 'warm retro software without kitsch',
    bg: 'linear-gradient(135deg, #2a1730 0%, #674d2e 58%, #f2c673 100%)',
    surface: '#22172b',
    panel: 'rgba(247,198,111,0.14)',
    ink: '#fff2d2',
    muted: '#d8b983',
    accent: '#f2c673',
    accent2: '#ff8c6a',
    onAccent: '#22172b',
    border: 'rgba(242,198,115,0.38)',
    shadow: '0 24px 70px rgba(31,15,35,0.35)',
    radius: '12px',
  },
  {
    theme: 'cyberpunk',
    file: 'theme-cyberpunk.json',
    label: 'Neon Ops',
    tone: 'night city infrastructure',
    bg: 'radial-gradient(circle at 76% 8%, rgba(255,43,214,0.36), transparent 28%), radial-gradient(circle at 18% 86%, rgba(34,211,238,0.24), transparent 32%), linear-gradient(145deg, #060817 0%, #111827 100%)',
    surface: '#090b1a',
    panel: 'rgba(34,211,238,0.08)',
    ink: '#f8fbff',
    muted: '#93a4b8',
    accent: '#22d3ee',
    accent2: '#ff2bd6',
    onAccent: '#060817',
    border: 'rgba(34,211,238,0.34)',
    shadow: '0 24px 70px rgba(34,211,238,0.12)',
    radius: '10px',
  },
  {
    theme: 'organic',
    file: 'theme-organic.json',
    label: 'Living System',
    tone: 'natural workflow with soft structure',
    bg: 'linear-gradient(135deg, #eef0df 0%, #bfd1b8 100%)',
    surface: '#f5f3e7',
    panel: '#dfe7d3',
    ink: '#233128',
    muted: '#60705f',
    accent: '#4f7b58',
    accent2: '#b08345',
    onAccent: '#f5f3e7',
    border: 'rgba(79,123,88,0.22)',
    shadow: '0 26px 64px rgba(68,92,68,0.18)',
    radius: '28px',
  },
  {
    theme: 'editorial',
    file: 'theme-editorial.json',
    label: 'Index Magazine',
    tone: 'publication-grade product storytelling',
    bg: 'linear-gradient(135deg, #fbfaf7 0%, #ddd8ce 100%)',
    surface: '#fbfaf7',
    panel: '#151515',
    ink: '#151515',
    muted: '#6f6b63',
    accent: '#b03d2d',
    accent2: '#151515',
    onAccent: '#fbfaf7',
    border: 'rgba(21,21,21,0.22)',
    shadow: '0 22px 54px rgba(21,21,21,0.12)',
    radius: '4px',
  },
  {
    theme: 'gradient',
    file: 'theme-gradient.json',
    label: 'Chromatic System',
    tone: 'precise chromatic depth',
    bg: 'linear-gradient(135deg, #192033 0%, #526f7b 46%, #f2c673 100%)',
    surface: 'rgba(255,255,255,0.14)',
    panel: 'rgba(13,19,24,0.34)',
    ink: '#ffffff',
    muted: 'rgba(255,255,255,0.74)',
    accent: '#f2c673',
    accent2: '#aebdc5',
    onAccent: '#111719',
    border: 'rgba(255,255,255,0.26)',
    shadow: '0 28px 78px rgba(16,28,38,0.28)',
    radius: '18px',
  },
  {
    theme: 'xianxia',
    file: 'theme-xianxia.json',
    label: 'Celestial Jade',
    tone: 'eastern fantasy interface with restraint',
    bg: 'radial-gradient(circle at 50% 0%, rgba(218,191,124,0.32), transparent 34%), linear-gradient(160deg, #0f1518 0%, #20332e 58%, #111719 100%)',
    surface: 'rgba(16,29,25,0.88)',
    panel: 'rgba(218,191,124,0.10)',
    ink: '#f3ead2',
    muted: '#b7c3aa',
    accent: '#dabf7c',
    accent2: '#8fc7aa',
    onAccent: '#101d19',
    border: 'rgba(218,191,124,0.30)',
    shadow: '0 28px 74px rgba(4,8,7,0.36)',
    radius: '16px',
  },
];

const categoryLabels = {
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

function uniq(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim().toLowerCase()).filter(Boolean))];
}

function promptFor(profile, assetName, category, focus) {
  return [
    `高级设计指令: ${profile.label} ${assetName}`,
    `定位: ${profile.tone} 的 ${categoryLabels[category] || category}模板，面向真实产品界面而不是展示稿。`,
    `视觉原则: 使用 ${profile.surface} 作为主体表面，${profile.accent} 作为唯一主强调色，${profile.accent2} 只做稀有辅助；靠比例、对齐、边界、层级和留白建立高级感。`,
    `构图要求: ${focus}；所有模块必须有明确主次，文本不要拥挤，交互区尺寸稳定，移动端改为单列或横向滚动。`,
    `实现要求: CSS class 必须命名空间化，hover/focus/active 状态完整；动效克制，时长 120ms-520ms，优先 cubic-bezier(0.16, 1, 0.3, 1)。`,
    '禁忌: 禁止廉价大面积发光、随机渐变、过度圆角、无意义玻璃叠层、低对比小字、会让布局跳动的动画，以及只有装饰没有信息层级的视觉噱头。',
  ].join('\n');
}

function preview(profile, minHeight = 300) {
  return { background: profile.bg, minHeight, surface: ['light', 'neumorphism', 'luxury', 'organic', 'editorial'].includes(profile.theme) ? 'light' : 'dark' };
}

function quality(complexity, density = 'balanced') {
  return { score: 98, tier: 'signature', complexity, density };
}

function heroAsset(profile) {
  const cls = `sig-${profile.theme}-hero`;
  return {
    id: `signature-${profile.theme}-hero`,
    name: `${profile.label} Hero`,
    category: 'hero',
    themes: uniq([profile.theme, profile.theme === 'dark' ? 'minimal' : undefined, profile.theme === 'luxury' ? 'editorial' : undefined]),
    tags: uniq(['signature', 'hero', 'premium', 'responsive', 'product', profile.theme]),
    description: `${profile.label} 的高端首屏模板，用稳定双栏、信息面板和克制强调色建立成熟产品气质。`,
    stylePrompt: promptFor(profile, 'Hero', 'hero', '首屏左侧只放一个强主张、两行动机说明和双按钮；右侧是可替换的信息面板，不使用装饰性插画抢层级'),
    css: `.${cls} {
  width: min(100%, 900px);
  min-height: 420px;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(240px, 320px);
  gap: 32px;
  align-items: stretch;
  padding: 42px;
  border: 1px solid ${profile.border};
  border-radius: ${profile.radius};
  background: linear-gradient(145deg, ${profile.surface}, ${profile.panel});
  color: ${profile.ink};
  box-shadow: ${profile.shadow};
  overflow: hidden;
}
.${cls} .copy { display: flex; flex-direction: column; justify-content: center; gap: 18px; }
.${cls} .eyebrow { color: ${profile.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
.${cls} h1 { margin: 0; max-width: 580px; font-size: 52px; line-height: 1.02; letter-spacing: 0; font-weight: 760; }
.${cls} p { margin: 0; max-width: 520px; color: ${profile.muted}; font-size: 15px; line-height: 1.75; }
.${cls} .actions { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 6px; }
.${cls} button { height: 38px; padding: 0 16px; border-radius: 8px; border: 1px solid ${profile.border}; font: inherit; font-size: 13px; cursor: pointer; transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), border-color 180ms; }
.${cls} .primary { background: ${profile.accent}; color: ${profile.onAccent}; border-color: ${profile.accent}; }
.${cls} .secondary { background: transparent; color: ${profile.ink}; }
.${cls} button:hover { transform: translateY(-1px); border-color: ${profile.accent}; }
.${cls} .panel { display: grid; align-content: space-between; gap: 18px; padding: 22px; border: 1px solid ${profile.border}; border-radius: calc(${profile.radius} - 2px); background: ${profile.panel}; }
.${cls} .metric { display: grid; gap: 4px; }
.${cls} .metric strong { font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.${cls} .metric span { color: ${profile.muted}; font-size: 12px; }
.${cls} .rail { height: 8px; border-radius: 99px; background: linear-gradient(90deg, ${profile.accent}, ${profile.accent2}); }
@media (max-width: 760px) {
  .${cls} { grid-template-columns: 1fr; padding: 28px; }
  .${cls} h1 { font-size: 36px; }
}`,
    html: `<section class="${cls}">
  <div class="copy">
    <div class="eyebrow">Signature System</div>
    <h1>Build interfaces with deliberate calm.</h1>
    <p>A precise front page composition for teams that need premium presence, clear hierarchy, and production-ready behavior.</p>
    <div class="actions">
      <button class="primary">Start Flow</button>
      <button class="secondary">View System</button>
    </div>
  </div>
  <aside class="panel">
    <div class="metric"><strong>98</strong><span>Quality score</span></div>
    <div class="rail"></div>
    <div class="metric"><strong>12ms</strong><span>Interaction budget</span></div>
  </aside>
</section>`,
    designNotes: '首屏模板保持强品牌信号和真实产品信息，不依赖装饰图形。右侧 panel 可以替换成截图、指标、订阅卡或流程状态。',
    useCases: ['landing-hero', 'product-introduction', 'campaign-cover'],
    accessibility: ['contrast-aa', 'keyboard-visible', 'responsive-single-column'],
    preview: preview(profile, 340),
    quality: quality('composition', 'rich'),
  };
}

function cardAsset(profile) {
  const cls = `sig-${profile.theme}-card`;
  return {
    id: `signature-${profile.theme}-card`,
    name: `${profile.label} Insight Card`,
    category: 'card',
    themes: uniq([profile.theme]),
    tags: uniq(['signature', 'card', 'dashboard', 'insight', 'premium', profile.theme]),
    description: `${profile.label} 信息卡，强调标题、状态、指标和上下文说明的专业层级，适合关键指标、审计状态和产品控制台概览。`,
    stylePrompt: promptFor(profile, 'Insight Card', 'card', '卡片必须像真实 dashboard 组件，有标题、状态、核心指标、解释文本和脚注，不做空洞装饰'),
    css: `.${cls} {
  width: min(100%, 380px);
  padding: 22px;
  border: 1px solid ${profile.border};
  border-radius: ${profile.radius};
  background: ${profile.surface};
  color: ${profile.ink};
  box-shadow: ${profile.shadow};
}
.${cls} .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.${cls} .title { font-size: 13px; font-weight: 700; letter-spacing: 0; }
.${cls} .status { display: inline-flex; align-items: center; gap: 6px; color: ${profile.accent}; font-size: 12px; }
.${cls} .dot { width: 7px; height: 7px; border-radius: 50%; background: ${profile.accent}; }
.${cls} .value { margin: 0 0 10px; font-size: 40px; line-height: 1; font-weight: 760; font-variant-numeric: tabular-nums; letter-spacing: 0; }
.${cls} p { margin: 0; color: ${profile.muted}; font-size: 13px; line-height: 1.7; }
.${cls} .footer { display: flex; justify-content: space-between; gap: 14px; margin-top: 22px; padding-top: 16px; border-top: 1px solid ${profile.border}; color: ${profile.muted}; font-size: 12px; }
.${cls} .footer strong { color: ${profile.ink}; font-weight: 700; }`,
    html: `<article class="${cls}">
  <div class="top">
    <div class="title">Interface Quality</div>
    <div class="status"><span class="dot"></span>Live</div>
  </div>
  <h3 class="value">97.8%</h3>
  <p>Completion quality across typography, contrast, spacing, responsive behavior, and state coverage.</p>
  <div class="footer"><span>Audit</span><strong>Pass</strong><span>Updated</span><strong>Now</strong></div>
</article>`,
    designNotes: '信息卡不应该只有一个漂亮容器；必须包含用户能判断状态的真实信息。',
    useCases: ['dashboard-panel', 'feature-summary', 'quality-metric'],
    accessibility: ['contrast-aa', 'tabular-numerals'],
    preview: preview(profile, 280),
    quality: quality('component', 'balanced'),
  };
}

function navAsset(profile) {
  const cls = `sig-${profile.theme}-nav`;
  return {
    id: `signature-${profile.theme}-nav`,
    name: `${profile.label} Navigation`,
    category: 'navigation',
    themes: uniq([profile.theme]),
    tags: uniq(['signature', 'navigation', 'workspace', 'toolbar', 'responsive', profile.theme]),
    description: `${profile.label} 顶部导航，适合产品控制台、作品集和高端 SaaS 工具。`,
    stylePrompt: promptFor(profile, 'Navigation', 'navigation', '导航只承载品牌、三到四个关键入口和一个主动作；active 状态明确但不喧宾夺主'),
    css: `.${cls} {
  width: min(100%, 860px);
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 16px;
  border: 1px solid ${profile.border};
  border-radius: ${profile.radius};
  background: ${profile.surface};
  color: ${profile.ink};
  box-shadow: ${profile.shadow};
}
.${cls} .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 760; }
.${cls} .mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, ${profile.accent}, ${profile.accent2}); }
.${cls} .links { display: flex; align-items: center; gap: 4px; }
.${cls} a { height: 34px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 8px; color: ${profile.muted}; text-decoration: none; font-size: 13px; transition: color 160ms, background 160ms; }
.${cls} a:hover, .${cls} a.active { color: ${profile.ink}; background: ${profile.panel}; }
.${cls} button { height: 34px; padding: 0 13px; border-radius: 8px; border: 1px solid ${profile.border}; background: ${profile.accent}; color: ${profile.onAccent}; font: inherit; font-size: 13px; cursor: pointer; }
@media (max-width: 720px) {
  .${cls} { align-items: stretch; flex-direction: column; }
  .${cls} .links { overflow-x: auto; padding-bottom: 2px; }
}`,
    html: `<nav class="${cls}">
  <div class="brand"><span class="mark"></span>Atelier OS</div>
  <div class="links">
    <a href="#" class="active">Overview</a>
    <a href="#">Systems</a>
    <a href="#">Signals</a>
    <a href="#">Archive</a>
  </div>
  <button>Compose</button>
</nav>`,
    designNotes: '导航宽度、间距和 active 背景固定，避免 hover 时跳动。',
    useCases: ['workspace-nav', 'product-console', 'portfolio-header'],
    accessibility: ['keyboard-visible', 'target-size-stable'],
    preview: preview(profile, 240),
    quality: quality('component', 'quiet'),
  };
}

function formAsset(profile) {
  const cls = `sig-${profile.theme}-form`;
  return {
    id: `signature-${profile.theme}-form`,
    name: `${profile.label} Form Stack`,
    category: 'form',
    themes: uniq([profile.theme]),
    tags: uniq(['signature', 'form', 'input', 'settings', 'focus', profile.theme]),
    description: `${profile.label} 表单栈，适合设置页、订阅入口、搜索筛选和 onboarding。`,
    stylePrompt: promptFor(profile, 'Form Stack', 'form', '表单必须有 label、辅助说明、输入、主动作和 focus 状态；不要把 placeholder 当成唯一标签'),
    css: `.${cls} {
  width: min(100%, 420px);
  display: grid;
  gap: 14px;
  padding: 22px;
  border: 1px solid ${profile.border};
  border-radius: ${profile.radius};
  background: ${profile.surface};
  color: ${profile.ink};
  box-shadow: ${profile.shadow};
}
.${cls} label { display: grid; gap: 7px; color: ${profile.ink}; font-size: 13px; font-weight: 700; }
.${cls} small { color: ${profile.muted}; font-size: 12px; line-height: 1.5; font-weight: 400; }
.${cls} .row { display: flex; gap: 10px; }
.${cls} input { min-width: 0; flex: 1; height: 40px; border-radius: 8px; border: 1px solid ${profile.border}; background: ${profile.panel}; color: ${profile.ink}; padding: 0 12px; font: inherit; outline: none; transition: border-color 160ms, box-shadow 160ms; }
.${cls} input:focus { border-color: ${profile.accent}; box-shadow: 0 0 0 3px color-mix(in srgb, ${profile.accent} 18%, transparent); }
.${cls} button { height: 40px; padding: 0 14px; border-radius: 8px; border: 1px solid ${profile.accent}; background: ${profile.accent}; color: ${profile.onAccent}; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
@media (max-width: 520px) { .${cls} .row { flex-direction: column; } }`,
    html: `<form class="${cls}">
  <label>
    Invite collaborator
    <small>Use a work email. Permissions can be adjusted later.</small>
  </label>
  <div class="row">
    <input type="email" value="design@atelier.dev" aria-label="Collaborator email" />
    <button type="button">Invite</button>
  </div>
</form>`,
    designNotes: '保留 label 和说明文字，避免只靠 placeholder 传递语义。',
    useCases: ['settings-form', 'invite-flow', 'search-filter'],
    accessibility: ['label-present', 'keyboard-visible', 'contrast-aa'],
    preview: preview(profile, 260),
    quality: quality('component', 'quiet'),
  };
}

function tableAsset(profile) {
  const cls = `sig-${profile.theme}-table`;
  return {
    id: `signature-${profile.theme}-table`,
    name: `${profile.label} Data Table`,
    category: 'table',
    themes: uniq([profile.theme]),
    tags: uniq(['signature', 'table', 'data', 'status', 'console', profile.theme]),
    description: `${profile.label} 数据表格，适合审计日志、任务队列、素材清单和运营后台。`,
    stylePrompt: promptFor(profile, 'Data Table', 'table', '表格强调密度、对齐、状态色和 hover 行反馈；表头小而清晰，数字使用 tabular-nums'),
    css: `.${cls} {
  width: min(100%, 760px);
  overflow: hidden;
  border: 1px solid ${profile.border};
  border-radius: ${profile.radius};
  background: ${profile.surface};
  color: ${profile.ink};
  box-shadow: ${profile.shadow};
}
.${cls} table { width: 100%; border-collapse: collapse; font-size: 13px; }
.${cls} th, .${cls} td { padding: 12px 14px; text-align: left; border-bottom: 1px solid ${profile.border}; }
.${cls} th { color: ${profile.muted}; font-size: 11px; font-weight: 760; text-transform: uppercase; letter-spacing: 0; background: ${profile.panel}; }
.${cls} td { color: ${profile.ink}; }
.${cls} tr:last-child td { border-bottom: 0; }
.${cls} tbody tr:hover td { background: ${profile.panel}; }
.${cls} .mono { font-variant-numeric: tabular-nums; }
.${cls} .status { display: inline-flex; align-items: center; gap: 6px; color: ${profile.accent}; font-weight: 700; }
.${cls} .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: ${profile.accent}; }`,
    html: `<div class="${cls}">
  <table>
    <thead><tr><th>Asset</th><th>Status</th><th>Score</th><th>Owner</th></tr></thead>
    <tbody>
      <tr><td>Hero System</td><td><span class="status">Ready</span></td><td class="mono">98</td><td>Design</td></tr>
      <tr><td>Form Stack</td><td><span class="status">Ready</span></td><td class="mono">96</td><td>Product</td></tr>
      <tr><td>Data Table</td><td><span class="status">Review</span></td><td class="mono">94</td><td>Ops</td></tr>
    </tbody>
  </table>
</div>`,
    designNotes: '表格使用真实字段和状态，不用装饰性占位图。',
    useCases: ['data-console', 'audit-log', 'asset-inventory'],
    accessibility: ['semantic-table', 'hover-not-required', 'tabular-numerals'],
    preview: preview(profile, 300),
    quality: quality('composition', 'quiet'),
  };
}

function signatureAssets(profile) {
  return [
    heroAsset(profile),
    cardAsset(profile),
    navAsset(profile),
    formAsset(profile),
    tableAsset(profile),
  ];
}

function descriptionFor(asset) {
  if (asset.description && String(asset.description).trim().length >= 36) return String(asset.description).trim();
  const themes = Array.isArray(asset.themes) ? asset.themes.join(' / ') : 'premium';
  const tags = Array.isArray(asset.tags) ? asset.tags.slice(0, 4).join('、') : 'interface';
  return `${asset.name} 是一款 ${themes} ${categoryLabels[asset.category] || asset.category}素材，适合 ${tags || '高级界面'} 场景，强调清晰层级、克制质感和可复制的前端实现。`;
}

function upgradePrompt(asset, profile) {
  const original = String(asset.stylePrompt || '').trim();
  if (original.includes('高级设计指令:')) return original;
  return [
    `高级设计指令: ${asset.name}`,
    `定位: ${descriptionFor(asset)}`,
    `审美系统: ${profile.label} / ${profile.tone}。使用 ${profile.accent} 作为主强调色，保持信息层级、留白、边界和字体重量的秩序感。`,
    `实现要求: 保留素材原有 class 和结构；补齐 hover/focus/active 状态；移动端避免横向溢出；动效必须轻、短、可关闭。`,
    `落地检查: 文字对比度达标，按钮和输入有稳定尺寸，卡片或面板不嵌套过深，状态颜色必须服务真实语义。`,
    '禁忌: 不要随机堆渐变、厚发光、廉价玻璃、过度圆角、无意义装饰符号或只有“高级感”口号但没有可用信息层级的设计。',
    original ? `原始风格要点:\n${original}` : '',
  ].filter(Boolean).join('\n');
}

function primaryClass(css, id) {
  return css.match(/\.([A-Za-z0-9_-]+)/)?.[1] || id;
}

function caseHtmlFor(asset, profile, css) {
  const cls = primaryClass(css, asset.id);
  const title = String(asset.name || 'Design Asset');
  const category = String(asset.category || 'component');

  if (category === 'background') {
    return `<section class="${cls}" style="width:100%;min-height:360px;display:grid;place-items:center;padding:32px;">
  <div style="position:relative;z-index:1;width:min(100%,520px);padding:26px;border:1px solid ${profile.border};border-radius:${profile.radius};background:${profile.panel};color:${profile.ink};box-shadow:${profile.shadow};">
    <div style="color:${profile.accent};font-size:12px;font-weight:700;text-transform:uppercase;">Background Case</div>
    <h2 style="margin:10px 0 8px;font-size:32px;line-height:1.08;letter-spacing:0;">${title}</h2>
    <p style="margin:0;color:${profile.muted};font-size:14px;line-height:1.7;">A real product hero preview using this background as the atmospheric system layer.</p>
  </div>
</section>`;
  }

  if (css.includes('stroke-dasharray')) {
    return `<svg viewBox="0 0 520 180" role="img" aria-label="${title} path animation" style="width:min(100%,520px);height:auto;overflow:visible;">
  <path d="M24 120 C116 34, 208 156, 300 72 S432 30, 496 104" fill="none" stroke="${profile.accent}" stroke-width="2.5" stroke-linecap="round" class="${cls}" />
  <circle cx="24" cy="120" r="4" fill="${profile.accent}" />
  <circle cx="496" cy="104" r="4" fill="${profile.accent2}" />
</svg>`;
  }

  if (cls.includes('skeleton')) {
    return `<article style="width:min(100%,380px);padding:22px;border:1px solid ${profile.border};border-radius:${profile.radius};background:${profile.surface};box-shadow:${profile.shadow};">
  <div class="${cls}" style="width:46%;height:14px;margin-bottom:18px;"></div>
  <div class="${cls}" style="width:100%;height:72px;margin-bottom:14px;"></div>
  <div class="${cls}" style="width:72%;height:12px;margin-bottom:10px;"></div>
  <div class="${cls}" style="width:54%;height:12px;"></div>
</article>`;
  }

  if (category === 'animation') {
    return `<article class="${cls}" style="width:min(100%,420px);padding:24px;border:1px solid ${profile.border};border-radius:${profile.radius};background:${profile.surface};color:${profile.ink};box-shadow:${profile.shadow};">
  <div style="color:${profile.accent};font-size:12px;font-weight:700;text-transform:uppercase;">Motion Case</div>
  <h3 style="margin:10px 0 8px;font-size:24px;line-height:1.15;">${title}</h3>
  <p style="margin:0;color:${profile.muted};font-size:14px;line-height:1.7;">Used as a product-state transition with a clear message and stable layout.</p>
</article>`;
  }

  if (category === 'effect') {
    return `<article class="${cls}" style="width:min(100%,390px);padding:24px;border:1px solid ${profile.border};border-radius:${profile.radius};background:${profile.surface};color:${profile.ink};box-shadow:${profile.shadow};">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:18px;">
    <div>
      <div style="color:${profile.accent};font-size:12px;font-weight:700;text-transform:uppercase;">Effect Case</div>
      <h3 style="margin:8px 0 6px;font-size:24px;line-height:1.15;">${title}</h3>
      <p style="margin:0;color:${profile.muted};font-size:13px;line-height:1.6;">Applied to a live status card, not as isolated decoration.</p>
    </div>
    <span style="width:42px;height:42px;border-radius:999px;background:${profile.accent};color:${profile.onAccent};display:grid;place-items:center;font-weight:800;">✓</span>
  </div>
</article>`;
  }

  return `<article class="${cls}" style="width:min(100%,380px);padding:24px;border:1px solid ${profile.border};border-radius:${profile.radius};background:${profile.surface};color:${profile.ink};box-shadow:${profile.shadow};">
  <div style="color:${profile.accent};font-size:12px;font-weight:700;text-transform:uppercase;">Component Case</div>
  <h3 style="margin:10px 0 8px;font-size:24px;line-height:1.15;">${title}</h3>
  <p style="margin:0;color:${profile.muted};font-size:14px;line-height:1.7;">Production-ready example with real content hierarchy.</p>
</article>`;
}

function upgradeExistingAsset(asset, profile, index) {
  const tags = uniq([...(Array.isArray(asset.tags) ? asset.tags : []), profile.theme]);
  const themes = uniq([...(Array.isArray(asset.themes) ? asset.themes : [profile.theme])]);
  const description = descriptionFor({ ...asset, tags, themes });
  const css = typeof asset.css === 'string' ? asset.css.trim() : '';
  const html = typeof asset.html === 'string' && asset.html.trim() ? asset.html.trim() : caseHtmlFor(asset, profile, css);
  const complexity = ['hero', 'layout', 'modal', 'table'].includes(asset.category) || css.split('\n').length > 42 ? 'composition' : html ? 'component' : 'drop-in';
  const score = Math.min(94, 78 + (description.length > 80 ? 4 : 0) + (css.split('\n').length > 16 ? 5 : 0) + (html ? 4 : 0) + (tags.length >= 5 ? 3 : 0));

  return {
    ...asset,
    themes,
    tags,
    description,
    stylePrompt: upgradePrompt({ ...asset, tags, themes, description }, profile),
    css,
    html,
    designNotes: asset.designNotes || `此素材已按 ${profile.label} 市场标准补齐提示词和落地约束。使用时优先保留核心比例、状态层级和命名空间 class。`,
    useCases: uniq(asset.useCases || [asset.category === 'button' ? 'primary-action' : undefined, asset.category === 'card' ? 'dashboard-panel' : undefined, asset.category === 'hero' ? 'landing-hero' : undefined, 'product-interface']).slice(0, 4),
    accessibility: uniq(asset.accessibility || ['contrast-aa', ['button', 'form', 'navigation', 'modal'].includes(asset.category) ? 'keyboard-visible' : undefined, tags.includes('animated') ? 'reduced-motion-friendly' : undefined]).slice(0, 4),
    preview: asset.preview || preview(profile, ['hero', 'layout'].includes(asset.category) ? 340 : 280),
    quality: asset.quality || { score, tier: score >= 90 ? 'production' : 'foundation', complexity, density: tags.includes('animated') || tags.includes('ornament') ? 'rich' : 'balanced' },
    sourceOrder: index,
  };
}

function readJsonArray(filePath) {
  if (!existsSync(filePath)) return [];
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  return Array.isArray(data) ? data : [];
}

function writeJsonArray(filePath, assets) {
  const seen = new Set();
  const deduped = [];
  for (const asset of assets) {
    if (!asset.id || seen.has(asset.id)) continue;
    seen.add(asset.id);
    deduped.push(asset);
  }
  writeFileSync(filePath, `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');
}

if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });

for (const profile of profiles) {
  const filePath = join(ASSETS_DIR, profile.file);
  const existing = readJsonArray(filePath)
    .filter(asset => !String(asset.id || '').startsWith(`signature-${profile.theme}-`))
    .map((asset, index) => upgradeExistingAsset(asset, profile, index));
  writeJsonArray(filePath, [...signatureAssets(profile), ...existing]);
}

const knownFiles = new Set(profiles.map(profile => profile.file));
for (const file of readdirSync(ASSETS_DIR).filter(file => file.endsWith('.json') && !knownFiles.has(file))) {
  const profile = profiles[0];
  const filePath = join(ASSETS_DIR, file);
  const existing = readJsonArray(filePath).map((asset, index) => upgradeExistingAsset(asset, profile, index));
  writeJsonArray(filePath, existing);
}

console.log(`Upgraded ${profiles.length} design-market theme files in ${ASSETS_DIR}`);
await import('./refine-design-signatures.mjs');
