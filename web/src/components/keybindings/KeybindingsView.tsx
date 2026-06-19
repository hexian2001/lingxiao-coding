/**
 * KeybindingsView — 快捷键覆盖层
 *
 * 显示所有快捷键分类，支持搜索和重置
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Keyboard, Search, RotateCcw, ChevronDown, ChevronRight,
} from 'lucide-react';

interface Keybinding {
  actionKey: string;
  keys: string[];
  categoryKey: string;
}

const defaultKeybindings: Keybinding[] = [
  { actionKey: 'sendMessage', keys: ['Enter'], categoryKey: 'chat' },
  { actionKey: 'newLine', keys: ['Shift', 'Enter'], categoryKey: 'chat' },
  { actionKey: 'stopGeneration', keys: ['Escape'], categoryKey: 'chat' },
  { actionKey: 'toggleDeepThinking', keys: ['Ctrl', 'Shift', 'D'], categoryKey: 'chat' },
  { actionKey: 'toggleSidebar', keys: ['Ctrl', 'B'], categoryKey: 'navigation' },
  { actionKey: 'commandPalette', keys: ['Ctrl', 'Shift', 'P'], categoryKey: 'navigation' },
  { actionKey: 'quickOpen', keys: ['Ctrl', 'P'], categoryKey: 'editor' },
  { actionKey: 'saveFile', keys: ['Ctrl', 'S'], categoryKey: 'editor' },
  { actionKey: 'search', keys: ['Ctrl', 'F'], categoryKey: 'general' },
  { actionKey: 'toggleTheme', keys: ['Ctrl', 'Shift', 'T'], categoryKey: 'general' },
  { actionKey: 'toggleLanguage', keys: ['Ctrl', 'Shift', 'L'], categoryKey: 'general' },
  { actionKey: 'newChat', keys: ['Ctrl', 'N'], categoryKey: 'chat' },
  { actionKey: 'zoomIn', keys: ['Ctrl', '+'], categoryKey: 'canvas' },
  { actionKey: 'zoomOut', keys: ['Ctrl', '-'], categoryKey: 'canvas' },
  { actionKey: 'resetZoom', keys: ['Ctrl', '0'], categoryKey: 'canvas' },
  { actionKey: 'nextView', keys: ['Ctrl', 'Tab'], categoryKey: 'navigation' },
];

export default function KeybindingsView() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [customBindings, setCustomBindings] = useState<Record<string, string[]> | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set([...new Set(defaultKeybindings.map((kb) => kb.categoryKey))])
  );

  // Merge custom bindings with defaults
  const keybindings: Keybinding[] = defaultKeybindings.map((kb) => ({
    ...kb,
    keys: customBindings?.[kb.actionKey] || kb.keys,
  }));

  const filtered = useMemo(() => {
    if (!search) return keybindings;
    const q = search.toLowerCase();
    return keybindings.filter(
      (kb) => t(`keybindings.action.${kb.actionKey}`).toLowerCase().includes(q) || kb.keys.some((k) => k.toLowerCase().includes(q))
    );
  }, [search, keybindings, t]);

  const categories = useMemo(() => {
    const cats = new Map<string, Keybinding[]>();
    for (const kb of filtered) {
      if (!cats.has(kb.categoryKey)) cats.set(kb.categoryKey, []);
      cats.get(kb.categoryKey)!.push(kb);
    }
    return cats;
  }, [filtered]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleResetAll = () => {
    setCustomBindings(null);
    try { localStorage.removeItem('lingxiao_custom_keybindings'); } catch (err) { console.warn('[KeybindingsView] Failed to reset custom keybindings:', err); }
  };

  // Load custom bindings from localStorage on mount
  useState(() => {
    try {
      const stored = localStorage.getItem('lingxiao_custom_keybindings');
      if (stored) setCustomBindings(JSON.parse(stored));
    } catch (err) {
      console.warn('[KeybindingsView] Failed to load custom keybindings:', err);
    }
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border-default bg-bg-secondary shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
            <Keyboard className="w-4 h-4" />
            {t('keybindings.title')}
          </h2>
          <button className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary" onClick={handleResetAll} title={t('keybindings.resetAll')}>
            <RotateCcw className="w-3.5 h-3.5" />
            {t('keybindings.resetAll')}
          </button>
        </div>
        <div className="mt-2 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('keybindings.search')}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {[...categories.entries()].map(([category, kbs]) => {
          const isExpanded = expandedCategories.has(category);
          return (
            <div key={category}>
              <button
                className="w-full px-4 py-2 flex items-center gap-2 text-sm font-medium text-text-primary hover:bg-bg-hover transition-colors border-b border-border-default/50"
                onClick={() => toggleCategory(category)}
              >
                {isExpanded ? <ChevronDown className="w-4 h-4 text-text-tertiary" /> : <ChevronRight className="w-4 h-4 text-text-tertiary" />}
                {t(`keybindings.category.${category}`)}
                <span className="text-xs text-text-tertiary ml-auto">{kbs.length}</span>
              </button>
              {isExpanded && (
                <div className="divide-y divide-border-default/30">
                  {kbs.map((kb, i) => (
                    <div key={i} className="px-4 py-2 flex items-center gap-3 hover:bg-bg-hover transition-colors">
                      <span className="text-sm text-text-primary flex-1">{t(`keybindings.action.${kb.actionKey}`)}</span>
                      <div className="flex items-center gap-1">
                        {kb.keys.map((key, ki) => (
                          <span key={ki}>
                            {ki > 0 && <span className="text-text-tertiary text-xs mx-0.5">+</span>}
                            <kbd className="px-1.5 py-0.5 text-xs bg-bg-tertiary border border-border-default rounded text-text-secondary font-mono">
                              {key}
                            </kbd>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
