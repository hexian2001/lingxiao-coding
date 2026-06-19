import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS_DIR = join(process.cwd(), 'skills/bundled/design-market/assets');

const collections = [
  {
    theme: 'dark',
    file: 'theme-dark.json',
    name: 'Nocturne Command',
    tone: '深色工程控制台',
    surface: '#0f1416',
    panel: 'rgba(239,242,241,0.055)',
    ink: '#eff2f1',
    muted: '#8c989a',
    accent: '#aebdc5',
    accent2: '#f2c673',
    onAccent: '#0f1416',
    border: 'rgba(210,219,222,0.16)',
    shadow: '0 28px 78px rgba(0,0,0,0.38)',
    radius: '14px',
    bg: 'radial-gradient(circle at 50% 0%, rgba(174,189,197,0.16), transparent 34%), linear-gradient(145deg, #0b0f11 0%, #171c1f 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'linear-gradient(90deg, rgba(174,189,197,0.10) 1px, transparent 1px), linear-gradient(0deg, rgba(174,189,197,0.06) 1px, transparent 1px)',
    motifSize: '36px 36px',
    heroTitle: 'Observe every system before it speaks.',
    heroBody: 'A quiet operations surface for release health, incidents, and agent decisions.',
    brand: 'Nocturne',
    links: ['Health', 'Runs', 'Incidents', 'Ledger'],
    cta: 'Open watch',
    metricA: '99.98',
    metricALabel: 'availability',
    metricB: '4.8m',
    metricBLabel: 'events shaped',
    field: 'Escalation channel',
    fieldHelp: 'Route only high-signal failures into the incident room.',
    fieldValue: 'release-watch@ops.dev',
    rows: [['Deploy gate', 'Clear', '99'], ['Agent loop', 'Watching', '42'], ['Registry', 'Quiet', '12']],
  },
  {
    theme: 'light',
    file: 'theme-light.json',
    name: 'Pearl Workspace',
    tone: '明亮办公产品系统',
    surface: '#ffffff',
    panel: '#f1f5f1',
    ink: '#172025',
    muted: '#667174',
    accent: '#526f7b',
    accent2: '#a77720',
    onAccent: '#ffffff',
    border: 'rgba(91,104,111,0.22)',
    shadow: '0 28px 70px rgba(48,75,86,0.14)',
    radius: '12px',
    bg: 'linear-gradient(145deg, #fbfcf8 0%, #e9eee8 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'linear-gradient(135deg, rgba(82,111,123,0.10), transparent 48%)',
    motifSize: 'auto',
    heroTitle: 'Make dense work feel composed.',
    heroBody: 'A daylight workspace for briefs, approvals, schedules, and handoff quality.',
    brand: 'Pearl OS',
    links: ['Briefs', 'Calendar', 'Review', 'Library'],
    cta: 'Plan day',
    metricA: '12',
    metricALabel: 'briefs ready',
    metricB: '3',
    metricBLabel: 'handoffs due',
    field: 'Project room',
    fieldHelp: 'Invite stakeholders without creating a noisy workspace.',
    fieldValue: 'spring-launch',
    rows: [['Creative brief', 'Approved', 'A'], ['QA pass', 'Open', 'B'], ['Launch copy', 'Draft', 'A']],
  },
  {
    theme: 'glassmorphism',
    file: 'theme-glassmorphism.json',
    name: 'Frosted Atrium',
    tone: '空间化玻璃控制层',
    surface: 'rgba(255,255,255,0.18)',
    panel: 'rgba(255,255,255,0.14)',
    ink: '#f8fbfa',
    muted: 'rgba(248,251,250,0.74)',
    accent: '#d9f3ff',
    accent2: '#f2c673',
    onAccent: '#102027',
    border: 'rgba(255,255,255,0.32)',
    shadow: '0 30px 78px rgba(8,19,25,0.26)',
    radius: '20px',
    bg: 'radial-gradient(circle at 22% 0%, rgba(174,189,200,0.55), transparent 34%), radial-gradient(circle at 78% 10%, rgba(242,198,115,0.28), transparent 30%), linear-gradient(135deg, #102027, #d8e3e4)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'radial-gradient(circle at 18% 20%, rgba(255,255,255,0.34), transparent 22%), radial-gradient(circle at 86% 80%, rgba(217,243,255,0.24), transparent 24%)',
    motifSize: 'auto',
    heroTitle: 'Layer decisions without hiding the room.',
    heroBody: 'A translucent command atrium for ambient status, previews, and live controls.',
    brand: 'Atrium',
    links: ['Layers', 'Previews', 'Rooms', 'Signals'],
    cta: 'Focus layer',
    metricA: '7',
    metricALabel: 'active panes',
    metricB: '84%',
    metricBLabel: 'clarity index',
    field: 'Review lens',
    fieldHelp: 'Name the current layer so collaborators know what is being judged.',
    fieldValue: 'visual-density',
    rows: [['North pane', 'Live', '84'], ['Brief layer', 'Pinned', '71'], ['Preview', 'Soft', '63']],
  },
  {
    theme: 'neumorphism',
    file: 'theme-neumorphism.json',
    name: 'Soft Instrument',
    tone: '低对比仪器面板',
    surface: '#e6ece8',
    panel: '#dce5e0',
    ink: '#243033',
    muted: '#6b777a',
    accent: '#526f7b',
    accent2: '#9b7c33',
    onAccent: '#ffffff',
    border: 'rgba(255,255,255,0.72)',
    shadow: '12px 12px 28px rgba(72,84,87,0.20), -12px -12px 28px rgba(255,255,255,0.84)',
    radius: '24px',
    bg: 'linear-gradient(145deg, #edf1ee 0%, #cbd5d2 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'linear-gradient(145deg, rgba(255,255,255,0.48), rgba(82,111,123,0.08))',
    motifSize: 'auto',
    heroTitle: 'Tune the system by touch.',
    heroBody: 'A tactile instrument surface for settings, thresholds, and gentle state changes.',
    brand: 'Instrument',
    links: ['Input', 'Tuning', 'Limits', 'Output'],
    cta: 'Balance',
    metricA: '0.42',
    metricALabel: 'signal gain',
    metricB: '18db',
    metricBLabel: 'noise floor',
    field: 'Threshold preset',
    fieldHelp: 'Use named presets so operators understand the effect before applying.',
    fieldValue: 'quiet-release',
    rows: [['Gain', 'Stable', '42'], ['Latency', 'Soft', '18'], ['Output', 'Ready', '91']],
  },
  {
    theme: 'brutalist',
    file: 'theme-brutalist.json',
    name: 'Museum Brutalist',
    tone: '美术馆式硬网格',
    surface: '#f8f1cf',
    panel: '#111111',
    ink: '#111111',
    muted: '#4c4636',
    accent: '#e03b2f',
    accent2: '#111111',
    onAccent: '#fff7d6',
    border: '#111111',
    shadow: '10px 10px 0 rgba(0,0,0,0.94)',
    radius: '0px',
    bg: 'linear-gradient(135deg, #f3f0dc 0%, #ece3bd 52%, #111111 52%, #111111 100%)',
    font: 'Arial, Helvetica, sans-serif',
    heading: 'Arial Black, Arial, Helvetica, sans-serif',
    motif: 'linear-gradient(90deg, rgba(17,17,17,0.12) 1px, transparent 1px), linear-gradient(0deg, rgba(17,17,17,0.12) 1px, transparent 1px)',
    motifSize: '24px 24px',
    heroTitle: 'Refuse decoration. Show the structure.',
    heroBody: 'A severe exhibition interface for catalogs, critical launches, and public records.',
    brand: 'ROOM 04',
    links: ['Index', 'Works', 'Wall Text', 'Archive'],
    cta: 'Issue pass',
    metricA: '04',
    metricALabel: 'rooms open',
    metricB: '128',
    metricBLabel: 'objects filed',
    field: 'Accession code',
    fieldHelp: 'Short, legible identifiers beat decorative labels in this system.',
    fieldValue: 'LX-2026-04',
    rows: [['Manifest', 'Public', '04'], ['Wall text', 'Set', '18'], ['Archive', 'Filed', '128']],
  },
  {
    theme: 'luxury',
    file: 'theme-luxury.json',
    name: 'Atelier Reserve',
    tone: '静奢编辑电商',
    surface: '#fbf8f1',
    panel: '#efe4d2',
    ink: '#211b16',
    muted: '#7a6b5d',
    accent: '#9a7738',
    accent2: '#2f2520',
    onAccent: '#fbf8f1',
    border: 'rgba(154,119,56,0.34)',
    shadow: '0 34px 80px rgba(62,44,28,0.16)',
    radius: '8px',
    bg: 'linear-gradient(145deg, #fbf8f1 0%, #e6dac8 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Georgia, Times New Roman, serif',
    motif: 'linear-gradient(90deg, rgba(154,119,56,0.20), transparent 28%, transparent 72%, rgba(47,37,32,0.12))',
    motifSize: 'auto',
    heroTitle: 'Reserve the object, not the noise.',
    heroBody: 'An editorial commerce system for limited releases, appointments, and quiet conversion.',
    brand: 'Maison Reserve',
    links: ['Objects', 'Atelier', 'Appointments', 'Journal'],
    cta: 'Reserve',
    metricA: '18',
    metricALabel: 'pieces remaining',
    metricB: '04',
    metricBLabel: 'private viewings',
    field: 'Appointment note',
    fieldHelp: 'Use precise, calm language. Luxury UI should never sound urgent.',
    fieldValue: 'Florentine leather review',
    rows: [['No. 18', 'Reserved', 'A'], ['No. 21', 'Viewing', 'B'], ['No. 24', 'Available', 'A']],
  },
  {
    theme: 'minimal',
    file: 'theme-minimal.json',
    name: 'Monastic Product',
    tone: '极简产品系统',
    surface: '#f7f8f5',
    panel: '#ecefeb',
    ink: '#151b1d',
    muted: '#667174',
    accent: '#111719',
    accent2: '#526f7b',
    onAccent: '#f7f8f5',
    border: 'rgba(21,27,29,0.16)',
    shadow: '0 24px 64px rgba(0,0,0,0.18)',
    radius: '10px',
    bg: 'linear-gradient(145deg, #101315 0%, #181d1f 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'linear-gradient(180deg, transparent, rgba(21,27,29,0.035))',
    motifSize: 'auto',
    heroTitle: 'One clear action. Nothing else.',
    heroBody: 'A restrained product surface for onboarding, focused creation, and zero-noise decisions.',
    brand: 'Plainform',
    links: ['Today', 'Drafts', 'Decisions', 'Archive'],
    cta: 'Begin',
    metricA: '1',
    metricALabel: 'primary path',
    metricB: '0',
    metricBLabel: 'visual debt',
    field: 'Workspace name',
    fieldHelp: 'A single noun is enough. The interface should not over-explain itself.',
    fieldValue: 'atelier',
    rows: [['Path', 'Single', '1'], ['Draft', 'Clean', '0'], ['Review', 'Ready', '1']],
  },
  {
    theme: 'retro',
    file: 'theme-retro.json',
    name: 'Analog Terminal',
    tone: '温暖复古软件',
    surface: '#22172b',
    panel: 'rgba(247,198,111,0.14)',
    ink: '#fff2d2',
    muted: '#d8b983',
    accent: '#f2c673',
    accent2: '#ff8c6a',
    onAccent: '#22172b',
    border: 'rgba(242,198,115,0.38)',
    shadow: '0 28px 76px rgba(31,15,35,0.38)',
    radius: '12px',
    bg: 'linear-gradient(135deg, #2a1730 0%, #674d2e 58%, #f2c673 100%)',
    font: 'JetBrains Mono, ui-monospace, monospace',
    heading: 'JetBrains Mono, ui-monospace, monospace',
    motif: 'repeating-linear-gradient(0deg, rgba(255,242,210,0.045) 0 1px, transparent 1px 5px)',
    motifSize: 'auto',
    heroTitle: 'Archive the signal before it fades.',
    heroBody: 'A warm terminal interface for logs, tapes, ledgers, and durable machine memory.',
    brand: 'TAPE-09',
    links: ['Log', 'Tape', 'Ledger', 'Export'],
    cta: 'Record',
    metricA: '09',
    metricALabel: 'tapes mounted',
    metricB: '742',
    metricBLabel: 'entries held',
    field: 'Tape label',
    fieldHelp: 'Retro systems feel premium when every label has operational meaning.',
    fieldValue: 'release-memory-09',
    rows: [['Tape A', 'Mounted', '742'], ['Checksum', 'Good', '100'], ['Export', 'Queued', '09']],
  },
  {
    theme: 'cyberpunk',
    file: 'theme-cyberpunk.json',
    name: 'Neon Infrastructure',
    tone: '克制赛博基础设施',
    surface: '#090b1a',
    panel: 'rgba(34,211,238,0.08)',
    ink: '#f8fbff',
    muted: '#93a4b8',
    accent: '#22d3ee',
    accent2: '#ff2bd6',
    onAccent: '#060817',
    border: 'rgba(34,211,238,0.34)',
    shadow: '0 30px 80px rgba(34,211,238,0.12)',
    radius: '10px',
    bg: 'radial-gradient(circle at 76% 8%, rgba(255,43,214,0.36), transparent 28%), radial-gradient(circle at 18% 86%, rgba(34,211,238,0.24), transparent 32%), linear-gradient(145deg, #060817 0%, #111827 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'linear-gradient(90deg, rgba(34,211,238,0.10) 1px, transparent 1px), linear-gradient(0deg, rgba(255,43,214,0.07) 1px, transparent 1px)',
    motifSize: '42px 42px',
    heroTitle: 'Route the city through one clean signal.',
    heroBody: 'A restrained neon operations layer for infrastructure, routing, and live telemetry.',
    brand: 'GRID/7',
    links: ['Nodes', 'Routes', 'Load', 'Trace'],
    cta: 'Trace node',
    metricA: '7',
    metricALabel: 'districts linked',
    metricB: '31ms',
    metricBLabel: 'route latency',
    field: 'Node alias',
    fieldHelp: 'Cyberpunk should feel like infrastructure, not a nightclub poster.',
    fieldValue: 'shanghai-north-07',
    rows: [['Node 07', 'Synced', '31'], ['Route C', 'Open', '88'], ['Relay', 'Hot', '12']],
  },
  {
    theme: 'organic',
    file: 'theme-organic.json',
    name: 'Living Field',
    tone: '自然生活方式系统',
    surface: '#f5f3e7',
    panel: '#dfe7d3',
    ink: '#233128',
    muted: '#60705f',
    accent: '#4f7b58',
    accent2: '#b08345',
    onAccent: '#f5f3e7',
    border: 'rgba(79,123,88,0.22)',
    shadow: '0 30px 70px rgba(68,92,68,0.18)',
    radius: '30px',
    bg: 'linear-gradient(135deg, #eef0df 0%, #bfd1b8 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Georgia, Times New Roman, serif',
    motif: 'radial-gradient(circle at 15% 20%, rgba(79,123,88,0.18), transparent 24%), radial-gradient(circle at 80% 74%, rgba(176,131,69,0.16), transparent 26%)',
    motifSize: 'auto',
    heroTitle: 'Let the interface breathe with the day.',
    heroBody: 'A living field system for rituals, wellness plans, agriculture, and slower decisions.',
    brand: 'Field Notes',
    links: ['Rituals', 'Garden', 'Weather', 'Journal'],
    cta: 'Plan ritual',
    metricA: '6:40',
    metricALabel: 'morning window',
    metricB: '18c',
    metricBLabel: 'soil warmth',
    field: 'Daily ritual',
    fieldHelp: 'Natural UI needs gentle structure, not decorative leaves everywhere.',
    fieldValue: 'breath + water + notes',
    rows: [['Sunrise', 'Open', '6:40'], ['Garden', 'Moist', '18'], ['Journal', 'Quiet', '03']],
  },
  {
    theme: 'editorial',
    file: 'theme-editorial.json',
    name: 'Index Magazine',
    tone: '出版级产品叙事',
    surface: '#fbfaf7',
    panel: '#151515',
    ink: '#151515',
    muted: '#6f6b63',
    accent: '#b03d2d',
    accent2: '#151515',
    onAccent: '#fbfaf7',
    border: 'rgba(21,21,21,0.22)',
    shadow: '0 28px 64px rgba(21,21,21,0.14)',
    radius: '4px',
    bg: 'linear-gradient(135deg, #fbfaf7 0%, #ddd8ce 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Georgia, Times New Roman, serif',
    motif: 'linear-gradient(90deg, rgba(21,21,21,0.08) 1px, transparent 1px)',
    motifSize: '84px 100%',
    heroTitle: 'Turn product facts into a readable issue.',
    heroBody: 'A magazine-grade interface for launches, reports, research indexes, and cultural products.',
    brand: 'INDEX 26',
    links: ['Features', 'Notes', 'Objects', 'Credits'],
    cta: 'Read issue',
    metricA: '12',
    metricALabel: 'features',
    metricB: '04',
    metricBLabel: 'essays',
    field: 'Issue title',
    fieldHelp: 'Editorial UI needs hierarchy, captions, and rhythm more than decoration.',
    fieldValue: 'systems of attention',
    rows: [['Feature', 'Lead', '12'], ['Essay', 'Edited', '04'], ['Credits', 'Set', '31']],
  },
  {
    theme: 'gradient',
    file: 'theme-gradient.json',
    name: 'Chromatic Engine',
    tone: '精密色彩计算系统',
    surface: 'rgba(255,255,255,0.14)',
    panel: 'rgba(13,19,24,0.34)',
    ink: '#ffffff',
    muted: 'rgba(255,255,255,0.76)',
    accent: '#f2c673',
    accent2: '#aebdc5',
    onAccent: '#111719',
    border: 'rgba(255,255,255,0.26)',
    shadow: '0 32px 86px rgba(16,28,38,0.30)',
    radius: '20px',
    bg: 'linear-gradient(135deg, #192033 0%, #526f7b 46%, #f2c673 100%)',
    font: 'Inter, ui-sans-serif, system-ui, sans-serif',
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    motif: 'conic-gradient(from 140deg at 70% 20%, rgba(242,198,115,0.34), rgba(174,189,197,0.20), transparent, rgba(242,198,115,0.34))',
    motifSize: 'auto',
    heroTitle: 'Color is data when it has a job.',
    heroBody: 'A chromatic system for AI surfaces, creative tools, and high-signal previews.',
    brand: 'Spectrum Lab',
    links: ['Model', 'Palette', 'Render', 'Export'],
    cta: 'Render',
    metricA: '8',
    metricALabel: 'palettes scored',
    metricB: '96',
    metricBLabel: 'harmony',
    field: 'Palette seed',
    fieldHelp: 'Use gradient only where it clarifies depth, state, or ownership.',
    fieldValue: 'aurora-526f',
    rows: [['Aurora', 'Balanced', '96'], ['Metal', 'Cool', '88'], ['Signal', 'Warm', '72']],
  },
  {
    theme: 'xianxia',
    file: 'theme-xianxia.json',
    name: 'Celestial Jade',
    tone: '克制东方玄幻界面',
    surface: 'rgba(16,29,25,0.88)',
    panel: 'rgba(218,191,124,0.10)',
    ink: '#f3ead2',
    muted: '#b7c3aa',
    accent: '#dabf7c',
    accent2: '#8fc7aa',
    onAccent: '#101d19',
    border: 'rgba(218,191,124,0.30)',
    shadow: '0 32px 82px rgba(4,8,7,0.40)',
    radius: '16px',
    bg: 'radial-gradient(circle at 50% 0%, rgba(218,191,124,0.32), transparent 34%), linear-gradient(160deg, #0f1518 0%, #20332e 58%, #111719 100%)',
    font: 'Inter, "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
    heading: '"Noto Serif SC", Georgia, serif',
    motif: 'radial-gradient(circle at 50% 0%, rgba(218,191,124,0.22), transparent 30%), linear-gradient(90deg, rgba(143,199,170,0.10), transparent)',
    motifSize: 'auto',
    heroTitle: '以玉为界，以气为序。',
    heroBody: '为宗门面板、修行任务、秘境状态和东方幻想产品建立克制而可信的界面秩序。',
    brand: '凌霄录',
    links: ['宗门', '秘境', '法器', '卷宗'],
    cta: '入境',
    metricA: '九',
    metricALabel: '重天阙',
    metricB: '72',
    metricBLabel: '灵脉稳定',
    field: '秘境名',
    fieldHelp: '仙侠界面要有东方秩序和留白，不能变成廉价游戏皮肤。',
    fieldValue: '青冥玉台',
    rows: [['青冥台', '开启', '72'], ['玉简', '已录', '18'], ['剑阵', '安定', '09']],
  },
];

