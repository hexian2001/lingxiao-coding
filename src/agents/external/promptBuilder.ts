import type { WorkerTaskPayload } from '../../core/WorkerProcessRunner.js';
import {
  buildCapabilitySurfaceProtocol,
  buildExternalWorkerCompletionProtocol,
} from '../prompts/shared/fragments.js';

export function buildExternalPrompt(payload: WorkerTaskPayload): string {
  const sections: string[] = [];

  if (payload.systemPrompt?.trim()) {
    sections.push('# 系统约束 / Contract Pack', payload.systemPrompt.trim());
  }

  if (payload.contractPack?.entries?.length) {
    sections.push(
      '# Contract Pack 元数据',
      [
        `contracts_dir=${payload.contractPack.contractsDir}`,
        `active_contracts=${payload.contractPack.entries.length}`,
        ...payload.contractPack.entries.map((entry) => `- ${entry.surface} | sha256=${entry.sha256.slice(0, 16)} | path=${entry.path ?? '(not persisted)'}`),
      ].join('\n'),
    );
  }

  sections.push('# 任务主题', payload.taskSubject || '(untitled)');

  if (payload.taskDescription?.trim()) {
    sections.push('# 任务描述', payload.taskDescription.trim());
  }

  if (payload.taskContext?.trim()) {
    sections.push('# 上下文（凌霄 Leader 已准备）', payload.taskContext.trim());
  }

  if (payload.leaderContextSummary?.trim()) {
    sections.push('# Leader 已完成工作的摘要', payload.leaderContextSummary.trim());
  }

  sections.push('# 工作目录', payload.workingDirectory || payload.workspace);

  if (payload.writeScope?.length) {
    sections.push('# 写入范围（按任务契约执行）', payload.writeScope.join('\n'));
  }

  sections.push(buildCapabilitySurfaceProtocol());

  sections.push(
    '# 完成条件',
    [
      '在上述工作目录内完成任务。',
      '完成后直接输出自然语言最终答复。',
      'git commit、push 或 PR 按任务明确要求创建。',
      '凌霄服务重启由用户执行；需要重启时在最终答复中说明原因和命令。',
      '如果遇到外部配置、认证、权限阻塞，请明确说明阻塞原因和需要用户采取的动作。',
    ].join('\n'),
  );

  sections.push(buildExternalWorkerCompletionProtocol());

  return sections.join('\n\n');
}
