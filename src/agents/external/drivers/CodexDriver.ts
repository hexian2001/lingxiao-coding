import { join } from 'path';
import { tmpdir } from 'os';
import type { ExternalAgentInput, ExternalDriver, ExternalEvent, ExternalExecutionPlan } from '../types.js';
import { extractDriverUsage } from '../../../llm/usageExtractor.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {/* expected: resource not available */
    return undefined;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {/* expected: fallback to default */
    return String(value);
  }
}

export class CodexDriver implements ExternalDriver {
  readonly type = 'codex' as const;

  buildExecute(input: ExternalAgentInput): ExternalExecutionPlan {
    const command = process.env.LINGXIAO_CODEX_BIN || 'codex';
    const providerName = 'lingxiao';
    const wireApi = input.model.wireApi || 'chat';
    const codexHome = join(tmpdir(), 'lingxiao', 'codex', input.sessionId, input.agentId);
    const args = [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--color', 'never',
      '--model', input.model.apiModel,
      '-c', `model_provider="${providerName}"`,
      '-c', `model_providers.${providerName}.name="${providerName}"`,
      '-c', `model_providers.${providerName}.wire_api="${wireApi}"`,
      '-c', `model_providers.${providerName}.base_url="${input.model.baseUrl}"`,
      '-c', `model_providers.${providerName}.env_key="${input.model.envKey}"`,
      '-c', `model_reasoning_effort="${input.model.reasoningEffort || 'high'}"`,
      ...(typeof input.model.disableResponseStorage === 'boolean'
        ? ['-c', `disable_response_storage=${input.model.disableResponseStorage ? 'true' : 'false'}`]
        : []),
      ...(input.model.networkAccess
        ? ['-c', `network_access="${input.model.networkAccess}"`]
        : []),
      '-c', `base_instructions=${JSON.stringify(input.systemPrompt)}`,
      '-C', input.workingDirectory,
      '--add-dir', input.workspace,
      ...(input.extraArgs || []),
    ];

    return {
      command,
      args,
      stdin: input.prompt,
      cwd: input.workingDirectory,
      env: {
        [input.model.envKey]: input.model.apiKey,
        OPENAI_API_KEY: input.model.apiKey,
        CODEX_HOME: codexHome,
      },
    };
  }

  parseStdoutLine(line: string): ExternalEvent[] {
    const obj = parseJsonLine(line);
    if (!obj) return [];
    const events: ExternalEvent[] = [];

    const type = obj.type;
    const payload = asRecord(obj.payload) ?? obj;
    const eventType = payload.type || type;

    if (type === 'thread.started' && obj.thread_id) {
      events.push({ kind: 'started', sessionId: String(obj.thread_id) });
      return events;
    }
    if (type === 'turn.started') {
      events.push({ kind: 'status', phase: 'turn_started' });
      return events;
    }

    switch (eventType) {
      case 'task_started':
        events.push({ kind: 'status', phase: 'task_started' });
        break;
      case 'agent_message':
        if (payload.message) {
          events.push({ kind: 'text_full', text: String(payload.message) });
        }
        break;
      case 'exec_command_end': {
        const command = Array.isArray(payload.command) ? payload.command.join(' ') : asText(payload.command);
        const callId = String(payload.call_id || `exec-${Date.now()}`);
        events.push({ kind: 'tool_call', toolCallId: callId, name: 'shell', input: { command, cwd: payload.cwd } });
        events.push({
          kind: 'tool_result',
          toolCallId: callId,
          tool: 'shell',
          output: `${asText(payload.stdout)}${payload.stderr ? `\n[stderr]\n${asText(payload.stderr)}` : ''}`,
          isError: Number(payload.exit_code ?? 0) !== 0,
        });
        break;
      }
      case 'patch_apply_end': {
        const callId = String(payload.call_id || `patch-${Date.now()}`);
        events.push({ kind: 'tool_call', toolCallId: callId, name: 'apply_patch', input: { changes: payload.changes } });
        events.push({
          kind: 'tool_result',
          toolCallId: callId,
          tool: 'apply_patch',
          output: asText(payload.stdout || payload.stderr || payload.changes),
          isError: payload.success === false,
        });
        break;
      }
      case 'token_count': {
        const info = asRecord(payload.info);
        const rawUsage = info?.total_token_usage || info?.token_usage || payload.usage;
        const usage = extractDriverUsage(rawUsage);
        if (usage) {
          events.push({
            kind: 'usage',
            prompt: usage.prompt,
            completion: usage.completion,
            total: usage.total,
            cacheRead: usage.cacheRead,
          });
        }
        break;
      }
      case 'task_complete':
        events.push({
          kind: 'complete',
          result: String(payload.last_agent_message ?? payload.message ?? ''),
          durationMs: Number(payload.duration_ms ?? 0),
        });
        break;
      case 'turn_aborted':
        events.push({ kind: 'error', message: `codex turn_aborted: ${payload.reason || 'unknown'}`, fatal: true });
        break;
      case 'error':
      case 'stream.error':
        events.push({ kind: 'error', message: String(payload.message || payload.error || 'codex execution failed'), fatal: true });
        break;
    }

    return events;
  }

  parseStderrLine(line: string): ExternalEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (/invalid api key|unauthorized|forbidden|permission denied/i.test(trimmed)) {
      return [{ kind: 'error', message: trimmed, fatal: true }];
    }
    return [];
  }

  finalizeResult(events: ExternalEvent[], exitCode: number | null): string {
    const complete = [...events].reverse().find((event): event is Extract<ExternalEvent, { kind: 'complete' }> => event.kind === 'complete');
    if (complete) return complete.result;
    if (exitCode !== 0) return '';
    return events
      .filter((event): event is Extract<ExternalEvent, { kind: 'text_full' | 'text_delta' }> => event.kind === 'text_full' || event.kind === 'text_delta')
      .map(event => event.text)
      .join('\n\n')
      .trim();
  }
}
