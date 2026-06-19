export interface ThemeSiteQuality {
  score?: number;
  tier?: 'signature' | 'production' | 'foundation';
}

export interface ThemeSite {
  id: string;
  name: string;
  theme?: string;
  title?: string;
  subtitle?: string;
  description: string;
  summary?: string;
  scene?: string;
  prompt?: string;
  stylePrompt?: string;
  referencePrompt?: string;
  usageBoundary?: string;
  boundary?: string;
  previewHtml?: string;
  previewFile?: string;
  promptFile?: string;
  category?: string;
  version?: string;
  source?: string;
  tags?: string[];
  palette?: Record<string, string>;
  useCases?: string[];
  pages?: string[];
  sections?: string[];
  quality?: ThemeSiteQuality;
}

export type ThemeMode = 'light' | 'dark';
export type ModeFilter = 'all' | ThemeMode;
export type FontSignal = 'Sans' | 'Serif' | 'Mono';

export interface ThemeVisual {
  accent: string;
  accent2: string;
  surface: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  mode: ThemeMode;
  font: FontSignal;
}

export interface SystemMetric {
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'danger' | 'neutral';
}

export interface SystemRecord {
  name: string;
  owner: string;
  status: string;
  meta: string;
  progress: number;
  tone: 'good' | 'warn' | 'danger' | 'neutral';
}

export type SystemSurfaceKey =
  | 'auth'
  | 'onboarding'
  | 'workspace'
  | 'records'
  | 'detail'
  | 'workflow'
  | 'settings'
  | 'security'
  | 'audit'
  | 'states';

export interface SystemSurface {
  key: SystemSurfaceKey;
  label: string;
  title: string;
  description: string;
  primary: string;
  secondary: string;
  tone: SystemMetric['tone'];
}

export interface SystemSpec {
  product: string;
  context: string;
  operator: string;
  entity: string;
  actionPrimary: string;
  actionSecondary: string;
  nav: string[];
  modules: string[];
  metrics: SystemMetric[];
  lanes: Array<{ label: string; count: string; detail: string; tone: SystemMetric['tone'] }>;
  records: SystemRecord[];
  activity: string[];
  rules: string[];
}

interface SystemProfile {
  product: string;
  context: string;
  operator: string;
  entity: string;
  actionPrimary: string;
  actionSecondary: string;
  nav: string[];
  modules: string[];
  metrics: SystemMetric[];
  lanes: SystemSpec['lanes'];
  records: SystemRecord[];
  activity: string[];
  rules: string[];
}

export const THEME_LABELS: Record<string, string> = {
  dark: 'Dark',
  light: 'Light',
  glassmorphism: 'Glass',
  neumorphism: 'Neumorph',
  brutalist: 'Brutalist',
  luxury: 'Luxury',
  minimal: 'Minimal',
  retro: 'Retro',
  cyberpunk: 'Cyber',
  organic: 'Organic',
  editorial: 'Editorial',
  gradient: 'Gradient',
  xianxia: 'Xianxia',
};

export const THEME_VISUALS: Record<string, ThemeVisual> = {
  luxury: { accent: '#9a7738', accent2: '#d6b46a', surface: '#fbf8f1', panel: '#fffdf8', ink: '#211b16', muted: '#7a6b5d', line: 'rgba(154,119,56,0.28)', mode: 'light', font: 'Serif' },
  editorial: { accent: '#9a3f2d', accent2: '#c9b6a6', surface: '#fbfaf7', panel: '#ffffff', ink: '#201c19', muted: '#786f68', line: 'rgba(86,67,54,0.18)', mode: 'light', font: 'Serif' },
  xianxia: { accent: '#d6b46a', accent2: '#8fc7aa', surface: '#101d19', panel: '#14231f', ink: '#f3ead2', muted: '#b7c3aa', line: 'rgba(214,180,106,0.25)', mode: 'dark', font: 'Serif' },
  minimal: { accent: '#dfe5e2', accent2: '#7f8b8f', surface: '#101315', panel: '#181d1f', ink: '#eff2f1', muted: '#8c989a', line: 'rgba(223,229,226,0.14)', mode: 'dark', font: 'Sans' },
  dark: { accent: '#aebdc5', accent2: '#f2c673', surface: '#0f1416', panel: '#161d20', ink: '#eff2f1', muted: '#8c989a', line: 'rgba(210,219,222,0.15)', mode: 'dark', font: 'Mono' },
  cyberpunk: { accent: '#22d3ee', accent2: '#ff4fd8', surface: '#060817', panel: '#0a1020', ink: '#f8fbff', muted: '#8da3b8', line: 'rgba(34,211,238,0.25)', mode: 'dark', font: 'Sans' },
  organic: { accent: '#5e7f55', accent2: '#d7b46a', surface: '#eef0df', panel: '#fbfbf1', ink: '#243022', muted: '#69725e', line: 'rgba(94,127,85,0.24)', mode: 'light', font: 'Serif' },
  glassmorphism: { accent: '#9cc9d8', accent2: '#d8c7ff', surface: '#15212a', panel: 'rgba(232,241,244,0.12)', ink: '#eef8fb', muted: '#a7bac2', line: 'rgba(205,232,241,0.22)', mode: 'dark', font: 'Sans' },
  gradient: { accent: '#f4769f', accent2: '#78d5ff', surface: '#172034', panel: '#202941', ink: '#f8fbff', muted: '#b2bfd7', line: 'rgba(120,213,255,0.18)', mode: 'dark', font: 'Sans' },
  brutalist: { accent: '#e43d30', accent2: '#111111', surface: '#f3f0dc', panel: '#fffcef', ink: '#111111', muted: '#5f5a4f', line: 'rgba(17,17,17,0.28)', mode: 'light', font: 'Mono' },
  light: { accent: '#526f7b', accent2: '#a77720', surface: '#f7f9f4', panel: '#ffffff', ink: '#172025', muted: '#667174', line: 'rgba(91,104,111,0.22)', mode: 'light', font: 'Sans' },
  neumorphism: { accent: '#71879a', accent2: '#f7fbff', surface: '#e7edf2', panel: '#edf3f7', ink: '#26323a', muted: '#667784', line: 'rgba(88,104,117,0.18)', mode: 'light', font: 'Sans' },
  retro: { accent: '#f2c673', accent2: '#33ff99', surface: '#17100f', panel: '#241817', ink: '#ffe9b8', muted: '#be9e78', line: 'rgba(242,198,115,0.22)', mode: 'dark', font: 'Mono' },
};

