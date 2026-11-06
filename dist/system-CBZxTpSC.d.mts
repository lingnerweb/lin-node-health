//#region src/types.d.ts
/**
 * The shapes of the health contract, see CONTRACT.md in lin-grafana-monitoring.
 * Nothing in this file touches Node or a framework.
 */
type HealthStatus = "ok" | "degraded" | "error";
type MetricType = "gauge" | "counter";
interface Sample {
  readonly labels?: Readonly<Record<string, string>>;
  readonly value: number;
}
interface Metric {
  /** Without the lin_health_ prefix, for example "runtime_heap_used_bytes". */
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  /** An empty list drops the metric: a value that cannot be read is omitted, not 0. */
  readonly samples: readonly Sample[];
}
/**
 * The key stays identical while the warning lasts, alerts group by it. The
 * message carries the current values and may change between scrapes.
 */
interface Warning {
  readonly key: string;
  readonly message: string;
}
interface CollectorResult {
  readonly metrics?: readonly Metric[];
  readonly warnings?: readonly Warning[];
  /** The area in the JSON format. null when the area is not available. */
  readonly json?: unknown;
  /** The application cannot serve requests at all, the status becomes "error". */
  readonly fatal?: boolean;
}
/**
 * One area of the contract. An area is reported in full or not at all, so a
 * collector that finds nothing returns json: null and no metrics.
 */
interface Collector {
  /** Area of the contract, also the key in the JSON payload. */
  readonly area: string;
  collect(): CollectorResult | Promise<CollectorResult>;
  /** Starts background measurement, called once per process. */
  start?(): void;
  stop?(): void;
}
interface HealthPayload {
  readonly status: HealthStatus;
  readonly contract: number;
  readonly version: string;
  readonly platform: string;
  readonly warnings: readonly Warning[];
  readonly hostname: string;
  readonly time: string;
  readonly durationMs: number;
  /** Labels of lin_health_info, without contract, version, platform and hostname. */
  readonly info: Readonly<Record<string, string>>;
  /** One entry per registered collector, null when the area is not available. */
  readonly areas: Readonly<Record<string, unknown>>;
  readonly metrics: readonly Metric[];
}
interface HealthConfig {
  /** Overrides the token from the environment. An empty token disables the endpoint. */
  readonly token?: string;
  /** Environment variable holding the token, default HEALTH_ENDPOINT_BEARER. */
  readonly tokenEnv?: string;
  /** Label of lin_health_info that dashboards and alert rules branch on. */
  readonly platform?: string;
  /** Extra labels for lin_health_info, for example the deployed commit. */
  readonly info?: Readonly<Record<string, string>>;
  readonly collectors?: readonly Collector[];
}
interface Health {
  /** False without a configured token: the endpoint is disabled. */
  readonly enabled: boolean;
  collect(): Promise<HealthPayload>;
  isAuthorized(headers: Headers): boolean;
  /** null when the endpoint is disabled, so the caller can fall through. */
  handle(request: Request): Promise<Response | null>;
  register(collector: Collector): void;
  /** Starts every collector that measures in the background. */
  start(): void;
  stop(): void;
}
//#endregion
//#region src/collectors/errors.d.ts
interface ErrorEvent {
  /**
   * What the visitor got: "page" means an error page was served, "content"
   * means one element failed while the page rendered.
   */
  readonly errorPage?: "page" | "content";
  /** Which log the entry belongs to, default "app". */
  readonly log?: string;
  /** Severity, default "error". */
  readonly level?: string;
}
interface ErrorCollector extends Collector {
  record(event?: ErrorEvent): void;
}
/**
 * Counts server errors of the last 24 hours in memory.
 *
 * The counts come from the application, not from a log store, so the dashboard
 * still works when log shipping is broken. They restart with the process, like
 * every other runtime metric here.
 */
declare function createErrorCollector(): ErrorCollector;
//#endregion
//#region src/collectors/runtime.d.ts
interface RuntimeCollectorOptions {
  /** Warn above this event loop lag in seconds, measured as p99. Default 1. */
  readonly lagWarnSeconds?: number;
  /** Warn above this heap usage relative to the V8 limit. Default 0.9. */
  readonly heapWarnRatio?: number;
  /** Resolution of the event loop sampler in milliseconds. Default 20. */
  readonly lagResolutionMs?: number;
}
/**
 * Process metrics of the Node runtime: heap, RSS, CPU, uptime and event loop.
 *
 * Event loop lag and utilization describe the window since the last collect,
 * not the whole process life: the histogram is reset after every read. A lag
 * spike during boot would otherwise stay in the p99 forever.
 */
declare function createRuntimeCollector(options?: RuntimeCollectorOptions): Collector;
//#endregion
//#region src/collectors/system.d.ts
interface SystemCollectorOptions {
  /** Emit the system warnings. Default true. */
  readonly warnings?: boolean;
  /** Warn above this memory usage. Default 0.9. */
  readonly memoryWarnRatio?: number;
  /** Warn above this disk usage. Default 0.9. */
  readonly diskWarnRatio?: number;
  /** Warn above this load average per CPU, only outside containers. Default 2. */
  readonly loadWarnPerCpu?: number;
  /** Volume to report, default the working directory of the process. */
  readonly diskPath?: string;
  /** Name of that volume in the device label. Default "project". */
  readonly diskName?: string;
}
/**
 * Memory, CPUs and disk of the environment the process runs in.
 *
 * Inside a container these are the limits of the container, read from cgroup
 * v2 and v1. /proc/meminfo would report the host, which says nothing about
 * the project. The load average is only reported where it belongs to this
 * process: /proc/loadavg is the host's load in every container.
 */
declare function createSystemCollector(options?: SystemCollectorOptions): Collector;
//#endregion
export { Warning as _, ErrorCollector as a, Collector as c, HealthConfig as d, HealthPayload as f, Sample as g, MetricType as h, createRuntimeCollector as i, CollectorResult as l, Metric as m, createSystemCollector as n, ErrorEvent as o, HealthStatus as p, RuntimeCollectorOptions as r, createErrorCollector as s, SystemCollectorOptions as t, Health as u };