/**
 * CustomCommandService — write-capable persistence for user-defined slash
 * commands, mirroring SkillDefinitionService / AgentDefinitionService. The
 * read-only CustomCommandLoader (collectCustomCommands / findCustomCommand)
 * stays untouched; this service owns only create / update / delete of
 * markdown command files.
 *
 *   .lingxiao/commands/<name>.md     (project, default)
 *   <globalCommandsDir>/<name>.md    (global)
 *
 * Command file format (matches CustomCommandLoader.readCommandFile, which
 * REQUIRES all three frontmatter fields — files missing any are skipped):
 *   ---
 *   name: fix-tests
 *   description: Run failing tests and fix them
 *   agent: qa-engineer
 *   ---
 *   Find failing tests for $ARGUMENTS and fix each one.
 *
 * Writing a file updates the command dir's mtime, which invalidates the
 * loader's 5s TTL cache (keyed on dir mtimes) on the next read — no manual
 * cache eviction needed. Deterministic only: regex name validation, required
 * description/agent/body — no heuristics.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getGlobalCommandsDir } from './CustomCommandLoader.js';

export type CustomCommandScope = 'project' | 'global';

export interface SaveCommandInput {
  name: string;
  description: string;
  agent: string;
  body: string;
  scope?: CustomCommandScope;
}

export interface CommandDefinitionRecord {
  name: string;
  description: string;
  agent: string;
  body: string;
  source: CustomCommandScope;
  path: string;
  updatedAt?: number;
}

export interface CustomCommandServiceOptions {
  workspace?: string;
  globalCommandsDir?: string;
}

const VALID_COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;

export function validateCommandName(name: string): string {
  // Tolerate a leading slash (users type "/fix-tests") and a trailing .md.
  const trimmed = name.trim().replace(/^\/+/, '').replace(/\.md$/i, '');
  if (trimmed.includes('/') || trimmed.includes('\\') || basename(trimmed) !== trimmed) {
    throw new Error('Invalid command name. Do not include paths or a leading slash.');
  }
  if (!VALID_COMMAND_NAME_RE.test(trimmed)) {
    throw new Error('Invalid command name. Use 2-64 chars: letters, numbers, hyphen, underscore; start with a letter.');
  }
  return trimmed;
}

function cleanOneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function defaultCommandsDir(workspace: string, scope: CustomCommandScope, globalCommandsDir?: string): string {
  return scope === 'project'
    ? join(resolve(workspace), '.lingxiao', 'commands')
    : resolve(globalCommandsDir ?? getGlobalCommandsDir());
}

function renderCommandMarkdown(input: { name: string; description: string; agent: string; body: string }): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: cleanOneLine(input.description),
    agent: cleanOneLine(input.agent),
  };
  return [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
}

function normalizeCommand(input: SaveCommandInput): CommandDefinitionRecord {
  const name = validateCommandName(input.name);
  const description = cleanOneLine(input.description || '');
  if (!description) {
    throw new Error('Command description is required.');
  }
  const agent = cleanOneLine(input.agent || '');
  if (!agent) {
    throw new Error('Command target agent is required.');
  }
  const body = (input.body || '').trim();
  if (!body) {
    throw new Error('Command body is required.');
  }
  return { name, description, agent, body, source: 'project', path: '' };
}

export class CustomCommandService {
  private readonly workspace: string;
  private readonly globalCommandsDir?: string;

  constructor(options: CustomCommandServiceOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd());
    this.globalCommandsDir = options.globalCommandsDir;
  }

  getCommandsDir(scope: CustomCommandScope): string {
    return defaultCommandsDir(this.workspace, scope, this.globalCommandsDir);
  }

  saveCommand(input: SaveCommandInput): CommandDefinitionRecord {
    const scope = input.scope ?? 'project';
    const normalized = normalizeCommand(input);
    const dir = this.getCommandsDir(scope);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${normalized.name}.md`);
    writeFileSync(path, renderCommandMarkdown(normalized), 'utf-8');
    return { ...normalized, source: scope, path, updatedAt: statSync(path).mtimeMs };
  }

  deleteCommand(name: string, scope: CustomCommandScope = 'project'): boolean {
    const normalized = validateCommandName(name);
    const path = join(this.getCommandsDir(scope), `${normalized}.md`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}

export default CustomCommandService;
