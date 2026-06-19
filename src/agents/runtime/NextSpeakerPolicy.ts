import {
  type ChatMessage,
  type ToolDefinition,
} from '../../llm/types.js';
import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import { isStopFinishReason } from './CompletionTerminationPolicy.js';
import { runStructuredJudgment } from '../../core/JudgmentService.js';
import { agentLogger } from '../../core/Log.js';
import { createLlmGuard } from '../LlmGuard.js';
import { getPromptCatalog, type PromptLocale } from '../prompts/i18n/catalog.js';

/**
 * NextSpeaker 决策（2026-05-28 重构）
 *
 * Why 重构：
 *   旧实现每轮工具批 / stop 都要串联 1~3 次 LLM 判官调用
 *   （primary verdict + self-correction rejudge + persistent-signal rejudge），
 *   最坏一轮 = 4 次 LLM。这些 judge 调用与主 LLM 共享 baseUrl::model 的
 *   CircuitBreaker 与重试预算，是 Leader 比 worker 卡的主因之一。
 *
 * 改造：信任 API 端点的 finish_reason；只有 eternal 模式下 stop 后是否需要续跑交给统一 LLM judge。
 *   - finishReason 不是 stop/end_turn → model（API 没说停就继续，任何模式）
 *   - finishReason 是 stop 系列：
 *     · 非 eternal → user（完全信任 API stop 信号，不做任何本地续跑）
 *     · eternal + continuation judge 认为输出仍需接续       → model
 *     · eternal + hasOpenWork && !hasExplicitUserGate                 → model（自驱找活）
 *     · 其余                                                          → user
 *
 * 2026-05-30 用户决策：非 eternal 下"完全信任远程 API 信号，其他全不要"——
 *   manual 模式不做本地截断猜测、不因 open_work 自驱，杜绝"没开 eternal 却空转续跑"。
 *
 * rejudge*Signal 接口已删除；本模块只有一个统一入口。
 */

export type NextSpeakerDecision = 'model' | 'user';

export interface EvaluateNextSpeakerInput {
  finishReason?: string;
  content?: string;
  reasoningContent?: string;
  hasOpenWork: boolean;
  hasExplicitUserGate: boolean;
  /** 当前是否有正在运行的 Agent（已派发、在途的工作） */
  hasRunningAgents?: boolean;
  /** 是否处于 eternal（自治长跑）模式。 */
  isEternalMode?: boolean;
  messages?: ChatMessage[];
  llm?: ContentGenerator;
  model?: string;
  sessionId?: string;
  actorLabel?: string;
  locale?: PromptLocale;
}

export interface NextSpeakerVerdict {
  nextSpeaker: NextSpeakerDecision;
  reason: string;
  continuationPrompt: string;
}

/**
 * 统一的 continuation 文案。
 *
 * Why 统一：每条 continuation prompt 都会作为新的 user 消息追加到对话末尾，
 * 而 Anthropic prompt caching 会在最近的消息块上打 cache_control 断点。
 * 不同 reason 用不同文案 → 末尾文本每轮都漂移 → "最近 1 个断点"对应的
 * cache_creation 反复发生，命中率受损。文案统一为一条稳定字符串后，
 * 哪怕 reason 不同，缓存前缀仍能稳定命中（reason 仅在日志/事件中体现）。
 */
const UNIFIED_CONTINUATION_PROMPT =
  '请基于当前上下文接续未完成部分，已输出内容用承接方式处理。';

interface ContinuationVerdict {
  shouldContinue: boolean;
  reason: string;
}

function buildNextSpeakerContinuationTool(locale?: PromptLocale): ToolDefinition {
  const catalog = getPromptCatalog(locale).judges.nextSpeaker;
  return {
    type: 'function',
    function: {
      name: 'submit_next_speaker_verdict',
      description: catalog.toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          should_continue: {
            type: 'boolean',
          },
          reason: {
            type: 'string',
          },
        },
        required: ['should_continue', 'reason'],
      },
    },
  };
}

function validateContinuationVerdict(payload: unknown): ContinuationVerdict | null {
  if (!payload || typeof payload !== 'object') return null;
  const shouldContinue = 'should_continue' in payload ? payload.should_continue : undefined;
  const reason = 'reason' in payload ? payload.reason : undefined;
  if (typeof shouldContinue !== 'boolean' || typeof reason !== 'string') return null;
  return { shouldContinue, reason };
}

