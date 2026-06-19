/**
 * 工具名 → 流式阶段人类友好文案映射
 *
 * 对齐 CodeBuddy 的 AgentPhaseUtils.getLabel()：
 * model_streaming + streamingToolName → "writing file" / "editing" 等动作化描述。
 * 让用户在 LLM 生成工具参数期间就能直观了解正在做什么，
 * 而非只看到 "正在生成 Write 参数"。
 */

const TOOL_PHASE_LABELS: Record<string, string> = {
  Write: 'writing file',
  Edit: 'editing',
  NotebookEdit: 'editing notebook',
  Read: 'reading file',
  Bash: 'running command',
  PowerShell: 'running command',
  Grep: 'searching content',
  Glob: 'searching files',
  WebFetch: 'fetching web',
  WebSearch: 'searching web',
  Agent: 'spawning agent',
  Skill: 'running skill',
  AskUserQuestion: 'asking question',
  EnterPlanMode: 'planning',
  ExitPlanMode: 'finalizing plan',
  TaskCreate: 'creating task',
  TaskUpdate: 'updating task',
  SendMessage: 'sending message',
  file_read: 'reading file',
  file_edit: 'editing',
  file_multi_edit: 'editing',
  file_patch: 'editing',
  structured_patch: 'editing',
  file_create: 'writing file',
  code_search: 'searching content',
  web_fetch: 'fetching web',
  web_search: 'searching web',
  shell: 'running command',
  python_exec: 'running python',
  workflow: 'running workflow',
  blackboard: 'updating graph',
  office_ops: 'working on office file',
  team_message: 'sending message',
  team_manage: 'managing team',
  team_inbox: 'checking inbox',
};

/**
 * 将工具名映射为用户可读的动作描述。
 *
 * @param toolName - 工具原始名称（如 "Write"、"Edit"）
 * @returns 人类友好的动作短语（如 "writing file"、"editing"）
 */
export function getToolPhaseLabel(toolName: string | null | undefined): string {
  if (!toolName) return 'generating';
  return TOOL_PHASE_LABELS[toolName] || `running ${toolName}`;
}
