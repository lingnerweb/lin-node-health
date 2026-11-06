import "../system-CBZxTpSC.mjs";
import { n as NextHealthConfig, t as NextHealth } from "../types-Cf64sY15.mjs";

//#region src/next/create.d.ts

/**
 * Only reached through a dynamic import from ./index.ts: everything below
 * needs Node built-ins, and instrumentation.ts is compiled for the Edge
 * runtime as well.
 */
declare function createNextHealth(config?: NextHealthConfig): NextHealth;
//#endregion
export { createNextHealth };