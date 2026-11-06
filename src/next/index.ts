import type { Health } from "../types.ts";
import type { NextHealth, NextHealthConfig, RequestErrorHandler } from "./types.ts";

export type {
	NextHealth,
	NextHealthConfig,
	RequestErrorContext,
	RequestErrorHandler,
	RequestErrorRequest,
} from "./types.ts";

/**
 * The route handler, instrumentation.ts and the error hook can end up in
 * different bundles, so the instance lives on globalThis rather than in a
 * module variable.
 */
const STORE = Symbol.for("lingner.node-health");

interface Store {
	instance?: Promise<NextHealth>;
}

function store(): Store {
	const global = globalThis as unknown as Record<symbol, Store | undefined>;
	const existing = global[STORE];
	if (existing !== undefined) {
		return existing;
	}
	const created: Store = {};
	global[STORE] = created;
	return created;
}

/**
 * The single instance. The first caller decides the configuration, every later
 * one gets the same instance, so the order of register, route and error hook
 * does not matter.
 *
 * The import is dynamic on purpose: the module behind it uses Node built-ins,
 * and instrumentation.ts is compiled for the Edge runtime as well, where a
 * static import of node:v8 fails at build time.
 */
export function getHealth(config?: NextHealthConfig): Promise<NextHealth> {
	const state = store();
	state.instance ??= import("./create.ts").then(({ createNextHealth }) => createNextHealth(config));
	return state.instance;
}

/**
 * Call from register() in instrumentation.ts. Starts the background
 * measurement of the event loop, so the first scrape already has values.
 */
export async function registerHealth(config?: NextHealthConfig): Promise<Health | undefined> {
	// register() runs in every runtime, the collectors need Node.
	if (process.env.NEXT_RUNTIME !== "nodejs") {
		return undefined;
	}
	const { health } = await getHealth(config);
	return health;
}

/**
 * The route handler for app/.../route.ts:
 *
 *   export const { GET } = createHealthRoute();
 *
 * Without a configured token the endpoint answers 404: a route handler cannot
 * fall through to the application, and an empty payload would be worse.
 */
export function createHealthRoute(config?: NextHealthConfig): {
	GET: (request: Request) => Promise<Response>;
} {
	return {
		GET: async (request: Request): Promise<Response> => {
			const { health } = await getHealth(config);
			const response = await health.handle(request);
			return (
				response ??
				new Response("Not Found", {
					status: 404,
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						"Cache-Control": "no-store",
					},
				})
			);
		},
	};
}

/**
 * Wraps onRequestError instead of occupying it: an app has exactly one such
 * export, and a later Sentry or custom hook has to keep working.
 *
 *   export const onRequestError = withHealthRequestError(sentryOnRequestError);
 */
export function withHealthRequestError(next?: RequestErrorHandler): RequestErrorHandler {
	return async (error, request, context) => {
		if (process.env.NEXT_RUNTIME === "nodejs") {
			try {
				const { errors } = await getHealth();
				// Only a render ends in an error page; a route handler or an
				// action returns a failed response instead.
				errors.record({
					errorPage: context?.routeType === "render" ? "page" : undefined,
				});
			} catch {
				// Counting must never swallow or replace the error report.
			}
		}
		await next?.(error, request, context);
	};
}
