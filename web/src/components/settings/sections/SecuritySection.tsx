import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Lock, Shield, ShieldAlert, Zap } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingStringArray } from '../types';

export function SecuritySection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;
  const [hardenedConfirmOpen, setHardenedConfirmOpen] = useState(false);
  const [envAllowlistDraft, setEnvAllowlistDraft] = useState<string | null>(null);

  const envAllowlistValue = envAllowlistDraft !== null
    ? envAllowlistDraft
    : settingStringArray(settings.envAllowlist).length > 0
      ? settingStringArray(settings.envAllowlist).join('\n')
      : '';

  const saveEnvAllowlist = async () => {
    const list = envAllowlistValue.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    const result = await onSave('envAllowlist', list);
    if (result.ok) setEnvAllowlistDraft(null);
  };

  return (
    <SettingsSection id="security" title={t('settings.group.sandbox')} icon={Shield} iconClassName="text-accent-blue">
      <div className="space-y-3 pb-3 border-b border-border-default">
        <SettingsRow label={t('settings.item.permissionMode')} desc={t('settings.item.permissionMode.desc')} error={errors.permissionMode}>
          <select
            value={typeof settings.permissionMode === 'string' ? settings.permissionMode : 'yolo'}
            onChange={(event) => onSave('permissionMode', event.target.value)}
            disabled={saving.permissionMode}
            className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
          >
            <option value="yolo">yolo · {t('settings.permissionMode.yolo')}</option>
            <option value="networked">networked · {t('settings.permissionMode.networked')}</option>
            <option value="dev">dev · {t('settings.permissionMode.dev')}</option>
            <option value="strict">strict · {t('settings.permissionMode.strict')}</option>
          </select>
        </SettingsRow>
        {settings.permissionMode === 'yolo' && (
          <div className="flex items-start gap-2 text-xs text-accent-orange bg-accent-orange/10 rounded px-2 py-1.5">
            <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{t('settings.item.permissionMode.yoloHint')}</span>
          </div>
        )}

        <SettingsRow label={t('settings.item.hardenedMode')} desc={t('settings.item.hardenedMode.tagline')} error={errors.hardenedMode}>
          <SettingsToggle
            value={settings.hardenedMode === true}
            onChange={(v) => {
              if (v) setHardenedConfirmOpen(true);
              else onSave('hardenedMode', false);
            }}
            saving={saving.hardenedMode}
            saved={saved.hardenedMode}
            disabled={settings.hardenedModeLocked === true}
          />
        </SettingsRow>

        <div className="flex items-start gap-2 text-xs text-text-tertiary leading-relaxed">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent-blue" />
          <p className="min-w-0">{t('settings.item.hardenedMode.desc')}</p>
        </div>

        {settings.hardenedModeLocked === true && (
          <div className="flex items-center gap-2 text-xs text-accent-yellow bg-accent-yellow/10 rounded px-2 py-1.5">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span>{t('settings.item.hardenedMode.locked')}</span>
          </div>
        )}

        {hardenedConfirmOpen && (
          <div className="rounded-md border border-accent-yellow/40 bg-accent-yellow/10 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-accent-yellow">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{t('settings.item.hardenedMode.confirm.title')}</span>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">{t('settings.item.hardenedMode.confirm.body')}</p>
            <div className="flex items-center gap-2 pt-1">
              <button className="px-3 py-1 text-xs font-medium rounded bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/40 hover:bg-accent-yellow/30 transition-colors" onClick={() => { setHardenedConfirmOpen(false); onSave('hardenedMode', true); }}>
                {t('settings.item.hardenedMode.confirm.ok')}
              </button>
              <button className="px-3 py-1 text-xs font-medium rounded border border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors" onClick={() => setHardenedConfirmOpen(false)}>
                {t('settings.item.hardenedMode.confirm.cancel')}
              </button>
            </div>
          </div>
        )}

        {settings.hardenedMode === true && (
          <SettingsRow label={t('settings.item.envAllowlist')} desc={t('settings.item.envAllowlist.desc')} error={errors.envAllowlist} align="start">
            <div className="flex flex-col items-end gap-2">
              <textarea
                value={envAllowlistValue}
                onChange={(e) => setEnvAllowlistDraft(e.target.value)}
                placeholder="PATH\nHOME\nLANG"
                rows={3}
                className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary w-64 font-mono resize-y"
              />
              <button type="button" onClick={saveEnvAllowlist} disabled={saving.envAllowlist} className="px-3 py-1 text-xs bg-bg-tertiary hover:bg-bg-input border border-border-default rounded text-text-primary disabled:opacity-50">
                {t('settings.action.saveEnvAllowlist')}
              </button>
            </div>
          </SettingsRow>
        )}
      </div>

      <SettingsRow label={t('settings.item.sandbox.autoAllowBashIfSandboxed')} desc={t('settings.item.sandbox.autoAllowBashIfSandboxed.desc')} error={errors.sandboxAutoAllowBashIfSandboxed}>
        <SettingsToggle value={settings.sandboxAutoAllowBashIfSandboxed !== false} onChange={(v) => onSave('sandboxAutoAllowBashIfSandboxed', v)} saving={saving.sandboxAutoAllowBashIfSandboxed} saved={saved.sandboxAutoAllowBashIfSandboxed} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.dangerousCommandGuard')} desc={t('settings.item.dangerousCommandGuard.desc')} error={errors.dangerousCommandGuard}>
        <SettingsToggle value={settings.dangerousCommandGuard !== false} onChange={(v) => onSave('dangerousCommandGuard', v)} saving={saving.dangerousCommandGuard} saved={saved.dangerousCommandGuard} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.identityJudgeLlm')} desc={t('settings.item.identityJudgeLlm.desc')} error={errors.identityJudgeLlmEnabled}>
        <SettingsToggle value={settings.identityJudgeLlmEnabled === true} onChange={(v) => onSave('identityJudgeLlmEnabled', v)} saving={saving.identityJudgeLlmEnabled} saved={saved.identityJudgeLlmEnabled} />
      </SettingsRow>
      <SettingsRow label={t('settings.item.blockPrivateNetwork')} desc={t('settings.item.blockPrivateNetwork.desc')} error={errors.blockPrivateNetwork}>
        <SettingsToggle value={!!settings.blockPrivateNetwork} onChange={(v) => onSave('blockPrivateNetwork', v)} saving={saving.blockPrivateNetwork} saved={saved.blockPrivateNetwork} />
      </SettingsRow>
    </SettingsSection>
  );
}
