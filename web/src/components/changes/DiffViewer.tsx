/**
 * DiffViewer — 逐行 diff 渲染
 *
 * 解析 unified diff 格式，按行渲染：
 * - 绿色背景：添加行
 * - 红色背景：删除行
 * - 蓝色背景：修改标记
 * - 行号同步
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus2, FileMinus2, FileEdit, ArrowRightLeft, Download, AlertCircle } from 'lucide-react';
import type { FileDiff } from '../../stores/fileChangesStore';

interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'hunk-header';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const changeTypeIcons: Record<string, React.ReactNode> = {
  added: <FilePlus2 className="w-4 h-4 text-accent-green" />,
  modified: <FileEdit className="w-4 h-4 text-accent-blue" />,
  deleted: <FileMinus2 className="w-4 h-4 text-accent-red" />,
  renamed: <ArrowRightLeft className="w-4 h-4 text-accent-yellow" />,
};

function parseDiff(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffText.split('\n');
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      // Diff header lines (--- a/file, +++ b/file, etc.)
      continue;
    }

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        content: line.slice(1),
        newLineNo: newLine++,
      });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'remove',
        content: line.slice(1),
        oldLineNo: oldLine++,
      });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNo: oldLine++,
        newLineNo: newLine++,
      });
    } else if (line.startsWith('\\')) {
      // "No newline at end of file" marker
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
      });
    }
  }

  return hunks;
}

interface DiffViewerProps {
  diff: FileDiff;
}

export default function DiffViewer({ diff }: DiffViewerProps) {
  const { t } = useTranslation();
  const hunks = useMemo(() => parseDiff(diff.diff ?? ''), [diff.diff]);
  const fileHeader = (
    <div className="px-4 py-2 border-b border-border-default bg-bg-secondary flex items-center gap-3 shrink-0">
      {changeTypeIcons[diff.changeType]}
      <span className="text-sm font-mono text-text-primary flex-1 truncate">{diff.path}</span>
      <span className="text-xs text-text-tertiary flex items-center gap-2">
        {diff.additions > 0 && <span className="text-accent-green">+{diff.additions}</span>}
        {diff.deletions > 0 && <span className="text-accent-red">-{diff.deletions}</span>}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
          diff.changeType === 'added' ? 'bg-accent-green/20 text-accent-green' :
          diff.changeType === 'deleted' ? 'bg-accent-red/20 text-accent-red' :
          diff.changeType === 'renamed' ? 'bg-accent-yellow/20 text-accent-yellow' :
          'bg-accent-blue/20 text-accent-blue'
        }`}>
          {diff.changeType}
        </span>
      </span>
    </div>
  );

  if (diff.binary) {
    return (
      <div className="flex flex-col h-full">
        {fileHeader}
        <div className="flex flex-col items-center justify-center flex-1 text-text-tertiary gap-2">
          <AlertCircle className="w-8 h-8" />
          <p>{t('fileChanges.binaryNotSupported')}</p>
        </div>
      </div>
    );
  }

  if (hunks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        {t('diff.noChanges')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      {fileHeader}

      {/* Diff content */}
      <div className="flex-1 overflow-auto font-mono text-[13px] leading-5">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            {/* Hunk header */}
            <div className="px-4 py-0.5 bg-accent-brand/5 text-accent-brand/70 text-xs sticky top-0 z-10">
              {hunk.header}
            </div>

            {/* Diff lines */}
            <table className="w-full border-collapse">
              <tbody>
                {hunk.lines.map((line, li) => (
                  <tr
                    key={li}
                    className={
                      line.type === 'add'
                        ? 'bg-bg-diff-add/40'
                        : line.type === 'remove'
                        ? 'bg-bg-diff-del/40'
                        : ''
                    }
                  >
                    {/* Old line number */}
                    <td className="px-2 py-0 text-right text-text-tertiary/50 select-none w-10 align-top border-r border-border-default/50">
                      {line.oldLineNo ?? ''}
                    </td>
                    {/* New line number */}
                    <td className="px-2 py-0 text-right text-text-tertiary/50 select-none w-10 align-top border-r border-border-default/50">
                      {line.newLineNo ?? ''}
                    </td>
                    {/* Change indicator */}
                    <td className="px-1 py-0 text-center select-none w-5 align-top shrink-0">
                      {line.type === 'add' ? (
                        <span className="text-accent-green">+</span>
                      ) : line.type === 'remove' ? (
                        <span className="text-accent-red">-</span>
                      ) : null}
                    </td>
                    {/* Content */}
                    <td className="px-2 py-0 whitespace-pre-wrap break-all">
                      <span className={
                        line.type === 'add' ? 'text-accent-green' :
                        line.type === 'remove' ? 'text-accent-red' :
                        'text-text-primary'
                      }>
                        {line.content}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
