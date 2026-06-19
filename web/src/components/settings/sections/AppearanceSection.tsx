import { useTranslation } from 'react-i18next';
import type { i18n as I18nInstance } from 'i18next';
import { Monitor } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import type { SaveSetting, SaveState, SettingsData, ThemeMode } from '../types';
import { isThemeMode } from '../types';
import type { WebLanguage } from '../../../i18n';
import { normalizeLanguage, persistLanguage } from '../../../i18n';

export function AppearanceSection({
  mode,
  setMode,
  settings,
  saveState,
  i18n,
  onSave,
}: {
  mode: string;
  setMode: (mode: ThemeMode) => void;
  settings: SettingsData;
  saveState: SaveState;
  i18n: I18nInstance;
  onSave: SaveSetting;
}) {
  const { t } = useTranslation();
  const language = normalizeLanguage(i18n.resolvedLanguage) || normalizeLanguage(i18n.language) || normalizeLanguage(settings.uiLanguage) || 'zh';

  const handleLanguageChange = async (next: WebLanguage) => {
    await i18n.changeLanguage(next);
    persistLanguage(next);
    await onSave('uiLanguage', next);
  };

  return (
    <SettingsSection id="appearance" title={t('settings.appearance')} icon={Monitor} iconClassName="text-accent-purple">
      <SettingsRow label={t('settings.item.theme')}>
        <select
          value={mode}
          onChange={(e) => {
            if (isThemeMode(e.target.value)) setMode(e.target.value);
          }}
          className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary"
        >
          <option value="light">{t('settings.theme.light')}</option>
          <option value="dark">{t('settings.theme.dark')}</option>
          <option value="system">{t('settings.theme.system')}</option>
        </select>
      </SettingsRow>
      <SettingsRow label={t('settings.item.language')} desc={t('settings.item.language.desc')} error={saveState.errors.uiLanguage}>
        <select
          value={language}
          onChange={(e) => {
            const next = normalizeLanguage(e.target.value);
            if (next) handleLanguageChange(next);
          }}
          className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary"
        >
          <option value="en">{t('settings.locale.en')}</option>
          <option value="zh">{t('settings.locale.zh')}</option>
        </select>
      </SettingsRow>
    </SettingsSection>
  );
}
