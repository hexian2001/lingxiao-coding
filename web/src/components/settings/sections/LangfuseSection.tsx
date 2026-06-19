import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Loader2, CheckCircle2, XCircle, ExternalLink } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { DraftTextInput } from '../components/DraftTextInput';
import type { SaveSetting, SaveState, SettingsData } from '../types';
import { settingString, settingNumber } from '../types';
import { settingsApiFetch } from '../settingsApi';

type TestState = 'idle' | 'testing' | 'success' | 'failed';

export function LangfuseSection({ settings, saveState, onSave }: { settings: SettingsData; saveState: SaveState; onSave: SaveSetting }) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;

  const enabled = settings.langfuseEnabled === true;
  const baseUrl = settingString(settings.langfuseBaseUrl, 'https://cloud.langfuse.com');
  const secretKey = settingString(settings.langfuseSecretKey);
  const publicKey = settingString(settings.langfusePublicKey);
  const traceLlmCalls = settings.langfuseTraceLlmCalls !== false;
  const traceToolCalls = settings.langfuseTraceToolCalls === true;
  const traceAgentLifecycle = settings.langfuseTraceAgentLifecycle !== false;
  const sampleRate = settingNumber(settings.langfuseSampleRate, 1.0);
  const maskSensitive = settings.langfuseMaskSensitive !== false;

  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  const runTest = async () => {
    setTestState('testing');
    setTestMessage('');
    try {
      const res = await settingsApiFetch<{ success: boolean; error?: string; message?: string }>('/langfuse/test', {
        method: 'POST',
      });
      if (res.success) {
        setTestState('success');
        setTestMessage(res.message || t('settings.langfuse.testSuccess', '连接成功'));
      } else {
        setTestState('failed');
        setTestMessage(res.error || t('settings.langfuse.testFailed', '连接失败'));
      }
    } catch (e) {
      setTestState('failed');
      setTestMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SettingsSection id="langfuse" title={t('settings.group.langfuse', 'Langfuse 可观测性')} icon={Activity} iconClassName="text-accent-purple">
      <SettingsRow
        label={t('settings.langfuse.enabled', '启用 Langfuse')}
        desc={t('settings.langfuse.enabled.desc', '开启后，LLM 调用和 Agent 活动将上报到 Langfuse 可观测性平台。默认关闭，不影响任何现有功能。')}
        error={errors.langfuseEnabled}
      >
        <SettingsToggle value={enabled} onChange={(v) => onSave('langfuseEnabled', v)} saving={saving.langfuseEnabled} saved={saved.langfuseEnabled} />
      </SettingsRow>

      {enabled && (
        <>
          <SettingsRow
            label={t('settings.langfuse.baseUrl', 'Langfuse 服务地址')}
            desc={t('settings.langfuse.baseUrl.desc', 'Langfuse Cloud 填 https://cloud.langfuse.com，自托管填部署地址')}
            error={errors.langfuseBaseUrl}
          >
            <DraftTextInput
              value={baseUrl}
              onSave={(v) => onSave('langfuseBaseUrl', v)}
              placeholder="https://cloud.langfuse.com"
              className="w-full sm:w-80"
              saving={saving.langfuseBaseUrl}
              saved={saved.langfuseBaseUrl}
            />
          </SettingsRow>

          <SettingsRow
            label={t('settings.langfuse.secretKey', 'Secret Key')}
            desc={t('settings.langfuse.secretKey.desc', '在 Langfuse 项目设置中获取，以 sk-lf- 开头')}
            error={errors.langfuseSecretKey}
          >
            <DraftTextInput
              value={secretKey}
              onSave={(v) => onSave('langfuseSecretKey', v)}
              placeholder="sk-lf-..."
              type="password"
              className="w-full sm:w-80"
              saving={saving.langfuseSecretKey}
              saved={saved.langfuseSecretKey}
            />
          </SettingsRow>

          <SettingsRow
            label={t('settings.langfuse.publicKey', 'Public Key')}
            desc={t('settings.langfuse.publicKey.desc', '在 Langfuse 项目设置中获取，以 pk-lf- 开头')}
            error={errors.langfusePublicKey}
          >
            <DraftTextInput
              value={publicKey}
              onSave={(v) => onSave('langfusePublicKey', v)}
              placeholder="pk-lf-..."
              type="password"
              className="w-full sm:w-80"
              saving={saving.langfusePublicKey}
              saved={saved.langfusePublicKey}
            />
          </SettingsRow>

          <SettingsRow label={t('settings.langfuse.connectionTest', '连接测试')} desc={t('settings.langfuse.connectionTest.desc', '验证 Langfuse 服务是否可达')}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={runTest}
                disabled={testState === 'testing'}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border-input bg-bg-input px-3 text-xs font-medium text-text-secondary transition-colors hover:border-accent-brand hover:text-text-primary disabled:opacity-50"
              >
                {testState === 'testing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('settings.langfuse.test', '测试连接')}
              </button>
              {testState === 'success' && (
                <span className="flex items-center gap-1 text-xs text-accent-green">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {testMessage}
                </span>
              )}
              {testState === 'failed' && (
                <span className="flex items-center gap-1 text-xs text-accent-red">
                  <XCircle className="h-3.5 w-3.5" />
                  {testMessage}
                </span>
              )}
            </div>
          </SettingsRow>

          <div className="border-t border-border-default pt-3 space-y-3">
            <SettingsRow
              label={t('settings.langfuse.traceLlmCalls', '追踪 LLM 调用')}
              desc={t('settings.langfuse.traceLlmCalls.desc', '对每次 LLM 调用生成 generation span，记录模型、输入输出、token 用量')}
              error={errors.langfuseTraceLlmCalls}
            >
              <SettingsToggle value={traceLlmCalls} onChange={(v) => onSave('langfuseTraceLlmCalls', v)} saving={saving.langfuseTraceLlmCalls} saved={saved.langfuseTraceLlmCalls} />
            </SettingsRow>

            <SettingsRow
              label={t('settings.langfuse.traceToolCalls', '追踪工具调用')}
              desc={t('settings.langfuse.traceToolCalls.desc', '对工具调用生成 span')}
              error={errors.langfuseTraceToolCalls}
            >
              <SettingsToggle value={traceToolCalls} onChange={(v) => onSave('langfuseTraceToolCalls', v)} saving={saving.langfuseTraceToolCalls} saved={saved.langfuseTraceToolCalls} />
            </SettingsRow>

            <SettingsRow
              label={t('settings.langfuse.traceAgentLifecycle', '追踪 Agent 生命周期')}
              desc={t('settings.langfuse.traceAgentLifecycle.desc', '记录 Agent 创建、完成、失败等生命周期事件')}
              error={errors.langfuseTraceAgentLifecycle}
            >
              <SettingsToggle value={traceAgentLifecycle} onChange={(v) => onSave('langfuseTraceAgentLifecycle', v)} saving={saving.langfuseTraceAgentLifecycle} saved={saved.langfuseTraceAgentLifecycle} />
            </SettingsRow>

            <SettingsRow
              label={t('settings.langfuse.sampleRate', '采样率')}
              desc={t('settings.langfuse.sampleRate.desc', '0-1 之间，1 = 全量上报，0.1 = 10% 采样')}
              error={errors.langfuseSampleRate}
            >
              <div className="flex items-center gap-2 w-full sm:w-56">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={sampleRate}
                  onChange={(e) => onSave('langfuseSampleRate', parseFloat(e.target.value))}
                  className="flex-1 accent-accent-brand"
                />
                <span className="text-xs font-mono text-text-tertiary w-8 text-right">{sampleRate.toFixed(1)}</span>
              </div>
            </SettingsRow>

            <SettingsRow
              label={t('settings.langfuse.maskSensitive', '脱敏敏感信息')}
              desc={t('settings.langfuse.maskSensitive.desc', '上报前对 prompt 中的密钥、token 等敏感信息进行脱敏')}
              error={errors.langfuseMaskSensitive}
            >
              <SettingsToggle value={maskSensitive} onChange={(v) => onSave('langfuseMaskSensitive', v)} saving={saving.langfuseMaskSensitive} saved={saved.langfuseMaskSensitive} />
            </SettingsRow>
          </div>

          <div className="border-t border-border-default pt-3">
            <a
              href={baseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-accent-brand hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('settings.langfuse.openDashboard', '打开 Langfuse Dashboard')}
            </a>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
