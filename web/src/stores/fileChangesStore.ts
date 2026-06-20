/**
 * fileChangesStore — 文件变更与检查点状态管理
 */

import { create } from 'zustand';
import { getServerToken } from '../api/headers';
import { useSessionStore } from './sessionStore';
import { useDeliveryContextStore } from './deliveryContextStore';

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  timestamp: number;
  files: string[];
  additions: number;
  deletions: number;
  type: 'session_start' | 'turn' | 'tool' | 'revert' | 'manual';
  turnNumber?: number;
  toolName?: string;
  actorType?: 'leader' | 'agent';
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  taskId?: string;
}

export interface TurnCheckpointGroup {
  turnNumber: number;
  turnStart: Checkpoint | null;
  toolCheckpoints: Checkpoint[];
}

export interface SessionCheckpointGroup {
  sessionId: string;
  summary: string | null;
  createdAt: number;
  isActive: boolean;
  checkpoints: Checkpoint[];
  turns: TurnCheckpointGroup[];
}

export interface FileDiff {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff: string;
  binary: boolean;
}

interface FileChangesState {
  checkpoints: Checkpoint[];
  sessionGroups: SessionCheckpointGroup[];
  changes: FileDiff[];
  selectedCheckpoint: string | null;
  selectedFilePath: string | null;
  selectedDiff: FileDiff | null;
  isLoading: boolean;
  error: string | null;
  // Checkpoint 磁盘清理
  diskUsage: { historyDir: string; sizeBytes: number; commitCount: number } | null;
  isCleaningUp: boolean;
  cleanupMessage: string | null;

