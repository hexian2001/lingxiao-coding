/**
 * GitPlatformApi — 对接 GitHub / GitLab / Gitea REST API
 *
 * 使用 Strategy Pattern，每个平台一个 Driver 实现。
 * 外部 API 不变：new GitPlatformApi(config) → .createMR(), .mergeMR(), etc.
 */

import { getScopedProxyFetch } from '../ProxyConfig.js';

export interface GitPlatformConfig {
  platform: 'github' | 'gitlab' | 'gitea' | 'none';
  token: string;
  apiUrl?: string;
  owner?: string;
  repo?: string;
}

export interface MergeRequest {
  id: number | string;
  iid?: number;
  title: string;
  description: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  platform: 'github' | 'gitlab' | 'gitea';
  draft: boolean;
  labels: string[];
  comments: number;
}

export interface CreateMRParams {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
  labels?: string[];
  assignee?: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  url: string;
  isPrivate: boolean;
  stars: number;
  forks: number;
}
// ────────────────────── Strategy Interface ──────────────────────

interface GitPlatformDriver {
  listMRs(state: 'open' | 'closed' | 'merged' | 'all', request: RequestFn, repoPath: string): Promise<MergeRequest[]>;
  getMR(id: number | string, request: RequestFn, repoPath: string): Promise<MergeRequest>;
  createMR(params: CreateMRParams, request: RequestFn, repoPath: string): Promise<MergeRequest>;
  mergeMR(id: number | string, method: 'merge' | 'squash' | 'rebase', request: RequestFn, repoPath: string): Promise<void>;
  closeMR(id: number | string, request: RequestFn, repoPath: string): Promise<void>;
  addComment(id: number | string, body: string, request: RequestFn, repoPath: string): Promise<void>;
  getRepoInfo(request: RequestFn, repoPath: string): Promise<RepoInfo>;
}

type RequestFn = (path: string, opts?: RequestInit) => Promise<unknown>;
type GitPlatform = Exclude<GitPlatformConfig['platform'], 'none'>;
type JsonRecord = Record<string, unknown>;

interface GithubPullDto {
  number: number | string;
  title: string;
  body: string;
  mergedAt: string;
  state: string;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  labels: string[];
  comments: number;
}

interface GithubRepoDto {
  ownerLogin: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  htmlUrl: string;
  isPrivate: boolean;
  stars: number;
  forks: number;
}

