/**
 * CommandsTab — manage custom slash commands via /api/v1/commands (full CRUD).
 * Also fetches /api/v1/roles once to suggest agent targets in the form.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Search, Terminal, Trash2 } from 'lucide-react';
import { apiFetch } from './crud/api';
import CommandForm, { type CommandFormInitial } from './CommandForm';

interface CommandItem {
  name: string;
  slashName: string;
  description: string;
  agent: string;
  source: string;
  path: string;
  editable: boolean;
}

export default function CommandsTab() {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CommandFormInitial | null>(null);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    try {
      const [cmdData, roleData] = await Promise.all([
        apiFetch<{ data: CommandItem[] }>('/commands'),
        apiFetch<{ data: { roles: { name: string }[] } }>('/roles').catch(() => ({ data: { roles: [] } })),
      ]);
      setCommands(cmdData.data || []);
      setAgents((roleData.data?.roles || []).map((role) => role.name));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch commands');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const remove = async (cmd: CommandItem) => {
    if (!window.confirm(t('commands.confirm.delete', { name: cmd.name }))) return;
    try {
      const scope = cmd.source === 'global' ? 'global' : 'project';
      await apiFetch(`/commands/${encodeURIComponent(cmd.name)}?scope=${scope}`, { method: 'DELETE' });
      setCommands((prev) => prev.filter((c) => c.name !== cmd.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete command');
    }
  };

  const startEdit = async (cmd: CommandItem) => {
    try {
      const data = await apiFetch<{ data: { name: string; description: string; agent: string; body: string; source: string } }>(
        `/commands/${encodeURIComponent(cmd.name)}`,
      );
      const d = data.data;
      setEditing({ name: d.name, description: d.description, agent: d.agent, body: d.body, scope: d.source === 'global' ? 'global' : 'project' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load command');
    }
  };

  const filtered = commands.filter((c) => !search.trim() || `${c.name} ${c.description} ${c.agent}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b border-border-muted flex items-center gap-2 shrink-0 bg-bg-primary/40 backdrop-blur-xl">
        <button onClick={() => setCreating(true)} className="cyber-btn cyber-btn-primary text-xs flex items-center gap-1 !h-8">
          <Plus className="w-3.5 h-3.5" /> {t('commands.action.create')}
        </button>
        <div className="relative flex-1 max-w-md ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('commands.search')}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary outline-none focus:border-border-default"
          />
        </div>
        <button onClick={fetchAll} className="codex-icon-btn !h-8 !min-w-8">
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
            <Terminal className="w-8 h-8 mb-2" />
            <p className="text-sm">{t('commands.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {filtered.map((cmd) => (
              <div key={cmd.name} className="px-5 py-3.5 flex items-start gap-3 hover:bg-bg-hover/70 transition-colors">
                <Terminal className="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary font-mono">{cmd.slashName}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-brand/15 text-accent-brand">{cmd.agent}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">{cmd.source}</span>
                  </div>
                  <div className="text-xs text-text-tertiary mt-0.5 break-words">{cmd.description || '-'}</div>
                </div>
                {cmd.editable && (
                  <>
                    <button onClick={() => startEdit(cmd)} className="p-1 text-text-tertiary hover:text-accent-brand" title={t('commands.action.edit')}>
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => remove(cmd)} className="p-1 text-text-tertiary hover:text-accent-red" title={t('commands.action.delete')}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && <CommandForm availableAgents={agents} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); fetchAll(); }} />}
      {editing && <CommandForm initial={editing} availableAgents={agents} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); fetchAll(); }} />}
    </div>
  );
}
