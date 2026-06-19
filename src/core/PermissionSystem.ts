import type { ToolContext } from '../contracts/types/Tool.js';
import { isAlwaysAllowedToolByMetadata, isNetworkToolByMetadata, isPrivilegedToolByMetadata, isWorkspaceModifyingTool } from '../contracts/types/ToolMetadata.js';
import { getConfigValue } from '../config.js';
import { isHardenedMode } from './HardeningPolicy.js';

export const PERMISSION_MODES = ['strict', 'dev', 'networked', 'yolo'] as const;

export type PermissionMode = typeof PERMISSION_MODES[number];
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

const PERMISSION_MODE_SET = new Set<string>(PERMISSION_MODES);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODE_SET.has(value);
}

export interface PermissionRule {
  toolName: string;
  pattern?: string;
}

export interface ToolPermissionContext {
  mode: PermissionMode;
  allowedHosts: string[];
  sandboxBackend: 'app-guard' | 'bubblewrap';
  allowBackendFallback: boolean;
  allowRules: PermissionRule[];
  denyRules: PermissionRule[];
  askRules: PermissionRule[];
}

export type PermissionUpdate =
  | {
      type: 'setMode';
      mode: PermissionMode;
    }
  | {
      type: 'addHosts';
      hosts: string[];
    }
  | {
      type: 'replaceHosts';
      hosts: string[];
    }
  | {
      type: 'setSandboxBackend';
      backend: 'app-guard' | 'bubblewrap';
      allowFallback?: boolean;
    }
  | {
      type: 'addRules';
      behavior: PermissionBehavior;
      rules: PermissionRule[];
    }
  | {
      type: 'replaceRules';
      behavior: PermissionBehavior;
      rules: PermissionRule[];
    }
  | {
      type: 'removeRules';
      behavior: PermissionBehavior;
      rules: PermissionRule[];
    };

export interface PermissionRequestPayload {
  requestId: string;
  source: 'leader' | 'worker';
  toolName: string;
  requestedMode?: PermissionMode;
  requestedHosts?: string[];
  destination?: 'session' | 'project' | 'local' | 'user';
  requestedBackend?: 'app-guard' | 'bubblewrap';
  reason: string;
  workerName?: string;
}

export function getDefaultToolPermissionContext(): ToolPermissionContext {
  const configuredMode = getConfigValue('security.permission_mode');
  return {
    mode: isPermissionMode(configuredMode) ? configuredMode : 'yolo',
    allowedHosts: [],
    sandboxBackend: isPermissionMode(configuredMode) && configuredMode !== 'yolo' ? 'bubblewrap' : 'app-guard',
    allowBackendFallback: true,
    allowRules: [],
    denyRules: [],
    askRules: [],
  };
}

export function getLeaderDefaultPermissionContext(): ToolPermissionContext {
  return getDefaultToolPermissionContext();
}

export function normalizeToolPermissionContext(
  raw: unknown,
): ToolPermissionContext {
  if (!raw || typeof raw !== 'object') {
    return getDefaultToolPermissionContext();
  }

  const candidate = raw as Partial<ToolPermissionContext>;
  return {
    mode: isPermissionMode(candidate.mode) ? candidate.mode : 'yolo',
    allowedHosts: Array.isArray(candidate.allowedHosts)
      ? candidate.allowedHosts.filter((value): value is string => typeof value === 'string')
      : [],
    sandboxBackend:
      candidate.sandboxBackend === 'app-guard' || candidate.sandboxBackend === 'bubblewrap'
        ? candidate.sandboxBackend
        : 'app-guard',
    allowBackendFallback: candidate.allowBackendFallback === true,
    allowRules: Array.isArray(candidate.allowRules)
      ? candidate.allowRules.filter((value): value is PermissionRule => !!value && typeof value === 'object' && typeof (value as PermissionRule).toolName === 'string')
      : [],
    denyRules: Array.isArray(candidate.denyRules)
      ? candidate.denyRules.filter((value): value is PermissionRule => !!value && typeof value === 'object' && typeof (value as PermissionRule).toolName === 'string')
      : [],
    askRules: Array.isArray(candidate.askRules)
      ? candidate.askRules.filter((value): value is PermissionRule => !!value && typeof value === 'object' && typeof (value as PermissionRule).toolName === 'string')
      : [],
  };
}

