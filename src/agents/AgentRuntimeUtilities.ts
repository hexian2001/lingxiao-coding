import { thinkingBlocksToText, type ChatMessage, type ChatResponse } from '../llm/types.js';
import { estimateTokens } from '../llm/token_counter.js';
import type { AgentTask } from '../types/canonical.js';
import type { ToolResultContent } from './runtime/ToolResponseProcessor.js';

const CENTER_PRESERVED_TOOL_RESULTS = new Set<string>(['file_read', 'code_search']);
const TAIL_PRESERVED_TOOL_RESULTS = new Set<string>(['shell', 'python_exec']);

export interface AgentTokenUsageTracker {
  addUsage(
    agentId: string,
    usage: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number },
    modelName?: string,
  ): void;
}

export function truncateAgentToolResult(
  toolName: string,
  result: ToolResultContent,
  maxChars: number,
): ToolResultContent {
  if (Array.isArray(result)) {
    return result;
  }
  if (result.length <= maxChars) {
    return result;
  }

  if (CENTER_PRESERVED_TOOL_RESULTS.has(toolName)) {
    const head = result.slice(0, maxChars / 2);
    const tail = result.slice(-(maxChars / 2));
    return `${head}\n\n... [中间 ${result.length - maxChars} 字符已省略] ...\n\n${tail}`;
  }

  if (TAIL_PRESERVED_TOOL_RESULTS.has(toolName)) {
    return `[输出过长，仅保留最后 ${maxChars} 字符]\n...${result.slice(-maxChars)}`;
  }

  if (toolName === 'list_dir') {
    const lines = result.split('\n');
    if (lines.length > 50) {
      return [
        ...lines.slice(0, 25),
        `\n... [${lines.length - 50} 行已省略] ...\n`,
        ...lines.slice(-25),
      ].join('\n');
    }
  }

  const head = result.slice(0, (maxChars * 2) / 3);
  const tail = result.slice(-(maxChars / 3));
  return `${head}\n\n... [${result.length - maxChars} 字符已截断] ...\n\n${tail}`;
}

export function recordAgentTokenUsage(
  response: ChatResponse,
  tracker: AgentTokenUsageTracker,
  agentId: string,
  model: string,
): void {
  const hasRealUsage = response.usage && response.usage.total_tokens > 0;
  if (hasRealUsage) {
    tracker.addUsage(agentId, {
      prompt: response.usage!.prompt_tokens,
      completion: response.usage!.completion_tokens,
      total: response.usage!.total_tokens,
      cache_read: response.usage!.cache_read_input_tokens,
      cache_creation: response.usage!.cache_creation_input_tokens,
    }, model);
    return;
  }

  let completionTokens = estimateTokens(response.content ?? '') + estimateTokens(thinkingBlocksToText(response.thinking));
  if (response.tool_calls) {
    for (const toolCall of response.tool_calls) {
      completionTokens += estimateTokens(toolCall.function?.arguments ?? '');
    }
  }
  if (completionTokens > 0) {
    tracker.addUsage(agentId, {
      prompt: 0,
      completion: completionTokens,
      total: completionTokens,
    }, model);
  }
}

export function inferAgentGatewayPurpose(
  task: AgentTask,
  role: string,
): 'coding' | 'review' | 'research' | 'verify' | 'agent' {
  const tokens = tokenizeAgentPurposeLabels(task.agent_type, role);
  if (hasAgentPurposeToken(tokens, RESEARCH_PURPOSE_TOKENS)) return 'research';
  if (hasAgentPurposeToken(tokens, VERIFY_PURPOSE_TOKENS)) return 'verify';
  if (hasAgentPurposeToken(tokens, REVIEW_PURPOSE_TOKENS)) return 'review';
  if (hasAgentPurposeToken(tokens, CODING_PURPOSE_TOKENS)) return 'coding';
  return 'agent';
}

const NEGATED_PURPOSE_TOKENS = new Set(['not', 'non', 'no']);
const RESEARCH_PURPOSE_TOKENS = new Set(['research', 'researcher', 'analyst']);
const VERIFY_PURPOSE_TOKENS = new Set(['verify', 'verifier', 'qa', 'test', 'testing', 'tester']);
const REVIEW_PURPOSE_TOKENS = new Set(['review', 'reviewer', 'evaluator']);
const CODING_PURPOSE_TOKENS = new Set(['coding', 'coder', 'code', 'frontend', 'backend', 'fullstack', 'developer']);

function tokenizeAgentPurposeLabels(...labels: Array<string | undefined>): string[] {
  const tokens: string[] = [];
  for (const label of labels) {
    if (!label) continue;
    for (const token of label.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

function hasAgentPurposeToken(tokens: string[], purposeTokens: ReadonlySet<string>): boolean {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!purposeTokens.has(token)) continue;
    if (index > 0 && NEGATED_PURPOSE_TOKENS.has(tokens[index - 1])) continue;
    return true;
  }
  return false;
}

export function summarizeAgentProgress(
  iteration: number,
  toolCallCount: number,
  messages: ChatMessage[],
): string {
  const lines = [`已执行 ${iteration} 轮对话`, `已调用 ${toolCallCount} 次工具`];
  const recentTools = messages
    .filter((message) => message.role === 'tool')
    .slice(-5)
    .map((message) => {
      const toolName = (message as { tool_name?: unknown }).tool_name;
      return `- ${typeof toolName === 'string' ? toolName : 'unknown'}`;
    });

  if (recentTools.length > 0) {
    lines.push('\n最近的工具调用:');
    lines.push(...recentTools);
  }

  return lines.join('\n');
}

export function renderAgentPromptTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

export function detectAgentPhase(task: AgentTask, fallbackRole: string): 'research' | 'coding' | 'testing' | 'reviewing' | 'other' {
  const tokens = tokenizeAgentPurposeLabels(task.agent_type, fallbackRole);
  if (hasAgentPurposeToken(tokens, RESEARCH_PURPOSE_TOKENS)) return 'research';
  if (hasAgentPurposeToken(tokens, CODING_PURPOSE_TOKENS)) return 'coding';
  if (hasAgentPurposeToken(tokens, VERIFY_PURPOSE_TOKENS)) return 'testing';
  if (hasAgentPurposeToken(tokens, REVIEW_PURPOSE_TOKENS)) return 'reviewing';
  return 'other';
}

export function extractAgentArtifactsFromMessages(messages: ChatMessage[]): string[] {
  const files = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const pathMatches = content.match(/(?:^|\s)(\/[\w\-./]+\.\w+)/gm);
    if (!pathMatches) continue;
    for (const path of pathMatches) {
      const trimmed = path.trim();
      if (trimmed.length > 5 && trimmed.length < 200) {
        files.add(trimmed);
      }
    }
  }
  return [...files].slice(0, 20);
}
