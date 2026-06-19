/**
 * wikiStore — Wiki 状态管理
 *
 * 通过 SSE (acpClient) 接收实时生成进度
 */

import { create } from 'zustand';
import { acpClient } from '../api/AcpClient';
import i18n from '../i18n';
import { getServerToken } from '../api/headers';
import { useSessionStore } from './sessionStore';
import { extractCanonicalEventEnvelope, SESSION_UPDATE_METHOD } from '@contracts/adapters/EventAdapter';

export interface WikiStatus {
  projectPath: string;
  lang: string;
  exists: boolean;
  generating: boolean;
  lastGeneratedAt: number | null;
  documentCount: number;
  totalSize: number;
  changeCount: number;
  version: number;
}

export interface WikiDocument {
  path: string;
  title: string;
  section: string;
  size: number;
  lastModified: number;
}

type WikiGenerationUpdate =
  | { type: 'generation_started'; sessionId?: string; projectPath?: string; lang?: string }
  | { type: 'generation_progress'; sessionId?: string; projectPath?: string; lang?: string; phase?: string; progress?: number; detail?: string }
  | { type: 'generation_completed'; sessionId?: string; projectPath?: string; lang?: string; result?: unknown }
  | { type: 'generation_failed'; sessionId?: string; projectPath?: string; lang?: string; error?: string }
  | { type: 'generation_stream'; sessionId?: string; projectPath?: string; lang?: string; sectionId: string; sectionTitle: string; chunk: string };

type WikiCanonicalEventType =
  | 'wiki:generation_started'
  | 'wiki:generation_progress'
  | 'wiki:generation_completed'
  | 'wiki:generation_failed'
  | 'wiki:generation_stream';

const WIKI_EVENT_TO_UPDATE_TYPE: Readonly<Record<WikiCanonicalEventType, WikiGenerationUpdate['type']>> = {
  'wiki:generation_started': 'generation_started',
  'wiki:generation_progress': 'generation_progress',
  'wiki:generation_completed': 'generation_completed',
  'wiki:generation_failed': 'generation_failed',
  'wiki:generation_stream': 'generation_stream',
};

const WIKI_DEDUPE_TTL_MS = 1000;
const seenWikiEventIds = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function pruneSeenWikiSignatures(now: number): void {
  for (const [eventId, at] of seenWikiEventIds.entries()) {
    if (now - at > WIKI_DEDUPE_TTL_MS) seenWikiEventIds.delete(eventId);
  }
}

function normalizeWikiUpdate(value: unknown): WikiGenerationUpdate | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const params = value;
  switch (params.type) {
    case 'generation_started':
    case 'generation_completed':
      return params as WikiGenerationUpdate;
    case 'generation_progress':
      return {
        ...params,
        type: 'generation_progress',
        progress: typeof params.progress === 'number' ? params.progress : 0,
        phase: typeof params.phase === 'string' ? params.phase : '',
        detail: typeof params.detail === 'string' ? params.detail : '',
      };
    case 'generation_failed':
      return {
        ...params,
        type: 'generation_failed',
        error: typeof params.error === 'string' ? params.error : 'Unknown error',
      };
    case 'generation_stream':
      if (
        typeof params.sectionId !== 'string' ||
        typeof params.sectionTitle !== 'string' ||
        typeof params.chunk !== 'string'
      ) {
        return null;
      }
      return params as WikiGenerationUpdate;
    default:
      return null;
  }
}

function wikiUpdateTypeForEvent(type: string): WikiGenerationUpdate['type'] | null {
  return WIKI_EVENT_TO_UPDATE_TYPE[type as WikiCanonicalEventType] ?? null;
}

function normalizeCanonicalWikiUpdate(value: unknown): { update: WikiGenerationUpdate; eventId?: string } | null {
  const envelope = extractCanonicalEventEnvelope(value);
  if (!envelope) return null;
  const updateType = wikiUpdateTypeForEvent(envelope.type);
  if (!updateType) return null;
  const update = normalizeWikiUpdate({
    ...(isRecord(envelope.payload) ? envelope.payload : {}),
    type: updateType,
    sessionId: envelope.sessionId || (isRecord(envelope.payload) ? stringValue(envelope.payload.sessionId) ?? undefined : undefined),
  });
  return update ? { update, eventId: envelope.eventId } : null;
}

