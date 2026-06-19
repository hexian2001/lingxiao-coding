/**
 * changesReport — 会话级文件变更报告（checkpoints + 工作区改动）。
 *
 * 复用 FileChangesApi（shadow git per session），把 Web 的 ChangesView 数据
 * 以终端文本呈现，作为 /changes 回调命令的结果。只读，不含回滚（回滚是破坏性操作，
 * 通过 Web UI 或显式确认流程进行）。
 */

import type { DatabaseManager } from '../core/Database.js';
import { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

export async function buildChangesReport(db: DatabaseManager, sessionId: string | null | undefined): Promise<string> {
  if (!sessionId) return '当前没有活动会话';

  let api;
  try {
    const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
    api = new FileChangesApi(new DatabaseRepositoryAdapter(db));
  } catch (error) {
    return `变更服务初始化失败: ${error instanceof Error ? error.message : String(error)}`;
  }

  const lines: string[] = [];

  // ── 当前工作区改动 ──
  try {
    const working = await api.getWorkingChanges(sessionId);
    lines.push(`📝 工作区改动（${working.length} 个文件）`);
    if (working.length === 0) {
      lines.push('  工作区干净');
    } else {
      const typeIcon: Record<string, string> = { added: '+', modified: '~', deleted: '-', renamed: '→' };
      for (const f of working.slice(0, 20)) {
        const icon = typeIcon[f.changeType] || '?';
        lines.push(`  ${icon} ${f.path}  (+${f.additions} -${f.deletions})`);
      }
      if (working.length > 20) lines.push(`  … 还有 ${working.length - 20} 个文件`);
    }
  } catch (error) {
    lines.push(`  工作区改动读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── 会话 checkpoints ──
  try {
    const checkpoints = await api.getCheckpoints(sessionId);
    lines.push('');
    lines.push(`📍 检查点（${checkpoints.length} 个）`);
    if (checkpoints.length === 0) {
      lines.push('  暂无检查点');
    } else {
      for (const cp of checkpoints.slice(0, 15)) {
        const turn = cp.turnNumber != null ? `T${cp.turnNumber} ` : '';
        const stats = (cp.additions || cp.deletions) ? ` (+${cp.additions} -${cp.deletions})` : '';
        const fileCount = cp.files.length ? ` · ${cp.files.length} 文件` : '';
        lines.push(`  ${fmtTime(cp.timestamp)} ${turn}[${cp.type}] ${cp.label.slice(0, 50)}${stats}${fileCount}`);
      }
      if (checkpoints.length > 15) lines.push(`  … 还有 ${checkpoints.length - 15} 个检查点`);
      lines.push('');
      lines.push('  提示: 回滚请在 Web UI 的 Changes 视图操作（破坏性操作需确认）');
    }
  } catch (error) {
    lines.push(`  检查点读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  return lines.join('\n');
}
