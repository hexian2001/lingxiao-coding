/**
 * LSP Client — manages Language Server Protocol server connections and requests.
 *
 * Experimental: gated behind LINGXIAO_EXPERIMENTAL_LSP=1
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { registerCleanup } from '../core/CleanupRegistry.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LspServerConfig {
  command: string[];
  /** Working directory for the LSP server process */
  rootUri?: string;
}

export interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LspSymbol {
  name: string;
  kind: number;
  location?: LspLocation;
  containerName?: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LspHoverResult {
  contents: string;
}

// ── Default configs per language ─────────────────────────────────────────────

const DEFAULT_CONFIGS: Record<string, string[]> = {
  typescript: ['typescript-language-server', '--stdio'],
  javascript: ['typescript-language-server', '--stdio'],
  python: ['pylsp'],
  rust: ['rust-analyzer'],
  go: ['gopls', 'serve'],
};

const MAX_ACTIVE_CONNECTIONS = 8;
const CONNECTION_IDLE_TTL_MS = 10 * 60_000;
const CONNECTION_CLEANUP_INTERVAL_MS = 60_000;

// ── LSP Symbol kinds ─────────────────────────────────────────────────────────

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
  6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
  11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
  15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object',
  20: 'Key', 21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event',
  25: 'Operator', 26: 'TypeParameter',
};

export function getSymbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] || `Unknown(${kind})`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function filePathToUri(filePath: string): string {
  const abs = resolve(filePath);
  return `file://${abs}`;
}

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice(7);
  return uri;
}

export function formatLocation(loc: LspLocation): string {
  const file = uriToFilePath(loc.uri);
  const line = loc.range.start.line + 1;
  const col = loc.range.start.character + 1;
  return `${file}:${line}:${col}`;
}

export function formatSymbol(sym: LspSymbol): string {
  const kind = getSymbolKindName(sym.kind);
  if (sym.location) {
    return `${sym.name} [${kind}] ${formatLocation(sym.location)}`;
  }
  if (sym.range) {
    const line = sym.range.start.line + 1;
    const col = sym.range.start.character + 1;
    return `${sym.name} [${kind}] line ${line}:${col}`;
  }
  return `${sym.name} [${kind}]`;
}

// ── Language detection ───────────────────────────────────────────────────────

export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'py': case 'pyi': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    default: return null;
  }
}

export function getDefaultConfig(language: string): string[] | null {
  return DEFAULT_CONFIGS[language] ?? null;
}

// ── LSP Connection ───────────────────────────────────────────────────────────

export class LspConnection {
  private process: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initialized = false;
  readonly language: string;
  readonly rootUri: string;
  private config: string[];

  constructor(language: string, rootUri: string, config?: string[]) {
    this.language = language;
    this.rootUri = rootUri;
    this.config = config ?? getDefaultConfig(language) ?? [];
  }

