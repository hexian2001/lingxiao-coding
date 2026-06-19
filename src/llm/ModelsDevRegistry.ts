/**
 * ModelsDevRegistry — models.dev 模型能力数据库
 *
 * 数据来源优先级：
 *   1. 构建时内嵌的 models-snapshot.json（离线兜底，必选）
 *   2. 本地缓存 ~/.lingxiao/cache/models.json（TTL 1h）
 *   3. 运行时从 https://models.dev/api.json 拉取
 *
 * 查询接口对调用方透明：数据未就绪时返回 undefined，调用方应显式处理未知模型。
 */

import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { buildLingxiaoComponentUserAgent } from '../version.js';

// ── 常量 ──────────────────────────────────────────────────────────────────

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const FETCH_TIMEOUT_MS = 10_000;
const MODELS_DEV_USER_AGENT = buildLingxiaoComponentUserAgent('models.dev registry');

// 缓存文件路径（与项目其他缓存同目录）
function getCachePath(): string {
  const cacheDir = join(homedir(), '.lingxiao', 'cache');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  return join(cacheDir, 'models.json');
}

// ── 类型定义 ──────────────────────────────────────────────────────────────

/** models.dev 原始 Model 结构（只取我们需要的字段）*/
export interface ModelDevRaw {
  id: string;
  attachment?: boolean;    // 文件上传/视觉支持
  reasoning?: boolean;     // 思考/推理模式
  tool_call?: boolean;     // 函数调用
  temperature?: boolean;   // 支持 temperature 参数
  modalities?: {
    input?: string[];      // "text" | "image" | "audio" | "video" | "pdf"
    output?: string[];
  };
  limit?: {
    context?: number;      // 上下文窗口 (tokens)
    input?: number;
    output?: number;       // 最大输出 (tokens)
  };
  /**
   * 思考/推理控制选项（models.dev reasoning_options）。type 决定控制机制：
   *   - "effort"        档位控制（OpenAI/GLM/Grok 风格），values 为合法档位值
   *   - "toggle"        开关控制（Kimi/Qwen/旧 GLM 风格）
   *   - "budget_tokens" token 预算控制（Anthropic/Gemini 风格），min/max 为预算区间
   */
  reasoning_options?: Array<{
    type?: string;
    values?: (string | null)[];
    min?: number;
    max?: number;
  }>;
  /** reasoning 输出字段（models.dev interleaved.field，如 "reasoning_content"）；布尔 true 表示交错但字段未知 */
  interleaved?: { field?: string } | boolean;
  /** 价格（每百万 token 美元；models.dev 提供）*/
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

/**
 * 归一化后的思考控制选项。type 必填，其余按机制可选：
 *   effort        → values（合法档位，已去 null）
 *   budget_tokens → min/max（预算区间）
 *   toggle        → 无附加字段
 */
export interface ReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

/** 经过归一化的模型信息，供内部使用 */
export interface ModelDevInfo {
  /** 是否支持图片输入（attachment 或 modalities.input 包含 image）*/
  vision: boolean;
  /** 是否支持 PDF 输入 */
  pdf: boolean;
  /** 是否支持音频输入 */
  audio: boolean;
  /** 是否支持视频输入 */
  video: boolean;
  /** 是否支持思考/推理模式 */
  reasoning: boolean;
  /** 思考控制选项（来自 models.dev reasoning_options）；undefined 表示 reasoning 不可控/恒开 */
  reasoningOptions?: ReasoningOption[];
  /** reasoning 输出字段名（来自 models.dev interleaved.field，如 "reasoning_content"）*/
  reasoningOutputField?: string;
  /** 是否支持函数调用 */
  toolCall: boolean;
  /** 上下文窗口大小 (tokens) */
  contextLimit?: number;
  /** 最大输出 token 数 */
  outputLimit?: number;
  /** 价格（美元/百万 token），来自 models.dev cost 字段 */
  pricing?: {
    inputPerMToken: number;
    outputPerMToken: number;
    cacheReadPerMToken?: number;
    cacheCreationPerMToken?: number;
  };
}

type ProviderData = {
  models: Record<string, ModelDevRaw>;
};

type ApiData = Record<string, ProviderData>;

// ── ModelsDevRegistry 类 ───────────────────────────────────────────────────

class ModelsDevRegistry {
  /** 归一化后的模型索引：modelId (小写) → ModelDevInfo */
  private index: Map<string, ModelDevInfo> = new Map();
  private loaded = false;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // ★ 推迟初始化到下一个事件循环 tick，避免阻塞主请求链路。
    // 模型能力数据未就绪时 getModelInfo() 返回 undefined，调用方应显式处理未知模型。
    setImmediate(() => this.initAsync());
  }

  // ── 初始化 ───────────────────────────────────────────────────────────────

