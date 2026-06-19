import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { AssetUsageStore } from '../memory/AssetUsageStore.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager, ScheduledTaskRecord } from '../core/Database.js';
import type { SessionManager } from '../core/SessionManager.js';
import { buildTuiSnapshot } from '../cli_snapshot.js';
import { buildDirectoryPreview } from '../cli_helpers.js';
import { buildRuntimeDiagnosticsItems, buildRuntimeDiagnosticsPayload } from '../core/RuntimeDiagnostics.js';
import { ProjectRuntimeManager } from '../core/ProjectRuntimeManager.js';
import { EternalRuntimeTelemetry } from '../core/EternalRuntimeTelemetry.js';
import { ProjectRetentionPolicy } from '../core/ProjectRetentionPolicy.js';
import { BlockedAgingPolicy } from '../contracts/adapters/BlockedAgingPolicy.js';
import { detectSandboxCapabilities } from '../tools/implementations/ExecutionSandbox.js';
import {
  applyAndPersistPermissionUpdates,
  buildPermissionSurfaceItems,
  type PermissionUpdateDestination,
} from '../core/PermissionStore.js';
import { normalizeToolPermissionContext, summarizePermissionContextForDisplay } from '../core/PermissionSystem.js';
import {
  isProjectBacklogTerminalStatus,
  isProjectDependencyTerminalStatus,
  normalizeProjectRuntimeMode,
} from '../core/StateSemantics.js';
import { buildRoleSkillSurfaceItems, buildSkillSurfaceItems } from '../core/SkillCatalog.js';
import { getSessionScopeDescription } from '../tools/implementations/utils.js';
import { runFetchCommand, runSearchCommand } from '../cli_web.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import type { CommandMessageResult, CommandResult, RewindScope, RewindCheckpointSummary, RewindPreview } from './types.js';
import type { Checkpoint } from '../web-server/GitService.js';
import { ProjectControlService } from '../agents/ProjectControlService.js';
import { buildBughuntRequest } from './bughunt.js';
import { findCustomCommand, renderCommandBody } from './CustomCommandLoader.js';
import { appendBughuntEvent, buildBughuntBrief, generateBughuntReport, readBughuntLedger, startOrResumeBughuntLedger } from '../core/BughuntLedger.js';
import { getModelManager } from '../config/ModelManager.js';
import { config as runtimeConfig, setConfigValue, saveSettings, ConfigSchema } from '../config.js';
import {
  t,
  setSessionLanguage,
  getSessionLanguage,
  normalizeLanguage,
} from '../i18n.js';
import {
  OFFICE_TOOL_NAMES,
  WORKFLOW_TOOL_NAMES,
} from '../contracts/constants/leaderToolDefinitions.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CallbackCommandDispatcherContext {
  db: DatabaseManager;
  sessionManager: SessionManager;
  emitter: EventEmitter;
  cwd: string;
  getCurrentSessionId(): string | undefined;
  setCurrentSessionId(sessionId: string | undefined): void;
  scheduledTaskManager?: import('../core/ScheduledTaskManager.js').ScheduledTaskManager;
}

interface CommandHandlerContext {
  db: DatabaseManager;
  sessionManager: SessionManager;
  emitter: EventEmitter;
  cwd: string;
  currentSessionId: string | undefined;
  args: string[];
  commandLine: string;
  command: string;
  context: CallbackCommandDispatcherContext;
}

type CommandHandler = (ctx: CommandHandlerContext) => Promise<CommandResult | void> | CommandResult | void;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function systemMessage(content: string): CommandMessageResult {
  return { type: 'system', content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatEternalGoalForCommand(goal: { description: string; paused: boolean; updatedAt: number } | null | undefined): string {
  if (!goal) return '当前没有 Eternal 目标。使用 /eternal <目标> 启动持续目标模式。';
  const state = goal.paused ? 'paused' : 'active';
  return [
    `Eternal 目标模式: ${state}`,
    goal.description,
    `updatedAt=${new Date(goal.updatedAt).toISOString()}`,
  ].join('\n');
}

function getWorkspacePath(ctx: CommandHandlerContext): string {
  const { currentSessionId, db, cwd } = ctx;
  return currentSessionId
    ? (db.getSession(currentSessionId)?.workspace || cwd)
    : cwd;
}

// ─── Command Handlers ────────────────────────────────────────────────────────

async function handleHistoryCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { db } = ctx;
  const sessions = db.listSessions().slice(0, 20).map((session) => ({
    id: session.id,
    status: session.status,
    preview: (db.getConversation(session.id).slice(-1)[0]?.content
      ? String(db.getConversation(session.id).slice(-1)[0]?.content)
      : String(session.user_request)).replace(/\s+/g, ' ').slice(0, 80),
  }));
  if (sessions.length === 0) return systemMessage('暂无历史会话');
  return {
    type: 'table' as const,
    content: '选择历史会话恢复',
    action: 'history_modal' as const,
    items: sessions,
  };
}

function handleSkillsCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd } = ctx;
  const roleItems = currentSessionId
    ? buildRoleSkillSurfaceItems(db, currentSessionId)
    : [];
  return {
    type: 'system' as const,
    content: '已生成技能来源视图。打开技能面板查看 source、优先级和样例，回车查看详情。',
    action: 'skills_modal' as const,
    items: [...buildSkillSurfaceItems(cwd), ...roleItems].map((item) => ({
      id: item.id,
      status: item.status,
      preview: item.preview,
      detail: item.detail,
    })),
  };
}

async function handleMcpCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { handleMcpCommand: doMcp } = await import('./mcpCommand.js');
  const workspacePath = getWorkspacePath(ctx);
  return {
    type: 'code' as const,
    content: await doMcp(ctx.args, workspacePath),
  };
}

async function handleHooksCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { existsSync: fe, readFileSync: fr } = await import('fs');
  const { join: pj } = await import('path');
  const { homedir: hd } = await import('os');
  const { cwd } = ctx;
  const userSettingsFile = pj(hd(), '.lingxiao', 'settings.json');
  const projectSettingsFile = pj(cwd, '.lingxiao', 'settings.json');

  const lines: string[] = ['**Hooks 配置状态**\n'];

  for (const [label, file] of [['用户级', userSettingsFile], ['项目级', projectSettingsFile]] as const) {
    if (!fe(file)) {
      lines.push(`${label}: 未配置`);
      continue;
    }
    try {
      const settings: unknown = JSON.parse(fr(file, 'utf-8'));
      if (!isRecord(settings) || !isRecord(settings.hooks)) {
        lines.push(`${label}: 无 hooks 配置`);
        continue;
      }
      const events = Object.keys(settings.hooks);
      if (events.length === 0) {
        lines.push(`${label}: 无 hooks 配置`);
        continue;
      }
      lines.push(`${label} (${file}):`);
      for (const event of events) {
        const groups = settings.hooks[event];
        if (!Array.isArray(groups)) continue;
        const hookCount = groups.reduce((sum, group) => {
          if (!isRecord(group) || !Array.isArray(group.hooks)) return sum;
          return sum + group.hooks.length;
        }, 0);
        const matchers = groups.map((group) => {
          if (!isRecord(group)) return '*';
          return typeof group.matcher === 'string' && group.matcher.length > 0
            ? group.matcher
            : '*';
        }).join(', ');
        lines.push(`  ${event} → ${hookCount} hooks [matchers: ${matchers}]`);
      }
    } catch (err: unknown) {
      lines.push(`${label}: 解析失败 - ${getErrorMessage(err)}`);
    }
  }

  lines.push('\n配置方法: 在 settings.json 中添加 "hooks" 字段');
  lines.push('格式: {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "..."}]}]}}');
  lines.push('支持事件: PreToolUse, PostToolUse, Notification, UserPromptSubmit, Stop, SubagentStop, PreCompact, SessionStart, SessionEnd');
  return { type: 'code' as const, content: lines.join('\n') };
}

function handleModelsCommand(ctx: CommandHandlerContext): CommandResult {
  const allModels = getModelManager().getAllModels();
  if (allModels.length === 0) {
    return systemMessage('暂无可用模型');
  }
  const grouped: Record<string, typeof allModels> = {};
  for (const model of allModels) {
    const provider = model.provider || 'unknown';
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push(model);
  }
  const lines = ['**可用模型**\n'];
  for (const [provider, models] of Object.entries(grouped)) {
    lines.push(`**${provider.toUpperCase()}**`);
    for (const model of models) {
      const current = model.id === runtimeConfig.llm.leader_model ? ' ← 当前' : '';
      lines.push(`- \`${model.id}\`${current}`);
    }
    lines.push('');
  }
  lines.push(`当前模型: \`${runtimeConfig.llm.leader_model}\`\n使用 \`/model <id>\` 切换模型`);
  return { type: 'code' as const, content: lines.join('\n') };
}

