# Agent 系统架构

> 凌霄的 Agent 系统基于 Leader-Worker 架构，支持多智能体协作

## 快速导航

- [返回根目录](../AGENTS.md)
- [Leader Agent](#leader-agent)
- [Worker Agent](#worker-agent)
- [角色系统](#角色系统)
- [Agent 通信](#agent-通信)

## 核心架构

### Leader-Worker 模式

```
LeaderAgent (主进程)
    ↓ 任务分解
TaskBoard (任务队列)
    ↓ 派发任务
WorkerAgent (独立子进程)
    ↓ 执行完成
LeaderAgent (监督 + 整合)
```

**关键特性**:
- **进程隔离**: 每个 Worker 独立 OS 进程
- **IPC 通信**: 结构化的进程间消息传递
- **心跳监控**: 30s 超时检测，自动清理僵尸进程
- **任务持久化**: TaskBoard 完整记录状态转换

## Leader Agent

**文件**: `src/agents/LeaderAgent.ts`

**职责**:
1. **任务分解**: 将用户输入分解为可执行任务
2. **任务路由**: 决定自己处理 or 派发 Worker
3. **Worker 监督**: 监控 Worker 执行状态
4. **结果整合**: 汇总 Worker 结果返回用户

**核心方法**:
- `leaderThinkAndAct()`: 主循环，处理用户输入
- `dispatchAgent()`: 派发任务给 Worker
- `superviseWorker()`: 监督 Worker 执行

**工具集**:
- 所有 23 个工具（完整权限）
- 特殊工具: `dispatch_agent`, `check_agent_progress`

## Worker Agent

**文件**: `src/agents/WorkerProcessEntry.ts` (入口) + `src/agents/BaseAgentRuntime.ts` (基类)

**职责**:
1. **任务执行**: 在独立进程中执行分配的任务
2. **工具调用**: 使用受限的工具集
3. **进度报告**: 通过 IPC 向 Leader 报告进度
4. **结果返回**: 完成后返回结构化结果

**生命周期**:
```
spawn → initialize → execute → report → terminate
```

**隔离机制**:
- **进程隔离**: 独立 OS 进程，崩溃不影响 Leader
- **上下文隔离**: 每个 Worker 独立上下文
- **工具隔离**: 受限的工具集（根据角色）

## 角色系统

**文件**: `src/agents/roles/*.ts`

### 内置角色

| 角色 | 用途 | 工具集 | 文件 |
|------|------|--------|------|
| `backend` | 后端开发 | 文件操作 + Shell | `backend.ts` |
| `frontend` | 前端开发 | 文件操作 + UI | `frontend.ts` |
| `fullstack` | 全栈开发 | 完整工具集 | `fullstack.ts` |
| `qa` | 测试 | 文件读取 + Shell | `qa.ts` |
| `researcher` | 研究 | 搜索 + 网络 | `researcher.ts` |

### 角色定义结构

```typescript
export interface AgentRole {
  name: string;              // 角色名称
  displayName: string;       // 显示名称
  systemPrompt: string;      // 系统提示词
  tools: string[];           // 工具列表
  skillNames?: string[];     // Skills 列表
  model?: string;            // 指定模型
  capabilities?: {           // 能力限制
    canWrite: boolean;
    canExecute: boolean;
    canNetwork: boolean;
  };
}
```

### 创建新角色

1. 在 `src/agents/roles/` 创建 `{role}.ts`
2. 定义 `AgentRole` 对象
3. 在 `src/agents/RoleRegistry.ts` 注册
4. 添加系统提示词到 `src/agents/prompts/{role}_system.ts`

**示例**: 创建 `reviewer` 角色

```typescript
// src/agents/roles/reviewer.ts
export const reviewerRole: AgentRole = {
  name: 'reviewer',
  displayName: 'Code Reviewer',
  systemPrompt: '你是代码审查专家...',
  tools: ['FileRead', 'CodeSearch', 'Grep'],
  capabilities: {
    canWrite: false,    // 只读
    canExecute: false,
    canNetwork: false
  }
};
```

## Agent 通信

### IPC 消息类型

**Worker → Leader**:
- `worker:progress`: 进度更新
- `worker:complete`: 任务完成
- `worker:failed`: 任务失败
- `worker:heartbeat`: 心跳信号

**Leader → Worker**:
- `user_intervention`: 用户追问
- `task_update`: 任务更新
- `terminate`: 终止信号

### MessageBus

**文件**: `src/core/MessageBus.ts`

**用途**: Agent 间异步消息传递

```typescript
// 发送消息
bus.send('leader', 'worker-1', 'user_intervention', '请继续');

// 接收消息
bus.subscribe('worker-1', (from, type, payload) => {
  console.log(`收到来自 ${from} 的 ${type} 消息`);
});
```

## Agent Pool

**文件**: `src/agents/AgentPoolRuntime.ts`

**职责**:
1. **Worker 生命周期管理**: spawn/monitor/cleanup
2. **资源管理**: 限制并发 Worker 数量
3. **故障恢复**: 自动重启失败的 Worker
4. **状态追踪**: 记录所有 Worker 状态

**关键方法**:
- `spawnAgent()`: 创建新 Worker
- `respawnAgent()`: 重启 Worker（保留历史）
- `killAgent()`: 终止 Worker
- `getAgentStatus()`: 查询 Worker 状态

## 上下文管理

**文件**: `src/core/ContextManager.ts`

### 3层压缩架构

**L1 - 近端截断** (Context Manager):
- 保留最近 15 条消息
- 压缩中间消息（工具结果截断到 200 字符）

**L2 - 摘要压缩** (Leader):
- 当 token 超过阈值时触发
- 调用 LLM 生成对话摘要
- 替换旧消息为摘要

**L3 - 归档** (Database):
- 完整对话历史持久化到 SQLite
- 支持按需恢复（respawn 时加载）

### Token 追踪

**文件**: `src/agents/BaseAgentRuntime.ts` (TokenTracker)

```typescript
tracker.addUsage('leader', {
  prompt: 1000,
  completion: 500,
  total: 1500,
  cache_read: 200,
  cache_creation: 100
}, 'gpt-4');
```

## 权限与安全

### 权限系统

**文件**: `src/core/PermissionSystem.ts`

**三档策略**:
- `deny`: 直接拒绝（危险命令）
- `ask`: 请求用户确认（文件修改）
- `allow`: 自动通过（文件读取）

**配置**: `~/.lingxiao/settings.json`

```json
{
  "permissions": {
    "mode": "ask",
    "rules": {
      "structured_patch": "ask",
      "shell": "ask",
      "file_read": "allow"
    }
  }
}
```

### 沙箱隔离

**文件**: `src/tools/implementations/ExecutionSandbox.ts`

**两种后端**:
- `app-guard`: 轻量级，基于权限检查（默认）
- `bubblewrap`: 重量级，Linux namespace 隔离

**隔离范围**:
- 文件系统：限制访问 workspace 外路径
- 网络：可选禁用网络访问
- 进程：限制子进程创建

## 监控与调试

### Agent 日志

**文件**: `src/core/Database.ts` (agent_logs 表)

**记录内容**:
- Agent 事件（spawned/started/completed/failed）
- 工具调用（tool_call/tool_result）
- LLM 交互（text/thinking/retry）

**查询**: Web UI → Logs 页面

### 性能追踪

**文件**: `src/core/Database.ts` (agent_states 表)

**追踪指标**:
- 迭代次数
- 工具调用次数
- Token 使用量
- 执行时长

**查询**: Web UI → Stats 页面

## 故障恢复

### 自动重启

**触发条件**:
- Worker 进程崩溃
- 心跳超时（30s）
- LLM 连续失败（3次）

**恢复策略**:
1. 保存当前状态到 recovery records
2. 终止旧进程
3. 创建新进程，恢复状态
4. 继续执行任务

**文件**: `src/core/RecoveryRecords.ts`

### 故障分类

**文件**: `src/core/AutonomousFaultPolicy.ts`

**分类**:
- `transient`: 临时故障，可重试（网络超时）
- `persistent`: 持久故障，需人工介入（权限错误）
- `fatal`: 致命故障，立即终止（进程崩溃）

## 最佳实践

### 创建新 Agent 角色

1. **明确职责**: 角色应该有清晰的单一职责
2. **最小权限**: 只给必需的工具
3. **清晰提示词**: systemPrompt 应该简洁明确
4. **测试隔离**: 在独立环境测试新角色

### 调试 Agent 问题

1. **查看日志**: Web UI → Logs 页面
2. **检查状态**: Web UI → Traces 页面
3. **查看对话**: Web UI → Chat 页面（展开 Agent 消息）
4. **检查权限**: 确认工具权限配置正确

### 性能优化

1. **控制上下文**: 避免过长的对话历史
2. **限制工具集**: 只加载必需的工具
3. **使用 Skills**: 复用知识，减少重复提示
4. **监控 Token**: 及时触发压缩

## 相关文档

- [工具系统](../tools/AGENTS.md) — 23个工具的使用指南
- [开发约定](../../CONVENTIONS.md) — 编码规范和架构约定
- [返回根目录](../../AGENTS.md) — 项目概览
