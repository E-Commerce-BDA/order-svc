-- 007 — contracts 2.0.0 canonical envelopes for pending outbox rows.
--
-- 006 parked pre-envelope rows as failed, so a pending row here was written by
-- messaging 0.1/0.2 with a 1.x envelope: one canonical `type` plus the legacy
-- `topic`/`eventType` aliases. contracts 2.0.0 validates the envelope strictly,
-- no longer reads those aliases, and requires `type`/`version`/`idempotencyKey`.
-- Without this backfill the relay would retry the affected rows until they are
-- parked as failed without ever being published.
--
-- Only pending rows are rewritten; published rows are history and failed rows
-- are an operator's queue. When a field is absent, the value comes from the row
-- itself (`event_type`, `event_id`) so the 006 envelope/check constraints keep
-- holding. `timestamp`, `producer` and `payload` are left alone: a 1.x envelope
-- already carried them, and inventing new ones would change the event.
--
-- Idempotent: the WHERE clause stops matching once every alias is gone and the
-- three required fields are present, so a second run updates zero rows.

BEGIN;

UPDATE "order".outbox
   SET envelope = (
         ((envelope - 'topic') - 'eventType')
         || jsonb_build_object(
              'type', COALESCE(
                NULLIF(envelope->>'type', ''),
                NULLIF(envelope->>'topic', ''),
                NULLIF(envelope->>'eventType', ''),
                event_type
              ),
              'version', CASE
                WHEN jsonb_typeof(envelope->'version') = 'number'
                  THEN envelope->'version'
                ELSE '1'::jsonb
              END,
              'idempotencyKey', COALESCE(
                NULLIF(envelope->>'idempotencyKey', ''),
                NULLIF(envelope->>'id', ''),
                event_id::text
              )
            )
       )
 WHERE status = 'pending'
   AND envelope IS NOT NULL
   AND (
         envelope ? 'topic'
      OR envelope ? 'eventType'
      OR COALESCE(envelope->>'type', '') = ''
      OR jsonb_typeof(envelope->'version') IS DISTINCT FROM 'number'
      OR COALESCE(envelope->>'idempotencyKey', '') = ''
   );

COMMIT;
