import { Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { DraftNumberInput } from '../components/DraftNumberInput';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingNumber } from '../types';
import McpServersTab from '../../plugins/McpServersTab';

export function McpSection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;
  return (
    <SettingsSection id="mcp" title={t('settings.group.mcp')} icon={Server} iconClassName="text-accent-blue">
      <SettingsRow label={t('settings.item.mcpEnabled')} desc={t('settings.item.mcpEnabled.desc')} error={errors.mcpEnabled}>
        <SettingsToggle value={settings.mcpEnabled !== false} onChange={(value) => onSave('mcpEnabled', value)} saving={saving.mcpEnabled} saved={saved.mcpEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.mcpToolTimeoutMs')} desc={t('settings.item.mcpToolTimeoutMs.desc')} error={errors.mcpToolTimeoutMs}>
        <DraftNumberInput value={settingNumber(settings.mcpToolTimeoutMs, 60000)} onSave={(value) => onSave('mcpToolTimeoutMs', value)} min={1000} saving={saving.mcpToolTimeoutMs} saved={saved.mcpToolTimeoutMs} />
      </SettingsRow>
      <div className="border-t border-border-default pt-3">
        <div className="h-[520px] border border-border-muted rounded overflow-hidden bg-bg-primary">
          <McpServersTab />
        </div>
      </div>
    </SettingsSection>
  );
}
