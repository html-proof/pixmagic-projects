import { createServer, type Server } from "node:http";
import { logger } from "@app/core";

/**
 * Prometheus metrics for bizinsights on a server of its own (server.ts; docs/ikorex-migration):
 * counters and histograms kept in memory, plus gauges read when Prometheus scrapes (queue depth,
 * the dead-letter queue, memory). Served on their own port, which only the internal Docker network
 * reaches: never through the tunnel. Label values are the app's own words (queue names, outcomes,
 * status classes), never anything a request or a customer supplies.
 */
type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
const fmt = (name: string, labels: string, value: number) => `${name}${labels ? `{${labels}}` : ""} ${Number.isFinite(value) ? value : 0}`;

export class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values].map(([k, v]) => fmt(this.name, k, v))];
  }
}

export class Histogram {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(labels: Labels, value: number) {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : "";
      this.buckets.forEach((b, i) => out.push(fmt(`${this.name}_bucket`, `${sep}le="${b}"`, s.counts[i]!)));
      out.push(fmt(`${this.name}_bucket`, `${sep}le="+Inf"`, s.count));
      out.push(fmt(`${this.name}_sum`, k, s.sum));
      out.push(fmt(`${this.name}_count`, k, s.count));
    }
    return out;
  }
}

/** A gauge family read at scrape time. */
export interface GaugeSource {
  name: string;
  help: string;
  read(): Promise<Array<{ labels: Labels; value: number }>>;
}

export class Registry {
  private counters: Counter[] = [];
  private histograms: Histogram[] = [];
  private gauges: GaugeSource[] = [];
  counter(name: string, help: string) {
    const c = new Counter(name, help);
    this.counters.push(c);
    return c;
  }
  histogram(name: string, help: string, buckets: number[]) {
    const h = new Histogram(name, help, buckets);
    this.histograms.push(h);
    return h;
  }
  gauge(source: GaugeSource) {
    this.gauges.push(source);
  }
  async render(): Promise<string> {
    const lines: string[] = [];
    for (const c of this.counters) lines.push(...c.render());
    for (const h of this.histograms) lines.push(...h.render());
    for (const g of this.gauges) {
      let values: Array<{ labels: Labels; value: number }>;
      try {
        values = await g.read();
      } catch (err) {
        // One source failing (the database away) must not hide the others.
        logger.warn({ err, metric: g.name }, "metric could not be read");
        continue;
      }
      lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, ...values.map((v) => fmt(g.name, key(v.labels), v.value)));
    }
    return `${lines.join("\n")}\n`;
  }
}

/** The status class Prometheus sees ("2xx", "4xx", ...): never the path, which a client chooses. */
export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/** GET /metrics on `port`, on every interface of the container (only the internal network reaches it). */
export function serveMetrics(registry: Registry, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url?.split("?")[0] !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry
      .render()
      .then((body) => res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(body))
      .catch((err: unknown) => {
        logger.error({ err }, "metrics failed");
        res.writeHead(500).end();
      });
  });
  return new Promise((ready, fail) => {
    server.once("error", fail);
    server.listen(port, "0.0.0.0", () => ready(server));
  });
}
