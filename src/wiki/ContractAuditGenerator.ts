/**
 * ContractAuditGenerator — 契约 audit 生成器(代码反推缺失契约)。
 *
 * 复用 wiki 脚手架(WikiFileScanner 扫代码 + LlmGuard 重试),内核从"写代码文档"换成
 * "从代码结构反推契约 surface 清单 + 每项结构化契约"。产出带 `provenance:audit` 标记,
 * 落项目级 `.lingxiao/contracts/`(跨会话复用,loader 下次会话加载)。
 *
 * 权威链(命门):已存在 surface(declared 或既有 audit)→ **跳过,不 supersede**(避免覆盖声明)。
 * 只 seed 项目级尚不存在的 surface。审计生成永远不破坏人类/LLM 已声明契约。
 *
 * 零启发式:scan 是确定性文件遍历;契约 surface 由 LLM 从真实代码反推(LLM 不臆造,
 * prompt 要求"只产出代码里真实存在的 surface");权威链是纯集合运算。
 */
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ChatMessage } from '../llm/types.js';
import { createLlmGuard } from '../agents/LlmGuard.js';
import { classifyLLMError } from '../llm/errors.js';
import { WikiFileScanner } from './WikiFileScanner.js';
import {
  graphNodeToContractPackEntry,
  getProjectContractsDir,
  persistContractPack,
  type ContractPackEntry,
  type ContractPack,
} from '../core/ContractPack.js';
import { loadProjectContractEntries, clearProjectContractsCache } from '../core/ProjectContracts.js';
import type { GraphNode, EvidenceItem } from '../core/blackboard/types.js';
import type { ContractAllowedScope } from '../core/ContractAllowedScope.js';

/** LLM 反推的原始契约草稿(解析自 LLM JSON)。 */
export interface RawDraft {
  surface: string;
  title: string;
  content: string;
  allowedScope?: ContractAllowedScope;
  evidence?: string[];
}

export interface ContractAuditProgress {
  phase: string;
  progress: number;
  detail?: string;
}

export interface ContractAuditResult {
  scannedFiles: number;
  /** 新生成(seed)的契约(surface 此前项目级不存在)。 */
  generated: ContractPackEntry[];
  /** 已存在 surface 跳过(权威链:不覆盖声明)。 */
  skipped: Array<{ surface: string; reason: string }>;
  durationMs: number;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')))
      .join('');
  }
  if (content && typeof content === 'object' && 'text' in content) return String((content as { text: unknown }).text);
  return String(content ?? '');
}

function isRawDraft(raw: unknown): raw is RawDraft {
  if (!raw || typeof raw !== 'object') return false;
  const d = raw as Record<string, unknown>;
  return typeof d.surface === 'string' && d.surface.trim() !== '' && typeof d.content === 'string';
}

export function parseContractDrafts(text: string): RawDraft[] {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!obj || typeof obj !== 'object') return [];
    const contracts = (obj as Record<string, unknown>).contracts;
    if (!Array.isArray(contracts)) return [];
    return contracts.filter(isRawDraft);
  } catch {
    return [];
  }
}

function draftToEntry(draft: RawDraft, contractsDir: string): ContractPackEntry {
  const evidence: EvidenceItem[] = (draft.evidence ?? []).map((s) => {
    const idx = s.lastIndexOf(':');
    if (idx > 0 && /^(\d+|[\w./-]+)$/.test(s.slice(idx + 1))) {
      return { type: 'file', ref: s.slice(0, idx), location: s.slice(idx + 1) };
    }
    return { type: 'file', ref: s };
  });
  const node: GraphNode = {
    id: `audit-${draft.surface}`,
    kind: 'contract',
    sessionId: 'audit',
    title: draft.title?.trim() || draft.surface,
    content: draft.content,
    tags: [`contract:${draft.surface}`, 'provenance:audit'],
    createdBy: 'contract-audit-generator',
    createdAt: Date.now(),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(draft.allowedScope ? { contractAllowedScope: draft.allowedScope } : {}),
  };
  return graphNodeToContractPackEntry(node, contractsDir);
}

export class ContractAuditGenerator {
  private scanner = new WikiFileScanner();

  constructor(
    private readonly projectPath: string,
    private readonly llm: ContentGenerator,
    private readonly model: string,
  ) {}