function handleModelCommand(ctx: CommandHandlerContext): CommandResult {
  const { args, sessionManager } = ctx;
  const modelId = args[0];
  if (!modelId) {
    return systemMessage(`当前模型: ${runtimeConfig.llm.leader_model}\n用法: /model <model-id>\n使用 /models 查看可用模型列表`);
  }
  const modelManager = getModelManager();
  const modelConfig = modelManager.getModelById(modelId);
  if (!modelConfig) {
    const available = modelManager.getAllModels().map(m => m.id);
    return systemMessage(`模型 '${modelId}' 不存在\n可用模型: ${available.join(', ') || '无'}`);
  }
  const oldModel = runtimeConfig.llm.leader_model;
  setConfigValue('llm.leader_model', modelId);
  try {
    ConfigSchema.parse(runtimeConfig);
    saveSettings(runtimeConfig);
    sessionManager.setModelForActiveSessions(modelId);
    const provider = 'provider' in modelConfig ? modelConfig.provider : '';
    return systemMessage(`✓ 已切换模型: ${oldModel} → ${modelId}${provider ? ` (${provider})` : ''}\n来源: [file] (已持久化，已热加载到当前会话)`);
  } catch (e: unknown) {
    setConfigValue('llm.leader_model', oldModel);
    const msg = e instanceof Error ? e.message : '验证失败';
    return systemMessage(`✗ 模型切换失败: ${msg}`);
  }
}

function handleProjectsCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd } = ctx;
  const workspacePath = currentSessionId
    ? (db.getSession(currentSessionId)?.workspace || cwd)
    : cwd;
  const runtimeManager = new ProjectRuntimeManager(workspacePath);
  const telemetry = new EternalRuntimeTelemetry(workspacePath);
  const retentionPolicy = new ProjectRetentionPolicy();
  const agingPolicy = new BlockedAgingPolicy();
  const items = runtimeManager.listProjectIds().map((projectId) => {
    const record = runtimeManager.loadProject(projectId)!;
    const trends = telemetry.summarizeTrends(projectId);
    const audit = telemetry.loadAudit(projectId);
    const runtimeMode = normalizeProjectRuntimeMode(record.state.mode);
    const retention = retentionPolicy.evaluate({
      completedAt: runtimeMode === 'completed' ? record.state.lastActionAt * 1000 : undefined,
      archivedAt: runtimeMode === 'archived' ? record.state.lastActionAt * 1000 : undefined,
      transferCount: 0,
      auditCount: audit.length,
      trendSamples: trends.samples,
    });
    const blockedAging = agingPolicy.evaluate({
      blockedSinceAt: runtimeMode === 'blocked' || runtimeMode === 'waiting'
        ? record.state.lastActionAt * 1000
        : undefined,
    });
    const backlogRemaining = record.backlog.filter((item) => !isProjectBacklogTerminalStatus(item.status)).length;
    const unresolvedDependencies = record.dependencyLedger.entries.filter((entry) => !isProjectDependencyTerminalStatus(entry.status)).length;
    return {
      id: projectId,
      status: record.state.mode,
      preview: `${projectId} · backlog=${backlogRemaining} · deps=${unresolvedDependencies}`,
      detail: [
        `[Project] ${projectId}`,
        `mode=${record.state.mode}`,
        typeof record.metadata?.priority === 'string' ? `priority=${record.metadata.priority}` : '',
        `backlog_remaining=${backlogRemaining}`,
        `audit_entries=${audit.length}`,
        `trend_samples=${trends.samples}`,
        trends.latest ? `latest_trend_at=${trends.latest.at}` : '',
        `trend_repairs=${trends.deltas.repairs}`,
        `trend_resets=${trends.deltas.resets}`,
        `trend_stale_rejected=${trends.deltas.staleRejected}`,
        `retention_state=${retention.state}`,
        `blocked_aging=${blockedAging.severity}`,
      ].filter(Boolean).join('\n'),
    };
  });
  return {
    type: 'system' as const,
    content: '已生成 orchestration 项目看板。',
    action: 'projects_modal' as const,
    items,
  };
}

function handleProjectControlCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd, args, command } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const workspacePath = db.getSession(currentSessionId)?.workspace || cwd;
  const control = new ProjectControlService(db as never, workspacePath);
  if (command === '/project-pause') {
    return systemMessage(control.apply('pause', { sessionId: currentSessionId, reason: args.join(' ').trim() || undefined }));
  }
  if (command === '/project-resume') {
    return systemMessage(control.apply('resume', { sessionId: currentSessionId, reason: args.join(' ').trim() || undefined }));
  }
  if (command === '/project-priority') {
    const priority = (args[0] || '').toLowerCase() as 'critical' | 'high' | 'normal' | 'low';
    if (!['critical', 'high', 'normal', 'low'].includes(priority)) {
      return systemMessage('用法: /project-priority <critical|high|normal|low>');
    }
    return systemMessage(control.apply('reprioritize', { sessionId: currentSessionId, priority }));
  }
  if (command === '/project-replan') {
    return systemMessage(control.apply('force_replan', { sessionId: currentSessionId, reason: args.join(' ').trim() || undefined }));
  }
  if (command === '/project-reset') {
    return systemMessage(control.apply('force_reset', { sessionId: currentSessionId, reason: args.join(' ').trim() || undefined }));
  }
  if (command === '/project-unblock') {
    const dependencyId = args[0];
    if (!dependencyId) return systemMessage('用法: /project-unblock <dependency-id>');
    return systemMessage(control.apply('resolve_dependency', { sessionId: currentSessionId, dependencyId, reason: args.slice(1).join(' ').trim() || undefined }));
  }
  if (command === '/project-archive') {
    return systemMessage(control.apply('archive', { sessionId: currentSessionId, reason: args.join(' ').trim() || undefined }));
  }
  return systemMessage('未知的项目控制命令');
}

function handleLsCommand(ctx: CommandHandlerContext): CommandResult {
  const { args, currentSessionId, db, cwd } = ctx;
  const target = args[0] || '.';
  const baseDir = currentSessionId ? (db.getSession(currentSessionId)?.workspace || cwd) : cwd;
  const absPath = resolve(baseDir, target);
  if (!existsSync(absPath)) return systemMessage(`路径不存在: ${target}`);
  return { type: 'table' as const, content: buildDirectoryPreview(absPath, 2) };
}

function handleOpenCommand(ctx: CommandHandlerContext): CommandResult {
  const { args, currentSessionId, db, cwd } = ctx;
  const target = args[0];
  if (!target) return systemMessage('请指定文件路径: /open <path>');
  const baseDir = currentSessionId ? (db.getSession(currentSessionId)?.workspace || cwd) : cwd;
  const absPath = resolve(baseDir, target);
  if (!existsSync(absPath)) return systemMessage(`文件不存在: ${target}`);
  const content = readFileSync(absPath, 'utf-8').split('\n').slice(0, 200).join('\n');
  return { type: 'code' as const, content: `文件: ${absPath}\n\n${content}` };
}

async function handleFetchCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const url = ctx.args[0];
  if (!url) return systemMessage('用法: /fetch <url>');
  return { type: 'code' as const, content: await runFetchCommand(url) };
}

async function handleSearchCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const query = ctx.args.join(' ').trim();
  if (!query) return systemMessage('用法: /search <query>');
  return { type: 'code' as const, content: await runSearchCommand(query) };
}

function handleDoctorCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, sessionManager, db, cwd } = ctx;
  const session = currentSessionId ? sessionManager.getSession(currentSessionId) : undefined;
  const workspacePath = getWorkspacePath(ctx);
  const payload = buildRuntimeDiagnosticsPayload({
    db,
    workspace: workspacePath,
    sessionId: currentSessionId,
    session,
    detectSandboxCapabilities,
  });
  return {
    type: 'system' as const,
    content: '已生成运行时诊断。打开诊断面板查看分组摘要，回车可查看某一组详情。',
    action: 'doctor_modal' as const,
    items: buildRuntimeDiagnosticsItems(payload).map((item) => ({
      id: item.id,
      status: item.status,
      preview: item.preview,
      detail: item.detail,
    })),
  };
}

function handleSessionCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd } = ctx;
  const workspacePath = getWorkspacePath(ctx);
  const mode = currentSessionId ? db.getSessionState(currentSessionId, SESSION_KEYS.LEADER_EXECUTION_MODE) : null;
  const reason = currentSessionId ? db.getSessionState(currentSessionId, SESSION_KEYS.LEADER_EXECUTION_REASON) : null;
  const permission = summarizePermissionContextForDisplay(
    normalizeToolPermissionContext(currentSessionId ? db.getSessionState(currentSessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT) : null),
  );
  const routeInfo = currentSessionId
    ? `\nLeader mode: ${typeof mode === 'string' ? mode : 'unknown'}\nLeader reason: ${typeof reason === 'string' ? reason : 'unknown'}\nPermission: ${permission}`
    : '';
  if (!currentSessionId) {
    return systemMessage(`${getSessionScopeDescription(cwd)}${routeInfo}`);
  }
  return systemMessage(`${getSessionScopeDescription(workspacePath, currentSessionId)}${routeInfo}`);
}

function handlePermissionsCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd } = ctx;
  const workspacePath = getWorkspacePath(ctx);
  const sessionKey = currentSessionId || 'preview';
  return {
    type: 'system' as const,
    content: '已生成权限诊断。打开权限面板查看 effective、layers 与待处理批准请求。',
    action: 'permissions_modal' as const,
    items: buildPermissionSurfaceItems(db, workspacePath, sessionKey).map((item) => ({
      id: item.id,
      status: item.status,
      preview: item.preview,
      detail: item.detail,
    })),
  };
}

async function handleBughuntCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, sessionManager, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const target = args.join(' ').trim() || '当前工作区';
  const previous = readBughuntLedger(db, currentSessionId);
  startOrResumeBughuntLedger(db, currentSessionId, target);
  if (previous) {
    appendBughuntEvent(db, currentSessionId, {
      kind: 'status_change',
      summary: `Bughunt resumed with target=${target}`,
      finding_ids: [],
      files: [],
      commands: [],
      exit_codes: [],
      evidence: [],
    });
  }
  await sessionManager.sendUserInput(currentSessionId, buildBughuntRequest(target));
  return systemMessage(`已启动 Bughunt 闭环：${target || '当前工作区'}`);
}

function handleBughuntStatusCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const ledger = readBughuntLedger(db, currentSessionId);
  if (!ledger) return systemMessage('当前会话没有活跃的 Bughunt ledger。使用 /bughunt [范围] 启动。');
  return { type: 'code' as const, content: buildBughuntBrief(ledger) };
}

function handleBughuntReportCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const ledger = readBughuntLedger(db, currentSessionId);
  if (!ledger) return systemMessage('当前会话没有活跃的 Bughunt ledger。使用 /bughunt [范围] 启动。');
  return { type: 'code' as const, content: generateBughuntReport(ledger) };
}

function handleOfficeCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, emitter, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const arg = (args[0] || '').toLowerCase();
  const current = db.getSessionState(currentSessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
  const next = arg === 'off' ? false : arg === 'on' ? true : !current;
  db.setSessionState(currentSessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE, String(next));
  emitter.emit('plugin:toggled', {
    pluginId: 'office',
    enabled: next,
    sessionId: currentSessionId,
    toolNames: OFFICE_TOOL_NAMES,
    toolCount: OFFICE_TOOL_NAMES.length,
  });
  const toolList = next ? `${OFFICE_TOOL_NAMES.length} 个 PPT/DOCX/XLSX/PDF/HTML/Slidev/Canvas/解析工具已加载` : '办公工具已卸载';
  return systemMessage(next
    ? `Office 模式已开启 — ${toolList}\n可用：/office off 关闭`
    : `Office 模式已关闭 — 回到纯 Coding 模式\n可用：/office on 开启`);
}

function handleWorkflowCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, emitter, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const arg = (args[0] || '').toLowerCase();
  const current = db.getSessionState(currentSessionId, SESSION_KEYS.WORKFLOW_MODE_ACTIVE) === 'true';
  const next = arg === 'off' ? false : arg === 'on' ? true : !current;
  db.setSessionState(currentSessionId, SESSION_KEYS.WORKFLOW_MODE_ACTIVE, String(next));
  emitter.emit('plugin:toggled', {
    pluginId: 'workflow',
    enabled: next,
    sessionId: currentSessionId,
    toolNames: WORKFLOW_TOOL_NAMES,
    toolCount: WORKFLOW_TOOL_NAMES.length,
  });
  return systemMessage(next
    ? `Workflow 模式已开启 — ${WORKFLOW_TOOL_NAMES.length} 个 workflow_* 工具已注入到 Leader\n可用：/workflow off 关闭`
    : 'Workflow 模式已关闭 — workflow_* 工具已卸载\n可用：/workflow on 开启');
}

function handleTeamCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, sessionManager, db, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const sub = (args[0] || 'status').toLowerCase();
  if (sub === 'status') {
    const mode = db.getSessionState(currentSessionId, SESSION_KEYS.COLLABORATION_MODE);
    const activeTeam = db.getSessionState(currentSessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM);
    return systemMessage(`Collaboration: ${mode === 'team' ? 'team' : 'solo'}\nActive team: ${typeof activeTeam === 'string' && activeTeam.trim() ? activeTeam : '(none)'}`);
  }
  if (sub !== 'on' && sub !== 'off' && sub !== 'team' && sub !== 'solo') {
    return systemMessage('用法: /team status|on|off');
  }
  const mode = sub === 'on' || sub === 'team' ? 'team' : 'solo';
  const result = sessionManager.setCollaborationMode(currentSessionId, mode);
  return systemMessage(result.message);
}

function handleRouteCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, sessionManager, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const mode = (args[0] || '').toLowerCase();
  if (mode !== 'auto' && mode !== 'direct' && mode !== 'hybrid' && mode !== 'delegate') {
    return systemMessage('用法: /route <auto|direct|delegate>');
  }
  const result = sessionManager.setExecutionRoutePreference(currentSessionId, mode);
  return systemMessage(result.message);
}

async function handleEternalCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager, args, commandLine, command } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const raw = commandLine.slice(command.length).trim();
  const sub = (args[0] || '').toLowerCase();
  if (!raw || sub === 'status') {
    const goal = sessionManager.getEternalGoal(currentSessionId);
    return systemMessage(formatEternalGoalForCommand(goal));
  }
  if (sub === 'pause') {
    const result = await sessionManager.setEternalGoalPaused(currentSessionId, true);
    return systemMessage(result.ok ? `${result.message}\n${formatEternalGoalForCommand(result.goal)}` : result.message);
  }
  if (sub === 'resume') {
    const result = await sessionManager.setEternalGoalPaused(currentSessionId, false);
    return systemMessage(result.ok ? `${result.message}\n${formatEternalGoalForCommand(result.goal)}` : result.message);
  }
  if (sub === 'clear' || sub === 'delete' || sub === 'remove') {
    const result = await sessionManager.clearEternalGoal(currentSessionId);
    return systemMessage(result.message);
  }
  const description = sub === 'set' ? args.slice(1).join(' ').trim() : raw;
  if (!description) return systemMessage('用法: /eternal <要持续完成的目标>|status|pause|resume|clear');
  const result = await sessionManager.setEternalGoal(currentSessionId, description);
  return systemMessage(result.ok ? `${result.message}\n${formatEternalGoalForCommand(result.goal)}` : result.message);
}

function handleModeCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd, args, emitter } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const rawMode = (args[0] || '').toLowerCase();
  const requestedMode = rawMode as 'strict' | 'dev' | 'networked' | 'yolo' | undefined;
  const destination = (args[1] as PermissionUpdateDestination | undefined) || 'session';
  if (!requestedMode || !['strict', 'dev', 'networked', 'yolo'].includes(requestedMode)) {
    return systemMessage('用法: /mode <strict|dev|networked|yolo> [session|project|local|user]');
  }
  const workspacePath = db.getSession(currentSessionId)?.workspace || cwd;
  const permissionContext = applyAndPersistPermissionUpdates(
    db, workspacePath, currentSessionId,
    [{ type: 'setMode', mode: requestedMode }],
    destination,
  );
  emitter.emit('permission:mode_changed', {
    sessionId: currentSessionId,
    mode: permissionContext.mode,
    summary: summarizePermissionContextForDisplay(permissionContext),
  });
  return systemMessage(`已将权限模式更新为 ${requestedMode} (${destination})`);
}

function handleToolPermissionCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, cwd, args, command, emitter } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const toolName = args[0];
  const maybeScope = args[args.length - 1];
  const destination = (['session', 'project', 'local', 'user'].includes(maybeScope || '')
    ? maybeScope
    : 'session') as PermissionUpdateDestination;
  const patternTokens = ['session', 'project', 'local', 'user'].includes(maybeScope || '')
    ? args.slice(1, -1)
    : args.slice(1);
  const pattern = patternTokens.join(' ').trim() || undefined;
  if (!toolName) return systemMessage(`用法: ${command} <tool> [pattern] [session|project|local|user]`);
  const behavior = command === '/allow-tool' ? 'allow' : command === '/deny-tool' ? 'deny' : 'ask';
  const workspacePath = db.getSession(currentSessionId)?.workspace || cwd;
  const permissionContext = applyAndPersistPermissionUpdates(
    db, workspacePath, currentSessionId,
    [{ type: 'addRules', behavior, rules: [{ toolName, pattern }] }],
    destination,
  );
  emitter.emit('permission:mode_changed', {
    sessionId: currentSessionId,
    mode: permissionContext.mode,
    summary: summarizePermissionContextForDisplay(permissionContext),
  });
  return systemMessage(`已添加 ${behavior} 规则: ${toolName}${pattern ? ` (${pattern})` : ''} [${destination}]`);
}

