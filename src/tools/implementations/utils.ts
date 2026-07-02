import { spawnSync } from 'child_process';
import { writeFileSync, renameSync, mkdirSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import { open as openFile } from 'fs/promises';
import { join, dirname, basename, resolve, isAbsolute, sep } from 'path';
import { AsyncFileLock } from '../../core/FileLock.js';
import { getPythonExecutable } from '../../utils/platform.js';
import { allowArbitraryTerminalCwd, shouldEnforceTaskWriteScope } from '../../core/HardeningPolicy.js';
import { CONFIG_DIR } from '../../config.js';
import type { ContractAllowedScope } from '../../core/ContractAllowedScope.js';
import { getSessionScopePaths } from '../../contracts/adapters/SessionScope.js';
export {
  getSessionScopeDescription,
  type SessionScopePaths,
} from '../../contracts/adapters/SessionScope.js';
export { getSessionScopePaths };

export interface TaskScopeInput {
  taskWorkingDirectory?: string;
  taskWriteScope?: string[];
}

export function resolveWorkspacePath(
  workspace: string | undefined,
  filePath: string,
  sessionId?: string
): string {
  // 仅解析绝对路径；会话级写入边界由 ensureTaskScopedWritePath 在写入层强制，
  // 解析层不重复校验（读取路径不受会话作用域限制）。
  void sessionId;
  const absolutePath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(workspace || process.cwd(), filePath);
  return absolutePath;
}

export function normalizeTaskWriteScope(
  workspace: string | undefined,
  taskWriteScope?: string[],
  sessionId?: string,
): string[] {
  const workspaceRoot = resolve(workspace || process.cwd());
  const roots = (taskWriteScope && taskWriteScope.length > 0)
    ? taskWriteScope.map((scopePath) => isAbsolute(scopePath) ? resolve(scopePath) : resolve(workspaceRoot, scopePath))
    : [];

  const sessionScope = getSessionScopePaths(workspaceRoot, sessionId);
  if (sessionScope.sessionDir) roots.push(sessionScope.sessionDir);
  return Array.from(new Set(roots));
}

/**
 * 判断 child 是否等于 root 或落在 root 之内（带分隔符边界，避免 /foo 命中 /foobar 前缀绕过）。
 */
function isPathInside(child: string, root: string): boolean {
  const normChild = resolve(child);
  const normRoot = resolve(root);
  if (normChild === normRoot) return true;
  const rootWithSep = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
  return normChild.startsWith(rootWithSep);
}

/**
 * 契约结构化允许面的硬校验(只缩不放)。在 taskWriteScope/session 检查通过后追加执行。
 * - undefined(无契约)→ 直接通过,维持现状(向后兼容)。
 * - forbid 命中 → 拒(优先于 allow,保护架构核心目录)。
 * - allow 未命中 → 拒(收紧到契约声明的目录前缀)。
 * - mode='create' 且 allowCreate 未开启 → 拒(禁止新建文件)。
 *
 * 契约层只缩不放:被契约拒绝的路径即便落在 taskWriteScope 内也拒;被契约放行的路径必然已通过 taskWriteScope
 * (否则在调用方的 allowedRoots 循环里就因越界被拒)。
 */
function enforceContractAllowedScope(
  absolutePath: string,
  workspaceRoot: string,
  scope: ContractAllowedScope | undefined,
  mode: 'create' | 'modify' | undefined,
): void {
  if (!scope) return;
  const resolvePrefix = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p));
  for (const forbidPrefix of scope.forbid ?? []) {
    if (isPathInside(absolutePath, resolvePrefix(forbidPrefix))) {
      throw new Error(
        `契约禁止面：路径 ${absolutePath} 命中契约 allowedScope.forbid 区 ${forbidPrefix}，拒绝写入。`,
      );
    }
  }
  const allowRoots = scope.allow.map(resolvePrefix);
  const hitAllow = allowRoots.some(r => isPathInside(absolutePath, r));
  if (!hitAllow) {
    throw new Error(
      `契约允许面：路径 ${absolutePath} 不在契约 allowedScope.allow 之内(${scope.allow.join(', ') || '空'}），拒绝写入。请升级契约扩大 allow，或改到允许目录。`,
    );
  }
  if (mode === 'create' && scope.allowCreate !== true) {
    throw new Error(
      `契约禁止新建文件：allowedScope.allowCreate 未开启，file_create 被拒。改用 structured_patch 修改既有文件，或升级契约显式声明 allow_create: true。`,
    );
  }
}

