import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Edit3, Loader2, Plus, RefreshCw, Server, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { getServerToken } from '../../api/headers';
import McpServerForm, { type McpServerConfig } from './McpServerForm';
import { useSessionStore } from '../../stores/sessionStore';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const hasBody = opts?.body != null;
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  return body as T;
}

export default function McpServersTab({ inline }: { inline?: boolean }) {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);

  const fetchServers = useCallback(async () => {
      setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      const data = await apiFetch<{ data: McpServerConfig[] }>(`/mcp/servers${params.size > 0 ? `?${params.toString()}` : ''}`);
      setServers(data.data || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcp.error.fetchFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const toggle = async (server: McpServerConfig) => {
    try {
      const result = await apiFetch<{ data: McpServerConfig }>(`/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: server.enabled === false }),
      });
      setServers((prev) => prev.map((item) => item.id === server.id ? result.data : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcp.error.toggleFailed'));
    }
  };

  const remove = async (server: McpServerConfig) => {
    if (!confirm(t('mcp.confirm.remove', { id: server.id }))) return;
    try {
      await apiFetch(`/mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
      setServers((prev) => prev.filter((item) => item.id !== server.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcp.error.removeFailed'));
    }
  };

  const filtered = servers.filter((server) => {
    if (!search.trim()) return true;
    const haystack = `${server.id} ${server.name} ${server.title || ''} ${server.description || ''}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b border-border-muted flex items-center gap-2 shrink-0 bg-bg-primary/40 backdrop-blur-xl">
        <button onClick={() => setCreating(true)} className="cyber-btn cyber-btn-primary !py-1.5 !text-xs flex items-center gap-1">
          <Plus className="w-3 h-3" /> {t('mcp.action.add')}
        </button>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('mcp.searchPlaceholder')}
          className="ml-auto px-3 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary w-52 outline-none focus:border-border-default"
        />
        <button onClick={fetchServers} className="codex-icon-btn !h-8 !min-w-8" title={t('plugins.refresh')}>
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
        {creating ? (
          <McpServerForm
            inline={inline}
            onClose={() => setCreating(false)}
            onSaved={(server) => {
              setCreating(false);
              setServers((prev) => [...prev.filter((item) => item.id !== server.id), server].sort((a, b) => a.id.localeCompare(b.id)));
            }}
          />
        ) : editing ? (
          <McpServerForm
            inline={inline}
            initial={editing}
            onClose={() => setEditing(null)}
            onSaved={(server) => {
              setEditing(null);
              setServers((prev) => prev.map((item) => item.id === server.id ? server : item));
            }}
          />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <Server className="w-8 h-8 mb-2" />
            <p className="text-sm">{t('mcp.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {filtered.map((server) => (
              <div key={server.id} className="px-5 py-3.5 flex items-start gap-3 hover:bg-bg-hover/70 transition-colors">
                <Server className="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary font-mono">{server.id}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">
                      {server.transport}
                    </span>
                    {server.enabled === false && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                        {t('plugins.disabled')}
                      </span>
                    )}
                    {server.origin?.plugin_id && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/20 text-accent-green">
                        {t('mcp.badge.pluginSource', { id: server.origin.plugin_id })}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">{server.title || server.name}</div>
                  <div className="text-xs text-text-tertiary mt-0.5 break-words">{server.description || t('mcp.emptyDescription')}</div>
                  <div className="text-[11px] text-text-tertiary mt-1 font-mono truncate">
                    {server.transport === 'stdio' ? server.command : server.url}
                  </div>
                </div>
                <button onClick={() => setEditing(server)} className="p-1 text-text-tertiary hover:text-accent-brand" title={t('tools.action.edit')}>
                  <Edit3 className="w-4 h-4" />
                </button>
                <button onClick={() => toggle(server)} className={`p-1 ${server.enabled !== false ? 'text-accent-green' : 'text-text-tertiary'}`} title={t('mcp.action.toggle')}>
                  {server.enabled !== false ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                </button>
                <button onClick={() => remove(server)} className="p-1 text-text-tertiary hover:text-accent-red" title={t('mcp.action.remove')}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
