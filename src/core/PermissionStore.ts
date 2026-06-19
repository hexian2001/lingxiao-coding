import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync, constants as fsConstants } from 'fs';
import { dirname, join } from 'path';
import { CONFIG_DIR } from '../config.js';
import type { DatabaseManager } from './Database.js';
import type { AgentRole } from '../contracts/types/Agent.js';
import { SESSION_KEYS } from './SessionStateKeys.js';
import {
  applyPermissionUpdates,
  getPermissionAccessLabel,
  getDefaultToolPermissionContext,
  normalizeToolPermissionContext,
  summarizePermissionContextForDisplay,
  type PermissionRequestPayload,
  type PermissionRule,
  type PermissionUpdate,
  type ToolPermissionContext,
} from './PermissionSystem.js';

export type PermissionUpdateDestination = 'session' | 'project' | 'local' | 'user';

interface PermissionLayerDescriptor {
  destination: PermissionUpdateDestination;
  path?: string;
}

function getPermissionLayerDescriptors(workspace: string): PermissionLayerDescriptor[] {
  return [
    {
      destination: 'user',
      path: join(CONFIG_DIR, 'permissions.user.json'),
    },
    {
      destination: 'project',
      path: join(workspace, '.lingxiao', 'permissions.project.json'),
    },
    {
      destination: 'local',
      path: join(workspace, '.lingxiao', 'permissions.local.json'),
    },
    {
      destination: 'session',
    },
  ];
}

function readPermissionFile(path: string): Partial<ToolPermissionContext> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<ToolPermissionContext>;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function writePermissionFile(path: string, context: ToolPermissionContext): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(context, null, 2), 'utf-8');
}

/**
 * P1 修复（PermissionStore RMW lost update）：在文件层 read→apply→write 期间持有
 * 短暂的跨进程锁，防止两个进程同时把对方的更新覆盖掉。
 *
 * 单进程内本身就是单线程，但凌霄是多进程（daemon + 子进程 worker / 多个 CLI 实例），
 * 因此必须用文件锁。这里采用 openSync O_EXCL 的同步实现，加 stale 兜底，
 * 关键段一般 < 5ms，busy-wait 上限设 2 秒。
 *
 * 不复用 AsyncFileLock 是因为 applyAndPersistPermissionUpdates 是 sync 调用链
 * （LeaderPermissionManager / LeaderAgent.setPermissionMode 都是 sync），改 async 涉及大面积
 * 接口改动。
 */
function withFileLockSync<T>(filePath: string, fn: () => T, timeoutMs = 2000, staleMs = 60_000): T {
  const lockPath = `${filePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  let fd: number | null = null;
  while (true) {
    try {
      fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o644);
      break;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
      // stale 兜底：锁文件 mtime 超过 staleMs 视为残留（持锁进程异常退出）
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { unlinkSync(lockPath); } catch { /* 已被别人删了 */ }
          continue;
        }
      } catch { /* 文件已不存在 */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`[PermissionStore] timed out acquiring file lock for ${lockPath}`);
      }
      // 短忙等。permission 写入很罕见，不会引发持续 CPU 占用。
      const deadline = Date.now() + 20;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

function mergePermissionContexts(
  base: ToolPermissionContext,
  next: Partial<ToolPermissionContext> | null
): ToolPermissionContext {
  if (!next) {
    return base;
  }

  return normalizeToolPermissionContext({
    ...base,
    ...next,
    allowedHosts: Array.isArray(next.allowedHosts) ? next.allowedHosts : base.allowedHosts,
  });
}

function applyPermissionUpdatesAsLayerDelta(
  currentLayer: Partial<ToolPermissionContext> | null,
  updates: PermissionUpdate[],
): Partial<ToolPermissionContext> {
  let layer: Partial<ToolPermissionContext> = { ...(currentLayer || {}) };
  for (const update of updates) {
    switch (update.type) {
      case 'setMode':
        layer = { ...layer, mode: update.mode };
        break;
      case 'addHosts':
        layer = {
          ...layer,
          allowedHosts: Array.from(new Set([...(Array.isArray(layer.allowedHosts) ? layer.allowedHosts : []), ...update.hosts])),
        };
        break;
      case 'replaceHosts':
        layer = { ...layer, allowedHosts: Array.from(new Set(update.hosts)) };
        break;
      case 'setSandboxBackend':
        layer = {
          ...layer,
          sandboxBackend: update.backend,
          allowBackendFallback: update.allowFallback === true,
        };
        break;
      case 'addRules': {
        const targetKey =
          update.behavior === 'allow'
            ? 'allowRules'
            : update.behavior === 'deny'
              ? 'denyRules'
              : 'askRules';
        layer = {
          ...layer,
          [targetKey]: mergeUniquePermissionRules((layer[targetKey] as PermissionRule[] | undefined) || [], update.rules),
        };
        break;
      }
      case 'replaceRules': {
        const targetKey =
          update.behavior === 'allow'
            ? 'allowRules'
            : update.behavior === 'deny'
              ? 'denyRules'
              : 'askRules';
        layer = { ...layer, [targetKey]: mergeUniquePermissionRules([], update.rules) };
        break;
      }
      case 'removeRules': {
        const targetKey =
          update.behavior === 'allow'
            ? 'allowRules'
            : update.behavior === 'deny'
              ? 'denyRules'
              : 'askRules';
        layer = {
          ...layer,
          [targetKey]: removePermissionRules((layer[targetKey] as PermissionRule[] | undefined) || [], update.rules),
        };
        break;
      }
    }
  }
  return layer;
}

function mergeUniquePermissionRules(current: PermissionRule[], next: PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>();
  const merged: PermissionRule[] = [];
  for (const rule of [...current, ...next]) {
    const key = `${rule.toolName}::${rule.pattern || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rule);
  }
  return merged;
}

