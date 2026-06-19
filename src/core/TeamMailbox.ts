/**
 * TeamMailbox — Shared inter-team / intra-team communication infrastructure
 *
 * Two singletons:
 *   - TeamMemberRegistry: name → member directory, scoped by sessionId.
 *     主键为 (sessionId, name)；不再生成内部 member id，所有外部接口直接用 agent name。
 *   - TeamMailbox: team definitions + message store
 *     fromMember / toMember / leader / members 字段全部存放 agent name；
 *     不再有 member_<hash>_<N> 这层中间编码。
 *
 * Both can be backed by a DatabaseManager via attachDatabase() to survive
 * process restart. When no db is attached they remain in-memory.
 *
 * sessionId is propagated through every record so multiple sessions can share
 * the singletons without leaking state to each other.
 *
 * Read tracking is per-recipient (member name): a broadcast remains "unread"
 * for member B even after member A has called markRead. P2P messages have a
 * single recipient and read-state collapses to one entry in readBy.
 */

import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import type { CoreTeamDeliveryStatus } from './StateSemantics.js';
import { normalizeTeamDeliveryStatus } from './StateSemantics.js';
import type { CollaborationMetadata } from './TeamProtocol.js';

export type TeamUrgency = 'normal' | 'urgent';

/**
 * Team 消息类型：
 *   - 'normal'：普通通知（默认）
 *   - 'ack'：契约/任务 ack 回执，必须配合 requestId（推荐 `<surface>@v<N>`）
 *   - 'request'：协议请求，期望对方回 ack（同一 requestId）
 *
 * 历史背景：旧版只有 fromMember/toMember/content/urgency 四元组，没有"我已消费契约 X@v2"
 * 的可解析回执。审计 2026-05-28 缺位：项目启动跨栈契约对齐 → 实现完成 → 无 ack 机制
 * 让 architect/leader 知道契约已落地。新增 kind+requestId 后不破坏旧调用，仅作为额外信号。
 */
export type TeamMessageKind = 'normal' | 'ack' | 'request';

export interface TeamMember {
  /** Agent name — also the canonical primary key inside (sessionId, name). */
  name: string;
  team: string;
  role: 'leader' | 'member';
  workspace: string;
  sessionId: string;
  registeredAt: number;
}

export interface TeamDefinition {
  name: string;
  description?: string;
  leader: string;       // member name
  members: string[];    // member names (excluding leader)
  workspace: string;
  sessionId: string;
  createdAt: number;
  active: boolean;
}

export type TeamDeliveryStatus = CoreTeamDeliveryStatus;

export interface TeamDeliveryRecipientState {
  status: TeamDeliveryStatus;
  updatedAt: number;
  reason?: string;
}

export interface TeamDeliveryState {
  recipients: Record<string, TeamDeliveryRecipientState>;
}

export type TeamMessageMetadata = Partial<CollaborationMetadata> & Record<string, unknown> & {
  delivery?: TeamDeliveryState;
};

export interface TeamMessage {
  id: string;
  fromTeam: string;
  fromMember?: string;     // member name
  toTeam: string;
  toMember?: string;       // member name; present → P2P; absent → broadcast
  content: string;
  urgency: TeamUrgency;
  /** 消息类型；缺省按 'normal' 处理（旧消息兼容） */
  kind?: TeamMessageKind;
  /** ack/request 配对用的 request id（推荐 `<surface>@v<N>` 形态） */
  requestId?: string;
  metadata?: TeamMessageMetadata;
  sessionId: string;
  timestamp: number;
  readBy: Set<string>;     // member names who have read this message
}

export interface SendMessageOpts {
  fromTeam: string;
  toTeam: string;
  fromMember?: string;
  toMember?: string;
  content: string;
  urgency?: TeamUrgency;
  kind?: TeamMessageKind;
  requestId?: string;
  metadata?: TeamMessageMetadata;
  sessionId: string;
}

const MAX_MESSAGES = 10000;
const TRIM_TARGET = 5000;
/** 单个 session 配额：避免 A 大量刷消息挤掉 B 的早期记录 */
const PER_SESSION_QUOTA = 1000;

function requireSessionId(sessionId: string | undefined, operation: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error(`${operation} 必须指定 sessionId（防多 session 串台）`);
  }
  return sessionId;
}

function requireStoredSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) {
    throw new Error('TeamMailbox row missing session_id');
  }
  return sessionId;
}

function memberKey(sessionId: string, name: string): string {
  return `${sessionId}::${name}`;
}

function teamKey(sessionId: string, name: string): string {
  return `${sessionId}::${name}`;
}

// ═══════════════════════════════════════════════════════════════
// TeamMemberRegistry — (sessionId, name) 直接做主键
// ═══════════════════════════════════════════════════════════════

export class TeamMemberRegistry {
  /** key = `${sessionId}::${name}` → TeamMember */
  private members = new Map<string, TeamMember>();
  private db: DatabaseManager | null = null;

  attachDatabase(db: DatabaseManager): void {
    this.db = db;
    this.rebuildFromDb();
  }

  private rebuildFromDb(): void {
    if (!this.db) return;
    const raw = this.db.getDb();
    const rows = raw.prepare(
      `SELECT name, team, role, workspace, session_id, registered_at FROM team_members`,
    ).all() as Array<{
      name: string; team: string; role: string;
      workspace: string; session_id: string; registered_at: number;
    }>;
    this.members.clear();
    for (const r of rows) {
      const member: TeamMember = {
        name: r.name,
        team: r.team,
        role: (r.role as 'leader' | 'member'),
        workspace: r.workspace,
        sessionId: requireStoredSessionId(r.session_id),
        registeredAt: r.registered_at,
      };
      this.members.set(memberKey(member.sessionId, member.name), member);
    }
  }

  /**
   * 注册或覆盖一个成员。返回 TeamMember 记录。
   * 同 (sessionId, name) 已存在时直接覆盖。
   */
  register(member: Omit<TeamMember, 'registeredAt'>): TeamMember {
    const sessionId = requireSessionId(member.sessionId, 'TeamMemberRegistry.register');
    const record: TeamMember = {
      ...member,
      sessionId,
      registeredAt: Date.now(),
    };
    if (this.db) {
      this.db.getDb().prepare(
        `INSERT OR REPLACE INTO team_members (name, team, role, workspace, session_id, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(record.name, record.team, record.role, record.workspace,
            record.sessionId, record.registeredAt);
    }
    this.members.set(memberKey(record.sessionId, record.name), record);
    return record;
  }

  unregister(name: string, sessionId: string): boolean {
    const requiredSessionId = requireSessionId(sessionId, 'TeamMemberRegistry.unregister');
    const key = memberKey(requiredSessionId, name);
    const memoryHadMember = this.members.has(key);
    let dbDeleted = false;
    if (this.db) {
      const result = this.db.getDb().prepare(
        `DELETE FROM team_members WHERE name = ? AND session_id = ?`,
      ).run(name, requiredSessionId);
      dbDeleted = Number(result.changes) > 0;
    }
    this.members.delete(key);
    return memoryHadMember || dbDeleted;
  }

  /**
   * 单条直查 DB（跨进程安全）。
   * 返回 { ok: true, member } 表示 DB 查询成功；member 为命中的成员或 undefined（未找到）。
   * 返回 { ok: false } 表示未挂 DB；调用方可使用内存路径。
   */
  private fetchFromDb(
    name: string,
    sessionId: string,
  ): { ok: true; member: TeamMember | undefined } | { ok: false } {
    if (!this.db) return { ok: false };
    const raw = this.db.getDb();
    const row = raw.prepare(
      `SELECT name, team, role, workspace, session_id, registered_at
       FROM team_members
       WHERE name = ? AND session_id = ?`,
    ).get(name, sessionId) as {
      name: string; team: string; role: string;
      workspace: string; session_id: string; registered_at: number;
    } | undefined;
    if (!row) return { ok: true, member: undefined };
    const member: TeamMember = {
      name: row.name,
      team: row.team,
      role: row.role as 'leader' | 'member',
      workspace: row.workspace,
      sessionId: requireStoredSessionId(row.session_id),
      registeredAt: row.registered_at,
    };
    this.members.set(memberKey(member.sessionId, member.name), member);
    return { ok: true, member };
  }

  getByName(name: string, sessionId: string): TeamMember | undefined {
    const requiredSessionId = requireSessionId(sessionId, 'TeamMemberRegistry.getByName');
    // DB 是真源 — 不依赖陈旧的 in-memory 缓存。
    const result = this.fetchFromDb(name, requiredSessionId);
    if (result.ok) {
      if (result.member) return result.member;
      // DB 查询成功但没命中 → 清掉可能的脏缓存，避免误判
      this.members.delete(memberKey(requiredSessionId, name));
      return undefined;
    }
    // 未挂 DB — 退回内存
    return this.members.get(memberKey(requiredSessionId, name));
  }

  getByTeam(teamName: string, sessionId: string): TeamMember[] {
    const requiredSessionId = requireSessionId(sessionId, 'TeamMemberRegistry.getByTeam');
    if (this.db) {
      const raw = this.db.getDb();
      const rows = raw.prepare(
        `SELECT name, team, role, workspace, session_id, registered_at
         FROM team_members
         WHERE team = ? AND session_id = ?`,
      ).all(teamName, requiredSessionId) as Array<{
            name: string; team: string; role: string;
            workspace: string; session_id: string; registered_at: number;
          }>;
      return rows.map(r => ({
        name: r.name,
        team: r.team,
        role: r.role as 'leader' | 'member',
        workspace: r.workspace,
        sessionId: requireStoredSessionId(r.session_id),
        registeredAt: r.registered_at,
      }));
    }
    const result: TeamMember[] = [];
    for (const member of this.members.values()) {
      if (member.team !== teamName) continue;
      if (member.sessionId !== requiredSessionId) continue;
      result.push(member);
    }
    return result;
  }

  getAll(): TeamMember[] {
    return Array.from(this.members.values());
  }

  /** Test helper: drop everything in memory and DB. */
  resetForTesting(): void {
    this.members.clear();
    if (this.db && !this.db.isClosed()) {
      this.db.getDb().prepare(`DELETE FROM team_members`).run();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TeamMailbox
// ═══════════════════════════════════════════════════════════════

function parseJsonValue(json: string, context: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`[TeamMailbox] Invalid JSON in ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseStringArray(json: string, context: string): string[] {
  const parsed = parseJsonValue(json, context);
  if (!Array.isArray(parsed)) {
    throw new Error(`[TeamMailbox] Expected JSON array in ${context}`);
  }
  return parsed.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`[TeamMailbox] Expected string at ${context}[${index}]`);
    }
    return item;
  });
}

