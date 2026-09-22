/**
 * Package root. The default export is the plugin entry (see `./server.ts`); the layers are exported
 * as well so tests — and later the docs recipes — can reach them without deep imports.
 *
 * Nothing here talks to the network at import time.
 */

export { default } from "./server.js";
export * from "./provider.js";
export * from "./adapter.js";
export * from "./apply.js";
export * from "./plugin.js";
