import { readFile, statfs } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import type { Collector, CollectorResult, Metric, Sample, Warning } from "../types.ts";
import { formatPercent, warning } from "../warnings.ts";

export interface SystemCollectorOptions {
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

const CGROUP_V2 = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY = "/sys/fs/cgroup/memory";
const CGROUP_V1_CPU = "/sys/fs/cgroup/cpu";

type MemorySource = "cgroup-v2" | "cgroup-v1" | "host";

interface Memory {
	readonly totalBytes: number;
	readonly availableBytes: number;
	readonly usedRatio: number;
	readonly source: MemorySource;
}

interface Disk {
	readonly totalBytes: number;
	readonly freeBytes: number;
	readonly usedRatio: number;
}

/**
 * Memory, CPUs and disk of the environment the process runs in.
 *
 * Inside a container these are the limits of the container, read from cgroup
 * v2 and v1. /proc/meminfo would report the host, which says nothing about
 * the project. The load average is only reported where it belongs to this
 * process: /proc/loadavg is the host's load in every container.
 */
export function createSystemCollector(options: SystemCollectorOptions = {}): Collector {
	const emitWarnings = options.warnings ?? true;
	const memoryWarnRatio = options.memoryWarnRatio ?? 0.9;
	const diskWarnRatio = options.diskWarnRatio ?? 0.9;
	const loadWarnPerCpu = options.loadWarnPerCpu ?? 2;
	const diskPath = options.diskPath ?? process.cwd();
	const diskName = options.diskName ?? "project";

	return {
		area: "system",

		async collect(): Promise<CollectorResult> {
			const [memory, cpus, disk, contained] = await Promise.all([
				readMemory(),
				readCpus(),
				readDisk(diskPath),
				isContained(),
			]);
			// Host load in a container describes other people's work, not ours.
			const load = contained ? undefined : loadavg();

			const warnings: Warning[] = [];
			if (emitWarnings && memory !== undefined && memory.usedRatio >= memoryWarnRatio) {
				warnings.push(
					warning("system.memory_high", `Memory usage at ${formatPercent(memory.usedRatio)}`),
				);
			}
			if (emitWarnings && disk !== undefined && disk.usedRatio >= diskWarnRatio) {
				warnings.push(
					warning(
						`system.disk_high.${diskName}`,
						`Disk "${diskName}" at ${formatPercent(disk.usedRatio)}`,
					),
				);
			}
			const load5m = load?.[1];
			if (emitWarnings && load5m !== undefined && cpus > 0 && load5m / cpus >= loadWarnPerCpu) {
				warnings.push(
					warning(
						"system.load_high",
						`Load average ${load5m.toFixed(2)} on ${cpus} ${cpus === 1 ? "CPU" : "CPUs"}`,
					),
				);
			}

			const diskLabels = { device: diskName };
			const metrics: Metric[] = [
				{
					name: "system_cpus",
					type: "gauge",
					help: "CPUs available to the process, the cgroup quota where one is set.",
					samples: cpus > 0 ? [{ value: cpus }] : [],
				},
				{
					name: "system_memory_total_bytes",
					type: "gauge",
					help: "Total memory, the cgroup limit inside a container.",
					samples: sample(memory?.totalBytes),
				},
				{
					name: "system_memory_available_bytes",
					type: "gauge",
					help: "Memory still available, reclaimable page cache included.",
					samples: sample(memory?.availableBytes),
				},
				{
					name: "system_memory_used_ratio",
					type: "gauge",
					help: "Used memory relative to total.",
					samples: sample(memory?.usedRatio),
				},
				{
					name: "system_load_average",
					type: "gauge",
					help: "System load average, absent inside a container where it describes the host.",
					samples:
						load === undefined
							? []
							: [
									{ labels: { period: "1m" }, value: round(load[0]) },
									{ labels: { period: "5m" }, value: round(load[1]) },
									{ labels: { period: "15m" }, value: round(load[2]) },
								],
				},
				{
					name: "system_disk_total_bytes",
					type: "gauge",
					help: "Disk size.",
					samples: sample(disk?.totalBytes, diskLabels),
				},
				{
					name: "system_disk_free_bytes",
					type: "gauge",
					help: "Free disk space.",
					samples: sample(disk?.freeBytes, diskLabels),
				},
				{
					name: "system_disk_used_ratio",
					type: "gauge",
					help: "Used disk space relative to size.",
					samples: sample(disk?.usedRatio, diskLabels),
				},
			];

			if (memory === undefined && cpus === 0 && disk === undefined) {
				return { json: null };
			}

			return {
				metrics,
				warnings,
				json: {
					contained,
					cpus: cpus > 0 ? cpus : null,
					loadAverage:
						load === undefined
							? null
							: { "1m": round(load[0]), "5m": round(load[1]), "15m": round(load[2]) },
					memory: memory ?? null,
					disk: disk === undefined ? {} : { [diskName]: disk },
				},
			};
		},
	};
}

function sample(value: number | undefined, labels?: Record<string, string>): Sample[] {
	return value === undefined ? [] : [{ labels, value }];
}

function round(value: number | undefined): number {
	return Math.round((value ?? 0) * 100) / 100;
}

/**
 * cgroup v2 first, then v1, then the host. memory.current counts the page
 * cache, which would push a container that reads files to 100 %: inactive
 * file pages are reclaimable and are subtracted.
 */
async function readMemory(): Promise<Memory | undefined> {
	const v2Limit = await readNumber(`${CGROUP_V2}/memory.max`);
	const v2Current = await readNumber(`${CGROUP_V2}/memory.current`);
	if (v2Limit !== undefined && v2Current !== undefined) {
		const inactiveFile = await readStatValue(`${CGROUP_V2}/memory.stat`, "inactive_file");
		return build(v2Limit, Math.max(0, v2Current - (inactiveFile ?? 0)), "cgroup-v2");
	}

	const v1Limit = await readNumber(`${CGROUP_V1_MEMORY}/memory.limit_in_bytes`);
	const v1Current = await readNumber(`${CGROUP_V1_MEMORY}/memory.usage_in_bytes`);
	// An unlimited v1 cgroup reports a number close to 2^63, not a word.
	if (v1Limit !== undefined && v1Current !== undefined && v1Limit < Number.MAX_SAFE_INTEGER) {
		const inactiveFile = await readStatValue(
			`${CGROUP_V1_MEMORY}/memory.stat`,
			"total_inactive_file",
		);
		return build(v1Limit, Math.max(0, v1Current - (inactiveFile ?? 0)), "cgroup-v1");
	}

	// Outside a container: only MemAvailable, which accounts for reclaimable
	// cache. os.freemem() would report 97 % usage on an idle machine and warn
	// about it, because every cached page counts as used.
	const meminfo = await readMeminfo();
	if (meminfo !== undefined) {
		return build(meminfo.total, meminfo.total - meminfo.available, "host");
	}
	return undefined;

	function build(totalBytes: number, usedBytes: number, source: MemorySource): Memory {
		return {
			totalBytes,
			availableBytes: Math.max(0, totalBytes - usedBytes),
			usedRatio: Math.round(Math.min(1, usedBytes / totalBytes) * 1000) / 1000,
			source,
		};
	}
}

/** Linux only: macOS has no /proc, so a dev machine reports no memory at all. */
async function readMeminfo(): Promise<{ total: number; available: number } | undefined> {
	const text = await readText("/proc/meminfo");
	if (text === undefined) {
		return undefined;
	}
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined) {
			values.set(match[1], Number(match[2]) * 1024);
		}
	}
	const total = values.get("MemTotal");
	const available = values.get("MemAvailable");
	return total !== undefined && total > 0 && available !== undefined
		? { total, available }
		: undefined;
}

