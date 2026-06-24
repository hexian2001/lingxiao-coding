import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { Workspace } from './Workspace.js';
import type { GraphNode, GraphSnapshot } from './blackboard/types.js';
import type { ContractAllowedScope } from './ContractAllowedScope.js';
import { getContractProvenance, shouldPreferContractNode } from './ContractProvenance.js';

export interface ContractPackEntry {
  surface: string;
  title: string;
  version?: number;
  content: string;
  nodeId?: string;
  createdBy?: string;
  createdAt?: number;
  tags: string[];
  evidenceRefs?: string[];
  path?: string;
  allowedScope?: ContractAllowedScope;
  sha256: string;
  /** 来源:'declared'(人类/LLM 声明,含 architect 产出)/ 'audit'(代码反推生成)。从 GraphNode tag `provenance:*` 派生。 */
  provenance?: string;
}

export interface ContractPack {
  sessionId: string;
  generatedAt: number;
  contractsDir: string;
  entries: ContractPackEntry[];
}

const CONTRACTS_DIRNAME = 'contracts';
const CONTRACT_PACK_FILENAME = 'contract-pack.json';
export const CONTRACT_PACK_MARKER = '[Contract Pack — 系统强约束注入]';
/** system message 全文渲染的契约条数上限（每条受 DEFAULT_MAX_CONTENT_CHARS 截断）。 */
export const DEFAULT_MAX_RENDERED_CONTRACTS = 12;
/** Context Manifest 摘要段渲染的契约条数上限 —— 摘要每条仅一行，可比全文多列几条。 */
export const DEFAULT_MAX_MANIFEST_CONTRACTS = 16;
const DEFAULT_MAX_CONTENT_CHARS = 2_400;
const PROJECT_CONTRACT_PACK_LOCK_DIR = '.contract-pack.lock';
const PROJECT_CONTRACT_PACK_LOCK_TIMEOUT_MS = 5_000;
const PROJECT_CONTRACT_PACK_LOCK_STALE_MS = 30_000;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashContract(input: {
  surface: string;
  title: string;
  version?: number;
  content: string;
  tags: string[];
  allowedScope?: ContractAllowedScope;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      surface: input.surface,
      title: input.title,
      version: input.version ?? null,
      content: input.content,
      tags: [...input.tags].sort(),
      // allowedScope 必须纳入指纹,否则改允许面不换 sha256 → ContractPack 缓存命中旧契约 → worker 拿到过期的写作用域。
      allowedScope: input.allowedScope
        ? {
            allow: [...input.allowedScope.allow].sort(),
            forbid: input.allowedScope.forbid ? [...input.allowedScope.forbid].sort() : null,
            allowCreate: input.allowedScope.allowCreate ?? false,
          }
        : null,
    }))
    .digest('hex');
}

