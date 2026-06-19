/**
 * Chat message transform hooks.
 *
 * Provides a pipeline that runs before messages are sent to the LLM.
 * Each hook in the pipeline receives the output of the previous hook,
 * allowing progressive filtering, modification, or augmentation of messages.
 */

import type { ChatMessage } from '../../llm/types.js';

/**
 * Input to a chat transform hook.
 */
export interface ChatTransformInput {
  messages: ChatMessage[];
  sessionId?: string;
}

/**
 * A registered chat message transform hook.
 *
 * The transform function receives the current messages array and must return
 * the (possibly modified) messages array. Hooks run as a pipeline in
 * registration order: each hook receives the output of the previous one.
 */
export interface ChatTransformHook {
  name: string;
  transform(input: ChatTransformInput): Promise<ChatMessage[]>;
}

/**
 * Runs chat transform hooks as a sequential pipeline.
 *
 * Each hook receives the messages output by the previous hook.
 * The first hook receives the original messages array.
 */
export class ChatTransformRunner {
  private hooks: ChatTransformHook[] = [];

  /**
   * Register a transform hook (appended to the end of the pipeline).
   */
  register(hook: ChatTransformHook): void {
    this.hooks.push(hook);
  }

  /**
   * Remove a transform hook by name.
   */
  unregister(name: string): boolean {
    const index = this.hooks.findIndex((h) => h.name === name);
    if (index === -1) return false;
    this.hooks.splice(index, 1);
    return true;
  }

  /**
   * Run all transform hooks in registration order as a pipeline.
   * Returns the final transformed messages array.
   */
  async run(input: ChatTransformInput): Promise<ChatMessage[]> {
    let currentMessages = input.messages;

    for (const hook of this.hooks) {
      currentMessages = await hook.transform({
        ...input,
        messages: currentMessages,
      });
    }

    return currentMessages;
  }

  /**
   * Get the count of registered hooks.
   */
  get count(): number {
    return this.hooks.length;
  }

  /**
   * Clear all registered hooks.
   */
  clear(): void {
    this.hooks = [];
  }
}
