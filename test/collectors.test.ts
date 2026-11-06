import assert from "node:assert/strict";
import { test } from "node:test";
import { createErrorCollector } from "../src/collectors/errors.ts";
import { createRuntimeCollector } from "../src/collectors/runtime.ts";
import { createSystemCollector } from "../src/collectors/system.ts";
import type { Metric } from "../src/types.ts";

function metric(metrics: readonly Metric[] | undefined, name: string): Metric | undefined {
	return metrics?.find((entry) => entry.name === name);
}

test("the error collector reports zero before anything failed", async () => {
	const errors = createErrorCollector();
	const result = await errors.collect();

	assert.deepEqual(metric(result.metrics, "log_entries")?.samples, [
		{ labels: { log: "app", level: "error" }, value: 0 },
	]);
	assert.deepEqual(metric(result.metrics, "log_error_pages")?.samples, [
		{ labels: { type: "page" }, value: 0 },
	]);
});

test("the error collector counts entries and error pages apart", async () => {
	const errors = createErrorCollector();
	errors.record({ errorPage: "page" });
	errors.record({ errorPage: "page" });
	// A failed route handler is a log entry, the visitor saw no error page.
	errors.record();
	const result = await errors.collect();

	assert.deepEqual(metric(result.metrics, "log_entries")?.samples, [
		{ labels: { log: "app", level: "error" }, value: 3 },
	]);
	assert.deepEqual(metric(result.metrics, "log_error_pages")?.samples, [
		{ labels: { type: "page" }, value: 2 },
	]);
	assert.deepEqual(result.json, {
		windowSeconds: 86400,
		entries: { app: { error: 3 } },
		errorPages: { page: 2 },
	});
});

test("the runtime collector reports process metrics and event loop lag once started", async () => {
	const runtime = createRuntimeCollector();
	runtime.start?.();
	await new Promise((resolve) => setTimeout(resolve, 60));
	const result = await runtime.collect();

	const heap = metric(result.metrics, "runtime_heap_used_bytes")?.samples[0]?.value ?? 0;
	assert.ok(heap > 0, "heap is reported");
	assert.ok((metric(result.metrics, "runtime_uptime_seconds")?.samples[0]?.value ?? 0) > 0);
	assert.deepEqual(
		metric(result.metrics, "runtime_cpu_seconds_total")?.samples.map((s) => s.labels?.mode),
		["user", "system"],
	);
	assert.deepEqual(
		metric(result.metrics, "runtime_event_loop_lag_seconds")?.samples.map(
			// Not "quantile": promtool reserves that label for summaries.
			(s) => s.labels?.percentile,
		),
		["50", "99"],
	);
	runtime.stop?.();
});

test("the runtime collector omits event loop metrics when it was never started", async () => {
	const result = await createRuntimeCollector().collect();

	assert.deepEqual(metric(result.metrics, "runtime_event_loop_lag_seconds")?.samples, []);
	assert.deepEqual(metric(result.metrics, "runtime_event_loop_utilization")?.samples, []);
});

test("the runtime collector warns about a heap near the limit", async () => {
	const result = await createRuntimeCollector({ heapWarnRatio: 0 }).collect();

	assert.deepEqual(
		result.warnings?.map((entry) => entry.key),
		["runtime.heap_high"],
	);
});

test("the system collector reports the CPUs and the project volume", async () => {
	const result = await createSystemCollector().collect();

	assert.ok((metric(result.metrics, "system_cpus")?.samples[0]?.value ?? 0) > 0);
	assert.equal(
		metric(result.metrics, "system_disk_used_ratio")?.samples[0]?.labels?.device,
		"project",
	);
});

test("the system collector omits memory where neither cgroup nor /proc is readable", async (t) => {
	const result = await createSystemCollector().collect();
	const total = metric(result.metrics, "system_memory_total_bytes")?.samples[0]?.value;

	if (process.platform !== "linux") {
		// macOS has no /proc: os.freemem() would read as 97 % used and warn.
		assert.equal(total, undefined);
		return;
	}
	t.diagnostic("on Linux the memory comes from the cgroup or /proc/meminfo");
	assert.ok((total ?? 0) > 0);
});

test("the system collector can be told to report without warning", async () => {
	const result = await createSystemCollector({ warnings: false, memoryWarnRatio: 0 }).collect();

	assert.deepEqual(result.warnings ?? [], []);
});
