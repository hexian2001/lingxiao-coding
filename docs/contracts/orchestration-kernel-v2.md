# Orchestration Kernel v2 — DAG Roadmap

> 目标：用**代码驱动的 SessionRun 状态机**替代「prompt 分层 + 影子 waitingForUser + 多套状态方言」联邦。  
> 原则：相位只由代码转；LLM 只在 `thinking` 填 DecisionEnvelope；Team 是 Run 配置不是平行宇宙。

**状态**：Phase 0–1 实现中（见 `src/core/SessionRunController.ts`）  
**分支建议**：`v1.13.1` 上持续提交，稳定后可开 `orch/session-run-v2`

---

## 0. 问题诊断（固化）

| 症状 | 根因 |
|------|------|
| Solo 有 ready 任务却“空闲” | manual 不 force dispatch；`waitingForUser` 与 idle 语义混淆 |
| Team 卡在建团/派发 | roster 双写（definition vs registry）；`team` mode 与 `teamEnabled` 脱节 |
| 完成后再来一轮“莫名评价” | OrchestrationRuntime 对 bare complete 自动挂 evaluator |
| UI/日志对不上 | Task 10 态 / core 3 态 / display 6 态 / normalize 再投影 |
| S1/S2/S3 不听话 | **仅 prompt**，无代码 gate |

Task/Agent **内核 FSM 是干净的**（3+3 态）。不流畅的是外层 **Run 相位** 缺失。

---

## 1. 目标架构

```
User/TUI/Web ──► SessionRunController (phase 唯一权威)
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    TaskBoard     AgentPool    TeamContext
    (3-state)     (3-state)    (atomic roster)
         │            │            │
         └────────────┴────────────┘
                      │
              OrchestratorPolicy (纯函数)
              signals → next phase / actions
                      │
              LLM only when phase=thinking
              → DecisionEnvelope { tier, tasks, dispatches, ask_user }
```

### 1.1 SessionRunPhase

| Phase | 含义 |
|-------|------|
| `idle` | 无开放工作、不在等用户、无 running agent |
| `thinking` | Leader 正在 LLM 决策 |
| `waiting_user` | 显式用户门 **或** Leader 有意 defer ready 任务 |
| `waiting_workers` | 存在 running agent |
| `dispatching` | 正在 assign/spawn（过渡相） |
| `recovering` | fault recovery 预算内 |
| `eternal_patrol` | eternal 空闲巡逻 |

### 1.2 DecisionEnvelope（Phase 4）

```ts
type DecisionEnvelope = {
  tier: 'S1' | 'S2' | 'S3';
  rationale: string;
  create_tasks?: TaskSpec[];
  dispatch?: DispatchSpec[];
  ask_user?: string;
  finish?: boolean;
};
```

- S1：代码禁止 team_manage / 多 dispatch  
- S2：最多 1 ephemeral worker  
- S3：team roster 必须 ready  

---

## 2. PR / 工作 DAG（拓扑序）

```
                    ┌──────────────────┐
                    │  PR-A  Roadmap   │  (本文档)
                    │  + 类型/投影骨架  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼                             ▼
     ┌────────────────┐            ┌─────────────────┐
     │ PR-B Phase0    │            │ PR-C 可观测性    │
     │ derivePhase    │            │ 诊断/SSE/TUI     │
     │ + 单测         │            │ session:run_*    │
     └───────┬────────┘            └────────┬────────┘
             │                              │
             └──────────────┬───────────────┘
                            ▼
                 ┌────────────────────┐
                 │ PR-D Phase1        │
                 │ 收编 waitingForUser│
                 │ 禁 silent idle     │
                 └─────────┬──────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼                             ▼
   ┌─────────────────┐          ┌──────────────────┐
   │ PR-E Team roster│          │ PR-F 状态方言     │
   │ 原子单写路径    │          │ 收缩对外 TaskStatus│
   └────────┬────────┘          └────────┬─────────┘
            │                            │
            └──────────────┬─────────────┘
                           ▼
                 ┌────────────────────┐
                 │ PR-G DecisionEnv   │
                 │ S 档硬 gate        │
                 │ evaluator 策略     │
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │ PR-H 清理          │
                 │ 删影子字段/死路径  │
                 └────────────────────┘
```

