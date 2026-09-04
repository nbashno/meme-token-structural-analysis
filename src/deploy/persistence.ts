/**
 * WAR deployment — persistence wiring.
 *
 * Builds a live PostgreSQL-backed UnitOfWork from DATABASE_URL. `pg` is imported
 * dynamically (and its specifier held in a variable) so the dependency is only
 * required when a database is actually configured — the default in-memory path,
 * tests, and health-only boots never touch it.
 *
 * On connect this also applies migrations/0001_init.sql idempotently, so a fresh
 * Supabase database is schema-ready on first boot with no manual step. The SQL is
 * written with CREATE ... IF NOT EXISTS, so re-running is safe.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { wrapNodePgPool, type PgPool } from "../product/persistence/pg/pgClient.js";
import { PgUnitOfWork } from "../product/persistence/pg/pgRepositories.js";
import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";

export interface PgHandle {
  readonly uow: UnitOfWork;
  readonly pool: PgPool;
  /** Close the underlying pool (used on shutdown). */
  close(): Promise<void>;
}

/**
 * Connect to Postgres, apply the schema, and return a UnitOfWork. Throws if the
 * connection or migration fails — we do NOT silently fall back to in-memory,
 * because a configured-but-broken database must be visible, not masked.
 */
export async function createPgUnitOfWork(databaseUrl: string): Promise<PgHandle> {
  // Held in a variable so the typechecker/bundler does not hard-require `pg`.
  const pgModule = "pg";
  const pg = (await import(pgModule)) as unknown as {
    Pool: new (cfg: { connectionString: string }) => {
      query(t: string, p?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
      connect(): Promise<{
        query(t: string, p?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
        release(): void;
      }>;
      end(): Promise<void>;
    };
  };

  const raw = new pg.Pool({ connectionString: databaseUrl });

  // Apply migrations (idempotent), in filename order. Locate the folder
  // relative to this module, with fallbacks so it works from dist (prod),
  // src (dev), or the process CWD regardless of how the image is laid out.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "migrations"),  // dist/src/deploy → /app/migrations
    join(here, "..", "..", "migrations"),          // fallback
    join(process.cwd(), "migrations"),             // CWD (Render workdir)
  ];
  let migrationsDir: string | null = null;
  for (const c of candidates) {
    try { if (readdirSync(c).some((f) => f.endsWith(".sql"))) { migrationsDir = c; break; } } catch { /* try next */ }
  }
  if (!migrationsDir) {
    throw new Error("migrations folder not found. Looked in: " + candidates.join(" , "));
  }
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  // eslint-disable-next-line no-console
  console.log("[war-api] applying " + files.length + " migrations from " + migrationsDir);
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    try {
      await raw.query(sql);
      // eslint-disable-next-line no-console
      console.log("[war-api]   migration ok: " + f);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[war-api]   migration FAILED: " + f + " → " + (e as Error).message);
      throw e; // a broken schema must be visible, not silently half-applied
    }
  }

  const pool = wrapNodePgPool(raw);
  const uow = new PgUnitOfWork(pool);
  return {
    uow,
    pool,
    async close() { await raw.end(); },
  };
}
