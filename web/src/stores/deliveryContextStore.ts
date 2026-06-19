import { create } from 'zustand';

export type DeliveryContextSourceView = 'tasks' | 'chat' | 'changes' | 'git';

export interface DeliveryContextArtifactRef {
  path?: string;
  url?: string;
  label?: string;
  kind?: string;
}

export interface DeliveryContext {
  sourceView: DeliveryContextSourceView;
  sessionId?: string;
  taskId?: string;
  taskTitle?: string;
  agentName?: string;
  agentType?: string;
  workspace?: string;
  writeScope?: string[];
  filesCreated?: string[];
  filesModified?: string[];
  evidenceRefs?: string[];
  artifactRefs?: DeliveryContextArtifactRef[];
  verificationCount?: number;
  updatedAt: number;
}

interface DeliveryContextState {
  context: DeliveryContext | null;
  setContext: (context: Omit<DeliveryContext, 'updatedAt'> & { updatedAt?: number }) => void;
  clearContext: () => void;
}

export const useDeliveryContextStore = create<DeliveryContextState>((set) => ({
  context: null,
  setContext: (context) => set({
    context: {
      ...context,
      updatedAt: context.updatedAt ?? Date.now(),
    },
  }),
  clearContext: () => set({ context: null }),
}));
