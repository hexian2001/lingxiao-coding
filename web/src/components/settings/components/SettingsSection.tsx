import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function SettingsSection({
  id,
  title,
  icon: Icon,
  iconClassName = 'text-accent-blue',
  desc,
  children,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  iconClassName?: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-12">
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border-muted bg-bg-secondary">
          <Icon className={`w-3.5 h-3.5 ${iconClassName}`} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {desc && <p className="mt-0.5 text-xs leading-relaxed text-text-tertiary">{desc}</p>}
        </div>
      </div>
      <div className="space-y-3 rounded-lg border border-border-default bg-bg-secondary/80 p-3 shadow-[var(--glow-brand)] sm:p-4">
        {children}
      </div>
    </section>
  );
}
