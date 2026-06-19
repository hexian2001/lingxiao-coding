/**
 * Tool execution hooks.
 *
 * Provides before/after interception points for tool execution.
 * Plugins register hooks to modify arguments, deny execution, or transform results.
 */

/**
 * Input provided to a tool.execute.before hook handler.
 */
export interface ToolBeforeHookInput {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
}

/**
 * Output from a tool.execute.before hook handler.
 * - If `deny` is true, tool execution is blocked with the given `reason`.
 * - If `args` is provided, it replaces the tool arguments for execution.
 */
export interface ToolBeforeHookOutput {
  args?: Record<string, unknown>;
  deny?: boolean;
  reason?: string;
}

/**
 * Input provided to a tool.execute.after hook handler.
 */
export interface ToolAfterHookInput {
  toolName: string;
  args: Record<string, unknown>;
  result: { success: boolean; output: unknown; error?: string };
  sessionId: string;
}

/**
 * Output from a tool.execute.after hook handler.
 * - If `output` is provided, it replaces the tool result output.
 */
export interface ToolAfterHookOutput {
  output?: unknown;
}

/**
 * A registered before-execution hook.
 */
export interface ToolBeforeHook {
  name: string;
  handler(input: ToolBeforeHookInput): Promise<ToolBeforeHookOutput>;
}

/**
 * A registered after-execution hook.
 */
export interface ToolAfterHook {
  name: string;
  handler(input: ToolAfterHookInput): Promise<ToolAfterHookOutput>;
}

/**
 * Result of running the before-hook pipeline.
 */
export interface ToolBeforeResult {
  denied: boolean;
  reason?: string;
  args: Record<string, unknown>;
}

/**
 * Result of running the after-hook pipeline.
 */
export interface ToolAfterResult {
  output: unknown;
}

/**
 * Executes tool hooks in registration order.
 *
 * Before hooks:
 *   - Run sequentially in registration order.
 *   - Each hook can modify args (subsequent hooks see modified args).
 *   - If any hook returns deny:true, execution stops and the denial is returned.
 *
 * After hooks:
 *   - Run sequentially in registration order.
 *   - Each hook can replace the output (subsequent hooks see the replaced output).
 */
export class ToolHookRunner {
  private beforeHooks: ToolBeforeHook[] = [];
  private afterHooks: ToolAfterHook[] = [];

  /**
   * Register a before-execution hook.
   */
  registerBefore(hook: ToolBeforeHook): void {
    this.beforeHooks.push(hook);
  }

  /**
   * Register an after-execution hook.
   */
  registerAfter(hook: ToolAfterHook): void {
    this.afterHooks.push(hook);
  }

  /**
   * Remove a before-execution hook by name.
   */
  unregisterBefore(name: string): boolean {
    const index = this.beforeHooks.findIndex((h) => h.name === name);
    if (index === -1) return false;
    this.beforeHooks.splice(index, 1);
    return true;
  }

  /**
   * Remove an after-execution hook by name.
   */
  unregisterAfter(name: string): boolean {
    const index = this.afterHooks.findIndex((h) => h.name === name);
    if (index === -1) return false;
    this.afterHooks.splice(index, 1);
    return true;
  }

  /**
   * Run all before hooks in registration order.
   */
  async runBefore(input: ToolBeforeHookInput): Promise<ToolBeforeResult> {
    let currentArgs = { ...input.args };

    for (const hook of this.beforeHooks) {
      const result = await hook.handler({ ...input, args: currentArgs });
      if (result.deny) {
        return { denied: true, reason: result.reason, args: currentArgs };
      }
      if (result.args) {
        currentArgs = result.args;
      }
    }

    return { denied: false, args: currentArgs };
  }

  /**
   * Run all after hooks in registration order.
   */
  async runAfter(input: ToolAfterHookInput): Promise<ToolAfterResult> {
    let currentOutput = input.result.output;

    for (const hook of this.afterHooks) {
      const result = await hook.handler({
        ...input,
        result: { ...input.result, output: currentOutput },
      });
      if (result.output !== undefined) {
        currentOutput = result.output;
      }
    }

    return { output: currentOutput };
  }

  /**
   * Get the count of registered before hooks.
   */
  get beforeCount(): number {
    return this.beforeHooks.length;
  }

  /**
   * Get the count of registered after hooks.
   */
  get afterCount(): number {
    return this.afterHooks.length;
  }

  /**
   * Clear all registered hooks.
   */
  clear(): void {
    this.beforeHooks = [];
    this.afterHooks = [];
  }
}
