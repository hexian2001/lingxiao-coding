import { Minus, PanelBottomOpen, Plus, TerminalSquare, X } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TerminalPane = lazy(() => import('../canvas/TerminalPane'));

interface WorkbenchTerminalDockProps {
  open: boolean;
  workspaceName: string;
  onOpenChange: (open: boolean) => void;
}

interface TerminalTab {
  id: string;
  title: string;
}

function createTerminalTab(index: number): TerminalTab {
  return {
    id: `chat-workbench-${crypto.randomUUID()}`,
    title: `Terminal ${index}`,
  };
}

function TerminalLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
      <span className="mr-2 h-3 w-3 rounded-full border-2 border-accent-brand border-t-transparent animate-spin" />
      Loading terminal...
    </div>
  );
}

export default function WorkbenchTerminalDock({ open, workspaceName, onOpenChange }: WorkbenchTerminalDockProps) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTerminalTab(1)]);
  const [activeId, setActiveId] = useState(() => tabs[0]?.id || '');
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) || tabs[0], [activeId, tabs]);

  const newTerminal = () => {
    const tab = createTerminalTab(tabs.length + 1);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    onOpenChange(true);
  };

  const closeTerminal = (id: string) => {
    setTabs((current) => {
      if (current.length <= 1) {
        onOpenChange(false);
        return current;
      }
      const next = current.filter((tab) => tab.id !== id);
      if (activeId === id) {
        setActiveId(next[Math.max(0, current.findIndex((tab) => tab.id === id) - 1)]?.id || next[0]?.id || '');
      }
      return next;
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="workbench-terminal-collapsed"
      >
        <PanelBottomOpen size={14} />
        <span className="font-mono">{workspaceName}</span>
        <span className="workbench-terminal-count">{tabs.length}</span>
        <Plus size={13} />
      </button>
    );
  }

  return (
    <section className="workbench-terminal-dock">
      <div className="workbench-terminal-tabs">
        <TerminalSquare size={14} className="shrink-0 text-text-tertiary" />
        <div className="workbench-terminal-tab-strip">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`workbench-terminal-tab ${tab.id === activeTab?.id ? 'is-active' : ''}`}
              title={tab.id}
            >
              <button type="button" className="workbench-terminal-tab-main" onClick={() => setActiveId(tab.id)}>
                <span>{t('workbench.terminalTabLabel', tab.title)}</span>
              </button>
              <button
                type="button"
                className="workbench-terminal-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTerminal(tab.id);
                }}
                title={t('workbench.closeTerminal', '关闭终端')}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="workbench-terminal-icon"
          title={t('workbench.newTerminal', '新终端')}
          onClick={newTerminal}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="workbench-terminal-icon"
          title={t('workbench.collapseTerminal', '收起终端')}
        >
          <Minus size={13} />
        </button>
      </div>
      <div className="workbench-terminal-pane-stack">
        {tabs.map((tab) => (
          <div key={tab.id} className={`workbench-terminal-pane ${tab.id === activeTab?.id ? 'is-active' : ''}`}>
            <Suspense fallback={<TerminalLoading />}>
              <TerminalPane terminalId={tab.id} />
            </Suspense>
          </div>
        ))}
      </div>
    </section>
  );
}