const categoryNames = {
  hero: '首屏',
  card: '洞察卡片',
  navigation: '导航',
  form: '表单',
  table: '数据表',
};

function uniq(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim().toLowerCase()).filter(Boolean))];
}

function prompt(c, kind, focus) {
  return [
    `高级设计指令: ${c.name} ${categoryNames[kind]}`,
    `定位: ${c.tone}，用于真实产品场景，不做演示稿式换皮。`,
    `审美校准: 主体表面 ${c.surface}，主强调 ${c.accent}，辅助强调 ${c.accent2}。所有视觉都必须服务信息层级、阅读节奏和交互判断。`,
    `构图语法: ${focus}`,
    `工程要求: class 命名空间固定；hover/focus/active 状态完整；移动端不溢出；动效低幅度、低频率、可被 prefers-reduced-motion 降级。`,
    `真实案例: 文案、指标、状态、表格行和输入内容必须像真实业务，不允许使用 Lorem ipsum 或空洞口号。`,
    '禁忌: 禁止同构换皮、廉价大渐变、厚重发光、随机装饰、过度圆角、低对比文字、无语义状态色，以及只有“高级感”但没有信息结构的视觉噱头。',
  ].join('\n');
}

function preview(c, minHeight) {
  return { background: c.bg, minHeight, surface: ['light', 'neumorphism', 'luxury', 'organic', 'editorial'].includes(c.theme) ? 'light' : 'dark' };
}

