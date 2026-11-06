import { createRequire } from "node:module";
import {
	createErrorCollector,
	createHealth,
	createRuntimeCollector,
	createSystemCollector,
} from "../index.ts";
import type { NextHealth, NextHealthConfig } from "./types.ts";

/**
 * Only reached through a dynamic import from ./index.ts: everything below
 * needs Node built-ins, and instrumentation.ts is compiled for the Edge
 * runtime as well.
 */
export function createNextHealth(config: NextHealthConfig = {}): NextHealth {
	const errors = createErrorCollector();
	const health = createHealth({
		token: config.token,
		tokenEnv: config.tokenEnv,
		platform: "node",
		info: {
			framework: "next",
			framework_version: readNextVersion() ?? "unknown",
			node_version: process.versions.node,
			...config.info,
		},
		collectors: [
			createRuntimeCollector(config.runtime),
			createSystemCollector(config.system),
			errors,
			...(config.collectors ?? []),
		],
	});
	health.start();
	return { health, errors };
}

function readNextVersion(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const pkg: unknown = require("next/package.json");
		const version = (pkg as { version?: unknown }).version;
		return typeof version === "string" ? version : undefined;
	} catch {
		// Bundled output cannot resolve it, the label then reads "unknown".
		return undefined;
	}
}
