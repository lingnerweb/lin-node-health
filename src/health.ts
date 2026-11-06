import { hostname as readHostname } from "node:os";
import { formatPrometheus, PROMETHEUS_CONTENT_TYPE } from "./prometheus.ts";
import { readBearerTokens, verifyToken } from "./token.ts";
import type {
	Collector,
	Health,
	HealthConfig,
	HealthPayload,
	HealthStatus,
	Metric,
	Warning,
} from "./types.ts";
import { VERSION } from "./version.ts";
import { warning } from "./warnings.ts";

/** Version of CONTRACT.md this implementation fulfills. */
export const CONTRACT_VERSION = 2;

const DEFAULT_TOKEN_ENV = "HEALTH_ENDPOINT_BEARER";

const STATUS_VALUES: Record<HealthStatus, number> = { ok: 0, degraded: 1, error: 2 };

export function createHealth(config: HealthConfig = {}): Health {
	return new HealthRegistry(config);
}

/**
 * Holds the collectors, turns their results into the two output formats and
 * guards the endpoint with the bearer token.
 */
class HealthRegistry implements Health {
	private readonly collectors: Collector[];
	private readonly token: string;
	private readonly platform: string;
	private readonly info: Readonly<Record<string, string>>;
	private started = false;

	constructor(config: HealthConfig) {
		this.collectors = [...(config.collectors ?? [])];
		this.token = (config.token ?? process.env[config.tokenEnv ?? DEFAULT_TOKEN_ENV] ?? "").trim();
		this.platform = config.platform ?? "node";
		this.info = config.info ?? {};
	}

	get enabled(): boolean {
		return this.token !== "";
	}

	register(collector: Collector): void {
		this.collectors.push(collector);
		if (this.started) {
			collector.start?.();
		}
	}

	start(): void {
		this.started = true;
		for (const collector of this.collectors) {
			collector.start?.();
		}
	}

	stop(): void {
		this.started = false;
		for (const collector of this.collectors) {
			collector.stop?.();
		}
	}

	isAuthorized(headers: Headers): boolean {
		return readBearerTokens(headers).some((presented) => verifyToken(presented, this.token));
	}

	/**
	 * One collector failing must not fail the endpoint: its area stays empty
	 * and shows up as a warning, the rest is reported.
	 */
	async collect(): Promise<HealthPayload> {
		const startedAt = performance.now();
		const results = await Promise.all(
			this.collectors.map(async (collector) => {
				try {
					return { area: collector.area, result: await collector.collect() };
				} catch (error) {
					return {
						area: collector.area,
						result: {
							json: null,
							// The message may carry paths or credentials, the name does not.
							warnings: [
								warning(
									`${collector.area}.collector_failed`,
									`Collecting ${collector.area} failed with ${errorName(error)}`,
								),
							],
						},
					};
				}
			}),
		);

		const warnings: Warning[] = [];
		const areas: Record<string, unknown> = {};
		const areaMetrics: Metric[] = [];
		let fatal = false;

		for (const { area, result } of results) {
			warnings.push(...(result.warnings ?? []));
			areas[area] = result.json ?? null;
			areaMetrics.push(...(result.metrics ?? []));
			fatal ||= result.fatal === true;
		}

		const status: HealthStatus = fatal ? "error" : warnings.length > 0 ? "degraded" : "ok";
		const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

		return {
			status,
			contract: CONTRACT_VERSION,
			version: VERSION,
			platform: this.platform,
			warnings,
			hostname: readHostname(),
			time: new Date().toISOString(),
			durationMs,
			info: this.info,
			areas,
			metrics: [...this.generalMetrics(status, warnings, durationMs), ...areaMetrics],
		};
	}

	async handle(request: Request): Promise<Response | null> {
		if (!this.enabled) {
			return null;
		}
		if (!this.isAuthorized(request.headers)) {
			return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
		}

		const payload = await this.collect();
		if (new URL(request.url).searchParams.get("format") === "prometheus") {
			// Always 200: Prometheus drops the body of non-2xx responses, which
			// would throw away exactly the metrics describing the failure.
			return new Response(formatPrometheus(payload.metrics), {
				status: 200,
				headers: { "Content-Type": PROMETHEUS_CONTENT_TYPE, "Cache-Control": "no-store" },
			});
		}
		return json(toJson(payload), payload.status === "error" ? 503 : 200);
	}

	private generalMetrics(
		status: HealthStatus,
		warnings: readonly Warning[],
		durationMs: number,
	): Metric[] {
		return [
			{
				name: "status",
				type: "gauge",
				help: "Overall status: 0 ok, 1 degraded, 2 error.",
				samples: [{ value: STATUS_VALUES[status] }],
			},
			{
				name: "info",
				type: "gauge",
				help: "Implementation information, the value is always 1.",
				samples: [
					{
						labels: {
							contract: String(CONTRACT_VERSION),
							version: VERSION,
							platform: this.platform,
							hostname: readHostname(),
							...this.info,
						},
						value: 1,
					},
				],
			},
			{
				name: "warnings",
				type: "gauge",
				help: "Number of active warnings.",
				samples: [{ value: warnings.length }],
			},
			{
				name: "warning",
				type: "gauge",
				help: "One series per active warning. The key identifies the warning, the message carries the current values.",
				samples: warnings.map((entry) => ({
					labels: { key: entry.key, message: entry.message },
					value: 1,
				})),
			},
			{
				name: "duration_seconds",
				type: "gauge",
				help: "Time spent collecting the health data.",
				samples: [{ value: durationMs / 1000 }],
			},
		];
	}
}

/** The JSON format: the general fields, then one key per area. */
export function toJson(payload: HealthPayload): Record<string, unknown> {
	return {
		status: payload.status,
		contract: payload.contract,
		version: payload.version,
		platform: payload.platform,
		warnings: payload.warnings,
		hostname: payload.hostname,
		time: payload.time,
		durationMs: payload.durationMs,
		...payload.areas,
	};
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...headers,
		},
	});
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}
