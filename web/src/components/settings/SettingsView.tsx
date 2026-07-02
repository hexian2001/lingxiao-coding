import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Database, GitBranch, Globe, Loader2, Monitor, Settings, Shield, Zap, Users, Info, Server, Activity, Layers, FileText } from 'lucide-react';
import { useThemeStore } from '../../stores/themeStore';
import { SettingsNav, type SettingsNavGroup } from './components/SettingsNav';
import { notifySettingChanged, SETTINGS_CHANGED_EVENT, settingsApiFetch, type SettingsChangedDetail } from './settingsApi';
import type { ExternalAgentsStatus, ProviderInfo, SaveResult, SaveState, SettingsData, SystemInfoData } from './types';
import { ModelAndReasoningSection } from './sections/ModelAndReasoningSection';
import { GitIntegrationSection } from './sections/GitIntegrationSection';
import { BehaviorSection } from './sections/BehaviorSection';
import { MemorySection } from './sections/MemorySection';
import { NetworkProxySection } from './sections/NetworkProxySection';
import { McpSection } from './sections/McpSection';
import { SecuritySection } from './sections/SecuritySection';
import { AdvancedSection } from './sections/AdvancedSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { RolesSection } from './sections/RolesSection';
import { PromptsSection } from './sections/PromptsSection';
import { SystemInfoSection } from './sections/SystemInfoSection';
import { LangfuseSection } from './sections/LangfuseSection';
import { ContextSection } from './sections/ContextSection';

function isProviderInfoArray(value: unknown): value is ProviderInfo[] {
  return Array.isArray(value) && value.every((provider) => (
    provider !== null &&
    typeof provider === 'object' &&
    typeof (provider as { id?: unknown }).id === 'string' &&
    typeof (provider as { name?: unknown }).name === 'string' &&
    Array.isArray((provider as { models?: unknown }).models)
  ));
}