interface GithubCreatePullBody {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

interface GitlabMergeRequestDto {
  iid?: number;
  title: string;
  description: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  authorUsername: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  labels: string[];
  userNotesCount: number;
}

interface GitlabRepoDto {
  namespacePath: string;
  path: string;
  pathWithNamespace: string;
  description: string;
  defaultBranch: string;
  webUrl: string;
  visibility: string;
  starCount: number;
  forksCount: number;
}

interface GitlabCreateMergeRequestBody {
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  draft: boolean;
}

interface GiteaPullDto {
  number: number | string;
  title: string;
  body: string;
  merged: boolean;
  state: string;
  headLabel: string;
  baseLabel: string;
  htmlUrl: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  labels: string[];
  comments: number;
}

interface GiteaRepoDto {
  ownerLogin: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  htmlUrl: string;
  isPrivate: boolean;
  stars: number;
  forks: number;
}

interface GiteaCreatePullBody {
  title: string;
  body: string;
  head: string;
  base: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectFrom(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`${label} response was not an array`);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNumberOr(value: unknown, fallback = 0): number {
  return readNumber(value) ?? fallback;
}

function readId(value: unknown): number | string {
  return typeof value === 'number' || typeof value === 'string' ? value : '';
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNestedRecord(record: JsonRecord, key: string): JsonRecord {
  return objectFrom(record[key]);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => readString(objectFrom(label).name))
    .filter((label) => label.length > 0);
}

function parseGithubPullDto(value: unknown): GithubPullDto {
  const raw = objectFrom(value);
  return {
    number: readId(raw.number),
    title: readString(raw.title),
    body: readString(raw.body),
    mergedAt: readString(raw.merged_at),
    state: readString(raw.state),
    headRef: readString(readNestedRecord(raw, 'head').ref),
    baseRef: readString(readNestedRecord(raw, 'base').ref),
    htmlUrl: readString(raw.html_url),
    authorLogin: readString(readNestedRecord(raw, 'user').login),
    createdAt: readString(raw.created_at),
    updatedAt: readString(raw.updated_at),
    draft: readBoolean(raw.draft),
    labels: readLabelNames(raw.labels),
    comments: readNumberOr(raw.comments),
  };
}

function parseGithubRepoDto(value: unknown): GithubRepoDto {
  const raw = objectFrom(value);
  return {
    ownerLogin: readString(readNestedRecord(raw, 'owner').login),
    name: readString(raw.name),
    fullName: readString(raw.full_name),
    description: readString(raw.description),
    defaultBranch: readString(raw.default_branch, 'main'),
    htmlUrl: readString(raw.html_url),
    isPrivate: readBoolean(raw.private),
    stars: readNumberOr(raw.stargazers_count),
    forks: readNumberOr(raw.forks_count),
  };
}

function parseGitlabMergeRequestDto(value: unknown): GitlabMergeRequestDto {
  const raw = objectFrom(value);
  return {
    iid: readNumber(raw.iid),
    title: readString(raw.title),
    description: readString(raw.description),
    state: readString(raw.state),
    sourceBranch: readString(raw.source_branch),
    targetBranch: readString(raw.target_branch),
    webUrl: readString(raw.web_url),
    authorUsername: readString(readNestedRecord(raw, 'author').username),
    createdAt: readString(raw.created_at),
    updatedAt: readString(raw.updated_at),
    draft: readBoolean(raw.draft),
    labels: readStringArray(raw.labels),
    userNotesCount: readNumberOr(raw.user_notes_count),
  };
}

function parseGitlabRepoDto(value: unknown): GitlabRepoDto {
  const raw = objectFrom(value);
  return {
    namespacePath: readString(readNestedRecord(raw, 'namespace').path),
    path: readString(raw.path),
    pathWithNamespace: readString(raw.path_with_namespace),
    description: readString(raw.description),
    defaultBranch: readString(raw.default_branch, 'main'),
    webUrl: readString(raw.web_url),
    visibility: readString(raw.visibility),
    starCount: readNumberOr(raw.star_count),
    forksCount: readNumberOr(raw.forks_count),
  };
}

function parseGiteaPullDto(value: unknown): GiteaPullDto {
  const raw = objectFrom(value);
  return {
    number: readId(raw.number),
    title: readString(raw.title),
    body: readString(raw.body),
    merged: readBoolean(raw.merged),
    state: readString(raw.state),
    headLabel: readString(readNestedRecord(raw, 'head').label),
    baseLabel: readString(readNestedRecord(raw, 'base').label),
    htmlUrl: readString(raw.html_url),
    authorLogin: readString(readNestedRecord(raw, 'user').login),
    createdAt: readString(raw.created_at),
    updatedAt: readString(raw.updated_at),
    draft: readBoolean(raw.draft),
    labels: readLabelNames(raw.labels),
    comments: readNumberOr(raw.comments),
  };
}

function parseGiteaRepoDto(value: unknown): GiteaRepoDto {
  const raw = objectFrom(value);
  return {
    ownerLogin: readString(readNestedRecord(raw, 'owner').login),
    name: readString(raw.name),
    fullName: readString(raw.full_name),
    description: readString(raw.description),
    defaultBranch: readString(raw.default_branch, 'main'),
    htmlUrl: readString(raw.html_url),
    isPrivate: readBoolean(raw.private),
    stars: readNumberOr(raw.stars_count),
    forks: readNumberOr(raw.forks_count),
  };
}

function readErrorMessageBody(value: unknown): string {
  const body = objectFrom(value);
  return readString(body.message) || readString(body.error);
}

// ────────────────────── GitHub Driver ──────────────────────

class GithubDriver implements GitPlatformDriver {
  async listMRs(state: 'open' | 'closed' | 'merged' | 'all', request: RequestFn, repoPath: string): Promise<MergeRequest[]> {
    const ghState = state === 'merged' ? 'closed' : state === 'all' ? 'all' : state;
    const raw = await request(`${repoPath}/pulls?state=${ghState}&per_page=50`);
    return requireArray(raw, 'GitHub pulls').map(pr => this.mapPR(pr));
  }

  async getMR(id: number | string, request: RequestFn, repoPath: string): Promise<MergeRequest> {
    const raw = await request(`${repoPath}/pulls/${id}`);
    return this.mapPR(raw);
  }

