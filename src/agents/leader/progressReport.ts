/**
 * Leader progress report builder
 *
 * 纯函数：根据 (handle, logs) 列表生成 Leader 监督使用的进度报告文本。
 */

export interface ProgressAgentLogLite {
  event_type: string;
  content: string | null;
}

export interface ProgressAgentHandleLite {
  name: string;
  roleType: string;
  startTime: number;
}

export interface ProgressAgentReportInput {
  handle: ProgressAgentHandleLite;
  logs: ProgressAgentLogLite[];
  /** 当前时间戳，便于测试注入 */
  now?: number;
  /** 工具条目上限 */
  toolCallLimit?: number;
  /** 触发提前中断扫描的最近工具数阈值 */
  diagnosticThreshold?: number;
}

const TEXT_PROGRESS_EVENT_TYPES = new Set<string>(['agent_text', 'agent_response', 'tool_result']);

/**
 * 针对单个 agent 的进度片段
 */
export function buildAgentProgressSection(input: ProgressAgentReportInput): string {
  const {
    handle,
    logs,
    now = Date.now(),
    toolCallLimit = 5,
    diagnosticThreshold = 5,
  } = input;

  const toolCalls: string[] = [];
  let lastText = '';

  for (const log of [...logs].reverse()) {
    if (log.event_type === 'tool_call_start' && toolCalls.length < toolCallLimit) {
      try {
        const parsed = JSON.parse(log.content ?? '');
        const name = (parsed && typeof parsed === 'object' ? (parsed as { name?: unknown }).name : undefined);
        toolCalls.push(typeof name === 'string' ? name : String(log.content ?? '').slice(0, 50));
      } catch {/* swallowed: unhandled error */
        toolCalls.push(String(log.content ?? '').slice(0, 50));
      }
    }

    if (!lastText && TEXT_PROGRESS_EVENT_TYPES.has(log.event_type)) {
      try {
        const parsed = JSON.parse(log.content ?? '');
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          lastText = String(
            rec.result_preview ?? rec.content ?? rec.message ?? '',
          );
        } else {
          lastText = String(parsed ?? '');
        }
      } catch {/* swallowed: unhandled error */
        lastText = String(log.content ?? '');
      }
    }

    if (toolCalls.length >= diagnosticThreshold && lastText) {
      break;
    }
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - handle.startTime) / 1000));
  const elapsed = `${Math.floor(elapsedSeconds / 60)}m${String(elapsedSeconds % 60).padStart(2, '0')}s`;
  const lines = [
    `Agent @${handle.name} (${handle.roleType}) 已运行 ${elapsed}`,
    toolCalls.length > 0 ? `最近工具: ${toolCalls.join(', ')}` : '最近工具: 暂无',
    lastText ? `最近输出: ${lastText.slice(0, 500)}` : '最近输出: 暂无',
  ];

  return lines.join('\n');
}

/**
 * 汇总多个 agent 的进度为完整报告
 */
export function buildProgressReport(
  sections: ProgressAgentReportInput[],
): string {
  return sections.map(buildAgentProgressSection).join('\n\n');
}
