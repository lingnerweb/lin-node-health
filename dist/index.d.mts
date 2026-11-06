import { _ as Warning, a as ErrorCollector, c as Collector, d as HealthConfig, f as HealthPayload, g as Sample, h as MetricType, i as createRuntimeCollector, l as CollectorResult, m as Metric, n as createSystemCollector, o as ErrorEvent, p as HealthStatus, r as RuntimeCollectorOptions, s as createErrorCollector, t as SystemCollectorOptions, u as Health } from "./system-CBZxTpSC.mjs";

//#region src/health.d.ts
/** Version of CONTRACT.md this implementation fulfills. */
declare const CONTRACT_VERSION = 2;
declare function createHealth(config?: HealthConfig): Health;
/** The JSON format: the general fields, then one key per area. */
declare function toJson(payload: HealthPayload): Record<string, unknown>;
//#endregion
//#region src/prometheus.d.ts
/** Shared by every implementation of the contract, see CONTRACT.md. */
declare const METRIC_PREFIX = "lin_health_";
declare const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
/**
 * Renders the Prometheus text exposition format.
 *
 * Metrics without samples are dropped: a value that cannot be read is absent,
 * not 0. Metrics of the same name are merged, because HELP and TYPE may appear
 * only once per name and all samples of a name have to be adjacent.
 */
declare function formatPrometheus(metrics: readonly Metric[]): string;
/**
 * Prometheus reads Go floats: NaN and +Inf are spelled out. Fractions are cut
 * to 12 significant digits, otherwise a division leaves 0.30000000000000004
 * in the output.
 */
declare function formatValue(value: number): string;
//#endregion
//#region src/token.d.ts
/**
 * Authorization and X-Authorization. The second one is required: hosts behind
 * basic auth consume the first, so Prometheus sends the token as
 * X-Authorization.
 */
declare const TOKEN_HEADERS: readonly ["authorization", "x-authorization"];
/** Every bearer token the request carries, in header order. */
declare function readBearerTokens(headers: Headers): string[];
/**
 * Constant time over the token: both sides are hashed first, so the comparison
 * runs over 32 bytes regardless of the presented length and no length leaks.
 */
declare function verifyToken(presented: string, expected: string): boolean;
//#endregion
//#region src/version.d.ts
/**
 * Replaced at build time (tsdown define, see tsdown.config.ts). Running the
 * sources unbuilt reports a development version.
 */
declare const VERSION: string;
//#endregion
//#region src/warnings.d.ts
/**
 * Warnings are the shared alert channel: one rule in the monitoring alerts on
 * every warning of every platform, which is what lets the metrics stay
 * platform-specific. The key has to stay identical while the warning lasts.
 *
 * Neither key nor message may carry hostnames, IP addresses, credentials or
 * paths outside the project.
 */
declare function warning(key: string, message: string): Warning;
/** "92%" from 0.92. Percentages in messages are whole numbers. */
declare function formatPercent(ratio: number): string;
/** "1.5 GB", base 1024, one decimal from a kilobyte on. */
declare function formatBytes(bytes: number): string;
/** "850 ms" below a second, "1.42 s" above. */
declare function formatSeconds(seconds: number): string;
//#endregion
export { CONTRACT_VERSION, type Collector, type CollectorResult, type ErrorCollector, type ErrorEvent, type Health, type HealthConfig, type HealthPayload, type HealthStatus, METRIC_PREFIX, type Metric, type MetricType, PROMETHEUS_CONTENT_TYPE, type RuntimeCollectorOptions, type Sample, type SystemCollectorOptions, TOKEN_HEADERS, VERSION, type Warning, createErrorCollector, createHealth, createRuntimeCollector, createSystemCollector, formatBytes, formatPercent, formatPrometheus, formatSeconds, formatValue, readBearerTokens, toJson, verifyToken, warning };