import {
  normalizeLeaderStatusKind,
  normalizeRunStatus,
  type NormalizedLeaderStatusKind,
  type NormalizedRunStatus,
} from '../core/StateSemantics.js';

export interface TuiTheme {
  text: string;
  muted: string;
  subtle: string;
  heading: string;
  accent: string;
  accentAlt: string;
  info: string;
  success: string;
  warning: string;
  error: string;
  panelBorder: string;
  panelAltBorder: string;
  codeBorder: string;
  codeHeader: string;
  codeComment: string;
  codeString: string;
  codeKeyword: string;
  codeFunction: string;
  codeDecorator: string;
  codeNumber: string;
  markdownEmphasis: string;
  markdownLink: string;
  markdownCode: string;
  markdownBullet: string;
  // Status indicators
  idle: string;
  working: string;
  thinking: string;
  // Panel accents
  panelLabel: string;
  panelDivider: string;
  // Input
  prompt: string;
  cursor: string;
  // Semantic colors for markdown rendering
  semantic: {
    text: {
      primary: string;
      secondary: string;
      link: string;
      accent: string;
      code: string;
    };
    selection: {
      background: string;
      text: string;
    };
    border: {
      default: string;
      focused: string;
    };
    status: {
      idle: string;
      running: string;
      completed: string;
      failed: string;
      interrupted: string;
      blocked: string;
      pending: string;
      cancelled: string;
      info: string;
      error: string;
      success: string;
      warning: string;
    };
    panel: {
      title: string;
      border: string;
      borderFocused: string;
      borderMuted: string;
      divider: string;
      help: string;
      empty: string;
    };
    priority: {
      critical: string;
      important: string;
      normal: string;
    };
    role: {
      research: string;
      coding: string;
      review: string;
      verify: string;
      frontend: string;
      backend: string;
      qa: string;
      uxDesigner: string;
      planning: string;
      testing: string;
      architect: string;
      default: string;
    };
    phase: {
      research: string;
      coding: string;
      testing: string;
      reviewing: string;
      planning: string;
      other: string;
    };
    diff: {
      add: string;
      del: string;
      hunk: string;
      context: string;
      meta: string;
    };
    runtime: {
      leader: string;
      agent: string;
      tool: string;
      approval: string;
      shell: string;
      stream: string;
    };
  };
  // Syntax highlighting colors (hljs class -> ink color)
  hljs: {
    keyword: string;
    built_in: string;
    type: string;
    literal: string;
    number: string;
    string: string;
    comment: string;
    function: string;
    title: string;
    params: string;
    attr: string;
    variable: string;
    regexp: string;
    meta: string;
    operator: string;
    default: string;
  };
}

// LingXiao 水墨 terminal theme：松烟暖炭为骨、宣纸暖白为肉、剑金为锋。
// 以墨色单色为主、金为唯一主点缀(描金)；青墨/朱砂/赭金/墨青作低饱和状态色，
// 替代原先的夜青+彩虹。金与开场动画 LINGXIAO_GOLD_PALETTE 同源，边框/帮助文用
// 暖墨炭而非冷青灰，避免暗终端上的「黑洞」感，同时收紧水墨气韵。
export const tuiTheme: TuiTheme = {
  text: '#ece5d8',        // 宣纸暖白(原 #eef6f3 冷白)
  muted: '#b3aa9b',       // 暖灰(原冷灰)
  subtle: '#857c6e',      // 深暖灰
  heading: '#f2c673',     // 剑金(品牌金,描金主点缀)
  accent: '#f2c673',
  accentAlt: '#f3e3b0',   // 暖高光(描金最亮处)
  info: '#7d93a6',        // 墨青(原亮青 #8ecae6 降饱)
  success: '#7fae95',     // 青墨(原亮玉 #8fcfb8 降饱)
  warning: '#d4a85a',     // 赭金(原亮黄 #ffd37a 降饱)
  error: '#c95a4a',       // 朱砂(原亮红→水墨朱砂,与 web --accent-red 同源)
  panelBorder: '#46403a', // 暖墨炭(原冷青灰→松烟暖炭)
  panelAltBorder: '#322e29',
  codeBorder: '#403a34',
  codeHeader: '#9a8f7d',  // 暖灰(原青)
  codeComment: '#6f8a78', // 黛青(原亮草青)
  codeString: '#d4a85a',  // 赭金
  codeKeyword: '#7d93a6', // 墨青
  codeFunction: '#f2c673',// 剑金
  codeDecorator: '#b08a6a',// 赭石
  codeNumber: '#9fb582',  // 黛绿
  markdownEmphasis: '#d8c9a8',// 暖(原冷)
  markdownLink: '#f2c673',
  markdownCode: '#d4a85a',
  markdownBullet: '#b3aa9b',
  // Status indicators — clear and distinct
  idle: '#7a7264',        // 深暖灰(原冷灰)
  working: '#f2c673',     // 剑金
  thinking: '#9c8fa6',    // 黛紫(原亮紫 #c8b6ff 降饱)
  // Panel accents
  panelLabel: '#857c6e',
  panelDivider: '#5a5249',// 暖中灰(原冷)
  // Input
  prompt: '#f2c673',
  cursor: '#f3e3b0',
  // Semantic colors for markdown rendering
  semantic: {
    text: {
      primary: '#ece5d8',
      secondary: '#b3aa9b',
      link: '#f2c673',
      accent: '#f2c673',
      code: '#d4a85a',
    },
    selection: {
      background: '#3a3530',
      text: '#f5efe2',
    },
    border: {
      default: '#46403a',
      focused: '#f2c673',
    },
    status: {
      idle: '#7a7264',
      running: '#f2c673',
      completed: '#7fae95',
      failed: '#c95a4a',
      interrupted: '#7d93a6',
      blocked: '#d4a85a',
      pending: '#8a8174',
      cancelled: '#6d655a',
      info: '#7d93a6',
      error: '#c95a4a',
      success: '#7fae95',
      warning: '#d4a85a',
    },
    panel: {
      title: '#f2c673',
      border: '#46403a',
      borderFocused: '#f2c673',
      borderMuted: '#322e29',
      divider: '#5a5249',
      help: '#857c6e',
      empty: '#6f675c',
    },
    priority: {
      critical: '#c95a4a',
      important: '#d4a85a',
      normal: '#b3aa9b',
    },
    role: {
      research: '#7d93a6',    // 墨青
      coding: '#7fae95',      // 青墨
      review: '#f2c673',      // 剑金
      verify: '#9c8fa6',      // 黛紫
      frontend: '#6f93b0',    // 黛蓝(原亮蓝降饱)
      backend: '#b08a6a',     // 赭石
      qa: '#bd7a5e',          // 赭朱(较 error 柔)
      uxDesigner: '#caa05a',  // 赭金
      planning: '#9c8fa6',    // 黛紫
      testing: '#d4a85a',     // 赭金
      architect: '#6f8a8a',   // 石青
      default: '#8a8174',     // 暖灰
    },
    phase: {
      research: '#7d93a6',
      coding: '#9c8fa6',
      testing: '#d4a85a',
      reviewing: '#7fae95',
      planning: '#c9b8a0',
      other: '#8a8174',
    },
    diff: {
      add: '#7fae95',
      del: '#c95a4a',
      hunk: '#9c8fa6',
      context: '#a89f90',
      meta: '#7d93a6',
    },
    runtime: {
      leader: '#f2c673',
      agent: '#f3e3b0',
      tool: '#b08a6a',
      approval: '#d4a85a',
      shell: '#7d93a6',
      stream: '#b3aa9b',
    },
  },
  // Syntax highlighting colors tuned for the LingXiao 水墨 palette.
  hljs: {
    keyword: '#7d93a6',   // 墨青
    built_in: '#7fae95',  // 青墨
    type: '#7fae95',
    literal: '#7d93a6',
    number: '#9fb582',    // 黛绿
    string: '#d4a85a',    // 赭金
    comment: '#6f8a78',   // 黛青
    function: '#f2c673',  // 剑金
    title: '#f2c673',
    params: '#c9b8a0',    // 暖(原冷)
    attr: '#c9b8a0',
    variable: '#c9b8a0',
    regexp: '#bd7a5e',    // 赭朱
    meta: '#7d93a6',
    operator: '#cabeae',  // 暖(原冷)
    default: '#cabeae',
  },
};

