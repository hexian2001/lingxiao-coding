/**
 * Forge REST API 客户端封装
 *
 * 契约: contract:mcp-forge-api v1
 * 路径前缀: /api/v1/mcp-forge
 * 鉴权: x-lingxiao-token header (SSE 用 ?token= 参数)
 *
 * 响应格式: { success: boolean, data?: T, error?: { code, message, retryable } }
 * 本模块自动 unwrap data 字段
 */

import { getServerToken } from '../../../api/headers';
import type {
  GenerateRequest,
  ForgeRequest,
  ForgeJob,
  ForgeJobDetail,
  ForgeJobSummary,
  ForgeApiResponse,
  ForgeApiListResponse,
  TemplateSummary,
  TemplateMetadata,
} from './types';

// ── 错误类型 ──────────────────────────────────────────────────────────────

export class ForgeApiError extends Error {
  code: string;
  retryable: boolean;
  phase?: string;
  detail?: string;

  constructor(code: string, message: string, retryable = false, phase?: string, detail?: string) {
    super(message);
    this.name = 'ForgeApiError';
    this.code = code;
    this.retryable = retryable;
    this.phase = phase;
    this.detail = detail;
  }
}

// ── 通用请求函数 ──────────────────────────────────────────────────────────

const API_BASE = '/api/v1/mcp-forge';

async function forgeFetch<T>(
  path: string,
  opts?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });

  const body: ForgeApiResponse<T> | ForgeApiListResponse<T> = await res.json().catch(() => ({}));

  if (!res.ok || !body.success) {
    const err = body.error;
    throw new ForgeApiError(
      err?.code || `HTTP_${res.status}`,
      err?.message || `HTTP ${res.status}`,
      err?.retryable ?? false,
      err?.phase,
      err?.detail,
    );
  }

  return (body as ForgeApiResponse<T>).data as T;
}

// ── SSE 连接 ──────────────────────────────────────────────────────────────

/**
 * 创建 Forge SSE 事件流连接。
 * EventSource 不支持自定义 header，用 ?token= 参数传递鉴权。
 *
 * @param jobId 任务 ID
 * @param handlers 事件回调
 * @returns cleanup 函数（关闭 EventSource）
 */
