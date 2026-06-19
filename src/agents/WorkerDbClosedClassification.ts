/**
 * Worker 主 catch 块捕获的 "Database has been closed" 类错误的确定性分类。
 *
 * 单一事实源：既是判定「哪些消息算 DB-closed 类」的正则，也是「该判 terminated 还是
 * recoverable」的决策函数。抽成纯函数是为了脱离 WorkerProcessEntry 的顶层副作用
 * （sendMessage / setInterval / registerSignalHandlers）直接单测。
 *
 * 背景 / 旧实现的缺陷：
 *   旧实现仅靠字符串匹配就把 "Database has been closed" 一律判定为「关停拆解副产物」
 *   (terminalKind:'terminated')。但字符串本身无法区分「真在关停」与「运行期 DB 异常断开」
 *   ——后者会被误判成良性终止，agent 不恢复、任务卡 interrupted 成孤儿，无人 respawn。
 *
 *   Worker 的 DatabaseManager.close() 只在退出路径调用（gracefulShutdown 收到信号 /
 *   fatal uncaughtException / main finally）。因此在主 try 块执行期间出现 DB-closed，
 *   要么源自 gracefulShutdown（良性拆解副产物），要么是运行期连接异常断开（真实故障）。
 *   二者的唯一确定性判据是「gracefulShutdown 是否已被进入」——一个真实关停态闩锁，
 *   而非对错误字符串的启发式猜测。
 *
 *   判据刻意收窄到 ensureConnection() 抛出的这两条消息：SQLITE_BUSY / requires sessionId
 *   等属于可恢复瞬态（别处已有限重试），不应被这里误判为终止或复活。
 */

const DB_CLOSED_PATTERN = /Database has been closed|Database reconnection failed/i;

/** worker `failed` IPC 的 metadata 面（与父进程 parseWorkerFailurePayload 消费的字段对齐）。 */
export interface WorkerFailedMetadata {
  /** true → 父进程 worker:failed 处理器走 markAgentRecovering → respawn。 */
  recoverable?: boolean;
  /** 'terminated' → 良性终止不恢复；'recovering' → 暗示 recoverable。 */
  terminalKind: 'terminated' | 'recovering';
  /** recoverable 路径下的故障类，须是父进程 classifyAutonomousFault 认得的 worker_* 值。 */
  faultClass?: string;
  statusReason: string;
}

/** worker `failed` IPC 的结构化 payload（type:'failed' 的 payload 字段）。 */
export interface WorkerFailedIPCPayload {
  error: string;
  metadata: WorkerFailedMetadata;
}

/**
 * 依据真实关停态闩锁确定性分类 DB-closed 错误。
 *
 * @param message worker 主 catch 捕获的错误消息。
 * @param gracefulShutdownInitiated worker 是否已收到关停信号并进入 gracefulShutdown
 *        （即 db.close() 的合法调用源）。必须在 db.close() 之前置位。
 * @returns DB-closed 类错误返回对应 failed IPC payload；非 DB-closed 错误返回 null，
 *          由调用方走通用失败分支（裸串 failed + exit(1)）。
 *
 *   - latch=true : 关停拆解副产物 → terminalKind:'terminated'（良性，任务交回 Leader/recovery）
 *   - latch=false: 无关停信号却 DB 断了 → 真实运行期故障 → recoverable + worker_crashed，
 *                  交父进程 markAgentRecovering → respawn 复活（修复「不恢复」的核心）。
 */
export function classifyDbClosedWorkerFailure(
  message: string,
  gracefulShutdownInitiated: boolean,
): WorkerFailedIPCPayload | null {
  if (!DB_CLOSED_PATTERN.test(message)) {
    return null;
  }
  if (gracefulShutdownInitiated) {
    return {
      error: message,
      metadata: {
        terminalKind: 'terminated',
        statusReason: 'worker shutdown: database closed',
      },
    };
  }
  return {
    error: message,
    metadata: {
      recoverable: true,
      terminalKind: 'recovering',
      faultClass: 'worker_crashed',
      statusReason: 'worker db connection lost (no graceful shutdown in progress)',
    },
  };
}
