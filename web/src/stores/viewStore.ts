import { create } from 'zustand';
import { flushSync } from 'react-dom';

export type ViewName =
  | 'chat' | 'tasks' | 'plugins' | 'terminal' | 'canvas' | 'artifact'
  | 'editor' | 'changes' | 'settings'
  | 'keybindings' | 'metrics' | 'stats' | 'traces'
  | 'workers' | 'logs' | 'docs' | 'wiki' | 'git' | 'blackboard'
  | 'team' | 'design-market' | 'memory'
  | 'blueprint' | 'langfuse';

const PANEL_STATE_KEY = 'lingxiao-panel-state';

interface PersistedPanelState {
  sidebarCollapsed: boolean;
}

function loadPanelState(): PersistedPanelState {
  try {
    const stored = localStorage.getItem(PANEL_STATE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (err) {
    console.warn('[viewStore] Failed to load panel state:', err);
  }
  return { sidebarCollapsed: false };
}

function savePanelState(state: PersistedPanelState) {
  try {
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[viewStore] Failed to save panel state:', err);
  }
}

interface ViewState {
  mainView: ViewName;
  sidebarCollapsed: boolean;
  setMainView: (view: ViewName) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const validViews: ViewName[] = [
  'chat', 'tasks', 'plugins', 'terminal', 'canvas',
  'artifact', 'editor', 'changes', 'settings',
  'keybindings', 'metrics', 'stats', 'traces',
  'workers', 'logs', 'docs', 'wiki', 'git', 'blackboard',
  'team', 'design-market', 'memory',
  'blueprint', 'langfuse',
];

const initialPanelState = loadPanelState();

function syncHashToView() {
  const hash = window.location.hash.replace('#/', '');
  if (validViews.includes(hash as ViewName)) {
    useViewStore.setState({ mainView: hash as ViewName });
  }
}

export const useViewStore = create<ViewState>((set) => ({
  mainView: 'chat',
  sidebarCollapsed: initialPanelState.sidebarCollapsed,
  setMainView: (view) => {
    window.location.hash = `#/${view}`;
    const apply = () => set({ mainView: view });
    const doc = typeof document !== 'undefined' ? document : null;
    const reducedMotion = typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const startVT = (doc as unknown as { startViewTransition?: (cb: () => void) => unknown } | null)?.startViewTransition;
    if (doc && typeof startVT === 'function' && !reducedMotion) {
      // 原生视图过渡:flushSync 让 React 在过渡回调内同步提交,cross-fade 捕获新旧快照
      try {
        startVT.call(doc, () => { flushSync(apply); });
      } catch {
        apply();
      }
    } else {
      apply();
    }
  },
  toggleSidebar: () => set((s) => {
    const sidebarCollapsed = !s.sidebarCollapsed;
    savePanelState({ sidebarCollapsed });
    return { sidebarCollapsed };
  }),
  setSidebarCollapsed: (collapsed) => {
    savePanelState({ sidebarCollapsed: collapsed });
    set({ sidebarCollapsed: collapsed });
  },
}));

// Sync hash → store on load
if (typeof window !== 'undefined') {
  syncHashToView();
  window.addEventListener('hashchange', syncHashToView);

  // 清理函数（HMR 和 beforeunload 时调用）
  const cleanup = () => {
    window.removeEventListener('hashchange', syncHashToView);
  };

  if (import.meta.hot) {
    import.meta.hot.dispose(cleanup);
  }

  // 生产环境：页面卸载时清理（虽然通常不必要，因为整个 JS 环境会被销毁）
  window.addEventListener('beforeunload', cleanup, { once: true });
}