export default function SettingsView() {
  const { t, i18n } = useTranslation();
  const { mode, setMode } = useThemeStore();
  const [settings, setSettings] = useState<SettingsData>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfoData | null>(null);
  const [externalAgentsStatus, setExternalAgentsStatus] = useState<ExternalAgentsStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [activeSection, setActiveSection] = useState('model');
  const [navSearch, setNavSearch] = useState('');

  const saveState: SaveState = useMemo(() => ({ saving, saved, errors: fieldErrors }), [saving, saved, fieldErrors]);

  const fetchSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const [settingsData, infoData, externalAgentsData] = await Promise.all([
        settingsApiFetch<{ data: SettingsData }>('/settings'),
        settingsApiFetch<{ data: SystemInfoData }>('/info'),
        settingsApiFetch<{ data: ExternalAgentsStatus | null }>('/settings/external-agents/status').catch(() => ({ data: null })),
      ]);
      const data = settingsData.data || {};
      setSettings(data);
      setProviders(isProviderInfoArray(data.providers) ? data.providers : []);
      setSystemInfo(infoData.data || null);
      setExternalAgentsStatus(externalAgentsData.data || null);
    } catch {
    } finally {
      setIsLoading(false);
    }
  }, [i18n]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SettingsChangedDetail>).detail;
      if (!detail?.key) return;
      setSettings((prev) => ({ ...prev, [detail.key]: detail.value }));
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
  }, []);

  const handleSave = useCallback(async (key: string, value: unknown): Promise<SaveResult> => {
    setSaving((prev) => ({ ...prev, [key]: true }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    try {
      const response = await settingsApiFetch<{ success?: boolean; key?: string; value?: unknown }>('/settings/general', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
      });
      const savedValue = Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : value;
      setSettings((prev) => ({ ...prev, [key]: savedValue }));
      notifySettingChanged({ key, value: savedValue });
      setSaved((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setSaved((prev) => ({ ...prev, [key]: false })), 2000);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : t('settings.saveFailed');
      setFieldErrors((prev) => ({ ...prev, [key]: message }));
      return { ok: false, error: message };
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  }, [t]);

  // 分组导航：常用 / 高级 / 专家与系统。点击只切换单个面板，避免超长滚动 + 锚点跳转引发的“顶飞/底部空白”。
  const navGroups = useMemo<SettingsNavGroup[]>(() => [
    {
      id: 'common',
      label: t('settings.navGroup.common', '常用'),
      items: [
        { id: 'model', label: t('settings.group.modelAndReasoning'), icon: Brain, keywords: 'model reasoning 模型 推理 api key' },
        { id: 'appearance', label: t('settings.appearance'), icon: Monitor, keywords: 'appearance theme language 外观 主题 语言' },
        { id: 'behavior', label: t('settings.group.behavior'), icon: Zap, keywords: 'behavior 行为' },
      ],
    },
    {
      id: 'advanced',
      label: t('settings.navGroup.advanced', '高级'),
      items: [
        { id: 'context', label: t('settings.group.context'), icon: Layers, keywords: 'context 上下文 compact' },
        { id: 'memory', label: t('settings.group.memory'), icon: Database, keywords: 'memory 记忆' },
        { id: 'network-proxy', label: t('settings.group.networkProxy'), icon: Globe, keywords: 'network proxy 网络 代理' },
        { id: 'mcp', label: t('settings.group.mcp'), icon: Server, keywords: 'mcp server 服务' },
        { id: 'git', label: t('settings.group.gitIntegration'), icon: GitBranch, keywords: 'git integration 集成' },
        { id: 'roles', label: t('settings.roles.title'), icon: Users, keywords: 'roles agent 角色' },
        { id: 'prompts', label: t('settings.group.prompts'), icon: FileText, keywords: 'prompts 提示词' },
      ],
    },
    {
      id: 'expert',
      label: t('settings.navGroup.expert', '专家与系统'),
      items: [
        { id: 'security', label: t('settings.group.sandbox'), icon: Shield, keywords: 'security sandbox 沙箱 安全 加固' },
        { id: 'advanced-settings', label: t('settings.group.advanced'), icon: Settings, keywords: 'advanced 高级' },
        { id: 'langfuse', label: t('settings.group.langfuse', 'Langfuse'), icon: Activity, keywords: 'langfuse 可观测' },
        { id: 'system', label: t('settings.systemInfo'), icon: Info, keywords: 'system info 系统 信息' },
      ],
    },
  ], [t]);

  const renderSection = () => {
    switch (activeSection) {
      case 'model':
        return <ModelAndReasoningSection settings={settings} providers={providers} saveState={saveState} onSave={handleSave} onProvidersChange={setProviders} onRefreshSettings={fetchSettings} />;
      case 'appearance':
        return <AppearanceSection mode={mode} setMode={setMode} settings={settings} saveState={saveState} i18n={i18n} onSave={handleSave} />;
      case 'behavior':
        return <BehaviorSection settings={settings} saveState={saveState} externalAgentsStatus={externalAgentsStatus} onSave={handleSave} />;
      case 'context':
        return <ContextSection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'memory':
        return <MemorySection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'network-proxy':
        return <NetworkProxySection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'mcp':
        return <McpSection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'git':
        return <GitIntegrationSection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'roles':
        return <RolesSection />;
      case 'prompts':
        return <PromptsSection />;
      case 'security':
        return <SecuritySection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'advanced-settings':
        return <AdvancedSection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'langfuse':
        return <LangfuseSection settings={settings} saveState={saveState} onSave={handleSave} />;
      case 'system':
        return systemInfo
          ? <SystemInfoSection systemInfo={systemInfo} />
          : <div className="rounded-lg border border-border-default bg-bg-secondary/80 p-4 text-xs text-text-tertiary">{t('settings.systemInfo.na')}</div>;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border-default bg-bg-secondary shrink-0">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Settings className="w-4 h-4" />
          {t('settings.title')}
        </h2>
      </div>

      <div className="flex-1 overflow-hidden p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : (
          <div className="flex h-full max-w-7xl flex-col gap-4 lg:flex-row lg:items-start">
            <SettingsNav
              groups={navGroups}
              activeId={activeSection}
              onSelect={setActiveSection}
              search={navSearch}
              onSearchChange={setNavSearch}
            />
            <div className="min-w-0 flex-1 overflow-y-auto lg:h-full lg:pr-1">
              {renderSection()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
