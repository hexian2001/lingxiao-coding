import { getModelManager } from '../config/ModelManager.js';
import { getLanguage, t } from '../i18n.js';
import { collectCustomCommands } from './CustomCommandLoader.js';

export interface SlashCommandDefinition {
  name: string;
  desc: string;
  usage?: string;
  handledBy?: 'tui-local' | 'callback';
  includeInSuggestions?: boolean;
  includeInHelp?: boolean;
  /** 帮助分组类别（用于 /help 分区展示）。缺省归入「其它」。 */
  category?: SlashCommandCategory;
  /** 参数自动补全函数，partial 为用户已输入的参数部分 */
  argCompleter?: (partial: string) => Array<{ name: string; desc: string }>;
}

export type SlashCommandCategory =
  | 'session'      // 会话/历史
  | 'view'         // 视图/面板（任务、图、git、统计…）
  | 'permission'   // 权限/审批
  | 'project'      // orchestration 项目控制
  | 'model'        // 模型/配置
  | 'tools'        // 工具/技能/网络
  | 'misc';        // 其它

/** 类别展示顺序与标题 key */
export const CATEGORY_LABELS: Array<{ key: SlashCommandCategory; labelKey: string }> = [
  { key: 'session', labelKey: 'slash.category.session' },
  { key: 'view', labelKey: 'slash.category.view' },
  { key: 'permission', labelKey: 'slash.category.permission' },
  { key: 'project', labelKey: 'slash.category.project' },
  { key: 'model', labelKey: 'slash.category.model' },
  { key: 'tools', labelKey: 'slash.category.tools' },
  { key: 'misc', labelKey: 'slash.category.misc' },
];

