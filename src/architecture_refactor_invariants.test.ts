import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseManager } from './core/Database.js';
import {
  buildContractPackFromSnapshot,
  getProjectContractPackPath,
  graphNodeToContractPackEntry,
  persistContractPack,
} from './core/ContractPack.js';
import { BlackboardGraph } from './core/blackboard/BlackboardGraph.js';
import { GraphStore } from './core/blackboard/GraphStore.js';
import type { GraphNode } from './core/blackboard/types.js';
import { clearProjectContractsCache, loadProjectContractEntries } from './core/ProjectContracts.js';

function contractNode(input: Partial<GraphNode> & { id: string; content: string; tags: string[]; createdAt: number }): GraphNode {
  return {
    kind: 'contract',
    sessionId: 's1',
    title: input.title ?? 'Contract',
    createdBy: input.createdBy ?? 'test',
    ...input,
  };
}

test('MOA contract pack prefers authoritative contract over newer template', () => {
  const authoritative = contractNode({
    id: 'real',
    content: 'REAL CONTRACT CONTENT',
    tags: ['contract:api-surface', 'provenance:declared'],
    createdAt: 100,
  });
  const newerTemplate = contractNode({
    id: 'template',
    content: 'TEMPLATE STUB',
    tags: ['contract:api-surface', 'provenance:template'],
    createdAt: 200,
  });

  const pack = buildContractPackFromSnapshot(
    { nodes: [authoritative, newerTemplate], edges: [] },
    { sessionId: 's1', generatedAt: 1 },
  );

  assert.equal(pack.entries.length, 1);
  assert.equal(pack.entries[0].nodeId, 'real');
  assert.equal(pack.entries[0].content, 'REAL CONTRACT CONTENT');
});

test('MOA contract pack treats legacy provenance:worker stub as lower authority than declared contract', () => {
  const authoritative = contractNode({
    id: 'real',
    content: 'REAL CONTRACT CONTENT',
    tags: ['contract:data-layer', 'provenance:declared'],
    createdAt: 100,
  });
  const newerWorkerStub = contractNode({
    id: 'worker-stub',
    content: 'Task T-1 contract compliance report',
    tags: ['contract:data-layer', 'provenance:worker'],
    createdAt: 300,
  });

  const pack = buildContractPackFromSnapshot(
    { nodes: [authoritative, newerWorkerStub], edges: [] },
    { sessionId: 's1', generatedAt: 1 },
  );

  assert.equal(pack.entries.length, 1);
  assert.equal(pack.entries[0].nodeId, 'real');
  assert.equal(pack.entries[0].content, 'REAL CONTRACT CONTENT');
});