function removePermissionRules(current: PermissionRule[], removing: PermissionRule[]): PermissionRule[] {
  const toRemove = new Set(removing.map((rule) => `${rule.toolName}::${rule.pattern || ''}`));
  return current.filter((rule) => !toRemove.has(`${rule.toolName}::${rule.pattern || ''}`));
}

export function loadEffectivePermissionContext(
  db: DatabaseManager | undefined,
  workspace: string,
  sessionId: string
): ToolPermissionContext {
  let context = getDefaultToolPermissionContext();

  for (const layer of getPermissionLayerDescriptors(workspace)) {
    if (layer.destination === 'session') {
      context = mergePermissionContexts(
        context,
        db ? (db.getSessionState(sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT) as Partial<ToolPermissionContext> | null) : null
      );
      continue;
    }

    if (layer.path) {
      context = mergePermissionContexts(context, readPermissionFile(layer.path));
    }
  }

  return context;
}

export function applyAndPersistPermissionUpdates(
  db: DatabaseManager | undefined,
  workspace: string,
  sessionId: string,
  updates: PermissionUpdate[],
  destination: PermissionUpdateDestination
): ToolPermissionContext {
  if (destination === 'session') {
    // P1 修复：原实现 getSessionState + setSessionState 是两次独立 SQL，
    // 多进程并发下可能 lost update。这里改用 db.updateSessionState（事务化 RMW）。
    if (db && typeof (db as unknown as { updateSessionState?: unknown }).updateSessionState === 'function') {
      (db as DatabaseManager).updateSessionState<Partial<ToolPermissionContext>>(
        sessionId,
        SESSION_KEYS.TOOL_PERMISSION_CONTEXT,
        (currentRaw) => {
          // session 层的 effective 仍需要叠加 user/project/local 文件层；
          // 但持久化的只是 session 层增量。读 effective 用于本次返回。
          const next = applyPermissionUpdatesAsLayerDelta(currentRaw, updates);
          return next;
        },
      );
      // 重新计算 effective（叠加文件层）
      return loadEffectivePermissionContext(db, workspace, sessionId);
    }
    const currentSessionLayer = db
      ? db.getSessionState(sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT) as Partial<ToolPermissionContext> | null
      : null;
    const next = applyPermissionUpdatesAsLayerDelta(currentSessionLayer, updates);
    if (db) {
      db.setSessionState(sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT, next);
      return loadEffectivePermissionContext(db, workspace, sessionId);
    }
    return normalizeToolPermissionContext(next);
  }

  const target = getPermissionLayerDescriptors(workspace).find((item) => item.destination === destination);
  if (!target?.path) {
    return loadEffectivePermissionContext(db, workspace, sessionId);
  }

  // P1 修复：文件层 read-modify-write 必须上跨进程锁，避免多进程并发覆盖。
  withFileLockSync(target.path, () => {
    const currentLayer = normalizeToolPermissionContext(readPermissionFile(target.path!));
    const nextLayer = applyPermissionUpdates(currentLayer, updates);
    writePermissionFile(target.path!, nextLayer);
  });

  return loadEffectivePermissionContext(db, workspace, sessionId);
}

