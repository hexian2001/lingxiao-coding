/**
 * WorkerProcessEntry - Worker 子进程入口
 *
 * 由 WorkerProcessRunner 启动，负责：
 * 1. 从环境变量读取任务 payload
 * 2. 尽早向父进程确认子进程已启动，避免重型初始化被误判为 spawn timeout
 * 3. 初始化 Agent 执行环境
 * 4. 通过 IPC 向父进程报告进度和结果
 * 5. 处理信号和优雅退出
 */

import { readFileSync } from 'fs';
import type {
  WorkerTaskPayload,
  WorkerMessage,
  WorkerParentMessage,
} from '../core/WorkerProcessRunner.js';
import type { ChatMessage } from '../llm/types.js';
import type { BusMessageType } from '../core/BusMessageTypes.js';
import type { AgentExecutionResult } from './AgentExecutionResult.js';
import { agentLogger } from '../core/Log.js';
import { classifyDbClosedWorkerFailure } from './WorkerDbClosedClassification.js';

// 检查是否在子进程中运行
if (!process.send) {
  console.error('WorkerProcessEntry must be run as a child process with IPC');
  process.exit(1);
}

// 读取 payload
const payloadPath = process.env.LINGXIAO_WORKER_PAYLOAD;
if (!payloadPath) {
  console.error('LINGXIAO_WORKER_PAYLOAD not set');
  process.exit(1);
}

let payload: WorkerTaskPayload;
try {
  payload = JSON.parse(readFileSync(payloadPath, 'utf-8')) as WorkerTaskPayload;
} catch (error) {
  console.error('Failed to read payload:', error);
  process.exit(1);
}

// DB-closed 错误的分类（terminated vs recoverable）已抽成纯函数
// classifyDbClosedWorkerFailure，见 ./WorkerDbClosedClassification.ts。判定依据是
// gracefulShutdownInitiated 闩锁（真实关停态），不再靠字符串启发式猜测。

function sendMessage(msg: WorkerMessage): void {
  if (process.send) {
    try {
      process.send(msg);
    } catch {
      // IPC channel 已关闭（父进程退出）——静默丢弃，不要让 bridge subscriber 抛异常杀死 worker
    }
  }
}

/**
 * 发送 IPC 消息并等待 drain，确保父进程收到后再退出。
 * process.send() 在 pipe 满时是异步的，直接 process.exit() 可能丢消息。
 */
function sendMessageAndDrain(msg: WorkerMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!process.send) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 1000);
    if (timeout.unref) timeout.unref();
    try {
      const flushed = process.send(msg, () => finish());
      // process.send returns true when buffered synchronously
      if (flushed) finish();
    } catch {
      finish();
    }
  });
}

function isWorkerParentMessage(value: unknown): value is WorkerParentMessage {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in (value as Record<string, unknown>) &&
    (value as WorkerParentMessage).type === 'deliver_message'
  );
}

function isAgentExecutionResult(value: unknown): value is AgentExecutionResult {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'status' in (value as Record<string, unknown>) &&
    'summary' in (value as Record<string, unknown>) &&
    typeof (value as { summary?: unknown }).summary === 'string'
  );
}

function resultSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isAgentExecutionResult(value)) return value.summary;
  if (value && typeof value === 'object' && typeof (value as { summary?: unknown }).summary === 'string') {
    return (value as { summary: string }).summary;
  }
  return JSON.stringify(value);
}

let cleanupRuntime: (() => void) | null = null;
let currentPhase = 'bootstrapping';

// 关停态闩锁：worker 是否已收到信号并进入 gracefulShutdown。这是「主 try 块执行期间出现
// DB-closed 错误时，该判良性拆解副产物(terminated)还是真实运行期故障(recoverable)」的
// 唯一确定性判据。db.close() 只在 gracefulShutdown / main finally / fatal uncaughtException
// 调用，故主 try 块在飞期间出现 DB-closed 必然源自 gracefulShutdown。闩锁在 gracefulShutdown
// 首行（db.close() 之前）置位，永不复位。
let gracefulShutdownInitiated = false;

