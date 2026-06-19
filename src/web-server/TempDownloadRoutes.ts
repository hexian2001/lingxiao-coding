import type { FastifyInstance } from 'fastify';
import { tempDownloadRegistry } from '../core/TempDownloadRegistry.js';

export function registerTempDownloadRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/v1/downloads/temp/:token', async (request, reply) => {
    const params = request.params as { token?: string };
    const token = String(params.token || '').trim();
    if (!token) {
      reply.status(400);
      return { error: 'token is required' };
    }
    tempDownloadRegistry.send(token, reply);
  });
}
