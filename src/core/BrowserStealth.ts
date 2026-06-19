/**
 * Browser stealth — 反爬指纹对齐(零依赖,等价 puppeteer-extra-stealth 核心补丁)。
 *
 * 设计原则(契合凌霄「确定性,非启发式」):
 * - 平台 / 版本基于真实运行环境动态生成,不写死 "Chrome/130 Windows"——那是高熵矛盾指纹
 *   (UA 声称 Windows 但实际跑在 Linux,且 Chrome/130 与 Playwright bundled Chromium 真实版本不符)。
 * - addInitScript 在每个 frame 加载前擦除自动化铁证(navigator.webdriver / 缺失的 window.chrome /
 *   空 plugins / SwiftShader webgl vendor / permissions 不一致),等价 stealth 插件核心补丁,
 *   但不引入 playwright-extra / puppeteer-extra-plugin-stealth 第三方依赖。
 *
 * 边界:这只降低被通用反爬(指纹库)识别的概率,不是安全边界,也不是根治。
 * 真正治本是走官方 Search API(见 WebSearch.ts 双后端:有 key 走 API,无 key 才回落到
 * 这条 headless SERP 抓取)。本模块只负责让「回落浏览器路径」少被识别。
 */

import { IS_LINUX, IS_MACOS } from '../utils/platform.js';

/** launch 后探测到的真实 Chrome 主版本号;未探测时回落到 FALLBACK。 */
let detectedChromeMajor: number | null = null;

/**
 * 记录真实 Chromium 主版本号,供 UA 动态对齐。
 * Playwright `browser.version()` 返回形如 "131.0.6778.87",只取主版本号。
 */
export function rememberBrowserVersion(version: string | undefined | null): void {
  if (!version) return;
  const match = /(\d+)\./.exec(version);
  if (match) detectedChromeMajor = parseInt(match[1], 10);
}

/** 仅测试用:重置探测状态。 */
export function _resetDetectedChromeVersionForTesting(): void {
  detectedChromeMajor = null;
}

/** 仅测试用:读取当前探测值。 */
export function _detectedChromeMajorForTesting(): number | null {
  return detectedChromeMajor;
}

/** fallback 主版本号——launch 后会被真实版本覆盖;仅 web_fetch 在浏览器 launch 前调用时用到。 */
const FALLBACK_CHROME_MAJOR = 138;

/** 按真实运行平台生成 UA 的平台 token,消除「UA 说 Windows 实际 Linux」的矛盾。 */
function platformTokenForUserAgent(): string {
  if (IS_MACOS) return 'Macintosh; Intel Mac OS X 10_15_7';
  if (IS_LINUX) return 'X11; Linux x86_64';
  return 'Windows NT 10.0; Win64; x64';
}

/** 生成与真实环境(平台 + Chromium 版本)对齐的 User-Agent。 */
export function buildStealthUserAgent(): string {
  const major = detectedChromeMajor ?? FALLBACK_CHROME_MAJOR;
  return `Mozilla/5.0 (${platformTokenForUserAgent()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * addInitScript 注入脚本——在浏览器上下文执行,不得引用闭包变量、不得含 TS 语法。
 * 全程 try/catch 包裹:任一指纹维度失败不应阻断页面加载。
 */
export function buildStealthInitScript(): string {
  return `
(() => {
  // navigator.webdriver === true 是 headless 自动化的头号铁证,擦为 undefined。
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
  // window.chrome 在真实 Chrome 存在;headless 缺失或残缺,补最小骨架。
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.app) window.chrome.app = { isInstalled: false };
  } catch (e) {}
  // plugins.length === 0 是自动化信号;造一个非空伪数组(含 item/namedItem 接口)。
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const a = [0, 0, 0, 0, 0].map(() => ({ name: '', filename: '', description: '' }));
        a.item = () => null;
        a.namedItem = () => null;
        return a;
      },
      configurable: true,
    });
  } catch (e) {}
  // languages 对齐 context locale(zh-CN 优先)。
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true }); } catch (e) {}
  // hardwareConcurrency:headless 可能是宿主极值,对齐常见值。
  try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true }); } catch (e) {}
  // WebGL vendor/renderer:headless 默认 "Google Inc. (Google)" / "SwiftShader",换成常见显卡。
  // UNMASKED_VENDOR_WEBGL=37445, UNMASKED_RENDERER_WEBGL=37446;同时覆盖 WebGL 与 WebGL2 原型。
  try {
    const patchGetParameter = (proto) => {
      if (!proto || typeof proto.getParameter !== 'function') return;
      const original = proto.getParameter;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return original.call(this, parameter);
      };
    };
    patchGetParameter(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchGetParameter(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  } catch (e) {}
  // permissions.query 对 notifications 在 headless 返回 denied 但 Notification.permission 是 default,不一致。
  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (typeof originalQuery === 'function') {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : originalQuery(parameters);
    }
  } catch (e) {}
})();
`;
}
