/**
 * The shapes of the health contract, see CONTRACT.md in lin-grafana-monitoring.
 * Nothing in this file touches Node or a framework.
 */

export type HealthStatus = "ok" | "degraded" | "error";

export type MetricType = "gauge" | "counter";

export interface Sample {
	readonly labels?: Readonly<Record<string, string>>;
	readonly value: number;
}

export interface Metric {
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
export interface Warning {
	readonly key: string;
	readonly message: string;
}

export interface CollectorResult {
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
export interface Collector {
	/** Area of the contract, also the key in the JSON payload. */
	readonly area: string;
	collect(): CollectorResult | Promise<CollectorResult>;
	/** Starts background measurement, called once per process. */
	start?(): void;
	stop?(): void;
}

export interface HealthPayload {
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

export interface HealthConfig {
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

export interface Health {
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
