# 凌霄剑域 · 稳定性审计报告

> 审计时间：2025-01 | 审计范围：全代码库 5 层 | 审计方法：5 Agent 并行深度审计 + 交叉验证
>
> 问题分级：**P0** = 必须修复（生产环境会触发）| **P1** = 应当修复（影响稳定性/安全性）| **P2** = 建议修复（可维护性/技术债）

---

## 一、P0 问题汇总（10 个 — 必须修复）

### P0-1: ScheduledTaskManager pollTimer 缺少 unref()
- **层级**: 核心引擎
- **文件**: `src/core/ScheduledTaskManager.ts:230`
- **现象**: `setInterval` 创建的 pollTimer 未调用 `.unref()`，导致进程无法正常退出
- **影响**: 优雅关闭时 pollTimer 阻止 Node.js 事件循环退出，进程 hang 住
- **修复**: `this.pollTimer.unref()` 或在 stop() 中确保 clearInterval
- **交叉验证**: T-3/T-5 均确认 SseBridge heartbeatInterval 有同类问题

### P0-2: 31+ 处 `catch { /* ignore */ }` 吞掉异常
- **层级**: 核心引擎
- **文件**: `src/core/` 全局（31+ 处）
- **现象**: 大量 catch 块静默吞掉异常，无日志、无错误传播
- **影响**: 关键错误（DB 连接失败、文件写入失败）被隐藏，排查困难
- **修复**: 至少添加 `coreLogger.debug()` 日志；业务路径异常应向上传播

### P0-3: LeaderAgent.ts 巨型文件（3500+ 行）
- **层级**: Agent 系统
- **文件**: `src/agents/LeaderAgent.ts:294-3600`
- **现象**: 单文件 3500+ 行，包含 LLM 调用、工具执行、状态管理、会话恢复等全部逻辑
- **影响**: 修改风险极高，难以测试，维护成本失控
- **修复**: 拆分为 LeaderDecisionEngine、LeaderToolExecutor、LeaderStateManager 等独立模块

### P0-4: 46 处 tolerate/ignore catch 模式
- **层级**: Agent 系统
- **文件**: `src/agents/` 全局（46 处 across 115 files）
- **现象**: Agent 系统中大量 catch 容忍错误，无日志记录
- **影响**: Agent 崩溃原因不可追溯，工具执行失败静默丢弃
- **修复**: 审查 46 处 catch，业务路径添加日志或错误传播

### P0-5: GitIntegrationApi 路径遍历漏洞
- **层级**: Web 服务器
- **文件**: `src/web-server/GitIntegrationApi.ts:29-31`
- **现象**: `resolveReadWorkspace` / `resolveWriteWorkspace` 无路径遍历校验
- **影响**: 攻击者可通过 `../../` 读取/写入任意文件
- **修复**: 增加 `isPathInside()` 校验，确保路径在 workspace 内
- **交叉验证**: T-5 确认 FileSystemRoutes 有校验但 GitIntegrationApi 缺失

### P0-6: server.ts 注入 window.__LINGXIAO_TOKEN__ 造成 XSS
- **层级**: Web 服务器
- **文件**: `src/server.ts:326-337`
- **现象**: onSend hook 将 server token 注入 HTML 为 `window.__LINGXIAO_TOKEN__`
- **影响**: 与前端 McpAppRenderer `postMessage targetOrigin='*'` 形成 XSS 攻击链
- **修复**: 改用 HttpOnly cookie 传递 token，移除 window 全局变量注入
- **交叉验证**: T-5/T-6 联合确认攻击链

### P0-7: sseStore.ts 巨型文件（1400+ 行）
- **层级**: 前端
- **文件**: `web/src/stores/sseStore.ts`
- **现象**: 单文件 1400+ 行，包含 SSE 连接管理、事件分发、状态更新全部逻辑
- **影响**: 状态管理复杂度过高，SSE 事件处理逻辑难以维护
- **修复**: 按 SessionUpdateKind 拆分为独立 handler 模块

### P0-8: LingXiaoTUI.tsx 巨型文件（2800+ 行）
- **层级**: 前端
- **文件**: `src/tui/LingXiaoTUI.tsx`
- **现象**: 单组件 2800+ 行，40+ useState，包含 TUI 全部交互逻辑
- **影响**: 任何修改都有回归风险，re-render 性能差
- **修复**: 按功能域拆分为独立组件（ChatPanel、TaskBoard、AgentPanel 等）

### P0-9: 配置文件损坏无恢复机制
- **层级**: CLI/工程化
- **文件**: `src/config.ts:1307-1347`
- **现象**: `loadSettings()` 读取 JSON 失败时直接抛异常，无降级/备份恢复
- **影响**: 配置文件损坏导致凌霄完全无法启动
- **修复**: 读取失败时回退到默认配置 + 备份损坏文件 + 提示用户

