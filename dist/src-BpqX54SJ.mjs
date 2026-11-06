import { monitorEventLoopDelay, performance as performance$1 } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { readFile, statfs } from "node:fs/promises";
import { availableParallelism, hostname, loadavg } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";

//#region src/collectors/errors.ts
/** The contract counts the last 24 hours. */
const WINDOW_MINUTES = 1440;
const WINDOW_SECONDS = WINDOW_MINUTES * 60;
const SEPARATOR = "\0";
/**
* Counts server errors of the last 24 hours in memory.
*
* The counts come from the application, not from a log store, so the dashboard
* still works when log shipping is broken. They restart with the process, like
* every other runtime metric here.
*/
function createErrorCollector() {
	const entries = new MinuteWindow();
	const pages = new MinuteWindow();
	entries.seed(key("app", "error"));
	pages.seed("page");
	return {
		area: "log",
		record(event = {}) {
			entries.add(key(event.log ?? "app", event.level ?? "error"));
			if (event.errorPage !== void 0) pages.add(event.errorPage);
		},
		collect() {
			const entryTotals = entries.totals();
			const pageTotals = pages.totals();
			return {
				metrics: [{
					name: "log_entries",
					type: "gauge",
					help: "Server errors of the last 24 hours by log and level.",
					samples: [...entryTotals].map(([combined, value]) => {
						const [log = "app", level = "error"] = combined.split(SEPARATOR);
						return {
							labels: {
								log,
								level
							},
							value
						};
					})
				}, {
					name: "log_error_pages",
					type: "gauge",
					help: "Error pages of the last 24 hours: page is a request that ended in an error page, content a single element that failed.",
					samples: [...pageTotals].map(([type, value]) => ({
						labels: { type },
						value
					}))
				}],
				json: {
					windowSeconds: WINDOW_SECONDS,
					entries: groupEntries(entryTotals),
					errorPages: Object.fromEntries(pageTotals)
				}
			};
		}
	};
}
function key(log, level) {
	return `${log}${SEPARATOR}${level}`;
}
function groupEntries(totals) {
	const grouped = {};
	for (const [combined, value] of totals) {
		const [log = "app", level = "error"] = combined.split(SEPARATOR);
		const levels = grouped[log] ?? {};
		levels[level] = value;
		grouped[log] = levels;
	}
	return grouped;
}
/**
* A ring of one bucket per minute. Expired buckets are dropped on access, so
* an idle process holds nothing and a busy one holds at most 24 hours of keys.
*/
var MinuteWindow = class {
	buckets = new Array(WINDOW_MINUTES);
	seeded = /* @__PURE__ */ new Set();
	lastMinute = currentMinute();
	seed(key$1) {
		this.seeded.add(key$1);
	}
	add(key$1) {
		this.rotate();
		const index = this.lastMinute % WINDOW_MINUTES;
		const bucket = this.buckets[index] ?? /* @__PURE__ */ new Map();
		bucket.set(key$1, (bucket.get(key$1) ?? 0) + 1);
		this.buckets[index] = bucket;
	}
	totals() {
		this.rotate();
		const totals = /* @__PURE__ */ new Map();
		for (const key$1 of this.seeded) totals.set(key$1, 0);
		for (const bucket of this.buckets) {
			if (bucket === void 0) continue;
			for (const [key$1, value] of bucket) totals.set(key$1, (totals.get(key$1) ?? 0) + value);
		}
		return totals;
	}
	rotate() {
		const now = currentMinute();
		if (now === this.lastMinute) return;
		const elapsed = Math.min(now - this.lastMinute, WINDOW_MINUTES);
		for (let step = 1; step <= elapsed; step += 1) this.buckets[(this.lastMinute + step) % WINDOW_MINUTES] = void 0;
		this.lastMinute = now;
	}
};
function currentMinute() {
	return Math.floor(Date.now() / 6e4);
}

