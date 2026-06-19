import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BadgeCheck, BookOpen, Loader2, Pencil, Plus, RefreshCw, Search, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { apiFetch } from './crud/api';
import SkillForm, { type SkillFormInitial } from './SkillForm';

interface SkillItem {
  id: string;
  ref: string;
  name: string;
  description: string;
  source: 'project' | 'plugin' | 'global' | 'bundled';
  path: string;
  enabled: boolean;
  plugin?: {
    id: string;
    version: string;
    path: string;
  };
}

function sourceLabel(skill: SkillItem): string {
  if (skill.source === 'project') return 'project';
  if (skill.source === 'plugin') return skill.plugin ? `plugin:${skill.plugin.id}` : 'plugin';
  if (skill.source === 'global') return 'global';
  return 'bundled';
}

/** Only project / global skills live in user-writable dirs and are CRUD-manageable. */
function isEditable(skill: SkillItem): boolean {
  return skill.source === 'project' || skill.source === 'global';
}

export default function SkillsTab() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SkillFormInitial | null>(null);

  const fetchSkills = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('includeDisabled', 'true');
      if (sessionId) params.set('sessionId', sessionId);
      const data = await apiFetch<{ data: SkillItem[] }>(`/skills?${params.toString()}`);
      setSkills(data.data || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch skills');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = async (skill: SkillItem) => {
    try {
      await apiFetch(`/skills/${encodeURIComponent(skill.ref)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      setSkills((prev) => prev.map((item) => item.ref === skill.ref ? { ...item, enabled: !item.enabled } : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle skill');
    }
  };

  const remove = async (skill: SkillItem) => {
    if (!window.confirm(t('skills.confirm.delete', { name: skill.name }))) return;
    try {
      const scope = skill.source === 'global' ? 'global' : 'project';
      const qs = new URLSearchParams({ scope });
      if (sessionId) qs.set('sessionId', sessionId);
      await apiFetch(`/skills/${encodeURIComponent(skill.name)}?${qs.toString()}`, { method: 'DELETE' });
      setSkills((prev) => prev.filter((item) => item.name !== skill.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete skill');
    }
  };

  const startEdit = async (skill: SkillItem) => {
    try {
      const scope = skill.source === 'global' ? 'global' : 'project';
      const params = new URLSearchParams({ scope });
      if (sessionId) params.set('sessionId', sessionId);
      const data = await apiFetch<{ data: { name: string; description: string; body: string } }>(
        `/skills/${encodeURIComponent(skill.name)}?${params.toString()}`,
      );
      setEditing({ name: data.data.name, description: data.data.description, body: data.data.body, scope });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skill');
    }
  };

  const filtered = skills.filter((skill) => {
    if (!search.trim()) return true;
    const haystack = `${skill.name} ${skill.description} ${skill.ref} ${skill.path}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b border-border-muted flex items-center gap-2 shrink-0 bg-bg-primary/40 backdrop-blur-xl">
        <button onClick={() => setCreating(true)} className="cyber-btn cyber-btn-primary text-xs flex items-center gap-1 !h-8">
          <Plus className="w-3.5 h-3.5" /> {t('skills.action.create')}
        </button>
        <div className="relative flex-1 max-w-md ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('skills.search')}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary outline-none focus:border-border-default"
          />
        </div>
        <button onClick={fetchSkills} className="codex-icon-btn !h-8 !min-w-8">
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
            <BookOpen className="w-8 h-8 mb-2" />
            <p className="text-sm">{t('skills.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {filtered.map((skill) => (
              <div key={skill.ref} className="px-5 py-3.5 flex items-start gap-3 hover:bg-bg-hover/70 transition-colors">
                <BookOpen className="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary font-mono">{skill.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                      {sourceLabel(skill)}
                    </span>
                    {skill.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/20 text-accent-green flex items-center gap-1">
                        <BadgeCheck className="w-3 h-3" /> {t('plugins.enabled')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-tertiary mt-0.5 break-words">{skill.description || '-'}</div>
                  <div className="text-[11px] text-text-tertiary mt-1 font-mono truncate">{skill.ref}</div>
                  <div className="text-[11px] text-text-tertiary mt-0.5 font-mono truncate">{skill.path}</div>
                </div>
                {isEditable(skill) && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(skill)} className="p-1 text-text-tertiary hover:text-accent-brand" title={t('skills.action.edit')}>
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => remove(skill)} className="p-1 text-text-tertiary hover:text-accent-red" title={t('skills.action.delete')}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <button onClick={() => toggle(skill)} className={`p-1 ${skill.enabled ? 'text-accent-green' : 'text-text-tertiary'}`} title={t('skills.action.toggle')}>
                  {skill.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && <SkillForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); fetchSkills(); }} />}
      {editing && <SkillForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); fetchSkills(); }} />}
    </div>
  );
}
