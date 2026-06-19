/**
 * MetricsRegistry — Lightweight Prometheus-compatible metrics collection
 *
 * Zero external dependencies. Supports counters and gauges with labels.
 * Outputs standard Prometheus exposition format via serialize().
 */

// ─── Types ───

interface MetricMeta {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
}

interface LabeledValue {
  labels: Record<string, string>;
  value: number;
}

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map(k => `${k}=${labels[k]}`).join(',');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return `{${keys.map(k => `${k}="${labels[k]}"`).join(',')}}`;
}

// ─── Counter ───

export class Counter {
  readonly name: string;
  private values: Map<string, LabeledValue> = new Map();

  constructor(name: string) { this.name = name; }

  inc(labels: Record<string, string> = {}, delta = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += delta;
    else this.values.set(key, { labels, value: delta });
  }

  getValues(): LabeledValue[] { return Array.from(this.values.values()); }
}

// ─── Gauge ───

export class Gauge {
  readonly name: string;
  private values: Map<string, LabeledValue> = new Map();

  constructor(name: string) { this.name = name; }

  set(labels: Record<string, string> = {}, value: number): void {
    this.values.set(labelKey(labels), { labels, value });
  }

  inc(labels: Record<string, string> = {}, delta = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += delta;
    else this.values.set(key, { labels, value: delta });
  }

  dec(labels: Record<string, string> = {}, delta = 1): void { this.inc(labels, -delta); }

  getValues(): LabeledValue[] { return Array.from(this.values.values()); }
}

// ─── Registry ───

export class MetricsRegistry {
  private metas: Map<string, MetricMeta> = new Map();
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();

  counter(name: string, help: string): Counter {
    if (!this.counters.has(name)) {
      this.counters.set(name, new Counter(name));
      this.metas.set(name, { name, help, type: 'counter' });
    }
    return this.counters.get(name)!;
  }

  gauge(name: string, help: string): Gauge {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, new Gauge(name));
      this.metas.set(name, { name, help, type: 'gauge' });
    }
    return this.gauges.get(name)!;
  }

  serialize(): string {
    const lines: string[] = [];
    for (const [name, meta] of this.metas) {
      lines.push(`# HELP ${name} ${meta.help}`);
      lines.push(`# TYPE ${name} ${meta.type}`);
      const values = meta.type === 'counter'
        ? this.counters.get(name)!.getValues()
        : this.gauges.get(name)!.getValues();
      for (const v of values) {
        lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, meta] of this.metas) {
      const values = meta.type === 'counter'
        ? this.counters.get(name)!.getValues()
        : this.gauges.get(name)!.getValues();
      if (values.length === 1 && Object.keys(values[0].labels).length === 0) {
        result[name] = values[0].value;
      } else {
        const sub: Record<string, number> = {};
        for (const v of values) sub[labelKey(v.labels) || '_total'] = v.value;
        result[name] = sub;
      }
    }
    return result;
  }
}

// ─── Global Instance ───

export const metrics = new MetricsRegistry();

export const tasksTotal = metrics.counter('lingxiao_tasks_total', 'Total tasks processed');
export const agentsActive = metrics.gauge('lingxiao_agents_active', 'Currently active agents');
export const tokensTotal = metrics.counter('lingxiao_tokens_total', 'Total tokens consumed');
export const healthStatus = metrics.gauge('lingxiao_health_status', 'Agent health status counts');
export const patrolTotal = metrics.counter('lingxiao_patrol_total', 'Eternal patrol cycles');
export const uptimeSeconds = metrics.gauge('lingxiao_uptime_seconds', 'Process uptime');
export const apiErrorsTotal = metrics.counter('lingxiao_api_errors_total', 'API call failures');
export const llmRequestsTotal = metrics.counter('lingxiao_llm_requests_total', 'LLM API requests');

const startTime = Date.now();
export function refreshUptime(): void {
  uptimeSeconds.set({}, Math.floor((Date.now() - startTime) / 1000));
}