export function sanitizeSurfaceForFilename(surface: string): string {
  const sanitized = surface
    .trim()
    .replace(/^[a-z]+:/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return sanitized || 'contract';
}

export function getContractsDir(sessionId: string, workspace?: string): string {
  return join(Workspace.getSessionArtifactPaths(sessionId, workspace).contextDir, CONTRACTS_DIRNAME);
}

export function getContractPackPath(sessionId: string, workspace?: string): string {
  return join(getContractsDir(sessionId, workspace), CONTRACT_PACK_FILENAME);
}

/**
 * 项目级契约目录:`.lingxiao/contracts/`(workspace 根,跨会话权威)。
 * 与 session-scoped 的 getContractsDir 区别:不绑 sessionId,供 loader 跨会话加载复用。
 */
export function getProjectContractsDir(workspace?: string): string {
  const workspaceRoot = resolve(workspace || process.cwd());
  return join(workspaceRoot, '.lingxiao', CONTRACTS_DIRNAME);
}

/** 项目级 contract-pack.json 路径(跨会话权威)。 */
export function getProjectContractPackPath(workspace?: string): string {
  return join(getProjectContractsDir(workspace), CONTRACT_PACK_FILENAME);
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withProjectContractPackLock<T>(dir: string, fn: () => T): T {
  const lockDir = join(dir, PROJECT_CONTRACT_PACK_LOCK_DIR);
  const deadline = Date.now() + PROJECT_CONTRACT_PACK_LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), `pid=${process.pid}\nacquiredAt=${new Date().toISOString()}\n`, 'utf8');
      acquired = true;
    } catch (err) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > PROJECT_CONTRACT_PACK_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock disappeared between mkdir and stat; retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for project contract-pack lock: ${lockDir}`);
      }
      sleepSync(25);
      if (err instanceof Error && err.message.includes('EACCES')) {
        throw err;
      }
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function getContractSurface(node: Pick<GraphNode, 'tags' | 'title' | 'id'>): string {
  const surfaceTag = node.tags.find(tag => tag.startsWith('contract:'));
  if (surfaceTag) {
    const surface = surfaceTag.slice('contract:'.length).trim();
    if (surface) return surface;
  }
  return node.title.trim() || node.id;
}

export function getContractVersion(node: Pick<GraphNode, 'tags' | 'title' | 'content'>): number | undefined {
  for (const tag of node.tags) {
    const match = tag.match(/^v(?:ersion)?:?(\d+)$/i) || tag.match(/^contract-version:(\d+)$/i);
    if (match) return Number(match[1]);
  }
  const titleMatch = node.title.match(/\bv(?:ersion)?\s*[:=]?\s*(\d+)\b/i);
  if (titleMatch) return Number(titleMatch[1]);
  const contentMatch = node.content.match(/^\s*version\s*[:=]\s*(\d+)\s*$/im);
  if (contentMatch) return Number(contentMatch[1]);
  return undefined;
}

export function graphNodeToContractPackEntry(
  node: GraphNode,
  contractsDir?: string,
  workspace?: string,
): ContractPackEntry {
  const surface = getContractSurface(node);
  const version = getContractVersion(node);
  const evidenceRefs = node.evidence
    ?.map(item => [item.type, item.ref, item.location].filter(Boolean).join(':'))
    .filter(Boolean);
  const tags = Array.from(new Set(node.tags));
  const provenance = getContractProvenance(node.tags) || undefined;
  const fileName = `${sanitizeSurfaceForFilename(surface)}.json`;
  const entryPath = contractsDir ? join(contractsDir, fileName) : undefined;

  // BUG FIX: provenance:template(Leader 薄模板)和 provenance:worker(compliance stub)
  // 都不是完整契约正文。如果磁盘已有同 surface 的完整契约文件（worker 通过 file_create 写入），
  // 用磁盘内容替代,防止 persistContractPack 用模板/stub 覆盖磁盘完整文件。
  let content = node.content;
  if ((provenance === 'template' || provenance === 'worker') && entryPath && existsSync(entryPath)) {
    try {
      const diskEntry = JSON.parse(readFileSync(entryPath, 'utf8')) as unknown;
      if (diskEntry && typeof diskEntry === 'object'
        && typeof (diskEntry as Record<string, unknown>).content === 'string'
        && typeof (diskEntry as Record<string, unknown>).surface === 'string'
        && (diskEntry as Record<string, string>).surface === surface) {
        const diskContent = (diskEntry as Record<string, string>).content;
        if (diskContent.length > 0) {
          content = diskContent;
        }
      }
    } catch { /* 磁盘文件非合法 JSON,用模板内容 */ }
  }

  const sha256 = hashContract({
    surface,
    title: node.title,
    version,
    content,
    tags,
    allowedScope: node.contractAllowedScope,
  });
  return {
    surface,
    title: node.title,
    ...(version !== undefined ? { version } : {}),
    content,
    nodeId: node.id,
    createdBy: node.createdBy,
    createdAt: node.createdAt,
    tags,
    ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    ...(entryPath ? { path: entryPath } : {}),
    ...(node.contractAllowedScope ? { allowedScope: node.contractAllowedScope } : {}),
    sha256,
    ...(provenance ? { provenance } : {}),
  };
}

export function buildContractPackFromSnapshot(
  snapshot: GraphSnapshot,
  input: { sessionId: string; workspace?: string; generatedAt?: number },
): ContractPack {
  const contractsDir = getContractsDir(input.sessionId, input.workspace);
  // ARCH FIX: provenance 权威排序——同 surface 多活节点时,最权威描述胜出;同权威再按 createdAt 取新。
  const latestBySurface = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'contract' || node.supersededBy) continue;
    const surface = getContractSurface(node);
    const existing = latestBySurface.get(surface);
    if (!existing || shouldPreferContractNode(node, existing)) {
      latestBySurface.set(surface, node);
    }
  }
  const entries = [...latestBySurface.values()]
    .sort((a, b) => getContractSurface(a).localeCompare(getContractSurface(b)))
    .map(node => graphNodeToContractPackEntry(node, contractsDir, input.workspace));
  return {
    sessionId: input.sessionId,
    generatedAt: input.generatedAt ?? Date.now(),
    contractsDir,
    entries,
  };
}

export function persistContractPack(pack: ContractPack, workspace?: string): ContractPack {
  mkdirSync(pack.contractsDir, { recursive: true });
  for (const entry of pack.entries) {
    if (!entry.path) continue;
    writeJsonAtomic(entry.path, entry);
  }
  writeJsonAtomic(join(pack.contractsDir, CONTRACT_PACK_FILENAME), pack);
  // 项目级双写(跨会话权威):workspace 给定时,契约同步落到 .lingxiao/contracts/ 供 loader 加载。
  if (workspace) {
    persistProjectContractPack(pack, workspace);
  }
  return pack;
}

/** 把契约包写到项目级 .lingxiao/contracts/(跨会话权威)。每 surface 一文件 + contract-pack.json(不带 sessionId 绑定,纯跨会话数据)。
 *  合并语义:每个 session 的 refreshContractPack 只看当前 session 黑板快照,全量覆写会丢失其他 session 产出的契约。
 *  改为 merge——按 surface@version 去重,新 entry 覆盖同 surface@version 的旧 entry,其余保留。 */
function persistProjectContractPack(pack: ContractPack, workspace: string): void {
  const dir = getProjectContractsDir(workspace);
  mkdirSync(dir, { recursive: true });

  // 项目级契约是跨会话权威投影:读-合并-写必须跨进程串行,否则两个 session 同时刷新会丢更新。
  withProjectContractPackLock(dir, () => {
    // 读取已存在的项目级契约,合并而非覆写
    const packPath = join(dir, CONTRACT_PACK_FILENAME);
    const existingBySurface = new Map<string, ContractPackEntry>();
    if (existsSync(packPath)) {
      try {
        const raw = readFileSync(packPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).entries)) {
          for (const e of (parsed as Record<string, unknown[]>).entries) {
            if (e && typeof e === 'object'
              && typeof (e as Record<string, unknown>).surface === 'string'
              && typeof (e as Record<string, unknown>).content === 'string'
              && typeof (e as Record<string, unknown>).sha256 === 'string') {
              const entry = e as ContractPackEntry;
              const key = entry.version !== undefined ? `${entry.surface}@v${entry.version}` : entry.surface;
              existingBySurface.set(key, entry);
            }
          }
        }
      } catch { /* 容错:损坏则从当前 pack 重建 */ }
    }

    // 新 entry 覆盖同 surface@version 的旧 entry
    for (const entry of pack.entries) {
      const key = entry.version !== undefined ? `${entry.surface}@v${entry.version}` : entry.surface;
      existingBySurface.set(key, entry);
    }

    const mergedEntries = [...existingBySurface.values()].sort((a, b) =>
      a.surface.localeCompare(b.surface) || (a.version ?? 0) - (b.version ?? 0),
    );

    for (const entry of mergedEntries) {
      const fileName = `${sanitizeSurfaceForFilename(entry.surface)}.json`;
      writeJsonAtomic(join(dir, fileName), entry);
    }
    writeJsonAtomic(packPath, { generatedAt: pack.generatedAt, contractsDir: dir, entries: mergedEntries });
  });
}

/**
 * 持久化单个契约条目到项目级 contracts 目录。
 * 用于 Leader 的 write_contract 工具——绕过 BlackboardGraph 直接写契约。
 * 内部走相同的锁和合并逻辑，保证跨会话一致性。
 */
export function persistProjectContractEntry(workspace: string, entry: ContractPackEntry): void {
  const dir = getProjectContractsDir(workspace);
  mkdirSync(dir, { recursive: true });

  withProjectContractPackLock(dir, () => {
    const packPath = join(dir, CONTRACT_PACK_FILENAME);
    const existingBySurface = new Map<string, ContractPackEntry>();

    // 读取已有契约
    if (existsSync(packPath)) {
      try {
        const raw = readFileSync(packPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).entries)) {
          for (const e of (parsed as Record<string, unknown[]>).entries) {
            if (e && typeof e === 'object'
              && typeof (e as Record<string, unknown>).surface === 'string'
              && typeof (e as Record<string, unknown>).content === 'string'
              && typeof (e as Record<string, unknown>).sha256 === 'string') {
              const existing = e as ContractPackEntry;
              const key = existing.version !== undefined ? `${existing.surface}@v${existing.version}` : existing.surface;
              existingBySurface.set(key, existing);
            }
          }
        }
      } catch { /* 容错 */ }
    }

    // 合并新 entry
    const key = entry.version !== undefined ? `${entry.surface}@v${entry.version}` : entry.surface;
    existingBySurface.set(key, entry);

    const mergedEntries = [...existingBySurface.values()].sort((a, b) =>
      a.surface.localeCompare(b.surface) || (a.version ?? 0) - (b.version ?? 0),
    );

    // 写入文件
    for (const e of mergedEntries) {
      const fileName = `${sanitizeSurfaceForFilename(e.surface)}.json`;
      writeJsonAtomic(join(dir, fileName), e);
    }
    writeJsonAtomic(packPath, { generatedAt: Date.now(), contractsDir: dir, entries: mergedEntries });
  });
}

export function buildAndPersistContractPackFromSnapshot(
  snapshot: GraphSnapshot,
  input: { sessionId: string; workspace?: string; generatedAt?: number },
): ContractPack {
  return persistContractPack(buildContractPackFromSnapshot(snapshot, input), input.workspace);
}

export function renderContractPackSystemMessage(
  pack: ContractPack | null | undefined,
  options: { maxContracts?: number; maxContentChars?: number } = {},
): string {
  if (!pack || pack.entries.length === 0) return '';
  const maxContracts = options.maxContracts ?? DEFAULT_MAX_RENDERED_CONTRACTS;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const shown = pack.entries.slice(0, maxContracts);
  const lines: string[] = [
    CONTRACT_PACK_MARKER,
    `session=${pack.sessionId}`,
    `contracts_dir=${pack.contractsDir}`,
    `contract_pack=${join(pack.contractsDir, CONTRACT_PACK_FILENAME)}`,
    `active_contracts=${pack.entries.length}`,
    '',
    '这些契约是当前跨 Agent 实现的单一事实源。实现、验证、前后端字段、事件流和验收口径必须优先遵守；发现冲突时先升级契约或请求 Leader 决策，不要自行脑补字段。',
  ];
  for (const entry of shown) {
    const content = entry.content.length > maxContentChars
      ? `${entry.content.slice(0, maxContentChars)}\n...(truncated ${entry.content.length - maxContentChars} chars; read ${entry.path ?? 'contract file'} for full contract)`
      : entry.content;
    lines.push(
      '',
      `## ${entry.surface}${entry.version !== undefined ? ` @v${entry.version}` : ''}`,
      `title=${entry.title}`,
      `node=${entry.nodeId ?? '(none)'}`,
      `sha256=${entry.sha256}`,
      `path=${entry.path ?? '(not persisted)'}`,
      `tags=${entry.tags.join(', ') || '(none)'}`,
      ...(entry.allowedScope
        ? [`allowed_scope=allow: ${entry.allowedScope.allow.join(', ') || '(empty)'} | forbid: ${(entry.allowedScope.forbid ?? []).join(', ') || '(none)'} | allow_create: ${entry.allowedScope.allowCreate ?? false}`]
        : []),
      ...(entry.evidenceRefs && entry.evidenceRefs.length > 0
        ? [`evidence=${entry.evidenceRefs.join(', ')}`]
        : []),
      '',
      content,
    );
  }
  if (pack.entries.length > shown.length) {
    lines.push('', `... ${pack.entries.length - shown.length} more contracts omitted; read ${join(pack.contractsDir, CONTRACT_PACK_FILENAME)} for full list.`);
  }
  return lines.join('\n');
}

