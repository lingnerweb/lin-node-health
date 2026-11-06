import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrometheus, formatValue } from "../src/prometheus.ts";

test("renders help, type and samples with the shared prefix", () => {
	const output = formatPrometheus([
		{
			name: "status",
			type: "gauge",
			help: "Overall status: 0 ok, 1 degraded, 2 error.",
			samples: [{ value: 1 }],
		},
	]);

	assert.equal(
		output,
		"# HELP lin_health_status Overall status: 0 ok, 1 degraded, 2 error.\n" +
			"# TYPE lin_health_status gauge\n" +
			"lin_health_status 1\n",
	);
});

test("drops a metric without samples instead of reporting zero", () => {
	const output = formatPrometheus([
		{ name: "system_cpus", type: "gauge", help: "CPUs.", samples: [] },
	]);

	assert.equal(output, "\n");
});

test("merges metrics of the same name so help and type appear once", () => {
	const output = formatPrometheus([
		{
			name: "warning",
			type: "gauge",
			help: "One series per warning.",
			samples: [{ labels: { key: "a" }, value: 1 }],
		},
		{
			name: "warning",
			type: "gauge",
			help: "One series per warning.",
			samples: [{ labels: { key: "b" }, value: 1 }],
		},
	]);

	assert.equal(output.match(/# TYPE/g)?.length, 1);
	assert.match(output, /lin_health_warning\{key="a"\} 1\nlin_health_warning\{key="b"\} 1/);
});

test("escapes backslash, quote and newline in label values", () => {
	const output = formatPrometheus([
		{
			name: "warning",
			type: "gauge",
			help: "One series per warning.",
			samples: [{ labels: { message: 'a "b"\\c\nd' }, value: 1 }],
		},
	]);

	assert.match(output, /\{message="a \\"b\\"\\\\c\\nd"\} 1/);
});

test("formats values the way Prometheus reads them", () => {
	assert.equal(formatValue(0), "0");
	assert.equal(formatValue(1234567890), "1234567890");
	assert.equal(formatValue(0.1 + 0.2), "0.3");
	assert.equal(formatValue(Number.POSITIVE_INFINITY), "+Inf");
	assert.equal(formatValue(Number.NaN), "NaN");
});
