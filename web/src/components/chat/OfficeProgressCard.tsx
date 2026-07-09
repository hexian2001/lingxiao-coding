/**
 * OfficeProgressCard — Office 工具运行时的进度卡片
 *
 * 在 ToolCallCard 中，当 office 生成/验收类工具处于 running 状态时，
 * 展示动态进度条和阶段提示，替代纯转圈等待。
 *
 * 注意：后端 SSE 进度机制存在（emitToolOutput + ToolProgressHeartbeat），
 * 但 office 工具未主动推送细粒度进度。当前通过运行时间推断阶段 + 动态动画。
 * 后续可扩展为读取 SSE progress 事件展示精确进度。
 */

import { useEffect, useState } from 'react';
import { Loader2, Presentation, FileEdit, Sheet, FileText } from 'lucide-react';

interface Props {
  toolName: string;
  elapsedMs: number;
}

const OFFICE_GENERATE_TOOLS = new Set([
  'generate_pptx', 'generate_docx', 'generate_xlsx', 'generate_pdf',
  'office_ops',
]);

const FORMAT_ICONS: Record<string, React.ReactNode> = {
  pptx: <Presentation size={14} />,
  docx: <FileEdit size={14} />,
  xlsx: <Sheet size={14} />,
  pdf: <FileText size={14} />,
};

const FORMAT_LABELS: Record<string, string> = {
  pptx: 'PPTX',
  docx: 'DOCX',
  xlsx: 'XLSX',
  pdf: 'PDF',
};

interface Phase {
  threshold: number; // ms
  label: string;
  progress: number; // 0-100
}

const PHASES: Phase[] = [
  { threshold: 0, label: '解析参数', progress: 10 },
  { threshold: 2000, label: '构建文档结构', progress: 25 },
  { threshold: 5000, label: '渲染内容', progress: 50 },
  { threshold: 10000, label: '应用主题样式', progress: 70 },
  { threshold: 15000, label: '写入文件', progress: 85 },
  { threshold: 20000, label: '创建下载链接', progress: 95 },
];

function getPhase(elapsedMs: number): Phase {
  for (let i = PHASES.length - 1; i >= 0; i--) {
    if (elapsedMs >= PHASES[i].threshold) return PHASES[i];
  }
  return PHASES[0];
}

export function isOfficeGenerateTool(toolName: string): boolean {
  return OFFICE_GENERATE_TOOLS.has(toolName);
}

export default function OfficeProgressCard({ toolName, elapsedMs }: Props) {
  const format = toolName.match(/(pptx|docx|xlsx|pdf)/i)?.[1]?.toLowerCase() || 'pptx';
  const label = FORMAT_LABELS[format] || 'OFFICE';
  const icon = FORMAT_ICONS[format] || <FileText size={14} />;
  const phase = getPhase(elapsedMs);

  // 平滑进度动画
  const [displayProgress, setDisplayProgress] = useState(phase.progress);
  useEffect(() => {
    const target = phase.progress;
    const current = displayProgress;
    const diff = target - current;
    if (Math.abs(diff) < 0.5) return;
    const timer = setTimeout(() => {
      setDisplayProgress(current + diff * 0.3);
    }, 200);
    return () => clearTimeout(timer);
  }, [phase.progress, displayProgress]);

  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  return (
    <div className="rounded-lg border border-accent-brand/30 bg-accent-brand/5 p-3 space-y-2">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-brand/15 text-accent-brand">
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-text-primary">
            正在生成 {label}
          </div>
          <div className="text-[10px] text-text-tertiary">
            {phase.label}...
          </div>
        </div>
        <Loader2 size={14} className="animate-spin text-accent-brand shrink-0" />
      </div>

      {/* 进度条 */}
      <div className="space-y-1">
        <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
          <div
            className="h-full rounded-full bg-accent-brand transition-all duration-300 ease-out"
            style={{ width: `${Math.min(displayProgress, 99)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-text-tertiary font-mono">
          <span>{Math.round(displayProgress)}%</span>
          <span>{elapsedSec}s</span>
        </div>
      </div>

      {/* 阶段标记 */}
      <div className="flex items-center gap-1">
        {PHASES.map((p, i) => {
          const isDone = elapsedMs >= p.threshold;
          const isCurrent = phase.label === p.label;
          return (
            <div
              key={i}
              className={`flex-1 h-0.5 rounded-full transition-colors ${
                isDone
                  ? isCurrent
                    ? 'bg-accent-brand animate-pulse'
                    : 'bg-accent-brand/40'
                  : 'bg-border-muted'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}