export function contractPackFingerprint(pack: ContractPack | null | undefined): string | null {
  if (!pack || pack.entries.length === 0) return null;
  return createHash('sha256')
    .update(stableJson({
      sessionId: pack.sessionId,
      entries: pack.entries.map(entry => ({
        surface: entry.surface,
        version: entry.version ?? null,
        sha256: entry.sha256,
        path: entry.path ?? null,
      })),
    }))
    .digest('hex');
}

export function hasContractPackFiles(sessionId: string, workspace?: string): boolean {
  return existsSync(getContractPackPath(sessionId, workspace));
}

export function renderContractPackManifestSection(pack: ContractPack | null | undefined): string {
  if (!pack || pack.entries.length === 0) return '';
  const shown = pack.entries.slice(0, DEFAULT_MAX_MANIFEST_CONTRACTS);
  const lines = [
    `contracts_dir=${pack.contractsDir}`,
    `contract_pack=${join(pack.contractsDir, CONTRACT_PACK_FILENAME)}`,
    `active_contracts=${pack.entries.length}`,
    ...shown.map(entry => [
      `- ${entry.surface}${entry.version !== undefined ? ` @v${entry.version}` : ''}`,
      `sha256=${entry.sha256.slice(0, 16)}`,
      `path=${entry.path ?? '(not persisted)'}`,
      `title=${compactWhitespace(entry.title)}`,
      ...(entry.evidenceRefs && entry.evidenceRefs.length > 0
        ? [`evidence=${entry.evidenceRefs.map(compactWhitespace).join(', ')}`]
        : []),
    ].join(' | ')),
  ];
  if (pack.entries.length > shown.length) {
    lines.push(`... ${pack.entries.length - shown.length} more contracts omitted; read ${join(pack.contractsDir, CONTRACT_PACK_FILENAME)} for full list.`);
  }
  return lines.join('\n');
}
