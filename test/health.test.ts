import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealth } from "../src/health.ts";
import type { Collector } from "../src/types.ts";

const TOKEN = "s3cret";

function collector(result: Partial<ReturnType<Collector["collect"]> & object> = {}): Collector {
	return { area: "demo", collect: () => ({ json: {}, ...result }) };
}

function get(url: string, headers: Record<string, string> = {}): Request {
	return new Request(url, { headers });
}

function authorized(header = "X-Authorization"): Record<string, string> {
	return { [header]: `Bearer ${TOKEN}` };
}

test("falls through when no token is configured", async () => {
	const health = createHealth({ token: "" });

	assert.equal(health.enabled, false);
	assert.equal(await health.handle(get("https://example.test/_api/health")), null);
});

test("answers 401 for a missing or wrong token, on both headers", async () => {
	const health = createHealth({ token: TOKEN });

	const missing = await health.handle(get("https://example.test/_api/health"));
	assert.equal(missing?.status, 401);
	assert.equal(missing?.headers.get("WWW-Authenticate"), "Bearer");

	const wrong = await health.handle(
		get("https://example.test/_api/health", { Authorization: "Bearer nope" }),
	);
	assert.equal(wrong?.status, 401);

	for (const header of ["Authorization", "X-Authorization"]) {
		const response = await health.handle(
			get("https://example.test/_api/health", authorized(header)),
		);
		assert.equal(response?.status, 200, header);
	}
});

test("reports the four required metrics", async () => {
	const health = createHealth({ token: TOKEN, collectors: [collector()] });
	const response = await health.handle(
		get("https://example.test/_api/health?format=prometheus", authorized()),
	);
	const body = await response?.text();

	assert.equal(response?.status, 200);
	assert.match(response?.headers.get("Content-Type") ?? "", /^text\/plain; version=0\.0\.4/);
	assert.match(body ?? "", /^lin_health_status 0$/m);
	assert.match(body ?? "", /^lin_health_info\{contract="2",version="[^"]+",platform="node"/m);
	assert.match(body ?? "", /^lin_health_duration_seconds /m);
	// No warning active: the family has no series and is left out entirely.
	assert.doesNotMatch(body ?? "", /lin_health_warning\{/);
	assert.match(body ?? "", /^lin_health_warnings 0$/m);
});

test("a warning makes the status degraded and never stays at ok", async () => {
	const health = createHealth({
		token: TOKEN,
		collectors: [collector({ warnings: [{ key: "demo.high", message: "Demo at 95%" }] })],
	});
	const payload = await health.collect();

	assert.equal(payload.status, "degraded");
	assert.deepEqual(payload.warnings, [{ key: "demo.high", message: "Demo at 95%" }]);
});

test("Prometheus always answers 200, JSON answers 503 on error", async () => {
	const health = createHealth({ token: TOKEN, collectors: [collector({ fatal: true })] });

	const prometheus = await health.handle(
		get("https://example.test/_api/health?format=prometheus", authorized()),
	);
	assert.equal(prometheus?.status, 200);
	assert.match(await prometheus.text(), /^lin_health_status 2$/m);

	const json = await health.handle(get("https://example.test/_api/health", authorized()));
	assert.equal(json?.status, 503);
	assert.equal(((await json.json()) as { status: string }).status, "error");
});

test("a failing collector leaves its area empty and warns, the rest is reported", async () => {
	const failing: Collector = {
		area: "broken",
		collect: () => {
			throw new TypeError("/srv/app/secret.ts is missing");
		},
	};
	const health = createHealth({ token: TOKEN, collectors: [failing, collector()] });
	const payload = await health.collect();

	assert.equal(payload.areas.broken, null);
	assert.deepEqual(payload.areas.demo, {});
	assert.deepEqual(payload.warnings, [
		{ key: "broken.collector_failed", message: "Collecting broken failed with TypeError" },
	]);
});

test("the JSON format carries the general fields and one key per area", async () => {
	const health = createHealth({ token: TOKEN, collectors: [collector({ json: { a: 1 } })] });
	const response = await health.handle(get("https://example.test/_api/health", authorized()));
	const body = (await response?.json()) as Record<string, unknown>;

	assert.equal(body.status, "ok");
	assert.equal(body.contract, 2);
	assert.equal(body.platform, "node");
	assert.deepEqual(body.warnings, []);
	assert.deepEqual(body.demo, { a: 1 });
	assert.equal(typeof body.time, "string");
	assert.equal(typeof body.durationMs, "number");
});

test("rejects anything but GET", async () => {
	const health = createHealth({ token: TOKEN });
	const response = await health.handle(
		new Request("https://example.test/_api/health", { method: "POST", headers: authorized() }),
	);

	assert.equal(response?.status, 405);
});