  async start(): Promise<void> {
    if (this.config.length === 0) {
      throw new Error(`No LSP server configured for language: ${this.language}`);
    }
    const [cmd, ...args] = this.config;
    this.process = spawn(cmd, args, {
      cwd: this.rootUri,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.stderr!.on('data', () => { /* swallow stderr */ });
    this.process.on('error', (err) => this.onProcessError(err));
    this.process.on('exit', () => this.onProcessExit());

    try {
      await this.initialize();
    } catch (err) {
      // C3: initialize 失败(30s 超时/协议错/server 立即退出)→ 显式 kill 刚 spawn 的进程并释放 stdio fd,
      // 否则 getOrCreateConnection 因 start() reject 不将其入 activeConnections → 孤子进程泄漏。
      const proc = this.process;
      this.process = null;
      this.initialized = false;
      this.killProcess(proc);
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    // 优雅关闭协议(shutdown → exit notification),失败容忍(进程可能已死)。
    try {
      await this.sendRequest('shutdown', null);
      this.sendNotification('exit', null);
    } catch { /* ignore */ }
    this.process = null;
    this.initialized = false;
    // C4: SIGTERM + 2s 后 SIGKILL 兜底 + destroy stdio,确保子进程与 fd 不泄漏。
    this.killProcess(proc);
    this.rejectAllPending(new Error('LSP server stopped'));
  }

  /**
   * 统一的进程终结例程(C3/C4):已死则跳过 kill;先 SIGTERM,2s 后 SIGKILL;无条件 destroy stdio 释放 fd。
   * 幂等——多次调用(stop/onError/onExit 重叠)安全。
   */
  private killProcess(proc: ChildProcess | null): void {
    if (!proc) return;
    const alreadyDead = proc.exitCode !== null || proc.signalCode !== null;
    if (!alreadyDead) {
      try { proc.kill('SIGTERM'); } catch { /* tolerate */ }
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already reaped */ }
      }, 2000);
      killTimer.unref?.();
    }
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
      try { stream?.destroy(); } catch { /* tolerate */ }
    }
  }

  isReady(): boolean {
    return this.initialized && this.process !== null;
  }

  hasPendingRequests(): boolean {
    return this.pendingRequests.size > 0;
  }

  // ── LSP Operations ──────────────────────────────────────────────────────

  async goToDefinition(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    const params = this.makeTextDocumentPositionParams(filePath, line, character);
    const result = await this.sendRequest('textDocument/definition', params);
    return this.normalizeLocations(result);
  }

  async findReferences(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    const params = {
      ...this.makeTextDocumentPositionParams(filePath, line, character),
      context: { includeDeclaration: true },
    };
    const result = await this.sendRequest('textDocument/references', params);
    return this.normalizeLocations(result);
  }

  async hover(filePath: string, line: number, character: number): Promise<LspHoverResult | null> {
    const params = this.makeTextDocumentPositionParams(filePath, line, character);
    const result = await this.sendRequest('textDocument/hover', params) as Record<string, unknown> | null;
    if (!result || !result.contents) return null;
    return { contents: this.extractHoverContents(result.contents) };
  }

  async documentSymbol(filePath: string): Promise<LspSymbol[]> {
    const params = { textDocument: { uri: filePathToUri(filePath) } };
    const result = await this.sendRequest('textDocument/documentSymbol', params);
    return this.normalizeSymbols(result);
  }

  async workspaceSymbol(query: string): Promise<LspSymbol[]> {
    const result = await this.sendRequest('workspace/symbol', { query });
    return this.normalizeSymbols(result);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private makeTextDocumentPositionParams(filePath: string, line: number, character: number) {
    return {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line: line - 1, character: character - 1 }, // convert 1-based to 0-based
    };
  }

  private async initialize(): Promise<void> {
    const initParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
          documentSymbol: { dynamicRegistration: false },
        },
        workspace: { symbol: { dynamicRegistration: false } },
      },
      rootUri: filePathToUri(this.rootUri),
      workspaceFolders: [{ uri: filePathToUri(this.rootUri), name: 'workspace' }],
    };
    await this.sendRequest('initialize', initParams);
    this.sendNotification('initialized', {});
    this.initialized = true;
  }

  private sendNotification(method: string, params: unknown): void {
    const message = { jsonrpc: '2.0', method, params };
    this.writeMessage(message);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request "${method}" timed out after 30s`));
      }, 30_000);
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this.writeMessage(message);
    });
  }

  private writeMessage(msg: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;
      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    try {
      const msg = JSON.parse(body) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result ?? null);
        }
      }
    } catch { /* malformed JSON — ignore */ }
  }

  private onProcessError(err: Error): void {
    this.rejectAllPending(err);
    const proc = this.process;
    this.process = null;
    this.initialized = false;
    // C3: spawn 'error'(如 ENOENT 找不到 server)也要兜底 kill+destroy stdio,不留半成品。
    this.killProcess(proc);
  }

  private onProcessExit(): void {
    this.rejectAllPending(new Error('LSP server process exited'));
    const proc = this.process;
    this.process = null;
    this.initialized = false;
    this.killProcess(proc);
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private normalizeLocations(result: unknown): LspLocation[] {
    if (!result) return [];
    if (Array.isArray(result)) return result as LspLocation[];
    if (typeof result === 'object' && result !== null && 'uri' in result) return [result as LspLocation];
    return [];
  }

  private normalizeSymbols(result: unknown): LspSymbol[] {
    if (!result || !Array.isArray(result)) return [];
    return result as LspSymbol[];
  }

  private extractHoverContents(contents: unknown): string {
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) {
      return contents.map((c) => (typeof c === 'string' ? c : (c as { value?: string }).value ?? '')).join('\n');
    }
    if (typeof contents === 'object' && contents !== null) {
      return (contents as { value?: string }).value ?? JSON.stringify(contents);
    }
    return String(contents);
  }
}

// ── LSP Manager (singleton per workspace) ────────────────────────────────────

interface ManagedLspConnection {
  connection: LspConnection;
  lastUsedAt: number;
}

const activeConnections = new Map<string, ManagedLspConnection>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function connectionKey(language: string, rootUri: string): string {
  return `${language}:${rootUri}`;
}

function scheduleConnectionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void pruneIdleConnections(Date.now()).catch(() => {});
  }, CONNECTION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

function stopConnectionCleanupIfIdle(): void {
  if (activeConnections.size > 0 || !cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

async function stopManagedConnection(key: string, managed: ManagedLspConnection): Promise<void> {
  activeConnections.delete(key);
  await managed.connection.stop().catch(() => {});
  stopConnectionCleanupIfIdle();
}

async function pruneIdleConnections(now: number): Promise<void> {
  const stale: Array<[string, ManagedLspConnection]> = [];
  for (const [key, managed] of activeConnections.entries()) {
    const isIdle = now - managed.lastUsedAt >= CONNECTION_IDLE_TTL_MS;
    if (!managed.connection.isReady() || (isIdle && !managed.connection.hasPendingRequests())) {
      stale.push([key, managed]);
    }
  }

  await Promise.all(stale.map(([key, managed]) => stopManagedConnection(key, managed)));
}

async function evictLeastRecentlyUsedConnection(exemptKey: string): Promise<void> {
  let oldest: [string, ManagedLspConnection] | undefined;

  for (const entry of activeConnections.entries()) {
    const [key, managed] = entry;
    if (key === exemptKey || managed.connection.hasPendingRequests()) continue;
    if (!oldest || managed.lastUsedAt < oldest[1].lastUsedAt) {
      oldest = entry;
    }
  }

  if (oldest) {
    await stopManagedConnection(oldest[0], oldest[1]);
  }
}

async function enforceConnectionLimit(exemptKey: string): Promise<void> {
  while (activeConnections.size >= MAX_ACTIVE_CONNECTIONS) {
    const before = activeConnections.size;
    await evictLeastRecentlyUsedConnection(exemptKey);
    if (activeConnections.size === before) {
      throw new Error(`LSP connection limit reached (${MAX_ACTIVE_CONNECTIONS}); all connections are busy`);
    }
  }
}

export async function getOrCreateConnection(
  language: string,
  rootUri: string,
  config?: string[],
): Promise<LspConnection> {
  const key = connectionKey(language, rootUri);
  const now = Date.now();
  await pruneIdleConnections(now);

  const existing = activeConnections.get(key);
  if (existing?.connection.isReady()) {
    existing.lastUsedAt = now;
    return existing.connection;
  }

  // Clean up stale connection
  if (existing) {
    await stopManagedConnection(key, existing);
  }

  await enforceConnectionLimit(key);

  const conn = new LspConnection(language, rootUri, config);
  await conn.start();
  activeConnections.set(key, { connection: conn, lastUsedAt: Date.now() });
  scheduleConnectionCleanup();
  return conn;
}

export async function stopAllConnections(): Promise<void> {
  const stops = Array.from(activeConnections.values()).map((c) => c.connection.stop().catch(() => {}));
  await Promise.all(stops);
  activeConnections.clear();
  stopConnectionCleanupIfIdle();
}

export function getActiveConnectionCount(): number {
  return activeConnections.size;
}

// C2: 进程级清理——gracefulShutdown/runAllCleanups 时 kill 所有 LSP 子进程,
// 防止 orphan LSP server 泄漏。与 BrowserManager.registerCleanup 同口径;无连接时为 no-op。
registerCleanup(() => stopAllConnections(), 19);
