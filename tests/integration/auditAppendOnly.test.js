'use strict';

const knexLib = require('knex');
const { appendAuditEvent } = require('../../src/services/auditLogStore');

const DEFAULT_PG_URL =
  process.env.DATABASE_URL ||
  'postgresql://liquifact_user:liquifact_dev_password@localhost:5432/liquifact';

function isAppendOnlyTriggerError(error) {
  const message = (error && (error.message || error.detail)) || '';
  return /audit_log_events is append-only/i.test(message);
}

describe('Audit log append-only DB triggers (Postgres)', () => {
  let pg;

  beforeAll(async () => {
    try {
      pg = knexLib({
        client: 'pg',
        connection: DEFAULT_PG_URL,
        pool: { min: 0, max: 2 },
      });

      await pg.raw('select 1 as ok');
    } catch (error) {
      pg = null;
    }

    if (!pg) {
      console.log('Postgres not available; skipping append-only trigger test (SQLite does not support these triggers).');
      return;
    }

    // Ensure extensions used by defaults exist (safe no-op if already present).
    await pg.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await pg.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    // Ensure the audit_log_events table exists with required columns.
    await pg.raw(`
      CREATE TABLE IF NOT EXISTS audit_log_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        request_id TEXT,
        route TEXT,
        method TEXT,
        status_code INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Install/refresh the append-only enforcement trigger (migration behavior).
    await pg.raw(`
      CREATE OR REPLACE FUNCTION prevent_audit_log_update_or_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log_events is append-only';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log_events;
      DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log_events;

      CREATE TRIGGER trg_audit_log_no_update
      BEFORE UPDATE ON audit_log_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_update_or_delete();

      CREATE TRIGGER trg_audit_log_no_delete
      BEFORE DELETE ON audit_log_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_update_or_delete();
    `);
  });

  afterAll(async () => {
    if (!pg) {return;}
    await pg.destroy();
  });

  test('INSERT succeeds; UPDATE and DELETE are rejected by trigger', async () => {
    if (!pg) {
      return;
    }

    const baseEvent = {
      eventType: 'escrow_indexer',
      action: 'projection_upsert',
      actorType: 'system',
      actorId: 'escrow-indexer',
      targetType: 'invoice',
      targetId: 'inv_123',
      requestId: 'req_test_1',
      route: '/jobs/escrow-indexer',
      method: 'POST',
      statusCode: 200,
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
      metadata: { source: 'stellar-horizon', chain: 'stellar' },
    };

    await appendAuditEvent(baseEvent, { db: pg });

    const inserted = await pg('audit_log_events')
      .select(['id'])
      .where({ request_id: 'req_test_1' })
      .first();

    expect(inserted).toBeTruthy();
    expect(inserted.id).toBeTruthy();

    try {
      await pg('audit_log_events').where({ id: inserted.id }).update({ action: 'mutated' });
      throw new Error('Expected UPDATE to be rejected by append-only trigger.');
    } catch (error) {
      expect(isAppendOnlyTriggerError(error)).toBe(true);
    }

    try {
      await pg('audit_log_events').where({ id: inserted.id }).del();
      throw new Error('Expected DELETE to be rejected by append-only trigger.');
    } catch (error) {
      expect(isAppendOnlyTriggerError(error)).toBe(true);
    }
  });
});