function base(c, kind, css, html, focus, useCases, accessibility, density = 'balanced') {
  return {
    id: `signature-${c.theme}-${kind === 'navigation' ? 'nav' : kind}`,
    name: `${c.name} ${categoryNames[kind]}`,
    category: kind,
    themes: uniq([c.theme, c.theme === 'dark' ? 'minimal' : undefined, c.theme === 'luxury' ? 'editorial' : undefined]),
    tags: uniq(['signature', 'curated', 'premium', kind, c.theme, c.tone.replace(/\s+/g, '-')]),
    description: `${c.name} 的${categoryNames[kind]}素材，服务于${c.tone}，包含真实内容、明确状态和可直接落地的前端结构。`,
    stylePrompt: prompt(c, kind, focus),
    css,
    html,
    designNotes: `这不是换色模板；它使用 ${c.name} 的专属构图、材质和内容节奏。应用时保留信息层级，再替换业务文案。`,
    useCases,
    accessibility,
    pairsWith: [`signature-${c.theme}-hero`, `signature-${c.theme}-card`].filter(id => !id.endsWith(`-${kind}`)),
    preview: preview(c, kind === 'hero' ? 420 : kind === 'table' ? 320 : 280),
    quality: { score: 99, tier: 'signature', complexity: kind === 'hero' || kind === 'table' ? 'composition' : 'component', density },
  };
}