### P0-10: 升级中断无回滚保障
- **层级**: CLI/工程化
- **文件**: `src/cli_upgrade.ts:200-272`
- **现象**: 下载解压过程中断（网络/手动）后，安装目录处于不一致状态
- **影响**: 用户需要手动恢复安装，严重时需要重装
- **修复**: 原子替换（下载到临时目录 → 验证完整性 → 原子 rename）；备份已存在但恢复逻辑不完整

---

## 二、P1 问题汇总（28 个 — 应当修复）

### 核心引擎层（6 个）

| # | 问题 | 文件:行号 | 修复建议 |
|---|------|-----------|----------|
| P1-1 | MessageBus.unregister() 全局 0 调用方，内存泄漏风险 | `src/core/MessageBus.ts:285-290` | 在 SessionManager.destroy() 中调用 unregister |
| P1-2 | Log FileSink 同步写入阻塞事件循环 | `src/core/Log.ts:59-91` | 改为异步写入或使用 write stream |
| P1-3 | Database ensureConnection 自动重连无退避策略 | `src/core/Database.ts:864-877` | 添加指数退避 + 最大重试次数 |
| P1-4 | ResourceBudgetService 清理循环无并发控制 | `src/core/ResourceBudgetService.ts:105-143` | 添加 isRunning 标志防止重入 |
| P1-5 | WorkerProcessRunner destroy 超时不可配置 | `src/core/WorkerProcessRunner.ts:903-943` | 超时参数化 + 配置化 |
| P1-6 | SessionManager 会话恢复无版本兼容检查 | `src/runtime/SessionManagerRuntime.ts:274-310` | 添加 schema version 检查 |

### Agent 系统层（5 个）

| # | 问题 | 文件:行号 | 修复建议 |
|---|------|-----------|----------|
| P1-7 | LeaderProgressInvariant watchdogTimer 缺少 unref() | `src/agents/LeaderAgent.ts` | 添加 `.unref()` |
| P1-8 | FaultRecovery respawn 限制硬编码 | `src/agents/pool/FaultRecovery.ts:109-400` | 参数配置化 |
| P1-9 | ToolLoopDetector 无跨 session 隔离 | `src/agents/runtime/ToolLoopDetector.ts:1-111` | 按 session 隔离检测状态 |
| P1-10 | LlmGuard 规则不可配置 | `src/agents/LlmGuard.ts:1-700` | 规则外部化（配置文件/插件） |
| P1-11 | Agent 工具执行超时无全局策略 | `src/agents/` 全局 | 统一超时中间件 |

### Web 服务器层（5 个）

| # | 问题 | 文件:行号 | 修复建议 |
|---|------|-----------|----------|
| P1-12 | TempDownloadRoutes 无 requireServerToken 认证 | `src/web-server/TempDownloadRoutes.ts:4-13` | 添加认证层 |
| P1-13 | SseBridge heartbeatInterval 缺少 unref() | `src/web-server/SseBridge.ts` | 添加 `.unref()` |
| P1-14 | GitIntegrationApi/BrowserRoutes URL 参数无内网过滤 | `src/web-server/GitIntegrationApi.ts` | SSRF 防护：过滤 127.0.0.1/10.*/172.16-31.*/192.168.* |
| P1-15 | 认证逻辑分散，未统一为 Fastify preHandler | `src/server.ts:276` | 迁移为中间件模式 |
| P1-16 | DaemonRoutes proxyToDaemon fetch 无超时 | `src/web-server/DaemonRoutes.ts:172-190` | 添加 AbortSignal.timeout |

### 前端层（5 个）

| # | 问题 | 文件:行号 | 修复建议 |
|---|------|-----------|----------|
| P1-17 | SSE 重连竞态：重连中收到旧连接事件 | `web/src/api/AcpClient.ts:64-74` | 添加 connectionId 标记，丢弃旧连接事件 |
| P1-18 | streamingTimer 清理不完整 | `web/src/stores/sseStore.ts` | 确保 clearInterval 在所有分支执行 |
| P1-19 | McpAppRenderer postMessage targetOrigin='*' | `web/src/components/chat/McpAppRenderer.tsx:114` | 限制为 origin |
| P1-20 | i18n 翻译键不完整 | `web/src/` + `src/tui/` | 审计并补全缺失翻译 |
| P1-21 | useTuiEventBridge 依赖数组过长 | `src/tui/runtime/useTuiEventBridge.ts:369` | 拆分为多个独立 useEffect |

### CLI/工程化层（7 个）