const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: '/help', desc: '显示帮助', handledBy: 'tui-local', category: 'misc' },
  { name: '/resume', desc: '恢复会话', handledBy: 'callback', category: 'session' },
  { name: '/session', desc: '查看当前会话空间', handledBy: 'callback', category: 'session' },
  { name: '/doctor', desc: '查看运行时诊断', handledBy: 'callback', category: 'misc' },
  { name: '/permissions', desc: '查看权限层级', handledBy: 'callback', category: 'permission' },
  { name: '/bughunt', desc: '启动白盒审计+插桩+黑盒验证闭环', usage: '/bughunt [目标/范围]', handledBy: 'callback', category: 'tools' },
  { name: '/bughunt-status', desc: '查看当前 Bughunt 态势摘要', handledBy: 'callback', category: 'tools' },
  { name: '/bughunt-report', desc: '从 Bughunt ledger 生成事实报告骨架', handledBy: 'callback', category: 'tools' },
  { name: '/office', desc: '切换 Office 模式（PPTX/DOCX/XLSX/PDF/HTML/Slidev/Canvas/解析）', usage: '/office [on|off]', handledBy: 'callback', category: 'tools' },
  { name: '/workflow', desc: '切换 Workflow 模式（workflow action=create/add_node/connect/execute/...）', usage: '/workflow [on|off]', handledBy: 'callback', category: 'tools' },
  { name: '/eternal', desc: '设置/管理 Eternal 持续目标模式', usage: '/eternal <要持续完成的目标>|status|pause|resume|clear', handledBy: 'callback', category: 'project',
    argCompleter: (partial) => ['status', 'pause', 'resume', 'clear', 'delete', 'set ']
      .filter(s => s.startsWith(partial.toLowerCase()))
      .map(s => ({ name: s.trim(), desc: `Eternal ${s.trim()}` })) },
  { name: '/team', desc: '查看/切换协作模式', usage: '/team status|on|off', handledBy: 'callback', category: 'project',
    argCompleter: (partial) => ['status', 'on', 'off'].filter(m => m.startsWith(partial.toLowerCase())).map(m => ({ name: m, desc: `Team ${m}` })) },
  { name: '/route', desc: '设置 Leader 执行路由偏好', usage: '/route <auto|direct|delegate>', handledBy: 'callback', category: 'project',
    argCompleter: (partial) => ['auto', 'direct', 'delegate'].filter(m => m.startsWith(partial.toLowerCase())).map(m => ({ name: m, desc: `Route ${m}` })) },
  { name: '/mode', desc: '切换权限模式', usage: '/mode <strict|dev|networked|yolo> [scope]', handledBy: 'callback', category: 'permission',
    argCompleter: (partial) => ['strict', 'dev', 'networked', 'yolo'].filter(m => m.startsWith(partial.toLowerCase())).map(m => ({ name: m, desc: `${m} 模式` })) },
  { name: '/allow-tool', desc: '添加 allow 规则', usage: '/allow-tool <tool> [pattern] [scope]', handledBy: 'callback', category: 'permission' },
  { name: '/deny-tool', desc: '添加 deny 规则', usage: '/deny-tool <tool> [pattern] [scope]', handledBy: 'callback', category: 'permission' },
  { name: '/ask-tool', desc: '添加 ask 规则', usage: '/ask-tool <tool> [pattern] [scope]', handledBy: 'callback', category: 'permission' },
  { name: '/approve', desc: '批准当前待审批项（权限/方案）', handledBy: 'callback', category: 'permission' },
  { name: '/deny', desc: '拒绝待处理权限请求', handledBy: 'callback', category: 'permission' },
  { name: '/fetch', desc: '抓取网页', usage: '/fetch <url>', handledBy: 'callback', category: 'tools' },
  { name: '/search', desc: '网页搜索', usage: '/search <query>', handledBy: 'callback', category: 'tools' },
  { name: '/ls', desc: '查看目录', usage: '/ls <path>', handledBy: 'callback', category: 'tools' },
  { name: '/open', desc: '预览文件', usage: '/open <path>', handledBy: 'callback', category: 'tools' },
  { name: '/tasks', desc: '查看任务概览', handledBy: 'tui-local', category: 'view' },
  { name: '/agents', desc: '查看 Agent 概览', handledBy: 'tui-local', category: 'view' },
  { name: '/graph', desc: '查看知识图谱/黑板', handledBy: 'tui-local', category: 'view' },
  { name: '/notes', desc: '查看 Agent 工作笔记', handledBy: 'tui-local', category: 'view' },
  { name: '/git', desc: '查看 Git 工作区状态/diff', usage: '/git [refresh]', handledBy: 'tui-local', category: 'view' },
  { name: '/changes', desc: '查看会话文件变更/检查点', handledBy: 'callback', category: 'view' },
  { name: '/rewind', desc: '回退到检查点（代码/对话/全部，预览+确认）', usage: '/rewind [checkpointId] [code|conversation|all] [confirm]', handledBy: 'callback', category: 'session' },
  { name: '/hooks', desc: '查看 Hooks 配置', handledBy: 'callback', category: 'tools' },
  { name: '/main', desc: '切回主频道', handledBy: 'tui-local', category: 'view' },
  { name: '/clear', desc: '清空当前对话（DB + 内存）', handledBy: 'callback', category: 'session' },
  { name: '/compact', desc: '压缩 Leader 上下文', handledBy: 'callback', category: 'session' },
  { name: '/fork', desc: '从指定消息分叉会话', usage: '/fork [messageId]', handledBy: 'callback', category: 'session' },
  { name: '/history', desc: '查看历史会话', handledBy: 'callback', category: 'session' },
  { name: '/skills', desc: '查看可用技能', handledBy: 'callback', category: 'tools' },
  { name: '/mcp', desc: '管理 MCP servers / 市场 / 工具发现', usage: '/mcp [list|search|install|tools|call|resources|read-resource|prompts|get-prompt|templates|snapshot|enable|disable|remove|add-remote|add-stdio]', handledBy: 'callback', category: 'tools',
    argCompleter: (partial) => ['list', 'search ', 'install ', 'tools ', 'call ', 'resources ', 'read-resource ', 'prompts ', 'get-prompt ', 'templates ', 'snapshot ', 'enable ', 'disable ', 'remove ', 'add-remote ', 'add-stdio ']
      .filter(s => s.startsWith(partial.toLowerCase()))
      .map(s => ({ name: s.trim(), desc: `MCP ${s.trim()}` })) },
  { name: '/projects', desc: '查看 orchestration 项目看板', handledBy: 'callback', category: 'project' },
  { name: '/project-pause', desc: '暂停当前 orchestration 项目', handledBy: 'callback', category: 'project' },
  { name: '/project-resume', desc: '恢复当前 orchestration 项目', handledBy: 'callback', category: 'project' },
  { name: '/project-priority', desc: '调整当前 orchestration 项目优先级', usage: '/project-priority <critical|high|normal|low>', handledBy: 'callback', category: 'project',
    argCompleter: (partial) => ['critical', 'high', 'normal', 'low'].filter(p => p.startsWith(partial.toLowerCase())).map(p => ({ name: p, desc: `${p} 优先级` })) },
  { name: '/project-replan', desc: '强制当前 orchestration 项目进入重规划', handledBy: 'callback', category: 'project' },
  { name: '/project-reset', desc: '强制当前 orchestration 项目进入恢复/重置', handledBy: 'callback', category: 'project' },
  { name: '/project-unblock', desc: '将当前 orchestration 项目的依赖标记为 fulfilled', usage: '/project-unblock <dependency-id>', handledBy: 'callback', category: 'project' },
  { name: '/project-archive', desc: '归档当前 orchestration 项目', handledBy: 'callback', category: 'project' },
  { name: '/models', desc: '查看当前可用模型', handledBy: 'callback', category: 'model' },
  { name: '/model', desc: '切换当前模型', usage: '/model <model-id>', handledBy: 'callback', category: 'model',
    argCompleter: (partial) => {
      try {
        return getModelManager().getAllModels()
          .filter((model) => !partial || model.id.toLowerCase().includes(partial.toLowerCase()))
          .map((model) => ({ name: model.id, desc: model.provider || '' }));
      } catch (err) {
          // 模型子系统故障（未初始化/配置解析/provider 注册）不应静默返回空 ——
          // 否则用户看到「无模型」却无从知晓是模型管理器出错。debug 记录原因。
          console.debug('[slash_registry] /model 补全失败，返回空:', err instanceof Error ? err.message : String(err));
          return [];
        }
    } },
  { name: '/intervene', desc: '向 Agent 发送干预消息', usage: '/intervene @agent <message>', handledBy: 'callback', category: 'project' },
  { name: '/stop', desc: '中断当前会话', handledBy: 'callback', category: 'session' },
  { name: '/cancel-task', desc: '取消任务', usage: '/cancel-task <task-id> [reason]', handledBy: 'callback', category: 'project' },
  { name: '/refresh', desc: '刷新当前视图', handledBy: 'callback', category: 'view' },
  { name: '/reset', desc: '重置当前视图', handledBy: 'tui-local', category: 'view' },
  { name: '/broadcast', desc: '广播消息给所有 Agent', usage: '/broadcast <message>', handledBy: 'callback', category: 'project' },
  { name: '/quit', desc: '退出程序', handledBy: 'tui-local', category: 'misc' },
  { name: '/exit', desc: '退出程序', handledBy: 'tui-local', category: 'misc' },
  { name: '/language', desc: '切换语言', usage: '/language <zh|en>', handledBy: 'tui-local', category: 'model',
    argCompleter: (partial) => ['zh', 'en'].filter(l => l.startsWith(partial.toLowerCase())).map(l => ({ name: l, desc: l === 'zh' ? '中文' : 'English' })) },
  { name: '/config', desc: '查看/修改配置', usage: '/config | /config set <key> <value> | /config reset <key> | /config reset-all | /config init', handledBy: 'tui-local', category: 'model',
    argCompleter: (partial) => ['set ', 'reset ', 'reset-all', 'init', 'init --force', 'export']
      .filter(s => s.startsWith(partial.toLowerCase()))
      .map(s => ({ name: s.trim(), desc: s.startsWith('set') ? '设置配置项' : s.startsWith('reset-all') ? '重置所有配置' : s.startsWith('reset') ? '重置单项配置' : s.startsWith('init') ? '重新生成配置文件' : '导出配置' })) },
  { name: '/loop', desc: '创建/管理定时任务', usage: '/loop [interval] <prompt> | /loop list | /loop delete <id> | /loop stop', handledBy: 'callback', category: 'tools',
    argCompleter: (partial) => ['list', 'delete', 'stop']
      .filter(s => s.startsWith(partial.toLowerCase()))
      .map(s => ({ name: s, desc: s === 'list' ? '列出定时任务' : s === 'delete' ? '删除定时任务' : '停止所有定时任务' })) },
  { name: '/tools', desc: '查看当前可用工具', handledBy: 'callback', category: 'tools' },
  { name: '/cost', desc: '查看当前会话的 token 用量和费用', handledBy: 'callback', category: 'view' },
  { name: '/stats', desc: '查看统计（token/工具/费用）', usage: '/stats [models]', handledBy: 'callback', category: 'view',
    argCompleter: (partial) => ['models'].filter(s => s.startsWith(partial.toLowerCase())).map(s => ({ name: s, desc: '跨会话模型统计' })) },
  { name: '/logs', desc: '查看本会话最近日志', usage: '/logs [count]', handledBy: 'callback', category: 'view' },
  { name: '/traces', desc: '查看 Agent 执行时间线', handledBy: 'callback', category: 'view' },
  { name: '/wiki', desc: '管理 Repo Wiki 文档', usage: '/wiki [generate|update|status|list] [zh|en]', handledBy: 'callback', category: 'tools',
    argCompleter: (partial) => ['generate', 'update', 'status', 'list']
      .filter(s => s.startsWith(partial.toLowerCase()))
      .map(s => ({ name: s, desc: `Wiki ${s}` })) },
  { name: '/dream', desc: '整理 checkpoint 到结构化 MEMORY.md', handledBy: 'callback', category: 'session' },
  { name: '/distill', desc: '从会话历史提炼可复用资产（技能/命令/Agent）', usage: '/distill [回溯天数]', handledBy: 'callback', category: 'tools' },
];

