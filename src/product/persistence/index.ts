/**
 * WAR Product Layer - Phase 2 - persistence barrel.
 * Contracts + implementations. The domain depends on contracts only.
 */
export * from "./tokenMemory.js";
export * from "./contracts/repositories.js";
export { InMemoryUnitOfWork } from "./memory/inMemory.js";
export { PgUnitOfWork } from "./pg/pgRepositories.js";
export type { PgQueryable, PgPool, PgQueryResult } from "./pg/pgClient.js";
export { wrapNodePgPool } from "./pg/pgClient.js";
