/**
 * ContractRoutes — 契约只读 Web 路由(可视化)。
 *
 * 从项目级 `.lingxiao/contracts/` 加载(`loadProjectContractEntries`),跨会话复用、契约变更即 persist
 * 到项目级,故基本实时。纯只读(GET),无 POST/PUT/DELETE——改契约走正规流程(leader 派 architect /
 * 改源码),避免人类误改 allowedScope 锁死 agent。
 *
 * projectPath 由 query 传入(与 WikiRoutes 一致),决定从哪个 workspace 的 .lingxiao/contracts/ 读。
 */
import type { FastifyInstance } from 'fastify';
import type { AuthFn } from './types.js';
import { loadProjectContractEntries } from '../core/ProjectContracts.js';

export function registerContractRoutes(fastify: FastifyInstance, deps: { requireServerToken: AuthFn }): void {
  const { requireServerToken } = deps;

  /** 契约列表(跨会话,项目级)。 */
  fastify.get('/api/v1/contracts', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath } = request.query as { projectPath?: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    const entries = loadProjectContractEntries(projectPath);
    return { projectPath, count: entries.length, contracts: entries };
  });

  /** 单契约详情(by surface)。 */
  fastify.get('/api/v1/contracts/:surface', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath } = request.query as { projectPath?: string };
    const { surface } = request.params as { surface: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    const entry = loadProjectContractEntries(projectPath).find((e) => e.surface === surface);
    if (!entry) {
      reply.status(404);
      return { error: `contract surface '${surface}' not found` };
    }
    return { contract: entry };
  });

  /** 单契约版本信息。当前仅 active 最新版;历史版本链(supersede diff)需读 DB graph_nodes,后续接入。 */
  fastify.get('/api/v1/contracts/:surface/versions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath } = request.query as { projectPath?: string };
    const { surface } = request.params as { surface: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    const active = loadProjectContractEntries(projectPath).filter((e) => e.surface === surface);
    return {
      surface,
      versions: active,
      note: active.length <= 1 ? '当前仅 active 版本;历史版本 diff 待接入 supersede 链' : undefined,
    };
  });
}
