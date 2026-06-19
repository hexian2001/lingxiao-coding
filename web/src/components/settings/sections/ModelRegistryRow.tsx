import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Loader2 } from 'lucide-react';
import { SettingsRow } from '../components/SettingsRow';
import { notifySettingChanged, settingsApiFetch } from '../settingsApi';

interface RegistryStatus {
  available: boolean;
  modelCount: number;
  cache: { exists: boolean; mtimeMs?: number; ageMs?: number; ttlMs: number; expired: boolean };
}

export function ModelRegistryRow({ onRefreshed }: { onRefreshed?: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RegistryStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await settingsApiFetch<{ data: RegistryStatus }>('/model/registry/status');
      setStatus(r.data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const onRefresh = async () => {
    setRefreshing(true);
    setFeedback(null);
    try {
      const r = await settingsApiFetch<{ data: { ok: boolean; size: number; error?: string } }>('/model/registry/refresh', { method: 'POST', body: '{}' });
      if (r.data.ok) {
        setFeedback(t('settings.modelRegistry.refreshed', { count: r.data.size }));
        notifySettingChanged({ key: 'modelRegistry', value: { refreshedAt: Date.now(), size: r.data.size } });
        await onRefreshed?.();
      } else {
        setFeedback(r.data.error || t('settings.modelRegistry.networkFail'));
      }
      await loadStatus();
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const ageMin = status?.cache.ageMs ? Math.floor(status.cache.ageMs / 60000) : null;
  const desc = status
    ? status.cache.exists
      ? t('settings.modelRegistry.cached', {
        count: status.modelCount,
        age: ageMin !== null ? t('settings.modelRegistry.ageMinutes', { count: ageMin }) : t('settings.modelRegistry.fresh'),
        expired: status.cache.expired ? t('settings.modelRegistry.expired') : '',
      })
      : t('settings.modelRegistry.snapshot', { count: status.modelCount })
    : t('settings.modelRegistry.loading');

  return (
    <SettingsRow label={t('settings.item.modelRegistry')} desc={desc}>
      {feedback && <span className="text-xs text-text-tertiary mr-2 truncate max-w-[180px]" title={feedback}>{feedback}</span>}
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="px-3 py-1 text-xs bg-bg-tertiary hover:bg-bg-input border border-border-default rounded text-text-primary disabled:opacity-50 flex items-center gap-1"
      >
        {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />}
        {t('settings.modelRegistry.refresh')}
      </button>
    </SettingsRow>
  );
}
