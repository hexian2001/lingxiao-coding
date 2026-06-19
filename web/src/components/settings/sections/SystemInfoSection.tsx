import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { InfoRow } from '../components/InfoRow';
import type { SystemInfoData } from '../types';

export function SystemInfoSection({ systemInfo }: { systemInfo: SystemInfoData | null }) {
  const { t } = useTranslation();
  if (!systemInfo) return null;

  return (
    <SettingsSection id="system" title={t('settings.systemInfo')} icon={Info} iconClassName="text-accent-blue">
      <div className="text-xs space-y-1.5">
        <InfoRow label={t('settings.systemInfo.cwd')} value={systemInfo.cwd || t('settings.systemInfo.na')} />
        <InfoRow label={t('settings.systemInfo.os')} value={`${systemInfo.os || ''} ${systemInfo.arch || ''}`.trim() || t('settings.systemInfo.na')} />
        <InfoRow label={t('settings.systemInfo.node')} value={systemInfo.nodeVersion || t('settings.systemInfo.na')} />
        <InfoRow label={t('settings.systemInfo.version')} value={systemInfo.version || t('settings.systemInfo.na')} />
        <InfoRow label={t('settings.systemInfo.uptime')} value={systemInfo.uptime ? `${Math.floor(systemInfo.uptime / 60)}m` : t('settings.systemInfo.na')} />
      </div>
    </SettingsSection>
  );
}
