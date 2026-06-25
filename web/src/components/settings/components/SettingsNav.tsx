import { useCallback } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
  const handleNavClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  return (
    <nav className="shrink-0 lg:sticky lg:top-4 lg:w-56">
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-border-default bg-bg-secondary/70 p-1 lg:flex-col lg:overflow-visible">
        {items.map(({ id, label, icon: Icon }) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(e) => handleNavClick(e, id)}
            className="inline-flex min-h-8 items-center gap-2 whitespace-nowrap rounded-md border border-transparent px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-default hover:bg-bg-hover hover:text-text-primary"
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </a>
        ))}
      </div>
    </nav>
  );
}
