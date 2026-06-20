import i18n, { normalizeLanguage } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { settingsApiFetch } from './components/settings/settingsApi';
import Sidebar from './components/Sidebar';
import MainContent from './components/MainContent';
import CommandPalette from './components/CommandPalette';
import MaintenanceOverlay from './components/MaintenanceOverlay';
import { ToastProvider } from './components/ui/Toast';
import UpdateNotification from './components/ui/UpdateNotification';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { useSessionStore } from './stores/sessionStore';
import { pickBootstrapSessionId } from './utils/sessionListViewModel';
import InkBackground from './components/decor/InkBackground';
import OnboardingWizard from './components/onboarding/OnboardingWizard';

/**
 * Session bootstrap — runs at app level so SSE connection is established
 * regardless of which view the user lands on after a refresh.
 */
function useSessionBootstrap() {
  const fetchSessions = useSessionStore(s => s.fetchSessions);
  const isConnected = useSessionStore(s => s.isConnected);
  const sessionId = useSessionStore(s => s.sessionId);
  const sessionsLoaded = useSessionStore(s => s.sessionsLoaded);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  // Use session count + first-id as a stable dependency instead of array reference
  const sessionCount = useSessionStore(s => s.sessions.length);
  const firstSessionId = useSessionStore(s => s.sessions[0]?.id ?? null);
  // Read sessions synchronously inside the effect via getState() to avoid
  // depending on the array reference (which changes on every fetchSessions call).
  const connectingRef = useRef(false);

  useEffect(() => { fetchSessions(); }, []);

  useEffect(() => {
    // Guard: already connected or connection in progress
    if (isConnected || sessionId || connectingRef.current) return;
    if (!sessionsLoaded) return;

    const store = useSessionStore.getState();
    const sessions = store.sessions;

    if (sessions.length === 0) {
      connectingRef.current = true;
      store.createAndConnect().finally(() => { connectingRef.current = false; });
      return;
    }
    const targetId = pickBootstrapSessionId(sessions, activeSessionId);
    if (targetId) {
      connectingRef.current = true;
      store.connectToSession(targetId).finally(() => { connectingRef.current = false; });
    }
  }, [isConnected, sessionId, sessionsLoaded, activeSessionId, sessionCount, firstSessionId]);
}

/**
 * 语言统一:从服务端配置 ui.language 读取语言(config 为唯一真源),
 * 优先于 localStorage,使 web 与 TUI 对齐。失败则沿用 localStorage 默认(zh)。
 */
function useConfigLanguageSync() {
  useEffect(() => {
    let cancelled = false;
    settingsApiFetch<{ uiLanguage?: unknown; data?: { uiLanguage?: unknown } }>('/settings')
      .then((s) => {
        if (cancelled) return;
        const cfg = normalizeLanguage(s?.data?.uiLanguage ?? s?.uiLanguage);
        if (cfg && cfg !== i18n.language) i18n.changeLanguage(cfg);
      })
      .catch(() => { /* config 不可用 — 保留 localStorage 默认 */ });
    return () => { cancelled = true; };
  }, []);
}

/**
 * Onboarding guard — checks `initialized` flag from settings.
 * If the app hasn't been initialized yet (first launch), renders
 * the OnboardingWizard overlay to guide the user through LLM config.
 */
function useOnboardingCheck() {
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const checkInitialized = async () => {
      try {
        const s = await settingsApiFetch<{ data?: { initialized?: unknown }; initialized?: unknown }>('/settings');
        if (cancelled) return;
        const initialized = s?.data?.initialized ?? s?.initialized;
        if (initialized) {
          setNeedsOnboarding(false);
          return; // 已初始化，停止轮询
        }
        setNeedsOnboarding(true);
        // 未初始化 → 启动轮询，TUI 端完成配置后 Web UI 自动关闭 wizard
        pollTimer = setTimeout(checkInitialized, 2000);
      } catch {
        if (cancelled) return;
        setNeedsOnboarding(true);
        pollTimer = setTimeout(checkInitialized, 2000);
      }
    };

    checkInitialized();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  return { needsOnboarding, setNeedsOnboarding };
}

export default function App() {
  useSessionBootstrap();
  useConfigLanguageSync();
  const { needsOnboarding, setNeedsOnboarding } = useOnboardingCheck();

  const handleOnboardingComplete = () => {
    setNeedsOnboarding(false);
  };

  const handleOnboardingSkip = () => {
    setNeedsOnboarding(false);
  };

  return (
    <ErrorBoundary>
      <ToastProvider>
        <UpdateNotification />
        <div className="flex h-screen text-text-primary overflow-hidden relative">
          <InkBackground />
          <div className="relative z-10 flex w-full h-full">
            <Sidebar />
            <MainContent />
            <CommandPalette />
            <MaintenanceOverlay />
          </div>
          {needsOnboarding && (
            <OnboardingWizard
              onComplete={handleOnboardingComplete}
              onSkip={handleOnboardingSkip}
            />
          )}
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
}
