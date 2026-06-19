/**
 * ChangeDetector — 文件 hash 变更检测
 *
 * 基于 SHA-256 文件内容 hash 跟踪变更。
 * 对比 meta.json 中的 fileHashes，产出 ChangeSet。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type WikiMeta,
  type ChangeSet,
  type UpdateCheckResult,
  WIKI_DIR_NAME,
  WIKI_META_FILE,
} from './types.js';
import { WikiFileScanner } from './WikiFileScanner.js';

export class ChangeDetector {
  private scanner = new WikiFileScanner();

  /**
   * 计算单个文件的 SHA-256 hash
   */
  hashFile(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    } catch {/* expected: fallback to default */
      return '';
    }
  }

  /**
   * 计算字符串内容的 hash
   */
  hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * 扫描项目所有文件并计算 hash
   */
  async hashProject(projectPath: string): Promise<Map<string, string>> {
    const scanResult = await this.scanner.scan(projectPath);
    const hashes = new Map<string, string>();

    for (const relPath of scanResult.sourceFiles) {
      const fullPath = path.join(projectPath, relPath);
      const hash = this.hashFile(fullPath);
      if (hash) {
        hashes.set(relPath, hash);
      }
    }

    return hashes;
  }

  /**
   * 检测变更，返回 ChangeSet
   */
  async detectChanges(projectPath: string, lang: string): Promise<ChangeSet> {
    const currentHashes = await this.hashProject(projectPath);
    const meta = this.loadMeta(projectPath, lang);
    if (!meta) {
      return { added: [...currentHashes.keys()], modified: [], deleted: [] };
    }

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // 当前有但 meta 没有的 → 新增
    for (const [relPath, hash] of currentHashes) {
      const prevHash = meta.fileHashes[relPath];
      if (!prevHash) {
        added.push(relPath);
      } else if (prevHash !== hash) {
        modified.push(relPath);
      }
    }

    // meta 有但当前没有的 → 删除
    for (const relPath of Object.keys(meta.fileHashes)) {
      if (!currentHashes.has(relPath)) {
        deleted.push(relPath);
      }
    }

    return { added, modified, deleted };
  }

  /**
   * 完整的更新检查：变更检测 + 映射到受影响 sections
   */
  async checkForUpdates(projectPath: string, lang: string): Promise<UpdateCheckResult> {
    const changeSet = await this.detectChanges(projectPath, lang);
    const meta = this.loadMeta(projectPath, lang);

    const affectedSections = new Set<string>();
    const allChanged = [...changeSet.added, ...changeSet.modified, ...changeSet.deleted];

    if (meta) {
      for (const section of meta.sections) {
        const isAffected = section.sourceFiles.some(sf => allChanged.includes(sf));
        if (isAffected) {
          affectedSections.add(section.id);
        }
      }

      // 新增文件可能影响 overview 和 architecture
      if (changeSet.added.length > 0) {
        affectedSections.add('overview');
        affectedSections.add('architecture');
      }
    }

    return {
      needsUpdate: allChanged.length > 0,
      changeSet,
      affectedSections: [...affectedSections],
      changeCount: allChanged.length,
    };
  }

  /**
   * 加载 meta.json
   */
  loadMeta(projectPath: string, lang: string): WikiMeta | null {
    const metaPath = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang, WIKI_META_FILE);
    try {
      const content = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(content);
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  /**
   * 保存 meta.json
   */
  saveMeta(projectPath: string, lang: string, meta: WikiMeta): void {
    const metaDir = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME, lang);
    fs.mkdirSync(metaDir, { recursive: true });
    const metaPath = path.join(metaDir, WIKI_META_FILE);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  /**
   * 删除 wiki 目录（指定语言）
   */
  deleteWikiDir(projectPath: string, lang?: string): void {
    const wikiBase = path.join(projectPath, '.lingxiao', WIKI_DIR_NAME);
    if (!lang) {
      // 删除整个 wiki 目录
      if (fs.existsSync(wikiBase)) {
        fs.rmSync(wikiBase, { recursive: true, force: true });
      }
    } else {
      const langDir = path.join(wikiBase, lang);
      if (fs.existsSync(langDir)) {
        fs.rmSync(langDir, { recursive: true, force: true });
      }
    }
  }
}
