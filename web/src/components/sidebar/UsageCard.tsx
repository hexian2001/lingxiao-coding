/**
 * UsageCard — 侧边栏常驻用量/费用卡片。
 *
 * 让报告/统计在侧边栏有可见的存在(此前只藏在 /cost /stats 斜杠命令后)。
 * 实时显示当前会话累计 token + 估算费用;点击跳已有的完整统计页 StatsView。
 *
 * 数据复用:
 *  - token: sessionStore.tokenUsage(实时,SSE 累加)
 *  - cost: costCalculator.calculateCost(纯前端,'default' 模型走 DEFAULT_PRICING)
 * 不新建 report modal —— 点击复用 StatsView 完整报告页。
 */

import { memo, useMemo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap, Coins } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useViewStore } from '../../stores/viewStore';
import { calculateCost, formatCost } from '../../utils/costCalculator';

/** 紧凑 token 格式:1234 → 1.2K,1_200_000 → 1.2M。 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.floor(n));
}

function UsageCardBase(): ReactElement {
  const { t } = useTranslation();
  const tokenUsage = useSessionStore((s) => s.tokenUsage);
  const setMainView = useViewStore((s) => s.setMainView);

  const total = tokenUsage?.total ?? 0;
  const cost = useMemo(
    () => calculateCost('default', {
      prompt: tokenUsage?.prompt ?? 0,
      completion: tokenUsage?.completion ?? 0,
      cache_read: tokenUsage?.cache_read,
      cache_creation: tokenUsage?.cache_creation,
    }),
    [tokenUsage],
  );
  const hasUsage = total > 0;

  return (
    <button
      type="button"
      onClick={() => setMainView('stats')}
      title={t('sidebar.usage_hint', '查看完整统计/费用报告')}
      className="group mt-1 w-full rounded-md border border-border-muted bg-bg-secondary/55 px-2 py-1.5 text-left shadow-[var(--shadow-flat)] transition-colors hover:border-accent-brand/40 hover:bg-bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          {t('sidebar.usage', '用量')}
        </span>
        <Coins size={11} className="text-accent-yellow" aria-hidden />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-medium tabular-nums text-text-secondary">
          <Zap size={11} className="text-accent-yellow" aria-hidden />
          {hasUsage ? formatTokens(total) : '——'}
        </span>
        <span className="text-[10px] text-text-muted">·</span>
        <span className="text-xs font-semibold tabular-nums text-accent-red">
          {hasUsage ? formatCost(cost) : '——'}
        </span>
      </div>
    </button>
  );
}

export const UsageCard = memo(UsageCardBase);
export default UsageCard;
