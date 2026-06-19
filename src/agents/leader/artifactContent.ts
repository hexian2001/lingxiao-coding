/**
 * Leader artifact content builders
 *
 * 纯函数：负责生成 Implementation / Review 制品的 Markdown 内容。
 * 从 LeaderAgent 中抽出以降低主类体量，便于单测。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Task } from '../../core/TaskBoard.js';
import { Workspace } from '../../core/Workspace.js';

export interface ImplementationContentInput {
  taskId: string;
  agentName: string;
  result: string;
  workspace: string;
  sessionId: string;
  task: Task | undefined;
  /**
   * 注入用于读 scratchpad 的 IO，便于测试。
   * 返回与该 taskId 相关的所有 scratchpad 文件 [{ file, content }]。
   */
  readScratchpads?: (taskId: string) => Array<{ file: string; content: string }>;
}

const SCRATCHPAD_TAIL_BYTES = 2000;

/**
 * 默认实现：从 <sessionDir>/scratchpad/ 中匹配 `<taskId>.md` 或 `<taskId>_*.md`。
 * 与 worker_task_prompt 的命名约定（buildScratchpadSection: `<taskId>_<role>.md`）保持一致。
 */
function defaultReadScratchpads(
  workspace: string,
  sessionId: string,
  taskId: string,
): Array<{ file: string; content: string }> {
  try {
    const dir = Workspace.getScratchpadDir(sessionId, workspace);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir).filter(
      (name) => name === `${taskId}.md` || name.startsWith(`${taskId}_`),
    );
    const out: Array<{ file: string; content: string }> = [];
    for (const file of entries) {
      const fullPath = join(dir, file);
      try {
        if (!statSync(fullPath).isFile()) continue;
        out.push({ file, content: readFileSync(fullPath, 'utf-8') });
      } catch {
        // 单个文件失败不阻塞
      }
    }
    return out;
  } catch {/* expected: data source unavailable */
    return [];
  }
}

/**
 * 生成 Implementation 制品内容
 */
export function buildImplementationContent(input: ImplementationContentInput): string {
  const { taskId, agentName, result, workspace, sessionId, task } = input;
  const reader = input.readScratchpads
    ?? ((id: string) => defaultReadScratchpads(workspace, sessionId, id));

  const sections: string[] = [];
  sections.push(`# Implementation Report`);
  sections.push('');
  sections.push(`**Task**: ${taskId} - ${task?.subject || '(unknown)'}`);
  sections.push(`**Agent**: ${agentName}`);
  sections.push(`**Completed**: ${new Date().toISOString()}`);
  sections.push('');

  sections.push('## Implementation Result');
  sections.push(result);
  sections.push('');

  const scratchpads = reader(taskId);
  for (const { file, content } of scratchpads) {
    if (!content) continue;
    const tail = content.length > SCRATCHPAD_TAIL_BYTES
      ? content.slice(-SCRATCHPAD_TAIL_BYTES)
      : content;
    sections.push(`## Agent Scratchpad — ${file}`);
    sections.push('```');
    sections.push(tail);
    sections.push('```');
    sections.push('');
  }

  return sections.join('\n');
}

export interface ReviewContentInput {
  taskId: string;
  verdict: 'PASS' | 'FAIL';
  feedback: string;
  task: Task | undefined;
}

/**
 * 生成 Review 制品内容
 */
export function buildReviewContent(input: ReviewContentInput): string {
  const { taskId, verdict, feedback, task } = input;

  const sections: string[] = [];
  sections.push(`# Review Report`);
  sections.push('');
  sections.push(`**Task**: ${taskId} - ${task?.subject || '(unknown)'}`);
  sections.push(`**Verdict**: ${verdict}`);
  sections.push(`**Reviewed**: ${new Date().toISOString()}`);
  sections.push('');

  sections.push('## Review Feedback');
  sections.push(feedback);
  sections.push('');

  if (verdict === 'PASS') {
    sections.push('## Acceptance Criteria');
    sections.push('- [x] Implementation complete');
    sections.push('- [x] Tests passing');
    sections.push('- [x] Documentation updated');
  } else {
    sections.push('## Required Changes');
    sections.push('- [ ] Address review feedback');
    sections.push('- [ ] Re-run tests');
    sections.push('- [ ] Update implementation');
  }
  sections.push('');

  return sections.join('\n');
}
