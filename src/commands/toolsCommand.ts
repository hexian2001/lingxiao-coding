/**
 * /tools 命令实现
 *
 * 显示当前会话可用工具列表和权限状态
 */

import type { SessionManager } from '../core/SessionManager.js';

/**
 * 格式化 /tools 输出
 */
export function formatToolsDisplay(
  allTools: { name: string; description: string }[],
  availableTools: Set<string>,
  permissionMode: string,
): string {
  const lines: string[] = [];

  // 权限模式头
  const modeLabel = {
    yolo: '🟢 yolo（完全访问）',
    networked: '🟡 networked（网络白名单）',
    dev: '🔵 dev（开发审批）',
    strict: '🔴 strict（严格审批）',
  }[permissionMode] || `⚪ ${permissionMode}`;

  lines.push(`⚙ 权限模式: ${modeLabel}`);
  lines.push('');

  // 可用工具
  lines.push('━━ 可用工具 ━━');
  const available = allTools.filter(t => availableTools.has(t.name));
  for (const tool of available) {
    lines.push(`  ✓ ${tool.name}: ${tool.description}`);
  }

  if (available.length === 0) {
    lines.push('  （无）');
  }

  // 不可用工具
  const unavailable = allTools.filter(t => !availableTools.has(t.name));
  if (unavailable.length > 0) {
    lines.push('');
    lines.push('━━ 不可用 ━━');
    for (const tool of unavailable) {
      lines.push(`  ✗ ${tool.name}: ${tool.description}`);
    }
  }

  lines.push('');
  lines.push(`共计: ${available.length}/${allTools.length} 可用`);

  return lines.join('\n');
}

/**
 * 处理 /tools 命令
 */
export async function handleToolsCommand(sessionManager: SessionManager, currentSessionId: string | undefined): Promise<string> {
  if (!currentSessionId) {
    return '当前没有活跃会话';
  }

  const toolsInfo = sessionManager.getSessionTools(currentSessionId);
  if (!toolsInfo) {
    return '无法获取会话工具信息';
  }

  return formatToolsDisplay(toolsInfo.allTools, toolsInfo.availableTools, toolsInfo.permissionMode);
}
