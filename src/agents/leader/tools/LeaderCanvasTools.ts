/**
 * Leader Canvas 元工具：闭合选区回写闭环。
 *
 * - canvas_save_sourcemap：持久化 nodeId ↔ 源码锚点
 * - canvas_push_version：产物快照入栈 + SSE
 * - canvas_get_state：读 sourcemap / 版本 / 批注
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Workspace } from '../../../core/Workspace.js';
import { CanvasStore, toArtifactId } from '../../../core/canvas/CanvasStore.js';
import type { CanvasSourceMap, SourceAnchorKind, SourceProvenance } from '../../../contracts/types/Canvas.js';
import { fail } from '../LeaderToolFailure.js';
import type { TaskPlanningContext } from './LeaderTaskPlanningTools.js';

function resolveArtifactPath(ctx: TaskPlanningContext, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw fail('artifact_path 不能为空。');
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(ctx.leader.workspace, trimmed);
}

function openStore(ctx: TaskPlanningContext): CanvasStore {
  const sessionDir = Workspace.getSessionDir(ctx.leader.sessionId, ctx.leader.workspace);
  if (!sessionDir) {
    throw fail('无法解析会话目录，Canvas 状态不可用。');
  }
  return new CanvasStore({
    sessionDir,
    workspace: ctx.leader.workspace,
    onVersionPushed: (artifactId, version) => {
      try {
        ctx.leader.emitter.emit('canvas:version_pushed', {
          sessionId: ctx.leader.sessionId,
          artifactId,
          version,
          activeVersion: version,
          timestamp: Date.now(),
        });
      } catch {
        /* emit 失败不影响持久化 */
      }
    },
  });
}

function resolveArtifactId(
  ctx: TaskPlanningContext,
  args: Record<string, unknown>,
): { artifactId: string; artifactPath?: string } {
  const explicitId = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : '';
  const pathRaw = typeof args.artifact_path === 'string' ? args.artifact_path.trim() : '';
  if (explicitId) {
    return { artifactId: explicitId, artifactPath: pathRaw || undefined };
  }
  if (!pathRaw) {
    throw fail('必须提供 artifact_id 或 artifact_path。');
  }
  const absolute = resolveArtifactPath(ctx, pathRaw);
  return { artifactId: toArtifactId(absolute), artifactPath: absolute };
}

function parseProvenanceNode(entry: unknown, index: number): SourceProvenance {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw fail(`nodes[${index}] 必须是对象。`);
  }
  const rec = entry as Record<string, unknown>;
  // 允许扁平字段或嵌套 anchor
  const anchorObj = (rec.anchor && typeof rec.anchor === 'object' && !Array.isArray(rec.anchor))
    ? rec.anchor as Record<string, unknown>
    : rec;

  const kindRaw = String(anchorObj.kind ?? rec.kind ?? '').trim();
  const nodeId = String(
    rec.node_id ?? rec.nodeId ?? anchorObj.node_id ?? anchorObj.nodeId ?? '',
  ).trim();
  if (!nodeId) throw fail(`nodes[${index}] 需要 node_id。`);

  if (kindRaw === 'spec') {
    const specPath = String(anchorObj.spec_path ?? anchorObj.specPath ?? '').trim();
    if (!specPath) throw fail(`nodes[${index}] spec 锚点需要 spec_path。`);
    return {
      kind: 'spec',
      nodeId,
      specPath,
      ...(typeof (anchorObj.role ?? rec.role) === 'string'
        ? { role: String(anchorObj.role ?? rec.role) }
        : {}),
    };
  }

  if (kindRaw === 'script') {
    const srcFile = String(anchorObj.src_file ?? anchorObj.srcFile ?? '').trim();
    if (!srcFile) throw fail(`nodes[${index}] script 锚点需要 src_file。`);
    const rangeRaw = anchorObj.src_range ?? anchorObj.srcRange;
    let srcRange: [number, number] = [1, 1];
    if (Array.isArray(rangeRaw) && rangeRaw.length >= 2) {
      srcRange = [Number(rangeRaw[0]) || 1, Number(rangeRaw[1]) || 1];
    } else if (typeof rangeRaw === 'string' && rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-').map((x) => Number(x.trim()));
      srcRange = [a || 1, b || a || 1];
    }
    return {
      kind: 'script',
      nodeId,
      srcFile,
      srcRange,
      ...(typeof (anchorObj.role ?? rec.role) === 'string'
        ? { role: String(anchorObj.role ?? rec.role) }
        : {}),
    };
  }

  throw fail(`nodes[${index}] 的 kind 必须是 spec 或 script。`);
}

