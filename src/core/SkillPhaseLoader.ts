/**
 * SkillPhaseLoader — 分层技能加载器
 *
 * 加载技能目录下的 phases/ 子目录，并解析 Phase 文件中的 Quality Gate。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';

export interface SkillPhase {
  name: string;
  path: string;
  content: string;
}

export interface QualityGate {
  checks: string[];
  skipConditions: string[];
}

/** 从 markdown 中解析 Quality Gate 和 Skip Conditions 段落 */
export function parseQualityGate(content: string): QualityGate {
  const checks: string[] = [];
  const skipConditions: string[] = [];

  const lines = content.split('\n');
  let section: 'checks' | 'skip' | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#{1,3}\s*Quality\s*Gate/i.test(trimmed)) {
      section = 'checks';
      continue;
    }
    if (/^#{1,3}\s*Skip\s*Conditions?/i.test(trimmed)) {
      section = 'skip';
      continue;
    }
    // 遇到下一个同级或更高级标题时退出当前段落
    if (/^#{1,3}\s+/.test(trimmed) && section) {
      section = null;
      continue;
    }

    if (section === 'checks') {
      const match = trimmed.match(/^[-*]\s+\[?\s*[x ]?\s*\]?\s*(.+)/i);
      if (match?.[1]) {
        checks.push(match[1].trim());
      } else if (trimmed && !trimmed.startsWith('#')) {
        // 非 checkbox 格式的条目也收集
        checks.push(trimmed);
      }
    }

    if (section === 'skip') {
      const match = trimmed.match(/^[-*]\s+(.+)/);
      if (match?.[1]) {
        skipConditions.push(match[1].trim());
      } else if (trimmed && !trimmed.startsWith('#')) {
        skipConditions.push(trimmed);
      }
    }
  }

  return { checks, skipConditions };
}

/** 从目录中加载 .md 文件为条目列表 */
function loadMarkdownEntries(dir: string): Array<{ name: string; path: string; content: string }> {
  if (!existsSync(dir)) {
    return [];
  }

  const entries: Array<{ name: string; path: string; content: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (!stat.isFile()) continue;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      entries.push({ name: basename(file, '.md'), path: fullPath, content });
    } catch {
      // 跳过读取失败的文件
    }
  }

  return entries;
}

/** 加载技能目录下的 phases/ 子目录 */
export function loadSkillPhases(skillDir: string): SkillPhase[] {
  return loadMarkdownEntries(join(skillDir, 'phases')) as SkillPhase[];
}

/** 检查 phases 中是否存在 Quality Gate */
export function hasQualityGates(phases: SkillPhase[]): boolean {
  return phases.some((phase) => {
    const gate = parseQualityGate(phase.content);
    return gate.checks.length > 0;
  });
}
