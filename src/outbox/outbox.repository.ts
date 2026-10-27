import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import type { OutboxRow } from '../db/rows.js';

@Injectable()
export class OutboxRepository {
  /**
   * Fetches pending outbox events using partial index `idx_outbox_pending`.
   */
  async fetchPendingEvents(batchSize = 20): Promise<OutboxRow[]> {
    const pool = getPool();
    const res = await pool.query<OutboxRow>(
      `SELECT * FROM "order".outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1;`,
      [batchSize],
    );
    return res.rows;
  }

  /**
   * Marks an outbox event as published with current timestamp.
   */
  async markPublished(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE "order".outbox
       SET status = 'published', published_at = now()
       WHERE id = $1;`,
      [id],
    );
  }

  /**
   * Increments attempt count and marks as failed after 5 retries.
   */
  async markFailed(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE "order".outbox
       SET attempts = attempts + 1,
           status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END
       WHERE id = $1;`,
      [id],
    );
  }
}