| # | 问题 | 文件:行号 | 修复建议 |
|---|------|-----------|----------|
| P1-22 | fetchLatestRelease 依赖外部 curl | `src/cli_upgrade.ts:72-93` | 改用 native fetch |
| P1-23 | refreshSymlink 硬编码 /usr/local/bin | `src/cli_upgrade.ts:278-287` | 使用 process.env.PATH 动态解析 |
| P1-24 | 配置文件无 schema version 迁移 | `src/config.ts:1307-1347` | 添加 version 字段 + 迁移函数 |
| P1-25 | 构建脚本依赖网络（postinstall 下载模型） | `scripts/postinstall.mjs` | 网络不可用时降级跳过 |
| P1-26 | package.json 无 lockfile 策略说明 | `package.json` | 添加 npmrc engines-strict |
| P1-27 | tsconfig strict 模式未全量开启 | `tsconfig.cli.json` | 启用 strictNullChecks + noUncheckedIndexedAccess |
| P1-28 | .gitignore 未排除 .lingxiao/sessions/ 临时文件 | `.gitignore` | 添加 `.lingxiao/sessions/*/scratchpad/` |

---

## 三、P2 问题汇总（32 个 — 建议修复）

### 核心引擎层（8 个）
- EventEmitter maxListeners 固定 100，不可配置
- MessageBus 优先级队列无公平性保证
- Log 轮转策略简单（按大小），无时间维度
- Database WAL checkpoint 时机不可配置
- ScheduledTaskManager cron 解析无错误提示
- WorkerProcessRunner 子进程 stderr 未结构化
- ResourceBudgetService 清理日志不详细
- RuntimeGuards uncaughtException 无错误分类

### Agent 系统层（6 个）
- LeaderTools 工具注册无 schema 验证
- BaseAgentRuntime 状态转换无状态机校验
- AgentPoolRuntime 池大小无动态调整
- LlmGuard 日志无采样限流
- LeaderSupervisionCoordinator 轮询间隔固定
- ReasoningLoopDriver 过于简单（60 行）

### Web 服务器层（4 个）
- 错误响应格式不统一（部分用 reply.code().send()，部分用 throw）
- CORS 配置 origin:false 但未提供白名单机制
- 速率限制 200req/min/IP 不可配置
- ConnectionManager 连接清理依赖 GC

### 前端层（6 个）
- sessionStore reactive prune subscribe 复杂度高
- sseStore handleSessionUpdate 分拆为 Part1/2/3/4 但仍在单文件
- LingXiaoTUI batch ref sync 逻辑复杂
- useTuiEventBridge 77 个 unsubscribe 配对但无自动化检查
- WebUI 组件无 React.memo 优化
- TUI 无虚拟列表（大量消息时性能差）

### CLI/工程化层（8 个）
- cli.ts 命令注册混在一个文件
- version.ts 读取 package.json 无缓存
- bump-version.mjs 无 dry-run 模式
- build.mjs 错误提示不友好
- run-tests.mjs 只支持简单运行
- package.json 依赖无 peerDependencies 声明
- 缺少 CONTRIBUTING.md
- 缺少 CHANGELOG.md

---

## 四、跨层交叉问题

### 1. unref() 遗漏（跨 3 层）
- `ScheduledTaskManager.pollTimer` (core)
- `SseBridge.heartbeatInterval` (web-server)
- `LeaderProgressInvariant.watchdogTimer` (agents)
- **统一修复**: 排查所有 setInterval/setTimeout，长生命周期的必须 unref()

### 2. 异常吞没（跨 2 层）
- core 层 31+ 处 `catch { /* ignore */ }`
- agents 层 46 处 tolerate/ignore catch
- **统一修复**: 建立异常处理规范：至少 debug 日志，业务路径必须传播

### 3. 巨型文件（跨 3 层）
- `LeaderAgent.ts` 3500+ 行 (agents)
- `LingXiaoTUI.tsx` 2800+ 行 (tui)
- `sseStore.ts` 1400+ 行 (web)
- `cli.ts` 1700+ 行 (cli)
- `config.ts` 1633 行 (cli)
- **统一修复**: 制定文件行数上限规范（建议 800 行），分批重构

### 4. 安全攻击链（跨 2 层）
- 后端 `window.__LINGXIAO_TOKEN__` 注入 (web-server) + 前端 `postMessage targetOrigin='*'` (frontend)
- **统一修复**: P0-6 + P1-19 联合修复

---

## 五、修复优先级建议

### 第一批（立即修复 — P0 安全 + 稳定性）
1. P0-5: GitIntegrationApi 路径遍历
2. P0-6: window.__LINGXIAO_TOKEN__ XSS
3. P0-1: pollTimer unref()
4. P0-9: 配置文件损坏恢复
5. P0-10: 升级中断回滚

### 第二批（近期修复 — P0 可维护性 + P1 稳定性）
6. P0-2/P0-4: 异常吞没统一治理
7. P1-1: MessageBus.unregister 泄漏
8. P1-12: TempDownloadRoutes 认证
9. P1-13: heartbeatInterval unref()
10. P1-7: watchdogTimer unref()

### 第三批（中期重构 — P0 巨型文件）
11. P0-3: LeaderAgent.ts 拆分
12. P0-7: sseStore.ts 拆分
13. P0-8: LingXiaoTUI.tsx 拆分

### 第四批（持续改进 — P1/P2）
14. P1 剩余项 + P2 按模块逐步修复
