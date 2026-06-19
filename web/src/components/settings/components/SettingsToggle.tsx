import { Loader2, Save } from 'lucide-react';

export function SettingsToggle({
  value,
  onChange,
  saving,
  saved,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  saving?: boolean;
  saved?: boolean;
  disabled?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        aria-pressed={value}
        className={`relative h-6 w-11 rounded-full border transition-colors ${value ? 'border-accent-brand bg-accent-brand' : 'border-border-input bg-bg-tertiary'} ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-accent-brand/70'}`}
        onClick={() => onChange(!value)}
        disabled={saving || disabled}
      >
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${value ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
      {saving && <Loader2 className="w-3 h-3 text-accent-brand animate-spin" />}
      {saved && !saving && <Save className="w-3 h-3 text-accent-green" />}
    </>
  );
}
