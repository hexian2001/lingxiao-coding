/**
 * 会话级 Hook 管理
 */

import {
  FunctionHook,
  HookCallback,
  HookEvent,
} from './types.js';
import { getHookRegistry } from './registry.js';

/**
 * 会话级 Hook 管理器
 */
export class SessionHookManager {
  private sessionId: string;
  private hookIds: Set<string> = new Set();
  private registry = getHookRegistry();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * 注册一个会话级函数 Hook
   */
  registerFunction(
    event: HookEvent,
    callback: HookCallback,
    matcher = '*',
    priority = 0,
    timeout = 5000,
    errorMessage = 'Hook execution failed'
  ): string {
    const hook: FunctionHook = {
      type: 'function',
      callback,
      timeout,
      error_message: errorMessage,
    };

    const hookId = this.registry.register(
      event,
      hook,
      matcher,
      priority,
      `session:${this.sessionId}`
    );

    this.hookIds.add(hookId);
    this.registry.registerSessionHook(this.sessionId, hookId);

    return hookId;
  }

  /**
   * 注销一个 Hook
   */
  unregister(hookId: string): boolean {
    if (!this.hookIds.has(hookId)) return false;

    const result = this.registry.unregister(hookId);
    if (result) {
      this.hookIds.delete(hookId);
    }

    return result;
  }

  /**
   * 清除所有会话级 Hook
   */
  clearAll(): number {
    let count = 0;
    for (const hookId of Array.from(this.hookIds)) {
      if (this.registry.unregister(hookId)) {
        count++;
      }
    }

    this.hookIds.clear();
    return count;
  }

  /**
   * 列出会话的所有 Hook
   */
  listHooks(): Record<string, unknown>[] {
    return this.registry.listHooks(undefined, `session:${this.sessionId}`);
  }
}

// 全局会话 Hook 管理器实例
const sessionManagers: Map<string, SessionHookManager> = new Map();

/**
 * 获取会话 Hook 管理器
 */
export function getSessionHookManager(sessionId: string): SessionHookManager {
  if (!sessionManagers.has(sessionId)) {
    sessionManagers.set(sessionId, new SessionHookManager(sessionId));
  }
  return sessionManagers.get(sessionId)!;
}

/**
 * 清理会话 Hook 管理器
 */
export function clearSessionHookManager(sessionId: string): number {
  const manager = sessionManagers.get(sessionId);
  if (!manager) return 0;

  const count = manager.clearAll();
  sessionManagers.delete(sessionId);

  return count;
}

/**
 * 添加会话级函数 Hook
 */
export function addSessionFunctionHook(
  sessionId: string,
  event: HookEvent,
  callback: HookCallback,
  matcher = '*',
  options?: {
    priority?: number;
    timeout?: number;
    error_message?: string;
  }
): string {
  const manager = getSessionHookManager(sessionId);

  return manager.registerFunction(
    event,
    callback,
    matcher,
    options?.priority ?? 0,
    options?.timeout ?? 5000,
    options?.error_message ?? 'Hook execution failed'
  );
}

/**
 * 移除会话级函数 Hook
 */
export function removeSessionFunctionHook(
  sessionId: string,
  hookId: string
): boolean {
  const manager = getSessionHookManager(sessionId);
  return manager.unregister(hookId);
}

/**
 * 清除会话的所有 Hook
 */
export function clearAllSessionHooks(sessionId: string): number {
  return clearSessionHookManager(sessionId);
}