//#endregion
//#region src/warnings.ts
/**
* Warnings are the shared alert channel: one rule in the monitoring alerts on
* every warning of every platform, which is what lets the metrics stay
* platform-specific. The key has to stay identical while the warning lasts.
*
* Neither key nor message may carry hostnames, IP addresses, credentials or
* paths outside the project.
*/
function warning(key$1, message) {
	return {
		key: key$1,
		message
	};
}
/** "92%" from 0.92. Percentages in messages are whole numbers. */
function formatPercent(ratio) {
	return `${Math.round(ratio * 100)}%`;
}
/** "1.5 GB", base 1024, one decimal from a kilobyte on. */
function formatBytes(bytes) {
	const units = [
		"B",
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}
/** "850 ms" below a second, "1.42 s" above. */
function formatSeconds(seconds) {
	return seconds < 1 ? `${Math.round(seconds * 1e3)} ms` : `${seconds.toFixed(2)} s`;
}

//#endregion
//#region src/collectors/runtime.ts
const NANOSECONDS = 1e9;
const MICROSECONDS = 1e6;
/** Keeps the output readable: nothing here is meaningful below a microsecond. */
function round$1(value, digits) {
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
function createRuntimeCollector(options = {}) {
	const lagWarnSeconds = options.lagWarnSeconds ?? 1;
	const heapWarnRatio = options.heapWarnRatio ?? .9;
	const resolution = options.lagResolutionMs ?? 20;
	let histogram;
	let lastUtilization;
	return {
		area: "runtime",
		start() {
			if (histogram !== void 0) return;
			histogram = monitorEventLoopDelay({ resolution });
			histogram.enable();
			lastUtilization = performance$1.eventLoopUtilization();
		},
		stop() {
			histogram?.disable();
			histogram = void 0;
			lastUtilization = void 0;
		},
		collect() {
			const memory = process.memoryUsage();
			const heap = getHeapStatistics();
			const cpu = process.cpuUsage();
			const uptimeSeconds = round$1(process.uptime(), 3);
			const heapLimitBytes = heap.heap_size_limit;
			const heapUsedRatio = heapLimitBytes > 0 ? round$1(memory.heapUsed / heapLimitBytes, 4) : void 0;
			const eventLoop = readEventLoop();
			const warnings = [];
			if (heapUsedRatio !== void 0 && heapUsedRatio >= heapWarnRatio) warnings.push(warning("runtime.heap_high", `Heap at ${formatPercent(heapUsedRatio)} of the V8 limit`));
			if (eventLoop !== void 0 && eventLoop.lagP99Seconds >= lagWarnSeconds) warnings.push(warning("runtime.event_loop_lag_high", `Event loop lag at ${formatSeconds(eventLoop.lagP99Seconds)} (p99)`));
			return {
				metrics: [
					{
						name: "runtime_uptime_seconds",
						type: "gauge",
						help: "Seconds since the Node process started.",
						samples: [{ value: uptimeSeconds }]
					},
					{
						name: "runtime_heap_used_bytes",
						type: "gauge",
						help: "Used V8 heap.",
						samples: [{ value: memory.heapUsed }]
					},
					{
						name: "runtime_heap_total_bytes",
						type: "gauge",
						help: "V8 heap reserved from the operating system.",
						samples: [{ value: memory.heapTotal }]
					},
					{
						name: "runtime_heap_limit_bytes",
						type: "gauge",
						help: "Maximum V8 heap, the process aborts when it is reached.",
						samples: heapLimitBytes > 0 ? [{ value: heapLimitBytes }] : []
					},
					{
						name: "runtime_heap_used_ratio",
						type: "gauge",
						help: "Used V8 heap relative to the limit.",
						samples: heapUsedRatio === void 0 ? [] : [{ value: heapUsedRatio }]
					},
					{
						name: "runtime_rss_bytes",
						type: "gauge",
						help: "Resident set size of the process.",
						samples: [{ value: memory.rss }]
					},
					{
						name: "runtime_external_bytes",
						type: "gauge",
						help: "Memory of C++ objects bound to JavaScript, buffers included.",
						samples: [{ value: memory.external }]
					},
					{
						name: "runtime_cpu_seconds_total",
						type: "counter",
						help: "CPU time of the process since it started.",
						samples: [{
							labels: { mode: "user" },
							value: round$1(cpu.user / MICROSECONDS, 6)
						}, {
							labels: { mode: "system" },
							value: round$1(cpu.system / MICROSECONDS, 6)
						}]
					},
					{
						name: "runtime_event_loop_lag_seconds",
						type: "gauge",
						help: "Event loop lag since the last scrape, by percentile.",
						samples: eventLoop === void 0 ? [] : [{
							labels: { percentile: "50" },
							value: eventLoop.lagP50Seconds
						}, {
							labels: { percentile: "99" },
							value: eventLoop.lagP99Seconds
						}]
					},
					{
						name: "runtime_event_loop_lag_max_seconds",
						type: "gauge",
						help: "Longest event loop lag since the last scrape.",
						samples: eventLoop === void 0 ? [] : [{ value: eventLoop.lagMaxSeconds }]
					},
					{
						name: "runtime_event_loop_utilization",
						type: "gauge",
						help: "Share of the time the event loop was busy since the last scrape.",
						samples: eventLoop?.utilization === void 0 ? [] : [{ value: eventLoop.utilization }]
					}
				],
				warnings,
				json: {
					uptimeSeconds,
					heap: {
						usedBytes: memory.heapUsed,
						totalBytes: memory.heapTotal,
						limitBytes: heapLimitBytes > 0 ? heapLimitBytes : null,
						usedRatio: heapUsedRatio ?? null
					},
					rssBytes: memory.rss,
					externalBytes: memory.external,
					cpu: {
						userSeconds: round$1(cpu.user / MICROSECONDS, 6),
						systemSeconds: round$1(cpu.system / MICROSECONDS, 6)
					},
					eventLoop: eventLoop === void 0 ? null : {
						...eventLoop,
						utilization: eventLoop.utilization ?? null
					}
				}
			};
		}
	};
	function readEventLoop() {
		if (histogram === void 0 || histogram.count === 0) return;
		const lagP50Seconds = round$1(histogram.percentile(50) / NANOSECONDS, 6);
		const lagP99Seconds = round$1(histogram.percentile(99) / NANOSECONDS, 6);
		const lagMaxSeconds = round$1(histogram.max / NANOSECONDS, 6);
		histogram.reset();
		let utilization;
		if (lastUtilization !== void 0) utilization = round$1(performance$1.eventLoopUtilization(lastUtilization).utilization, 4);
		lastUtilization = performance$1.eventLoopUtilization();
		return {
			lagP50Seconds,
			lagP99Seconds,
			lagMaxSeconds,
			utilization
		};
	}
}

//#endregion
//#region src/collectors/system.ts
const CGROUP_V2 = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY = "/sys/fs/cgroup/memory";
const CGROUP_V1_CPU = "/sys/fs/cgroup/cpu";
/**
* Memory, CPUs and disk of the environment the process runs in.
*
* Inside a container these are the limits of the container, read from cgroup
* v2 and v1. /proc/meminfo would report the host, which says nothing about
* the project. The load average is only reported where it belongs to this
* process: /proc/loadavg is the host's load in every container.
*/
function createSystemCollector(options = {}) {
	const emitWarnings = options.warnings ?? true;
	const memoryWarnRatio = options.memoryWarnRatio ?? .9;
	const diskWarnRatio = options.diskWarnRatio ?? .9;
	const loadWarnPerCpu = options.loadWarnPerCpu ?? 2;
	const diskPath = options.diskPath ?? process.cwd();
	const diskName = options.diskName ?? "project";
	return {
		area: "system",
		async collect() {
			const [memory, cpus, disk, contained] = await Promise.all([
				readMemory(),
				readCpus(),
				readDisk(diskPath),
				isContained()
			]);
			const load = contained ? void 0 : loadavg();
			const warnings = [];
			if (emitWarnings && memory !== void 0 && memory.usedRatio >= memoryWarnRatio) warnings.push(warning("system.memory_high", `Memory usage at ${formatPercent(memory.usedRatio)}`));
			if (emitWarnings && disk !== void 0 && disk.usedRatio >= diskWarnRatio) warnings.push(warning(`system.disk_high.${diskName}`, `Disk "${diskName}" at ${formatPercent(disk.usedRatio)}`));
			const load5m = load?.[1];
			if (emitWarnings && load5m !== void 0 && cpus > 0 && load5m / cpus >= loadWarnPerCpu) warnings.push(warning("system.load_high", `Load average ${load5m.toFixed(2)} on ${cpus} ${cpus === 1 ? "CPU" : "CPUs"}`));
			const diskLabels = { device: diskName };
			const metrics = [
				{
					name: "system_cpus",
					type: "gauge",
					help: "CPUs available to the process, the cgroup quota where one is set.",
					samples: cpus > 0 ? [{ value: cpus }] : []
				},
				{
					name: "system_memory_total_bytes",
					type: "gauge",
					help: "Total memory, the cgroup limit inside a container.",
					samples: sample(memory?.totalBytes)
				},
				{
					name: "system_memory_available_bytes",
					type: "gauge",
					help: "Memory still available, reclaimable page cache included.",
					samples: sample(memory?.availableBytes)
				},
				{
					name: "system_memory_used_ratio",
					type: "gauge",
					help: "Used memory relative to total.",
					samples: sample(memory?.usedRatio)
				},
				{
					name: "system_load_average",
					type: "gauge",
					help: "System load average, absent inside a container where it describes the host.",
					samples: load === void 0 ? [] : [
						{
							labels: { period: "1m" },
							value: round(load[0])
						},
						{
							labels: { period: "5m" },
							value: round(load[1])
						},
						{
							labels: { period: "15m" },
							value: round(load[2])
						}
					]
				},
				{
					name: "system_disk_total_bytes",
					type: "gauge",
					help: "Disk size.",
					samples: sample(disk?.totalBytes, diskLabels)
				},
				{
					name: "system_disk_free_bytes",
					type: "gauge",
					help: "Free disk space.",
					samples: sample(disk?.freeBytes, diskLabels)
				},
				{
					name: "system_disk_used_ratio",
					type: "gauge",
					help: "Used disk space relative to size.",
					samples: sample(disk?.usedRatio, diskLabels)
				}
			];
			if (memory === void 0 && cpus === 0 && disk === void 0) return { json: null };
			return {
				metrics,
				warnings,
				json: {
					contained,
					cpus: cpus > 0 ? cpus : null,
					loadAverage: load === void 0 ? null : {
						"1m": round(load[0]),
						"5m": round(load[1]),
						"15m": round(load[2])
					},
					memory: memory ?? null,
					disk: disk === void 0 ? {} : { [diskName]: disk }
				}
			};
		}
	};
}
function sample(value, labels) {
	return value === void 0 ? [] : [{
		labels,
		value
	}];
}
function round(value) {
	return Math.round((value ?? 0) * 100) / 100;
}
/**
* cgroup v2 first, then v1, then the host. memory.current counts the page
* cache, which would push a container that reads files to 100 %: inactive
* file pages are reclaimable and are subtracted.
*/
async function readMemory() {
	const v2Limit = await readNumber(`${CGROUP_V2}/memory.max`);
	const v2Current = await readNumber(`${CGROUP_V2}/memory.current`);
	if (v2Limit !== void 0 && v2Current !== void 0) {
		const inactiveFile = await readStatValue(`${CGROUP_V2}/memory.stat`, "inactive_file");
		return build(v2Limit, Math.max(0, v2Current - (inactiveFile ?? 0)), "cgroup-v2");
	}
	const v1Limit = await readNumber(`${CGROUP_V1_MEMORY}/memory.limit_in_bytes`);
	const v1Current = await readNumber(`${CGROUP_V1_MEMORY}/memory.usage_in_bytes`);
	if (v1Limit !== void 0 && v1Current !== void 0 && v1Limit < Number.MAX_SAFE_INTEGER) {
		const inactiveFile = await readStatValue(`${CGROUP_V1_MEMORY}/memory.stat`, "total_inactive_file");
		return build(v1Limit, Math.max(0, v1Current - (inactiveFile ?? 0)), "cgroup-v1");
	}
	const meminfo = await readMeminfo();
	if (meminfo !== void 0) return build(meminfo.total, meminfo.total - meminfo.available, "host");
	return;
	function build(totalBytes, usedBytes, source) {
		return {
			totalBytes,
			availableBytes: Math.max(0, totalBytes - usedBytes),
			usedRatio: Math.round(Math.min(1, usedBytes / totalBytes) * 1e3) / 1e3,
			source
		};
	}
}
/** Linux only: macOS has no /proc, so a dev machine reports no memory at all. */
async function readMeminfo() {
	const text = await readText("/proc/meminfo");
	if (text === void 0) return;
	const values = /* @__PURE__ */ new Map();
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line);
		if (match?.[1] !== void 0 && match[2] !== void 0) values.set(match[1], Number(match[2]) * 1024);
	}
	const total = values.get("MemTotal");
	const available = values.get("MemAvailable");
	return total !== void 0 && total > 0 && available !== void 0 ? {
		total,
		available
	} : void 0;
}
/** The cgroup CPU quota where one is set, otherwise the visible CPUs. */
async function readCpus() {
	const v2 = await readText(`${CGROUP_V2}/cpu.max`);
	if (v2 !== void 0) {
		const [quota$1, period$1] = v2.trim().split(/\s+/);
		if (quota$1 !== void 0 && quota$1 !== "max" && period$1 !== void 0) {
			const cpus = Number(quota$1) / Number(period$1);
			if (Number.isFinite(cpus) && cpus > 0) return round(cpus);
		}
	}
	const quota = await readNumber(`${CGROUP_V1_CPU}/cpu.cfs_quota_us`);
	const period = await readNumber(`${CGROUP_V1_CPU}/cpu.cfs_period_us`);
	if (quota !== void 0 && quota > 0 && period !== void 0 && period > 0) return round(quota / period);
	return availableParallelism();
}
async function readDisk(path) {
	try {
		const stats = await statfs(path);
		const blockSize = Number(stats.bsize);
		const totalBytes = Number(stats.blocks) * blockSize;
		const freeBytes = Number(stats.bavail) * blockSize;
		if (totalBytes <= 0) return;
		return {
			totalBytes,
			freeBytes,
			usedRatio: Math.round((1 - freeBytes / totalBytes) * 1e3) / 1e3
		};
	} catch {
		return;
	}
}
/** A cgroup limit or the Docker marker file: the load average is the host's. */
async function isContained() {
	if (await readText("/.dockerenv") !== void 0) return true;
	const v2 = await readText(`${CGROUP_V2}/memory.max`);
	if (v2 !== void 0) return v2.trim() !== "max";
	const v1 = await readNumber(`${CGROUP_V1_MEMORY}/memory.limit_in_bytes`);
	return v1 !== void 0 && v1 < Number.MAX_SAFE_INTEGER;
}
async function readText(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return;
	}
}
async function readNumber(path) {
	const text = await readText(path);
	if (text === void 0) return;
	const value = Number(text.trim());
	return Number.isFinite(value) ? value : void 0;
}
async function readStatValue(path, key$1) {
	const text = await readText(path);
	if (text === void 0) return;
	for (const line of text.split("\n")) {
		const [name, value] = line.split(" ");
		if (name === key$1 && value !== void 0) {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : void 0;
		}
	}
}

