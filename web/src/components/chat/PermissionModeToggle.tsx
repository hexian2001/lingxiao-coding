import { useState, useRef, useEffect } from 'react';
import { Shield, ShieldAlert, Wifi, Zap, Check, ChevronDown } from 'lucide-react';
import { acpClient } from '../../api/AcpClient';
import { useSessionStore } from '../../stores/sessionStore';

type PermissionMode = 'yolo' | 'networked' | 'dev' | 'strict';

const MODES: PermissionMode[] = ['yolo', 'networked', 'dev', 'strict'];

function normalizeMode(value: unknown): PermissionMode {
  return MODES.includes(value as PermissionMode) ? value as PermissionMode : 'yolo';
}

function modeIcon(mode: PermissionMode) {
  if (mode === 'yolo') return <Zap size={11} className="shrink-0" />;
  if (mode === 'networked') return <Wifi size={11} className="shrink-0" />;
  if (mode === 'strict') return <ShieldAlert size={11} className="shrink-0" />;
  return <Shield size={11} className="shrink-0" />;
}

function modeClass(mode: PermissionMode): string {
  if (mode === 'yolo') return 'border-accent-orange/60 bg-accent-orange/15 text-accent-orange hover:bg-accent-orange/25';
  if (mode === 'networked') return 'border-accent-green/50 bg-accent-green/10 text-accent-green hover:bg-accent-green/20';
  if (mode === 'strict') return 'border-accent-red/50 bg-accent-red/10 text-accent-red hover:bg-accent-red/20';
  return 'border-border-default bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-input';
}

export function PermissionModeToggle() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const isConnected = useSessionStore((s) => s.isConnected);
  const permissionMode = useSessionStore((s) => s.permissionMode);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!sessionId || !isConnected) return null;

  const mode = normalizeMode(permissionMode);

  const apply = async (target: PermissionMode) => {
    setOpen(false);
    if (busy || target === mode) return;
    setBusy(true);
    try {
      const result = await acpClient.sendJsonRpc('session/set_mode', { modeId: target });
      const nextMode = normalizeMode((result as { mode?: unknown } | null)?.mode ?? target);
      useSessionStore.setState({ permissionMode: nextMode });
    } catch (err) {
      console.warn('[PermissionModeToggle] set_mode failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={`权限模式：${mode}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md border transition-colors ${modeClass(mode)} ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        {modeIcon(mode)}
        <span className="shrink-0">{mode}</span>
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 z-50 mb-1 min-w-[150px] rounded-md border border-border-default bg-bg-card py-1 shadow-xl backdrop-blur-xl">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              onClick={() => { void apply(m); }}
              className={`flex w-full items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono text-left transition-colors ${
                m === mode ? 'bg-bg-hover text-accent-brand' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {modeIcon(m)}
              <span className="flex-1">{m}</span>
              {m === mode && <Check size={11} className="text-accent-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
