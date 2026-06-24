/**
 * ProjectContracts — 项目级契约 loader(跨会话复用)。
 *
 * 契约真相源是黑板 contract 节点;ContractPack 是投影。本模块从项目级
 * `.lingxiao/contracts/contract-pack.json` 加载契约 entries,让凌霄生成的契约
 * 跨会话复用:新会话启动时 `LeaderBlackboard.seedProjectContracts` 调本模块 load
 * → 灌入黑板 contract 节点(`provenance:declared`)→ `refreshContractPack` 自动包含。
 *
 * 路径权威在 `ContractPack.ts`(`getProjectContractsDir`/`getProjectContractPackPath`);
 * 本模块单向 import,只做 load(读),避免循环依赖。persist(写项目级)在 ContractPack.ts。
 *
 * 范式复刻 `CustomCommandLoader`:确定性文件读取 + stat-mtime 5s TTL 缓存 +
 * 容错(缺失/损坏返回 [],契约缺失时退化为"从零建",不阻断启动)。
 *
 * 改契约走正规流程(leader 派 architect / 改源码);人类不直接编辑本目录文件。
 */
import { existsSync, readFileSync, statSync } from 'fs';
import {
  getProjectContractPackPath,
  type ContractPackEntry,
} from './ContractPack.js';

const PROJECT_CACHE_TTL_MS = Number(process.env.LINGXIAO_PROJECT_CONTRACT_CACHE_TTL_MS || 5_000);

const projectContractsCache = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; createdAt: number; entries: ContractPackEntry[] }>();

function isValidEntry(raw: unknown): raw is ContractPackEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return typeof e.surface === 'string' && e.surface.trim() !== ''
    && typeof e.content === 'string'
    && typeof e.sha256 === 'string';
}

/**
 * 从项目级 `.lingxiao/contracts/contract-pack.json` 加载契约 entries(跨会话复用)。
 * 文件签名(mtime/ctime/size) + 5s TTL 缓存:文件未变且未过期则复用。容错:缺失/损坏/格式错返回 []。
 */
export function loadProjectContractEntries(workspace?: string): ContractPackEntry[] {
  const path = getProjectContractPackPath(workspace);
  if (!existsSync(path)) return [];
  let signature: { mtimeMs: number; ctimeMs: number; size: number };
  try {
    const stat = statSync(path);
    signature = { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
  } catch {
    projectContractsCache.delete(path);
    return [];
  }
  const cached = projectContractsCache.get(path);
  const now = Date.now();
  if (cached
    && cached.mtimeMs === signature.mtimeMs
    && cached.ctimeMs === signature.ctimeMs
    && cached.size === signature.size
    && now - cached.createdAt < PROJECT_CACHE_TTL_MS) {
    return cached.entries;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const entriesRaw = (parsed as Record<string, unknown>).entries;
    if (!Array.isArray(entriesRaw)) return [];
    const entries = entriesRaw.filter(isValidEntry);
    projectContractsCache.set(path, { ...signature, createdAt: now, entries });
    return entries;
  } catch {
    return [];
  }
}

/** 清除项目级契约缓存(测试 / 强制刷新用)。 */
export function clearProjectContractsCache(): void {
  projectContractsCache.clear();
}

/**
 * 持久化单个契约到项目级 contracts 目录。
 * 用于 Leader 的 write_contract 工具——直接写契约而不经过 BlackboardGraph。
 * 内部走 ContractPack 的合并逻辑，保证跨会话一致性。
 */
export async function persistContractToProjectDir(
  workspace: string,
  contract: {
    surface: string;
    title: string;
    content: string;
    version?: number;
    createdBy?: string;
    createdAt?: string;
  },
): Promise<void> {
  const { persistProjectContractEntry } = await import('./ContractPack.js');
  const { createHash } = await import('crypto');

  const entry: ContractPackEntry = {
    surface: contract.surface,
    title: contract.title,
    content: contract.content,
    sha256: createHash('sha256').update(contract.content).digest('hex'),
    version: contract.version ?? 1,
    createdBy: contract.createdBy ?? 'leader',
    createdAt: contract.createdAt ? new Date(contract.createdAt).getTime() : Date.now(),
    tags: [],
  };

  persistProjectContractEntry(workspace, entry);
  // 清除缓存让下次 load 立即看到新契约
  projectContractsCache.delete(getProjectContractPackPath(workspace));
}
