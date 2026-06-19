import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { OrchestrationTaskMetadata } from './OrchestrationTypes.js';

export type AdversarialBreakerVerdict = 'PASS' | 'FAIL' | 'BLOCKED';

export interface AdversarialCommandStrategy {
  id: string;
  type: 'command';
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  expectedExitCode?: number;
  failOnExitCode?: number;
}

export interface AdversarialCommandEvidence {
  strategyId: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface AdversarialBreakerResult {
  verdict: AdversarialBreakerVerdict;
  evidence: AdversarialCommandEvidence[];
  summary: string;
  findings: string[];
}

export interface AdversarialBreakerPolicy {
  enabled?: boolean;
  timeoutMs?: number;
  strategies: AdversarialCommandStrategy[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeInteger(value: unknown): number | undefined {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : undefined;
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return Math.trunc(raw);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const normalized = normalizeInteger(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

export function extractAdversarialBreakerPolicy(orchestration?: OrchestrationTaskMetadata): AdversarialBreakerPolicy | undefined {
  const evaluationPolicy = asRecord(orchestration?.evaluationPolicy);
  const rawPolicy = asRecord(evaluationPolicy?.adversarial ?? evaluationPolicy?.breaker);
  if (!rawPolicy || rawPolicy.enabled === false) return undefined;
  const strategies = Array.isArray(rawPolicy.strategies)
    ? rawPolicy.strategies
      .map((value): AdversarialCommandStrategy | null => {
        const strategy = asRecord(value);
        if (!strategy || strategy.type !== 'command') return null;
        const id = normalizeString(strategy.id);
        const command = normalizeString(strategy.command);
        if (!id || !command) return null;
        return {
          id,
          type: 'command',
          command,
          args: normalizeStringArray(strategy.args),
          cwd: normalizeString(strategy.cwd),
          timeoutMs: normalizePositiveInteger(strategy.timeout_ms ?? strategy.timeoutMs),
          expectedExitCode: normalizeInteger(strategy.expected_exit_code ?? strategy.expectedExitCode),
          failOnExitCode: normalizeInteger(strategy.fail_on_exit_code ?? strategy.failOnExitCode),
        };
      })
      .filter((strategy): strategy is AdversarialCommandStrategy => Boolean(strategy))
    : [];
  return {
    enabled: rawPolicy.enabled === true,
    timeoutMs: normalizePositiveInteger(rawPolicy.timeout_ms ?? rawPolicy.timeoutMs),
    strategies,
  };
}

function truncateOutput(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS ? value : value.slice(-MAX_OUTPUT_CHARS);
}

function runCommandStrategy(input: {
  strategy: AdversarialCommandStrategy;
  workingDir: string;
  defaultTimeoutMs: number;
}): Promise<AdversarialCommandEvidence> {
  return new Promise((resolveEvidence) => {
    const startedAt = Date.now();
    const cwd = resolve(input.strategy.cwd ?? input.workingDir);
    const args = input.strategy.args ?? [];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(input.strategy.command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1000).unref?.();
    }, input.strategy.timeoutMs ?? input.defaultTimeoutMs);

    child.stdout?.on('data', (chunk) => { stdout = truncateOutput(stdout + String(chunk)); });
    child.stderr?.on('data', (chunk) => { stderr = truncateOutput(stderr + String(chunk)); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveEvidence({
        strategyId: input.strategy.id,
        command: input.strategy.command,
        args,
        cwd,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: truncateOutput(stderr + error.message),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveEvidence({
        strategyId: input.strategy.id,
        command: input.strategy.command,
        args,
        cwd,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

function evidenceFinding(strategy: AdversarialCommandStrategy, evidence: AdversarialCommandEvidence): string | null {
  if (evidence.timedOut) {
    return `strategy ${strategy.id} timed out after ${evidence.durationMs}ms`;
  }
  if (strategy.failOnExitCode !== undefined && evidence.exitCode === strategy.failOnExitCode) {
    return `strategy ${strategy.id} reproduced a failure signal with exit code ${evidence.exitCode}`;
  }
  const expected = strategy.expectedExitCode ?? 0;
  if (evidence.exitCode !== expected) {
    return `strategy ${strategy.id} expected exit code ${expected}, got ${evidence.exitCode ?? 'null'}`;
  }
  return null;
}

export async function runAdversarialBreaker(input: {
  workingDir: string;
  policy?: AdversarialBreakerPolicy;
}): Promise<AdversarialBreakerResult> {
  const strategies = input.policy?.strategies ?? [];
  if (strategies.length === 0) {
    return {
      verdict: 'PASS',
      evidence: [],
      findings: [],
      summary: 'no executable adversarial strategies configured',
    };
  }

  const defaultTimeoutMs = input.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const evidence: AdversarialCommandEvidence[] = [];
  const findings: string[] = [];
  let timedOut = false;
  for (const strategy of strategies) {
    const result = await runCommandStrategy({ strategy, workingDir: input.workingDir, defaultTimeoutMs });
    evidence.push(result);
    const finding = evidenceFinding(strategy, result);
    if (result.timedOut) timedOut = true;
    if (finding) findings.push(finding);
  }

  const verdict: AdversarialBreakerVerdict = timedOut ? 'BLOCKED' : findings.length > 0 ? 'FAIL' : 'PASS';
  return {
    verdict,
    evidence,
    findings,
    summary: findings.length > 0
      ? findings.join('\n')
      : `all ${evidence.length} adversarial strategy command(s) matched expected evidence`,
  };
}

export function formatAdversarialBreakerFeedback(result: AdversarialBreakerResult): string {
  const lines = [
    `adversarial breaker verdict: ${result.verdict}`,
    result.summary,
  ];
  for (const evidence of result.evidence) {
    lines.push([
      `strategy=${evidence.strategyId}`,
      `cmd=${[evidence.command, ...evidence.args].join(' ')}`,
      `cwd=${evidence.cwd}`,
      `exit=${evidence.exitCode ?? 'null'}`,
      `timeout=${evidence.timedOut}`,
      evidence.stdout ? `stdout=${evidence.stdout.slice(-1000)}` : '',
      evidence.stderr ? `stderr=${evidence.stderr.slice(-1000)}` : '',
    ].filter(Boolean).join('\n'));
  }
  return lines.join('\n\n');
}
