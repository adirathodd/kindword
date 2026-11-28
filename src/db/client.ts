import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolConfig } from "pg";
import * as schema from "./schema";

// How long a query waits for a pool connection (a free client, or a new connection to
// Postgres) before it fails. Without it, pg waits forever: drizzle's transaction() does not
// release its client when BEGIN fails, so after a few dropped connections every later query on
// a warm instance would hang until the function times out. With it, the query throws. A job
// step that throws is retried by the queue (D-11) and shows on the jobs-ran check; job loops
// that catch errors per row (e.g. rowError in src/requests) count it as a failed row and go on.
// 10 seconds is far above a normal wait and well inside a job's run time.
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

export function poolConfig(connectionString: string | undefined): PoolConfig {
  return { connectionString, connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS };
}

export const db = drizzle({ connection: poolConfig(process.env.DATABASE_URL), schema });
export type Db = typeof db;
