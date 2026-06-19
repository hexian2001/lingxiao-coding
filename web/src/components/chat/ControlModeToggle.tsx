/**
 * ControlModeToggle — 顶部状态条 Eternal Mode 开关
 *
 * 默认 manual。切到 eternal 时弹首次启用二次确认（无人值守自治）。
 *
 * 数据流：
 *   1. 用户点击 → /api/v1 ACP `session/set_control_mode` { mode }
 *   2. Leader.setControlMode() 写 DB + emit 'leader:control_mode_changed'
 *   3. SseBridge 广播 canonical 'leader:control_mode_changed'
 *   4. sessionStore 接 canonical event → 更新 controlMode
 *
 * 这样不论从哪端触发（TUI / Web / API），所有端都能实时看到当前模式。
 */
import { useEffect, useRef, useState } from 'react';
import { Infinity as InfinityIcon, Loader2, Pause, Play, Save, Trash2, User as UserIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { applyRuntimeSnapshotFromRpcResult, useSessionStore } from '../../stores/sessionStore';
import { acpClient } from '../../api/AcpClient';
import { buildEternalControlModeViewModel, type RuntimePillTone } from '../../utils/eternalRuntimeViewModel';
import { usePopoverMaxHeight } from '../../hooks/usePopoverMaxHeight';

function runtimeDotClass(tone: RuntimePillTone): string {
  if (tone === 'active') return 'bg-accent-brand';
  if (tone === 'ok') return 'bg-accent-green';
  if (tone === 'warn') return 'bg-accent-yellow';
  if (tone === 'danger') return 'bg-accent-red';
  return 'bg-text-tertiary';
}

export function ControlModeToggle() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const isConnected = useSessionStore((s) => s.isConnected);
  const controlMode = useSessionStore((s) => s.controlMode);
  const runtimeSnapshot = useSessionStore((s) => s.runtimeSnapshot);
  const [confirming, setConfirming] = useState(false);
  const [draftGoal, setDraftGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const maxHeight = usePopoverMaxHeight(triggerRef, confirming, { cap: 360 });

  // 点击外部或 Esc 关闭（与其他 composer 弹层一致，避免遮挡无法点掉）
  useEffect(() => {
    if (!confirming) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setConfirming(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirming(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [confirming]);

  const eternalRuntime = runtimeSnapshot?.eternal ?? null;
  const goal = eternalRuntime?.goal ?? null;
  const modeView = buildEternalControlModeViewModel(controlMode, eternalRuntime);
  const isEternal = modeView.isEternal;
  const goalPaused = Boolean(goal?.paused || eternalRuntime?.status === 'paused');

  useEffect(() => {
    if (!confirming) return;
    setDraftGoal(goal?.description || '');
  }, [confirming, goal?.description]);

  if (!sessionId || !isConnected) return null;

  const apply = async (next: 'manual' | 'eternal') => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await acpClient.sendJsonRpc('session/set_control_mode', { mode: next });
      if (!applyRuntimeSnapshotFromRpcResult(result, sessionId)) {
        // 乐观更新：服务端 emit 后 store 仍会再写一次（幂等）
        useSessionStore.setState({ controlMode: next });
      }
    } catch (err) {
      console.warn('[ControlModeToggle] set_control_mode failed:', err);
    } finally {
      setBusy(false);
      if (next === 'manual') setConfirming(false);
    }
  };

  const handleClick = () => {
    setConfirming((value) => !value);
  };

  const updateGoal = async (action: 'set' | 'pause' | 'resume' | 'clear') => {
    if (busy) return;
    const description = draftGoal.trim();
    if (action === 'set' && !description) return;
    setBusy(true);
    try {
      const result = await acpClient.sendJsonRpc('session/set_eternal_goal', {
        action,
        ...(action === 'set' ? { description } : {}),
      });
      const applied = applyRuntimeSnapshotFromRpcResult(result, sessionId);
      if (!applied && (action === 'set' || action === 'resume')) {
        useSessionStore.setState({ controlMode: 'eternal' });
      }
      if (action === 'clear') setDraftGoal('');
    } catch (err) {
      console.warn('[ControlModeToggle] set_eternal_goal failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        disabled={busy}
        title={
          isEternal
            ? `${(t('eternal.toggle.disable') as string) || '退出 Eternal Mode'} · ${modeView.title}`
            : (t('eternal.toggle.enable') as string) || '开启 Eternal Mode'
        }
        className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md border transition-colors ${
          isEternal
            ? 'border-accent-yellow/60 bg-accent-yellow/15 text-accent-yellow hover:bg-accent-yellow/25'
            : 'border-transparent text-text-tertiary hover:text-text-primary hover:border-border-default'
        } ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        {isEternal ? (
          <>
            <InfinityIcon size={11} className="shrink-0" />
            <span className="shrink-0">{modeView.modeLabel}</span>
            {modeView.spinning ? (
              <Loader2 size={10} className="shrink-0 animate-spin text-accent-brand" />
            ) : modeView.runtimeTone ? (
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${runtimeDotClass(modeView.runtimeTone)}`} />
            ) : null}
            {goal?.description && (
              <span className="hidden max-w-[128px] truncate text-[10px] text-text-tertiary xl:inline">
                {goal.description}
              </span>
            )}
            {!goal?.description && modeView.runtimeLabel && (
              <span className="hidden max-w-[112px] truncate text-[10px] text-text-tertiary lg:inline">
                {modeView.runtimeLabel}
              </span>
            )}
          </>
        ) : (
          <>
            <UserIcon size={11} className="shrink-0" />
            <span className="shrink-0">Manual</span>
          </>
        )}
      </button>

      {confirming && (
        <div
          style={{ maxHeight: maxHeight ?? undefined }}
          className="absolute bottom-full left-0 z-[210] mb-1 w-[360px] max-h-[85vh] overflow-y-auto rounded-lg border border-accent-yellow/40 bg-bg-card p-3 shadow-2xl"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0 text-[12px] font-medium text-accent-yellow">
              Eternal Goal
            </div>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-border-muted text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
              title="Close"
            >
              <X size={12} />
            </button>
          </div>
          <textarea
            value={draftGoal}
            onChange={(event) => setDraftGoal(event.target.value)}
            disabled={busy}
            rows={4}
            className="mb-2 w-full resize-none rounded-md border border-border-muted bg-bg-primary px-2 py-1.5 text-[12px] leading-relaxed text-text-primary outline-none focus:border-accent-yellow/60 disabled:opacity-60"
            placeholder="例如：持续修复 WebUI/TUI/后端状态同步 bug，统一 session/runtime 状态机"
          />
          <div className="mb-2 flex min-h-5 items-center gap-2 text-[10px] text-text-tertiary">
            {modeView.spinning ? <Loader2 size={11} className="animate-spin text-accent-brand" /> : <InfinityIcon size={11} />}
            <span className="min-w-0 truncate">
              {isEternal ? [modeView.runtimeLabel, goalPaused ? 'paused' : null].filter(Boolean).join(' · ') || 'eternal active' : 'manual'}
            </span>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {isEternal && (
              <button
                type="button"
                onClick={() => apply('manual')}
                disabled={busy}
                className="inline-flex h-6 items-center gap-1 rounded border border-border-default px-2 text-[11px] text-text-secondary hover:bg-bg-tertiary disabled:opacity-60"
              >
                <UserIcon size={11} />
                Manual
              </button>
            )}
            {goal && (
              <button
                type="button"
                onClick={() => updateGoal(goalPaused ? 'resume' : 'pause')}
                disabled={busy}
                className="inline-flex h-6 items-center gap-1 rounded border border-border-default px-2 text-[11px] text-text-secondary hover:bg-bg-tertiary disabled:opacity-60"
              >
                {goalPaused ? <Play size={11} /> : <Pause size={11} />}
                {goalPaused ? 'Resume' : 'Pause'}
              </button>
            )}
            {goal && (
              <button
                type="button"
                onClick={() => updateGoal('clear')}
                disabled={busy}
                className="inline-flex h-6 items-center gap-1 rounded border border-accent-red/40 px-2 text-[11px] text-accent-red hover:bg-accent-red/10 disabled:opacity-60"
              >
                <Trash2 size={11} />
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => updateGoal('set')}
              disabled={busy || !draftGoal.trim()}
              className="inline-flex h-6 items-center gap-1 rounded border border-accent-yellow/60 bg-accent-yellow/20 px-2 text-[11px] text-accent-yellow hover:bg-accent-yellow/30 disabled:opacity-60"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
