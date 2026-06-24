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
// 共享账本（替代 BlackboardGraph）
export { SharedLedger } from './SharedLedger.js';
export type { LedgerEntry, LedgerEntryType, LedgerQuery, LedgerSnapshot } from './SharedLedger.js';


// 0→1 交付引擎
export { buildExpansion, renderExpansionHint } from './SpecFirstPipeline.js';
export type { PipelineExpansion, PipelineNode } from './SpecFirstPipeline.js';
export { ContractHotSync } from './ContractHotSync.js';
export type { ContractDelta, ContractConsumer } from './ContractHotSync.js';
export { IntegrationVerifyInjector } from './IntegrationVerifyInjector.js';
export type { VerifyInjection, VerifyScenario } from './IntegrationVerifyInjector.js';
export { DeterministicAcceptance } from './DeterministicAcceptance.js';
export type { AcceptanceCheck, AcceptanceSuite } from './DeterministicAcceptance.js';
export { RepairStrategyEngine } from './RepairStrategyEngine.js';
export type { ErrorClassification, RepairDecision, RepairStrategy } from './RepairStrategyEngine.js';
