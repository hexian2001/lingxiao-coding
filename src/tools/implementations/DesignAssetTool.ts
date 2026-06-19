/**
 * DesignAssetTool — 查询设计素材市场里的完整主题参考网站
 *
 * 用法: agent 调用 design_asset({ theme: "minimal" })
 * 返回: 主题参考网站的 prompt、使用策略和只读预览信息，不返回可复制代码。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

interface ThemeManifest {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  category?: string;
  tags?: string[];
  preview?: string;
  prompt?: string;
}

interface ThemeReference {
  id: string;
  name: string;
  title: string;
  description: string;
  version?: string;
  category?: string;
  tags: string[];
  prompt: string;
  usagePolicy: string[];
  referenceOnly: true;
  previewAvailableInDesignMarket: boolean;
}

const USAGE_POLICY = [
  '这是完整主题参考网站，不是组件库。只能用于审美校准、信息架构参考和业务页面构图参考。',
  '必须结合当前业务、真实内容、产品目标和交互路径重新设计，不允许照搬主题里的页面结构。',
  '禁止复制、改写或拼接参考站的 DOM、CSS、React、Tailwind、previewHtml 或任何可直接落地代码。',
  '禁止堆叠多个主题到同一页面；选择一个主主题后，用业务需求重建视觉语言。',
];

/** 主题参考网站单例 (延迟加载) */
let themeReferencesInstance: ThemeReference[] | null = null;

function getThemeDirectories(): string[] {
  return [
    resolve(MODULE_DIR, '../../../skills/bundled/design-market/themes'),
    resolve(MODULE_DIR, '../../../../skills/bundled/design-market/themes'),
    join(process.cwd(), 'skills/bundled/design-market/themes'),
  ];
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function cleanLongText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[ \t]+\n/g, '\n').trim() : '';
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    const tag = cleanText(item).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
  return output;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function loadThemeReferencesFromDirectories(themeRoots: string[]): ThemeReference[] {
  const references = new Map<string, ThemeReference>();

  for (const root of themeRoots) {
    if (!existsSync(root)) continue;

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const themeDir = join(root, entry.name);
      const manifest = readJsonFile(join(themeDir, 'manifest.json')) as ThemeManifest | null;
      if (!manifest) continue;

      const id = cleanText(manifest.id || entry.name).toLowerCase();
      if (!id || references.has(id)) continue;

      const promptFile = cleanText(manifest.prompt || 'prompt.md');
      const promptPath = join(themeDir, promptFile);
      const prompt = existsSync(promptPath)
        ? cleanLongText(readFileSync(promptPath, 'utf8'))
        : cleanLongText(manifest.description);

      references.set(id, {
        id,
        name: cleanText(manifest.name) || id,
        title: cleanText(manifest.title) || cleanText(manifest.name) || id,
        description: cleanText(manifest.description),
        version: cleanText(manifest.version) || undefined,
        category: cleanText(manifest.category) || undefined,
        tags: cleanTags(manifest.tags),
        prompt,
        usagePolicy: USAGE_POLICY,
        referenceOnly: true,
        previewAvailableInDesignMarket: Boolean(cleanText(manifest.preview)),
      });
    }
  }

  return Array.from(references.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function getThemeReferences(): ThemeReference[] {
  if (themeReferencesInstance) return themeReferencesInstance;
  themeReferencesInstance = loadThemeReferencesFromDirectories(getThemeDirectories());
  return themeReferencesInstance;
}

function matchesSearch(reference: ThemeReference, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    reference.id,
    reference.name,
    reference.title,
    reference.description,
    reference.category ?? '',
    ...reference.tags,
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

export class DesignAssetTool extends Tool {
  readonly name = 'design_asset';
  readonly description = '设计素材市场主题参考网站查询 — 返回完整主题参考站的 prompt、使用策略和只读预览可用性；不返回 CSS/HTML/React/Tailwind/previewHtml 或可复制 DOM/CSS。';
  readonly parameters = z.object({
    theme: z.string().optional().describe('主题参考站 ID，如 minimal、luxury、editorial、xianxia 等。'),
    tags: z.array(z.string()).optional().describe('标签过滤(AND)，用于筛选业务方向或主题特征。'),
    search: z.string().optional().describe('自然语言关键词搜索，匹配主题名称、标题、描述、分类和标签。'),
    limit: z.number().min(1).max(50).optional().describe('返回数量上限(默认10, 最大50)。'),
    action: z.enum(['search', 'themes', 'tags']).optional().describe('操作: search(默认)=查询主题参考站, themes=列出可用主题, tags=列出热门标签。'),
  });

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = this.parameters.parse(args ?? {});
    const references = getThemeReferences();

    if (references.length === 0 && params.action !== 'tags') {
      const dirs = getThemeDirectories();
      const anyExists = dirs.some(d => existsSync(d));
      if (!anyExists) {
        return {
          success: false,
          data: null,
          error: '设计素材目录不存在，design_asset 功能未安装。预期路径: ' + dirs[0],
        };
      }
    }

    if (params.action === 'themes') {
      return {
        success: true,
        data: {
          themes: references.map(reference => ({
            id: reference.id,
            name: reference.name,
            title: reference.title,
            description: reference.description,
            tags: reference.tags,
            referenceOnly: true,
            previewAvailableInDesignMarket: reference.previewAvailableInDesignMarket,
          })),
          total: references.length,
          usagePolicy: USAGE_POLICY,
        },
      };
    }

    if (params.action === 'tags') {
      const tags = Array.from(new Set(references.flatMap(reference => reference.tags))).sort();
      return { success: true, data: { tags, total: tags.length, usagePolicy: USAGE_POLICY } };
    }

    const requestedTags = params.tags?.map(tag => tag.trim().toLowerCase()).filter(Boolean) ?? [];
    const limit = params.limit ?? 10;
    const matched = references.filter(reference => {
      if (params.theme && reference.id !== params.theme.trim().toLowerCase()) return false;
      if (requestedTags.some(tag => !reference.tags.includes(tag))) return false;
      if (params.search && !matchesSearch(reference, params.search)) return false;
      return true;
    });

    if (matched.length === 0) {
      return {
        success: true,
        data: {
          message: '未找到匹配主题参考站。建议放宽过滤条件或使用 design_asset({ action: "themes" }) 查看可用主题。',
          total: 0,
          returned: 0,
          query: params,
          usagePolicy: USAGE_POLICY,
          referenceOnly: true,
        },
      };
    }

    return {
      success: true,
      data: {
        total: matched.length,
        returned: Math.min(matched.length, limit),
        themes: matched.slice(0, limit),
        query: params,
        usagePolicy: USAGE_POLICY,
        referenceOnly: true,
      },
    };
  }
}
