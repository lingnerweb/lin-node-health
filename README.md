# @lingner/node-health

Health endpoint for Node projects, scraped by
[lin-grafana-monitoring](https://github.com/lingnerweb/lin-grafana-monitoring).
It implements version 2 of that repository's `CONTRACT.md`, which is normative:
when this package and the contract disagree, the contract is right.

The TYPO3 side of the same contract is
[lin-typo3-health](https://github.com/lingnerweb/lin-typo3-health).

```
@lingner/node-health            core: collector registry, warnings, Prometheus
                                format, token check. No framework.
@lingner/node-health/next       route handler, register(), onRequestError wrapper
```

A `payload` entry point with Postgres and job metrics follows in a later phase.

## Install

The package is private and installed from a git tag, like the TYPO3 extension is
pulled from its repository instead of Packagist:

```json
{
  "dependencies": {
    "@lingner/node-health": "git+ssh://git@github.com/lingnerweb/lin-node-health.git#v0.1.0"
  }
}
```

Not the `github:` shorthand: bun resolves it over the GitHub tarball API, which
answers 404 for a private repository unless a token is configured. `git+ssh`
clones with the SSH key that is there anyway, so the build host needs a deploy
key with read access to this repository.

`dist/` is committed because nothing builds on the installing side. A git
dependency also ships the whole repository rather than what `files` in
package.json lists, so `src/` and the tests land in node_modules as well;
`exports` still decides what can be imported.

## Use it in a Next.js app

Three files, nothing else.

**`instrumentation.ts`** in the app root. `register()` runs in every runtime, so
the package checks `NEXT_RUNTIME` itself and does nothing outside Node.

```ts
import { registerHealth, withHealthRequestError } from "@lingner/node-health/next";

export async function register() {
	await registerHealth();
}

// Wraps rather than occupies the hook: an app has exactly one onRequestError
// export, so a later Sentry handler has to keep working.
export const onRequestError = withHealthRequestError();
```

**`app/(health)/%5Fapi/health/route.ts`**. The folder is `%5F`, not `_`: Next
treats a leading underscore as a private folder and would not route it at all.
The route group keeps the path out of any `[domain]` or `[locale]` catch-all.

```ts
import { createHealthRoute } from "@lingner/node-health/next";

export const { GET } = createHealthRoute();
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

**`proxy.ts`**: the matcher has to let `_api` through, otherwise the proxy
answers before the handler is reached.

```ts
export const config = {
	matcher: ["/((?!api|_api|_next/static|...).*)"],
};
```

Then set the token:

```bash
HEALTH_ENDPOINT_BEARER=$(openssl rand -hex 32)
```

```bash
curl -H "X-Authorization: Bearer $HEALTH_ENDPOINT_BEARER" \
  "http://localhost:3000/_api/health?format=prometheus"
```

Without a token the endpoint is disabled and answers 404. A wrong token is 401,
on both `Authorization` and `X-Authorization`; the second one is what Prometheus
sends, because a host behind basic auth consumes the first.

## Configuration

```ts
await registerHealth({
	// Default: the token from HEALTH_ENDPOINT_BEARER.
	token: process.env.MY_TOKEN,
	tokenEnv: "MY_TOKEN",
	// Extra labels on lin_health_info, for example the deployed commit.
	info: { commit: process.env.SOURCE_COMMIT ?? "unknown" },
	runtime: { lagWarnSeconds: 1, heapWarnRatio: 0.9 },
	system: { warnings: true, memoryWarnRatio: 0.9, diskWarnRatio: 0.9 },
});
```

The first call decides the configuration. Route handler, `register()` and the
error hook share one instance over `globalThis`, because Next may put them in
different bundles.

## What it reports

Besides the four required metrics (`status`, `info`, `warning`,
`duration_seconds`) and `warnings`:

| Area | Metrics |
|---|---|
| `runtime` | uptime, heap used/total/limit/ratio, RSS, external, CPU seconds, event loop lag (p50, p99, max), event loop utilization |
| `system` | CPUs, memory total/available/ratio, load average, disk of the project volume |
| `log` | server errors and error pages of the last 24 hours |

Warning keys: `runtime.heap_high`, `runtime.event_loop_lag_high`,
`system.memory_high`, `system.load_high`, `system.disk_high.<name>`,
`<area>.collector_failed`.

Three things are deliberate:

- **Event loop lag and utilization describe the window since the last scrape**,
  not the whole process life. The histogram is reset after every read, otherwise
  a lag spike during boot would sit in the p99 forever.
- **Memory comes from the cgroup**, v2 first, then v1, and page cache
  (`inactive_file`) is subtracted. `/proc/meminfo` describes the host, which
  says nothing about the container. Outside a container `MemAvailable` is used;
  on a machine without `/proc` the area reports no memory at all rather than a
  wrong number.
- **The load average is absent inside a container**, where `/proc/loadavg` is
  the host's load and belongs to someone else's work.

`lin_health_status` is 2 only when the application cannot serve requests at all.
Until the Postgres collector exists, nothing here can establish that, so the
status is 0 or 1.

## Development

```bash
bun install
bun run build        # tsdown, ESM plus types into dist/
bun test             # node --test over the sources
bun run check        # biome
bun run check-types  # tsc --noEmit
```

Against a real app:

`bun link` does not work against a Turbopack app: it symlinks into the global
bun store, and Turbopack refuses to read files outside the project root
("Module not found"). Install the packed tarball instead, which is also the
check that `files` in package.json is complete:

```bash
bun run build
bun pm pack --destination /tmp

cd ../lngnr/apps/lingner-web
rm -rf node_modules/@lingner/node-health
mkdir -p node_modules/@lingner/node-health
tar -xzf /tmp/lingner-node-health-0.1.0.tgz \
  -C node_modules/@lingner/node-health --strip-components=1
```

The next `bun install` overwrites that directory with whatever package.json
names, so this is a development loop, not a setup step.
