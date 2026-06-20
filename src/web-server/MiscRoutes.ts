/**
 * MiscRoutes — Auth、Storage、Info、Docs、Metrics、Traces、Scheduled Tasks 路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { ServerAuth } from './ServerAuth.js';
import type { StorageApi } from './StorageApi.js';
import { getSystemInfo, getSystemMetrics } from './index.js';
import { metrics, refreshUptime } from '../core/MetricsRegistry.js';
import type { AuthFn } from './types.js';
import { VERSION } from '../version.js';
import { requireTokenInHeaderOnly, rateLimitExemptLocalhost } from '../core/HardeningPolicy.js';

/**
 * 版本检测缓存与辅助函数
 */

const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5分钟

interface VersionCheckData {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes: string;
}

let versionCheckCache: { data: VersionCheckData; timestamp: number } | null = null;

/** 桌面端 electron-updater 状态（由 desktop/main.ts 通过 setDesktopUpdateStatus 设置） */
let desktopUpdateStatus: { updateDownloaded: boolean; updateVersion: string | null } | null = null;

export function setDesktopUpdateStatus(status: { updateDownloaded: boolean; updateVersion: string | null } | null): void {
  desktopUpdateStatus = status;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body: string;
}

/** 调用 GitHub API 获取最新 release */
async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const url = 'https://api.github.com/repos/hexian2001/lingxiao-coding/releases/latest';
  const res = await globalThis.fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': `LingXiaoCLI/${VERSION}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json() as GitHubRelease;
  return data;
}

