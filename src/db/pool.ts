import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

const logger = new Logger('DbPool');

const CONNECTION_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 10000;

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