const SYSTEM_PROFILES: Record<string, SystemProfile> = {
  luxury: {
    product: 'Maison Reserve OS',
    context: '限量商品预约运营系统',
    operator: 'Private Client Team',
    entity: '预约编号',
    actionPrimary: '确认私享时段',
    actionSecondary: '查看编号库存',
    nav: ['总览', '预约队列', '编号库存', '顾问确认', '会员档案', '规则'],
    modules: ['实时预约总览', '编号库存表', '顾问分派流', '候补规则'],
    metrics: [
      { label: '可预约编号', value: '42', detail: '6 个高优先级', tone: 'good' },
      { label: '候补人数', value: '118', detail: '较昨日 +9', tone: 'warn' },
      { label: '平均确认', value: '18m', detail: '目标 30m 内', tone: 'good' },
      { label: '锁定库存', value: '14', detail: '需顾问复核', tone: 'neutral' },
    ],
    lanes: [
      { label: '新预约', count: '24', detail: '等待资质确认', tone: 'neutral' },
      { label: '顾问处理中', count: '17', detail: '平均响应 8m', tone: 'good' },
      { label: '候补观察', count: '31', detail: '编号冲突 4', tone: 'warn' },
      { label: '已锁定', count: '14', detail: '待尾款确认', tone: 'good' },
    ],
    records: [
      { name: 'No. 017 牛皮托特预约', owner: 'Mira Chen', status: '顾问确认', meta: '今日 14:20', progress: 72, tone: 'good' },
      { name: 'No. 023 香槟金手包', owner: 'Y. Laurent', status: '候补观察', meta: '等待编号释放', progress: 46, tone: 'warn' },
      { name: 'No. 031 私享看货', owner: 'Ava Lin', status: '资料补充', meta: '缺偏好时段', progress: 38, tone: 'neutral' },
      { name: 'No. 004 家具定制咨询', owner: 'Noah Wen', status: '已锁定', meta: '19:00 到店', progress: 92, tone: 'good' },
    ],
    activity: ['顾问 Mira 锁定 No.017 的 16:30 时段', '候补规则将 4 个重复编号合并', '库存同步完成，新增 3 个可看货编号', '会员 Ava 补充材质偏好'],
    rules: ['高价值编号需双人确认', '候补自动按会员等级与响应时间排序', '预约超 18 分钟未确认进入提醒队列', '同一手机号不可占用两个看货时段'],
  },
  editorial: {
    product: 'Index Desk',
    context: '编辑专题生产系统',
    operator: 'Editorial Operations',
    entity: '稿件包',
    actionPrimary: '排入出版节奏',
    actionSecondary: '审阅版面批注',
    nav: ['节奏', '选题', '稿件', '版面', '校对', '归档'],
    modules: ['出版节奏', '稿件状态', '版面批注', '校对清单'],
    metrics: [
      { label: '本周专题', value: '9', detail: '2 个待主编', tone: 'neutral' },
      { label: '校对完成率', value: '86%', detail: '+12% 本周', tone: 'good' },
      { label: '版面冲突', value: '3', detail: '需今晚处理', tone: 'warn' },
      { label: '引用风险', value: '1', detail: '法务复核中', tone: 'danger' },
    ],
    lanes: [
      { label: '选题确认', count: '12', detail: '编辑已认领', tone: 'good' },
      { label: '撰写中', count: '18', detail: '4 篇临近截稿', tone: 'warn' },
      { label: '版面中', count: '7', detail: '跨页 2 组', tone: 'neutral' },
      { label: '已归档', count: '29', detail: '本月合集', tone: 'good' },
    ],
    records: [
      { name: '城市观察封面稿', owner: 'Iris Wu', status: '主编审阅', meta: '截稿 18:00', progress: 74, tone: 'warn' },
      { name: '设计师访谈组稿', owner: 'Ken Zhou', status: '版面调整', meta: '跨页 A12', progress: 61, tone: 'neutral' },
      { name: '数据图表引用', owner: 'Mei Sun', status: '法务复核', meta: '引用来源缺失', progress: 32, tone: 'danger' },
      { name: '季度索引归档', owner: 'Ops Desk', status: '完成', meta: '已发布', progress: 100, tone: 'good' },
    ],
    activity: ['主编批注城市观察封面稿', '版面系统释放 A12 跨页', '法务标记 1 条引用风险', '校对完成季度索引归档'],
    rules: ['封面稿必须有事实核验记录', '跨页版面变动自动通知摄影与编辑', '引用风险未清除禁止进入发布', '归档保留批注与版本差异'],
  },
  xianxia: {
    product: 'Celestial Sect Console',
    context: '宗门任务与秘境档案系统',
    operator: '执事堂',
    entity: '秘境卷宗',
    actionPrimary: '开启秘境窗口',
    actionSecondary: '调阅任务榜',
    nav: ['宗门总览', '秘境', '任务榜', '弟子', '灵脉', '封印'],
    modules: ['秘境开放窗口', '任务编组', '灵脉稳定度', '卷宗审签'],
    metrics: [
      { label: '开放秘境', value: '7', detail: '2 个高风险', tone: 'warn' },
      { label: '灵脉稳定', value: '91%', detail: '辰时复测', tone: 'good' },
      { label: '待审卷宗', value: '23', detail: '长老签批 5', tone: 'neutral' },
      { label: '封印告警', value: '1', detail: '西岭裂隙', tone: 'danger' },
    ],
    lanes: [
      { label: '可入境', count: '5', detail: '队伍齐备', tone: 'good' },
      { label: '资质核验', count: '11', detail: '缺阵修 3', tone: 'neutral' },
      { label: '灵压观测', count: '4', detail: '需复测', tone: 'warn' },
      { label: '封存', count: '2', detail: '风险过高', tone: 'danger' },
    ],
    records: [
      { name: '青岚秘境甲字号', owner: '云衡小队', status: '可入境', meta: '子时开放', progress: 88, tone: 'good' },
      { name: '西岭裂隙观测', owner: '灵脉司', status: '封印告警', meta: '灵压异常', progress: 24, tone: 'danger' },
      { name: '丹房护送任务', owner: '外门三队', status: '资质核验', meta: '缺阵修', progress: 54, tone: 'neutral' },
      { name: '古镜卷宗复核', owner: '藏经阁', status: '长老签批', meta: '第七卷', progress: 67, tone: 'warn' },
    ],
    activity: ['执事堂更新青岚秘境开放窗口', '灵脉司标记西岭裂隙为高危', '藏经阁上传第七卷复核批注', '外门三队补交阵修名册'],
    rules: ['秘境开放需灵压连续三次稳定', '高危裂隙自动冻结入境资格', '任务队伍必须满足心法与阵修配比', '卷宗签批保留长老印记与版本'],
  },
  minimal: {
    product: 'Decision Desk',
    context: '极简决策与事项系统',
    operator: 'Product Council',
    entity: '决策项',
    actionPrimary: '推进决策',
    actionSecondary: '查看证据',
    nav: ['Inbox', 'Evidence', 'Risks', 'Review', 'Archive', 'Rules'],
    modules: ['决策队列', '证据面板', '风险约束', '复盘记录'],
    metrics: [
      { label: 'Open', value: '18', detail: '6 need owner', tone: 'neutral' },
      { label: 'Clarity', value: '82%', detail: 'source attached', tone: 'good' },
      { label: 'Risk', value: '4', detail: 'blocking', tone: 'warn' },
      { label: 'Cycle', value: '2.4d', detail: '-18%', tone: 'good' },
    ],
    lanes: [
      { label: 'Intake', count: '8', detail: 'unscored', tone: 'neutral' },
      { label: 'Evidence', count: '12', detail: 'ready', tone: 'good' },
      { label: 'Review', count: '5', detail: 'agenda', tone: 'warn' },
      { label: 'Closed', count: '31', detail: 'this month', tone: 'good' },
    ],
    records: [
      { name: 'Model routing policy', owner: 'Ari', status: 'Evidence ready', meta: '4 linked notes', progress: 84, tone: 'good' },
      { name: 'Workspace permission copy', owner: 'Lin', status: 'Review', meta: 'Council Friday', progress: 63, tone: 'warn' },
      { name: 'Billing event schema', owner: 'Noa', status: 'Needs owner', meta: 'unassigned', progress: 21, tone: 'neutral' },
      { name: 'Audit export scope', owner: 'Kai', status: 'Closed', meta: 'accepted', progress: 100, tone: 'good' },
    ],
    activity: ['Ari attached evidence to routing policy', 'Council moved permission copy to review', 'Noa requested schema owner', 'Kai closed audit export scope'],
    rules: ['No decision without owner', 'Every review needs evidence', 'Blocking risk requires explicit fallback', 'Closed decisions keep audit context'],
  },
  dark: {
    product: 'Nocturne Ops',
    context: 'SRE 事故响应控制台',
    operator: 'On-call Runtime',
    entity: 'Incident',
    actionPrimary: '执行 Runbook',
    actionSecondary: '打开影响面',
    nav: ['Overview', 'Incidents', 'Services', 'Runbooks', 'Audit', 'Settings'],
    modules: ['事故队列', '服务健康', 'Runbook 执行', '审计日志'],
    metrics: [
      { label: 'SEV-1', value: '0', detail: 'clear 14d', tone: 'good' },
      { label: 'Active', value: '6', detail: '2 watching', tone: 'warn' },
      { label: 'MTTR', value: '11m', detail: '-7m', tone: 'good' },
      { label: 'Error budget', value: '72%', detail: 'safe', tone: 'neutral' },
    ],
    lanes: [
      { label: 'Triage', count: '4', detail: 'routing', tone: 'warn' },
      { label: 'Mitigating', count: '2', detail: 'runbook live', tone: 'neutral' },
      { label: 'Monitoring', count: '9', detail: 'auto close', tone: 'good' },
      { label: 'Resolved', count: '37', detail: '7 days', tone: 'good' },
    ],
    records: [
      { name: 'API p95 latency spike', owner: 'SRE West', status: 'Mitigating', meta: 'runbook step 3', progress: 66, tone: 'warn' },
      { name: 'Queue consumer lag', owner: 'Runtime', status: 'Monitoring', meta: 'lag < 200', progress: 81, tone: 'good' },
      { name: 'Auth token refresh', owner: 'Identity', status: 'Triage', meta: 'impact 2%', progress: 43, tone: 'neutral' },
      { name: 'Search deploy gate', owner: 'Release', status: 'Resolved', meta: 'rollback ready', progress: 100, tone: 'good' },
    ],
    activity: ['Runtime executed cache warmup runbook', 'SRE West acknowledged API latency', 'Identity attached auth trace', 'Release marked search gate safe'],
    rules: ['SEV escalation requires owner within 4 minutes', 'Runbook steps write audit entries', 'Rollback window blocks non-critical deploys', 'Monitoring closes after three clean probes'],
  },
  cyberpunk: {
    product: 'Signal Router',
    context: '网络遥测与路由调度系统',
    operator: 'NOC Edge',
    entity: 'Route',
    actionPrimary: 'Trace Route',
    actionSecondary: 'Inspect POP',
    nav: ['Telemetry', 'Routes', 'POPs', 'Incidents', 'Traffic', 'Policy'],
    modules: ['链路遥测', 'POP 健康', '路由策略', '异常处置'],
    metrics: [
      { label: 'p95 latency', value: '42ms', detail: 'global edge', tone: 'good' },
      { label: 'packet loss', value: '0.08%', detail: 'safe', tone: 'good' },
      { label: 'BGP alerts', value: '3', detail: 'Tokyo POP', tone: 'warn' },
      { label: 'convergence', value: '19s', detail: 'target 30s', tone: 'neutral' },
    ],
    lanes: [
      { label: 'Healthy', count: '146', detail: 'POP sessions', tone: 'good' },
      { label: 'Rerouting', count: '8', detail: 'policy active', tone: 'warn' },
      { label: 'Investigate', count: '3', detail: 'loss variance', tone: 'danger' },
      { label: 'Suppressed', count: '22', detail: 'noise filter', tone: 'neutral' },
    ],
    records: [
      { name: 'TYO-2 route convergence', owner: 'NOC Edge', status: 'Rerouting', meta: 'ASN 64512', progress: 71, tone: 'warn' },
      { name: 'SFO packet loss probe', owner: 'Telemetry', status: 'Healthy', meta: '0.02%', progress: 94, tone: 'good' },
      { name: 'FRA BGP flap', owner: 'Routing', status: 'Investigate', meta: '3 flaps / h', progress: 36, tone: 'danger' },
      { name: 'SIN transit policy', owner: 'Traffic Eng', status: 'Suppressed', meta: 'noise rule', progress: 58, tone: 'neutral' },
    ],
    activity: ['NOC Edge rerouted TYO-2 through backup carrier', 'Telemetry cleared SFO packet loss probe', 'Routing opened FRA BGP incident', 'Policy suppressed duplicate SIN alerts'],
    rules: ['Packet loss over 0.2% opens incident', 'BGP flap suppression expires after 20 minutes', 'Traffic shifts require rollback route', 'Every POP status includes probe source'],
  },
  organic: {
    product: 'Living Field',
    context: '会员习惯与健康计划系统',
    operator: 'Care Studio',
    entity: '习惯计划',
    actionPrimary: '调整计划',
    actionSecondary: '查看日志',
    nav: ['Overview', 'Members', 'Plans', 'Rituals', 'Signals', 'Care'],
    modules: ['会员节律', '计划进度', '关怀日志', '风险提醒'],
    metrics: [
      { label: '活跃计划', value: '328', detail: '本周 +26', tone: 'good' },
      { label: '连续完成', value: '74%', detail: '高于目标', tone: 'good' },
      { label: '需关怀', value: '19', detail: '两天未打卡', tone: 'warn' },
      { label: '睡眠改善', value: '+11%', detail: '28 天均值', tone: 'neutral' },
    ],
    lanes: [
      { label: '稳定', count: '211', detail: '节律正常', tone: 'good' },
      { label: '轻提醒', count: '72', detail: '缺一次', tone: 'neutral' },
      { label: '需关怀', count: '19', detail: '教练跟进', tone: 'warn' },
      { label: '暂停', count: '8', detail: '旅行中', tone: 'neutral' },
    ],
    records: [
      { name: '晨间伸展计划', owner: 'Luna', status: '稳定', meta: '12 天连续', progress: 86, tone: 'good' },
      { name: '睡眠修复节律', owner: 'Moss', status: '需关怀', meta: '2 天未打卡', progress: 42, tone: 'warn' },
      { name: '晚间饮水提醒', owner: 'Ivy', status: '轻提醒', meta: '今晚 21:30', progress: 63, tone: 'neutral' },
      { name: '旅行低负担计划', owner: 'Fern', status: '暂停', meta: '下周恢复', progress: 28, tone: 'neutral' },
    ],
    activity: ['Care Studio 调整 Luna 的晨间计划', 'Moss 触发两天未打卡提醒', 'Ivy 完成饮水日志', 'Fern 标记旅行低负担模式'],
    rules: ['连续缺勤两天进入关怀队列', '睡眠计划每 7 天复核目标', '旅行模式不计入失败次数', '教练备注必须关联可执行动作'],
  },
  glassmorphism: {
    product: 'Atrium Workspace',
    context: 'AI 工作流协同系统',
    operator: 'Workspace Pilot',
    entity: '工作流',
    actionPrimary: '启动编排',
    actionSecondary: '查看上下文',
    nav: ['Studio', 'Agents', 'Flows', 'Context', 'Approvals', 'Memory'],
    modules: ['Agent 编排', '上下文面板', '审批队列', '记忆索引'],
    metrics: [
      { label: 'Active flows', value: '16', detail: '4 waiting', tone: 'neutral' },
      { label: 'Context fit', value: '91%', detail: 'clean', tone: 'good' },
      { label: 'Approvals', value: '7', detail: '2 risky', tone: 'warn' },
      { label: 'Memory hits', value: '284', detail: '+18%', tone: 'good' },
    ],
    lanes: [
      { label: 'Drafting', count: '6', detail: 'agents live', tone: 'neutral' },
      { label: 'Review', count: '7', detail: 'human gate', tone: 'warn' },
      { label: 'Applied', count: '18', detail: 'merged', tone: 'good' },
      { label: 'Blocked', count: '2', detail: 'permission', tone: 'danger' },
    ],
    records: [
      { name: 'Docs refactor flow', owner: 'Agent Alpha', status: 'Review', meta: 'human gate', progress: 68, tone: 'warn' },
      { name: 'Release note synthesis', owner: 'Agent Lyra', status: 'Applied', meta: 'merged', progress: 100, tone: 'good' },
      { name: 'API audit pass', owner: 'Agent Vector', status: 'Drafting', meta: '2 tools active', progress: 57, tone: 'neutral' },
      { name: 'Filesystem change', owner: 'Workspace Pilot', status: 'Blocked', meta: 'permission', progress: 22, tone: 'danger' },
    ],
    activity: ['Agent Alpha requested review for docs flow', 'Memory index linked 18 prior decisions', 'Workspace Pilot blocked risky file change', 'Agent Lyra finalized release notes'],
    rules: ['Risky tools require approval', 'Context over budget triggers compression', 'Applied flows write memory summaries', 'Blocked actions keep rationale visible'],
  },
  gradient: {
    product: 'Chromatic Engine',
    context: 'AI 创意生产控制系统',
    operator: 'Creative Ops',
    entity: '生成批次',
    actionPrimary: '启动生成',
    actionSecondary: '校准风格',
    nav: ['Board', 'Batches', 'Prompts', 'Review', 'Assets', 'Rules'],
    modules: ['生成队列', '风格校准', '评审栈', '资产归档'],
    metrics: [
      { label: '批次', value: '38', detail: '本日', tone: 'neutral' },
      { label: '通过率', value: '79%', detail: '+6%', tone: 'good' },
      { label: '风格偏移', value: '5', detail: '需校准', tone: 'warn' },
      { label: '可交付', value: '142', detail: '已归档', tone: 'good' },
    ],
    lanes: [
      { label: 'Prompting', count: '11', detail: 'draft', tone: 'neutral' },
      { label: 'Generating', count: '9', detail: 'GPU live', tone: 'warn' },
      { label: 'Review', count: '23', detail: 'curation', tone: 'neutral' },
      { label: 'Approved', count: '142', detail: 'assets', tone: 'good' },
    ],
    records: [
      { name: 'Campaign hero batch', owner: 'Nora', status: 'Generating', meta: '12 variants', progress: 64, tone: 'warn' },
      { name: 'Product texture pass', owner: 'Kite', status: 'Review', meta: 'needs crop', progress: 58, tone: 'neutral' },
      { name: 'Social motion stills', owner: 'Mika', status: 'Approved', meta: '24 files', progress: 100, tone: 'good' },
      { name: 'Tone calibration set', owner: 'Creative Ops', status: 'Prompting', meta: 'brand drift', progress: 31, tone: 'neutral' },
    ],
    activity: ['Nora launched campaign hero variants', 'Kite flagged texture crop issue', 'Mika approved social stills', 'Creative Ops adjusted tone calibration'],
    rules: ['Every batch needs reference lock', 'Style drift over 8% returns to prompt', 'Approved assets require usage tags', 'Reviewers see before/after prompt deltas'],
  },
  brutalist: {
    product: 'Archive Machine',
    context: '美术馆藏品与借展系统',
    operator: 'Collections Office',
    entity: '藏品记录',
    actionPrimary: '批准借展',
    actionSecondary: '打开档案',
    nav: ['Index', 'Loans', 'Objects', 'Condition', 'Couriers', 'Rules'],
    modules: ['借展队列', '藏品索引', '状态报告', '运输规则'],
    metrics: [
      { label: '借展申请', value: '26', detail: '4 urgent', tone: 'warn' },
      { label: '状态报告', value: '91%', detail: 'complete', tone: 'good' },
      { label: '温控风险', value: '2', detail: 'crate check', tone: 'danger' },
      { label: '待归档', value: '14', detail: 'scan batch', tone: 'neutral' },
    ],
    lanes: [
      { label: 'Request', count: '26', detail: 'incoming', tone: 'neutral' },
      { label: 'Condition', count: '12', detail: 'exam', tone: 'warn' },
      { label: 'Transit', count: '8', detail: 'courier', tone: 'neutral' },
      { label: 'Approved', count: '31', detail: 'this quarter', tone: 'good' },
    ],
    records: [
      { name: 'Object A-194 loan', owner: 'M. Reyes', status: 'Condition', meta: 'humidity note', progress: 52, tone: 'warn' },
      { name: 'Crate temperature log', owner: 'Transit', status: 'Risk', meta: '2 excursions', progress: 29, tone: 'danger' },
      { name: 'Plate archive scan', owner: 'Index Team', status: 'Pending', meta: 'batch 7', progress: 41, tone: 'neutral' },
      { name: 'Courier route packet', owner: 'Collections', status: 'Approved', meta: 'signed', progress: 100, tone: 'good' },
    ],
    activity: ['Collections approved courier route packet', 'Transit flagged crate temperature excursions', 'Index Team queued plate archive scan', 'M. Reyes requested condition photo'],
    rules: ['Loans require condition report', 'Temperature excursions block dispatch', 'Courier packet must be signed', 'Archive scans keep object checksum'],
  },
  light: {
    product: 'Brief Handoff',
    context: '跨团队交接与审批系统',
    operator: 'Program Office',
    entity: '交接包',
    actionPrimary: '发起交接',
    actionSecondary: '查看风险',
    nav: ['Home', 'Briefs', 'Approvals', 'Risks', 'Calendar', 'Settings'],
    modules: ['交接清单', '审批链', '风险雷达', '会议节奏'],
    metrics: [
      { label: '进行中', value: '32', detail: '8 due today', tone: 'warn' },
      { label: '准时率', value: '88%', detail: '+4%', tone: 'good' },
      { label: '阻塞项', value: '5', detail: 'owner needed', tone: 'danger' },
      { label: '已交付', value: '117', detail: 'quarter', tone: 'good' },
    ],
    lanes: [
      { label: 'Draft', count: '9', detail: 'needs scope', tone: 'neutral' },
      { label: 'Review', count: '14', detail: 'approval', tone: 'warn' },
      { label: 'Ready', count: '18', detail: 'handoff', tone: 'good' },
      { label: 'Blocked', count: '5', detail: 'missing owner', tone: 'danger' },
    ],
    records: [
      { name: 'Q3 launch handoff', owner: 'Program', status: 'Review', meta: 'due today', progress: 72, tone: 'warn' },
      { name: 'Sales enablement brief', owner: 'GTM', status: 'Ready', meta: 'all owners', progress: 91, tone: 'good' },
      { name: 'Design QA packet', owner: 'Design Ops', status: 'Blocked', meta: 'no QA owner', progress: 34, tone: 'danger' },
      { name: 'Partner calendar sync', owner: 'BizOps', status: 'Draft', meta: 'scope missing', progress: 44, tone: 'neutral' },
    ],
    activity: ['Program moved Q3 launch handoff to review', 'GTM completed sales enablement brief', 'Design Ops flagged missing QA owner', 'BizOps added partner calendar dependency'],
    rules: ['Every brief needs owner and deadline', 'Blocked handoffs surface in daily digest', 'Approvals keep decision comments', 'Ready handoffs require risk acknowledgement'],
  },
  neumorphism: {
    product: 'Soft Instrument',
    context: '设备参数与阈值系统',
    operator: 'Device Lab',
    entity: '参数集',
    actionPrimary: '应用参数',
    actionSecondary: '比较版本',
    nav: ['Control', 'Devices', 'Profiles', 'Thresholds', 'Logs', 'Lab'],
    modules: ['设备状态', '参数版本', '阈值规则', '校准记录'],
    metrics: [
      { label: '在线设备', value: '84', detail: 'lab + field', tone: 'good' },
      { label: '待校准', value: '11', detail: 'scheduled', tone: 'warn' },
      { label: '阈值漂移', value: '2', detail: 'manual check', tone: 'danger' },
      { label: '版本一致', value: '96%', detail: 'stable', tone: 'good' },
    ],
    lanes: [
      { label: 'Online', count: '84', detail: 'stable', tone: 'good' },
      { label: 'Calibrate', count: '11', detail: 'queue', tone: 'warn' },
      { label: 'Drift', count: '2', detail: 'threshold', tone: 'danger' },
      { label: 'Offline', count: '6', detail: 'maintenance', tone: 'neutral' },
    ],
    records: [
      { name: 'Lab profile B7', owner: 'Device Lab', status: 'Calibrate', meta: 'sensor pair', progress: 62, tone: 'warn' },
      { name: 'Field node 18', owner: 'Ops', status: 'Online', meta: 'v2.8.1', progress: 96, tone: 'good' },
      { name: 'Pressure threshold', owner: 'Safety', status: 'Drift', meta: '+3.1%', progress: 26, tone: 'danger' },
      { name: 'Firmware cohort', owner: 'Release', status: 'Consistent', meta: '96%', progress: 96, tone: 'good' },
    ],
    activity: ['Device Lab queued profile B7 calibration', 'Ops confirmed field node 18 online', 'Safety flagged pressure threshold drift', 'Release synced firmware cohort'],
    rules: ['Threshold drift over 2% requires manual check', 'Parameter changes keep before/after snapshot', 'Offline devices exit active cohorts', 'Calibration windows avoid peak field hours'],
  },
  retro: {
    product: 'Analog Terminal',
    context: '批处理与运行日志系统',
    operator: 'Night Batch',
    entity: '作业',
    actionPrimary: '重跑作业',
    actionSecondary: '查看日志',
    nav: ['Console', 'Jobs', 'Queues', 'Artifacts', 'Ledger', 'Config'],
    modules: ['批处理队列', '作业日志', '产物校验', '配置账本'],
    metrics: [
      { label: 'Jobs', value: '128', detail: 'night batch', tone: 'neutral' },
      { label: 'Success', value: '97%', detail: 'last run', tone: 'good' },
      { label: 'Warnings', value: '12', detail: 'non-blocking', tone: 'warn' },
      { label: 'Failed', value: '2', detail: 'rerun ready', tone: 'danger' },
    ],
    lanes: [
      { label: 'Queued', count: '34', detail: '00:30 run', tone: 'neutral' },
      { label: 'Running', count: '11', detail: 'workers', tone: 'warn' },
      { label: 'Verified', count: '81', detail: 'checksum', tone: 'good' },
      { label: 'Failed', count: '2', detail: 'rerun', tone: 'danger' },
    ],
    records: [
      { name: 'Ledger compact job', owner: 'Night Batch', status: 'Running', meta: 'worker 07', progress: 69, tone: 'warn' },
      { name: 'Artifact checksum', owner: 'Archive', status: 'Verified', meta: 'sha ok', progress: 100, tone: 'good' },
      { name: 'Report rollup', owner: 'BI', status: 'Queued', meta: '00:30', progress: 18, tone: 'neutral' },
      { name: 'Import replay', owner: 'Data Ops', status: 'Failed', meta: 'schema mismatch', progress: 12, tone: 'danger' },
    ],
    activity: ['Night Batch started ledger compact job', 'Archive verified artifact checksum', 'BI queued report rollup', 'Data Ops prepared import replay rerun'],
    rules: ['Failed jobs keep replay input', 'Checksums gate artifact publish', 'Warnings do not block unless repeated', 'Config changes require ledger entry'],
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function getSiteTheme(site: ThemeSite): string {
  return site.theme || site.id;
}

export function getThemeVisual(site?: ThemeSite): ThemeVisual {
  const theme = site ? getSiteTheme(site) : '';
  const fallback = THEME_VISUALS[theme] ?? THEME_VISUALS.light;
  if (!site?.palette) return fallback;
  const palette = site.palette;
  return {
    ...fallback,
    accent: palette.accent || palette.primary || palette.gold || palette.accentWarm || fallback.accent,
    accent2: palette.accentAlt || palette.accentWarm || palette.jade || palette.warning || fallback.accent2,
    surface: palette.canvas || palette.surface || fallback.surface,
    panel: palette.surfaceElevated || palette.surfaceMuted || palette.surface || fallback.panel,
    ink: palette.ink || palette.text || fallback.ink,
    muted: palette.muted || fallback.muted,
    line: palette.line || fallback.line,
  };
}

export function getReadableTextColor(background: string): '#050505' | '#ffffff' {
  const hex = background.trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#050505';
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const toLinear = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.48 ? '#050505' : '#ffffff';
}

export function getPaletteValues(site?: ThemeSite, limit = 6): string[] {
  const visual = getThemeVisual(site);
  const values = site?.palette ? Object.values(site.palette) : [];
  return [...values, visual.surface, visual.panel, visual.ink, visual.accent, visual.accent2]
    .filter(Boolean)
    .slice(0, limit);
}

export function getReferencePrompt(site: ThemeSite): string {
  return site.referencePrompt || site.stylePrompt || site.prompt || '';
}

export function getUsageBoundary(site: ThemeSite): string {
  return site.usageBoundary || site.boundary || '这是完整前端系统主题，不是官网模板，也不是组件库。必须围绕真实业务对象生成导航、数据、列表、详情、流程、规则和状态闭环；只能提取视觉语言、信息组织和交互节奏，禁止原样照搬。';
}

function profileForTheme(theme: string): SystemProfile {
  return SYSTEM_PROFILES[theme] ?? SYSTEM_PROFILES.light;
}

export function getSystemSpec(site?: ThemeSite): SystemSpec {
  if (!site) return profileForTheme('light');
  const theme = getSiteTheme(site);
  const profile = profileForTheme(theme);
  return { ...profile };
}

export function getSystemSummary(site?: ThemeSite): string {
  const spec = getSystemSpec(site);
  const modules = spec.modules.slice(0, 4).join('、');
  return `${spec.context}，以 ${spec.entity} 为核心对象，覆盖登录、初始化、工作台、列表详情、流程、设置、安全与审计，并组织 ${modules}。`;
}

function metricClass(tone: SystemMetric['tone']): string {
  return `tone-${tone}`;
}

function percent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

export const SYSTEM_SURFACE_LABELS: Record<SystemSurfaceKey, string> = {
  auth: '登录',
  onboarding: '初始化',
  workspace: '工作台',
  records: '列表',
  detail: '详情',
  workflow: '流程',
  settings: '设置',
  security: '安全',
  audit: '审计',
  states: '状态',
};

export const SYSTEM_SURFACE_KEYS: SystemSurfaceKey[] = [
  'auth',
  'onboarding',
  'workspace',
  'records',
  'detail',
  'workflow',
  'settings',
  'security',
  'audit',
  'states',
];

export function getSystemSurfaces(site?: ThemeSite): SystemSurface[] {
  const spec = getSystemSpec(site);
  const firstRecord = spec.records[0] ?? {
    name: spec.entity,
    owner: spec.operator,
    status: 'Active',
    meta: spec.context,
    progress: 68,
    tone: 'neutral' as const,
  };
  const secondRecord = spec.records[1] ?? firstRecord;
  const firstRule = spec.rules[0] ?? '关键操作必须留下可追溯记录';
  const secondRule = spec.rules[1] ?? '高风险变更需要复核';

  return [
    {
      key: 'auth',
      label: SYSTEM_SURFACE_LABELS.auth,
      title: `${spec.product} 登录`,
      description: `${spec.operator} 通过账号、空间和权限边界进入系统。`,
      primary: 'SSO / Passkey',
      secondary: '最近登录 09:42',
      tone: 'good',
    },
    {
      key: 'onboarding',
      label: SYSTEM_SURFACE_LABELS.onboarding,
      title: '初始化向导',
      description: `配置 ${spec.entity} 字段、默认队列、审批人和通知节奏。`,
      primary: '4 / 5 完成',
      secondary: spec.modules[0] ?? spec.context,
      tone: 'neutral',
    },
    {
      key: 'workspace',
      label: SYSTEM_SURFACE_LABELS.workspace,
      title: '运营工作台',
      description: `实时聚合 ${spec.modules.slice(0, 3).join('、')}。`,
      primary: spec.metrics[0]?.value ?? 'Live',
      secondary: spec.metrics[0]?.label ?? '总览',
      tone: spec.metrics[0]?.tone ?? 'neutral',
    },
    {
      key: 'records',
      label: SYSTEM_SURFACE_LABELS.records,
      title: `${spec.entity} 列表`,
      description: `筛选、批量操作、状态分组和所有者分派。`,
      primary: firstRecord.status,
      secondary: firstRecord.name,
      tone: firstRecord.tone,
    },
    {
      key: 'detail',
      label: SYSTEM_SURFACE_LABELS.detail,
      title: '详情抽屉',
      description: `查看 ${firstRecord.name} 的进度、上下文、备注和风险。`,
      primary: percent(firstRecord.progress),
      secondary: firstRecord.owner,
      tone: firstRecord.tone,
    },
    {
      key: 'workflow',
      label: SYSTEM_SURFACE_LABELS.workflow,
      title: '流程与审批',
      description: `${spec.actionPrimary} 前校验规则、审批链和回滚路径。`,
      primary: spec.actionPrimary,
      secondary: secondRule,
      tone: 'warn',
    },
    {
      key: 'settings',
      label: SYSTEM_SURFACE_LABELS.settings,
      title: '系统设置',
      description: `字段、视图、通知、阈值和 ${spec.modules[spec.modules.length - 1] ?? '自动化'} 参数。`,
      primary: '12 项配置',
      secondary: '保存为工作区策略',
      tone: 'neutral',
    },
    {
      key: 'security',
      label: SYSTEM_SURFACE_LABELS.security,
      title: '安全与权限',
      description: `角色、敏感操作、数据范围和审批例外。`,
      primary: '3 个角色',
      secondary: firstRule,
      tone: 'danger',
    },
    {
      key: 'audit',
      label: SYSTEM_SURFACE_LABELS.audit,
      title: '审计日志',
      description: `记录 ${secondRecord.owner}、系统规则、批量操作和状态变更。`,
      primary: '实时写入',
      secondary: spec.activity[0] ?? '暂无活动',
      tone: 'good',
    },
    {
      key: 'states',
      label: SYSTEM_SURFACE_LABELS.states,
      title: '空 / 错 / 载入',
      description: `覆盖无数据、权限不足、规则冲突、同步中和失败恢复。`,
      primary: '5 类状态',
      secondary: '带动作和原因',
      tone: 'neutral',
    },
  ];
}

function buildMiniScreen(surface: SystemSurface, spec: SystemSpec, index: number): string {
  const firstRecord = spec.records[0] ?? {
    name: spec.entity,
    owner: spec.operator,
    status: 'Active',
    meta: spec.context,
    progress: 68,
    tone: 'neutral' as const,
  };
  const secondRecord = spec.records[1] ?? firstRecord;
  const thirdRecord = spec.records[2] ?? secondRecord;
  const rows = [firstRecord, secondRecord, thirdRecord];

  switch (surface.key) {
    case 'auth':
      return `
        <div class="mini-auth">
          <div class="mini-brand"></div>
          <strong>${escapeHtml(spec.product)}</strong>
          <label>Workspace <input value="${escapeHtml(spec.operator)}" aria-label="Workspace" /></label>
          <button>Continue with SSO</button>
          <small>Passkey enabled / scoped session</small>
        </div>
      `;
    case 'onboarding':
      return `
        <div class="mini-steps">
          ${['业务对象', '视图字段', '审批链', '通知', '发布'].map((step, stepIndex) => `
            <div class="mini-step ${stepIndex < 4 ? 'done' : ''}">
              <i>${stepIndex < 4 ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : String(stepIndex + 1)}</i>
              <span>${escapeHtml(step)}</span>
            </div>
          `).join('')}
          <div class="setup-progress"><i style="width:80%"></i></div>
        </div>
      `;
    case 'workspace':
      return `
        <div class="mini-dashboard">
          ${spec.metrics.slice(0, 3).map(metric => `
            <div class="${metricClass(metric.tone)}">
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(metric.value)}</strong>
            </div>
          `).join('')}
          <div class="mini-chart">
            <i style="height:44%"></i><i style="height:72%"></i><i style="height:58%"></i><i style="height:86%"></i>
          </div>
        </div>
      `;
    case 'records':
      return `
        <div class="mini-list">
          ${rows.map(record => `
            <div class="${metricClass(record.tone)}">
              <strong>${escapeHtml(record.name)}</strong>
              <span>${escapeHtml(record.owner)} · ${escapeHtml(record.status)}</span>
            </div>
          `).join('')}
        </div>
      `;
    case 'detail':
      return `
        <div class="mini-detail">
          <div>
            <small>${escapeHtml(firstRecord.status)}</small>
            <strong>${escapeHtml(firstRecord.name)}</strong>
            <span>${escapeHtml(firstRecord.meta)}</span>
          </div>
          <div class="detail-meter">
            <b>${percent(firstRecord.progress)}</b>
            <div class="bar"><i style="width:${percent(firstRecord.progress)}"></i></div>
          </div>
        </div>
      `;
    case 'workflow':
      return `
        <div class="mini-flowline">
          ${['提交', '校验', '审批', '执行'].map((step, stepIndex) => `
            <div class="${stepIndex <= 2 ? 'active' : ''}">
              <i>${stepIndex + 1}</i>
              <span>${escapeHtml(step)}</span>
            </div>
          `).join('')}
        </div>
      `;
    case 'settings':
      return `
        <div class="mini-settings">
          ${['字段模板', '通知节奏', '阈值规则'].map((item, itemIndex) => `
            <div>
              <span>${escapeHtml(item)}</span>
              <i class="${itemIndex === 1 ? '' : 'on'}"></i>
            </div>
          `).join('')}
        </div>
      `;
    case 'security':
      return `
        <div class="mini-permission">
          ${['Admin', 'Operator', 'Viewer'].map((role, roleIndex) => `
            <div>
              <strong>${escapeHtml(role)}</strong>
              <span>${roleIndex === 0 ? 'RWX' : roleIndex === 1 ? 'RW-' : 'R--'}</span>
            </div>
          `).join('')}
          <small>${escapeHtml(spec.rules[0] ?? 'Sensitive actions require approval')}</small>
        </div>
      `;
    case 'audit':
      return `
        <div class="mini-audit">
          ${spec.activity.slice(0, 3).map((item, activityIndex) => `
            <div>
              <time>${String(9 + activityIndex).padStart(2, '0')}:${activityIndex === 0 ? '08' : activityIndex === 1 ? '27' : '43'}</time>
              <span>${escapeHtml(item)}</span>
            </div>
          `).join('')}
        </div>
      `;
    case 'states':
      return `
        <div class="mini-states">
          <div><b>Empty</b><span>创建首个 ${escapeHtml(spec.entity)}</span></div>
          <div><b>Error</b><span>规则冲突可恢复</span></div>
          <div><b>Loading</b><span>同步 ${escapeHtml(spec.modules[0] ?? '数据')}</span></div>
        </div>
      `;
    default:
      return `
        <div class="mini-fallback">
          <strong>${escapeHtml(surface.title)}</strong>
          <span>${escapeHtml(surface.description)}</span>
          <small>${String(index + 1).padStart(2, '0')}</small>
        </div>
      `;
  }
}

export function buildSystemDemoHtml(site: ThemeSite): string {
  const visual = getThemeVisual(site);
  const spec = getSystemSpec(site);
  const surfaces = getSystemSurfaces(site);
  const isDark = visual.mode === 'dark';
  const palette = site.palette || {};
  const canvas = palette.canvas || visual.surface;
  const panel = palette.surfaceElevated || palette.surfaceMuted || visual.panel;
  const panelStrong = isDark ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.72)';
  const subtle = isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.50)';
  const danger = palette.danger || '#d84a4a';
  const success = palette.success || (isDark ? '#7fd6a7' : '#4f8296');
  const warning = palette.warning || palette.accentWarm || '#a77720';
  const titleFont = visual.font === 'Serif'
    ? 'ui-serif, Georgia, Cambria, "Times New Roman", serif'
    : visual.font === 'Mono'
      ? '"JetBrains Mono", "SFMono-Regular", Consolas, monospace'
      : 'Inter, ui-sans-serif, system-ui, sans-serif';
  const bodyFont = visual.font === 'Mono'
    ? '"JetBrains Mono", "SFMono-Regular", Consolas, monospace'
    : 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const nav = spec.nav.map((item, index) => `
    <button class="${index === 0 ? 'active' : ''}">
      <span>${String(index + 1).padStart(2, '0')}</span>
      ${escapeHtml(item)}
    </button>
  `).join('');
  const modules = spec.modules.map(item => `<span>${escapeHtml(item)}</span>`).join('');
  const metrics = spec.metrics.map(item => `
    <section class="metric ${metricClass(item.tone)}">
      <div>${escapeHtml(item.label)}</div>
      <strong>${escapeHtml(item.value)}</strong>
      <small>${escapeHtml(item.detail)}</small>
    </section>
  `).join('');
  const lanes = spec.lanes.map(item => `
    <section class="lane ${metricClass(item.tone)}">
      <div>
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.count)}</strong>
      </div>
      <small>${escapeHtml(item.detail)}</small>
    </section>
  `).join('');
  const records = spec.records.map(item => `
    <tr>
      <td>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.meta)}</span>
      </td>
      <td>${escapeHtml(item.owner)}</td>
      <td><span class="status ${metricClass(item.tone)}">${escapeHtml(item.status)}</span></td>
      <td>
        <div class="bar"><i style="width:${percent(item.progress)}"></i></div>
      </td>
    </tr>
  `).join('');
  const activity = spec.activity.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const rules = spec.rules.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const surfaceCards = surfaces.map((surface, index) => `
    <article class="surface-card ${metricClass(surface.tone)}">
      <header>
        <span>${String(index + 1).padStart(2, '0')}</span>
        <strong>${escapeHtml(surface.label)}</strong>
      </header>
      <div class="surface-copy">
        <h3>${escapeHtml(surface.title)}</h3>
        <p>${escapeHtml(surface.description)}</p>
      </div>
      ${buildMiniScreen(surface, spec, index)}
      <footer>
        <b>${escapeHtml(surface.primary)}</b>
        <small>${escapeHtml(surface.secondary)}</small>
      </footer>
    </article>
  `).join('');
  const coverageLabels = surfaces.map(surface => `<span>${escapeHtml(surface.label)}</span>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(spec.product)}</title>
<style>
  :root {
    color-scheme: ${isDark ? 'dark' : 'light'};
    --canvas: ${canvas};
    --panel: ${panel};
    --panel-strong: ${panelStrong};
    --subtle: ${subtle};
    --ink: ${visual.ink};
    --muted: ${visual.muted};
    --accent: ${visual.accent};
    --accent-2: ${visual.accent2};
    --line: ${visual.line};
    --danger: ${danger};
    --success: ${success};
    --warning: ${warning};
    --shadow: ${isDark ? '0 24px 70px rgba(0,0,0,.38)' : '0 22px 60px rgba(34,45,48,.12)'};
    --radius: 10px;
    --title-font: ${titleFont};
    --body-font: ${bodyFont};
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    min-height: 100vh;
    color: var(--ink);
    background:
      linear-gradient(120deg, color-mix(in srgb, var(--accent) 12%, transparent), transparent 34%),
      linear-gradient(180deg, color-mix(in srgb, var(--panel) 84%, transparent), var(--canvas)),
      var(--canvas);
    font-family: var(--body-font);
  }
  button, input { font: inherit; }
  .system {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
  }
  .sidebar {
    min-width: 0;
    border-right: 1px solid var(--line);
    background:
      linear-gradient(180deg, var(--panel-strong), transparent),
      color-mix(in srgb, var(--panel) 78%, transparent);
    padding: 20px 14px;
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 8px 18px;
    border-bottom: 1px solid var(--line);
  }
  .gem {
    width: 38px;
    height: 38px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.28), 0 16px 30px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .mark strong {
    display: block;
    font-family: var(--title-font);
    font-size: 15px;
    letter-spacing: 0;
  }
  .mark small, .sidebar footer {
    color: var(--muted);
    font-size: 11px;
  }
  nav {
    display: grid;
    gap: 6px;
    margin-top: 18px;
  }
  nav button {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: center;
    min-height: 36px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    text-align: left;
    cursor: default;
  }
  nav button span {
    color: color-mix(in srgb, var(--muted) 68%, transparent);
    font: 10px/1 "SFMono-Regular", Consolas, monospace;
    text-align: center;
  }
  nav button.active, nav button:hover {
    border-color: var(--line);
    color: var(--ink);
    background: color-mix(in srgb, var(--accent) 10%, var(--subtle));
  }
  .sidebar footer {
    margin-top: 22px;
    padding: 14px 8px 0;
    border-top: 1px solid var(--line);
    line-height: 1.7;
  }
  .main {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    min-height: 64px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    padding: 14px 22px;
    background: color-mix(in srgb, var(--panel) 72%, transparent);
    backdrop-filter: blur(18px);
  }
  .topbar h1 {
    margin: 0;
    font-family: var(--title-font);
    font-size: clamp(20px, 3vw, 30px);
    line-height: 1.05;
    letter-spacing: 0;
  }
  .topbar p {
    margin: 5px 0 0;
    max-width: 820px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .actions button {
    min-height: 36px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0 12px;
    color: var(--ink);
    background: var(--panel-strong);
  }
  .actions button.primary {
    border-color: color-mix(in srgb, var(--accent) 52%, var(--line));
    color: ${getReadableTextColor(visual.accent)};
    background: var(--accent);
  }
  .app-map {
    padding: 18px;
    border-bottom: 1px solid var(--line);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--panel-strong) 82%, transparent), transparent),
      color-mix(in srgb, var(--canvas) 92%, var(--panel));
  }
  .app-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    align-items: end;
    margin-bottom: 12px;
  }
  .app-head h2 {
    margin: 0;
    font-family: var(--title-font);
    font-size: 20px;
    line-height: 1.12;
  }
  .app-head p {
    margin: 5px 0 0;
    max-width: 760px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.65;
  }
  .coverage-count {
    min-width: 108px;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
    border-radius: 9px;
    padding: 10px 12px;
    text-align: right;
    background: color-mix(in srgb, var(--accent) 10%, var(--panel-strong));
  }
  .coverage-count strong {
    display: block;
    color: var(--accent);
    font-family: var(--title-font);
    font-size: 22px;
    line-height: 1;
  }
  .coverage-count span {
    color: var(--muted);
    font-size: 10px;
  }
  .surface-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(150px, 1fr));
    gap: 10px;
  }
  .surface-card {
    min-width: 0;
    min-height: 168px;
    display: flex;
    flex-direction: column;
    border: 1px solid color-mix(in srgb, var(--tone) 22%, var(--line));
    border-radius: 9px;
    padding: 9px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tone) 7%, transparent), transparent 42%),
      color-mix(in srgb, var(--panel-strong) 76%, transparent);
    box-shadow: 0 12px 34px color-mix(in srgb, var(--tone) 8%, transparent);
  }
  .surface-card header, .surface-card footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .surface-card header span {
    color: color-mix(in srgb, var(--muted) 70%, transparent);
    font: 10px/1 "SFMono-Regular", Consolas, monospace;
  }
  .surface-card header strong {
    color: var(--tone);
    font-size: 11px;
  }
  .surface-copy {
    min-height: 54px;
    padding-top: 8px;
  }
  .surface-copy h3 {
    margin: 0;
    color: var(--ink);
    font-family: var(--title-font);
    font-size: 12px;
    line-height: 1.25;
  }
  .surface-copy p {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.4;
  }
  .surface-card footer {
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .surface-card footer b {
    min-width: 0;
    overflow: hidden;
    color: var(--tone);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .surface-card footer small {
    max-width: 54%;
    overflow: hidden;
    color: var(--muted);
    font-size: 10px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-auth, .mini-steps, .mini-dashboard, .mini-list, .mini-detail, .mini-flowline, .mini-settings, .mini-permission, .mini-audit, .mini-states, .mini-fallback {
    min-height: 62px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px;
    background: color-mix(in srgb, var(--canvas) 46%, transparent);
  }
  .mini-auth {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 4px 7px;
  }
  .mini-brand {
    width: 22px;
    height: 22px;
    border-radius: 7px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
  }
  .mini-auth strong {
    align-self: center;
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-auth label {
    grid-column: 1 / -1;
    display: grid;
    gap: 3px;
    color: var(--muted);
    font-size: 9px;
  }
  .mini-auth input {
    min-height: 22px;
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0 7px;
    color: var(--ink);
    background: var(--subtle);
    font-size: 10px;
  }
  .mini-auth button {
    grid-column: 1 / -1;
    min-height: 22px;
    border: 0;
    border-radius: 6px;
    color: ${getReadableTextColor(visual.accent)};
    background: var(--accent);
    font-size: 10px;
  }
  .mini-auth small {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: 9px;
  }
  .mini-steps {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }
  .mini-step, .mini-settings div, .mini-permission div, .mini-audit div, .mini-states div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mini-step i, .mini-flowline i {
    display: inline-flex;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 50%;
    color: var(--muted);
    font-size: 10px;
    font-style: normal;
  }
  .mini-step.done i, .mini-flowline .active i {
    border-color: color-mix(in srgb, var(--accent) 54%, var(--line));
    color: ${getReadableTextColor(visual.accent)};
    background: var(--accent);
  }
  .mini-step span, .mini-flowline span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--muted);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .setup-progress {
    grid-column: 1 / -1;
    height: 5px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 18%, transparent);
  }
  .setup-progress i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .mini-dashboard {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
  }
  .mini-dashboard > div:not(.mini-chart) {
    border: 1px solid color-mix(in srgb, var(--tone) 20%, var(--line));
    border-radius: 6px;
    padding: 5px;
  }
  .mini-dashboard span, .mini-list span, .mini-detail span, .mini-permission small, .mini-audit span, .mini-states span {
    color: var(--muted);
    font-size: 9px;
  }
  .mini-dashboard strong, .mini-list strong, .mini-detail strong, .mini-permission strong, .mini-states b {
    display: block;
    overflow: hidden;
    color: var(--ink);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-chart {
    grid-column: 1 / -1;
    height: 20px;
    display: flex;
    align-items: end;
    gap: 5px;
  }
  .mini-chart i {
    flex: 1;
    border-radius: 5px 5px 0 0;
    background: linear-gradient(180deg, var(--accent-2), var(--accent));
  }
  .mini-list {
    display: grid;
    gap: 4px;
  }
  .mini-list div {
    border-left: 3px solid var(--tone);
    padding-left: 7px;
  }
  .mini-detail {
    display: grid;
    gap: 6px;
  }
  .mini-detail small {
    color: var(--tone);
    font-size: 9px;
  }
  .detail-meter {
    display: grid;
    gap: 5px;
  }
  .detail-meter b {
    color: var(--tone);
    font-size: 11px;
  }
  .mini-flowline {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 4px;
  }
  .mini-flowline div {
    min-width: 0;
    display: grid;
    justify-items: center;
    gap: 5px;
    text-align: center;
  }
  .mini-settings, .mini-permission, .mini-audit, .mini-states {
    display: grid;
    gap: 5px;
  }
  .mini-settings span, .mini-permission span, .mini-audit time {
    color: var(--muted);
    font-size: 10px;
  }
  .mini-settings i {
    width: 28px;
    height: 16px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 14%, transparent);
  }
  .mini-settings i.on {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .mini-permission span {
    font-family: "SFMono-Regular", Consolas, monospace;
  }
  .mini-permission small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-audit time {
    font-family: "SFMono-Regular", Consolas, monospace;
  }
  .mini-audit span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-states div {
    min-height: 20px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0 6px;
  }
  .workspace {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(300px, .76fr);
    gap: 18px;
    padding: 18px;
  }
  .section {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--panel-strong) 92%, transparent), color-mix(in srgb, var(--panel) 76%, transparent)),
      var(--panel);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
  }
  .section-head strong {
    font-size: 13px;
    letter-spacing: .02em;
  }
  .section-head span {
    color: var(--muted);
    font-size: 11px;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    padding: 14px;
  }
  .metric, .lane {
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 12px;
    background: color-mix(in srgb, var(--panel-strong) 72%, transparent);
  }
  .metric div, .lane span {
    color: var(--muted);
    font-size: 11px;
  }
  .metric strong {
    display: block;
    margin-top: 8px;
    font-family: var(--title-font);
    font-size: 25px;
    line-height: 1;
  }
  .metric small, .lane small {
    display: block;
    margin-top: 8px;
    color: var(--muted);
    font-size: 11px;
  }
  .tone-good { --tone: var(--success); }
  .tone-warn { --tone: var(--warning); }
  .tone-danger { --tone: var(--danger); }
  .tone-neutral { --tone: var(--accent); }
  .metric, .lane, .status { border-color: color-mix(in srgb, var(--tone) 26%, var(--line)); }
  .metric strong, .lane strong { color: var(--tone); }
  .flow {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    padding: 0 14px 14px;
  }
  .lane div {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .lane strong {
    font-size: 20px;
  }
  .modules {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 14px 14px;
  }
  .modules span {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 9px;
    color: var(--muted);
    background: var(--subtle);
    font-size: 11px;
  }
  .app-map .modules {
    padding: 0 0 12px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    padding: 12px 14px;
    border-top: 1px solid var(--line);
    text-align: left;
    font-size: 12px;
    vertical-align: middle;
  }
  th {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  td strong {
    display: block;
    margin-bottom: 4px;
    color: var(--ink);
    font-size: 12px;
  }
  td span {
    color: var(--muted);
    font-size: 11px;
  }
  .status {
    display: inline-flex;
    min-height: 24px;
    align-items: center;
    border: 1px solid;
    border-radius: 999px;
    padding: 0 8px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 10%, transparent);
    font-size: 11px;
  }
  .bar {
    height: 7px;
    min-width: 82px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 18%, transparent);
  }
  .bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .side {
    display: grid;
    gap: 18px;
    align-content: start;
  }
  .inspector {
    padding: 16px;
  }
  .inspector h2 {
    margin: 0 0 8px;
    font-family: var(--title-font);
    font-size: 22px;
  }
  .inspector p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
  .activity, .rules {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .activity li, .rules li {
    border-top: 1px solid var(--line);
    padding: 12px 16px;
    color: color-mix(in srgb, var(--ink) 84%, var(--muted));
    font-size: 12px;
    line-height: 1.55;
  }
  .rules li::before, .activity li::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 8px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: 1px;
  }
  .control-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
    margin-top: 16px;
  }
  .control-row label {
    color: var(--muted);
    font-size: 11px;
  }
  .control-row input {
    width: 100%;
    min-height: 34px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0 10px;
    color: var(--ink);
    background: var(--subtle);
    outline: none;
  }
  .control-row button {
    min-height: 34px;
    border: 1px solid color-mix(in srgb, var(--accent) 52%, var(--line));
    border-radius: 8px;
    padding: 0 10px;
    color: ${getReadableTextColor(visual.accent)};
    background: var(--accent);
  }
  @media (max-width: 1260px) {
    .surface-grid { grid-template-columns: repeat(3, minmax(170px, 1fr)); }
  }
  @media (max-width: 980px) {
    .surface-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .workspace { grid-template-columns: 1fr; }
    .metrics, .flow { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 760px) {
    .system { grid-template-columns: 1fr; }
    .sidebar { border-right: 0; border-bottom: 1px solid var(--line); padding: 14px; }
    nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .sidebar footer { display: none; }
  }
  @media (max-width: 680px) {
    .topbar { grid-template-columns: 1fr; padding: 14px; }
    .actions { flex-wrap: wrap; }
    .app-map { padding: 12px; }
    .app-head { grid-template-columns: 1fr; align-items: start; }
    .coverage-count { width: 100%; text-align: left; }
    .surface-grid { grid-template-columns: 1fr; }
    .surface-card { min-height: auto; }
    .workspace { padding: 12px; gap: 12px; }
    .metrics, .flow { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    th:nth-child(2), td:nth-child(2) { display: none; }
    nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  }
</style>
</head>
<body>
  <div class="system">
    <aside class="sidebar">
      <div class="mark">
        <div class="gem" aria-hidden="true"></div>
        <div>
          <strong>${escapeHtml(spec.product)}</strong>
          <small>${escapeHtml(spec.context)}</small>
        </div>
      </div>
      <nav aria-label="System modules">${nav}</nav>
      <footer>
        Operator: ${escapeHtml(spec.operator)}<br />
        Entity: ${escapeHtml(spec.entity)}<br />
        Mode: ${visual.mode} / ${visual.font}
      </footer>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <h1>${escapeHtml(spec.product)}</h1>
          <p>${escapeHtml(getSystemSummary(site))}</p>
        </div>
        <div class="actions">
          <button>${escapeHtml(spec.actionSecondary)}</button>
          <button class="primary">${escapeHtml(spec.actionPrimary)}</button>
        </div>
      </header>
      <section class="app-map" aria-label="Full app coverage">
        <div class="app-head">
          <div>
            <h2>完整前端系统覆盖</h2>
            <p>不是单页官网预览。每套主题都生成登录、初始化、工作区、列表详情、流程审批、设置、安全、审计和状态反馈，作为真实产品系统的视觉与交互基线。</p>
          </div>
          <div class="coverage-count">
            <strong>${surfaces.length}</strong>
            <span>surfaces ready</span>
          </div>
        </div>
        <div class="modules">${coverageLabels}</div>
        <div class="surface-grid">${surfaceCards}</div>
      </section>
      <section class="workspace">
        <div class="section">
          <div class="section-head">
            <strong>System overview</strong>
            <span>${escapeHtml(spec.operator)} / live workspace</span>
          </div>
          <div class="metrics">${metrics}</div>
          <div class="flow">${lanes}</div>
          <div class="modules">${modules}</div>
          <table>
            <thead>
              <tr>
                <th>${escapeHtml(spec.entity)}</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>${records}</tbody>
          </table>
        </div>
        <aside class="side">
          <section class="section inspector">
            <h2>${escapeHtml(spec.entity)} workspace</h2>
            <p>${escapeHtml(spec.modules.join('、'))} 被组织在同一工作区，当前视图同步队列、详情、规则和审计记录。</p>
            <div class="control-row">
              <label>
                Quick filter
                <input value="${escapeHtml(spec.records[0]?.status ?? 'Active')}" aria-label="Quick filter" />
              </label>
              <button>Apply</button>
            </div>
          </section>
          <section class="section">
            <div class="section-head">
              <strong>Activity</strong>
              <span>audited</span>
            </div>
            <ul class="activity">${activity}</ul>
          </section>
          <section class="section">
            <div class="section-head">
              <strong>Rules</strong>
              <span>automation guardrails</span>
            </div>
            <ul class="rules">${rules}</ul>
          </section>
        </aside>
      </section>
    </main>
  </div>
</body>
</html>`;
}
