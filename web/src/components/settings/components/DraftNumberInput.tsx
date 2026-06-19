import { useEffect, useRef, useState } from 'react';
import { Loader2, Save } from 'lucide-react';

export function DraftNumberInput({
  value,
  onSave,
  min = 0,
  max,
  placeholder,
  className = 'w-24',
  saving,
  saved,
}: {
  value: number;
  onSave: (value: number) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
  saving?: boolean;
  saved?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return;
    const next = Math.max(min, Math.min(max ?? Infinity, parsed));
    if (next !== value) onSave(next);
    setDraft(String(next));
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        ref={inputRef}
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            inputRef.current?.blur();
          }
        }}
        placeholder={placeholder}
        min={min}
        max={max}
        className={`min-h-8 min-w-0 rounded border border-border-input bg-bg-input px-2 py-1 text-xs font-mono text-text-primary transition-colors focus:border-accent-brand ${className}`}
      />
      {saving && <Loader2 className="w-3 h-3 text-accent-brand animate-spin" />}
      {saved && !saving && <Save className="w-3 h-3 text-accent-green" />}
    </div>
  );
}
