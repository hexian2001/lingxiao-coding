/**
 * WikiGenerator — LLM 驱动的文档生成引擎
 *
 * 4-Pass 流程:
 *   1. Scan — 扫描项目文件树
 *   2. Outline — LLM 分析结构，产出 Wiki 大纲
 *   3. Generate — 对每个 section 用 LLM 生成 Markdown 文档
 *   4. Meta — 写 meta.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ChatMessage } from '../llm/types.js';
import { createLlmGuard } from '../agents/LlmGuard.js';
import { classifyLLMError } from '../llm/errors.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import { createWikiAgent } from './WikiAgentFactory.js';
import { WikiFileScanner } from './WikiFileScanner.js';
import { ChangeDetector } from './ChangeDetector.js';
import {
  type WikiLanguage,
  type WikiOutline,
  type WikiOutlineSection,
  type WikiMeta,
  type WikiMetaSection,
  type WikiCheckpoint,
  type WikiGenerationResult,
  type WikiGenerationPhase,
  type WikiProgressCallback,
  type WikiStreamCallback,
  type ProjectScanResult,
  WIKI_DIR_NAME,
  WIKI_GENERATION_CONCURRENCY,
  WIKI_GENERATION_TIMEOUT_MS,
  WIKI_INCREMENTAL_THRESHOLD,
} from './types.js';

class WikiTimeoutError extends Error {
  constructor(ms: number) {
    super(`Wiki generation timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'WikiTimeoutError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason || 'Wiki generation aborted'));
  }
}

async function withWikiTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new WikiTimeoutError(ms));
  }, ms);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

type UnknownRecord = Record<string, unknown>;

interface TextContentPartLike {
  type: 'text';
  text?: unknown;
}

interface AgentTrackerHolder {
  tracker?: {
    getTotal?: () => unknown;
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTextContentPartLike(value: unknown): value is TextContentPartLike {
  return isRecord(value) && value.type === 'text';
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function getAgentTokenTotal(agent: unknown): number {
  if (!isRecord(agent)) return 0;
  const tracker = (agent as AgentTrackerHolder).tracker;
  const total = tracker?.getTotal?.();
  return typeof total === 'number' ? total : 0;
}

function hasOutlineSections(value: unknown): value is { sections: WikiOutlineSection[] } {
  return isRecord(value) && Array.isArray(value.sections);
}

export class WikiGenerator {
  private scanner = new WikiFileScanner();
  private detector = new ChangeDetector();
  private onStreamChunk?: WikiStreamCallback;

  constructor(
    private projectPath: string,
    private llm: ContentGenerator,
    private model: string,
    private emitter: EventEmitter,
    private db: DatabaseManager,
  ) {}

  /**
   * 全量生成 Wiki
   */
  async generate(
    lang: WikiLanguage,
    onProgress?: WikiProgressCallback,
    onStream?: WikiStreamCallback,
  ): Promise<WikiGenerationResult> {
    const startTime = Date.now();
    let tokensUsed = 0;

    this.onStreamChunk = onStream;

    try {
      // Pass 1: Scan
      onProgress?.('scanning', 0.1, lang === 'zh' ? '扫描项目文件...' : 'Scanning project files...');
      const scanResult = await this.scanner.scan(this.projectPath);
      onProgress?.('scanning', 0.2, `${scanResult.totalFiles} files`);

      // Pass 2: Outline
      onProgress?.('analyzing', 0.3, lang === 'zh' ? '分析项目结构...' : 'Analyzing project structure...');
      const outline = await withWikiTimeout(
        WIKI_GENERATION_TIMEOUT_MS,
        (signal) => this.generateOutline(scanResult, lang, signal),
      );
      onProgress?.('analyzing', 0.4, `${outline.sections.length} sections`);

      // Pass 3: Generate documents
      const totalSections = outline.sections.length;
      let completed = 0;
      const metaSections: WikiMetaSection[] = [];

      // 断点续传：加载上次 checkpoint
      const outlineHash = hashOutline(outline);
      const checkpoint = loadCheckpoint(this.projectPath, lang);
      if (checkpoint && checkpoint.outlineHash === outlineHash && checkpoint.sections.length > 0) {
        // 恢复已完成的 sections
        metaSections.push(...checkpoint.sections);
        completed = checkpoint.sections.length;
        const resumeMsg = lang === 'zh'
          ? `断点恢复：已跳过 ${completed}/${totalSections} 个文档`
          : `Resuming: skipping ${completed}/${totalSections} completed docs`;
        onProgress?.('generating', 0.4 + (completed / totalSections) * 0.5, resumeMsg);
      } else if (checkpoint) {
        // outline 变了，废弃旧 checkpoint
        removeCheckpoint(this.projectPath, lang);
      }
      const completedIds = new Set(metaSections.map(s => s.id));
      const pendingSections = outline.sections.filter(s => !completedIds.has(s.id));

      // 并发控制
      const semaphore = new Semaphore(WIKI_GENERATION_CONCURRENCY);
      const tasks = pendingSections.map((section) => async (signal: AbortSignal) => {
        throwIfAborted(signal);
        await semaphore.acquire();
        try {
          throwIfAborted(signal);
          onProgress?.(
            'generating',
            0.4 + (completed / totalSections) * 0.5,
            `${section.title} (${completed + 1}/${totalSections})`,
          );
          const { content, tokens } = await this.generateDocument(section, scanResult, lang, signal);
          tokensUsed += tokens;
          completed++;

          // 写入文件
          const docDir = path.join(
            this.projectPath,
            '.lingxiao',
            WIKI_DIR_NAME,
            lang,
            path.dirname(section.documentPath),
          );
          fs.mkdirSync(docDir, { recursive: true });
          const docPath = path.join(
            this.projectPath,
            '.lingxiao',
            WIKI_DIR_NAME,
            lang,
            section.documentPath,
          );
          fs.writeFileSync(docPath, content, 'utf-8');

          // 收集 meta section
          const newSection: WikiMetaSection = {
            id: section.id,
            title: section.title,
            documentPath: section.documentPath,
            sourceFiles: section.sourceFiles,
            hash: this.detector.hashContent(content),
          };
          metaSections.push(newSection);

          // 立刻保存 checkpoint（原子写）
          saveCheckpoint(this.projectPath, lang, { outlineHash, sections: [...metaSections] });
        } finally {
          semaphore.release();
        }
      });

      // 带取消语义的并发执行：超时会中止未完成的 LLM 调用，而不是只 reject 外层 Promise
      await withWikiTimeout(WIKI_GENERATION_TIMEOUT_MS, async (signal) => {
        await Promise.all(tasks.map(t => t(signal)));
      });

      // Pass 4: Meta
      onProgress?.('finalizing', 0.95, lang === 'zh' ? '写入元数据...' : 'Writing metadata...');
      const fileHashes = await this.detector.hashProject(this.projectPath);
      const meta: WikiMeta = {
        version: 1,
        generatedAt: Math.floor(Date.now() / 1000),
        lang,
        totalFiles: scanResult.totalFiles,
        sections: metaSections,
        fileHashes: Object.fromEntries(fileHashes),
      };
      this.detector.saveMeta(this.projectPath, lang, meta);
      // 全部完成，删除 checkpoint
      removeCheckpoint(this.projectPath, lang);

      onProgress?.('finalizing', 1.0, lang === 'zh' ? '完成' : 'Done');

      return {
        success: true,
        documentsGenerated: metaSections.length,
        documentsUpdated: 0,
        tokensUsed,
        duration: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        success: false,
        documentsGenerated: 0,
        documentsUpdated: 0,
        tokensUsed,
        duration: Date.now() - startTime,
        error: unknownErrorMessage(err),
      };
    }
  }

  /**
   * 增量更新：仅重新生成受影响的 sections
   */
  async incrementalUpdate(
    lang: WikiLanguage,
    changedFiles: string[],
    onProgress?: WikiProgressCallback,
    onStream?: WikiStreamCallback,
  ): Promise<WikiGenerationResult> {
    const startTime = Date.now();
    let tokensUsed = 0;

    this.onStreamChunk = onStream;

    try {
      const meta = this.detector.loadMeta(this.projectPath, lang);
      if (!meta) {
        // 没有 meta，全量生成
        return this.generate(lang, onProgress);
      }

      // 映射变更文件到受影响 sections
      const affectedSectionIds = new Set<string>();
      for (const section of meta.sections) {
        if (section.sourceFiles.some(sf => changedFiles.includes(sf))) {
          affectedSectionIds.add(section.id);
        }
      }
      // 新增文件影响 overview 和 architecture
      affectedSectionIds.add('overview');
      affectedSectionIds.add('architecture');

      // 阈值检查：受影响过多则全量重新生成
      const ratio = affectedSectionIds.size / meta.sections.length;
      if (ratio > WIKI_INCREMENTAL_THRESHOLD) {
        onProgress?.('analyzing', 0.2, lang === 'zh' ? '变更过多，转为全量生成...' : 'Too many changes, switching to full generation...');
        return this.generate(lang, onProgress);
      }

      // 重新扫描以获取最新文件信息
      onProgress?.('scanning', 0.1, lang === 'zh' ? '重新扫描...' : 'Re-scanning...');
      const scanResult = await this.scanner.scan(this.projectPath);

      // 仅重新生成受影响 sections
      const sectionsToRegen = meta.sections.filter(s => affectedSectionIds.has(s.id));
      let completed = 0;
      const totalSections = sectionsToRegen.length;
      const updatedMetaSections: WikiMetaSection[] = [...meta.sections];

      // 增量断点续传
      const incrOutlineHash = 'incr_' + sectionsToRegen.map(s => s.id).join('|');
      const incrCheckpoint = loadCheckpoint(this.projectPath, lang);
      const incrDone = new Set(
        incrCheckpoint?.outlineHash === incrOutlineHash
          ? incrCheckpoint.sections.map(s => s.id)
          : []
      );
      if (incrDone.size > 0) {
        // 把已完成的更新合并到 updatedMetaSections
        for (const doneSection of incrCheckpoint!.sections) {
          const idx = updatedMetaSections.findIndex(s => s.id === doneSection.id);
          if (idx >= 0) updatedMetaSections[idx] = doneSection;
        }
        completed = incrDone.size;
      } else if (incrCheckpoint) {
        removeCheckpoint(this.projectPath, lang);
      }
      const pendingRegen = sectionsToRegen.filter(s => !incrDone.has(s.id));

      const semaphore = new Semaphore(WIKI_GENERATION_CONCURRENCY);
      const tasks = pendingRegen.map((section) => async (signal: AbortSignal) => {
        throwIfAborted(signal);
        await semaphore.acquire();
        try {
          throwIfAborted(signal);
          onProgress?.(
            'generating',
            0.3 + (completed / totalSections) * 0.6,
            `${section.title} (${completed + 1}/${totalSections})`,
          );

          const outlineSection: WikiOutlineSection = {
            id: section.id,
            title: section.title,
            documentPath: section.documentPath,
            sourceFiles: section.sourceFiles,
            description: section.title,
          };

          const { content, tokens } = await this.generateDocument(outlineSection, scanResult, lang, signal);
          tokensUsed += tokens;
          completed++;

          // 写入文件
          const docPath = path.join(
            this.projectPath,
            '.lingxiao',
            WIKI_DIR_NAME,
            lang,
            section.documentPath,
          );
          fs.mkdirSync(path.dirname(docPath), { recursive: true });
          fs.writeFileSync(docPath, content, 'utf-8');

          // 更新 meta section 并保存 checkpoint
          const updatedSection: WikiMetaSection = {
            ...section,
            hash: this.detector.hashContent(content),
          };
          const idx = updatedMetaSections.findIndex(s => s.id === section.id);
          if (idx >= 0) updatedMetaSections[idx] = updatedSection;

          // 收集已完成的增量 sections 并写 checkpoint
          const incrCompleted = incrCheckpoint?.outlineHash === incrOutlineHash
            ? [...(incrCheckpoint.sections.filter(s => s.id !== section.id)), updatedSection]
            : [updatedSection];
          saveCheckpoint(this.projectPath, lang, { outlineHash: incrOutlineHash, sections: incrCompleted });
        } finally {
          semaphore.release();
        }
      });

      await withWikiTimeout(WIKI_GENERATION_TIMEOUT_MS, async (signal) => {
        await Promise.all(tasks.map(t => t(signal)));
      });

      // 更新 meta
      onProgress?.('finalizing', 0.95, lang === 'zh' ? '更新元数据...' : 'Updating metadata...');
      const fileHashes = await this.detector.hashProject(this.projectPath);
      const newMeta: WikiMeta = {
        ...meta,
        generatedAt: Math.floor(Date.now() / 1000),
        totalFiles: scanResult.totalFiles,
        sections: updatedMetaSections,
        fileHashes: Object.fromEntries(fileHashes),
      };
      this.detector.saveMeta(this.projectPath, lang, newMeta);
      // 增量更新完成，清理 checkpoint
      removeCheckpoint(this.projectPath, lang);

      onProgress?.('finalizing', 1.0, lang === 'zh' ? '完成' : 'Done');

      return {
        success: true,
        documentsGenerated: 0,
        documentsUpdated: completed,
        tokensUsed,
        duration: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        success: false,
        documentsGenerated: 0,
        documentsUpdated: 0,
        tokensUsed,
        duration: Date.now() - startTime,
        error: unknownErrorMessage(err),
      };
    }
  }

  // ─── Private: Outline Generation ──────────────────

  private async generateOutline(
    scanResult: ProjectScanResult,
    lang: WikiLanguage,
    signal: AbortSignal,
  ): Promise<WikiOutline> {
    const langDir = lang === 'zh' ? '中文' : 'English';
    const keyFilesContent = this.scanner.readKeyFiles(
      scanResult.rootPath,
      scanResult.keyFiles.slice(0, 20), // 限制入口文件数量
    );

    // 格式化入口文件内容
    const keyFilesStr = Object.entries(keyFilesContent)
      .map(([fp, content]) => `--- ${fp} ---\n${content.slice(0, 3000)}`)
      .join('\n\n');

    const langDistribution = Object.entries(scanResult.languages)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(', ');

    const systemPrompt = `You are a senior technical documentation architect. Analyze the project structure and create a comprehensive documentation outline.
Output language: ${langDir}.
Output MUST be valid JSON with this exact schema:
{
  "sections": [
    {
      "id": "string (lowercase, no spaces, e.g. 'overview')",
      "title": "string (section title in ${langDir})",
      "documentPath": "string (e.g. 'overview.md' or 'modules/core.md')",
      "sourceFiles": ["string (relative path to source files this section covers)"],
      "description": "string (detailed description of what this section should cover, including key topics and diagram suggestions)"
    }
  ]
}

Standard sections to include:
1. "quick-start" - quick-start.md - Quick start guide: installation, initialization, first run
2. "overview" - overview.md - Project overview, purpose, tech stack, key features
3. "architecture" - architecture.md - High-level architecture, component diagram, data flow
4. "api" - api.md - API endpoints, public interfaces (if applicable)
5. "configuration" - configuration.md - Configuration options and environment variables
6. "development" - development.md - Setup, build, test instructions

Then add one section per major module/directory under "modules/" path.
Each module section documentPath should be like "modules/xxx.md".

In the description field, be specific about:
- What mermaid diagrams to include (e.g. "Include a graph TB showing module dependencies" or "Include a sequenceDiagram showing the request flow")
- Key concepts to explain
- Important code snippets to highlight

Focus sections on product, architecture, APIs, configuration, development workflow, and major source modules.
Keep total sections between 5-15.`;

    const userPrompt = `Project root: ${scanResult.rootPath}
Total files: ${scanResult.totalFiles}
Languages: ${langDistribution}

Directory tree:
${scanResult.directoryTree}

Key files:
${keyFilesStr}

Create a documentation outline for this project.`;

    // 2026-05-29：generator 层非流式重试已收口到 LlmGuard。outline 是整个 wiki 构建的
    // JSON 解析门，无 try/catch fallback，必须自带重试保护——否则一次瞬时 429/断连
    // 会让整个多 pass wiki 生成直接失败。用 LlmGuard 包一层（非流式 + 5 次预算 + recycle）。
    const guard = createLlmGuard({ actorLabel: 'WikiOutline', classifyError: classifyLLMError });
    const response = await guard.call(
      this.llm,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      this.model,
      undefined,
      false, // 非流式：outline 一次性解析 JSON，不需要流式
      signal,
      undefined,
      {
        actorType: 'system',
        actorLabel: 'WikiOutline',
        purpose: 'wiki',
        requestedModel: this.model,
      },
    );

    const text = this.extractText(response.content);
    return this.parseOutlineResponse(text);
  }

  // ─── Private: Document Generation (Agent-based) ──────────

  private async generateDocument(
    section: WikiOutlineSection,
    scanResult: ProjectScanResult,
    lang: WikiLanguage,
    signal: AbortSignal,
  ): Promise<{ content: string; tokens: number }> {
    throwIfAborted(signal);

    // Read existing content for incremental updates
    let existingContent: string | undefined;
    const docPath = path.join(
      this.projectPath,
      '.lingxiao',
      WIKI_DIR_NAME,
      lang,
      section.documentPath,
    );
    if (fs.existsSync(docPath)) {
      try {
        existingContent = fs.readFileSync(docPath, 'utf-8');
      } catch (err) {
        // ENOENT 在 existsSync 之后仍可能因竞态出现，视为无内容；
        // 其他错误（权限/IO/截断）绝不能静默——否则增量更新会退化为全量覆写，破坏已编辑内容。
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[WikiGenerator] 读取既有文档失败，增量更新将跳过旧内容 (${docPath}):`, err instanceof Error ? err.message : String(err));
        }
        existingContent = undefined;
      }
    }

    // Create a WikiAgent with tool access
    const agent = createWikiAgent({
      projectPath: this.projectPath,
      sessionId: `wiki-${lang}`,
      model: this.model,
      lang,
      emitter: this.emitter,
      db: this.db,
      sectionTitle: section.title,
      sectionDescription: section.description,
      sourceFiles: section.sourceFiles,
      existingContent,
    });

    // Wire up stream callback
    if (this.onStreamChunk) {
      agent.setStreamCallback(this.onStreamChunk);
    }
    // 注入 section 上下文，供 BaseAgent.onText 回调透传给 stream callback
    agent.currentSectionId = section.id;
    agent.currentSectionTitle = section.title;

    const abortAgent = () => agent.stop();
    signal.addEventListener('abort', abortAgent, { once: true });
    try {
      throwIfAborted(signal);
      const result = await agent.run({
        id: `wiki-${section.id}`,
        subject: `Write wiki documentation: ${section.title}`,
        description: section.description,
        working_directory: this.projectPath,
        write_scope: [],
      });
      throwIfAborted(signal);

      // Extract token usage from the agent's tracker
      const tokens = getAgentTokenTotal(agent);

      // 提取内容：直接使用结构化结果的 summary 或字符串结果
      const content = typeof result === 'string'
        ? result
        : result.summary;

      return { content, tokens };
    } finally {
      signal.removeEventListener('abort', abortAgent);
    }

  }

  // ─── Private: Utilities ────────────────────────────

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(isTextContentPartLike)
        .map((p) => typeof p.text === 'string' ? p.text : '')
        .join('');
    }
    return String(content || '');
  }

  private parseOutlineResponse(text: string): WikiOutline {
    // 尝试从响应中提取 JSON
    let jsonStr = text;

    // 如果被 markdown code block 包裹
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // 尝试找到 JSON 对象
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
    }

    try {
      const parsed: unknown = JSON.parse(jsonStr);
      if (hasOutlineSections(parsed)) {
        return { sections: parsed.sections };
      }
    } catch {
      // 解析失败，返回默认大纲
    }

    // Fallback: 默认大纲
    return {
      sections: [
        {
          id: 'overview',
          title: 'Project Overview',
          documentPath: 'overview.md',
          sourceFiles: [],
          description: 'Project overview, purpose, and tech stack',
        },
        {
          id: 'architecture',
          title: 'Architecture',
          documentPath: 'architecture.md',
          sourceFiles: [],
          description: 'High-level architecture and data flow',
        },
        {
          id: 'development',
          title: 'Development Guide',
          documentPath: 'development.md',
          sourceFiles: [],
          description: 'Setup, build, and test instructions',
        },
      ],
    };
  }

}

// ─── Checkpoint 工具函数 ──────────────────────────────

const CHECKPOINT_FILE = 'checkpoint.json';

function checkpointPath(projectPath: string, lang: WikiLanguage): string {
  return path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang, CHECKPOINT_FILE);
}

function hashOutline(outline: WikiOutline): string {
  const ids = outline.sections.map(s => s.id).join('|');
  // 简单 djb2 哈希，不需要加密强度
  let h = 5381;
  for (let i = 0; i < ids.length; i++) { h = ((h << 5) + h) ^ ids.charCodeAt(i); }
  return (h >>> 0).toString(16);
}

function loadCheckpoint(projectPath: string, lang: WikiLanguage): WikiCheckpoint | null {
  const p = checkpointPath(projectPath, lang);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as WikiCheckpoint;
  } catch (err) {
    // 损坏/不可读的 checkpoint 不能静默：否则长篇 wiki 会无声地从零重生成，丢失进度且无可诊断线索。
    console.warn(`[WikiGenerator] checkpoint 不可读，将从零重新生成 (${p}):`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function saveCheckpoint(projectPath: string, lang: WikiLanguage, cp: WikiCheckpoint): void {
  try {
    const p = checkpointPath(projectPath, lang);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cp), 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* best effort */ }
}

function removeCheckpoint(projectPath: string, lang: WikiLanguage): void {
  try { fs.unlinkSync(checkpointPath(projectPath, lang)); } catch { /* ignore */ }
}

// ─── 并发信号量 ────────────────────────────────────

class Semaphore {
  private queue: (() => void)[] = [];
  private _current = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this._current < this.max) {
      this._current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this._current++;
        resolve();
      });
    });
  }

  release(): void {
    this._current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}
