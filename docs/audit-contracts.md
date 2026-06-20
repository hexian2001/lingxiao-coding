# 凌霄剑域 · 架构契约文档

> 版本：1.0 | 基于全库审计 T-3~T-7 综合产出
>
> 本文档定义凌霄各层之间的接口契约、数据流契约和事件契约，作为开发者和贡献者的权威参考。

---

## 一、系统分层架构

```
┌──────────────────────────────────────────────────────┐
│                    用户入口层                          │
│  cli.ts (CLI) ── cli-tui.ts (TUI) ── cli-daemon.ts    │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                  Web 服务器层 (Fastify)                │
│  SseBridge · ConnectionManager · ServerAuth           │
│  AcpRoutes · FileSystemRoutes · GitIntegrationApi     │
│  TerminalRoutes · DaemonRoutes · SettingsRoutes       │
│  TempDownloadRoutes · ArtifactPreviewRoutes · ...     │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                  Agent 编排层                          │
│  LeaderAgent · LeaderTools · LeaderSupervisionCoord   │
│  BaseAgentRuntime · AgentPoolRuntime · FaultRecovery  │
│  WorkerProcessRunner · LlmGuard · ToolLoopDetector    │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                    核心引擎层                          │
│  EventEmitter · MessageBus · DatabaseManager          │
│  SessionManager · ScheduledTaskManager                │
│  ResourceBudgetService · Log · RuntimeGuards          │
│  UpdateChecker                                         │
└──────────────────────────────────────────────────────┘
```

### 层间依赖规则
- **上层可依赖下层，下层不可依赖上层**
- 同层模块间通过 EventEmitter / MessageBus 解耦
- 跨层通信只允许通过定义的接口契约（本文档）

---

## 二、核心引擎层契约

### 2.1 EventEmitter (`src/core/EventEmitter.ts`)

```typescript
// 事件发射器接口
class EventEmitter {
  subscribe<T>(event: string, handler: (data: T) => void): () => void;  // 返回 unsubscribe
  emit(event: string, data: unknown): void;
  once(event: string, handler: (data: unknown) => void): void;
  removeAllListeners(event?: string): void;
}
```

**契约规则：**
- `subscribe()` 返回的 unsubscribe 函数**必须**在组件/模块销毁时调用
- 事件名使用 `namespace:action` 格式（如 `session:created`、`task:updated`）
- maxListeners = 100，超出时打印警告但不阻止

### 2.2 MessageBus (`src/core/MessageBus.ts`)

```typescript
class MessageBus {
  register(handler: MessageHandler): string;        // 返回 handlerId
  unregister(handlerId: string): void;               // ⚠️ P1-1: 当前无调用方
  send(message: BusMessage): void;
  getQueueLength(): number;
}
```

**契约规则：**
- 消息按优先级排序：`critical > important > normal > low`
- `send()` 是同步入队，handler 异步执行
- BusMessage 格式：`{ id, type, payload, priority, sessionId?, timestamp }`

### 2.3 DatabaseManager (`src/core/Database.ts`)

```typescript
class DatabaseManager {
  getDb(): Database;                    // better-sqlite3 实例
  getPath(): string;
  ensureConnection(): void;             // 自动重连
  close(): void;
  pruneOldRecords(maxAgeHours: number): number;
  setSessionState(sessionId: string, key: string, value: unknown): void;
  getSessionState(sessionId: string, key: string): unknown;
}
```

**契约规则：**
- SQLite WAL 模式，单进程读写
- `setSessionState` value 支持 JSON 可序列化对象
- `pruneOldRecords` 不触碰 leader_conversation / agent_conversation 表

### 2.4 SessionManager (`src/runtime/SessionManagerRuntime.ts`)

```typescript
class SessionManager {
  createSession(options: SessionOptions): Session;
  getSession(sessionId: string): Session | undefined;
  getActiveSessionIds(): string[];
  destroySession(sessionId: string): void;
  destroy(): void;                      // 销毁所有 session
  setScheduledTaskManager(mgr: ScheduledTaskManager): void;
}
```

