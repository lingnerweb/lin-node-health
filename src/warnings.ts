import type { Warning } from "./types.ts";

/**
 * Warnings are the shared alert channel: one rule in the monitoring alerts on
 * every warning of every platform, which is what lets the metrics stay
 * platform-specific. The key has to stay identical while the warning lasts.
 *
 * Neither key nor message may carry hostnames, IP addresses, credentials or
 * paths outside the project.
 */
export function warning(key: string, message: string): Warning {
	return { key, message };
}

/** "92%" from 0.92. Percentages in messages are whole numbers. */
export function formatPercent(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

/** "1.5 GB", base 1024, one decimal from a kilobyte on. */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** "850 ms" below a second, "1.42 s" above. */
export function formatSeconds(seconds: number): string {
	return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`;
}
