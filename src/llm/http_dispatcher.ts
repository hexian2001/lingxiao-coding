/**
 * 共享 HTTP dispatcher（OpenAI / Anthropic Provider 共用）
 *
 * 设计目标：
 * 1. 单例 dispatcher：所有 LLM 请求复用同一个 undici Agent 的 socket 池
 * 2. 显式 keepAlive 配置：覆盖 undici 默认 4s 的 keepAliveTimeout，避免
 *    用户在两次请求间隔（编辑、思考、压缩）超过 4s 时连接被回收，
 *    下次请求触发完整 TCP+TLS 握手（"断开重连"感）
 * 3. 强制 HTTP/1.1：许多国内 LLM API 在 HTTP/2 下出现 ECONNRESET
 * 4. headersTimeout=300s + bodyTimeout=0 双层兜底：
 *    - headersTimeout 是 *header 层* 兜底（HTTP/1.1 chunked 流式：headers
 *      返回 200 OK 后才开始 body chunks。thinking model（o3, claude-opus extended
 *      thinking）合法等待 2-5 分钟才返回首个 header；大文件工具调用场景模型
 *      需要长时间 thinking 后才开始输出）
 *    - bodyTimeout=0：流式 body 持续数分钟正常，由 SDK request timeout 兜底
 *
 *    历史版本：
 *      • audit-2026-05-15 把 headersTimeout 从 0（=undici 默认 5min）调到 30s
 *      • audit-2026-05-28 误判把 headersTimeout 调到 600s "信赖远端"
 *        → 反而把死 socket 上的 fetch 拖到 SDK 600s timeout 才报错
 *        → 5 次重试每次都等满 600s，用户感知"卡 50 分钟"。
 *        已回退到 30s。
 *      • audit-2026-05-29 thinking model 合法等 60-120s 首 header，30s 误断
 *        → 调到 120s。仍远小于 SDK 600s timeout，死 socket 仍能快速失败。
 *      • audit-2026-05-30 大文件工具调用（file_create 几千行）模型 thinking 2-5min
 *        → 120s 仍误断。调到 300s，死 socket 由 SDK 600s timeout 兜底。
 *
 * 环境变量覆盖：
 *   LINGXIAO_HTTP_HEADERS_TIMEOUT_MS 默认 300_000
 *   LINGXIAO_HTTP_KEEPALIVE_MS       默认 30_000
 *   LINGXIAO_HTTP_KEEPALIVE_MAX_MS   默认 600_000
 *   LINGXIAO_HTTP_CONNECTIONS        默认 8
 */

import { Agent as UndiciAgent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { getScopedProxyFetch } from '../core/ProxyConfig.js';
import { withUserAgentHeader } from '../core/UserAgent.js';

const DEFAULT_HEADERS_TIMEOUT_MS = 300_000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 30_000;
const DEFAULT_KEEPALIVE_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_CONNECTIONS_PER_HOST = 8;

let _cachedCustomFetch: typeof fetch | undefined | null = null; // null = 未初始化
let _cachedDispatcher: UndiciAgent | ProxyAgent | undefined;

function readNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function buildAgentOptions() {
  return {
    headersTimeout: readNumberEnv('LINGXIAO_HTTP_HEADERS_TIMEOUT_MS', DEFAULT_HEADERS_TIMEOUT_MS),
    bodyTimeout: 0,
    allowH2: false,
    keepAliveTimeout: readNumberEnv('LINGXIAO_HTTP_KEEPALIVE_MS', DEFAULT_KEEPALIVE_TIMEOUT_MS),
    keepAliveMaxTimeout: readNumberEnv('LINGXIAO_HTTP_KEEPALIVE_MAX_MS', DEFAULT_KEEPALIVE_MAX_TIMEOUT_MS),
    connections: readNumberEnv('LINGXIAO_HTTP_CONNECTIONS', DEFAULT_CONNECTIONS_PER_HOST),
    pipelining: 1,
  } as ConstructorParameters<typeof UndiciAgent>[0];
}

/**
 * 返回共享的 fetch 实现；首次调用时构造 dispatcher 并缓存。
 * 所有 provider（OpenAI、Anthropic）都应通过这个函数拿 fetch，
 * 也包括 warmup 路径，确保预热建立的连接进入正确的池。
 */
export function getSharedFetch(): typeof fetch | undefined {
  if (_cachedCustomFetch !== null) return _cachedCustomFetch;
  try {
    const configuredProxyFetch = getScopedProxyFetch('llm');
    if (configuredProxyFetch) {
      _cachedCustomFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        return configuredProxyFetch(input, withUserAgentHeader(input, init));
      }) as typeof fetch;
      return _cachedCustomFetch;
    }

    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy;

    const agentOpts = buildAgentOptions();
    _cachedDispatcher = proxyUrl
      ? new ProxyAgent({
          uri: proxyUrl,
          ...agentOpts,
        } as ConstructorParameters<typeof ProxyAgent>[0])
      : new UndiciAgent(agentOpts);

    const dispatcher = _cachedDispatcher;
    _cachedCustomFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      return undiciFetch(input as unknown as Parameters<typeof undiciFetch>[0], { ...withUserAgentHeader(input, init), dispatcher } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<typeof fetch>;
    }) as typeof fetch;
    return _cachedCustomFetch;
  } catch {
    // undici 不可用（极少发生），回退到默认 fetch
    _cachedCustomFetch = undefined;
    return undefined;
  }
}

/**
 * 仅用于测试：清除缓存，强制下次重新构造。
 */
export function __resetSharedFetchForTest(): void {
  _cachedCustomFetch = null;
  _cachedDispatcher = undefined;
}

/**
 * 强制重建共享 dispatcher：销毁旧 undici Agent（连带回收所有 keep-alive socket），
 * 下次 getSharedFetch() 会构造新的。LLM 长跑时如果 provider 中断或 socket 被
 * 中间设备半开（half-open）但 keep-alive 探活拿不到 RST，老 socket 会卡住请求；
 * 由上层在判定 provider 真死时显式触发，配合 generator.recycle()。
 */
export function rebuildSharedFetch(): void {
  const old = _cachedDispatcher;
  _cachedCustomFetch = null;
  _cachedDispatcher = undefined;
  // 异步关闭旧 dispatcher，避免阻塞 caller
  if (old) {
    void Promise.resolve()
      .then(() => old.destroy(new Error('rebuildSharedFetch: provider recycle requested')))
      .catch(() => { /* tolerate — destroy 是 best-effort */ });
  }
}
