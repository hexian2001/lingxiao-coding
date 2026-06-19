import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingString } from '../types';

export function MemorySection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;

  return (
    <SettingsSection id="memory" title={t('settings.group.memory')} icon={Database} iconClassName="text-accent-green">
      <SettingsRow label={t('settings.item.memory.enabled')} error={errors.memoryEnabled}>
        <SettingsToggle value={settings.memoryEnabled !== false} onChange={(v) => onSave('memoryEnabled', v)} saving={saving.memoryEnabled} saved={saved.memoryEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.memory.autoMemoryEnabled')} desc={t('settings.item.memory.autoMemoryEnabled.desc')} error={errors.autoMemoryEnabled}>
        <SettingsToggle value={!!settings.autoMemoryEnabled} onChange={(v) => onSave('autoMemoryEnabled', v)} saving={saving.autoMemoryEnabled} saved={saved.autoMemoryEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.intuition')} desc={t('settings.item.intuition.desc')} error={errors.intuitionEnabled}>
        <SettingsToggle value={settings.intuitionEnabled !== false} onChange={(v) => onSave('intuitionEnabled', v)} saving={saving.intuitionEnabled} saved={saved.intuitionEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.tacitMode')} desc={t('settings.item.tacitMode.desc')} error={errors.tacitModeEnabled}>
        <SettingsToggle value={settings.tacitModeEnabled !== false} onChange={(v) => onSave('tacitModeEnabled', v)} saving={saving.tacitModeEnabled} saved={saved.tacitModeEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.intuitionProfile')} desc={t('settings.item.intuitionProfile.desc')} error={errors.intuitionProfile}>
        <select
          value={settingString(settings.intuitionProfile, 'autonomous_partner')}
          onChange={(e) => onSave('intuitionProfile', e.target.value)}
          className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary min-w-[180px]"
        >
          <option value="autonomous_partner">{t('settings.item.intuitionProfile.autonomousPartner')}</option>
          <option value="low_interrupt">{t('settings.item.intuitionProfile.lowInterrupt')}</option>
          <option value="balanced">{t('settings.item.intuitionProfile.balanced')}</option>
        </select>
      </SettingsRow>
    </SettingsSection>
  );
}
