import {
	type ELDHistogram,
	type EventLoopUtilization,
	monitorEventLoopDelay,
	performance,
} from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type { Collector, CollectorResult, Metric, Warning } from "../types.ts";
import { formatPercent, formatSeconds, warning } from "../warnings.ts";

export interface RuntimeCollectorOptions {
	/** Warn above this event loop lag in seconds, measured as p99. Default 1. */
	readonly lagWarnSeconds?: number;
	/** Warn above this heap usage relative to the V8 limit. Default 0.9. */
	readonly heapWarnRatio?: number;
	/** Resolution of the event loop sampler in milliseconds. Default 20. */
	readonly lagResolutionMs?: number;
}

const NANOSECONDS = 1e9;
const MICROSECONDS = 1e6;

/** Keeps the output readable: nothing here is meaningful below a microsecond. */
function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/**
 * Process metrics of the Node runtime: heap, RSS, CPU, uptime and event loop.
 *
 * Event loop lag and utilization describe the window since the last collect,
 * not the whole process life: the histogram is reset after every read. A lag
 * spike during boot would otherwise stay in the p99 forever.
 */
export function createRuntimeCollector(options: RuntimeCollectorOptions = {}): Collector {
	const lagWarnSeconds = options.lagWarnSeconds ?? 1;
	const heapWarnRatio = options.heapWarnRatio ?? 0.9;
	const resolution = options.lagResolutionMs ?? 20;

	let histogram: ELDHistogram | undefined;
	let lastUtilization: EventLoopUtilization | undefined;

	return {
		area: "runtime",

		start(): void {
			if (histogram !== undefined) {
				return;
			}
			histogram = monitorEventLoopDelay({ resolution });
			histogram.enable();
			lastUtilization = performance.eventLoopUtilization();
		},

		stop(): void {
			histogram?.disable();
			histogram = undefined;
			lastUtilization = undefined;
		},

		collect(): CollectorResult {
			const memory = process.memoryUsage();
			const heap = getHeapStatistics();
			const cpu = process.cpuUsage();
			const uptimeSeconds = round(process.uptime(), 3);
			const heapLimitBytes = heap.heap_size_limit;
			const heapUsedRatio =
				heapLimitBytes > 0 ? round(memory.heapUsed / heapLimitBytes, 4) : undefined;
			const eventLoop = readEventLoop();

			const warnings: Warning[] = [];
			if (heapUsedRatio !== undefined && heapUsedRatio >= heapWarnRatio) {
				warnings.push(
					warning("runtime.heap_high", `Heap at ${formatPercent(heapUsedRatio)} of the V8 limit`),
				);
			}
			if (eventLoop !== undefined && eventLoop.lagP99Seconds >= lagWarnSeconds) {
				warnings.push(
					warning(
						"runtime.event_loop_lag_high",
						`Event loop lag at ${formatSeconds(eventLoop.lagP99Seconds)} (p99)`,
					),
				);
			}

			const metrics: Metric[] = [
				{
					name: "runtime_uptime_seconds",
					type: "gauge",
					help: "Seconds since the Node process started.",
					samples: [{ value: uptimeSeconds }],
				},
				{
					name: "runtime_heap_used_bytes",
					type: "gauge",
					help: "Used V8 heap.",
					samples: [{ value: memory.heapUsed }],
				},
				{
					name: "runtime_heap_total_bytes",
					type: "gauge",
					help: "V8 heap reserved from the operating system.",
					samples: [{ value: memory.heapTotal }],
				},
				{
					name: "runtime_heap_limit_bytes",
					type: "gauge",
					help: "Maximum V8 heap, the process aborts when it is reached.",
					samples: heapLimitBytes > 0 ? [{ value: heapLimitBytes }] : [],
				},
				{
					name: "runtime_heap_used_ratio",
					type: "gauge",
					help: "Used V8 heap relative to the limit.",
					samples: heapUsedRatio === undefined ? [] : [{ value: heapUsedRatio }],
				},
				{
					name: "runtime_rss_bytes",
					type: "gauge",
					help: "Resident set size of the process.",
					samples: [{ value: memory.rss }],
				},
				{
					name: "runtime_external_bytes",
					type: "gauge",
					help: "Memory of C++ objects bound to JavaScript, buffers included.",
					samples: [{ value: memory.external }],
				},
				{
					name: "runtime_cpu_seconds_total",
					type: "counter",
					help: "CPU time of the process since it started.",
					samples: [
						{ labels: { mode: "user" }, value: round(cpu.user / MICROSECONDS, 6) },
						{ labels: { mode: "system" }, value: round(cpu.system / MICROSECONDS, 6) },
					],
				},
				{
					name: "runtime_event_loop_lag_seconds",
					type: "gauge",
					help: "Event loop lag since the last scrape, by percentile.",
					samples:
						eventLoop === undefined
							? []
							: [
									{ labels: { percentile: "50" }, value: eventLoop.lagP50Seconds },
									{ labels: { percentile: "99" }, value: eventLoop.lagP99Seconds },
								],
				},
				{
					name: "runtime_event_loop_lag_max_seconds",
					type: "gauge",
					help: "Longest event loop lag since the last scrape.",
					samples: eventLoop === undefined ? [] : [{ value: eventLoop.lagMaxSeconds }],
				},
				{
					name: "runtime_event_loop_utilization",
					type: "gauge",
					help: "Share of the time the event loop was busy since the last scrape.",
					samples: eventLoop?.utilization === undefined ? [] : [{ value: eventLoop.utilization }],
				},
			];

			return {
				metrics,
				warnings,
				json: {
					uptimeSeconds,
					heap: {
						usedBytes: memory.heapUsed,
						totalBytes: memory.heapTotal,
						limitBytes: heapLimitBytes > 0 ? heapLimitBytes : null,
						usedRatio: heapUsedRatio ?? null,
					},
					rssBytes: memory.rss,
					externalBytes: memory.external,
					cpu: {
						userSeconds: round(cpu.user / MICROSECONDS, 6),
						systemSeconds: round(cpu.system / MICROSECONDS, 6),
					},
					eventLoop:
						eventLoop === undefined
							? null
							: { ...eventLoop, utilization: eventLoop.utilization ?? null },
				},
			};
		},
	};

	function readEventLoop() {
		if (histogram === undefined || histogram.count === 0) {
			return undefined;
		}
		const lagP50Seconds = round(histogram.percentile(50) / NANOSECONDS, 6);
		const lagP99Seconds = round(histogram.percentile(99) / NANOSECONDS, 6);
		const lagMaxSeconds = round(histogram.max / NANOSECONDS, 6);
		histogram.reset();

		let utilization: number | undefined;
		if (lastUtilization !== undefined) {
			utilization = round(performance.eventLoopUtilization(lastUtilization).utilization, 4);
		}
		lastUtilization = performance.eventLoopUtilization();

		return { lagP50Seconds, lagP99Seconds, lagMaxSeconds, utilization };
	}
}
