import { join, resolve } from 'path';

export interface SessionScopePaths {
  workspaceRoot: string;
  sessionsRoot: string;
  sessionId?: string;
  sessionDir?: string;
  scratchpadDir?: string;
  contextDir?: string;
  implementationsDir?: string;
}

export function getSessionScopePaths(
  workspace: string | undefined,
  sessionId?: string,
): SessionScopePaths {
  const workspaceRoot = resolve(workspace || process.cwd());
  const sessionsRoot = join(workspaceRoot, '.lingxiao', 'sessions');
  const sessionDir = sessionId ? join(sessionsRoot, sessionId) : undefined;

  return {
    workspaceRoot,
    sessionsRoot,
    sessionId,
    sessionDir,
    scratchpadDir: sessionDir ? join(sessionDir, 'scratchpad') : undefined,
    contextDir: sessionDir ? join(sessionDir, 'context') : undefined,
    implementationsDir: sessionDir ? join(sessionDir, 'implementations') : undefined,
  };
}

export function getSessionScopeDescription(
  workspace: string | undefined,
  sessionId?: string,
): string {
  const scope = getSessionScopePaths(workspace, sessionId);
  if (!scope.sessionId || !scope.sessionDir || !scope.scratchpadDir || !scope.contextDir) {
    return [
      `工作区根目录: ${scope.workspaceRoot}`,
      '当前未绑定 session_id，会话空间信息不可用。',
    ].join('\n');
  }

  return [
    `工作区根目录: ${scope.workspaceRoot}`,
    `当前会话 ID: ${scope.sessionId}`,
    `当前会话目录: ${scope.sessionDir}`,
    `当前 Scratchpad: ${scope.scratchpadDir}`,
    `当前 Context: ${scope.contextDir}`,
    '写入型工具限定在工作区、显式写入范围和当前会话运行时目录内。',
  ].join('\n');
}