// pipeline-flush 契约：Worker 侧 pending flush 回调。
// 由 BaseAgentRuntime 在创建 ToolScheduler 时注册，
// pipeline-flush 函数已移至 WorkerFlushRegistry.ts（避免 BaseAgentRuntime → WorkerProcessEntry
// import 链触发本文件顶层 process.exit(1) 守卫）。
// WorkerProcessEntry 仍通过 re-export 保持向后兼容。
export { setWorkerFlushFn } from './WorkerFlushRegistry.js';
import { flushPendingToolResults } from './WorkerFlushRegistry.js';

function reportPhase(phase: string): void {
  currentPhase = phase;
  sendMessage({ type: 'progress', timestamp: Date.now(), payload: { phase } });
  sendMessage({ type: 'heartbeat', timestamp: Date.now(), payload: { phase } });
}

// 让父进程尽快拿到“已启动”握手，重型 import/初始化放到后面。
sendMessage({
  type: 'started',
  timestamp: Date.now(),
  payload: { agentId: payload.agentId, taskId: payload.taskId, phase: 'bootstrapping' },
});

const heartbeatInterval = setInterval(() => {
  sendMessage({
    type: 'heartbeat',
    timestamp: Date.now(),
    payload: { phase: currentPhase },
  });
}, 30000);

function clearRuntime(): void {
  clearInterval(heartbeatInterval);
  cleanupRuntime?.();
  cleanupRuntime = null;
}

function gracefulShutdown(signal: string): void {
  // 必须先置位闩锁再 clearRuntime()→db.close()：紧随其后的在飞 runWithConclude 会撞已关
  // 连接抛 "Database has been closed"，主 catch 据此闩锁判定为良性拆解副产物(terminated)，
  // 而非被误判成 recoverable 触发无谓 respawn。
  gracefulShutdownInitiated = true;
  agentLogger.info(`[Worker ${payload.agentName}] Received ${signal}, shutting down gracefully...`);
  // pipeline-flush 契约：在 clearRuntime()（含 db.close()）之前 flush pending tool_results。
  // flushPendingToolResults 是 async，但 gracefulShutdown 是 sync 函数——
  // 用 .catch 吞错 + 不 await（fire-and-forget），靠 3s 超时兜底不阻塞退出。
  // clearRuntime() 的 1s setTimeout 给 flush 留出 settle 窗口。
  flushPendingToolResults().catch(() => {});
  clearRuntime();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// 防止重复注册（防御性编程）
let signalHandlersRegistered = false;
function registerSignalHandlers() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

  // Worker 进程 uncaughtException 保护：
  // 已知可恢复的 DB 错误（SQLITE_BUSY、连接关闭）不应杀死 worker。
  // 非恢复性错误仍正常退出（发送 failed IPC 后 exit(1)）。
  let workerRecoverableErrorCount = 0;
  process.on('uncaughtException', (error) => {
    const msg = error.message || '';
    const isDbError = /SQLITE_BUSY|database is locked|Database has been closed|reconnection failed|requires sessionId/i.test(msg);
    if (isDbError && workerRecoverableErrorCount < 5) {
      workerRecoverableErrorCount++;
      console.warn(`[Worker ${payload.agentName}] Recoverable DB error (${workerRecoverableErrorCount}/5), continuing:`, msg);
      return;
    }
    // 不可恢复：发送 failed 通知后退出
    console.error(`[Worker ${payload.agentName}] Fatal uncaughtException:`, error);
    sendMessage({
      type: 'failed',
      timestamp: Date.now(),
      payload: `uncaughtException: ${msg}`,
    });
    // pipeline-flush 契约：在 clearRuntime() 之前 flush pending tool_results。
    // fire-and-forget + 3s 超时兜底，200ms exit timer 给 flush 留窗口。
    flushPendingToolResults().catch(() => {});
    clearRuntime();
    setTimeout(() => process.exit(1), 200);
  });
}
registerSignalHandlers();

