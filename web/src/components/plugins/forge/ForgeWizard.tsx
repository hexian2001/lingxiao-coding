/**
 * ForgeWizard — 生成向导（需求输入 → 模板选择 → 参数配置）
 *
 * 3 步流程:
 * 1. 需求描述 + serverName
 * 2. 模板选择（可选，支持 auto-detect）
 * 3. 参数配置（transport/skipValidation/autoRegister 等）
 *
 * 提交后调用 onGenerate 回调
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Sparkles,
  FileCode,
  Settings,
  PenLine,
} from 'lucide-react';
import {
  listTemplates,
  ForgeApiError,
} from './api';
import type { TemplateSummary, GenerateRequest } from './types';

interface ForgeWizardProps {
  onGenerate: (req: GenerateRequest) => void;
  onCancel: () => void;
}

type WizardStep = 0 | 1 | 2;

export default function ForgeWizard({ onGenerate, onCancel }: ForgeWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(0);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Step 0: 需求描述
  const [description, setDescription] = useState('');
  const [serverName, setServerName] = useState('');

  // Step 1: 模板选择
  const [templateId, setTemplateId] = useState<string>('');

  // Step 2: 参数配置
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('stdio');
  const [skipValidation, setSkipValidation] = useState(false);
  const [skipInspector, setSkipInspector] = useState(false);
  const [autoRegister, setAutoRegister] = useState(true);
  const [llmModel, setLlmModel] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(120);

  // Validation
  const [descError, setDescError] = useState('');
  const [nameError, setNameError] = useState('');

  useEffect(() => {
    setLoadingTemplates(true);
    listTemplates()
      .then(setTemplates)
      .catch(() => { /* ignore, templates are optional */ })
      .finally(() => setLoadingTemplates(false));
  }, []);

  function validateStep0(): boolean {
    let ok = true;
    if (!description.trim() || description.trim().length < 10) {
      setDescError(t('forge.error.descTooShort') || 'Description must be at least 10 characters');
      ok = false;
    } else {
      setDescError('');
    }
    if (!serverName.trim()) {
      setNameError(t('forge.error.nameRequired') || 'Server name is required');
      ok = false;
    } else if (!/^[a-z0-9][a-z0-9_-]*$/.test(serverName)) {
      setNameError(t('forge.error.nameFormat') || 'Must match ^[a-z0-9][a-z0-9_-]*$');
      ok = false;
    } else {
      setNameError('');
    }
    return ok;
  }

  function handleNext() {
    if (step === 0 && !validateStep0()) return;
    setStep((s) => Math.min(s + 1, 2) as WizardStep);
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 0) as WizardStep);
  }

  function handleSubmit() {
    onGenerate({
      description: description.trim(),
      serverName: serverName.trim(),
      templateId: templateId || undefined,
      options: {
        transport,
        skipValidation,
        skipInspector,
        autoRegister,
        ...(llmModel ? { llmModel } : {}),
      },
      timeoutMs: timeoutMs * 1000,
    });
  }

  const stepIcons = [PenLine, FileCode, Settings];
  const stepLabels = [
    t('forge.wizard.stepRequirement') || 'Requirement',
    t('forge.wizard.stepTemplate') || 'Template',
    t('forge.wizard.stepOptions') || 'Options',
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Step indicator */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border-muted">
        {stepLabels.map((label, i) => {
          const Icon = stepIcons[i];
          const isActive = step === i;
          const isDone = step > i;
          return (
            <div key={i} className="flex items-center gap-2">
              {i > 0 && <div className={`w-8 h-px ${isDone ? 'bg-accent-brand' : 'bg-border-default'}`} />}
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                  isActive
                    ? 'bg-accent-brand/20 text-accent-brand'
                    : isDone
                    ? 'text-accent-green'
                    : 'text-text-tertiary'
                }`}
              >
                {isDone ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Icon className="w-3.5 h-3.5" />
                )}
                <span>{label}</span>
              </div>
            </div>
          );
        })}
        <div className="flex-1" />
        <button
          onClick={onCancel}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {t('app.cancel') || 'Cancel'}
        </button>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {/* Step 0: Requirement */}
        {step === 0 && (
          <div className="space-y-4 max-w-2xl">
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">
                {t('forge.wizard.description') || 'Description'}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder={t('forge.wizard.descriptionPlaceholder') || 'Describe the MCP server you want to create. e.g., "A weather server that provides current weather and forecast tools using the Open-Meteo API"'}
                className="w-full px-3 py-2 text-sm bg-bg-input/80 border border-border-input rounded text-text-primary resize-none outline-none focus:border-border-default"
                autoFocus
              />
              {descError && <p className="text-xs text-accent-red mt-1">{descError}</p>}
              <p className="text-[10px] text-text-tertiary mt-1">
                {description.length}/4000
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">
                {t('forge.wizard.serverName') || 'Server Name'}
              </label>
              <input
                type="text"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder="weather-server"
                className="w-full px-3 py-2 text-sm bg-bg-input/80 border border-border-input rounded text-text-primary outline-none focus:border-border-default"
              />
              {nameError && <p className="text-xs text-accent-red mt-1">{nameError}</p>}
              <p className="text-[10px] text-text-tertiary mt-1">
                {t('forge.wizard.serverNameHint') || 'Lowercase letters, numbers, hyphens, underscores. Must start with alphanumeric.'}
              </p>
            </div>
          </div>
        )}

        {/* Step 1: Template */}
        {step === 1 && (
          <div className="space-y-3 max-w-2xl">
            <p className="text-xs text-text-tertiary mb-3">
              {t('forge.wizard.templateHint') || 'Select a template or leave empty for auto-detection during analysis.'}
            </p>
            {/* Auto-detect option */}
            <button
              onClick={() => setTemplateId('')}
              className={`w-full text-left p-3 rounded border transition-colors ${
                templateId === ''
                  ? 'border-accent-brand bg-accent-brand/10'
                  : 'border-border-default hover:border-border-default hover:bg-bg-hover'
              }`}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-accent-brand" />
                <span className="text-sm text-text-primary font-medium">
                  {t('forge.wizard.autoDetect') || 'Auto-detect'}
                </span>
              </div>
              <p className="text-xs text-text-tertiary mt-1">
                {t('forge.wizard.autoDetectHint') || 'Let the LLM analyze your requirements and choose the best template.'}
              </p>
            </button>
            {/* Template options */}
            {loadingTemplates ? (
              <div className="flex items-center gap-2 py-4 text-text-tertiary">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-xs">{t('forge.loadingTemplates') || 'Loading templates...'}</span>
              </div>
            ) : (
              templates.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => setTemplateId(tpl.id)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    templateId === tpl.id
                      ? 'border-accent-brand bg-accent-brand/10'
                      : 'border-border-default hover:bg-bg-hover'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-text-secondary" />
                    <span className="text-sm text-text-primary font-medium">{tpl.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                      {tpl.language}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                      {tpl.transport}
                    </span>
                  </div>
                  <p className="text-xs text-text-tertiary mt-1">{tpl.description}</p>
                  <p className="text-[10px] text-text-tertiary mt-1">
                    {t('forge.wizard.framework') || 'Framework'}: {tpl.framework}
                  </p>
                </button>
              ))
            )}
          </div>
        )}

        {/* Step 2: Options */}
        {step === 2 && (
          <div className="space-y-4 max-w-2xl">
            {/* Transport */}
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">
                {t('forge.wizard.transport') || 'Transport'}
              </label>
              <div className="flex gap-2">
                {(['stdio', 'streamable-http'] as const).map((t_val) => (
                  <button
                    key={t_val}
                    onClick={() => setTransport(t_val)}
                    className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                      transport === t_val
                        ? 'border-accent-brand bg-accent-brand/10 text-accent-brand'
                        : 'border-border-default text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    {t_val}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-2.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipValidation}
                  onChange={(e) => setSkipValidation(e.target.checked)}
                  className="accent-accent-brand"
                />
                <span className="text-sm text-text-primary">
                  {t('forge.wizard.skipValidation') || 'Skip validation (sandbox + inspector)'}
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipInspector}
                  onChange={(e) => setSkipInspector(e.target.checked)}
                  disabled={skipValidation}
                  className="accent-accent-brand disabled:opacity-40"
                />
                <span className="text-sm text-text-primary">
                  {t('forge.wizard.skipInspector') || 'Skip inspector (tool call verification)'}
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRegister}
                  onChange={(e) => setAutoRegister(e.target.checked)}
                  className="accent-accent-brand"
                />
                <span className="text-sm text-text-primary">
                  {t('forge.wizard.autoRegister') || 'Auto-register server after generation'}
                </span>
              </label>
            </div>

            {/* LLM Model */}
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">
                {t('forge.wizard.llmModel') || 'LLM Model (optional)'}
              </label>
              <input
                type="text"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="default"
                className="w-full px-3 py-2 text-sm bg-bg-input/80 border border-border-input rounded text-text-primary outline-none focus:border-border-default"
              />
            </div>

            {/* Timeout */}
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">
                {t('forge.wizard.timeout') || 'Timeout (seconds)'}
              </label>
              <input
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Math.max(10, Math.min(600, Number(e.target.value) || 120)))}
                min={10}
                max={600}
                className="w-24 px-3 py-2 text-sm bg-bg-input/80 border border-border-input rounded text-text-primary outline-none focus:border-border-default"
              />
            </div>
          </div>
        )}
      </div>

      {/* Footer navigation */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-border-muted">
        <button
          onClick={handleBack}
          disabled={step === 0}
          className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('forge.wizard.back') || 'Back'}
        </button>
        {step < 2 ? (
          <button
            onClick={handleNext}
            className="flex items-center gap-1 px-4 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 transition-opacity"
          >
            {t('forge.wizard.next') || 'Next'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            className="flex items-center gap-1 px-4 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 transition-opacity"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {t('forge.wizard.generate') || 'Generate'}
          </button>
        )}
      </div>
    </div>
  );
}
