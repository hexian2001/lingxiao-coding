import { z } from 'zod';
import { basename, dirname, extname, join, resolve } from 'path';
import { mkdirSync } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath, lockedAtomicWriteBuffer } from './utils.js';
import { slugFileName } from './OfficeXmlBuilder.js';
import { checkUrlNotPrivate } from './WebCommon.js';
import { getScopedProxyFetch } from '../../core/ProxyConfig.js';

const SearchSchema = z.object({
  action: z.literal('search'),
  provider: z.enum(['pexels', 'unsplash']).default('pexels'),
  query: z.string(),
  orientation: z.enum(['landscape', 'portrait', 'square']).default('landscape'),
  per_page: z.number().int().min(1).max(20).default(8),
});

const DownloadSchema = z.object({
  action: z.literal('download_url'),
  url: z.string().url(),
  output_path: z.string().optional(),
  filename: z.string().optional(),
  attribution: z.string().optional(),
});

const SuggestSchema = z.object({
  action: z.literal('suggest_queries'),
  topic: z.string(),
  audience: z.string().optional(),
  style: z.enum(['corporate', 'technology', 'finance', 'healthcare', 'industrial', 'education', 'abstract']).default('corporate'),
});

const OfficeAssetSchema = z.discriminatedUnion('action', [SearchSchema, DownloadSchema, SuggestSchema]);

type OfficeAssetInput = z.infer<typeof OfficeAssetSchema>;

function env(name: string): string | undefined {
  return process.env[name] || process.env[`LINGXIAO_${name}`];
}

function toolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const scopedFetch = getScopedProxyFetch('tools') || fetch;
  return scopedFetch(input, init);
}

function extensionFromContentType(contentType: string | null, url: string): string {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return ext;
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'image/png') return '.png';
  if (mediaType === 'image/webp') return '.webp';
  if (mediaType === 'image/gif') return '.gif';
  return '.jpg';
}

