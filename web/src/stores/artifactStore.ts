import { create } from 'zustand';

export interface ArtifactTarget {
  name: string;
  path?: string;
  url?: string;
  line?: number;
  column?: number;
  size?: number;
  mimeType?: string;
  expiresAt?: string;
}

interface ArtifactState {
  activeArtifact: ArtifactTarget | null;
  recentArtifacts: ArtifactTarget[];
  openArtifact: (artifact: ArtifactTarget) => void;
  clearArtifact: () => void;
}

function artifactKey(artifact: ArtifactTarget): string {
  return artifact.path || artifact.url || artifact.name;
}

export const useArtifactStore = create<ArtifactState>((set) => ({
  activeArtifact: null,
  recentArtifacts: [],
  openArtifact: (artifact) => set((state) => {
    const key = artifactKey(artifact);
    const recentArtifacts = [
      artifact,
      ...state.recentArtifacts.filter(item => artifactKey(item) !== key),
    ].slice(0, 12);
    return { activeArtifact: artifact, recentArtifacts };
  }),
  clearArtifact: () => set({ activeArtifact: null }),
}));
