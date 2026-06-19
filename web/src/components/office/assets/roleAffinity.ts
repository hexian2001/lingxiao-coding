export type RoleCapabilityTag =
  | 'worker'
  | 'general'
  | 'implement'
  | 'coder'
  | 'plan'
  | 'lead'
  | 'architect'
  | 'tool'
  | 'terminal'
  | 'debug'
  | 'review'
  | 'test'
  | 'qa'
  | 'monitor'
  | 'observe'
  | 'status'
  | 'research'
  | 'explore';

export type RoleColorKey = 'research' | 'explore' | 'coding' | 'implement' | 'plan' | 'leader' | 'review' | 'test' | 'default';

const AFFINITY_TAGS: ReadonlySet<RoleCapabilityTag> = new Set([
  'worker',
  'general',
  'implement',
  'coder',
  'plan',
  'lead',
  'architect',
  'tool',
  'terminal',
  'debug',
  'review',
  'test',
  'qa',
  'monitor',
  'observe',
  'status',
  'research',
  'explore',
]);

const ROLE_TAG_ALIASES: Readonly<Record<string, readonly RoleCapabilityTag[]>> = {
  worker: ['worker', 'general'],
  general: ['general'],

  coding: ['implement', 'coder', 'general'],
  code: ['implement', 'coder', 'general'],
  coder: ['implement', 'coder', 'general'],
  developer: ['implement', 'coder', 'general'],
  dev: ['implement', 'coder', 'general'],
  implement: ['implement', 'coder', 'general'],
  implementer: ['implement', 'coder', 'general'],
  frontend: ['implement', 'coder', 'general'],
  backend: ['implement', 'coder', 'general'],
  fullstack: ['implement', 'coder', 'general'],

  plan: ['plan', 'lead'],
  planner: ['plan', 'lead'],
  planning: ['plan', 'lead'],
  lead: ['lead', 'plan'],
  leader: ['lead', 'plan'],
  architect: ['architect', 'plan'],

  tool: ['tool', 'terminal', 'debug'],
  tooling: ['tool', 'terminal', 'debug'],
  terminal: ['terminal', 'tool'],
  debug: ['debug', 'tool'],
  debugger: ['debug', 'tool'],
  devops: ['tool', 'terminal', 'debug'],

  review: ['review', 'qa'],
  reviewer: ['review', 'qa'],
  code_reviewer: ['review', 'qa'],
  codereviewer: ['review', 'qa'],
  security_reviewer: ['review', 'qa'],
  securityreviewer: ['review', 'qa'],
  evaluate: ['review', 'qa'],
  evaluator: ['review', 'qa'],
  verify: ['test', 'qa', 'review'],
  verifier: ['test', 'qa', 'review'],
  test: ['test', 'qa'],
  tester: ['test', 'qa'],
  qa: ['qa', 'test'],

  monitor: ['monitor', 'observe', 'status'],
  observability: ['observe', 'monitor', 'status'],
  observer: ['observe', 'monitor', 'status'],
  observe: ['observe', 'monitor', 'status'],
  status: ['status', 'monitor'],
  watchdog: ['monitor', 'status'],

  research: ['research', 'explore'],
  researcher: ['research', 'explore'],
  explore: ['explore', 'research'],
  explorer: ['explore', 'research'],
  analysis: ['research'],
  analyst: ['research'],
  ux: ['research', 'review'],
  designer: ['research', 'review'],
  ux_designer: ['research', 'review'],
  uxdesigner: ['research', 'review'],
};

const ROLE_COLOR_ALIASES: Readonly<Record<string, RoleColorKey>> = {
  research: 'research',
  researcher: 'research',
  analysis: 'research',
  analyst: 'research',
  explore: 'explore',
  explorer: 'explore',
  coding: 'coding',
  code: 'coding',
  coder: 'coding',
  developer: 'coding',
  dev: 'coding',
  frontend: 'coding',
  backend: 'coding',
  fullstack: 'coding',
  implement: 'implement',
  implementer: 'implement',
  plan: 'plan',
  planner: 'plan',
  planning: 'plan',
  architect: 'plan',
  lead: 'leader',
  leader: 'leader',
  review: 'review',
  reviewer: 'review',
  code_reviewer: 'review',
  codereviewer: 'review',
  security_reviewer: 'review',
  securityreviewer: 'review',
  evaluate: 'review',
  evaluator: 'review',
  verify: 'test',
  verifier: 'test',
  test: 'test',
  tester: 'test',
  qa: 'test',
};

function roleWords(role: string | undefined): string[] {
  const expanded = (role || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return expanded.split(/[^a-z0-9]+/).filter(Boolean);
}

export function normalizeRole(role: string | undefined): string {
  return roleWords(role).join('_');
}

function compactRole(role: string | undefined): string {
  return roleWords(role).join('');
}

function tagsForAlias(key: string): readonly RoleCapabilityTag[] {
  return ROLE_TAG_ALIASES[key] ?? [];
}

export function getRoleCapabilityTags(role: string | undefined): ReadonlySet<RoleCapabilityTag> {
  const tags = new Set<RoleCapabilityTag>();
  const words = roleWords(role);
  const normalized = words.join('_');
  const compact = words.join('');

  const exactTags = tagsForAlias(normalized);
  if (exactTags.length) return new Set(exactTags);
  if (compact !== normalized) {
    const compactTags = tagsForAlias(compact);
    if (compactTags.length) return new Set(compactTags);
  }
  for (const word of words) {
    for (const tag of tagsForAlias(word)) tags.add(tag);
  }

  return tags;
}

export function normalizeRoleAffinity(affinity: string | undefined): RoleCapabilityTag | null {
  const normalized = normalizeRole(affinity);
  if (AFFINITY_TAGS.has(normalized as RoleCapabilityTag)) return normalized as RoleCapabilityTag;

  const compact = compactRole(affinity);
  const aliases = tagsForAlias(normalized);
  if (aliases[0]) return aliases[0];
  const compactAliases = compact !== normalized ? tagsForAlias(compact) : [];
  return compactAliases[0] ?? null;
}

export function roleMatchesAnyAffinity(role: string | undefined, affinities: readonly string[] | undefined): boolean {
  if (!affinities?.length) return false;
  const tags = getRoleCapabilityTags(role);
  for (const affinity of affinities) {
    const tag = normalizeRoleAffinity(affinity);
    if (tag && tags.has(tag)) return true;
  }
  return false;
}

export function getRoleColorKey(role: string | undefined): RoleColorKey {
  const normalized = normalizeRole(role);
  const compact = compactRole(role);
  const exact = ROLE_COLOR_ALIASES[normalized] ?? ROLE_COLOR_ALIASES[compact];
  if (exact) return exact;

  const tags = getRoleCapabilityTags(role);
  if (tags.has('research')) return 'research';
  if (tags.has('explore')) return 'explore';
  if (tags.has('implement') || tags.has('coder')) return 'coding';
  if (tags.has('lead')) return 'leader';
  if (tags.has('plan') || tags.has('architect')) return 'plan';
  if (tags.has('review')) return 'review';
  if (tags.has('test') || tags.has('qa')) return 'test';
  return 'default';
}
