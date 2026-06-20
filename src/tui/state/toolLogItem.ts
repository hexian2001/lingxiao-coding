import type { CommandLogMessage } from '../../commands/types.js';
import { extractToolDiff } from './toolDiff.js';
import { t } from '../../i18n.js';

function isPayloadRecord(payload: unknown): payload is Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return t('tui.tool.unserializable');
  }
}

// ── 参数值格式化 ──

/** 格式化单个参数值，截断到 maxLen */
function formatParamValue(value: unknown, maxLen: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    const valueLines = value.split('\n');
    if (valueLines.length > 1) {
      const firstLine = valueLines[0];
      const truncated = firstLine.length > maxLen - 12
        ? firstLine.slice(0, maxLen - 15) + '…'
        : firstLine;
      return `"${truncated}" (+${valueLines.length - 1}行)`;
    }
    const truncated = value.length > maxLen ? value.slice(0, maxLen - 1) + '…' : value;
    return `"${truncated}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
      const preview = value.slice(0, 3).map(v => `"${v}"`).join(', ');
      const extra = value.length > 3 ? `, +${value.length - 3}` : '';
      return `[${preview}${extra}]`;
    }
    return `[${value.length} 项]`;
  }
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  } catch {
    return '[?]';
  }
}

/** 将 input 的所有 key-value 格式化为展示行（用于展开视图） */
function formatToolParams(input: unknown, maxValLen: number): string[] {
  if (!isPayloadRecord(input)) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    lines.push(`${key}: ${formatParamValue(value, maxValLen)}`);
  }
  return lines;
}

/** 生成简短的 key=value 摘要（用于头行 fallback，最多 3 对） */
function shortParamSummary(input: unknown): string {
  if (!isPayloadRecord(input)) return '';
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  return entries.slice(0, 3)
    .map(([k, v]) => `${k}=${formatParamValue(v, 30)}`)
    .join(', ');
}

// ── 工具调用摘要 ──

export function summarizeToolCall(toolName: string, input: unknown): {
  summary: string;
  meta: string;
  preview: string;
} {
  const raw = stringifyPayload(input);
  const args = isPayloadRecord(input) ? input : undefined;

  if (!args) {
    return { summary: t('tui.tool.summary.calling', toolName), meta: '', preview: raw };
  }

  // ── 文件操作 ──
  if (toolName === 'file_read') {
    const path = stringField(args, 'path') || '';
    const startLine = numberField(args, 'start_line') || 1;
    const endLine = numberField(args, 'end_line');
    const lineInfo = endLine ? `:${startLine}-${endLine}` : (startLine > 1 ? `:${startLine}+` : '');
    return { summary: t('tui.tool.summary.reading', path, lineInfo), meta: path || toolName, preview: raw };
  }
  if (toolName === 'file_create') {
    const path = stringField(args, 'path') || '';
    return { summary: t('tui.tool.summary.creating', path), meta: path || toolName, preview: raw };
  }
  if (toolName === 'file_write' || toolName === 'file_edit') {
    // 兼容旧工具名
    const path = stringField(args, 'path') || '';
    return { summary: t('tui.tool.summary.creating', path), meta: path || toolName, preview: raw };
  }
  if (toolName === 'structured_patch') {
    const path = stringField(args, 'path') || '';
    const hunks = Array.isArray(args.hunks) ? args.hunks.length : 0;
    return { summary: t('tui.tool.summary.patching', path, hunks), meta: path || toolName, preview: raw };
  }
  if (toolName === 'list_dir' || toolName === 'list_directory') {
    const path = stringField(args, 'path') || '.';
    return { summary: t('tui.tool.summary.listing', path), meta: path, preview: raw };
  }
  if (toolName === 'glob') {
    const pattern = stringField(args, 'pattern') || '';
    const path = stringField(args, 'path') || '';
    return { summary: t('tui.tool.summary.globbing', pattern), meta: path || toolName, preview: raw };
  }

  // ── 搜索 ──
  if (toolName === 'code_search') {
    const pattern = stringField(args, 'pattern') || '';
    const path = stringField(args, 'path') || '';
    const filePattern = stringField(args, 'file_pattern') || '';
    const detail = [pattern, path && `in ${path}`, filePattern && `(${filePattern})`].filter(Boolean).join(' ');
    return { summary: t('tui.tool.summary.searching_code', detail), meta: filePattern || '', preview: raw };
  }
  if (toolName === 'ast_query') {
    const action = stringField(args, 'action') || '';
    const symbol = stringField(args, 'symbol') || stringField(args, 'name_pattern') || '';
    return { summary: `AST ${action}${symbol ? ` ${symbol}` : ''}`, meta: '', preview: raw };
  }
  if (toolName === 'web_fetch') {
    const url = stringField(args, 'url') || '';
    return { summary: t('tui.tool.summary.fetching', url), meta: url || toolName, preview: raw };
  }
  if (toolName === 'web_search') {
    const query = stringField(args, 'query') || '';
    return { summary: t('tui.tool.summary.searching', query), meta: query || toolName, preview: raw };
  }

  // ── 执行 ──
  if (toolName === 'shell') {
    const command = stringField(args, 'command') || '';
    const cwd = stringField(args, 'cwd') || '';
    const cmdPreview = command.length > 80 ? `${command.slice(0, 80)}…` : command;
    return { summary: t('tui.tool.summary.running', cmdPreview), meta: cwd || toolName, preview: raw };
  }
  if (toolName === 'python_exec') {
    const code = stringField(args, 'code') || '';
    const firstLine = code.split('\n')[0];
    const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
    return { summary: t('tui.tool.summary.python', preview), meta: '', preview: raw };
  }
  if (toolName === 'http_request') {
    const method = (stringField(args, 'method') || 'GET').toUpperCase();
    const url = stringField(args, 'url') || '';
    return { summary: t('tui.tool.summary.http', method, url), meta: url || toolName, preview: raw };
  }
  if (toolName === 'node_repl') {
    const code = stringField(args, 'code') || '';
    const firstLine = code.split('\n')[0];
    const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
    return { summary: `REPL: ${preview}`, meta: '', preview: raw };
  }

  // ── 浏览器 ──
  if (toolName === 'browser_action') {
    const action = stringField(args, 'action') || '';
    const selector = stringField(args, 'selector') || '';
    const url = stringField(args, 'url') || '';
    const target = url || selector;
    return { summary: t('tui.tool.summary.browser', action, target), meta: target || '', preview: raw };
  }
  if (toolName === 'browser_visual_verify') {
    const url = stringField(args, 'url') || '';
    return { summary: t('tui.tool.summary.browser_verify', url), meta: url || toolName, preview: raw };
  }
  if (toolName === 'screenshot') {
    const url = stringField(args, 'url') || '';
    return { summary: t('tui.tool.summary.screenshot', url), meta: url || toolName, preview: raw };
  }
  if (toolName === 'ocr') {
    const image = stringField(args, 'image') || '';
    const preview = image.length > 50 ? image.slice(0, 50) + '…' : image;
    return { summary: `OCR: ${preview}`, meta: '', preview: raw };
  }
  if (toolName === 'visual_contact_sheet') {
    return { summary: '生成拼接图', meta: '', preview: raw };
  }

  // ── Git ──
  if (toolName === 'git') {
    const action = stringField(args, 'action') || '';
    return { summary: t('tui.tool.summary.git', action), meta: '', preview: raw };
  }

  // ── 任务 / Agent 管理 ──
  if (toolName === 'create_task') {
    const subject = stringField(args, 'subject') || '';
    const preview = subject.length > 60 ? subject.slice(0, 60) + '…' : subject;
    return { summary: t('tui.tool.summary.creating_task', preview), meta: '', preview: raw };
  }
  if (toolName === 'update_task') {
    const taskId = stringField(args, 'task_id') || '';
    return { summary: t('tui.tool.summary.updating_task', taskId), meta: taskId, preview: raw };
  }
  if (toolName === 'update_task_status') {
    const taskId = stringField(args, 'task_id') || '';
    const status = stringField(args, 'status') || '';
    return { summary: t('tui.tool.summary.updating_status', taskId, status), meta: taskId, preview: raw };
  }
  if (toolName === 'delete_task') {
    const taskId = stringField(args, 'task_id') || '';
    return { summary: `删除任务 ${taskId}`, meta: taskId, preview: raw };
  }
  if (toolName === 'dispatch_agent') {
    const taskId = stringField(args, 'task_id') || '';
    const agentName = stringField(args, 'agent_name') || '';
    return { summary: t('tui.tool.summary.dispatching', taskId, agentName), meta: agentName, preview: raw };
  }
  if (toolName === 'dispatch_batch') {
    const dispatches = Array.isArray(args.dispatches) ? args.dispatches.length : 0;
    return { summary: `批量派发 (${dispatches} 个任务)`, meta: '', preview: raw };
  }
  if (toolName === 'explore') {
    const goal = stringField(args, 'goal') || '';
    const preview = goal.length > 60 ? goal.slice(0, 60) + '…' : goal;
    return { summary: t('tui.tool.summary.exploring', preview), meta: '', preview: raw };
  }
  if (toolName === 'force_complete_task') {
    const taskId = stringField(args, 'task_id') || '';
    return { summary: `强制完成 ${taskId}`, meta: taskId, preview: raw };
  }

  // ── Agent 操作（通用模式：agent_name 是关键参数） ──
  const agentOpTools = new Set([
    'check_agent_progress', 'nudge_agent', 'pause_agent', 'resume_agent',
    'terminate_agent', 'compact_agent_context', 'retry_agent_llm',
    'intervene_agent', 'confirm_intervention',
    'send_message_to_agent', 'request_work_note',
  ]);
  if (agentOpTools.has(toolName)) {
    const agentName = stringField(args, 'agent_name') || stringField(args, 'agentId') || '';
    const opLabel = toolName.replace(/_/g, ' ');
    return { summary: t('tui.tool.summary.agent_op', opLabel, agentName), meta: agentName, preview: raw };
  }

  // ── 通信 ──
  if (toolName === 'send_message') {
    const recipient = stringField(args, 'recipient') || '';
    return { summary: t('tui.tool.summary.messaging', recipient), meta: recipient, preview: raw };
  }
  if (toolName === 'write_work_note') {
    const summary = stringField(args, 'summary') || '';
    const preview = summary.length > 50 ? summary.slice(0, 50) + '…' : summary;
    return { summary: t('tui.tool.summary.writing_note', preview), meta: '', preview: raw };
  }
  if (toolName === 'read_work_notes') {
    return { summary: '读取工作笔记', meta: '', preview: raw };
  }

  // ── 规划 ──
  const planTools = new Set(['plan_create', 'plan_update', 'plan_checkpoint', 'plan_finalize']);
  if (planTools.has(toolName)) {
    const goal = stringField(args, 'goal') || stringField(args, 'summary') || '';
    const preview = goal.length > 50 ? goal.slice(0, 50) + '…' : goal;
    return { summary: t('tui.tool.summary.plan', toolName.replace(/_/g, ' '), preview), meta: '', preview: raw };
  }
  if (toolName === 'submit_plan') {
    const goal = stringField(args, 'goal') || '';
    const preview = goal.length > 50 ? goal.slice(0, 50) + '…' : goal;
    return { summary: `提交方案: ${preview}`, meta: '', preview: raw };
  }

  // ── 记忆 ──
  const memoryTools = new Set(['memory', 'memory_read', 'memory_write', 'learn_soul']);
  if (memoryTools.has(toolName)) {
    const action = stringField(args, 'action') || '';
    return { summary: t('tui.tool.summary.memory_op', action), meta: '', preview: raw };
  }

  // ── 会话 / 其他 ──
  if (toolName === 'ask_user') {
    const question = stringField(args, 'question') || '';
    const questions = Array.isArray(args.questions) ? args.questions : undefined;
    const qText = question || (questions && questions.length > 0 ? `${questions.length} 个问题` : '');
    const preview = qText.length > 50 ? qText.slice(0, 50) + '…' : qText;
    return { summary: t('tui.tool.summary.asking', preview), meta: '', preview: raw };
  }
  if (toolName === 'finish_session') {
    const summary = stringField(args, 'summary') || '';
    const preview = summary.length > 50 ? summary.slice(0, 50) + '…' : summary;
    return { summary: t('tui.tool.summary.finish', preview), meta: '', preview: raw };
  }
  if (toolName === 'complete_eternal_goal') {
    const summary = stringField(args, 'summary') || '';
    const preview = summary.length > 50 ? summary.slice(0, 50) + '…' : summary;
    return { summary: `完成目标: ${preview}`, meta: '', preview: raw };
  }
  if (toolName === 'create_download_link') {
    const path = stringField(args, 'path') || '';
    return { summary: t('tui.tool.summary.download_link', path), meta: path, preview: raw };
  }
  if (toolName === 'define_agent_role') {
    const roleName = stringField(args, 'role_name') || '';
    return { summary: t('tui.tool.summary.defining_role', roleName), meta: roleName, preview: raw };
  }
  if (toolName === 'list_available_roles') {
    return { summary: '列出可用角色', meta: '', preview: raw };
  }
  if (toolName === 'declare_assumption') {
    const title = stringField(args, 'title') || '';
    return { summary: `声明假设: ${title}`, meta: '', preview: raw };
  }
  if (toolName === 'request_permission_update') {
    const mode = stringField(args, 'mode') || '';
    return { summary: `请求权限: ${mode}`, meta: mode, preview: raw };
  }
  if (toolName === 'parallel_read_batch') {
    const ops = Array.isArray(args.operations) ? args.operations.length : 0;
    return { summary: `并行读取 (${ops} 个操作)`, meta: '', preview: raw };
  }
  if (toolName === 'session_artifacts') {
    const action = stringField(args, 'action') || '';
    return { summary: `会话产物: ${action}`, meta: '', preview: raw };
  }
  if (toolName === 'tool_preflight') {
    const tool = stringField(args, 'tool') || '';
    return { summary: `预检工具: ${tool}`, meta: tool, preview: raw };
  }
  if (toolName === 'find_tools') {
    const query = stringField(args, 'query') || '';
    return { summary: `查找工具${query ? `: ${query}` : ''}`, meta: '', preview: raw };
  }
  if (toolName === 'mcp') {
    const action = stringField(args, 'action') || '';
    return { summary: `MCP: ${action}`, meta: '', preview: raw };
  }

  // ── 通用 fallback：显示 key=value 对 ──
  const paramSummary = shortParamSummary(args);
  return {
    summary: paramSummary || t('tui.tool.summary.calling', toolName),
    meta: '',
    preview: raw,
  };
}

// ── 工具结果摘要 ──

export function summarizeToolResult(toolName: string, result: unknown): {
  summary: string;
  meta: string;
  preview: string;
} {
  const raw = stringifyPayload(result).trim();

  if (toolName === 'file_read') {
    const lineNumbers = raw.match(/^\s*(\d+)→/gm);
    if (lineNumbers && lineNumbers.length > 0) {
      const firstLine = parseInt(lineNumbers[0].match(/\d+/)?.[0] || '1', 10);
      const lastLine = parseInt(lineNumbers[lineNumbers.length - 1].match(/\d+/)?.[0] || '1', 10);
      const totalRead = lineNumbers.length;
      const lineRange = firstLine === lastLine ? t('tui.tool.result.line_single', firstLine) : t('tui.tool.result.line_range', firstLine, lastLine);
      return { summary: t('tui.tool.result.read_lines', lineRange, totalRead), meta: toolName, preview: raw };
    }
    const charCount = raw.length;
    return { summary: charCount > 0 ? t('tui.tool.result.read_chars', charCount) : t('tui.tool.result.no_output'), meta: '', preview: raw };
  }
  if (toolName === 'list_dir' || toolName === 'list_directory') {
    const entries = raw.split('\n').filter(Boolean);
    const fileCount = entries.filter((entry) => !entry.endsWith('/')).length;
    const dirCount = entries.filter((entry) => entry.endsWith('/')).length;
    return {
      summary: t('tui.tool.result.listed', entries.length, fileCount, dirCount),
      meta: '',
      preview: raw,
    };
  }
  if (toolName === 'web_fetch') {
    const charCount = raw.length;
    return { summary: t('tui.tool.result.fetched', charCount), meta: '', preview: raw };
  }
  if (toolName === 'web_search') {
    const resultCount = (raw.match(/"title"/g) || []).length || (raw.match(/\d+\./g) || []).length;
    return { summary: t('tui.tool.result.searched', resultCount), meta: '', preview: raw };
  }
  if (toolName === 'file_create' || toolName === 'file_write' || toolName === 'file_edit') {
    const path = raw.length > 0 ? t('tui.tool.result.created') : t('tui.tool.result.no_output');
    return { summary: path, meta: '', preview: raw };
  }
  if (toolName === 'structured_patch') {
    const added = (raw.match(/^\+[^+]/gm) || []).length;
    const removed = (raw.match(/^-[^-]/gm) || []).length;
    return { summary: t('tui.tool.result.patched', added, removed), meta: '', preview: raw };
  }
  if (toolName === 'code_search') {
    const matchCount = (raw.match(/^\//gm) || []).length;
    return { summary: t('tui.tool.result.searched_code', matchCount), meta: '', preview: raw };
  }
  if (toolName === 'glob') {
    const fileCount = raw.split('\n').filter(Boolean).length;
    return { summary: `匹配到 ${fileCount} 个文件`, meta: '', preview: raw };
  }
  if (toolName === 'git') {
    return { summary: t('tui.tool.result.git'), meta: '', preview: raw };
  }
  if (toolName === 'dispatch_agent' || toolName === 'dispatch_batch') {
    return { summary: t('tui.tool.result.dispatched'), meta: '', preview: raw };
  }
  if (toolName === 'browser_action' || toolName === 'browser_visual_verify' || toolName === 'screenshot') {
    return { summary: t('tui.tool.result.browser'), meta: '', preview: raw };
  }
  if (toolName === 'shell' || toolName === 'python_exec' || toolName === 'node_repl') {
    const lineCount = raw.split('\n').filter(Boolean).length;
    return { summary: t('tui.tool.result.executed', lineCount), meta: '', preview: raw };
  }
  if (toolName === 'http_request') {
    const statusMatch = raw.match(/"status"[:\s]*(\d+)/);
    const status = statusMatch ? statusMatch[1] : '';
    return { summary: t('tui.tool.result.http', status || raw.length), meta: '', preview: raw };
  }
  if (toolName === 'create_task' || toolName === 'update_task' || toolName === 'update_task_status' || toolName === 'delete_task') {
    return { summary: t('tui.tool.result.task_done'), meta: '', preview: raw };
  }
  if (toolName === 'explore') {
    return { summary: '探索已启动', meta: '', preview: raw };
  }

  // 通用结果：显示字符数
  const charCount = raw.length;
  return { summary: charCount > 0 ? t('tui.tool.result.generic', charCount) : t('tui.tool.result.no_output'), meta: '', preview: raw };
}

// ── 构建 LogMessage ──

export function buildToolCallLogMessage(toolName: string, input: unknown): CommandLogMessage {
  const info = summarizeToolCall(toolName, input);
  const toolDiff = toolName === 'structured_patch' && isPayloadRecord(input)
    ? extractToolDiff(toolName, input)
    : undefined;
  // 生成展开视图的参数行
  const paramLines = formatToolParams(input, 120);
  return {
    type: 'tool',
    content: t('tui.tool.call', toolName, info.preview),
    toolName,
    toolKind: 'call',
    toolSummary: info.summary,
    toolMeta: info.meta,
    toolDiff,
    toolStartedAt: Date.now(),
    toolInput: paramLines.length > 0 ? paramLines.join('\n') : undefined,
  };
}

export function buildToolResultLogMessage(toolName: string, result: unknown): CommandLogMessage {
  const info = summarizeToolResult(toolName, result);
  // 生成展开视图的结果预览（截断到合理长度）
  const raw = typeof result === 'string' ? result : stringifyPayload(result);
  const outputPreview = raw.length > 500 ? raw.slice(0, 500) + `\n… (+${raw.length - 500} 字符)` : raw;
  return {
    type: 'tool',
    content: t('tui.tool.result', toolName, info.preview),
    toolName,
    toolKind: 'result',
    toolSummary: info.summary,
    toolMeta: info.meta,
    toolOutput: outputPreview || undefined,
  };
}
