/**
 * WAR API layer (Phase: HTTP/API).
 *
 * A thin HTTP surface over the existing ArenaSession. It performs routing,
 * validation, and serialization only — no intelligence, no core imports, no
 * scoring config, no GMGN access. Built on node:http (zero external deps).
 */

export * from "./httpResult.js";
export * from "./router.js";
export * from "./handlers.js";
export * from "./app.js";
export * from "./httpServer.js";
