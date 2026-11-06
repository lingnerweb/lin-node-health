import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
	entry: ["src/index.ts", "src/next/index.ts", "src/next/create.ts"],
	outDir: "dist",
	format: "esm",
	platform: "node",
	target: "node22",
	dts: true,
	clean: true,
	// The package reports its own version as a label on lin_health_info. Reading
	// package.json at runtime breaks once a consumer bundles the files, so the
	// version is baked in here. Unbuilt sources fall back to "0.0.0-dev".
	define: {
		"process.env.LIN_NODE_HEALTH_VERSION": JSON.stringify(pkg.version),
	},
});
