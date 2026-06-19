/**
 * PlanApprovalBanner — Plan审批横幅
 *
 * 当 Leader 生成方案需要用户审批时显示。
 * 用户可以：批准执行 / 提供修改意见
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, MessageSquare, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { acpClient } from '../../api/AcpClient';
import { useSessionStore } from '../../stores/sessionStore';

type JsonRecord = Record<string, unknown>;

interface StructuredPlan {
  goal?: unknown;
  analysis?: unknown;
  approach?: unknown;
  risks?: unknown;
  verification?: unknown;
  tasks?: unknown[];
  groups?: unknown[];
  [key: string]: unknown;
}

const PLAN_SECTION_KEYS = ['goal', 'analysis', 'approach', 'risks', 'verification', 'tasks', 'groups'] as const;
const PLAN_SECTION_KEY_SET = new Set<string>(PLAN_SECTION_KEYS);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStructuredPlan(value: unknown): StructuredPlan | null {
  if (!isRecord(value)) return null;
  return {
    ...value,
    tasks: Array.isArray(value.tasks) ? value.tasks : undefined,
    groups: Array.isArray(value.groups) ? value.groups : undefined,
  };
}

/**
 * 将 pendingPlan (string | object) 解析为可渲染的结构化对象
 */
function parsePlan(raw: string): { structured: StructuredPlan | null; text: string } {
  // Already a plain text (not JSON)
  if (!raw.trimStart().startsWith('{') && !raw.trimStart().startsWith('[')) {
    return { structured: null, text: raw };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj = parseStructuredPlan(parsed);
    if (obj) {
      return { structured: obj, text: raw };
    }
    return { structured: null, text: raw };
  } catch {
    return { structured: null, text: raw };
  }
}

function PlanSection({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === '') return null;
  const text = Array.isArray(value)
    ? value.map((v, i) => `${i + 1}. ${v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : v}`).join('\n')
    : value !== null && typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : String(value);

  return (
    <div className="mb-3">
      <div className="text-[11px] font-semibold text-accent-brand/80 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">{text}</div>
    </div>
  );
}

export function PlanApprovalBanner() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const pendingPlan = useSessionStore((s) => s.pendingPlan);

  const [expanded, setExpanded] = useState(true);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Parse plan once — avoids re-parsing on every render
  const parsed = useMemo(() => {
    if (!pendingPlan) return null;
    return parsePlan(pendingPlan);
  }, [pendingPlan]);

  if (!pendingPlan || !parsed) return null;

  const handleApprove = async () => {
    if (!sessionId || loading) return;
    setLoading('approve');
    setError(null);
    try {
      await acpClient.sendJsonRpc('session/approvePlan', { sessionId });
      useSessionStore.setState({ pendingPlan: null });
    } catch (e) {
      console.error('[PlanApproval] approve failed', e);
      setError(e instanceof Error ? e.message : String(e || 'approve failed'));
    } finally {
      setLoading(null);
    }
  };

  const handleReject = async () => {
    if (!sessionId || loading || !feedback.trim()) return;
    setLoading('reject');
    setError(null);
    try {
      await acpClient.sendJsonRpc('session/rejectPlan', { sessionId, feedback: feedback.trim() });
      useSessionStore.setState({ pendingPlan: null });
      setFeedback('');
      setShowFeedback(false);
    } catch (e) {
      console.error('[PlanApproval] reject failed', e);
      setError(e instanceof Error ? e.message : String(e || 'reject failed'));
    } finally {
      setLoading(null);
    }
  };

  const { structured, text } = parsed;

  return (
    <div className="mx-4 mb-3 border border-accent-brand/40 rounded-lg bg-accent-brand/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-accent-brand/10">
        <span className="plan-seal shrink-0" aria-hidden="true" title={t('plan.awaitingApproval', '方案待审批')}>批</span>
        <span className="text-sm font-medium text-accent-brand flex-1">
          {t('plan.awaitingApproval', '方案待审批')}
        </span>
        <button
          className="text-text-tertiary hover:text-text-secondary transition-colors"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Plan content */}
      {expanded && (
        <div className="px-3 py-3 max-h-72 overflow-y-auto">
          {structured ? (
            // Structured display when plan is an object
            <>
              {structured.goal && <PlanSection label={t('plan.goal', '目标')} value={structured.goal} />}
              {structured.analysis && <PlanSection label={t('plan.analysis', '分析')} value={structured.analysis} />}
              {structured.approach && <PlanSection label={t('plan.approach', '方案')} value={structured.approach} />}
              {structured.risks && <PlanSection label={t('plan.risks', '风险')} value={structured.risks} />}
              {structured.tasks && structured.tasks.length > 0 && (
                <PlanSection label={t('plan.tasks', '任务列表')} value={structured.tasks} />
              )}
              {structured.groups && structured.groups.length > 0 && (
                <PlanSection label={t('plan.groups', '任务分组')} value={structured.groups} />
              )}
              {structured.verification && (
                <PlanSection label={t('plan.verification', '验收标准')} value={structured.verification} />
              )}
              {/* Render extra keys not explicitly handled above */}
              {Object.entries(structured)
                .filter(([k]) => !PLAN_SECTION_KEY_SET.has(k))
                .map(([k, v]) => (
                  <PlanSection key={k} label={k} value={v} />
                ))
              }
            </>
          ) : (
            // Plain text / pre-formatted fallback
            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">
              {text}
            </pre>
          )}
        </div>
      )}

      {/* Feedback input */}
      {showFeedback && (
        <div className="px-3 pb-2">
          <textarea
            className="w-full text-xs bg-bg-input border border-border-input rounded px-2 py-1.5 text-text-primary resize-none focus:outline-none focus:border-accent-brand/60 placeholder:text-text-tertiary"
            rows={3}
            placeholder={t('plan.feedbackPlaceholder', '请输入修改意见，Leader 将根据意见重新规划...')}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleReject();
            }}
          />
        </div>
      )}

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-accent-red/25 bg-accent-red/10 px-2 py-1.5 text-xs text-accent-red">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {t('plan.approvalFailed', 'Plan approval request failed')}: {error}
          </span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label={t('app.dismiss', 'Dismiss')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <button
          disabled={!!loading}
          onClick={handleApprove}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading === 'approve' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5" />
          )}
          {t('plan.approve', '批准执行')}
        </button>

        {!showFeedback ? (
          <button
            disabled={!!loading}
            onClick={() => setShowFeedback(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-bg-tertiary text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {t('plan.requestRevision', '修改方案')}
          </button>
        ) : (
          <button
            disabled={!feedback.trim() || !!loading}
            onClick={handleReject}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-yellow/20 text-accent-yellow hover:bg-accent-yellow/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading === 'reject' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <MessageSquare className="w-3.5 h-3.5" />
            )}
            {t('plan.submitFeedback', '提交意见')}
          </button>
        )}

        {showFeedback && (
          <button
            onClick={() => { setShowFeedback(false); setFeedback(''); }}
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {t('app.cancel', '取消')}
          </button>
        )}
      </div>
    </div>
  );
}