const EN_COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/help': 'Show help',
  '/resume': 'Resume a session',
  '/session': 'Show the current session space',
  '/doctor': 'Show runtime diagnostics',
  '/permissions': 'Show permission layers',
  '/bughunt': 'Start the whitebox audit, instrumentation, and blackbox verification loop',
  '/bughunt-status': 'Show the current Bughunt situation summary',
  '/bughunt-report': 'Generate a factual report outline from the Bughunt ledger',
  '/office': 'Toggle Office mode (PPTX/DOCX/XLSX/PDF/HTML/Slidev/Canvas/parse)',
  '/workflow': 'Toggle Workflow mode (workflow action=create/add_node/connect/execute/...)',
  '/eternal': 'Set/manage Eternal goal mode',
  '/team': 'Show/switch collaboration mode',
  '/route': 'Set Leader execution route preference',
  '/mode': 'Switch permission mode',
  '/allow-tool': 'Add an allow rule',
  '/deny-tool': 'Add a deny rule',
  '/ask-tool': 'Add an ask rule',
  '/approve': 'Approve the current pending item (permission/plan)',
  '/deny': 'Deny the pending permission request',
  '/fetch': 'Fetch a web page',
  '/search': 'Search the web',
  '/ls': 'List a directory',
  '/open': 'Preview a file',
  '/tasks': 'Show the task overview',
  '/agents': 'Show the Agent overview',
  '/graph': 'Show the knowledge graph/blackboard',
  '/notes': 'Show Agent work notes',
  '/git': 'Show Git workspace status/diff',
  '/changes': 'Show session file changes/checkpoints',
  '/hooks': 'Show Hooks configuration',
  '/main': 'Switch back to the main channel',
  '/clear': 'Clear the current conversation (DB + memory)',
  '/compact': 'Compact the Leader context',
  '/fork': 'Fork the session from a specific message',
  '/history': 'Show session history',
  '/skills': 'Show available skills',
  '/mcp': 'Manage MCP servers / marketplace / tool discovery',
  '/projects': 'Show orchestration project dashboard',
  '/project-pause': 'Pause the current orchestration project',
  '/project-resume': 'Resume the current orchestration project',
  '/project-priority': 'Change the current orchestration project priority',
  '/project-replan': 'Force the current orchestration project to replan',
  '/project-reset': 'Force the current orchestration project into recovery/reset',
  '/project-unblock': 'Mark a dependency of the current orchestration project as fulfilled',
  '/project-archive': 'Archive the current orchestration project',
  '/models': 'Show currently available models',
  '/model': 'Switch the current model',
  '/intervene': 'Send an intervention message to an Agent',
  '/stop': 'Interrupt the current session',
  '/cancel-task': 'Cancel a task',
  '/refresh': 'Refresh the current view',
  '/reset': 'Reset the current view',
  '/broadcast': 'Broadcast a message to all Agents',
  '/quit': 'Exit the program',
  '/exit': 'Exit the program',
  '/language': 'Switch language',
  '/config': 'View/change configuration',
  '/loop': 'Create/manage scheduled tasks',
  '/tools': 'Show currently available tools',
  '/cost': 'Show token usage and cost for the current session',
  '/stats': 'Show statistics (tokens/tools/cost)',
  '/logs': 'Show recent logs for this session',
  '/traces': 'Show the Agent execution timeline',
  '/wiki': 'Manage Repo Wiki docs',
  '/dream': 'Consolidate checkpoints into a structured MEMORY.md',
  '/distill': 'Distill reusable assets (skills/commands/agents) from session history',
};