  async createMR(params: CreateMRParams, request: RequestFn, repoPath: string): Promise<MergeRequest> {
    const body: GithubCreatePullBody = {
      title: params.title,
      body: params.description || '',
      head: params.sourceBranch,
      base: params.targetBranch,
      draft: params.draft ?? false,
    };
    const raw = await request(`${repoPath}/pulls`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapPR(raw);
  }

  async mergeMR(id: number | string, method: 'merge' | 'squash' | 'rebase', request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/pulls/${id}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: method }),
    });
  }
  async closeMR(id: number | string, request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/pulls/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }

  async addComment(id: number | string, body: string, request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/issues/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async getRepoInfo(request: RequestFn, repoPath: string): Promise<RepoInfo> {
    const raw = parseGithubRepoDto(await request(repoPath));
    return {
      owner: raw.ownerLogin,
      repo: raw.name,
      fullName: raw.fullName,
      description: raw.description,
      defaultBranch: raw.defaultBranch,
      url: raw.htmlUrl,
      isPrivate: raw.isPrivate,
      stars: raw.stars,
      forks: raw.forks,
    };
  }

  private mapPR(raw: unknown): MergeRequest {
    const pr = parseGithubPullDto(raw);
    let state: 'open' | 'merged' | 'closed' = 'open';
    if (pr.mergedAt) state = 'merged';
    else if (pr.state === 'closed') state = 'closed';

    return {
      id: pr.number,
      title: pr.title,
      description: pr.body,
      state,
      sourceBranch: pr.headRef,
      targetBranch: pr.baseRef,
      url: pr.htmlUrl,
      author: pr.authorLogin,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      platform: 'github',
      draft: pr.draft,
      labels: pr.labels,
      comments: pr.comments,
    };
  }
}
// ────────────────────── GitLab Driver ──────────────────────
class GitlabDriver implements GitPlatformDriver {
  async listMRs(state: 'open' | 'closed' | 'merged' | 'all', request: RequestFn, repoPath: string): Promise<MergeRequest[]> {
    const glState = state === 'merged' ? 'merged' : state === 'all' ? '' : state;
    const qs = glState ? `?state=${glState}&per_page=50` : '?per_page=50';
    const raw = await request(`${repoPath}/merge_requests${qs}`);
    return requireArray(raw, 'GitLab merge_requests').map(mr => this.mapMR(mr));
  }

  async getMR(id: number | string, request: RequestFn, repoPath: string): Promise<MergeRequest> {
    const raw = await request(`${repoPath}/merge_requests/${id}`);
    return this.mapMR(raw);
  }

  async createMR(params: CreateMRParams, request: RequestFn, repoPath: string): Promise<MergeRequest> {
    const body: GitlabCreateMergeRequestBody = {
      title: params.title,
      description: params.description || '',
      source_branch: params.sourceBranch,
      target_branch: params.targetBranch,
      draft: params.draft ?? false,
    };
    const raw = await request(`${repoPath}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapMR(raw);
  }

  async mergeMR(id: number | string, method: 'merge' | 'squash' | 'rebase', request: RequestFn, repoPath: string): Promise<void> {
    const glMethod = method === 'squash' ? 'squash' : method === 'rebase' ? 'rebase_merge' : 'merge';
    await request(`${repoPath}/merge_requests/${id}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: glMethod }),
    });
  }

  async closeMR(id: number | string, request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/merge_requests/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'close' }),
    });
  }

  async addComment(id: number | string, body: string, request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/merge_requests/${id}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
  async getRepoInfo(request: RequestFn, repoPath: string): Promise<RepoInfo> {
    const raw = parseGitlabRepoDto(await request(repoPath));
    return {
      owner: raw.namespacePath,
      repo: raw.path,
      fullName: raw.pathWithNamespace,
      description: raw.description,
      defaultBranch: raw.defaultBranch,
      url: raw.webUrl,
      isPrivate: raw.visibility === 'private',
      stars: raw.starCount,
      forks: raw.forksCount,
    };
  }

  private mapMR(raw: unknown): MergeRequest {
    const mr = parseGitlabMergeRequestDto(raw);
    let state: 'open' | 'merged' | 'closed' = 'open';
    if (mr.state === 'merged') state = 'merged';
    else if (mr.state === 'closed') state = 'closed';

    return {
      id: mr.iid ?? '',
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      state,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      url: mr.webUrl,
      author: mr.authorUsername,
      createdAt: mr.createdAt,
      updatedAt: mr.updatedAt,
      platform: 'gitlab',
      draft: mr.draft,
      labels: mr.labels,
      comments: mr.userNotesCount,
    };
  }
}