//#endregion
//#region src/prometheus.ts
/** Shared by every implementation of the contract, see CONTRACT.md. */
const METRIC_PREFIX = "lin_health_";
const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
/**
* Renders the Prometheus text exposition format.
*
* Metrics without samples are dropped: a value that cannot be read is absent,
* not 0. Metrics of the same name are merged, because HELP and TYPE may appear
* only once per name and all samples of a name have to be adjacent.
*/
function formatPrometheus(metrics) {
	const merged = /* @__PURE__ */ new Map();
	for (const metric of metrics) {
		if (metric.samples.length === 0) continue;
		const existing = merged.get(metric.name);
		if (existing === void 0) merged.set(metric.name, {
			metric,
			samples: [...metric.samples]
		});
		else existing.samples.push(...metric.samples);
	}
	const lines = [];
	for (const [name, { metric, samples }] of merged) {
		const fullName = METRIC_PREFIX + name;
		lines.push(`# HELP ${fullName} ${escapeHelp(metric.help)}`);
		lines.push(`# TYPE ${fullName} ${metric.type}`);
		for (const sample$1 of samples) lines.push(`${fullName}${formatLabels(sample$1.labels)} ${formatValue(sample$1.value)}`);
	}
	return `${lines.join("\n")}\n`;
}
function formatLabels(labels) {
	if (labels === void 0) return "";
	const pairs = Object.entries(labels).map(([key$1, value]) => `${key$1}="${escapeLabel(value)}"`);
	return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}