  async auditGenerate(
    onProgress?: (p: ContractAuditProgress) => void,
    signal?: AbortSignal,
  ): Promise<ContractAuditResult> {
    const start = Date.now();

    onProgress?.({ phase: 'scanning', progress: 0.1, detail: '扫描项目文件...' });
    const scan = await this.scanner.scan(this.projectPath);
    const keyFilesContent = this.scanner.readKeyFiles(this.projectPath, scan.keyFiles);

    onProgress?.({ phase: 'analyzing', progress: 0.4, detail: '反推契约 surface...' });
    const drafts = await this.generateContractDrafts(scan.directoryTree, scan.languages, keyFilesContent, signal);

    // 权威链守卫:已存在 surface(declared/audit)跳过,绝不 supersede 声明。
    const existing = loadProjectContractEntries(this.projectPath);
    const existingSurfaces = new Set(existing.map((e) => e.surface));
    const contractsDir = getProjectContractsDir(this.projectPath);
    const generated: ContractPackEntry[] = [];
    const skipped: Array<{ surface: string; reason: string }> = [];
    for (const draft of drafts) {
      const surface = draft.surface.trim();
      if (existingSurfaces.has(surface)) {
        skipped.push({ surface, reason: '项目级已存在该 surface 契约(声明/审计),不覆盖(权威链)' });
        continue;
      }
      generated.push(draftToEntry({ ...draft, surface }, contractsDir));
      existingSurfaces.add(surface); // 防同批重复 surface
    }

    if (generated.length > 0) {
      clearProjectContractsCache();
      const allEntries = [...existing, ...generated];
      const pack: ContractPack = {
        sessionId: 'audit',
        generatedAt: Date.now(),
        contractsDir,
        entries: allEntries,
      };
      persistContractPack(pack, this.projectPath); // 项目级双写(含 generated)
    }

    onProgress?.({ phase: 'done', progress: 1, detail: `生成 ${generated.length} / 跳过 ${skipped.length}` });
    return { scannedFiles: scan.totalFiles, generated, skipped, durationMs: Date.now() - start };
  }

  private async generateContractDrafts(
    directoryTree: string,
    languages: Record<string, number>,
    keyFilesContent: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<RawDraft[]> {
    const systemPrompt = `你是契约架构师。从项目代码结构反推"实现契约"——跨模块共享的接口、数据模型、事件流、配置 surface。
对每个 surface 产出结构化契约。只产出代码里真实存在的 surface,不要臆造。
输出严格 JSON(不要 markdown 围栏、不要解释文字):
{"contracts":[{"surface":"<kebab-case-id>","title":"<中文名>","content":"<契约正文:字段/接口签名/事件/约束,结构化文本>","allowedScope":{"allow":["<相对 workspace 的可写目录前缀>"],"forbid":["<禁止目录>"],"allowCreate":false},"evidence":["<path:line>"]}]}
allowedScope.allow 用相对 workspace 的目录前缀(如 src/auth);forbid 留空数组若无;evidence 给关键 file:line。聚焦核心 surface,通常 5-15 个,不要逐文件罗列。`;

    const keyFilesStr = Object.entries(keyFilesContent)
      .map(([p, c]) => `### ${p}\n${c.length > 800 ? `${c.slice(0, 800)}…` : c}`)
      .join('\n\n');
    const langStr = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, n]) => `${ext}:${n}`)
      .join(', ');

    const userPrompt = `项目目录结构:\n${directoryTree}\n\n语言分布: ${langStr}\n\n关键入口/配置文件:\n${keyFilesStr}\n\n反推实现契约清单(严格 JSON)。`;

    const guard = createLlmGuard({ actorLabel: 'ContractAudit', classifyError: classifyLLMError });
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const response = await guard.call(
      this.llm,
      messages,
      this.model,
      undefined,
      false, // 非流式:一次性解析 JSON
      signal,
      undefined,
      {
        actorType: 'system',
        actorLabel: 'ContractAudit',
        purpose: 'wiki',
        requestedModel: this.model,
      },
    );
    return parseContractDrafts(extractText(response.content));
  }

  /** 扫描代码 + LLM 反推契约 surface 清单(不落库,供漂移校验对比实现 vs 声明)。 */
  async getCodeSurfaces(signal?: AbortSignal): Promise<string[]> {
    const scan = await this.scanner.scan(this.projectPath);
    const keyFilesContent = this.scanner.readKeyFiles(this.projectPath, scan.keyFiles);
    const drafts = await this.generateContractDrafts(scan.directoryTree, scan.languages, keyFilesContent, signal);
    return drafts.map((d) => d.surface.trim()).filter(Boolean);
  }
}