async function handleApproveOrDenyCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager, command } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  await sessionManager.sendUserInput(currentSessionId, command);
  return systemMessage(`已发送 ${command}`);
}

async function handleResumeCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager, db, args, context } = ctx;
  if (args[0]) {
    const prevSessionId = context.getCurrentSessionId();
    if (prevSessionId && prevSessionId !== args[0]) {
      await sessionManager.interruptSession(prevSessionId).catch(() => {});
    }
    context.setCurrentSessionId(args[0]);
    const resumed = await sessionManager.resumeSession(args[0]);
    if (!resumed) return systemMessage(`会话不存在: ${args[0]}`);
    const snapshot = buildTuiSnapshot(db, args[0]);
    return snapshot
      ? {
          action: 'hydrate' as const,
          content: `已恢复会话 ${args[0]}`,
          sessionStatus: snapshot.sessionStatus,
          tasks: snapshot.tasks,
          messages: snapshot.messages,
          channels: snapshot.channels,
          tokenUsage: snapshot.tokenUsage,
          agentTokens: snapshot.agentTokens,
          leaderStatus: snapshot.leaderStatus,
          leaderMode: snapshot.leaderMode,
          leaderReason: snapshot.leaderReason,
        }
      : systemMessage(`已恢复会话 ${args[0]}`);
  }

  const sessions = db.listSessions().slice(0, 20).map((session) => ({
    id: session.id,
    status: session.status,
    preview: (db.getConversation(session.id).slice(-1)[0]?.content
      ? String(db.getConversation(session.id).slice(-1)[0]?.content)
      : String(session.user_request)).replace(/\s+/g, ' ').slice(0, 80),
  }));
  if (sessions.length === 0) return systemMessage('暂无可恢复会话');
  return {
    type: 'table' as const,
    content: '选择一个历史会话恢复',
    action: 'resume_modal' as const,
    sessions,
  };
}

async function handleStopCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const ok = await sessionManager.interruptSession(currentSessionId);
  return systemMessage(ok ? '已中断当前会话' : '会话未运行');
}

async function handleCancelTaskCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager, db, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const taskId = args[0];
  const reason = args.slice(1).join(' ').trim() || '用户取消任务';
  if (!taskId) return systemMessage('用法: /cancel-task <task-id> [reason]');

  const result = await sessionManager.cancelTask(currentSessionId, taskId, reason);
  if (!result.ok) return systemMessage(result.message);

  const snapshot = buildTuiSnapshot(db, currentSessionId);
  return snapshot
    ? {
        action: 'hydrate' as const,
        content: result.message,
        sessionStatus: snapshot.sessionStatus,
        tasks: snapshot.tasks,
        messages: snapshot.messages,
        channels: snapshot.channels,
        tokenUsage: snapshot.tokenUsage,
        agentTokens: snapshot.agentTokens,
        leaderStatus: snapshot.leaderStatus,
        leaderMode: snapshot.leaderMode,
        leaderReason: snapshot.leaderReason,
      }
    : systemMessage(result.message);
}

function handleRefreshCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const snapshot = buildTuiSnapshot(db, currentSessionId);
  if (!snapshot) return systemMessage('会话不存在');
  return {
    action: 'hydrate' as const,
    content: `已刷新会话 ${currentSessionId}`,
    sessionStatus: snapshot.sessionStatus,
    tasks: snapshot.tasks,
    messages: snapshot.messages,
    channels: snapshot.channels,
    tokenUsage: snapshot.tokenUsage,
    agentTokens: snapshot.agentTokens,
    leaderStatus: snapshot.leaderStatus,
    leaderMode: snapshot.leaderMode,
    leaderReason: snapshot.leaderReason,
  };
}

async function handleBroadcastCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager, args } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const msg = args.join(' ');
  if (!msg) return systemMessage('请指定广播消息: /broadcast <message>');
  await sessionManager.sendUserInput(currentSessionId, `[BROADCAST] ${msg}`);
  const session = sessionManager.getSession(currentSessionId);
  if (session) {
    try {
      const agents = session.pool?.getAll?.() || [];
      for (const agent of agents) {
        if (agent.name && agent.name !== 'main') {
          await sessionManager.sendAgentInput(currentSessionId, agent.name, msg);
        }
      }
      return systemMessage(`已广播给 ${agents.length} 个 Agent: ${msg}`);
    } catch {/* expected: fallback to default */
      return systemMessage('广播 Agent 不可用');
    }
  }
  return systemMessage('会话未就绪');
}

function handleInterveneCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, sessionManager, commandLine, command } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const session = sessionManager.getSession(currentSessionId);
  if (!session) return systemMessage('会话未就绪');

  const raw = commandLine.slice(command.length).trim();
  const match = raw.match(/^@?(\S+)\s+(.+)$/);
  if (!match) return systemMessage('用法: /intervene @agent <message>');
  const agentName = match[1];
  const instruction = match[2].trim();
  if (!instruction) return systemMessage('干预消息不能为空');

  try {
    session.pool.interveneAgent(agentName, instruction);
    return systemMessage(`干预消息已发送到 @${agentName}`);
  } catch (err) {
    return systemMessage(`干预失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleCompactCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, sessionManager } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  const session = sessionManager.getSession(currentSessionId);
  if (!session?.leader) return systemMessage('Leader 未就绪');
  try {
    const leader = session.leader;
    if (typeof leader.compactContext !== 'function') return systemMessage('Leader 不支持压缩');
    const result = await leader.compactContext();
    if (result?.inProgress) {
      return systemMessage(`上下文压缩已在进行中: ${result.oldTokens ?? '?'} tokens`);
    }
    if (result?.overflow) {
      return systemMessage(`上下文压缩后仍超限: ${result.oldTokens ?? '?'} → ${result.newTokens ?? '?'} tokens，已触发溢出保护`);
    }
    if (result?.compacted === false) {
      const oldTokens = typeof result.oldTokens === 'number' ? result.oldTokens : undefined;
      const threshold = typeof result.threshold === 'number' ? result.threshold : undefined;
      if (oldTokens !== undefined && threshold !== undefined && oldTokens > threshold) {
        return systemMessage(`上下文仍需压缩但本次未产生压缩结果: ${oldTokens} tokens / 阈值 ${threshold}`);
      }
      return systemMessage(`无需压缩: ${result.oldTokens ?? '?'} tokens`);
    }
    const type = result?.compactType ? ` (${result.compactType})` : '';
    return systemMessage(`上下文已压缩${type}: ${result?.oldTokens ?? '?'} → ${result?.newTokens ?? '?'} tokens`);
  } catch (err) {
    return systemMessage(`压缩失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleClearCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, db, sessionManager } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  try {
    db.clearConversation(currentSessionId);
    const session = sessionManager.getSession(currentSessionId);
    session?.bus?.clearHistory?.();
    return systemMessage('对话历史已清空');
  } catch (err) {
    return systemMessage(`清空失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleLanguageCommand(ctx: CommandHandlerContext): CommandResult {
  const langArg = ctx.args[0];
  if (!langArg) {
    return systemMessage(t('cmd.language.current', getSessionLanguage()) as unknown as string);
  }
  try {
    const normalized = normalizeLanguage(langArg);
    setSessionLanguage(normalized);
    return systemMessage(t('cmd.language.changed', normalized) as unknown as string);
  } catch (e) {
    return systemMessage(t('cmd.language.invalid', langArg) as unknown as string);
  }
}

async function handleToolsCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { handleToolsCommand: doTools } = await import('./toolsCommand.js');
  return systemMessage(await doTools(ctx.sessionManager, ctx.currentSessionId));
}

async function handleCostCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db } = ctx;
  const { calculateSessionCost, formatCostReport } = await import('../llm/CostService.js');
  if (!currentSessionId) {
    return { action: 'report_modal' as const, title: '费用', report: '当前没有活动会话。\n\n开始对话后,此处将显示各模型的 token 用量与费用明细。', content: '' };
  }
  const summary = db.getTokenSummary(currentSessionId);
  if (summary.length === 0) {
    return { action: 'report_modal' as const, title: '费用', report: '本会话暂无 token 使用记录。\n\n开始对话后,此处将显示各模型的 token 用量与费用明细。', content: '' };
  }
  const modelStats = summary.map(s => ({
    name: s.agent_name || s.agent_id,
    totalPrompt: s.prompt,
    totalCompletion: s.completion,
    cacheRead: s.cache_read,
    cacheCreation: s.cache_creation,
  }));
  const costSummary = calculateSessionCost(modelStats);
  return { action: 'report_modal' as const, title: '费用', report: formatCostReport(costSummary), content: '' };
}

async function handleStatsCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, args } = ctx;
  const { buildSessionStatsReport, buildModelStatsReport } = await import('./statsReport.js');
  const { calculateSessionCost, formatCostReport } = await import('../llm/CostService.js');
  const scope = (args[0] || '').toLowerCase();

  if (scope === 'models' || scope === 'model') {
    return { action: 'report_modal' as const, title: '模型统计', report: buildModelStatsReport(db), content: '' };
  }

  const parts: string[] = [buildSessionStatsReport(db, currentSessionId)];
  if (currentSessionId) {
    const summary = db.getTokenSummary(currentSessionId);
    if (summary.length > 0) {
      const costSummary = calculateSessionCost(summary.map(s => ({
        name: s.agent_name || s.agent_id,
        totalPrompt: s.prompt,
        totalCompletion: s.completion,
        cacheRead: s.cache_read,
        cacheCreation: s.cache_creation,
      })));
      parts.push('');
      parts.push(formatCostReport(costSummary));
    }
  }
  return { action: 'report_modal' as const, title: '统计', report: parts.join('\n'), content: '' };
}

async function handleLogsCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, args } = ctx;
  const { buildLogsReport } = await import('./statsReport.js');
  const limit = Number.parseInt(args[0] || '', 10);
  return { action: 'report_modal' as const, title: '日志', report: buildLogsReport(db, currentSessionId, Number.isFinite(limit) && limit > 0 ? limit : 40), content: '' };
}

async function handleTracesCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db } = ctx;
  const { buildTracesReport } = await import('./statsReport.js');
  return { action: 'report_modal' as const, title: '执行时间线', report: buildTracesReport(db, currentSessionId), content: '' };
}

async function handleChangesCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db } = ctx;
  const { buildChangesReport } = await import('./changesReport.js');
  return { action: 'report_modal' as const, title: '文件变更', report: await buildChangesReport(db, currentSessionId), content: '' };
}

// ─── /rewind helpers ─────────────────────────────────────────────────────────

export function normalizeRewindScope(raw: string | undefined): RewindScope | undefined {
  if (raw === 'code' || raw === 'conversation' || raw === 'all') return raw;
  return undefined;
}

export function toRewindSummary(cp: Checkpoint): RewindCheckpointSummary {
  return {
    id: cp.id,
    label: cp.label,
    timestamp: cp.timestamp,
    type: cp.type,
    isDbOnly: cp.id.startsWith('db-'),
    turnNumber: cp.turnNumber,
    toolName: cp.toolName,
    actorType: cp.actorType,
    agentName: cp.agentName,
    fileCount: cp.files.length,
    additions: cp.additions,
    deletions: cp.deletions,
  };
}

/** 回退点之后将被 truncateAfter 删除的对话消息数（leader_conversation.timestamp > ts）。 */
export function countMessagesAfter(db: DatabaseManager, sessionId: string, ts: number): number {
  try {
    const msgs = db.getConversation(sessionId);
    let n = 0;
    for (const m of msgs) {
      const t = (m as { timestamp?: number }).timestamp;
      if (typeof t === 'number' && t > ts) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

function isLeaderBusyNow(sessionManager: SessionManager, sessionId: string): boolean {
  const session = sessionManager.getSession(sessionId);
  return Boolean(session && (session.isLeaderBusy || session.leader?.isRunning));
}

function rewindModalResult(partial: {
  stage: 'pick' | 'scope' | 'confirm';
  content?: string;
  checkpointId?: string;
  scope?: RewindScope;
  checkpoints?: RewindCheckpointSummary[];
  workingChangesSummary?: { fileCount: number; additions: number; deletions: number } | null;
  isDbOnly?: boolean;
  preview?: RewindPreview;
  crossSession?: { hasOtherSessionChanges: boolean; otherSessionIds: string[] };
  leaderBusy?: boolean;
}): CommandResult {
  return { type: 'system', content: partial.content ?? '', action: 'rewind_modal', ...partial };
}

/**
 * /rewind — 交互式检查点回退（比 Claude Code 的整体回退更强：可选范围 + 预览 + 跨会话警告 + 显式确认）。
 *
 * 三阶段，由 re-dispatch 驱动：
 *   /rewind                       → stage 'pick'   列检查点 + 工作区伪条目
 *   /rewind <id>                  → stage 'scope'  差异预览 + 范围选择
 *   /rewind <id> <scope>          → stage 'confirm' 精确计划 + 确认
 *   /rewind <id> <scope> confirm  → 执行（interrupt-if-busy → revert → warm-restart → hydrate）
 *
 * 后端原语全部复用 FileChangesApi（shadow git + DB truncate）；不重写回滚逻辑。
 */
async function handleRewindCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, sessionManager, args } = ctx;
  if (!currentSessionId) return systemMessage(t('cmd.rewind.no_session'));
  const session = db.getSession(currentSessionId);
  if (!session?.workspace) return systemMessage(t('cmd.rewind.no_workspace'));

  const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
  const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
  const api = new FileChangesApi(new DatabaseRepositoryAdapter(db));
  const leaderBusy = isLeaderBusyNow(sessionManager, currentSessionId);

  // ── 0 参：stage 'pick' ────────────────────────────────────────────────────
  if (args.length === 0) {
    let summaries: RewindCheckpointSummary[] = [];
    let workingChangesSummary: { fileCount: number; additions: number; deletions: number } | null = null;
    try {
      const [checkpoints, working] = await Promise.all([
        api.getCheckpoints(currentSessionId),
        api.getWorkingChanges(currentSessionId),
      ]);
      summaries = checkpoints.map(toRewindSummary);
      if (working.length > 0) {
        let add = 0;
        let del = 0;
        for (const f of working) { add += f.additions; del += f.deletions; }
        workingChangesSummary = { fileCount: working.length, additions: add, deletions: del };
      }
    } catch (err) {
      return systemMessage(t('cmd.rewind.load_failed', getErrorMessage(err)));
    }
    if (summaries.length === 0 && !workingChangesSummary) {
      return systemMessage(t('cmd.rewind.empty'));
    }
    return rewindModalResult({
      stage: 'pick',
      checkpoints: summaries,
      workingChangesSummary,
      leaderBusy,
      content: t('cmd.rewind.pick_loaded', summaries.length),
    });
  }

  const cpId = args[0];

  // ── 'working' 伪条目：丢弃全部未提交（revertAll），scope 固定 code ──────────
  if (cpId === 'working') {
    if (args.length === 1) {
      let working;
      try { working = await api.getWorkingChanges(currentSessionId); }
      catch (err) { return systemMessage(t('cmd.rewind.load_failed', getErrorMessage(err))); }
      const files = working.slice(0, 20).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
      return rewindModalResult({
        stage: 'confirm',
        checkpointId: 'working',
        scope: 'code',
        preview: { files, messagesAfter: 0 },
        leaderBusy,
        content: t('cmd.rewind.working_entry', working.length),
      });
    }
    // /rewind working code confirm → 执行
    if (args.length >= 3 && args[2] === 'confirm') {
      try {
        const res = await api.revertAll(currentSessionId);
        if (!res.success) return systemMessage(t('cmd.rewind.exec_failed', res.error ?? 'unknown'));
        return hydrateAfterRewind(ctx, t('cmd.rewind.done_working'));
      } catch (err) {
        return systemMessage(t('cmd.rewind.exec_failed', getErrorMessage(err)));
      }
    }
    return systemMessage(t('cmd.rewind.usage'));
  }

  // ── 1 参：stage 'scope'（差异预览 + 跨会话警告 + 影响统计） ──────────────────
  if (args.length === 1) {
    let cps: Checkpoint[] = [];
    try { cps = await api.getCheckpoints(currentSessionId); }
    catch (err) { return systemMessage(t('cmd.rewind.load_failed', getErrorMessage(err))); }
    const cp = cps.find((c) => c.id === cpId);
    if (!cp) return systemMessage(t('cmd.rewind.cp_not_found', cpId));
    const isDbOnly = cpId.startsWith('db-');
    const messagesAfter = countMessagesAfter(db, currentSessionId, cp.timestamp);
    const preview: RewindPreview = {
      files: cp.files.slice(0, 20).map((path) => ({ path, additions: 0, deletions: 0 })),
      messagesAfter,
    };
    let crossSession = { hasOtherSessionChanges: false, otherSessionIds: [] as string[] };
    if (!isDbOnly) {
      try {
        crossSession = await api.getOtherSessionChanges(currentSessionId, cpId);
      } catch { /* 跨会话检测失败不阻塞流程 */ }
    }
    return rewindModalResult({
      stage: 'scope',
      checkpointId: cpId,
      checkpoints: [toRewindSummary(cp)],
      isDbOnly,
      preview,
      crossSession,
      leaderBusy,
      content: t('cmd.rewind.scope_loaded', cp.label.slice(0, 40)),
    });
  }

  // ── 2 参：stage 'confirm'（校验 scope + db-only 限制） ──────────────────────
  if (args.length === 2) {
    const scopeRaw = args[1];
    const scope = normalizeRewindScope(scopeRaw);
    if (!scope) return systemMessage(t('cmd.rewind.bad_scope', scopeRaw));
    const isDbOnly = cpId.startsWith('db-');
    if (isDbOnly && scope !== 'conversation') {
      return systemMessage(t('cmd.rewind.db_only_conversation'));
    }
    // 复用 scope 阶段数据组装确认计划
    let cps: Checkpoint[] = [];
    let crossSession = { hasOtherSessionChanges: false, otherSessionIds: [] as string[] };
    let messagesAfter = 0;
    let summary: RewindCheckpointSummary | undefined;
    try {
      cps = await api.getCheckpoints(currentSessionId);
      const cp = cps.find((c) => c.id === cpId);
      if (cp) {
        summary = toRewindSummary(cp);
        messagesAfter = countMessagesAfter(db, currentSessionId, cp.timestamp);
        if (!isDbOnly) {
          try { crossSession = await api.getOtherSessionChanges(currentSessionId, cpId); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      return systemMessage(t('cmd.rewind.load_failed', getErrorMessage(err)));
    }
    if (!summary) return systemMessage(t('cmd.rewind.cp_not_found', cpId));
    return rewindModalResult({
      stage: 'confirm',
      checkpointId: cpId,
      scope,
      checkpoints: [summary],
      isDbOnly,
      preview: { files: [], messagesAfter },
      crossSession,
      leaderBusy,
      content: t('cmd.rewind.confirm_ready'),
    });
  }

  // ── 3 参：执行 ─────────────────────────────────────────────────────────────
  if (args.length >= 3) {
    if (args[2] !== 'confirm') return systemMessage(t('cmd.rewind.need_confirm'));
    const scope = normalizeRewindScope(args[1]);
    if (!scope) return systemMessage(t('cmd.rewind.bad_scope', args[1]));
    const isDbOnly = cpId.startsWith('db-');
    if (isDbOnly && scope !== 'conversation') {
      return systemMessage(t('cmd.rewind.db_only_conversation'));
    }
    const touchesConversation = scope === 'conversation' || scope === 'all';

    // 1) 触及对话且 Leader 忙 → 先中断（停 leader+pool，释放 worker 以便重生时重新水合）
    if (leaderBusy && touchesConversation) {
      try { await sessionManager.interruptSession(currentSessionId); }
      catch (err) { return systemMessage(t('cmd.rewind.exec_failed', getErrorMessage(err))); }
    }

    // 2) 回退（复用 FileChangesApi.revert；内部已做原子 truncate）
    let res;
    let label = cpId;
    try {
      const cps = await api.getCheckpoints(currentSessionId).catch(() => [] as Checkpoint[]);
      const cp = cps.find((c) => c.id === cpId);
      if (cp) label = cp.label;
      res = await api.revert(currentSessionId, cpId, scope);
    } catch (err) {
      return systemMessage(t('cmd.rewind.exec_failed', getErrorMessage(err)));
    }
    if (!res.success) return systemMessage(t('cmd.rewind.exec_failed', res.error ?? 'unknown'));

    // 3) 截断了对话 → warm-restart 强制 live Leader 从 DB 重载（对比 /clear 留陈旧的改进）
    if (touchesConversation && typeof res.conversationTruncated === 'number' && res.conversationTruncated > 0) {
      sessionManager.rewindConversation(currentSessionId);
    }

    const truncated = typeof res.conversationTruncated === 'number' ? res.conversationTruncated : 0;
    const doneMsg = t('cmd.rewind.done', scope, label.slice(0, 40), truncated);
    return hydrateAfterRewind(ctx, doneMsg);
  }

  return systemMessage(t('cmd.rewind.usage'));
}

/** 回退执行后：构建 hydrate 快照让 TUI 立即重载（镜像 handleRefreshCommand）。 */
function hydrateAfterRewind(ctx: CommandHandlerContext, content: string): CommandResult {
  const snapshot = buildTuiSnapshot(ctx.db, ctx.currentSessionId!);
  if (!snapshot) return systemMessage(content);
  return {
    action: 'hydrate' as const,
    content,
    sessionStatus: snapshot.sessionStatus,
    tasks: snapshot.tasks,
    messages: snapshot.messages,
    channels: snapshot.channels,
    tokenUsage: snapshot.tokenUsage,
    agentTokens: snapshot.agentTokens,
    leaderStatus: snapshot.leaderStatus,
    leaderMode: snapshot.leaderMode,
    leaderReason: snapshot.leaderReason,
  };
}

async function handleWikiCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, cwd, emitter, args } = ctx;
  const subCommand = args[0] || 'status';
  const workspacePath = currentSessionId
    ? (db.getSession(currentSessionId)?.workspace || cwd)
    : cwd;
  const lang = args.includes('en') ? 'en' : 'zh';
  const { WikiManager } = await import('../wiki/WikiManager.js');
  const { createLLMClient } = await import('../llm/Client.js');
  const wikiManager = new WikiManager(emitter, db);

  if (subCommand === 'generate') {
    const llm = createLLMClient();
    emitter?.emit('wiki:generation_started', { projectPath: workspacePath, lang });
    const result = await wikiManager.generateWiki(
      workspacePath, lang, llm,
      (phase, progress, detail) => {
        emitter?.emit('wiki:generation_progress', { projectPath: workspacePath, lang, phase, progress, detail });
      },
      (sectionId, sectionTitle, chunk) => {
        emitter?.emit('wiki:generation_stream', { projectPath: workspacePath, lang, sectionId, sectionTitle, chunk });
      },
    );
    if (result.success) {
      emitter?.emit('wiki:generation_completed', { projectPath: workspacePath, lang, result });
      return systemMessage(`Wiki 生成完成: ${result.documentsGenerated} 个文档, 耗时 ${Math.round(result.duration / 1000)}s`);
    }
    emitter?.emit('wiki:generation_failed', { projectPath: workspacePath, lang, error: result.error || '未知错误' });
    return systemMessage(`Wiki 生成失败: ${result.error}`);
  }

  if (subCommand === 'update') {
    const llm = createLLMClient();
    emitter?.emit('wiki:generation_started', { projectPath: workspacePath, lang });
    const result = await wikiManager.updateWiki(
      workspacePath, lang, llm,
      (phase, progress, detail) => {
        emitter?.emit('wiki:generation_progress', { projectPath: workspacePath, lang, phase, progress, detail });
      },
      (sectionId, sectionTitle, chunk) => {
        emitter?.emit('wiki:generation_stream', { projectPath: workspacePath, lang, sectionId, sectionTitle, chunk });
      },
    );
    if (result.success) {
      emitter?.emit('wiki:generation_completed', { projectPath: workspacePath, lang, result });
      return systemMessage(`Wiki 更新完成: ${result.documentsUpdated} 个文档已更新, 耗时 ${Math.round(result.duration / 1000)}s`);
    }
    return systemMessage(`Wiki 更新失败: ${result.error}`);
  }

  if (subCommand === 'status') {
    const status = await wikiManager.getStatus(workspacePath, lang);
    if (!status.exists) {
      return systemMessage(`项目暂无 Wiki (${lang})。使用 /wiki generate 生成。`);
    }
    return systemMessage(
      `Wiki 状态 (${lang}): ${status.documentCount} 个文档 | ` +
      `上次生成: ${status.lastGeneratedAt ? new Date(status.lastGeneratedAt * 1000).toLocaleString() : 'N/A'} | ` +
      `变更: ${status.changeCount} 个文件` +
      (status.generating ? ' | 正在生成...' : ''),
    );
  }

  if (subCommand === 'list') {
    const docs = await wikiManager.listDocuments(workspacePath, lang);
    if (docs.length === 0) {
      return systemMessage(`项目暂无 Wiki 文档 (${lang})。`);
    }
    return systemMessage(docs.map(d => `${d.section}: ${d.title} (${d.size} bytes)`).join('\n'));
  }

  return systemMessage('用法: /wiki [generate|update|status|list] [zh|en]');
}

async function handleContractCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, cwd, emitter, args } = ctx;
  const workspacePath = currentSessionId
    ? (db.getSession(currentSessionId)?.workspace || cwd)
    : cwd;
  const subCommand = args[0] || 'list';

  if (subCommand === 'audit' && args[1] === 'generate') {
    const { createLLMClient } = await import('../llm/Client.js');
    const { ContractAuditGenerator } = await import('../wiki/ContractAuditGenerator.js');
    const { config } = await import('../config.js');
    const model = config.llm.wiki_model || config.llm.leader_model;
    if (!model) {
      return systemMessage('未配置 llm.wiki_model 或 llm.leader_model,无法运行契约 audit。');
    }
    const llm = createLLMClient();
    emitter?.emit('contract:audit_started', { projectPath: workspacePath });
    const gen = new ContractAuditGenerator(workspacePath, llm, model);
    const result = await gen.auditGenerate(
      (p) => emitter?.emit('contract:audit_progress', { projectPath: workspacePath, ...p }),
    );
    return systemMessage(
      `契约 audit 完成:扫描 ${result.scannedFiles} 文件 · 生成 ${result.generated.length}(provenance:audit)· 跳过 ${result.skipped.length}(权威链保留)` +
        (result.generated.length > 0 ? `\n生成 surface: ${result.generated.map((e) => e.surface).join(', ')}` : '') +
        (result.skipped.length > 0 ? `\n跳过(已存在): ${result.skipped.map((s) => s.surface).join(', ')}` : '') +
        `\n已写入项目级 .lingxiao/contracts/(跨会话复用,TUI/Web 契约面板可见)。`,
    );
  }

  if (subCommand === 'audit' && args[1] === 'verify') {
    const { createLLMClient } = await import('../llm/Client.js');
    const { ContractAuditGenerator } = await import('../wiki/ContractAuditGenerator.js');
    const { config } = await import('../config.js');
    const { loadProjectContractEntries } = await import('../core/ProjectContracts.js');
    const { computeContractDrift, renderContractDriftReport } = await import('../core/ContractDriftAudit.js');
    const model = config.llm.wiki_model || config.llm.leader_model;
    if (!model) {
      return systemMessage('未配置 llm.wiki_model 或 llm.leader_model,无法运行契约漂移校验。');
    }
    const declared = loadProjectContractEntries(workspacePath);
    const llm = createLLMClient();
    const gen = new ContractAuditGenerator(workspacePath, llm, model);
    emitter?.emit('contract:audit_started', { projectPath: workspacePath, phase: 'verify' });
    const codeSurfaces = await gen.getCodeSurfaces();
    const drift = computeContractDrift(declared, codeSurfaces);
    return systemMessage(renderContractDriftReport(drift));
  }

  if (subCommand === 'list') {
    const { loadProjectContractEntries } = await import('../core/ProjectContracts.js');
    const entries = loadProjectContractEntries(workspacePath);
    if (entries.length === 0) {
      return systemMessage('项目暂无契约(.lingxiao/contracts/)。用 /contract audit generate 从代码反推生成。');
    }
    return systemMessage(
      entries
        .map((e) => `${e.surface}${e.version !== undefined ? `@v${e.version}` : ''} [${e.provenance ?? 'declared'}] ${e.sha256.slice(0, 8)} · ${e.title}`)
        .join('\n'),
    );
  }

  return systemMessage('用法: /contract [list | audit generate]');
}

async function handleDreamCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, cwd, emitter } = ctx;
  const workspacePath = currentSessionId
    ? (db.getSession(currentSessionId)?.workspace || cwd)
    : cwd;
  const { runMemoryMaintenancePipeline } = await import('../memory/MemoryMaintenanceStatus.js');
  try {
    const run = await runMemoryMaintenancePipeline({
      kind: 'dream',
      workspace: workspacePath,
      projectId: currentSessionId || 'default',
      dbPath: db.getPath(),
      emitter,
      sessionId: currentSessionId,
    });
    if (run.kind !== 'dream') {
      return systemMessage('Dream 失败: 维护管线返回了非 dream 结果');
    }
    const { result } = run;

    if (result.linesWritten === 0 && result.checkpointsProcessed === 0) {
      return systemMessage('Dream: 暂无可整理的 checkpoint 与既有记忆。');
    }
    const verifyNote = result.verification?.verified
      ? `（已核对 ${result.verification.recentSessionCount} 个会话 / ${result.verification.totalMessages} 条消息）`
      : '（无近期会话核对数据，仅基于 checkpoint）';
    return systemMessage(
      `Dream 整理完成：处理 ${result.checkpointsProcessed} 个 checkpoint，` +
      `写入 ${result.sectionsConsolidated} 个章节 / ${result.linesWritten} 行 ${verifyNote}\n${result.updatedPath}`,
    );
  } catch (err) {
    return systemMessage(`Dream 失败: ${getErrorMessage(err)}`);
  }
}

async function handleDistillCommand(ctx: CommandHandlerContext): Promise<CommandResult> {
  const { currentSessionId, db, cwd, args, emitter } = ctx;
  const workspacePath = currentSessionId
    ? (db.getSession(currentSessionId)?.workspace || cwd)
    : cwd;
  const lookbackArg = args.find((a) => /^\d+$/.test(a));
  const { runMemoryMaintenancePipeline } = await import('../memory/MemoryMaintenanceStatus.js');
  try {
    const run = await runMemoryMaintenancePipeline({
      kind: 'distill',
      workspace: workspacePath,
      projectId: currentSessionId || 'default',
      dbPath: db.getPath(),
      emitter,
      sessionId: currentSessionId,
      sessionLookbackDays: lookbackArg ? Number(lookbackArg) : undefined,
    });
    if (run.kind !== 'distill') {
      return systemMessage('Distill 失败: 维护管线返回了非 distill 结果');
    }
    const { result } = run;
    if (result.created.length === 0) {
      const skippedNote = result.skipped.length > 0 ? ` 跳过 ${result.skipped.length} 项。` : '';
      const evidenceNote = result.needsMoreEvidence.length > 0 ? ` ${result.needsMoreEvidence.length} 项证据不足。` : '';
      const invalidNote = result.invalid.length > 0 ? ` ${result.invalid.length} 项格式无效。` : '';
      const conflictNote = result.conflicts.length > 0 ? ` ${result.conflicts.length} 项已存在未覆盖。` : '';
      return systemMessage(`Distill: 未提炼出可复用资产。${skippedNote}${evidenceNote}${invalidNote}${conflictNote}`);
    }
    const lines = result.created.map((a) => `  [${a.form}] ${a.name} → ${a.path}`).join('\n');
    const guard = [
      result.conflicts.length > 0 ? `冲突 ${result.conflicts.length}` : '',
      result.invalid.length > 0 ? `无效 ${result.invalid.length}` : '',
      result.needsMoreEvidence.length > 0 ? `证据不足 ${result.needsMoreEvidence.length}` : '',
    ].filter(Boolean).join(' / ');
    return systemMessage(`Distill 完成：提炼 ${result.created.length} 个资产${guard ? `（${guard}）` : ''}\n${lines}`);
  } catch (err) {
    return systemMessage(`Distill 失败: ${getErrorMessage(err)}`);
  }
}

function handleLoopCommand(ctx: CommandHandlerContext): CommandResult {
  const { currentSessionId, args, context } = ctx;
  if (!currentSessionId) return systemMessage('当前没有活动会话');
  if (!context.scheduledTaskManager) return systemMessage('/loop 命令需要定时任务引擎（请确保 Web Server 已启动）');

  const stm = context.scheduledTaskManager;
  const subCmd = args[0]?.toLowerCase();

  // /loop list
  if (subCmd === 'list') {
    const tasks = stm.getTasks(currentSessionId);
    if (tasks.length === 0) return systemMessage('当前会话没有定时任务。使用 /loop [interval] <prompt> 创建。');
    const lines = ['**定时任务列表**\n'];
    for (const t of tasks) {
      const task = t as ScheduledTaskRecord;
      const status = task.enabled === false ? '⏸' : '▶';
      const taskType = task.task_type ?? 'prompt';
      const intensity = task.intensity ?? 'normal';
      const audience = task.audience ?? 'personal';
      const title = taskType === 'workflow'
        ? `workflow:${task.workflow_id ?? 'missing'}`
        : `${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? '...' : ''}`;
      const execution = task.last_execution_id ? ` | exec: ${task.last_execution_id}` : '';
      const error = task.last_error ? ` | error: ${task.last_error}` : '';
      lines.push(`${status} \`${task.id}\` | ${taskType}/${intensity}/${audience} | cron: ${task.cron} | ${title}${execution}${error}`);
    }
    return { type: 'code' as const, content: lines.join('\n') };
  }

  // /loop delete <id>
  if (subCmd === 'delete') {
    const taskId = args[1];
    if (!taskId) return systemMessage('用法: /loop delete <task-id>');
    try {
      stm.deleteTask(taskId);
      return systemMessage(`已删除定时任务: ${taskId}`);
    } catch {/* expected: fallback to default */
      return systemMessage(`删除失败: 任务 ${taskId} 不存在`);
    }
  }

  // /loop stop
  if (subCmd === 'stop') {
    const tasks = stm.getTasks(currentSessionId);
    if (tasks.length === 0) return systemMessage('当前会话没有定时任务');
    for (const t of tasks) {
      stm.deleteTask(t.id);
    }
    return systemMessage(`已删除当前会话的 ${tasks.length} 个定时任务`);
  }

  // /loop [interval] <prompt> — 创建定时任务
  const firstToken = args[0] || '';
  const intervalMatch = firstToken.match(/^(\d+)([mhd])$/);
  let cron: string;
  let intervalLabel: string;
  let prompt: string;

  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    if (value <= 0) return systemMessage('间隔必须大于 0');
    switch (unit) {
      case 'm':
        if (value > 59) {
          cron = `0 */${Math.floor(value / 60)} * * *`;
          intervalLabel = `${value}分钟`;
        } else {
          cron = `*/${value} * * * *`;
          intervalLabel = `${value}分钟`;
        }
        break;
      case 'h':
        cron = `0 */${value} * * *`;
        intervalLabel = `${value}小时`;
        break;
      case 'd':
        cron = `0 0 */${value} * *`;
        intervalLabel = `${value}天`;
        break;
      default:
        cron = '*/10 * * * *';
        intervalLabel = '10分钟';
    }
    prompt = args.slice(1).join(' ').trim();
  } else {
    cron = '*/10 * * * *';
    intervalLabel = '10分钟';
    prompt = args.join(' ').trim();
  }

  if (!prompt) return systemMessage('用法: /loop [interval] <prompt>\n示例: /loop 5m 检查部署状态\n       /loop 1h /bughunt\n       /loop 检查部署（默认10分钟）');

  const result = stm.createTask({
    cron,
    prompt,
    recurring: true,
    durable: false,
    sessionId: currentSessionId,
    taskType: 'prompt',
    intensity: 'normal',
    audience: 'personal',
  });

  const nextRunStr = result.next_run_at ? new Date(result.next_run_at).toLocaleTimeString() : '未知';
  return systemMessage(`已创建定时任务 (每${intervalLabel})\nID: ${result.id}\nPrompt: ${prompt}\n下次执行: ${nextRunStr}\n\n使用 /loop list 查看 | /loop delete ${result.id} 删除`);
}