function parseReadBy(json: string | null | undefined): Set<string> {
  if (json === null || json === undefined) {
    throw new Error('[TeamMailbox] Missing canonical column team_messages.read_by');
  }
  return new Set(parseStringArray(json, 'team_messages.read_by'));
}

function parseMetadata(json: string | null | undefined): TeamMessageMetadata | undefined {
  if (!json) return undefined;
  const parsed = parseJsonValue(json, 'team_messages.metadata');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as TeamMessageMetadata;
  }
  throw new Error('[TeamMailbox] Expected JSON object in team_messages.metadata');
}

function cloneMetadata(metadata: TeamMessageMetadata | undefined): TeamMessageMetadata | undefined {
  if (!metadata) return undefined;
  try {
    return JSON.parse(JSON.stringify(metadata)) as TeamMessageMetadata;
  } catch (error) {
    throw new Error(`[TeamMailbox] metadata must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringifyJson(value: unknown, context: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error(`[TeamMailbox] ${context} must be JSON-serializable`);
  }
  return json;
}

export class TeamMailbox {
  /** key = `${sessionId}::${name}` → TeamDefinition */
  private teams = new Map<string, TeamDefinition>();
  private messages: TeamMessage[] = [];
  private msgCounter = 0;
  private db: DatabaseManager | null = null;
  private eventEmitter: EventEmitter | null = null;

  attachEmitter(emitter: EventEmitter): void {
    this.eventEmitter = emitter;
  }

  attachDatabase(db: DatabaseManager): void {
    this.db = db;
    this.rebuildFromDb();
  }

  private rebuildFromDb(): void {
    if (!this.db) return;
    const raw = this.db.getDb();
    const teamRows = raw.prepare(
      `SELECT name, description, leader_name, members_json, workspace, session_id, created_at, active FROM teams`,
    ).all() as Array<{
      name: string; description: string | null; leader_name: string;
      members_json: string; workspace: string; session_id: string;
      created_at: number; active: number;
    }>;
    this.teams.clear();
    for (const r of teamRows) {
      const members = parseStringArray(r.members_json, 'teams.members_json');
      const def: TeamDefinition = {
        name: r.name,
        description: r.description ?? undefined,
        leader: r.leader_name,
        members,
        workspace: r.workspace,
        sessionId: requireStoredSessionId(r.session_id),
        createdAt: r.created_at,
        active: r.active === 1,
      };
      this.teams.set(teamKey(def.sessionId, def.name), def);
    }

    const msgRows = raw.prepare(
      `SELECT id, from_team, from_member, to_team, to_member, content, urgency, kind, request_id, session_id, timestamp, read_by, metadata FROM team_messages ORDER BY timestamp ASC`,
    ).all() as Array<{
      id: string; from_team: string; from_member: string | null;
      to_team: string; to_member: string | null; content: string;
      urgency: string; kind: string | null; request_id: string | null;
      session_id: string; timestamp: number; read_by: string; metadata: string | null;
    }>;
    this.messages = msgRows.map(r => ({
      id: r.id,
      fromTeam: r.from_team,
      fromMember: r.from_member ?? undefined,
      toTeam: r.to_team,
      toMember: r.to_member ?? undefined,
      content: r.content,
      urgency: (r.urgency as TeamUrgency) || 'normal',
      kind: ((r.kind as TeamMessageKind | null) ?? 'normal'),
      requestId: r.request_id ?? undefined,
      metadata: parseMetadata(r.metadata),
      sessionId: requireStoredSessionId(r.session_id),
      timestamp: r.timestamp,
      readBy: parseReadBy(r.read_by),
    }));
    for (const m of this.messages) {
      // id format: msg_<pid>_<counter>_<ts>
      const match = /^msg_\d+_(\d+)_\d+$/.exec(m.id);
      if (match) {
        const n = Number(match[1]);
        if (n > this.msgCounter) this.msgCounter = n;
      }
    }
  }

  createTeam(team: Omit<TeamDefinition, 'createdAt' | 'active'>): TeamDefinition {
    if (!team.sessionId) {
      throw new Error('TeamMailbox.createTeam 必须指定 sessionId（防多 session 串台）');
    }
    const sessionId = team.sessionId;
    const def: TeamDefinition = {
      ...team,
      sessionId,
      createdAt: Date.now(),
      active: true,
    };
    if (this.db) {
      this.db.getDb().prepare(
        `INSERT OR REPLACE INTO teams (name, description, leader_name, members_json, workspace, session_id, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(def.name, def.description ?? null, def.leader, stringifyJson(def.members, 'teams.members_json'),
            def.workspace, sessionId, def.createdAt, def.active ? 1 : 0);
    }
    this.teams.set(teamKey(sessionId, def.name), def);
    return def;
  }

  deleteTeam(teamName: string, sessionId: string): boolean {
    if (!sessionId) {
      throw new Error('TeamMailbox.deleteTeam 必须指定 sessionId（防多 session 串台）');
    }
    const key = teamKey(sessionId, teamName);
    const team = this.teams.get(key);
    if (team) team.active = false;
    const memoryHadTeam = this.teams.has(key);
    let dbDeleted = false;
    if (this.db) {
      const result = this.db.getDb().prepare(
        `DELETE FROM teams WHERE name = ? AND session_id = ?`,
      ).run(teamName, sessionId);
      dbDeleted = Number(result.changes) > 0;
    }
    this.teams.delete(key);
    return memoryHadTeam || dbDeleted;
  }

  /**
   * 更新已存在 team 的 roster / 描述 / workspace / leader。
   * 仅覆盖传入的字段；name + sessionId 作为主键不可改。
   * 返回更新后的 TeamDefinition；team 不存在时返回 undefined。
   */
  updateTeam(
    teamName: string,
    sessionId: string,
    patch: { description?: string; leader?: string; members?: string[]; workspace?: string },
  ): TeamDefinition | undefined {
    if (!sessionId) {
      throw new Error('TeamMailbox.updateTeam 必须指定 sessionId（防多 session 串台）');
    }
    const current = this.getTeam(teamName, sessionId);
    if (!current) return undefined;

    const next: TeamDefinition = {
      ...current,
      description: patch.description !== undefined ? patch.description : current.description,
      leader: patch.leader !== undefined ? patch.leader : current.leader,
      members: patch.members !== undefined ? patch.members : current.members,
      workspace: patch.workspace !== undefined ? patch.workspace : current.workspace,
      sessionId,
    };
    if (this.db) {
      const result = this.db.getDb().prepare(
        `UPDATE teams SET description = ?, leader_name = ?, members_json = ?, workspace = ?
         WHERE name = ? AND session_id = ?`,
      ).run(next.description ?? null, next.leader, stringifyJson(next.members, 'teams.members_json'),
            next.workspace, teamName, sessionId);
      if (Number(result.changes) === 0) {
        throw new Error(`[TeamMailbox] Missing canonical team row teams(${sessionId}, ${teamName})`);
      }
    }
    this.teams.set(teamKey(sessionId, teamName), next);
    return next;
  }

  /**
   * 单 team 直查 DB（跨进程安全）。
   * 返回 { ok: true, team } 表示 DB 查询成功；team 为命中或 undefined（未找到）。
   * 返回 { ok: false } 表示未挂 DB；调用方可使用内存路径。
   */
  private fetchTeamFromDb(
    teamName: string,
    sessionId: string,
  ): { ok: true; team: TeamDefinition | undefined } | { ok: false } {
    if (!this.db) return { ok: false };
    const raw = this.db.getDb();
    const row = raw.prepare(
      `SELECT name, description, leader_name, members_json, workspace, session_id, created_at, active
       FROM teams WHERE name = ? AND session_id = ?`,
    ).get(teamName, sessionId) as {
      name: string; description: string | null; leader_name: string;
      members_json: string; workspace: string; session_id: string;
      created_at: number; active: number;
    } | undefined;
    if (!row) return { ok: true, team: undefined };
    const members = parseStringArray(row.members_json, 'teams.members_json');
    const def: TeamDefinition = {
      name: row.name,
      description: row.description ?? undefined,
      leader: row.leader_name,
      members,
      workspace: row.workspace,
      sessionId: requireStoredSessionId(row.session_id),
      createdAt: row.created_at,
      active: row.active === 1,
    };
    this.teams.set(teamKey(def.sessionId, def.name), def);
    return { ok: true, team: def };
  }

  teamExists(teamName: string, sessionId: string): boolean {
    if (!sessionId) {
      throw new Error('TeamMailbox.teamExists 必须指定 sessionId（防多 session 串台）');
    }
    const result = this.fetchTeamFromDb(teamName, sessionId);
    if (result.ok) {
      if (result.team) return true;
      this.teams.delete(teamKey(sessionId, teamName));
      return false;
    }
    // 未挂 DB — 退回内存
    return this.teams.has(teamKey(sessionId, teamName));
  }

  getTeam(teamName: string, sessionId: string): TeamDefinition | undefined {
    if (!sessionId) {
      throw new Error('TeamMailbox.getTeam 必须指定 sessionId（防多 session 串台）');
    }
    const result = this.fetchTeamFromDb(teamName, sessionId);
    if (result.ok) {
      if (result.team) return result.team;
      this.teams.delete(teamKey(sessionId, teamName));
      return undefined;
    }
    return this.teams.get(teamKey(sessionId, teamName));
  }

  getAllTeams(sessionId: string): TeamDefinition[] {
    const requiredSessionId = requireSessionId(sessionId, 'TeamMailbox.getAllTeams');
    if (this.db) {
      const rows = this.db.getDb().prepare(
        `SELECT name, description, leader_name, members_json, workspace, session_id, created_at, active
         FROM teams WHERE session_id = ?`,
      ).all(requiredSessionId) as Array<{
        name: string; description: string | null; leader_name: string;
        members_json: string; workspace: string; session_id: string;
        created_at: number; active: number;
      }>;
      const all: TeamDefinition[] = rows.map(r => {
        const members = parseStringArray(r.members_json, 'teams.members_json');
        return {
          name: r.name,
          description: r.description ?? undefined,
          leader: r.leader_name,
          members,
          workspace: r.workspace,
          sessionId: requireStoredSessionId(r.session_id),
          createdAt: r.created_at,
          active: r.active === 1,
        };
      });
      // 同步刷新缓存
      this.teams.clear();
      for (const t of all) this.teams.set(teamKey(t.sessionId, t.name), t);
      return all;
    }
    const all = Array.from(this.teams.values());
    return all.filter(t => t.sessionId === requiredSessionId);
  }

  /**
   * Send a message. toMember present → directed P2P; absent → team broadcast.
   * fromMember / toMember 用 agent name。
   *
   * sessionId 必填：team 通信永远绑定 session 上下文，缺省会导致下游
   * TeamCommunicationService 的硬过滤直接拒收，等于消息悄悄丢失。
   */
  sendMessage(opts: SendMessageOpts): TeamMessage {
    const sessionId = requireSessionId(opts.sessionId, 'TeamMailbox.sendMessage');
    // 写入端不需要重建读视图：本进程内存即源；DB INSERT 紧随其后用于跨进程读路径
    this.msgCounter++;
    const msg: TeamMessage = {
      id: `msg_${process.pid}_${this.msgCounter}_${Date.now()}`,
      fromTeam: opts.fromTeam,
      fromMember: opts.fromMember,
      toTeam: opts.toTeam,
      toMember: opts.toMember,
      content: opts.content,
      urgency: opts.urgency ?? 'normal',
      kind: opts.kind ?? 'normal',
      requestId: opts.requestId ?? opts.metadata?.requestId,
      metadata: cloneMetadata(opts.metadata),
      sessionId,
      timestamp: Date.now(),
      readBy: new Set(),
    };
    if (this.db) {
      this.db.getDb().prepare(
        `INSERT INTO team_messages (id, from_team, from_member, to_team, to_member, content, urgency, kind, request_id, session_id, timestamp, read_by, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(msg.id, msg.fromTeam, msg.fromMember ?? null, msg.toTeam,
            msg.toMember ?? null, msg.content, msg.urgency,
            msg.kind ?? 'normal', msg.requestId ?? null,
            msg.sessionId, msg.timestamp, '[]', msg.metadata ? stringifyJson(msg.metadata, 'team_messages.metadata') : null);
    }
    this.messages.push(msg);
    this.eventEmitter?.emit('team:message_sent', {
      sessionId: msg.sessionId,
      message: msg,
      toTeam: msg.toTeam,
      isBroadcast: !msg.toMember,
    });
    // Per-session quota：先按 sessionId 维度回收超额，避免单 session 大量消息挤掉其他 session 的早期记录
    const sameSession = this.messages.filter(m => m.sessionId === sessionId);
    if (sameSession.length > PER_SESSION_QUOTA) {
      const overflow = sameSession.slice(0, sameSession.length - PER_SESSION_QUOTA);
      const overflowIds = new Set(overflow.map(m => m.id));
      this.messages = this.messages.filter(m => !overflowIds.has(m.id));
      if (this.db && overflowIds.size > 0) {
        const stmt = this.db.getDb().prepare(`DELETE FROM team_messages WHERE id = ?`);
        for (const id of overflowIds) stmt.run(id);
      }
    }
    // 全局上限兜底
    if (this.messages.length > MAX_MESSAGES) {
      const removed = this.messages.slice(0, this.messages.length - TRIM_TARGET);
      this.messages = this.messages.slice(-TRIM_TARGET);
      if (this.db && removed.length > 0) {
        const stmt = this.db.getDb().prepare(`DELETE FROM team_messages WHERE id = ?`);
        for (const r of removed) stmt.run(r.id);
      }
    }
    return msg;
  }

  /**
   * Inbox view for one member (by name): P2P messages addressed to them
   * + broadcasts to their team. unread_only filters by *this* member's read state.
   */
  getInboxForMember(memberName: string, opts: {
    teamName: string;
    sessionId: string;
    unreadOnly?: boolean;
    limit?: number;
  }): TeamMessage[] {
    const sessionId = requireSessionId(opts.sessionId, 'TeamMailbox.getInboxForMember');
    this.rebuildFromDb();
    const unreadOnly = opts.unreadOnly ?? true;
    const filtered = this.messages.filter(m => {
      if (m.sessionId !== sessionId) return false;
      const isDirect = m.toMember === memberName;
      const isBroadcast = !m.toMember && m.toTeam === opts.teamName;
      if (!isDirect && !isBroadcast) return false;
      if (unreadOnly && m.readBy.has(memberName)) return false;
      return true;
    });
    if (opts.limit && filtered.length > opts.limit) {
      return filtered.slice(-opts.limit);
    }
    return filtered;
  }

  /** Messages addressed to a team (broadcasts + P2P). unreadOnly here uses memberName-perspective if provided. */
  getMessages(teamName: string, opts: { unreadOnlyForMember?: string; sessionId: string }): TeamMessage[] {
    const sessionId = requireSessionId(opts.sessionId, 'TeamMailbox.getMessages');
    this.rebuildFromDb();
    let msgs = this.messages.filter(m =>
      (m.toTeam === teamName || m.fromTeam === teamName) &&
      m.sessionId === sessionId,
    );
    if (opts.unreadOnlyForMember) {
      const id = opts.unreadOnlyForMember;
      msgs = msgs.filter(m => !m.readBy.has(id));
    }
    return msgs;
  }

  updateDelivery(
    messageId: string,
    recipientName: string,
    status: TeamDeliveryStatus,
    reason?: string,
  ): void {
    let msg = this.messages.find(m => m.id === messageId);
    if (!msg && this.db) {
      this.rebuildFromDb();
      msg = this.messages.find(m => m.id === messageId);
    }
    if (!msg) {
      if (this.db) {
        throw new Error(`[TeamMailbox] Missing canonical message row team_messages.${messageId}`);
      }
      return;
    }
    const metadata: TeamMessageMetadata = cloneMetadata(msg.metadata) ?? {};
    const delivery = metadata.delivery ?? { recipients: {} };
    delivery.recipients = {
      ...delivery.recipients,
      [recipientName]: {
        // 投递状态写库前统一归一化，避免 sent/seen 等来源拼写扩散到持久层。
        status: normalizeTeamDeliveryStatus(status),
        updatedAt: Date.now(),
        ...(reason ? { reason } : {}),
      },
    };
    metadata.delivery = delivery;
    msg.metadata = metadata;
    if (this.db) {
      const result = this.db.getDb().prepare(`UPDATE team_messages SET metadata = ? WHERE id = ?`)
        .run(stringifyJson(metadata, 'team_messages.metadata'), messageId);
      if (Number(result.changes) === 0) {
        throw new Error(`[TeamMailbox] Missing canonical message row team_messages.${messageId}`);
      }
    }
  }

  getDeliverySummary(messageId: string): { delivered: number; queued: number; read: number; skipped: number; failed: number; recipients: Record<string, TeamDeliveryRecipientState> } {
    let msg = this.messages.find(m => m.id === messageId);
    if (!msg && this.db) {
      this.rebuildFromDb();
      msg = this.messages.find(m => m.id === messageId);
    }
    if (!msg && this.db) {
      throw new Error(`[TeamMailbox] Missing canonical message row team_messages.${messageId}`);
    }
    const recipients = msg?.metadata?.delivery?.recipients ?? {};
    const summary = { delivered: 0, queued: 0, read: 0, skipped: 0, failed: 0, recipients };
    for (const state of Object.values(recipients)) {
      summary[state.status]++;
    }
    return summary;
  }

  /**
   * Mark messages as read for a specific member (by name). Required for
   * broadcasts so each recipient tracks their own read state.
   */
  markRead(messageIds: string[], memberName: string): void {
    if (messageIds.length === 0) return;
    if (this.db) {
      this.rebuildFromDb();
    }
    const idSet = new Set(messageIds);
    if (this.db) {
      const existingIds = new Set(this.messages.map(m => m.id));
      for (const id of idSet) {
        if (!existingIds.has(id)) {
          throw new Error(`[TeamMailbox] Missing canonical message row team_messages.${id}`);
        }
      }
    }
    const updated: TeamMessage[] = [];
    if (this.db) {
      // SELECT read_by → 内存合并 → UPDATE read_by 必须在同一 immediate 事务内：
      // 否则两个并发 markRead 各自读旧 read_by、各自写并集，后者覆盖前者 → 丢已读回执。
      // updateDelivery 的写也并入此事务（同连接，不嵌套 BEGIN）。
      this.db.transaction(() => {
        for (const msg of this.messages) {
          if (!idSet.has(msg.id)) continue;
          const row = this.db!.getDb().prepare(`SELECT read_by FROM team_messages WHERE id = ?`).get(msg.id) as { read_by: string | null } | undefined;
          if (!row) {
            throw new Error(`[TeamMailbox] Missing canonical message row team_messages.${msg.id}`);
          }
          for (const reader of parseReadBy(row.read_by)) msg.readBy.add(reader);
          if (!msg.readBy.has(memberName)) {
            msg.readBy.add(memberName);
            updated.push(msg);
          }
          this.updateDelivery(msg.id, memberName, 'read');
        }
        if (updated.length > 0) {
          const stmt = this.db!.getDb().prepare(`UPDATE team_messages SET read_by = ? WHERE id = ?`);
          for (const msg of updated) {
            const result = stmt.run(stringifyJson(Array.from(msg.readBy), 'team_messages.read_by'), msg.id);
            if (Number(result.changes) === 0) {
              throw new Error(`[TeamMailbox] Missing canonical message row team_messages.${msg.id}`);
            }
          }
        }
      }, { immediate: true });
    } else {
      // 无 DB 后端：仅内存态
      for (const msg of this.messages) {
        if (!idSet.has(msg.id)) continue;
        if (!msg.readBy.has(memberName)) {
          msg.readBy.add(memberName);
          updated.push(msg);
        }
      }
    }
    if (updated.length > 0 && this.eventEmitter) {
      // Emit one event per session to keep SSE bridge granularity；多数批读同一 session
      const bySession = new Map<string, TeamMessage[]>();
      for (const m of updated) {
        const arr = bySession.get(m.sessionId) ?? [];
        arr.push(m);
        bySession.set(m.sessionId, arr);
      }
      for (const [sid, msgs] of bySession.entries()) {
        this.eventEmitter.emit('team:message_read', {
          sessionId: sid,
          memberName,
          messageIds: msgs.map(m => m.id),
        });
      }
    }
  }

  /** Drop all messages mentioning a team (used by team_manage action="delete"). */
  cleanupTeam(teamName: string, sessionId: string): number {
    if (!sessionId) {
      throw new Error('TeamMailbox.cleanupTeam 必须指定 sessionId（防多 session 串台）');
    }
    const before = this.messages.length;
    this.messages = this.messages.filter(
      m => !(
        (m.fromTeam === teamName || m.toTeam === teamName)
        && m.sessionId === sessionId
      ),
    );
    const removedFromMemory = before - this.messages.length;
    if (this.db) {
      const result = this.db.getDb().prepare(
        `DELETE FROM team_messages
         WHERE (from_team = ? OR to_team = ?)
           AND session_id = ?`,
      ).run(teamName, teamName, sessionId);
      return Math.max(removedFromMemory, Number(result.changes));
    }
    return removedFromMemory;
  }

  /** Test helper: drop everything in memory and DB. */
  resetForTesting(): void {
    this.teams.clear();
    this.messages = [];
    this.msgCounter = 0;
    if (this.db && !this.db.isClosed()) {
      const raw = this.db.getDb();
      raw.prepare(`DELETE FROM team_messages`).run();
      raw.prepare(`DELETE FROM teams`).run();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton accessors
// ═══════════════════════════════════════════════════════════════

let _memberRegistry: TeamMemberRegistry | null = null;
let _teamMailbox: TeamMailbox | null = null;

export function getTeamMemberRegistry(): TeamMemberRegistry {
  if (!_memberRegistry) _memberRegistry = new TeamMemberRegistry();
  return _memberRegistry;
}

export function getTeamMailbox(): TeamMailbox {
  if (!_teamMailbox) _teamMailbox = new TeamMailbox();
  return _teamMailbox;
}

/** Wire the singletons to a DatabaseManager so they survive process restart. */
export function attachTeamMailboxDatabase(db: DatabaseManager): void {
  const maybeDb = db as unknown as { getDb?: unknown };
  if (typeof maybeDb.getDb !== 'function') return;
  getTeamMemberRegistry().attachDatabase(db);
  getTeamMailbox().attachDatabase(db);
}

/** Test-only: drop singleton refs (forces rebuild on next access). Does NOT wipe DB. */
export function resetTeamMailboxSingletonsForTesting(): void {
  _memberRegistry = null;
  _teamMailbox = null;
}

/** Test-only: drop singletons AND wipe DB-backed state. */
export function resetTeamMailboxForTesting(): void {
  getTeamMemberRegistry().resetForTesting();
  getTeamMailbox().resetForTesting();
  _memberRegistry = null;
  _teamMailbox = null;
}
