import type { ErrorCollector } from "../collectors/errors.ts";
import type { RuntimeCollectorOptions } from "../collectors/runtime.ts";
import type { SystemCollectorOptions } from "../collectors/system.ts";
import type { Collector, Health } from "../types.ts";

export interface NextHealthConfig {
	/** Overrides the token from the environment. An empty token disables the endpoint. */
	readonly token?: string;
	/** Environment variable holding the token, default HEALTH_ENDPOINT_BEARER. */
	readonly tokenEnv?: string;
	/** Extra labels for lin_health_info, for example the deployed commit. */
	readonly info?: Readonly<Record<string, string>>;
	readonly runtime?: RuntimeCollectorOptions;
	readonly system?: SystemCollectorOptions;
	/** Collectors of further areas, for example the Payload ones. */
	readonly collectors?: readonly Collector[];
}

export interface NextHealth {
	readonly health: Health;
	readonly errors: ErrorCollector;
}

/**
 * Structurally compatible with Next's Instrumentation.onRequestError. It is
 * declared here instead of imported, because next is an optional peer
 * dependency and the types must not be required to build against this package.
 */
export type RequestErrorHandler = (
	error: unknown,
	request: RequestErrorRequest,
	context: RequestErrorContext,
) => void | Promise<void>;

export interface RequestErrorRequest {
	readonly path: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface RequestErrorContext {
	readonly routerKind: "Pages Router" | "App Router";
	readonly routePath: string;
	/** "middleware" is the name this had before Next 16 renamed it to "proxy". */
	readonly routeType: "render" | "route" | "action" | "proxy" | "middleware";
	readonly renderSource?: string;
	readonly revalidateReason?: string;
	readonly renderType?: string;
}
