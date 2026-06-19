import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync as DatabaseType } from 'node:sqlite';
import type { DatabaseManager } from './Database.js';
import { runTransaction } from './Database.js';

export type SpanStatus = 'ok' | 'error';
export type SpanAttributeValue = string | number | boolean;

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface SpanSink {
  write(spans: Span[]): void;
}

export interface SerializedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startTs: number;
  endTs?: number;
  status: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
}

function newTraceId(): string {
  return randomBytes(8).toString('hex');
}

function newSpanId(): string {
  return randomBytes(4).toString('hex');
}

export class Span {
  readonly context: SpanContext;
  readonly operation: string;
  readonly startTs: number;
  endTs?: number;
  status: SpanStatus = 'ok';
  readonly attributes: Record<string, SpanAttributeValue>;

  constructor(
    operation: string,
    context: SpanContext,
    attributes: Record<string, SpanAttributeValue> = {},
  ) {
    this.operation = operation;
    this.context = context;
    this.startTs = Date.now();
    this.attributes = { ...attributes };
  }

  end(status: SpanStatus = 'ok'): void {
    if (this.endTs !== undefined) return;
    this.status = status;
    this.endTs = Date.now();
  }

  addAttribute(key: string, value: SpanAttributeValue): void {
    this.attributes[key] = value;
  }

  child(operation: string): Span {
    return globalTracer.startSpan(operation, this.context);
  }

  toJSON(): SerializedSpan {
    return {
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      operation: this.operation,
      startTs: this.startTs,
      endTs: this.endTs,
      status: this.status,
      attributes: { ...this.attributes },
    };
  }
}

export interface TracerOptions {
  persist: boolean;
  maxSpans: number;
  sink?: SpanSink;
}

export class Tracer {
  private readonly storage = new AsyncLocalStorage<Span>();
  private spans: Span[] = [];
  private persist = false;
  private maxSpans = 1000;
  private sink?: SpanSink;

  configure(opts: Partial<TracerOptions>): void {
    if (typeof opts.persist === 'boolean') this.persist = opts.persist;
    if (typeof opts.maxSpans === 'number' && Number.isFinite(opts.maxSpans)) {
      this.maxSpans = Math.max(1, Math.floor(opts.maxSpans));
      this.enforceRingLimit();
    }
    if (opts.sink !== undefined) this.sink = opts.sink;
  }

  startTrace(operation: string, attributes: Record<string, SpanAttributeValue> = {}): Span {
    return this.startSpan(operation, undefined, attributes);
  }

  startSpan(
    operation: string,
    parent?: SpanContext,
    attributes: Record<string, SpanAttributeValue> = {},
  ): Span {
    const active = this.currentSpan();
    const parentContext = parent ?? active?.context;
    const span = new Span(operation, {
      traceId: parentContext?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      parentSpanId: parentContext?.spanId,
    }, attributes);
    this.spans.push(span);
    this.enforceRingLimit();
    return span;
  }

  currentSpan(): Span | null {
    return this.storage.getStore() ?? null;
  }

  withSpan<T>(span: Span, fn: () => T): T {
    return this.storage.run(span, fn);
  }

  flush(): void {
    if (this.persist && this.sink && this.spans.length > 0) {
      this.sink.write([...this.spans]);
    }
    this.spans = [];
  }

  recent(n: number): SerializedSpan[] {
    return this.spans.slice(-Math.max(0, n)).map((span) => span.toJSON());
  }

  reset(): void {
    this.spans = [];
  }

  private enforceRingLimit(): void {
    while (this.spans.length > this.maxSpans) {
      this.spans.shift();
    }
  }
}

export class SqliteSpanSink implements SpanSink {
  private readonly db: DatabaseType;

  constructor(dbOrManager: DatabaseType | DatabaseManager) {
    this.db = 'getDb' in dbOrManager ? dbOrManager.getDb() : dbOrManager;
    this.ensureSchema();
  }

  write(spans: Span[]): void {
    if (spans.length === 0) return;
    this.ensureSchema();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO traces (
        trace_id, span_id, parent_span_id, operation, start_ts, end_ts,
        status, attributes, session_id, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    runTransaction(this.db, () => {
      for (const span of spans) {
        const attrs = span.attributes;
        stmt.run(
          span.context.traceId,
          span.context.spanId,
          span.context.parentSpanId ?? null,
          span.operation,
          span.startTs,
          span.endTs ?? null,
          span.status,
          JSON.stringify(attrs),
          typeof attrs.session_id === 'string' ? attrs.session_id : null,
          typeof attrs.agent_id === 'string' ? attrs.agent_id : null,
        );
      }
    }, { immediate: true });
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT NOT NULL,
        span_id TEXT PRIMARY KEY,
        parent_span_id TEXT,
        operation TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER,
        status TEXT DEFAULT 'ok',
        attributes TEXT,
        session_id TEXT,
        agent_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_traces_trace ON traces(trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, start_ts);
    `);
  }
}

export interface TraceSummary {
  traceId: string;
  spanCount: number;
  rootOperation: string;
  startTs: number;
  endTs?: number;
  status: SpanStatus;
  durationMs?: number;
}

export function summarizeSpans(spans: SerializedSpan[]): TraceSummary[] {
  const byTrace = new Map<string, SerializedSpan[]>();
  for (const span of spans) {
    const bucket = byTrace.get(span.traceId) ?? [];
    bucket.push(span);
    byTrace.set(span.traceId, bucket);
  }
  return Array.from(byTrace.entries()).map(([traceId, items]) => {
    const sorted = [...items].sort((a, b) => a.startTs - b.startTs);
    const root = sorted.find((span) => !span.parentSpanId) ?? sorted[0];
    const startTs = Math.min(...sorted.map((span) => span.startTs));
    const ended = sorted.map((span) => span.endTs).filter((v): v is number => typeof v === 'number');
    const endTs = ended.length > 0 ? Math.max(...ended) : undefined;
    const status: SpanStatus = sorted.some((span) => span.status === 'error') ? 'error' : 'ok';
    return {
      traceId,
      spanCount: sorted.length,
      rootOperation: root.operation,
      startTs,
      endTs,
      status,
      durationMs: endTs === undefined ? undefined : Math.max(0, endTs - startTs),
    };
  }).sort((a, b) => b.startTs - a.startTs);
}

export const globalTracer = new Tracer();
