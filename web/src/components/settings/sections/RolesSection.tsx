import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, Loader2, Pencil, Plus, RotateCcw, Save, Trash2, Users, X } from 'lucide-react';
import ConfirmationDialog from '../../ui/ConfirmationDialog';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { settingsApiFetch } from '../settingsApi';

type JsonRecord = Record<string, unknown>;
type RoleSource = 'preset' | 'custom';
type CustomAgentScope = 'project' | 'global';
type CustomAgentMode = 'create' | 'edit';

interface RoleDefinitionMeta {
  source: CustomAgentScope | 'runtime';
  path?: string;
  editable: boolean;
  updatedAt?: number;
  tools: string[];
  skillNames: string[];
}

interface RoleSurfaceItem {
  name: string;
  description: string;
  source: RoleSource;
  baselineRole?: string;
  allowedTiers: string[];
  tools: string[];
  profileTools: string[];
  override: { tools_added: string[]; tools_removed: string[] };
  skillNames: string[];
  workerBackend?: string;
  model?: string;
  systemPrompt?: string;
  definition?: RoleDefinitionMeta;
}

interface RolesPayload {
  basic_tools_enabled: boolean;
  basic_tools: string[];
  roles: RoleSurfaceItem[];
  custom_agent_dirs: {
    project?: string;
    global?: string;
  };
}

interface ToolCatalogItem {
  name: string;
  enabled?: boolean;
  readOnly?: boolean;
}

type ConfirmAction =
  | { kind: 'remove'; roleName: string; tool: string }
  | { kind: 'reset'; roleName: string }
  | { kind: 'delete_agent'; roleName: string; scope: CustomAgentScope };

interface AgentFormState {
  mode: CustomAgentMode;
  originalName?: string;
  name: string;
  description: string;
  scope: CustomAgentScope;
  baseRoleName: string;
  model: string;
  workerBackend: string;
  toolsText: string;
  skillsText: string;
  systemPrompt: string;
}

const ROLE_SOURCE_VALUES = ['preset', 'custom'] as const satisfies readonly RoleSource[];
const ROLE_SOURCE_SET = new Set<RoleSource>(ROLE_SOURCE_VALUES);
const DEFAULT_WORKER_BACKEND = 'worker_process';
const BASE_ROLE_OPTIONS = [
  '',
  'research',
  'coding',
  'verify',
  'review',
  'frontend',
  'backend',
  'fullstack',
  'qa',
  'ux_designer',
  'planner',
  'evaluator',
  'architect',
];

const emptyAgentForm: AgentFormState = {
  mode: 'create',
  name: '',
  description: '',
  scope: 'project',
  baseRoleName: '',
  model: '',
  workerBackend: DEFAULT_WORKER_BACKEND,
  toolsText: '',
  skillsText: '',
  systemPrompt: '',
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readCsvText(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)));
}

function writeCsvText(values: string[]): string {
  return values.join(', ');
}

function parseRoleSource(value: unknown): RoleSource {
  return typeof value === 'string' && ROLE_SOURCE_SET.has(value as RoleSource) ? value as RoleSource : 'custom';
}

function parseRoleOverride(value: unknown): RoleSurfaceItem['override'] {
  if (!isRecord(value)) return { tools_added: [], tools_removed: [] };
  return {
    tools_added: readStringArray(value.tools_added),
    tools_removed: readStringArray(value.tools_removed),
  };
}

function parseRoleDefinition(value: unknown): RoleDefinitionMeta | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source === 'global' || value.source === 'project' || value.source === 'runtime'
    ? value.source
    : 'runtime';
  return {
    source,
    path: readOptionalString(value.path),
    editable: readBoolean(value.editable, false),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    tools: readStringArray(value.tools),
    skillNames: readStringArray(value.skillNames),
  };
}

function parseRoleSurfaceItem(value: unknown): RoleSurfaceItem | null {
  if (!isRecord(value)) return null;
  const name = readString(value.name).trim();
  if (!name) return null;
  return {
    name,
    description: readString(value.description),
    source: parseRoleSource(value.source),
    baselineRole: readOptionalString(value.baselineRole),
    allowedTiers: readStringArray(value.allowedTiers),
    tools: readStringArray(value.tools),
    profileTools: readStringArray(value.profileTools),
    override: parseRoleOverride(value.override),
    skillNames: readStringArray(value.skillNames),
    workerBackend: readOptionalString(value.workerBackend),
    model: readOptionalString(value.model),
    systemPrompt: readString(value.systemPrompt),
    definition: parseRoleDefinition(value.definition),
  };
}

