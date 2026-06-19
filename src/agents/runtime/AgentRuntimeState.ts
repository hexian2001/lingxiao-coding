import type { Task } from '../BaseAgentRuntime.js';
import type { ContractAllowedScope } from '../../core/ContractAllowedScope.js';

export class AgentRuntimeState {
  currentTaskId: string | null = null;
  currentTaskWorkingDirectory: string | null = null;
  currentTaskWriteScope: string[] = [];
  /** 契约结构化允许面(由 payload 透传,worker 子进程启动时 set)。undefined=无契约→写工具维持原 scope 检查。 */
  currentContractAllowedScope: ContractAllowedScope | undefined = undefined;
  /** 完成校验重试耗尽后强制放行的审计标记(null=正常验收通过,非 null=本次完成未经测试门验证)。 */
  completionBypassed: { reason: string; retries: number } | null = null;
  iteration = 0;
  rawXmlRetryCount = 0;
  completionGuardRetryCount = 0;
  /**
   * 连续续跑次数（nextSpeaker=model / LLM continuation judge 触发的续跑）。
   * 任何一次真实工具调用都会清零。用于熔断「续跑→短 stop→续跑」空转死循环。
   */
  continuationRetryCount = 0;
  toolCallCount = 0;
  startTime = 0;

  initializeTaskScope(task: Task, workspace: string): void {
    this.currentTaskId = task.id;
    this.currentTaskWorkingDirectory = task.working_directory || workspace;
    this.currentTaskWriteScope = Array.isArray(task.write_scope) && task.write_scope.length > 0
      ? [...task.write_scope]
      : [this.currentTaskWorkingDirectory];
    this.rawXmlRetryCount = 0;
    this.completionGuardRetryCount = 0;
    this.continuationRetryCount = 0;
    this.startTime = Date.now();
  }

  restoreProgress(iteration: number, toolCallCount: number): void {
    this.iteration = iteration;
    this.toolCallCount = toolCallCount;
  }

  beginRound(): number {
    this.iteration += 1;
    return this.iteration;
  }

  repeatRound(): number {
    this.iteration = Math.max(0, this.iteration - 1);
    return this.iteration;
  }

  recordToolCalls(count: number): number {
    this.rawXmlRetryCount = 0;
    this.completionGuardRetryCount = 0;
    this.continuationRetryCount = 0;
    this.toolCallCount += count;
    return this.toolCallCount;
  }

  setRawXmlRetryCount(count: number): void {
    this.rawXmlRetryCount = count;
  }

  /** 续跑计数 +1 并返回新值。任何真实工具调用（recordToolCalls）会清零。 */
  incrementContinuationRetry(): number {
    this.continuationRetryCount += 1;
    return this.continuationRetryCount;
  }

  resetContinuationRetry(): void {
    this.continuationRetryCount = 0;
  }

  incrementCompletionGuardRetry(): number {
    this.completionGuardRetryCount += 1;
    return this.completionGuardRetryCount;
  }

  resetCompletionGuardRetry(): void {
    this.completionGuardRetryCount = 0;
  }
}
