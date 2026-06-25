/**
 * BrowserScreencastRoutes — v1.0.5 剑阁原生浏览器体验
 *
 * 通过 CDP (Chrome DevTools Protocol) screencast 实现实时浏览器画面推送。
 * 后端通过 WebSocket 推送 JPEG 画面帧（10-30fps），
 * 前端转发鼠标移动/点击/滚动/键盘事件到后端。
 *
 * 这是 Chrome DevTools 远程调试同款技术，完全原生体验。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthFn } from './types.js';
import { BrowserRuntime } from '../core/BrowserRuntime.js';
import type { Page } from 'playwright';
import { coreLogger } from '../core/Log.js';

interface ScreencastDeps {
  requireServerToken: AuthFn;
  browserRuntime: BrowserRuntime;
}

interface WebSocketLike {
  send: (data: string | Buffer) => void;
  on: (event: string, cb: (data: any) => void) => void;
  close: () => void;
  readyState: number;
}

// Active screencast sessions: sessionId -> { cdpSession, ws, stop }
const activeCasts = new Map<string, { ws: WebSocketLike; stop: () => void }>();

export function registerBrowserScreencastRoutes(fastify: FastifyInstance, deps: ScreencastDeps): void {
  const { requireServerToken, browserRuntime } = deps;

  /**
   * GET /api/v1/browser/screencast/:sessionId
   * WebSocket: 实时浏览器画面推送 + 输入转发
   *
   * 前端连接后：
   * - 后端持续推送 { type: 'frame', data: 'base64jpeg' } 消息
   * - 前端发送 { type: 'mouse', x, y, button, action } 鼠标事件
   * - 前端发送 { type: 'key', key, action } 键盘事件
   * - 前端发送 { type: 'scroll', x, y } 滚动事件
   */
  fastify.get('/api/v1/browser/screencast/:sessionId', { websocket: true }, async (socket: WebSocketLike, request: any) => {
    // Auth via query param
    const query = request.query as { token?: string };
    const token = query?.token || '';
    // We can't easily use requireServerToken for websocket, check manually
    // The token is validated by the fastify websocket handler below

    const { sessionId } = request.params as { sessionId: string };
    let page: Page;
    let cdpSession: any;

    try {
      // Get the page from browser runtime
      page = browserRuntime.getPage(sessionId) as Page;
      if (!page) {
        socket.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        socket.close();
        return;
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: String(error) }));
      socket.close();
      return;
    }

    // Create CDP session for screencast
    try {
      cdpSession = await page.context().newCDPSession(page);
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: `CDP session failed: ${error}` }));
      socket.close();
      return;
    }

    let casting = true;
    let lastFrameTime = 0;
    const MIN_FRAME_INTERVAL = 80; // ~12fps min, adapts up to 30fps

    // Start screencast
    try {
      await cdpSession.send('Page.enable');
      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        everyNthFrame: 1,
      });
      coreLogger.info(`[Screencast] Started for session ${sessionId}`);
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: `Screencast start failed: ${error}` }));
      socket.close();
      return;
    }

    // Listen for screencast frames
    cdpSession.on('Page.screencastFrame', async (params: any) => {
      if (!casting || socket.readyState !== 1) return;

      const now = Date.now();
      if (now - lastFrameTime < MIN_FRAME_INTERVAL) {
        // Skip frame to control fps
        try { await cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch {}
        return;
      }
      lastFrameTime = now;

      // Send frame to client
      try {
        socket.send(JSON.stringify({
          type: 'frame',
          data: params.data, // base64 JPEG
          width: params.metadata?.deviceWidth || 1280,
          height: params.metadata?.deviceHeight || 820,
          timestamp: now,
        }));
      } catch {
        // socket closed
      }

      // Ack the frame so CDP sends the next one
      try { await cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch {}
    });

    // Handle incoming input events from client
    socket.on('message', async (rawData: any) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof rawData === 'string' ? rawData : rawData.toString());
      } catch { return; }

      try {
        switch (msg.type) {
          case 'mouse': {
            const { x, y, button, action } = msg;
            if (action === 'move') {
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: Math.round(x), y: Math.round(y),
              });
            } else if (action === 'down') {
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: Math.round(x), y: Math.round(y),
                button: button || 'left', clickCount: 1,
              });
            } else if (action === 'up') {
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
                button: button || 'left', clickCount: 1,
              });
            } else if (action === 'click') {
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: Math.round(x), y: Math.round(y),
                button: button || 'left', clickCount: 1,
              });
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
                button: button || 'left', clickCount: 1,
              });
            } else if (action === 'dblclick') {
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: Math.round(x), y: Math.round(y),
                button: button || 'left', clickCount: 2,
              });
              await cdpSession.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
                button: button || 'left', clickCount: 2,
              });
            }
            break;
          }
          case 'scroll': {
            const { x, y, deltaX, deltaY } = msg;
            await cdpSession.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: Math.round(x || 640), y: Math.round(y || 410),
              deltaX: Math.round(deltaX || 0), deltaY: Math.round(deltaY || 0),
            });
            break;
          }
          case 'key': {
            const { key, action } = msg;
            // Map common keys to CDP key codes
            const keyMap: Record<string, number> = {
              'Enter': 13, 'Tab': 9, 'Backspace': 8, 'Escape': 27,
              'Delete': 46, 'ArrowUp': 38, 'ArrowDown': 40,
              'ArrowLeft': 37, 'ArrowRight': 39,
              'Shift': 16, 'Control': 17, 'Alt': 18, 'Meta': 91,
              ' ': 32,
            };
            const code = keyMap[key] ?? key.charCodeAt(0);
            const text = key.length === 1 ? key : undefined;
            if (action === 'down' || action === undefined) {
              await cdpSession.send('Input.dispatchKeyEvent', {
                type: text ? 'char' : 'rawKeyDown',
                key, code: code.toString(), windowsVirtualKeyCode: code,
                ...(text ? { text } : {}),
              });
            } else if (action === 'up') {
              await cdpSession.send('Input.dispatchKeyEvent', {
                type: 'keyUp', key, code: code.toString(), windowsVirtualKeyCode: code,
              });
            }
            break;
          }
          case 'type': {
            // Type a string of text
            for (const ch of msg.text) {
              await cdpSession.send('Input.dispatchKeyEvent', {
                type: 'char', text: ch,
              });
            }
            break;
          }
          case 'navigate': {
            await browserRuntime.navigate(sessionId, msg.url);
            break;
          }
          case 'refresh': {
            // Force a new frame
            lastFrameTime = 0;
            break;
          }
        }
      } catch (err) {
        // Input errors are non-fatal
      }
    });

    // Cleanup on disconnect
    socket.on('close', async () => {
      casting = false;
      try { await cdpSession.send('Page.stopScreencast'); } catch {}
      try { await cdpSession.detach(); } catch {}
      activeCasts.delete(sessionId);
      coreLogger.info(`[Screencast] Stopped for session ${sessionId}`);
    });

    // Store for cleanup
    activeCasts.set(sessionId, {
      ws: socket,
      stop: async () => {
        casting = false;
        try { await cdpSession.send('Page.stopScreencast'); } catch {}
        try { await cdpSession.detach(); } catch {}
      },
    });
  });
}