function parseRolesPayload(value: unknown): RolesPayload {
  if (!isRecord(value)) return { basic_tools_enabled: true, basic_tools: [], roles: [], custom_agent_dirs: {} };
  const roles = Array.isArray(value.roles)
    ? value.roles.flatMap((item) => {
      const parsed = parseRoleSurfaceItem(item);
      return parsed ? [parsed] : [];
    })
    : [];
  const customDirs = isRecord(value.custom_agent_dirs) ? value.custom_agent_dirs : {};
  return {
    basic_tools_enabled: readBoolean(value.basic_tools_enabled, true),
    basic_tools: readStringArray(value.basic_tools),
    roles,
    custom_agent_dirs: {
      project: readOptionalString(customDirs.project),
      global: readOptionalString(customDirs.global),
    },
  };
}

function parseRolesResponse(value: unknown): RolesPayload {
  return isRecord(value) && 'data' in value ? parseRolesPayload(value.data) : parseRolesPayload(value);
}

function parseToolCatalogItem(value: unknown): ToolCatalogItem | null {
  if (!isRecord(value)) return null;
  const name = readString(value.name).trim();
  if (!name) return null;
  return {
    name,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    readOnly: typeof value.readOnly === 'boolean' ? value.readOnly : undefined,
  };
}

function parseToolCatalogResponse(value: unknown): ToolCatalogItem[] {
  const rawTools = isRecord(value) ? value.tools : undefined;
  if (!Array.isArray(rawTools)) return [];
  return rawTools.flatMap((item) => {
    const parsed = parseToolCatalogItem(item);
    return parsed ? [parsed] : [];
  });
}

function roleSourceClass(source: RoleSource): string {
  return source === 'preset' ? 'bg-accent-blue/20 text-accent-blue' : 'bg-accent-purple/20 text-accent-purple';
}

function formFromRole(role: RoleSurfaceItem): AgentFormState {
  const definition = role.definition;
  const scope = definition?.source === 'global' ? 'global' : 'project';
  return {
    mode: 'edit',
    originalName: role.name,
    name: role.name,
    description: role.description,
    scope,
    baseRoleName: role.baselineRole ?? '',
    model: role.model ?? '',
    workerBackend: role.workerBackend ?? DEFAULT_WORKER_BACKEND,
    toolsText: writeCsvText(definition?.tools ?? []),
    skillsText: writeCsvText(definition?.skillNames ?? []),
    systemPrompt: role.systemPrompt ?? '',
  };
}

