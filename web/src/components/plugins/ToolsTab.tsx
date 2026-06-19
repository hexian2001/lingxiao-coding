/**
 * ToolsTab — 工具管理 Tab
 *
 * 列出所有工具（builtin + user），支持启用/禁用、新建/编辑/删除/测试。
 * 数据源：/api/v1/tools
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Edit3, ToggleLeft, ToggleRight, RefreshCw, Loader2, AlertTriangle, Wrench } from 'lucide-react';
import { getServerToken } from '../../api/headers';
import UserToolForm, { type UserToolSpec } from './UserToolForm';

interface ToolListItem {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'leader-meta';
  kind?: 'http' | 'shell' | 'python';
  enabled: boolean;
  parameters?: unknown;
  spec?: UserToolSpec;
  requiresRestart?: boolean;
  warning?: string;
  readOnly?: boolean;
  scope?: 'leader-meta' | 'leader-bughunt';
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
  }
  return fallback;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(errorMessageFromBody(body, `HTTP ${res.status}`));
  }
  return body as T;
}

export default function ToolsTab() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'builtin' | 'user' | 'leader-meta' | 'disabled'>('all');
  const [editing, setEditing] = useState<UserToolSpec | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchTools = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiFetch<{ tools: ToolListItem[] }>('/tools');
      setTools(data.tools || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTools();
  }, [fetchTools]);

  const toggle = async (tool: ToolListItem) => {
    if (tool.readOnly) return;
    try {
      const result = await apiFetch<{ success: boolean; enabled: boolean; requiresRestart?: boolean; warning?: string; message?: string }>(`/tools/${encodeURIComponent(tool.name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !tool.enabled }),
      });
      setTools((prev) => prev.map((p) => (
        p.name === tool.name
          ? { ...p, enabled: !p.enabled, requiresRestart: result.requiresRestart, warning: result.warning }
          : p
      )));
      if (result.requiresRestart) {
        setError(result.message || t('tools.warning.restartRequired'));
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle');
    }
  };

  const remove = async (tool: ToolListItem) => {
    if (tool.source !== 'user') return;
    if (!confirm(t('tools.confirm.delete', { name: tool.name }))) return;
    try {
      await apiFetch(`/tools/${encodeURIComponent(tool.name)}`, { method: 'DELETE' });
      setTools((prev) => prev.filter((p) => p.name !== tool.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const filtered = tools.filter((t) => {
    if (filter === 'disabled' && t.enabled) return false;
    if (filter !== 'all' && filter !== 'disabled' && t.source !== filter) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const builtinCount = tools.filter((t) => t.source === 'builtin').length;
  const userCount = tools.filter((t) => t.source === 'user').length;
  const leaderMetaCount = tools.filter((t) => t.source === 'leader-meta').length;
  const disabledCount = tools.filter((t) => !t.enabled).length;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-border-muted flex items-center gap-2 flex-wrap shrink-0 bg-bg-primary/40 backdrop-blur-xl">
        <button
          onClick={() => setCreating(true)}
          className="cyber-btn cyber-btn-primary !py-1.5 !text-xs flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {t('tools.action.create')}
        </button>
        <div className="flex items-center gap-1 text-xs">
          {(['all', 'builtin', 'leader-meta', 'user', 'disabled'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`codex-chip px-2.5 py-1 transition-colors ${
                filter === f
                  ? 'text-text-primary'
                  : 'text-text-tertiary'
              }`}
            >
              {t(`tools.filter.${f}`)}
              {f === 'builtin' && ` (${builtinCount})`}
              {f === 'leader-meta' && ` (${leaderMetaCount})`}
              {f === 'user' && ` (${userCount})`}
              {f === 'disabled' && ` (${disabledCount})`}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('tools.search') as string}
          className="ml-auto px-3 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary w-48 outline-none focus:border-border-default"
        />
        <button onClick={fetchTools} className="codex-icon-btn !h-8 !min-w-8">
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
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <Wrench className="w-8 h-8 mb-2" />
            <p className="text-sm">{t('tools.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {filtered.map((tool) => (
              <div key={tool.name} className="px-5 py-3.5 flex items-start gap-3 hover:bg-bg-hover/70 transition-colors">
                <Wrench className="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary font-mono">{tool.name}</span>
                    <KindBadge source={tool.source} kind={tool.kind} scope={tool.scope} />
                    {!tool.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                        {t('tools.badge.disabled')}
                      </span>
                    )}
                    {tool.requiresRestart && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-yellow/20 text-accent-yellow">
                        {t('tools.badge.restartRequired')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-tertiary mt-0.5 break-words">
                    {tool.description || '—'}
                  </div>
                  {tool.warning && (
                    <div className="text-[11px] text-accent-yellow mt-1">
                      {tool.warning === 'builtin_tool_reenable_requires_restart' ? t('tools.warning.restartRequired') : tool.warning}
                    </div>
                  )}
                </div>
                {tool.source === 'user' && (
                  <button
                    onClick={() => tool.spec && setEditing(tool.spec)}
                    className="p-1 text-text-tertiary hover:text-accent-brand"
                    title={t('tools.action.edit') as string}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                )}
                {tool.readOnly ? (
                  <span
                    className="p-1 text-text-tertiary opacity-60 cursor-not-allowed"
                    title={t('tools.badge.leaderMetaHint') as string}
                  >
                    <ToggleRight className="w-5 h-5" />
                  </span>
                ) : (
                  <button
                    onClick={() => toggle(tool)}
                    className={`p-1 ${tool.enabled ? 'text-accent-green' : 'text-text-tertiary'}`}
                    title={tool.enabled ? t('tools.action.disable') as string : t('tools.action.enable') as string}
                  >
                    {tool.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                  </button>
                )}
                {tool.source === 'user' && (
                  <button
                    onClick={() => remove(tool)}
                    className="p-1 text-text-tertiary hover:text-accent-red"
                    title={t('tools.action.delete') as string}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <UserToolForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            fetchTools();
          }}
        />
      )}
      {editing && (
        <UserToolForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            fetchTools();
          }}
        />
      )}
    </div>
  );
}

function KindBadge({ source, kind, scope }: { source: 'builtin' | 'user' | 'leader-meta'; kind?: string; scope?: 'leader-meta' | 'leader-bughunt' }) {
  const { t } = useTranslation();
  if (source === 'builtin') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">
        {t('tools.badge.builtin')}
      </span>
    );
  }
  if (source === 'leader-meta') {
    const label = scope === 'leader-bughunt' ? t('tools.badge.leaderBughunt') : t('tools.badge.leaderMeta');
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-accent-orange/20 text-accent-orange"
        title={t('tools.badge.leaderMetaHint') as string}
      >
        {label}
      </span>
    );
  }
  const label = kind ? t(`tools.kind.${kind}`) : t('tools.badge.user');
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-purple/20 text-accent-purple">
      {label}
    </span>
  );
}