  private async initAsync(): Promise<void> {
    // 1. 优先加载构建时 snapshot
    this.loadSnapshotSync();

    // 2. 尝试加载本地缓存（覆盖 snapshot，如果缓存更新）
    const cached = this.loadCache();
    if (cached) {
      this.buildIndex(cached);
      this.loaded = true;
    }

    // 3. 后台刷新（如果缓存过期或不存在）
    this.scheduleRefresh();
  }

  // ── 数据加载 ─────────────────────────────────────────────────────────────

  /** 加载构建时内嵌的 snapshot */
  private loadSnapshot(): ApiData | null {
    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const raw = readFileSync(join(currentDir, 'models-snapshot.json'), 'utf-8');
      return JSON.parse(raw) as ApiData;
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  /**
   * 同步加载内置 snapshot。
   *
   * 构造函数仍会在后台初始化，但 LeaderAgent/ContextManager 创建时会立刻查询
   * context window。首次查询必须能命中 snapshot，否则会错误回退到 200K。
   */
  private loadSnapshotSync(): void {
    if (this.loaded && this.index.size > 0) return;
    const snapshotData = this.loadSnapshot();
    if (snapshotData) {
      this.buildIndex(snapshotData);
      this.loaded = true;
    }
  }

  /** 加载本地缓存文件（仅当未过期时）*/
  private loadCache(): ApiData | null {
    try {
      const cachePath = getCachePath();
      const stat = statSync(cachePath);
      const age = Date.now() - stat.mtimeMs;
      if (age > CACHE_TTL_MS) return null; // 已过期，不用旧缓存覆盖 snapshot

      const raw = readFileSync(cachePath, 'utf-8');
      return JSON.parse(raw) as ApiData;
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  /** 从 models.dev 拉取最新数据，写入缓存 */
  private async fetchAndCache(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(MODELS_DEV_URL, {
        headers: { 'User-Agent': MODELS_DEV_USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

      const text = await res.text();
      const data = JSON.parse(text) as ApiData;

      // 写缓存
      try {
        writeFileSync(getCachePath(), text, 'utf-8');
      } catch { /* 写缓存失败无副作用 */ }

      // 更新索引
      this.buildIndex(data);
      this.loaded = true;
      return { ok: true };
    } catch (err) {
      // 网络失败 — 静默，继续使用 snapshot / 旧缓存
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 判断缓存是否需要刷新 */
  private cacheNeedsRefresh(): boolean {
    try {
      const cachePath = getCachePath();
      const stat = statSync(cachePath);
      return Date.now() - stat.mtimeMs > CACHE_TTL_MS;
    } catch {/* expected: fallback to default */
      return true; // 缓存不存在
    }
  }

  private scheduleRefresh(): void {
    // 启动时如果缓存过期，立即后台拉取
    if (this.cacheNeedsRefresh()) {
      void this.fetchAndCache();
    }

    // 每小时刷新一次（不阻塞进程退出）
    this.refreshTimer = setInterval(() => {
      void this.fetchAndCache();
    }, CACHE_TTL_MS);
    this.refreshTimer.unref?.();
  }

  // ── 索引构建 ─────────────────────────────────────────────────────────────

  private buildIndex(data: ApiData): void {
    const newIndex = new Map<string, ModelDevInfo>();

    const setIfBetter = (key: string, info: ModelDevInfo) => {
      const existing = newIndex.get(key);
      if (!existing) {
        newIndex.set(key, info);
        return;
      }
      // 多个 provider 有同名模型时，取能力更丰富的那个：
      // reasoning=true > false，vision=true > false
      if (!existing.reasoning && info.reasoning) newIndex.set(key, info);
      else if (!existing.vision && info.vision) newIndex.set(key, info);
    };

    for (const provider of Object.values(data)) {
      if (!provider?.models) continue;
      for (const [rawId, model] of Object.entries(provider.models)) {
        const info = this.normalize(model);
        setIfBetter(rawId.toLowerCase(), info);
        if (model.id && model.id.toLowerCase() !== rawId.toLowerCase()) {
          setIfBetter(model.id.toLowerCase(), info);
        }
      }
    }

    this.index = newIndex;
  }

  private normalize(model: ModelDevRaw): ModelDevInfo {
    const inputModalities = model.modalities?.input ?? [];
    const cost = model.cost;
    let pricing: ModelDevInfo['pricing'];
    if (cost && (typeof cost.input === 'number' || typeof cost.output === 'number')) {
      pricing = {
        inputPerMToken: typeof cost.input === 'number' ? cost.input : 0,
        outputPerMToken: typeof cost.output === 'number' ? cost.output : 0,
        cacheReadPerMToken: typeof cost.cache_read === 'number' ? cost.cache_read : undefined,
        cacheCreationPerMToken: typeof cost.cache_write === 'number' ? cost.cache_write : undefined,
      };
    }
    // 思考控制选项：只保留有 type 的条目；effort 的 values 去 null 收敛为 string[]。
    const reasoningOptions: ReasoningOption[] | undefined = Array.isArray(model.reasoning_options)
      ? model.reasoning_options
          .map((o): ReasoningOption => ({
            type: typeof o?.type === 'string' ? o.type : '',
            values: Array.isArray(o?.values)
              ? o.values.filter((v): v is string => typeof v === 'string')
              : undefined,
            min: typeof o?.min === 'number' ? o.min : undefined,
            max: typeof o?.max === 'number' ? o.max : undefined,
          }))
          .filter((o) => o.type.length > 0)
      : undefined;
    // reasoning 输出字段：interleaved 可能是 {field} 对象或布尔 true（字段未知）。
    const reasoningOutputField =
      model.interleaved && typeof model.interleaved === 'object' && typeof model.interleaved.field === 'string'
        ? model.interleaved.field
        : undefined;
    return {
      vision:      (model.attachment ?? false) || inputModalities.includes('image'),
      pdf:         inputModalities.includes('pdf'),
      audio:       inputModalities.includes('audio'),
      video:       inputModalities.includes('video'),
      reasoning:   model.reasoning ?? false,
      reasoningOptions,
      reasoningOutputField,
      toolCall:    model.tool_call ?? true,
      contextLimit: model.limit?.context,
      outputLimit:  model.limit?.output,
      pricing,
    };
  }

  // ── 公共查询接口 ─────────────────────────────────────────────────────────

  /**
   * 按模型 ID 查询能力信息。
   *
   * 匹配策略（和 models.dev 一致）：
   *   1. 精确匹配（小写）
   *   2. 前缀匹配（从最长 key 开始）
   */
  getModelInfo(modelId: string): ModelDevInfo | undefined {
    if (!this.loaded || this.index.size === 0) {
      this.loadSnapshotSync();
    }
    if (!this.loaded || this.index.size === 0) return undefined;

    const id = modelId.trim().toLowerCase();

    // 1. 精确匹配
    const exact = this.index.get(id);
    if (exact) return exact;

    // 2. 前缀匹配：找最长匹配的 key
    let bestKey = '';
    let bestInfo: ModelDevInfo | undefined;
    for (const [key, info] of this.index) {
      if (id.startsWith(key) && key.length > bestKey.length) {
        bestKey = key;
        bestInfo = info;
      }
    }
    return bestInfo;
  }

  /**
   * 按模型 ID 精确查询能力信息。
   *
   * 用于定价等不能容忍前缀猜测的路径；例如 `claude-opus-4` 不应因为
   * 前缀关系静默套用 `claude-opus-4-20250514` 的价格。
   */
  getModelInfoExact(modelId: string): ModelDevInfo | undefined {
    if (!this.loaded || this.index.size === 0) {
      this.loadSnapshotSync();
    }
    if (!this.loaded || this.index.size === 0) return undefined;
    const id = modelId.trim().toLowerCase();
    return this.index.get(id);
  }

  /** 数据是否已加载（snapshot 或缓存）*/
  isAvailable(): boolean {
    return this.loaded;
  }

  /** 当前模型索引规模（用于状态查询）*/
  size(): number {
    return this.index.size;
  }

  /** 缓存文件元信息（路径、上次修改时间、是否过期）*/
  getCacheStatus(): { path: string; mtimeMs?: number; ageMs?: number; ttlMs: number; expired: boolean; exists: boolean } {
    const path = getCachePath();
    try {
      const stat = statSync(path);
      const ageMs = Date.now() - stat.mtimeMs;
      return { path, mtimeMs: stat.mtimeMs, ageMs, ttlMs: CACHE_TTL_MS, expired: ageMs > CACHE_TTL_MS, exists: true };
    } catch {/* expected: fallback to default */
      return { path, ttlMs: CACHE_TTL_MS, expired: true, exists: false };
    }
  }

  /** 强制刷新（用于测试或手动触发，返回是否成功拉到新数据）*/
  async refresh(): Promise<{ ok: boolean; size: number; error?: string }> {
    const result = await this.fetchAndCache();
    return { ok: result.ok, size: this.index.size, error: result.error };
  }
}

// ── 全局单例 ──────────────────────────────────────────────────────────────

let registry: ModelsDevRegistry | null = null;

export function getModelsDevRegistry(): ModelsDevRegistry {
  if (!registry) {
    registry = new ModelsDevRegistry();
  }
  return registry;
}

/** 直接查询快捷方法 */
export function getModelDevInfo(modelId: string): ModelDevInfo | undefined {
  return getModelsDevRegistry().getModelInfo(modelId);
}

/** 精确查询快捷方法：不会执行前缀匹配。 */
export function getModelDevInfoExact(modelId: string): ModelDevInfo | undefined {
  return getModelsDevRegistry().getModelInfoExact(modelId);
}
