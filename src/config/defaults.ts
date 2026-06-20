import { DEFAULT_LINGXIAO_USER_AGENT } from '../version.js';

/**
 * 集中常量定义 — 所有默认值的唯一来源
 *
 * 每个常量都按功能分组，使用 `as const` 确保类型安全。
 * 用户可通过 settings.json 覆盖这些默认值。
 *
 * 规则：
 * - 用户可能调整的值 → 同时加入 ConfigSchema（settings.json 可配置）
 * - 内部实现细节 → 仅在此文件定义，不暴露给 /config UI
 * - 任何新数字常量必须添加到此文件，不得在业务代码中硬编码
 */

// ═══════════════════════════════════════════════════════════════
// LLM 相关
// ═══════════════════════════════════════════════════════════════

export const LLM = {
  /** 上下文窗口最大 token 数 */
  CONTEXT_MAX_TOKENS: 200_000,
  /** 默认 max_tokens 上限 — 16K 覆盖绝大多数响应，减少截断重试 */
  CAPPED_MAX_TOKENS: 16_384,
  /** 升级后 max_tokens — 覆盖绝大多数长输出场景 */
  ESCALATED_MAX_TOKENS: 65_536,
  /** 思考预算 token 数 */
  THINKING_BUDGET_TOKENS: 32_000,
  /**
   * LLM 请求总超时 (秒) — SDK 层 socket-level hang 兜底。
   * 180s 平衡 thinking 模型长思考与交互式体验：正常请求由 first-token watchdog
   * 和流式 chunk 活动保活，不会等到此超时；只有 SDK/网络层完全 hang 时才触发。
   * 2026-05-27 曾调高到 600s 防 thinking 模型偶发卡顿，但 600s×5 重试 = 50 分钟
   * 不可接受。现改为 180s + 首 token watchdog + 3 次重试，最坏 ~9 分钟。
   */
  REQUEST_TIMEOUT_S: 180,
  /** LLM 连接超时 (秒) */
  CONNECT_TIMEOUT_S: 30,
  /**
   * LLM 重试预算。3 次平衡容错和响应速度：180s×3 ≈ 9 分钟最坏，远优于 600s×5 ≈ 50 分钟。
   * CircuitBreaker 在连续失败时仍会提前熔断，不需要大 retry 预算兜底。
   */
  MAX_RETRIES: 3,
  /** LLM 错误重试退避基数 (ms) — 300ms 快速重试，3 次退避序列 300/600/900ms */
  BACKOFF_BASE_MS: 300,
  /**
   * 首 token 超时 (秒) — 流式请求建连后等待第一个 token 的最长时间。
   * 超时后 abort 当前 attempt 并按 stream_timeout 重试（recycle 连接池）。
   * 非流式请求不使用此超时，由 request_timeout_s + hang watchdog 兜底。
   */
  FIRST_TOKEN_TIMEOUT_S: 30,
  /**
   * thinking 模型的首 token 超时 (秒) — reasoning 模型在输出前有内部思考阶段，
   * 正常可能 30-60s 才出第一个 token。90s 给足够余量，超时则大概率是排队/hang。
   */
  FIRST_TOKEN_THINKING_TIMEOUT_S: 90,
  /**
   * 推理/编排/判定类 LLM 调用的采样温度。0 = 确定性解码，最大化降低漂移。
   * 这是防漂移的根因修复之一：主推理循环此前完全不设温度，走 provider 默认(~1.0)
   * 随机解码，导致相同任务两次跑出不同任务分解/工具选择/续跑判定。
   * 取 1 可经 env LINGXIAO_REASONING_TEMPERATURE 恢复旧行为。
   */
  REASONING_TEMPERATURE: 0,
} as const;

export const NETWORK = {
  USER_AGENT: DEFAULT_LINGXIAO_USER_AGENT,
} as const;

// ═══════════════════════════════════════════════════════════════
// Agent 相关
// ═══════════════════════════════════════════════════════════════