export function ensureTaskScopedWritePath(
  absolutePath: string,
  workspace: string | undefined,
  taskWriteScope?: string[],
  sessionId?: string,
  contractAllowedScope?: ContractAllowedScope,
  mode?: 'create' | 'modify',
): void {
  // 写入隔离：目标路径必须落在 workspace root、显式 taskWriteScope、当前 session runtime 或
  // lingxiao 全局配置目录（~/.lingxiao/ — skills/agents/commands/memory 等）之内。
  const workspaceRoot = resolve(workspace || process.cwd());
  // Task write-scope isolation is only enforced in hardened mode. In non-hardened
  // mode, skip the scope boundary check and keep only the contract tightening layer.
  if (!shouldEnforceTaskWriteScope()) {
    enforceContractAllowedScope(absolutePath, workspaceRoot, contractAllowedScope, mode);
    return;
  }
  const allowedRoots = new Set<string>([workspaceRoot, CONFIG_DIR]);
  for (const root of normalizeTaskWriteScope(workspaceRoot, taskWriteScope, sessionId)) {
    allowedRoots.add(root);
  }
  for (const root of allowedRoots) {
    if (isPathInside(absolutePath, root)) {
      // 命中 taskWriteScope/workspace 后,追加契约收紧层(只缩不放:契约拒绝的路径即便在 scope 内也拒)。
      enforceContractAllowedScope(absolutePath, workspaceRoot, contractAllowedScope, mode);
      return;
    }
  }
  // 拒绝时给出可执行的引导:列出允许写入的根,并给出一个工作区内的具体可用路径(同名文件),
  // 避免调用方只看到"越界"而不知道该写到哪里。
  const allowedList = Array.from(allowedRoots);
  const rootsShown = allowedList.slice(0, 5);
  const rootsExtra = allowedList.length > rootsShown.length ? `（共 ${allowedList.length} 个）` : '';
  const requestedName = basename(absolutePath) || 'output';
  const suggestedPath = join(workspaceRoot, requestedName);
  throw new Error(
    `写入隔离：路径越界，拒绝写入工作区/会话范围之外的位置: ${absolutePath}。` +
    `允许写入的目录: ${rootsShown.join(', ')}${rootsExtra}（工作区根 / 任务写入作用域 / 会话目录）。` +
    `请改用工作区内的相对路径，或绝对路径如 "${suggestedPath}"。`,
  );
}

export function resolveTaskWritePath(
  workspace: string | undefined,
  filePath: string,
  sessionId?: string,
  taskWriteScope?: string[],
  contractAllowedScope?: ContractAllowedScope,
  mode?: 'create' | 'modify',
): string {
  const absolutePath = resolveWorkspacePath(workspace, filePath, sessionId);
  ensureTaskScopedWritePath(absolutePath, workspace, taskWriteScope, sessionId, contractAllowedScope, mode);
  return absolutePath;
}

export function resolveTaskWorkingDirectory(
  workspace: string | undefined,
  cwd: string | undefined,
  sessionId?: string,
  taskWorkingDirectory?: string,
  taskWriteScope?: string[]
): string {
  const preferred = cwd || taskWorkingDirectory || '.';
  const absolutePath = resolveWorkspacePath(workspace, preferred, sessionId);
  if (!allowArbitraryTerminalCwd()) {
    const workspaceRoot = resolve(workspace || process.cwd());
    const allowedRoots = new Set<string>([workspaceRoot]);
    for (const root of normalizeTaskWriteScope(workspaceRoot, taskWriteScope, sessionId)) {
      allowedRoots.add(root);
    }
    for (const root of allowedRoots) {
      if (isPathInside(absolutePath, root)) {
        return absolutePath;
      }
    }
    throw new Error(
      `执行目录隔离：cwd 越界，拒绝在工作区/会话范围之外执行: ${absolutePath}`,
    );
  }
  return absolutePath;
}

