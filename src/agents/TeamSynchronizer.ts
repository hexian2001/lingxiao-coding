/**
 * TeamSynchronizer - Synchronizes team agents after parallel task execution
 *
 * v2 重构（2026-05）：
 * - 旧实现基于 summary keyword 匹配 ("pass" vs "fail") 判断 logic_conflict — 误报严重，
 *   把语义相近的 "did not pass" / "failed" 也算成冲突。
 * - v2 改为结构化输入：
 *   - file conflict：用 task.write_scope 重叠（同一文件被多个 agent 写） — 仍保留 artifact fallback。
 *   - logic conflict：用 BlackboardGraph 中带 contradicts edge 的 fact 节点判定，无 graph 时退化到 artifact-only。
 *   - orchestration conflict：把 `orchestration:verdict` Fact 中 `verdict:fail` 节点一并报为高优先冲突，提示 leader 修复。
 * - schema 不变（ConflictReport / TeamSummary 的字段保持向后兼容）。
 */

interface WorkNote {
  id: string;
  agentId: string;
  taskId: string;
  timestamp: number;
  phase: string;
  summary: string;
  details?: string;
  blockers?: string[];
  artifacts?: string[];
  /** 可选：从 TaskBoard.write_scope 拷贝过来的写入路径前缀，比 artifacts 更权威 */
  writeScope?: string[];
}

interface ConflictReport {
  id: string;
  type: 'code_conflict' | 'logic_conflict' | 'resource_conflict';
  severity: 'high' | 'medium' | 'low';
  description: string;
  agents: string[];
  affectedFiles?: string[];
  suggestion?: string;
  /**
   * 收敛路径（2026-05 新增）：
   *   - 'peer_negotiate'：相关成员先 P2P 协商收敛（如拆分写入路径），谈不拢再升级 Leader。
   *   - 'leader_arbitrate'：仲裁权归 Leader（orchestration verdict 失败 / 黑板逻辑矛盾）。
   * 区别于旧实现的「一律交 Leader」，让文件/资源类冲突先走成员协商，减少 Leader 打断。
   */
  resolution?: 'peer_negotiate' | 'leader_arbitrate';
}

interface TeamSummary {
  taskId: string;
  agents: string[];
  totalNotes: number;
  summary: string;
  conflicts: ConflictReport[];
  artifacts: string[];
  completedAt: number;
}

interface WorkNoteManager {
  getAllNotes(sessionId: string): Promise<WorkNote[]>;
}

/** Minimal blackboard graph view — 避免 import 循环依赖，只声明用到的方法 */
interface ConflictGraphView {
  getSnapshot(sessionId: string): {
    nodes: Array<{
      id: string;
      kind: string;
      tags: string[];
      title: string;
      content: string;
      createdBy?: string;
    }>;
    edges: Array<{ fromNodeId: string; toNodeId: string; edgeType: string }>;
  };
}

export class TeamSynchronizer {
  private workNoteManager: WorkNoteManager;
  private sessionId: string;
  /** 可选黑板图 — 用于结构化冲突检测 */
  private graph?: ConflictGraphView;

  constructor(workNoteManager: WorkNoteManager, sessionId: string, graph?: ConflictGraphView) {
    this.workNoteManager = workNoteManager;
    this.sessionId = sessionId;
    this.graph = graph;
  }

  setGraph(graph: ConflictGraphView | undefined): void {
    this.graph = graph;
  }

  async collectWorkNotes(taskId: string): Promise<WorkNote[]> {
    const allNotes = await this.workNoteManager.getAllNotes(this.sessionId);
    return allNotes.filter((note) => note.taskId === taskId);
  }

  mergeWorkNotes(notes: WorkNote[]): string {
    if (notes.length === 0) return 'No work notes available';

    const agentGroups: Record<string, WorkNote[]> = {};
    for (const note of notes) {
      if (!agentGroups[note.agentId]) {
        agentGroups[note.agentId] = [];
      }
      agentGroups[note.agentId].push(note);
    }

    const summary: string[] = [];
    summary.push('## 团队工作摘要\n');

    for (const [agentId, agentNotes] of Object.entries(agentGroups)) {
      summary.push(`### Agent: ${agentId}`);
      summary.push(`工作笔记 (${agentNotes.length} 条):\n`);

      for (const note of agentNotes) {
        summary.push(`- [${note.phase}] ${note.summary}`);
        if (note.details) {
          summary.push(`  ${note.details}`);
        }
        if (note.blockers && note.blockers.length > 0) {
          summary.push(`  阻塞: ${note.blockers.join(', ')}`);
        }
      }
      summary.push('');
    }

    return summary.join('\n');
  }

