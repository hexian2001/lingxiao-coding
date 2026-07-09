/**
 * Tool metadata 运行时入口。
 * 真源在 contracts/types/ToolMetadata.ts（下层，无反向依赖）。
 * 本文件仅 re-export，避免 tools/ 与 contracts/ 双份漂移。
 */
export * from '../contracts/types/ToolMetadata.js';
