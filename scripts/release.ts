#!/usr/bin/env bun

/**
 * Release in one command: check, version, build, commit, tag.
 *
 * The order is the reason this script exists. tsdown bakes the version from
 * package.json into dist/ (see the define block in tsdown.config.ts), and dist/ is
 * committed because consumers install this package from a git tag without running a
 * build. Tagging before rebuilding would ship a tree whose health endpoint reports
 * the previous version as the lin_health_info label: nothing fails, the number is
 * simply wrong, and it is wrong in Grafana where someone will trust it.
 *
 *   1. refuse to run on a dirty working tree or outside main
 *   2. refuse to run without a pending changeset
 *   3. run the checks, because the tag is what other projects consume
 *   4. changeset version: bumps package.json, writes CHANGELOG.md, consumes the changesets
 *   5. bun run build: bakes the new version into dist/
 *   6. commit the bump and dist/ together
 *   7. tag <version>, plain semver without a v prefix, like every other Lingner repository
 *   8. print the push command, because pushing stays a deliberate act
 *
 * Usage: bun run release
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

function capture(command: string, args: readonly string[]): string {
	return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function run(command: string, args: readonly string[]): void {
	execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

function fail(message: string): never {
	console.error(`\nAbbruch: ${message}\n`);
	process.exit(1);
}

function readVersion(): string {
	const raw: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	if (
		typeof raw !== "object" ||
		raw === null ||
		!("version" in raw) ||
		typeof raw.version !== "string"
	) {
		fail("package.json enthält kein version-Feld.");
	}
	return raw.version;
}

// 1. A release has to sit on a defined state, on the branch others pull from.

if (capture("git", ["status", "--porcelain"])) {
	fail(
		"Der Arbeitsbaum ist nicht sauber.\n\n" +
			"  Sonst landen fremde Änderungen im Release-Commit und das Tag beschreibt\n" +
			"  etwas anderes als das, was gebaut wurde.\n\n" +
			"  Erst committen oder verwerfen, dann erneut: bun run release",
	);
}

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") {
	fail(`Ein Release gehört auf main, aktueller Branch: ${branch}.`);
}

// 2. Without a changeset there is nothing to version and no changelog entry.

const pending = readdirSync(join(repoRoot, ".changeset")).filter(
	(name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md",
);

if (pending.length === 0) {
	fail(
		"Keine offenen Changesets.\n\n" +
			"  Eines anlegen: bun run changeset\n" +
			"  Dann erneut:   bun run release",
	);
}

console.log(`Offene Changesets: ${pending.length}\n`);

// 3. The tag is what other projects install, so it is checked before it exists.

run("bun", ["run", "check-types"]);
run("bun", ["run", "check"]);
run("bun", ["run", "test"]);

// 4. Bump and changelog.

run("bunx", ["changeset", "version"]);

const version = readVersion();

if (capture("git", ["tag", "-l", version])) {
	fail(
		`Tag ${version} existiert bereits.\n\n` +
			"  Der Bump ist bereits geschrieben. Entweder das Tag aufräumen oder den\n" +
			"  Bump zurücknehmen: git checkout -- . && git clean -fd .changeset",
	);
}

// 5. Rebuild, so dist/ carries the version that was just written.

run("bun", ["run", "build"]);

// 6. Bump and dist/ belong in the same commit: the tag points at both.

run("git", ["add", "-A"]);
run("git", ["commit", "-m", `[chore] release ${version}`]);

// 7. Plain semver, no v prefix. Consumers pin this string in their dependency URL.

run("git", ["tag", "-a", version, "-m", version]);

console.log(
	`\nRelease ${version}: Commit und Tag liegen lokal.\n\n` +
		`  Pushen:  git push origin main && git push origin ${version}\n\n` +
		"  Danach in den konsumierenden Projekten den Tag hochziehen:\n" +
		`  "@lingner/node-health": "git+ssh://git@github.com/lingnerweb/lin-node-health.git#${version}"\n`,
);