  /**
   * Detect conflicts between different agents' outputs.
   *
   * 三个维度（按严重度从高到低）：
   * 1. orchestration verdict fail — 黑板上 `orchestration:verdict` Fact 标记的失败节点
   * 2. write scope / artifact 重叠 — 同一文件被多个 agent 写
   * 3. blackboard contradicts 边 — 不同 agent 写入的 fact 被显式标为相互矛盾
   */
  detectConflicts(notes: WorkNote[]): ConflictReport[] {
    const conflicts: ConflictReport[] = [];

    // ─── 1. orchestration:verdict 失败节点（如果黑板可用） ───
    if (this.graph) {
      try {
        const snap = this.graph.getSnapshot(this.sessionId);
        const verdictFail = snap.nodes.filter(
          n => n.kind === 'fact' && n.tags.includes('orchestration:verdict') && n.tags.includes('verdict:fail'),
        );
        for (const fact of verdictFail) {
          // step 已被同一 step 的 verdict:pass supersede 时不再报
          const sameStepTag = fact.tags.find(t => t.startsWith('orchestration:node:'));
          const passed = sameStepTag
            ? snap.nodes.some(n => n.kind === 'fact'
                && n.tags.includes('orchestration:verdict')
                && n.tags.includes('verdict:pass')
                && n.tags.includes(sameStepTag))
            : false;
          if (passed) continue;
          conflicts.push({
            id: `orchestration_${fact.id}`,
            type: 'logic_conflict',
            severity: 'high',
            description: `Orchestration 节点失败：${fact.title}`,
            agents: fact.createdBy ? [fact.createdBy] : [],
            suggestion: 'Leader 应基于黑板 verdict 决定 repair 策略',
            resolution: 'leader_arbitrate',
          });
        }
      } catch {
        // 容忍：图操作失败不应阻断同步
      }
    }

    // ─── 2. write scope / artifact 重叠 ───
    const fileToAgents: Record<string, Set<string>> = {};
    for (const note of notes) {
      const files: string[] = [];
      if (note.writeScope && note.writeScope.length > 0) {
        files.push(...note.writeScope);
      }
      if (note.artifacts && note.artifacts.length > 0) {
        files.push(...note.artifacts);
      }
      for (const file of files) {
        if (!fileToAgents[file]) fileToAgents[file] = new Set();
        fileToAgents[file].add(note.agentId);
      }
    }
    for (const [file, agentSet] of Object.entries(fileToAgents)) {
      if (agentSet.size > 1) {
        const agents = Array.from(agentSet);
        conflicts.push({
          id: `file_${file}_${Date.now()}`,
          type: 'code_conflict',
          severity: 'high',
          description: `文件 ${file} 被多个 Agent 修改 (${agents.join(', ')})`,
          agents,
          affectedFiles: [file],
          suggestion: `相关成员先用 team_message 协商谁负责 ${file}（拆分写入路径或串行化）；谈不拢再升级 Leader`,
          resolution: 'peer_negotiate',
        });
      }
    }

    // ─── 3. blackboard contradicts 边 ───
    if (this.graph) {
      try {
        const snap = this.graph.getSnapshot(this.sessionId);
        const contradictsEdges = snap.edges.filter(e => e.edgeType === 'contradicts');
        const nodeById = new Map(snap.nodes.map(n => [n.id, n]));
        const seen = new Set<string>();
        for (const edge of contradictsEdges) {
          const a = nodeById.get(edge.fromNodeId);
          const b = nodeById.get(edge.toNodeId);
          if (!a || !b) continue;
          const key = [a.id, b.id].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const agents: string[] = [];
          if (a.createdBy) agents.push(a.createdBy);
          if (b.createdBy && b.createdBy !== a.createdBy) agents.push(b.createdBy);
          conflicts.push({
            id: `contradicts_${a.id}_${b.id}`,
            type: 'logic_conflict',
            severity: 'medium',
            description: `黑板矛盾：${a.title} ↔ ${b.title}`,
            agents,
            suggestion: '触发 Reason 任务收敛矛盾',
            resolution: 'leader_arbitrate',
          });
        }
      } catch {
        // tolerate
      }
    }

    return conflicts;
  }

