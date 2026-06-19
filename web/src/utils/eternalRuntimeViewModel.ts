import type { SessionEternalRuntimeSnapshot } from '../stores/sessionStoreTypes';
import {
  buildEternalRuntimeProjection,
  type EternalRuntimeProjectionTone,
} from '@contracts/adapters/EternalRuntimeProjection';

export type RuntimePillTone = EternalRuntimeProjectionTone;

export interface EternalRuntimeViewModel {
  tone: RuntimePillTone;
  statusLabel: string;
  detailLabel: string | null;
  title: string;
  spinning: boolean;
}

export interface EternalControlModeViewModel {
  isEternal: boolean;
  modeLabel: 'Manual' | 'Eternal';
  title: string;
  runtimeLabel: string | null;
  runtimeTone: RuntimePillTone | null;
  spinning: boolean;
}

export function buildEternalRuntimeViewModel(
  snapshot: SessionEternalRuntimeSnapshot | null | undefined,
  now = Date.now(),
): EternalRuntimeViewModel | null {
  const projection = buildEternalRuntimeProjection(snapshot, now);
  if (!projection) return null;
  return {
    tone: projection.tone,
    statusLabel: projection.statusLabel,
    detailLabel: projection.compactDetailLabel,
    title: projection.title,
    spinning: projection.spinning,
  };
}

export function buildEternalControlModeViewModel(
  controlMode: 'manual' | 'eternal' | undefined,
  snapshot: SessionEternalRuntimeSnapshot | null | undefined,
  now = Date.now(),
): EternalControlModeViewModel {
  if (controlMode !== 'eternal') {
    return {
      isEternal: false,
      modeLabel: 'Manual',
      title: 'Manual mode',
      runtimeLabel: null,
      runtimeTone: null,
      spinning: false,
    };
  }

  const runtime = buildEternalRuntimeViewModel(snapshot, now);
  return {
    isEternal: true,
    modeLabel: 'Eternal',
    title: runtime ? `Eternal mode | ${runtime.title}` : 'Eternal mode | runtime snapshot unavailable',
    runtimeLabel: runtime ? [runtime.statusLabel, runtime.detailLabel].filter(Boolean).join(' ') : null,
    runtimeTone: runtime?.tone ?? null,
    spinning: runtime?.spinning ?? false,
  };
}
