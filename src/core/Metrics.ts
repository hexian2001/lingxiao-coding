export type MetricLabels = Record<string, string>;

export interface MetricSample {
  labels: MetricLabels;
  value: number;
}

export interface MetricSnapshot {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: MetricSample[];
  buckets?: number[];
}

function labelKey(labels: MetricLabels = {}): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join('\u0000');
}

function cloneLabels(labels: MetricLabels = {}): MetricLabels {
  return { ...labels };
}

class ValueStore {
  private readonly values = new Map<string, MetricSample>();
  // #24: 按 label 组合基数封顶(FIFO 驱逐最旧),防止 actor/model 等高基数标签跨长会话无限增长。
  private static readonly MAX_LABEL_SERIES = 256;

  add(labels: MetricLabels, value: number): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.values.set(key, { labels: cloneLabels(labels), value });
    this.evictIfNeeded();
  }

  set(labels: MetricLabels, value: number): void {
    this.values.set(labelKey(labels), { labels: cloneLabels(labels), value });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.values.size > ValueStore.MAX_LABEL_SERIES) {
      const oldestKey = this.values.keys().next().value;
      if (oldestKey === undefined) break;
      this.values.delete(oldestKey);
    }
  }

  snapshot(): MetricSample[] {
    return Array.from(this.values.values()).map((sample) => ({
      labels: cloneLabels(sample.labels),
      value: sample.value,
    }));
  }

  reset(): void {
    this.values.clear();
  }
}

export class Counter {
  private readonly store = new ValueStore();

  inc(labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value)) return;
    if (value < 0) {
      throw new Error('Counter cannot be incremented by a negative value');
    }
    this.store.add(labels, value);
  }

  snapshot(): MetricSample[] {
    return this.store.snapshot();
  }

  reset(): void {
    this.store.reset();
  }
}

export class Gauge {
  private readonly store = new ValueStore();

  set(labels: MetricLabels = {}, value: number): void {
    if (!Number.isFinite(value)) return;
    this.store.set(labels, value);
  }

  inc(labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value)) return;
    this.store.add(labels, value);
  }

  dec(labels: MetricLabels = {}, value = 1): void {
    this.inc(labels, -value);
  }

  snapshot(): MetricSample[] {
    return this.store.snapshot();
  }

  reset(): void {
    this.store.reset();
  }
}

export class Histogram {
  private readonly store = new ValueStore();
  readonly buckets: number[];

  constructor(buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 5000]) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: MetricLabels = {}, value: number): void {
    if (!Number.isFinite(value)) return;
    for (const bucket of this.buckets) {
      if (value <= bucket) {
        this.store.add({ ...labels, le: String(bucket) }, 1);
      }
    }
    this.store.add({ ...labels, le: '+Inf' }, 1);
    this.store.add({ ...labels, stat: 'sum' }, value);
    this.store.add({ ...labels, stat: 'count' }, 1);
  }

  snapshot(): MetricSample[] {
    return this.store.snapshot();
  }

  reset(): void {
    this.store.reset();
  }
}

type MetricEntry =
  | { type: 'counter'; help: string; metric: Counter }
  | { type: 'gauge'; help: string; metric: Gauge }
  | { type: 'histogram'; help: string; metric: Histogram };

export class MetricsRegistry {
  private readonly entries = new Map<string, MetricEntry>();

  counter(name: string, help: string): Counter {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.type !== 'counter') throw new Error(`Metric ${name} already registered as ${existing.type}`);
      return existing.metric;
    }
    const metric = new Counter();
    this.entries.set(name, { type: 'counter', help, metric });
    return metric;
  }

  gauge(name: string, help: string): Gauge {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.type !== 'gauge') throw new Error(`Metric ${name} already registered as ${existing.type}`);
      return existing.metric;
    }
    const metric = new Gauge();
    this.entries.set(name, { type: 'gauge', help, metric });
    return metric;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.type !== 'histogram') throw new Error(`Metric ${name} already registered as ${existing.type}`);
      return existing.metric;
    }
    const metric = new Histogram(buckets);
    this.entries.set(name, { type: 'histogram', help, metric });
    return metric;
  }

  snapshot(): Record<string, MetricSnapshot> {
    const result: Record<string, MetricSnapshot> = {};
    for (const [name, entry] of this.entries.entries()) {
      result[name] = {
        name,
        help: entry.help,
        type: entry.type,
        values: entry.metric.snapshot(),
        buckets: entry.type === 'histogram' ? entry.metric.buckets : undefined,
      };
    }
    return result;
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      entry.metric.reset();
    }
  }
}

export const globalMetrics = new MetricsRegistry();

export const llmRequestsTotal = globalMetrics.counter('llm_requests_total', 'Total LLM requests');
export const llmTokensUsed = globalMetrics.counter('llm_tokens_used', 'Total LLM tokens used');
export const taskDispatchTotal = globalMetrics.counter('task_dispatch_total', 'Total task dispatch attempts');
export const compressionRuns = globalMetrics.counter('compression_runs', 'Total context compression runs');
export const circuitBreakerState = globalMetrics.gauge('circuit_breaker_state', 'Circuit breaker state by provider');
export const llmLatencyMs = globalMetrics.histogram('llm_latency_ms', 'LLM request latency in milliseconds');