const RUN_STATUS_COLOR_MAP: Record<NormalizedRunStatus, string> = {
  idle: tuiTheme.semantic.status.idle,
  planning: tuiTheme.semantic.runtime.leader,
  running: tuiTheme.semantic.status.running,
  blocked: tuiTheme.semantic.status.blocked,
  completed: tuiTheme.semantic.status.completed,
  failed: tuiTheme.semantic.status.failed,
  cancelled: tuiTheme.semantic.status.cancelled,
};

const LEADER_STATUS_KIND_COLOR_MAP: Record<NormalizedLeaderStatusKind, string> = {
  active: tuiTheme.semantic.runtime.leader,
  idle: tuiTheme.semantic.status.idle,
  waiting: tuiTheme.semantic.status.idle,
  interrupted: tuiTheme.semantic.status.interrupted,
  completed: tuiTheme.semantic.status.completed,
};

const RUN_STATUS_EXACT_INPUTS = new Set([
  'idle',
  'planning',
  'running',
  'blocked',
  'completed',
  'done',
  'success',
  'failed',
  'error',
  'crashed',
  'cancelled',
  'canceled',
]);

const LEADER_STATUS_KIND_EXACT_INPUTS = new Set([
  'active',
  'idle',
  'waiting',
  'interrupted',
  'completed',
]);

const STATUS_EXACT_COLOR_MAP: Record<string, string> = {
  busy: tuiTheme.semantic.status.running,
  pending: tuiTheme.semantic.status.pending,
  queued: tuiTheme.semantic.status.pending,
  waiting_external: tuiTheme.semantic.status.blocked,
  recovering: tuiTheme.semantic.status.info,
  info: tuiTheme.semantic.status.info,
  warning: tuiTheme.semantic.status.warning,
  stalled: tuiTheme.semantic.status.warning,
  paused: tuiTheme.semantic.status.interrupted,
  thinking: tuiTheme.semantic.runtime.leader,
  processing: tuiTheme.semantic.status.running,
  working: tuiTheme.semantic.status.running,
  starting: tuiTheme.semantic.status.running,
  terminated: tuiTheme.semantic.status.failed,
  killed: tuiTheme.semantic.status.failed,
  timeout: tuiTheme.semantic.status.failed,
};

function normalizeStatusToken(status: string): string {
  return status.trim().toLowerCase();
}

function getCanonicalStatusColor(status: string): string | undefined {
  const value = normalizeStatusToken(status);
  if (!value) return undefined;

  if (LEADER_STATUS_KIND_EXACT_INPUTS.has(value)) {
    return LEADER_STATUS_KIND_COLOR_MAP[normalizeLeaderStatusKind(value)];
  }

  if (RUN_STATUS_EXACT_INPUTS.has(value)) {
    return RUN_STATUS_COLOR_MAP[normalizeRunStatus(value)];
  }

  return STATUS_EXACT_COLOR_MAP[value];
}

export function getStatusColor(status: string): string {
  return getCanonicalStatusColor(status)
    ?? tuiTheme.semantic.text.primary;
}
