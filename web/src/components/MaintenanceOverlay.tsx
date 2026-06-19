/**
 * MaintenanceOverlay — 右下角后台记忆维护浮层。
 *
 * 订阅 maintenanceStore，dream/distill 运行时浮现：旋转图标 + 阶段文案 +
 * 进度条；完成显示对勾与总结后自动淡出。全程 lucide 图标，无 emoji。
 *
 * 这是 dream/distill 在 Web 端的可见化落点，与 TUI 底部状态行对等。
 */
import { Brain, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMaintenanceStore, type MaintenanceKind } from '../stores/maintenanceStore';

const KIND_PHASE_KEY: Record<MaintenanceKind, 'maintenance.phase.dream' | 'maintenance.phase.distill'> = {
  dream: 'maintenance.phase.dream',
  distill: 'maintenance.phase.distill',
};

const KIND_ICON: Record<MaintenanceKind, typeof Brain> = {
  dream: Brain,
  distill: Sparkles,
};

export default function MaintenanceOverlay() {
  const { t } = useTranslation();
  const phase = useMaintenanceStore((s) => s.phase);
  const kind = useMaintenanceStore((s) => s.kind);
  const progress = useMaintenanceStore((s) => s.progress);
  const detail = useMaintenanceStore((s) => s.detail);
  const summary = useMaintenanceStore((s) => s.summary);

  if (phase === 'idle' || !kind) return null;

  const label = t(KIND_PHASE_KEY[kind]);
  const Icon = KIND_ICON[kind];
  const percent = Math.round(progress * 100);
  const running = phase === 'running';
  const failed = phase === 'failed';

  return (
    <div className="fixed bottom-20 right-4 z-40 w-72 animate-fade-in">
      <div className="rounded-lg border border-border-default bg-bg-secondary shadow-lg px-3.5 py-3">
        {/* 标题行 */}
        <div className="flex items-center gap-2 mb-2">
          {running && <Icon size={15} className="text-accent-brand animate-spin shrink-0" />}
          {phase === 'completed' && <CheckCircle2 size={15} className="text-accent-green shrink-0" />}
          {failed && <AlertCircle size={15} className="text-accent-red shrink-0" />}
          <span className="text-xs font-medium text-text-primary flex-1">
            {running ? t('maintenance.status.running', { label }) : phase === 'completed' ? t('maintenance.status.completed', { label }) : t('maintenance.status.failed', { label })}
          </span>
          {running && <span className="text-xs font-mono font-bold text-accent-brand">{percent}%</span>}
        </div>

        {/* 进度条（仅运行中） */}
        {running && (
          <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden mb-1.5">
            <div
              className="h-full bg-accent-brand rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.max(percent, 4)}%`, boxShadow: '0 0 8px rgba(0,255,170,0.35)' }}
            />
          </div>
        )}

        {/* 明细 / 总结 */}
        <p className={`text-[11px] truncate ${failed ? 'text-accent-red/80' : 'text-text-tertiary'}`}>
          {running ? detail : summary}
        </p>
      </div>
    </div>
  );
}