function hero(c) {
  const cls = `sig-${c.theme}-hero`;
  const css = `.${cls} {
  position: relative;
  width: min(100%, 980px);
  min-height: 440px;
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(260px, 0.82fr);
  gap: 34px;
  align-items: stretch;
  padding: 42px;
  overflow: hidden;
  border: 1px solid ${c.border};
  border-radius: ${c.radius};
  background: linear-gradient(145deg, ${c.surface}, ${c.panel});
  color: ${c.ink};
  box-shadow: ${c.shadow};
  font-family: ${c.font};
}
.${cls}::before { content: ""; position: absolute; inset: 0; background: ${c.motif}; background-size: ${c.motifSize}; opacity: 0.78; pointer-events: none; }
.${cls} > * { position: relative; z-index: 1; }
.${cls} .copy { display: grid; align-content: center; gap: 18px; }
.${cls} .kicker { width: fit-content; border: 1px solid ${c.border}; border-radius: 999px; padding: 6px 10px; color: ${c.accent}; background: ${c.panel}; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
.${cls} h1 { margin: 0; max-width: 620px; font-family: ${c.heading}; font-size: clamp(40px, 6.4vw, 70px); font-weight: 760; line-height: 0.98; letter-spacing: 0; }
.${cls} p { margin: 0; max-width: 560px; color: ${c.muted}; font-size: 15px; line-height: 1.78; }
.${cls} .actions { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 6px; }
.${cls} button { height: 40px; padding: 0 16px; border-radius: calc(${c.radius} / 2 + 4px); border: 1px solid ${c.border}; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), border-color 180ms; }
.${cls} .primary { background: ${c.accent}; color: ${c.onAccent}; border-color: ${c.accent}; }
.${cls} .secondary { background: transparent; color: ${c.ink}; }
.${cls} button:hover { transform: translateY(-1px); border-color: ${c.accent}; }
.${cls} .artifact { display: grid; align-content: space-between; gap: 18px; padding: 22px; border: 1px solid ${c.border}; border-radius: calc(${c.radius} - 2px); background: ${c.panel}; backdrop-filter: blur(18px) saturate(140%); }
.${cls} .artifact h2 { margin: 0; font-size: 13px; color: ${c.accent}; text-transform: uppercase; letter-spacing: 0; }
.${cls} .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.${cls} .metric { padding: 14px; border: 1px solid ${c.border}; border-radius: calc(${c.radius} - 4px); background: color-mix(in srgb, ${c.surface} 76%, transparent); }
.${cls} .metric strong { display: block; font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.${cls} .metric span { display: block; margin-top: 6px; color: ${c.muted}; font-size: 11px; }
.${cls} .rail { height: 9px; border-radius: 999px; background: linear-gradient(90deg, ${c.accent}, ${c.accent2}); }
@media (max-width: 780px) { .${cls} { grid-template-columns: 1fr; padding: 28px; } }`;
  const html = `<section class="${cls}">
  <div class="copy">
    <div class="kicker">${c.tone}</div>
    <h1>${c.heroTitle}</h1>
    <p>${c.heroBody}</p>
    <div class="actions"><button class="primary">${c.cta}</button><button class="secondary">View system</button></div>
  </div>
  <aside class="artifact">
    <h2>${c.brand} / Live brief</h2>
    <div class="metric-grid">
      <div class="metric"><strong>${c.metricA}</strong><span>${c.metricALabel}</span></div>
      <div class="metric"><strong>${c.metricB}</strong><span>${c.metricBLabel}</span></div>
    </div>
    <div class="rail"></div>
  </aside>
</section>`;
  return base(c, 'hero', css, html, '首屏必须把主题的业务世界讲清楚：一个可读主张、一个真实状态面板、两个明确动作。', ['landing-hero', 'product-introduction', 'campaign-cover'], ['contrast-aa', 'keyboard-visible', 'responsive-single-column'], 'rich');
}

