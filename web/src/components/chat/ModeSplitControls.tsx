import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Route, User, Users, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { acpClient } from '../../api/AcpClient';
import { applyRuntimeSnapshotFromRpcResult, useSessionStore } from '../../stores/sessionStore';

type CollaborationMode = 'solo' | 'team';
// UI 仅暴露 auto/direct/delegate；hybrid 不再作为用户选项（auto 运行时默认即解析为 hybrid，二者语义重叠）。
// 后端 preference 类型仍保留 hybrid 做向后兼容，老快照里的 hybrid 偏好由 normalizeRoutePreference 容错回退为 auto。
type RoutePreference = 'auto' | 'direct' | 'delegate';
type ActualRouteMode = RoutePreference | 'hybrid' | 'unknown';

const COLLABORATION_MODES: CollaborationMode[] = ['solo', 'team'];
const ROUTE_PREFERENCES: RoutePreference[] = ['auto', 'direct', 'delegate'];
type BusyKey = `collab:${CollaborationMode}` | `route:${RoutePreference}`;
type NoticeTone = 'pending' | 'success' | 'error';
type ModeNotice = { id: number; tone: NoticeTone; message: string };

function normalizeCollaborationMode(value: unknown): CollaborationMode {
  return value === 'team' ? 'team' : 'solo';
}

function normalizeRoutePreference(value: unknown): RoutePreference {
  return ROUTE_PREFERENCES.includes(value as RoutePreference) ? value as RoutePreference : 'auto';
}

function normalizeActualRouteMode(value: unknown): ActualRouteMode {
  return value === 'direct' || value === 'hybrid' || value === 'delegate' || value === 'auto' || value === 'unknown'
    ? (value as ActualRouteMode)
    : 'direct';
}

function segmentClass(active: boolean, loading: boolean): string {
  return active
    ? `border-accent-brand/70 bg-accent-brand/15 text-accent-brand shadow-[0_0_16px_rgba(69,190,255,0.22)] ${loading ? 'animate-pulse' : 'scale-[1.015]'}`
    : 'border-transparent text-text-tertiary hover:border-border-default hover:bg-bg-tertiary hover:text-text-primary';
}

function noticeClass(tone: NoticeTone): string {
  if (tone === 'error') return 'border-accent-red/30 bg-accent-red/10 text-accent-red';
  if (tone === 'success') return 'border-accent-green/30 bg-accent-green/10 text-accent-green';
  return 'border-accent-brand/30 bg-accent-brand/10 text-accent-brand';
}

