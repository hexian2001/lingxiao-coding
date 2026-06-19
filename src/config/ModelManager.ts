/**
 * ModelManager v3
 *
 * 所有模型通过 model_providers 管理，id 全局唯一。
 * resolveApiKey: envKey 找不到时抛错（而非静默返回空）。
 * getModelByIdStrict: 找不到时抛出 ModelNotFoundError。
 */

import type {
  ModelProviderConfig,
  ModelProvidersConfig,
  RuntimeModelSnapshot,
  ModelCapabilities,
} from '../config.js';
import { refreshRuntimeConfig, config as _cachedConfig, onConfigReload } from '../config.js';
import { coreLogger } from '../core/Log.js';

const RUNTIME_MODEL_PREFIX = '$runtime|';

function isRuntimeModelSnapshotId(candidate: string): boolean {
  return candidate.startsWith(RUNTIME_MODEL_PREFIX);
}

export class ModelNotFoundError extends Error {
  constructor(public readonly modelId: string) {
    super(
      `模型 '${modelId}' 在 model_providers 中未找到。` +
      ` 请检查 settings.json 中 llm.model_providers 是否包含 id='${modelId}' 的条目，` +
      ` 或使用 /model 命令切换到已配置的模型。`,
    );
    this.name = 'ModelNotFoundError';
  }
}

export class ModelManager {
  private modelProviders: ModelProvidersConfig;
  private runtimeModelSnapshots: Map<string, RuntimeModelSnapshot>;

  constructor(modelProviders?: ModelProvidersConfig) {
    this.modelProviders = modelProviders || {};
    this.runtimeModelSnapshots = new Map();
  }

  /**
   * 将 envKey 展开为实际 apiKey。
   * envKey 在 credentials 中未找到时抛错（而非静默）。
   */
  private resolveApiKey(model: ModelProviderConfig): ModelProviderConfig {
    if (model.apiKey) return model;
    if (model.envKey) {
      const credentials = _cachedConfig.credentials || {};
      const resolved = credentials[model.envKey];
      if (resolved) {
        return { ...model, apiKey: resolved };
      }
      throw new Error(
        `[ModelManager] 模型 '${model.id}' 的 envKey '${model.envKey}' 在 credentials 中未找到。` +
        ` 请在 settings.json 的 credentials 字段中添加 "${model.envKey}": "your-api-key"。`,
      );
    }
    return model;
  }

  // ==================== 查询 ====================

  getAllModels(): Array<ModelProviderConfig & { snapshotId?: string }> {
    const models: Array<ModelProviderConfig & { snapshotId?: string }> = [];

    for (const providerModels of Object.values(this.modelProviders)) {
      for (const model of providerModels) {
        try {
          models.push(this.resolveApiKey(model));
        } catch (e) {
          coreLogger.warn(String(e));
        }
      }
    }

    for (const [snapshotId, snapshot] of this.runtimeModelSnapshots.entries()) {
      models.push({
        id: snapshotId,
        name: snapshot.modelId,
        apiKey: snapshot.apiKey,
        baseUrl: snapshot.baseUrl,
        provider: snapshot.provider,
        generationConfig: snapshot.generationConfig,
        capabilities: snapshot.capabilities,
        snapshotId,
      });
    }

    return models;
  }

  getModelsByProvider(provider: string): ModelProviderConfig[] {
    const models = this.modelProviders[provider] || [];
    return models.map(m => this.resolveApiKey(m));
  }

  /**
   * 按 ID 查找模型，找不到返回 undefined。
   */
  getModelById(modelId: string): ModelProviderConfig | RuntimeModelSnapshot | undefined {
    if (isRuntimeModelSnapshotId(modelId)) {
      return this.runtimeModelSnapshots.get(modelId);
    }
    for (const models of Object.values(this.modelProviders)) {
      for (const model of models) {
        if (model.id === modelId) {
          return this.resolveApiKey(model);
        }
      }
    }
    return undefined;
  }

  /**
   * 按 ID 查找模型，找不到抛出 ModelNotFoundError。
   */
  getModelByIdStrict(modelId: string): ModelProviderConfig | RuntimeModelSnapshot {
    const model = this.getModelById(modelId);
    if (!model) throw new ModelNotFoundError(modelId);
    return model;
  }

