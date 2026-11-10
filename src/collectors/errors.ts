import type { Collector, CollectorResult, Metric } from "../types.ts";

/** The contract counts the last 24 hours. */
const WINDOW_MINUTES = 1440;
const WINDOW_SECONDS = WINDOW_MINUTES * 60;
const SEPARATOR = "\u0000";

export interface ErrorEvent {
	/**
	 * What the visitor got: "page" means an error page was served, "content"
	 * means one element failed while the page rendered.
	 */
	readonly errorPage?: "page" | "content";
	/**
	 * Which log the entry belongs to, default "app".
	 *
	 * Both this and level have to come from a fixed set of names. Every distinct
	 * combination becomes its own series and is held for 24 hours, so request
	 * data here (a path, a user agent, an error message) grows the window without
	 * a bound and explodes the cardinality on the Prometheus side.
	 */
	readonly log?: string;
	/** Severity, default "error". A fixed set of values, see the note on log. */
	readonly level?: string;
}

export interface ErrorCollector extends Collector {
	record(event?: ErrorEvent): void;
}

/**
 * Counts server errors of the last 24 hours in memory.
 *
 * The counts come from the application, not from a log store, so the dashboard
 * still works when log shipping is broken. They restart with the process, like
 * every other runtime metric here.
 */
export function createErrorCollector(): ErrorCollector {
	const entries = new MinuteWindow();
	const pages = new MinuteWindow();
	// Seeded so the series exist from the first scrape on and a quiet hour
	// reads as 0 instead of a gap.
	entries.seed(key("app", "error"));
	pages.seed("page");

	return {
		area: "log",

		record(event: ErrorEvent = {}): void {
			entries.add(key(event.log ?? "app", event.level ?? "error"));
			if (event.errorPage !== undefined) {
				pages.add(event.errorPage);
			}
		},

		collect(): CollectorResult {
			const entryTotals = entries.totals();
			const pageTotals = pages.totals();

			const metrics: Metric[] = [
				{
					name: "log_entries",
					type: "gauge",
					help: "Server errors of the last 24 hours by log and level.",
					samples: [...entryTotals].map(([combined, value]) => {
						const [log = "app", level = "error"] = combined.split(SEPARATOR);
						return { labels: { log, level }, value };
					}),
				},
				{
					name: "log_error_pages",
					type: "gauge",
					help: "Error pages of the last 24 hours: page is a request that ended in an error page, content a single element that failed.",
					samples: [...pageTotals].map(([type, value]) => ({ labels: { type }, value })),
				},
			];

			return {
				metrics,
				json: {
					windowSeconds: WINDOW_SECONDS,
					entries: groupEntries(entryTotals),
					errorPages: Object.fromEntries(pageTotals),
				},
			};
		},
	};
}

function key(log: string, level: string): string {
	return `${log}${SEPARATOR}${level}`;
}

function groupEntries(totals: Map<string, number>): Record<string, Record<string, number>> {
	const grouped: Record<string, Record<string, number>> = {};
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
class MinuteWindow {
	private readonly buckets: Array<Map<string, number> | undefined> = new Array(WINDOW_MINUTES);
	private readonly seeded = new Set<string>();
	private lastMinute = currentMinute();

	seed(key: string): void {
		this.seeded.add(key);
	}

	add(key: string): void {
		this.rotate();
		const index = this.lastMinute % WINDOW_MINUTES;
		const bucket = this.buckets[index] ?? new Map<string, number>();
		bucket.set(key, (bucket.get(key) ?? 0) + 1);
		this.buckets[index] = bucket;
	}

	totals(): Map<string, number> {
		this.rotate();
		const totals = new Map<string, number>();
		for (const key of this.seeded) {
			totals.set(key, 0);
		}
		for (const bucket of this.buckets) {
			if (bucket === undefined) {
				continue;
			}
			for (const [key, value] of bucket) {
				totals.set(key, (totals.get(key) ?? 0) + value);
			}
		}
		return totals;
	}

	private rotate(): void {
		const now = currentMinute();
		if (now === this.lastMinute) {
			return;
		}
		const elapsed = Math.min(now - this.lastMinute, WINDOW_MINUTES);
		for (let step = 1; step <= elapsed; step += 1) {
			this.buckets[(this.lastMinute + step) % WINDOW_MINUTES] = undefined;
		}
		this.lastMinute = now;
	}
}

function currentMinute(): number {
	return Math.floor(Date.now() / 60_000);
}
