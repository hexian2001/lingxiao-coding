/**
 * CustomCommandLoader — discovers markdown command files under
 * `<workspace>/.lingxiao/commands/*.md` (project) and `~/.lingxiao/commands/*.md`
 * (global) and exposes them as executable slash commands.
 *
 * Mirrors the deterministic file-scan + 5s TTL cache pattern of
 * `src/core/SkillCatalog.ts` (collectMarkdownSkills / getSkillSourceCandidates /
 * collectAvailableSkills), including stat-mtime cache-keying.
 *
 * Command file format (written by /distill — see DistillCommand.ts):
 *   ---
 *   name: fix-test-failures
 *   description: Run failing tests and fix them
 *   agent: qa-engineer
 *   ---
 *   Find the failing tests for $ARGUMENTS and fix each one.
 *
 * Hard rules: deterministic only (no heuristics, no keyword matching, no
 * thresholds, no confidence scores). Files missing any of name/description/agent
 * frontmatter are skipped (logged via coreLogger, never crash).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { coreLogger } from '../core/Log.js';
import type { SlashCommandDefinition } from './slash_registry.js';

export type CustomCommandSource = 'project' | 'global';

export interface CustomCommandDescriptor {
  /** Slash-command name WITHOUT the leading slash (e.g. "fix-test-failures"). */
  name: string;
  description: string;
  /** Target agent role from frontmatter (may be "leader"). */
  agent: string;
  /** Original slash name with leading slash, e.g. "/fix-test-failures". */
  slashName: string;
  source: CustomCommandSource;
  /** Absolute path to the .md file on disk. */
  path: string;
  /** Markdown body with frontmatter stripped (may contain $ARGUMENTS). */
  body: string;
}

export interface CustomCommandSourceCandidate {
  dir: string;
  source: CustomCommandSource;
}

/** 5s TTL cache, mirroring SkillCatalog's SKILL_CATALOG_CACHE_TTL_MS. */
const CUSTOM_COMMAND_CACHE_TTL_MS = Number(process.env.LINGXIAO_CUSTOM_COMMAND_CACHE_TTL_MS || 5_000);

const customCommandCache = new Map<string, { createdAt: number; commands: CustomCommandDescriptor[] }>();

/**
 * Resolve the global commands directory: `~/.lingxiao/commands/`. Overridable via
 * LINGXIAO_GLOBAL_COMMANDS_DIR for symmetry with SkillCatalog's global skills dir.
 */
export function getGlobalCommandsDir(): string {
  return process.env.LINGXIAO_GLOBAL_COMMANDS_DIR || join(homedir(), '.lingxiao', 'commands');
}

/**
 * Build the ordered list of source directories. Order encodes precedence:
 * project comes first so it overrides global by name (see collectCustomCommands).
 */
export function getCustomCommandSourceCandidates(workspace: string): CustomCommandSourceCandidate[] {
  return [
    { dir: join(workspace, '.lingxiao', 'commands'), source: 'project' as const },
    { dir: getGlobalCommandsDir(), source: 'global' as const },
  ];
}

function cloneCustomCommandDescriptor(command: CustomCommandDescriptor): CustomCommandDescriptor {
  return { ...command };
}

function cloneCustomCommandDescriptors(commands: CustomCommandDescriptor[]): CustomCommandDescriptor[] {
  return commands.map(cloneCustomCommandDescriptor);
}

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {/* expected: fallback to default */
    return 0;
  }
}

function buildCustomCommandCacheKey(input: { workspace: string; candidates: CustomCommandSourceCandidate[] }): string {
  const candidateSignature = input.candidates.map((candidate) => [
    resolve(candidate.dir),
    candidate.source,
    statMtimeMs(candidate.dir),
  ].join('\0')).join('\x01');

  return JSON.stringify({
    workspace: resolve(input.workspace),
    candidates: candidateSignature,
  });
}

/** Strip a leading `---\n...\n---` YAML frontmatter block, returning the body. */
function trimFrontMatter(content: string): string {
  if (!content.startsWith('---\n')) {
    return content;
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return content;
  }
  return content.slice(end + 5);
}