function escapeLabel(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}
function escapeHelp(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}
/**
* Prometheus reads Go floats: NaN and +Inf are spelled out. Fractions are cut
* to 12 significant digits, otherwise a division leaves 0.30000000000000004
* in the output.
*/
function formatValue(value) {
	if (Number.isNaN(value)) return "NaN";
	if (value === Number.POSITIVE_INFINITY) return "+Inf";
	if (value === Number.NEGATIVE_INFINITY) return "-Inf";
	if (Number.isInteger(value)) return String(value);
	return String(Number(value.toPrecision(12)));
}

//#endregion
//#region src/token.ts
const BEARER = /^Bearer\s+(.+)$/i;
/**
* Authorization and X-Authorization. The second one is required: hosts behind
* basic auth consume the first, so Prometheus sends the token as
* X-Authorization.
*/
const TOKEN_HEADERS = ["authorization", "x-authorization"];
/** Every bearer token the request carries, in header order. */
function readBearerTokens(headers) {
	const tokens = [];
	for (const name of TOKEN_HEADERS) {
		const value = headers.get(name);
		const match = value === null ? null : BEARER.exec(value);
		if (match?.[1] !== void 0) tokens.push(match[1].trim());
	}
	return tokens;
}
/**
* Constant time over the token: both sides are hashed first, so the comparison
* runs over 32 bytes regardless of the presented length and no length leaks.
*/
function verifyToken(presented, expected) {
	if (expected === "") return false;
	return timingSafeEqual(sha256(presented), sha256(expected));
}
function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest();
}

