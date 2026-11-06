import { f as createSystemCollector, n as createHealth, p as createRuntimeCollector, v as createErrorCollector } from "../src-BpqX54SJ.mjs";
import { createRequire } from "node:module";

//#region src/next/create.ts
/**
* Only reached through a dynamic import from ./index.ts: everything below
* needs Node built-ins, and instrumentation.ts is compiled for the Edge
* runtime as well.
*/
function createNextHealth(config = {}) {
	const errors = createErrorCollector();
	const health = createHealth({
		token: config.token,
		tokenEnv: config.tokenEnv,
		platform: "node",
		info: {
			framework: "next",
			framework_version: readNextVersion() ?? "unknown",
			node_version: process.versions.node,
			...config.info
		},
		collectors: [
			createRuntimeCollector(config.runtime),
			createSystemCollector(config.system),
			errors,
			...config.collectors ?? []
		]
	});
	health.start();
	return {
		health,
		errors
	};
}
function readNextVersion() {
	try {
		const version = createRequire(import.meta.url)("next/package.json").version;
		return typeof version === "string" ? version : void 0;
	} catch {
		return;
	}
}

//#endregion
export { createNextHealth };