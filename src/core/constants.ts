/**
 * 共享字符串常量 — 消除魔数字符串
 *
 * 新增代码请使用这些枚举/常量替代硬编码字符串。
 */

// ── Task & Agent Status ──
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
  WAITING: 'waiting',
  SUSPENDED: 'suspended',
  ACTIVE: 'active',
  KILLED: 'killed',
  IDLE: 'idle',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// ── Chat Message Roles ──
export const MessageRole = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

// ── Tool Names (commonly referenced as strings) ──
export const ToolName = {
  FILE_READ: 'file_read',
  FILE_CREATE: 'file_create',
  STRUCTURED_PATCH: 'structured_patch',
  LIST_DIR: 'list_dir',
  GLOB: 'glob',
  CODE_SEARCH: 'code_search',
  SHELL: 'shell',
  GIT: 'git',
  WEB_FETCH: 'web_fetch',
  WEB_SEARCH: 'web_search',
  MEMORY: 'memory',
  TASK_COMPLETE: 'task_complete',
  SEND_MESSAGE: 'send_message',
  DELEGATE: 'delegate',
  SCREENSHOT: 'screenshot',
  OCR: 'ocr',
  TERMINAL_CONTROL: 'terminal_control',
  GET_TERMINAL_OUTPUT: 'get_terminal_output',
  HTTP_REQUEST: 'http_request',
  PYTHON_EXEC: 'python_exec',

  SESSION_ARTIFACTS: 'session_artifacts',
  PARSE_FILE: 'parse_file',
  WRITE_WORK_NOTE: 'write_work_note',
  READ_WORK_NOTES: 'read_work_notes',
  REQUEST_WORK_NOTE: 'request_work_note',
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

// ── Bus / Event Channel Names ──
export const Channel = {
  LEADER_STATUS: 'leader:status',
  AGENT_STATUS: 'agent:status',
  TASK_UPDATE: 'task:update',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

// ── Execution Modes ──
export const ExecutionMode = {
  DELEGATE: 'delegate',
  DIRECT: 'direct',
  PROBE: 'probe',
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];