function mergeUniqueRules(current: PermissionRule[], next: PermissionRule[]): PermissionRule[] {
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

function removeRules(current: PermissionRule[], removing: PermissionRule[]): PermissionRule[] {
  const toRemove = new Set(removing.map((rule) => `${rule.toolName}::${rule.pattern || ''}`));
  return current.filter((rule) => !toRemove.has(`${rule.toolName}::${rule.pattern || ''}`));
}

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
): ToolPermissionContext {
  let next = normalizeToolPermissionContext(context);
  for (const update of updates) {
    switch (update.type) {
      case 'setMode':
        next = { ...next, mode: update.mode };
        break;
      case 'addHosts':
        next = {
          ...next,
          allowedHosts: Array.from(new Set([...next.allowedHosts, ...update.hosts])),
        };
        break;
      case 'replaceHosts':
        next = {
          ...next,
          allowedHosts: Array.from(new Set(update.hosts)),
        };
        break;
      case 'setSandboxBackend':
        next = {
          ...next,
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
        next = {
          ...next,
          [targetKey]: mergeUniqueRules(next[targetKey], update.rules),
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
        next = {
          ...next,
          [targetKey]: mergeUniqueRules([], update.rules),
        };
        break;
      }
      case 'removeRules': {
        const targetKey =
          update.behavior === 'allow'
            ? 'allowRules'
            : update.behavior === 'deny'
              ? 'denyRules'
              : 'askRules';
        next = {
          ...next,
          [targetKey]: removeRules(next[targetKey], update.rules),
        };
        break;
      }
    }
  }
  return next;
}

export function summarizePermissionContext(context: ToolPermissionContext): string {
  return [
    `mode=${context.mode}`,
    `sandbox=${context.sandboxBackend}${context.allowBackendFallback ? ' (fallback)' : ''}`,
    `hosts=${context.allowedHosts.length > 0 ? context.allowedHosts.join(', ') : '(none)'}`,
    `rules=allow:${context.allowRules.length}/deny:${context.denyRules.length}/ask:${context.askRules.length}`,
  ].join(' · ');
}

export function getPermissionAccessLabel(mode: PermissionMode): string {
  return mode === 'strict'
    ? 'strict'
    : mode === 'yolo'
      ? 'yolo'
      : mode === 'networked'
        ? 'approved'
        : 'standard';
}

export function summarizePermissionContextForDisplay(context: ToolPermissionContext): string {
  return [
    `access=${getPermissionAccessLabel(context.mode)}`,
    `sandbox=${context.sandboxBackend}${context.allowBackendFallback ? ' (fallback)' : ''}`,
    `rules=allow:${context.allowRules.length}/deny:${context.denyRules.length}/ask:${context.askRules.length}`,
  ].join(' · ');
}

export function getToolPermissionContextFromToolContext(
  context?: ToolContext,
): ToolPermissionContext {
  return normalizeToolPermissionContext(context?.permissionContext);
}

export function isWriteTool(name: string): boolean {
  return isWorkspaceModifyingTool(name);
}

export function isNetworkTool(name: string): boolean {
  return isNetworkToolByMetadata(name);
}

export function isPrivilegedTool(name: string): boolean {
  return isPrivilegedToolByMetadata(name) || isExecutionToolWithNetworkCapability(name);
}

/**
 * Tools that can perform network operations indirectly (via subprocess).
 * These are subject to network governance via sandbox or code analysis,
 * but are not gated at the permission evaluation layer like pure network tools.
 */
export function isExecutionToolWithNetworkCapability(name: string): boolean {
  return ['shell', 'python_exec'].includes(name);
}

export function isAlwaysAllowedTool(name: string): boolean {
  return isAlwaysAllowedToolByMetadata(name);
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }

    if (ch === ';') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    if (ch === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function stripShellWrappers(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;

  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === 'env' || token === 'command' || token === 'builtin' || token === 'noglob') {
      index += 1;
      continue;
    }
    if (token === 'time') {
      index += 1;
      continue;
    }
    if (token === 'sudo') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        index += 1;
        if (['-u', '-g', '-h', '-p'].includes(option) && index < tokens.length) {
          index += 1;
        }
      }
      continue;
    }
    break;
  }

  return tokens.slice(index).join(' ').trim();
}

