import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowRight,
  Brain,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Loader2,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow, SettingsSubsection } from '../components/SettingsRow';
import { SettingsToggle } from '../components/SettingsToggle';
import { ModelInputRow } from '../components/ModelInputRow';
import { notifySettingChanged, settingsApiFetch } from '../settingsApi';
import { ModelRegistryRow } from './ModelRegistryRow';
import type { AddModelForm, ModelProtocol, ProviderInfo, SaveSetting, SaveState, SettingsData } from '../types';
import { settingNumber, settingString } from '../types';
import { DEFAULT_MODEL_BASE_URL, createDefaultAddModelForm } from '../types';

type ModelItem = ProviderInfo['models'][number] & { provider: ModelProtocol };
type StatusMessage = { kind: 'success' | 'error'; message: string } | null;
const MODEL_PAGE_SIZE = 10;

export function ModelAndReasoningSection({
  settings,
  providers,
  saveState,
  onSave,
  onProvidersChange,
  onRefreshSettings,
}: {
  settings: SettingsData;
  providers: ProviderInfo[];
  saveState: SaveState;
  onSave: SaveSetting;
  onProvidersChange: (providers: ProviderInfo[]) => void;
  onRefreshSettings: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { saving, saved, errors } = saveState;
  const [modelFormOpen, setModelFormOpen] = useState(false);
  const [newModel, setNewModel] = useState<AddModelForm>(() => createDefaultAddModelForm());
  const [addingModel, setAddingModel] = useState(false);
  const [modelStatus, setModelStatus] = useState<StatusMessage>(null);
  const [cardTestResults, setCardTestResults] = useState<Record<string, StatusMessage>>({});
  const [showApiKey, setShowApiKey] = useState(false);
  const [leaderCtxEdit, setLeaderCtxEdit] = useState<number | ''>('');
  const [agentCtxEdit, setAgentCtxEdit] = useState<number | ''>('');
  const [ctxSaving, setCtxSaving] = useState<string | null>(null);
  const [ctxSaved, setCtxSaved] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [modelProviderFilter, setModelProviderFilter] = useState('');
  const [modelPage, setModelPage] = useState(1);
  const [deleteCandidate, setDeleteCandidate] = useState<ModelItem | null>(null);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [autoDetected, setAutoDetected] = useState(false);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);

  const configuredModels = useMemo<ModelItem[]>(
    () => providers.flatMap((p) => p.models.flatMap((m) => (m.provider ? [{ ...m, provider: m.provider }] : []))),
    [providers],
  );

  const configuredModelIds = useMemo(
    () => configuredModels.map((m) => m.id).filter((id, index, arr) => id && arr.indexOf(id) === index),
    [configuredModels],
  );
  const customProviderOptions = useMemo(
    () => providers.filter((p) => !['auto', 'openai', 'anthropic'].includes(p.id)),
    [providers],
  );
  const modelProviderOptions = useMemo(
    () => configuredModels.map((m) => m.provider).filter((provider, index, arr) => provider && arr.indexOf(provider) === index),
    [configuredModels],
  );

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return configuredModels.filter((model) => {
      if (modelProviderFilter && model.provider !== modelProviderFilter) return false;
      if (!q) return true;
      const haystack = [
        model.id,
        model.name,
        model.model,
        model.provider,
        model.baseUrl,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [configuredModels, modelProviderFilter, modelSearch]);

  const modelPageCount = Math.max(1, Math.ceil(filteredModels.length / MODEL_PAGE_SIZE));
  const safeModelPage = Math.min(modelPage, modelPageCount);
  const pagedModels = filteredModels.slice((safeModelPage - 1) * MODEL_PAGE_SIZE, safeModelPage * MODEL_PAGE_SIZE);

  const leaderModelId = settingString(settings.model);
  const agentModelId = settingString(settings.agentModel);
  const selectedAgentModelId = agentModelId || leaderModelId;
  const providerSetting = settingString(settings.provider, 'auto');
  const gatewayConfiguredModelId = settingString(settings.localLlmGatewayModel);
  const gatewayEffectiveModelId = settingString(settings.localLlmGatewayEffectiveModel);
  const reasoningEffort = settingString(settings.reasoningEffort, 'high');

  const selectedLeader = useMemo(() => findModel(configuredModels, leaderModelId), [configuredModels, leaderModelId]);
  const selectedAgent = useMemo(() => findModel(configuredModels, selectedAgentModelId), [configuredModels, selectedAgentModelId]);
  const selectedGateway = useMemo(
    () => findModel(configuredModels, gatewayConfiguredModelId || leaderModelId),
    [configuredModels, gatewayConfiguredModelId, leaderModelId],
  );

  const existingModel = useMemo(() => {
    if (!editingModelId) return undefined;
    return findModel(configuredModels, editingModelId);
  }, [configuredModels, editingModelId]);

  const getModelContextWindowSize = (model: string): number | undefined => {
    const item = findModel(configuredModels, model);
    return item?.contextWindowSize && item.contextWindowSize > 0 ? item.contextWindowSize : undefined;
  };

  useEffect(() => {
    const v = getModelContextWindowSize(leaderModelId);
    setLeaderCtxEdit(v ? v : '');
  }, [leaderModelId, configuredModels]);

  useEffect(() => {
    const v = getModelContextWindowSize(selectedAgentModelId);
    setAgentCtxEdit(v ? v : '');
  }, [selectedAgentModelId, configuredModels]);

  useEffect(() => {
    setModelPage(1);
  }, [modelSearch, modelProviderFilter, configuredModels.length]);

  // debounce 自动查询 models.dev 模型信息
  useEffect(() => {
    const modelName = newModel.model.trim();
    if (!modelName) {
      setAutoDetected(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await settingsApiFetch<{ data: { found: boolean; outputLimit?: number; contextLimit?: number } }>(`/model/info?model=${encodeURIComponent(modelName)}`);
        if (res.data?.found) {
          setNewModel((prev) => ({
            ...prev,
            ...(prev.maxTokens === '' && res.data.outputLimit ? { maxTokens: res.data.outputLimit } : {}),
            ...(prev.contextWindowSize === '' && res.data.contextLimit ? { contextWindowSize: res.data.contextLimit } : {}),
          }));
          setAutoDetected(true);
        } else {
          setAutoDetected(false);
        }
      } catch {
        setAutoDetected(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [newModel.model]);

  const updateNewModel = (patch: Partial<AddModelForm>) => {
    setNewModel((prev) => ({ ...prev, ...patch }));
    setModelStatus(null);
    if (patch.model !== undefined) setAutoDetected(false);
  };

  const startEditModel = (model: ModelItem) => {
    setEditingModelId(model.id);
    const existingMaxTokens = model.generationConfig?.max_tokens;
    setNewModel({
      protocol: model.provider,
      name: model.id,
      model: model.model || model.id,
      apiKey: '',
      baseUrl: model.baseUrl || DEFAULT_MODEL_BASE_URL[model.provider],
      contextWindowSize: model.contextWindowSize || '',
      maxTokens: typeof existingMaxTokens === 'number' ? existingMaxTokens : '',
    });
    setShowApiKey(false);
    setModelFormOpen(true);
    setModelStatus(null);
    setAutoDetected(false);
  };

  const resetModelForm = () => {
    setEditingModelId(null);
    setNewModel(createDefaultAddModelForm());
    setShowApiKey(false);
    setModelStatus(null);
    setAutoDetected(false);
  };

  const handleProtocolChange = (protocol: ModelProtocol) => {
    setNewModel((prev) => {
      const previousDefault = DEFAULT_MODEL_BASE_URL[prev.protocol];
      const shouldReplaceBaseUrl = !prev.baseUrl.trim() || prev.baseUrl === previousDefault;
      return { ...prev, protocol, baseUrl: shouldReplaceBaseUrl ? DEFAULT_MODEL_BASE_URL[protocol] : prev.baseUrl };
    });
    setModelStatus(null);
  };

  const handleSaveContextWindow = async (model: string, value: number | '') => {
    if (!model) return;
    setCtxSaving(model);
    try {
      await settingsApiFetch(`/settings/model-provider/${encodeURIComponent(model)}`, {
        method: 'PUT',
        body: JSON.stringify({ contextWindowSize: value === '' ? null : value }),
      });
      onProvidersChange(providers.map((p) => ({
        ...p,
        models: p.models.map((m) => m.id === model ? { ...m, contextWindowSize: value === '' ? undefined : (value as number) } : m),
      })));
      setCtxSaved(model);
      setTimeout(() => setCtxSaved(null), 2000);
    } catch (e) {
      setModelStatus({ kind: 'error', message: e instanceof Error ? e.message : t('settings.error.saveContextWindowFailed') });
    } finally {
      setCtxSaving(null);
    }
  };

  const handleAddModel = async () => {
    const modelName = newModel.model.trim();
    const displayName = newModel.name.trim() || modelName;
    const payload: Record<string, unknown> = {
      provider: newModel.protocol,
      name: displayName,
      model: modelName,
      apiKey: newModel.apiKey.trim(),
      baseUrl: newModel.baseUrl.trim(),
    };
    if (newModel.contextWindowSize !== '' && Number(newModel.contextWindowSize) > 0) {
      payload.contextWindowSize = Number(newModel.contextWindowSize);
    }
    if (newModel.maxTokens !== '' && Number(newModel.maxTokens) > 0) {
      payload.generationConfig = { max_tokens: Number(newModel.maxTokens) };
    }
    if (!payload.model || !payload.baseUrl || (!payload.apiKey && !editingModelId)) {
      setModelStatus({ kind: 'error', message: editingModelId ? t('settings.addModel.error.baseUrlRequired') : t('settings.addModel.error.required') });
      return;
    }
    setAddingModel(true);
    setModelStatus(null);
    let apiOk = false;
    try {
      if (editingModelId) {
        const existingGenConfig = existingModel?.generationConfig;
        const mergedGenConfig = {
          ...(existingGenConfig || {}),
          ...(payload.generationConfig || {}),
        };
        await settingsApiFetch(`/settings/model-provider/${encodeURIComponent(editingModelId)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: displayName,
            model: payload.model,
            provider: payload.provider,
            baseUrl: payload.baseUrl,
            ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
            ...(payload.contextWindowSize ? { contextWindowSize: payload.contextWindowSize } : {}),
            ...(Object.keys(mergedGenConfig).length > 0 ? { generationConfig: mergedGenConfig } : {}),
          }),
        });
      } else {
        await settingsApiFetch('/settings/model-provider', { method: 'POST', body: JSON.stringify(payload) });
      }
      apiOk = true;
    } catch (e) {
      setModelStatus({ kind: 'error', message: e instanceof Error ? e.message : t('settings.addModel.error.failed') });
    } finally {
      setAddingModel(false);
    }
    if (!apiOk) return;
    // API 成功后的 UI 更新与 settings 刷新分离，避免 refresh 失败掩盖操作成功
    setEditingModelId(null);
    setNewModel({ ...createDefaultAddModelForm(), protocol: newModel.protocol, baseUrl: DEFAULT_MODEL_BASE_URL[newModel.protocol] });
    setShowApiKey(false);
    setModelStatus({ kind: 'success', message: editingModelId ? t('settings.addModel.updated', { name: displayName }) : t('settings.addModel.success', { name: displayName }) });
    try {
      await onRefreshSettings();
      notifySettingChanged({ key: 'providers', value: { changedAt: Date.now() } });
    } catch {
      // refresh 失败不覆盖操作成功状态
    }
  };

  const handleDeleteModel = async (model: ModelItem) => {
    setDeletingModelId(model.id);
    setModelStatus(null);
    try {
      await settingsApiFetch(`/settings/model-provider/${encodeURIComponent(model.id)}`, { method: 'DELETE' });
    } catch (e) {
      setModelStatus({ kind: 'error', message: e instanceof Error ? e.message : t('settings.model.deleteFailed') });
      return;
    } finally {
      setDeletingModelId(null);
    }
    // DELETE 成功后的 UI 更新与 settings 刷新分离，避免 refresh 失败掩盖删除成功
    setDeleteCandidate(null);
    setModelStatus({ kind: 'success', message: t('settings.model.deleteSuccess', { name: model.id }) });
    try {
      await onRefreshSettings();
      notifySettingChanged({ key: 'providers', value: { changedAt: Date.now() } });
    } catch {
      // refresh 失败不覆盖删除成功状态，用户可手动刷新
    }
  };

  const handleTestFormConnection = async () => {
    const modelName = newModel.model.trim();
    const apiKey = newModel.apiKey.trim();
    if (!modelName || !apiKey) {
      setModelStatus({ kind: 'error', message: t('settings.addModel.error.required') });
      return;
    }
    setTestingModelId('__form__');
    setModelStatus(null);
    try {
      await settingsApiFetch('/settings/test-llm', {
        method: 'POST',
        body: JSON.stringify({
          provider: newModel.protocol,
          apiKey,
          baseUrl: newModel.baseUrl.trim(),
          model: modelName,
        }),
      });
      setModelStatus({ kind: 'success', message: t('onboarding.llm.testSuccess') });
    } catch (e) {
      setModelStatus({ kind: 'error', message: e instanceof Error ? e.message : t('onboarding.llm.testFailed') });
    } finally {
      setTestingModelId(null);
    }
  };

  const handleTestCardConnection = async (modelId: string) => {
    setTestingModelId(modelId);
    setCardTestResults((prev) => ({ ...prev, [modelId]: null }));
    try {
      await settingsApiFetch(`/settings/test-model-provider/${encodeURIComponent(modelId)}`, { method: 'POST' });
      setCardTestResults((prev) => ({ ...prev, [modelId]: { kind: 'success', message: t('onboarding.llm.testSuccess') } }));
    } catch (e) {
      setCardTestResults((prev) => ({ ...prev, [modelId]: { kind: 'error', message: e instanceof Error ? e.message : t('onboarding.llm.testFailed') } }));
    } finally {
      setTestingModelId(null);
      setTimeout(() => setCardTestResults((prev) => ({ ...prev, [modelId]: null })), 4000);
    }
  };

  const effortOptions = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'].map((value) => ({ value, label: t(`settings.effort.${value}`) }));
  const gatewayEnabled = !!settings.localLlmGatewayEnabled;
  const gatewayProvider = settingString(settings.localLlmGatewayProvider, 'openai');
  const gatewayModel = gatewayEffectiveModelId || selectedGateway?.model || gatewayConfiguredModelId || leaderModelId || '-';
  const openaiEndpoint = settingString(settings.localLlmGatewayOpenaiBaseUrl, '-');
  const anthropicEndpoint = settingString(settings.localLlmGatewayAnthropicBaseUrl, '-');

  return (
    <SettingsSection
      id="model"
      title={t('settings.group.modelAndReasoning')}
      desc={t('settings.model.desc')}
      icon={Brain}
      iconClassName="text-accent-purple"
    >
      <SettingsSubsection title={t('settings.model.activeTitle')} desc={t('settings.model.activeDesc')}>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <ModelSummaryCard
            icon={Brain}
            label={t('settings.model.summary.leader')}
            model={leaderModelId || t('settings.notSet')}
            provider={selectedLeader?.provider || providerSetting}
            sub={selectedLeader?.model && selectedLeader.model !== selectedLeader.id ? selectedLeader.model : undefined}
          />
          <ModelSummaryCard
            icon={Cpu}
            label={t('settings.model.summary.agent')}
            model={agentModelId || t('settings.item.agentModel.sameAsLeader')}
            provider={selectedAgent?.provider || selectedLeader?.provider || providerSetting}
            sub={!agentModelId && leaderModelId ? leaderModelId : selectedAgent?.model}
          />
          <ModelSummaryCard
            icon={Network}
            label={t('settings.model.summary.gateway')}
            model={gatewayEnabled ? (gatewayEffectiveModelId || gatewayConfiguredModelId || leaderModelId || t('settings.notSet')) : t('settings.model.gatewayOff')}
            provider={gatewayProvider}
            sub={gatewayEnabled ? t('settings.model.gatewayOn') : undefined}
          />
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border-muted bg-bg-primary/45 p-3 text-xs text-text-tertiary lg:flex-row lg:items-center">
          <DependencyStep icon={Database} title={t('settings.model.dag.registry')} value={`${configuredModels.length} ${t('settings.model.dag.models')}`} />
          <ArrowRight className="hidden h-4 w-4 shrink-0 text-text-muted lg:block" />
          <DependencyStep icon={Settings2} title={t('settings.model.dag.selection')} value={`${leaderModelId || '-'} / ${agentModelId || t('settings.item.agentModel.sameAsLeader')}`} />
          <ArrowRight className="hidden h-4 w-4 shrink-0 text-text-muted lg:block" />
          <DependencyStep icon={Server} title={t('settings.model.dag.gateway')} value={gatewayEnabled ? (gatewayEffectiveModelId || gatewayConfiguredModelId || leaderModelId || '-') : t('settings.model.gatewayOff')} />
          <ArrowRight className="hidden h-4 w-4 shrink-0 text-text-muted lg:block" />
          <DependencyStep icon={Sparkles} title={t('settings.model.dag.reasoning')} value={t(`settings.effort.${reasoningEffort}`)} />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.model.selectionTitle')} desc={t('settings.model.selectionDesc')}>
        <SettingsRow label={t('settings.item.provider')} desc={t('settings.item.provider.desc')} error={errors.provider}>
          <select value={providerSetting} onChange={(e) => onSave('provider', e.target.value)} className={selectClassName}>
            <option value="auto">{t('settings.provider.auto')}</option>
            <option value="openai">{t('settings.provider.openai')}</option>
            <option value="anthropic">{t('settings.provider.anthropic')}</option>
            {customProviderOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </SettingsRow>
        <ModelInputRow
          label={t('settings.item.model')}
          desc={t('settings.item.model.desc')}
          value={leaderModelId}
          suggestions={configuredModelIds}
          quickPickLabel={t('settings.item.model.quickPick')}
          saving={saving.model}
          saved={saved.model}
          error={errors.model}
          onSave={(v) => onSave('model', v)}
        />
        <ModelInputRow
          label={t('settings.item.agentModel')}
          desc={t('settings.item.agentModel.desc')}
          value={agentModelId}
          suggestions={configuredModelIds}
          quickPickLabel={t('settings.item.model.quickPick')}
          placeholder={leaderModelId ? `${t('settings.item.agentModel.sameAsLeader')} (${leaderModelId})` : t('settings.item.agentModel.sameAsLeader')}
          saving={saving.agentModel}
          saved={saved.agentModel}
          error={errors.agentModel}
          onSave={(v) => onSave('agentModel', v)}
        />
        {leaderModelId && (
          <SettingsRow label={t('settings.item.contextWindow')} desc={t('settings.item.leaderContextWindow.desc')}>
            <ContextInput value={leaderCtxEdit} setValue={setLeaderCtxEdit} model={leaderModelId} saving={ctxSaving === leaderModelId} saved={ctxSaved === leaderModelId} onSave={handleSaveContextWindow} />
          </SettingsRow>
        )}
        {selectedAgentModelId && (
          <SettingsRow label={t('settings.item.contextWindow')} desc={t('settings.item.agentContextWindow.desc')}>
            <ContextInput value={agentCtxEdit} setValue={setAgentCtxEdit} model={selectedAgentModelId} saving={ctxSaving === selectedAgentModelId} saved={ctxSaved === selectedAgentModelId} onSave={handleSaveContextWindow} />
          </SettingsRow>
        )}
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.model.libraryTitle')} desc={t('settings.model.libraryDesc')}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <ModelRegistryRow onRefreshed={onRefreshSettings} />
          <button type="button" onClick={() => setModelFormOpen((v) => { if (v) { setEditingModelId(null); setNewModel(createDefaultAddModelForm()); } return !v; })} className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded border border-border-default px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
            <Plus className="h-3.5 w-3.5" />
            {modelFormOpen ? t('settings.model.closeEditor') : t('settings.addModel')}
          </button>
        </div>

        {modelFormOpen && (
          <div className="rounded-md border border-border-default bg-bg-primary/55 p-3">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium text-text-primary">{existingModel ? t('settings.model.editModelTitle') : t('settings.model.addModelTitle')}</div>
                <div className="text-xs text-text-tertiary">{existingModel ? t('settings.model.editModelDesc') : t('settings.model.addModelDesc')}</div>
              </div>
              <button type="button" onClick={resetModelForm} className="inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
                <RotateCcw className="h-3.5 w-3.5" />
                {t('settings.reset')}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('settings.addModel.protocol')}>
                <select value={newModel.protocol} onChange={(e) => handleProtocolChange(e.target.value as ModelProtocol)} className={fieldClassName}>
                  <option value="openai">{t('settings.provider.openai')}</option>
                  <option value="anthropic">{t('settings.provider.anthropic')}</option>
                </select>
              </FormField>
              <FormField label={t('settings.addModel.name')} hint={t('settings.model.displayNameHint')}>
                <input type="text" value={newModel.name} onChange={(e) => updateNewModel({ name: e.target.value })} placeholder={t('settings.addModel.namePlaceholder')} className={fieldClassName} />
              </FormField>
              <FormField label={t('settings.addModel.model')} hint={t('settings.model.realModelHint')}>
                <input type="text" value={newModel.model} onChange={(e) => updateNewModel({ model: e.target.value })} placeholder="gpt-4o" className={`${fieldClassName} font-mono`} />
              </FormField>
              <FormField label={t('settings.addModel.apiKey')} hint={existingModel ? t('settings.addModel.apiKeyPlaceholderForUpdate') : undefined}>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={newModel.apiKey}
                    onChange={(e) => updateNewModel({ apiKey: e.target.value })}
                    placeholder={existingModel ? t('settings.addModel.apiKeyPlaceholderForUpdate') : 'sk-...'}
                    className={`${fieldClassName} pr-9 font-mono`}
                  />
                  <button type="button" onClick={() => setShowApiKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary transition-colors hover:text-text-primary" title={showApiKey ? t('settings.model.hideApiKey') : t('settings.model.showApiKey')}>
                    {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </FormField>
              <FormField label={t('settings.addModel.baseUrl')} className="sm:col-span-2">
                <input type="text" value={newModel.baseUrl} onChange={(e) => updateNewModel({ baseUrl: e.target.value })} placeholder={DEFAULT_MODEL_BASE_URL[newModel.protocol]} className={`${fieldClassName} font-mono`} />
              </FormField>
              <FormField label={t('settings.addModel.contextWindow')} hint={t('settings.addModel.contextWindowPlaceholder')}>
                <input type="number" value={newModel.contextWindowSize} onChange={(e) => updateNewModel({ contextWindowSize: e.target.value === '' ? '' : Number(e.target.value) })} min={1} placeholder="200000" className={`${fieldClassName} font-mono`} />
              </FormField>
              <FormField label={t('settings.addModel.maxTokens')} hint={autoDetected ? t('settings.addModel.autoDetected') : t('settings.addModel.maxTokensHint')}>
                <input type="number" value={newModel.maxTokens} onChange={(e) => updateNewModel({ maxTokens: e.target.value === '' ? '' : Number(e.target.value) })} min={1} placeholder={t('settings.addModel.maxTokensPlaceholder')} className={`${fieldClassName} font-mono`} />
              </FormField>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <button type="button" onClick={handleAddModel} disabled={addingModel} className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded bg-accent-brand px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                {addingModel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {existingModel ? t('settings.action.updateModel') : t('settings.addModel.save')}
              </button>
              <button type="button" onClick={handleTestFormConnection} disabled={testingModelId === '__form__'} className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded border border-border-default px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50">
                {testingModelId === '__form__' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                {t('settings.git.testConnection')}
              </button>
              {modelStatus && <StatusInline status={modelStatus} />}
            </div>
          </div>
        )}

        {configuredModels.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md border border-border-muted bg-bg-primary/40 p-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
              <input
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder={t('settings.model.searchPlaceholder')}
                className={`${fieldClassName} pl-7`}
              />
            </div>
            <select value={modelProviderFilter} onChange={(e) => setModelProviderFilter(e.target.value)} className={`${fieldClassName} lg:w-44`}>
              <option value="">{t('settings.model.allProviders')}</option>
              {modelProviderOptions.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
            {(modelSearch || modelProviderFilter) && (
              <button type="button" onClick={() => { setModelSearch(''); setModelProviderFilter(''); }} className="inline-flex min-h-8 items-center justify-center gap-1 rounded border border-border-default px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
                <X className="h-3.5 w-3.5" />
                {t('settings.model.clearFilters')}
              </button>
            )}
          </div>
        )}

        {deleteCandidate && (
          <div className="flex flex-col gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 p-3 sm:flex-row sm:items-center">
            <AlertCircle className="h-4 w-4 shrink-0 text-accent-red" />
            <div className="min-w-0 flex-1 text-xs text-text-secondary">
              {t('settings.model.deleteConfirm', { name: deleteCandidate.id })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => handleDeleteModel(deleteCandidate)} disabled={deletingModelId === deleteCandidate.id} className="inline-flex min-h-8 items-center gap-1 rounded border border-accent-red/40 bg-accent-red/10 px-3 text-xs font-medium text-accent-red transition-colors hover:bg-accent-red/20 disabled:opacity-50">
                {deletingModelId === deleteCandidate.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {t('settings.model.delete')}
              </button>
              <button type="button" onClick={() => setDeleteCandidate(null)} className="inline-flex min-h-8 items-center rounded border border-border-default px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
                {t('settings.roles.confirmCancel')}
              </button>
            </div>
          </div>
        )}

        {filteredModels.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
              {pagedModels.map((model) => (
                <ModelConfigCard
                  key={`${model.provider}:${model.id}`}
                  model={model}
                  active={model.id === leaderModelId || model.id === agentModelId || model.id === gatewayConfiguredModelId}
                  activeLabel={t('settings.model.active')}
                  tokenUnit={t('settings.model.tokenUnit')}
                  editLabel={t('settings.model.edit')}
                  deleteLabel={t('settings.model.delete')}
                  deleteDisabled={model.id === leaderModelId || model.id === agentModelId || model.id === gatewayConfiguredModelId}
                  deleteDisabledTitle={t('settings.model.deleteInUse')}
                  deleting={deletingModelId === model.id}
                  testing={testingModelId === model.id}
                  testLabel={t('settings.git.testConnection')}
                  testResult={cardTestResults[model.id] ?? null}
                  onEdit={() => startEditModel(model)}
                  onDelete={() => setDeleteCandidate(model)}
                  onTest={() => handleTestCardConnection(model.id)}
                />
              ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-border-muted pt-2 text-xs text-text-tertiary sm:flex-row sm:items-center sm:justify-between">
              <span>
                {t('settings.model.pageSummary', {
                  start: (safeModelPage - 1) * MODEL_PAGE_SIZE + 1,
                  end: Math.min(safeModelPage * MODEL_PAGE_SIZE, filteredModels.length),
                  total: filteredModels.length,
                })}
              </span>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setModelPage((p) => Math.max(1, p - 1))} disabled={safeModelPage <= 1} className="inline-flex min-h-8 items-center gap-1 rounded border border-border-default px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40">
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t('settings.model.prevPage')}
                </button>
                <span className="font-mono text-text-secondary">{safeModelPage}/{modelPageCount}</span>
                <button type="button" onClick={() => setModelPage((p) => Math.min(modelPageCount, p + 1))} disabled={safeModelPage >= modelPageCount} className="inline-flex min-h-8 items-center gap-1 rounded border border-border-default px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40">
                  {t('settings.model.nextPage')}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-border-default bg-bg-primary/45 p-4 text-sm text-text-tertiary">
            {configuredModels.length === 0 ? t('settings.model.emptyLibrary') : t('settings.model.noFilteredModels')}
          </div>
        )}
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.model.gatewayTitle')} desc={t('settings.model.gatewayDesc')}>
        <div className={`overflow-hidden rounded-md border ${gatewayEnabled ? 'border-accent-green/30 bg-accent-green/5' : 'border-border-muted bg-bg-primary/45'}`}>
          <div className="flex flex-col gap-3 border-b border-border-muted/80 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${gatewayEnabled ? 'border-accent-green/30 bg-accent-green/10 text-accent-green' : 'border-border-muted bg-bg-secondary text-text-tertiary'}`}>
                <Server className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-text-primary">{t('settings.item.localLlmGateway')}</div>
                  <StatusPill tone={gatewayEnabled ? 'success' : 'muted'} label={gatewayEnabled ? t('settings.model.gatewayOn') : t('settings.model.gatewayOff')} />
                </div>
                <div className="mt-1 max-w-3xl text-xs leading-relaxed text-text-tertiary">
                  {t('settings.item.localLlmGateway.desc')}
                </div>
                {errors.localLlmGatewayEnabled && <div className="mt-1 text-xs font-mono text-accent-red">{errors.localLlmGatewayEnabled}</div>}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end">
              <SettingsToggle value={gatewayEnabled} onChange={(v) => onSave('localLlmGatewayEnabled', v)} saving={saving.localLlmGatewayEnabled} saved={saved.localLlmGatewayEnabled} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-px bg-border-muted/70 md:grid-cols-2">
            <GatewayFieldBlock
              icon={Network}
              label={t('settings.item.localLlmGatewayProvider')}
              desc={t('settings.item.localLlmGatewayProvider.desc')}
              error={errors.localLlmGatewayProvider}
            >
              <select value={gatewayProvider} onChange={(e) => onSave('localLlmGatewayProvider', e.target.value)} className={`${fieldClassName} w-full min-w-0`}>
                <option value="openai">{t('settings.provider.openai')}</option>
                <option value="anthropic">{t('settings.provider.anthropic')}</option>
              </select>
            </GatewayFieldBlock>
            <GatewayFieldBlock
              icon={Brain}
              label={t('settings.item.localLlmGatewayModel')}
              desc={t('settings.item.localLlmGatewayModel.desc')}
              error={errors.localLlmGatewayModel}
            >
              <select value={gatewayConfiguredModelId || leaderModelId} onChange={(e) => onSave('localLlmGatewayModel', e.target.value)} className={`${fieldClassName} w-full min-w-0`}>
                {configuredModels.length === 0 && <option value="">{t('settings.modelInput.placeholder')}</option>}
                {configuredModels.map((m) => (
                  <option key={`${m.provider}:${m.id}`} value={m.id}>
                    {m.name || m.id}{m.model && m.model !== m.id ? ` (${m.model})` : ''}
                  </option>
                ))}
              </select>
            </GatewayFieldBlock>
            <GatewayFieldBlock
              icon={KeyRound}
              label={t('settings.item.localLlmGatewayInjectEnv')}
              desc={t('settings.item.localLlmGatewayInjectEnv.desc')}
              error={errors.localLlmGatewayInjectEnv}
            >
              <SettingsToggle value={settings.localLlmGatewayInjectEnv !== false} onChange={(v) => onSave('localLlmGatewayInjectEnv', v)} saving={saving.localLlmGatewayInjectEnv} saved={saved.localLlmGatewayInjectEnv} />
            </GatewayFieldBlock>
            <GatewayFieldBlock
              icon={Settings2}
              label={t('settings.item.localLlmGatewayOverrideExistingEnv')}
              desc={t('settings.item.localLlmGatewayOverrideExistingEnv.desc')}
              error={errors.localLlmGatewayOverrideExistingEnv}
            >
              <SettingsToggle value={!!settings.localLlmGatewayOverrideExistingEnv} onChange={(v) => onSave('localLlmGatewayOverrideExistingEnv', v)} saving={saving.localLlmGatewayOverrideExistingEnv} saved={saved.localLlmGatewayOverrideExistingEnv} />
            </GatewayFieldBlock>
          </div>

          <div className="bg-bg-primary/55 px-3 py-3">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-tertiary">
                <StatusPill tone={gatewayEnabled ? 'info' : 'muted'} label={gatewayProvider === 'anthropic' ? t('settings.provider.anthropic') : t('settings.provider.openai')} />
                <span>{t('settings.localLlmGateway.effectiveModel')}</span>
                <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-secondary" title={gatewayModel}>{gatewayModel}</span>
              </div>
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 lg:max-w-[58%] xl:grid-cols-2">
                <GatewayEndpoint label="OpenAI" value={openaiEndpoint} />
                <GatewayEndpoint label="Anthropic" value={anthropicEndpoint} />
              </div>
            </div>
          </div>
        </div>
      </SettingsSubsection>

      <SettingsSubsection title={t('settings.model.reasoningTitle')} desc={t('settings.model.reasoningDesc')}>
        <SettingsRow label={t('settings.item.reasoningEffort')} error={errors.reasoningEffort}>
          <select value={reasoningEffort} onChange={(e) => onSave('reasoningEffort', e.target.value)} className={selectClassName}>
            {effortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t('settings.item.alwaysThinkingEnabled')} error={errors.alwaysThinkingEnabled}>
          <SettingsToggle value={!!settings.alwaysThinkingEnabled} onChange={(v) => onSave('alwaysThinkingEnabled', v)} saving={saving.alwaysThinkingEnabled} saved={saved.alwaysThinkingEnabled} />
        </SettingsRow>
        <SettingsRow label={t('settings.item.showThinkingContent')} error={errors.showThinkingContent}>
          <SettingsToggle value={settings.showThinkingContent === true} onChange={(v) => onSave('showThinkingContent', v)} saving={saving.showThinkingContent} saved={saved.showThinkingContent} />
        </SettingsRow>
      </SettingsSubsection>
    </SettingsSection>
  );
}

const fieldClassName = 'min-h-8 w-full min-w-0 rounded border border-border-input bg-bg-input px-2 py-1.5 text-xs text-text-primary transition-colors focus:border-accent-brand';
const selectClassName = `${fieldClassName} min-w-[12rem]`;

function findModel(models: ModelItem[], model: unknown): ModelItem | undefined {
  const id = typeof model === 'string' ? model : '';
  if (!id) return undefined;
  return models.find((m) => m.id === id);
}

function formatNumber(value?: number): string {
  if (!value) return '-';
  return new Intl.NumberFormat().format(value);
}

function ModelSummaryCard({
  icon: Icon,
  label,
  model,
  provider,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  model: string;
  provider: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border-muted bg-bg-primary/55 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
        <Icon className="h-3.5 w-3.5 text-accent-brand" />
        <span>{label}</span>
      </div>
      <div className="truncate font-mono text-sm text-text-primary" title={model}>{model}</div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
        <StatusPill tone="info" label={provider} />
        {sub && <span className="min-w-0 truncate font-mono" title={sub}>{sub}</span>}
      </div>
    </div>
  );
}

function DependencyStep({
  icon: Icon,
  title,
  value,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-accent-brand" />
      <div className="min-w-0">
        <div className="text-[11px] uppercase text-text-muted">{title}</div>
        <div className="truncate font-mono text-xs text-text-secondary" title={value}>{value}</div>
      </div>
    </div>
  );
}

function FormField({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block min-w-0 space-y-1 ${className}`}>
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-relaxed text-text-tertiary">{hint}</span>}
    </label>
  );
}

function StatusInline({ status }: { status: Exclude<StatusMessage, null> }) {
  const Icon = status.kind === 'success' ? CheckCircle : AlertCircle;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 text-xs ${status.kind === 'success' ? 'text-accent-green' : 'text-accent-red'}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{status.message}</span>
    </span>
  );
}

function ModelConfigCard({
  model,
  active,
  activeLabel,
  tokenUnit,
  editLabel,
  deleteLabel,
  deleteDisabled,
  deleteDisabledTitle,
  deleting,
  testing,
  testLabel,
  testResult,
  onEdit,
  onDelete,
  onTest,
}: {
  model: ModelItem;
  active: boolean;
  activeLabel: string;
  tokenUnit: string;
  editLabel: string;
  deleteLabel: string;
  deleteDisabled: boolean;
  deleteDisabledTitle: string;
  deleting: boolean;
  testing: boolean;
  testLabel: string;
  testResult: StatusMessage;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border-muted bg-bg-primary/45 p-3 transition-colors hover:border-accent-brand/40 hover:bg-bg-hover">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm text-text-primary" title={model.id}>{model.id}</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
            <StatusPill tone={model.provider === 'anthropic' ? 'warning' : 'info'} label={model.provider} />
            {active && <StatusPill tone="success" label={activeLabel} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onTest}
            disabled={testing}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border-default text-text-tertiary transition-colors hover:border-accent-brand/40 hover:bg-accent-brand/10 hover:text-accent-brand disabled:opacity-50"
            title={testLabel}
            aria-label={testLabel}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border-default text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title={editLabel}
            aria-label={editLabel}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteDisabled || deleting}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border-default text-text-tertiary transition-colors hover:border-accent-red/40 hover:bg-accent-red/10 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border-default disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
            title={deleteDisabled ? deleteDisabledTitle : deleteLabel}
            aria-label={deleteLabel}
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-1 text-[11px] text-text-tertiary">
        <div className="truncate font-mono" title={model.model || model.id}>{model.model || model.id}</div>
        <div className="truncate font-mono" title={model.baseUrl}>{model.baseUrl || '-'}</div>
        <div className="flex items-center gap-1.5">
          <Gauge className="h-3 w-3" />
          <span>{formatNumber(model.contextWindowSize)} {tokenUnit}</span>
        </div>
      </div>
      {testResult && (
        <div className={`mt-2 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] ${testResult.kind === 'success' ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'}`}>
          {testResult.kind === 'success' ? <CheckCircle className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {testResult.message}
        </div>
      )}
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'success' | 'warning' | 'info' | 'muted' }) {
  const toneClass = {
    success: 'border-accent-green/30 bg-accent-green/10 text-accent-green',
    warning: 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow',
    info: 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue',
    muted: 'border-border-default bg-bg-tertiary text-text-tertiary',
  }[tone];
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${toneClass}`}>{label}</span>;
}

function GatewayFieldBlock({
  icon: Icon,
  label,
  desc,
  error,
  children,
}: {
  icon: LucideIcon;
  label: string;
  desc: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-bg-card/75 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-muted bg-bg-secondary text-text-tertiary">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">{label}</div>
          <div className="mt-1 min-h-[2.25rem] max-w-xl text-xs leading-relaxed text-text-tertiary">{desc}</div>
          {error && <div className="mt-1 text-xs font-mono text-accent-red">{error}</div>}
        </div>
      </div>
      <div className="mt-3 flex min-h-9 items-center justify-end">{children}</div>
    </div>
  );
}

function GatewayEndpoint({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-border-muted bg-bg-secondary/75 px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase text-text-tertiary">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-text-secondary" title={value}>{value}</div>
    </div>
  );
}

function ContextInput({
  value,
  setValue,
  model,
  saving,
  saved,
  onSave,
}: {
  value: number | '';
  setValue: (value: number | '') => void;
  model: string;
  saving: boolean;
  saved: boolean;
  onSave: (model: string, value: number | '') => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
        onBlur={() => { if (value !== '' && value > 0) onSave(model, value); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && value !== '' && value > 0) onSave(model, value); }}
        placeholder="200000"
        min={1}
        className="min-h-8 w-40 min-w-0 rounded border border-border-input bg-bg-input px-2 py-1 text-xs font-mono text-text-primary transition-colors focus:border-accent-brand"
      />
      {saving && <Loader2 className="h-3 w-3 text-accent-brand animate-spin" />}
      {saved && <Save className="h-3 w-3 text-accent-green" />}
    </div>
  );
}
