import { getServerToken } from '../../api/headers';
import type {
  CreateModelProviderRequest,
  ModelProviderMutationResponse,
  UpdateModelProviderRequest,
} from './types';

export const SETTINGS_CHANGED_EVENT = 'lingxiao:settings-changed';

export interface SettingsChangedDetail {
  key: string;
  value: unknown;
}

export function notifySettingChanged(detail: SettingsChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, { detail }));
}

export async function settingsApiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      // Only set Content-Type: application/json when there IS a body.
      // Bodyless POST (e.g. /langfuse/test) with this header causes Fastify
      // to reject with FST_ERR_CTP_EMPTY_JSON_BODY (400).
      ...(opts?.body ? { 'Content-Type': 'application/json' } : {}),
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.message) message = String(data.message);
      else if (data?.error) message = String(data.error);
    } catch (err) {
      console.warn('[settingsApi] Failed to parse error response:', err);
    }
    throw new Error(message);
  }
  return res.json();
}

export function createModelProvider(
  payload: CreateModelProviderRequest,
): Promise<ModelProviderMutationResponse> {
  return settingsApiFetch<ModelProviderMutationResponse>('/settings/model-provider', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateModelProvider(
  id: string,
  payload: UpdateModelProviderRequest,
): Promise<ModelProviderMutationResponse> {
  return settingsApiFetch<ModelProviderMutationResponse>(`/settings/model-provider/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteModelProvider(id: string): Promise<{ success: boolean; data: { id: string } }> {
  return settingsApiFetch<{ success: boolean; data: { id: string } }>(
    `/settings/model-provider/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}
