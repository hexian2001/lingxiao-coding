/**
 * MCP Forge 状态机 — 合法转换校验
 *
 * 契约: contract:mcp-forge-core v1 §1.1, §5
 */

import type { ForgeJobState } from './types.js';
import { TERMINAL_STATES } from './types.js';
import { ForgeError } from './errors.js';

/** 合法状态转换映射 */
const TRANSITIONS: Record<ForgeJobState, ForgeJobState[]> = {
  pending: ['analyzing', 'cancelled'],
  analyzing: ['analyzed', 'analysis_failed', 'cancelled'],
  analyzed: ['generating', 'generation_failed', 'cancelled'],
  generating: ['generated', 'generation_failed', 'cancelled'],
  generated: ['validating', 'validation_skipped', 'cancelled'],
  validating: ['validated', 'validation_failed', 'cancelled'],
  validation_skipped: ['registering', 'cancelled'],
  validated: ['registering', 'validation_failed', 'cancelled'],
  registering: ['registered', 'registration_failed', 'cancelled'],
  registered: ['completed'],
  completed: [],
  analysis_failed: ['analyzing', 'cancelled'],
  generation_failed: ['generating', 'analyzed', 'cancelled'],
  validation_failed: ['validating', 'generating', 'generated', 'analyzed', 'cancelled'],
  registration_failed: ['registering', 'validated', 'cancelled'],
  cancelled: [],
};

/**
 * 校验状态转换是否合法，不合法时抛出 FORGE_STATE_VIOLATION。
 */
export function validateTransition(from: ForgeJobState, to: ForgeJobState): void {
  if (TERMINAL_STATES.has(from) && from !== 'cancelled') {
    // 终态不允许转换（cancelled 已在 TRANSITIONS 中处理）
    if (from === 'completed' && to === 'cancelled') {
      // 允许从 completed 取消（特殊处理）
      return;
    }
    throw new ForgeError(
      'FORGE_STATE_VIOLATION',
      `Cannot transition from terminal state '${from}' to '${to}'`,
      { phase: from, retryable: false },
    );
  }

  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ForgeError(
      'FORGE_STATE_VIOLATION',
      `Invalid state transition: '${from}' → '${to}'. Allowed: [${allowed.join(', ')}]`,
      { phase: from, retryable: false },
    );
  }
}

/**
 * 判断状态转换是否合法（不抛异常）。
 */
export function canTransition(from: ForgeJobState, to: ForgeJobState): boolean {
  if (TERMINAL_STATES.has(from) && from !== 'cancelled') {
    if (from === 'completed' && to === 'cancelled') return true;
    return false;
  }
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * 获取指定状态的所有合法目标状态。
 */
export function getAllowedTransitions(from: ForgeJobState): ForgeJobState[] {
  return TRANSITIONS[from] || [];
}

/**
 * 判断是否为终态。
 */
export function isTerminal(state: ForgeJobState): boolean {
  return TERMINAL_STATES.has(state);
}
