/**
 * officeStore — 办公室专属状态
 */
import { create } from 'zustand';
import type { FurnitureItem } from '../assets/officeLayout';

const STORAGE_KEY = 'lingxiao-office-workstation-assignments';

function loadAssignments(): Record<string, string> {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function saveAssignments(a: Record<string, string>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); } catch { /* ignore */ }
}

export type StatusFilter = 'all' | 'running' | 'completed' | 'failed' | 'idle';
export type OfficeActionStatus = { kind: 'success' | 'error' | 'info'; message: string };
export type AgentContextMenuState = { agentId: string; x: number; y: number } | null;
export type FurnitureActionState = { type: FurnitureItem['type']; x: number; y: number } | null;

export interface OfficeState {
  selectedAgentId: string | null; detailPanelOpen: boolean; editMode: boolean;
  cameraX: number; cameraY: number; zoom: number;
  hoveredAgentId: string | null; tooltipPosition: { x: number; y: number };
  workstationAssignments: Record<string, string>;

  searchQuery: string; statusFilter: StatusFilter;
  selectedAreaId: string | null; areaInfoOpen: boolean;
  focusAgentId: string | null; statsPanelOpen: boolean;
  searchBarVisible: boolean;  // toggled by Ctrl+F
  contextMenu: AgentContextMenuState;
  furnitureAction: FurnitureActionState;
  actionStatus: OfficeActionStatus | null;

  selectAgent: (agentId: string | null) => void;
  setDetailPanelOpen: (open: boolean) => void;
  setEditMode: (edit: boolean) => void;
  setCameraState: (x: number, y: number, zoom: number) => void;
  setHoveredAgent: (agentId: string | null, x: number, y: number) => void;
  assignWorkstation: (agentName: string, workstationId: string) => void;
  getAssignedWorkstation: (agentName: string) => string | undefined;

  setSearchQuery: (query: string) => void;
  setStatusFilter: (filter: StatusFilter) => void;
  selectArea: (areaId: string | null) => void;
  setAreaInfoOpen: (open: boolean) => void;
  setFocusAgentId: (agentId: string | null) => void;
  toggleSearchBar: () => void;
  toggleStatsPanel: () => void;
  setStatsPanelOpen: (open: boolean) => void;
  openAgentContextMenu: (agentId: string, x: number, y: number) => void;
  closeAgentContextMenu: () => void;
  openFurnitureAction: (type: FurnitureItem['type'], x: number, y: number) => void;
  closeFurnitureAction: () => void;
  setActionStatus: (status: OfficeActionStatus | null) => void;
}

export const useOfficeStore = create<OfficeState>((set, get) => ({
  selectedAgentId: null, detailPanelOpen: false, editMode: false,
  cameraX: 0, cameraY: 0, zoom: 2,
  hoveredAgentId: null, tooltipPosition: { x: 0, y: 0 },
  workstationAssignments: loadAssignments(),
  searchQuery: '', statusFilter: 'all',
  selectedAreaId: null, areaInfoOpen: false,
  focusAgentId: null, statsPanelOpen: false,
  searchBarVisible: false,
  contextMenu: null,
  furnitureAction: null,
  actionStatus: null,

  selectAgent: (agentId) => set({ selectedAgentId: agentId, detailPanelOpen: agentId !== null, contextMenu: null }),
  setDetailPanelOpen: (open) => set((state) => ({ detailPanelOpen: open, selectedAgentId: open ? state.selectedAgentId : null })),
  setEditMode: (edit) => set({ editMode: edit }),
  setCameraState: (x, y, zoom) => set({ cameraX: x, cameraY: y, zoom }),
  setHoveredAgent: (agentId, x, y) => set({ hoveredAgentId: agentId, tooltipPosition: { x, y } }),
  assignWorkstation: (agentName, wsId) => {
    const a = { ...get().workstationAssignments, [agentName]: wsId };
    saveAssignments(a); set({ workstationAssignments: a });
  },
  getAssignedWorkstation: (agentName) => get().workstationAssignments[agentName],

  setSearchQuery: (query) => set({ searchQuery: query }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  selectArea: (areaId) => set({ selectedAreaId: areaId, areaInfoOpen: areaId !== null }),
  setAreaInfoOpen: (open) => set({ areaInfoOpen: open, selectedAreaId: open ? get().selectedAreaId : null }),
  setFocusAgentId: (agentId) => set({ focusAgentId: agentId, selectedAgentId: agentId, detailPanelOpen: agentId !== null }),
  toggleSearchBar: () => set((state) => ({ searchBarVisible: !state.searchBarVisible })),
  toggleStatsPanel: () => set((state) => ({ statsPanelOpen: !state.statsPanelOpen })),
  setStatsPanelOpen: (open) => set({ statsPanelOpen: open }),
  openAgentContextMenu: (agentId, x, y) => set({ contextMenu: { agentId, x, y }, furnitureAction: null }),
  closeAgentContextMenu: () => set({ contextMenu: null }),
  openFurnitureAction: (type, x, y) => set({ furnitureAction: { type, x, y }, contextMenu: null }),
  closeFurnitureAction: () => set({ furnitureAction: null }),
  setActionStatus: (status) => set({ actionStatus: status }),
}));
