import { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  keywords?: string;
}

export interface SettingsNavGroup {
  id: string;
  label: string;
  items: SettingsNavItem[];
}

export function SettingsNav({
  groups,
  activeId,
  onSelect,
  search,
  onSearchChange,
}: {
  groups: SettingsNavGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const query = search.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!query) return groups;
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          const haystack = `${item.label} ${item.keywords ?? ''}`.toLowerCase();
          return haystack.includes(query);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  return (
    <nav className="shrink-0 lg:sticky lg:top-4 lg:w-56">
      <div className="mb-2 relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索设置..."
          className="w-full min-h-8 rounded-md border border-border-input bg-bg-input py-1.5 pl-8 pr-8 text-xs text-text-primary placeholder:text-text-tertiary transition-colors focus:border-accent-brand focus:outline-none"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-tertiary transition-colors hover:text-text-primary"
            aria-label="清除搜索"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border-default bg-bg-secondary/70 p-2">
        {filteredGroups.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-text-tertiary">无匹配设置项</div>
        )}
        {filteredGroups.map((group) => (
          <div key={group.id} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
              {group.label}
            </div>
            {group.items.map(({ id, label, icon: Icon }) => {
              const active = id === activeId;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  className={`inline-flex min-h-8 w-full items-center gap-2 whitespace-nowrap rounded-md border px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                    active
                      ? 'border-border-default bg-bg-hover text-text-primary'
                      : 'border-transparent text-text-secondary hover:border-border-default hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