**契约规则：**
- 单进程内可有多个 session，但只有 active session 接收用户输入
- `destroy()` 必须按顺序释放：AgentPool → WorkerRunner → DB 连接
- 会话恢复时检查 schema version（⚠️ P1-6: 当前未实现）

### 2.5 ScheduledTaskManager (`src/core/ScheduledTaskManager.ts`)

```typescript
class ScheduledTaskManager {
  start(): void;                        // 30s 轮询
  stop(): void;
  createTask(params: ScheduledTaskCreateParams): ScheduledTaskCreateResult;
  updateTask(id: string, updates: Partial<ScheduledTaskRecord>): void;
  deleteTask(id: string): void;
  fireTaskManually(id: string): void;
}
```

**契约规则：**
- cron 表达式解析为下次执行时间，30s 检查一次到期
- 系统任务前缀：`[SYSTEM:patrol]`、`[SYSTEM:dead_end_check]`、`[SYSTEM:rebalance]`、`[SYSTEM:idle_scan]`
- `firingTasks` Set 防止同 taskId 并发触发

### 2.6 WorkerProcessRunner (`src/core/WorkerProcessRunner.ts`)

```typescript
class WorkerProcessRunner {
  spawn(options: WorkerSpawnOptions): string;   // 返回 workerId
  send(workerId: string, message: unknown): void;
  kill(workerId: string): void;
  destroy(): void;                              // SIGKILL 所有子进程
}
```

**契约规则：**
- Worker 是独立子进程，通过 IPC 通信
- `destroy()` 按顺序：SIGTERM → 等 5s → SIGKILL → 清理 IPC 队列 → removeAllListeners
- PidRegistry 持久化跟踪 PID，防止孤儿进程

---

## 三、Agent 编排层契约

### 3.1 LeaderAgent (`src/agents/LeaderAgent.ts`)

```typescript
class LeaderAgent {
  sessionId: string;
  emitter: EventEmitter;
  db: DatabaseManager;
  
  processUserInput(input: string): Promise<void>;
  dispatchTask(taskId: string, agentName: string): Promise<void>;
  markWaitingForUser(waiting: boolean): void;
  markPendingUserInput(question: string): void;
}
```

**契约规则：**
- Leader 是单例 per session，管理该 session 的全部 Agent 和任务
- 用户输入通过 `processUserInput` 进入，Leader 决策后拆分任务 DAG
- `markWaitingForUser(true)` 后 Leader 暂停处理，等待 `user:input_needed` 闭环

### 3.2 LeaderTools (`src/agents/LeaderTools.ts`)

```typescript
// 工具注册契约
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;              // JSON Schema 描述参数
  execute: (args: unknown, context: ToolContext) => Promise<ToolResult>;
}
```

**契约规则：**
- 80+ 内置工具，每个工具必须定义 JSON Schema 参数
- 工具执行返回 `ToolResult`：`{ success, data?, error? }`
- 工具执行超时由 `ToolContext.timeout` 控制（⚠️ P1-11: 当前无全局策略）

### 3.3 AgentPoolRuntime (`src/agents/AgentPoolRuntime.ts`)

```typescript
class AgentPoolRuntime {
  acquire(role: string): AgentWorker;
  release(worker: AgentWorker): void;
  destroy(): void;
  getActiveWorkers(): AgentWorker[];
}
```

**契约规则：**
- Agent Worker 是池化资源，用完归还
- 同角色可有多实例（fe-1, fe-2），由 write_scope 区分
- `destroy()` 释放所有 worker → WorkerProcessRunner.kill() → 清理池

### 3.4 FaultRecovery (`src/agents/pool/FaultRecovery.ts`)

```typescript
class FaultRecovery {
  handleCrash(workerId: string, error: Error): RecoveryDecision;
  // RecoveryDecision: { action: 'respawn' | 'abort', delay?, maxRetries? }
}
```

