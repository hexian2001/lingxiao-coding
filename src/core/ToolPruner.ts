/**
 * ToolPruner — 工具描述裁剪器
 *
 * 解决问题：工具描述冗长（策略写进 description），总 token 开销 ~9,200。
 *
 * 策略：
 * 1. 按模式做硬过滤 — bughunt/office/blackboard 由运行态决定
 * 2. 预算内保留角色允许的工具集合
 * 3. 超预算时默认按确定性优先级裁剪；只有显式开启 semanticSelection 才让 LLM 选择工具
 */

import type { ContentGenerator } from '../llm/ContentGenerator.js';
import { contentToPlainText, type ChatMessage, type ToolDefinition } from '../llm/types.js';
import { countTokens } from '../llm/token_counter.js';
import { BUGHUNT_MODE_TOOL_NAMES, OFFICE_TOOL_NAMES } from '../contracts/constants/toolNames.js';
import { runStructuredJudgment } from './JudgmentService.js';
import { coreLogger } from './Log.js';
import { getPromptCatalog, type PromptLocale } from '../agents/prompts/i18n/catalog.js';

// ─── Pruning ────────────────────────────────────────────────────────────────

export type ExecutionMode = 'normal' | 'bughunt' | 'blackboard' | 'office';
export type ToolModeFilter = (tools: ToolDefinition[], mode: ExecutionMode) => ToolDefinition[];

export const REQUIRED_AGENT_CONTRACT_TOOLS = [
  'attempt_completion',
  'write_work_note',
  'read_work_notes',
  'send_message',
] as const;

export const REQUIRED_TEAM_CONTRACT_TOOLS = [
  'team_inbox',
  'team_message',
] as const;

const NEGATED_ROLE_TOKENS = new Set(['not', 'non', 'no']);

export interface ToolSelectionTaskContext {
  id?: string;
  subject?: string;
  description?: string;
  context?: string;
  working_directory?: string;
  write_scope?: string[];
}

export interface ToolSelectionContext {
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
  mode: ExecutionMode;
  task?: ToolSelectionTaskContext;
  recentMessages?: ChatMessage[];
}

interface ToolSelectionVerdict {
  selectedToolNames: string[];
  reason: string;
}

const BLACKBOARD_TOOL_NAMES: ReadonlySet<string> = new Set(['blackboard']);

function defaultToolModeFilter(tools: ToolDefinition[], mode: ExecutionMode): ToolDefinition[] {
  const bughuntNames = new Set<string>(BUGHUNT_MODE_TOOL_NAMES);
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (bughuntNames.has(name) && mode !== 'bughunt') return false;
    if (BLACKBOARD_TOOL_NAMES.has(name) && mode !== 'blackboard') return false;
    return true;
  });
}

export function buildToolSelectionTool(locale?: PromptLocale): ToolDefinition {
  const catalog = getPromptCatalog(locale).judges.toolSelection;
  return {
    type: 'function',
    function: {
      name: 'submit_tool_selection',
      description: catalog.toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_tool_names: {
            type: 'array',
            items: { type: 'string' },
            description: catalog.selectedToolNamesDescription,
          },
          reason: {
            type: 'string',
          },
        },
        required: ['selected_tool_names', 'reason'],
      },
    },
  };
}

function summarizeTool(tool: ToolDefinition): string {
  const parameterShape = tool.function.parameters as { properties?: Record<string, unknown> } | undefined;
  const parameterNames = Object.keys(parameterShape?.properties || {});
  return [
    `name: ${tool.function.name}`,
    `description: ${tool.function.description.slice(0, 500)}`,
    `parameters: ${parameterNames.join(', ') || '(none)'}`,
  ].join('\n');
}

function renderRecentMessages(messages: ChatMessage[] | undefined): string {
  if (!messages || messages.length === 0) return '(none)';
  return messages.slice(-6).map((message) => {
    const content = contentToPlainText(message.content);
    return `${message.role}: ${content.slice(0, 400)}`;
  }).join('\n---\n');
}

export function buildToolSelectionMessages(
  tools: ToolDefinition[],
  context: ToolSelectionContext,
  tokenBudget: number,
  locale?: PromptLocale,
): ChatMessage[] {
  const task = context.task;
  return [
    {
      role: 'system',
      content: getPromptCatalog(locale).judges.toolSelection.system,
    },
    {
      role: 'user',
      content: [
        `agent: ${context.agentName || '(unknown)'}`,
        `role: ${context.role || '(unknown)'}`,
        `mode: ${context.mode}`,
        `tool_token_budget: ${tokenBudget}`,
        `task_id: ${task?.id || '(none)'}`,
        `task_subject: ${task?.subject || '(none)'}`,
        `task_description: ${task?.description || '(none)'}`,
        `task_context: ${task?.context || '(none)'}`,
        `working_directory: ${task?.working_directory || '(none)'}`,
        `write_scope: ${(task?.write_scope || []).join(', ') || '(none)'}`,
        '',
        '[recent_messages]',
        renderRecentMessages(context.recentMessages),
        '[/recent_messages]',
        '',
        '[available_tools]',
        tools.map(summarizeTool).join('\n---\n'),
        '[/available_tools]',
      ].join('\n'),
    },
  ];
}

