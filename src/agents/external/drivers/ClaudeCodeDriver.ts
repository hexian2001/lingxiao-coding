import { randomUUID } from 'crypto';
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

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) return String((item as Record<string, unknown>).text ?? '');
      return JSON.stringify(item);
    }).join('\n');
  }
  if (value == null) return '';
  return JSON.stringify(value);
}

export class ClaudeCodeDriver implements ExternalDriver {
  readonly type = 'claude' as const;

  buildExecute(input: ExternalAgentInput): ExternalExecutionPlan {
    const sessionIdHint = randomUUID();
    const command = process.env.LINGXIAO_CLAUDE_BIN || 'claude';
    // 抑制 claude-code 内置身份/语气注入：
    // - 二进制内的 "You are Claude Code, Anthropic's official CLI..." 系统提示无法从外部删除，
    //   只能通过 --append-system-prompt 在其后追加一段强覆写指令，让模型按凌霄 worker 角色执行。
    // - 一并禁用 Claude Code 自带的对话风格、emoji 限制、自我标识反馈等会污染 worker 输出的部分。
    const overridePrefix = [
      'Operate as a Lingxiao external worker subagent for this run.',
      'Use Lingxiao task instructions, workspace boundaries, completion protocol, and role system as the active authority.',
      'Keep identity and status language focused on the assigned Lingxiao worker role and task.',
      'Keep memory and artifacts inside the workspace/session paths provided by Lingxiao.',
      'Follow the task instructions and system prompt provided by Lingxiao below.',
      '',
    ].join('\n');
    const mergedSystemPrompt = overridePrefix + (input.systemPrompt || '');
    const args = [
      '-p',
      ...(input.extraArgs?.includes('--no-bare') ? [] : ['--bare']),
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--session-id', sessionIdHint,
      '--model', input.model.apiModel,
      '--add-dir', input.workingDirectory,
      '--add-dir', input.workspace,
      '--append-system-prompt', mergedSystemPrompt,
      ...(input.extraArgs || []).filter(arg => arg !== '--no-bare'),
    ];

    return {
      command,
      args,
      stdin: input.prompt,
      cwd: input.workingDirectory,
      sessionIdHint,
      env: {
        ANTHROPIC_BASE_URL: input.model.baseUrl,
        ANTHROPIC_AUTH_TOKEN: input.model.apiKey,
        ANTHROPIC_API_KEY: input.model.apiKey,
        ANTHROPIC_MODEL: input.model.apiModel,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    };
  }

  parseStdoutLine(line: string): ExternalEvent[] {
    const obj = parseJsonLine(line);
    if (!obj) return [];
    const events: ExternalEvent[] = [];

    if (obj.type === 'system') {
      if (obj.subtype === 'init' && obj.session_id) {
        events.push({ kind: 'started', sessionId: String(obj.session_id) });
      } else if (obj.subtype === 'status' && obj.status) {
        events.push({ kind: 'status', phase: String(obj.status) });
      }
      return events;
    }

    if (obj.type === 'stream_event') {
      const ev = asRecord(obj.event);
      if (ev?.type === 'content_block_delta') {
        const delta = asRecord(ev.delta);
        if (delta?.type === 'text_delta') {
          events.push({ kind: 'text_delta', text: String(delta.text ?? '') });
        } else if (delta?.type === 'thinking_delta') {
          events.push({ kind: 'thinking_delta', text: String(delta.thinking ?? delta.text ?? '') });
        }
      } else if (ev?.type === 'message_delta' && ev.usage) {
        const usage = extractDriverUsage(ev.usage);
        if (usage) {
          events.push({
            kind: 'usage',
            prompt: usage.prompt,
            completion: usage.completion,
            total: usage.total,
            cacheRead: usage.cacheRead,
            cacheCreation: usage.cacheCreation,
          });
        }
      }
      return events;
    }

    if (obj.type === 'assistant') {
      const blocks = asRecord(obj.message)?.content;
      if (Array.isArray(blocks)) {
        for (const rawBlock of blocks) {
          const block = asRecord(rawBlock);
          if (block?.type === 'tool_use') {
            events.push({
              kind: 'tool_call',
              toolCallId: String(block.id ?? ''),
              name: String(block.name ?? 'tool'),
              input: block.input,
            });
          }
        }
      }
      return events;
    }

    if (obj.type === 'user') {
      const blocks = asRecord(obj.message)?.content;
      if (Array.isArray(blocks)) {
        for (const rawBlock of blocks) {
          const block = asRecord(rawBlock);
          if (block?.type === 'tool_result') {
            events.push({
              kind: 'tool_result',
              toolCallId: String(block.tool_use_id ?? ''),
              output: stringifyContent(block.content),
              isError: Boolean(block.is_error),
            });
          }
        }
      }
      return events;
    }

    if (obj.type === 'result') {
      if (obj.usage) {
        const usage = extractDriverUsage(obj.usage);
        if (usage) {
          events.push({
            kind: 'usage',
            prompt: usage.prompt,
            completion: usage.completion,
            total: usage.total,
            cacheRead: usage.cacheRead,
            cacheCreation: usage.cacheCreation,
          });
        }
      }
      if (obj.is_error) {
        events.push({ kind: 'error', message: String(obj.result || obj.subtype || 'claude execution failed'), fatal: true });
      } else {
        events.push({
          kind: 'complete',
          result: String(obj.result ?? ''),
          durationMs: Number(obj.duration_ms ?? 0),
          modelUsage: asRecord(obj.modelUsage),
        });
      }
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
      .filter((event): event is Extract<ExternalEvent, { kind: 'text_delta' | 'text_full' }> => event.kind === 'text_delta' || event.kind === 'text_full')
      .map(event => event.text)
      .join('')
      .trim();
  }
}
