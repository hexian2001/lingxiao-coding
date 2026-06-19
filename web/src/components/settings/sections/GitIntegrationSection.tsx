import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { DraftTextInput } from '../components/DraftTextInput';
import { settingsApiFetch } from '../settingsApi';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingString } from '../types';

export function GitIntegrationSection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;
  const [gitTestResult, setGitTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [gitTesting, setGitTesting] = useState(false);
  const gitPlatform = settingString(settings.gitPlatform, 'none');
  const gitToken = settingString(settings.gitToken);

  const testConnection = async () => {
    setGitTesting(true);
    setGitTestResult(null);
    try {
      const res = await settingsApiFetch<{ ok: boolean; message: string }>('/git/platform/test', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setGitTestResult(res);
    } catch (e) {
      setGitTestResult({ ok: false, message: e instanceof Error ? e.message : t('settings.git.testFailed') });
    } finally {
      setGitTesting(false);
    }
  };

  return (
    <SettingsSection id="git" title={t('settings.group.gitIntegration')} icon={GitBranch} iconClassName="text-accent-green">
      <SettingsRow label={t('settings.item.gitPlatform')} desc={t('settings.item.gitPlatform.desc')} error={errors.gitPlatform}>
        <select
          value={gitPlatform}
          onChange={(e) => onSave('gitPlatform', e.target.value)}
          className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary min-w-[140px]"
        >
          <option value="none">{t('settings.item.gitPlatform.none')}</option>
          <option value="github">{t('settings.item.gitPlatform.github')}</option>
          <option value="gitlab">{t('settings.item.gitPlatform.gitlab')}</option>
          <option value="gitea">{t('settings.item.gitPlatform.gitea')}</option>
        </select>
      </SettingsRow>

      <SettingsRow
        label={t('settings.item.gitToken')}
        desc={t('settings.item.gitToken.desc')}
        hint={gitToken ? t('settings.git.tokenMaskedHint', { token: gitToken }) : t('settings.git.tokenReadOnlyHint')}
      >
        <span className="px-2 py-1 text-xs rounded bg-bg-tertiary border border-border-default text-text-tertiary font-mono">
          {gitToken || t('settings.notSet')}
        </span>
      </SettingsRow>

      {(gitPlatform === 'gitlab' || gitPlatform === 'gitea') && (
        <SettingsRow label={t('settings.item.gitApiUrl')} desc={t('settings.item.gitApiUrl.desc')} error={errors.gitApiUrl}>
          <DraftTextInput
            value={settingString(settings.gitApiUrl)}
            onSave={(value) => onSave('gitApiUrl', value)}
            placeholder="https://gitlab.company.com"
            className="w-56"
            saving={saving.gitApiUrl}
            saved={saved.gitApiUrl}
          />
        </SettingsRow>
      )}

      <SettingsRow label={t('settings.item.gitDefaultBranch')} desc={t('settings.item.gitDefaultBranch.desc')} error={errors.gitDefaultTargetBranch}>
        <DraftTextInput
          value={settingString(settings.gitDefaultTargetBranch)}
          onSave={(value) => onSave('gitDefaultTargetBranch', value)}
          placeholder="main"
          className="w-32"
          saving={saving.gitDefaultTargetBranch}
          saved={saved.gitDefaultTargetBranch}
        />
      </SettingsRow>

      {gitPlatform !== 'none' && (
        <div className="flex items-center gap-3">
          <button
            onClick={testConnection}
            disabled={gitTesting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border border-border-default text-text-secondary rounded hover:bg-bg-hover disabled:opacity-40 transition-colors"
          >
            {gitTesting ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
            {t('settings.git.testConnection')}
          </button>
          {gitTestResult && (
            <span className={`text-xs font-mono ${gitTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>
              {gitTestResult.ok ? <CheckCircle2 size={12} className="inline text-green-400" /> : <XCircle size={12} className="inline text-red-400" />}{' '}{gitTestResult.message}
            </span>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
