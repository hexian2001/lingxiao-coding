import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { DraftNumberInput } from '../components/DraftNumberInput';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingNumber } from '../types';

export function AdvancedSection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;
  const [envDraft, setEnvDraft] = useState('{}');
  const [envDirty, setEnvDirty] = useState(false);
  const [envParseError, setEnvParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!envDirty) setEnvDraft(settings.env ? JSON.stringify(settings.env, null, 2) : '{}');
  }, [settings.env, envDirty]);

  const saveEnv = async () => {
    try {
      const parsed = JSON.parse(envDraft);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setEnvParseError(t('settings.error.envMustBeObject'));
        return;
      }
      setEnvParseError(null);
      const result = await onSave('env', parsed);
      if (result.ok) {
        setEnvDirty(false);
        setEnvDraft(JSON.stringify(parsed, null, 2));
      }
    } catch {
      setEnvParseError(t('settings.error.invalidJson'));
    }
  };

  return (
    <SettingsSection id="advanced" title={t('settings.group.advanced')} icon={Settings} iconClassName="text-accent-purple">
      <SettingsRow label={t('settings.item.cleanupPeriodDays')} error={errors.cleanupPeriodDays}>
        <DraftNumberInput value={settingNumber(settings.cleanupPeriodDays, 30)} onSave={(value) => onSave('cleanupPeriodDays', value)} min={1} saving={saving.cleanupPeriodDays} saved={saved.cleanupPeriodDays} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.imageHistoryRetainRounds')} desc={t('settings.item.imageHistoryRetainRounds.desc')} error={errors.imageHistoryRetainRounds}>
        <DraftNumberInput value={settingNumber(settings.imageHistoryRetainRounds, 2)} onSave={(value) => onSave('imageHistoryRetainRounds', value)} min={1} saving={saving.imageHistoryRetainRounds} saved={saved.imageHistoryRetainRounds} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.toolExecutionTimeoutMs')} desc={t('settings.item.toolExecutionTimeoutMs.desc')} error={errors.toolExecutionTimeoutMs}>
        <DraftNumberInput value={settingNumber(settings.toolExecutionTimeoutMs, 60000)} onSave={(value) => onSave('toolExecutionTimeoutMs', value)} min={1000} saving={saving.toolExecutionTimeoutMs} saved={saved.toolExecutionTimeoutMs} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.fileCheckpointingEnabled')} desc={t('settings.item.fileCheckpointingEnabled.desc')} error={errors.fileCheckpointingEnabled}>
        <SettingsToggle value={!!settings.fileCheckpointingEnabled} onChange={(v) => onSave('fileCheckpointingEnabled', v)} saving={saving.fileCheckpointingEnabled} saved={saved.fileCheckpointingEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.deferToolLoading')} error={errors.deferToolLoading}>
        <SettingsToggle value={!!settings.deferToolLoading} onChange={(v) => onSave('deferToolLoading', v)} saving={saving.deferToolLoading} saved={saved.deferToolLoading} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.ignoreGitIgnore')} desc={t('settings.item.ignoreGitIgnore.desc')} error={errors.ignoreGitIgnore}>
        <SettingsToggle value={!!settings.ignoreGitIgnore} onChange={(v) => onSave('ignoreGitIgnore', v)} saving={saving.ignoreGitIgnore} saved={saved.ignoreGitIgnore} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.hookOutputCollapsed')} error={errors.hookOutputCollapsed}>
        <SettingsToggle value={settings.hookOutputCollapsed !== false} onChange={(v) => onSave('hookOutputCollapsed', v)} saving={saving.hookOutputCollapsed} saved={saved.hookOutputCollapsed} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.env')} desc={t('settings.item.env.desc')} error={envParseError || errors.env} align="start">
        <div className="flex flex-col items-end gap-2">
          <textarea
            value={envDraft}
            onChange={(e) => { setEnvDraft(e.target.value); setEnvDirty(true); setEnvParseError(null); }}
            placeholder="{}"
            rows={5}
            className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary w-72 font-mono resize-y"
          />
          <button type="button" onClick={saveEnv} disabled={saving.env} className="px-3 py-1 text-xs bg-bg-tertiary hover:bg-bg-input border border-border-default rounded text-text-primary disabled:opacity-50">
            {t('settings.action.validateAndSave')}
          </button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
