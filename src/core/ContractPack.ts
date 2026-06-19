import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { Workspace } from './Workspace.js';
import type { GraphNode, GraphSnapshot } from './blackboard/types.js';
import type { ContractAllowedScope } from './ContractAllowedScope.js';

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

function sanitizeSurfaceForFilename(surface: string): string {
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
): ContractPackEntry {
  const surface = getContractSurface(node);
  const version = getContractVersion(node);
  const evidenceRefs = node.evidence
    ?.map(item => [item.type, item.ref, item.location].filter(Boolean).join(':'))
    .filter(Boolean);
  const tags = Array.from(new Set(node.tags));
  const sha256 = hashContract({
    surface,
    title: node.title,
    version,
    content: node.content,
    tags,
    allowedScope: node.contractAllowedScope,
  });
  const provenance = node.tags.find((t) => t.startsWith('provenance:'))?.slice('provenance:'.length).trim() || undefined;
  const fileName = `${sanitizeSurfaceForFilename(surface)}.json`;
  return {
    surface,
    title: node.title,
    ...(version !== undefined ? { version } : {}),
    content: node.content,
    nodeId: node.id,
    createdBy: node.createdBy,
    createdAt: node.createdAt,
    tags,
    ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    ...(contractsDir ? { path: join(contractsDir, fileName) } : {}),
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
  const latestBySurface = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'contract' || node.supersededBy) continue;
    const surface = getContractSurface(node);
    const existing = latestBySurface.get(surface);
    if (!existing || node.createdAt > existing.createdAt) {
      latestBySurface.set(surface, node);
    }
  }
  const entries = [...latestBySurface.values()]
    .sort((a, b) => getContractSurface(a).localeCompare(getContractSurface(b)))
    .map(node => graphNodeToContractPackEntry(node, contractsDir));
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
    writeFileSync(entry.path, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  }
  writeFileSync(join(pack.contractsDir, CONTRACT_PACK_FILENAME), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
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
    writeFileSync(join(dir, fileName), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  }
  writeFileSync(packPath, `${JSON.stringify({ generatedAt: pack.generatedAt, contractsDir: dir, entries: mergedEntries }, null, 2)}\n`, 'utf8');
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
