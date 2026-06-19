import { withToolProxyEnv } from '../ProxyConfig.js';

const ASKPASS_ENV_KEYS = [
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'ASKPASS',
] as const;

const PAGER_ENV_KEYS = [
  'GIT_PAGER',
  'PAGER',
] as const;

const EDITOR_ENV_KEYS = [
  'GIT_EDITOR',
  'EDITOR',
  'VISUAL',
] as const;

/**
 * Build a non-interactive environment for server-side git commands.
 *
 * The desktop host may export askpass helpers for GUI credential prompts, but
 * those helpers are not allowed inside the app sandbox and should not be needed
 * for read-only Git UI operations. Removing them also makes write operations
 * fail fast instead of hanging on an invisible prompt.
 */
export function buildSafeGitEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = String(value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = String(value);
  }
  for (const key of ASKPASS_ENV_KEYS) {
    delete env[key];
  }
  for (const key of PAGER_ENV_KEYS) {
    delete env[key];
  }
  for (const key of EDITOR_ENV_KEYS) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return withToolProxyEnv(env) as Record<string, string>;
}
