/**
 * jiangeStore — v1.0.5 剑阁全屏工作台状态
 */

import { create } from 'zustand';
import { browserClient, type BrowserSessionSummary, type BrowserElementSelection } from '../api/BrowserClient';

export type JiangeTab = 'browser' | 'files' | 'office' | 'split';

export interface JiangeFileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: JiangeFileNode[];
  size?: number;
  modified?: string;
}

export interface JiangeState {
  activeTab: JiangeTab;
  // Browser
  browserSessions: BrowserSessionSummary[];
  activeBrowserSessionId: string | null;
  browserScreenshotUrl: string | null;
  browserSelection: BrowserElementSelection | null;
  browserIsInspecting: boolean;
  browserIsLoading: boolean;
  browserUrl: string;
  browserError: string | null;
  // File Canvas
  fileTree: JiangeFileNode[];
  activeFilePath: string | null;
  activeFileContent: string | null;
  fileIsLoading: boolean;
  filePreviewMode: 'render' | 'source';
  // Split layout
  splitLeftTab: JiangeTab;
  splitRightTab: JiangeTab;

  // Actions
  setActiveTab: (tab: JiangeTab) => void;
  setBrowserUrl: (url: string) => void;
  setBrowserInspecting: (v: boolean) => void;
  setBrowserSelection: (s: BrowserElementSelection | null) => void;
  setBrowserLoading: (v: boolean) => void;
  setBrowserError: (e: string | null) => void;
  refreshScreenshot: () => void;
  setActiveFile: (path: string | null) => void;
  setFileContent: (content: string | null) => void;
  setFileLoading: (v: boolean) => void;
  setFilePreviewMode: (mode: 'render' | 'source') => void;
  setSplitTabs: (left: JiangeTab, right: JiangeTab) => void;
}

export const useJiangeStore = create<JiangeState>((set, get) => ({
  activeTab: 'split',
  // Browser
  browserSessions: [],
  activeBrowserSessionId: null,
  browserScreenshotUrl: null,
  browserSelection: null,
  browserIsInspecting: false,
  browserIsLoading: false,
  browserUrl: 'http://localhost:5173',
  browserError: null,
  // Files
  fileTree: [],
  activeFilePath: null,
  activeFileContent: null,
  fileIsLoading: false,
  filePreviewMode: 'render',
  // Split
  splitLeftTab: 'browser',
  splitRightTab: 'files',

  setActiveTab: (tab) => set({ activeTab: tab }),
  setBrowserUrl: (url) => set({ browserUrl: url }),
  setBrowserInspecting: (v) => set({ browserIsInspecting: v }),
  setBrowserSelection: (s) => set({ browserSelection: s }),
  setBrowserLoading: (v) => set({ browserIsLoading: v }),
  setBrowserError: (e) => set({ browserError: e }),
  refreshScreenshot: () => {
    const sessionId = get().activeBrowserSessionId;
    if (sessionId) {
      set({ browserScreenshotUrl: browserClient.screenshotUrl(sessionId) });
    }
  },
  setActiveFile: (path) => set({ activeFilePath: path }),
  setFileContent: (content) => set({ activeFileContent: content }),
  setFileLoading: (v) => set({ fileIsLoading: v }),
  setFilePreviewMode: (mode) => set({ filePreviewMode: mode }),
  setSplitTabs: (left, right) => set({ splitLeftTab: left, splitRightTab: right }),
}));
