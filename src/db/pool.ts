import { Logger } from '@nestjs/common';
import { Pool, types } from 'pg';

const logger = new Logger('DbPool');

const CONNECTION_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 10000;

/** Postgres `numeric`/`decimal` — the type every money column uses. */
const NUMERIC_OID = 1700;

/**
 * Money is parsed to a number *here*, at the persistence boundary, so it is a
 * number everywhere above it: in the row types, in the REST responses, in the
 * outbox payloads, and on the storefront.
 *
 * node-postgres hands `numeric` back as text by default (it is the only way the
 * driver can guarantee no precision loss), which is why the same service used to
 * answer `checkout` with `144` and `GET /orders/:id` with `"144.00"`. Callers
 * papered over it with `Number(...)` scattered through the services; a consumer
 * had no way to know which shape it would get.
 *
 * The column type stays `DECIMAL(12,2)` — exact decimal storage, per the money
 * convention in `Documentation/3.Database-Schema.md`. `float8` was rejected: a
 * binary float cannot hold 0.10, so it would trade a typing bug for an
 * arithmetic bug. `DECIMAL(12,2)` carries at most 14 significant digits and a
 * double keeps 15, so every amount the schema can store survives the round trip
 * to its cent. NULL never reaches a type parser (`pg` sets the field to null
 * first), so the callback only ever sees the digit text.
 */
types.setTypeParser(NUMERIC_OID, (value: string) => Number.parseFloat(value));

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
    });

    pool.on('error', (error: Error) => {
      logger.error('Database pool error', error.stack ?? error.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
