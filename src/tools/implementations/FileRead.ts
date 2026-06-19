import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { createReadStream } from 'fs';
import { access, stat as statFile } from 'fs/promises';
import { readBinaryProbeAsync, resolveWorkspacePath } from './utils.js';
import { basename, extname } from 'path';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { createInterface } from 'readline';

const FileReadSchema = z.object({
  path: z.string().describe('文件路径'),
  start_line: z.number().optional().describe('起始行号 1-based(可选)'),
  end_line: z.number().optional().describe('结束行号 (含，可选)'),
});

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('file_read aborted');
  }
}

async function readLineWindow(filePath: string, startLine: number, endLine: number, signal?: AbortSignal): Promise<{ lines: string[]; lastLine: number; hitLineLimit: boolean }> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const result: string[] = [];
  let lineNumber = 0;
  let hitLineLimit = false;
  const onAbort = () => stream.destroy(new Error('file_read aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for await (const line of rl) {
      throwIfAborted(signal);
      lineNumber += 1;
      if (lineNumber === 1 && line.startsWith('\uFEFF')) {
        const displayLine = line.slice(1);
        if (startLine <= 1 && endLine >= 1) {
          result.push(`${String(1).padStart(6)}→${formatLine(displayLine)}`);
        }
        continue;
      }
      if (lineNumber < startLine) continue;
      if (lineNumber > endLine) break;

      result.push(`${String(lineNumber).padStart(6)}→${formatLine(line)}`);
      if (result.length >= MAX_LINES) {
        hitLineLimit = true;
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    rl.close();
    stream.destroy();
  }

  return { lines: result, lastLine: lineNumber, hitLineLimit };
}

function formatLine(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? line.slice(0, MAX_LINE_CHARS) + `…[截断，该行共 ${line.length} 字符]`
    : line;
}

const PREVIEWABLE_BINARY_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// Code file extensions that should be wrapped in code blocks
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp',
  '.cs', '.fs', '.swift',
  '.php', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.md', '.astro', '.vue', '.svelte',
]);

/**
 * Detect if a file path is a code file based on extension
 */
function isCodeFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/**
 * Guess language from file extension for syntax highlighting
 */
function guessLanguage(path: string): string {
  const ext = extname(path).toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.c': 'c', '.cpp': 'cpp',
    '.cs': 'csharp', '.swift': 'swift', '.php': 'php',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh',
    '.sql': 'sql', '.md': 'markdown', '.astro': 'astro', '.vue': 'vue', '.svelte': 'svelte',
  };
  return langMap[ext] || 'text';
}

export class FileReadTool extends Tool {
  readonly name = 'file_read';
  readonly description = '读取文件内容，支持指定行号范围（含二进制检测和超大文件流式截断）';
  readonly parameters = FileReadSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof FileReadSchema>;
    let p: string;

    try {
      throwIfAborted(context?.abortSignal);
      p = resolveWorkspacePath(context?.workspace, params.path, context?.sessionId);
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      throwIfAborted(context?.abortSignal);
      await access(p);
    } catch {
      return {
        success: false,
        data: null,
        error: `ERROR: 文件不存在：${params.path}`,
      };
    }

    // 检查是否是文件（而非目录）
    throwIfAborted(context?.abortSignal);
    const stat = await statFile(p);
    if (!stat.isFile()) {
      return {
        success: false,
        data: null,
        error: `ERROR: 不是文件：${params.path}`,
      };
    }

    // 检测二进制文件
    try {
      throwIfAborted(context?.abortSignal);
      const probe = await readBinaryProbeAsync(p, context?.abortSignal);
      if (probe.isBinary) {
        const ext = extname(p).toLowerCase();
        const mimeType = PREVIEWABLE_BINARY_EXTENSIONS[ext];
        if (mimeType) {
          const artifact = tempDownloadRegistry.create({
            path: p,
            name: basename(p),
            mimeType,
            sessionId: context?.sessionId,
          });
          return {
            success: true,
            data: {
              ...artifact,
              preview_url: artifact.url,
              file_path: p,
              mode: 'binary_preview',
            },
          };
        }
        return {
          success: false,
          data: null,
          error: `ERROR: 二进制文件 (${probe.reason})，无法读取：${params.path}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      // 参数验证
      throwIfAborted(context?.abortSignal);
      if (params.start_line !== undefined && params.start_line < 1) {
        return {
          success: false,
          data: null,
          error: `ERROR: start_line 必须 >= 1，当前值: ${params.start_line}`,
        };
      }
      if (params.end_line !== undefined && params.end_line < 1) {
        return {
          success: false,
          data: null,
          error: `ERROR: end_line 必须 >= 1，当前值: ${params.end_line}`,
        };
      }
      if (params.start_line !== undefined && params.end_line !== undefined && params.start_line > params.end_line) {
        return {
          success: false,
          data: null,
          error: `ERROR: 请让 start_line (${params.start_line}) 小于或等于 end_line (${params.end_line})`,
        };
      }

      const s = Math.max(1, params.start_line || 1);
      const e = params.end_line !== undefined ? params.end_line : Number.MAX_SAFE_INTEGER;
      const result = await readLineWindow(p, s, e, context?.abortSignal);
      const lines = [...result.lines];

      if (result.hitLineLimit) {
        lines.push(`...... (⚠️ 已读取 ${MAX_LINES} 行并截断。请使用 start_line=${result.lastLine + 1} 继续读取)`);
      }
      const fileContent = lines.join('\n') || '(空文本内容)';

      return {
        success: true,
        data: fileContent,
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

export default FileReadTool;