interface WikiState {
  activeProjectPath: string | null;
  activeSessionId: string | null;
  status: WikiStatus | null;
  documents: WikiDocument[];
  selectedDocument: string | null;
  documentContent: string | null;
  isGenerating: boolean;
  generationPhase: string | null;
  generationProgress: number;
  generationDetail: string | null;
  /** per-section streaming buffers: Map<sectionId, {title, text}> */
  streamingSections: Map<string, { title: string; text: string }>;
  /** Last active section stream used by the current single-document view. */
  streamingText: string;
  streamingSectionId: string | null;
  streamingSectionTitle: string | null;
  isLoading: boolean;
  error: string | null;
  lang: 'zh' | 'en';
  /** 断点续传：上次未完成的 checkpoint 信息 */
  checkpoint: { exists: boolean; completedCount: number; totalCount: number } | null;

  setLang: (lang: 'zh' | 'en') => void;
  fetchStatus: (projectPath: string) => Promise<void>;
  fetchCheckpoint: (projectPath: string) => Promise<void>;
  generateWiki: (projectPath: string) => Promise<void>;
  updateWiki: (projectPath: string) => Promise<void>;
  deleteWiki: (projectPath: string) => Promise<void>;
  fetchDocuments: (projectPath: string) => Promise<void>;
  fetchDocument: (projectPath: string, docPath: string) => Promise<void>;
  setSelectedDocument: (path: string | null) => void;
  checkForUpdates: (projectPath: string) => Promise<void>;
  setGenerationProgress: (phase: string, progress: number, detail: string) => void;
  setGenerationComplete: () => void;
  setGenerationFailed: (error: string) => void;
  appendStreamChunk: (sectionId: string, sectionTitle: string, chunk: string) => void;
  clearError: () => void;
}

function currentSessionId(): string | null {
  return useSessionStore.getState().sessionId || acpClient.getSessionId() || null;
}