**契约规则：**
- 崩溃后默认 respawn，最多 3 次（⚠️ P1-8: 硬编码）
- LLM 超时/网络错误属于瞬时类，倾向 respawn
- 代码逻辑错误倾向 abort

---

## 四、Web 服务器层契约

### 4.1 SSE 事件契约

**事件名映射表（SseBridge → 前端 sseStore）：**

| 后端事件名 | 前端 SessionUpdateKind | 方向 |
|-----------|----------------------|------|
| `session:created` | SessionCreated | → 前端 |
| `session:runtime_state` | SessionRuntimeState | → 前端 |
| `task:created/updated/deleted` | TaskUpdate | → 前端 |
| `agent:heartbeat` | AgentHeartbeat | → 前端 |
| `agent:crashed` | AgentCrashed | → 前端 |
| `agent:error` | AgentError | → 前端 |
| `notification:new` | Notification | → 前端 |
| `leader:message_queued` | LeaderMessageQueued | → 前端 |
| `leader:message_dequeued` | LeaderMessageDequeued | → 前端 |
| `plan:submitted/updated/finalized` | PlanSubmitted/Updated/Finalized | → 前端 |
| `permission:request` | InterruptionRequest | → 前端 |
| `user:input_needed` | AskUserQuestion | → 前端 |
| `blackboard:delta` | BlackboardDelta | → 前端 |
| `team:message_sent/read` | TeamMessageSent/Read | → 前端 |
| `work_note:written` | WorkNoteWritten | → 前端 |
| `orchestration:*` | Orchestration* | → 前端 |
| `context:compressed/compacting` | ContextCompressed/Compacting | → 前端 |
| `terminal:output/state` | TerminalOutput/State | → 前端 |
| `leader:control_mode_changed` | ControlModeChanged | → 前端 |
| `eternal:goal_changed` | EternalGoalChanged | → 前端 |

**Notification 数据契约：**
```typescript
interface Notification {
  id: string;                    // 唯一 ID
  sessionId?: string;            // 目标 session
  type: string;                  // 'user_input_needed' | 'agent_warning' | 'update_available' | ...
  priority: 'critical' | 'important' | 'normal';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  duplicateCount?: number;
}
```

### 4.2 API 端点契约

**认证：** 所有 API 端点需要 `x-lingxiao-token` header 或 `?token=` query param（⚠️ P0-5/P1-12 除外）

| 方法 | 路径 | 认证 | 描述 |
|------|------|------|------|
| GET | `/api/sse` | ✓ | SSE 事件流 |
| GET | `/api/session/:id` | ✓ | 获取会话状态 |
| POST | `/api/session/:id/message` | ✓ | 发送用户消息 |
| POST | `/api/session/:id/interrupt` | ✓ | 中断当前操作 |
| GET | `/api/settings` | ✓ | 获取设置 |
| PUT | `/api/settings` | ✓ | 更新设置 |
| GET | `/api/fs/*` | ✓ | 文件系统读取 |
| POST | `/api/fs/*` | ✓ | 文件系统写入 |
| GET | `/api/git/*` | ✓ | Git 操作（⚠️ P0-5: 缺路径校验） |
| WS | `/api/terminal/:id` | ✓ | 交互式终端 |
| GET | `/api/stats` | ✓ | 统计数据 |
| GET | `/api/download/:token` | ✗ | 临时文件下载（⚠️ P1-12: 缺认证） |
| GET | `/api/artifact/*` | ✓ | 产物预览 |
| POST | `/api/workflow/*` | ✓ | 工作流操作 |

### 4.3 ConnectionManager 契约

```typescript
class ConnectionManager {
  addConnection(sessionId: string, res: ServerResponse): string;
  removeConnection(connId: string): void;
  broadcastToSession(sessionId: string, event: string, data: unknown): void;
  getSessionConnections(sessionId: string): number;
}
```

**契约规则：**
- MAX_TOTAL_CONNECTIONS = 100（背压防护）
- 连接关闭时必须 removeConnection，防止泄漏
- broadcastToSession 遍历连接列表，写入失败时自动移除

---

## 五、前端层契约

