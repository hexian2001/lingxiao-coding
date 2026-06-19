import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { getBundledSkillRegistry, getGlobalSkillsDir } from './BundledSkillRegistry.js';
import { getEnabledPluginSkillContributions } from './plugins/PluginStore.js';
import type { DatabaseManager } from './Database.js';
import type { AgentRole } from '../contracts/types/Agent.js';
import { SESSION_KEYS } from './SessionStateKeys.js';
import { SKILL_SELECTION_POLICY, isSkillDisabledByPolicy } from './SkillSelectionPolicy.js';
import { config as runtimeConfig } from '../config.js';
import {
  loadSkillPhases,
  hasQualityGates,
  type SkillPhase,
} from './SkillPhaseLoader.js';

export type SkillSource = 'project' | 'plugin' | 'global' | 'bundled';

export interface SkillPluginProvenance {
  id: string;
  version: string;
  path: string;
}

export interface SkillDescriptor {
  name: string;
  source: SkillSource;
  path: string;
  summary: string;
  contentPreview: string;
  plugin?: SkillPluginProvenance;
}

export interface SkillInjectionOptions {
  maxTotalChars?: number;
  maxPerSkillChars?: number;
}

export interface SkillCollectionOptions {
  disabledNames?: string[];
  disabledRefs?: string[];
  maxActive?: number;
}

export interface InjectedSkillSection {
  name: string;
  source: SkillSource;
  path: string;
  summary: string;
  plugin?: SkillPluginProvenance;
  includedChars: number;
  originalChars: number;
  truncated: boolean;
  body: string;
}

/** 分层技能描述符 — 包含 phases */
export interface ExtendedSkillDescriptor extends SkillDescriptor {
  phases: SkillPhase[];
  hasQualityGates: boolean;
}

export interface SkillSurfaceItem {
  id: string;
  status?: string;
  preview: string;
  detail: string;
}