  /**
   * 验证所有 model_providers 中的 id 全局唯一。
   * 返回重复 id 列表，空数组表示无重复。
   */
  validateUniqueIds(): string[] {
    const seen = new Map<string, number>();
    for (const models of Object.values(this.modelProviders)) {
      for (const model of models) {
        if (model.id) {
          seen.set(model.id, (seen.get(model.id) || 0) + 1);
        }
      }
    }
    return Array.from(seen.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
  }

  // ==================== 增删改 ====================

  addModel(model: ModelProviderConfig): void {
    const provider = model.provider;
    if (!this.modelProviders[provider]) {
      this.modelProviders[provider] = [];
    }
    // 检查全局唯一性
    const duplicateModelIds = new Set(this.validateUniqueIds());
    if (this.getModelById(model.id) || duplicateModelIds.has(model.id)) {
      coreLogger.warn(`[ModelManager] 模型 id '${model.id}' 已存在，跳过添加`);
      return;
    }
    this.modelProviders[provider].push(model);
  }

  updateModel(
    modelId: string,
    updates: Partial<Omit<ModelProviderConfig, 'id' | 'provider'>>,
  ): boolean {
    for (const [provider, models] of Object.entries(this.modelProviders)) {
      const index = models.findIndex(m => m.id === modelId);
      if (index !== -1) {
        models[index] = {
          ...models[index],
          ...updates,
        };
        return true;
      }
    }
    return false;
  }

  deleteModel(modelId: string): boolean {
    for (const models of Object.values(this.modelProviders)) {
      const index = models.findIndex(m => m.id === modelId);
      if (index !== -1) {
        models.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  // ==================== Runtime Snapshots ====================

  createRuntimeSnapshot(
    provider: 'openai' | 'anthropic',
    modelId: string,
    snapshotConfig: {
      apiKey: string;
      baseUrl: string;
      generationConfig?: ModelGenerationConfig;
      capabilities?: ModelCapabilities;
    },
  ): string {
    const snapshotId = `$runtime|${provider}|${modelId}`;
    const snapshot: RuntimeModelSnapshot = {
      snapshotId,
      provider,
      modelId,
      apiKey: snapshotConfig.apiKey,
      baseUrl: snapshotConfig.baseUrl,
      generationConfig: snapshotConfig.generationConfig,
      capabilities: snapshotConfig.capabilities,
    };
    this.runtimeModelSnapshots.set(snapshotId, snapshot);
    coreLogger.debug(`创建运行时快照: ${snapshotId}`);
    return snapshotId;
  }

  getRuntimeSnapshot(snapshotId: string): RuntimeModelSnapshot | undefined {
    return this.runtimeModelSnapshots.get(snapshotId);
  }

  getAllSnapshots(): RuntimeModelSnapshot[] {
    return Array.from(this.runtimeModelSnapshots.values());
  }

  clearAllSnapshots(): void {
    const count = this.runtimeModelSnapshots.size;
    this.runtimeModelSnapshots.clear();
    coreLogger.debug(`已清除 ${count} 个运行时快照`);
  }

  // ==================== 工具方法 ====================

  getModelProvidersConfig(): ModelProvidersConfig {
    return this.modelProviders;
  }

  updateModelProvidersConfig(config: ModelProvidersConfig): void {
    this.modelProviders = config;
  }

  validateModelConfig(model: ModelProviderConfig): string[] {
    const errors: string[] = [];
    if (!model.id) errors.push('模型 ID 不能为空');
    if (!model.apiKey && !model.envKey) errors.push(`模型 '${model.id}' 的 apiKey 或 envKey 不能为空`);
    if (!model.baseUrl) errors.push(`模型 '${model.id}' 的 baseUrl 不能为空`);
    if (model.generationConfig) {
      const gc = model.generationConfig;
      if (gc.temperature !== undefined && (gc.temperature < 0 || gc.temperature > 1)) {
        errors.push(`模型 '${model.id}' 的 temperature 必须在 0-1 之间`);
      }
      if (gc.max_tokens !== undefined && gc.max_tokens <= 0) {
        errors.push(`模型 '${model.id}' 的 max_tokens 必须为正整数`);
      }
    }
    return errors;
  }

  validateAllModels(): string[] {
    const allErrors: string[] = [];
    for (const models of Object.values(this.modelProviders)) {
      for (const model of models) {
        allErrors.push(...this.validateModelConfig(model));
      }
    }
    return allErrors;
  }
}

// 补充缺失的类型引用（ModelGenerationConfig 在 config.ts 里，通过 ModelProviderConfig 传递即可）
import type { ModelGenerationConfig } from '../config.js';

// 全局单例
let globalModelManager: ModelManager | undefined;
let configReloadSubscribed = false;

function ensureConfigReloadSubscription(): void {
  if (configReloadSubscribed) return;
  configReloadSubscribed = true;
  // settings.json 文件被外部直接编辑时（chokidar watcher 触发 refreshRuntimeConfig），
  // 同步 model_providers 到当前 ModelManager，让下次 getModelById* 立即看到新值。
  onConfigReload((cfg) => {
    if (!globalModelManager) return;
    try {
      globalModelManager.updateModelProvidersConfig(cfg.llm.model_providers || {});
      coreLogger.debug('[ModelManager] 已同步 model_providers (settings.json 热加载)');
    } catch (e) {
      coreLogger.warn(`[ModelManager] 同步 model_providers 失败: ${e}`);
    }
  });
}

export function getModelManager(): ModelManager {
  if (!globalModelManager) {
    const runtimeConfig = refreshRuntimeConfig();
    globalModelManager = new ModelManager(runtimeConfig.llm.model_providers);
  }
  ensureConfigReloadSubscription();
  return globalModelManager;
}

export function initModelManager(modelProviders?: ModelProvidersConfig): ModelManager {
  globalModelManager = new ModelManager(modelProviders);
  ensureConfigReloadSubscription();
  return globalModelManager;
}