/**
 * 本机 LISTEN 状态的 TCP 端口(仅 loopback + 通配地址,即本地 dev server 相关的那些)。
 * 用 ss/netstat 的真实 OS 信号,非启发式猜测。
 */
export interface ListeningPort {
  port: number;
  address: string;
  family: 'IPv4' | 'IPv6';
}

// 捕获 "地址:端口" 形态的本地监听地址(IPv4 点分 / IPv6 含冒号或方括号)。
// 在 ss/netstat 的 LISTEN 行里,本地地址总是出现在对端地址之前,故首个匹配即为本地地址。
const LISTEN_ADDR_RE = /(\[?[0-9a-fA-F.:]+\]?):(\d{1,5})/;

function classifyListenAddress(rawAddr: string): { address: string; family: 'IPv4' | 'IPv6' } | null {
  const address = rawAddr.replace(/^\[|\]$/g, '');
  if (!address) return null;
  // IPv4(含通配 0.0.0.0)不含多余冒号;IPv6 含冒号。
  return { address, family: address.includes(':') ? 'IPv6' : 'IPv4' };
}

function isLoopbackOrWildcard(address: string, family: 'IPv4' | 'IPv6'): boolean {
  if (family === 'IPv4') {
    return address === '0.0.0.0' || address.startsWith('127.');
  }
  return address === '::' || address === ':::' || address === '::1'
    || address === '0::0' || address === '0:0:0:0:0:0:0:0' || address === '0:0:0:0:0:0:0:1';
}

/**
 * 从 ss/netstat 的 stdout 文本中解析出 loopback/通配地址上 LISTEN 的端口(纯函数,可单测)。
 * 跨平台兼容:`ss -tlnH`(Linux/macOS)/ `netstat -tln`(Linux)/ `netstat -ano`(Windows)。
 * 列内本地地址恒出现在对端之前,故取首个 "地址:端口" 匹配作为本地监听地址。
 */
export function parseListeningPortsFromText(text: string): ListeningPort[] {
  const seen = new Set<number>();
  const out: ListeningPort[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const match = line.match(LISTEN_ADDR_RE);
    if (!match) continue;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const classified = classifyListenAddress(match[1]);
    if (!classified) continue;
    if (!isLoopbackOrWildcard(classified.address, classified.family)) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push({ port, address: classified.address, family: classified.family });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}

/**
 * 跨平台枚举本机 LISTEN 状态的 TCP 端口(限定 loopback + 通配地址)。
 * Linux/macOS 优先 `ss -tlnH`,缺失时回退 `netstat -tln`;Windows 用 `netstat -ano`。
 * 命令缺失或解析为空时返回 []。供浏览器工具在连接被拒时给出"实际在听哪些端口"的
 * 可执行引导,避免调用方误诊为"沙箱网络隔离"而瞎试。
 */
export function listListeningLoopbackPorts(): ListeningPort[] {
  const candidates: Array<{ file: string; args: string[] }> = process.platform === 'win32'
    ? [{ file: 'netstat', args: ['-ano'] }]
    : [
      { file: 'ss', args: ['-tlnH'] },
      { file: 'netstat', args: ['-tln'] },
    ];

  for (const { file, args } of candidates) {
    let res: import('child_process').SpawnSyncReturns<string> | undefined;
    try {
      res = spawnSync(file, args, { encoding: 'utf-8', timeout: 3000 });
    } catch {
      continue;
    }
    if (res.error || res.status !== 0) continue;
    const ports = parseListeningPortsFromText(res.stdout);
    if (ports.length > 0) return ports;
  }
  return [];
}

/**
 * Safe literal string replacement that does NOT interpret $-patterns.
 *
 * JS String.replace() treats special patterns in the replacement string:
 *   $$  → $        $&  → matched substring    $`  → pre-match
 *   $'  → post-match    $n  → nth capture group
 *
 * This function escapes `$` in the replacement so it is treated as a literal
 * character, making the replacement safe for arbitrary code content.
 */
export function safeLiteralReplace(
  content: string,
  search: string,
  replace: string,
  replaceAll = false,
): string {
  if (replaceAll) {
    const parts: string[] = [];
    let startIdx = 0;
    while (true) {
      const idx = content.indexOf(search, startIdx);
      if (idx === -1) break;
      parts.push(content.slice(startIdx, idx));
      parts.push(replace);
      startIdx = idx + search.length;
    }
    parts.push(content.slice(startIdx));
    return parts.join('');
  }

  const safeReplace = replace.replace(/\$/g, '$$$$');
  return content.replace(search, safeReplace);
}

/**
 * Count non-overlapping occurrences of `search` in `str`.
 */
export function countOccurrences(str: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while ((index = str.indexOf(search, index)) !== -1) {
    count++;
    index += search.length;
  }
  return count;
}

export interface BinaryProbeResult {
  isBinary: boolean;
  reason: string;
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('operation aborted');
  }
}