function localizeCommand(command: SlashCommandDefinition): SlashCommandDefinition {
  if (getLanguage() === 'zh') return command;
  return { ...command, desc: EN_COMMAND_DESCRIPTIONS[command.name] || command.desc };
}

/**
 * Build the list of custom commands as SlashCommandDefinitions for a workspace.
 * Built-in names always take precedence — a custom command sharing a built-in
 * name (e.g. /clear) is dropped to prevent shadowing. Returns [] when no
 * workspace is provided.
 */
function buildCustomCommandDefinitions(workspace: string | undefined): SlashCommandDefinition[] {
  if (!workspace) return [];
  const builtinNames = new Set(SLASH_COMMANDS.map((item) => item.name));
  return collectCustomCommands(workspace)
    .filter((command) => !builtinNames.has(command.slashName))
    .map((command) => ({
      name: command.slashName,
      desc: command.description,
      handledBy: 'callback' as const,
      category: 'tools' as const,
      includeInSuggestions: true,
      includeInHelp: true,
    }));
}

export function getSlashCommands(workspace?: string): SlashCommandDefinition[] {
  const builtins = SLASH_COMMANDS.map(localizeCommand);
  if (!workspace) return builtins;
  // Built-ins first; custom commands are appended after (and never shadow).
  const builtinNames = new Set(builtins.map((item) => item.name));
  const customs = buildCustomCommandDefinitions(workspace)
    .filter((item) => !builtinNames.has(item.name))
    .map(localizeCommand);
  return [...builtins, ...customs];
}

