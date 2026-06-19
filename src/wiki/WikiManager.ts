/**
 * WikiManager — Wiki 生命周期管理器
 *
 * 按 projectPath 管理多个 Wiki 实例。
 * 协调 Scanner、Detector、Generator 完成 Wiki 的生成、更新、删除。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import { WikiFileScanner } from './WikiFileScanner.js';
import { ChangeDetector } from './ChangeDetector.js';
import { WikiGenerator } from './WikiGenerator.js';
import {
  type WikiLanguage,
  type WikiStatus,
  type WikiDocument,
  type WikiGenerationResult,
  type UpdateCheckResult,
  type SyncResult,
  type WikiProgressCallback,
  type WikiStreamCallback,
  WIKI_DIR_NAME,
  WIKI_META_FILE,
} from './types.js';
import { refreshRuntimeConfig } from '../config.js';

export class WikiManager {
  private scanners = new Map<string, WikiFileScanner>();
  private detectors = new Map<string, ChangeDetector>();
  private generators = new Map<string, WikiGenerator>();

  // 当前正在生成中的 project+lang
  private generating = new Set<string>();

  constructor(
    private emitter: EventEmitter,
    private db: DatabaseManager,
  ) {}

  private key(projectPath: string, lang: WikiLanguage): string {
    return `${projectPath}::${lang}`;
  }

  private getScanner(projectPath: string): WikiFileScanner {
    let scanner = this.scanners.get(projectPath);
    if (!scanner) {
      scanner = new WikiFileScanner();
      this.scanners.set(projectPath, scanner);
    }
    return scanner;
  }

  private getDetector(projectPath: string): ChangeDetector {
    let detector = this.detectors.get(projectPath);
    if (!detector) {
      detector = new ChangeDetector();
      this.detectors.set(projectPath, detector);
    }
    return detector;
  }

  private getGenerator(projectPath: string, llm: ContentGenerator): WikiGenerator {
    const key = projectPath;
    let generator = this.generators.get(key);
    if (!generator) {
      const config = refreshRuntimeConfig();
      const model = config.llm.wiki_model || config.llm.leader_model;
      if (!model) throw new Error('llm.wiki_model 或 llml.leader_model 未配置');
      generator = new WikiGenerator(projectPath, llm, model, this.emitter, this.db);
      this.generators.set(key, generator);
    }
    return generator;
  }

  /**
   * 全量生成 Wiki
   */
  async generateWiki(
    projectPath: string,
    lang: WikiLanguage,
    llm: ContentGenerator,
    onProgress?: WikiProgressCallback,
    onStream?: WikiStreamCallback,
  ): Promise<WikiGenerationResult> {
    const k = this.key(projectPath, lang);
    if (this.generating.has(k)) {
      return {
        success: false,
        documentsGenerated: 0,
        documentsUpdated: 0,
        tokensUsed: 0,
        duration: 0,
        error: 'Wiki generation already in progress',
      };
    }

    // 前置检查
    const scanner = this.getScanner(projectPath);
    if (!scanner.isGitRepo(projectPath)) {
      return {
        success: false,
        documentsGenerated: 0,
        documentsUpdated: 0,
        tokensUsed: 0,
        duration: 0,
        error: '项目不是 Git 仓库或没有提交记录',
      };
    }

    this.generating.add(k);
    try {
      const generator = this.getGenerator(projectPath, llm);
      return await generator.generate(lang, onProgress, onStream);
    } finally {
      this.generating.delete(k);
    }
  }

  /**
   * 增量更新 Wiki
   */
  async updateWiki(
    projectPath: string,
    lang: WikiLanguage,
    llm: ContentGenerator,
    onProgress?: WikiProgressCallback,
    onStream?: WikiStreamCallback,
  ): Promise<WikiGenerationResult> {
    const k = this.key(projectPath, lang);
    if (this.generating.has(k)) {
      return {
        success: false,
        documentsGenerated: 0,
        documentsUpdated: 0,
        tokensUsed: 0,
        duration: 0,
        error: 'Wiki generation already in progress',
      };
    }

    const meta = this.getDetector(projectPath).loadMeta(projectPath, lang);
    if (!meta) {
      // 没有 meta，全量生成
      return this.generateWiki(projectPath, lang, llm, onProgress, onStream);
    }

    // 检测变更
    const updateCheck = await this.getDetector(projectPath).checkForUpdates(projectPath, lang);
    if (!updateCheck.needsUpdate) {
      return {
        success: true,
        documentsGenerated: 0,
        documentsUpdated: 0,
        tokensUsed: 0,
        duration: 0,
      };
    }

    this.generating.add(k);
    try {
      const generator = this.getGenerator(projectPath, llm);
      const allChanged = [
        ...updateCheck.changeSet.added,
        ...updateCheck.changeSet.modified,
        ...updateCheck.changeSet.deleted,
      ];
      return await generator.incrementalUpdate(lang, allChanged, onProgress, onStream);
    } finally {
      this.generating.delete(k);
    }
  }

  /**
   * 获取 Wiki 状态
   */
  async getStatus(projectPath: string, lang: WikiLanguage): Promise<WikiStatus> {
    const detector = this.getDetector(projectPath);
    const meta = detector.loadMeta(projectPath, lang);
    const k = this.key(projectPath, lang);

    if (!meta) {
      return {
        projectPath,
        lang,
        exists: false,
        generating: this.generating.has(k),
        lastGeneratedAt: null,
        documentCount: 0,
        totalSize: 0,
        changeCount: 0,
        version: 0,
      };
    }

    // 计算变更数
    const updateCheck = await detector.checkForUpdates(projectPath, lang);

    // 计算总大小
    let totalSize = 0;
    const wikiDir = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang);
    if (fs.existsSync(wikiDir)) {
      try {
        const files = this.walkDir(wikiDir);
        for (const f of files) {
          try { totalSize += fs.statSync(f).size; } catch { /* expected: file may be deleted concurrently */ }
        }
      } catch { /* expected: wiki dir may be removed during scan */ }
    }

    return {
      projectPath,
      lang,
      exists: true,
      generating: this.generating.has(k),
      lastGeneratedAt: meta.generatedAt,
      documentCount: meta.sections.length,
      totalSize,
      changeCount: updateCheck.changeCount,
      version: meta.version,
    };
  }

  /**
   * 列出所有 Wiki 文档
   */
  async listDocuments(projectPath: string, lang: WikiLanguage): Promise<WikiDocument[]> {
    const detector = this.getDetector(projectPath);
    const meta = detector.loadMeta(projectPath, lang);
    if (!meta) return [];

    const docs: WikiDocument[] = [];
    for (const section of meta.sections) {
      const docPath = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang, section.documentPath);
      let size = 0;
      let lastModified = 0;
      try {
        const stat = fs.statSync(docPath);
        size = stat.size;
        lastModified = Math.floor(stat.mtimeMs / 1000);
      } catch { /* expected: doc file may not exist yet */ }

      docs.push({
        path: section.documentPath,
        title: section.title,
        section: section.id,
        size,
        lastModified,
      });
    }

    return docs;
  }

  /**
   * 读取指定文档内容
   */
  async readDocument(projectPath: string, lang: WikiLanguage, docPath: string): Promise<string | null> {
    const fullPath = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang, docPath);
    try {
      return fs.readFileSync(fullPath, 'utf-8');
    } catch { /* expected: document file may not exist */
      return null;
    }
  }

  /**
   * 删除 Wiki
   */
  async deleteWiki(projectPath: string, lang?: WikiLanguage): Promise<void> {
    const detector = this.getDetector(projectPath);
    detector.deleteWikiDir(projectPath, lang);
  }

  /**
   * 检查是否需要更新
   */
  async checkForUpdates(projectPath: string, lang: WikiLanguage): Promise<UpdateCheckResult> {
    const detector = this.getDetector(projectPath);
    return detector.checkForUpdates(projectPath, lang);
  }

  /**
   * 从 Git 同步 Wiki
   */
  async syncFromGit(projectPath: string, lang: WikiLanguage): Promise<SyncResult> {
    // Git 同步的本质是：如果 .lingxiao/wiki/ 下有文件被 git pull 了，
    // 那么这些文件已经是最新的，我们只需验证 meta.json 存在且有效。
    const detector = this.getDetector(projectPath);
    const meta = detector.loadMeta(projectPath, lang);

    if (!meta) {
      return {
        synced: false,
        documentsSynced: 0,
        error: 'No wiki meta found in git directory',
      };
    }

    // 统计文档数
    const wikiDir = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang);
    let docsSynced = 0;
    try {
      for (const section of meta.sections) {
        const docPath = path.join(wikiDir, section.documentPath);
        if (fs.existsSync(docPath)) {
          docsSynced++;
        }
      }
    } catch { /* expected: wiki dir may not exist */ }

    return {
      synced: true,
      documentsSynced: docsSynced,
    };
  }

  /**
   * 是否正在生成
   */
  isGenerating(projectPath: string, lang: WikiLanguage): boolean {
    return this.generating.has(this.key(projectPath, lang));
  }

  /**
   * 查询断点续传状态
   */
  async getCheckpointStatus(projectPath: string, lang: WikiLanguage): Promise<{ exists: boolean; completedCount: number; totalCount: number }> {
    const checkpointPath = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang, 'checkpoint.json');
    try {
      if (!fs.existsSync(checkpointPath)) return { exists: false, completedCount: 0, totalCount: 0 };
      const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
      const completedCount = Array.isArray(cp.sections) ? cp.sections.length : 0;
      // totalCount 无法精确知道（需要重新 outline），用 completedCount 作保守估计
      return { exists: completedCount > 0, completedCount, totalCount: completedCount };
    } catch { /* expected: checkpoint file missing or malformed */
      return { exists: false, completedCount: 0, totalCount: 0 };
    }
  }

  // ─── Private ──────────────────────────────────────

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.walkDir(fullPath));
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch { /* expected: directory may not be readable */ }
    return results;
  }
}
