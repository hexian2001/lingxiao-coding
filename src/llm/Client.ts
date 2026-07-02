import type { ChatResponse, StreamCallbacks } from './types.js';
import {
  config as _cachedConfig,
  getConfigValue,
  type Config,
  type ModelProviderConfig,
  type RuntimeModelSnapshot,
} from '../config.js';
import { getModelManager } from '../config/ModelManager.js';
import { applyLocalVisionFallback } from './local_vision_fallback.js';
import { normalizeImageRetainRounds, rehydrateRecentImageBlobRefs } from './image_blob_store.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  CountTokensParams,
  CountTokensResult,
  GenerateContentParams,
  StreamEvent,
} from './ContentGenerator.js';
import { createContentGenerator } from './ContentGenerator.js';
import { rebuildSharedFetch } from './http_dispatcher.js';

/**
 * LLMClientManager v4 — 实现 ContentGenerator 接口
 *
 * 解析规则（简洁无歧义）：
 * 1. 传入 modelId → ModelManager.getModelByIdStrict(modelId) → 用 model.apiKey + model.baseUrl
 * 2. 找不到 → 抛出 ModelNotFoundError（明确提示用户配置）
 * 3. 不再有全局 provider 凭据/地址回退
 *
 * 热更新：model_providers 里的 envKey 每次调用时重新 resolve（ModelManager 实时读 credentials）。
 */
export class LLMClientManager implements ContentGenerator {
  private provider: 'openai' | 'anthropic';
  private generator: ContentGenerator;
  private runtimeConfig: Config;
  private modelId: string;
  private modelConfig: ModelProviderConfig | RuntimeModelSnapshot;

  constructor(modelOrProvider?: string | 'openai' | 'anthropic' | 'auto') {
    this.runtimeConfig = _cachedConfig;

    // 确定 modelId
    const modelId =
      (!modelOrProvider || modelOrProvider === 'auto' || modelOrProvider === 'openai' || modelOrProvider === 'anthropic')
        ? (this.runtimeConfig.llm.leader_model || '')
        : modelOrProvider;

    this.modelId = modelId;

    if (!modelId) {
      throw new Error(
        '未配置 leader_model。请在 settings.json 中设置 llm.leader_model，' +
        '并确保 llm.model_providers 中存在对应的模型条目。',
      );
    }

    // 严格查找，找不到抛 ModelNotFoundError
    this.modelConfig = getModelManager().getModelByIdStrict(modelId);
    this.provider = this.modelConfig.provider as 'openai' | 'anthropic';
    this.generator = this.createGenerator();
  }

  private createGenerator(): ContentGenerator {
    if (!this.modelConfig.apiKey) {
      throw new Error(
        `模型 '${this.modelId}' 的 apiKey 为空。` +
        ` 请检查 credentials 中是否存在对应的 envKey，或直接在 model_providers 中配置 apiKey。`,
      );
    }

    const config: ContentGeneratorConfig = {
      modelId: this.modelId,
      apiModelName: this.modelConfig.model || this.modelId,
      provider: this.provider,
      apiKey: this.modelConfig.apiKey,
      baseUrl: this.modelConfig.baseUrl,
      wireApi: this.modelConfig.wireApi,
    };

    return createContentGenerator(config);
  }

  /**
   * 重新从 ModelManager 获取最新模型配置。
   * 当 session 热切换模型时必须同步切换 provider/baseUrl/apiKey。
   */
  private refreshModelConfig(model?: string): void {
    const targetModelId = model || this.modelId;
    const latest = getModelManager().getModelByIdStrict(targetModelId);
    const latestProvider = latest.provider as 'openai' | 'anthropic';
    if (
      targetModelId !== this.modelId ||
      latestProvider !== this.provider ||
      latest.model !== this.modelConfig.model ||
      latest.apiKey !== this.modelConfig.apiKey ||
      latest.baseUrl !== this.modelConfig.baseUrl
    ) {
      this.modelId = targetModelId;
      this.modelConfig = latest;
      this.provider = latestProvider;
      this.generator = this.createGenerator();
    }
  }

  /**
   * 解析实际发送给 API 的模型名。
   */
  private resolveApiModelName(model?: string): string {
    const targetModelId = model || this.modelId;
    if (targetModelId === this.modelId && this.modelConfig.model) {
      return this.modelConfig.model;
    }
    const config = getModelManager().getModelByIdStrict(targetModelId);
    if ('model' in config && config.model) {
      return config.model;
    }
    return targetModelId;
  }