function card(c) {
  const cls = `sig-${c.theme}-card`;
  const css = `.${cls} { width: min(100%, 390px); padding: 22px; border: 1px solid ${c.border}; border-radius: ${c.radius}; background: ${c.surface}; color: ${c.ink}; box-shadow: ${c.shadow}; font-family: ${c.font}; }
.${cls} .top { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.${cls} .label { color: ${c.accent}; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
.${cls} .pill { border: 1px solid ${c.border}; border-radius: 999px; padding: 5px 9px; color: ${c.muted}; background: ${c.panel}; font-size: 11px; }
.${cls} h3 { margin: 0 0 10px; font-family: ${c.heading}; font-size: 32px; line-height: 1; letter-spacing: 0; }
.${cls} p { margin: 0; color: ${c.muted}; font-size: 13px; line-height: 1.7; }
.${cls} .strip { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-top: 22px; padding-top: 16px; border-top: 1px solid ${c.border}; }
.${cls} .strip strong { font-variant-numeric: tabular-nums; color: ${c.ink}; }
.${cls} .signal { width: 38px; height: 38px; display: grid; place-items: center; border-radius: calc(${c.radius} - 4px); background: ${c.accent}; color: ${c.onAccent}; font-weight: 900; }`;
  const html = `<article class="${cls}">
  <div class="top"><div><div class="label">${c.brand}</div><h3>${c.metricA}</h3></div><span class="pill">${c.metricALabel}</span></div>
  <p>${c.heroBody}</p>
  <div class="strip"><span>${c.metricBLabel}</span><strong>${c.metricB}</strong><span>Status</span><span class="signal">✓</span></div>
</article>`;
  return base(c, 'card', css, html, '卡片必须有一个核心判断、一个状态胶囊、一组可读指标和解释文本。', ['dashboard-panel', 'status-summary', 'quality-metric'], ['contrast-aa', 'tabular-numerals'], 'balanced');
}

