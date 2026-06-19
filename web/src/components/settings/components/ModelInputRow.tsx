import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Save } from 'lucide-react';

export function ModelInputRow({
  label,
  desc,
  value,
  suggestions,
  quickPickLabel,
  placeholder,
  saving,
  saved,
  error,
  onSave,
}: {
  label: string;
  desc?: string;
  value: string;
  suggestions: string[];
  quickPickLabel: string;
  placeholder?: string;
  saving?: boolean;
  saved?: boolean;
  error?: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [showPicker, setShowPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => { setDraft(value); }, [value]);

  const commit = (v: string) => {
    const trimmed = v.trim();
    if (trimmed !== value) onSave(trimmed);
  };

  const pickModel = (model: string) => {
    setDraft(model);
    setShowPicker(false);
    onSave(model);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md px-0.5 py-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">{label}</div>
          {desc && <div className="mt-0.5 max-w-2xl text-xs leading-relaxed text-text-tertiary">{desc}</div>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 sm:shrink-0">
          <div className="relative flex min-w-0 items-center">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commit(draft);
                  inputRef.current?.blur();
                }
              }}
              placeholder={placeholder || t('settings.modelInput.placeholder')}
              className="min-h-8 w-full min-w-[13rem] rounded border border-border-input bg-bg-input px-2 py-1 pr-7 text-xs font-mono text-text-primary transition-colors focus:border-accent-brand sm:w-64"
            />
            <button
              type="button"
              onClick={() => setShowPicker((p) => !p)}
              className="absolute right-1 text-text-tertiary transition-colors hover:text-text-primary"
              title={t('settings.modelInput.quickPickTitle')}
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPicker ? 'rotate-180' : ''}`} />
            </button>
          </div>
          {saving && <Loader2 className="w-3 h-3 text-accent-brand animate-spin" />}
          {saved && !saving && <Save className="w-3 h-3 text-accent-green" />}
        </div>
      </div>
      {error && <div className="text-xs text-accent-red font-mono">{error}</div>}
      {showPicker && (
        <div className="flex flex-wrap gap-1.5 rounded-md border border-border-muted bg-bg-card/50 p-2">
          <span className="self-center text-xs text-text-tertiary">{quickPickLabel}</span>
          {suggestions.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => pickModel(m)}
              className={`rounded border px-2 py-1 text-xs font-mono transition-colors ${
                draft === m
                  ? 'bg-accent-brand/15 border-accent-brand text-accent-brand'
                  : 'bg-bg-tertiary border-border-default text-text-secondary hover:border-accent-brand hover:text-text-primary'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
