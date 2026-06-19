import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Download,
  Edit3,
  Filter,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  SlidersHorizontal,
  Store,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { getServerToken } from '../../api/headers';
import { useSessionStore } from '../../stores/sessionStore';

type MarketplaceKind = 'mcp' | 'skill' | 'plugin';
type MarketplaceSourceType = 'mcp_registry' | 'skill_index' | 'plugin_index';
type MarketplaceSearchField = 'id' | 'name' | 'title' | 'description' | 'version' | 'source' | 'transport' | 'repository' | 'remote';
type TriFilter = 'all' | 'yes' | 'no';
type JsonRecord = Record<string, unknown>;

interface MarketplaceSource {
  id: string;
  title?: string;
  type: MarketplaceSourceType;
  url?: string;
  enabled?: boolean;
  official?: boolean;
}

interface MarketplaceEntry {
  id: string;
  kind: MarketplaceKind;
  sourceId: string;
  name: string;
  title?: string;
  description: string;
  version?: string;
  installed: boolean;
  installable: boolean;
  transport?: string;
  remoteUrl?: string;
  repositoryUrl?: string;
}

interface MarketState {
  entries: MarketplaceEntry[];
  sourceId: string;
  query: string;
  fields: MarketplaceSearchField[];
  installed: TriFilter;
  installable: TriFilter;
  transport: string;
  nextCursor?: string;
  lastFetchedAt?: number;
  isLoading: boolean;
}

const PAGE_SIZE = 60;

const MARKETPLACE_KIND_VALUES = ['mcp', 'skill', 'plugin'] as const satisfies readonly MarketplaceKind[];
const MARKETPLACE_SOURCE_TYPE_VALUES = ['mcp_registry', 'skill_index', 'plugin_index'] as const satisfies readonly MarketplaceSourceType[];
const TRI_FILTER_VALUES = ['all', 'yes', 'no'] as const satisfies readonly TriFilter[];
const MARKETPLACE_KIND_SET = new Set<MarketplaceKind>(MARKETPLACE_KIND_VALUES);
const MARKETPLACE_SOURCE_TYPE_SET = new Set<MarketplaceSourceType>(MARKETPLACE_SOURCE_TYPE_VALUES);
const TRI_FILTER_SET = new Set<TriFilter>(TRI_FILTER_VALUES);

const SOURCE_TYPE_BY_KIND: Record<MarketplaceKind, MarketplaceSourceType> = {
  mcp: 'mcp_registry',
  skill: 'skill_index',
  plugin: 'plugin_index',
};

const KIND_BY_SOURCE_TYPE: Record<MarketplaceSourceType, MarketplaceKind> = {
  mcp_registry: 'mcp',
  skill_index: 'skill',
  plugin_index: 'plugin',
};

const MARKET_CONFIG: Record<MarketplaceKind, { label: string; empty: string; placeholder: string; allSources: string; icon: LucideIcon }> = {
  mcp: {
    label: 'MCP Market',
    empty: 'No MCP servers found',
    placeholder: 'Search MCP servers',
    allSources: 'All MCP registries',
    icon: Server,
  },
  skill: {
    label: 'Skills Market',
    empty: 'No skills found',
    placeholder: 'Search skills',
    allSources: 'All skill indexes',
    icon: BookOpen,
  },
  plugin: {
    label: 'Plugins Market',
    empty: 'No plugins found',
    placeholder: 'Search plugins',
    allSources: 'All plugin indexes',
    icon: Package,
  },
};

