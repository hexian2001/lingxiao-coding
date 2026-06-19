/**
 * GitPanel — Git 工作区状态可视化（只读）
 *
 * 展示：
 *   - 当前分支 + ahead/behind 追踪
 *   - 暂存 / 未暂存 / 未跟踪 / 冲突文件（带状态字形）
 *   - 最近提交历史
 *   - 当前 diff（截断滚动）
 *
 * 数据由 LingXiaoTUI 通过 RealGitService 在 /git 命令触发时异步加载。
 * 快捷键: ↑/↓ 滚动 · Esc/Ctrl+X 关闭
 */

import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { EmptyState, HelpLine, PanelFrame, PanelHeader } from './components/PanelFrame.js';
import { t } from '../i18n.js';

export interface GitFileStatus {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitCommitLine {
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitPanelData {
  isRepo: boolean;
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  conflicted: string[];
  isClean: boolean;
  commits: GitCommitLine[];
  diff: string;
  error?: string;
  loadedAt?: number;
}

interface GitPanelProps {
  data?: GitPanelData | null;
  width?: number;
  cursor?: number;
  visibleRows?: number;
}

/** index/working_dir 字母 → 颜色 */
function statusColor(code: string): string {
  switch (code) {
    case 'M': return tuiTheme.semantic.status.running;
    case 'A': return tuiTheme.semantic.diff.add;
    case 'D': return tuiTheme.semantic.diff.del;
    case 'R': return tuiTheme.semantic.diff.hunk;
    case 'C': return tuiTheme.semantic.diff.hunk;
    case 'U': return tuiTheme.semantic.status.blocked;
    default: return tuiTheme.semantic.text.secondary;
  }
}

function diffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return tuiTheme.semantic.diff.add;
  if (line.startsWith('-') && !line.startsWith('---')) return tuiTheme.semantic.diff.del;
  if (line.startsWith('@@')) return tuiTheme.semantic.diff.hunk;
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) return tuiTheme.semantic.diff.meta;
  return tuiTheme.semantic.diff.context;
}

export const GitPanel: FunctionComponent<GitPanelProps> = ({ data, width = 80, cursor = 0, visibleRows = 12 }) => {
  const maxWidth = Math.max(24, width - 4);

  if (!data) {
    return (
      <PanelFrame title={t('tui.git.title')}>
        <EmptyState text={t('tui.panel.loading')} width={maxWidth} />
      </PanelFrame>
    );
  }

  if (data.error) {
    return (
      <PanelFrame title={t('tui.git.title')}>
        <Text color={tuiTheme.semantic.status.failed}>{truncateDisplayText(data.error, maxWidth)}</Text>
      </PanelFrame>
    );
  }

  if (!data.isRepo) {
    return (
      <PanelFrame title={t('tui.git.title')}>
        <EmptyState text={t('tui.git.not_repo')} width={maxWidth} />
      </PanelFrame>
    );
  }

  const trackingInfo = data.tracking
    ? `${data.tracking}${data.ahead ? ` ↑${data.ahead}` : ''}${data.behind ? ` ↓${data.behind}` : ''}`
    : t('tui.git.no_upstream');

  // diff 区域：按 cursor 滚动（clamp 到末页，避免越界滚到空白）
  const diffLines = data.diff ? data.diff.split('\n') : [];
  const maxScroll = Math.max(0, diffLines.length - visibleRows);
  const scroll = Math.min(Math.max(0, cursor), maxScroll);
  const diffWindow = diffLines.slice(scroll, scroll + visibleRows);

  return (
    <PanelFrame>
      {/* 头部：分支 + 追踪 */}
      <PanelHeader
        title={t('tui.git.title')}
        meta={`${data.branch} · ${trackingInfo}${data.isClean ? ' · clean' : ''}`}
        width={maxWidth}
      />

      {/* 文件状态摘要 */}
      <Box>
        <Text color={tuiTheme.semantic.text.secondary}>
          {t('tui.git.summary', data.staged.length, data.unstaged.length, data.untracked.length, data.conflicted.length)}
        </Text>
      </Box>

      {/* 暂存文件 */}
      {data.staged.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={tuiTheme.semantic.diff.add}>{t('tui.git.staged')}</Text>
          {data.staged.slice(0, 8).map((f, i) => (
            <Box key={`staged-${i}`}>
              <Text color={statusColor(f.index)}>{` ${f.index} `}</Text>
              <Text color={tuiTheme.semantic.text.primary} wrap="truncate-end">{truncateDisplayText(f.path, maxWidth - 4)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 未暂存文件 */}
      {data.unstaged.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={tuiTheme.semantic.status.running}>{t('tui.git.unstaged')}</Text>
          {data.unstaged.slice(0, 8).map((f, i) => (
            <Box key={`unstaged-${i}`}>
              <Text color={statusColor(f.working_dir)}>{` ${f.working_dir} `}</Text>
              <Text color={tuiTheme.semantic.text.primary} wrap="truncate-end">{truncateDisplayText(f.path, maxWidth - 4)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 未跟踪文件 */}
      {data.untracked.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={tuiTheme.semantic.text.secondary}>{t('tui.git.untracked')}</Text>
          {data.untracked.slice(0, 6).map((p, i) => (
            <Box key={`untracked-${i}`}>
              <Text color={tuiTheme.semantic.text.secondary}>{' ? '}</Text>
              <Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">{truncateDisplayText(p, maxWidth - 4)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 最近提交 */}
      {data.commits.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={tuiTheme.semantic.panel.help}>{t('tui.git.recent_commits')}</Text>
          {data.commits.slice(0, 5).map((c, i) => (
            <Box key={`commit-${i}`}>
              <Text color={tuiTheme.semantic.diff.meta}>{` ${c.shortHash} `}</Text>
              <Text color={tuiTheme.semantic.text.primary} wrap="truncate-end">{truncateDisplayText(c.message, maxWidth - 12)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Diff（可滚动） */}
      {diffLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={tuiTheme.semantic.panel.help}>
            {t('tui.git.diff_header', scroll + 1, Math.min(scroll + visibleRows, diffLines.length), diffLines.length)}
          </Text>
          {diffWindow.map((line, i) => (
            <Text key={`diff-${scroll + i}`} color={diffLineColor(line)} wrap="truncate-end">
              {truncateDisplayText(line || ' ', maxWidth)}
            </Text>
          ))}
        </Box>
      )}

      <HelpLine text={t('tui.git.help')} width={maxWidth} />
    </PanelFrame>
  );
};

/** diff 总行数 —— 供模态滚动上限计算 */
export function getGitDiffLineCount(data?: GitPanelData | null): number {
  if (!data?.diff) return 0;
  return data.diff.split('\n').length;
}

export default GitPanel;
