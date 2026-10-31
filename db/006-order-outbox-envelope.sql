-- 006 — order.outbox becomes a real outbox.
--
-- ord-011: the table predates @ecom/messaging. It stored a bare `payload` and
-- the relay was a local poller that logged instead of publishing, so a row could
-- be marked `published` without ever leaving the service. This migration adds
-- the canonical envelope and the columns the shared relay claims with.

BEGIN;

ALTER TABLE "order".outbox ADD COLUMN IF NOT EXISTS envelope jsonb NULL;
ALTER TABLE "order".outbox ADD COLUMN IF NOT EXISTS locked_until timestamptz NULL;
ALTER TABLE "order".outbox ADD COLUMN IF NOT EXISTS last_error text NULL;

-- Rows written before the envelope existed can never be published as contracts
-- 1.8.0 envelopes: the original bytes are the only record of what consumers
-- already received, and the canonical shape cannot be reconstructed from them.
-- Park them where an operator can see them instead of retrying forever.
UPDATE "order".outbox
   SET status = 'failed',
       last_error = 'pre-envelope row (migration 006)'
 WHERE envelope IS NULL
   AND status = 'pending';

-- `payload` stays as audit data for the rows above, and new rows leave it null.
ALTER TABLE "order".outbox ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE "order".outbox DROP CONSTRAINT IF EXISTS outbox_pending_has_envelope;
ALTER TABLE "order".outbox
  ADD CONSTRAINT outbox_pending_has_envelope
  CHECK (status <> 'pending' OR envelope IS NOT NULL);

ALTER TABLE "order".outbox DROP CONSTRAINT IF EXISTS outbox_envelope_type_matches;
ALTER TABLE "order".outbox
  ADD CONSTRAINT outbox_envelope_type_matches
  CHECK (envelope IS NULL OR envelope->>'type' = event_type);

ALTER TABLE "order".outbox DROP CONSTRAINT IF EXISTS outbox_envelope_id_matches;
ALTER TABLE "order".outbox
  ADD CONSTRAINT outbox_envelope_id_matches
  CHECK (envelope IS NULL OR envelope->>'id' = event_id::text);

-- The shared claim query is `WHERE status = 'pending' ORDER BY created_at`, so
-- the index drops the leading `status` column the local poller needed.
DROP INDEX IF EXISTS "order".idx_outbox_pending;
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON "order".outbox (created_at) WHERE status = 'pending';

COMMIT;