const SEARCH_FIELDS: Array<{ value: MarketplaceSearchField; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'title', label: 'Title' },
  { value: 'description', label: 'Description' },
  { value: 'source', label: 'Source' },
  { value: 'version', label: 'Version' },
  { value: 'transport', label: 'Transport' },
  { value: 'repository', label: 'Repository' },
  { value: 'remote', label: 'Remote' },
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | null {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : null;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseMarketplaceKind(value: unknown): MarketplaceKind | null {
  return parseOneOf(value, MARKETPLACE_KIND_SET);
}

function parseMarketplaceSourceType(value: unknown, fallback?: MarketplaceSourceType): MarketplaceSourceType | null {
  return parseOneOf(value, MARKETPLACE_SOURCE_TYPE_SET) ?? fallback ?? null;
}

function parseTriFilter(value: unknown, fallback: TriFilter): TriFilter {
  return parseOneOf(value, TRI_FILTER_SET) ?? fallback;
}

function parseMarketplaceSource(value: unknown): MarketplaceSource | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const type = parseMarketplaceSourceType(value.type);
  if (!id || !type) return null;
  return {
    id,
    title: readOptionalString(value.title),
    type,
    url: readOptionalString(value.url),
    enabled: readBoolean(value.enabled, true),
    official: readBoolean(value.official, false),
  };
}

function parseMarketplaceEntry(value: unknown): MarketplaceEntry | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const kind = parseMarketplaceKind(value.kind);
  if (!id || !kind) return null;
  const name = readString(value.name, id);
  return {
    id,
    kind,
    sourceId: readString(value.sourceId),
    name,
    title: readOptionalString(value.title),
    description: readString(value.description),
    version: readOptionalString(value.version),
    installed: readBoolean(value.installed, false),
    installable: readBoolean(value.installable, false),
    transport: readOptionalString(value.transport),
    remoteUrl: readOptionalString(value.remoteUrl),
    repositoryUrl: readOptionalString(value.repositoryUrl),
  };
}

function parseSourceList(value: unknown): MarketplaceSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parseMarketplaceSource(item);
    return parsed ? [parsed] : [];
  });
}

function parseEntryList(value: unknown): MarketplaceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parseMarketplaceEntry(item);
    return parsed ? [parsed] : [];
  });
}

function parseMarketplacesResponse(value: unknown): {
  sources: MarketplaceSource[];
  entries: MarketplaceEntry[];
  nextCursor?: string;
  fetchedAt?: number;
} {
  if (!isRecord(value)) return { sources: [], entries: [] };
  return {
    sources: parseSourceList(value.sources),
    entries: parseEntryList(value.entries),
    nextCursor: readOptionalString(value.nextCursor),
    fetchedAt: readOptionalNumber(value.fetchedAt),
  };
}

function parseSourcesResponse(value: unknown): MarketplaceSource[] {
  if (isRecord(value)) return parseSourceList(value.data);
  return parseSourceList(value);
}

function parseSourceMutationResponse(value: unknown): MarketplaceSource {
  const parsed = isRecord(value) ? parseMarketplaceSource(value.data) : null;
  const fallback = parsed ?? parseMarketplaceSource(value);
  if (!fallback) throw new Error('Invalid marketplace source response');
  return fallback;
}

function errorMessageFromBody(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const message = readOptionalString(value.message);
  if (message) return message;
  return readOptionalString(value.error) ?? null;
}

function formatFetchedAt(value?: number): string {
  if (!value) return 'not refreshed';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function initialMarketState(): MarketState {
  return {
    entries: [],
    sourceId: '',
    query: '',
    fields: [],
    installed: 'all',
    installable: 'all',
    transport: '',
    isLoading: false,
  };
}

function initialMarkets(): Record<MarketplaceKind, MarketState> {
  return {
    mcp: initialMarketState(),
    skill: initialMarketState(),
    plugin: initialMarketState(),
  };
}

function emptySource(kind: MarketplaceKind): MarketplaceSource {
  return {
    id: '',
    title: '',
    type: SOURCE_TYPE_BY_KIND[kind],
    url: kind === 'mcp' ? 'https://registry.modelcontextprotocol.io' : '',
    enabled: true,
  };
}

function mergeEntries(previous: MarketplaceEntry[], incoming: MarketplaceEntry[]): MarketplaceEntry[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return Array.from(byId.values());
}

function filterToQuery(value: TriFilter): string | undefined {
  if (value === 'yes') return 'true';
  if (value === 'no') return 'false';
  return undefined;
}

function kindBadgeClass(kind: MarketplaceKind): string {
  if (kind === 'mcp') return 'bg-accent-blue/20 text-accent-blue';
  if (kind === 'plugin') return 'bg-accent-green/20 text-accent-green';
  return 'bg-accent-purple/20 text-accent-purple';
}

async function apiFetch(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessageFromBody(body) || `HTTP ${res.status}`);
  return body;
}

