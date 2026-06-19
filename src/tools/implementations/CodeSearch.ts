import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync } from 'fs';
import { isLikelyBinaryBuffer, resolveWorkspacePath } from './utils.js';
import { TRUNCATION } from '../../config/defaults.js';
import { getConfigValue } from '../../config.js';

const execFileAsync = promisify(execFile);

type ExecFailure = Error & {
  killed?: boolean;
  code?: string | number;
  stdout?: string;
  stderr?: string;
};

const MAX_OUTPUT_SIZE = TRUNCATION.CODESEARCH_OUTPUT_MAX;
const MAX_LINE_COUNT = TRUNCATION.CODESEARCH_LINE_MAX;
const COLOR_DISABLED_VALUE = 'nev' + 'er';
const COLOR_DISABLED_ARG = '--color=' + COLOR_DISABLED_VALUE;
const GLOB_REGEX_SPECIAL_CHARS = new Set(['[', ']', '!', '@', '#', '%', '&', '^', '(', ')', '$']);

export interface CodeSearchOptions {
  offset?: number;
  limit?: number;
}

interface CodeSearchSuccessData {
  matches: string[];
  text: string;
  count: number;
  total_scanned_matches: number;
  offset: number;
  limit: number;
  truncated: boolean;
  next_offset?: number;
  continuation_tool_call?: {
    tool: 'code_search';
    args: {
      pattern: string;
      path: string;
      file_pattern?: string;
      timeout?: number;
      offset: number;
      limit: number;
    };
  };
  hint?: string;
}

export type CodeSearchResult = { success: true; data: CodeSearchSuccessData } | { success: false; data: ''; error: string };

function sanitizePattern(pattern: string): string {
  if (!pattern) return '';
  return pattern.replace(/\0/g, '');
}

function normalizeSearchOptions(options?: CodeSearchOptions): Required<CodeSearchOptions> {
  return {
    offset: Math.max(0, Math.floor(options?.offset ?? 0)),
    limit: Math.max(1, Math.min(Math.floor(options?.limit ?? MAX_LINE_COUNT), 500)),
  };
}

function paginateMatches(matches: string[], pattern: string, path: string, filePattern: string | undefined, timeout: number | undefined, options?: CodeSearchOptions): CodeSearchSuccessData {
  const normalized = normalizeSearchOptions(options);
  const page = matches.slice(normalized.offset, normalized.offset + normalized.limit);
  const nextOffset = normalized.offset + page.length;
  const truncated = nextOffset < matches.length;
  const textParts = page.length > 0
    ? [...page]
    : [`未找到匹配：${pattern}`, '建议：', '1. 检查拼写和大小写', '2. 使用更短的关键词', '3. 使用正则表达式处理变体（如 funct..n 或 class|interface）', '4. 如果确定代码存在，请直接用 file_read 读取相关文件'];
  if (truncated) {
    textParts.push(`... (结果过多，本页 ${page.length} 条，next_offset=${nextOffset}，请用 continuation_tool_call 继续)`);
  }
  return {
    matches: page,
    text: textParts.join('\n'),
    count: page.length,
    total_scanned_matches: matches.length,
    offset: normalized.offset,
    limit: normalized.limit,
    truncated,
    ...(truncated ? {
      next_offset: nextOffset,
      continuation_tool_call: {
        tool: 'code_search',
        args: {
          pattern,
          path,
          ...(filePattern ? { file_pattern: filePattern } : {}),
          ...(timeout ? { timeout } : {}),
          offset: nextOffset,
          limit: normalized.limit,
        },
      },
      hint: '结果已分页；继续读取时使用 continuation_tool_call 和下一个 offset。',
    } : {}),
  };
}

function truncateLongMatchLines(matches: string[]): string[] {
  return matches.map((line) => line.length > 800 ? `${line.slice(0, 800)}...` : line);
}

function countChar(input: string, char: string): number {
  let count = 0;
  for (const current of input) {
    if (current === char) count++;
  }
  return count;
}

function containsDoubleDot(input: string): boolean {
  for (let i = 0; i < input.length - 1; i++) {
    if (input[i] === '.' && input[i + 1] === '.') return true;
  }
  return false;
}