//#endregion
//#region src/version.ts
/**
* Replaced at build time (tsdown define, see tsdown.config.ts). Running the
* sources unbuilt reports a development version.
*/
const VERSION = "0.1.0";

//#endregion
//#region src/health.ts
/** Version of CONTRACT.md this implementation fulfills. */
const CONTRACT_VERSION = 2;
const DEFAULT_TOKEN_ENV = "HEALTH_ENDPOINT_BEARER";
const STATUS_VALUES = {
	ok: 0,
	degraded: 1,
	error: 2
};
function createHealth(config = {}) {
	return new HealthRegistry(config);
}
/**
* Holds the collectors, turns their results into the two output formats and
* guards the endpoint with the bearer token.
*/
var HealthRegistry = class {
	collectors;
	token;
	platform;
	info;
	started = false;
	constructor(config) {
		this.collectors = [...config.collectors ?? []];
		this.token = (config.token ?? process.env[config.tokenEnv ?? DEFAULT_TOKEN_ENV] ?? "").trim();
		this.platform = config.platform ?? "node";
		this.info = config.info ?? {};
	}
	get enabled() {
		return this.token !== "";
	}
	register(collector) {
		this.collectors.push(collector);
		if (this.started) collector.start?.();
	}
	start() {
		this.started = true;
		for (const collector of this.collectors) collector.start?.();
	}
	stop() {
		this.started = false;
		for (const collector of this.collectors) collector.stop?.();
	}
	isAuthorized(headers) {
		return readBearerTokens(headers).some((presented) => verifyToken(presented, this.token));
	}
	/**
	* One collector failing must not fail the endpoint: its area stays empty
	* and shows up as a warning, the rest is reported.
	*/
	async collect() {
		const startedAt = performance.now();
		const results = await Promise.all(this.collectors.map(async (collector) => {
			try {
				return {
					area: collector.area,
					result: await collector.collect()
				};
			} catch (error) {
				return {
					area: collector.area,
					result: {
						json: null,
						warnings: [warning(`${collector.area}.collector_failed`, `Collecting ${collector.area} failed with ${errorName(error)}`)]
					}
				};
			}
		}));
		const warnings = [];
		const areas = {};
		const areaMetrics = [];
		let fatal = false;
		for (const { area, result } of results) {
			warnings.push(...result.warnings ?? []);
			areas[area] = result.json ?? null;
			areaMetrics.push(...result.metrics ?? []);
			fatal ||= result.fatal === true;
		}
		const status = fatal ? "error" : warnings.length > 0 ? "degraded" : "ok";
		const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
		return {
			status,
			contract: CONTRACT_VERSION,
			version: VERSION,
			platform: this.platform,
			warnings,
			hostname: hostname(),
			time: (/* @__PURE__ */ new Date()).toISOString(),
			durationMs,
			info: this.info,
			areas,
			metrics: [...this.generalMetrics(status, warnings, durationMs), ...areaMetrics]
		};
	}
	async handle(request) {
		if (!this.enabled) return null;
		if (!this.isAuthorized(request.headers)) return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
		if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
		const payload = await this.collect();
		if (new URL(request.url).searchParams.get("format") === "prometheus") return new Response(formatPrometheus(payload.metrics), {
			status: 200,
			headers: {
				"Content-Type": PROMETHEUS_CONTENT_TYPE,
				"Cache-Control": "no-store"
			}
		});
		return json(toJson(payload), payload.status === "error" ? 503 : 200);
	}
	generalMetrics(status, warnings, durationMs) {
		return [
			{
				name: "status",
				type: "gauge",
				help: "Overall status: 0 ok, 1 degraded, 2 error.",
				samples: [{ value: STATUS_VALUES[status] }]
			},
			{
				name: "info",
				type: "gauge",
				help: "Implementation information, the value is always 1.",
				samples: [{
					labels: {
						contract: String(CONTRACT_VERSION),
						version: VERSION,
						platform: this.platform,
						hostname: hostname(),
						...this.info
					},
					value: 1
				}]
			},
			{
				name: "warnings",
				type: "gauge",
				help: "Number of active warnings.",
				samples: [{ value: warnings.length }]
			},
			{
				name: "warning",
				type: "gauge",
				help: "One series per active warning. The key identifies the warning, the message carries the current values.",
				samples: warnings.map((entry) => ({
					labels: {
						key: entry.key,
						message: entry.message
					},
					value: 1
				}))
			},
			{
				name: "duration_seconds",
				type: "gauge",
				help: "Time spent collecting the health data.",
				samples: [{ value: durationMs / 1e3 }]
			}
		];
	}
};
/** The JSON format: the general fields, then one key per area. */
function toJson(payload) {
	return {
		status: payload.status,
		contract: payload.contract,
		version: payload.version,
		platform: payload.platform,
		warnings: payload.warnings,
		hostname: payload.hostname,
		time: payload.time,
		durationMs: payload.durationMs,
		...payload.areas
	};
}
function json(body, status, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...headers
		}
	});
}
function errorName(error) {
	return error instanceof Error ? error.name : typeof error;
}

//#endregion
export { warning as _, TOKEN_HEADERS as a, METRIC_PREFIX as c, formatValue as d, createSystemCollector as f, formatSeconds as g, formatPercent as h, VERSION as i, PROMETHEUS_CONTENT_TYPE as l, formatBytes as m, createHealth as n, readBearerTokens as o, createRuntimeCollector as p, toJson as r, verifyToken as s, CONTRACT_VERSION as t, formatPrometheus as u, createErrorCollector as v };