function shouldAcceptWikiUpdate(params: WikiGenerationUpdate, state: WikiState): boolean {
  const updateSessionId = stringValue(params.sessionId);
  const stateSessionId = state.activeSessionId || currentSessionId();
  if (updateSessionId && stateSessionId && updateSessionId !== stateSessionId) {
    return false;
  }

  const updateProjectPath = stringValue(params.projectPath);
  const stateProjectPath = state.activeProjectPath || state.status?.projectPath || null;
  if (updateProjectPath && stateProjectPath && updateProjectPath !== stateProjectPath) {
    return false;
  }

  return true;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const hasBody = opts?.body != null;
  const headers: Record<string, string> = {
    'x-lingxiao-token': getServerToken(),
    ...(opts?.headers as Record<string, string> || {}),
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const useWikiStore = create<WikiState>((set, get) => ({
  activeProjectPath: null,
  activeSessionId: null,
  status: null,
  documents: [],
  selectedDocument: null,
  documentContent: null,
  isGenerating: false,
  generationPhase: null,
  generationProgress: 0,
  generationDetail: null,
  streamingSections: new Map(),
  streamingText: '',
  streamingSectionId: null,
  streamingSectionTitle: null,
  isLoading: false,
  error: null,
  lang: 'zh',
  checkpoint: null,

  setLang: (lang) => set({ lang, status: null, documents: [], selectedDocument: null, documentContent: null, checkpoint: null }),

  fetchCheckpoint: async (projectPath) => {
    set({ activeProjectPath: projectPath, activeSessionId: currentSessionId() });
    const { lang } = get();
    try {
      const data = await apiFetch<{ exists: boolean; completedCount: number; totalCount: number }>(
        `/wiki/checkpoint?projectPath=${encodeURIComponent(projectPath)}&lang=${lang}`
      );
      set({ checkpoint: data.exists ? data : null });
    } catch { set({ checkpoint: null }); }
  },

  fetchStatus: async (projectPath) => {
    set({ activeProjectPath: projectPath, activeSessionId: currentSessionId(), isLoading: true, error: null });
    try {
      const { lang } = get();
      const data = await apiFetch<WikiStatus>(`/wiki/status?projectPath=${encodeURIComponent(projectPath)}&lang=${lang}`);
      // 后端返回 generating=true 说明后台正在跑（比如刷新后恢复），恢复前端状态
      if (data.generating && !get().isGenerating) {
        set({ isGenerating: true, generationPhase: 'generating', generationProgress: 0.5, generationDetail: i18n.t('wiki.resumingProgress') });
      }
      set({ status: data, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch wiki status', isLoading: false });
    }
  },

  generateWiki: async (projectPath) => {
    const sessionId = currentSessionId();
    set({ activeProjectPath: projectPath, activeSessionId: sessionId, isGenerating: true, generationPhase: 'scanning', generationProgress: 0.05, generationDetail: null, streamingText: '', streamingSectionId: null, streamingSectionTitle: null, streamingSections: new Map(), error: null });
    try {
      const { lang } = get();
      const res = await apiFetch<{ started: boolean; error?: string }>('/wiki/generate', {
        method: 'POST',
        body: JSON.stringify({ projectPath, lang, sessionId: sessionId || undefined }),
      });
      if (!res.started) {
        set({ isGenerating: false, error: res.error || 'Failed to start generation' });
      }
      // 进度通过 canonical session/update SSE 实时推送
    } catch (err) {
      set({ isGenerating: false, error: err instanceof Error ? err.message : 'Generation failed' });
    }
  },

  updateWiki: async (projectPath) => {
    const sessionId = currentSessionId();
    set({ activeProjectPath: projectPath, activeSessionId: sessionId, isGenerating: true, generationPhase: 'scanning', generationProgress: 0.05, generationDetail: null, streamingText: '', streamingSectionId: null, streamingSectionTitle: null, streamingSections: new Map(), error: null });
    try {
      const { lang } = get();
      const res = await apiFetch<{ started: boolean; error?: string }>('/wiki/refresh', {
        method: 'POST',
        body: JSON.stringify({ projectPath, lang, sessionId: sessionId || undefined }),
      });
      if (!res.started) {
        set({ isGenerating: false, error: res.error || 'Failed to start update' });
      }
    } catch (err) {
      set({ isGenerating: false, error: err instanceof Error ? err.message : 'Update failed' });
    }
  },

  deleteWiki: async (projectPath) => {
    set({ activeProjectPath: projectPath, activeSessionId: currentSessionId(), isLoading: true, error: null });
    try {
      const { lang } = get();
      await apiFetch(`/wiki?projectPath=${encodeURIComponent(projectPath)}&lang=${lang}`, {
        method: 'DELETE',
      });
      set({ status: null, documents: [], selectedDocument: null, documentContent: null, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Delete failed', isLoading: false });
    }
  },

  fetchDocuments: async (projectPath) => {
    set({ activeProjectPath: projectPath, activeSessionId: currentSessionId(), isLoading: true, error: null });
    try {
      const { lang } = get();
      const data = await apiFetch<{ documents: WikiDocument[] }>(`/wiki/documents?projectPath=${encodeURIComponent(projectPath)}&lang=${lang}`);
      set({ documents: data.documents || [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch documents', isLoading: false });
    }
  },

  fetchDocument: async (projectPath, docPath) => {
    set({ activeProjectPath: projectPath, activeSessionId: currentSessionId(), isLoading: true, error: null, selectedDocument: docPath });
    try {
      const { lang } = get();
      const data = await apiFetch<{ content: string; path: string }>(`/wiki/document?projectPath=${encodeURIComponent(projectPath)}&lang=${lang}&path=${encodeURIComponent(docPath)}`);
      set({ documentContent: data.content, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch document', documentContent: null, isLoading: false });
    }
  },

  setSelectedDocument: (path) => set({ selectedDocument: path }),

  checkForUpdates: async (projectPath) => {
    set({ activeProjectPath: projectPath, activeSessionId: currentSessionId() });
    try {
      const { lang } = get();
      await apiFetch(`/wiki/check-updates?projectPath=${encodeURIComponent(projectPath)}&lang=${lang}`);
    } catch (err) {
      // silent
    }
  },

  setGenerationProgress: (phase, progress, detail) => {
    set({ generationPhase: phase, generationProgress: progress, generationDetail: detail });
  },

  setGenerationComplete: () => {
    set({ isGenerating: false, generationPhase: null, generationProgress: 1, generationDetail: null, streamingText: '', streamingSectionId: null, streamingSectionTitle: null, streamingSections: new Map(), checkpoint: null });
    // 刷新状态和文档列表
    const { status, activeProjectPath } = get();
    const projectPath = status?.projectPath || activeProjectPath;
    if (projectPath) {
      get().fetchStatus(projectPath);
      get().fetchDocuments(projectPath);
    }
  },

  setGenerationFailed: (error) => {
    set({ isGenerating: false, generationPhase: null, generationProgress: 0, error, streamingText: '', streamingSectionId: null, streamingSectionTitle: null, streamingSections: new Map() });
    // 生成失败时刷新 checkpoint 状态（保留断点可恢复）
    const { status, activeProjectPath } = get();
    const projectPath = status?.projectPath || activeProjectPath;
    if (projectPath) get().fetchCheckpoint(projectPath);
  },

  appendStreamChunk: (sectionId, sectionTitle, chunk) => {
    const { streamingSections, streamingSectionId, streamingText } = get();
    // Update per-section map (for multi-agent display)
    const existing = streamingSections.get(sectionId);
    const newMap = new Map(streamingSections);
    newMap.set(sectionId, { title: sectionTitle, text: (existing?.text || '') + chunk });
    // Maintain the last active section stream for the single-document view.
    if (streamingSectionId !== sectionId) {
      set({ streamingSectionId: sectionId, streamingSectionTitle: sectionTitle, streamingText: chunk, streamingSections: newMap });
    } else {
      set({ streamingText: streamingText + chunk, streamingSections: newMap });
    }
  },

  clearError: () => set({ error: null }),
}));

// ─── SSE 事件监听 ────────────────────────────────────
function applyWikiUpdate(params: WikiGenerationUpdate): void {
  const store = useWikiStore.getState();
  if (!shouldAcceptWikiUpdate(params, store)) return;

  switch (params.type) {
    case 'generation_started':
      store.setGenerationProgress('scanning', 0.05, '');
      break;

    case 'generation_progress':
      store.setGenerationProgress(
        params.phase || '',
        params.progress || 0,
        params.detail || '',
      );
      break;

    case 'generation_completed':
      store.setGenerationComplete();
      break;

    case 'generation_failed':
      store.setGenerationFailed(params.error || 'Unknown error');
      break;

    case 'generation_stream':
      store.appendStreamChunk(params.sectionId, params.sectionTitle, params.chunk);
      break;
  }
}

// 订阅 acpClient 的 canonical session/update 事件，实时更新 wiki 进度（注册一次，支持 dispose/HMR）
let wikiSseUnsubscribe: (() => void) | null = null;

export function ensureWikiSseSubscription(): void {
  if (wikiSseUnsubscribe) return;
  wikiSseUnsubscribe = acpClient.on(SESSION_UPDATE_METHOD, (data) => {
    const normalized = normalizeCanonicalWikiUpdate(data);
    if (!normalized) return;
    const now = Date.now();
    pruneSeenWikiSignatures(now);
    if (normalized.eventId) {
      if (seenWikiEventIds.has(normalized.eventId)) return;
      seenWikiEventIds.set(normalized.eventId, now);
    }
    applyWikiUpdate(normalized.update);
  });
}

export function disposeWikiSseSubscription(): void {
  wikiSseUnsubscribe?.();
  wikiSseUnsubscribe = null;
}

ensureWikiSseSubscription();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeWikiSseSubscription();
  });
}