export const AGENT = {
  /** 最大并发 Agent 数 */
  MAX_CONCURRENT: 5,
  /** Agent 最大迭代次数 */
  MAX_ITERATIONS: 200,
  /** Agent 最大运行时间 (分钟) — 24×7 模式给足时间，大型任务可能需要数小时 */
  MAX_RUNTIME_MINUTES: 480,
  /** 权限请求超时 (ms) */
  PERMISSION_TIMEOUT_MS: 300_000,
  /** 对话最大消息数 */
  MAX_CONVERSATION_MESSAGES: 500,
  /** 单 Agent 最大消息数 */
  MAX_AGENT_MESSAGES: 300,
  /** 工具结果默认截断长度 */
  TOOL_RESULT_MAX_CHARS: 4_000,
  /** 最大续接深度 */
  MAX_CONTINUATION_DEPTH: 3,
  /** 是否启用 Claude/Codex 外部子 Agent */
  EXTERNAL_AGENTS_ENABLED: true,
  /** 初始可注入图片数 */
  MAX_INITIAL_IMAGES: 3,
} as const;

export const TOOLS = {
  /** Default watchdog for tools that do not declare their own execution window. */
  EXECUTION_TIMEOUT_MS: 60_000,
} as const;

// ═══════════════════════════════════════════════════════════════
// Leader 相关
// ═══════════════════════════════════════════════════════════════

