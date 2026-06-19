/**
 * Provider 思考参数 —— 类型 re-export。
 *
 * ★ 单一事实源（2026-06 重构，删除按模型名前缀猜能力的家族表）：
 *   - 「模型有没有 thinking / vision / 多模态 / context limit」
 *       → models.dev snapshot（ModelsDevRegistry，社区维护、每小时刷新）。
 *   - 「思考控制机制（effort / toggle / budget_tokens）+ 合法档位值 / 预算区间」
 *       → 同样来自 models.dev 的 reasoning_options 字段。
 *   - 「思考参数名（reasoning_effort / thinking / enable_thinking）」
 *       → 由用户选的 provider wire 格式（model.provider: openai | anthropic）决定。
 *
 * 不再维护家族名前缀表：那是不可靠启发式，匹配不到 glm/minimax 等新模型，
 * 导致思考参数静默不发送（OpenAI「传了和没传一样」/ Anthropic「思考都没开」的根因）。
 */

import type { ThinkingMode as CanonicalThinkingMode, ModelCapabilitySpec } from '../types/canonical.js';

// ThinkingMode — re-exported from canonical（仅用于用户显式 capabilities 配置）
export type ThinkingMode = CanonicalThinkingMode;

// ModelCapabilityConfig — re-exported from canonical
export type ModelCapabilityConfig = ModelCapabilitySpec;

export type ModelCapabilitiesMap = Record<string, ModelCapabilityConfig>;
