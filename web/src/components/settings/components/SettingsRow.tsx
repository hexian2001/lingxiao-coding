import type { ReactNode } from 'react';

export function SettingsRow({
  label,
  desc,
  children,
  error,
  hint,
  align = 'center',
  compact = false,
}: {
  label: string;
  desc?: string;
  children: ReactNode;
  error?: string;
  hint?: ReactNode;
  align?: 'center' | 'start';
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-md transition-colors ${compact ? '' : 'px-0.5 py-1'}`}>
      <div className={`flex flex-col gap-2 sm:flex-row sm:justify-between sm:gap-4 ${align === 'start' ? 'sm:items-start' : 'sm:items-center'}`}>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">{label}</div>
          {desc && <div className="mt-0.5 max-w-2xl text-xs leading-relaxed text-text-tertiary">{desc}</div>}
          {hint && <div className="mt-1 max-w-2xl text-xs leading-relaxed text-text-tertiary">{hint}</div>}
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:shrink-0 sm:justify-end">{children}</div>
      </div>
      {error && <div className="text-xs font-mono text-accent-red">{error}</div>}
    </div>
  );
}

export function SettingsSubsection({
  title,
  desc,
  children,
}: {
  title?: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border-muted bg-bg-card/55 p-3">
      {(title || desc) && (
        <div className="mb-3">
          {title && <div className="text-xs font-semibold uppercase text-text-secondary">{title}</div>}
          {desc && <div className="mt-0.5 text-xs leading-relaxed text-text-tertiary">{desc}</div>}
        </div>
      )}
      <div className="space-y-3">{children}</div>
    </div>
  );
}
