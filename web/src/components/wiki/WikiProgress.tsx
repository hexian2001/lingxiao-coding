import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SafeMarkdown, { type SafeMarkdownComponents } from '../ui/SafeMarkdown';
import { useWikiStore } from '../../stores/wikiStore';
import { CheckCircle2, Loader2, Search, Brain, PenTool, Package, FileText } from 'lucide-react';
import { normalizeWikiGenerationPhase } from '@contracts/adapters/StatusAdapter';

const STEPS = [
  { id: 'scanning',   icon: Search,   labelKey: 'wiki.step.scanning',   descKey: 'wiki.step.scanningDesc' },
  { id: 'analyzing',  icon: Brain,    labelKey: 'wiki.step.analyzing',   descKey: 'wiki.step.analyzingDesc' },
  { id: 'generating', icon: PenTool,  labelKey: 'wiki.step.generating',  descKey: 'wiki.step.generatingDesc' },
  { id: 'finalizing', icon: Package,  labelKey: 'wiki.step.finalizing',  descKey: 'wiki.step.finalizingDesc' },
];

export default function WikiProgress() {
  const { t } = useTranslation();
  const generationPhase    = useWikiStore((s) => s.generationPhase);
  const generationProgress = useWikiStore((s) => s.generationProgress);
  const generationDetail   = useWikiStore((s) => s.generationDetail);
  const streamingSections  = useWikiStore((s) => s.streamingSections);

  const bottomRef = useRef<HTMLDivElement>(null);
  const sections = Array.from(streamingSections.entries());
  const sectionCount = sections.length;
  const prevCountRef = useRef(0);

  // 只在新 section 出现时才滚到底，chunk 追加不滚动
  useEffect(() => {
    if (sectionCount > prevCountRef.current) {
      prevCountRef.current = sectionCount;
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [sectionCount]);

  const normalizedPhase = normalizeWikiGenerationPhase(generationPhase);
  const currentIdx = STEPS.findIndex((s) => s.id === normalizedPhase);
  const totalPercent = Math.round(generationProgress * 100);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* ── 左栏：步骤进度 ── */}
      <div className="w-72 shrink-0 flex flex-col border-r border-border-default bg-bg-secondary overflow-y-auto">
        {/* 总进度条 */}
        <div className="px-4 pt-4 pb-3 border-b border-border-default/50">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-text-primary">
              {t('wiki.progress.title')}
            </span>
            <span className="text-xs font-mono font-bold text-accent-brand">{totalPercent}%</span>
          </div>
          <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-brand rounded-full transition-all duration-500 ease-out"
              style={{ width: `${totalPercent}%`, boxShadow: '0 0 8px rgba(0,255,170,0.35)' }}
            />
          </div>
          {generationDetail && (
            <p className="mt-1.5 text-[11px] text-text-tertiary truncate">{generationDetail}</p>
          )}
        </div>

        {/* 步骤列表 */}
        <div className="flex-1 px-3 py-3 space-y-2">
          {STEPS.map((step, idx) => {
            const status = idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'pending';
            const Icon = step.icon;
            return (
              <div
                key={step.id}
                className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-all ${
                  status === 'active'
                    ? 'bg-accent-brand/5 border-accent-brand/25'
                    : status === 'done'
                    ? 'bg-bg-primary/50 border-border-default/40'
                    : 'bg-bg-primary/20 border-border-default/20'
                }`}
              >
                {/* 图标 */}
                <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                  status === 'active' ? 'bg-accent-brand/10 text-accent-brand'
                  : status === 'done' ? 'bg-accent-green/10 text-accent-green'
                  : 'bg-bg-tertiary text-text-tertiary/50'
                }`}>
                  {status === 'done'
                    ? <CheckCircle2 size={16} />
                    : status === 'active'
                    ? <Icon size={16} className="animate-pulse" />
                    : <Icon size={16} className="opacity-40" />}
                </div>
                {/* 文字 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-xs font-medium ${
                      status === 'active' ? 'text-accent-brand'
                      : status === 'done' ? 'text-text-primary'
                      : 'text-text-tertiary/60'
                    }`}>
                      {t(step.labelKey)}
                    </span>
                    {status === 'done' && (
                      <span className="text-[9px] font-mono text-accent-green bg-accent-green/10 px-1.5 py-0.5 rounded shrink-0">
                        {t('wiki.progress.done')}
                      </span>
                    )}
                    {status === 'active' && (
                      <Loader2 size={11} className="text-accent-brand animate-spin shrink-0" />
                    )}
                  </div>
                  <p className={`text-[11px] mt-0.5 ${status === 'pending' ? 'text-text-tertiary/40' : 'text-text-secondary'}`}>
                    {t(step.descKey)}
                  </p>
                  {/* generating 步骤的子进度条 */}
                  {status === 'active' && step.id === 'generating' && (
                    <div className="mt-1.5 h-0.5 bg-bg-tertiary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent-brand rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(Math.max(((generationProgress - 0.4) / 0.5) * 100, 0), 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 并发 section 计数 */}
        {sections.length > 0 && (
          <div className="px-4 py-2 border-t border-border-default/30">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-brand animate-pulse" />
              <span className="text-[10px] text-text-tertiary">
                {t('wiki.progress.docsParallel', { count: sections.length })}
              </span>
            </div>
          </div>
        )}

        <p className="px-4 py-3 text-[10px] text-text-tertiary/50 border-t border-border-default/30">
          {t('wiki.progress.savePath')}
        </p>
      </div>

      {/* ── 右栏：多 section 流式 Markdown 预览 ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg-primary overflow-y-auto">
        {sections.length > 0 ? (
          <div className="px-6 py-4 space-y-6">
            {sections.map(([sectionId, { title, text }]) => (
              <StreamingSection key={sectionId} title={title} text={text} />
            ))}
            <div ref={bottomRef} />
          </div>
        ) : (
          /* 占位 */
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
            <div className="w-12 h-12 rounded-xl bg-bg-secondary border border-border-default/50 flex items-center justify-center">
              <PenTool size={20} className="text-text-tertiary/40" />
            </div>
            <div>
              <p className="text-sm text-text-secondary font-medium">
                {t('wiki.progress.waiting')}
              </p>
              <p className="text-xs text-text-tertiary/60 mt-1">
                {t('wiki.progress.waitingHint')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 单个 section 的流式 Markdown 卡片 */
function StreamingSection({ title, text }: { title: string; text: string }) {
  const { t } = useTranslation();
  const components: SafeMarkdownComponents = {
    h1: ({ children }) => <h1 className="text-base font-bold text-text-primary mt-4 mb-2 pb-1 border-b border-border-muted">{children}</h1>,
    h2: ({ children }) => <h2 className="text-sm font-semibold text-text-primary mt-3 mb-1.5">{children}</h2>,
    h3: ({ children }) => <h3 className="text-xs font-semibold text-text-primary mt-2 mb-1">{children}</h3>,
    p: ({ children }) => <p className="text-xs text-text-secondary mb-2 leading-6">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="text-xs text-text-secondary leading-5">{children}</li>,
    code({ className, children }) {
      const isBlock = /language-/.test(className || '');
      if (isBlock) {
        return <pre className="my-2 px-3 py-2 bg-bg-primary rounded text-[11px] font-mono text-accent-green overflow-x-auto whitespace-pre-wrap">{children}</pre>;
      }
      return <code className="px-1 py-0.5 bg-bg-primary text-accent-green text-[11px] font-mono rounded">{children}</code>;
    },
    strong: ({ children }) => <strong className="text-text-primary font-semibold">{children}</strong>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-accent-blue/40 pl-3 my-2 text-text-tertiary italic">{children}</blockquote>,
  };

  return (
    <div className="rounded-lg border border-border-default bg-bg-secondary overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default/50 bg-bg-tertiary/50">
        <FileText size={12} className="text-accent-brand/70 shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate flex-1">{title || t('wiki.progress.generating')}</span>
        <span className="flex items-center gap-1 text-[10px] text-accent-brand/60 font-mono shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-brand animate-pulse" />
          LIVE
        </span>
      </div>
      {/* Markdown 内容 */}
      <div className="px-5 py-4 text-sm text-text-secondary leading-7 prose-wiki">
        <SafeMarkdown components={components}>{text}</SafeMarkdown>
        {/* 光标 */}
        <span className="inline-block w-1.5 h-3 bg-accent-brand/70 animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  );
}