// ────────────────────── Gitea Driver ──────────────────────

class GiteaDriver implements GitPlatformDriver {
  async listMRs(state: 'open' | 'closed' | 'merged' | 'all', request: RequestFn, repoPath: string): Promise<MergeRequest[]> {
    const giteaState = state === 'merged' ? 'closed' : state === 'all' ? 'open' : state;
    const raw = await request(`${repoPath}/pulls?state=${giteaState}&limit=50`);
    return requireArray(raw, 'Gitea pulls').map(pr => this.mapPR(pr));
  }

  async getMR(id: number | string, request: RequestFn, repoPath: string): Promise<MergeRequest> {
    const raw = await request(`${repoPath}/pulls/${id}`);
    return this.mapPR(raw);
  }
  async createMR(params: CreateMRParams, request: RequestFn, repoPath: string): Promise<MergeRequest> {
    const body: GiteaCreatePullBody = {
      title: params.title,
      body: params.description || '',
      head: params.sourceBranch,
      base: params.targetBranch,
    };
    const raw = await request(`${repoPath}/pulls`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapPR(raw);
  }

  async mergeMR(id: number | string, method: 'merge' | 'squash' | 'rebase', request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/pulls/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ Do: method }),
    });
  }

  async closeMR(id: number | string, request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/pulls/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }

  async addComment(id: number | string, body: string, request: RequestFn, repoPath: string): Promise<void> {
    await request(`${repoPath}/issues/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async getRepoInfo(request: RequestFn, repoPath: string): Promise<RepoInfo> {
    const raw = parseGiteaRepoDto(await request(repoPath));
    return {
      owner: raw.ownerLogin,
      repo: raw.name,
      fullName: raw.fullName,
      description: raw.description,
      defaultBranch: raw.defaultBranch,
      url: raw.htmlUrl,
      isPrivate: raw.isPrivate,
      stars: raw.stars,
      forks: raw.forks,
    };
  }

  private mapPR(raw: unknown): MergeRequest {
    const pr = parseGiteaPullDto(raw);
    let state: 'open' | 'merged' | 'closed' = 'open';
    if (pr.merged) state = 'merged';
    else if (pr.state === 'closed') state = 'closed';

    return {
      id: pr.number,
      title: pr.title,
      description: pr.body,
      state,
      sourceBranch: pr.headLabel,
      targetBranch: pr.baseLabel,
      url: pr.htmlUrl,
      author: pr.authorLogin,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      platform: 'gitea',
      draft: pr.draft,
      labels: pr.labels,
      comments: pr.comments,
    };
  }
}

// ────────────────────── Driver Factory ──────────────────────

const driverRegistry: Record<GitPlatform, () => GitPlatformDriver> = {
  github: () => new GithubDriver(),
  gitlab: () => new GitlabDriver(),
  gitea: () => new GiteaDriver(),
};

function isGitPlatform(platform: string): platform is GitPlatform {
  return platform === 'github' || platform === 'gitlab' || platform === 'gitea';
}

function getDriver(platform: string): GitPlatformDriver {
  if (!isGitPlatform(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const factory = driverRegistry[platform];
  return factory();
}

// ────────────────────── Public API (unchanged interface) ──────────────────────

/**
 * 平台不可用原因 — 确定性分类，供路由层判断是否优雅降级（而非一律 500）。
 *
 * - no_platform: 未配置任何 Git 平台（platform === 'none'）
 * - no_owner_repo: 缺少 owner/repo，无法定位仓库
 * - unauthorized: 401 — 无 token 或 token 无效
 * - forbidden:    403 — token 无权限
 * - not_found:    404 — 仓库不可见 / 不存在
 *
 * 其它失败（5xx、网络错误等）仍抛普通 Error，由路由作为真实 500 上报。
 */
export type GitPlatformUnavailableReason =
  | 'no_platform'
  | 'no_owner_repo'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found';

export class GitPlatformUnavailableError extends Error {
  readonly reason: GitPlatformUnavailableReason;
  constructor(reason: GitPlatformUnavailableReason, message: string) {
    super(message);
    this.name = 'GitPlatformUnavailableError';
    this.reason = reason;
  }
}

export class GitPlatformApi {
  private config: GitPlatformConfig;
  private driver?: GitPlatformDriver;

  constructor(config: GitPlatformConfig) {
    this.config = config;
    if (config.platform !== 'none') {
      this.driver = getDriver(config.platform);
    }
  }

  private get headers(): Record<string, string> {
    const { platform, token } = this.config;
    if (!token) return { 'Content-Type': 'application/json' };
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (platform === 'gitlab') {
      h['PRIVATE-TOKEN'] = token;
    } else {
      h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  private async request(path: string, opts?: RequestInit): Promise<unknown> {
    const { platform, apiUrl } = this.config;
    if (platform === 'none') throw new GitPlatformUnavailableError('no_platform', 'No git platform configured');

    const base = apiUrl || (platform === 'github' ? 'https://api.github.com' : '');
    if (!base) throw new GitPlatformUnavailableError('no_platform', `No API URL configured for platform: ${platform}`);

    const url = `${base.replace(/\/$/, '')}${path}`;
    const scopedFetch = getScopedProxyFetch('tools') || fetch;
    const res = await scopedFetch(url, {
      ...opts,
      headers: { ...this.headers, ...(opts?.headers || {}) },
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = readErrorMessageBody(await res.json()) || msg;
      } catch { /* ignore */ }
      const unavailableReason: GitPlatformUnavailableReason | null =
        res.status === 401 ? 'unauthorized'
          : res.status === 403 ? 'forbidden'
            : res.status === 404 ? 'not_found'
              : null;
      // 访问/配置类错误（401/403/404）确定性归类为「平台不可用」，供路由优雅降级；
      // 其余（5xx 等）仍视为真实错误向上抛。
      if (unavailableReason) throw new GitPlatformUnavailableError(unavailableReason, msg);
      throw new Error(msg);
    }

    if (res.status === 204) return undefined;
    return res.json();
  }

  private get repoPath(): string {
    const { platform, owner, repo } = this.config;
    if (!owner || !repo) throw new GitPlatformUnavailableError('no_owner_repo', 'owner and repo are required');
    const repoPathMap: Partial<Record<GitPlatformConfig['platform'], string>> = {
      github: `/repos/${owner}/${repo}`,
      gitlab: `/projects/${encodeURIComponent(`${owner}/${repo}`)}`,
      gitea: `/repos/${owner}/${repo}`,
    };
    const path = repoPathMap[platform];
    if (!path) throw new Error(`Unsupported platform: ${platform}`);
    return path;
  }

  private ensureDriver(): GitPlatformDriver {
    if (this.config.platform === 'none') throw new GitPlatformUnavailableError('no_platform', 'No git platform configured');
    if (!this.driver) throw new GitPlatformUnavailableError('no_platform', `Unsupported platform: ${this.config.platform}`);
    return this.driver;
  }

  // ────────────────────── MR/PR operations ──────────────────────

  async listMRs(state: 'open' | 'closed' | 'merged' | 'all' = 'open'): Promise<MergeRequest[]> {
    const driver = this.ensureDriver();
    return driver.listMRs(state, this.request.bind(this), this.repoPath);
  }

  async getMR(id: number | string): Promise<MergeRequest | null> {
    const driver = this.ensureDriver();
    try {
      return await driver.getMR(id, this.request.bind(this), this.repoPath);
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  async createMR(params: CreateMRParams): Promise<MergeRequest> {
    const driver = this.ensureDriver();
    return driver.createMR(params, this.request.bind(this), this.repoPath);
  }

  async mergeMR(id: number | string, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<void> {
    const driver = this.ensureDriver();
    return driver.mergeMR(id, method, this.request.bind(this), this.repoPath);
  }

  async closeMR(id: number | string): Promise<void> {
    const driver = this.ensureDriver();
    return driver.closeMR(id, this.request.bind(this), this.repoPath);
  }

  async addComment(id: number | string, body: string): Promise<void> {
    const driver = this.ensureDriver();
    return driver.addComment(id, body, this.request.bind(this), this.repoPath);
  }

  async getRepoInfo(): Promise<RepoInfo | null> {
    const driver = this.ensureDriver();
    try {
      return await driver.getRepoInfo(this.request.bind(this), this.repoPath);
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 测试连接是否有效
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const info = await this.getRepoInfo();
      if (info) {
        return { ok: true, message: `Connected to ${info.fullName}` };
      }
      return { ok: false, message: 'Could not fetch repo info' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
