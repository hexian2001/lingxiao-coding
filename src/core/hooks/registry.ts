/**
 * Hook 注册表
 */

import { randomUUID } from 'crypto';
import {
  FunctionHook,
  HookCallback,
  HookCommand,
  HookDefinition,
  HookEvent,
  HookMatcher,
  RegisteredHook,
} from './types.js';

/**
 * Hook 注册表
 */
export class HookRegistry {
  private hooks: Map<HookEvent, RegisteredHook[]> = new Map();
  private byId: Map<string, RegisteredHook> = new Map();
  private sessionHooks: Map<string, Set<string>> = new Map();
  private disabled: Set<string> = new Set();

  constructor() {
    // 初始化每个事件类型的空数组
    for (const event of Object.values(HookEvent)) {
      this.hooks.set(event, []);
    }
  }

  /**
   * 注册一个 Hook
   */
  register(
    event: HookEvent,
    hook: HookDefinition,
    matcher = '*',
    priority = 0,
    source = 'user',
    hookId?: string
  ): string {
    const id = hookId || `hook-${event}-${randomUUID().slice(0, 8)}`;

    const registered: RegisteredHook = {
      matcher: { event, matcher },
      hook,
      priority,
      enabled: true,
      source,
    };

    this.byId.set(id, registered);

    const hooksList = this.hooks.get(event) || [];
    hooksList.push(registered);
    hooksList.sort((a, b) => b.priority - a.priority);
    this.hooks.set(event, hooksList);

    return id;
  }

  /**
   * 注册一个函数 Hook
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
    return this.register(event, hook, matcher, priority, 'function');
  }

  /**
   * 注册一个命令 Hook
   */
  registerCommand(
    event: HookEvent,
    command: string,
    matcher = '*',
    priority = 0,
    timeout = 30000,
    env: Record<string, string> = {}
  ): string {
    const hook: HookCommand = {
      type: 'command',
      command,
      timeout,
      env,
    };
    return this.register(event, hook, matcher, priority, 'command');
  }

  /**
   * 注销一个 Hook
   */
  unregister(hookId: string): boolean {
    const registered = this.byId.get(hookId);
    if (!registered) return false;

    const event = registered.matcher.event;
    const hooksList = this.hooks.get(event) || [];
    const index = hooksList.indexOf(registered);
    if (index > -1) {
      hooksList.splice(index, 1);
    }

    this.byId.delete(hookId);

    // 从会话索引移除
    for (const sessionHooks of this.sessionHooks.values()) {
      sessionHooks.delete(hookId);
    }

    return true;
  }

  /**
   * 启用 Hook
   */
  enable(hookId: string): boolean {
    const registered = this.byId.get(hookId);
    if (registered) {
      registered.enabled = true;
      this.disabled.delete(hookId);
      return true;
    }
    return false;
  }

  /**
   * 禁用 Hook
   */
  disable(hookId: string): boolean {
    const registered = this.byId.get(hookId);
    if (registered) {
      registered.enabled = false;
      this.disabled.add(hookId);
      return true;
    }
    return false;
  }

  /**
   * 获取匹配特定事件和工具的 Hook 列表
   */
  getHooksForEvent(event: HookEvent, toolName?: string): RegisteredHook[] {
    const hooks = this.hooks.get(event) || [];

    return hooks.filter(h => {
      if (!h.enabled) return false;

      if (toolName !== undefined) {
        return this.matchTool(h.matcher.matcher, toolName);
      }

      return true;
    });
  }

  /**
   * 检查工具名是否匹配模式
   */
  private matchTool(pattern: string, toolName: string): boolean {
    if (pattern === '*') return true;

    // 多工具匹配
    if (pattern.includes(',')) {
      const patterns = pattern.split(',').map(p => p.trim());
      return patterns.some(p => this.matchTool(p, toolName));
    }

    // 参数前缀匹配: Tool(arg:*)
    if (pattern.includes('(')) {
      const base = pattern.split('(')[0];
      return toolName === base;
    }

    // 精确匹配
    return toolName === pattern;
  }

  /**
   * 将 Hook 标记为会话级
   */
  registerSessionHook(sessionId: string, hookId: string): void {
    if (!this.sessionHooks.has(sessionId)) {
      this.sessionHooks.set(sessionId, new Set());
    }
    this.sessionHooks.get(sessionId)!.add(hookId);
  }

  /**
   * 清理会话的所有 Hook
   */
  clearSessionHooks(sessionId: string): number {
    const hookIds = this.sessionHooks.get(sessionId);
    if (!hookIds) return 0;

    let count = 0;
    for (const hookId of hookIds) {
      if (this.unregister(hookId)) {
        count++;
      }
    }

    this.sessionHooks.delete(sessionId);
    return count;
  }

  /**
   * 清空所有 Hook
   */
  clearAll(): number {
    const count = this.byId.size;
    for (const event of Object.values(HookEvent)) {
      this.hooks.set(event, []);
    }
    this.byId.clear();
    this.sessionHooks.clear();
    this.disabled.clear();
    return count;
  }

  /**
   * 列出 Hook
   */
  listHooks(event?: HookEvent, source?: string): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    const events = event ? [event] : Object.values(HookEvent);

    for (const ev of events) {
      const hooks = this.hooks.get(ev) || [];
      for (const h of hooks) {
        if (source && h.source !== source) continue;

        const hookInfo: Record<string, unknown> = {
          event: ev,
          matcher: h.matcher.matcher,
          priority: h.priority,
          enabled: h.enabled,
          source: h.source,
          type: h.hook.type,
        };

        if (h.hook.type === 'function') {
          hookInfo.has_callback = true;
          hookInfo.timeout = h.hook.timeout;
        } else if (h.hook.type === 'command') {
          hookInfo.command = h.hook.command;
          hookInfo.timeout = h.hook.timeout;
        }

        result.push(hookInfo);
      }
    }

    return result;
  }
}

// 全局注册表实例
let globalRegistry: HookRegistry | null = null;

/**
 * 获取全局 Hook 注册表
 */
export function getHookRegistry(): HookRegistry {
  if (!globalRegistry) {
    globalRegistry = new HookRegistry();
  }
  return globalRegistry;
}

/**
 * 重置全局 Hook 注册表
 */
export function resetHookRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clearAll();
  }
  globalRegistry = null;
}