/**
 * DaemonView — 统一 Daemon 控制面板
 *
 * 合并原 WorkersView + RemoteControlView：
 * - Daemon 启停控制
 * - QQ Bot 配置与启停
 * - Daemon 会话列表
 * - 后台进程列表
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getServerToken } from '../../api/headers';
import {
  Server, Play, Square, RotateCw, RefreshCw,
  Loader2, AlertTriangle, CheckCircle2, XCircle,
  Bot, MessageCircle, Save, Eye, EyeOff,
} from 'lucide-react';
import {
  isDaemonActiveStatus,
  isQQBotActiveStatus,
  isRunActiveStatus,
  normalizeQQBotStatus,
  type CoreDaemonStatus,
} from '@contracts/adapters/StatusAdapter';

interface DaemonStatus {
  status: CoreDaemonStatus;
  pid?: number;
  port?: number;
  host?: string;
  url?: string;
  token?: string;
  uptime?: number;
  startedAt?: number;
}

interface QQBotConfig {
  enabled: boolean;
  appId: string;
  secret: string;
  sandbox?: boolean;
}

interface QQBotRuntimeStatus {
  status: string;
  appId?: string;
  connectedAt?: number;
  messageCount?: number;
  lastMessageAt?: number;
  error?: string;
}

interface SessionInfo {
  id: string;
  status: string;
  workspace?: string;
  name?: string;
  summary?: string;
  createdAt?: number;
}

interface PidEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  url?: string;
  name?: string;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function DaemonView() {
  const { t } = useTranslation();
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [qqbotConfig, setQqbotConfig] = useState<QQBotConfig | null>(null);
  const [qqbotStatus, setQqbotStatus] = useState<QQBotRuntimeStatus | null>(null);
  const [daemonSessions, setDaemonSessions] = useState<SessionInfo[]>([]);
  const [processes, setProcesses] = useState<PidEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [daemonActionLoading, setDaemonActionLoading] = useState(false);
  const [qqbotActionLoading, setQqbotActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // QQ Bot config form
  const [editAppId, setEditAppId] = useState('');
  const [editSecret, setEditSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [daemonData, qqbotCfg, qqbotSt, procData] = await Promise.all([
        apiFetch<{ data: DaemonStatus }>('/daemon/status').catch(() => ({ data: { status: 'stopped' as CoreDaemonStatus } })),
        apiFetch<{ data: QQBotConfig }>('/daemon/qqbot/config').catch(() => ({ data: { enabled: false, appId: '', secret: '' } })),
        apiFetch<{ data: QQBotRuntimeStatus }>('/daemon/qqbot/status').catch(() => ({ data: { status: 'disconnected' } })),
        apiFetch<{ data: PidEntry[] }>('/processes').catch(() => ({ data: [] })),
      ]);
      setDaemon(daemonData.data);
      setQqbotConfig(qqbotCfg.data);
      setQqbotStatus(qqbotSt.data);
      setProcesses(Array.isArray(procData.data) ? procData.data : []);

      // Fill form from config
      if (!configDirty) {
        setEditAppId(qqbotCfg.data.appId || '');
        setEditSecret(qqbotCfg.data.secret || '');
      }

      // Fetch daemon sessions if daemon is running
      if (isDaemonActiveStatus(daemonData.data.status)) {
        try {
          const sessData = await apiFetch<{ data: SessionInfo[] }>('/daemon/sessions');
          setDaemonSessions(Array.isArray(sessData.data) ? sessData.data : []);
        } catch (err) {
          console.warn('[DaemonView] Failed to fetch daemon sessions:', err);
          setDaemonSessions([]);
        }
      } else {
        setDaemonSessions([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setIsLoading(false);
    }
  }, [configDirty]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Daemon actions
  const handleDaemonAction = async (action: 'start' | 'stop' | 'restart') => {
    setDaemonActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/daemon/${action}`, { method: 'POST', body: '{}' });
      setTimeout(() => { fetchData(); setDaemonActionLoading(false); }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Daemon ${action} failed`);
      setDaemonActionLoading(false);
    }
  };

  // QQ Bot actions
  const handleSaveConfig = async () => {
    setQqbotActionLoading(true);
    setError(null);
    try {
      await apiFetch('/daemon/qqbot/config', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: qqbotConfig?.enabled ?? false,
          appId: editAppId,
          secret: editSecret,
        }),
      });
      setConfigDirty(false);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setQqbotActionLoading(false);
    }
  };

  const handleQQBotAction = async (action: 'start' | 'stop') => {
    setQqbotActionLoading(true);
    setError(null);
    try {
      await apiFetch(`/daemon/qqbot/${action}`, { method: 'POST', body: '{}' });
      setTimeout(() => { fetchData(); setQqbotActionLoading(false); }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : `QQ Bot ${action} failed`);
      setQqbotActionLoading(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!qqbotConfig) return;
    const newEnabled = !qqbotConfig.enabled;
    setQqbotConfig({ ...qqbotConfig, enabled: newEnabled });
    try {
      await apiFetch('/daemon/qqbot/config', {
        method: 'PUT',
        body: JSON.stringify({ ...qqbotConfig, enabled: newEnabled }),
      });
    } catch (err) {
      setQqbotConfig(qqbotConfig);
      setError(err instanceof Error ? err.message : 'Failed to update QQ Bot config');
    }
  };

  const daemonIsRunning = isDaemonActiveStatus(daemon?.status);
  const qqbotNormalizedStatus = normalizeQQBotStatus(qqbotStatus?.status);
  const qqbotConnected = qqbotNormalizedStatus === 'connected';
  const qqbotActive = isQQBotActiveStatus(qqbotNormalizedStatus);
  const bgProcesses = processes.filter(p => p.kind === 'bg' || p.kind === 'daemon');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-default bg-bg-secondary flex items-center justify-between shrink-0">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Server className="w-4 h-4" />
          {t('daemon.title', 'Daemon Control')}
        </h2>
        <button onClick={fetchData} className="text-text-tertiary hover:text-text-secondary" disabled={isLoading}>
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-xs hover:underline">{t('common.close', 'Close')}</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && !daemon ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : (
          <div className="p-4 space-y-4">

            {/* ═══ Daemon Control ═══ */}
            <section className="bg-bg-secondary border border-border-default rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {daemonIsRunning ? (
                    <CheckCircle2 className="w-4 h-4 text-accent-green" />
                  ) : (
                    <XCircle className="w-4 h-4 text-text-tertiary" />
                  )}
                  <span className="text-sm font-medium text-text-primary">
                    {t('daemon.server', 'Daemon Server')}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    daemonIsRunning ? 'bg-accent-green/20 text-accent-green' : 'bg-bg-tertiary text-text-tertiary'
                  }`}>
                    {daemonIsRunning ? t('daemon.running', 'running') : t('daemon.stopped', 'stopped')}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {daemonActionLoading ? (
                    <Loader2 className="w-4 h-4 text-text-tertiary animate-spin" />
                  ) : daemonIsRunning ? (
                    <>
                      <button onClick={() => handleDaemonAction('stop')} className="p-1.5 text-accent-red hover:bg-accent-red/10 rounded" title={t('daemon.stop', 'Stop')}>
                        <Square className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDaemonAction('restart')} className="p-1.5 text-accent-yellow hover:bg-accent-yellow/10 rounded" title={t('daemon.restart', 'Restart')}>
                        <RotateCw className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => handleDaemonAction('start')} className="p-1.5 text-accent-green hover:bg-accent-green/10 rounded" title={t('daemon.start', 'Start')}>
                      <Play className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
              {daemonIsRunning && daemon && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-tertiary">
                  {daemon.pid && <span>PID: {daemon.pid}</span>}
                  {daemon.port && <span>Port: {daemon.port}</span>}
                  {daemon.uptime !== undefined && <span>Uptime: {formatUptime(daemon.uptime)}</span>}
                  {daemon.url && (
                    <a
                      href={daemon.token ? `${daemon.url}?token=${daemon.token}` : daemon.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent-blue hover:underline"
                    >
                      {daemon.url}
                    </a>
                  )}
                </div>
              )}
            </section>

            {/* ═══ QQ Bot Config ═══ */}
            <section className="bg-bg-secondary border border-border-default rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-accent-blue" />
                  <span className="text-sm font-medium text-text-primary">
                    {t('daemon.qqbot.title', 'QQ Bot')}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    qqbotConnected
                      ? 'bg-accent-green/20 text-accent-green'
                      : qqbotActive
                        ? 'bg-accent-yellow/20 text-accent-yellow'
                        : 'bg-bg-tertiary text-text-tertiary'
                  }`}>
                    {qqbotNormalizedStatus}
                  </span>
                  {qqbotConnected && qqbotStatus?.messageCount !== undefined && (
                    <span className="text-xs text-text-tertiary">
                      {qqbotStatus.messageCount} msgs
                    </span>
                  )}
                </div>
                <div className="flex gap-1.5 items-center">
                  <button
                    onClick={handleToggleEnabled}
                    className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
                      qqbotConfig?.enabled
                        ? 'bg-accent-green/20 text-accent-green'
                        : 'bg-bg-tertiary text-text-tertiary'
                    }`}
                  >
                    {qqbotConfig?.enabled ? t('daemon.qqbot.enabled', 'Enabled') : t('daemon.qqbot.disabled', 'Disabled')}
                  </button>
                  {qqbotActionLoading ? (
                    <Loader2 className="w-4 h-4 text-text-tertiary animate-spin" />
                  ) : qqbotConnected ? (
                    <button onClick={() => handleQQBotAction('stop')} className="p-1.5 text-accent-red hover:bg-accent-red/10 rounded" title={t('daemon.qqbot.stop', 'Stop Bot')}>
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleQQBotAction('start')}
                      disabled={!daemonIsRunning || !editAppId || !editSecret}
                      className="p-1.5 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-30"
                      title={!daemonIsRunning ? t('daemon.qqbot.startRequiresDaemon', 'Start daemon first') : t('daemon.qqbot.start', 'Start Bot')}
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* QQ Bot Config Form */}
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] text-text-tertiary uppercase tracking-wider">{t('daemon.qqbot.appId', 'App ID')}</label>
                  <input
                    type="text"
                    value={editAppId}
                    onChange={(e) => { setEditAppId(e.target.value); setConfigDirty(true); }}
                    placeholder="1234567890"
                    className="w-full mt-0.5 px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-text-tertiary uppercase tracking-wider">{t('daemon.qqbot.secret', 'App Secret')}</label>
                  <div className="relative mt-0.5">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={editSecret}
                      onChange={(e) => { setEditSecret(e.target.value); setConfigDirty(true); }}
                      placeholder="App Secret"
                      className="w-full px-2 py-1 pr-7 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                    />
                    <button onClick={() => setShowSecret(!showSecret)} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                      {showSecret ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                {configDirty && (
                  <button
                    onClick={handleSaveConfig}
                    disabled={qqbotActionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-brand/20 text-accent-brand rounded hover:bg-accent-brand/30 disabled:opacity-50"
                  >
                    <Save className="w-3 h-3" />
                    {t('daemon.qqbot.save', 'Save Config')}
                  </button>
                )}
                {!daemonIsRunning && (
                  <p className="text-[10px] text-accent-yellow/70">
                    {t('daemon.qqbot.startDaemonFirst', 'Start the daemon first to enable QQ Bot.')}
                  </p>
                )}
              </div>
            </section>

            {/* ═══ Daemon Sessions ═══ */}
            {daemonIsRunning && (
              <section className="bg-bg-secondary border border-border-default rounded-lg p-4">
                <h3 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
                  <MessageCircle className="w-4 h-4" />
                  {t('daemon.sessions', 'Daemon Sessions')}
                  <span className="text-xs text-text-tertiary">({daemonSessions.length})</span>
                </h3>
                {daemonSessions.length === 0 ? (
                  <p className="text-xs text-text-tertiary py-2">{t('daemon.noSessions', 'No sessions in daemon')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {daemonSessions.slice(0, 20).map((s) => (
                      <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-hover text-xs">
                        <MessageCircle className="w-3 h-3 text-text-tertiary shrink-0" />
                        <span className="font-mono text-text-secondary truncate flex-1">
                          {s.name || s.id.slice(0, 12)}
                        </span>
                        <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                          isRunActiveStatus(s.status) ? 'bg-accent-green/20 text-accent-green' : 'bg-bg-tertiary text-text-tertiary'
                        }`}>
                          {s.status}
                        </span>
                        {s.createdAt && (
                          <span className="text-[10px] text-text-tertiary shrink-0">
                            {formatTimeAgo(s.createdAt * 1000)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ═══ Background Processes ═══ */}
            {bgProcesses.length > 0 && (
              <section className="bg-bg-secondary border border-border-default rounded-lg p-4">
                <h3 className="text-sm font-medium text-text-primary mb-3">
                  {t('daemon.processes', 'Background Processes')}
                </h3>
                <div className="space-y-1.5">
                  {bgProcesses.map((p) => (
                    <div key={p.pid} className="flex items-center gap-2 px-2 py-1.5 rounded text-xs">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${
                        p.kind === 'daemon' ? 'bg-accent-purple/20 text-accent-purple' : 'bg-accent-yellow/20 text-accent-yellow'
                      }`}>
                        {p.kind}
                      </span>
                      <span className="font-mono text-text-secondary">PID {p.pid}</span>
                      {p.name && <span className="text-text-tertiary truncate">{p.name}</span>}
                      {p.url && p.kind === 'daemon' && daemon?.token ? (
                        <a href={`${p.url}?token=${daemon.token}`} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline text-[10px]">
                          {p.url}
                        </a>
                      ) : p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline text-[10px]">
                          {p.url}
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            )}

          </div>
        )}
      </div>
    </div>
  );
}
