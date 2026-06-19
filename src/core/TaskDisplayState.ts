/**
 * TaskDisplayState — 任务面向用户的展示态
 *
 * 后端 TaskBoard 用 (status: 'dispatchable'|'running'|'terminal') × (exitReason)
 * 二元组建模任务状态机，但这是状态机内部值，不应直接暴露给 UI。
 * 本模块负责把内部值派生为面向用户的单一展示态 displayState，由 SSE 与 REST 一并推送到前端。
 *
 * 前端只读 displayState，不读 status / exitReason，避免每个面板各自解读、文案漂移。
 */

import type { Task } from './TaskBoard.js';
import { normalizeTaskDisplayState, type NormalizedTaskDisplayState } from './StateSemantics.js';

export type TaskDisplayState = NormalizedTaskDisplayState;

/**
 * 从 status / exitReason / assigned_agent 派生 displayState。
 *
 * - terminal 优先看 exitReason：completed→completed；failed/timeout→failed；cancelled→cancelled。
 *   exitReason 缺失（不应出现，状态机会强制配对）按 failed 兜底。
 * - running 直接映射。
 * - dispatchable 看是否分配过 agent：未分配 → pending；已分配（被退回重派的场景）→ dispatchable。
 */
function deriveTaskDisplayState(task: Pick<Task, 'status' | 'exitReason' | 'assigned_agent'>): TaskDisplayState {
  return normalizeTaskDisplayState(task);
}

export interface TaskWithDisplay extends Task {
  displayState: TaskDisplayState;
}

/**
 * 给 task 附加 displayState 字段，返回浅拷贝。原对象不变。
 * 用于 emit / SSE 出口，避免污染内部状态机字段。
 */
export function withDisplayState(task: Task): TaskWithDisplay {
  return { ...task, displayState: deriveTaskDisplayState(task) };
}