export default function MarketplaceTab({ onInstalled }: { onInstalled?: () => void }) {
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const [activeKind, setActiveKind] = useState<MarketplaceKind>('mcp');
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [allSources, setAllSources] = useState<MarketplaceSource[]>([]);
  const [markets, setMarkets] = useState<Record<MarketplaceKind, MarketState>>(initialMarkets);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [editingSource, setEditingSource] = useState<MarketplaceSource | null>(null);
  const [savingSource, setSavingSource] = useState(false);

  const activeMarket = markets[activeKind];
  const activeConfig = MARKET_CONFIG[activeKind];

  const enabledSources = useMemo(
    () => (sources.length > 0 ? sources : allSources.filter((source) => source.enabled !== false)),
    [allSources, sources],
  );

  const activeSources = useMemo(
    () => enabledSources.filter((source) => source.enabled !== false && source.type === SOURCE_TYPE_BY_KIND[activeKind]),
    [activeKind, enabledSources],
  );

  const updateMarket = useCallback((kind: MarketplaceKind, patch: Partial<MarketState>) => {
    setMarkets((prev) => ({
      ...prev,
      [kind]: {
        ...prev[kind],
        ...patch,
      },
    }));
  }, []);

  const fetchEntries = useCallback(async (kind: MarketplaceKind, state: MarketState, append = false, cursor?: string) => {
    setMarkets((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], isLoading: true },
    }));
    try {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      params.set('kind', kind);
      params.set('limit', String(PAGE_SIZE));
      if (state.sourceId) params.set('sourceId', state.sourceId);
      if (state.query.trim()) params.set('query', state.query.trim());
      if (state.fields.length > 0) params.set('fields', state.fields.join(','));
      const installed = filterToQuery(state.installed);
      const installable = filterToQuery(state.installable);
      if (installed) params.set('installed', installed);
      if (installable) params.set('installable', installable);
      if (state.transport.trim()) params.set('transport', state.transport.trim());
      if (cursor) params.set('cursor', cursor);

      const data = parseMarketplacesResponse(await apiFetch(`/plugins/marketplaces?${params.toString()}`));
      setSources(data.sources);
      setMarkets((prev) => ({
        ...prev,
        [kind]: {
          ...prev[kind],
          entries: append ? mergeEntries(prev[kind].entries, data.entries) : data.entries,
          nextCursor: data.nextCursor,
          lastFetchedAt: data.fetchedAt,
          isLoading: false,
        },
      }));
      setError(null);
    } catch (err) {
      setMarkets((prev) => ({
        ...prev,
        [kind]: {
          ...prev[kind],
          entries: append ? prev[kind].entries : [],
          nextCursor: append ? prev[kind].nextCursor : undefined,
          isLoading: false,
        },
      }));
      setError(err instanceof Error ? err.message : 'Failed to fetch marketplace');
    }
  }, [sessionId]);

  const fetchSources = useCallback(async () => {
    try {
      const data = parseSourcesResponse(await apiFetch('/plugins/marketplaces/sources'));
      setAllSources(data);
      setSources(data.filter((source) => source.enabled !== false));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch marketplace sources');
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const fieldsKey = activeMarket.fields.join(',');
  const activeFieldSet = useMemo(() => new Set(activeMarket.fields), [activeMarket.fields]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchEntries(activeKind, activeMarket, false);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [
    activeKind,
    fetchEntries,
    sessionId,
    activeMarket.sourceId,
    activeMarket.query,
    fieldsKey,
    activeMarket.installed,
    activeMarket.installable,
    activeMarket.transport,
  ]);

  useEffect(() => {
    if (!activeMarket.sourceId) return;
    if (activeSources.some((source) => source.id === activeMarket.sourceId)) return;
    updateMarket(activeKind, { sourceId: '' });
  }, [activeKind, activeMarket.sourceId, activeSources, updateMarket]);

  const install = async (entry: MarketplaceEntry) => {
    setInstallingId(entry.id);
    setError(null);
    try {
      await apiFetch('/plugins/marketplaces/install', {
        method: 'POST',
        body: JSON.stringify({ id: entry.id, sourceId: entry.sourceId, sessionId }),
      });
      setMarkets((prev) => {
        const next = { ...prev };
        for (const kind of Object.keys(next) as MarketplaceKind[]) {
          next[kind] = {
            ...next[kind],
            entries: next[kind].entries.map((item) => item.id === entry.id ? { ...item, installed: true } : item),
          };
        }
        return next;
      });
      onInstalled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install');
    } finally {
      setInstallingId(null);
    }
  };

  const saveSource = async () => {
    if (!editingSource) return;
    const source = {
      ...editingSource,
      id: editingSource.id.trim(),
      title: editingSource.title?.trim() || undefined,
      url: editingSource.url?.trim() || undefined,
      enabled: editingSource.enabled !== false,
    };
    if (!source.id) {
      setError('Marketplace source id is required.');
      return;
    }
    if (!/^[a-z][a-z0-9_-]{1,79}$/.test(source.id)) {
      setError('Marketplace source id must start with a lowercase letter and contain only a-z, 0-9, _ or -.');
      return;
    }
    if (source.type === 'mcp_registry' && !source.url) {
      setError('MCP registry source requires a URL.');
      return;
    }
    setSavingSource(true);
    setError(null);
    try {
      await apiFetch('/plugins/marketplaces/sources', {
        method: 'POST',
        body: JSON.stringify(source),
      });
      setEditingSource(null);
      await fetchSources();
      await fetchEntries(activeKind, markets[activeKind], false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save marketplace source');
    } finally {
      setSavingSource(false);
    }
  };

  const toggleSource = async (source: MarketplaceSource) => {
    try {
      const result = parseSourceMutationResponse(await apiFetch(`/plugins/marketplaces/sources/${encodeURIComponent(source.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: source.enabled === false }),
      }));
      setAllSources((prev) => prev.map((item) => item.id === source.id ? result : item));
      setSources((prev) => (
        result.enabled === false
          ? prev.filter((item) => item.id !== source.id)
          : mergeSources(prev, result)
      ));
      const kind = KIND_BY_SOURCE_TYPE[source.type];
      const selectedState = {
        ...markets[activeKind],
        sourceId: kind === activeKind && markets[activeKind].sourceId === source.id ? '' : markets[activeKind].sourceId,
      };
      if (kind === activeKind && selectedState.sourceId !== markets[activeKind].sourceId) {
        updateMarket(activeKind, { sourceId: '' });
      } else {
        await fetchEntries(activeKind, selectedState, false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle marketplace source');
    }
  };

  const removeSource = async (source: MarketplaceSource) => {
    if (!confirm(`Remove marketplace source ${source.id}?`)) return;
    try {
      const result = parseSourceMutationResponse(await apiFetch(`/plugins/marketplaces/sources/${encodeURIComponent(source.id)}`, {
        method: 'DELETE',
      }));
      if (source.official) {
        setAllSources((prev) => prev.map((item) => item.id === source.id ? result : item));
      } else {
        setAllSources((prev) => prev.filter((item) => item.id !== source.id));
      }
      setSources((prev) => prev.filter((item) => item.id !== source.id));
      const kind = KIND_BY_SOURCE_TYPE[source.type];
      if (markets[kind].sourceId === source.id) updateMarket(kind, { sourceId: '' });
      if (kind !== activeKind || markets[activeKind].sourceId !== source.id) {
        await fetchEntries(activeKind, markets[activeKind], false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove marketplace source');
    }
  };

  const resetSearch = () => {
    updateMarket(activeKind, {
      query: '',
      fields: [],
      installed: 'all',
      installable: 'all',
      transport: '',
      nextCursor: undefined,
    });
  };

  const toggleField = (field: MarketplaceSearchField) => {
    const hasField = activeFieldSet.has(field);
    updateMarket(activeKind, {
      fields: hasField
        ? activeMarket.fields.filter((item) => item !== field)
        : [...activeMarket.fields, field],
      nextCursor: undefined,
    });
  };

  const ActiveIcon = activeConfig.icon;

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b border-border-muted shrink-0 bg-bg-primary/40 backdrop-blur-xl space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {MARKETPLACE_KIND_VALUES.map((kind) => {
            const Icon = MARKET_CONFIG[kind].icon;
            const active = activeKind === kind;
            return (
              <button
                key={kind}
                onClick={() => setActiveKind(kind)}
                className={`codex-chip px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors ${active ? 'text-text-primary border-accent-brand/40' : 'text-text-tertiary'}`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{MARKET_CONFIG[kind].label}</span>
                <span className="font-mono text-[10px] text-text-tertiary">{markets[kind].entries.length}</span>
              </button>
            );
          })}
          <div className="flex-1" />
          <span className="hidden md:inline text-[11px] text-text-tertiary whitespace-nowrap">
            Updated {formatFetchedAt(activeMarket.lastFetchedAt)}
          </span>
          <button onClick={() => fetchEntries(activeKind, activeMarket, false)} className="codex-icon-btn !h-8 !min-w-8" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${activeMarket.isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setShowAdvanced((value) => !value)}
            className={`codex-icon-btn !h-8 !min-w-8 ${showAdvanced ? 'text-accent-brand' : ''}`}
            title="Advanced search"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setShowSources((value) => !value);
              if (!showSources) fetchSources();
            }}
            className="px-2 py-1.5 text-xs text-text-secondary border border-border-default rounded hover:bg-bg-hover"
          >
            Sources
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={activeMarket.sourceId}
            onChange={(event) => updateMarket(activeKind, { sourceId: event.target.value, nextCursor: undefined })}
            className="px-2 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded text-text-primary outline-none max-w-[220px]"
          >
            <option value="">{activeConfig.allSources}</option>
            {activeSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.title || source.id}
              </option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[220px] max-w-xl">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
            <input
              value={activeMarket.query}
              onChange={(event) => updateMarket(activeKind, { query: event.target.value, nextCursor: undefined })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') fetchEntries(activeKind, activeMarket, false);
              }}
              placeholder={activeConfig.placeholder}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-input/80 border border-border-input rounded-full text-text-primary outline-none focus:border-border-default"
            />
          </div>
          <button
            onClick={resetSearch}
            className="codex-icon-btn !h-8 !min-w-8"
            title="Clear search"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>

        {showAdvanced && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Filter className="w-3.5 h-3.5 text-text-tertiary" />
            <button
              onClick={() => updateMarket(activeKind, { fields: [], nextCursor: undefined })}
              className={`px-2 py-1 text-[11px] rounded border ${activeMarket.fields.length === 0 ? 'border-accent-brand/40 text-text-primary bg-accent-brand/10' : 'border-border-default text-text-tertiary hover:bg-bg-hover'}`}
            >
              All fields
            </button>
            {SEARCH_FIELDS.map((field) => (
              <button
                key={field.value}
                onClick={() => toggleField(field.value)}
                className={`px-2 py-1 text-[11px] rounded border ${activeFieldSet.has(field.value) ? 'border-accent-brand/40 text-text-primary bg-accent-brand/10' : 'border-border-default text-text-tertiary hover:bg-bg-hover'}`}
              >
                {field.label}
              </button>
            ))}
            <select
              value={activeMarket.installed}
              onChange={(event) => updateMarket(activeKind, { installed: parseTriFilter(event.target.value, activeMarket.installed), nextCursor: undefined })}
              className="px-2 py-1 text-[11px] bg-bg-input border border-border-input rounded text-text-primary"
            >
              <option value="all">Any installed state</option>
              <option value="yes">Installed</option>
              <option value="no">Not installed</option>
            </select>
            <select
              value={activeMarket.installable}
              onChange={(event) => updateMarket(activeKind, { installable: parseTriFilter(event.target.value, activeMarket.installable), nextCursor: undefined })}
              className="px-2 py-1 text-[11px] bg-bg-input border border-border-input rounded text-text-primary"
            >
              <option value="all">Any installability</option>
              <option value="yes">Installable</option>
              <option value="no">Unavailable</option>
            </select>
            <input
              value={activeMarket.transport}
              onChange={(event) => updateMarket(activeKind, { transport: event.target.value, nextCursor: undefined })}
              placeholder="Transport"
              className="px-2 py-1 text-[11px] bg-bg-input border border-border-input rounded text-text-primary outline-none w-32"
            />
          </div>
        )}
      </div>

      {showSources && (
        <div className="border-b border-border-muted bg-bg-primary/70">
          <div className="px-5 py-3 flex items-start gap-3 overflow-x-auto">
            <button
              onClick={() => setEditingSource(emptySource(activeKind))}
              className="shrink-0 px-2.5 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add source
            </button>
            <div className="flex-1 min-w-[360px] divide-y divide-border-muted border border-border-muted rounded">
              {allSources.map((source) => (
                <div key={source.id} className="px-3 py-2 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-primary font-mono">{source.id}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                        {source.type}
                      </span>
                      {source.official && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/20 text-accent-green">
                          official
                        </span>
                      )}
                      {source.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                          disabled
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-secondary truncate">{source.title || source.id}</div>
                    <div className="text-[11px] text-text-tertiary font-mono truncate">{source.url || 'local dynamic scan'}</div>
                  </div>
                  <button onClick={() => setEditingSource({ ...source })} className="p-1 text-text-tertiary hover:text-accent-brand" title="Edit source">
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button onClick={() => toggleSource(source)} className={`p-1 ${source.enabled !== false ? 'text-accent-green' : 'text-text-tertiary'}`} title="Toggle source">
                    {source.enabled !== false ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                  </button>
                  <button onClick={() => removeSource(source)} className="p-1 text-text-tertiary hover:text-accent-red" title={source.official ? 'Disable source' : 'Remove source'}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {allSources.length === 0 && (
                <div className="px-3 py-4 text-xs text-text-tertiary">No marketplace sources</div>
              )}
            </div>
          </div>
        </div>
      )}

      {editingSource && (
        <div className="border-b border-border-muted bg-bg-primary px-5 py-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-text-primary">
              {allSources.some((source) => source.id === editingSource.id) ? 'Edit marketplace source' : 'Add marketplace source'}
            </span>
            <button onClick={() => setEditingSource(null)} className="text-text-tertiary hover:text-text-primary">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <label className="block">
              <span className="block text-[11px] text-text-tertiary mb-1">Source id</span>
              <input
                value={editingSource.id}
                onChange={(event) => setEditingSource({ ...editingSource, id: event.target.value })}
                disabled={editingSource.official}
                placeholder="my-mcp-registry"
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-text-tertiary mb-1">Type</span>
              <select
                value={editingSource.type}
                onChange={(event) => {
                  const type = parseMarketplaceSourceType(event.target.value, editingSource.type);
                  if (type) setEditingSource({ ...editingSource, type });
                }}
                disabled={editingSource.official}
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-50"
              >
                <option value="mcp_registry">mcp_registry</option>
                <option value="skill_index">skill_index</option>
                <option value="plugin_index">plugin_index</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] text-text-tertiary mb-1">Title</span>
              <input
                value={editingSource.title || ''}
                onChange={(event) => setEditingSource({ ...editingSource, title: event.target.value })}
                placeholder="Team Registry"
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1.5 text-xs text-text-primary"
              />
            </label>
            <label className="flex items-end gap-2">
              <input
                type="checkbox"
                checked={editingSource.enabled !== false}
                onChange={(event) => setEditingSource({ ...editingSource, enabled: event.target.checked })}
                className="mb-2"
              />
              <span className="text-xs text-text-secondary mb-1.5">Enabled</span>
            </label>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <label className="block flex-1">
              <span className="block text-[11px] text-text-tertiary mb-1">
                URL {editingSource.type === 'skill_index' ? '(empty means local skill scan)' : editingSource.type === 'plugin_index' ? '(empty means local plugin scan)' : ''}
              </span>
              <input
                value={editingSource.url || ''}
                onChange={(event) => setEditingSource({ ...editingSource, url: event.target.value })}
                placeholder={editingSource.type === 'mcp_registry' ? 'https://registry.modelcontextprotocol.io' : editingSource.type === 'plugin_index' ? 'https://example.com/plugins.json' : 'https://example.com/skills.json'}
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1.5 text-xs text-text-primary font-mono"
              />
            </label>
            <button
              onClick={saveSource}
              disabled={savingSource}
              className="px-3 py-1.5 text-xs text-white bg-accent-brand rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
            >
              {savingSource && <Loader2 className="w-3 h-3 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {activeMarket.isLoading && activeMarket.entries.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : activeMarket.entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <ActiveIcon className="w-8 h-8 mb-2" />
            <p className="text-sm">{activeConfig.empty}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {activeMarket.entries.map((entry) => {
              const EntryIcon = MARKET_CONFIG[entry.kind]?.icon || Store;
              return (
                <div key={entry.id} className="px-5 py-3.5 flex items-start gap-3 hover:bg-bg-hover/70 transition-colors">
                  <EntryIcon className="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text-primary break-words">{entry.title || entry.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${kindBadgeClass(entry.kind)}`}>
                        {entry.kind}
                      </span>
                      {entry.version && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                          {entry.version}
                        </span>
                      )}
                      {entry.transport && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                          {entry.transport}
                        </span>
                      )}
                      {entry.installed && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/20 text-accent-green">
                          installed
                        </span>
                      )}
                      {!entry.installable && !entry.installed && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-tertiary/20 text-text-tertiary">
                          unavailable
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-tertiary mt-0.5 break-words">{entry.description || '-'}</div>
                    <div className="text-[11px] text-text-tertiary mt-1 font-mono truncate">{entry.id}</div>
                    {(entry.repositoryUrl || entry.remoteUrl) && (
                      <div className="text-[11px] text-text-tertiary mt-0.5 font-mono truncate">
                        {entry.repositoryUrl || entry.remoteUrl}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => install(entry)}
                    disabled={!entry.installable || entry.installed || installingId === entry.id}
                    className="p-1 text-text-tertiary hover:text-accent-brand disabled:opacity-40 disabled:hover:text-text-tertiary"
                    title={entry.installed ? 'Installed' : 'Install'}
                  >
                    {installingId === entry.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  </button>
                </div>
              );
            })}
            {activeMarket.nextCursor && (
              <div className="px-5 py-3">
                <button
                  onClick={() => fetchEntries(activeKind, activeMarket, true, activeMarket.nextCursor)}
                  disabled={activeMarket.isLoading}
                  className="px-3 py-1.5 text-xs border border-border-default rounded text-accent-brand hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1"
                >
                  {activeMarket.isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function mergeSources(previous: MarketplaceSource[], source: MarketplaceSource): MarketplaceSource[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  byId.set(source.id, source);
  return Array.from(byId.values());
}