### 5.1 WebUI 状态管理（Zustand）

**Store 分层：**
```
sessionStore         — 会话列表、当前会话、会话状态
sseStore             — SSE 连接、事件分发、实时更新
agentStore           — Agent 列表、Agent 对话
taskStore            — 任务板、DAG
notificationStore    — 通知列表
```

**SSE 事件消费契约：**
- 所有 SSE 事件通过 `handleSessionUpdate()` 统一分发
- 每种 SessionUpdateKind 对应一个 case 分支
- 状态更新使用不可变模式：`setState((s) => ({ ...s, field: newValue }))`

### 5.2 TUI 事件桥接

```typescript
// useTuiEventBridge.ts 契约
emitter.subscribe('event:name', scoped('event:name', (event) => {
  // scoped 确保事件只处理当前 session
  // 返回 unsubscribe 函数
}));
```

**契约规则：**
- 所有 subscribe 返回的 unsubscribe 必须在 useEffect cleanup 中调用
- 当前 77 个订阅全部配对清理（T-6 验证通过）
- 通知列表上限 500 条（FIFO 封顶）

---

## 六、CLI 入口层契约

### 6.1 命令注册

```
lingxiao                    — 启动交互模式（TUI 或 WebUI）
lingxiao upgrade            — 检查并升级
lingxiao upgrade --check    — 只检查不升级
lingxiao --version          — 显示版本
lingxiao --help             — 显示帮助
```

### 6.2 配置文件契约

**路径：** `~/.lingxiao/config.json`

**Schema：**
```json
{
  "version": 1,
  "uiLanguage": "zh-CN | en",
  "defaultMode": "tui | web",
  "providers": {
    "openai": { "apiKey": "...", "baseUrl": "...", "model": "..." }
  },
  "permissions": { "mode": "strict | dev | networked | yolo" }
}
```

**契约规则：**
- `loadSettings()` 失败时应回退默认配置（⚠️ P0-9: 当前直接抛异常）
- `saveSettings()` 原子写入（临时文件 → rename）
- 配置变更通过 `startSettingsWatcher()` 文件监听热加载

### 6.3 升级流程契约

```
1. fetchLatestRelease()  → GitHub API /releases/latest
2. compareVersions()     → semver 比较
3. detectInstallType()   → portable | npm | source
4. 升级路径:
   - portable: downloadAndExtract → refreshSymlink
   - source:   git fetch → git checkout tag → npm install → npm run build → npm link
   - npm:      提示手动 npm update -g
```

**契约规则：**
- 升级前自动备份旧版本到 `.bak` 目录
- 升级中断后可通过 `.bak` 恢复（⚠️ P0-10: 恢复逻辑不完整）
- `UpdateChecker` 启动后 10s 异步检查，每 24h 定期检查

---

## 七、进程生命周期契约

### 启动顺序
```
1. installProcessRuntimeGuards()     — 注册 uncaughtException / SIGINT/SIGTERM handler
2. loadSettings()                    — 加载配置
3. DatabaseManager                   — 打开 SQLite
4. createEventEmitter() / createMessageBus()
5. SessionManager                    — 初始化会话管理
6. createServerWithDeps()            — Fastify 服务器
   6.1 ServerAuth / ConnectionManager / SseBridge
   6.2 ScheduledTaskManager.start()
   6.3 ResourceBudgetService.start()
   6.4 UpdateChecker.start()
   6.5 register*Routes() × 22
7. 启动 TUI 或 WebUI
```

### 关闭顺序（registerCleanup 优先级，数字越大越先执行）
```
priority 10: db.close()                    — 最后关闭数据库
priority 9.5: killOrphanWorkers            — 回收孤儿进程
priority 9.4: sessionManager.destroy()      — 销毁所有 session
priority 9:   scheduledTaskManager.stop()   — 停止调度
priority 8:   resourceBudget.stop()         — 停止清理
priority 8:   updateChecker.stop()          — 停止检查
priority 8:   sseBridge.stop()              — 关闭 SSE
```
