/**
 * DesignMarketRoutes — 素材市场 Web API
 *
 * GET /api/v1/design-market/theme-sites?theme=&tags=&search=&limit=
 * GET /api/v1/design-market/theme-sites/:id
 * GET /api/v1/design-market/theme-sites/:id/preview
 * GET /api/v1/design-market/facets
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DesignThemeCatalog,
  loadDesignThemesFromDirectories,
} from '../core/DesignAssetCatalog.js';
import type { AuthFn } from './types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

interface ThemeSiteRecord {
  id: string;
  name?: string;
  theme?: string;
  tags?: string[];
  description?: string;
  prompt?: string;
  previewHtml?: string;
  [key: string]: unknown;
}

interface ThemeSiteQuery {
  theme?: string;
  tags?: string[];
  search?: string;
  limit?: number;
}

interface ThemeSiteQueryResult {
  total: number;
  returned: number;
  query: ThemeSiteQuery;
  themeSites: ThemeSiteRecord[];
}

interface ThemeCatalogApi {
  query?: (query: ThemeSiteQuery) => ThemeSiteQueryResult | ThemeSiteRecord[];
  get?: (id: string) => ThemeSiteRecord | undefined;
  getById?: (id: string) => ThemeSiteRecord | undefined;
  getThemeSite?: (id: string) => ThemeSiteRecord | undefined;
  getTheme?: (id: string) => ThemeSiteRecord | undefined;
  list?: () => ThemeSiteRecord[];
  search?: (search: string, limit?: number) => ThemeSiteRecord[];
  getFacets?: () => Record<string, unknown>;
  getThemes?: () => unknown;
  getTags?: () => unknown;
}

let cachedThemeCatalog: DesignThemeCatalog | null = null;

function getThemeCatalog(): ThemeCatalogApi {
  if (cachedThemeCatalog) return cachedThemeCatalog as unknown as ThemeCatalogApi;

  const searchPaths = [
    resolve(MODULE_DIR, '../../skills/bundled/design-market/themes'),
    resolve(MODULE_DIR, '../../../skills/bundled/design-market/themes'),
    join(process.cwd(), 'skills/bundled/design-market/themes'),
  ];

  cachedThemeCatalog = new DesignThemeCatalog(loadDesignThemesFromDirectories(searchPaths));
  return cachedThemeCatalog as unknown as ThemeCatalogApi;
}

function parseTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function parseLimit(value: string | undefined): number {
  return Math.min(parseInt(value || '100', 10) || 100, 200);
}

function withoutPreviewHtml(site: ThemeSiteRecord): Omit<ThemeSiteRecord, 'previewHtml'> {
  const { previewHtml: _previewHtml, ...publicSite } = site;
  return publicSite;
}

function normalizeQueryResult(rawResult: ThemeSiteQueryResult | ThemeSiteRecord[], query: ThemeSiteQuery): ThemeSiteQueryResult {
  if (Array.isArray(rawResult)) {
    return {
      total: rawResult.length,
      returned: rawResult.length,
      query,
      themeSites: rawResult,
    };
  }

  return rawResult;
}

function queryThemeSites(catalog: ThemeCatalogApi, query: ThemeSiteQuery): ThemeSiteQueryResult {
  if (catalog.query) return normalizeQueryResult(catalog.query(query), query);

  let themeSites = query.search ? (catalog.search?.(query.search, query.limit) ?? []) : (catalog.list?.() ?? []);
  if (query.theme) themeSites = themeSites.filter(site => site.id === query.theme || site.theme === query.theme);
  if (query.tags?.length) {
    themeSites = themeSites.filter(site => {
      const tags = new Set((site.tags ?? []).map(tag => tag.toLowerCase()));
      return query.tags!.every(tag => tags.has(tag));
    });
  }

  const total = themeSites.length;
  const limitedThemeSites = themeSites.slice(0, query.limit ?? 100);
  return {
    total,
    returned: limitedThemeSites.length,
    query,
    themeSites: limitedThemeSites,
  };
}

function findThemeSite(catalog: ThemeCatalogApi, id: string): ThemeSiteRecord | undefined {
  return catalog.getById?.(id)
    ?? catalog.getThemeSite?.(id)
    ?? catalog.getTheme?.(id)
    ?? catalog.get?.(id)
    ?? queryThemeSites(catalog, { search: id, limit: 200 }).themeSites.find(site => site.id === id);
}

function buildFacets(catalog: ThemeCatalogApi): Record<string, unknown> {
  return catalog.getFacets?.() ?? {
    themes: catalog.getThemes?.() ?? [],
    tags: catalog.getTags?.() ?? [],
  };
}

export function registerDesignMarketRoutes(fastify: FastifyInstance, _deps: { auth: AuthFn }): void {
  fastify.get('/api/v1/design-market/assets', async () => ({
    deprecated: true,
    message: 'design-market assets API has been replaced by theme-sites.',
    replacement: '/api/v1/design-market/theme-sites',
    themeSitesUrl: '/api/v1/design-market/theme-sites',
  }));

  fastify.get('/api/v1/design-market/theme-sites', async (req) => {
    const query = req.query as {
      theme?: string;
      tags?: string;
      limit?: string;
      search?: string;
    };
    const catalog = getThemeCatalog();
    const normalizedQuery: ThemeSiteQuery = {
      theme: query.theme,
      tags: parseTags(query.tags),
      search: query.search,
      limit: parseLimit(query.limit),
    };
    const result = queryThemeSites(catalog, normalizedQuery);

    return {
      total: result.total,
      returned: result.returned,
      query: result.query,
      themeSites: result.themeSites.map(withoutPreviewHtml),
      facets: buildFacets(catalog),
    };
  });

  fastify.get('/api/v1/design-market/facets', async () => ({
    facets: buildFacets(getThemeCatalog()),
  }));

  fastify.get('/api/v1/design-market/theme-sites/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const site = findThemeSite(getThemeCatalog(), id);
    if (!site) return reply.code(404).send({ error: 'theme_site_not_found', id });
    return site;
  });

  fastify.get('/api/v1/design-market/theme-sites/:id/preview', async (req, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const site = findThemeSite(getThemeCatalog(), id);
    if (!site) return reply.code(404).send({ error: 'theme_site_not_found', id });
    return reply.type('text/html; charset=utf-8').send(site.previewHtml ?? '');
  });
}
