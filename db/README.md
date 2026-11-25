# Database migrations — order-svc

The `NNN-*.sql` files apply in filename order against the `order` schema. There
is no migration runner in this repo: an operator applies them with `psql` (or any
client that executes the whole file as one script), e.g.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/001-order-schema.sql
# ... through the highest number present
```

Every file is re-runnable (`IF NOT EXISTS`, guarded `UPDATE`s, `BEGIN`/`COMMIT`),
so re-applying an earlier number is safe. `test/schema.e2e-spec.ts` walks the same
directory in sorted order, so a new `db/NNN-*.sql` file is exercised by that suite
without a test edit.

## Migration index

| File | Purpose |
| --- | --- |
| `001-order-schema.sql` | Base `order` schema: orders, items, history, payments, discounts, shipments, outbox. |
| `002-seed-orders.sql` | Seed data for local development. |
| `003-orders-stock-reservation.sql` | Reservation/idempotency columns added to orders. |
| `004-orders-idempotency.sql` | Idempotency key/body-hash columns and uniqueness. |
| `005-order-refunds.sql` | Refund table and one-refund-per-order guard. |
| `006-order-outbox-envelope.sql` | Canonical envelope columns; parks pre-envelope pending rows as `failed`. |
| `007-canonical-envelope-backfill.sql` | Rewrites pending 1.x envelopes to the contracts 2.0.0 shape. |

## 007 — contracts 2.0.0 envelope backfill

`@ecom/contracts` 2.0.0 requires every envelope to carry `type`, `version` and
`idempotencyKey`, and rejects the 1.x `topic`/`eventType` aliases. Rows still
pending when the service repins were written by `@ecom/messaging` 0.1/0.2 with
those aliases; the relay would otherwise retry them until they are parked as
failed without ever publishing. Run 007 **before** starting the 2.0.0 relay.

The migration:

- touches only rows with `status = 'pending'` and a non-null envelope;
- removes `topic` and `eventType` from the stored envelope;
- fills a missing/blank `type`, `version` or `idempotencyKey`, taking the event
  name from `event_type` and the key from the envelope `id` or `event_id`;
- leaves `timestamp`, `producer`, `payload`, published rows and failed rows as
  they are — rewriting history is not part of a cutover.

It is idempotent: once a row has a canonical envelope it no longer matches the
`WHERE` clause, so a second run changes nothing. To confirm the backfill took
effect:

```sql
SELECT count(*) AS pending_with_legacy_aliases
  FROM "order".outbox
 WHERE status = 'pending'
   AND (envelope ? 'topic' OR envelope ? 'eventType');
-- expect 0
```
