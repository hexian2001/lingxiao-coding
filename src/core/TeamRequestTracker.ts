/**
 * TeamRequestTracker — team request/ack 参与者级闭环。
 */

import { getTeamMailbox, type TeamMessage } from './TeamMailbox.js';

export interface PendingRequest {
  requestId: string;
  from: string;
  to: string;
  isBroadcast: boolean;
  content: string;
  sentAt: number;
  timedOut: boolean;
  expectedAckBy: string[];
  ackedBy: Record<string, number>;
}

export interface AckOutcome {
  matched: boolean;
  completed?: boolean;
  request?: PendingRequest;
  ignoredReason?: 'unexpected_sender' | 'unknown_sender';
  missingAckBy?: string[];
}

export interface RequestState {
  status: 'unknown' | 'pending' | 'closed';
  request?: PendingRequest;
  missingAckBy?: string[];
  timedOut?: boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function normalizeMember(name: string): string {
  return name.trim().replace(/^@+/, '');
}

function uniqueMembers(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeMember(raw);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function missingAckBy(req: PendingRequest): string[] {
  return req.expectedAckBy.filter(name => req.ackedBy[name] === undefined);
}

export class TeamRequestTracker {
  private readonly sessionId: string;
  private readonly ttlMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed = new Set<string>();

  constructor(sessionId: string, ttlMs: number = DEFAULT_TTL_MS) {
    this.sessionId = sessionId;
    this.ttlMs = ttlMs;
  }

  onRequest(input: {
    requestId: string;
    from: string;
    to: string;
    isBroadcast: boolean;
    content: string;
    sentAt?: number;
    expectedAckBy?: string[];
  }): void {
    const sentAt = input.sentAt ?? Date.now();
    this.closed.delete(input.requestId);
    this.pending.set(input.requestId, {
      requestId: input.requestId,
      from: normalizeMember(input.from),
      to: input.to,
      isBroadcast: input.isBroadcast,
      content: input.content,
      sentAt,
      timedOut: false,
      expectedAckBy: this.resolveExpectedAckBy(input),
      ackedBy: {},
    });
  }

  onAck(requestId: string, fromMember: string): AckOutcome {
    const sender = normalizeMember(fromMember);
    if (!sender) return { matched: false, ignoredReason: 'unknown_sender' };
    const req = this.pending.get(requestId) ?? this.findRequestInMailbox(requestId);
    if (!req) return { matched: false };
    if (!req.expectedAckBy.some(name => name.toLowerCase() === sender.toLowerCase())) {
      return { matched: true, request: req, completed: false, ignoredReason: 'unexpected_sender', missingAckBy: missingAckBy(req) };
    }
    const canonical = req.expectedAckBy.find(name => name.toLowerCase() === sender.toLowerCase()) ?? sender;
    req.ackedBy[canonical] = Date.now();
    const missing = missingAckBy(req);
    if (missing.length === 0) {
      this.pending.delete(requestId);
      this.closed.add(requestId);
      return { matched: true, completed: true, request: req, missingAckBy: [] };
    }
    this.pending.set(requestId, req);
    return { matched: true, completed: false, request: req, missingAckBy: missing };
  }

  private resolveExpectedAckBy(input: { from: string; to: string; isBroadcast: boolean; expectedAckBy?: string[] }): string[] {
    if (input.expectedAckBy && input.expectedAckBy.length > 0) return uniqueMembers(input.expectedAckBy);
    if (!input.isBroadcast) return uniqueMembers([input.to]);
    const mailbox = getTeamMailbox();
    const team = mailbox.getTeam(input.to, this.sessionId);
    if (!team) return [];
    return uniqueMembers([team.leader, ...team.members]).filter(name => name.toLowerCase() !== normalizeMember(input.from).toLowerCase());
  }

  private findRequestInMailbox(requestId: string): PendingRequest | undefined {
    this.rebuildFromMailbox();
    return this.pending.get(requestId);
  }

  private refreshTimeouts(now: number): void {
    for (const req of this.pending.values()) {
      if (!req.timedOut && now - req.sentAt >= this.ttlMs) req.timedOut = true;
    }
  }

  rebuildFromMailbox(): void {
    const mailbox = getTeamMailbox();
    const teams = mailbox.getAllTeams(this.sessionId);
    const messages: TeamMessage[] = [];
    for (const team of teams) messages.push(...mailbox.getMessages(team.name, { sessionId: this.sessionId }));
    const protocolMessages = messages
      .filter(msg => msg.requestId && (msg.kind === 'request' || msg.kind === 'ack'))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (protocolMessages.length === 0) return;

    const rebuilt = new Map<string, PendingRequest>();
    for (const msg of protocolMessages) {
      const requestId = msg.requestId!;
      if (msg.kind === 'request') {
        const from = msg.fromMember ?? 'system';
        rebuilt.set(requestId, {
          requestId,
          from,
          to: msg.toMember ?? msg.toTeam,
          isBroadcast: !msg.toMember,
          content: msg.content,
          sentAt: msg.timestamp,
          timedOut: false,
          expectedAckBy: this.resolveExpectedAckBy({ from, to: msg.toMember ?? msg.toTeam, isBroadcast: !msg.toMember }),
          ackedBy: {},
        });
      } else {
        const req = rebuilt.get(requestId);
        const from = msg.fromMember;
        if (!req || !from) continue;
        if (req.expectedAckBy.some(name => name.toLowerCase() === normalizeMember(from).toLowerCase())) {
          const canonical = req.expectedAckBy.find(name => name.toLowerCase() === normalizeMember(from).toLowerCase()) ?? normalizeMember(from);
          req.ackedBy[canonical] = msg.timestamp;
          if (missingAckBy(req).length === 0) rebuilt.delete(requestId);
        }
      }
    }

    this.pending.clear();
    for (const [requestId, req] of rebuilt.entries()) this.pending.set(requestId, req);
  }

  getOutstandingFrom(memberName: string, now: number = Date.now()): PendingRequest[] {
    this.rebuildFromMailbox();
    this.refreshTimeouts(now);
    return Array.from(this.pending.values()).filter(r => r.from === memberName).sort((a, b) => a.sentAt - b.sentAt);
  }

  getAwaitingAckBy(memberName: string, now: number = Date.now()): PendingRequest[] {
    this.rebuildFromMailbox();
    this.refreshTimeouts(now);
    const normalized = normalizeMember(memberName).toLowerCase();
    return Array.from(this.pending.values())
      .filter(r => r.expectedAckBy.some(name => name.toLowerCase() === normalized) && !Object.keys(r.ackedBy).some(name => name.toLowerCase() === normalized))
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  getTimedOut(now: number = Date.now()): PendingRequest[] {
    this.rebuildFromMailbox();
    this.refreshTimeouts(now);
    return Array.from(this.pending.values()).filter(r => r.timedOut);
  }

  getRequestState(requestId: string, now: number = Date.now()): RequestState {
    this.rebuildFromMailbox();
    this.refreshTimeouts(now);
    const req = this.pending.get(requestId);
    if (req) {
      return {
        status: 'pending',
        request: req,
        missingAckBy: missingAckBy(req),
        timedOut: req.timedOut,
      };
    }

    if (this.closed.has(requestId)) return { status: 'closed', missingAckBy: [], timedOut: false };

    const mailbox = getTeamMailbox();
    const teams = mailbox.getAllTeams(this.sessionId);
    for (const team of teams) {
      const messages = mailbox.getMessages(team.name, { sessionId: this.sessionId });
      if (messages.some(msg => msg.requestId === requestId && msg.kind === 'request')) {
        this.closed.add(requestId);
        return { status: 'closed', missingAckBy: [], timedOut: false };
      }
    }
    return { status: 'unknown' };
  }

  getMissingAckBy(request: PendingRequest): string[] {
    return missingAckBy(request);
  }

  size(): number { return this.pending.size; }
  reset(): void {
    this.pending.clear();
    this.closed.clear();
  }
}

const trackers = new Map<string, TeamRequestTracker>();

export function getTeamRequestTracker(sessionId: string): TeamRequestTracker {
  let t = trackers.get(sessionId);
  if (!t) {
    t = new TeamRequestTracker(sessionId);
    trackers.set(sessionId, t);
  }
  return t;
}

export function peekTeamRequestTracker(sessionId: string): TeamRequestTracker | undefined {
  return trackers.get(sessionId);
}

export function disposeTeamRequestTracker(sessionId: string): void {
  const t = trackers.get(sessionId);
  if (t) {
    t.reset();
    trackers.delete(sessionId);
  }
}

function resetTeamRequestTrackersForTesting(): void {
  for (const t of trackers.values()) t.reset();
  trackers.clear();
}