export function describePermissionLayers(
  db: DatabaseManager | undefined,
  workspace: string,
  sessionId: string
): string {
  const lines = ['Permission layers:'];

  for (const layer of getPermissionLayerDescriptors(workspace)) {
    if (layer.destination === 'session') {
      const value = db ? db.getSessionState(sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT) : null;
      lines.push(`- session: ${summarizePermissionContextForDisplay(normalizeToolPermissionContext(value))}`);
      continue;
    }

    lines.push(
      `- ${layer.destination}: ${layer.path && existsSync(layer.path)
        ? summarizePermissionContextForDisplay(normalizeToolPermissionContext(readPermissionFile(layer.path)))
        : '(not set)'}`
    );
  }

  lines.push(`- effective: ${summarizePermissionContextForDisplay(loadEffectivePermissionContext(db, workspace, sessionId))}`);
  return lines.join('\n');
}

export interface PermissionSurfaceItem {
  id: string;
  status?: string;
  preview: string;
  detail: string;
}

export function buildPermissionSurfaceItems(
  db: DatabaseManager | undefined,
  workspace: string,
  sessionId: string
): PermissionSurfaceItem[] {
  const effective = loadEffectivePermissionContext(db, workspace, sessionId);
  const pendingRequest = db?.getSessionState(sessionId, SESSION_KEYS.PENDING_PERMISSION_REQUEST) as PermissionRequestPayload | null;

  const items: PermissionSurfaceItem[] = [
    {
      id: 'effective',
      status: getPermissionAccessLabel(effective.mode),
      preview: summarizePermissionContextForDisplay(effective),
      detail: [
        '[Effective Permission Context]',
        summarizePermissionContextForDisplay(effective),
        `allow_rules: ${effective.allowRules.map((rule) => `${rule.toolName}${rule.pattern ? `:${rule.pattern}` : ''}`).join(', ') || '(none)'}`,
        `deny_rules: ${effective.denyRules.map((rule) => `${rule.toolName}${rule.pattern ? `:${rule.pattern}` : ''}`).join(', ') || '(none)'}`,
        `ask_rules: ${effective.askRules.map((rule) => `${rule.toolName}${rule.pattern ? `:${rule.pattern}` : ''}`).join(', ') || '(none)'}`,
      ].join('\n'),
    },
    {
      id: 'layers',
      preview: 'user / project / local / session',
      detail: describePermissionLayers(db, workspace, sessionId),
    },
  ];

  if (pendingRequest) {
    items.push({
      id: 'pending_request',
      status: pendingRequest.source,
      preview: `${pendingRequest.toolName} · approval pending`,
      detail: [
        '[Pending Permission Request]',
        `request_id: ${pendingRequest.requestId}`,
        `source: ${pendingRequest.source}${pendingRequest.workerName ? ` @${pendingRequest.workerName}` : ''}`,
        `tool: ${pendingRequest.toolName}`,
        `reason: ${pendingRequest.reason}`,
        'Use /approve or /deny. Optional: /allow-tool /deny-tool /ask-tool /mode.',
      ].join('\n'),
    });
  }

  const customRoles = db?.getSessionState(sessionId, SESSION_KEYS.CUSTOM_ROLES);
  const parsedRoles = typeof customRoles === 'string'
    ? (() => {
        try {
          return JSON.parse(customRoles) as Record<string, AgentRole>;
        } catch {/* expected: operation may fail gracefully */
          return null;
        }
      })()
    : customRoles && typeof customRoles === 'object'
      ? customRoles as Record<string, AgentRole>
      : null;

  if (parsedRoles && Object.keys(parsedRoles).length > 0) {
    const roleLines = Object.values(parsedRoles).map((role) => {
      const profile = role.capabilityProfile;
      const baseline = profile?.baselineRole || '(custom)';
      const tiers = profile?.allowedTiers?.join('/') || '(unknown)';
      return `- ${role.name}: baseline=${baseline} · tiers=${tiers}${role.skillNames?.length ? ` · skills=${role.skillNames.join(', ')}` : ''}${role.droppedTools?.length ? ` · dropped=${role.droppedTools.join(', ')}` : ''}`;
    });

    items.push({
      id: 'roles',
      status: `${Object.keys(parsedRoles).length} roles`,
      preview: 'baseline / tiers / skills',
      detail: ['[Role Capability View]', ...roleLines].join('\n'),
    });
  }

  return items;
}
