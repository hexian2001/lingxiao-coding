import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  Loader2,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { settingsApiFetch, createModelProvider } from '../settings/settingsApi';
import { DEFAULT_MODEL_BASE_URL, type ModelProtocol } from '../settings/types';
import { useSessionStore } from '../../stores/sessionStore';

// ── Types ───────────────────────────────────────────────────────────

type Step = 0 | 1 | 2 | 3;

interface LlmConfig {
  provider: ModelProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindowSize: string;
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface DirEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
}

// ── Constants ───────────────────────────────────────────────────────

const TOTAL_STEPS = 4;
const PROVIDERS: { id: ModelProtocol; label: string; defaultModel: string }[] = [
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o' },
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514' },
];

// ── Sub-components ──────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className="h-1 rounded-full transition-all duration-300"
          style={{
            width: i === current ? 32 : 6,
            background: i === current
              ? 'var(--color-accent-brand)'
              : i < current
                ? 'color-mix(in srgb, var(--color-accent-brand) 50%, transparent)'
                : 'var(--color-border-default)',
          }}
        />
      ))}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  type = 'text',
  placeholder,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none ${className}`}
      style={{
        background: 'var(--color-bg-input)',
        border: '1px solid var(--color-border-input)',
        color: 'var(--color-text-primary)',
      }}
    />
  );
}

// ── Step 0: Welcome ─────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="lingxiao-empty-logo-shell mb-6" style={{ width: 64, height: 64 }}>
        <img
          src={`/logo.svg?v=${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`}
          alt=""
          aria-hidden="true"
          className="lingxiao-empty-logo"
        />
      </div>
      <h2 className="mb-3 text-xl font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        {t('onboarding.welcome.title')}
      </h2>
      <p className="mb-8 max-w-md text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        {t('onboarding.welcome.desc')}
      </p>
      <button
        type="button"
        onClick={onNext}
        className="inline-flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-medium transition-all hover:opacity-90"
        style={{
          background: 'var(--primary-button-bg)',
          color: 'var(--primary-button-fg)',
          boxShadow: '0 0 20px color-mix(in srgb, var(--color-accent-brand) 24%, transparent)',
        }}
      >
        <Sparkles size={16} />
        {t('onboarding.welcome.start')}
      </button>
    </div>
  );
}

// ── Step 1: LLM Config ──────────────────────────────────────────────

function LlmConfigStep({
  config,
  onChange,
  testStatus,
  testMessage,
  onTest,
}: {
  config: LlmConfig;
  onChange: (patch: Partial<LlmConfig>) => void;
  testStatus: TestStatus;
  testMessage: string;
  onTest: () => void;
}) {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);

  const handleProviderChange = (provider: ModelProtocol) => {
    const shouldReplaceBaseUrl =
      !config.baseUrl.trim() || Object.values(DEFAULT_MODEL_BASE_URL).includes(config.baseUrl);
    onChange({
      provider,
      baseUrl: shouldReplaceBaseUrl ? DEFAULT_MODEL_BASE_URL[provider] : config.baseUrl,
    });
  };

  return (
    <div className="space-y-5">
      {/* Provider segmented control */}
      <div>
        <FieldLabel>{t('onboarding.llm.provider')}</FieldLabel>
        <div
          className="flex gap-0.5 rounded-lg p-0.5"
          style={{ background: 'var(--color-bg-primary)', border: '1px solid var(--color-border-muted)' }}
        >
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleProviderChange(p.id)}
              className="codex-chip inline-flex flex-1 items-center justify-center rounded-[6px] px-3 py-1.5 text-sm font-medium transition-all duration-200"
              style={{
                border: '1px solid transparent',
                background: config.provider === p.id
                  ? 'color-mix(in srgb, var(--color-accent-brand) 14%, transparent)'
                  : 'transparent',
                color: config.provider === p.id
                  ? 'var(--color-accent-brand)'
                  : 'var(--color-text-tertiary)',
                borderColor: config.provider === p.id
                  ? 'color-mix(in srgb, var(--color-accent-brand) 40%, transparent)'
                  : 'transparent',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div>
        <FieldLabel>{t('onboarding.llm.apiKey')}</FieldLabel>
        <div className="relative">
          <TextInput
            value={config.apiKey}
            onChange={(v) => onChange({ apiKey: v })}
            type={showApiKey ? 'text' : 'password'}
            placeholder="sk-..."
            className="pr-10 font-mono"
          />
          <button
            type="button"
            onClick={() => setShowApiKey((s) => !s)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors"
            style={{ color: 'var(--color-text-tertiary)' }}
            tabIndex={-1}
          >
            {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>

      {/* Base URL */}
      <div>
        <FieldLabel>{t('onboarding.llm.baseUrl')}</FieldLabel>
        <TextInput
          value={config.baseUrl}
          onChange={(v) => onChange({ baseUrl: v })}
          placeholder={DEFAULT_MODEL_BASE_URL[config.provider]}
          className="font-mono"
        />
      </div>

      {/* Model */}
      <div>
        <FieldLabel>{t('onboarding.llm.model')}</FieldLabel>
        <TextInput
          value={config.model}
          onChange={(v) => onChange({ model: v })}
          placeholder={PROVIDERS.find((p) => p.id === config.provider)?.defaultModel || 'gpt-4o'}
          className="font-mono"
        />
      </div>

      {/* Context Window Size (optional) */}
      <div>
        <FieldLabel>
          {t('onboarding.llm.contextWindowSize')}
          <span className="ml-1" style={{ color: 'var(--color-text-muted)' }}>({t('onboarding.common.optional')})</span>
        </FieldLabel>
        <TextInput
          value={config.contextWindowSize}
          onChange={(v) => onChange({ contextWindowSize: v })}
          type="number"
          placeholder="128000"
        />
      </div>

      {/* Test connection */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onTest}
          disabled={testStatus === 'testing' || !config.apiKey.trim() || !config.model.trim()}
          className="codex-chip inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            border: '1px solid var(--color-border-default)',
            background: 'var(--control-bg)',
            color: 'var(--color-text-primary)',
          }}
        >
          {testStatus === 'testing' ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Zap size={15} />
          )}
          {t('onboarding.llm.testConnection')}
        </button>
        {testStatus === 'success' && (
          <span className="inline-flex items-center gap-1 text-sm" style={{ color: 'var(--color-accent-green)' }}>
            <CheckCircle2 size={15} />
            {t('onboarding.llm.testSuccess')}
          </span>
        )}
        {testStatus === 'error' && (
          <span className="text-sm" style={{ color: 'var(--color-accent-red)' }} title={testMessage}>
            {t('onboarding.llm.testFailed')}: {testMessage.slice(0, 80)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Step 2: Workspace Selection ─────────────────────────────────────

function WorkspaceStep({
  workspacePath,
  onChange,
}: {
  workspacePath: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);

  const browse = useCallback(async (path: string) => {
    setBrowsing(true);
    try {
      const res = await settingsApiFetch<{ entries?: DirEntry[] }>('/fs/list', {
        method: 'POST',
        body: JSON.stringify({ path: path || '/' }),
      });
      setEntries((res.entries || []).filter((e) => e.type === 'directory'));
    } catch {
      setEntries([]);
    } finally {
      setBrowsing(false);
    }
  }, []);

  useEffect(() => {
    if (showBrowser) browse(browsePath || workspacePath || '/');
  }, [showBrowser, browsePath, workspacePath, browse]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          {t('onboarding.workspace.title')}
        </h3>
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{t('onboarding.workspace.desc')}</p>
      </div>

      <div>
        <FieldLabel>{t('onboarding.workspace.path')}</FieldLabel>
        <div className="flex gap-2">
          <TextInput
            value={workspacePath}
            onChange={onChange}
            placeholder="/home/user/project"
            className="font-mono"
          />
          <button
            type="button"
            onClick={() => {
              setBrowsePath(workspacePath || '');
              setShowBrowser((s) => !s);
            }}
            className="codex-chip inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
            style={{
              border: '1px solid var(--color-border-default)',
              background: 'var(--control-bg)',
              color: 'var(--color-text-primary)',
            }}
          >
            <Folder size={15} />
            {t('onboarding.workspace.browse')}
          </button>
        </div>
      </div>

      {/* Directory browser */}
      {showBrowser && (
        <div
          className="rounded-lg p-3"
          style={{
            background: 'var(--color-bg-primary)',
            border: '1px solid var(--color-border-muted)',
          }}
        >
          <div className="mb-2 flex items-center gap-2">
            <input
              value={browsePath}
              onChange={(e) => setBrowsePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') browse(browsePath);
              }}
              className="flex-1 rounded-md px-2 py-1 font-mono text-xs focus:outline-none"
              style={{
                background: 'var(--color-bg-input)',
                border: '1px solid var(--color-border-default)',
                color: 'var(--color-text-primary)',
              }}
            />
            <button
              type="button"
              onClick={() => browse(browsePath)}
              disabled={browsing}
              className="rounded-md px-2 py-1 text-xs disabled:opacity-50"
              style={{
                border: '1px solid var(--color-border-default)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {browsing ? <Loader2 size={12} className="animate-spin" /> : t('onboarding.workspace.go')}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {entries.length === 0 && !browsing ? (
              <p className="py-4 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {t('onboarding.workspace.noDirs')}
              </p>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    onChange(entry.path);
                    setBrowsePath(entry.path);
                  }}
                  onDoubleClick={() => browse(entry.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
                  style={{
                    background: entry.path === workspacePath
                      ? 'color-mix(in srgb, var(--color-accent-brand) 10%, transparent)'
                      : 'transparent',
                    color: entry.path === workspacePath
                      ? 'var(--color-accent-brand)'
                      : 'var(--color-text-secondary)',
                  }}
                >
                  <Folder size={13} className="shrink-0" />
                  <span className="truncate">{entry.name}</span>
                  {entry.path === workspacePath && <Check size={13} className="ml-auto shrink-0" />}
                </button>
              ))
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => setShowBrowser(false)}
              className="rounded-md px-3 py-1 text-xs font-medium"
              style={{
                background: 'color-mix(in srgb, var(--color-accent-brand) 14%, transparent)',
                color: 'var(--color-accent-brand)',
              }}
            >
              {t('onboarding.common.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 3: Complete ────────────────────────────────────────────────

function CompleteStep({
  config,
  workspacePath,
  saving,
  error,
}: {
  config: LlmConfig;
  workspacePath: string;
  saving: boolean;
  error: string;
}) {
  const { t } = useTranslation();
  const summary = useMemo(
    () => [
      { label: t('onboarding.llm.provider'), value: config.provider },
      { label: t('onboarding.llm.model'), value: config.model },
      { label: t('onboarding.llm.baseUrl'), value: config.baseUrl },
      { label: t('onboarding.workspace.path'), value: workspacePath || t('onboarding.workspace.default') },
    ],
    [config, workspacePath, t],
  );

  return (
    <div className="flex flex-col items-center py-4 text-center">
      <div
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--color-accent-green) 14%, transparent)' }}
      >
        <CheckCircle2 size={28} style={{ color: 'var(--color-accent-green)' }} />
      </div>
      <h2 className="mb-4 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        {t('onboarding.complete.title')}
      </h2>
      <div
        className="w-full max-w-sm space-y-2 rounded-lg p-4 text-left"
        style={{
          background: 'var(--color-bg-primary)',
          border: '1px solid var(--color-border-muted)',
        }}
      >
        {summary.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3 text-sm">
            <span className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>{item.label}</span>
            <span className="truncate font-mono" style={{ color: 'var(--color-text-secondary)' }}>{item.value}</span>
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-4 max-w-sm text-sm" style={{ color: 'var(--color-accent-red)' }}>{error}</p>
      )}
      {saving && (
        <p className="mt-4 inline-flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
          <Loader2 size={14} className="animate-spin" />
          {t('onboarding.complete.saving')}
        </p>
      )}
    </div>
  );
}

// ── Main Wizard Component ───────────────────────────────────────────

export interface OnboardingWizardProps {
  onComplete: () => void;
  onSkip?: () => void;
}

export default function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(0);
  const [llmConfig, setLlmConfig] = useState<LlmConfig>({
    provider: 'openai',
    apiKey: '',
    baseUrl: DEFAULT_MODEL_BASE_URL.openai,
    model: '',
    contextWindowSize: '',
  });
  const [workspacePath, setWorkspacePath] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const connectingRef = useRef(false);

  // Initialize workspace path from current cwd
  useEffect(() => {
    settingsApiFetch<{ data: { cwd?: string } }>('/info')
      .then((res) => {
        if (res?.data?.cwd) setWorkspacePath(res.data.cwd);
      })
      .catch(() => {});
  }, []);

  const updateLlmConfig = useCallback((patch: Partial<LlmConfig>) => {
    setLlmConfig((prev) => ({ ...prev, ...patch }));
    setTestStatus('idle');
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!llmConfig.apiKey.trim() || !llmConfig.model.trim()) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      await settingsApiFetch('/prompt/enhance', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'Hello' }),
      });
      setTestStatus('success');
    } catch (e) {
      setTestStatus('error');
      setTestMessage(e instanceof Error ? e.message : 'Unknown error');
    }
  }, [llmConfig.apiKey, llmConfig.model]);

  const canProceed = useMemo(() => {
    if (step === 1) {
      return llmConfig.apiKey.trim() !== '' && llmConfig.model.trim() !== '';
    }
    return true;
  }, [step, llmConfig]);

  const handleComplete = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      // 1. Create model provider
      const providerPayload = {
        provider: llmConfig.provider,
        name: llmConfig.model.trim(),
        model: llmConfig.model.trim(),
        apiKey: llmConfig.apiKey.trim(),
        baseUrl: llmConfig.baseUrl.trim() || DEFAULT_MODEL_BASE_URL[llmConfig.provider],
        ...(llmConfig.contextWindowSize !== '' && Number(llmConfig.contextWindowSize) > 0
          ? { contextWindowSize: Number(llmConfig.contextWindowSize) }
          : {}),
      };
      const createRes = await createModelProvider(providerPayload);
      const modelId = createRes?.data?.id || llmConfig.model.trim();

      // 2. Set leader_model and agent_model
      await settingsApiFetch('/settings/general', {
        method: 'PUT',
        body: JSON.stringify({ key: 'model', value: modelId }),
      });
      await settingsApiFetch('/settings/general', {
        method: 'PUT',
        body: JSON.stringify({ key: 'agentModel', value: modelId }),
      });

      // 3. Set initialized = true
      await settingsApiFetch('/settings/general', {
        method: 'PUT',
        body: JSON.stringify({ key: 'initialized', value: true }),
      });

      // 4. Create session with workspace
      await useSessionStore.getState().createAndConnect(
        workspacePath.trim() ? { workspace: workspacePath.trim() } : {},
      );

      onComplete();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
      connectingRef.current = false;
    }
  }, [llmConfig, workspacePath, onComplete]);

  const handleNext = useCallback(() => {
    if (step === 3) {
      void handleComplete();
      return;
    }
    setStep((s) => Math.min(s + 1, 3) as Step);
  }, [step, handleComplete]);

  const handlePrev = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0) as Step);
  }, []);

  const stepTitles = useMemo(
    () => [
      t('onboarding.welcome.title'),
      t('onboarding.llm.title'),
      t('onboarding.workspace.title'),
      t('onboarding.complete.title'),
    ],
    [t],
  );

  return (
    <div
      className="lx-overlay p-4"
    >
      {/* Card — lingxiao-cloud-panel for texture + glass effect */}
      <div
        className="lingxiao-cloud-panel relative w-full max-w-[560px] rounded-2xl"
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border-default)',
          boxShadow: 'var(--shadow-floating)',
        }}
      >
        {/* Skip button */}
        {onSkip && step === 0 && (
          <button
            type="button"
            onClick={onSkip}
            className="absolute right-4 top-4 z-10 rounded-md p-1.5 transition-colors"
            style={{ color: 'var(--color-text-tertiary)' }}
            title={t('onboarding.common.skip')}
          >
            <X size={16} />
          </button>
        )}

        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid var(--color-border-muted)' }}
        >
          <div className="flex items-center gap-2.5">
            <img
              src={`/logo.svg?v=${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`}
              alt=""
              aria-hidden="true"
              className="lingxiao-logo-mark h-5 w-5 shrink-0"
            />
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {t('onboarding.appName')}
            </span>
          </div>
          <StepIndicator current={step} total={TOTAL_STEPS} />
        </div>

        {/* Step title (hidden for welcome step) */}
        {step > 0 && (
          <div className="px-6 py-3" style={{ borderBottom: '1px solid var(--color-border-muted)' }}>
            <h2 className="text-base font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {stepTitles[step]}
            </h2>
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-6">
          {step === 0 && <WelcomeStep onNext={handleNext} />}
          {step === 1 && (
            <LlmConfigStep
              config={llmConfig}
              onChange={updateLlmConfig}
              testStatus={testStatus}
              testMessage={testMessage}
              onTest={handleTestConnection}
            />
          )}
          {step === 2 && (
            <WorkspaceStep
              workspacePath={workspacePath}
              onChange={setWorkspacePath}
            />
          )}
          {step === 3 && (
            <CompleteStep
              config={llmConfig}
              workspacePath={workspacePath}
              saving={saving}
              error={saveError}
            />
          )}
        </div>

        {/* Footer */}
        {step > 0 && (
          <div
            className="flex items-center justify-between px-6 py-4"
            style={{ borderTop: '1px solid var(--color-border-muted)' }}
          >
            <button
              type="button"
              onClick={handlePrev}
              disabled={step === 0 || saving}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              <ArrowLeft size={15} />
              {t('onboarding.common.prev')}
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!canProceed || saving}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                background: 'var(--primary-button-bg)',
                color: 'var(--primary-button-fg)',
                boxShadow: '0 0 16px color-mix(in srgb, var(--color-accent-brand) 20%, transparent)',
              }}
            >
              {saving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  {t('onboarding.complete.saving')}
                </>
              ) : step === 3 ? (
                <>
                  <Sparkles size={15} />
                  {t('onboarding.complete.start')}
                </>
              ) : (
                <>
                  {t('onboarding.common.next')}
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
