import { create } from 'zustand';

type ThemeMode = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

function getSystemPreference(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? getSystemPreference() : mode;
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved);
}

function loadStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem('lingxiao-theme');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.mode) return parsed.mode;
    }
  } catch (err) {
    console.warn('[themeStore] Failed to load stored theme:', err);
  }
  return 'light';
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialMode = loadStoredMode();
  const initialResolved = resolveTheme(initialMode);

  // Apply on init
  if (typeof window !== 'undefined') {
    applyTheme(initialResolved);
  }

  return {
    mode: initialMode,
    resolved: initialResolved,
    setMode: (mode: ThemeMode) => {
      const resolved = resolveTheme(mode);
      applyTheme(resolved);
      localStorage.setItem('lingxiao-theme', JSON.stringify({ mode }));
      set({ mode, resolved });
    },
    toggle: () => {
      const current = get().mode;
      const next: ThemeMode = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
      get().setMode(next);
    },
  };
});

function handleSystemThemeChange() {
  const { mode } = useThemeStore.getState();
  if (mode === 'system') {
    const resolved = getSystemPreference();
    applyTheme(resolved);
    useThemeStore.setState({ resolved });
  }
}

// Listen for system preference changes
if (typeof window !== 'undefined') {
  const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeMedia.addEventListener('change', handleSystemThemeChange);
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      systemThemeMedia.removeEventListener('change', handleSystemThemeChange);
    });
  }
}
