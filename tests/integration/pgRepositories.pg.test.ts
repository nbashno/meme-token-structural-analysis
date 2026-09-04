/**
 * Real PostgreSQL integration suite. SKIPPED by default. It runs only where a
 * database is available and the env flag is set:
 *
 *   WAR_PG_TEST=1 DATABASE_URL=postgres://... npm test
 *
 * It applies migrations/0001_init.sql, then exercises the same invariants as the
 * in-memory suite against a live pg pool via wrapNodePgPool. This keeps the pg
 * code path honest without making the default suite depend on a database.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ENABLED = process.env.WAR_PG_TEST === "1" && !!process.env.DATABASE_URL;

// The suite is a no-op unless explicitly enabled with a database present.
(ENABLED ? describe : describe.skip)("persistence (real PostgreSQL)", () => {
  it("applies schema and enforces single-consumption + idempotent entitlement", async () => {
    // Imports are dynamic so `pg` is only required when the suite is enabled.
    // The specifier is held in a variable so the typechecker does not attempt to
    // resolve an optional dependency that is absent in the default environment.
    const pgModule = "pg";
    const pg = (await import(pgModule)) as unknown as {
      Pool: new (cfg: { connectionString: string }) => {
        query(t: string, p?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
        connect(): Promise<{ query: (t: string, p?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release(): void }>;
        end(): Promise<void>;
      };
    };
    const { wrapNodePgPool } = await import("../../src/product/persistence/pg/pgClient.js");
    const { PgUnitOfWork } = await import("../../src/product/persistence/pg/pgRepositories.js");
    const { entitlementIdFor } = await import("../../src/product/payment/entitlement.js");

    const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
    const HERE = fileURLToPath(new URL(".", import.meta.url));
    const sql = readFileSync(join(HERE, "..", "..", "migrations", "0001_init.sql"), "utf8");
    await raw.query(sql);

    const pool = wrapNodePgPool(raw);
    const uow = new PgUnitOfWork(pool);

    await pool.query("SET search_path TO war_product");
    await uow.repos.pricing.record({ version: "pricing-v1", prices: { TOKEN_SCAN: 100000 as never, TOKEN_MONITOR_24H: 1000000 as never, PRO_ACCESS: 0 as never }, monitorDurationMs: 86400000 } as never);
    await uow.repos.engineVersions.record("war-engine-0.1.0", { engineVersion: "war-engine-0.1.0" } as never);
    await uow.repos.users.upsert({ userId: "u1" as never, provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 1000 });

    const first = await uow.repos.usage.consume({ entitlementId: entitlementIdFor("tx-pg"), userId: "u1" as never, consumedAt: 1, capabilityRef: "a" });
    const second = await uow.repos.usage.consume({ entitlementId: entitlementIdFor("tx-pg"), userId: "u1" as never, consumedAt: 2, capabilityRef: "b" });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    await raw.end();
  });
});