const BINARY_SNIFF_BYTES = 8192;
const NON_PRINTABLE_RATIO_THRESHOLD = 0.30;

const BINARY_MAGIC_BYTES: Array<{ pattern: number[]; name: string }> = [
  { pattern: [0x89, 0x50, 0x4E, 0x47], name: 'PNG' },
  { pattern: [0xFF, 0xD8, 0xFF], name: 'JPEG' },
  { pattern: [0x47, 0x49, 0x46], name: 'GIF' },
  { pattern: [0x50, 0x4B, 0x03, 0x04], name: 'ZIP/Office' },
  { pattern: [0x1F, 0x8B], name: 'GZIP' },
  { pattern: [0x42, 0x5A], name: 'BZIP2' },
  { pattern: [0x37, 0x7A, 0xBC, 0xAF], name: '7z' },
  { pattern: [0x52, 0x61, 0x72, 0x21], name: 'RAR' },
  { pattern: [0x25, 0x50, 0x44, 0x46], name: 'PDF' },
  { pattern: [0x7F, 0x45, 0x4C, 0x46], name: 'ELF' },
  { pattern: [0x4D, 0x5A], name: 'PE/EXE' },
  { pattern: [0xCA, 0xFE, 0xBA, 0xBE], name: 'Java Class/Mach-O' },
  { pattern: [0xFE, 0xED, 0xFA], name: 'Mach-O' },
  { pattern: [0x00, 0x00, 0x00], name: 'MP4' },
  { pattern: [0x49, 0x44, 0x33], name: 'MP3-ID3' },
  { pattern: [0xFF, 0xFB], name: 'MP3' },
  { pattern: [0x4F, 0x67, 0x67, 0x53], name: 'OGG' },
  { pattern: [0x57, 0x41, 0x56, 0x45], name: 'WAV' },
];

export function getBinaryMagicType(buf: Buffer): string | null {
  const sampleSize = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (const { pattern, name } of BINARY_MAGIC_BYTES) {
    if (pattern.every((byte, index) => index < sampleSize && buf[index] === byte)) {
      return name;
    }
  }
  return null;
}

export function isLikelyBinaryBuffer(buf: Buffer): boolean {
  const sampleSize = Math.min(buf.length, BINARY_SNIFF_BYTES);
  if (sampleSize === 0) return false;
  if (getBinaryMagicType(buf)) return true;

  let nonPrintable = 0;
  let i = 0;
  while (i < sampleSize) {
    const byte = buf[i];
    if (byte === 9 || byte === 10 || byte === 13) { i++; continue; }
    if (byte >= 32 && byte <= 126) { i++; continue; }
    if (byte >= 0xC0) {
      let seqLen = 1;
      if ((byte & 0xE0) === 0xC0) seqLen = 2;
      else if ((byte & 0xF0) === 0xE0) seqLen = 3;
      else if ((byte & 0xF8) === 0xF0) seqLen = 4;

      i++;
      let validSeq = true;
      for (let j = 1; j < seqLen && i < sampleSize; j++) {
        if ((buf[i] & 0xC0) !== 0x80) {
          validSeq = false;
          break;
        }
        i++;
      }
      if (!validSeq) nonPrintable++;
      continue;
    }
    if (byte >= 0x80 && byte <= 0xBF) {
      nonPrintable++;
      i++;
      continue;
    }
    nonPrintable++;
    i++;
  }

  return (nonPrintable / sampleSize) > NON_PRINTABLE_RATIO_THRESHOLD;
}