export const LEADER = {
  /** Leader 最大工具轮次 */
  MAX_TOOL_ROUNDS: 100,
  /** Leader 最大运行时间 (分钟) — 24×7 模式持续运行 */
  MAX_RUNTIME_MINUTES: 480,
  /** Leader 探测沉默阈值 (秒) — Agent 启动后首次静默多久开始探测 */
  PROBE_SILENCE_SECONDS: 300,
  /** Leader 探测最大间隔 (秒) */
  PROBE_MAX_INTERVAL_SECONDS: 900,
  /** Leader 探测退避倍数 */
  PROBE_BACKOFF_MULTIPLIER: 2,
  /** Leader 空闲警告时间 (秒) */
  IDLE_WARNING_SECONDS: 900,
  /** 空闲探测最大等待 (ms) */
  IDLE_PROBE_MAX_WAIT_MS: 30_000,
  /** 空闲探测退避基数 (ms) */
  IDLE_PROBE_BACKOFF_BASE_MS: 2_000,
  /** 流式缓冲刷新阈值 (chars)
   *  作用：把 LLM 逐 token chunk 聚合后再 emit，避免每 token 一次事件。
   *  - 首 token 延迟由 StreamChunkBuffer 的 idleFlushMs(10ms) 兜底，不受此阈值影响。
   *  - 此阈值主要决定流式中段的聚合粒度。TUI 侧另有 30ms coordinator 二级节流兜底，
   *    但 SSE/web 直接消费 emit（无二级节流），阈值越小 web 流式越顺滑。
   *  50→24 (2026-05-29)：web 端流式更细腻，TUI 端因 30ms 上限不受影响。 */
  STREAM_BUFFER_FLUSH_THRESHOLD: 24,
  /** Agent 报告最大字符数 */
  AGENT_REPORT_MAX_CHARS: 5_000,
  /** 思维缓冲阈值 */
  THINKING_BUFFER_THRESHOLD: 150,
  /** 等待超时 (有进行中任务, ms) — supervision 计算自适应间隔，此为兜底值 */
  WAIT_TIMEOUT_BUSY_MS: 60_000,
  /** 等待超时 (无进行中任务, ms) — 空闲时降频轮询 */
  WAIT_TIMEOUT_IDLE_MS: 120_000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 健康监控
// ═══════════════════════════════════════════════════════════════

export const HEALTH = {
  /** 轮询间隔 (秒) — 事件驱动即时响应，轮询仅作兜底 */
  POLL_INTERVAL_SECONDS: 60,
  /** 无活动 → stalling (秒) */
  STALL_THRESHOLD_SECONDS: 180,
  /** 无活动 → stuck (秒) */
  STUCK_THRESHOLD_SECONDS: 420,
  /** 无活动 → runaway (秒) */
  RUNAWAY_THRESHOLD_SECONDS: 1_800,
  /** nudge 冷却 (秒) */
  NUDGE_COOLDOWN_SECONDS: 120,
  /** 最多 nudge 次数后升级干预 */
  MAX_NUDGE_BEFORE_ESCALATION: 2,
} as const;

// ═══════════════════════════════════════════════════════════════
// 上下文管理
// ═══════════════════════════════════════════════════════════════

export const CONTEXT = {
  /**
   * 上下文 token 上限（用户意图的「有效工作上限」）。
   * 仅作文档/迁移参考：schema 默认不再写死，未设 token_limit 时凌霄自动跟随模型
   * 真实上下文窗口；显式设置则优先于模型窗口，压缩在其 ~80% 触发。
   * 详见 ContextManager.resolveEffectiveContextLimit。
   */
  TOKEN_LIMIT: 150_000,
  /** 摘要最大输出 token 数 */
  MAX_OUTPUT_TOKENS_FOR_SUMMARY: 20_000,
  /** 自动压缩缓冲 token 数 */
  AUTOCOMPACT_BUFFER_TOKENS: 20_000,
  /** 自动全文压缩固定在上下文上限 80% 触发；保留该配置仅兼容旧 settings */
  AUTOCOMPACT_RATIO: 0.8,
  /** 模型特定的 ratio 覆盖；保留该配置仅兼容旧 settings */
  AUTOCOMPACT_MODEL_RATIO_OVERRIDES: {} as Record<string, number>,
  /** 最大连续压缩失败次数 */
  MAX_CONSECUTIVE_FAILURES: 3,
  /** 压缩 LLM 超时 (ms) */
  COMPACT_LLM_TIMEOUT_MS: 30_000,
  /**
   * 单次 LLM 请求体的最大字节数（UTF-8）。
   *
   * HTTP 413 "Payload Too Large" 是网关/反代（nginx client_max_body_size、云 LB）
   * 对请求 body **字节大小**的限制，与模型 token 上下文窗口无关 —— 300K token 的
   * 中文/JSON/base64 序列化后可能数 MB，远未触及 token 阈值却已被网关拒绝。
   *
   * 默认 1_400_000（≈1.33MB），低于常见 1536KB 网关上限，余量留给 system prompt +
   * tools schema + JSON 框架。超过 calculateByteThreshold(此值) 即触发字节级压缩。
   */
  MAX_REQUEST_BYTES: 1_400_000,
  /**
   * 单条消息的最大字节数（UTF-8）。超过即对该条做「中段截断 + 全文归档」，
   * 避免单条巨型消息（一次粘贴几十万字 / 巨大工具结果）落在 pinned/recent 窗口里
   * 永远无法被现有按整条 pop 的压缩逻辑缩减，导致 413 死循环。默认 262_144（256KB）。
   */
  MAX_SINGLE_MESSAGE_BYTES: 262_144,
  /** 压缩后最大文件数 */
  POST_COMPACT_MAX_FILES: 10,
  /** 压缩后 token 预算 */
  POST_COMPACT_TOKEN_BUDGET: 200_000,
  /** 压缩后每文件最大 token 数 */
  POST_COMPACT_MAX_TOKENS_PER_FILE: 6_000,
  /** 最近文件容量 */
  RECENT_FILES_CAPACITY: 10,
  /** 最近窗口 token 预算 */
  RECENT_WINDOW_TOKEN_BUDGET: 150_000,
  /** 最近消息最大条数 */
  MAX_RECENT_MESSAGE_COUNT: 40,
  /** 分块 token 预算 */
  CHUNK_TOKEN_BUDGET: 8_000,
  /** 最大摘要深度 */
  MAX_SUMMARY_DEPTH: 3,
  /** 保留系统消息数 */
  PRESERVED_SYSTEM_COUNT: 3,
  /** 保留最近消息数 */
  PRESERVED_RECENT_COUNT: 24,
  /** 压缩后工具结果最大长度 */
  COMPRESSED_TOOL_RESULT_MAX: 200,
} as const;

export const FILE_PARSER = {
  /** Preview output character budget */
  PREVIEW_MAX_CHARS: 3000,
  /** Full output character budget */
  FULL_MAX_CHARS: 50000,
  /** Maximum file size for parsers that must load/decompress whole documents */
  MAX_PARSE_BYTES: 50 * 1024 * 1024,
  /** Maximum accepted upload size per file */
  MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
  /** Maximum accepted upload size per request */
  MAX_UPLOAD_TOTAL_BYTES: 100 * 1024 * 1024,
  /** Maximum files accepted in one upload request */
  MAX_UPLOAD_FILES: 20,
  /** Bytes needed for magic-byte detection */
  MAGIC_READ_BYTES: 512,
  /** Bounded ZIP sniffing window for Office format detection */
  ZIP_SNIFF_BYTES: 64 * 1024,
} as const;

export const WEB_API = {
  /** Maximum characters accepted by /api/v1/prompt/enhance */
  PROMPT_ENHANCE_MAX_CHARS: 20_000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 插件管理
// ═══════════════════════════════════════════════════════════════

export const PLUGINS = {
  /** 默认禁用的插件列表 */
  DEFAULT_DISABLED: ['bughunt', 'office', 'workflow'],
} as const;

// ═══════════════════════════════════════════════════════════════
// 截断限制
// ═══════════════════════════════════════════════════════════════

export const TRUNCATION = {
  /** 工具错误预览字符数 */
  TOOL_ERROR_PREVIEW: 500,
  /** 工具结果预览字符数 */
  TOOL_RESULT_PREVIEW: 500,
  /** 快照内容预览字符数 */
  SNAPSHOT_CONTENT: 300,
  /** CLI 请求预览字符数 */
  CLI_REQUEST_PREVIEW: 50,
  /** Shell stdout 最大字符数 */
  SHELL_STDOUT_MAX: 50_000,
  /** Shell stdout 最大行数 */
  SHELL_LINE_MAX: 2_000,
  /** Shell stderr 最大字符数 */
  SHELL_STDERR_MAX: 10_000,
  /** Python stderr 最大字符数 */
  PYTHON_STDERR_MAX: 2_000,
  /** Python 最大输出字符数 */
  PYTHON_MAX_OUTPUT: 5_000,
  /** Agent 报告给 Leader 的最大字符数 */
  AGENT_REPORT_TO_LEADER: 5_000,
  /** HTTP 头预览条数 */
  HTTP_HEADER_PREVIEW: 20,
  /** HTTP Set-Cookie 最大条数 */
  HTTP_SET_COOKIE_MAX: 20,
  /** WebFetch Markdown 最大字符数 */
  WEBFETCH_MARKDOWN_MAX: 100_000,
  /** CodeSearch 输出最大字符数 */
  CODESEARCH_OUTPUT_MAX: 30_000,
  /** CodeSearch 最大行数 */
  CODESEARCH_LINE_MAX: 1_500,
  /** 会话 artifact 最大字符数 */
  SESSION_ARTIFACT_MAX: 50_000,
  /** 文件附加最大字符数 */
  FILE_ATTACH_MAX: 100_000,
  /** 工作笔记摘要最大字符数 */
  WORK_NOTE_SUMMARY_MAX: 200,
  /** 工作笔记详情最大字符数 */
  WORK_NOTE_DETAILS_MAX: 2_000,
  /** 频道消息最大条数 */
  CHANNEL_MESSAGES_MAX: 500,
  /** 频道消息裁剪后保留条数 */
  CHANNEL_MESSAGES_KEEP_AFTER_TRIM: 400,
  /** 命令历史最大条数 */
  CMD_HISTORY_MAX: 1_000,
  /** 评估记录最大字符数 */
  MAX_RECORD_CHARS: 1_200,
  /** Orchestration 失败事件原因预览 */
  FAILURE_EVENT_REASON: 100,
  /** Orchestration transfer 反馈最大字符数 */
  TRANSFER_FEEDBACK_MAX: 300,
  /** 最大证据条目数 */
  MAX_EVIDENCE_ITEMS: 12,
  /** URL 最大长度 */
  MAX_URL_LENGTH: 2_000,
  /** HTTP 最大重定向次数 */
  MAX_REDIRECTS: 10,
  /** 收件箱内容预览字符数 */
  INBOX_PREVIEW: 80,
  /** 路线历史最大条数 */
  ROUTE_HISTORY_MAX: 25,
  /** 工具参数截断字符数 */
  TOOL_ARGS_PREVIEW: 500,
  /** 原因截断字符数 */
  REASON_PREVIEW: 48,
} as const;

// ═══════════════════════════════════════════════════════════════
// 超时
// ═══════════════════════════════════════════════════════════════

export const TIMEOUT = {
  /** DB busy 等待超时 (ms) */
  DB_BUSY_MS: 30_000,
  /** 清理注册表超时 (ms) */
  CLEANUP_REGISTRY_MS: 30_000,
  /** 优雅关闭超时 (ms) */
  GRACEFUL_SHUTDOWN_MS: 5_000,
  /** Hook 默认超时 (ms) */
  HOOK_DEFAULT_MS: 5_000,
  /** Hook 最大超时 (ms) */
  HOOK_TIMEOUT_MS: 30_000,
  /** 消息总线等待超时 (ms) */
  MESSAGE_BUS_WAIT_MS: 30_000,
  /** 权限同步轮询间隔 (ms) */
  PERMISSION_SYNC_POLL_MS: 1_000,
  /** 权限同步超时 (ms) */
  PERMISSION_SYNC_TIMEOUT_MS: 60_000,
  /** 心跳间隔 (ms) — LLM 流式进度心跳 */
  HEARTBEAT_INTERVAL_MS: 5_000,
  /** 浏览器页面跳转超时 (ms) */
  BROWSER_GOTO_MS: 30_000,
  /** 浏览器深度分析页面跳转超时 (ms) */
  BROWSER_DEEP_GOTO_MS: 60_000,
  /** 浏览器选择器等待超时 (ms) */
  BROWSER_SELECTOR_MS: 10_000,
  /** 浏览器网络空闲超时 (ms) */
  BROWSER_NETWORK_IDLE_MS: 15_000,
  /** 浏览器搜索网络空闲超时 (ms) */
  BROWSER_SEARCH_NETWORK_IDLE_MS: 30_000,
  /** 浏览器 get_text 默认最大字符数 */
  BROWSER_TEXT_MAX: 4_000,
  /** 浏览器 get_html 默认最大字符数 */
  BROWSER_HTML_MAX: 8_000,
  /** WebFetch LLM 超时 (ms) */
  WEBFETCH_LLM_TIMEOUT_MS: 60_000,
  /** 诊断节流间隔 (ms) */
  DIAGNOSTIC_THROTTLE_MS: 250,
  /** Transcript 刷盘间隔 (ms) */
  TRANSCRIPT_FLUSH_INTERVAL_MS: 2_000,
  /** Transcript 缓冲阈值 */
  TRANSCRIPT_BUFFER_THRESHOLD: 50,
  /** Ctrl 退出提示等待 (ms) */
  CTRL_EXIT_PROMPT_MS: 1_000,
  /** Worker 进程启动超时 (ms) */
  WORKER_SPAWN_MS: 30_000,
  /** Worker 进程心跳超时 (ms) — 超过此时间无心跳视为卡死。
   * 须 ≥ LLM 单次调用的最长静默窗口：request_timeout 全程（首 token 前）worker 除 30s
   * setInterval 外零 IPC，60s 阈值会把 LlmGuard 正在重试的活 worker 误判 heartbeat_timeout
   * 杀掉（"LLM 自愈噪声干扰 leader" 根因之一）。恢复 runner 设计值 90s（3× 心跳间隔），
   * 配合 BaseAgentRuntime 的 in-flight LLM 心跳，覆盖异步 SDK 的 TTFB 窗口。
   * 已退出/僵尸进程由 WorkerProcessRunner zombie 检测 + worker:exit 独立回收，不依赖此阈值。 */
  WORKER_HEARTBEAT_TIMEOUT_MS: 90_000,
  /** Worker 进程最大运行时长 (ms) — 与 AGENT.MAX_RUNTIME_MINUTES 对齐 */
  WORKER_MAX_RUNTIME_MS: 480 * 60 * 1000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 路径
// ═══════════════════════════════════════════════════════════════

export const PATHS = {
  /** 配置目录名 */
  CONFIG_DIR_NAME: '.lingxiao',
  /** 数据库文件名 */
  DB_NAME: 'data.db',
  /** 日志目录名 */
  LOG_DIR_NAME: 'logs',
  /** 技能目录名 */
  SKILLS_DIR_NAME: 'skills',
  /** 缓存目录名 */
  CACHE_DIR_NAME: 'cache',
} as const;

// ═══════════════════════════════════════════════════════════════
// 服务器
// ═══════════════════════════════════════════════════════════════

export const SERVER = {
  /** 默认绑定地址 — localhost only, 不暴露公网 */
  HOST: '127.0.0.1',
  /** 默认端口（仅在 random_port=false 时使用；默认随机端口避免冲突和扫描） */
  PORT: 8080,
} as const;

// ═══════════════════════════════════════════════════════════════
// 本地 LLM 网关
// ═══════════════════════════════════════════════════════════════

export const LLM_GATEWAY = {
  /**
   * 网关绑定地址 — 默认仅 loopback。网关的唯一防线是 sk- 秘钥鉴权（CORS 为 *），
   * 暴露到非 loopback 会带来凭据爆破面，默认不开放。
   */
  HOST: '127.0.0.1',
  /**
   * 固定大端口 — 网关在专用监听器上独立监听，地址不再随 Web 服务器漂移。
   * 62000 在本机 ephemeral 区间（32768–60999）之外，避免 OS 随机分配冲突；可经 llm_gateway.port 覆盖。
   */
  PORT: 62000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 消息总线
// ═══════════════════════════════════════════════════════════════

export const MESSAGE_BUS = {
  /** 消息队列警告阈值 */
  WARNING_THRESHOLD: 500,
  /** 消息队列危险阈值 */
  CRITICAL_THRESHOLD: 1_000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 终端会话
// ═══════════════════════════════════════════════════════════════

export const TERMINAL = {
  /** 后台会话最大数量 */
  MAX_SESSIONS: 10,
  /** 终端输出缓冲区最大字符数 */
  OUTPUT_BUFFER_MAX: 100_000,
  /** 孤儿会话检查间隔 (ms) */
  ORPHAN_CHECK_INTERVAL_MS: 30_000,
  /** 已完成会话保留时间 (ms) */
  COMPLETED_SESSION_TTL_MS: 300_000,
  /** SIGTERM -> SIGKILL 宽限时间 (ms) */
  KILL_GRACE_MS: 200,
  /** 前台超时自动转后台 */
  TIMEOUT_AUTO_BACKGROUND: true,
  /** PTY 默认列数 */
  DEFAULT_COLS: 80,
  /** PTY 默认行数 */
  DEFAULT_ROWS: 30,
  /** 输出截断字符数 */
  OUTPUT_TRUNCATE_CHARS: 50_000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 24×7 资源预算
// ═══════════════════════════════════════════════════════════════

export const RESOURCE_BUDGET = {
  /** 清理周期 (ms) */
  CLEANUP_INTERVAL_MS: 10 * 60 * 1000,
  /** DB 高写入量审计/日志表(agent_logs/token_usage/messages/llm_gateway_requests/execution_trace_events)保留窗口(小时),#2 */
  DB_PRUNE_MAX_AGE_HOURS: 72,
  /** session artifacts 最大磁盘 (MB) */
  SESSION_ARTIFACTS_MAX_MB: 500,
  /** agent logs 最大磁盘 (MB) */
  AGENT_LOGS_MAX_MB: 200,
  /** terminal transcripts 最大磁盘 (MB) */
  TERMINAL_TRANSCRIPTS_MAX_MB: 100,
  /** SQLite WAL checkpoint 触发阈值 (MB) */
  SQLITE_WAL_CHECKPOINT_MB: 50,
  /** scratchpad 最大磁盘 (MB) */
  SCRATCHPAD_MAX_MB: 50,
} as const;

// ═══════════════════════════════════════════════════════════════
// Worker 恢复策略
// ═══════════════════════════════════════════════════════════════

export const RECOVERY = {
  /** 瞬态故障最大重试次数 */
  TRANSIENT_MAX_RETRIES: 3,
  /** 内部可恢复故障最大重试次数 */
  INTERNAL_MAX_RETRIES: 2,
  /** 外部阻塞故障最大重试次数 */
  EXTERNAL_MAX_RETRIES: 0,
  /** 未知故障最大重试次数 */
  UNKNOWN_MAX_RETRIES: 1,
  /** 基础重试延迟 (ms) */
  RETRY_DELAY_MS: 1_000,
  /** 退避倍数 */
  BACKOFF_MULTIPLIER: 2,
  /** 最大重试延迟 (ms) */
  MAX_RETRY_DELAY_MS: 30_000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 黑板架构
// ═══════════════════════════════════════════════════════════════

export const BLACKBOARD = {
  /** 是否默认启用黑板架构 */
  ENABLED: true,
  /** 图节点上限 */
  MAX_GRAPH_NODES: 1000,
  /** 图边上限 */
  MAX_GRAPH_EDGES: 5000,
} as const;

// ═══════════════════════════════════════════════════════════════
// 统一 Token 预算
// ═══════════════════════════════════════════════════════════════

export const BUDGET = {
  /** 总 token 预算硬上限（system prompt + tools + soul + blackboard + messages） */
  MAX_CONTEXT_BUDGET: 100_000,
  /** 总 token 预算下限（防止小模型预算过低） */
  MIN_CONTEXT_BUDGET: 50_000,
  /** Soul.md 默认 token 预算 */
  SOUL_DEFAULT_BUDGET: 12_000,
  /** 黑板图快照默认 token 预算 */
  BLACKBOARD_DEFAULT_BUDGET: 5_000,
  /** 工具定义默认 token 预算 */
  TOOLS_DEFAULT_BUDGET: 8_000,
  /** 注入内容（skills/intuition/memory）默认 token 预算 */
  INJECTIONS_DEFAULT_BUDGET: 5_000,
} as const;