export function RolesSection() {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<RolesPayload | null>(null);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [restartHint, setRestartHint] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toolDrafts, setToolDrafts] = useState<Record<string, string>>({});
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [agentForm, setAgentForm] = useState<AgentFormState>(emptyAgentForm);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await settingsApiFetch<unknown>('/roles');
      setPayload(parseRolesResponse(data));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.roles.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadToolCatalog = useCallback(async () => {
    try {
      const data = await settingsApiFetch<unknown>('/tools');
      setToolCatalog(parseToolCatalogResponse(data));
    } catch {
      setToolCatalog([]);
    }
  }, []);

  useEffect(() => {
    load();
    loadToolCatalog();
  }, [load, loadToolCatalog]);

  const knownTools = useMemo(() => {
    const names = new Set<string>();
    if (payload) {
      payload.basic_tools.forEach((tool) => names.add(tool));
      payload.roles.forEach((role) => {
        role.tools.forEach((tool) => names.add(tool));
        role.profileTools.forEach((tool) => names.add(tool));
        role.override.tools_added.forEach((tool) => names.add(tool));
        role.override.tools_removed.forEach((tool) => names.add(tool));
      });
    }
    toolCatalog
      .filter((tool) => tool.name && tool.enabled !== false && !tool.readOnly)
      .forEach((tool) => names.add(tool.name));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [payload, toolCatalog]);

  const customRoles = useMemo(
    () => payload?.roles.filter((role) => role.source === 'custom' && role.definition?.editable) ?? [],
    [payload],
  );

  const updateAgentForm = (patch: Partial<AgentFormState>) => {
    setAgentForm((prev) => ({ ...prev, ...patch }));
  };

  const resetAgentForm = () => {
    setAgentForm(emptyAgentForm);
  };

  const toggleBasic = async (next: boolean) => {
    setBusyRole('__settings__');
    try {
      await settingsApiFetch('/roles/settings', {
        method: 'PATCH',
        body: JSON.stringify({ basic_tools_enabled: next }),
      });
      setRestartHint(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.roles.error.saveFailed'));
    } finally {
      setBusyRole(null);
    }
  };

  const updateRoleTool = async (
    roleName: string,
    op: 'add' | 'remove' | 'undo_add' | 'undo_remove',
    tool: string,
  ) => {
    if (!payload) return;
    const role = payload.roles.find((r) => r.name === roleName);
    if (!role) return;
    const added = new Set(role.override.tools_added);
    const removed = new Set(role.override.tools_removed);
    if (op === 'add') {
      added.add(tool);
      removed.delete(tool);
    } else if (op === 'remove') {
      removed.add(tool);
      added.delete(tool);
    } else if (op === 'undo_add') {
      added.delete(tool);
    } else if (op === 'undo_remove') {
      removed.delete(tool);
    }
    setBusyRole(roleName);
    try {
      await settingsApiFetch(`/roles/${encodeURIComponent(roleName)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tools_added: Array.from(added),
          tools_removed: Array.from(removed),
        }),
      });
      setRestartHint(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.roles.error.saveFailed'));
    } finally {
      setBusyRole(null);
    }
  };

  const resetRole = async (roleName: string) => {
    setBusyRole(roleName);
    try {
      await settingsApiFetch(`/roles/${encodeURIComponent(roleName)}/override`, { method: 'DELETE' });
      setRestartHint(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.roles.error.resetFailed'));
    } finally {
      setBusyRole(null);
    }
  };

  const toggleExpand = (roleName: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(roleName)) next.delete(roleName);
      else next.add(roleName);
      return next;
    });
  };

  const addToolToRole = async (role: RoleSurfaceItem, tool: string) => {
    const trimmed = tool.trim();
    if (!trimmed) return;
    const op = new Set(role.override.tools_removed).has(trimmed) ? 'undo_remove' : 'add';
    await updateRoleTool(role.name, op, trimmed);
    setToolDrafts((prev) => ({ ...prev, [role.name]: '' }));
  };

  const confirmPendingAction = () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action) return;
    if (action.kind === 'remove') {
      void updateRoleTool(action.roleName, 'remove', action.tool);
      return;
    }
    if (action.kind === 'reset') {
      void resetRole(action.roleName);
      return;
    }
    void deleteCustomAgent(action.roleName, action.scope);
  };

  const editCustomAgent = (role: RoleSurfaceItem) => {
    setAgentForm(formFromRole(role));
  };

  const saveCustomAgent = async () => {
    const name = agentForm.name.trim();
    if (!name) {
      setError(t('settings.roles.agent.error.nameRequired'));
      return;
    }
    const body = {
      name,
      description: agentForm.description.trim(),
      systemPrompt: agentForm.systemPrompt,
      baseRoleName: agentForm.baseRoleName || undefined,
      model: agentForm.model.trim() || undefined,
      workerBackend: agentForm.workerBackend || DEFAULT_WORKER_BACKEND,
      tools: readCsvText(agentForm.toolsText),
      skillNames: readCsvText(agentForm.skillsText),
      scope: agentForm.scope,
    };
    setBusyRole('__agent_form__');
    try {
      const isEdit = agentForm.mode === 'edit' && agentForm.originalName;
      await settingsApiFetch(isEdit
        ? `/roles/custom/${encodeURIComponent(agentForm.originalName ?? name)}`
        : '/roles/custom', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      setRestartHint(true);
      resetAgentForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.roles.error.saveFailed'));
    } finally {
      setBusyRole(null);
    }
  };

  const deleteCustomAgent = async (roleName: string, scope: CustomAgentScope) => {
    setBusyRole(roleName);
    try {
      await settingsApiFetch(`/roles/custom/${encodeURIComponent(roleName)}?scope=${encodeURIComponent(scope)}`, {
        method: 'DELETE',
      });
      setRestartHint(true);
      if (agentForm.originalName === roleName) resetAgentForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.roles.error.deleteFailed'));
    } finally {
      setBusyRole(null);
    }
  };

  return (
    <>
      <SettingsSection id="roles" title={t('settings.roles.title')} icon={Users} iconClassName="text-accent-brand">
        <SettingsRow label={t('settings.roles.basicTools.label')} desc={t('settings.roles.basicTools.desc')}>
          <SettingsToggle
            value={payload ? payload.basic_tools_enabled : true}
            onChange={(v) => toggleBasic(v)}
            saving={busyRole === '__settings__'}
            saved={false}
          />
        </SettingsRow>
        {payload && (
          <div className="text-[11px] text-text-tertiary pl-1">
            <span className="font-medium text-text-secondary">{t('settings.roles.basicTools.list')}：</span>
            <span className="font-mono">{payload.basic_tools.join(', ')}</span>
          </div>
        )}

        <div className="rounded-md border border-border-default bg-bg-secondary/40 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text-primary">
                {agentForm.mode === 'edit' ? t('settings.roles.agent.editTitle') : t('settings.roles.agent.createTitle')}
              </div>
              <div className="text-[10px] text-text-tertiary truncate">
                {agentForm.scope === 'global'
                  ? payload?.custom_agent_dirs.global
                  : payload?.custom_agent_dirs.project}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {agentForm.mode === 'edit' && (
                <button
                  type="button"
                  onClick={resetAgentForm}
                  className="inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-[11px] text-text-secondary hover:border-border-muted hover:text-text-primary"
                >
                  <X className="w-3.5 h-3.5" />
                  {t('settings.roles.agent.new')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void saveCustomAgent()}
                disabled={busyRole === '__agent_form__'}
                className="inline-flex items-center gap-1 rounded border border-accent-brand/40 bg-accent-brand/10 px-2 py-1 text-[11px] text-accent-brand hover:bg-accent-brand/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busyRole === '__agent_form__' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {agentForm.mode === 'edit' ? t('settings.roles.agent.save') : t('settings.roles.agent.create')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.name')}</span>
              <input
                value={agentForm.name}
                onChange={(e) => updateAgentForm({ name: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.description')}</span>
              <input
                value={agentForm.description}
                onChange={(e) => updateAgentForm({ description: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.scope')}</span>
              <select
                value={agentForm.scope}
                onChange={(e) => updateAgentForm({ scope: e.target.value === 'global' ? 'global' : 'project' })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand"
              >
                <option value="project">{t('settings.roles.agent.scope.project')}</option>
                <option value="global">{t('settings.roles.agent.scope.global')}</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.baseRole')}</span>
              <select
                value={agentForm.baseRoleName}
                onChange={(e) => updateAgentForm({ baseRoleName: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
              >
                {BASE_ROLE_OPTIONS.map((role) => (
                  <option key={role || '__none__'} value={role}>
                    {role || t('settings.roles.agent.baseRole.none')}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.backend')}</span>
              <select
                value={agentForm.workerBackend}
                onChange={(e) => updateAgentForm({ workerBackend: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
              >
                <option value="worker_process">worker_process</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.model')}</span>
              <input
                value={agentForm.model}
                onChange={(e) => updateAgentForm({ model: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.tools')}</span>
              <input
                value={agentForm.toolsText}
                onChange={(e) => updateAgentForm({ toolsText: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.skills')}</span>
              <input
                value={agentForm.skillsText}
                onChange={(e) => updateAgentForm({ skillsText: e.target.value })}
                className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
              />
            </label>
          </div>
          <label className="space-y-1 block">
            <span className="text-[10px] text-text-tertiary">{t('settings.roles.agent.prompt')}</span>
            <textarea
              value={agentForm.systemPrompt}
              onChange={(e) => updateAgentForm({ systemPrompt: e.target.value })}
              rows={5}
              className="w-full resize-y rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono leading-relaxed"
            />
          </label>
          {customRoles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {customRoles.map((role) => (
                <button
                  key={role.name}
                  type="button"
                  onClick={() => editCustomAgent(role)}
                  className="inline-flex items-center gap-1 rounded border border-border-default px-1.5 py-0.5 text-[10px] text-text-secondary hover:border-accent-brand hover:text-accent-brand font-mono"
                >
                  <Pencil className="w-3 h-3" />
                  {role.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {restartHint && (
          <div className="flex items-center gap-2 text-xs text-accent-yellow bg-accent-yellow/10 rounded px-2 py-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{t('settings.roles.restartHint')}</span>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-xs text-accent-red bg-accent-red/10 rounded px-2 py-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && !payload ? (
          <div className="flex items-center gap-2 text-xs text-text-tertiary py-2">
            <Loader2 className="w-3 h-3 animate-spin" /> {t('settings.roles.loading')}
          </div>
        ) : payload ? (
          <div className="divide-y divide-border-default -mx-2">
            {payload.roles.map((role) => {
              const isExpanded = expanded.has(role.name);
              const addedToolSet = new Set(role.override.tools_added);
              const removedToolSet = new Set(role.override.tools_removed);
              const effectiveToolSet = new Set(role.tools);
              const hasOverride = addedToolSet.size > 0 || removedToolSet.size > 0;
              const profileSet = new Set(role.profileTools);
              const addableTools = knownTools.filter((tool) => !effectiveToolSet.has(tool));
              const selectedTool = toolDrafts[role.name] || addableTools[0] || '';
              const editableDefinition = role.source === 'custom' && role.definition?.editable;
              const customScope: CustomAgentScope = role.definition?.source === 'global' ? 'global' : 'project';
              return (
                <div key={role.name} className="px-2 py-2.5">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary font-mono">{role.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${roleSourceClass(role.source)}`}>
                          {role.source}
                        </span>
                        {role.workerBackend && role.workerBackend !== DEFAULT_WORKER_BACKEND && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-orange/20 text-accent-orange">
                            {role.workerBackend}
                          </span>
                        )}
                        {hasOverride && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-yellow/20 text-accent-yellow">
                            {t('settings.roles.customized')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-tertiary mt-0.5 line-clamp-2">{role.description}</div>
                      <div className="text-[11px] text-text-tertiary mt-1">
                        {t('settings.roles.toolsCount', { count: role.tools.length })}
                        {role.allowedTiers.length > 0 && (
                          <> · tiers: <span className="font-mono text-text-secondary">{role.allowedTiers.join('/')}</span></>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {editableDefinition && (
                        <>
                          <button
                            type="button"
                            onClick={() => editCustomAgent(role)}
                            disabled={busyRole === role.name}
                            className="p-1 text-text-tertiary hover:text-accent-brand disabled:cursor-not-allowed disabled:opacity-40"
                            title={t('settings.roles.agent.edit')}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ kind: 'delete_agent', roleName: role.name, scope: customScope })}
                            disabled={busyRole === role.name}
                            className="p-1 text-text-tertiary hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-40"
                            title={t('settings.roles.agent.delete')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setConfirmAction({ kind: 'reset', roleName: role.name })}
                        disabled={!hasOverride || busyRole === role.name}
                        className="inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-[11px] text-text-secondary hover:border-accent-brand hover:text-accent-brand disabled:cursor-not-allowed disabled:opacity-40"
                        title={hasOverride ? t('settings.roles.restoreDefaultsDesc') : t('settings.roles.alreadyDefault')}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>{t('settings.roles.restoreDefaults')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleExpand(role.name)}
                        className="p-1 text-text-tertiary hover:text-text-primary"
                        title={isExpanded ? t('settings.roles.collapse') : t('settings.roles.expand')}
                      >
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 pl-1 space-y-3">
                      <div className="rounded-md border border-border-default bg-bg-secondary/50 p-2">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div>
                            <div className="text-[11px] font-medium text-text-secondary">{t('settings.roles.addTool')}</div>
                            <div className="text-[10px] text-text-tertiary">{t('settings.roles.addToolDesc')}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void addToolToRole(role, selectedTool)}
                            disabled={!selectedTool || busyRole === role.name}
                            className="inline-flex items-center gap-1 rounded border border-accent-brand/40 bg-accent-brand/10 px-2 py-1 text-[11px] text-accent-brand hover:bg-accent-brand/20 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            {t('settings.roles.addToolAction')}
                          </button>
                        </div>
                        {addableTools.length > 0 ? (
                          <select
                            value={selectedTool}
                            onChange={(e) => setToolDrafts((prev) => ({ ...prev, [role.name]: e.target.value }))}
                            disabled={busyRole === role.name}
                            className="w-full rounded border border-border-default bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-brand font-mono"
                          >
                            {addableTools.map((tool) => (
                              <option key={tool} value={tool}>{tool}</option>
                            ))}
                          </select>
                        ) : (
                          <div className="rounded border border-dashed border-border-default px-2 py-1.5 text-[11px] text-text-tertiary">
                            {t('settings.roles.noToolsToAdd')}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="text-[11px] font-medium text-text-secondary mb-1">{t('settings.roles.effective')}</div>
                        <div className="flex flex-wrap gap-1">
                          {role.tools.map((tool) => {
                            const fromOverride = addedToolSet.has(tool);
                            return (
                              <span
                                key={tool}
                                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono ${
                                  fromOverride
                                    ? 'bg-accent-green/15 text-accent-green border border-accent-green/30'
                                    : 'bg-bg-tertiary text-text-secondary'
                                }`}
                              >
                                {tool}
                                {profileSet.has(tool) && !removedToolSet.has(tool) && (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmAction({ kind: 'remove', roleName: role.name, tool })}
                                    disabled={busyRole === role.name}
                                    className="inline-flex items-center gap-0.5 rounded px-1 text-text-tertiary hover:bg-accent-red/10 hover:text-accent-red disabled:opacity-40"
                                    title={t('settings.roles.removeTool')}
                                  >
                                    <X className="w-3 h-3" />
                                    <span>{t('settings.roles.removeToolShort')}</span>
                                  </button>
                                )}
                                {fromOverride && (
                                  <button
                                    type="button"
                                    onClick={() => updateRoleTool(role.name, 'undo_add', tool)}
                                    disabled={busyRole === role.name}
                                    className="inline-flex items-center gap-0.5 rounded px-1 text-text-tertiary hover:bg-accent-red/10 hover:text-accent-red disabled:opacity-40"
                                    title={t('settings.roles.undoAdd')}
                                  >
                                    <X className="w-3 h-3" />
                                    <span>{t('settings.roles.undoAddShort')}</span>
                                  </button>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </div>

                      {role.override.tools_removed.length > 0 && (
                        <div>
                          <div className="text-[11px] font-medium text-text-secondary mb-1">{t('settings.roles.removed')}</div>
                          <div className="flex flex-wrap gap-1">
                            {role.override.tools_removed.map((tool) => (
                              <span
                                key={tool}
                                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono bg-accent-red/10 text-accent-red border border-accent-red/30"
                              >
                                <span className="line-through">{tool}</span>
                                <button
                                  type="button"
                                  onClick={() => updateRoleTool(role.name, 'undo_remove', tool)}
                                  disabled={busyRole === role.name}
                                  className="rounded px-1 text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
                                  title={t('settings.roles.undoRemove')}
                                >
                                  {t('settings.roles.undoRemove')}
                                </button>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </SettingsSection>

      <ConfirmationDialog
        open={!!confirmAction}
        title={
          confirmAction?.kind === 'remove'
            ? t('settings.roles.confirmRemoveTitle')
            : confirmAction?.kind === 'delete_agent'
              ? t('settings.roles.agent.confirmDeleteTitle')
              : t('settings.roles.confirmResetTitle')
        }
        message={
          confirmAction?.kind === 'remove'
            ? t('settings.roles.confirmRemoveMessage', {
              role: confirmAction.roleName,
              tool: confirmAction.tool,
            })
            : confirmAction?.kind === 'delete_agent'
              ? t('settings.roles.agent.confirmDeleteMessage', {
                role: confirmAction.roleName,
                scope: confirmAction.scope,
              })
              : t('settings.roles.confirmResetMessage', { role: confirmAction?.roleName ?? '' })
        }
        confirmLabel={
          confirmAction?.kind === 'remove'
            ? t('settings.roles.confirmRemoveOk')
            : confirmAction?.kind === 'delete_agent'
              ? t('settings.roles.agent.confirmDeleteOk')
              : t('settings.roles.confirmResetOk')
        }
        cancelLabel={t('settings.roles.confirmCancel')}
        variant={confirmAction?.kind === 'remove' || confirmAction?.kind === 'delete_agent' ? 'danger' : 'default'}
        onConfirm={confirmPendingAction}
        onCancel={() => setConfirmAction(null)}
      />
    </>
  );
}
