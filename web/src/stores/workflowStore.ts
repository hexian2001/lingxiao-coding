/**
 * workflowStore — 工作流持久化状态管理
 */

import { create } from 'zustand';
import { getServerToken } from '../api/headers';
import {
  reduceWorkflowDirectoryProjection,
} from '@contracts/types/Workflow';
import type {
  WorkflowProjectionEvent,
} from '@contracts/types/Workflow';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  workspace: string | null;
  nodeCount?: number;
  edgeCount?: number;
  scheduleTriggerCount?: number;
  tags?: string[] | null;
  createdAt?: number;
  updatedAt: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  nodes: unknown;
  edges: unknown;
  createdAt: number;
  version?: string;
  config?: Record<string, unknown>;
  scheduleSync?: unknown;
}

interface WorkflowState {
  workflows: WorkflowSummary[];
  currentWorkflowId: string | null;
  isLoading: boolean;
  error: string | null;

  fetchWorkflows: () => Promise<void>;
  createWorkflow: (name: string, description?: string) => Promise<WorkflowDetail | null>;
  loadWorkflow: (id: string) => Promise<WorkflowDetail | null>;
  saveWorkflow: (id: string, data: { name?: string; description?: string; nodes?: unknown; edges?: unknown; config?: Record<string, unknown> }) => Promise<boolean>;
  executeWorkflow: (id: string, options?: { input?: Record<string, unknown> }) => Promise<{ executionId: string } | null>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  setCurrentWorkflowId: (id: string | null) => void;
  applyWorkflowEvent: (event: WorkflowProjectionEvent) => { refreshWorkflows: boolean };
  clearError: () => void;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflows: [],
  currentWorkflowId: null,
  isLoading: false,
  error: null,

  fetchWorkflows: async () => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiFetch<WorkflowSummary[]>('/workflows');
      const { currentWorkflowId } = get();
      const stillExists = currentWorkflowId ? data.some((wf) => wf.id === currentWorkflowId) : true;
      set({
        workflows: data,
        isLoading: false,
        currentWorkflowId: stillExists ? currentWorkflowId : null,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch workflows', isLoading: false });
    }
  },

  createWorkflow: async (name, description) => {
    try {
      const wf = await apiFetch<WorkflowDetail>('/workflows', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      });
      await get().fetchWorkflows();
      set({ currentWorkflowId: wf.id });
      return wf;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to create workflow' });
      return null;
    }
  },

  loadWorkflow: async (id) => {
    try {
      const wf = await apiFetch<WorkflowDetail>(`/workflows/${encodeURIComponent(id)}`);
      set({ currentWorkflowId: id });
      return wf;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load workflow' });
      return null;
    }
  },

  saveWorkflow: async (id, data) => {
    try {
      await apiFetch(`/workflows/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      // Refresh list to get updated timestamps
      await get().fetchWorkflows();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save workflow' });
      return false;
    }
  },

  executeWorkflow: async (id, options) => {
    try {
      const result = await apiFetch<{ success: boolean; workflowId: string; executionId: string }>(`/workflows/${encodeURIComponent(id)}/execute`, {
        method: 'POST',
        body: JSON.stringify(options?.input ? { input: options.input } : {}),
      });
      return { executionId: result.executionId };
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to execute workflow' });
      return null;
    }
  },

  deleteWorkflow: async (id) => {
    try {
      await apiFetch(`/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (get().currentWorkflowId === id) {
        set({ currentWorkflowId: null });
      }
      await get().fetchWorkflows();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete workflow' });
      return false;
    }
  },

  setCurrentWorkflowId: (id) => set({ currentWorkflowId: id }),
  applyWorkflowEvent: (event) => {
    const refreshWorkflows = event.type === 'workflow:created'
      || event.type === 'workflow:updated'
      || event.type === 'workflow:deleted'
      || event.type === 'workflow:node_added'
      || event.type === 'workflow:node_updated'
      || event.type === 'workflow:node_deleted'
      || event.type === 'workflow:edge_added'
      || event.type === 'workflow:edge_updated'
      || event.type === 'workflow:edge_deleted';

    set((state) => {
      const projection = reduceWorkflowDirectoryProjection({
        workflows: state.workflows,
        currentWorkflowId: state.currentWorkflowId,
      }, event);
      return {
        workflows: projection.workflows,
        currentWorkflowId: projection.currentWorkflowId,
      };
    });

    return { refreshWorkflows };
  },
  clearError: () => set({ error: null }),
}));