### 节点明细

| ID | 名称 | 交付物 | 依赖 | 验收 |
|----|------|--------|------|------|
| **A** | Roadmap + skeleton | 本文档；`SessionRunPhase` 类型；`SessionRunController`；单测 | — | 类型可 import；derive 单测绿 |
| **B** | Phase0 投影 | Leader 关键点 `projectSessionRun()`；DB 持久化 phase | A | 日志/状态键能读到 phase |
| **C** | 可观测 | RuntimeDiagnostics + `session:run_phase_changed` SSE | A,B | 前端/诊断 payload 含 sessionRun |
| **D** | Phase1 收编 | 所有 `waitingForUser=` 走 controller；manual ready 不得标 idle | B,C | ready>0 时 phase≠idle；有 deferred 原因 |
| **E** | Team 单 roster | create 原子写 definition+registry；dispatch assertTeamReady | D | team 半同步用例失败→通过 |
| **F** | 状态方言 | API 只暴露 core+exitReason+displayState | D | 无消费者依赖 10 值 status |
| **G** | DecisionEnvelope | meta tool + S 档 tool 面裁剪；Solo 默认不自动 evaluator | E,F | S1 调 team 硬失败；S2 无自动评价噪声 |
| **H** | 清理 | 移除影子 latch 重复逻辑；文档对齐 | G | LeaderAgent 行数下降；invariants 全绿 |

**并行许可**：A→B∥C→D→E∥F→G→H  

---

## 3. 成功标准（产品）

1. Solo S2：1 task → 1 worker → complete → 总结，**无 silent idle ≥ 1 poll**  
2. Team S3：建团 3 人 → 3 并行 → 全 terminal → 一次收束  
3. 任意时刻可回答：phase / ready / running / teamReady  
4. generation 双 complete 幂等；late complete 丢弃  
5. S1 调 team 工具 → 硬失败  

---

## 4. 非目标

- 不把 TaskBoard 内核从 3 态扩成更多  
- 不默认 auto-dispatch 全部 ready（用显式 thinking 决策回合）  
- 不把 workflow 插件当成 team 的替代  
- 不一次重写整个 LeaderAgent  

---

## 5. 关键代码锚点

| 模块 | 路径 |
|------|------|
| Phase 类型/投影 | `src/contracts/types/SessionRun.ts` |
| Controller | `src/core/SessionRunController.ts` |
| 接入点 | `src/agents/LeaderAgent.ts` |
| 任务 FSM | `src/core/TaskBoard.ts` + `StatusAdapter` |
| Team | `src/core/TeamMailbox.ts` |
| 完成路径 | `src/agents/LeaderWorkOrchestrator.ts` |
| 评价 overlay | `src/agents/OrchestrationRuntime.ts` |
| 模式投影 | `src/core/ModeRuntimeProjection.ts` |

---

## 6. 实施记录

| 日期 | 提交/说明 |
|------|-----------|
| 2026-07-10 | 固化 roadmap；落地 SessionRunController + derivePhase 单测 + Leader 投影接入（PR-A/B 起步） |
| 2026-07-10 | **D**：waitingForUser 统一 `markWaitingForUser`；ready_needs_decision 强制决策回合；deferred 状态文案 |
| 2026-07-10 | **E**：`createTeamWithRoster` + `assertTeamReady`；TeamCreate/auto-team 原子路径 |
| 2026-07-10 | **G 起步**：裸 complete 不再自动注入 evaluator（需显式 evaluationPolicy） |
| 2026-07-10 | **G 完成**：`set_orchestration_tier` + `evaluateOrchestrationTierGate` 代码门控；ready anti-spin latch；TeamEdit 后 assertTeamReady；RuntimeDiagnostics SessionRun/tier；纯函数单测 |