export function ModeSplitControls() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const isConnected = useSessionStore((s) => s.isConnected);
  const modes = useSessionStore((s) => s.runtimeSnapshot?.modes);
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const [notice, setNotice] = useState<ModeNotice | null>(null);

  useEffect(() => {
    if (!notice || notice.tone === 'pending') return undefined;
    const timer = window.setTimeout(() => setNotice((current) => current?.id === notice.id ? null : current), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!sessionId || !isConnected) return null;

  const collaborationMode = normalizeCollaborationMode(modes?.collaboration.mode);
  const routePreference = normalizeRoutePreference(modes?.route.preference);
  const actualRouteMode = normalizeActualRouteMode(modes?.route.mode);
  const collaborationLabels: Record<CollaborationMode, string> = {
    solo: t('chat.modeSplit.solo'),
    team: t('chat.modeSplit.team'),
  };
  const routeLabels: Record<RoutePreference, string> = {
    auto: t('chat.modeSplit.auto'),
    direct: t('chat.modeSplit.direct'),
    delegate: t('chat.modeSplit.delegate'),
  };
  const actualRouteLabels: Record<ActualRouteMode, string> = {
    auto: t('chat.modeSplit.auto'),
    direct: t('chat.modeSplit.direct'),
    delegate: t('chat.modeSplit.delegate'),
    hybrid: t('chat.modeSplit.hybrid'),
    unknown: '—',
  };
  const routeHints: Record<RoutePreference, string> = {
    auto: t('chat.modeSplit.autoHint'),
    direct: t('chat.modeSplit.directHint'),
    delegate: t('chat.modeSplit.delegateHint'),
  };
  const collaborationHints: Record<CollaborationMode, string> = {
    solo: t('chat.modeSplit.soloHint'),
    team: t('chat.modeSplit.teamHint'),
  };
  const setModeNotice = (tone: NoticeTone, message: string) => {
    setNotice({ id: Date.now(), tone, message });
  };

  // 钉死 direct/delegate 时，实际运行 mode 偏离才提示；auto 偏好下 mode 经常变（hybrid/delegate），不提示，避免"当前混合"式困惑。
  const routeDeviation =
    routePreference !== 'auto' && actualRouteMode !== 'unknown' && actualRouteMode !== routePreference;

  const applyCollaboration = async (mode: CollaborationMode) => {
    if (busy || mode === collaborationMode) return;
    setBusy(`collab:${mode}`);
    setModeNotice('pending', t('chat.modeSplit.pendingCollaboration', { mode: collaborationLabels[mode] }));
    try {
      const result = await acpClient.sendJsonRpc('session/set_collaboration_mode', { mode });
      if (!applyRuntimeSnapshotFromRpcResult(result, sessionId)) {
        setModeNotice('error', t('chat.modeSplit.noSnapshot'));
        return;
      }
      setModeNotice('success', t('chat.modeSplit.collaborationSuccess', { mode: collaborationLabels[mode] }));
    } catch {
      setModeNotice('error', t('chat.modeSplit.errorCollaboration', { mode: collaborationLabels[mode] }));
    } finally {
      setBusy(null);
    }
  };

  const applyRoute = async (mode: RoutePreference) => {
    if (busy || mode === routePreference) return;
    setBusy(`route:${mode}`);
    setModeNotice('pending', t('chat.modeSplit.pendingRoute', { mode: routeLabels[mode] }));
    try {
      const result = await acpClient.sendJsonRpc('session/set_execution_route', { mode });
      if (!applyRuntimeSnapshotFromRpcResult(result, sessionId)) {
        setModeNotice('error', t('chat.modeSplit.noSnapshot'));
        return;
      }
      setModeNotice('success', t('chat.modeSplit.routeSuccess', { mode: routeLabels[mode] }));
    } catch {
      setModeNotice('error', t('chat.modeSplit.errorRoute', { mode: routeLabels[mode] }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-2 w-full rounded-lg border border-border-muted bg-bg-primary/78 px-3 py-2 shadow-[0_10px_28px_rgba(0,0,0,0.12)] backdrop-blur-xl transition-all duration-200 hover:border-border-default">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div
            className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-normal text-text-secondary"
            title={t('chat.modeSplit.permissionHint')}
          >
            <Route size={12} className="text-accent-brand" />
            <span>{t('chat.modeSplit.title')}</span>
            <span className="hidden min-w-0 truncate text-[11px] font-normal normal-case text-text-tertiary sm:inline">
              {routeHints[routePreference]}
            </span>
          </div>
        </div>
        {notice && (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-200 ${noticeClass(notice.tone)}`}
          >
            {notice.tone === 'pending' ? <Loader2 size={12} className="animate-spin" /> : notice.tone === 'success' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            <span className="truncate">{notice.message}</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div
          className="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-md border border-border-muted bg-bg-primary/80 p-0.5 shadow-sm transition-colors duration-200 hover:border-border-default"
          title={collaborationHints[collaborationMode]}
        >
          <span className="shrink-0 px-1.5 text-[10px] font-medium uppercase tracking-normal text-text-tertiary">
            {t('chat.modeSplit.collaborationLabel')}
          </span>
          {COLLABORATION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => void applyCollaboration(mode)}
              disabled={Boolean(busy)}
              aria-label={t('chat.modeSplit.switchTo', { mode: collaborationLabels[mode] })}
              title={collaborationHints[mode]}
              aria-pressed={mode === collaborationMode}
              className={`inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-[5px] border px-2 text-[11px] font-medium transition-all duration-200 ease-out sm:flex-none ${segmentClass(mode === collaborationMode, busy === `collab:${mode}`)} ${busy ? 'opacity-70' : ''}`}
            >
              {busy === `collab:${mode}` ? <Loader2 size={12} className="animate-spin" /> : mode === 'team' ? <Users size={12} /> : <User size={12} />}
              <span>{collaborationLabels[mode]}</span>
            </button>
          ))}
        </div>
        <div
          className="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-md border border-border-muted bg-bg-primary/80 p-0.5 shadow-sm transition-colors duration-200 hover:border-border-default"
          title={routeHints[routePreference]}
        >
          <div className="flex h-7 shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium uppercase tracking-normal text-text-tertiary">
            <Route size={11} />
            <span>{t('chat.modeSplit.routeLabel')}</span>
          </div>
          {routeDeviation && (
            <span
              className="mr-0.5 inline-flex shrink-0 items-center gap-0.5 rounded-[5px] border border-border-default bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
              title={t('chat.modeSplit.routeDeviation', { preference: routeLabels[routePreference], actual: actualRouteLabels[actualRouteMode] })}
            >
              <Zap size={10} className="text-accent-brand" />
              <span>{actualRouteLabels[actualRouteMode]}</span>
            </span>
          )}
          {ROUTE_PREFERENCES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => void applyRoute(mode)}
              disabled={Boolean(busy)}
              aria-label={t('chat.modeSplit.switchTo', { mode: routeLabels[mode] })}
              title={routeHints[mode]}
              aria-pressed={mode === routePreference}
              className={`inline-flex h-7 flex-1 items-center justify-center rounded-[5px] border px-2 text-[11px] font-medium transition-all duration-200 ease-out sm:flex-none ${segmentClass(mode === routePreference, busy === `route:${mode}`)} ${busy ? 'opacity-70' : ''}`}
            >
              {busy === `route:${mode}` ? <Loader2 size={12} className="animate-spin" /> : routeLabels[mode]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