/** Parse a single .md command file into a descriptor, or null if invalid/skipped. */
function readCommandFile(filePath: string, source: CustomCommandSource): CustomCommandDescriptor | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {/* expected: skip unreadable file */
    coreLogger.warn(`custom-command: failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  // Parse YAML frontmatter using the `yaml` package (same as AgentDefinitionService).
  // Require a leading `---\n` fence with a closing `\n---` marker.
  if (!content.startsWith('---\n')) {
    return null;
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return null;
  }
  const frontmatterText = content.slice(4, end);

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (error) {
    coreLogger.warn(`custom-command: failed to parse frontmatter in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  const agent = typeof frontmatter.agent === 'string' ? frontmatter.agent.trim() : '';

  // Require all three fields (mirrors DistillCommand.hasRequiredFrontmatter command branch).
  if (!name || !description || !agent) {
    coreLogger.debug(`custom-command: skipping ${filePath} (missing name/description/agent frontmatter)`);
    return null;
  }

  const body = trimFrontMatter(content).trim();
  return {
    name,
    description,
    agent,
    slashName: `/${name}`,
    source,
    path: resolve(filePath),
    body,
  };
}

/** Scan one candidate directory for *.md command files. */
function collectMarkdownCommands(candidate: CustomCommandSourceCandidate): CustomCommandDescriptor[] {
  const { dir, source } = candidate;
  if (!existsSync(dir)) {
    return [];
  }

  const descriptors: CustomCommandDescriptor[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) {
      continue;
    }
    const fullPath = join(dir, entry);
    let isFile: boolean;
    try {
      isFile = statSync(fullPath).isFile();
    } catch {/* expected: skip unreadable entry */
      continue;
    }
    if (!isFile) {
      continue;
    }
    const descriptor = readCommandFile(fullPath, source);
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/**
 * Discover all custom commands for a workspace. Project files override global
 * files by name (project candidates are visited first). Results are sorted by
 * name for deterministic ordering. Cached with a 5s TTL keyed on workspace +
 * candidate-dir mtimes (mirrors SkillCatalog.collectAvailableSkills).
 */
export function collectCustomCommands(workspace: string): CustomCommandDescriptor[] {
  const candidates = getCustomCommandSourceCandidates(workspace);
  const cacheKey = buildCustomCommandCacheKey({ workspace, candidates });
  const cached = customCommandCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= CUSTOM_COMMAND_CACHE_TTL_MS) {
    return cloneCustomCommandDescriptors(cached.commands);
  }

  const byName = new Map<string, CustomCommandDescriptor>();
  for (const candidate of candidates) {
    for (const command of collectMarkdownCommands(candidate)) {
      // First occurrence wins → project (visited first) overrides global.
      if (!byName.has(command.name)) {
        byName.set(command.name, command);
      }
    }
  }

  const all = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  customCommandCache.set(cacheKey, {
    createdAt: Date.now(),
    commands: cloneCustomCommandDescriptors(all),
  });
  return cloneCustomCommandDescriptors(all);
}

/** Convert custom command descriptors into slash-command definitions for the registry. */
export function getCustomSlashCommands(workspace: string): SlashCommandDefinition[] {
  return collectCustomCommands(workspace).map((command) => ({
    name: command.slashName,
    desc: command.description,
    handledBy: 'callback' as const,
    category: 'tools' as const,
    includeInSuggestions: true,
    includeInHelp: true,
  }));
}

/** Look up a single custom command by name (with or without leading slash). */
export function findCustomCommand(workspace: string, name: string): CustomCommandDescriptor | null {
  const normalized = name.startsWith('/') ? name.slice(1) : name;
  const match = collectCustomCommands(workspace).find((command) => command.name === normalized);
  return match ? cloneCustomCommandDescriptor(match) : null;
}

/**
 * Render a command body by substituting `$ARGUMENTS` with the provided args
 * string. Empty/undefined args become an empty substitution. Deterministic —
 * no template engine, no fallback heuristics.
 */
export function renderCommandBody(descriptor: CustomCommandDescriptor, args: string | undefined): string {
  const substitution = args && args.trim().length > 0 ? args : '';
  return descriptor.body.replaceAll('$ARGUMENTS', substitution);
}

/** Test-only hook to reset the cache between unit tests. */
export function __resetCustomCommandCacheForTests(): void {
  customCommandCache.clear();
}
