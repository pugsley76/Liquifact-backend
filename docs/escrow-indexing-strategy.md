# Escrow Event Ingest Strategy (Issue #102)

> **See also:** [Escrow Integration Overview](./escrow-integration-overview.md) — end-to-end flow from chain events through projection tables to the API.

## Goal
Persist a durable, replayable feed of latest Liquifact escrow contract events by `invoiceId`.

## Selected Approach
Use a Horizon-driven poller with cursor checkpointing and projection tables.

- Source: Horizon events API (cursor + ascending order)
- Cursor durability: `escrow_indexer_state`
- Raw immutable event log: `escrow_events`
- Latest per-invoice projection: `escrow_event_projection`

## InvoiceId vs ContractId Resolution
Horizon contract event records are keyed on-chain by the emitting contract
address (`contract_id`), not by the business `invoiceId` the projection is
queried by (`GET /api/escrow/:invoiceId`). The mapper must therefore derive a
real `invoiceId` for each event and keep the contract address as a separate
field (`escrow_events.contract_id`, which the schema already supports).

`deriveInvoiceId(record)` resolves the invoice in priority order:

1. An explicit `invoice_id` / `invoiceId` field on the record.
2. The LiquifactEscrow event payload — the event `value` body, or a topic
   entry explicitly labelled with an invoice field. Bare topic symbols (e.g.
   the leading event-name symbol such as `escrow_funded`) and unlabelled
   scalars are **not** treated as invoice IDs to avoid false positives.
3. Reverse lookup of the emitting contract address via
   `config/escrowMap.resolveInvoiceByAddress`, which maps an active escrow
   contract address back to its invoice ID for the current environment.

Every candidate is validated against `INVOICE_ID_REGEX`
(`/^[a-zA-Z0-9_-]{1,128}$/`). Any record that does not yield a valid invoice —
including contract-only events with no resolvable mapping — is **skipped**
(filtered out before persistence) rather than mis-keyed by contract address.
This guarantees the projection is keyed only by real invoice IDs and remains
usable for invoice-scoped lookups.

Skipping a record does not stall ingestion: the Horizon cursor (`nextCursor`)
is derived from the last *record* in the batch, so the cursor advances past
skipped events on the next cycle.

## Why This Over Captive Core
- Lower operational overhead for current Express service footprint.
- Faster delivery for production-ready MVP.
- Can be upgraded later to Captive Core without schema changes.

## Security Notes
- Indexer is read-only and does not require Stellar secret keys.
- Input validation enforces `invoiceId` format and required event fields.
- InvoiceId is never inferred from the raw contract address; only an
  allowlisted, environment-scoped `escrowMap` reverse lookup or an explicit
  payload field may resolve it, so unmapped contracts cannot inject rows.
- Contract-only / unresolvable events are skipped, never mis-keyed.
- Duplicate event IDs are safely ignored by primary-key conflict handling
  (idempotent upserts on `event_id` and `invoice_id`).
- No signing keys or secrets are logged; configuration comes from `.env`
  (`ESCROW_ADDR_BY_INVOICE`, `STELLAR_HORIZON_URL`) and deployment secrets.

## Failure and Recovery
- Cursor is updated only after batch processing.
- On restart, indexer resumes from persisted cursor.
- Invalid events are skipped with warning logs to avoid deadlocking ingestion.
- Cursor is saved only when it changes to keep writes idempotent across repeated cycles.

## Upgrade Path
When throughput or deterministic replay needs exceed Horizon polling limits:
1. Deploy Captive Core feeder.
2. Keep writing to `escrow_events` and `escrow_event_projection`.
3. Reuse existing projection semantics and API readers.