export function findSlashCommand(name: string, workspace?: string): SlashCommandDefinition | undefined {
  // Built-in precedence: if a static command matches, return it directly.
  const builtin = SLASH_COMMANDS.find((item) => item.name === name);
  if (builtin) return localizeCommand(builtin);
  if (!workspace) return undefined;
  const custom = buildCustomCommandDefinitions(workspace).find((item) => item.name === name);
  return custom ? localizeCommand(custom) : undefined;
}

export function isKnownSlashCommand(name: string, workspace?: string): boolean {
  if (SLASH_COMMANDS.some((command) => command.name === name)) return true;
  if (!workspace) return false;
  return buildCustomCommandDefinitions(workspace).some((command) => command.name === name);
}

export function isCallbackSlashCommand(name: string, workspace?: string): boolean {
  return findSlashCommand(name, workspace)?.handledBy === 'callback';
}

export function getSlashCommandMetadata(): Array<{ name: string; desc: string }> {
  return SLASH_COMMANDS
    .filter((item) => item.includeInSuggestions !== false)
    .map((command) => ({
      name: command.name,
      desc: localizeCommand(command).desc,
    }));
}

export function buildSlashHelpText(): string {
  const lines = [t('slash.help.title'), ''];
  const shown = SLASH_COMMANDS.filter((item) => item.includeInHelp !== false);

  for (const { key, labelKey } of CATEGORY_LABELS) {
    const group = shown.filter((cmd) => (cmd.category || 'misc') === key);
    if (group.length === 0) continue;
    lines.push(`▍${t(labelKey)}`);
    for (const command of group) {
      lines.push(`  ${command.usage || command.name} — ${localizeCommand(command).desc}`);
    }
    lines.push('');
  }

  lines.push(t('slash.help.image_upload'));
  lines.push(t('slash.help.image_example'));
  lines.push('');
  lines.push(t('slash.help.shortcuts'));
  lines.push(t('slash.help.ctrl_c'));
  lines.push(t('slash.help.ctrl_s'));
  lines.push(t('slash.help.ctrl_q'));
  lines.push(t('slash.help.ctrl_x'));
  lines.push(t('slash.help.ctrl_e'));
  lines.push(t('slash.help.ctrl_n'));
  lines.push(t('slash.help.ctrl_w'));
  lines.push(t('slash.help.ctrl_g'));
  lines.push(t('slash.help.ctrl_digits'));
  lines.push(t('slash.help.history'));
  lines.push(t('slash.help.mouse_wheel'));
  lines.push(t('slash.help.skill'));
  return lines.join('\n');
}