export function extractPermissionSubjects(toolName: string, args: unknown): string[] {
  if (!args || typeof args !== 'object') {
    return [''];
  }

  const raw = args as Record<string, unknown>;
  switch (toolName) {
    case 'shell': {
      const command = typeof raw.command === 'string' ? raw.command : '';
      if (!command) {
        return [''];
      }
      const candidates = new Set<string>();
      const segments = splitShellSegments(command);
      for (const segment of segments) {
        const normalized = stripShellWrappers(segment);
        if (!normalized) continue;
        const tokens = normalized.split(/\s+/).filter(Boolean);
        candidates.add(normalized);
        if (tokens.length >= 1) candidates.add(tokens.slice(0, 1).join(' '));
        if (tokens.length >= 2) candidates.add(tokens.slice(0, 2).join(' '));
        if (tokens.length >= 3) candidates.add(tokens.slice(0, 3).join(' '));
      }
      return candidates.size > 0 ? Array.from(candidates) : [''];
    }
    case 'http_request':
      return [typeof raw.url === 'string' ? raw.url : ''];
    case 'file_read':
    case 'structured_patch':
    case 'file_create':
      return [typeof raw.path === 'string' ? raw.path : ''];
    default:
      return [''];
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function ruleMatches(rule: PermissionRule, toolName: string, subjects: string[]): boolean {
  if (rule.toolName !== '*' && rule.toolName !== toolName) {
    return false;
  }
  if (!rule.pattern || rule.pattern.trim() === '') {
    return true;
  }
  const pattern = rule.pattern.trim();
  const matcher = wildcardToRegExp(pattern);
  return subjects.some((subject) => subject === pattern || subject.includes(pattern) || matcher.test(subject));
}

function getUrlHost(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const url = (args as Record<string, unknown>).url;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function hostAllowed(host: string | null, allowedHosts: string[]): boolean {
  if (!host) return false;
  const normalized = host.replace(/^www\./, '').toLowerCase();
  return allowedHosts.some((allowedHost) => {
    const allowed = allowedHost.replace(/^www\./, '').toLowerCase();
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

export function evaluateToolPermission(
  toolName: string,
  args: unknown,
  context: ToolPermissionContext,
): { allowed: boolean; reason?: string } {
  const subjects = extractPermissionSubjects(toolName, args);

  if (context.denyRules.some((rule) => ruleMatches(rule, toolName, subjects))) {
    return { allowed: false, reason: `deny rule matched for ${toolName}` };
  }

  if (context.allowRules.some((rule) => ruleMatches(rule, toolName, subjects))) {
    return { allowed: true };
  }

  if (context.askRules.some((rule) => ruleMatches(rule, toolName, subjects))) {
    return { allowed: false, reason: `approval required by ask rule for ${toolName}` };
  }

  if (context.mode === 'yolo') {
    return { allowed: true };
  }

  if (isAlwaysAllowedTool(toolName)) {
    return { allowed: true };
  }

  if (isNetworkTool(toolName)) {
    if (context.mode !== 'networked') {
      return { allowed: false, reason: `网络工具 ${toolName} 在 ${context.mode} 模式下需要审批` };
    }
    if (!hostAllowed(getUrlHost(args), context.allowedHosts)) {
      return { allowed: false, reason: `目标主机不在允许列表: ${getUrlHost(args) || '(invalid url)'}` };
    }
    return { allowed: true };
  }

  if (isHardenedMode() && isExecutionToolWithNetworkCapability(toolName) && context.mode !== 'networked') {
    return {
      allowed: false,
      reason: `执行工具 ${toolName} 在加固模式下需要 networked 模式审批（防子进程绕过网络治理）`,
    };
  }

  if (context.mode === 'strict' && isPrivilegedTool(toolName)) {
    return { allowed: false, reason: `高权限工具 ${toolName} 在 strict 模式下需要审批` };
  }

  return { allowed: true };
}
