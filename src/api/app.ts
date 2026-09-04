/**
 * WAR API — app assembly (Phase: HTTP/API).
 *
 * Builds a Router wired to the handlers over a provided ArenaSession. This is
 * the composition point for the API: given a session (built elsewhere with real
 * repositories/ports), it returns a dispatchable router. No server, no socket,
 * no intelligence — fully Node-testable.
 */

import type { ArenaSession } from "../arena/ArenaSession.js";
import { Router } from "./router.js";
import * as handlers from "./handlers.js";

export function createApp(session: ArenaSession): Router {
  const router = new Router();

  router.get("/health", () => handlers.health());
  router.get("/capabilities", () => handlers.capabilities());
  router.get("/search", (req) => handlers.search(session, req));
  router.get("/replay/:sessionId", (req) => handlers.replay(session, req));
  router.post("/scan", (req) => handlers.scan(session, req));

  return router;
}