function isValidFilePattern(pattern: string): boolean {
  if (/[;|&`$()\[\]!<>\\]/.test(pattern)) return false;
  if (containsDoubleDot(pattern) || pattern[0] === '/') return false;
  if (pattern.length > 200) return false;
  // Brace validation: must be paired, content only safe chars
  const openCount = countChar(pattern, '{');
  const closeCount = countChar(pattern, '}');
  if (openCount !== closeCount) return false;
  if (openCount > 0) {
    const braceContentRegex = /\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = braceContentRegex.exec(pattern)) !== null) {
      if (!/^[a-zA-Z0-9_.*,-]+$/.test(m[1])) return false;
    }
  }
  return true;
}

/**
 * Expand brace patterns: "*.{tsx,ts}" → ["*.tsx", "*.ts"].
 * Only expands the outermost brace pair; nested braces are kept literal
 * in the expanded alternatives (to be expanded in a subsequent call).
 */
function braceExpand(pattern: string): string[] {
  // Find outermost brace pair
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (pattern[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        end = i;
        break;
      }
    }
  }

  if (start === -1 || end === -1) return [pattern];

  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const content = pattern.slice(start + 1, end);

  // Split by commas at depth 0 (respect nested braces)
  const alternatives: string[] = [];
  let current = '';
  let d = 0;
  for (const ch of content) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
    else if (ch === ',' && d === 0) {
      alternatives.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) alternatives.push(current);

  return alternatives.map(alt => prefix + alt + suffix);
}

/**
 * Check if ripgrep (rg) is available on the system.
 */
let _rgAvailable: boolean | undefined;
async function isRgAvailable(): Promise<boolean> {
  if (_rgAvailable !== undefined) return _rgAvailable;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 3000 });
    _rgAvailable = true;
  } catch { /* expected: rg binary may not be installed */
    _rgAvailable = false;
  }
  return _rgAvailable;
}

/**
 * Build ripgrep arguments.
 * rg is significantly better than grep for code search:
 * - Respects .gitignore by default
 * - Faster, better Unicode support
 * - Smarter binary detection
 */
function buildRgArgs(
  pattern: string,
  searchPath: string,
  filePattern?: string,
  ignoreGitignore?: boolean,
): string[] {
  const args: string[] = [
    '--line-number',         // -n: show line numbers
    '--with-filename',       // show file paths
    '--color', COLOR_DISABLED_VALUE, // ANSI escapes disabled
    '--no-heading',          // ungrouped file output
    '--binary-files', 'without-match', // skip binary
    '--max-count', '500',    // per-file match limit (generous)
    '--hidden',              // include hidden project/session artifacts
    '-E',                    // extended regex
  ];

  if (ignoreGitignore) {
    args.push('--no-ignore');
  }

  args.push(pattern, searchPath);

  if (filePattern) {
    const expandedPatterns = braceExpand(filePattern);
    for (const p of expandedPatterns) {
      args.push('--glob', p);
    }
  }

  return args;
}

/**
 * Build GNU grep arguments.
 */
function buildGrepArgs(
  pattern: string,
  searchPath: string,
  filePattern?: string,
  ignoreGitignore?: boolean,
): string[] {
  const args: string[] = [
    '-rn',                   // recursive + line numbers
    '-E',                    // extended regex
    COLOR_DISABLED_ARG,
    '--binary-files=without-match',
    '--max-count=500',       // per-file match limit (generous)
  ];

  if (ignoreGitignore) {
    args.push('--no-ignore');
  }

  args.push(pattern, searchPath);

  if (filePattern) {
    if (!isValidFilePattern(filePattern)) {
      return []; // will be caught by caller
    }
    const expandedPatterns = braceExpand(filePattern);
    // Insert --include args before the pattern and search path
    for (let e = expandedPatterns.length - 1; e >= 0; e--) {
      args.splice(args.length - 2, 0, `--include=${expandedPatterns[e]}`);
    }
  }

  return args;
}

// ─── JS Fallback ────────────────────────────────────────────────────────────

/**
 * Convert a file glob pattern to a RegExp that matches full file paths.
 * Handles: *, ?, **, {a,b} brace expansion
 * Matches against the full relative path (e.g. "src/utils/helper.ts")
 */
function globToPathRegex(glob: string): RegExp {
  // First, expand braces to handle {tsx,ts} patterns
  const expanded = braceExpand(glob);
  if (expanded.length > 1) {
    const parts = expanded.map(g => globToPathRegex(g).source);
    return new RegExp('(' + parts.join('|') + ')');
  }

  function convert(segment: string): string {
    let reStr = '';
    let i = 0;
    while (i < segment.length) {
      const c = segment[i];
      if (c === '*' && segment[i + 1] === '*' && (segment[i + 2] === '/' || i + 2 === segment.length)) {
        // ** matches any path segment(s)
        reStr += '.*';
        i += segment[i + 2] === '/' ? 3 : 2;
      } else if (c === '*') {
        // * matches anything except /
        reStr += '[^/]*';
        i++;
      } else if (c === '?') {
        reStr += '[^/]';
        i++;
      } else if (c === '.') {
        reStr += '\\.';
        i++;
      } else if (GLOB_REGEX_SPECIAL_CHARS.has(c)) {
        reStr += '\\' + c;
        i++;
      } else {
        reStr += c;
        i++;
      }
    }
    return reStr;
  }

  return new RegExp(convert(glob) + '$');
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '__pycache__', '.next', 'coverage', '.turbo', 'target', 'vendor',
  '.cache', '.vscode', '.idea', '.tox', '.mypy_cache', '.pytest_cache',
  'venv', '.venv', 'env', '.env', '.direnv',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flac',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.so', '.dll', '.dylib', '.exe', '.bin', '.dat',
  '.pyc', '.pyo', '.class', '.o', '.obj',
  '.sqlite', '.db', '.lock',
  '.map',  // source maps are usually not useful to search
]);

/**
 * Pure JS fallback: recursively search files using Node.js fs + regex.
 * Enhanced version with better file matching and binary detection.
 */
async function codeSearchJS(
  pattern: string,
  searchPath: string,
  filePattern: string | undefined,
  maxCount: number,
  _sessionId?: string,
  _workspace?: string,
): Promise<{ matches: string[]; truncated: boolean; filesSearched: number }> {
  const fs = await import('fs/promises');
  const path = await import('path');

  // File pattern matches against the full relative path from searchPath
  const fileRe = filePattern ? globToPathRegex(filePattern) : null;

  // Compile search regex with case-insensitive option for common patterns
  let searchRe: RegExp;
  try {
    searchRe = new RegExp(pattern, 'i');
  } catch { /* expected: invalid regex — try escaping */
    try {
      searchRe = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch { /* expected: pattern still invalid after escaping */
      return { matches: [], truncated: false, filesSearched: 0 };
    }
  }

  const matches: string[] = [];
  let truncated = false;
  let filesSearched = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    // Depth limit to prevent runaway recursion
    if (depth > 20) return;
    if (matches.length >= maxCount) { truncated = true; return; }

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { /* expected: directory may be unreadable (permission denied) */ return; }

    for (const entry of entries) {
      if (matches.length >= maxCount) { truncated = true; return; }
      if (entry.name[0] === '.' && entry.name !== '.lingxiao') continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      const relPath = path.relative(searchPath, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        // File pattern filtering: match against relative path
        if (fileRe && !fileRe.test(relPath) && !fileRe.test(entry.name)) continue;

        const ext = path.extname(full).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;

        filesSearched++;

        let content: string;
        let rawBuf: Buffer;
        try {
          const stat = await fs.stat(full);
          // Skip files > 2MB
          if (stat.size > 2 * 1024 * 1024) continue;

          // Read first 8KB for binary check
          const handle = await fs.open(full, 'r');
          let bytesRead = 0;
          try {
            const probeBuf = Buffer.alloc(8192);
            ({ bytesRead } = await handle.read(probeBuf, 0, 8192, 0));
            if (bytesRead > 0 && isLikelyBinaryBuffer(probeBuf.subarray(0, bytesRead))) continue;
          } finally {
            await handle.close();
          }

          content = await fs.readFile(full, 'utf-8');
        } catch { /* expected: file may be binary or unreadable */ continue; }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < maxCount; i++) {
          const line = lines[i]!;
          if (searchRe.test(line)) {
            // Trim very long lines for readability
            const displayLine = line.length > 500 ? line.slice(0, 500) + '...' : line;
            matches.push(`${full.replace(/\\/g, '/')}:${i + 1}:${displayLine}`);
          }
        }
      }
    }
  }

  // 单文件搜索：跳过目录遍历，直接搜该文件
  const stat = await fs.stat(searchPath);
  if (stat.isFile()) {
    filesSearched = 1;
    const ext = path.extname(searchPath).toLowerCase();
    if (!BINARY_EXTS.has(ext)) {
      try {
        if (stat.size <= 2 * 1024 * 1024) {
          const probeBuf = Buffer.alloc(8192);
          const handle = await fs.open(searchPath, 'r');
          let bytesRead = 0;
          try {
            ({ bytesRead } = await handle.read(probeBuf, 0, 8192, 0));
            if (!(bytesRead > 0 && isLikelyBinaryBuffer(probeBuf.subarray(0, bytesRead)))) {
              const content = await fs.readFile(searchPath, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length && matches.length < maxCount; i++) {
                const line = lines[i]!;
                if (searchRe.test(line)) {
                  const displayLine = line.length > 500 ? line.slice(0, 500) + '...' : line;
                  matches.push(`${searchPath.replace(/\\/g, '/')}:${i + 1}:${displayLine}`);
                }
              }
            }
          } finally {
            await handle.close();
          }
        }
      } catch { /* file unreadable */ }
    }
    return { matches, truncated, filesSearched };
  }

  await walk(searchPath, 0);
  return { matches, truncated, filesSearched };
}

// ─── Main Search Engine ─────────────────────────────────────────────────────

export class CodeSearch {
  static async execute(
    pattern: string,
    path: string = '.',
    filePattern?: string,
    timeout: number = 30,
    workspace?: string,
    sessionId?: string,
    options?: CodeSearchOptions,
  ): Promise<CodeSearchResult> {
    try {
      if (!pattern || pattern.length > 1000) {
        return { success: false, data: '', error: '搜索模式为空或过长 (最大 1000 字符)' };
      }

      const sanitizedPattern = sanitizePattern(pattern);
      const searchPath = resolveWorkspacePath(workspace, path, sessionId);

      if (!existsSync(searchPath)) {
        return { success: false, data: '', error: `搜索路径不存在: ${path}` };
      }

      // 路径可以是目录或文件——rg/grep 原生支持单文件搜索
      try {
        statSync(searchPath);
      } catch { /* expected: path may not exist or no permission */
        return { success: false, data: '', error: `无法访问搜索路径: ${path}` };
      }

      // Validate file pattern early
      if (filePattern && !isValidFilePattern(filePattern)) {
        return { success: false, data: '', error: '文件模式包含非法字符，仅允许 glob 模式（如 *.py、*.ts、*.{tsx,ts}）' };
      }

      // 读取 ignoreGitIgnore 配置
      const ignoreGitignore = !!getConfigValue('advanced.ignore_gitignore');

      // Strategy 1: Try ripgrep (fastest, best results)
      const rgAvailable = await isRgAvailable();
      if (rgAvailable) {
        const result = await this.searchWithRg(sanitizedPattern, searchPath, filePattern, timeout, path, options, false, ignoreGitignore);
        if (result !== null) return result;
      }

      // Strategy 2: Try GNU grep
      const grepResult = await this.searchWithGrep(sanitizedPattern, searchPath, filePattern, timeout, path, options, false, ignoreGitignore);
      if (grepResult !== null) return grepResult;

      // Strategy 3: JS fallback (always works)
      return await this.searchWithJS(pattern, searchPath, path, filePattern, timeout, options);
    } catch (error: unknown) {
      const execError = error as Error;
      return { success: false, data: '', error: `搜索失败 - ${execError.name}: ${execError.message}` };
    }
  }

  /**
   * Search with ripgrep
   */
  private static async searchWithRg(
    pattern: string,
    searchPath: string,
    filePattern: string | undefined,
    timeout: number,
    originalPath: string,
    options: CodeSearchOptions | undefined,
    _searchingInsideExplicitSessionPath: boolean,
    ignoreGitignore?: boolean,
  ): Promise<CodeSearchResult | null> {
    const args = buildRgArgs(pattern, searchPath, filePattern, ignoreGitignore);
    if (args.length === 0) return null; // invalid file pattern

    try {
      const result = await execFileAsync('rg', args, {
        timeout: timeout * 1000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
      });

      const output = result.stdout || '';

      if (!output.trim()) {
        return null; // No matches, try next strategy
      }

      return this.formatOutput(output, pattern, originalPath, filePattern, timeout, options);
    } catch (error: unknown) {
      const execError = error as ExecFailure;
      if (execError.killed === true) {
        return {
          success: false, data: '',
          error: '搜索超时！请缩小搜索范围（指定 path 或 file_pattern）或使用更具体的搜索词。',
        };
      }
      // rg exits with code 1 when no matches found — not an error
      if (execError.code === 1) {
        return null; // No matches, try next strategy
      }
      // Other error → fall through to grep/JS
      return null;
    }
  }

  /**
   * Search with GNU grep
   */
  private static async searchWithGrep(
    pattern: string,
    searchPath: string,
    filePattern: string | undefined,
    timeout: number,
    originalPath: string,
    options: CodeSearchOptions | undefined,
    _searchingInsideExplicitSessionPath: boolean,
    ignoreGitignore?: boolean,
  ): Promise<CodeSearchResult | null> {
    const args = buildGrepArgs(pattern, searchPath, filePattern, ignoreGitignore);
    if (args.length === 0) return null; // invalid file pattern

    try {
      const result = await execFileAsync('grep', args, {
        timeout: timeout * 1000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
      });

      const output = result.stdout || '';

      if (!output.trim()) {
        return null; // No matches, try next strategy
      }

      return this.formatOutput(output, pattern, originalPath, filePattern, timeout, options);
    } catch (error: unknown) {
      const execError = error as ExecFailure;
      if (execError.killed === true) {
        return {
          success: false, data: '',
          error: '搜索超时！请缩小搜索范围（指定 path 或 file_pattern）或使用更具体的搜索词。',
        };
      }
      // grep exits with code 1 when no matches found
      if (execError.code === 1) {
        return null; // No matches, try next strategy
      }
      // grep not available or other error → JS fallback
      return null;
    }
  }

  /**
   * Search with pure JS (always works, no external deps)
   */
  private static async searchWithJS(
    pattern: string,
    searchPath: string,
    originalPath: string,
    filePattern: string | undefined,
    timeout: number,
    options?: CodeSearchOptions,
  ): Promise<CodeSearchResult> {
    const normalized = normalizeSearchOptions(options);
    const { matches, filesSearched } = await codeSearchJS(
      pattern, searchPath, filePattern, normalized.offset + normalized.limit + 1,
    );

    const data = paginateMatches(truncateLongMatchLines(matches), pattern, originalPath, filePattern, timeout, options);
    if (matches.length === 0) {
      data.hint = `未找到匹配（已搜索 ${filesSearched} 个文件）。如确定存在，请缩小 path/file_pattern 或直接 file_read。`;
    }
    return { success: true, data };
  }

  /**
   * Format and truncate search output
   */
  private static formatOutput(
    output: string,
    pattern: string,
    originalPath: string,
    filePattern: string | undefined,
    timeout: number,
    options?: CodeSearchOptions,
  ): CodeSearchResult {
    const rawLines = output.split('\n').filter((line) => line.trim().length > 0);
    const lines = truncateLongMatchLines(rawLines);
    const data = paginateMatches(lines, pattern, originalPath, filePattern, timeout, options);
    if (data.text.length > MAX_OUTPUT_SIZE) {
      data.text = `${data.text.slice(0, MAX_OUTPUT_SIZE)}\n... (本页输出过大已截断；如需更多结果请用 continuation_tool_call 或缩小 file_pattern)`;
      data.truncated = true;
    }
    return { success: true, data };
  }
}

export default CodeSearch;