  fetchCheckpoints: (sessionId: string) => Promise<void>;
  fetchAllCheckpoints: (sessionId?: string) => Promise<void>;
  fetchWorkingChanges: (sessionId: string) => Promise<void>;
  fetchFileDiff: (sessionId: string, filePath: string, commit?: string) => Promise<void>;
  revertToCheckpoint: (sessionId: string, commitHash: string, scope?: 'code' | 'conversation' | 'all') => Promise<void>;
  revertFiles: (sessionId: string, paths: string[]) => Promise<void>;
  revertAll: (sessionId: string) => Promise<void>;
  setSelectedCheckpoint: (id: string | null) => void;
  setSelectedFilePath: (path: string | null) => void;
  clearError: () => void;
  // Checkpoint 磁盘清理方法
  fetchDiskUsage: (sessionId: string) => Promise<void>;
  runGc: (sessionId: string) => Promise<void>;
  purgeHistory: (sessionId: string) => Promise<void>;
  clearCleanupMessage: () => void;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const hasBody = opts?.body != null;
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'x-lingxiao-token': getServerToken(),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const useFileChangesStore = create<FileChangesState>((set, get) => ({
  checkpoints: [],
  sessionGroups: [],
  changes: [],
  selectedCheckpoint: null,
  selectedFilePath: null,
  selectedDiff: null,
  isLoading: false,
  error: null,
  diskUsage: null,
  isCleaningUp: false,
  cleanupMessage: null,

  fetchCheckpoints: async (sessionId) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiFetch<{ checkpoints: Checkpoint[] }>(
        `/file-changes/checkpoints?sessionId=${encodeURIComponent(sessionId)}`,
      );
      set({ checkpoints: data.checkpoints, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch checkpoints', isLoading: false });
    }
  },

  fetchAllCheckpoints: async (sessionId?) => {
    set({ isLoading: true, error: null });
    try {
      const url = sessionId
        ? `/file-changes/all-checkpoints?sessionId=${encodeURIComponent(sessionId)}`
        : '/file-changes/all-checkpoints';
      const data = await apiFetch<{ groups: SessionCheckpointGroup[] }>(url);
      set({ sessionGroups: data.groups || [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch checkpoints', isLoading: false });
    }
  },

  fetchWorkingChanges: async (sessionId) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiFetch<{ changes: FileDiff[] }>(
        `/file-changes/diff?sessionId=${encodeURIComponent(sessionId)}`,
      );
      set({ changes: data.changes || [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch changes', isLoading: false });
    }
  },

  fetchFileDiff: async (sessionId, filePath, commit) => {
    set({ isLoading: true, error: null, selectedFilePath: filePath });
    try {
      let url = `/file-changes/diff?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`;
      if (commit) url += `&commit=${encodeURIComponent(commit)}`;
      const data = await apiFetch<FileDiff & { error?: string }>(url);
      if ((data as { error?: string }).error) {
        set({ selectedDiff: null, error: (data as { error?: string }).error as string, isLoading: false });
        return;
      }
      set({ selectedDiff: data, isLoading: false });
    } catch (err) {
      set({ selectedDiff: null, error: err instanceof Error ? err.message : 'Failed to fetch diff', isLoading: false });
    }
  },

  revertToCheckpoint: async (sessionId, commitHash, scope = 'all') => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiFetch<{ success: boolean; error?: string; conversationTruncated?: number }>(
        '/file-changes/revert',
        { method: 'POST', body: JSON.stringify({ sessionId, commitHash, scope }) },
      );
      if (!result.success) {
        set({ error: result.error || 'Revert failed', isLoading: false });
        return;
      }
      // Keep the visible Changes tab scoped to the active session, while
      // preserving a pinned delivery session when review context is active.
      const currentSessionId = useSessionStore.getState().sessionId;
      const deliverySessionId = useDeliveryContextStore.getState().context?.sessionId;
      const refreshSessionId = deliverySessionId === sessionId ? sessionId : (currentSessionId || sessionId);
      await get().fetchAllCheckpoints(refreshSessionId);
      await get().fetchWorkingChanges(refreshSessionId);
      // If conversation was rolled back, reload messages
      const revertedConversation = scope === 'conversation' || scope === 'all';
      if (revertedConversation && result.conversationTruncated && result.conversationTruncated > 0) {
        const store = useSessionStore.getState();
        if (store.sessionId === sessionId) {
          try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
              headers: { 'x-lingxiao-token': getServerToken() },
            });
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data)) {
                store.loadMessagesFromHistory(data);
              }
            }
          } catch {
            // Non-critical
          }
        }
      }
      set({ selectedCheckpoint: null, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Revert failed', isLoading: false });
    }
  },

  revertFiles: async (sessionId, paths) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiFetch<{ success: boolean; revertedFiles: string[]; error?: string }>(
        '/file-changes/revert-files',
        { method: 'POST', body: JSON.stringify({ sessionId, paths }) },
      );
      if (!result.success) {
        set({ error: result.error || 'Revert files failed', isLoading: false });
        return;
      }
      // Remove reverted files from changes list
      const revertedSet = new Set(result.revertedFiles);
      set((state) => ({
        changes: state.changes.filter((c) => !revertedSet.has(c.path)),
        selectedDiff: state.selectedFilePath && revertedSet.has(state.selectedFilePath) ? null : state.selectedDiff,
        selectedFilePath: state.selectedFilePath && revertedSet.has(state.selectedFilePath) ? null : state.selectedFilePath,
        isLoading: false,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Revert files failed', isLoading: false });
    }
  },

  revertAll: async (sessionId) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiFetch<{ success: boolean; error?: string }>(
        '/file-changes/revert-all',
        { method: 'POST', body: JSON.stringify({ sessionId }) },
      );
      if (!result.success) {
        set({ error: result.error || 'Revert all failed', isLoading: false });
        return;
      }
      // Clear all changes
      set({ changes: [], selectedDiff: null, selectedFilePath: null, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Revert all failed', isLoading: false });
    }
  },

  setSelectedCheckpoint: (id) => set({ selectedCheckpoint: id }),
  setSelectedFilePath: (path) => set({ selectedFilePath: path }),
  clearError: () => set({ error: null }),

  // ── Checkpoint 磁盘清理 ──

  fetchDiskUsage: async (sessionId) => {
    try {
      const data = await apiFetch<{ historyDir: string; sizeBytes: number; commitCount: number } | { error: string }>(
        `/file-changes/disk-usage?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if ('error' in data) {
        set({ diskUsage: null });
      } else {
        set({ diskUsage: data });
      }
    } catch {
      set({ diskUsage: null });
    }
  },

  runGc: async (sessionId) => {
    set({ isCleaningUp: true, cleanupMessage: null });
    try {
      const data = await apiFetch<{ sizeBytesBefore: number; sizeBytesAfter: number; commitCount: number } | { error: string }>(
        '/file-changes/gc',
        { method: 'POST', body: JSON.stringify({ sessionId }) },
      );
      if ('error' in data) {
        set({ isCleaningUp: false, cleanupMessage: `GC failed: ${data.error}` });
      } else {
        const freedMB = ((data.sizeBytesBefore - data.sizeBytesAfter) / 1024 / 1024).toFixed(1);
        set({
          isCleaningUp: false,
          cleanupMessage: `GC complete: freed ${freedMB} MB, ${data.commitCount} checkpoints remaining`,
          diskUsage: { historyDir: '', sizeBytes: data.sizeBytesAfter, commitCount: data.commitCount },
        });
        // 刷新 checkpoint 列表
        await get().fetchAllCheckpoints(sessionId);
      }
    } catch (err) {
      set({ isCleaningUp: false, cleanupMessage: `GC failed: ${err instanceof Error ? err.message : 'unknown'}` });
    }
  },

  purgeHistory: async (sessionId) => {
    set({ isCleaningUp: true, cleanupMessage: null });
    try {
      const data = await apiFetch<{ deleted: boolean; freedBytes: number; historyDir: string } | { error: string }>(
        '/file-changes/purge',
        { method: 'POST', body: JSON.stringify({ sessionId }) },
      );
      if ('error' in data) {
        set({ isCleaningUp: false, cleanupMessage: `Purge failed: ${data.error}` });
      } else {
        const freedMB = (data.freedBytes / 1024 / 1024).toFixed(1);
        set({
          isCleaningUp: false,
          cleanupMessage: `Purge complete: freed ${freedMB} MB, all history deleted`,
          diskUsage: null,
          checkpoints: [],
          sessionGroups: [],
        });
      }
    } catch (err) {
      set({ isCleaningUp: false, cleanupMessage: `Purge failed: ${err instanceof Error ? err.message : 'unknown'}` });
    }
  },

  clearCleanupMessage: () => set({ cleanupMessage: null }),
}));
