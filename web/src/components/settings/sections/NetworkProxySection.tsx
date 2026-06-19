import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, RotateCcw } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { DraftTextInput } from '../components/DraftTextInput';
import { DraftNumberInput } from '../components/DraftNumberInput';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingNumber, settingString } from '../types';

export function NetworkProxySection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;
  const protocol = settings.proxyProtocol === 'socks5' ? 'socks5' : 'http';
  const host = settingString(settings.proxyHost);
  const port = settingNumber(settings.proxyPort);
  const username = settingString(settings.proxyUsername);
  const password = settingString(settings.proxyPassword);
  const userAgent = settingString(settings.userAgent);
  const defaultUserAgent = settingString(settings.defaultUserAgent);
  const userAgentIsDefault = !defaultUserAgent || userAgent === defaultUserAgent;

  const preview = useMemo(() => {
    if (!host || !port) return '';
    const auth = username ? `${encodeURIComponent(username)}${password ? ':***' : ''}@` : '';
    return `${protocol}://${auth}${host}:${port}`;
  }, [host, password, port, protocol, username]);

  return (
    <SettingsSection id="network-proxy" title={t('settings.group.networkProxy')} icon={Globe} iconClassName="text-accent-green">
      <SettingsRow label={t('settings.item.userAgent')} desc={t('settings.item.userAgent.desc')} error={errors.userAgent}>
        <div className="flex min-w-0 items-center gap-1.5">
          <DraftTextInput value={userAgent} onSave={(value) => onSave('userAgent', value)} placeholder={defaultUserAgent} className="w-full sm:w-[32rem] font-mono" saving={saving.userAgent} saved={saved.userAgent} />
          <button
            type="button"
            aria-label={t('settings.item.userAgent.resetDefault')}
            title={t('settings.item.userAgent.resetDefault')}
            disabled={saving.userAgent || userAgentIsDefault}
            onClick={() => onSave('userAgent', '')}
            className="inline-flex h-8 min-w-8 items-center justify-center rounded border border-border-input bg-bg-input text-text-tertiary transition-colors hover:border-accent-brand hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border-input disabled:hover:text-text-tertiary"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </SettingsRow>

      <SettingsRow label={t('settings.item.proxyLlmRequests')} desc={t('settings.item.proxyLlmRequests.desc')} error={errors.proxyLlmRequests}>
        <SettingsToggle value={settings.proxyLlmRequests === true} onChange={(v) => onSave('proxyLlmRequests', v)} saving={saving.proxyLlmRequests} saved={saved.proxyLlmRequests} />
      </SettingsRow>

      <SettingsRow label={t('settings.item.proxyToolRequests')} desc={t('settings.item.proxyToolRequests.desc')} error={errors.proxyToolRequests}>
        <SettingsToggle value={settings.proxyToolRequests === true} onChange={(v) => onSave('proxyToolRequests', v)} saving={saving.proxyToolRequests} saved={saved.proxyToolRequests} />
      </SettingsRow>

      <div className="border-t border-border-default pt-3 space-y-3">
        <SettingsRow label={t('settings.item.proxyProtocol')} error={errors.proxyProtocol}>
          <select
            value={protocol}
            onChange={(e) => onSave('proxyProtocol', e.target.value)}
            className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary w-28"
          >
            <option value="http">{t('settings.proxy.protocol.http')}</option>
            <option value="socks5">{t('settings.proxy.protocol.socks5')}</option>
          </select>
        </SettingsRow>

        <SettingsRow label={t('settings.item.proxyHost')} error={errors.proxyHost}>
          <DraftTextInput value={host} onSave={(value) => onSave('proxyHost', value)} placeholder="192.168.2.4" className="w-52 font-mono" saving={saving.proxyHost} saved={saved.proxyHost} />
        </SettingsRow>

        <SettingsRow label={t('settings.item.proxyPort')} error={errors.proxyPort}>
          <DraftNumberInput value={port} onSave={(value) => onSave('proxyPort', value)} min={0} placeholder="7890" className="w-24" saving={saving.proxyPort} saved={saved.proxyPort} />
        </SettingsRow>

        <SettingsRow label={t('settings.item.proxyUsername')} desc={t('settings.item.proxyAuth.desc')} error={errors.proxyUsername}>
          <DraftTextInput value={username} onSave={(value) => onSave('proxyUsername', value)} placeholder={t('settings.proxy.optional')} className="w-52 font-mono" saving={saving.proxyUsername} saved={saved.proxyUsername} />
        </SettingsRow>

        <SettingsRow label={t('settings.item.proxyPassword')} error={errors.proxyPassword}>
          <DraftTextInput value={password} onSave={(value) => onSave('proxyPassword', value)} placeholder={t('settings.proxy.optional')} type="password" className="w-52 font-mono" saving={saving.proxyPassword} saved={saved.proxyPassword} />
        </SettingsRow>

        <SettingsRow label={t('settings.item.proxyNoProxy')} desc={t('settings.item.proxyNoProxy.desc')} error={errors.proxyNoProxy}>
          <DraftTextInput value={String(settings.proxyNoProxy || '')} onSave={(value) => onSave('proxyNoProxy', value)} placeholder="localhost,127.0.0.1" className="w-52 font-mono" saving={saving.proxyNoProxy} saved={saved.proxyNoProxy} />
        </SettingsRow>

        {preview && (
          <div className="text-xs text-text-tertiary font-mono bg-bg-tertiary border border-border-default rounded px-2 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
            {preview}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
