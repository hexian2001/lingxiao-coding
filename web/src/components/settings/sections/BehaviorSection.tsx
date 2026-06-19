import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { DraftNumberInput } from '../components/DraftNumberInput';
import { settingNumber } from '../types';
import type { SaveSetting, SaveState, ExternalAgentsStatus, SettingsData } from '../types';

export function BehaviorSection({
  settings,
  saveState,
  externalAgentsStatus,
  onSave,
}: {
  settings: SettingsData;
  saveState: SaveState;
  externalAgentsStatus: ExternalAgentsStatus | null;
  onSave: SaveSetting;
}) {
  const { t } = useTranslation();
  const saving = saveState.saving;
  const saved = saveState.saved;
  const errors = saveState.errors;

  return (
    <SettingsSection id="behavior" title={t('settings.group.behavior')} icon={Zap} iconClassName="text-accent-blue">
      <SettingsRow label={t('settings.item.maxConcurrency')} desc={t('settings.item.maxConcurrency.desc')} error={errors.maxConcurrency}>
        <DraftNumberInput value={settingNumber(settings.maxConcurrency, 5)} onSave={(value) => { void onSave('maxConcurrency', value); }} min={1} max={20} saving={saving.maxConcurrency} saved={saved.maxConcurrency} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.autoCompactEnabled')} error={errors.autoCompactEnabled}>
        <SettingsToggle value={settings.autoCompactEnabled !== false} onChange={(v) => onSave('autoCompactEnabled', v)} saving={saving.autoCompactEnabled} saved={saved.autoCompactEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.enableStreaming')} error={errors.enableStreaming}>
        <SettingsToggle value={settings.enableStreaming !== false} onChange={(v) => onSave('enableStreaming', v)} saving={saving.enableStreaming} saved={saved.enableStreaming} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.planReviewEnabled')} error={errors.planReviewEnabled}>
        <SettingsToggle value={settings.planReviewEnabled !== false} onChange={(v) => onSave('planReviewEnabled', v)} saving={saving.planReviewEnabled} saved={saved.planReviewEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.workerCompletionJudgeEnabled')} desc={t('settings.item.workerCompletionJudgeEnabled.desc')} error={errors.workerCompletionJudgeEnabled}>
        <SettingsToggle value={settings.workerCompletionJudgeEnabled === true} onChange={(v) => onSave('workerCompletionJudgeEnabled', v)} saving={saving.workerCompletionJudgeEnabled} saved={saved.workerCompletionJudgeEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.includeCoAuthoredBy')} error={errors.includeCoAuthoredBy}>
        <SettingsToggle value={settings.includeCoAuthoredBy !== false} onChange={(v) => onSave('includeCoAuthoredBy', v)} saving={saving.includeCoAuthoredBy} saved={saved.includeCoAuthoredBy} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.promptSuggestionEnabled')} error={errors.promptSuggestionEnabled}>
        <SettingsToggle value={settings.promptSuggestionEnabled !== false} onChange={(v) => onSave('promptSuggestionEnabled', v)} saving={saving.promptSuggestionEnabled} saved={saved.promptSuggestionEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.externalAgentsEnabled')} desc={t('settings.item.externalAgentsEnabled.desc')} error={errors.externalAgentsEnabled}>
        <div className="flex flex-col items-end gap-2">
          <SettingsToggle value={settings.externalAgentsEnabled !== false} onChange={(v) => onSave('externalAgentsEnabled', v)} saving={saving.externalAgentsEnabled} saved={saved.externalAgentsEnabled} />
          {externalAgentsStatus && (
            <div className="flex flex-col items-end gap-1 text-[10px] font-mono">
              {(['claude', 'codex'] as const).map((backend) => {
                const info = externalAgentsStatus[backend];
                return (
                  <span key={backend} className={info.installed ? 'text-accent-green' : 'text-accent-yellow'}>
                    {backend}: {info.command} · {info.installed ? t('settings.externalAgents.installed') : t('settings.externalAgents.missing')}
                  </span>
                );
              })}
              {settings.externalAgentsEnabled !== false && (!externalAgentsStatus.claude.installed || !externalAgentsStatus.codex.installed) && (
                <span className="text-accent-yellow">{t('settings.externalAgents.missingHint')}</span>
              )}
            </div>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
