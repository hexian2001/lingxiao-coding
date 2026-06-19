import { BuildDiagnosticsCollector } from '../../core/BuildDiagnosticsCollector.js';
import { ChangeImpactResolver } from '../../core/ChangeImpactResolver.js';
import { TestRunnerAdapter } from '../../core/TestRunnerAdapter.js';
import { VerificationPipeline, type VerificationGateConfig, type VerificationResult } from '../../core/VerificationPipeline.js';
import type { WorkerArtifactTrace } from '../../core/AgentProtocol.js';
import { getConfigValue } from '../../config.js';
import { agentLogger } from '../../core/Log.js';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface CompletionVerificationInput {
  workingDir: string;
  artifacts?: WorkerArtifactTrace;
  toolTrace?: WorkerArtifactTrace;
}

function isEnabled(path: string, fallback: boolean): boolean {
  const value = getConfigValue(path);
  return typeof value === 'boolean' ? value : fallback;
}

function positiveNumber(path: string, fallback: number): number {
  const value = Number(getConfigValue(path));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(path: string, fallback: number): number {
  const value = Number(getConfigValue(path));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function collectCompletionChangedFiles(input: {
  artifacts?: WorkerArtifactTrace;
  toolTrace?: WorkerArtifactTrace;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [
    ...(input.artifacts?.files_created ?? []),
    ...(input.artifacts?.files_modified ?? []),
    ...(input.toolTrace?.files_created ?? []),
    ...(input.toolTrace?.files_modified ?? []),
  ]) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 用 git 真实取证改动文件(git status --porcelain -z -uall),补全 worker 自报的漏报(最大洞)。
 * 非 git 仓库或 git 调用失败 → 返回 [](fallback 到纯自报,绝不阻塞验收)。
 * worktree 下 .git 是指向主仓库的文件指针,existsSync 仍 true,git -C status 正常工作。
 * -uall(=--untracked-files=all):展开未跟踪目录到逐文件。默认 normal 会把新建目录折叠成
 * "sub/",丢失逐文件粒度——而 worker 新建整目录模块正是最该被取证的场景,验收门/契约校验
 * 都按单文件工作,折叠目录会让 affected-test 检测漏掉新文件。
 */
export function collectGitChangedFiles(workingDir: string): string[] {
  if (!workingDir || !existsSync(join(workingDir, '.git'))) return [];
  const result = spawnSync('git', ['-C', workingDir, 'status', '--porcelain=v1', '-z', '-uall'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout) return [];
  // porcelain -z 用 \0 分隔;每条形如 XY<space>path(XY 是 2 字符状态码 + 1 空格)。
  // 只取第 3 字符为空格的条目(有 XY 状态码前缀),过滤掉重命名条目无前缀的 new path。
  return result.stdout
    .split('\0')
    .filter(entry => entry.length >= 3 && entry[2] === ' ')
    .map(entry => entry.slice(3).trim())
    .filter(p => p.length > 0);
}

export function resolveVerificationGateConfig(): Partial<VerificationGateConfig> {
  return {
    typeCheck: isEnabled('verification.typecheck', true),
    build: isEnabled('verification.build', true),
    affectedTests: isEnabled('verification.affected_tests', true),
    fullTests: isEnabled('verification.full_tests', false),
    selfRepairBudget: nonNegativeNumber('verification.self_repair_budget', 3),
    buildTimeoutMs: positiveNumber('verification.build_timeout_ms', 120_000),
    testTimeoutMs: positiveNumber('verification.test_timeout_ms', 120_000),
  };
}

export async function runCompletionVerification(
  input: CompletionVerificationInput,
): Promise<VerificationResult | undefined> {
  if (!isEnabled('verification.completion_gate_enabled', true)) {
    return undefined;
  }
  const selfReported = collectCompletionChangedFiles(input);
  const gitReported = collectGitChangedFiles(input.workingDir);
  // B1: union git 真实取证 + worker 自报——漏报被 git 补全,验收管线不再因 worker 漏报而跳过。
  const changedFiles = Array.from(new Set([...selfReported, ...gitReported]));
  if (gitReported.length > 0) {
    const unreported = gitReported.filter(f => !selfReported.includes(f));
    if (unreported.length > 0) {
      agentLogger.warn(`[verification] worker 漏报 ${unreported.length} 个改动文件,已由 git 取证补全: ${unreported.slice(0, 10).join(', ')}${unreported.length > 10 ? ' ...' : ''}`);
    }
  }
  if (changedFiles.length === 0) {
    return undefined;
  }

  const config = resolveVerificationGateConfig();
  const pipeline = new VerificationPipeline({
    buildDiagnostics: new BuildDiagnosticsCollector(),
    changeImpactResolver: new ChangeImpactResolver({
      projectRoot: input.workingDir,
      runBuildCheck: false,
      buildTimeoutMs: config.buildTimeoutMs,
    }),
    testRunner: new TestRunnerAdapter({
      projectRoot: input.workingDir,
      timeoutMs: config.testTimeoutMs,
    }),
    logger: agentLogger,
  });

  return pipeline.verify(input.workingDir, changedFiles, config);
}

