/**
 * Hook 生命周期系统
 */

// 执行器导出
export {
  HookExecutor,
  executeHooks,
  executeStop,
  executePreCompact,
  executePostCompact,
} from './executor.js';

// 注册表导出
export {
  HookRegistry,
  getHookRegistry,
  resetHookRegistry,
} from './registry.js';

// 会话级 Hook 导出
export {
  SessionHookManager,
  addSessionFunctionHook,
  clearAllSessionHooks,
  getSessionHookManager,
  removeSessionFunctionHook,
} from './session_hooks.js';

// 类型导出（type-only，TypeScript 接口在编译后不生成运行时导出）
export type {
  AggregatedHookResult,
  FunctionHook,
  HookCallback,
  HookCommand,
  HookDefinition,
  HookInput,
  HookMatcher,
  HookOutput,
  HookResult,
  RegisteredHook,
} from './types.js';

// 运行时导出
export {
  HOOK_EVENTS,
  HookEvent,
  createHookInput,
  createHookOutput,
} from './types.js';