/** The cgroup CPU quota where one is set, otherwise the visible CPUs. */
async function readCpus(): Promise<number> {
	const v2 = await readText(`${CGROUP_V2}/cpu.max`);
	if (v2 !== undefined) {
		const [quota, period] = v2.trim().split(/\s+/);
		if (quota !== undefined && quota !== "max" && period !== undefined) {
			const cpus = Number(quota) / Number(period);
			if (Number.isFinite(cpus) && cpus > 0) {
				return round(cpus);
			}
		}
	}

	const quota = await readNumber(`${CGROUP_V1_CPU}/cpu.cfs_quota_us`);
	const period = await readNumber(`${CGROUP_V1_CPU}/cpu.cfs_period_us`);
	if (quota !== undefined && quota > 0 && period !== undefined && period > 0) {
		return round(quota / period);
	}

	return availableParallelism();
}

async function readDisk(path: string): Promise<Disk | undefined> {
	try {
		const stats = await statfs(path);
		const blockSize = Number(stats.bsize);
		const totalBytes = Number(stats.blocks) * blockSize;
		const freeBytes = Number(stats.bavail) * blockSize;
		if (totalBytes <= 0) {
			return undefined;
		}
		return {
			totalBytes,
			freeBytes,
			usedRatio: Math.round((1 - freeBytes / totalBytes) * 1000) / 1000,
		};
	} catch {
		return undefined;
	}
}

/** A cgroup limit or the Docker marker file: the load average is the host's. */
async function isContained(): Promise<boolean> {
	if ((await readText("/.dockerenv")) !== undefined) {
		return true;
	}
	const v2 = await readText(`${CGROUP_V2}/memory.max`);
	if (v2 !== undefined) {
		return v2.trim() !== "max";
	}
	const v1 = await readNumber(`${CGROUP_V1_MEMORY}/memory.limit_in_bytes`);
	return v1 !== undefined && v1 < Number.MAX_SAFE_INTEGER;
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function readNumber(path: string): Promise<number | undefined> {
	const text = await readText(path);
	if (text === undefined) {
		return undefined;
	}
	const value = Number(text.trim());
	return Number.isFinite(value) ? value : undefined;
}

async function readStatValue(path: string, key: string): Promise<number | undefined> {
	const text = await readText(path);
	if (text === undefined) {
		return undefined;
	}
	for (const line of text.split("\n")) {
		const [name, value] = line.split(" ");
		if (name === key && value !== undefined) {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : undefined;
		}
	}
	return undefined;
}
