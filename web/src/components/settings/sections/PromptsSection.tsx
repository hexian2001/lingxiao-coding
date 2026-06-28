import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ChevronDown,
  Eye,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Search,
  FileText,
} from 'lucide-react';
import ConfirmationDialog from '../../ui/ConfirmationDialog';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsSubsection } from '../components/SettingsRow';
import { settingsApiFetch } from '../settingsApi';

interface PromptItem {
  key: string;
  label: string;
  default: string;
  override: string | null;
}

interface PromptsResponse {
  prompts: PromptItem[];
}

type ViewMode = 'edit' | 'default';

interface PromptEditorState {
  draft: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
}

export function PromptsSection() {
  const { t } = useTranslation();

  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<Record<string, ViewMode>>({});
  const [editorStates, setEditorStates] = useState<Record<string, PromptEditorState>>({});
  const [resetConfirm, setResetConfirm] = useState<{ key: string; label: string } | null>(null);

  // ── Fetch prompts ──────────────────────────────────────────────
  const fetchPrompts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await settingsApiFetch<PromptsResponse>('/prompts');
      setPrompts(data.prompts || []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load prompts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  // ── Filtering ──────────────────────────────────────────────────
  const filteredPrompts = useMemo(() => {
    if (!searchQuery.trim()) return prompts;
    const q = searchQuery.toLowerCase();
    return prompts.filter(
      (p) => p.key.toLowerCase().includes(q) || p.label.toLowerCase().includes(q),
    );
  }, [prompts, searchQuery]);

  const leaderPrompts = useMemo(
    () => filteredPrompts.filter((p) => p.key.startsWith('leader_')),
    [filteredPrompts],
  );
  const workerPrompts = useMemo(
    () => filteredPrompts.filter((p) => !p.key.startsWith('leader_')),
    [filteredPrompts],
  );

  // ── Editor helpers ─────────────────────────────────────────────
  const getEditorState = (key: string): PromptEditorState => {
    return (
      editorStates[key] || {
        draft: '',
        dirty: false,
        saving: false,
        error: null,
        success: null,
      }
    );
  };

  const updateEditorState = (key: string, patch: Partial<PromptEditorState>) => {
    setEditorStates((prev) => ({
      ...prev,
      [key]: { ...getEditorState(key), ...patch },
    }));
  };

  const handleExpand = (key: string, currentOverride: string | null, defaultContent: string) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    // Initialize editor state with current effective content
    if (!editorStates[key]) {
      updateEditorState(key, {
        draft: currentOverride || defaultContent,
        dirty: false,
        saving: false,
        error: null,
        success: null,
      });
    }
    setViewMode((prev) => ({ ...prev, [key]: 'edit' }));
  };

  const handleDraftChange = (key: string, value: string) => {
    updateEditorState(key, { draft: value, dirty: true, error: null, success: null });
  };

  // ── Save override ──────────────────────────────────────────────
  const handleSave = async (key: string) => {
    const state = getEditorState(key);
    if (!state.dirty) return;
    updateEditorState(key, { saving: true, error: null, success: null });
    try {
      await settingsApiFetch(`/prompts/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: state.draft }),
      });
      // Update local state
      setPrompts((prev) =>
        prev.map((p) => (p.key === key ? { ...p, override: state.draft } : p)),
      );
      updateEditorState(key, { saving: false, dirty: false, success: t('settings.prompts.saveSuccess') });
      // Clear success after 2s
      setTimeout(() => updateEditorState(key, { success: null }), 2000);
    } catch (err) {
      updateEditorState(key, {
        saving: false,
        error: err instanceof Error ? err.message : t('settings.prompts.saveFailed'),
      });
    }
  };

  // ── Reset override ─────────────────────────────────────────────
  const handleReset = async (key: string) => {
    updateEditorState(key, { saving: true, error: null, success: null });
    try {
      await settingsApiFetch(`/prompts/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      // Find default content
      const prompt = prompts.find((p) => p.key === key);
      const defaultContent = prompt?.default || '';
      setPrompts((prev) =>
        prev.map((p) => (p.key === key ? { ...p, override: null } : p)),
      );
      updateEditorState(key, {
        saving: false,
        dirty: false,
        draft: defaultContent,
        success: t('settings.prompts.resetSuccess'),
      });
      setTimeout(() => updateEditorState(key, { success: null }), 2000);
    } catch (err) {
      updateEditorState(key, {
        saving: false,
        error: err instanceof Error ? err.message : t('settings.prompts.saveFailed'),
      });
    }
    setResetConfirm(null);
  };

  // ── Render prompt card ─────────────────────────────────────────
  const renderPromptCard = (prompt: PromptItem) => {
    const isExpanded = expandedKey === prompt.key;
    const state = getEditorState(prompt.key);
    const isCustom = !!prompt.override;
    const currentViewMode = viewMode[prompt.key] || 'edit';
    const effectiveContent = currentViewMode === 'default' ? prompt.default : state.draft || prompt.override || prompt.default;

    return (
      <div
        key={prompt.key}
        className={`rounded-md border transition-colors ${
          isExpanded
            ? 'border-accent-brand/40 bg-bg-card/60'
            : 'border-border-muted bg-bg-card/40'
        }`}
      >
        {/* Header row */}
        <button
          type="button"
          onClick={() => handleExpand(prompt.key, prompt.override, prompt.default)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        >
          <div className="flex min-w-0 items-center gap-2">
            <ChevronDown
              className={`w-3.5 h-3.5 shrink-0 text-text-tertiary transition-transform ${
                isExpanded ? 'rotate-0' : '-rotate-90'
              }`}
            />
            <span className="text-sm font-medium text-text-primary truncate">
              {prompt.label}
            </span>
            <span className="shrink-0 text-[10px] text-text-tertiary font-mono">
              {prompt.key}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isCustom ? (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent-brand/15 text-accent-brand">
                <Pencil className="w-2.5 h-2.5" />
                {t('settings.prompts.custom')}
              </span>
            ) : (
              <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-tertiary text-text-tertiary">
                {t('settings.prompts.default')}
              </span>
            )}
          </div>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div className="border-t border-border-muted px-3 pb-3 pt-2 space-y-2">
            {/* View mode toggle */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setViewMode((prev) => ({ ...prev, [prompt.key]: 'edit' }))}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                  currentViewMode === 'edit'
                    ? 'bg-accent-brand/15 text-accent-brand'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <Pencil className="w-3 h-3" />
                {t('settings.prompts.edit')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode((prev) => ({ ...prev, [prompt.key]: 'default' }))}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                  currentViewMode === 'default'
                    ? 'bg-accent-brand/15 text-accent-brand'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <Eye className="w-3 h-3" />
                {t('settings.prompts.viewDefault')}
              </button>
            </div>

            {/* Textarea */}
            <textarea
              value={effectiveContent}
              onChange={(e) => {
                if (currentViewMode === 'edit') {
                  handleDraftChange(prompt.key, e.target.value);
                }
              }}
              readOnly={currentViewMode === 'default'}
              className="w-full min-h-[200px] resize-y rounded border border-border-input bg-bg-input px-2 py-1.5 text-xs font-mono leading-relaxed text-text-primary focus:border-accent-brand/60 focus:outline-none"
              placeholder={t('settings.prompts.edit')}
            />

            {/* Feedback */}
            {state.error && (
              <div className="flex items-center gap-1 text-xs text-accent-red">
                <AlertCircle className="w-3 h-3 shrink-0" />
                {state.error}
              </div>
            )}
            {state.success && (
              <div className="flex items-center gap-1 text-xs text-accent-green">
                <Save className="w-3 h-3 shrink-0" />
                {state.success}
              </div>
            )}

            {/* Action buttons */}
            {currentViewMode === 'edit' && (
              <div className="flex items-center justify-end gap-2">
                {isCustom && (
                  <button
                    type="button"
                    onClick={() =>
                      setResetConfirm({ key: prompt.key, label: prompt.label })
                    }
                    disabled={state.saving}
                    className="inline-flex items-center gap-1 rounded border border-border-default px-3 py-1 text-xs text-text-secondary transition-colors hover:border-accent-red/40 hover:text-accent-red disabled:opacity-50"
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('settings.prompts.reset')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleSave(prompt.key)}
                  disabled={state.saving || !state.dirty}
                  className="inline-flex items-center gap-1 rounded border border-accent-brand/40 bg-accent-brand/10 px-3 py-1 text-xs text-accent-brand transition-colors hover:bg-accent-brand/20 disabled:opacity-50"
                >
                  {state.saving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  {t('settings.prompts.save')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <SettingsSection
      id="prompts"
      title={t('settings.prompts.title')}
      icon={FileText}
      iconClassName="text-accent-blue"
      desc={t('settings.prompts.desc')}
    >
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('settings.prompts.searchPlaceholder')}
          className="w-full rounded border border-border-input bg-bg-input py-1.5 pl-8 pr-3 text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent-brand/60 focus:outline-none"
        />
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-accent-brand animate-spin" />
        </div>
      )}

      {/* Error state */}
      {loadError && !loading && (
        <div className="flex items-center gap-2 rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {loadError}
        </div>
      )}

      {/* Prompt groups */}
      {!loading && !loadError && (
        <>
          {leaderPrompts.length > 0 && (
            <SettingsSubsection title={t('settings.prompts.leaderGroup')}>
              {leaderPrompts.map(renderPromptCard)}
            </SettingsSubsection>
          )}
          {workerPrompts.length > 0 && (
            <SettingsSubsection title={t('settings.prompts.workerGroup')}>
              {workerPrompts.map(renderPromptCard)}
            </SettingsSubsection>
          )}
        </>
      )}

      <ConfirmationDialog
        open={!!resetConfirm}
        title={t('settings.prompts.reset')}
        message={t('settings.prompts.resetConfirm')}
        confirmLabel={t('settings.prompts.reset')}
        cancelLabel={t('settings.roles.confirmCancel')}
        variant="danger"
        onConfirm={() => resetConfirm && handleReset(resetConfirm.key)}
        onCancel={() => setResetConfirm(null)}
      />
    </SettingsSection>
  );
}