function buildContinuationJudgeMessages(input: EvaluateNextSpeakerInput): ChatMessage[] {
  const catalog = getPromptCatalog(input.locale).judges.nextSpeaker;
  return [
    {
      role: 'system',
      content: catalog.system,
    },
    {
      role: 'user',
      content: [
        `finish_reason: ${input.finishReason || '(none)'}`,
        `has_open_work: ${input.hasOpenWork ? 'true' : 'false'}`,
        `has_explicit_user_gate: ${input.hasExplicitUserGate ? 'true' : 'false'}`,
        `has_running_agents: ${input.hasRunningAgents ? 'true' : 'false'}`,
        '',
        '[assistant_visible_output]',
        input.content || '(empty)',
        '[/assistant_visible_output]',
        '',
        '[assistant_reasoning_output]',
        input.reasoningContent || '(empty)',
        '[/assistant_reasoning_output]',
        '',
        '[recent_messages]',
        (input.messages || []).slice(-6).map((message) => {
          const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
          return `${message.role}: ${content.slice(0, 500)}`;
        }).join('\n---\n') || '(none)',
        '[/recent_messages]',
      ].join('\n'),
    },
  ];
}

async function judgeContinuation(input: EvaluateNextSpeakerInput): Promise<ContinuationVerdict | null> {
  const result = await runStructuredJudgment({
    kind: 'next_speaker_continuation',
    llm: input.llm,
    model: input.model,
    messages: buildContinuationJudgeMessages(input),
    tool: buildNextSpeakerContinuationTool(input.locale),
    validate: validateContinuationVerdict,
    llmGuardFactory: createLlmGuard,
    logger: agentLogger,
    gatewayContext: {
      actorType: 'leader',
      actorLabel: input.actorLabel || 'NextSpeakerJudge',
      purpose: 'verify',
      sessionId: input.sessionId,
      requestedModel: input.model,
    },
  });
  return result.verdict;
}

async function decide(input: EvaluateNextSpeakerInput): Promise<NextSpeakerVerdict> {
  // API 没说停（finish_reason 不是 stop/end_turn）→ 继续。任何模式都成立：
  // 这是远程端点明确表达"输出还没完"，与本地续跑猜测无关。
  if (!isStopFinishReason(input.finishReason)) {
    return {
      nextSpeaker: 'model',
      reason: 'non_terminal_finish_reason',
      continuationPrompt: UNIFIED_CONTINUATION_PROMPT,
    };
  }

  // ── 非 eternal：完全信任远程 API 信号 ──
  // 用户明确要求：manual 模式下 stop/end_turn 一律收尾交回用户，
  // 不做任何本地续跑（不做截断猜测、不因 open_work 自驱）。
  // 是否继续完全由 Leader 自己在下一条用户消息驱动时决定，杜绝空转续跑。
  if (!input.isEternalMode) {
    return {
      nextSpeaker: 'user',
      reason: 'trust_api_stop_signal',
      continuationPrompt: '',
    };
  }

  // ── 以下仅 eternal（自治长跑）模式 ──
  const continuation = await judgeContinuation(input);
  if (continuation?.shouldContinue) {
    return {
      nextSpeaker: 'model',
      reason: continuation.reason || 'llm_incomplete_visible_response',
      continuationPrompt: UNIFIED_CONTINUATION_PROMPT,
    };
  }

  if (input.hasOpenWork && !input.hasExplicitUserGate) {
    // open_work = dispatchable 任务（尚未派发的就绪任务），running 不算。
    // 如果有 running agents 但没有真正需要 Leader 亲自派发的新工作，不应继续——
    // Leader 应等 worker 汇报，而非被反复唤醒空转。
    if (input.hasRunningAgents) {
      return {
        nextSpeaker: 'user',
        reason: 'agents_running_wait_for_completion',
        continuationPrompt: '',
      };
    }
    return {
      nextSpeaker: 'model',
      reason: 'open_work_still_exists',
      continuationPrompt: UNIFIED_CONTINUATION_PROMPT,
    };
  }

  return {
    nextSpeaker: 'user',
    reason: 'turn_complete',
    continuationPrompt: '',
  };
}

/**
 * 主入口：硬 finish_reason / user gate / running-agent 约束 + LLM 语义续跑判定。
 */
export async function evaluateNextSpeakerCandidate(input: EvaluateNextSpeakerInput): Promise<NextSpeakerVerdict> {
  return decide(input);
}
