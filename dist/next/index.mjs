//#region src/next/index.ts
/**
* The route handler, instrumentation.ts and the error hook can end up in
* different bundles, so the instance lives on globalThis rather than in a
* module variable.
*/
const STORE = Symbol.for("lingner.node-health");
function store() {
	const global = globalThis;
	const existing = global[STORE];
	if (existing !== void 0) return existing;
	const created = {};
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
function getHealth(config) {
	const state = store();
	state.instance ??= import("./create.mjs").then(({ createNextHealth }) => createNextHealth(config));
	return state.instance;
}
/**
* Call from register() in instrumentation.ts. Starts the background
* measurement of the event loop, so the first scrape already has values.
*/
async function registerHealth(config) {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
function createHealthRoute(config) {
	return { GET: async (request) => {
		const { health } = await getHealth(config);
		return await health.handle(request) ?? new Response("Not Found", {
			status: 404,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store"
			}
		});
	} };
}
/**
* Wraps onRequestError instead of occupying it: an app has exactly one such
* export, and a later Sentry or custom hook has to keep working.
*
*   export const onRequestError = withHealthRequestError(sentryOnRequestError);
*/
function withHealthRequestError(next) {
	return async (error, request, context) => {
		if (process.env.NEXT_RUNTIME === "nodejs") try {
			const { errors } = await getHealth();
			errors.record({ errorPage: context?.routeType === "render" ? "page" : void 0 });
		} catch {}
		await next?.(error, request, context);
	};
}

//#endregion
export { createHealthRoute, getHealth, registerHealth, withHealthRequestError };