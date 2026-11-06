import assert from "node:assert/strict";
import { test } from "node:test";
import { readBearerTokens, verifyToken } from "../src/token.ts";

test("reads the bearer token from both headers, case insensitive", () => {
	assert.deepEqual(readBearerTokens(new Headers({ Authorization: "Bearer one" })), ["one"]);
	assert.deepEqual(readBearerTokens(new Headers({ "X-Authorization": "bearer two" })), ["two"]);
	assert.deepEqual(
		readBearerTokens(new Headers({ Authorization: "Bearer one", "X-Authorization": "Bearer two" })),
		["one", "two"],
	);
});

test("ignores basic auth and empty headers", () => {
	assert.deepEqual(readBearerTokens(new Headers({ Authorization: "Basic dXNlcjpwdw==" })), []);
	assert.deepEqual(readBearerTokens(new Headers()), []);
});

test("compares tokens of any length without throwing", () => {
	assert.equal(verifyToken("abc", "abc"), true);
	assert.equal(verifyToken("abc", "abcd"), false);
	assert.equal(verifyToken("", "abc"), false);
	assert.equal(verifyToken("a".repeat(5000), "abc"), false);
});

test("an empty expected token never matches", () => {
	assert.equal(verifyToken("", ""), false);
	assert.equal(verifyToken("anything", ""), false);
});