// ─── Command Registry ────────────────────────────────────────────────────────

const commandRegistry = new Map<string, CommandHandler>([
  ['/history', handleHistoryCommand],
  ['/skills', handleSkillsCommand],
  ['/mcp', handleMcpCommand],
  ['/hooks', handleHooksCommand],
  ['/models', handleModelsCommand],
  ['/model', handleModelCommand],
  ['/projects', handleProjectsCommand],
  ['/project-pause', handleProjectControlCommand],
  ['/project-resume', handleProjectControlCommand],
  ['/project-priority', handleProjectControlCommand],
  ['/project-replan', handleProjectControlCommand],
  ['/project-reset', handleProjectControlCommand],
  ['/project-unblock', handleProjectControlCommand],
  ['/project-archive', handleProjectControlCommand],
  ['/ls', handleLsCommand],
  ['/open', handleOpenCommand],
  ['/fetch', handleFetchCommand],
  ['/search', handleSearchCommand],
  ['/doctor', handleDoctorCommand],
  ['/session', handleSessionCommand],
  ['/permissions', handlePermissionsCommand],
  ['/bughunt', handleBughuntCommand],
  ['/bughunt-status', handleBughuntStatusCommand],
  ['/bughunt-report', handleBughuntReportCommand],
  ['/office', handleOfficeCommand],
  ['/workflow', handleWorkflowCommand],
  ['/team', handleTeamCommand],
  ['/route', handleRouteCommand],
  ['/eternal', handleEternalCommand],
  ['/mode', handleModeCommand],
  ['/allow-tool', handleToolPermissionCommand],
  ['/deny-tool', handleToolPermissionCommand],
  ['/ask-tool', handleToolPermissionCommand],
  ['/approve', handleApproveOrDenyCommand],
  ['/deny', handleApproveOrDenyCommand],
  ['/resume', handleResumeCommand],
  ['/stop', handleStopCommand],
  ['/cancel-task', handleCancelTaskCommand],
  ['/refresh', handleRefreshCommand],
  ['/broadcast', handleBroadcastCommand],
  ['/intervene', handleInterveneCommand],
  ['/compact', handleCompactCommand],
  ['/clear', handleClearCommand],
  ['/language', handleLanguageCommand],
  ['/tools', handleToolsCommand],
  ['/cost', handleCostCommand],
  ['/stats', handleStatsCommand],
  ['/logs', handleLogsCommand],
  ['/traces', handleTracesCommand],
  ['/changes', handleChangesCommand],
  ['/rewind', handleRewindCommand],
  ['/wiki', handleWikiCommand],
  ['/contract', handleContractCommand],
  ['/dream', handleDreamCommand],
  ['/distill', handleDistillCommand],
  ['/loop', handleLoopCommand],
]);

