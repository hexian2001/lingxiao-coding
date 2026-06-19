/**
 * 推理/编排/判定类 LLM 调用的采样参数(防漂移根因修复)。
 *
 * 背景：主推理循环此前完全不设采样温度，走 provider 默认(~1.0)随机解码，
 * 导致相同任务两次跑出不同任务分解 / 工具选择 / 续跑判定。这与
 * `no-heuristics-deterministic-only` 原则相悖——确定性贯彻到了压缩/scope/
 * 任务板，唯独漏了解码器。
 *
 * 这里集中读取 `llm.reasoning_temperature`(默认 0 = 确定性解码)，供 Leader 主推理、
 * Worker 主推理、judgment、压缩摘要、续跑判定等"要可靠不要创意"的调用统一引用。
 *
 * 不走此路径：记忆生成类(Dream/Distill/Checkpoint)各自硬编码发散温度。
 */

import { getConfigValue } from '../config.js';

/**
 * 返回推理调用的 sampling 对象。temperature 未配置时返回 undefined(由调用方决定是否传)。
 */
export function getReasoningSampling(): { temperature: number } | undefined {
  const temperature = getConfigValue('llm.reasoning_temperature');
  return typeof temperature === 'number' ? { temperature } : undefined;
}

/**
 * 返回可直接作为 LlmGuard.call 第 9 参数(generateOptions)的对象。
 * 已合并 sampling；调用方若有 maxTokens 需求可在此基础上展开。
 */
export function getReasoningGenerateOptions(): { sampling?: { temperature: number } } {
  const sampling = getReasoningSampling();
  return sampling ? { sampling } : {};
}

/**
 * 全局温度兜底阈值：调用方未显式指定 sampling.temperature 时锁定的确定性解码温度。
 *
 * 这是确定性常量，不是启发式阈值——它不参与"判结构/判类别"，只是缺省解码参数的
 * 兜底值。配置层 `llm.reasoning_temperature`(schema 默认 0) 是单一事实源；当配置
 * 尚未加载(如早期初始化/单元测试环境 getConfigValue 返回 undefined)时，用此常量
 * 兜底，确保新调用点漏锁也不会静默走 provider 默认(~1.0)导致漂移。
 */
const DETERMINISTIC_FALLBACK_TEMPERATURE = 0;

/**
 * ContentGenerator 层全局温度兜底(防漂移根因修复 A1)。
 *
 * 背景：旧实现透传温度的逻辑是 `params.sampling?.temperature`——只在调用方**显式**
 * 传 sampling 时才下发 temperature。新调用点(Leader/Worker/Judgment/压缩之外的新增
 * LLM 调用)若忘记调 `getReasoningGenerateOptions()`，sampling 为空 → temperature
 * 字段不写 → 走 provider 默认(~1.0 随机解码) → 相同任务两次跑出不同结果(漂移)。
 *
 * 这里在 ContentGenerator 透传处统一收口为三态确定性分派(非启发式，无阈值/无打分)：
 *   1. thinkingActive=true → 返回 undefined
 *      (Anthropic extended thinking 经 API/SDK 强制要求 temperature=1，下发会 400；
 *      Vercel/OpenAI 路径同样不下发，保留 provider 默认)
 *   2. 调用方显式传 sampling.temperature(number) → 原样转发(尊重显式意图，如
 *      记忆生成类调用方显式传发散温度；这是确定性"显式优先"规则)
 *   3. 否则(无 sampling 或 sampling.temperature 缺省) → 锁 getReasoningSampling()，
 *      配置未加载时兜底为 DETERMINISTIC_FALLBACK_TEMPERATURE(0)
 *
 * thinkingActive 由调用方按各自 provider 的真实信号(supportsThinking + 配置开关 +
 * thinking 参数将实际下发)确定性计算后传入，本函数不做任何二次推断。
 *
 * @param explicitTemperature 调用方通过 GenerateContentParams.sampling.temperature 显式传入的温度，
 *        undefined 表示调用方未指定(走兜底)
 * @param thinkingActive 该 provider/模型本次是否处于 thinking 模式(由调用方确定性判定)
 * @returns 最终透传给底层 SDK 的 temperature 数值，或 undefined(表示不下发该字段)
 */
export function resolveGuardedTemperature(
  explicitTemperature: number | undefined,
  thinkingActive: boolean,
): number | undefined {
  if (thinkingActive) return undefined;
  if (typeof explicitTemperature === 'number') return explicitTemperature;
  const configured = getReasoningSampling();
  return configured ? configured.temperature : DETERMINISTIC_FALLBACK_TEMPERATURE;
}
