/**
 * DesignMarketView — full frontend system theme market.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Filter,
  Layers,
  Monitor,
  Palette,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Wand2,
  X,
} from 'lucide-react';
import {
  THEME_LABELS,
  SYSTEM_SURFACE_KEYS,
  buildSystemDemoHtml,
  getPaletteValues,
  getReadableTextColor,
  getReferencePrompt,
  getSiteTheme,
  getSystemSummary,
  getSystemSpec,
  getSystemSurfaces,
  getThemeVisual,
  getUsageBoundary,
  type ModeFilter,
  type ThemeSite,
} from './systemDemo';

interface FacetInfo {
  name?: string;
  theme?: string;
  tag?: string;
  count: number;
}

interface ThemeSitesResponse {
  total?: number;
  returned?: number;
  sites?: ThemeSite[];
  themeSites?: ThemeSite[];
  facets?: {
    themes?: FacetInfo[];
    tags?: FacetInfo[];
  };
}

async function fetchThemeSites(params: Record<string, string>): Promise<ThemeSitesResponse> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/v1/design-market/theme-sites${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Theme system market request failed: ${res.status}`);
  return res.json();
}

async function fetchThemeSiteDetail(id: string): Promise<ThemeSite> {
  const res = await fetch(`/api/v1/design-market/theme-sites/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Theme system detail request failed: ${res.status}`);
  const data = await res.json();
  return data.site || data.themeSite || data;
}

function normalizeSites(data: ThemeSitesResponse | ThemeSite[]): ThemeSite[] {
  if (Array.isArray(data)) return data;
  return data.sites || data.themeSites || [];
}

function openSystemPreview(site: ThemeSite): void {
  const blob = new Blob([buildSystemDemoHtml(site)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(url), opened ? 60_000 : 1_000);
}

function CopyButton({ text, label, compact = false }: { text: string; label: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!text}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-muted bg-bg-card px-3 text-[12px] font-medium text-text-secondary shadow-sm transition-colors hover:border-accent-brand/35 hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 ${compact ? 'w-9 px-0' : ''}`}
      title={`Copy ${label}`}
    >
      {copied ? <Check size={14} className="text-accent-green" /> : <Copy size={14} />}
      {!compact && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

function MetricPill({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="inline-flex h-8 items-center gap-2 rounded-md border border-border-muted bg-bg-card px-2.5 text-[11px] text-text-secondary shadow-sm">
      {icon}
      <span className="font-mono text-text-primary">{value}</span>
      <span>{label}</span>
    </div>
  );
}

function ModeToggle({ value, selected, label, onClick }: { value: ModeFilter; selected: ModeFilter; label: string; onClick: (value: ModeFilter) => void }) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={`h-8 rounded-md px-3 text-[12px] font-medium transition-colors ${
        selected === value
          ? 'bg-accent-brand text-white shadow-sm'
          : 'border border-border-muted bg-bg-card text-text-secondary hover:border-accent-brand/35 hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  );
}

function ThemeSwatch({ site, selected = false }: { site?: ThemeSite; selected?: boolean }) {
  const visual = getThemeVisual(site);
  const colors = getPaletteValues(site, 4);
  return (
    <div
      className={`relative h-12 w-12 shrink-0 overflow-hidden rounded-md border ${selected ? 'border-accent-brand/55' : 'border-border-muted'}`}
      style={{
        background: `linear-gradient(135deg, ${colors[0] || visual.surface}, ${colors[1] || visual.panel} 42%, ${colors[2] || visual.accent})`,
        boxShadow: selected ? `0 0 0 1px color-mix(in srgb, ${visual.accent} 34%, transparent), 0 16px 34px ${visual.accent}1f` : undefined,
      }}
    >
      <span
        className="absolute bottom-2 right-2 h-4 w-4 rounded-sm border border-white/30"
        style={{ backgroundColor: visual.accent, boxShadow: `0 0 18px ${visual.accent}70` }}
      />
      <span className="absolute left-2 top-2 h-5 w-5 rounded-sm border border-black/10 bg-white/45" />
    </div>
  );
}

function SystemCard({
  index,
  site,
  selected,
  onSelect,
}: {
  index: number;
  site: ThemeSite;
  selected: boolean;
  onSelect: () => void;
}) {
  const theme = getSiteTheme(site);
  const visual = getThemeVisual(site);
  const spec = getSystemSpec(site);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group grid w-full grid-cols-[48px_minmax(0,1fr)_32px] items-center gap-3 rounded-md border p-3 text-left transition-all ${
        selected
          ? 'border-accent-brand/42 bg-bg-card shadow-md'
          : 'border-transparent bg-transparent hover:border-border-muted hover:bg-bg-hover'
      }`}
    >
      <ThemeSwatch site={site} selected={selected} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-text-primary">{spec.product}</span>
          <span className="shrink-0 rounded border border-border-muted bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{THEME_LABELS[theme] || theme}</span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
          <span className="truncate">{spec.context}</span>
          <span className="h-1 w-1 shrink-0 rounded-full" style={{ backgroundColor: visual.accent }} />
          <span>{visual.mode}</span>
        </span>
      </span>
      <span className="font-mono text-[10px] text-text-muted">{String(index + 1).padStart(2, '0')}</span>
    </button>
  );
}

function TagCloud({ tags, onSelect }: { tags: FacetInfo[]; onSelect: (tag: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <section className="hidden border-t border-border-muted px-4 py-4 lg:block">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
        <Tags size={12} />
        <span>System Tags</span>
      </div>
      <div className="flex max-h-24 flex-wrap gap-1.5 overflow-hidden">
        {tags.slice(0, 18).map(item => {
          const tag = item.tag || item.name || '';
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onSelect(tag)}
              className="rounded-md border border-border-muted bg-bg-card px-2 py-1 text-[10px] text-text-tertiary transition-colors hover:border-accent-brand/35 hover:bg-bg-hover hover:text-text-primary"
            >
              {tag}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MarketRail({
  sites,
  selectedId,
  search,
  selectedMode,
  total,
  returned,
  tagFacets,
  loading,
  onSearch,
  onSelectMode,
  onSelectSite,
}: {
  sites: ThemeSite[];
  selectedId: string;
  search: string;
  selectedMode: ModeFilter;
  total: number;
  returned: number;
  tagFacets: FacetInfo[];
  loading: boolean;
  onSearch: (value: string) => void;
  onSelectMode: (value: ModeFilter) => void;
  onSelectSite: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="flex min-h-0 max-h-[39vh] w-full shrink-0 flex-col border-b border-border-muted bg-bg-secondary/74 text-text-primary backdrop-blur-xl sm:max-h-[42vh] lg:h-full lg:max-h-none lg:w-[320px] lg:border-b-0 lg:border-r xl:w-[336px]">
      <div className="space-y-5 border-b border-border-muted px-5 py-5">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={16} className="text-accent-brand" />
            <h1 className="text-[22px] font-semibold leading-tight text-text-primary">{t('design.market.title')}</h1>
          </div>
          <p className="max-w-[28rem] text-[13px] leading-relaxed text-text-secondary">
            {t('design.market.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <MetricPill icon={<Layers size={13} className="text-accent-brand" />} label="systems" value={returned || total} />
          <MetricPill icon={<Activity size={13} className="text-accent-yellow" />} label="surfaces" value={(returned || total) * SYSTEM_SURFACE_KEYS.length} />
        </div>

        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={event => onSearch(event.target.value)}
            placeholder={t('design.market.searchPlaceholder')}
            className="h-10 w-full rounded-md border border-border-input bg-bg-input pl-9 pr-3 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-brand"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
            <SlidersHorizontal size={12} />
            <span>Rendering Mode</span>
          </div>
          <div className="flex gap-1.5">
            <ModeToggle value="all" selected={selectedMode} label="All" onClick={onSelectMode} />
            <ModeToggle value="light" selected={selectedMode} label="Light" onClick={onSelectMode} />
            <ModeToggle value="dark" selected={selectedMode} label="Dark" onClick={onSelectMode} />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-52 items-center justify-center text-[13px] text-text-secondary">Loading systems...</div>
        ) : sites.length === 0 ? (
          <div className="flex h-52 flex-col items-center justify-center gap-3 text-center text-text-secondary">
            <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border-muted bg-bg-card">
              <Search size={18} />
            </div>
            <div>
              <div className="text-sm font-medium text-text-primary">No matching systems</div>
              <div className="text-xs text-text-tertiary">Try a broader business domain.</div>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {sites.map((site, index) => (
              <SystemCard
                key={site.id}
                index={index}
                site={site}
                selected={site.id === selectedId}
                onSelect={() => onSelectSite(site.id)}
              />
            ))}
          </div>
        )}
      </div>

      <TagCloud tags={tagFacets} onSelect={onSearch} />
    </aside>
  );
}

function SystemHeader({
  site,
  sites,
  onPrev,
  onNext,
  onOpenPrompt,
}: {
  site?: ThemeSite;
  sites: ThemeSite[];
  onPrev: () => void;
  onNext: () => void;
  onOpenPrompt: () => void;
}) {
  const { t } = useTranslation();
  const visual = getThemeVisual(site);
  const spec = getSystemSpec(site);
  const actionTextColor = getReadableTextColor(visual.accent);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-muted bg-bg-primary/86 px-3 py-3 text-text-primary backdrop-blur-xl sm:flex-nowrap lg:px-5">
      <div className="hidden sm:block">
        <ThemeSwatch site={site} selected />
      </div>
      <div className="min-w-[11rem] flex-1">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[16px] font-semibold text-text-primary sm:text-[17px]">{site ? spec.product : t('design.market.defaultHeading')}</h2>
          {site && (
            <>
              <span className="hidden rounded-md border border-border-muted bg-bg-card px-2 py-0.5 text-[10px] text-text-tertiary min-[440px]:inline">{THEME_LABELS[getSiteTheme(site)] || getSiteTheme(site)}</span>
              <span className="rounded-md border border-border-muted bg-bg-card px-2 py-0.5 text-[10px] text-text-tertiary">{visual.mode}</span>
              <span className="hidden rounded-md border border-border-muted bg-bg-card px-2 py-0.5 text-[10px] text-text-tertiary min-[440px]:inline">{visual.font}</span>
            </>
          )}
        </div>
        <p className="truncate text-[12px] text-text-secondary">{site ? getSystemSummary(site) : 'Browse complete product systems.'}</p>
      </div>

      <div className="hidden items-center gap-2 sm:flex">
        <button
          type="button"
          onClick={onPrev}
          disabled={sites.length < 2}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-muted bg-bg-card text-text-secondary transition-colors hover:border-accent-brand/35 hover:bg-bg-hover hover:text-text-primary disabled:opacity-35"
          title="Previous system"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={sites.length < 2}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-muted bg-bg-card text-text-secondary transition-colors hover:border-accent-brand/35 hover:bg-bg-hover hover:text-text-primary disabled:opacity-35"
          title="Next system"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenPrompt}
          disabled={!site}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border-muted bg-bg-card px-3 text-[12px] font-medium text-text-secondary transition-colors hover:border-accent-brand/35 hover:bg-bg-hover hover:text-text-primary disabled:opacity-35"
        >
          <Wand2 size={14} />
          <span className="hidden sm:inline">Prompt</span>
        </button>
        {site && (
          <button
            type="button"
            onClick={() => openSystemPreview(site)}
            className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-[12px] font-semibold shadow-sm transition-transform hover:scale-[1.02]"
            style={{ backgroundColor: visual.accent, color: actionTextColor }}
          >
            <span className="hidden sm:inline">{t('design.market.openSystem')}</span>
            <ExternalLink size={14} />
          </button>
        )}
      </div>
    </header>
  );
}

function SystemPreviewFrame({ site, loading }: { site?: ThemeSite; loading: boolean }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const visual = getThemeVisual(site);
  const spec = getSystemSpec(site);
  const surfaces = getSystemSurfaces(site);
  const srcDoc = useMemo(() => (site ? buildSystemDemoHtml(site) : ''), [site]);

  useEffect(() => {
    setReady(false);
  }, [site?.id]);

  if (!site) {
    return (
      <div className="flex h-full min-h-[520px] items-center justify-center rounded-md border border-border-muted bg-bg-card text-sm text-text-secondary">
        {t('design.market.selectPrompt')}
      </div>
    );
  }

  return (
    <section
      className="flex h-[54vh] min-h-[430px] flex-col overflow-hidden rounded-md border border-border-muted bg-bg-card shadow-xl sm:h-[60vh] lg:h-full lg:min-h-[620px]"
      style={{ boxShadow: `0 28px 80px -52px ${visual.accent}` }}
    >
      <div className="flex min-h-11 items-center gap-3 border-b border-border-muted bg-bg-secondary/78 px-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent-red/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-accent-yellow/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-accent-green/75" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border-muted bg-bg-card px-3 py-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: visual.accent }} />
          <span className="truncate font-mono text-[11px] text-text-tertiary">lingxiao.system/{site.id}/full-system</span>
        </div>
        <Monitor size={15} className="text-text-muted" />
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-border-muted bg-bg-card px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-text-primary">{spec.product}</div>
          <div className="truncate text-[11px] text-text-tertiary">{spec.modules.join(' / ')}</div>
        </div>
        <div className="hidden items-center gap-1.5 text-[10px] text-text-muted md:flex">
          {surfaces.slice(0, 6).map(surface => (
            <span key={surface.key} className="rounded border border-border-muted bg-bg-secondary px-2 py-1">{surface.label}</span>
          ))}
          <span className="rounded border border-border-muted bg-bg-secondary px-2 py-1">+{Math.max(0, surfaces.length - 6)}</span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
        {(!ready || loading) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-secondary">
            <div className="flex flex-col items-center gap-3 text-text-secondary">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-border-muted border-t-accent-brand" />
              <span className="text-[13px]">Rendering system...</span>
            </div>
          </div>
        )}
        <iframe
          key={site.id}
          title={`${spec.product} system demo`}
          srcDoc={srcDoc}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-same-origin"
          onLoad={() => setReady(true)}
        />
      </div>
    </section>
  );
}

function BlueprintPanel({ site }: { site?: ThemeSite }) {
  if (!site) return null;
  const spec = getSystemSpec(site);
  const visual = getThemeVisual(site);
  const colors = getPaletteValues(site, 6);
  const surfaces = getSystemSurfaces(site);

  return (
    <aside className="grid gap-3 lg:grid-cols-3 min-[1720px]:grid-cols-1">
      <section className="rounded-md border border-border-muted bg-bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
            <Layers size={12} />
            <span>Full App Coverage</span>
          </div>
          <span className="rounded-md border border-border-muted bg-bg-secondary px-2 py-1 font-mono text-[10px] text-text-tertiary">{surfaces.length}/{SYSTEM_SURFACE_KEYS.length}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 min-[1720px]:grid-cols-1">
          {surfaces.map((surface, index) => (
            <div key={surface.key} className="min-w-0 rounded-md border border-border-muted bg-bg-secondary px-3 py-2 text-[12px]">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium text-text-primary">{surface.label}</span>
                <span className="font-mono text-[10px] text-text-muted">{String(index + 1).padStart(2, '0')}</span>
              </div>
              <div className="mt-1 truncate text-[10px] text-text-tertiary">{surface.title}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-md border border-border-muted bg-bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
          <Palette size={12} />
          <span>Visual Tokens</span>
        </div>
        <div className="grid grid-cols-6 gap-2 min-[1720px]:grid-cols-3">
          {colors.map((color, index) => (
            <span
              key={`${color}-${index}`}
              className="h-9 rounded-md border border-border-muted"
              style={{ background: color }}
              title={color}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="rounded-md border border-border-muted bg-bg-secondary px-2 py-1 text-[10px] text-text-tertiary">{visual.mode}</span>
          <span className="rounded-md border border-border-muted bg-bg-secondary px-2 py-1 text-[10px] text-text-tertiary">{visual.font}</span>
          <span className="rounded-md border border-border-muted bg-bg-secondary px-2 py-1 text-[10px]" style={{ color: visual.accent }}>accent</span>
        </div>
      </section>

      <section className="rounded-md border border-border-muted bg-bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
          <Filter size={12} />
          <span>System Modules</span>
        </div>
        <div className="grid gap-2">
          {spec.modules.map((item, index) => (
            <div key={item} className="flex items-center justify-between gap-3 rounded-md border border-border-muted bg-bg-secondary px-3 py-2 text-[12px]">
              <span className="truncate text-text-secondary">{item}</span>
              <span className="font-mono text-[10px] text-text-muted">{String(index + 1).padStart(2, '0')}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border-muted pt-3">
          {[spec.context, spec.operator, spec.entity, ...(site.tags || [])].filter(Boolean).slice(0, 8).map(item => (
            <span key={item} className="rounded-md border border-border-muted bg-bg-secondary px-2 py-1 text-[10px] text-text-tertiary">{item}</span>
          ))}
        </div>
      </section>
    </aside>
  );
}

function PromptDrawer({ site, open, onClose }: { site?: ThemeSite; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  if (!open || !site) return null;
  const spec = getSystemSpec(site);
  const visual = getThemeVisual(site);
  const actionTextColor = getReadableTextColor(visual.accent);
  const prompt = getReferencePrompt(site);
  const boundary = getUsageBoundary(site);

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-bg-primary/62 text-text-primary backdrop-blur-sm">
      <aside className="flex h-full w-full max-w-[590px] flex-col border-l border-border-muted bg-bg-primary shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border-muted p-5">
          <ThemeSwatch site={site} selected />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase text-text-muted">{THEME_LABELS[getSiteTheme(site)] || getSiteTheme(site)}</div>
            <h2 className="truncate text-lg font-semibold text-text-primary">{spec.product}</h2>
            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{getSystemSummary(site)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border-muted bg-bg-card text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <section className="overflow-hidden rounded-md border border-border-muted bg-bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border-muted px-3 py-2">
              <span className="flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
                <Wand2 size={12} />
                System Prompt
              </span>
              <CopyButton text={prompt} label="Prompt" compact />
            </div>
            <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap bg-bg-code p-4 text-[12px] leading-relaxed text-text-secondary">
              {prompt || t('design.market.noPrompt')}
            </pre>
          </section>

          <section className="rounded-md border border-border-muted bg-bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
                <Layers size={12} />
                Guardrail
              </span>
              <CopyButton text={boundary} label="Guardrail" compact />
            </div>
            <p className="text-[12px] leading-relaxed text-text-secondary">{boundary}</p>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-muted p-4">
          <CopyButton text={prompt} label="Copy Prompt" />
          <button
            type="button"
            onClick={() => openSystemPreview(site)}
            className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-[12px] font-semibold shadow-sm transition-transform hover:scale-[1.02]"
            style={{ backgroundColor: visual.accent, color: actionTextColor }}
          >
            {t('design.market.openSystem')}
            <ExternalLink size={14} />
          </button>
        </div>
      </aside>
    </div>
  );
}

export default function DesignMarketView() {
  const [sites, setSites] = useState<ThemeSite[]>([]);
  const [siteDetails, setSiteDetails] = useState<Record<string, ThemeSite>>({});
  const [facets, setFacets] = useState<ThemeSitesResponse['facets']>({});
  const [total, setTotal] = useState(0);
  const [returned, setReturned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedMode, setSelectedMode] = useState<ModeFilter>('all');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [promptOpen, setPromptOpen] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 720 : false
  ));

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: '120' };
      if (search.trim()) params.search = search.trim();
      const data = await fetchThemeSites(params);
      const normalizedSites = normalizeSites(data);
      setSites(normalizedSites);
      setTotal(Array.isArray(data) ? normalizedSites.length : data.total ?? normalizedSites.length);
      setReturned(Array.isArray(data) ? normalizedSites.length : data.returned ?? normalizedSites.length);
      setFacets(Array.isArray(data) ? {} : data.facets || {});
    } catch (err) {
      console.error('Theme system market load failed:', err);
      setSites([]);
      setTotal(0);
      setReturned(0);
      setFacets({});
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const updateCompactViewport = () => setCompactViewport(window.innerWidth <= 720);
    updateCompactViewport();
    window.addEventListener('resize', updateCompactViewport);
    return () => window.removeEventListener('resize', updateCompactViewport);
  }, []);

  const visibleSites = useMemo(() => {
    if (selectedMode === 'all') return sites;
    return sites.filter(site => getThemeVisual(site).mode === selectedMode);
  }, [selectedMode, sites]);

  useEffect(() => {
    if (visibleSites.length === 0) {
      setSelectedSiteId('');
      return;
    }
    if (!visibleSites.some(site => site.id === selectedSiteId)) {
      setSelectedSiteId(visibleSites[0].id);
    }
  }, [selectedSiteId, visibleSites]);

  const listSelectedSite = visibleSites.find(site => site.id === selectedSiteId);
  const selectedSite = selectedSiteId ? siteDetails[selectedSiteId] || listSelectedSite : undefined;
  const selectedDetailLoaded = selectedSiteId ? Boolean(siteDetails[selectedSiteId]) : false;

  useEffect(() => {
    if (!selectedSiteId || !listSelectedSite || selectedDetailLoaded) return;

    let cancelled = false;
    setDetailLoading(true);
    fetchThemeSiteDetail(selectedSiteId)
      .then(detail => {
        if (!cancelled) {
          setSiteDetails(prev => ({
            ...prev,
            [selectedSiteId]: { ...listSelectedSite, ...detail },
          }));
        }
      })
      .catch(err => {
        console.error('Theme system detail load failed:', err);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [listSelectedSite, selectedDetailLoaded, selectedSiteId]);

  const tagFacets = facets?.tags || [];
  const selectedIndex = visibleSites.findIndex(site => site.id === selectedSiteId);

  const selectAdjacent = (direction: 'prev' | 'next') => {
    if (visibleSites.length === 0) return;
    const base = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = direction === 'prev'
      ? (base - 1 + visibleSites.length) % visibleSites.length
      : (base + 1) % visibleSites.length;
    setSelectedSiteId(visibleSites[nextIndex].id);
  };

  const clearSearch = () => {
    setSearch('');
    setSelectedMode('all');
  };

  return (
    <div
      data-design-market-root
      className={`${compactViewport ? 'fixed inset-0 z-[240] overflow-y-auto' : 'relative h-full overflow-hidden'} flex min-h-0 bg-bg-primary text-text-primary`}
      style={compactViewport ? { position: 'fixed', inset: 0, zIndex: 240, width: '100vw', height: '100vh' } : undefined}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--color-bg-secondary) 74%, transparent) 0%, transparent 32%, color-mix(in srgb, var(--color-bg-tertiary) 26%, transparent) 100%), linear-gradient(90deg, color-mix(in srgb, var(--color-border-muted) 30%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--color-border-muted) 24%, transparent) 1px, transparent 1px)',
          backgroundSize: 'auto, 56px 56px, 56px 56px',
        }}
      />

      <div className="relative z-10 flex min-h-full w-full flex-col lg:min-h-0 lg:flex-row">
        <MarketRail
          sites={visibleSites}
          selectedId={selectedSiteId}
          search={search}
          selectedMode={selectedMode}
          total={total}
          returned={returned}
          tagFacets={tagFacets}
          loading={loading}
          onSearch={setSearch}
          onSelectMode={setSelectedMode}
          onSelectSite={setSelectedSiteId}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <SystemHeader
            site={selectedSite}
            sites={visibleSites}
            onPrev={() => selectAdjacent('prev')}
            onNext={() => selectAdjacent('next')}
            onOpenPrompt={() => setPromptOpen(true)}
          />

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-3 p-3 sm:p-4 min-[1720px]:grid-cols-[minmax(0,1fr)_300px] min-[1720px]:grid-rows-1">
            {visibleSites.length === 0 && !loading ? (
              <div className="flex h-full min-h-[520px] flex-col items-center justify-center gap-4 rounded-md border border-border-muted bg-bg-card text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-md border border-border-muted bg-bg-secondary">
                  <Search size={20} className="text-text-muted" />
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary">No matching systems</div>
                  <div className="mt-1 text-xs text-text-secondary">Try a broader theme, prompt, or domain.</div>
                </div>
                <button
                  type="button"
                  onClick={clearSearch}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border-muted bg-bg-card px-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  <X size={14} />
                  Clear filters
                </button>
              </div>
            ) : (
              <SystemPreviewFrame site={selectedSite} loading={detailLoading} />
            )}

            <BlueprintPanel site={selectedSite} />
          </div>
        </main>
      </div>

      <PromptDrawer site={selectedSite} open={promptOpen} onClose={() => setPromptOpen(false)} />
    </div>
  );
}
