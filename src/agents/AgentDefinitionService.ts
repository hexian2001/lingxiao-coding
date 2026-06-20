/**
 * AgentDefinitionService
 *
 * Canonical persistence for user-defined agents. The runtime still dispatches
 * AgentRole, but custom definitions live as readable markdown files:
 *
 *   .lingxiao/agents/<name>.md
 *
 * YAML frontmatter stores structured fields; the markdown body is the system
 * prompt. Project definitions override global definitions with the same name.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { AgentRole } from './RoleRegistry.js';
import { WORKER_TOOLS, PRESET_ROLE_PROFILES, resolveDynamicRoleCapability, type PresetRoleName } from './RoleCapabilityModel.js';
import type { SkillDescriptor } from '../core/SkillCatalog.js';
import { coreLogger } from '../core/Log.js';

export type AgentDefinitionScope = 'project' | 'global';
export type AgentDefinitionSource = AgentDefinitionScope;
export type AgentWorkerBackend = 'worker_process' | 'claude' | 'codex';

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  skillNames: string[];
  baseRoleName?: PresetRoleName;
  model?: string;
  worker_backend?: AgentWorkerBackend;
  worker_config?: AgentRole['worker_config'];
  gitIdentity?: {
    name: string;
    email: string;
  };
}

export interface AgentDefinitionRecord extends AgentDefinition {
  source: AgentDefinitionSource;
  path: string;
  editable: boolean;
  shadowedBy?: AgentDefinitionSource;
  updatedAt?: number;
}

export interface SaveAgentDefinitionInput {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  skillNames?: string[];
  baseRoleName?: string;
  model?: string;
  worker_backend?: AgentWorkerBackend;
  worker_config?: AgentRole['worker_config'];
  gitIdentity?: {
    name: string;
    email: string;
  };
  scope?: AgentDefinitionScope;
}

export interface AgentDefinitionServiceOptions {
  workspace?: string;
  globalAgentsDir?: string;
}

const VALID_AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const WorkerConfigSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  extra_args: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  idle_timeout_ms: z.number().int().positive().optional(),
  wire_api: z.enum(['chat', 'responses']).optional(),
  no_bare: z.boolean().optional(),
}).strict();

const GitIdentitySchema = z.object({
  name: z.string(),
  email: z.string(),
}).optional();

const AgentDefinitionFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().default(''),
  baseRole: z.string().optional(),
  baseRoleName: z.string().optional(),
  model: z.string().optional(),
  workerBackend: z.enum(['worker_process', 'claude', 'codex']).optional(),
  worker_backend: z.enum(['worker_process', 'claude', 'codex']).optional(),
  tools: z.array(z.string()).optional(),
  skillNames: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  worker_config: WorkerConfigSchema.optional(),
  workerConfig: WorkerConfigSchema.optional(),
  gitIdentity: GitIdentitySchema,
  git_identity: GitIdentitySchema,
}).passthrough();

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function cleanOneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

export function validateAgentDefinitionName(name: string): string {
  const trimmed = name.trim().replace(/\.md$/i, '');
  if (trimmed.includes('/') || trimmed.includes('\\') || basename(trimmed) !== trimmed) {
    throw new Error('Invalid agent name. Do not include paths.');
  }
  if (!VALID_AGENT_NAME_RE.test(trimmed)) {
    throw new Error('Invalid agent name. Use 2-64 chars: letters, numbers, hyphen, underscore; start with a letter.');
  }
  return trimmed;
}

function parsePresetRoleName(value: string | undefined): PresetRoleName | undefined {
  if (!value) return undefined;
  return value in PRESET_ROLE_PROFILES ? value as PresetRoleName : undefined;
}

function defaultAgentsDir(workspace: string, scope: AgentDefinitionScope, globalAgentsDir?: string): string {
  return scope === 'project'
    ? join(resolve(workspace), '.lingxiao', 'agents')
    : resolve(globalAgentsDir ?? join(homedir(), '.lingxiao', 'agents'));
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

function renderDefinitionMarkdown(definition: AgentDefinition): string {
  const frontmatter: Record<string, unknown> = {
    name: definition.name,
    description: cleanOneLine(definition.description),
  };
  if (definition.baseRoleName) frontmatter.baseRole = definition.baseRoleName;
  if (definition.model) frontmatter.model = definition.model;
  if (definition.worker_backend && definition.worker_backend !== 'worker_process') {
    frontmatter.workerBackend = definition.worker_backend;
  }
  if (definition.worker_config && Object.keys(definition.worker_config).length > 0) {
    frontmatter.worker_config = definition.worker_config;
  }
  if (definition.tools.length > 0) frontmatter.tools = definition.tools;
  if (definition.skillNames.length > 0) frontmatter.skillNames = definition.skillNames;
  if (definition.gitIdentity) frontmatter.gitIdentity = definition.gitIdentity;

  return [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    definition.systemPrompt.trim(),
    '',
  ].join('\n');
}

function normalizeDefinition(input: SaveAgentDefinitionInput): AgentDefinition {
  const name = validateAgentDefinitionName(input.name);
  const description = cleanOneLine(input.description || '');
  if (!description) {
    throw new Error('Agent description is required.');
  }
  const systemPrompt = input.systemPrompt.trim();
  if (!systemPrompt) {
    throw new Error('Agent systemPrompt is required.');
  }
  const baseRoleName = parsePresetRoleName(input.baseRoleName);
  if (input.baseRoleName && !baseRoleName) {
    throw new Error(`Unknown baseRoleName: ${input.baseRoleName}`);
  }
  return {
    name,
    description,
    systemPrompt,
    tools: unique(input.tools ?? []),
    skillNames: unique(input.skillNames ?? []),
    baseRoleName,
    model: input.model?.trim() || undefined,
    worker_backend: input.worker_backend ?? 'worker_process',
    worker_config: input.worker_config,
    gitIdentity: input.gitIdentity,
  };
}

function parseDefinitionFile(path: string, fallbackName: string, source: AgentDefinitionSource): AgentDefinitionRecord | null {
  const raw = readFileSync(path, 'utf-8');
  const { meta, body } = stripFrontmatter(raw);
  const parsed = AgentDefinitionFrontmatterSchema.safeParse(meta);
  if (!parsed.success) {
    throw new Error(`Invalid agent definition frontmatter in ${path}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  const fm = parsed.data;
  const name = validateAgentDefinitionName(fm.name || fallbackName);
  const description = cleanOneLine(fm.description || '');
  if (!description || !body.trim()) {
    return null;
  }
  const baseRoleName = parsePresetRoleName(fm.baseRoleName || fm.baseRole);
  const stat = statSync(path);
  return {
    name,
    description,
    systemPrompt: body.trim(),
    tools: unique(fm.tools ?? []),
    skillNames: unique(fm.skillNames ?? fm.skills ?? []),
    baseRoleName,
    model: fm.model?.trim() || undefined,
    worker_backend: fm.worker_backend ?? fm.workerBackend ?? 'worker_process',
    worker_config: fm.worker_config ?? fm.workerConfig,
    gitIdentity: fm.gitIdentity ?? fm.git_identity,
    source,
    path,
    editable: true,
    updatedAt: stat.mtimeMs,
  };
}

export class AgentDefinitionService {
  private readonly workspace: string;
  private readonly globalAgentsDir?: string;

  constructor(options: AgentDefinitionServiceOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd());
    this.globalAgentsDir = options.globalAgentsDir;
  }

  getAgentsDir(scope: AgentDefinitionScope): string {
    return defaultAgentsDir(this.workspace, scope, this.globalAgentsDir);
  }

  listDefinitions(options: { includeShadowed?: boolean } = {}): AgentDefinitionRecord[] {
    const records: AgentDefinitionRecord[] = [];
    for (const source of ['global', 'project'] as const) {
      const dir = this.getAgentsDir(source);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue;
        const path = join(dir, entry);
        if (!statSync(path).isFile()) continue;
        // Per-file guard: one malformed/hand-edited agent file (bad frontmatter or a
        // name the loader rejects) must not crash the whole registry build — that would
        // take down session startup. Skip + warn, keep loading the rest.
        let record: AgentDefinitionRecord | null;
        try {
          record = parseDefinitionFile(path, entry.replace(/\.md$/i, ''), source);
        } catch (err) {
          coreLogger.warn(`[AgentDefinitionService] Skipping malformed agent definition ${path}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        if (record) records.push(record);
      }
    }

    const byName = new Map<string, AgentDefinitionRecord>();
    const shadowed: AgentDefinitionRecord[] = [];
    for (const record of records.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })) {
      if (!byName.has(record.name)) {
        byName.set(record.name, record);
      } else {
        shadowed.push({ ...record, shadowedBy: byName.get(record.name)?.source });
      }
    }

    const visible = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    return options.includeShadowed
      ? [...visible, ...shadowed.sort((a, b) => a.name.localeCompare(b.name))]
      : visible;
  }

  getDefinition(name: string, options: { includeShadowed?: boolean } = {}): AgentDefinitionRecord | null {
    const normalized = validateAgentDefinitionName(name);
    return this.listDefinitions(options).find((record) => record.name === normalized) ?? null;
  }

  getDefinitionInScope(name: string, scope: AgentDefinitionScope): AgentDefinitionRecord | null {
    const normalized = validateAgentDefinitionName(name);
    const path = join(this.getAgentsDir(scope), `${normalized}.md`);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return parseDefinitionFile(path, normalized, scope);
  }

  saveDefinition(input: SaveAgentDefinitionInput): AgentDefinitionRecord {
    const scope = input.scope ?? 'project';
    const definition = normalizeDefinition(input);
    const dir = this.getAgentsDir(scope);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${definition.name}.md`);
    writeFileSync(path, renderDefinitionMarkdown(definition), 'utf-8');
    return {
      ...definition,
      source: scope,
      path,
      editable: true,
      updatedAt: statSync(path).mtimeMs,
    };
  }

  deleteDefinition(name: string, scope: AgentDefinitionScope = 'project'): boolean {
    const normalized = validateAgentDefinitionName(name);
    const path = join(this.getAgentsDir(scope), `${normalized}.md`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  toAgentRole(record: AgentDefinitionRecord, availableSkills: SkillDescriptor[] = []): AgentRole {
    const resolved = resolveDynamicRoleCapability({
      roleName: record.name,
      roleDescription: record.description,
      systemPrompt: record.systemPrompt,
      requestedTools: record.tools.length > 0 ? record.tools : WORKER_TOOLS,
      availableSkills,
      requestedSkillNames: record.skillNames,
      baseRoleName: record.baseRoleName,
    });
    return {
      name: record.name,
      description: record.description,
      systemPrompt: record.systemPrompt,
      tools: resolved.tools,
      droppedTools: resolved.droppedTools,
      skillNames: resolved.skillNames,
      capabilityProfile: resolved.capabilityProfile,
      model: record.model,
      worker_backend: record.worker_backend,
      worker_config: record.worker_config,
      gitIdentity: record.gitIdentity,
      createdBy: 'user',
    };
  }

  listAgentRoles(availableSkills: SkillDescriptor[] = []): AgentRole[] {
    return this.listDefinitions().map((record) => this.toAgentRole(record, availableSkills));
  }
}

export default AgentDefinitionService;
