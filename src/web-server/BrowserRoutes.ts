import type { FastifyInstance } from 'fastify';
import type { AuthFn } from './types.js';
import { BrowserRuntime, type BrowserElementSelection, type DomTreeNode } from '../core/BrowserRuntime.js';

interface BrowserRoutesDeps {
  requireServerToken: AuthFn;
  browserRuntime: BrowserRuntime;
}

function sendError(reply: { status: (code: number) => { send: (body: unknown) => void } }, status: number, error: unknown): void {
  reply.status(status).send({ error: error instanceof Error ? error.message : String(error) });
}

export function registerBrowserRoutes(fastify: FastifyInstance, deps: BrowserRoutesDeps): void {
  const { requireServerToken, browserRuntime } = deps;

  fastify.get('/api/v1/browser/health', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { launch?: string | boolean } | undefined;
    const launch = query?.launch === true || query?.launch === 'true' || query?.launch === '1';
    return { data: await browserRuntime.checkHealth({ launch }) };
  });

  fastify.get('/api/v1/browser/sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: browserRuntime.listSessions() };
  });

  fastify.post('/api/v1/browser/sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { url?: string; viewport?: { width?: number; height?: number; deviceScaleFactor?: number } } | undefined;
    try {
      const session = await browserRuntime.createSession({
        url: body?.url,
        viewport: body?.viewport,
      });
      return { data: session };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.delete('/api/v1/browser/sessions/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const closed = await browserRuntime.closeSession(params.id);
    return { data: { closed } };
  });

  fastify.post('/api/v1/browser/sessions/:id/navigate', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { url?: string } | undefined;
    if (!body?.url) {
      reply.status(400).send({ error: 'url is required' });
      return;
    }
    try {
      const session = await browserRuntime.navigate(params.id, body.url);
      return { data: session };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.get('/api/v1/browser/sessions/:id/screenshot', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    try {
      const image = await browserRuntime.screenshot(params.id);
      reply.header('Cache-Control', 'no-store, max-age=0');
      reply.type('image/png');
      return reply.send(image);
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.post('/api/v1/browser/sessions/:id/inspect', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { x?: number; y?: number } | undefined;
    if (typeof body?.x !== 'number' || typeof body?.y !== 'number') {
      reply.status(400).send({ error: 'x and y are required' });
      return;
    }
    try {
      const selection = await browserRuntime.inspect(params.id, { x: body.x, y: body.y });
      return { data: selection };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.post('/api/v1/browser/sessions/:id/comment', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { selection?: BrowserElementSelection; comment?: string; intent?: string } | undefined;
    if (!body?.selection || body.selection.browserSessionId !== params.id) {
      reply.status(400).send({ error: 'selection is required for this browser session' });
      return;
    }
    if (!body.comment?.trim()) {
      reply.status(400).send({ error: 'comment is required' });
      return;
    }
    return { data: browserRuntime.buildComment({ selection: body.selection, comment: body.comment, intent: body.intent }) };
  });

  // ============================================================
  // v1.0.5 剑阁大改：真实交互端点
  // ============================================================

  fastify.post('/api/v1/browser/sessions/:id/click', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { x?: number; y?: number; selector?: string } | undefined;
    try {
      if (body?.selector) {
        return { data: await browserRuntime.clickSelector(params.id, body.selector) };
      }
      if (typeof body?.x !== 'number' || typeof body?.y !== 'number') {
        reply.status(400).send({ error: 'x and y (or selector) are required' });
        return;
      }
      return { data: await browserRuntime.click(params.id, { x: body.x, y: body.y }) };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.post('/api/v1/browser/sessions/:id/fill', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { selector?: string; value?: string } | undefined;
    if (!body?.selector || typeof body.value !== 'string') {
      reply.status(400).send({ error: 'selector and value are required' });
      return;
    }
    try {
      return { data: await browserRuntime.fill(params.id, body.selector, body.value) };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.post('/api/v1/browser/sessions/:id/scroll', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { x?: number; y?: number } | undefined;
    try {
      return { data: await browserRuntime.scroll(params.id, { x: body?.x ?? 0, y: body?.y ?? 0 }) };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.post('/api/v1/browser/sessions/:id/eval', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { script?: string } | undefined;
    if (!body?.script?.trim()) {
      reply.status(400).send({ error: 'script is required' });
      return;
    }
    try {
      return { data: await browserRuntime.evalJs(params.id, body.script) };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.get('/api/v1/browser/sessions/:id/html', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    try {
      return { data: await browserRuntime.getHtml(params.id) };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.put('/api/v1/browser/sessions/:id/html', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { html?: string } | undefined;
    if (!body?.html) {
      reply.status(400).send({ error: 'html is required' });
      return;
    }
    try {
      return { data: await browserRuntime.setHtml(params.id, body.html) };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.get('/api/v1/browser/sessions/:id/dom-tree', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const query = request.query as { depth?: string } | undefined;
    const maxDepth = Math.min(10, Math.max(1, Number(query?.depth ?? 5)));
    try {
      const tree: DomTreeNode = await browserRuntime.getDomTree(params.id, maxDepth);
      return { data: tree };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  fastify.post('/api/v1/browser/sessions/:id/patch-element', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as {
      selector?: string;
      html?: string;
      text?: string;
      style?: string;
      attr?: Record<string, string>;
      remove?: boolean;
    } | undefined;
    if (!body?.selector) {
      reply.status(400).send({ error: 'selector is required' });
      return;
    }
    try {
      return {
        data: await browserRuntime.patchElement(params.id, body.selector, {
          html: body.html,
          text: body.text,
          style: body.style,
          attr: body.attr,
          remove: body.remove,
        }),
      };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });
}
