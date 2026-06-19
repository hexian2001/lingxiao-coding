/**
 * AgentsTab — manage custom agent definitions (source === 'custom') via
 * /api/v1/roles (list) + /api/v1/roles/custom (create/update/delete).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { apiFetch } from './crud/api';
import AgentForm, { type AgentFormInitial } from './AgentForm';

interface AgentRoleItem {
  name: string;
  description: string;
  source: string;
  baselineRole?: string;
  model?: string;
  systemPrompt?: string;
  definition?: { source: string; editable: boolean; tools?: string[]; skillNames?: string[] };
}

export default function AgentsTab() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentRoleItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentFormInitial | null>(null);

  const fetchAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiFetch<{ data: { roles: AgentRoleItem[] } }>('/roles');
      const custom = (data.data?.roles || []).filter((role) => role.source === 'custom');
      setAgents(custom);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const remove = async (agent: AgentRoleItem) => {
    if (!window.confirm(t('agents.confirm.delete', { name: agent.name }))) return;
    try {
      const scope = agent.definition?.source === 'global' ? 'global' : 'project';
      await apiFetch(`/roles/custom/${encodeURIComponent(agent.name)}?scope=${scope}`, { method: 'DELETE' });
      setAgents((prev) => prev.filter((a) => a.name !== agent.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete agent');
    }
  };

  const startEdit = (agent: AgentRoleItem) => {
    setEditing({
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt ?? '',
      baseRoleName: agent.baselineRole,
      model: agent.model,
      tools: agent.definition?.tools ?? [],
      skillNames: agent.definition?.skillNames ?? [],
    });
  };

  const filtered = agents.filter((a) => !search.trim() || `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b border-border-muted flex items-center gap-2 shrink-0 bg-bg-primary/40 backdrop-blur-xl">
        <button onClick={() => setCreating(true)} className="cyber-btn cyber-btn-primary text-xs flex items-center gap-1 !h-8">
          <Plus className="w-3.5 h-3.5" /> {t('agents.action.create')}
        </button>
        <div className="relative flex-1 max-w-md ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agents.search')}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary outline-none focus:border-border-default"
          />
        </div>
        <button onClick={fetchAgents} className="codex-icon-btn !h-8 !min-w-8">
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-accent-brand animate-spin" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <Bot className="w-8 h-8 mb-2" />
            <p className="text-sm">{t('agents.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {filtered.map((agent) => (
              <div key={agent.name} className="px-5 py-3.5 flex items-start gap-3 hover:bg-bg-hover/70 transition-colors">
                <Bot className="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary font-mono">{agent.name}</span>
                    {agent.baselineRole && <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">{agent.baselineRole}</span>}
                    {agent.model && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-brand/15 text-accent-brand">{agent.model}</span>}
                  </div>
                  <div className="text-xs text-text-tertiary mt-0.5 break-words">{agent.description || '-'}</div>
                  <div className="text-[11px] text-text-tertiary mt-1">
                    {(agent.definition?.tools ?? []).length} tools · {(agent.definition?.skillNames ?? []).length} skills
                  </div>
                </div>
                <button onClick={() => startEdit(agent)} className="p-1 text-text-tertiary hover:text-accent-brand" title={t('agents.action.edit')}>
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => remove(agent)} className="p-1 text-text-tertiary hover:text-accent-red" title={t('agents.action.delete')}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && <AgentForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); fetchAgents(); }} />}
      {editing && <AgentForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); fetchAgents(); }} />}
    </div>
  );
}