function nav(c) {
  const cls = `sig-${c.theme}-nav`;
  const css = `.${cls} { width: min(100%, 900px); min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 16px; border: 1px solid ${c.border}; border-radius: ${c.radius}; background: ${c.surface}; color: ${c.ink}; box-shadow: ${c.shadow}; font-family: ${c.font}; }
.${cls} .brand { display: flex; align-items: center; gap: 10px; min-width: max-content; font-family: ${c.heading}; font-size: 15px; font-weight: 800; letter-spacing: 0; }
.${cls} .mark { width: 30px; height: 30px; border-radius: calc(${c.radius} - 4px); background: linear-gradient(135deg, ${c.accent}, ${c.accent2}); box-shadow: inset 0 0 0 1px ${c.border}; }
.${cls} .links { display: flex; align-items: center; gap: 4px; min-width: 0; overflow-x: auto; }
.${cls} a { height: 34px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: calc(${c.radius} - 6px); color: ${c.muted}; text-decoration: none; font-size: 13px; transition: color 160ms, background 160ms; white-space: nowrap; }
.${cls} a:hover, .${cls} a.active { color: ${c.ink}; background: ${c.panel}; }
.${cls} button { height: 34px; padding: 0 13px; border-radius: calc(${c.radius} - 6px); border: 1px solid ${c.accent}; background: ${c.accent}; color: ${c.onAccent}; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; }
@media (max-width: 720px) { .${cls} { align-items: stretch; flex-direction: column; } }`;
  const html = `<nav class="${cls}">
  <div class="brand"><span class="mark"></span>${c.brand}</div>
  <div class="links">${c.links.map((link, index) => `<a href="#"${index === 0 ? ' class="active"' : ''}>${link}</a>`).join('')}</div>
  <button>${c.cta}</button>
</nav>`;
  return base(c, 'navigation', css, html, '导航只放品牌、关键入口和一个主动作，active 状态必须清楚但克制。', ['workspace-nav', 'product-console', 'portfolio-header'], ['keyboard-visible', 'target-size-stable'], 'quiet');
}

