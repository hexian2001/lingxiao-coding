/**
 * SkillDefinitionService — write-capable persistence for user-defined skills,
 * mirroring AgentDefinitionService. The read-only SkillCatalog
 * (collectAvailableSkills) stays untouched; this service owns only the
 * create / update / delete of markdown skill files, so the cached read path
 * is never polluted by write logic.
 *
 *   .lingxiao/skills/<name>.md      (project, default)
 *   <globalSkillsDir>/<name>.md     (global)
 *
 * Skill file format (matches DistillCommand's skill write contract and what
 * SkillCatalog.collectMarkdownSkills reads back — flat form):
 *   ---
 *   name: <name>
 *   description: <one line>
 *   ---
 *   <markdown body / procedure>
 *
 * Project definitions override global by name (SkillCatalog visits project
 * first). Deterministic only: name validated by regex, description + body
 * required — no heuristics, no keyword matching.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getGlobalSkillsDir } from './BundledSkillRegistry.js';

export type SkillDefinitionScope = 'project' | 'global';

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
}

export interface SkillDefinitionRecord extends SkillDefinition {
  source: SkillDefinitionScope;
  path: string;
  updatedAt?: number;
}

export interface SaveSkillDefinitionInput {
  name: string;
  description: string;
  body: string;
  scope?: SkillDefinitionScope;
}

export interface SkillDefinitionServiceOptions {
  workspace?: string;
  globalSkillsDir?: string;
}

const VALID_SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function validateSkillName(name: string): string {
  const trimmed = name.trim().replace(/\.md$/i, '');
  if (trimmed.includes('/') || trimmed.includes('\\') || basename(trimmed) !== trimmed) {
    throw new Error('Invalid skill name. Do not include paths.');
  }
  if (!VALID_SKILL_NAME_RE.test(trimmed)) {
    throw new Error('Invalid skill name. Use 2-64 chars: letters, numbers, hyphen, underscore; start with a letter.');
  }
  return trimmed;
}

function cleanOneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function defaultSkillsDir(workspace: string, scope: SkillDefinitionScope, globalSkillsDir?: string): string {
  return scope === 'project'
    ? join(resolve(workspace), '.lingxiao', 'skills')
    : resolve(globalSkillsDir ?? getGlobalSkillsDir());
}

function stripFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }
  const parsed = parseYaml(match[1] || '');
  const meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return { meta, body: raw.slice(match[0].length).trim() };
}

function renderSkillMarkdown(definition: SkillDefinition): string {
  const frontmatter: Record<string, unknown> = {
    name: definition.name,
    description: cleanOneLine(definition.description),
  };
  return [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    definition.body.trim(),
    '',
  ].join('\n');
}

function normalizeSkill(input: SaveSkillDefinitionInput): SkillDefinition {
  const name = validateSkillName(input.name);
  const description = cleanOneLine(input.description || '');
  if (!description) {
    throw new Error('Skill description is required.');
  }
  const body = (input.body || '').trim();
  if (!body) {
    throw new Error('Skill body is required.');
  }
  return { name, description, body };
}

function parseSkillFile(path: string, fallbackName: string, source: SkillDefinitionScope): SkillDefinitionRecord | null {
  const raw = readFileSync(path, 'utf-8');
  const { meta, body } = stripFrontmatter(raw);
  const name = validateSkillName(typeof meta.name === 'string' ? meta.name : fallbackName);
  const description = cleanOneLine(typeof meta.description === 'string' ? meta.description : '');
  if (!description || !body.trim()) {
    return null;
  }
  const stat = statSync(path);
  return {
    name,
    description,
    body: body.trim(),
    source,
    path,
    updatedAt: stat.mtimeMs,
  };
}

export class SkillDefinitionService {
  private readonly workspace: string;
  private readonly globalSkillsDir?: string;

  constructor(options: SkillDefinitionServiceOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd());
    this.globalSkillsDir = options.globalSkillsDir;
  }

  getSkillsDir(scope: SkillDefinitionScope): string {
    return defaultSkillsDir(this.workspace, scope, this.globalSkillsDir);
  }

  /** Read back a single user-authored skill (flat <name>.md) for edit prefill. */
  getDefinitionInScope(name: string, scope: SkillDefinitionScope): SkillDefinitionRecord | null {
    const normalized = validateSkillName(name);
    const path = join(this.getSkillsDir(scope), `${normalized}.md`);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return parseSkillFile(path, normalized, scope);
  }

  saveDefinition(input: SaveSkillDefinitionInput): SkillDefinitionRecord {
    const scope = input.scope ?? 'project';
    const definition = normalizeSkill(input);
    const dir = this.getSkillsDir(scope);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${definition.name}.md`);
    writeFileSync(path, renderSkillMarkdown(definition), 'utf-8');
    return {
      ...definition,
      source: scope,
      path,
      updatedAt: statSync(path).mtimeMs,
    };
  }

  deleteDefinition(name: string, scope: SkillDefinitionScope = 'project'): boolean {
    const normalized = validateSkillName(name);
    const path = join(this.getSkillsDir(scope), `${normalized}.md`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}

export default SkillDefinitionService;