function validateToolSelectionVerdict(payload: unknown): ToolSelectionVerdict | null {
  if (!payload || typeof payload !== 'object') return null;
  const selectedToolNames = 'selected_tool_names' in payload ? payload.selected_tool_names : undefined;
  const reason = 'reason' in payload ? payload.reason : undefined;
  if (!Array.isArray(selectedToolNames) || typeof reason !== 'string') return null;
  return {
    selectedToolNames: selectedToolNames.filter((name): name is string => typeof name === 'string'),
    reason,
  };
}

/**
 * 按执行模式过滤工具。
 *
 * - normal: 移除 bughunt 工具
 * - bughunt: 保留 bughunt 工具
 * - blackboard: 保留黑板工具
 */
export function filterToolsByMode(
  tools: ToolDefinition[],
  mode: ExecutionMode,
  filter: ToolModeFilter = defaultToolModeFilter,
): ToolDefinition[] {
  let filtered = filter(tools, mode);
  if (mode !== 'office') {
    const officeNames: ReadonlySet<string> = new Set(OFFICE_TOOL_NAMES);
    filtered = filtered.filter((tool) => !officeNames.has(tool.function.name));
  }
  return filtered;
}

/** 按 token 预算执行硬裁剪。输入顺序即保留优先级。 */
export function pruneToolsByBudget(
  tools: ToolDefinition[],
  tokenBudget: number,
  requiredToolNames: readonly string[] = [],
): { pruned: ToolDefinition[]; removed: string[] } {
  const kept: ToolDefinition[] = [];
  const removed: string[] = [];
  const required = new Set(requiredToolNames);
  let currentTokens = 0;

  for (const tool of tools) {
    const toolTokens = countTokens(JSON.stringify(tool));
    if (required.has(tool.function.name) || currentTokens + toolTokens <= tokenBudget) {
      kept.push(tool);
      currentTokens += toolTokens;
    } else {
      removed.push(tool.function.name);
    }
  }

  return { pruned: kept, removed };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ToolPrunerResult {
  tools: ToolDefinition[];
  originalCount: number;
  finalCount: number;
  removedTools: string[];
  originalTokens: number;
  finalTokens: number;
  selectionStatus: 'all_within_budget' | 'deterministic_pruned' | 'llm_selected' | 'judge_unavailable' | 'judge_invalid';
  selectionReason?: string;
}

/**
 * 完整的工具裁剪流程：硬模式过滤 → 可选 LLM 选择（仅显式开启且超预算时）→ 硬预算裁剪。
 */
export async function pruneTools(
  tools: ToolDefinition[],
  options: {
    mode: ExecutionMode;
    tokenBudget: number;
    llm?: ContentGenerator;
    model?: string;
    semanticSelection?: boolean;
    context?: Omit<ToolSelectionContext, 'mode'>;
    toolModeFilter?: ToolModeFilter;
    locale?: PromptLocale;
  },
): Promise<ToolPrunerResult> {
  const { mode, tokenBudget } = options;
  const originalTokens = countTokens(JSON.stringify(tools));
  const originalCount = tools.length;
  const requiredToolNames = requiredToolNamesForContext(tools, options.context);

  const filtered = filterToolsByMode(tools, mode, options.toolModeFilter);
  const filteredTokens = countTokens(JSON.stringify(filtered));
  if (filteredTokens <= tokenBudget) {
    return {
      tools: filtered,
      originalCount,
      finalCount: filtered.length,
      removedTools: tools.filter((tool) => !filtered.some((kept) => kept.function.name === tool.function.name)).map((tool) => tool.function.name),
      originalTokens,
      finalTokens: filteredTokens,
      selectionStatus: 'all_within_budget',
    };
  }

  const byName = new Map(filtered.map((tool) => [tool.function.name, tool]));
  const semanticSelectionEnabled = options.semanticSelection === true && Boolean(options.llm && options.model);
  const result = semanticSelectionEnabled
    ? await runStructuredJudgment({
        kind: 'tool_selection',
        llm: options.llm,
        model: options.model,
        messages: buildToolSelectionMessages(filtered, { ...options.context, mode }, tokenBudget, options.locale),
        tool: buildToolSelectionTool(options.locale),
        validate: validateToolSelectionVerdict,
        logger: coreLogger,
        gatewayContext: {
          actorType: 'agent',
          actorLabel: options.context?.agentName || 'ToolPruner',
          purpose: 'verify',
          sessionId: options.context?.sessionId,
          agentId: options.context?.agentId,
          agentName: options.context?.agentName,
          taskId: options.context?.task?.id,
          role: options.context?.role,
          requestedModel: options.model,
        },
      })
    : { verdict: null, status: 'unavailable' as const };

  const selectedNames = result.verdict?.selectedToolNames ?? [];
  const seen = new Set<string>();
  const selectedTools = withRequiredTools(
    selectedNames
    .map((name) => byName.get(name))
    .filter((tool): tool is ToolDefinition => {
      if (!tool || seen.has(tool.function.name)) return false;
      seen.add(tool.function.name);
      return true;
    }),
    filtered,
    requiredToolNames,
  );

  const candidateTools = result.verdict ? selectedTools : filtered;
  const { pruned } = pruneToolsByBudget(candidateTools, tokenBudget, requiredToolNames);

  const finalTokens = countTokens(JSON.stringify(pruned));
  const finalNames = new Set(pruned.map((tool) => tool.function.name));

  return {
    tools: pruned,
    originalCount,
    finalCount: pruned.length,
    removedTools: tools.filter((tool) => !finalNames.has(tool.function.name)).map((tool) => tool.function.name),
    originalTokens,
    finalTokens,
    selectionStatus: result.verdict
      ? 'llm_selected'
      : !semanticSelectionEnabled
        ? 'deterministic_pruned'
        : result.status === 'unavailable'
          ? 'judge_unavailable'
        : 'judge_invalid',
    selectionReason: result.verdict?.reason,
  };
}

function requiredToolNamesForContext(
  tools: ToolDefinition[],
  context?: Omit<ToolSelectionContext, 'mode'>,
): string[] {
  const available = new Set(tools.map((tool) => tool.function.name));
  const required = [...REQUIRED_AGENT_CONTRACT_TOOLS].filter((name) => available.has(name)) as string[];
  const teamCapable = REQUIRED_TEAM_CONTRACT_TOOLS.some((name) => available.has(name));
  if (teamCapable && !isLeaderRoleLabel(context?.role)) {
    required.push(...[...REQUIRED_TEAM_CONTRACT_TOOLS].filter((name) => available.has(name)));
  }
  if (available.has('memory') && contextRequiresMemoryTool(context)) {
    required.push('memory');
  }
  if (available.has('design_asset') && contextRequiresDesignAssetTool(context)) {
    required.push('design_asset');
  }
  return Array.from(new Set(required));
}

function isLeaderRoleLabel(role: string | undefined): boolean {
  if (!role) return false;
  const tokens = role.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== 'leader') continue;
    if (index > 0 && NEGATED_ROLE_TOKENS.has(tokens[index - 1])) continue;
    return true;
  }
  return false;
}

