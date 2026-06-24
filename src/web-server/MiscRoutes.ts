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
    id: 'getting-started', title: 'Getting Started', titleZh: '快速入门',
    content: 'Welcome to Lingxiao (凌霄剑域). Lingxiao is a multi-agent coding assistant with a TUI and Web UI.\n\nRun `lingxiao` to launch, then open the Web UI in your browser.\n\nUse the sidebar to navigate between views: Chat, Editor, Canvas, Terminal, Traces, Workers, and more.',
    contentZh: '欢迎使用凌霄剑域（Lingxiao）。凌霄是一个支持 TUI 与 Web UI 的多智能体编程助手。\n\n运行 `lingxiao` 启动，然后在浏览器中打开 Web UI。\n\n使用侧边栏在各视图之间切换：对话、编辑器、画布、终端、追踪、工作线程等。',
    children: [
      { id: 'installation', title: 'Installation', titleZh: '安装',
        content: '```bash\nnpm install -g lingxiao\nlingxiao\n```\n\nThe Web UI will be available at `http://localhost:8080`.',
        contentZh: '```bash\nnpm install -g lingxiao\nlingxiao\n```\n\nWeb UI 将在 `http://localhost:8080` 可用。' },
      { id: 'configuration', title: 'Configuration', titleZh: '配置',
        content: 'Settings are stored in `~/.lingxiao/settings.json`. Use the Settings view in the Web UI or the `/config` command in TUI.\n\nKey settings:\n- `llm.provider` — LLM provider (openai, anthropic, auto)\n- `llm.leader_model` — Model for the leader agent\n- `llm.enable_extended_thinking` — Enable deep thinking mode',
        contentZh: '设置存储在 `~/.lingxiao/settings.json`。使用 Web UI 中的设置视图或 TUI 中的 `/config` 命令进行修改。\n\n关键设置：\n- `llm.provider` — LLM 提供商（openai、anthropic、auto）\n- `llm.leader_model` — 主智能体使用的模型\n- `llm.enable_extended_thinking` — 启用深度思考模式' },
    ],
  },
  {
    id: 'chat', title: 'Chat View', titleZh: '对话视图',
    content: 'The Chat view is the primary interface for interacting with the AI assistant. Type your message and press Enter to send.\n\nMessages support markdown rendering including code blocks, tables, and thinking content.',
    contentZh: '对话视图是与 AI 助手交互的主要界面。输入消息并按回车发送。\n\n消息支持 Markdown 渲染，包括代码块、表格和思考内容。',
    children: [
      { id: 'deep-thinking', title: 'Deep Thinking', titleZh: '深度思考',
        content: 'Toggle the **sparkles** button in the chat input bar to enable extended thinking mode.\n\nWhen enabled, the model will show its reasoning process in a collapsible "Thinking" block before the response.',
        contentZh: '点击聊天输入栏中的 **✨** 按钮启用深度思考模式。\n\n启用后，模型会在回复前以可折叠的"思考"块展示推理过程。' },
      { id: 'permissions', title: 'Permissions', titleZh: '权限管理',
        content: 'When the AI requests permission to execute a tool (e.g., file write, shell command), an approval banner appears at the bottom of the chat.\n\nYou can approve or deny each request. Approved permissions are shown in the Permission History section.',
        contentZh: '当 AI 请求执行工具（如文件写入、Shell 命令）的权限时，聊天底部会弹出审批横幅。\n\n你可以批准或拒绝每个请求。已批准的权限显示在权限历史区域。' },
      { id: 'file-upload', title: 'File Upload', titleZh: '文件上传',
        content: 'Click the **paperclip** button in the chat input to attach files. Files are uploaded to the server and included in the conversation context.',
        contentZh: '点击聊天输入栏中的**回形针**按钮来附加文件。文件会上传到服务器并纳入对话上下文。' },
    ],
  },
  {
    id: 'canvas', title: 'Canvas & Workflow', titleZh: '画布与工作流',
    content: 'The Canvas view provides a visual workflow editor using drag-and-drop nodes.\n\n**Right-click** on the canvas to add nodes. **Right-click** on a node for actions like Run, Connect, Edit, and Delete.',
    contentZh: '画布视图提供了拖拽式可视化工作流编辑器。\n\n**右键**画布添加节点。**右键**节点可执行运行、连接、编辑、删除等操作。',
    children: [
      { id: 'node-types', title: 'Node Types', titleZh: '节点类型',
        content: '- **Agent** — Represents an AI agent that can execute tasks\n- **Tool** — Represents a tool/function call\n- **Condition** — Branching logic node\n- **Input/Output** — Data flow entry/exit points\n\nThe Leader node automatically appears when a session is active and syncs with the real agent status.',
        contentZh: '- **Agent** — AI 智能体节点，可执行任务\n- **Tool** — 工具/函数调用节点\n- **Condition** — 分支逻辑节点\n- **Input/Output** — 数据流入口/出口节点\n\n当会话活跃时，Leader 节点会自动出现并与真实智能体状态同步。' },
      { id: 'canvas-actions', title: 'Canvas Actions', titleZh: '画布操作',
        content: '- **Right-click canvas** — Add node, Fit view, Reset\n- **Right-click node** — Run, Connect to, Edit, Mark complete/paused, Delete\n- **Drag** nodes to rearrange\n- **Scroll** to zoom\n- **Drag canvas** to pan',
        contentZh: '- **右键画布** — 添加节点、自适应视图、重置\n- **右键节点** — 运行、连接、编辑、标记完成/暂停、删除\n- **拖拽**节点重新排列\n- **滚轮**缩放\n- **拖拽画布**平移' },
    ],
  },
  {
    id: 'terminal', title: 'Terminal', titleZh: '终端',
    content: 'The Terminal view provides an interactive shell via WebSocket. Commands run in the project workspace.\n\nThe terminal supports full interactivity including colors, cursor movement, and resize.',
    contentZh: '终端视图通过 WebSocket 提供交互式 Shell。命令在项目工作空间中运行。\n\n终端支持完整的交互功能，包括颜色、光标移动和窗口缩放。',
  },
  {
    id: 'editor', title: 'Editor', titleZh: '编辑器',
    content: 'The Editor view is a VS Code-powered code editor using Monaco Editor.\n\nFeatures:\n- Full syntax highlighting for 50+ languages\n- File tree browser with create/delete support\n- Ctrl+S to save\n- Image preview\n- Multiple open tabs',
    contentZh: '编辑器视图是基于 Monaco Editor 的 VS Code 风格代码编辑器。\n\n功能特性：\n- 50+ 语言的完整语法高亮\n- 支持创建/删除的文件树浏览器\n- Ctrl+S 保存\n- 图片预览\n- 多标签页打开',
    children: [
      { id: 'editor-shortcuts', title: 'Keyboard Shortcuts', titleZh: '快捷键',
        content: '| Shortcut | Action |\n|----------|--------|\n| Ctrl+S | Save file |\n| Ctrl+P | Quick open |\n| Ctrl+Shift+P | Command palette |\n| Ctrl+G | Go to line |',
        contentZh: '| 快捷键 | 功能 |\n|----------|--------|\n| Ctrl+S | 保存文件 |\n| Ctrl+P | 快速打开 |\n| Ctrl+Shift+P | 命令面板 |\n| Ctrl+G | 跳转到行 |' },
    ],
  },
  {
    id: 'api', title: 'API Reference', titleZh: 'API 参考',
    content: 'Lingxiao exposes a REST API at `/api/v1/` and an ACP protocol for real-time communication.',
    contentZh: '凌霄在 `/api/v1/` 暴露 REST API，并通过 ACP 协议进行实时通信。',
    children: [
      { id: 'acp-protocol', title: 'ACP Protocol', titleZh: 'ACP 协议',
        content: 'The Agent Communication Protocol uses **SSE + JSON-RPC**.\n\n1. `POST /api/v1/acp/connect` — Establish connection, get session token\n2. `GET /api/v1/acp` — Subscribe to SSE events\n3. `POST /api/v1/acp` — Send JSON-RPC commands\n\nKey JSON-RPC methods: `session/prompt`, `session/cancel`, `_lingxiao.ai/getUserInfo`',
        contentZh: 'Agent Communication Protocol 基于 **SSE + JSON-RPC**。\n\n1. `POST /api/v1/acp/connect` — 建立连接，获取会话 token\n2. `GET /api/v1/acp` — 订阅 SSE 事件\n3. `POST /api/v1/acp` — 发送 JSON-RPC 命令\n\n常用 JSON-RPC 方法：`session/prompt`、`session/cancel`、`_lingxiao.ai/getUserInfo`' },
      { id: 'rest-api', title: 'REST API', titleZh: 'REST API',
        content: 'All REST endpoints require the `x-lingxiao-request: 1` header.\n\n| Endpoint | Description |\n|----------|-------------|\n| `GET /api/v1/info` | System information |\n| `GET /api/v1/settings` | Read settings |\n| `PUT /api/v1/settings/:group` | Update setting |\n| `GET /api/v1/workers` | Active workers |\n| `GET /api/v1/plugins` | Installed plugins |\n| `GET /api/v1/stats` | Usage statistics |',
        contentZh: '所有 REST 端点需要 `x-lingxiao-request: 1` 请求头。\n\n| 端点 | 描述 |\n|----------|-------------|\n| `GET /api/v1/info` | 系统信息 |\n| `GET /api/v1/settings` | 读取设置 |\n| `PUT /api/v1/settings/:group` | 更新设置 |\n| `GET /api/v1/workers` | 活跃工作线程 |\n| `GET /api/v1/plugins` | 已安装插件 |\n| `GET /api/v1/stats` | 使用统计 |' },
      { id: 'storage', title: 'Storage KV', titleZh: 'KV 存储',
        content: 'Persistent key-value storage via:\n- `GET /api/v1/storage` — List keys\n- `PUT /api/v1/storage` — Set value\n- `DELETE /api/v1/storage/:id` — Delete key\n\nSupports `key`, `namespace`, and `scope` parameters.',
        contentZh: '持久化键值存储接口：\n- `GET /api/v1/storage` — 列出键\n- `PUT /api/v1/storage` — 设置值\n- `DELETE /api/v1/storage/:id` — 删除键\n\n支持 `key`、`namespace` 和 `scope` 参数。' },
    ],
  },
  {
    id: 'traces', title: 'Traces', titleZh: '追踪',
    content: 'The Traces view shows agent execution traces with 4 visualization modes:\n\n1. **Timeline** — Chronological list of events\n2. **Tree** — Hierarchical view of agent-tool relationships\n3. **Flame** — Duration-based visualization\n4. **Graph** — DAG layout of spans\n\nTraces are loaded from the session\'s agent logs and updated in real-time via SSE.',
    contentZh: '追踪视图以 4 种可视化模式展示智能体执行追踪：\n\n1. **时间线** — 按时间顺序列出事件\n2. **树形图** — 智能体-工具关系的层级视图\n3. **火焰图** — 基于时长的可视化\n4. **拓扑图** — DAG 布局的 Span 视图\n\n追踪数据从会话的智能体日志加载，并通过 SSE 实时更新。',
  },
  {
    id: 'keyboard', title: 'Keyboard Shortcuts', titleZh: '快捷键',
    content: 'Use `Ctrl+Shift+P` to open the command palette.\n\nSee the Keybindings view for all available keyboard shortcuts.',
    contentZh: '使用 `Ctrl+Shift+P` 打开命令面板。\n\n查看快捷键视图了解所有可用快捷键。',
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
          loaded.push({ id, title, titleZh: title, content: body.trim(), contentZh: body.trim() });
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
