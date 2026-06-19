/**
 * maintenanceStore — 后台记忆维护（dream/distill）的实时状态。
 *
 * 订阅 acpClient 的 canonical session/update，过滤 memory:maintenance_* 事件，
 * 驱动右下角浮层动画。镜像 wikiStore 的订阅/去重/HMR 模式，保持两端一致。
 *
 * 维护是全局后台活动（daemon 或 TUI 启动触发），不绑定具体会话，因此这里不做
 * sessionId 过滤——任意打开的 Web 客户端都应看到正在进行的整理。
 */
import { create } from 'zustand';
import { acpClient } from '../api/AcpClient';
import { extractCanonicalEventEnvelope, SESSION_UPDATE_METHOD } from '@contracts/adapters/EventAdapter';

export type MaintenanceKind = 'dream' | 'distill';
export type MaintenancePhase = 'idle' | 'running' | 'completed' | 'failed';

export interface MaintenanceState {
  /** 当前可见状态；idle 时浮层不渲染。 */
  phase: MaintenancePhase;
  kind: MaintenanceKind | null;
  /** 0..1，由 pipeline 各阶段固定上报。 */
  progress: number;
  /** pipeline 阶段标识（reading/analyzing/generating/writing/scanning）。 */
  stage: string;
  /** 人类可读的当前动作描述。 */
  detail: string;
  /** 完成/失败时的总结或错误文案。 */
  summary: string;

  startRun: (kind: MaintenanceKind) => void;
  setProgress: (kind: MaintenanceKind, stage: string, progress: number, detail: string) => void;
  complete: (kind: MaintenanceKind, summary: string) => void;
  fail: (kind: MaintenanceKind, error: string) => void;
  reset: () => void;
}

/** 完成/失败后浮层停留时长（ms），随后自动淡出回 idle。 */
const SETTLE_MS = 4000;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function clearSettle(): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

export const useMaintenanceStore = create<MaintenanceState>((set, get) => ({
  phase: 'idle',
  kind: null,
  progress: 0,
  stage: '',
  detail: '',
  summary: '',

  startRun: (kind) => {
    clearSettle();
    set({ phase: 'running', kind, progress: 0.05, stage: 'started', detail: '', summary: '' });
  },

  setProgress: (kind, stage, progress, detail) => {
    // 进度只向前：避免 distill/dream 事件交错导致回退跳动。
    const prev = get();
    const next = prev.kind === kind ? Math.max(prev.progress, progress) : progress;
    clearSettle();
    set({ phase: 'running', kind, stage, progress: next, detail });
  },

  complete: (kind, summary) => {
    clearSettle();
    set({ phase: 'completed', kind, progress: 1, summary });
    settleTimer = setTimeout(() => get().reset(), SETTLE_MS);
  },

  fail: (kind, error) => {
    clearSettle();
    set({ phase: 'failed', kind, summary: error });
    settleTimer = setTimeout(() => get().reset(), SETTLE_MS);
  },

  reset: () => {
    clearSettle();
    set({ phase: 'idle', kind: null, progress: 0, stage: '', detail: '', summary: '' });
  },
}));

// ─── SSE 事件监听 ────────────────────────────────────
type MaintenanceEventType =
  | 'memory:maintenance_started'
  | 'memory:maintenance_progress'
  | 'memory:maintenance_completed'
  | 'memory:maintenance_failed';

const MAINTENANCE_EVENT_TYPES = new Set<string>([
  'memory:maintenance_started',
  'memory:maintenance_progress',
  'memory:maintenance_completed',
  'memory:maintenance_failed',
]);

const MAINTENANCE_DEDUPE_TTL_MS = 1000;
const seenMaintenanceEventIds = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pruneSeen(now: number): void {
  for (const [eventId, at] of seenMaintenanceEventIds.entries()) {
    if (now - at > MAINTENANCE_DEDUPE_TTL_MS) seenMaintenanceEventIds.delete(eventId);
  }
}

function kindOf(payload: Record<string, unknown>): MaintenanceKind {
  return payload.kind === 'distill' ? 'distill' : 'dream';
}

function applyMaintenanceEvent(type: MaintenanceEventType, payload: Record<string, unknown>): void {
  const store = useMaintenanceStore.getState();
  const kind = kindOf(payload);
  switch (type) {
    case 'memory:maintenance_started':
      store.startRun(kind);
      break;
    case 'memory:maintenance_progress':
      store.setProgress(
        kind,
        typeof payload.phase === 'string' ? payload.phase : '',
        typeof payload.progress === 'number' ? payload.progress : 0,
        typeof payload.detail === 'string' ? payload.detail : '',
      );
      break;
    case 'memory:maintenance_completed':
      store.complete(kind, typeof payload.summary === 'string' ? payload.summary : '');
      break;
    case 'memory:maintenance_failed':
      store.fail(kind, typeof payload.error === 'string' ? payload.error : 'Unknown error');
      break;
  }
}

let maintenanceSseUnsubscribe: (() => void) | null = null;

export function ensureMaintenanceSseSubscription(): void {
  if (maintenanceSseUnsubscribe) return;
  maintenanceSseUnsubscribe = acpClient.on(SESSION_UPDATE_METHOD, (data) => {
    const envelope = extractCanonicalEventEnvelope(data);
    if (!envelope || !MAINTENANCE_EVENT_TYPES.has(envelope.type)) return;
    const now = Date.now();
    pruneSeen(now);
    if (envelope.eventId) {
      if (seenMaintenanceEventIds.has(envelope.eventId)) return;
      seenMaintenanceEventIds.set(envelope.eventId, now);
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    applyMaintenanceEvent(envelope.type as MaintenanceEventType, payload);
  });
}

export function disposeMaintenanceSseSubscription(): void {
  maintenanceSseUnsubscribe?.();
  maintenanceSseUnsubscribe = null;
}

ensureMaintenanceSseSubscription();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeMaintenanceSseSubscription();
  });
}