/** 比较语义版本号：返回 >0 表示 a 更新，<0 表示 b 更新，0 表示相等 */
function compareVersions(a: string, b: string): number {
  const parseVer = (v: string): number[] =>
    v.replace(/^v/, '').split(/[.+-]/).filter(s => /^\d+$/.test(s)).map(Number);
  const partsA = parseVer(a);
  const partsB = parseVer(b);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

const builtinDocs = [
  {
    id: 'getting-started', title: 'Getting Started',
    content: 'Welcome to Lingxiao (凌霄剑域). Lingxiao is a multi-agent coding assistant with a TUI and Web UI.\n\nRun `lingxiao` to launch, then open the Web UI in your browser.\n\nUse the sidebar to navigate between views: Chat, Editor, Canvas, Terminal, Traces, Workers, and more.',
    children: [
      { id: 'installation', title: 'Installation', content: '```bash\nnpm install -g lingxiao\nlingxiao\n```\n\nThe Web UI will be available at `http://localhost:8080`.' },
      { id: 'configuration', title: 'Configuration', content: 'Settings are stored in `~/.lingxiao/settings.json`. Use the Settings view in the Web UI or the `/config` command in TUI.\n\nKey settings:\n- `llm.provider` — LLM provider (openai, anthropic, auto)\n- `llm.leader_model` — Model for the leader agent\n- `llm.enable_extended_thinking` — Enable deep thinking mode' },
    ],
  },
  {
    id: 'chat', title: 'Chat View',
    content: 'The Chat view is the primary interface for interacting with the AI assistant. Type your message and press Enter to send.\n\nMessages support markdown rendering including code blocks, tables, and thinking content.',
    children: [
      { id: 'deep-thinking', title: 'Deep Thinking', content: 'Toggle the **sparkles** button in the chat input bar to enable extended thinking mode.\n\nWhen enabled, the model will show its reasoning process in a collapsible "Thinking" block before the response.' },
      { id: 'permissions', title: 'Permissions', content: 'When the AI requests permission to execute a tool (e.g., file write, shell command), an approval banner appears at the bottom of the chat.\n\nYou can approve or deny each request. Approved permissions are shown in the Permission History section.' },
      { id: 'file-upload', title: 'File Upload', content: 'Click the **paperclip** button in the chat input to attach files. Files are uploaded to the server and included in the conversation context.' },
    ],
  },
  {
    id: 'canvas', title: 'Canvas & Workflow',
    content: 'The Canvas view provides a visual workflow editor using drag-and-drop nodes.\n\n**Right-click** on the canvas to add nodes. **Right-click** on a node for actions like Run, Connect, Edit, and Delete.',
    children: [
      { id: 'node-types', title: 'Node Types', content: '- **Agent** — Represents an AI agent that can execute tasks\n- **Tool** — Represents a tool/function call\n- **Condition** — Branching logic node\n- **Input/Output** — Data flow entry/exit points\n\nThe Leader node automatically appears when a session is active and syncs with the real agent status.' },
      { id: 'canvas-actions', title: 'Canvas Actions', content: '- **Right-click canvas** — Add node, Fit view, Reset\n- **Right-click node** — Run, Connect to, Edit, Mark complete/paused, Delete\n- **Drag** nodes to rearrange\n- **Scroll** to zoom\n- **Drag canvas** to pan' },
    ],
  },
  {
    id: 'terminal', title: 'Terminal',
    content: 'The Terminal view provides an interactive shell via WebSocket. Commands run in the project workspace.\n\nThe terminal supports full interactivity including colors, cursor movement, and resize.',
  },
  {
    id: 'editor', title: 'Editor',
    content: 'The Editor view is a VS Code-powered code editor using Monaco Editor.\n\nFeatures:\n- Full syntax highlighting for 50+ languages\n- File tree browser with create/delete support\n- Ctrl+S to save\n- Image preview\n- Multiple open tabs',
    children: [
      { id: 'editor-shortcuts', title: 'Keyboard Shortcuts', content: '| Shortcut | Action |\n|----------|--------|\n| Ctrl+S | Save file |\n| Ctrl+P | Quick open |\n| Ctrl+Shift+P | Command palette |\n| Ctrl+G | Go to line |' },
    ],
  },
  {
    id: 'api', title: 'API Reference',
    content: 'Lingxiao exposes a REST API at `/api/v1/` and an ACP protocol for real-time communication.',
    children: [
      { id: 'acp-protocol', title: 'ACP Protocol', content: 'The Agent Communication Protocol uses **SSE + JSON-RPC**.\n\n1. `POST /api/v1/acp/connect` — Establish connection, get session token\n2. `GET /api/v1/acp` — Subscribe to SSE events\n3. `POST /api/v1/acp` — Send JSON-RPC commands\n\nKey JSON-RPC methods: `session/prompt`, `session/cancel`, `_lingxiao.ai/getUserInfo`' },
      { id: 'rest-api', title: 'REST API', content: 'All REST endpoints require the `x-lingxiao-request: 1` header.\n\n| Endpoint | Description |\n|----------|-------------|\n| `GET /api/v1/info` | System information |\n| `GET /api/v1/settings` | Read settings |\n| `PUT /api/v1/settings/:group` | Update setting |\n| `GET /api/v1/workers` | Active workers |\n| `GET /api/v1/plugins` | Installed plugins |\n| `GET /api/v1/stats` | Usage statistics |' },
      { id: 'storage', title: 'Storage KV', content: 'Persistent key-value storage via:\n- `GET /api/v1/storage` — List keys\n- `PUT /api/v1/storage` — Set value\n- `DELETE /api/v1/storage/:id` — Delete key\n\nSupports `key`, `namespace`, and `scope` parameters.' },
    ],
  },
  {
    id: 'traces', title: 'Traces',
    content: 'The Traces view shows agent execution traces with 4 visualization modes:\n\n1. **Timeline** — Chronological list of events\n2. **Tree** — Hierarchical view of agent-tool relationships\n3. **Flame** — Duration-based visualization\n4. **Graph** — DAG layout of spans\n\nTraces are loaded from the session\'s agent logs and updated in real-time via SSE.',
  },
  {
    id: 'keyboard', title: 'Keyboard Shortcuts',
    content: 'Use `Ctrl+Shift+P` to open the command palette.\n\nSee the Keybindings view for all available keyboard shortcuts.',
  },
];

export function registerMiscRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    serverAuth: ServerAuth;
    storageApi: StorageApi;
    requireServerToken: AuthFn;
  },
): void {
  const { repos, serverAuth, storageApi, requireServerToken } = deps;

  // --- Auth ---
  fastify.get('/api/v1/auth/status', async (request) => {
    const authenticated = serverAuth.validate(request);
    return { authEnabled: true, authenticated, method: 'server_token' };
  });

  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const body = request.body as { token?: string };
    if (body.token === serverAuth.token) {
      return { success: true };
    }
    reply.status(401);
    return { success: false, error: 'Invalid token' };
  });

  // --- Local-only token recovery (本地私有化场景) ---
  // 用户关掉网页重新打开 http://localhost:PORT 时，前端 localStorage 无 token
  // 可通过此端点无感获取当前 server token，避免 401。
  // 安全保障：仅允许 loopback 访问；加固模式下禁用（加固模式不信任 IP，要求显式 token）。
  fastify.get('/api/v1/auth/local-token', async (request, reply) => {
    // 加固模式禁用此端点
    if (requireTokenInHeaderOnly()) {
      reply.status(403);
      return { error: 'Forbidden: local-token endpoint disabled in hardened mode' };
    }
    // 仅允许本机访问（与 server.ts shouldExemptFromRateLimit 逻辑一致，内联以避免循环依赖）
    const ip = request.ip;
    const hasRemoteAddress = Boolean(request.raw.socket.remoteAddress);
    const isLocalAccess = !hasRemoteAddress || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocalAccess || !rateLimitExemptLocalhost()) {
      reply.status(403);
      return { error: 'Forbidden: local access only' };
    }
    return { token: serverAuth.token };
  });

  // --- Storage KV ---
  fastify.get('/api/v1/storage', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { key?: string; namespace?: string; scope: string };
    const scope = query.scope || 'global';

    if (query.key) {
      const result = storageApi.getValue(query.key, scope);
      return { data: result };
    } else if (query.namespace) {
      const result = storageApi.getNamespace(query.namespace, scope);
      return { data: result };
    }

    reply.status(400);
    return { error: 'key or namespace is required' };
  });

  fastify.put('/api/v1/storage', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { scope: string };
    const scope = query.scope || 'global';
    const body = request.body as { key?: string; value?: unknown; entries?: Array<{ key: string; value: unknown }> };

    if (body.entries) {
      return storageApi.setEntries(body.entries, scope);
    } else if (body.key !== undefined) {
      return storageApi.setValue(body.key, body.value, scope);
    }

    reply.status(400);
    return { error: 'key+value or entries is required' };
  });

  fastify.delete('/api/v1/storage', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { key: string; scope: string };
    const scope = query.scope || 'global';

    if (!query.key) {
      reply.status(400);
      return { error: 'key is required' };
    }

    return storageApi.deleteValue(query.key, scope);
  });

  // --- Info ---
  fastify.get('/api/v1/info', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: getSystemInfo() };
  });

  // --- Docs ---
  let cachedDocs: typeof builtinDocs | null = null;
  fastify.get('/api/v1/docs', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (cachedDocs) return { data: cachedDocs };
    const { existsSync, readdirSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const docsDir = join(process.cwd(), 'docs');
    if (existsSync(docsDir)) {
      try {
        const files = readdirSync(docsDir).filter(f => f.endsWith('.md')).sort();
        const loaded: typeof builtinDocs = [];
        for (const file of files) {
          const content = readFileSync(join(docsDir, file), 'utf-8');
          const id = file.replace(/\.md$/, '');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
          let title = id.replace(/[-_]/g, ' ').replace(/^./, s => s.toUpperCase());
          let body = content;
          if (fmMatch) {
            const titleMatch = fmMatch[1].match(/^title:\s*(.+)$/m);
            if (titleMatch) title = titleMatch[1].trim();
            body = content.slice(fmMatch[0].length);
          }
          loaded.push({ id, title, content: body.trim() });
        }
        if (loaded.length > 0) {
          cachedDocs = loaded;
          return { data: cachedDocs };
        }
      } catch {/* expected: best-effort cleanup */}
    }
    cachedDocs = builtinDocs;
    return { data: builtinDocs };
  });

  // --- Prometheus Metrics ---
  fastify.get('/metrics', async (_request, reply) => {
    refreshUptime();
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.serialize();
  });

  // --- Metrics (JSON, for frontend) ---
  fastify.get('/api/v1/metrics', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    refreshUptime();
    return { data: { ...getSystemMetrics(), runtime: metrics.toJSON() } };
  });

  // --- Health History ---
  fastify.get('/api/v1/health/history', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId, limit } = request.query as { sessionId?: string; limit?: string };
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    try {
      const sqlite = repos.raw.getDb();
      const rows = sqlite.prepare(
        `SELECT * FROM health_reports WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
      ).all(sessionId, Number(limit) || 50);
      return { data: rows.map((r: Record<string, unknown>) => ({ ...r, decisions: JSON.parse(String(r.decisions ?? '[]')) })) };
    } catch {/* expected: fallback to default */
      return { data: [] };
    }
  });

  // --- Traces ---
  fastify.get('/api/v1/traces', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    const logs = repos.agentLogs.listBySession(sessionId);
    const states = repos.agentState.listBySession(sessionId);
    const stateMap = new Map(states.map((s) => [s.agent_id, s]));
    const tokenRows = repos.tokenUsage.getBySession(sessionId);
    const traces = logs.map((log) => {
      const state = stateMap.get(log.agent_id);
      let parsedContent: unknown = log.content;
      try { parsedContent = JSON.parse(log.content); } catch {/* expected: malformed JSON */}
      const agentTokens = tokenRows
        .filter((t) => t.agent_id === log.agent_id)
        .reduce((acc, t) => ({
          prompt: acc.prompt + (t.prompt || 0),
          completion: acc.completion + (t.completion || 0),
          total: acc.total + (t.total || 0),
        }), { prompt: 0, completion: 0, total: 0 });
      return {
        id: log.id,
        sessionId: log.session_id,
        agentId: log.agent_id,
        agentName: log.agent_name,
        agentRole: log.agent_role,
        taskId: log.task_id,
        eventType: log.event_type,
        content: parsedContent,
        tokenUsage: (agentTokens.total > 0) ? agentTokens : undefined,
        agentStatus: state?.status,
        agentIteration: state?.iteration,
        timestamp: log.timestamp,
      };
    });
    return { data: traces, states, tokenSummary: tokenRows.reduce((acc, t) => ({
      prompt: acc.prompt + (t.prompt || 0),
      completion: acc.completion + (t.completion || 0),
      total: acc.total + (t.total || 0),
    }), { prompt: 0, completion: 0, total: 0 }) };
  });

  // --- Scheduled Tasks (handled by server.ts with ScheduledTaskManager) ---
  // These routes are registered in server.ts directly, not here.

  // --- Version Check ---
  // GET /api/v1/version/check — 检查 GitHub Releases 是否有新版本，5分钟缓存
  fastify.get('/api/v1/version/check', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    // 缓存：5分钟内直接返回上次结果
    const now = Date.now();
    if (versionCheckCache && (now - versionCheckCache.timestamp) < VERSION_CACHE_TTL) {
      return { data: versionCheckCache.data };
    }

    try {
      const current = VERSION;
      const release = await fetchLatestRelease();
      if (!release) {
        const result = { current, latest: current, hasUpdate: false, releaseUrl: '', releaseNotes: '' };
        versionCheckCache = { data: result, timestamp: now };
        return { data: result };
      }

      const latest = release.tag_name.replace(/^v/, '');
      const hasUpdate = compareVersions(latest, current) > 0;
      const result = {
        current,
        latest,
        hasUpdate,
        releaseUrl: release.html_url || '',
        releaseNotes: release.body || '',
      };
      versionCheckCache = { data: result, timestamp: now };
      return { data: result };
    } catch {
      // GitHub API 不可达时返回当前版本，不报错
      const result = { current: VERSION, latest: VERSION, hasUpdate: false, releaseUrl: '', releaseNotes: '' };
      return { data: result };
    }
  });

  // GET /api/v1/version/status — 返回桌面端更新状态
  fastify.get('/api/v1/version/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    // 判断是否在 Electron 桌面端运行
    const isDesktop = !!(process.versions as Record<string, string | undefined>).electron;

    if (isDesktop && desktopUpdateStatus) {
      return { data: { isDesktop: true, updateDownloaded: desktopUpdateStatus.updateDownloaded, updateVersion: desktopUpdateStatus.updateVersion } };
    }

    return { data: { isDesktop, updateDownloaded: false, updateVersion: null } };
  });
}
