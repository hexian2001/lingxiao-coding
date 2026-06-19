import { z } from 'zod';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import net from 'net';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { browserManager } from './BrowserManager.js';
import { resolveTaskWritePath, listListeningLoopbackPorts, type ListeningPort } from './utils.js';

const BrowserVisualVerifySchema = z.object({
  url: z.string().url().describe('要打开并验证的 URL'),
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().default('domcontentloaded'),
  viewport: z.object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160),
  }).optional().describe('视口大小，默认 1440x900'),
  assertions: z.object({
    text: z.array(z.string().min(1)).optional().describe('必须出现在页面可见文本中的片段'),
    selectors: z.array(z.string().min(1)).optional().describe('必须存在的 CSS selector'),
  }).optional(),
  screenshot_path: z.string().optional().describe('截图输出路径，默认写入 .lingxiao/artifacts'),
  full_page: z.boolean().optional().default(false).describe('是否截取完整页面'),
});

type BrowserVisualVerifyParams = z.infer<typeof BrowserVisualVerifySchema>;

function defaultScreenshotPath(context?: ToolContext): string {
  const workspace = context?.workspace || process.cwd();
  return resolve(workspace, '.lingxiao', 'artifacts', `browser-visual-${Date.now()}.png`);
}

// ==================== 可见文本判定 ====================

// 等待客户端渲染就绪的上限。networkidle 只反映网络空闲、不反映 DOM 渲染完成,对 SPA/CSR
// 会在文本水合进 DOM 之前就抓 innerText 致误报。此处确定性等待断言文本真正进入 DOM。
// 这只是一个"等多久"的工程上限(同 page.goto 的 timeout 性质),判定逻辑本身基于真实
// DOM 文本信号、非启发式阈值。
const RENDER_SETTLE_TIMEOUT_MS = 5000;

/** 折叠连续空白为单空格并去首尾。视觉验收关心的是"可见文本",连续空白(换行/缩进/
 *  断言里手误多敲的空格,如 "云  笺" vs 渲染出的 "云笺")在视觉上不可见,不应导致断言失败。 */
export function normalizeVisibleWhitespace(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** 视觉等价的文本包含判定:忽略连续空白差异后做 includes。 */
export function visibleTextContains(haystack: string, needle: string): boolean {
  return normalizeVisibleWhitespace(haystack).includes(normalizeVisibleWhitespace(needle));
}

/** 删除所有空白字符(用于检测 "云  笺" 与 "云笺" 这类纯空白/排版差异)。 */
export function stripAllWhitespace(s: string): string {
  return (s ?? '').replace(/\s+/g, '');
}

/** 构造文本断言失败的 reason。折叠连续空白后不等即判"未找到";若去尽所有空白后匹配,
 *  则确定性点明这是空白差异(常见于断言里手误多敲的空格,如 "云  笺" 而页面渲染 "云笺"),
 *  给出可执行引导,而非干巴巴的 not found。判定基于真实计算、非关键词启发式。 */
export function describeTextFailure(haystack: string, needle: string): string {
  if (stripAllWhitespace(haystack).includes(stripAllWhitespace(needle))) {
    return `visible text not found (去尽空白后匹配——页面可能含该文本但空白不同,请核对断言「${needle}」中的空格/换行是否为笔误)`;
  }
  return 'visible text not found';
}

// ==================== 连接失败诊断 ====================
// 工具失败时若只倒出原始 Playwright 错误(如 net::ERR_CONNECTION_REFUSED),调用方常误诊为
// "沙箱网络隔离"而瞎试。这里按真实的协议错误码(Chromium net 码 + Node errno)确定性分类,
// 并用 ss/netstat 的真实监听端口 + 跨地址族探活,给出可执行引导。
// 这是按系统真实信号源判定,非关键词启发式。

export type ConnErrorClass = 'refused' | 'name-resolution' | 'timeout' | 'reset' | 'empty' | 'other';

/** 按真实的错误码分类连接失败(确定性:匹配的是系统发出的确切错误码,非模糊关键词)。 */
export function classifyConnectionError(msg: string): ConnErrorClass {
  const lower = msg.toLowerCase();
  if (lower.includes('err_connection_refused') || lower.includes('econnrefused')) return 'refused';
  if (lower.includes('err_name_not_resolved') || lower.includes('err_name_resolution_failed')
    || lower.includes('enotfound') || lower.includes('getaddrinfo')) return 'name-resolution';
  if (lower.includes('err_timed_out') || lower.includes('err_connection_timed_out') || lower.includes('etimedout')) return 'timeout';
  if (lower.includes('err_connection_reset') || lower.includes('econnreset')) return 'reset';
  if (lower.includes('err_empty_response')) return 'empty';
  return 'other';
}

/** 用 TCP 探活判定某 IP:port 是否真能连上(连接成功即返回 true,被拒/超时返回 false)。 */
export function probeReachable(ip: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, ip);
  });
}

