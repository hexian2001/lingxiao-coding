import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow, SettingsSubsection } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { DraftNumberInput } from '../components/DraftNumberInput';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingNumber } from '../types';

export function ContextSection({
  settings,
  saveState,
  onSave,
}: {
  settings: SettingsData;
  saveState: SaveState;
  onSave: SaveSetting;
}) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;

  return (
    <SettingsSection id="context" title={t('settings.group.context')} icon={Layers} iconClassName="text-accent-blue">
      <SettingsSubsection title={t('settings.item.autoCompactEnabled')} desc={t('settings.item.autoCompactEnabled.desc')}>
        <SettingsRow label={t('settings.item.autoCompactEnabled')} error={errors.autoCompactEnabled}>
          <SettingsToggle value={settings.autoCompactEnabled !== false} onChange={(v) => onSave('autoCompactEnabled', v)} saving={saving.autoCompactEnabled} saved={saved.autoCompactEnabled} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.autocompactRatio')} desc={t('settings.item.autocompactRatio.desc')} error={errors.autocompactRatio}>
          <DraftNumberInput value={settingNumber(settings.autocompactRatio, 0.8)} onSave={(value) => onSave('autocompactRatio', value)} min={0} max={1} step={0.05} saving={saving.autocompactRatio} saved={saved.autocompactRatio} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.contextTokenLimit')} desc={t('settings.item.contextTokenLimit.desc')} error={errors.contextTokenLimit}>
          <DraftNumberInput value={settingNumber(settings.contextTokenLimit, 0)} onSave={(value) => onSave('contextTokenLimit', value)} min={0} step={1000} saving={saving.contextTokenLimit} saved={saved.contextTokenLimit} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.autocompactBufferTokens')} desc={t('settings.item.autocompactBufferTokens')} error={errors.autocompactBufferTokens}>
          <DraftNumberInput value={settingNumber(settings.autocompactBufferTokens, 20000)} onSave={(value) => onSave('autocompactBufferTokens', value)} min={0} step={1000} saving={saving.autocompactBufferTokens} saved={saved.autocompactBufferTokens} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.compactLlmTimeoutMs')} desc={t('settings.item.compactLlmTimeoutMs')} error={errors.compactLlmTimeoutMs}>
          <DraftNumberInput value={settingNumber(settings.compactLlmTimeoutMs, 30000)} onSave={(value) => onSave('compactLlmTimeoutMs', value)} min={1000} step={1000} saving={saving.compactLlmTimeoutMs} saved={saved.compactLlmTimeoutMs} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.maxConsecutiveFailures')} desc={t('settings.item.maxConsecutiveFailures')} error={errors.maxConsecutiveFailures}>
          <DraftNumberInput value={settingNumber(settings.maxConsecutiveFailures, 3)} onSave={(value) => onSave('maxConsecutiveFailures', value)} min={0} saving={saving.maxConsecutiveFailures} saved={saved.maxConsecutiveFailures} />
        </SettingsRow>
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.item.maxRecentMessageCount')} desc={t('settings.item.maxRecentMessageCount.desc')}>
        <SettingsRow label={t('settings.item.maxRecentMessageCount')} error={errors.maxRecentMessageCount}>
          <DraftNumberInput value={settingNumber(settings.maxRecentMessageCount, 40)} onSave={(value) => onSave('maxRecentMessageCount', value)} min={1} saving={saving.maxRecentMessageCount} saved={saved.maxRecentMessageCount} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.preservedRecentCount')} desc={t('settings.item.preservedRecentCount.desc')} error={errors.preservedRecentCount}>
          <DraftNumberInput value={settingNumber(settings.preservedRecentCount, 6)} onSave={(value) => onSave('preservedRecentCount', value)} min={0} saving={saving.preservedRecentCount} saved={saved.preservedRecentCount} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.preservedSystemCount')} desc={t('settings.item.preservedSystemCount')} error={errors.preservedSystemCount}>
          <DraftNumberInput value={settingNumber(settings.preservedSystemCount, 3)} onSave={(value) => onSave('preservedSystemCount', value)} min={0} saving={saving.preservedSystemCount} saved={saved.preservedSystemCount} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.postCompactTokenBudget')} desc={t('settings.item.postCompactTokenBudget.desc')} error={errors.postCompactTokenBudget}>
          <DraftNumberInput value={settingNumber(settings.postCompactTokenBudget, 200000)} onSave={(value) => onSave('postCompactTokenBudget', value)} min={0} step={10000} saving={saving.postCompactTokenBudget} saved={saved.postCompactTokenBudget} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.recentWindowTokenBudget')} desc={t('settings.item.recentWindowTokenBudget.desc')} error={errors.recentWindowTokenBudget}>
          <DraftNumberInput value={settingNumber(settings.recentWindowTokenBudget, 150000)} onSave={(value) => onSave('recentWindowTokenBudget', value)} min={0} step={10000} saving={saving.recentWindowTokenBudget} saved={saved.recentWindowTokenBudget} />
        </SettingsRow>
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.item.maxRequestBytes')} desc={t('settings.item.maxRequestBytes.desc')}>
        <SettingsRow label={t('settings.item.maxRequestBytes')} desc={t('settings.item.maxRequestBytes.desc')} error={errors.maxRequestBytes}>
          <DraftNumberInput value={settingNumber(settings.maxRequestBytes, 1400000)} onSave={(value) => onSave('maxRequestBytes', value)} min={0} step={10000} saving={saving.maxRequestBytes} saved={saved.maxRequestBytes} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.maxSingleMessageBytes')} desc={t('settings.item.maxSingleMessageBytes.desc')} error={errors.maxSingleMessageBytes}>
          <DraftNumberInput value={settingNumber(settings.maxSingleMessageBytes, 262144)} onSave={(value) => onSave('maxSingleMessageBytes', value)} min={0} step={1024} saving={saving.maxSingleMessageBytes} saved={saved.maxSingleMessageBytes} />
        </SettingsRow>
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.item.toolResultRetainRounds')} desc={t('settings.item.toolResultRetainRounds.desc')}>
        <SettingsRow label={t('settings.item.toolResultRetainRounds')} desc={t('settings.item.toolResultRetainRounds.hint')} error={errors.toolResultRetainRounds}>
          <DraftNumberInput value={settingNumber(settings.toolResultRetainRounds, 50)} onSave={(value) => onSave('advanced.tool_result_retain_rounds', value)} min={1} step={5} saving={saving['advanced.tool_result_retain_rounds']} saved={saved['advanced.tool_result_retain_rounds']} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.imageHistoryRetainRounds')} desc={t('settings.item.imageHistoryRetainRounds.hint')} error={errors.imageHistoryRetainRounds}>
          <DraftNumberInput value={settingNumber(settings.imageHistoryRetainRounds, 2)} onSave={(value) => onSave('advanced.image_history_retain_rounds', value)} min={1} step={1} saving={saving['advanced.image_history_retain_rounds']} saved={saved['advanced.image_history_retain_rounds']} />
        </SettingsRow>
      </SettingsSubsection>
    </SettingsSection>
  );
}