function imageMimeFromExt(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function defaultAssetDir(context?: ToolContext): string {
  if (context?.sessionId) {
    return `.lingxiao/sessions/${context.sessionId}/scratchpad/assets`;
  }
  return '.lingxiao/assets';
}

function buildQuerySuggestions(topic: string, audience: string | undefined, style: string): string[] {
  const base = topic.trim();
  const modifier = audience ? `${audience} ` : '';
  const styleMap: Record<string, string[]> = {
    corporate: ['executive meeting', 'team collaboration', 'modern office', 'business strategy'],
    technology: ['data center', 'software team', 'AI interface', 'network infrastructure'],
    finance: ['financial dashboard', 'market analysis', 'boardroom', 'risk management'],
    healthcare: ['clinical operations', 'healthcare technology', 'care team', 'medical research'],
    industrial: ['manufacturing floor', 'logistics operations', 'industrial automation', 'quality control'],
    education: ['learning workshop', 'research team', 'digital classroom', 'knowledge sharing'],
    abstract: ['abstract gradient', 'geometric texture', 'minimal background', 'data visualization'],
  };
  return styleMap[style].map(item => `${modifier}${base} ${item}`.trim());
}

export class OfficeAssetTool extends Tool {
  readonly name = '__office_delegate_assets';
  readonly description = `办公素材工具：为 PPTX/DOCX/Canvas 搜索授权图库素材。

三个动作：
- search：搜索 Pexels/Unsplash 图库，返回图片 URL 列表
- download_url：下载远程图片到当前 session 目录
- suggest_queries：根据主题生成推荐搜索词

使用流程：先 suggest_queries 获取搜索建议 → 再 search 搜索 → 再 download_url 下载 → 最后用 image_path 嵌入文档。`;
  readonly parameters = OfficeAssetSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as OfficeAssetInput;
    if (params.action === 'suggest_queries') {
      return {
        success: true,
        data: {
          topic: params.topic,
          queries: buildQuerySuggestions(params.topic, params.audience, params.style),
        },
      };
    }

    if (params.action === 'search') {
      try {
        if (params.provider === 'pexels') {
          const key = env('PEXELS_API_KEY');
          if (!key) {
            return { success: false, data: null, error: '缺少 PEXELS_API_KEY 或 LINGXIAO_PEXELS_API_KEY' };
          }
          const url = new URL('https://api.pexels.com/v1/search');
          url.searchParams.set('query', params.query);
          url.searchParams.set('orientation', params.orientation);
          url.searchParams.set('per_page', String(params.per_page));
          const res = await toolFetch(url, { headers: { Authorization: key } });
          if (!res.ok) return { success: false, data: null, error: `Pexels search failed: ${res.status} ${await res.text()}` };
          const json = await res.json() as { photos?: Array<{ id: string; alt?: string; photographer?: string; url?: string; src?: { medium?: string; large2x?: string; large?: string; original?: string } }> };
          return {
            success: true,
            data: {
              provider: 'pexels',
              query: params.query,
              license_note: 'Pexels content requires following Pexels API guidelines and photographer credit where possible.',
              items: (json.photos || []).map((p) => ({
                id: p.id,
                title: p.alt || params.query,
                photographer: p.photographer,
                attribution: `Photo by ${p.photographer} on Pexels`,
                pageUrl: p.url,
                thumbUrl: p.src?.medium,
                downloadUrl: p.src?.large2x || p.src?.large || p.src?.original,
              })),
            },
          };
        }

        const key = env('UNSPLASH_ACCESS_KEY');
        if (!key) {
          return { success: false, data: null, error: '缺少 UNSPLASH_ACCESS_KEY 或 LINGXIAO_UNSPLASH_ACCESS_KEY' };
        }
        const url = new URL('https://api.unsplash.com/search/photos');
        url.searchParams.set('query', params.query);
        url.searchParams.set('orientation', params.orientation);
        url.searchParams.set('per_page', String(params.per_page));
        const res = await toolFetch(url, { headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' } });
        if (!res.ok) return { success: false, data: null, error: `Unsplash search failed: ${res.status} ${await res.text()}` };
        const json = await res.json() as { results?: Array<{ id: string; alt_description?: string; description?: string; user?: { name?: string }; links?: { html?: string }; urls?: { thumb?: string; small?: string; regular?: string; full?: string } }> };
        return {
          success: true,
          data: {
            provider: 'unsplash',
            query: params.query,
            license_note: 'Unsplash API requires following API Guidelines, including attribution and hotlinking rules where applicable.',
            items: (json.results || []).map((p) => ({
              id: p.id,
              title: p.alt_description || p.description || params.query,
              photographer: p.user?.name,
              attribution: `Photo by ${p.user?.name || 'Unsplash contributor'} on Unsplash`,
              pageUrl: p.links?.html,
              thumbUrl: p.urls?.small,
              downloadUrl: p.urls?.regular || p.urls?.full,
            })),
          },
        };
      } catch (error) {
        return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    try {
      const [notPrivate, privateReason] = await checkUrlNotPrivate(params.url);
      if (!notPrivate) {
        return { success: false, data: null, error: `SSRF 防护 - ${privateReason}` };
      }
      const res = await toolFetch(params.url);
      if (!res.ok) {
        return { success: false, data: null, error: `下载失败: ${res.status} ${res.statusText}` };
      }
      const contentType = res.headers.get('content-type');
      const ext = extensionFromContentType(contentType, params.url);
      const filename = params.filename
        ? `${slugFileName(params.filename.replace(ext, ''), 'asset')}${ext}`
        : `${slugFileName(basename(new URL(params.url).pathname, ext) || 'asset', 'asset')}${ext}`;
      const output = params.output_path || join(defaultAssetDir(context), filename);
      const outputPath = resolveTaskWritePath(context?.workspace, output, context?.sessionId, context?.taskWriteScope);
      const buffer = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(outputPath), { recursive: true });
      await lockedAtomicWriteBuffer(outputPath, buffer, { createDirs: true });
      let attributionPath: string | undefined;
      if (params.attribution) {
        attributionPath = `${outputPath}.attribution.txt`;
        await lockedAtomicWriteBuffer(attributionPath, Buffer.from(params.attribution, 'utf-8'), { createDirs: true });
      }
      return {
        success: true,
        data: {
          path: resolve(outputPath),
          size: buffer.length,
          mimeType: imageMimeFromExt(outputPath),
          attribution: params.attribution,
          attributionPath,
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export default OfficeAssetTool;
