# Agent 系统架构

> Leader-Worker 多 Agent 协作。细节以代码为准。

## 快速导航

- [返回根目录](../AGENTS.md)
- 工具面真源：`src/tools/AGENTS.md`
- 角色/白名单：`src/contracts/constants/rolePresets.ts`
- Leader 元工具：`src/contracts/constants/leaderToolDefinitions.ts`

## 核心架构

```
LeaderAgent (主进程)
    ↓ 任务分解 / create_task / dispatch_*
TaskBoard + Team / Solo workers
    ↓
Worker (独立进程 BaseAgentRuntime)
    ↓ attempt_completion / work notes
Leader 监督与整合
```

**要点**:
- Worker 进程隔离 + IPC
- 工具面：Registry + WORKER_TOOLS + ModeToolPolicy
- 死循环防护默认开启（ToolLoopDetector / ToolFailureLoopGuard）

## Leader

**主文件**: `src/agents/LeaderAgent.ts`  
**工具执行**: `src/agents/LeaderTools.ts` + `leader/tools/*`

**职责**: 任务分解、派发、监督、模式切换、蓝图、Canvas 闭环工具。

**工具面**:
- Direct：ToolRegistry 全量（再经 filterLeaderTools 按模式裁剪）
- Meta：`LEADER_META_TOOLS` + bughunt ledger（`scope: leader`）
- 蓝图：`define_project_blueprint` / `add_subsystem` / `update_subsystem` / `delete_subsystem`
- Canvas：`canvas_get_state` / `canvas_save_sourcemap` / `canvas_push_version`

## Worker

**入口**: `src/agents/WorkerProcessEntry.ts`  
**运行时**: `src/agents/BaseAgentRuntime.ts`

**工具面**: `WORKER_TOOLS` ∩ Registry ∩ mode/pruner。  
**收尾**: `attempt_completion` + 契约证明。

## 角色

预设与工具白名单：`PRESET_ROLE_PROFILES` / `WORKER_TOOLS`（contracts）。  
职责差异靠 system prompt + capability tier，不再按角色切工具表。

## 模式

`office` / `bughunt` / `workflow`：`src/contracts/modes.ts`，fail-closed。