function form(c) {
  const cls = `sig-${c.theme}-form`;
  const css = `.${cls} { width: min(100%, 440px); display: grid; gap: 15px; padding: 22px; border: 1px solid ${c.border}; border-radius: ${c.radius}; background: ${c.surface}; color: ${c.ink}; box-shadow: ${c.shadow}; font-family: ${c.font}; }
.${cls} label { display: grid; gap: 7px; font-size: 13px; font-weight: 800; color: ${c.ink}; }
.${cls} small { color: ${c.muted}; font-size: 12px; line-height: 1.55; font-weight: 400; }
.${cls} .row { display: flex; gap: 10px; }
.${cls} input { min-width: 0; flex: 1; height: 42px; border-radius: calc(${c.radius} - 6px); border: 1px solid ${c.border}; background: ${c.panel}; color: ${c.ink}; padding: 0 12px; font: inherit; outline: none; transition: border-color 160ms, box-shadow 160ms; }
.${cls} input:focus { border-color: ${c.accent}; box-shadow: 0 0 0 3px color-mix(in srgb, ${c.accent} 18%, transparent); }
.${cls} button { height: 42px; padding: 0 14px; border-radius: calc(${c.radius} - 6px); border: 1px solid ${c.accent}; background: ${c.accent}; color: ${c.onAccent}; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; }
@media (max-width: 520px) { .${cls} .row { flex-direction: column; } }`;
  const html = `<form class="${cls}">
  <label>${c.field}<small>${c.fieldHelp}</small></label>
  <div class="row"><input value="${c.fieldValue}" aria-label="${c.field}" /><button type="button">${c.cta}</button></div>
</form>`;
  return base(c, 'form', css, html, '表单必须有 label、辅助说明、真实输入值和 focus 状态；不能用 placeholder 冒充信息。', ['settings-form', 'invite-flow', 'search-filter'], ['label-present', 'keyboard-visible', 'contrast-aa'], 'quiet');
}

