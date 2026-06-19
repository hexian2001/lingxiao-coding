/**
 * Prompt 模板系统
 * 
 * 支持双阶段执行：
 * - Execute 阶段：正常执行任务
 * - Conclude 阶段：超时后快速收尾
 */

export type PromptMode = 'execute' | 'conclude';
export type TaskType = 'bootstrap' | 'reason' | 'explore' | 'generic';

export interface PromptTemplate {
  name: string;
  mode: PromptMode;
  taskType: TaskType;
  template: string;
}

const BLACKBOARD_OUTPUT_PROTOCOL = `**黑板输出协议**：
- 已确认事实输出 \`\`\`graph_fact\`\`\` 结构化代码块，字段包含 title、content、tags、confidence、evidence
- 后续探索方向输出 \`\`\`graph_intent\`\`\` 结构化代码块，字段包含 title、content、tags、priority
- 跨 Agent 契约输出 \`\`\`graph_contract\`\`\`，设计约定输出 \`\`\`graph_design_doc\`\`\`
- 这些不是工具调用；运行时会解析结构化代码块写入黑板，并通过 Context Manifest 传递给后续 Agent`;

/**
 * Bootstrap Execute Prompt
 * 初始态任务，直接尝试解决问题
 */
export const BOOTSTRAP_EXECUTE_PROMPT: PromptTemplate = {
  name: 'bootstrap_execute',
  mode: 'execute',
  taskType: 'bootstrap',
  template: `你正在执行一个 Bootstrap 任务。

**任务目标**：
{{goal}}

**当前状态**：
- 这是初始态任务，黑板图中只有 origin 和 goal
- 你需要直接尝试解决问题，或者分解问题并输出探索意图

**执行策略**：
1. 如果问题简单，直接解决并完成任务
2. 问题复杂时，分析问题并输出 graph_intent 结构化代码块提出探索意图
3. 输出 graph_fact 结构化代码块记录你发现的事实

${BLACKBOARD_OUTPUT_PROTOCOL}

**注意事项**：
- 优先尝试直接解决问题
- 问题复杂时分解任务，并让每个 intent 指向可执行探索
- 记录所有重要发现`,
};

/**
 * Bootstrap Conclude Prompt
 * Bootstrap 任务超时后的收尾
 */
export const BOOTSTRAP_CONCLUDE_PROMPT: PromptTemplate = {
  name: 'bootstrap_conclude',
  mode: 'conclude',
  taskType: 'bootstrap',
  template: `你的 Bootstrap 任务即将超时，现在需要快速收尾。

**任务目标**：
{{goal}}

**已完成的工作**：
{{progress}}

**收尾要求**（限时 2 分钟，最多 3 轮对话）：
1. 总结已完成的工作和发现
2. 已有成果输出 graph_fact 结构化代码块记录
3. 剩余问题输出 graph_intent 结构化代码块提出后续探索意图
4. 提供清晰的任务状态说明

${BLACKBOARD_OUTPUT_PROTOCOL}

		**注意**：
		- 聚焦整理和记录现有成果
	- 为后续工作提供清晰的方向`,
};

/**
 * Reason Execute Prompt
 * 态势分析任务，无 open intent 时触发
 */
export const REASON_EXECUTE_PROMPT: PromptTemplate = {
  name: 'reason_execute',
  mode: 'execute',
  taskType: 'reason',
  template: `你正在执行一个 Reason 任务（态势分析）。

**任务目标**：
{{goal}}

**当前黑板状态**：
- Facts: {{factCount}} 个
- Hints: {{hintCount}} 个
- Open Intents: 0 个（需要你提出新的探索方向）

**执行策略**：
1. 分析当前已知的 Facts 和 Hints
2. 评估距离目标还有多远
3. 识别知识缺口和未解决的问题
4. 输出 graph_intent 结构化代码块提出新的探索意图

${BLACKBOARD_OUTPUT_PROTOCOL}

		**注意事项**：
- 这是态势分析任务，聚焦下一步探索图
	- 专注定义"下一步应该做什么"，实现细节留给后续执行任务
	- 提出的 intent 应该是具体可执行的探索方向`,
};

