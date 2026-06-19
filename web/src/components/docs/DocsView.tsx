/**
 * DocsView — 文档面板
 *
 * Loads docs from /api/v1/docs, renders with react-markdown
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import SafeMarkdown from '../ui/SafeMarkdown';
import { getServerToken } from '../../api/headers';
import {
  BookOpen, ChevronDown, ChevronRight, Search,
  Loader2,
} from 'lucide-react';

interface DocSection {
  id: string;
  title: string;
  content: string;
  children?: DocSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDocSection(value: unknown): DocSection | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content : '';
  if (!id || !title) return null;

  if (value.children !== undefined && !Array.isArray(value.children)) return null;
  const children = Array.isArray(value.children) ? normalizeDocSections(value.children) : [];
  if (children === null) return null;

  return {
    id,
    title,
    content,
    ...(children.length > 0 ? { children } : {}),
  };
}

function normalizeDocSections(value: unknown): DocSection[] | null {
  if (!Array.isArray(value)) return null;
  const sections: DocSection[] = [];
  for (const item of value) {
    const section = normalizeDocSection(item);
    if (!section) return null;
    sections.push(section);
  }
  return sections;
}

function findSection(sections: DocSection[], id: string): DocSection | null {
  for (const section of sections) {
    if (section.id === id) return section;
    if (section.children) {
      const found = findSection(section.children, id);
      if (found) return found;
    }
  }
  return null;
}

function firstSectionId(sections: DocSection[]): string {
  return sections[0]?.id ?? '';
}

export default function DocsView() {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<DocSection[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeSection, setActiveSection] = useState<string>('');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/v1/docs', { headers: { 'x-lingxiao-token': getServerToken() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as unknown;
      const sections = normalizeDocSections(isRecord(data) ? data.data : undefined);
      if (!sections) throw new Error('Invalid docs response');
      const firstId = firstSectionId(sections);
      setDocs(sections);
      setActiveSection((prev) => (prev && findSection(sections, prev) ? prev : firstId));
      setExpanded(firstId ? new Set([firstId]) : new Set());
    } catch (error) {
      setDocs([]);
      setActiveSection('');
      setExpanded(new Set());
      setLoadError(error instanceof Error ? error.message : 'Failed to load documentation');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const active = findSection(docs, activeSection);

  const filterSections = (sections: DocSection[], query: string): DocSection[] => {
    if (!query) return sections;
    return sections.filter((s) =>
      s.title.toLowerCase().includes(query.toLowerCase()) ||
      s.content.toLowerCase().includes(query.toLowerCase()) ||
      (s.children && filterSections(s.children, query).length > 0)
    );
  };

  const renderToc = (sections: DocSection[], depth: number) => {
    const filtered = search ? filterSections(sections, search) : sections;
    return filtered.map((section) => (
      <div key={section.id}>
        <button
          className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-1.5 rounded transition-colors ${
            activeSection === section.id ? 'bg-accent-brand/10 text-accent-brand' : 'text-text-secondary hover:bg-bg-hover'
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => {
            setActiveSection(section.id);
            if (section.children) toggleExpand(section.id);
          }}
        >
          {section.children && (
            <span className="text-text-tertiary">
              {expanded.has(section.id) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </span>
          )}
          <span className="truncate">{section.title}</span>
        </button>
        {section.children && expanded.has(section.id) && renderToc(section.children, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="flex h-full">
      {/* Table of contents */}
      <div className="w-56 border-r border-border-default flex flex-col bg-bg-secondary overflow-hidden shrink-0">
        <div className="px-3 py-2 border-b border-border-default">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">{t('docs.toc')}</span>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-tertiary" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('docs.search') || 'Search...'}
              className="w-full pl-6 pr-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-accent-brand animate-spin" />
            </div>
          ) : loadError ? (
            <div className="px-3 py-4 text-xs text-accent-red">
              {t('docs.loadError')}
            </div>
          ) : docs.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-tertiary">
              {t('docs.notFound')}
            </div>
          ) : (
            renderToc(docs, 0)
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 max-w-3xl">
        {isLoading ? (
          <div className="text-center text-text-tertiary py-12">
            <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin text-accent-brand" />
            <p>{t('docs.loading')}</p>
          </div>
        ) : loadError ? (
          <div className="text-center text-text-tertiary py-12">
            <BookOpen className="w-8 h-8 mx-auto mb-2 text-accent-red" />
            <p className="text-text-secondary">{t('docs.loadError')}</p>
            <p className="mt-1 text-xs">{loadError}</p>
            <button
              type="button"
              onClick={fetchDocs}
              className="mt-4 rounded border border-border-default px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            >
              {t('docs.retry')}
            </button>
          </div>
        ) : active ? (
          <article>
            <h1 className="text-xl font-semibold text-text-primary mb-4">{active.title}</h1>
            <div className="prose prose-sm prose-invert max-w-none text-text-secondary">
              <SafeMarkdown>{active.content}</SafeMarkdown>
            </div>
            {active.children && (
              <div className="mt-6 space-y-4">
                {active.children.map((child) => (
                  <section key={child.id} className="pl-4 border-l-2 border-accent-brand/30">
                    <h2
                      className="text-base font-medium text-text-primary mb-2 cursor-pointer hover:text-accent-brand"
                      onClick={() => setActiveSection(child.id)}
                    >
                      {child.title}
                    </h2>
                    <div className="prose prose-sm prose-invert max-w-none text-text-secondary">
                      <SafeMarkdown>{child.content}</SafeMarkdown>
                    </div>
                  </section>
                ))}
              </div>
            )}
          </article>
        ) : (
          <div className="text-center text-text-tertiary py-12">
            <BookOpen className="w-8 h-8 mx-auto mb-2" />
            <p>{t('docs.notFound')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
