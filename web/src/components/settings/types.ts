export type ModelProtocol = 'openai' | 'anthropic';
export type ModelProviderId = ModelProtocol;
export type ThemeMode = 'light' | 'dark' | 'system';
export type SettingsData = Record<string, unknown>;
export type SystemInfoData = {
  cwd?: string;
  os?: string;
  arch?: string;
  nodeVersion?: string;
  version?: string;
  uptime?: number;
};

export function settingString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function settingNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function settingStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ModelProviderModel[];
}

export interface ModelProviderModel {
  id: string;
  name: string;
  model?: string;
  provider?: ModelProviderId;
  baseUrl: string;
  envKey?: string;
  contextWindowSize?: number;
  generationConfig?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export interface CreateModelProviderRequest {
  provider: ModelProviderId;
  name?: string;
  model: string;
  apiKey?: string;
  envKey?: string;
  baseUrl: string;
  contextWindowSize?: number;
  generationConfig?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export interface UpdateModelProviderRequest {
  provider?: ModelProviderId;
  model?: string;
  apiKey?: string;
  envKey?: string | null;
  baseUrl?: string;
  contextWindowSize?: number | null;
  generationConfig?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
}

export interface ModelProviderMutationResponse {
  success: boolean;
  data: ModelProviderModel & {
    updated?: boolean;
  };
}

export interface ExternalAgentsStatus {
  enabled: boolean;
  claude: { command: string; installed: boolean; reason?: string };
  codex: { command: string; installed: boolean; reason?: string };
}

export interface AddModelForm {
  protocol: ModelProtocol;
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  contextWindowSize: number | '';
  maxTokens: number | '';
}

export const DEFAULT_MODEL_BASE_URL: Record<ModelProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export const createDefaultAddModelForm = (): AddModelForm => ({
  protocol: 'openai',
  name: '',
  model: '',
  apiKey: '',
  baseUrl: DEFAULT_MODEL_BASE_URL.openai,
  contextWindowSize: '',
  maxTokens: '',
});

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export interface SaveState {
  saving: Record<string, boolean>;
  saved: Record<string, boolean>;
  errors: Record<string, string | undefined>;
}

export type SaveSetting = (key: string, value: unknown) => Promise<SaveResult>;