export interface DiagnosisDeps {
  /** 注入端口枚举(测试用);默认调真实 listListeningLoopbackPorts。 */
  listPorts?: () => ListeningPort[];
  /** 注入探活(测试用);默认调真实 probeReachable。 */
  probe?: (ip: string, port: number) => Promise<boolean>;
}

/**
 * 为连接类失败构造可执行引导:指出端口是否有监听、列出实际在听的 loopback 端口、
 * 检测 IPv4/IPv6 地址族不匹配(127.0.0.1 拒而 ::1 可通的情形)并给出可用的真实 URL。
 * 未知错误类或 URL 不可解析时返回空串(不臆造引导,回退到原始错误)。
 */
export async function buildConnectionGuidance(
  rawUrl: string,
  errorMsg: string,
  deps?: DiagnosisDeps,
): Promise<string> {
  const errorClass = classifyConnectionError(errorMsg);
  if (errorClass === 'other') return '';

  const listPorts = deps?.listPorts ?? listListeningLoopbackPorts;
  const probe = deps?.probe ?? probeReachable;

  let host = '';
  let port = 0;
  try {
    const parsed = new URL(rawUrl);
    host = parsed.hostname.replace(/^\[|\]$/g, '');
    port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    return '';
  }

  const parts: string[] = [];
  switch (errorClass) {
    case 'refused':
      parts.push(`目标 ${host}:${port} 没有进程在接受连接(连接被拒)。`);
      break;
    case 'name-resolution':
      parts.push(`主机名 "${host}" 无法解析。检查拼写,或改用 IP(127.0.0.1 / localhost)。`);
      break;
    case 'timeout':
      parts.push(`连接 ${host}:${port} 超时无响应。可能 server 还没起好、绑到了错误地址,或被防火墙挡。`);
      break;
    case 'reset':
      parts.push(`连接 ${host}:${port} 被重置(server 接受后立即断开,常见于进程崩溃)。`);
      break;
    case 'empty':
      parts.push(`连接 ${host}:${port} 返回空响应(server 连上但未正确回应 HTTP,可能不是 HTTP 服务)。`);
      break;
    default:
      return '';
  }

  // 对 loopback 目标跨地址族探活:检测 "127.0.0.1 被拒而 ::1 可通"(server 绑了 IPv6-only)及其反向。
  const isLoopbackTarget = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  if (isLoopbackTarget && port > 0) {
    const probes: Array<{ label: string; ip: string }> = [];
    if (host !== '127.0.0.1') probes.push({ label: `http://127.0.0.1:${port}`, ip: '127.0.0.1' });
    if (host !== '::1') probes.push({ label: `http://[::1]:${port}`, ip: '::1' });
    const reachable = await Promise.all(
      probes.map(async (p) => ((await probe(p.ip, port)) ? p.label : null)),
    );
    const ok = reachable.filter((r): r is string => r !== null);
    if (ok.length > 0) {
      parts.push(`检测到该端口在另一地址族可通(IPv4/IPv6 绑定不匹配),改用: ${ok.join(' / ')}。`);
    }
  }

  // 列出实际在听的 loopback 端口,让调用方一眼看出端口填错。
  const listening = listPorts().filter((p) => p.port !== port);
  if (listening.length > 0) {
    const shown = listening.slice(0, 12).map((p) => String(p.port)).join(', ');
    const extra = listening.length > 12 ? ` …(共 ${listening.length} 个)` : '';
    parts.push(`当前本机 loopback 实际在听的端口: ${shown}${extra}。dev server 很可能不在你填的 ${port}。`);
  }

  // 仅在原目标是 127.0.0.1 字面量时,提示换 localhost(localhost 可能解析为 ::1)。
  if (host === '127.0.0.1') {
    parts.push(`若 server 绑的是 localhost(部分系统解析为 ::1),可改试 http://localhost:${port}。`);
  }
  return parts.join(' ');
}

