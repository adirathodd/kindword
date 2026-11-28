// Runs against the Postgres in DATABASE_URL.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { db, POOL_CONNECTION_TIMEOUT_MS, poolConfig } from "./client";

const url = process.env.DATABASE_URL;

// Pools a test made; any client still checked out (leaked or held) is released before ending.
const pools: Pool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) {
    const clients = (pool as unknown as { _clients: (PoolClient & { release?: () => void })[] })._clients;
    for (const c of [...clients]) {
      try {
        c.release?.(); // only clients still checked out; an idle one throws
      } catch {}
    }
    await pool.end();
  }
});

// A pool built like the app's, with one connection so it is easy to use up.
function onePool(overrides: { connectionTimeoutMillis?: number } = {}) {
  const pool = new Pool({ ...poolConfig(url), max: 1, ...overrides });
  pools.push(pool);
  return pool;
}

// drizzle wraps a driver error as "Failed query" with the pg error as its cause.
async function elapsed(p: Promise<unknown>) {
  const start = Date.now();
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  const cause = (err as { cause?: unknown } | null)?.cause ?? err;
  return { err, message: cause ? String(cause) : "", ms: Date.now() - start };
}

describe("database pool", () => {
  it("the app's pool gives up waiting for a connection after 10 seconds", () => {
    expect(POOL_CONNECTION_TIMEOUT_MS).toBe(10_000);
    const pool = db.$client as Pool;
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.connectionString).toBe(url);
  });

  it("poolConfig keeps the connection string and sets the timeout", () => {
    expect(poolConfig("postgres://u:p@h:5432/d")).toEqual({
      connectionString: "postgres://u:p@h:5432/d",
      connectionTimeoutMillis: 10_000,
    });
  });

  it("a query fails instead of waiting forever when every connection is in use", async () => {
    const pool = onePool({ connectionTimeoutMillis: 200 });
    const held = await pool.connect(); // uses up the only connection
    const { message, ms } = await elapsed(drizzle({ client: pool }).execute(sql`select 1`));
    expect(message).toMatch(/timeout exceeded when trying to connect/);
    expect(ms).toBeLessThan(5_000);
    held.release();
    // The pool still works once a connection is free.
    const rows = await drizzle({ client: pool }).execute(sql`select 1 as one`);
    expect(rows.rows[0]).toEqual({ one: 1 });
  });

  it("a transaction whose BEGIN fails does not leave later queries hanging", async () => {
    // drizzle's transaction() does not release its client when BEGIN fails (the audit
    // scenario behind #95). Before this change the next query waited forever.
    const pool = onePool({ connectionTimeoutMillis: 200 });
    const tdb = drizzle({ client: pool });
    const begin = await elapsed(tdb.transaction(async () => {}, { isolationLevel: "not a level" as never }));
    expect(begin.err).toBeTruthy();
    expect(pool.totalCount - pool.idleCount).toBe(1); // the client is still checked out

    const { message, ms } = await elapsed(tdb.execute(sql`select 1`));
    expect(message).toMatch(/timeout exceeded when trying to connect/);
    expect(ms).toBeLessThan(5_000);
  });

  it("without a timeout, the same query is still waiting (why the setting is needed)", async () => {
    const pool = onePool({ connectionTimeoutMillis: 0 }); // pg's default: wait forever
    const tdb = drizzle({ client: pool });
    await tdb.transaction(async () => {}, { isolationLevel: "not a level" as never }).catch(() => {});
    const query = tdb.execute(sql`select 1`).then(
      () => "done",
      () => "failed",
    );
    const waited = await Promise.race([query, new Promise((r) => setTimeout(() => r("still waiting"), 500))]);
    expect(waited).toBe("still waiting");
    // afterEach releases the leaked client, which lets the waiting query finish.
  });
});