  getModelId(): string {
    return this.modelId;
  }

  private imageHistoryRetainRounds(): number {
    const configured = Number(getConfigValue('advanced.image_history_retain_rounds'));
    return normalizeImageRetainRounds(configured);
  }

  // ─── ContentGenerator 接口实现 ─────────────────────────────────────────

  async generateContent(params: GenerateContentParams): Promise<ChatResponse> {
    this.refreshModelConfig(params.model);
    const apiModelName = this.resolveApiModelName(params.model);
    const rehydratedMessages = await rehydrateRecentImageBlobRefs(params.messages, this.imageHistoryRetainRounds());
    const preparedMessages = await applyLocalVisionFallback(rehydratedMessages, apiModelName);
    return this.generator.generateContent({ ...params, messages: preparedMessages, model: apiModelName });
  }

  async *generateContentStream(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): AsyncGenerator<StreamEvent, ChatResponse, undefined> {
    this.refreshModelConfig(params.model);
    const apiModelName = this.resolveApiModelName(params.model);
    const rehydratedMessages = await rehydrateRecentImageBlobRefs(params.messages, this.imageHistoryRetainRounds());
    const preparedMessages = await applyLocalVisionFallback(rehydratedMessages, apiModelName, callbacks?.onProgress);
    return yield* this.generator.generateContentStream(
      { ...params, messages: preparedMessages, model: apiModelName },
      callbacks,
    );
  }

  async generateContentWithCallbacks(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): Promise<ChatResponse> {
    this.refreshModelConfig(params.model);
    const apiModelName = this.resolveApiModelName(params.model);
    const rehydratedMessages = await rehydrateRecentImageBlobRefs(params.messages, this.imageHistoryRetainRounds());
    const preparedMessages = await applyLocalVisionFallback(rehydratedMessages, apiModelName, callbacks?.onProgress);
    return this.generator.generateContentWithCallbacks(
      { ...params, messages: preparedMessages, model: apiModelName },
      callbacks,
    );
  }

  async countTokens(params: CountTokensParams): Promise<CountTokensResult> {
    return this.generator.countTokens(params);
  }

  async close(): Promise<void> {
    await this.generator.close();
  }

  async warmup(): Promise<void> {
    await this.generator.warmup?.();
  }

  /**
   * 强制丢弃当前 generator + 共享 HTTP dispatcher，下一次调用重建。
   * 配合 LlmGuard 在 request_timeout / network_error 等强信号下使用，
   * 避免 keep-alive 半开 socket 把 leader 长时间钉死。
   *
   * **顺序很重要**：必须先 rebuildSharedFetch() 销毁旧 undici Agent，再 createGenerator()
   * 让新 SDK client 在构造时拿到新的 fetch；否则新 client 会捕获旧的 _cachedCustomFetch
   * 引用，继续走那个已经半死的 socket 池 — 那是用户报"recycle 没效果，5 次都同样错"
   * 的根因。
   */
  recycle(): void {
    // 1) 释放当前 generator 内部 SDK client（best-effort）
    try {
      this.generator.recycle?.();
    } catch { /* tolerate */ }
    // 2) 同步销毁旧 undici Agent + 清缓存：下次 getSharedFetch() 一定构造新 dispatcher
    try {
      rebuildSharedFetch();
    } catch { /* tolerate */ }
    // 3) 重建 generator —— 此时 getSharedFetch() 会返回新 dispatcher 上的 fetch，
    //    新 SDK client 在构造时捕获新 fetch 引用，彻底切断旧 socket 池
    try {
      this.generator = this.createGenerator();
    } catch { /* tolerate — 下次 generateContent 时 refreshModelConfig 还会再试 */ }
  }

  getProviderKey(model: string): string | null {
    this.refreshModelConfig(model);
    return this.generator.getProviderKey?.(model) ?? null;
  }
}

/**
 * 创建 ContentGenerator 实例（同步工厂）。
 *
 * 从 ModelManager 解析模型配置，返回实现 ContentGenerator 接口的 LLMClientManager。
 * 这是所有上层代码获取 LLM 客户端的唯一入口。
 */
export function createLLMClient(modelOrProvider?: string | 'openai' | 'anthropic' | 'auto'): LLMClientManager {
  return new LLMClientManager(modelOrProvider);
}

export default LLMClientManager;
