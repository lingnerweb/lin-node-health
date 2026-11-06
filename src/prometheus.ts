import type { Metric, Sample } from "./types.ts";

/** Shared by every implementation of the contract, see CONTRACT.md. */
export const METRIC_PREFIX = "lin_health_";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Renders the Prometheus text exposition format.
 *
 * Metrics without samples are dropped: a value that cannot be read is absent,
 * not 0. Metrics of the same name are merged, because HELP and TYPE may appear
 * only once per name and all samples of a name have to be adjacent.
 */
export function formatPrometheus(metrics: readonly Metric[]): string {
	const merged = new Map<string, { metric: Metric; samples: Sample[] }>();
	for (const metric of metrics) {
		if (metric.samples.length === 0) {
			continue;
		}
		const existing = merged.get(metric.name);
		if (existing === undefined) {
			merged.set(metric.name, { metric, samples: [...metric.samples] });
		} else {
			existing.samples.push(...metric.samples);
		}
	}

	const lines: string[] = [];
	for (const [name, { metric, samples }] of merged) {
		const fullName = METRIC_PREFIX + name;
		lines.push(`# HELP ${fullName} ${escapeHelp(metric.help)}`);
		lines.push(`# TYPE ${fullName} ${metric.type}`);
		for (const sample of samples) {
			lines.push(`${fullName}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function formatLabels(labels: Readonly<Record<string, string>> | undefined): string {
	if (labels === undefined) {
		return "";
	}
	const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
	return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}

function escapeLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function escapeHelp(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

/**
 * Prometheus reads Go floats: NaN and +Inf are spelled out. Fractions are cut
 * to 12 significant digits, otherwise a division leaves 0.30000000000000004
 * in the output.
 */
export function formatValue(value: number): string {
	if (Number.isNaN(value)) {
		return "NaN";
	}
	if (value === Number.POSITIVE_INFINITY) {
		return "+Inf";
	}
	if (value === Number.NEGATIVE_INFINITY) {
		return "-Inf";
	}
	if (Number.isInteger(value)) {
		return String(value);
	}
	return String(Number(value.toPrecision(12)));
}
