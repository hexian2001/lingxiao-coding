import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config, CONFIG_DIR } from '../config.js';
import type { SkillSource } from './SkillCatalog.js';

export interface BundledSkillRegistryEntry {
  id: string;
  dir: string;
  source: SkillSource;
  syncToGlobalByDefault: boolean;
  description: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const RETIRED_BUNDLED_SKILLS = new Set([
  'browser-automation',
  'webapp-testing',
]);

export function getBundledSkillsDir(): string {
  return process.env.LINGXIAO_BUNDLED_SKILLS_DIR || config.paths.bundled_skills_dir || resolve(MODULE_DIR, '../../skills/bundled');
}

export function getBundledSkillRegistry(_workspace: string): BundledSkillRegistryEntry[] {
  return [
    {
      id: 'package_bundled',
      dir: getBundledSkillsDir(),
      source: 'bundled',
      syncToGlobalByDefault: true,
      description: 'package-bundled default skills',
    },
  ];
}

export function getGlobalSkillsDir(): string {
  return process.env.LINGXIAO_GLOBAL_SKILLS_DIR || config.paths.global_skills_dir || join(CONFIG_DIR, 'skills');
}

function iterSkillEntries(dir: string): Array<{ name: string; path: string; isDirectory: boolean }> {
  if (!existsSync(dir)) {
    return [];
  }

  const entries: Array<{ name: string; path: string; isDirectory: boolean }> = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const skillMd = join(fullPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        entries.push({ name: basename(fullPath), path: fullPath, isDirectory: true });
      }
      continue;
    }
    if (stat.isFile() && entry.endsWith('.md')) {
      entries.push({ name: entry.replace(/\.md$/, ''), path: fullPath, isDirectory: false });
    }
  }
  return entries;
}

export interface BundledSkillSyncOptions {
  workspace: string;
  targetDir?: string;
  overwrite?: boolean;
}

export interface BundledSkillSyncResult {
  targetDir: string;
  copied: string[];
  skipped: string[];
  removed: string[];
  missingSources: string[];
}

export function syncBundledSkillsToGlobalDir(options: BundledSkillSyncOptions): BundledSkillSyncResult {
  const targetDir = options.targetDir || getGlobalSkillsDir();
  const overwrite = options.overwrite === true;
  mkdirSync(targetDir, { recursive: true });

  const copied: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  const missingSources: string[] = [];

  for (const retiredName of RETIRED_BUNDLED_SKILLS) {
    for (const retiredPath of [join(targetDir, retiredName), join(targetDir, `${retiredName}.md`)]) {
      if (!existsSync(retiredPath)) continue;
      rmSync(retiredPath, { recursive: true, force: true });
      removed.push(retiredName);
    }
  }

  for (const entry of getBundledSkillRegistry(options.workspace)) {
    if (!entry.syncToGlobalByDefault) {
      continue;
    }
    if (!existsSync(entry.dir)) {
      missingSources.push(entry.id);
      continue;
    }
    for (const skill of iterSkillEntries(entry.dir)) {
      const destination = skill.isDirectory
        ? join(targetDir, skill.name)
        : join(targetDir, `${skill.name}.md`);
      if (existsSync(destination) && !overwrite) {
        skipped.push(skill.name);
        continue;
      }
      cpSync(skill.path, destination, { recursive: skill.isDirectory, force: overwrite });
      copied.push(skill.name);
    }
  }

  return { targetDir, copied, skipped, removed: [...new Set(removed)], missingSources };
}