export function canvasSaveSourcemap(
  ctx: TaskPlanningContext,
  args: Record<string, unknown> = {},
): string {
  const pathRaw = typeof args.artifact_path === 'string' ? args.artifact_path.trim() : '';
  if (!pathRaw) throw fail('canvas_save_sourcemap 必须提供 artifact_path。');
  const absolute = resolveArtifactPath(ctx, pathRaw);
  const nodesRaw = args.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw fail('canvas_save_sourcemap 必须提供非空 nodes 数组。');
  }

  const nodes = nodesRaw.map((entry, i) => parseProvenanceNode(entry, i));
  const kindCounts = { spec: 0, script: 0 };
  for (const n of nodes) kindCounts[n.kind] += 1;
  const anchorKind: SourceAnchorKind = kindCounts.spec >= kindCounts.script ? 'spec' : 'script';

  const explicitId = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : '';
  const map: CanvasSourceMap = {
    artifactId: explicitId || toArtifactId(absolute),
    artifactPath: absolute,
    anchorKind,
    nodes,
    generatedAt: Date.now(),
    ...(typeof args.spec_file === 'string' ? { specFile: args.spec_file } : {}),
    ...(typeof args.generator_file === 'string' ? { generatorFile: args.generator_file } : {}),
    ...(typeof args.regenerate_command === 'string' ? { regenerateCommand: args.regenerate_command } : {}),
  };

  const store = openStore(ctx);
  const artifactId = store.saveSourceMap(map);
  return JSON.stringify({
    ok: true,
    artifactId,
    nodeCount: nodes.length,
    anchorKind,
    artifactPath: map.artifactPath,
  });
}

export function canvasPushVersion(
  ctx: TaskPlanningContext,
  args: Record<string, unknown> = {},
): string {
  const { artifactId, artifactPath } = resolveArtifactId(ctx, args);
  const snapshotRaw = typeof args.snapshot_path === 'string' ? args.snapshot_path.trim() : '';
  const snapshotPath = snapshotRaw
    ? (isAbsolute(snapshotRaw) ? snapshotRaw : resolve(ctx.leader.workspace, snapshotRaw))
    : artifactPath;

  if (snapshotPath && !existsSync(snapshotPath)) {
    throw fail(`快照文件不存在: ${snapshotPath}`);
  }

  const store = openStore(ctx);
  // 若尚无 sourcemap，先写最小占位，保证 getArtifactState 可读
  if (!store.getSourceMap(artifactId) && artifactPath) {
    store.saveSourceMap({
      artifactId,
      artifactPath,
      anchorKind: 'script',
      nodes: [],
      generatedAt: Date.now(),
    });
  }

  const version = store.pushVersion({
    artifactId,
    artifactSnapshotPath: snapshotPath,
    intent: typeof args.intent === 'string' ? args.intent : undefined,
    changedFiles: Array.isArray(args.changed_files)
      ? args.changed_files.filter((x): x is string => typeof x === 'string')
      : undefined,
  });

  return JSON.stringify({
    ok: true,
    artifactId,
    version: version.version,
    status: version.status,
    snapshotPath: version.snapshotPath,
    intent: version.intent,
  });
}

export function canvasGetState(
  ctx: TaskPlanningContext,
  args: Record<string, unknown> = {},
): string {
  const { artifactId } = resolveArtifactId(ctx, args);
  const store = openStore(ctx);
  const state = store.getArtifactState(artifactId);
  if (!state) {
    throw fail(`未找到 Canvas 状态: ${artifactId}。请先 canvas_save_sourcemap 或 canvas_push_version。`);
  }
  return JSON.stringify({
    ok: true,
    artifactId: state.artifactId,
    hasSourceMap: Boolean(state.sourceMap),
    activeVersion: state.activeVersion,
    versionCount: state.versions.length,
    commentCount: state.comments.length,
    sourceMap: state.sourceMap,
    versions: state.versions,
    comments: state.comments,
  });
}
