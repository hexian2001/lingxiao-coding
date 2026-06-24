import { config as runtimeConfig } from '../config.js';
import { contentToPlainText, type ChatMessage } from '../llm/types.js';
import { CONTRACT_PACK_MARKER } from '../core/ContractPack.js';
import {
  stripOldImageParts,
  compactOldToolResults,
} from './messageMemoryBudget.js';

export interface AgentContextControllerDeps {
  maxMessages?: number;
}

/** 受保护前缀长度（永不因 ring-buffer 截断而丢失的开头消息条数）。
 *  此前错误地派生自 max_agent_messages（缓冲上限，默认 300）——与"前缀保护"无关的两个旋钮，
 *  维护者无法定位 3 从何而来。改为独立命名常量。 */
const PROTECTED_PREFIX_MESSAGES = 3;

export class AgentContextController {
  private readonly maxMessages: number;

  constructor(deps: AgentContextControllerDeps = {}) {
    this.maxMessages = Math.max(1, deps.maxMessages ?? runtimeConfig.agents.max_agent_messages);
  }

  addMessage(msg: ChatMessage, messages: ChatMessage[]): ChatMessage[] {
    const nextMessage = msg.timestamp ? msg : { ...msg, timestamp: Date.now() / 1000 };
    const next = [...messages, nextMessage];
    const protectedCount = Math.max(1, Math.min(PROTECTED_PREFIX_MESSAGES, this.maxMessages));
    return this.trimMessageBuffer(next, protectedCount, this.maxMessages);
  }

  collapseContractPacks(messages: ChatMessage[]): ChatMessage[] {
    let lastContractPackIndex = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (this.isRuntimeContractPackMessage(messages[i])) {
        lastContractPackIndex = i;
      }
    }
    if (lastContractPackIndex < 0) {
      return messages;
    }
    return messages.filter((msg, index) => !this.isRuntimeContractPackMessage(msg) || index === lastContractPackIndex);
  }

  isRuntimeContractPackMessage(msg: ChatMessage): boolean {
    return msg.role === 'system' && contentToPlainText(msg.content).trim().startsWith(CONTRACT_PACK_MARKER);
  }

  trimMessageBuffer(messages: ChatMessage[], protectedCount: number, _maxMessages = this.maxMessages): ChatMessage[] {
    // 1. 剥离旧图片 base64
    let trimmed = stripOldImageParts(messages, {
      retainImageMessages: runtimeConfig.advanced.image_history_retain_rounds,
      protectedCount,
    });

    // 2. 压缩旧 tool results
    trimmed = compactOldToolResults(trimmed, {
      retainRecentTurns: runtimeConfig.advanced.tool_result_retain_rounds,
      protectedCount,
    });

    return trimmed;
  }
}

export default AgentContextController;
