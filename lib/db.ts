import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

// Next.js dev mode re-runs this file on every save. Keeping the pool on
// globalThis means we reuse one pool instead of opening new connections each time.
const globalForDb = globalThis as unknown as { pgPool?: Pool };

function getPool(): Pool {
  if (globalForDb.pgPool) return globalForDb.pgPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to backend/.env.local.");
  }

  const pool = new Pool({ connectionString });

  // An idle connection can be dropped by the server at any time. Without this
  // listener, that error would crash the whole Node process.
  pool.on("error", (error) => {
    console.error("Idle database connection error:", error);
  });

  globalForDb.pgPool = pool;
  return pool;
}

/** Run one SQL statement and return its rows. Always pass values through `params` ($1, $2, ...). */
export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/**
 * Run several statements as one all-or-nothing unit.
 * Use the `client` given to `work` for every query inside, so they share one connection.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let connectionBroken = false;

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK itself failed, so this connection is unusable.
      connectionBroken = true;
    }
    throw error;
  } finally {
    // true = destroy the connection instead of returning it to the pool.
    client.release(connectionBroken);
  }
}
