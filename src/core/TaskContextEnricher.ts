import * as fs from 'fs/promises';
import * as path from 'path';
import type { WorkNoteManager } from './WorkNoteManager';
import type { DatabaseManager } from './Database.js';
import { ContextMemoryIndex, type ContextMemoryRecallResult } from './ContextMemoryIndex.js';
import {
  CONTEXT_MANIFEST_BLOCK_MARKER,
  renderContextManifest,
  type ContextManifestSection,
} from './ContextManifest.js';

const MAX_FILE_TREE_ENTRIES = 30;

function stripExistingContextManifest(context?: string): string {
  const raw = context?.trim();
  if (!raw) return '';
  const markerIdx = raw.indexOf(CONTEXT_MANIFEST_BLOCK_MARKER);
  return markerIdx >= 0 ? raw.slice(0, markerIdx).trim() : raw;
}

/**
 * 递归扫描目录并生成 markdown 树形列表
 */
async function scanDirectoryTree(
  dirPath: string,
  maxEntries: number,
  visited: Set<string>,
  depth: number = 0,
): Promise<string[]> {
  if (maxEntries <= 0 || depth > 4) return [];
  const resolved = path.resolve(dirPath);
  if (visited.has(resolved)) return [];
  visited.add(resolved);

  const lines: string[] = [];
  let remaining = maxEntries;

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    // 排序：目录在前，文件在后；字母序
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // 过滤隐藏文件/目录和 node_modules
    const filtered = sorted.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist');

    for (const entry of filtered) {
      if (remaining <= 0) break;
      const prefix = '  '.repeat(depth) + (depth === 0 ? '- ' : '  - ');
      const fullPath = path.join(resolved, entry.name);

      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        remaining--;
        if (remaining > 0) {
          const subLines = await scanDirectoryTree(fullPath, remaining, visited, depth + 1);
          lines.push(...subLines);
          remaining -= subLines.length;
        }
      } else {
        lines.push(`${prefix}${entry.name}`);
        remaining--;
      }
    }
  } catch {
    // 目录不可读，静默跳过
  }

  return lines;
}

/**
 * 生成 Context Manifest 的文件树 section 内容（基于 working_directory 和 write_scope）
 */
async function generateFileTreeManifestContent(
  workingDirectory?: string,
  writeScope?: string[],
): Promise<string> {
  const scanRoots: string[] = [];
  if (workingDirectory) {
    scanRoots.push(workingDirectory);
  }
  if (writeScope) {
    for (const scopePath of writeScope) {
      if (scopePath && !scanRoots.includes(scopePath)) {
        scanRoots.push(scopePath);
      }
    }
  }

  if (scanRoots.length === 0) return '';

  const visited = new Set<string>();
  const allLines: string[] = [];

  let budget = MAX_FILE_TREE_ENTRIES;
  for (const root of scanRoots) {
    if (budget <= 0) break;
    const resolved = path.resolve(root);
    // 跳过已扫描的根或上级目录
    if ([...visited].some(v => resolved.startsWith(v + path.sep) || v.startsWith(resolved + path.sep))) {
      continue;
    }
    const rootLines = await scanDirectoryTree(root, budget, visited);
    if (rootLines.length > 0) {
      allLines.push(...rootLines);
      budget -= rootLines.length;
    }
  }

  if (allLines.length === 0) return '';

  const footer = budget < MAX_FILE_TREE_ENTRIES && allLines.length >= MAX_FILE_TREE_ENTRIES
    ? `\n*(已截断，显示前 ${MAX_FILE_TREE_ENTRIES} 个条目)*`
    : '';

  return `${allLines.join('\n')}${footer}`;
}

/**
 * 上下文富化结果
 */
export interface EnrichedContext {
  /** 合并后的完整 context 字符串 */
  context: string;
  /** 自动注入的片段列表 */
  injectedSections: string[];
}

/**
 * 富化任务上下文：自动追加工作笔记、文件树、黑板快照等系统信息
 *
 * 用于 create_task 和 dispatch_agent 时自动补充背景信息
 */
export async function enrichTaskContext(params: {
  sessionId: string;
  existingContext?: string;
  workingDirectory?: string;
  writeScope?: string[];
  workNoteManager: WorkNoteManager;
  injectFileTree?: boolean;
  /** blocked_by 前序任务 ID 列表，用于优先注入依赖任务的笔记 */
  blockedByTaskIds?: string[];
  /** 黑板图快照（压缩后的 markdown） */
  blackboardSnapshot?: string;
  /** 额外注入到统一 Context Manifest 的系统片段 */
  manifestSections?: ContextManifestSection[];
  /** DB 可选；提供后启用统一上下文记忆召回 */
  db?: Pick<DatabaseManager, 'getTasksBySession' | 'getSessionState'>;
  /** 工作区根路径；提供后启用上游依赖任务的 scratchpad 召回 */
  workspace?: string;
  memoryTokenBudget?: number;
}): Promise<EnrichedContext> {
  const {
    sessionId,
    existingContext,
    workingDirectory,
    writeScope,
    workNoteManager,
    injectFileTree = true,
    blockedByTaskIds,
    blackboardSnapshot,
    db,
    workspace,
    memoryTokenBudget,
  } = params;

  const injectedSections: string[] = [];
  const manifestSections: ContextManifestSection[] = [...(params.manifestSections ?? [])];
  let memory: ContextMemoryRecallResult | undefined;

  // 1. 统一上下文记忆召回：任务结果、工作笔记、压缩归档、黑板快照（确定性，无 LLM 重排）
  if (db) {
    const memoryIndex = new ContextMemoryIndex(db, workNoteManager);
    memory = await memoryIndex.recall({
      sessionId,
      blockedByTaskIds,
      tokenBudget: memoryTokenBudget,
      blackboardSnapshot,
      workspace,
    });
  }

  // 2. 文件树进入统一 Context Manifest，避免并列系统注入标题
  if (injectFileTree && (workingDirectory || (writeScope && writeScope.length > 0))) {
    const fileTree = await generateFileTreeManifestContent(workingDirectory, writeScope);
    if (fileTree) {
      manifestSections.push({ title: 'Workspace File Tree', content: fileTree });
    }
  }

  if (memory?.rendered || manifestSections.length > 0) {
    injectedSections.push(renderContextManifest({
      scope: 'worker',
      sessionId,
      memory,
      sections: manifestSections,
    }));
  }

  if (injectedSections.length === 0) {
    return { context: existingContext || '', injectedSections: [] };
  }

  const leaderContext = stripExistingContextManifest(existingContext);
  const autoBlock = `${CONTEXT_MANIFEST_BLOCK_MARKER}\n${injectedSections.join('\n\n')}`;

  const fullContext = leaderContext
    ? `${leaderContext}\n\n${autoBlock}`
    : autoBlock;

  return { context: fullContext, injectedSections };
}