export function subscribeJobEvents(
  jobId: string,
  handlers: {
    onStateChange?: (event: { state?: string; progress?: number; message?: string }) => void;
    onProgress?: (event: { progress?: number; step?: string; message?: string }) => void;
    onLog?: (event: { message?: string; progress?: number; state?: string }) => void;
    onError?: (event: { error?: { message?: string; [key: string]: unknown } }) => void;
    onDone?: () => void;
    onOpen?: () => void;
  },
): () => void {
  const token = getServerToken();
  const url = `${API_BASE}/jobs/${encodeURIComponent(jobId)}/events?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);

  es.onopen = () => {
    handlers.onOpen?.();
  };

  es.addEventListener('state_change', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      handlers.onStateChange?.(data);
    } catch { /* ignore parse errors */ }
  });

  es.addEventListener('progress', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      handlers.onProgress?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('log', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      handlers.onLog?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('error', (e: MessageEvent) => {
    // SSE 'error' event (Forge custom) vs EventSource error
    if (e.data) {
      try {
        const data = JSON.parse(e.data);
        handlers.onError?.(data);
      } catch { /* ignore */ }
    }
  });

  es.addEventListener('done', () => {
    handlers.onDone?.();
    es.close();
  });

  // EventSource native error (connection lost)
  es.onerror = () => {
    // If not a custom error event, this is a connection error
    // EventSource auto-reconnects; we let it try
  };

  return () => {
    es.close();
  };
}

// ── API 方法 ──────────────────────────────────────────────────────────────

/** 4.1 POST /generate — 一键生成 */
export async function generate(req: GenerateRequest): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>('/generate', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** 4.2 GET /status/:id — 查询状态 */
export async function getJobStatus(
  jobId: string,
  opts?: { includeCode?: boolean; includeHistory?: boolean },
): Promise<ForgeJobDetail> {
  const params = new URLSearchParams();
  if (opts?.includeCode) params.set('includeCode', 'true');
  if (opts?.includeHistory === false) params.set('includeHistory', 'false');
  const qs = params.toString();
  return forgeFetch<ForgeJobDetail>(`/status/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ''}`);
}

/** 4.3 POST /validate — 验证 */
export async function validateJob(
  jobId: string,
  options?: { skipSandbox?: boolean; skipInspector?: boolean; timeoutMs?: number },
): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>('/validate', {
    method: 'POST',
    body: JSON.stringify({ jobId, options }),
  });
}

/** 4.4 POST /jobs — 创建任务（不执行） */
export async function createJob(req: ForgeRequest): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>('/jobs', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** 4.5 GET /jobs — 列出任务 */
export async function listJobs(params?: {
  state?: string;
  limit?: number;
  offset?: number;
  sort?: 'createdAt_desc' | 'createdAt_asc' | 'updatedAt_desc';
}): Promise<{ jobs: ForgeJobSummary[]; total: number; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  if (params?.state) qs.set('state', params.state);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  if (params?.sort) qs.set('sort', params.sort);
  const qsStr = qs.toString();

  const res = await fetch(`${API_BASE}/jobs${qsStr ? `?${qsStr}` : ''}`, {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
    },
  });
  const body: ForgeApiListResponse<ForgeJobSummary> = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new ForgeApiError(
      body.error?.code || `HTTP_${res.status}`,
      body.error?.message || `HTTP ${res.status}`,
      body.error?.retryable ?? false,
    );
  }
  return {
    jobs: body.data || [],
    total: body.pagination?.total ?? (body.data?.length || 0),
    limit: body.pagination?.limit ?? params?.limit ?? 20,
    offset: body.pagination?.offset ?? params?.offset ?? 0,
  };
}

/** 4.6 GET /jobs/:id — 任务详情 */
export async function getJob(
  jobId: string,
  opts?: { includeCode?: boolean; includeHistory?: boolean },
): Promise<ForgeJobDetail> {
  const params = new URLSearchParams();
  if (opts?.includeCode) params.set('includeCode', 'true');
  if (opts?.includeHistory === false) params.set('includeHistory', 'false');
  const qs = params.toString();
  return forgeFetch<ForgeJobDetail>(`/jobs/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ''}`);
}

/** 4.7 POST /jobs/:id/run — 执行流水线 */
export async function runJob(
  jobId: string,
  timeoutMs?: number,
): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>(`/jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
    body: JSON.stringify({ timeoutMs }),
  });
}

/** 4.8 POST /jobs/:id/advance — 推进单步 */
export async function advanceJob(
  jobId: string,
  toState?: string,
): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>(`/jobs/${encodeURIComponent(jobId)}/advance`, {
    method: 'POST',
    body: JSON.stringify({ toState }),
  });
}

/** 4.9 POST /jobs/:id/cancel — 取消任务 */
export async function cancelJob(jobId: string): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
}

/** 4.10 POST /jobs/:id/retry — 重试 */
export async function retryJob(
  jobId: string,
  patchRequest?: Partial<ForgeRequest>,
): Promise<{ job: ForgeJobDetail }> {
  return forgeFetch<{ job: ForgeJobDetail }>(`/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ patchRequest }),
  });
}

/** 4.11 DELETE /jobs/:id — 删除任务 */
export async function deleteJob(jobId: string): Promise<void> {
  await forgeFetch<{ deleted: boolean }>(`/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

/** 4.13 GET /templates — 模板列表 */
export async function listTemplates(params?: {
  language?: string;
  transport?: string;
}): Promise<TemplateSummary[]> {
  const qs = new URLSearchParams();
  if (params?.language) qs.set('language', params.language);
  if (params?.transport) qs.set('transport', params.transport);
  const qsStr = qs.toString();
  return forgeFetch<TemplateSummary[]>(`/templates${qsStr ? `?${qsStr}` : ''}`);
}

/** 4.14 GET /templates/:id — 模板详情 */
export async function getTemplate(
  templateId: string,
  includeCode = false,
): Promise<TemplateMetadata> {
  const qs = includeCode ? '?includeCode=true' : '';
  return forgeFetch<TemplateMetadata>(`/templates/${encodeURIComponent(templateId)}${qs}`);
}
