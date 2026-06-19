/**
 * Shared types for web-server route modules.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export type AuthFn = (request: FastifyRequest, reply: FastifyReply) => boolean;