async function main(): Promise<void> {
  try {
    reportPhase('imports:start');
    const [
      { WorkerTaskAgent },
      { createToolRegistry },
      { MessageBus },
      { EventEmitter },
      { DatabaseManager },
      { createLLMClient },
      { loadSettings },
      { GraphStore },
      { BlackboardGraph },
      { WorkflowManager },
      { WorkflowEngine },
      { attachTeamMailboxDatabase, getTeamMailbox },
    ] = await Promise.all([
      import('./WorkerTaskAgent.js'),
      import('../tools/index.js'),
      import('../core/MessageBus.js'),
      import('../core/EventEmitter.js'),
      import('../core/Database.js'),
      import('../llm/Client.js'),
      import('../config.js'),
      import('../core/blackboard/GraphStore.js'),
      import('../core/blackboard/BlackboardGraph.js'),
      import('../core/workflow/WorkflowManager.js'),
      import('../core/workflow/WorkflowEngine.js'),
      import('../core/TeamMailbox.js'),
    ]);

    reportPhase('imports:done');
    reportPhase('runtime:init:start');
    const config = loadSettings();

    // 初始化 Langfuse 可观测性（worker 子进程独立初始化，确保 agent LLM 调用被追踪）
    try {
      const { initLangfuse, readLangfuseConfig } = await import('../core/LangfuseIntegration.js');
      const langfuseConfig = readLangfuseConfig();
      initLangfuse(langfuseConfig);
      if (langfuseConfig.enabled) {
        agentLogger.info(`[Worker ${payload.agentName}] Langfuse initialized — traceLlm=${langfuseConfig.traceLlmCalls}, traceAgent=${langfuseConfig.traceAgentLifecycle}`);
      }
    } catch (e) {
      agentLogger.warn(`[Worker ${payload.agentName}] Langfuse init skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    const toolRegistry = createToolRegistry();
    const bus = new MessageBus();
    const emitter = new EventEmitter();
    const db = new DatabaseManager(config.paths.db_path);
    db.init();
    attachTeamMailboxDatabase(db);
    getTeamMailbox().attachEmitter(emitter);
    const workflowManager = new WorkflowManager(db, emitter);
    const workflowEngine = new WorkflowEngine({
      db,
      toolRegistry,
      eventEmitter: emitter,
      workflowManager,
    });

    // 初始化黑板图（与 Leader 共享同一 SQLite 文件，写入自动同步）
    let blackboardGraph: InstanceType<typeof BlackboardGraph> | undefined;
    try {
      const graphStore = new GraphStore(db.getDb());
      blackboardGraph = new BlackboardGraph(graphStore, emitter);
    } catch {/* swallowed: unhandled error */
      agentLogger.warn(`[Worker ${payload.agentName}] 黑板图初始化失败，跳过`);
    }
    cleanupRuntime = () => {
      db.close();
    };
    reportPhase('runtime:init:done');

    const bridgedEvents = [
      'agent:status',
      'agent:thinking',
      'agent:text',
      'agent:text_chunk',
      'agent:thinking_chunk',
      'agent:tool_call',
      'agent:tool_result',
      'agent:tool_output',
      'agent:shell_state',
      'agent:context_updated',
      'context:runtime_updated',
      'terminal:output',
      'terminal:state',
      'work_note:written',
      'work_note:requested',
      // Terminal state is authoritative only through the final `complete`/`failed`
      // IPC messages below. Bridging child terminal events lets the UI mark an
      // agent done before AgentPool has queued task_complete/task_failed for Leader.
      'agent:error',          // LLM 错误事件
      'agent:stop',           // Agent 停止事件
      'agent:llm_retry',      // LLM 重试事件
      'agent:progress',       // 进度事件
      'agent:intervention',   // 紧急消息介入事件，供 Leader abort 当前 LLM 调用
      'team:message_sent',    // team_message 从 worker 子进程回桥到主进程统一路由
    ] as const;

    const bridgeUnsubscribers = bridgedEvents.map((eventName) =>
      emitter.subscribe(eventName, (data) => {
        sendMessage({
          type: 'event',
          timestamp: Date.now(),
          payload: {
            eventName,
            data,
          },
        });
      })
    );

    cleanupRuntime = () => {
      for (const unsubscribe of bridgeUnsubscribers) {
        unsubscribe();
      }
      db.close();
    };

    const usageMap = new Map<string, { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }>();
    const tokenTracker = {
      addUsage: (agentId: string, usage: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }, modelName?: string) => {
        const current = usageMap.get(agentId) || { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0 };
        const next = {
          prompt: current.prompt + usage.prompt,
          completion: current.completion + usage.completion,
          total: current.total + usage.total,
          cache_read: (current.cache_read ?? 0) + (usage.cache_read ?? 0),
          cache_creation: (current.cache_creation ?? 0) + (usage.cache_creation ?? 0),
        };
        usageMap.set(agentId, next);
        sendMessage({
          type: 'usage',
          timestamp: Date.now(),
          payload: {
            agentId,
            modelName,
            usage,
          },
        });
      },
      getTotal: () => Array.from(usageMap.values()).reduce((sum, usage) => sum + usage.total, 0),
      loadHistory: () => {},
      getSessionTotal: () => Array.from(usageMap.values()).reduce((sum, usage) => sum + usage.total, 0),
      usageMap,
    };

    const originalBusSend = bus.send.bind(bus);
    const bridgedBusSend: typeof bus.send = ((from: string, to: string, typeOrPayload: string | unknown, maybePayload?: unknown) => {
      const type = maybePayload === undefined ? 'message' : String(typeOrPayload);
      const outgoingPayload = maybePayload === undefined ? typeOrPayload : maybePayload;

      sendMessage({
        type: 'bus_message',
        timestamp: Date.now(),
        payload: {
          from,
          to,
          type,
          payload: outgoingPayload,
        },
      });

      if (maybePayload === undefined) {
        // IPC 桥接逃逸口:子进程 bus.send 可能以任意形态调用,payload 形状运行时不可知;
        // 接收侧(parent)的 parseBusMessage 会校验 type 合法性。这里用受控 cast 桥接泛型。
        return originalBusSend(from, to, 'message', typeOrPayload as never);
      }
      return originalBusSend(from, to, String(typeOrPayload) as BusMessageType, maybePayload as never);
    }) as typeof bus.send;
    bus.send = bridgedBusSend;

    process.on('message', (message: unknown) => {
      if (!isWorkerParentMessage(message)) {
        return;
      }

      const busMessage = message.payload;
      originalBusSend(busMessage.from, busMessage.to, busMessage.type, busMessage.payload);
    });

    const llm = createLLMClient(payload.model || config.llm.agent_model || config.llm.leader_model);
    const agent = new WorkerTaskAgent({
      agentId: payload.agentId,
      name: payload.agentName,
      role: payload.roleType,
      systemPrompt: payload.systemPrompt,
      toolNames: payload.toolNames,
      skillNames: payload.skillNames,
      llmClient: llm,
      toolRegistry,
      messageBus: bus,
      tokenTracker,
      workspace: payload.workspace,
      sessionId: payload.sessionId,
      model: payload.model || 'kimi-k2.5',
      eventEmitter: emitter,
      db,
      taskId: payload.taskId,
      maxIterations: payload.maxIterations,
      maxRuntimeMinutes: payload.maxRuntimeMinutes,
      blackboardGraph,
      workflowManager,
      workflowEngine,
      ...(payload.gitIdentity ? { gitIdentity: payload.gitIdentity } : {}),
    });

    // A4: 透传契约结构化允许面(已在 WorkerPayloadBuilder 对多契约 intersect),供写工具 intersect 硬校验。
    agent.setContractAllowedScope(payload.contractAllowedScope);

    agent.setProgressCallback((progress) => {
      sendMessage({
        type: 'progress',
        timestamp: Date.now(),
        payload: progress,
      });
    });

    // 继承历史对话（respawn 复活 / 复用同名 worker 跑新任务）。
    // 不能用 addMessage 预注入：agent.run() 以 isResume=false 启动，会走 initializeMessages
    // 把 this.messages 清空，预注入的历史会丢。改为交给 BaseAgent.run 在初始化阶段 weave。
    //   - inheritFromHistoryMode === 'new_task'（默认）：历史作背景 + 追加新任务指令。
    //   - 'resume'：历史即完整基底，不再注入任务指令（追问/团队复活场景）。
    if (payload.conversationHistory && payload.conversationHistory.length > 0) {
      agent.seedInheritedHistory(
        payload.conversationHistory.map((msg) => ({
          role: msg.role as ChatMessage['role'],
          content: msg.content as ChatMessage['content'],
          tool_calls: msg.tool_calls as ChatMessage['tool_calls'],
          tool_call_id: msg.tool_call_id,
          thinking: msg.thinking as ChatMessage['thinking'],
        })),
        payload.inheritHistoryMode ?? 'new_task',
      );
    }

    reportPhase('agent:run:start');
    const rawResult = await agent.runWithConclude({
      id: payload.taskId,
      subject: payload.taskSubject,
      description: payload.leaderContextSummary
        ? `${payload.taskDescription}\n\n---\n**[背景：Leader 已完成工作的摘要]**\n${payload.leaderContextSummary}`
        : payload.taskDescription,
      context: payload.taskContext,
      working_directory: payload.workingDirectory,
      write_scope: payload.writeScope,
      agent_type: payload.agentType,
    });

    reportPhase('agent:run:done');
    // 框架自动采集的工具产物轨迹 + worker 主动声明的 attempt_completion 结构化字段，
    // 沿 complete payload 透传给 Leader，让 Leader 一眼看清"做了什么 / 改了哪些文件 / 怎么验证"。
    const result = resultSummary(rawResult);
    if (isAgentExecutionResult(rawResult) && rawResult.status !== 'completed') {
      await sendMessageAndDrain({
        type: 'failed',
        timestamp: Date.now(),
        payload: {
          error: result,
          status: rawResult.status,
          metadata: rawResult.metadata,
          outputs: rawResult.outputs,
          stats: {
            iterations: agent.getIterationCount(),
            toolCalls: agent.getToolCallCount(),
          },
          tokenUsage: usageMap.get(payload.agentId) || { total: 0, prompt: 0, completion: 0 },
        },
      });
      process.exitCode = 1;
      return;
    }

    const toolTrace = agent.getToolTrace();
    const attemptCompletion = agent.getAttemptCompletion();
    await sendMessageAndDrain({
      type: 'complete',
      timestamp: Date.now(),
      payload: {
        result,
        stats: {
          iterations: agent.getIterationCount(),
          toolCalls: agent.getToolCallCount(),
        },
        tokenUsage: usageMap.get(payload.agentId) || { total: 0, prompt: 0, completion: 0 },
        toolTrace,
        ...(attemptCompletion
          ? {
              summary: attemptCompletion.summary,
              verdict: attemptCompletion.verdict,
              artifacts: attemptCompletion.artifacts,
              verification: attemptCompletion.verification,
              evidence_refs: attemptCompletion.evidence_refs,
              contract_compliance: attemptCompletion.contract_compliance,
              next_steps: attemptCompletion.next_steps,
              blocked_by_discovery: attemptCompletion.blocked_by_discovery,
              needs_leader_coordination: attemptCompletion.needs_leader_coordination,
            }
          : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dbClosedFailure = classifyDbClosedWorkerFailure(message, gracefulShutdownInitiated);
    if (dbClosedFailure) {
      // DB-closed 错误：依据关停态闩锁确定性分类(见 WorkerDbClosedClassification.ts)。
      //   - 关停中(latch=true): 良性拆解副产物 → terminated，任务交回 Leader/recovery/force_complete。
      //   - 非关停(latch=false): 真实运行期 DB 故障 → recoverable + worker_crashed，父进程走
      //     markAgentRecovering → respawn 复活(本次修复的核心，治「agent 不恢复」)。
      //     worker:failed 已先到达并把 handle 置 recovering，worker:exit early-return；
      //     即便 worker:exit 先到也以 code!==0 走 crashed→markAgentRecovering，结果一致(幂等)。
      await sendMessageAndDrain({
        type: 'failed',
        timestamp: Date.now(),
        payload: dbClosedFailure,
      });
      if (!gracefulShutdownInitiated) {
        // 真实故障计非零退出码；关停副产物不计(沿用 terminated 路径 exit 0)。
        process.exitCode = 1;
      }
    } else {
      await sendMessageAndDrain({
        type: 'failed',
        timestamp: Date.now(),
        payload: message,
      });
      // 不再 re-throw：failed IPC 已发送给父进程，由 parent 决定恢复策略。
      // 以 exit(1) 退出让 parent 知晓非正常结束，但 failed 消息已先到达。
      process.exitCode = 1;
    }
  } finally {
    clearRuntime();
    // Flush Langfuse traces before exit — batched export may have pending spans
    try {
      const { shutdownLangfuse } = require('../core/LangfuseIntegration.js');
      await shutdownLangfuse();
    } catch {
      // non-fatal
    }
  }
}

main().then(() => {
  process.exit(process.exitCode ?? 0);
}).catch((error) => {
  // 兜底：main() 内部 catch 应已发送 failed IPC，此处仅输出诊断日志。
  console.error('[Worker] Unhandled error:', error);
  process.exit(1);
});