export interface SkillSourceCandidate {
  dir: string;
  source: SkillSource;
  plugin?: SkillPluginProvenance;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

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

function extractSummary(content: string, fallbackName: string): string {
  const descriptionMatch = content.match(/^\s*description:\s*(.+)$/m);
  if (descriptionMatch?.[1]) {
    return descriptionMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  const body = trimFrontMatter(content);
  const firstMeaningfulLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('---'));

  if (!firstMeaningfulLine) {
    return fallbackName;
  }

  return firstMeaningfulLine.replace(/^#+\s*/, '').slice(0, 160);
}

function readSkillFile(path: string, fallbackName: string): SkillDescriptor | null {
  try {
    const content = readFileSync(path, 'utf-8');
    const summary = extractSummary(content, fallbackName);
    return {
      name: fallbackName,
      source: 'bundled',
      path,
      summary,
      contentPreview: trimFrontMatter(content).slice(0, 800),
    };
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function collectMarkdownSkills(candidate: SkillSourceCandidate): SkillDescriptor[] {
  const { dir, source, plugin } = candidate;
  if (!existsSync(dir)) {
    return [];
  }

  const descriptors: SkillDescriptor[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isFile() && entry.endsWith('.md')) {
      const name = entry.replace(/\.md$/, '');
      const descriptor = readSkillFile(fullPath, name);
      if (descriptor) {
        descriptor.source = source;
        descriptor.plugin = plugin;
        descriptors.push(descriptor);
      }
      continue;
    }

    if (stat.isDirectory()) {
      const skillPath = join(fullPath, 'SKILL.md');
      if (!existsSync(skillPath)) {
        continue;
      }
      const descriptor = readSkillFile(skillPath, basename(fullPath));
      if (descriptor) {
        descriptor.source = source;
        descriptor.plugin = plugin;
        descriptors.push(descriptor);
      }
    }
  }

  return descriptors;
}

export function getSkillSourceCandidates(workspace: string): SkillSourceCandidate[] {
  return [
    { dir: join(workspace, '.lingxiao', 'skills'), source: 'project' },
    ...getEnabledPluginSkillContributions(workspace).map((entry) => ({
      dir: entry.dir,
      source: 'plugin' as const,
      plugin: {
        id: entry.pluginId,
        version: entry.pluginVersion,
        path: entry.pluginPath,
      },
    })),
    { dir: getGlobalSkillsDir(), source: 'global' },
    ...getBundledSkillRegistry(workspace).map((entry) => ({
      dir: entry.dir,
      source: entry.source,
    })),
  ];
}

export function formatSkillSourceLabel(source: SkillSource): string {
  switch (source) {
    case 'project':
      return '项目';
    case 'plugin':
      return '插件';
    case 'global':
      return '全局';
    case 'bundled':
      return '内置';
    default:
      return source;
  }
}

export function getSkillDescriptorRef(skill: Pick<SkillDescriptor, 'name' | 'source' | 'plugin'>): string {
  if (skill.source === 'plugin' && skill.plugin?.id) {
    return `plugin:${skill.plugin.id}/${skill.name}`;
  }
  return `${skill.source}:${skill.name}`;
}

/** 同时启用的 skill 上限（前端可配置，通过 session_state 存储） */
const DEFAULT_MAX_ACTIVE_SKILLS = 30;
const SKILL_CATALOG_CACHE_TTL_MS = Number(process.env.LINGXIAO_SKILL_CATALOG_CACHE_TTL_MS || 5_000);

const skillCatalogCache = new Map<string, { createdAt: number; skills: SkillDescriptor[] }>();

function cloneSkillDescriptor(skill: SkillDescriptor): SkillDescriptor {
  return {
    ...skill,
    plugin: skill.plugin ? { ...skill.plugin } : undefined,
  };
}

function cloneSkillDescriptors(skills: SkillDescriptor[]): SkillDescriptor[] {
  return skills.map(cloneSkillDescriptor);
}

function sortedUnique(items: string[] | undefined): string[] {
  return Array.from(new Set((items || []).filter((item) => typeof item === 'string' && item.length > 0))).sort();
}

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {/* expected: fallback to default */
    return 0;
  }
}

function buildSkillCatalogCacheKey(input: {
  workspace: string;
  candidates: SkillSourceCandidate[];
  disabledNames: string[];
  disabledRefs: string[];
  maxActive: number;
}): string {
  const candidateSignature = input.candidates.map((candidate) => [
    resolve(candidate.dir),
    candidate.source,
    candidate.plugin?.id || '',
    candidate.plugin?.version || '',
    candidate.plugin?.path || '',
    statMtimeMs(candidate.dir),
  ].join('\0')).join('\x01');

  return JSON.stringify({
    workspace: resolve(input.workspace),
    candidates: candidateSignature,
    disabledNames: input.disabledNames,
    disabledRefs: input.disabledRefs,
    disabledByPolicy: sortedUnique(SKILL_SELECTION_POLICY.disabledSkillNames),
    maxActive: input.maxActive,
  });
}

function clearSkillCatalogCache(): void {
  skillCatalogCache.clear();
}

export function resolveDisabledSkillNames(): string[] {
  let settingsNames: string[] = [];
  try {
    const list = (runtimeConfig as { skills?: { disabled_names?: string[] } })?.skills?.disabled_names;
    if (Array.isArray(list)) settingsNames = list as string[];
  } catch {
    /* config 未初始化时忽略 */
  }

  return Array.from(new Set(settingsNames)).filter((name) => typeof name === 'string' && name.length > 0);
}

export function resolveDisabledSkillRefs(): string[] {
  try {
    const list = (runtimeConfig as { skills?: { disabled_refs?: string[] } })?.skills?.disabled_refs;
    if (Array.isArray(list)) {
      return Array.from(new Set(list)).filter((ref) => typeof ref === 'string' && ref.length > 0);
    }
  } catch {
    /* config unavailable */
  }
  return [];
}

export function collectAvailableSkills(workspace: string, options?: SkillCollectionOptions): SkillDescriptor[] {
  const candidates = getSkillSourceCandidates(workspace);
  const disabledNamesArray = sortedUnique(options?.disabledNames);
  const disabledRefsArray = sortedUnique(options?.disabledRefs ?? resolveDisabledSkillRefs());
  const disabledSet = new Set(disabledNamesArray);
  const disabledRefs = new Set(disabledRefsArray);
  const maxActive = options?.maxActive ?? DEFAULT_MAX_ACTIVE_SKILLS;
  const cacheKey = buildSkillCatalogCacheKey({
    workspace,
    candidates,
    disabledNames: disabledNamesArray,
    disabledRefs: disabledRefsArray,
    maxActive,
  });
  const cached = skillCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= SKILL_CATALOG_CACHE_TTL_MS) {
    return cloneSkillDescriptors(cached.skills);
  }

  const byName = new Map<string, SkillDescriptor>();

  for (const candidate of candidates) {
    for (const skill of collectMarkdownSkills(candidate)) {
      const disabledByRef = disabledRefs.has(getSkillDescriptorRef(skill));
      if (!byName.has(skill.name) && !disabledByRef && !isSkillDisabledByPolicy(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }

  const all = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  // 过滤禁用的 skills
  const filtered = disabledSet.size > 0
    ? all.filter(s => !disabledSet.has(s.name))
    : all;

  // 应用上限（project 级优先，其次 global，最后 bundled）
  const selected = filtered.slice(0, maxActive);
  skillCatalogCache.set(cacheKey, {
    createdAt: Date.now(),
    skills: cloneSkillDescriptors(selected),
  });
  return cloneSkillDescriptors(selected);
}

/**
 * 获取技能的分层描述符 — 包含 phases/paradigms/principles/contracts
 * 返回 null 表示该技能不存在
 */
export function getExtendedSkillDescriptor(workspace: string, skillName: string): ExtendedSkillDescriptor | null {
  const candidates = getSkillSourceCandidates(workspace);

  for (const candidate of candidates) {
    // 目录形式的技能
    const dirPath = join(candidate.dir, skillName);
    const skillMd = join(dirPath, 'SKILL.md');
    if (existsSync(dirPath) && statSync(dirPath).isDirectory() && existsSync(skillMd)) {
      const base = readSkillFile(skillMd, skillName);
      if (base) {
        base.source = candidate.source;
        base.plugin = candidate.plugin;
        const phases = loadSkillPhases(dirPath);
        return {
          ...base,
          phases,
          hasQualityGates: hasQualityGates(phases),
        };
      }
    }

    // 平铺 .md 形式的技能（无子目录，返回空扩展字段）
    const mdPath = join(candidate.dir, `${skillName}.md`);
    if (existsSync(mdPath) && statSync(mdPath).isFile()) {
      const base = readSkillFile(mdPath, skillName);
      if (base) {
        base.source = candidate.source;
        base.plugin = candidate.plugin;
        return {
          ...base,
          phases: [],
          hasQualityGates: false,
        };
      }
    }
  }

  return null;
}

export function getAvailableSkillEntries(workspace: string): Array<{ name: string; source: string; desc: string }> {
  return collectAvailableSkills(workspace).map((skill) => ({
    name: skill.name,
    source: formatSkillSourceLabel(skill.source),
    desc: skill.summary,
  }));
}

export function buildSkillSurfaceItems(workspace: string): SkillSurfaceItem[] {
  const candidates = getSkillSourceCandidates(workspace);
  const skills = collectAvailableSkills(workspace);
  const precedence = candidates.map((item) => formatSkillSourceLabel(item.source)).join(' > ');
  const bySource = new Map<SkillSource, SkillDescriptor[]>();

  for (const skill of skills) {
    const sourceItems = bySource.get(skill.source) || [];
    sourceItems.push(skill);
    bySource.set(skill.source, sourceItems);
  }

  const items: SkillSurfaceItem[] = [
    {
      id: 'overview',
      status: `${skills.length} skills`,
      preview: `优先级: ${precedence}`,
      detail: [
        '[Skills Overview]',
        `total: ${skills.length}`,
        `precedence: ${precedence}`,
      ].join('\n'),
    },
  ];

  const sourceSummaries = new Map<SkillSource, { label: string; dirs: string[]; skills: SkillDescriptor[] }>();
  for (const candidate of candidates) {
    const sourceLabel = formatSkillSourceLabel(candidate.source);
    const summary = sourceSummaries.get(candidate.source) || {
      label: sourceLabel,
      dirs: [],
      skills: bySource.get(candidate.source) || [],
    };
    summary.dirs.push(candidate.plugin ? `${candidate.dir} (${candidate.plugin.id}@${candidate.plugin.version})` : candidate.dir);
    sourceSummaries.set(candidate.source, summary);
  }

  for (const [source, summary] of sourceSummaries) {
    items.push({
      id: source,
      status: `${summary.skills.length} skills`,
      preview: `${summary.label} · ${summary.dirs.slice(0, 2).join(' | ')}${summary.dirs.length > 2 ? ` (+${summary.dirs.length - 2})` : ''}`,
      detail: [
        `[${summary.label}]`,
        `path: ${summary.dirs.join(' | ') || '(none)'}`,
        `count: ${summary.skills.length}`,
        `precedence: ${precedence}`,
        `examples: ${summary.skills.slice(0, 8).map((skill) => skill.name).join(', ') || '(none)'}`,
      ].join('\n'),
    });
  }

  return items;
}

export function buildRoleSkillSurfaceItems(
  db: Pick<DatabaseManager, 'getSessionState'> | undefined,
  sessionId: string,
): SkillSurfaceItem[] {
  if (!db) {
    return [];
  }

  const customRoles = db.getSessionState(sessionId, SESSION_KEYS.CUSTOM_ROLES);
  const parsedRoles = typeof customRoles === 'string'
    ? (() => {
        try {
          return JSON.parse(customRoles) as Record<string, AgentRole>;
        } catch {/* expected: operation may fail gracefully */
          return null;
        }
      })()
    : customRoles && typeof customRoles === 'object'
      ? customRoles as Record<string, AgentRole>
      : null;

  if (!parsedRoles || Object.keys(parsedRoles).length === 0) {
    return [];
  }

  return Object.values(parsedRoles).map((role) => ({
    id: role.name,
    status: role.capabilityProfile?.baselineRole || role.capabilityProfile?.source || role.createdBy,
    preview: `${role.skillNames?.join(', ') || '(no skills)'} · ${role.tools.join(', ')}`,
    detail: [
      `[Role Skills: ${role.name}]`,
      `baseline: ${role.capabilityProfile?.baselineRole || '(custom)'}`,
      `source: ${role.capabilityProfile?.source || role.createdBy}`,
      `tiers: ${role.capabilityProfile?.allowedTiers?.join('/') || '(unknown)'}`,
      `skill_priority: ${role.capabilityProfile?.skillPriority?.join(' > ') || '(unset)'}`,
      `skills: ${role.skillNames?.join(', ') || '(none)'}`,
      `tools: ${role.tools.join(', ')}`,
      `dropped_tools: ${role.droppedTools?.join(', ') || '(none)'}`,
    ].join('\n'),
  }));
}

export function buildSkillDigest(skills: SkillDescriptor[]): string {
  if (skills.length === 0) {
    return '暂无可用 skills。';
  }

  return [
    '以下是当前工作区可用 skills 的摘要。你可以根据请求、角色职责和工具需求智能选择多个 skills 注入团队成员。',
    ...SKILL_SELECTION_POLICY.digestGuidance,
    '路径规则：每个 skill 的真实文件路径见 path 字段；需要完整内容时读取该真实 path。',
    ...skills.map((skill) => {
      const provenance = skill.plugin ? ` plugin=${skill.plugin.id}@${skill.plugin.version}` : '';
      return `- ${skill.name} [${skill.source}] ref=${getSkillDescriptorRef(skill)}${provenance} path=${skill.path}: ${skill.summary}`;
    }),
  ].join('\n');
}

function getSkillMap(skills: SkillDescriptor[]): Map<string, SkillDescriptor> {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

function resolveSkillName(name: string, skills: SkillDescriptor[]): string | null {
  if (skills.some(s => s.name === name)) return name;
  return null;
}

export function parseExplicitSkillMentions(text: string): string[] {
  return unique(Array.from(text.matchAll(/\$([a-zA-Z0-9_][a-zA-Z0-9_-]*)/g)).map((match) => match[1]));
}

export function resolveExplicitSkillMentions(text: string, skills: SkillDescriptor[]): string[] {
  const mentions = parseExplicitSkillMentions(text);
  return unique(mentions.map(m => resolveSkillName(m, skills)).filter(Boolean) as string[]);
}

export function buildSkillInjection(
  skillNames: string[],
  skills: SkillDescriptor[],
  options: SkillInjectionOptions = {},
): { names: string[]; sections: InjectedSkillSection[]; content: string } {
  const skillMap = getSkillMap(skills);
  const names: string[] = [];
  const sections: InjectedSkillSection[] = [];
  const maxTotalChars = options.maxTotalChars ?? 18_000;
  const maxPerSkillChars = options.maxPerSkillChars ?? 7_500;
  let remaining = maxTotalChars;

  for (const skillName of unique(skillNames)) {
    const descriptor = skillMap.get(skillName);
    if (!descriptor) {
      continue;
    }

    try {
      const content = readFileSync(descriptor.path, 'utf-8');
      names.push(skillName);
      const body = trimFrontMatter(content);
      const budget = Math.max(0, Math.min(maxPerSkillChars, remaining));
      if (budget <= 0) {
        sections.push({
          name: skillName,
          source: descriptor.source,
          path: descriptor.path,
          summary: descriptor.summary,
          plugin: descriptor.plugin,
          includedChars: 0,
          originalChars: body.length,
          truncated: true,
          body: '',
        });
        continue;
      }
      const clipped = body.length > budget;
      const injectedBody = clipped ? body.slice(0, budget) : body;
      remaining -= injectedBody.length;
      sections.push({
        name: skillName,
        source: descriptor.source,
        path: descriptor.path,
        summary: descriptor.summary,
        plugin: descriptor.plugin,
        includedChars: injectedBody.length,
        originalChars: body.length,
        truncated: clipped,
        body: injectedBody,
      });
    } catch {/* expected: skip invalid entry */
      continue;
    }
  }

  return {
    names,
    sections,
    content: renderSkillInjectionSections(sections),
  };
}

function renderSkillInjectionSections(sections: InjectedSkillSection[]): string {
  return sections.map((section) => [
    `<skill name="${section.name}" source="${section.source}" path="${section.path}">`,
    `summary: ${section.summary}`,
    section.plugin ? `plugin: ${section.plugin.id}@${section.plugin.version}` : '',
    section.plugin ? `plugin_path: ${section.plugin.path}` : '',
    `included_chars: ${section.includedChars}`,
    `original_chars: ${section.originalChars}`,
    `truncated: ${section.truncated ? 'true' : 'false'}`,
    'body:',
    section.body || '(not expanded; read path for details if needed)',
    section.truncated ? `[truncated ${Math.max(0, section.originalChars - section.includedChars)} chars; read path and referenced files for complete workflow]` : '',
    '</skill>',
  ].filter(Boolean).join('\n')).join('\n\n');
}