test('graphNodeToContractPackEntry loads disk content for template/worker stubs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lx-contract-pack-'));
  try {
    const contractsDir = join(dir, 'contracts');
    mkdirSync(contractsDir, { recursive: true });
    writeFileSync(join(contractsDir, 'web-shell.json'), JSON.stringify({
      surface: 'web-shell',
      title: 'Web Shell',
      content: 'REAL DISK CONTRACT',
      tags: ['contract:web-shell', 'provenance:declared'],
      sha256: 'placeholder',
    }), 'utf8');

    const workerStub = contractNode({
      id: 'worker-stub',
      title: 'Compliance',
      content: 'Task T-9 contract compliance report',
      tags: ['contract:web-shell', 'provenance:worker'],
      createdAt: 500,
    });

    const entry = graphNodeToContractPackEntry(workerStub, contractsDir);
    assert.equal(entry.content, 'REAL DISK CONTRACT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BlackboardGraph.addContract template does not supersede authoritative contract and getActiveContract returns authoritative node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lx-blackboard-'));
  const db = new DatabaseManager(join(dir, 'test.sqlite'));
  try {
    db.init();
    const graph = new BlackboardGraph(new GraphStore(db.getDb()));

    const real = graph.addContract({
      sessionId: 's1',
      title: 'Real API Contract',
      content: 'REAL CONTRACT CONTENT',
      tags: ['contract:api-surface', 'provenance:declared'],
      createdBy: 'test',
    });
    const template = graph.addContract({
      sessionId: 's1',
      title: 'Template API Contract',
      content: 'TEMPLATE STUB',
      tags: ['contract:api-surface', 'provenance:template'],
      createdBy: 'test',
    });

    const nodes = graph.getNodesByTag('s1', 'contract:api-surface');
    const persistedReal = nodes.find((node) => node.id === real.id);
    const persistedTemplate = nodes.find((node) => node.id === template.id);
    assert.ok(persistedReal);
    assert.ok(persistedTemplate);
    assert.equal(persistedReal.supersededBy, undefined);
    assert.equal(persistedTemplate.supersededBy, undefined);
    assert.equal(graph.getActiveContract('s1', 'api-surface')?.id, real.id);
    assert.equal(graph.getContractEvidence('s1', 'api-surface')?.id, real.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BlackboardGraph.getContractEvidence accepts tagged and semantic fact contract evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lx-blackboard-evidence-'));
  const db = new DatabaseManager(join(dir, 'test.sqlite'));
  try {
    db.init();
    const graph = new BlackboardGraph(new GraphStore(db.getDb()));

    const tagged = graph.addFact({
      sessionId: 's1',
      title: 'API fact contract',
      content: '字段、错误码、验收口径已确认',
      tags: ['contract:fact-surface'],
      createdBy: 'test',
      confidence: 'confirmed',
    });
    assert.equal(graph.getActiveContract('s1', 'fact-surface'), null);
    assert.equal(graph.getContractEvidence('s1', 'fact-surface')?.id, tagged.id);

    const semantic = graph.addFact({
      sessionId: 's1',
      title: 'semantic-surface 契约',
      content: 'Contract fields and status flow are ready for semantic-surface.',
      tags: [],
      createdBy: 'test',
      confidence: 'confirmed',
    });
    assert.equal(graph.getContractEvidence('s1', 'semantic-surface')?.id, semantic.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project contract pack merge preserves contracts from other sessions', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lx-project-contracts-'));
  try {
    const packA = buildContractPackFromSnapshot(
      {
        nodes: [contractNode({
          id: 'contract-a',
          content: 'CONTRACT A',
          tags: ['contract:surface-a', 'provenance:declared'],
          createdAt: 100,
        })],
        edges: [],
      },
      { sessionId: 's-a', workspace, generatedAt: 1 },
    );
    persistContractPack(packA, workspace);

    const packB = buildContractPackFromSnapshot(
      {
        nodes: [contractNode({
          id: 'contract-b',
          content: 'CONTRACT B',
          tags: ['contract:surface-b', 'provenance:declared'],
          createdAt: 200,
        })],
        edges: [],
      },
      { sessionId: 's-b', workspace, generatedAt: 2 },
    );
    persistContractPack(packB, workspace);

    const projectPack = JSON.parse(readFileSync(getProjectContractPackPath(workspace), 'utf8')) as { entries: Array<{ surface: string; content: string }> };
    assert.deepEqual(
      projectPack.entries.map((entry) => [entry.surface, entry.content]),
      [['surface-a', 'CONTRACT A'], ['surface-b', 'CONTRACT B']],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('project contract loader invalidates cache when project pack is atomically refreshed inside TTL', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lx-project-contract-loader-'));
  try {
    clearProjectContractsCache();
    const packA = buildContractPackFromSnapshot(
      {
        nodes: [contractNode({
          id: 'loader-contract-a',
          content: 'LOADER CONTRACT A',
          tags: ['contract:loader-surface-a', 'provenance:declared'],
          createdAt: 100,
        })],
        edges: [],
      },
      { sessionId: 'loader-a', workspace, generatedAt: 1 },
    );
    persistContractPack(packA, workspace);
    assert.deepEqual(loadProjectContractEntries(workspace).map((entry) => entry.surface), ['loader-surface-a']);

    const packB = buildContractPackFromSnapshot(
      {
        nodes: [contractNode({
          id: 'loader-contract-b',
          content: 'LOADER CONTRACT B',
          tags: ['contract:loader-surface-b', 'provenance:declared'],
          createdAt: 200,
        })],
        edges: [],
      },
      { sessionId: 'loader-b', workspace, generatedAt: 2 },
    );
    persistContractPack(packB, workspace);

    assert.deepEqual(
      loadProjectContractEntries(workspace).map((entry) => entry.surface),
      ['loader-surface-a', 'loader-surface-b'],
    );
  } finally {
    clearProjectContractsCache();
    rmSync(workspace, { recursive: true, force: true });
  }
});
