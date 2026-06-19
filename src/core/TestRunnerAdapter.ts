import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';

export interface TestRunnerAdapterOptions {
  projectRoot: string;
  timeoutMs?: number;
}

export interface TestCommandPlan {
  command: string;
  args: string[];
  cwd: string;
}

export interface TestRunResult {
  passed: boolean;
  totalRun: number;
  passedCount: number;
  failedCount: number;
  failedTests: string[];
  diagnostics: string[];
  command: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
}

const DEFAULT_TEST_TIMEOUT_MS = 120_000;

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readPackageTestScript(projectRoot: string): string | null {
  try {
    const raw = readFileSync(join(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const script = parsed.scripts?.test;
    return typeof script === 'string' && script.trim() ? script.trim() : null;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function toProjectRelative(projectRoot: string, file: string): string {
  return isAbsolute(file) ? relative(projectRoot, file) : file;
}

function toDistTestFile(projectRoot: string, file: string): string | null {
  const relativePath = toProjectRelative(projectRoot, file).replaceAll('\\', '/');
  const ext = extname(relativePath);
  if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return null;
  }

  const withoutExt = relativePath.slice(0, -ext.length);
  const distRelative = withoutExt.startsWith('src/')
    ? `dist/${withoutExt.slice('src/'.length)}.js`
    : `${withoutExt}.js`;
  const distPath = join(projectRoot, distRelative);
  if (existsSync(distPath)) return distPath;

  const directPath = join(projectRoot, relativePath);
  return existsSync(directPath) ? directPath : null;
}

function sanitizeNodeTestEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('NODE_TEST_')) delete clean[key];
  }
  return clean;
}

function extractNodeTestSummary(output: string): {
  totalRun: number;
  passedCount: number;
  failedCount: number;
  failedTests: string[];
} {
  let totalRun = 0;
  let passedCount = 0;
  let failedCount = 0;
  let tapPlanTotal = 0;
  let tapPassedCount = 0;
  let tapFailedCount = 0;
  const failedTests: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const testsMatch = /^ℹ\s+tests\s+(\d+)$/.exec(trimmed) ?? /^#\s+tests\s+(\d+)$/.exec(trimmed);
    if (testsMatch) totalRun = Number(testsMatch[1]);
    const passMatch = /^ℹ\s+pass\s+(\d+)$/.exec(trimmed) ?? /^#\s+pass\s+(\d+)$/.exec(trimmed);
    if (passMatch) passedCount = Number(passMatch[1]);
    const failMatch = /^ℹ\s+fail\s+(\d+)$/.exec(trimmed) ?? /^#\s+fail\s+(\d+)$/.exec(trimmed);
    if (failMatch) failedCount = Number(failMatch[1]);

    const tapPlanMatch = /^1\.\.(\d+)$/.exec(trimmed);
    if (tapPlanMatch) tapPlanTotal = Number(tapPlanMatch[1]);
    if (/^ok\s+\d+(?:\s+-\s+.+)?$/.test(trimmed)) tapPassedCount += 1;
    if (/^not ok\s+\d+(?:\s+-\s+.+)?$/.test(trimmed)) tapFailedCount += 1;

    const failedNameMatch = /^(?:✖|not ok\s+\d+\s+-)\s+(.+)$/.exec(trimmed);
    if (failedNameMatch) failedTests.push(failedNameMatch[1].trim());
  }

  return {
    totalRun: totalRun || tapPlanTotal || tapPassedCount + tapFailedCount,
    passedCount: passedCount || tapPassedCount,
    failedCount: failedCount || tapFailedCount,
    failedTests: uniqueStrings(failedTests),
  };
}

export class TestRunnerAdapter {
  private readonly projectRoot: string;
  private readonly timeoutMs: number;

  constructor(options: TestRunnerAdapterOptions) {
    this.projectRoot = options.projectRoot;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  detectTestCommand(): string | null {
    return readPackageTestScript(this.projectRoot);
  }

  buildPlan(testFiles: string[] = []): TestCommandPlan {
    const runnableFiles = uniqueStrings(
      testFiles
        .map((file) => toDistTestFile(this.projectRoot, file))
        .filter((file): file is string => Boolean(file)),
    );

    if (runnableFiles.length > 0) {
      return {
        command: process.execPath,
        args: ['--test', '--test-reporter=tap', `--test-timeout=${this.timeoutMs}`, ...runnableFiles],
        cwd: this.projectRoot,
      };
    }

    const script = this.detectTestCommand();
    if (script) {
      return {
        command: 'npm',
        args: ['test'],
        cwd: this.projectRoot,
      };
    }

    return {
      command: process.execPath,
      args: ['--test', '--test-reporter=tap', `--test-timeout=${this.timeoutMs}`],
      cwd: this.projectRoot,
    };
  }

  async runTests(testFiles: string[] = []): Promise<TestRunResult> {
    const plan = this.buildPlan(testFiles);
    if (testFiles.length > 0 && plan.args.every((arg) => !arg.endsWith('.js') && !arg.endsWith('.mjs') && !arg.endsWith('.cjs'))) {
      return {
        passed: false,
        totalRun: 0,
        passedCount: 0,
        failedCount: 0,
        failedTests: [],
        diagnostics: [`no runnable compiled test files found for: ${testFiles.join(', ')}`],
        command: plan.command,
        args: plan.args,
        exitCode: null,
        durationMs: 0,
      };
    }
    const start = Date.now();
    const { stdout, stderr, exitCode, timedOut } = await this.spawnPlan(plan);
    const output = `${stdout}\n${stderr}`;
    const summary = extractNodeTestSummary(output);
    const noTargetedTestsReported = testFiles.length > 0 && summary.totalRun === 0;
    const diagnostics = uniqueStrings(
      [
        ...(noTargetedTestsReported ? ['targeted test command reported zero executed tests'] : []),
        ...summary.failedTests,
        ...output
          .split(/\r?\n/)
          .filter((line) => line.trim().startsWith('✖') || line.trim().startsWith('not ok'))
          .map((line) => line.trim()),
      ],
    ).slice(0, 50);

    return {
      passed: !timedOut && exitCode === 0 && !noTargetedTestsReported,
      totalRun: summary.totalRun,
      passedCount: summary.passedCount,
      failedCount: summary.failedCount,
      failedTests: summary.failedTests,
      diagnostics: timedOut ? [`test command timed out after ${this.timeoutMs}ms`] : diagnostics,
      command: plan.command,
      args: plan.args,
      exitCode,
      durationMs: Date.now() - start,
    };
  }

  private spawnPlan(plan: TestCommandPlan): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    return new Promise((resolve) => {
      const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: sanitizeNodeTestEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);
      if (timer.unref) timer.unref();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        stderr += `\n${error.message}`;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code, timedOut });
      });
    });
  }
}
