import { useState, useEffect, useCallback } from 'react';
import { Command } from 'cmdk';
import {
  MessageSquare,
  FileCode2,
  ListTodo,
  Cpu,
  Activity,
  BarChart3,
  ScrollText,
  Code2,
  LayoutDashboard,
  GitBranch,
  Settings,
  Keyboard,
  BookOpen,
  Plug,
  Server,
  Palette,
  Moon,
  Sun,
  Monitor,
  RotateCcw,
  Terminal,
  Search,
  Brain,
} from 'lucide-react';
import { useViewStore } from '../stores/viewStore';
import { useThemeStore } from '../stores/themeStore';
import { useTranslation } from 'react-i18next';
import { persistLanguage, type WebLanguage } from '../i18n';
import { notifySettingChanged, settingsApiFetch } from './settings/settingsApi';

interface CommandItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  category: 'view' | 'command' | 'action';
  action: () => void;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const setMainView = useViewStore((s) => s.setMainView);
  const { mode, setMode } = useThemeStore();
  const { t, i18n } = useTranslation();
  const setLanguage = (language: WebLanguage) => {
    i18n.changeLanguage(language).then(() => {
      persistLanguage(language);
      return settingsApiFetch('/settings/general', {
        method: 'PUT',
        body: JSON.stringify({ key: 'uiLanguage', value: language }),
      });
    }).then(() => notifySettingChanged({ key: 'uiLanguage', value: language })).catch(() => {});
  };

  const commands: CommandItem[] = [
    // Views
    { id: 'view:chat', label: t('commandPalette.items.chat'), icon: MessageSquare, category: 'view', action: () => setMainView('chat') },
    { id: 'view:changes', label: t('commandPalette.items.changes'), icon: GitBranch, category: 'view', action: () => setMainView('changes') },
    { id: 'view:tasks', label: t('commandPalette.items.tasks'), icon: ListTodo, category: 'view', action: () => setMainView('tasks') },
    { id: 'view:workers', label: t('commandPalette.items.workers'), icon: Cpu, category: 'view', action: () => setMainView('workers') },
    { id: 'view:metrics', label: t('commandPalette.items.metrics'), icon: Activity, category: 'view', action: () => setMainView('metrics') },
    { id: 'view:stats', label: t('commandPalette.items.stats'), icon: BarChart3, category: 'view', action: () => setMainView('stats') },
    { id: 'view:logs', label: t('commandPalette.items.logs'), icon: ScrollText, category: 'view', action: () => setMainView('logs') },
    { id: 'view:editor', label: t('commandPalette.items.editor'), icon: Code2, category: 'view', action: () => setMainView('editor') },
    { id: 'view:canvas', label: t('commandPalette.items.canvas'), icon: LayoutDashboard, category: 'view', action: () => setMainView('canvas') },
    { id: 'view:terminal', label: t('commandPalette.items.terminal'), icon: Terminal, category: 'view', action: () => setMainView('terminal') },
    { id: 'view:traces', label: t('commandPalette.items.traces'), icon: GitBranch, category: 'view', action: () => setMainView('traces') },
    { id: 'view:daemon', label: t('commandPalette.items.daemon'), icon: Server, category: 'view', action: () => setMainView('workers') },
    { id: 'view:settings', label: t('commandPalette.items.settings'), icon: Settings, category: 'view', action: () => setMainView('settings') },
    { id: 'view:keybindings', label: t('commandPalette.items.keybindings'), icon: Keyboard, category: 'view', action: () => setMainView('keybindings') },
    { id: 'view:docs', label: t('commandPalette.items.docs'), icon: BookOpen, category: 'view', action: () => setMainView('docs') },
    { id: 'view:plugins', label: t('commandPalette.items.plugins'), icon: Plug, category: 'view', action: () => setMainView('plugins') },
    { id: 'view:memory', label: t('commandPalette.items.memory'), icon: Brain, category: 'view', action: () => setMainView('memory') },
    // Commands
    { id: 'cmd:theme-dark', label: t('commandPalette.items.themeDark'), icon: Moon, category: 'command', action: () => setMode('dark') },
    { id: 'cmd:theme-light', label: t('commandPalette.items.themeLight'), icon: Sun, category: 'command', action: () => setMode('light') },
    { id: 'cmd:theme-system', label: t('commandPalette.items.themeSystem'), icon: Monitor, category: 'command', action: () => setMode('system') },
    { id: 'cmd:toggle-theme', label: t('commandPalette.items.toggleTheme'), icon: Palette, category: 'command', action: () => setMode(mode === 'dark' ? 'light' : 'dark') },
    { id: 'cmd:lang-en', label: t('commandPalette.items.languageEnglish'), icon: MessageSquare, category: 'command', action: () => setLanguage('en') },
    { id: 'cmd:lang-zh', label: t('commandPalette.items.languageChinese'), icon: MessageSquare, category: 'command', action: () => setLanguage('zh') },
    { id: 'cmd:reload', label: t('commandPalette.items.reload'), icon: RotateCcw, category: 'command', action: () => window.location.reload() },
  ];

  const runCommand = useCallback(
    (cmd: CommandItem) => {
      cmd.action();
      setOpen(false);
    },
    [],
  );

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'p' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const categories = [
    { key: 'view' as const, label: t('commandPalette.views') },
    { key: 'command' as const, label: t('commandPalette.commands') },
    { key: 'action' as const, label: t('commandPalette.actions') },
  ];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
    >
      {/* Backdrop — unified overlay */}
      <div className="lx-overlay" style={{ alignItems: 'flex-start', paddingTop: '20vh' }} onClick={() => setOpen(false)} />

      {/* Dialog */}
      <div className="relative w-full max-w-lg bg-bg-card border border-border-default rounded-lg shadow-2xl font-mono overflow-hidden animate-fade-in">
        {/* Search Input */}
        <div className="flex items-center border-b border-border-default px-3">
          <Search size={14} className="text-text-tertiary shrink-0" />
          <Command.Input
            className="flex-1 rounded-md border border-border-input bg-bg-input outline-none px-2 py-1.5 my-1 text-xs text-text-primary placeholder:text-text-tertiary"
            placeholder={t('commandPalette.searchPlaceholder')}
          />
          <kbd className="text-[9px] text-text-tertiary bg-bg-tertiary px-1.5 py-0.5 rounded border border-border-default">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <Command.List className="max-h-72 overflow-y-auto p-1">
          <Command.Empty className="py-6 text-center text-xs text-text-tertiary">
            {t('commandPalette.noResults')}
          </Command.Empty>

          {categories.map((cat) => {
            const items = commands.filter((c) => c.category === cat.key);
            if (items.length === 0) return null;
            return (
              <Command.Group key={cat.key} heading={cat.label}>
                {items.map((cmd) => (
                  <Command.Item
                    key={cmd.id}
                    onSelect={() => runCommand(cmd)}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary rounded cursor-pointer data-[selected=true]:bg-bg-hover data-[selected=true]:text-text-primary transition-colors"
                  >
                    <cmd.icon size={13} />
                    <span className="flex-1">{cmd.label}</span>
                    <span className="text-[9px] text-text-tertiary uppercase">{cat.key}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-border-default px-3 py-1.5 text-[9px] text-text-tertiary">
          <span>
            <kbd className="bg-bg-tertiary px-1 py-0.5 rounded border border-border-default">&uarr;&darr;</kbd>{' '}
            {t('commandPalette.footer.navigate')}
          </span>
          <span>
            <kbd className="bg-bg-tertiary px-1 py-0.5 rounded border border-border-default">&crarr;</kbd> {t('commandPalette.footer.select')}
          </span>
          <span>
            <kbd className="bg-bg-tertiary px-1 py-0.5 rounded border border-border-default">Esc</kbd> {t('commandPalette.footer.close')}
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}