// ─── Custom Command Execution ────────────────────────────────────────────────

/**
 * Execute a custom command discovered from `.lingxiao/commands/*.md`.
 *
 * Renders the command body by substituting `$ARGUMENTS` with the args string,
 * then dispatches the rendered text as a user prompt to the current session via
 * `sessionManager.sendUserInput` (the same API used by /broadcast, /approve,
 * /bughunt, etc.).
 *
 * Agent routing: role-`@mention` parsing of free-text user input is NOT a
 * confirmed routing mechanism in this codebase (no parser routes `@<agent>`
 * prefixes to specific agents). The only deterministic agent-routing API is
 * `sessionManager.sendAgentInput(sessionId, agentName, message)`. To keep
 * behavior predictable we send the rendered body to the Leader (the session's
 * default entry point) and include the configured agent as a parenthetical
 * hint so the Leader can dispatch/intervene as appropriate. This avoids
 * inventing a heuristic that may route to a non-existent agent name.
 */
async function executeCustomCommand(
  workspace: string,
  commandName: string,
  args: string[],
  currentSessionId: string | undefined,
  sessionManager: SessionManager,
): Promise<CommandResult | void> {
  // commandName arrives with a leading slash (e.g. "/fix-test-failures").
  const descriptor = findCustomCommand(workspace, commandName);
  if (!descriptor) return undefined;
  if (!currentSessionId) return systemMessage(`自定义命令 ${descriptor.slashName} 需要一个活动会话`);

  const argsString = args.join(' ').trim();
  const renderedBody = renderCommandBody(descriptor, argsString);

  let prompt: string;
  const agentLower = descriptor.agent.toLowerCase();
  if (renderedBody.length === 0) {
    // Empty body: send just the description so the session has something to act on.
    prompt = descriptor.description;
  } else if (agentLower === 'leader') {
    prompt = renderedBody;
  } else {
    // Include the configured agent as a parenthetical hint (deterministic, no routing guess).
    prompt = `${renderedBody}\n\n(目标 Agent: @${descriptor.agent})`;
  }

  await sessionManager.sendUserInput(currentSessionId, prompt);

  // Record real usage so distill's C gate can later refine proven commands (N5-A).
  try {
    new AssetUsageStore(join(workspace, '.lingxiao')).recordUsage({
      assetRef: `commands/${descriptor.name.replace(/^\/+/, '')}`,
      kind: 'command_invoked',
      sessionId: currentSessionId,
      timestamp: Date.now(),
    });
  } catch { /* usage tracking is best-effort, never blocks the command */ }

  return systemMessage(`已执行自定义命令 ${descriptor.slashName}${argsString ? ` ${argsString}` : ''}`);
}

// ─── Public Dispatch Function ────────────────────────────────────────────────

export async function dispatchCallbackCommand(
  commandLine: string,
  context: CallbackCommandDispatcherContext,
): Promise<CommandResult | void> {
  const { db, sessionManager, emitter, cwd } = context;
  const [rawCommand, ...args] = commandLine.trim().split(/\s+/);
  const command = rawCommand.toLowerCase();
  const currentSessionId = context.getCurrentSessionId();

  const handler = commandRegistry.get(command);
  if (!handler) {
    // Fallback: custom command discovered from `.lingxiao/commands/*.md`.
    // Resolve workspace from the current session (or cwd) and look up by name.
    const workspace = currentSessionId
      ? (db.getSession(currentSessionId)?.workspace || cwd)
      : cwd;
    return executeCustomCommand(workspace, command, args, currentSessionId, sessionManager);
  }

  const handlerCtx: CommandHandlerContext = {
    db,
    sessionManager,
    emitter,
    cwd,
    currentSessionId,
    args,
    commandLine,
    command,
    context,
  };

  return handler(handlerCtx);
}
