import { useEffect, useRef, useState } from 'react';
import { Loader2, Save } from 'lucide-react';

export function DraftTextInput({
  value,
  onSave,
  placeholder,
  className = 'w-full sm:w-56',
  type = 'text',
  saving,
  saved,
}: {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  className?: string;
  type?: 'text' | 'password';
  saving?: boolean;
  saved?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        ref={inputRef}
        type={type}
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
        className={`min-h-8 min-w-0 rounded border border-border-input bg-bg-input px-2 py-1 text-xs text-text-primary transition-colors focus:border-accent-brand ${className}`}
      />
      {saving && <Loader2 className="w-3 h-3 text-accent-brand animate-spin" />}
      {saved && !saving && <Save className="w-3 h-3 text-accent-green" />}
    </div>
  );
}
