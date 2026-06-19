/**
 * EternalPatrolJudge — Eternal Mode patrol 入口前的轻量判官
 *
 * 设计动机：
 *   EternalLoop.tick 默认会按指数退避节奏向 LLM 注入"自主研发"prompt，
 *   但当项目指纹（任务板/黑板/scratchpad）完全没变时，LLM 找不到工作就回纯文本"挑一个"，
 *   持续烧 token。Judge 在 patrol prompt 注入之前判断三种动作：
 *
 *     - patrol     : 项目状态有可深挖增量，照常跑 patrol
 *     - skip       : 增量与上轮巡检重叠/属噪音，本轮不调 LLM；fingerprint 锁住下一轮
 *     - yield_user : 所有任务终态、上轮 idle、增量全是噪音 → 把控制权还给用户
 *
 * 与 NextSpeakerPolicy 的区别：
 *   NextSpeakerPolicy 是"LLM 已开口后是否继续"；
 *   EternalPatrolJudge 是"是否要让 LLM 开口"。两者前后衔接，互不重叠。
 */

import {
  type ChatMessage,
  type ToolDefinition,
} from '../../llm/types.js';
import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import { agentLogger } from '../../core/Log.js';
import { runStructuredJudgment } from '../../core/JudgmentService.js';
import { createLlmGuard } from '../LlmGuard.js';
import { getPromptCatalog, type PromptLocale } from '../prompts/i18n/catalog.js';
import {
  decideEternalActionFromRuntimeState,
  type EternalPatrolJudgeInput,
  type EternalPatrolVerdict,
} from '../../contracts/adapters/EternalPatrolPolicy.js';

export {
  decideEternalActionFromRuntimeState,
  type EternalAction,
  type EternalPatrolJudgeInput,
  type EternalPatrolVerdict,
} from '../../contracts/adapters/EternalPatrolPolicy.js';

function buildEternalVerdictTool(locale?: PromptLocale): ToolDefinition {
  const catalog = getPromptCatalog(locale).judges.eternalPatrol;
  return {
    type: 'function',
    function: {
      name: 'submit_eternal_verdict',
      description: catalog.toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['patrol', 'skip', 'yield_user'],
            description: catalog.actionDescription,
          },
          reason: {
            type: 'string',
            description: catalog.reasonDescription,
          },
        },
        required: ['action', 'reason'],
      },
    },
  };
}

function buildJudgeMessages(input: EternalPatrolJudgeInput & { locale?: PromptLocale }): ChatMessage[] {
  const catalog = getPromptCatalog(input.locale).judges.eternalPatrol;
  const goal = typeof input.eternalGoal === 'string' && input.eternalGoal.trim()
    ? input.eternalGoal.trim()
    : '(none)';
  const lines = [
    `eternal_goal: ${goal}`,
    `fingerprint_changed: ${input.fingerprintChanged ? 'true' : 'false'}`,
    `fingerprint_diff: ${input.fingerprintDiff || '(none)'}`,
    `last_patrol_outcome: ${input.lastPatrolOutcome}`,
    `consecutive_idle_patrols: ${input.consecutiveIdlePatrols}`,
    `has_open_work: ${input.hasOpenWork}`,
    `has_running_agents: ${input.hasRunningAgents}`,
    '',
    '[recent_conversation]',
    input.recentConversationDigest || '(none)',
    '[/recent_conversation]',
  ];

  return [
    {
      role: 'system',
      content: catalog.system,
    },
    {
      role: 'user',
      content: lines.join('\n'),
    },
  ];
}

function validateEternalVerdict(parsed: unknown): EternalPatrolVerdict | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const action = 'action' in parsed ? (parsed as { action?: unknown }).action : undefined;
  const reason = 'reason' in parsed ? (parsed as { reason?: unknown }).reason : undefined;
  if (action !== 'patrol' && action !== 'skip' && action !== 'yield_user') return null;
  if (typeof reason !== 'string') return null;
  return { action, reason };
}

export async function judgeEternalAction(input: EternalPatrolJudgeInput & { locale?: PromptLocale }): Promise<EternalPatrolVerdict> {
  if (!input.llm || !input.model) {
    return decideEternalActionFromRuntimeState(input);
  }

  const result = await runStructuredJudgment({
    kind: 'eternal_patrol',
    llm: input.llm as ContentGenerator,
    model: input.model,
    messages: buildJudgeMessages(input),
    tool: buildEternalVerdictTool(input.locale),
    validate: validateEternalVerdict,
    llmGuardFactory: createLlmGuard,
    logger: agentLogger,
    gatewayContext: {
      actorType: 'leader',
      actorLabel: 'Leader-EternalJudge',
      purpose: 'verify',
      requestedModel: input.model,
    },
  });
  if (result.verdict) {
    return result.verdict;
  }
  return decideEternalActionFromRuntimeState(input);
}
