import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getSessionScopePaths } from './utils.js';

const SessionArtifactsSchema = z.object({
  action: z.enum(['list', 'read']).describe('列出或读取当前 session 的白名单运行时文件'),
  kind: z.enum(['all', 'scratchpad', 'context', 'implementations']).optional().describe('白名单范围，默认 all'),
  artifact: z.string().optional().describe('要读取的文件路径，相对于当前 session 目录（action=read 时必填），如 scratchpad/T-1_research.md 或 implementations/T-1.md'),
});

function isInside(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`/../`) && !rel.includes('\\..\\'));
}

function collectFiles(rootDir: string, baseDir: string, maxFiles = 200): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const results: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop()!;
    const entries = readdirSync(current).sort();
    for (const entry of entries) {
      const fullPath = join(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      results.push(relative(baseDir, fullPath));
      if (results.length >= maxFiles) {
        break;
      }
    }
  }

  return results.sort();
}

export class SessionArtifactsTool extends Tool {
  readonly name = 'session_artifacts';
  readonly description = '列出或读取当前 session 的白名单运行时文件，只允许访问当前 session 的 scratchpad / context / implementations 目录';
  readonly parameters = SessionArtifactsSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof SessionArtifactsSchema>;
    const scope = getSessionScopePaths(context?.workspace, typeof context?.sessionId === 'string' ? context.sessionId : undefined);

    if (!scope.sessionId || !scope.sessionDir || !scope.scratchpadDir || !scope.contextDir) {
      return {
        success: false,
        data: null,
        error: 'ERROR: 当前没有可用的 session 作用域，无法读取 session artifacts。',
      };
    }

    const sessionDir = scope.sessionDir;
    const scratchpadDir = scope.scratchpadDir;
    const contextDir = scope.contextDir;
    const implementationsDir = scope.implementationsDir;
    const kind = params.kind || 'all';
    const allowedRoots = [
      ...(kind === 'all' || kind === 'scratchpad' ? [scratchpadDir] : []),
      ...(kind === 'all' || kind === 'context' ? [contextDir] : []),
      ...((kind === 'all' || kind === 'implementations') && implementationsDir ? [implementationsDir] : []),
    ].filter((path): path is string => typeof path === 'string' && existsSync(path));

    if (params.action === 'list') {
      const files = allowedRoots.flatMap((root) => collectFiles(root, sessionDir));
      return {
        success: true,
        data: [
          `session_id=${scope.sessionId}`,
          `session_dir=${sessionDir}`,
          `allowed_roots=${allowedRoots.join(', ') || '(none)'}`,
          'artifacts:',
          ...(files.length > 0 ? files.map((file) => `- ${file}`) : ['- (none)']),
        ].join('\n'),
      };
    }

    if (!params.artifact) {
      return {
        success: false,
        data: null,
        error: 'ERROR: 读取 session artifact 时必须提供 artifact 路径。',
      };
    }

    const artifactPath = resolve(sessionDir, params.artifact);
    const isAllowed = allowedRoots.some((root) => isInside(root, artifactPath));
    if (!isAllowed) {
      return {
        success: false,
        data: null,
        error: `ERROR: 非法 artifact 路径 ${params.artifact}。仅允许读取当前 session 的 scratchpad/ 与 context/ 下文件。`,
      };
    }

    if (!existsSync(artifactPath)) {
      return {
        success: false,
        data: null,
        error: `ERROR: artifact 不存在：${params.artifact}`,
      };
    }

    if (statSync(artifactPath).isDirectory()) {
      return {
        success: false,
        data: null,
        error: `ERROR: artifact 必须是文件：${params.artifact}`,
      };
    }

    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
    const fileStat = statSync(artifactPath);
    if (fileStat.size > MAX_FILE_SIZE) {
      return {
        success: false,
        data: null,
        error: `ERROR: 文件过大 (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)，超过限制 (${MAX_FILE_SIZE / 1024 / 1024}MB)。`,
      };
    }

    try {
      const content = readFileSync(artifactPath, 'utf-8');
      const MAX_CONTENT_LENGTH = 50000; // 50KB
      const truncated = content.length > MAX_CONTENT_LENGTH;
      const displayContent = truncated 
        ? content.slice(0, MAX_CONTENT_LENGTH) + '\n\n... [内容已截断，剩余 ' + (content.length - MAX_CONTENT_LENGTH) + ' 字符] ...'
        : content;
      
      return {
        success: true,
        data: [
          `artifact=${relative(sessionDir, artifactPath)}`,
          '',
          displayContent,
        ].join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export default SessionArtifactsTool;
