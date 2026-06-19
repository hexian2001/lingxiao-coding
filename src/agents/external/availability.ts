import { config } from '../../config.js';
import { t } from '../../i18n.js';
import { commandExists } from '../../utils/platform.js';

export type ExternalAgentBackendAvailability = {
  command: string;
  installed: boolean;
  reason?: string;
};

export type ExternalAgentAvailability = {
  enabled: boolean;
  claude: ExternalAgentBackendAvailability;
  codex: ExternalAgentBackendAvailability;
};

export type ExternalAgentBackend = 'claude' | 'codex';

export function getExternalAgentCommand(backend: ExternalAgentBackend): string {
  if (backend === 'claude') return process.env.LINGXIAO_CLAUDE_BIN || 'claude';
  return process.env.LINGXIAO_CODEX_BIN || 'codex';
}

function checkBackend(backend: ExternalAgentBackend, enabled: boolean): ExternalAgentBackendAvailability {
  const command = getExternalAgentCommand(backend);
  const installed = enabled && commandExists(command);
  return {
    command,
    installed,
    reason: enabled
      ? installed
        ? undefined
        : `missing_command:${command}`
      : 'disabled',
  };
}

export function areExternalAgentsEnabled(): boolean {
  return config.agents.external_agents_enabled !== false;
}

export function getExternalAgentAvailability(): ExternalAgentAvailability {
  const enabled = areExternalAgentsEnabled();
  return {
    enabled,
    claude: checkBackend('claude', enabled),
    codex: checkBackend('codex', enabled),
  };
}

export function assertExternalAgentAvailable(backend: ExternalAgentBackend): void {
  const availability = getExternalAgentAvailability();
  if (!availability.enabled) {
    throw new Error(t('external_agent.disabled', backend));
  }
  const backendAvailability = availability[backend];
  if (!backendAvailability.installed) {
    throw new Error(t('external_agent.command_not_found', backend, backendAvailability.command));
  }
}
