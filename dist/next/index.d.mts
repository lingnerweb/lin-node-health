import { u as Health } from "../system-CBZxTpSC.mjs";
import { a as RequestErrorRequest, i as RequestErrorHandler, n as NextHealthConfig, r as RequestErrorContext, t as NextHealth } from "../types-Cf64sY15.mjs";

//#region src/next/index.d.ts

/**
 * The single instance. The first caller decides the configuration, every later
 * one gets the same instance, so the order of register, route and error hook
 * does not matter.
 *
 * The import is dynamic on purpose: the module behind it uses Node built-ins,
 * and instrumentation.ts is compiled for the Edge runtime as well, where a
 * static import of node:v8 fails at build time.
 */
declare function getHealth(config?: NextHealthConfig): Promise<NextHealth>;
/**
 * Call from register() in instrumentation.ts. Starts the background
 * measurement of the event loop, so the first scrape already has values.
 */
declare function registerHealth(config?: NextHealthConfig): Promise<Health | undefined>;
/**
 * The route handler for app/.../route.ts:
 *
 *   export const { GET } = createHealthRoute();
 *
 * Without a configured token the endpoint answers 404: a route handler cannot
 * fall through to the application, and an empty payload would be worse.
 */
declare function createHealthRoute(config?: NextHealthConfig): {
  GET: (request: Request) => Promise<Response>;
};
/**
 * Wraps onRequestError instead of occupying it: an app has exactly one such
 * export, and a later Sentry or custom hook has to keep working.
 *
 *   export const onRequestError = withHealthRequestError(sentryOnRequestError);
 */
declare function withHealthRequestError(next?: RequestErrorHandler): RequestErrorHandler;
//#endregion
export { type NextHealth, type NextHealthConfig, type RequestErrorContext, type RequestErrorHandler, type RequestErrorRequest, createHealthRoute, getHealth, registerHealth, withHealthRequestError };