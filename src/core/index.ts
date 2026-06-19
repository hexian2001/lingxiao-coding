// 核心模块精简入口 — 仅导出被外部消费的符号
export { DatabaseManager } from './Database.js';
export { createEventEmitter, getEventEmitter } from './EventEmitter.js';
export { cleanupRegistry, registerCleanup, runAllCleanups } from './CleanupRegistry.js';
export { gracefulShutdown, isGracefulShuttingDown } from './RuntimeGuards.js';
export { createMessageBus, getMessageBus } from './MessageBus.js';
export { coreLogger, sessionLogger } from './Log.js';

// 共享常量枚举 — 替代魔数字符串
export { TaskStatus, MessageRole, ToolName, Channel, ExecutionMode } from './constants.js';

// Eternal / 无人值守运行时
export { EternalSupervisor } from './EternalSupervisor.js';
export { EternalLoop } from './EternalLoop.js';
export { AlertManager, alertManager, StdoutAlertChannel, LogFileAlertChannel, WebhookAlertChannel } from './AlertManager.js';