/**
 * Explore Execute Prompt
 * 探索任务，执行具体的 intent
 */
export const EXPLORE_EXECUTE_PROMPT: PromptTemplate = {
  name: 'explore_execute',
  mode: 'execute',
  taskType: 'explore',
  template: `你正在执行一个 Explore 任务。

**探索意图**：
{{intent}}

**任务目标**：
{{goal}}

**执行策略**：
1. 专注于完成这个具体的探索意图
2. 使用必要的工具进行探索
3. 输出 graph_fact 结构化代码块记录发现的事实
4. 发现新的问题时，输出 graph_intent 结构化代码块记录后续探索方向

${BLACKBOARD_OUTPUT_PROTOCOL}

		**注意事项**：
		- 专注于当前 intent，并把新增方向记录为后续 intent
		- 记录所有重要发现
- 遇到阻碍时，记录为后续 intent 并保留已确认事实`,
};

/**
 * Explore Conclude Prompt
 * 探索任务超时后的收尾
 */
export const EXPLORE_CONCLUDE_PROMPT: PromptTemplate = {
  name: 'explore_conclude',
  mode: 'conclude',
  taskType: 'explore',
  template: `你的 Explore 任务即将超时，现在需要快速收尾。

**探索意图**：
{{intent}}

**已完成的工作**：
{{progress}}

**收尾要求**（限时 2 分钟，最多 3 轮对话）：
1. 总结已探索的内容
2. 输出 graph_fact 结构化代码块记录已确认的发现
3. 输出 graph_intent 结构化代码块记录未完成的探索或遇到的问题
4. 提供清晰的探索结果说明

${BLACKBOARD_OUTPUT_PROTOCOL}

		**注意**：
		- 聚焦整理和记录现有发现
	- 即使探索未完成，也要记录有价值的信息`,
};

/**
 * Generic Execute Prompt
 * 通用任务的默认 Prompt
 */
export const GENERIC_EXECUTE_PROMPT: PromptTemplate = {
  name: 'generic_execute',
  mode: 'execute',
  taskType: 'generic',
  template: `你正在执行一个任务。

**任务描述**：
{{description}}

**执行策略**：
1. 理解任务要求
2. 使用必要的工具完成任务
3. 记录重要发现和结果

**注意事项**：
- 专注于完成任务
- 记录所有重要信息`,
};

/**
 * Generic Conclude Prompt
 * 通用任务超时后的收尾
 */
export const GENERIC_CONCLUDE_PROMPT: PromptTemplate = {
  name: 'generic_conclude',
  mode: 'conclude',
  taskType: 'generic',
  template: `你的任务即将超时，现在需要快速收尾。

**任务描述**：
{{description}}

**已完成的工作**：
{{progress}}

**收尾要求**（限时 2 分钟，最多 3 轮对话）：
1. 总结已完成的工作
2. 记录已有的成果
3. 说明剩余工作
4. 提供清晰的任务状态

	**注意**：
	- 聚焦整理现有成果`,
};

/**
 * 所有 Prompt 模板的集合
 */
export const ALL_PROMPTS: PromptTemplate[] = [
  BOOTSTRAP_EXECUTE_PROMPT,
  BOOTSTRAP_CONCLUDE_PROMPT,
  REASON_EXECUTE_PROMPT,
  EXPLORE_EXECUTE_PROMPT,
  EXPLORE_CONCLUDE_PROMPT,
  GENERIC_EXECUTE_PROMPT,
  GENERIC_CONCLUDE_PROMPT,
];

/**
 * 根据任务类型和模式获取 Prompt 模板
 */
export function getPromptTemplate(taskType: TaskType, mode: PromptMode): PromptTemplate | undefined {
  return ALL_PROMPTS.find(p => p.taskType === taskType && p.mode === mode);
}
