export type CodingEvalTaskSource =
  | 'internal_golden'
  | 'swe_bench_lite_replay'
  | 'custom';

export interface CodingEvalTask {
  id: string;
  title: string;
  source: CodingEvalTaskSource;
  prompt: string;
  repo?: string;
  baseRef?: string;
  setupCommands?: string[];
  testCommands: string[];
  expectedFiles?: string[];
  acceptanceCriteria?: string[];
  maxTokens?: number;
  recoveryBudget?: number;
  metadata?: Record<string, unknown>;
}

export interface CodingEvalTaskRun {
  taskId: string;
  source: CodingEvalTaskSource;
  passed: boolean;
  testPassed: boolean;
  tokenTotal: number;
  recoveryCount: number;
  durationMs: number;
  changedFiles: string[];
  commandsRun: string[];
  failures: string[];
  metadata?: Record<string, unknown>;
}

export interface CodingEvalRunContext {
  suiteId: string;
  workspace: string;
  signal?: AbortSignal;
}

export interface CodingEvalRunner {
  run(task: CodingEvalTask, context: CodingEvalRunContext): Promise<CodingEvalTaskRun>;
}

export interface CodingEvalSuiteInput {
  suiteId: string;
  workspace: string;
  tasks: CodingEvalTask[];
  runner: CodingEvalRunner;
  signal?: AbortSignal;
}

export interface CodingEvalSuiteResult {
  suiteId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  totalTasks: number;
  passedTasks: number;
  failedTasks: number;
  passRate: number;
  testPassRate: number;
  tokenTotal: number;
  averageTokens: number;
  recoveryCount: number;
  averageRecoveryCount: number;
  results: CodingEvalTaskRun[];
}

export function validateCodingEvalTask(task: CodingEvalTask): void {
  if (!task.id.trim()) throw new Error('Coding eval task id is required.');
  if (!task.title.trim()) throw new Error(`Coding eval task ${task.id} title is required.`);
  if (!task.prompt.trim()) throw new Error(`Coding eval task ${task.id} prompt is required.`);
  if (!Array.isArray(task.testCommands) || task.testCommands.length === 0) {
    throw new Error(`Coding eval task ${task.id} must define at least one test command.`);
  }
}

export async function runCodingEvalSuite(input: CodingEvalSuiteInput): Promise<CodingEvalSuiteResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  for (const task of input.tasks) {
    validateCodingEvalTask(task);
  }

  const results: CodingEvalTaskRun[] = [];
  for (const task of input.tasks) {
    if (input.signal?.aborted) {
      throw new Error(`Coding eval suite ${input.suiteId} aborted before task ${task.id}.`);
    }
    results.push(await input.runner.run(task, {
      suiteId: input.suiteId,
      workspace: input.workspace,
      signal: input.signal,
    }));
  }

  const ended = Date.now();
  const passedTasks = results.filter((result) => result.passed).length;
  const testPassedTasks = results.filter((result) => result.testPassed).length;
  const tokenTotal = results.reduce((sum, result) => sum + result.tokenTotal, 0);
  const recoveryCount = results.reduce((sum, result) => sum + result.recoveryCount, 0);
  const totalTasks = results.length;
  return {
    suiteId: input.suiteId,
    startedAt,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    totalTasks,
    passedTasks,
    failedTasks: totalTasks - passedTasks,
    passRate: totalTasks === 0 ? 0 : passedTasks / totalTasks,
    testPassRate: totalTasks === 0 ? 0 : testPassedTasks / totalTasks,
    tokenTotal,
    averageTokens: totalTasks === 0 ? 0 : tokenTotal / totalTasks,
    recoveryCount,
    averageRecoveryCount: totalTasks === 0 ? 0 : recoveryCount / totalTasks,
    results,
  };
}

export function createReplayEvalRunner(replays: Record<string, Omit<CodingEvalTaskRun, 'taskId' | 'source'>>): CodingEvalRunner {
  return {
    async run(task) {
      const replay = replays[task.id];
      if (!replay) {
        throw new Error(`Missing replay result for coding eval task ${task.id}.`);
      }
      return {
        taskId: task.id,
        source: task.source,
        ...replay,
      };
    },
  };
}

export const INTERNAL_GOLDEN_TASK_TAG = 'lingxiao-internal-golden';