function table(c) {
  const cls = `sig-${c.theme}-table`;
  const css = `.${cls} { width: min(100%, 780px); overflow: hidden; border: 1px solid ${c.border}; border-radius: ${c.radius}; background: ${c.surface}; color: ${c.ink}; box-shadow: ${c.shadow}; font-family: ${c.font}; }
.${cls} table { width: 100%; border-collapse: collapse; font-size: 13px; }
.${cls} th, .${cls} td { padding: 12px 14px; text-align: left; border-bottom: 1px solid ${c.border}; }
.${cls} th { color: ${c.muted}; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 0; background: ${c.panel}; }
.${cls} td { color: ${c.ink}; }
.${cls} tr:last-child td { border-bottom: 0; }
.${cls} tbody tr:hover td { background: ${c.panel}; }
.${cls} .mono { font-variant-numeric: tabular-nums; }
.${cls} .status { display: inline-flex; align-items: center; gap: 6px; color: ${c.accent}; font-weight: 800; }
.${cls} .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: ${c.accent}; }`;
  const html = `<div class="${cls}">
  <table>
    <thead><tr><th>Item</th><th>Status</th><th>Signal</th></tr></thead>
    <tbody>${c.rows.map(row => `<tr><td>${row[0]}</td><td><span class="status">${row[1]}</span></td><td class="mono">${row[2]}</td></tr>`).join('')}</tbody>
  </table>
</div>`;
  return base(c, 'table', css, html, '表格必须有真实字段、语义状态、数字对齐和行反馈，信息密度高但不压迫。', ['data-console', 'audit-log', 'asset-inventory'], ['semantic-table', 'hover-not-required', 'tabular-numerals'], 'quiet');
}

function signatureAssets(c) {
  return [hero(c), card(c), nav(c), form(c), table(c)];
}

function replaceSignatures(filePath, c) {
  const assets = JSON.parse(readFileSync(filePath, 'utf8'));
  const replacements = new Map(signatureAssets(c).map(asset => [asset.id, asset]));
  const output = assets.map(asset => replacements.get(asset.id) || asset);
  for (const asset of replacements.values()) {
    if (!output.some(item => item.id === asset.id)) output.unshift(asset);
  }
  writeFileSync(filePath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

if (!existsSync(ASSETS_DIR)) {
  console.error(`Missing design-market assets dir: ${ASSETS_DIR}`);
  process.exit(1);
}

const files = new Set(readdirSync(ASSETS_DIR).filter(file => file.endsWith('.json')));
for (const collection of collections) {
  if (!files.has(collection.file)) continue;
  replaceSignatures(join(ASSETS_DIR, collection.file), collection);
}

console.log(`Refined ${collections.length} signature design collections in ${ASSETS_DIR}`);