function contextRequiresMemoryTool(context?: Omit<ToolSelectionContext, 'mode'>): boolean {
  if (!context) return false;
  const task = context.task;
  const chunks = [
    task?.subject,
    task?.description,
    task?.context,
    ...(context.recentMessages || []).slice(-8).map((message) => contentToPlainText(message.content)),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const joined = chunks.join('\n');
  return /Persistent Memory Index|memory_items=|memory\s*\(\s*action\s*=\s*["']?load/i.test(joined);
}

function contextRequiresDesignAssetTool(context?: Omit<ToolSelectionContext, 'mode'>): boolean {
  if (!context) return false;
  // 结构化判定：仅当角色标签是设计/前端类角色时才必留 design_asset 工具。
  // 不再扫描任务/消息正文关键词（'page'/'style'/'layout'/'css' 等普通词汇会误触发，
  // 后端 agent 讨论"页面路由"也会被强制留 design_asset）——那是被禁的启发式。
  const role = (context.role || '').toLowerCase();
  return /\b(frontend|ux[_-]?designer|ui|visual|designer)\b/.test(role);
}

function withRequiredTools(
  selectedTools: ToolDefinition[],
  availableTools: ToolDefinition[],
  requiredToolNames: readonly string[],
): ToolDefinition[] {
  if (requiredToolNames.length === 0) return selectedTools;
  const selected = new Map(selectedTools.map((tool) => [tool.function.name, tool]));
  const required = new Set(requiredToolNames);
  for (const tool of availableTools) {
    if (required.has(tool.function.name) && !selected.has(tool.function.name)) {
      selected.set(tool.function.name, tool);
    }
  }
  return Array.from(selected.values());
}
