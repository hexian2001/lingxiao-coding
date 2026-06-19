/**
 * PluginsView — 插件管理器
 *
 * 已安装列表 + 工具管理 + MCP servers + Marketplace
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getServerToken } from '../../api/headers';
import { useSessionStore } from '../../stores/sessionStore';
import {
  Puzzle, Trash2, RefreshCw, Search,
  Loader2, AlertTriangle, ToggleLeft, ToggleRight, Wrench, Server, Store, BookOpen, Terminal, Bot, Hammer,
} from 'lucide-react';
import ToolsTab from './ToolsTab';
import McpServersTab from './McpServersTab';
import MarketplaceTab from './MarketplaceTab';
import SkillsTab from './SkillsTab';
import CommandsTab from './CommandsTab';
import AgentsTab from './AgentsTab';
import ForgeTab from './ForgeTab';

interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  scope?: string;
  counts?: {
    skills: number;
    mcp: number;
    apps: number;
    assets: number;
    tools: number;
    hooks: number;
    scripts: number;
  };
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function PluginsView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'installed' | 'skills' | 'commands' | 'agents' | 'tools' | 'mcp' | 'forge' | 'marketplace'>('installed');

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const pluginsData = await apiFetch<{ data: Plugin[] }>(
        `/plugins${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
      );
      setPlugins(pluginsData.data || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleTogglePlugin = async (plugin: Plugin) => {
    try {
      await apiFetch(`/plugins/${plugin.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !plugin.enabled, sessionId }),
      });
      setPlugins((prev) => prev.map((p) => p.id === plugin.id ? { ...p, enabled: !p.enabled } : p));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle plugin');
    }
  };

  const handleDeletePlugin = async (plugin: Plugin) => {
    try {
      await apiFetch(`/plugins/${plugin.id}`, { method: 'DELETE' });
      setPlugins((prev) => prev.filter((p) => p.id !== plugin.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plugin');
    }
  };

  const filteredPlugins = search
    ? plugins.filter((p) => `${p.name} ${p.id} ${p.description}`.toLowerCase().includes(search.toLowerCase()))
    : plugins;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="codex-topbar px-5 py-4 border-b border-border-muted backdrop-blur-2xl shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
            <Puzzle className="w-4 h-4" />
            {t('plugins.title')}
          </h2>
          <button onClick={fetchData} className="codex-icon-btn !h-8 !min-w-8">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <div className="flex gap-2 mt-2">
          <button
            className={`codex-chip px-3 py-1.5 text-xs transition-colors ${activeTab === 'installed' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('installed')}
          >
            {t('plugins.installed') || 'Installed'} ({plugins.length})
          </button>
          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'skills' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('skills')}
          >
            <BookOpen className="w-3 h-3" />
            {t('skills.title')}
          </button>
          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'commands' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('commands')}
          >
            <Terminal className="w-3 h-3" />
            {t('commands.title')}
          </button>
          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'agents' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('agents')}
          >
            <Bot className="w-3 h-3" />
            {t('agents.title')}
          </button>
          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'tools' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('tools')}
          >
            <Wrench className="w-3 h-3" />
            {t('tools.title')}
          </button>
          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'mcp' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('mcp')}
          >
            <Server className="w-3 h-3" />
            {t('mcp.title')}
          </button>
          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'marketplace' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('marketplace')}
          >
            <Store className="w-3 h-3" />
            {t('plugins.browseMarketplace')}
          </button>          <button
            className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1 transition-colors ${activeTab === 'forge' ? 'text-text-primary' : 'text-text-tertiary'}`}
            onClick={() => setActiveTab('forge')}
          >
            <Hammer className="w-3 h-3" />
            {t('forge.title') || 'Forge'}
          </button>
          <div className="flex-1" />
          {activeTab === 'installed' && <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('plugins.search') || 'Search plugins...'}
              className="pl-7 pr-2 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary w-48 outline-none focus:border-border-default"
            />
          </div>}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'tools' ? (
          <ToolsTab />
        ) : activeTab === 'skills' ? (
          <SkillsTab />
        ) : activeTab === 'commands' ? (
          <CommandsTab />
        ) : activeTab === 'agents' ? (
          <AgentsTab />
        ) : activeTab === 'mcp' ? (
          <McpServersTab />
        ) : activeTab === 'forge' ? (
          <ForgeTab />
        ) : activeTab === 'marketplace' ? (
          <MarketplaceTab onInstalled={fetchData} />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : (
          filteredPlugins.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
              <Puzzle className="w-8 h-8 mb-2" />
              <p className="text-sm">{t('plugins.noPlugins') || 'No plugins installed'}</p>
            </div>
          ) : (
            <div className="divide-y divide-border-muted">
              {filteredPlugins.map((plugin) => (
                <div key={plugin.id} className="px-5 py-3.5 flex items-center gap-3 hover:bg-bg-hover/70 transition-colors">
                  <Puzzle className="w-5 h-5 text-text-tertiary" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-primary">{plugin.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                        {plugin.scope || 'plugin'}
                      </span>
                      {plugin.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                          disabled
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-tertiary mt-0.5">{plugin.description}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {[
                        ['skills', plugin.counts?.skills],
                        ['mcp', plugin.counts?.mcp],
                        ['apps', plugin.counts?.apps],
                        ['tools', plugin.counts?.tools],
                        ['hooks', plugin.counts?.hooks],
                      ].filter(([, count]) => Number(count) > 0).map(([label, count]) => (
                        <span key={label} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                          {label}:{count}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs text-text-tertiary">{plugin.version}</span>
                  <button className={`p-1 ${plugin.enabled ? 'text-accent-green' : 'text-text-tertiary'}`} onClick={() => handleTogglePlugin(plugin)} title={plugin.enabled ? t('plugins.disable') || 'Disable' : t('plugins.enable') || 'Enable'}>
                    {plugin.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                  </button>
                  <button className="p-1 text-text-tertiary hover:text-accent-red" onClick={() => handleDeletePlugin(plugin)} title={t('plugins.uninstall') || 'Uninstall'}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
