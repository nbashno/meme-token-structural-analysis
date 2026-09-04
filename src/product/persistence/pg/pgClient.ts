/**
 * WAR Product Layer - Phase 2 - thin PostgreSQL client contract.
 *
 * We do NOT hard-depend on the `pg` package inside the domain. Instead we define
 * the minimal query surface the repositories need. In production, a tiny adapter
 * wraps node-postgres (pg.Pool / pg.PoolClient) to satisfy this. In tests we can
 * satisfy it with a fake, or run the real integration suite behind an env flag.
 *
 * This keeps the persistence layer free of a heavy ORM and free of an ambient
 * dependency the sandbox cannot install.
 */

export interface PgQueryResult<R = Record<string, unknown>> {
  readonly rows: R[];
  readonly rowCount: number;
}

/** A single query-capable handle (pool or in-transaction client). */
export interface PgQueryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
}

/** A pool that can also lease a client bound to one transaction. */
export interface PgPool extends PgQueryable {
  /** Run fn with a client inside BEGIN/COMMIT; ROLLBACK on throw. */
  withTransaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T>;
}

/**
 * Reference wrapper showing how a real pg.Pool maps onto PgPool. Not imported by
 * the domain; provided here as the production wiring recipe. It is written
 * against a structural `pg`-like shape so it compiles without the dependency.
 */
export interface NodePgLikePool {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
  connect(): Promise<{
    query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
    release(): void;
  }>;
}

export function wrapNodePgPool(pool: NodePgLikePool): PgPool {
  const asQueryable = (q: {
    query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
  }): PgQueryable => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await q.query(text, params);
      return { rows: r.rows as R[], rowCount: r.rowCount };
    },
  });

  return {
    query: asQueryable(pool).query,
    async withTransaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(asQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