export class BrowserVisualVerifyTool extends Tool {
  readonly name = 'browser_visual_verify';
  readonly description = '浏览器视觉验收：打开页面、设置视口、检查文本/selector、保存截图，并返回页面标题、尺寸和失败断言。适合前端改动后验收。';
  readonly parameters = BrowserVisualVerifySchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as BrowserVisualVerifyParams;

    // 先解析并校验截图输出路径(工作区/会话写入隔离)：失败时立即返回可执行引导，
    // 避免白跑一轮浏览器(导航/断言/截图)之后才发现写不进去。
    let rawScreenshotPath: string;
    try {
      rawScreenshotPath = params.screenshot_path
        ? resolveTaskWritePath(context?.workspace, params.screenshot_path, context?.sessionId, context?.taskWriteScope)
        : defaultScreenshotPath(context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const hint = params.screenshot_path
        ? '可省略 screenshot_path 参数，改用默认输出目录 .lingxiao/artifacts；'
        : '';
      return {
        success: false,
        data: null,
        error: `截图路径不可写: ${reason}${hint ? ` ${hint}` : ''}`,
      };
    }

    let page: import('playwright').Page;
    try {
      page = await browserManager.ensureBrowser();
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `浏览器启动失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const viewport = params.viewport || { width: 1440, height: 900 };
      await page.setViewportSize(viewport);
      await page.goto(params.url, {
        waitUntil: params.wait_until ?? 'domcontentloaded',
        timeout: 30_000,
      });

      // networkidle 只反映网络空闲、不反映客户端渲染完成。对 SPA/CSR,断言文本可能在
      // JS 水合进 DOM 之前还不可见——若抓取一次 innerText 即判,会与稍后(渲染已完成时)
      // 拍的截图矛盾,误报断言失败(用户实际遇到的"截图看着对、断言却报错")。
      // 因此:先确定性等待所有断言文本/选择器进入 DOM(超时不抛,由下面逐条精确判定
      // 哪些真正缺失),再抓最终可见文本判定。这是基于真实 DOM 信号的等待,非固定 sleep。
      const textNeedles = params.assertions?.text ?? [];
      const selectorList = params.assertions?.selectors ?? [];

      if (textNeedles.length > 0) {
        await page.waitForFunction(
          (needles: string[]) => {
            const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
            const body = document.body?.innerText ?? '';
            return needles.every((n) => norm(body).includes(norm(n)));
          },
          textNeedles,
          { timeout: RENDER_SETTLE_TIMEOUT_MS },
        ).catch(() => {});
      }
      for (const selector of selectorList) {
        await page.waitForSelector(selector, { timeout: RENDER_SETTLE_TIMEOUT_MS }).catch(() => {});
      }

      const title = await page.title().catch(() => '');
      const visibleText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const failures: Array<{ type: 'text' | 'selector'; value: string; reason: string }> = [];

      for (const text of textNeedles) {
        if (!visibleTextContains(visibleText, text)) {
          failures.push({ type: 'text', value: text, reason: describeTextFailure(visibleText, text) });
        }
      }
      for (const selector of selectorList) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count < 1) failures.push({ type: 'selector', value: selector, reason: 'selector not found' });
      }

      await mkdir(dirname(rawScreenshotPath), { recursive: true });
      const buffer = await page.screenshot({ type: 'png', fullPage: params.full_page === true });
      await writeFile(rawScreenshotPath, buffer);

      return {
        success: failures.length === 0,
        data: {
          url: page.url(),
          title,
          viewport,
          screenshot_path: rawScreenshotPath,
          visible_text_preview: visibleText.slice(0, 1200),
          assertions: {
            total: (params.assertions?.text?.length || 0) + (params.assertions?.selectors?.length || 0),
            failures,
          },
        },
        ...(failures.length > 0 ? { error: `视觉验收失败：${failures.length} 个断言未通过。` } : {}),
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // 连接类失败追加确定性引导(实际监听端口 + 地址族探活),避免调用方误诊为"沙箱网络"。
      // 引导构造为 best-effort:任何异常都吞掉,绝不掩盖原始错误。
      let guidance = '';
      try {
        guidance = await buildConnectionGuidance(params.url, errMsg);
      } catch { /* best-effort */ }
      return {
        success: false,
        data: null,
        error: guidance
          ? `浏览器视觉验收失败: ${errMsg}\n诊断与建议: ${guidance}`
          : `浏览器视觉验收失败: ${errMsg}`,
      };
    }
  }
}

export default BrowserVisualVerifyTool;
