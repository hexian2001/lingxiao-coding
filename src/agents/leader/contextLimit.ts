/**
 * Leader model context limit resolver
 *
 * 把 Leader 中两处重复的 "ProviderRegistry > ModelsDevRegistry > fallback"
 * 优先级解析逻辑抽出为纯函数。便于单测且消除复制。
 */

export interface ResolveContextLimitOptions {
  /** ProviderRegistry 中的 contextWindow（来自用户配置） */
  providerCtx: number | null | undefined;
  /** ModelsDevRegistry 中的 contextLimit（来自社区数据） */
  modelInfoCtx: number | null | undefined;
  /** settings.json 中的 llm.context_max_tokens */
  configuredCtx?: number | null | undefined;
  /** 兜底常量（仅 init 期需要） */
  fallback?: number;
}

/**
 * 解析模型 context window：
 * 1. providerCtx > 0 → 直接采用
 * 2. modelInfoCtx > 0 → 采用
 * 3. configuredCtx > 0 → 采用 settings.json 中的 llm.context_max_tokens
 * 4. 都缺失 → 返回 fallback（默认 undefined，让上游决定）
 */
export function resolveModelContextLimit(
  options: ResolveContextLimitOptions,
): number | undefined {
  const { providerCtx, modelInfoCtx, configuredCtx, fallback } = options;
  if (typeof providerCtx === 'number' && providerCtx > 0) return providerCtx;
  if (typeof modelInfoCtx === 'number' && modelInfoCtx > 0) return modelInfoCtx;
  if (typeof configuredCtx === 'number' && configuredCtx > 0) return configuredCtx;
  return fallback;
}
