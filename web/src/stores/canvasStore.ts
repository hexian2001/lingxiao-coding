/**
 * canvasStore — Canvas UI state management (session-independent)
 *
 * This store ONLY manages UI state that is NOT part of ReactFlow's state.
 * ReactFlow's nodes/edges are the single source of truth for canvas data.
 */

import { create } from 'zustand';
import {
  createWorkflowProjectionState,
  reduceWorkflowProjection,
} from '../types/workflow';
import type {
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
  WorkflowUiExecutionLog,
  WorkflowExecutionProjection,
  WorkflowNodeExecutionProjection,
  WorkflowProjectionEvent,
  WorkflowProjectionReduceOptions,
  WorkflowProjectionState,
} from '../types/workflow';

// ─── Execution types ───

export type NodeExecution = WorkflowNodeExecutionProjection;
export type ExecutionLog = WorkflowUiExecutionLog;

export interface CanvasActionContext {
  x?: number;
  y?: number;
  type?: 'node' | 'canvas' | 'edge';
  nodeId?: string | null;
  edgeId?: string | null;
}

// ─── Store interface ───

interface CanvasState {
  // Workflow management
  currentWorkflowId: string | null;
  setCurrentWorkflowId: (id: string | null) => void;

  // Editing
  editingNodeId: string | null;
  setEditingNodeId: (id: string | null) => void;

  // Connect mode
  connectFromNodeId: string | null;
  setConnectFromNodeId: (id: string | null) => void;

  // Execution
  isExecuting: boolean;
  executionSessionId: string | null;
  showExecPanel: boolean;
  executions: NodeExecution[];
  executionStates: Map<string, WorkflowExecutionProjection>;
  currentExecutionId: string | null;
  workflowProjection: WorkflowProjectionState;
  setShowExecPanel: (show: boolean) => void;
  clearExecutions: () => void;
  replaceWorkflowProjection: (projection: Partial<WorkflowProjectionState>) => WorkflowProjectionState;
  setWorkflowCanvas: (workflowId: string | null, nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[]) => WorkflowProjectionState;
  applyWorkflowEvent: (event: WorkflowProjectionEvent, options?: WorkflowProjectionReduceOptions) => WorkflowProjectionState;
}

function executionStatesToMap(states: Record<string, WorkflowExecutionProjection>): Map<string, WorkflowExecutionProjection> {
  return new Map(Object.entries(states));
}

function projectionPatch(projection: WorkflowProjectionState): Partial<CanvasState> {
  return {
    workflowProjection: projection,
    isExecuting: projection.isExecuting,
    executionSessionId: projection.isExecuting ? projection.currentExecutionId : null,
    showExecPanel: projection.showExecPanel,
    executions: projection.executions,
    executionStates: executionStatesToMap(projection.executionStates),
    currentExecutionId: projection.currentExecutionId,
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  // Workflow management
  currentWorkflowId: null,
  setCurrentWorkflowId: (id) => set({ currentWorkflowId: id }),

  // Editing
  editingNodeId: null,
  setEditingNodeId: (id) => set({ editingNodeId: id }),

  // Connect mode
  connectFromNodeId: null,
  setConnectFromNodeId: (id) => set({ connectFromNodeId: id }),

  // Execution
  isExecuting: false,
  executionSessionId: null,
  showExecPanel: false,
  executions: [],
  executionStates: new Map(),
  currentExecutionId: null,
  workflowProjection: createWorkflowProjectionState(),

  setShowExecPanel: (show) => set((state) => {
    const projection = { ...state.workflowProjection, showExecPanel: show };
    return projectionPatch(projection);
  }),

  clearExecutions: () => set((state) => {
    const projection = {
      ...state.workflowProjection,
      executions: [],
      executionStates: {},
      currentExecutionId: null,
      isExecuting: false,
    };
    return projectionPatch(projection);
  }),

  replaceWorkflowProjection: (projectionPatchInput) => {
    let nextProjection = get().workflowProjection;
    set((state) => {
      nextProjection = createWorkflowProjectionState({
        ...state.workflowProjection,
        ...projectionPatchInput,
      });
      return projectionPatch(nextProjection);
    });
    return nextProjection;
  },

  setWorkflowCanvas: (workflowId, nodes, edges) => {
    let nextProjection = get().workflowProjection;
    set((state) => {
      nextProjection = createWorkflowProjectionState({
        ...state.workflowProjection,
        currentWorkflowId: workflowId,
        nodes,
        edges,
      });
      return projectionPatch(nextProjection);
    });
    return nextProjection;
  },

  applyWorkflowEvent: (event, options) => {
    let nextProjection = get().workflowProjection;
    set((state) => {
      nextProjection = reduceWorkflowProjection(state.workflowProjection, event, options);
      return projectionPatch(nextProjection);
    });
    return nextProjection;
  },
}));