  generateTeamSummary(taskId: string, notes: WorkNote[]): TeamSummary {
    const mergedNotes = this.mergeWorkNotes(notes);
    const conflicts = this.detectConflicts(notes);
    const artifacts = Array.from(new Set(notes.flatMap((n) => n.artifacts || [])));

    return {
      taskId,
      agents: Array.from(new Set(notes.map((n) => n.agentId))),
      totalNotes: notes.length,
      summary: mergedNotes,
      conflicts,
      artifacts,
      completedAt: Date.now(),
    };
  }

  /**
   * 把 resolution='peer_negotiate' 的冲突转换成「成员间协商指令」。
   *
   * 每个冲突生成 N 条 P2P 消息（涉及的每个成员各收到一条，告知和谁、就什么协商），
   * urgency 一律 normal —— 进 mailbox 兜底、由对方下一轮 team_inbox 自然消费，
   * 不打断当前推理。caller（LeaderSupervisionCoordinator）负责实际投递 + tracker 登记。
   *
   * 返回空数组表示无需协商（全是 leader_arbitrate 类冲突）。
   */
  buildPeerNegotiations(conflicts: ConflictReport[]): Array<{
    from: string;
    to: string;
    requestId: string;
    content: string;
    conflictId: string;
    taskId?: string;
    affectedFiles?: string[];
    participants: string[];
  }> {
    const out: Array<{ from: string; to: string; requestId: string; content: string; conflictId: string; taskId?: string; affectedFiles?: string[]; participants: string[] }> = [];
    for (const c of conflicts) {
      if (c.resolution !== 'peer_negotiate') continue;
      const members = Array.from(new Set(c.agents)).filter(Boolean);
      if (members.length < 2) continue; // 协商至少需要两方
      const file = c.affectedFiles?.[0];
      const requestId = `conflict:${c.id}`;
      for (const me of members) {
        const peers = members.filter(m => m !== me);
        const content = [
          `[协商请求] 检测到协作冲突，请与 ${peers.map(p => `@${p}`).join('、')} 直接协商收敛：`,
          c.description,
          file
            ? `请协商谁负责 ${file}（拆分写入路径或串行化）。达成一致后回给原协商对象：team_message(target_type='member', target='${peers[0]}', content='已协商完成：...', intent='coordination_result', type='ack', request_id='${requestId}', verdict='PASS', next_action='...')；阻塞则 verdict='BLOCKED' 并升级 Leader。`
            : `请协商后回给原协商对象：team_message(target_type='member', target='${peers[0]}', content='已协商完成：...', intent='coordination_result', type='ack', request_id='${requestId}', verdict='PASS', next_action='...')；阻塞则 verdict='BLOCKED' 并升级 Leader。`,
        ].join('\n');
        out.push({
          from: me,
          to: peers[0],
          requestId,
          content,
          conflictId: c.id,
          taskId: c.id.startsWith('file_') ? undefined : undefined,
          affectedFiles: c.affectedFiles,
          participants: members,
        });
      }
    }
    return out;
  }

  formatForNextStage(summary: TeamSummary): string {
    const lines: string[] = [];

    lines.push('## 前序团队工作摘要\n');
    lines.push(`任务: ${summary.taskId}`);
    lines.push(`参与 Agent: ${summary.agents.join(', ')}`);
    lines.push(`工作笔记: ${summary.totalNotes} 条\n`);

    if (summary.conflicts.length > 0) {
      lines.push(`⚠️ 检测到 ${summary.conflicts.length} 个冲突:\n`);
      for (const conflict of summary.conflicts) {
        lines.push(`- [${conflict.severity}] ${conflict.description}`);
        if (conflict.suggestion) {
          lines.push(`  建议: ${conflict.suggestion}`);
        }
      }
      lines.push('');
    }

    lines.push('### 产出的文件');
    for (const artifact of summary.artifacts) {
      lines.push(`- ${artifact}`);
    }
    lines.push('');

    lines.push(summary.summary);

    return lines.join('\n');
  }
}

export default TeamSynchronizer;