function binaryProbeFromBuffer(buffer: Buffer, bytesRead: number): BinaryProbeResult {
  if (bytesRead === 0) return { isBinary: false, reason: '' };

  const chunk = buffer.subarray(0, bytesRead);
  if (chunk.includes(0x00)) return { isBinary: true, reason: '包含 null 字节' };

  const magicType = getBinaryMagicType(chunk);
  if (magicType) return { isBinary: true, reason: `二进制文件格式 (${magicType})` };

  if (isLikelyBinaryBuffer(chunk)) return { isBinary: true, reason: '高比例控制字符' };
  return { isBinary: false, reason: '' };
}

export function readBinaryProbe(filePath: string): BinaryProbeResult {
  let fd: number | null = null;
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return binaryProbeFromBuffer(buffer, bytesRead);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export async function readBinaryProbeAsync(filePath: string, signal?: AbortSignal): Promise<BinaryProbeResult> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    throwIfSignalAborted(signal);
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    handle = await openFile(filePath, 'r');
    throwIfSignalAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    throwIfSignalAborted(signal);
    return binaryProbeFromBuffer(buffer, bytesRead);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

export function getPythonSyntaxWarning(content: string): string {
  // 注意：此方法是同步的，调用方如果需要非阻塞应使用 getPythonSyntaxWarningAsync
  const result = spawnSync(
    getPythonExecutable(),
    ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'],
    {
      input: content,
      encoding: 'utf-8',
      timeout: 5000,
    }
  );

  if (result.status === 0) {
    return '';
  }

  const stderr = result.stderr || result.error?.message || '未知语法错误';
  return `\n⚠️ 警告：检测到 Python 语法错误（缩进丢失或语法不规范）: ${stderr}，请立刻检查并修正！`;
}

/**
 * 异步版本：Python 语法检查，不阻塞事件循环
 */
export async function getPythonSyntaxWarningAsync(content: string): Promise<string> {
  const { spawn } = await import('child_process');
  const { getPythonExecutable } = await import('../../utils/platform.js');
  const pyExec = getPythonExecutable();
  return new Promise((resolve) => {
    const proc = spawn(pyExec, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      timeout: 5000,
    });
    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve('');
      } else {
        resolve(`\n⚠️ 警告：检测到 Python 语法错误（缩进丢失或语法不规范）: ${stderr || '未知语法错误'}，请立刻检查并修正！`);
      }
    });
    proc.on('error', (err) => {
      resolve(`\n⚠️ Python 语法检查失败: ${err.message}`);
    });
    proc.stdin?.write(content);
    proc.stdin?.end();
  });
}

/**
 * Acquire a file-level lock, perform the write via temp-file + rename (atomic),
 * then release the lock. Guarantees serialized writes and no partial reads.
 */
export async function lockedAtomicWrite(
  filePath: string,
  content: string,
  options?: { createDirs?: boolean; timeout?: number },
): Promise<void> {
  const lockPath = `${filePath}.lock`;
  const lock = new AsyncFileLock(lockPath, { timeout: options?.timeout ?? 10 });
  await lock.acquire();
  try {
    if (options?.createDirs) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, content, 'utf-8');
    try {
      renameSync(tmpPath, filePath);
    } catch (renameErr) {
      // Fallback: if rename fails across filesystems, copy content directly
      try { unlinkSync(tmpPath); } catch {/* expected: file may not exist */}
      writeFileSync(filePath, content, 'utf-8');
    }
  } finally {
    await lock.release();
  }
}

export async function lockedAtomicWriteBuffer(
  filePath: string,
  content: Buffer,
  options?: { createDirs?: boolean; timeout?: number },
): Promise<void> {
  const lockPath = `${filePath}.lock`;
  const lock = new AsyncFileLock(lockPath, { timeout: options?.timeout ?? 10 });
  await lock.acquire();
  try {
    if (options?.createDirs) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, content);
    try {
      renameSync(tmpPath, filePath);
    } catch {/* swallowed: unhandled error */
      try { unlinkSync(tmpPath); } catch {/* expected: file may not exist */}
      writeFileSync(filePath, content);
    }
  } finally {
    await lock.release();
  }
}
