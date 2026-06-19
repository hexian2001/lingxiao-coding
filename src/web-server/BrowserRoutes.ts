import type { FastifyInstance } from 'fastify';
import type { AuthFn } from './types.js';
import { BrowserRuntime, type BrowserElementSelection } from '../core/BrowserRuntime.js';

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
}
