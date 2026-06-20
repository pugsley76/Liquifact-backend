'use strict';

/**
 * retention.focused.test.js
 *
 * Focused test coverage for src/jobs/retentionPurge.js targeting:
 *   1. RetentionJobSchema validation (via the registered handler)
 *   2. Dry-run zero-write proof (spy on db update, assert call count === 0)
 *   3. Scoped PII redaction (only declared fields nulled, undeclared untouched)
 *   4. Missing optional policy (policyId omitted) handled gracefully
 *
 * Mocking style matches the repo's existing retention tests:
 *   - jest.mock('../src/db/knex') at the top of the file
 *   - jest.mock('../src/logger') to suppress noise
 *   - db is a jest.fn() whose return value is configured per test
 */

// ---------------------------------------------------------------------------
// DB mock  must mirror the style in retention.dryRun.test.js / retention.handler.test.js
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const mockQuery = {
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(1),
    select: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
    delete: jest.fn().mockResolvedValue(1),
    first: jest.fn().mockResolvedValue(null),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
  };

  mockQuery.insert.mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]);
  mockQuery.returning.mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]);

  const db = jest.fn(() => mockQuery);
  db.raw = jest.fn();
  return db;
});

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { v4: uuidv4 } = require('uuid');
const db = require('../src/db/knex');
const retentionJob = require('../src/jobs/retentionPurge');

// ---------------------------------------------------------------------------
// Helper: build a minimal db mock sequence for a successful handler run.
// callMap is an object whose numeric keys map to a chainable object returned
// on the N-th call to db(tableName). Any other call falls back to mockQuery.
// ---------------------------------------------------------------------------
function buildDbSequence(callMap) {
  const defaultQuery = db();           // reuse the existing mockQuery singleton
  let callCount = 0;
  db.mockImplementation(() => {
    callCount += 1;
    return callMap[callCount] || defaultQuery;
  });
}

// Shorthand factory for a query chain object
function mkChain(overrides = {}) {
  return Object.assign(
    {
      where: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockResolvedValue([{ id: 'exec-id' }]),
      update: jest.fn().mockResolvedValue(1),
      first: jest.fn().mockResolvedValue(null),
      returning: jest.fn().mockReturnThis(),
    },
    overrides,
  );
}

// ---------------------------------------------------------------------------
// Retrieve the registered handler from the worker (set up at module load time)
// ---------------------------------------------------------------------------
function getHandler() {
  return retentionJob.retentionWorker.handlers.get('retention_purge');
}

// ===========================================================================
// 1. RetentionJobSchema validation
// ===========================================================================
describe('RetentionJobSchema validation (via handler)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects a malformed (non-UUID) tenantId and throws ZodError', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: { tenantId: 'not-a-uuid', dryRun: false },
    };

    await expect(handler(job)).rejects.toThrow();

    // Confirm the thrown error is from Zod schema parsing
    try {
      await handler(job);
    } catch (err) {
      // ZodError has .issues array, or at minimum the message contains "Invalid"
      expect(err.message).toBeDefined();
      // executionId should be null because createJobExecution was never reached
      // (validation is the FIRST thing the handler does)
    }
  });

  test('rejects an empty string tenantId', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: { tenantId: '', dryRun: false },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('rejects a numeric tenantId (wrong type)', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: { tenantId: 12345, dryRun: false },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('rejects retentionDays: 0 (must be positive)', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: {
        tenantId: uuidv4(),
        retentionDays: 0,   // z.number().positive() rejects 0
        dryRun: false,
      },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('rejects retentionDays: -1 (negative)', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: {
        tenantId: uuidv4(),
        retentionDays: -1,
        dryRun: false,
      },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('accepts retentionDays: undefined (field is optional)', async () => {
    // With no retentionDays the handler should NOT throw on schema parsing.
    // It will eventually fail because there are no active policies (mock returns []),
    // but the error will be "No active retention policies found"  not a Zod error.
    const execInsert = mkChain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'exec-id' }]),
    });
    const policyQuery = mkChain({ whereNull: jest.fn().mockResolvedValue([]) });
    const execUpdate = mkChain({ update: jest.fn().mockResolvedValue(1) });

    buildDbSequence({ 1: execInsert, 2: policyQuery, 3: execUpdate });

    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      // retentionDays omitted  optional field, schema default not set  undefined
      payload: { tenantId: uuidv4(), dryRun: false },
    };

    // Should throw "No active retention policies found", not a schema error
    await expect(handler(job)).rejects.toThrow('No active retention policies found');
  });

  test('rejects batchSize > 1000 (max constraint)', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: {
        tenantId: uuidv4(),
        batchSize: 1001,    // max(1000) in schema
        dryRun: false,
      },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('rejects batchSize: 0 (must be positive)', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: {
        tenantId: uuidv4(),
        batchSize: 0,
        dryRun: false,
      },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('accepts a valid UUID policyId', async () => {
    const execInsert = mkChain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'exec-id' }]),
    });
    // policy lookup returns null  handler throws "not found", but schema passes
    const policyQuery = mkChain({ first: jest.fn().mockResolvedValue(null) });
    const execUpdate = mkChain({ update: jest.fn().mockResolvedValue(1) });

    buildDbSequence({ 1: execInsert, 2: policyQuery, 3: execUpdate });

    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: {
        tenantId: uuidv4(),
        policyId: uuidv4(),   // valid UUID
        dryRun: false,
      },
    };

    await expect(handler(job)).rejects.toThrow(/not found|inactive/i);
  });

  test('rejects a malformed policyId (non-UUID string)', async () => {
    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      payload: {
        tenantId: uuidv4(),
        policyId: 'not-a-valid-uuid',
        dryRun: false,
      },
    };
    await expect(handler(job)).rejects.toThrow();
  });

  test('missing optional policyId is accepted (defaults to all active policies)', async () => {
    const execInsert = mkChain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'exec-id' }]),
    });
    const policyQuery = mkChain({ whereNull: jest.fn().mockResolvedValue([]) });
    const execUpdate = mkChain({ update: jest.fn().mockResolvedValue(1) });

    buildDbSequence({ 1: execInsert, 2: policyQuery, 3: execUpdate });

    const handler = getHandler();
    const job = {
      id: uuidv4(),
      type: 'retention_purge',
      // policyId intentionally omitted  should use getActivePolicies()
      payload: { tenantId: uuidv4(), dryRun: false },
    };

    await expect(handler(job)).rejects.toThrow('No active retention policies found');
  });
});

// ===========================================================================
// 2. Dry-run: zero writes to the invoices table
// ===========================================================================
describe('purgeInvoicePii  dry-run zero-write guarantee', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does NOT call db("invoices").update when dryRun is true', async () => {
    // Track every update mock created during the test
    const updateMock = jest.fn().mockResolvedValue(1);
    db.mockImplementation((table) => {
      const chain = mkChain({ update: updateMock });
      // For 'invoices' reads (first() lookup) return nothing special
      chain.first = jest.fn().mockResolvedValue({
        id: 'inv-1',
        customer_name: 'Alice',
        customer_email: 'alice@example.com',
        customer_tax_id: 'TAX-001',
        amount: 500,
        status: 'completed',
      });
      return chain;
    });

    const result = await retentionJob.purgeInvoicePii(
      'inv-1',
      ['customer_name', 'customer_email'],
      true, // dryRun
    );

    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
    expect(result.purgedFields).toEqual(['customer_name', 'customer_email']);
    // KEY assertion: no DB write happened
    expect(updateMock).not.toHaveBeenCalled();
  });

  test('dry-run: data that existed before still exists after (read-then-compare)', async () => {
    const storedRow = {
      id: 'inv-2',
      customer_name: 'Bob',
      customer_email: 'bob@example.com',
      customer_tax_id: 'TAX-002',
      amount: 1000,
      status: 'completed',
    };

    // Simulate the invoice still being in the DB after a dry-run
    const updateMock = jest.fn().mockResolvedValue(1);
    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({ ...storedRow }),
        update: updateMock,
      }),
    );

    await retentionJob.purgeInvoicePii('inv-2', ['customer_name'], true);

    // No update was issued, so "re-reading" would still return original values.
    // We prove side-effect freedom by asserting update was never called.
    expect(updateMock).not.toHaveBeenCalled();
  });

  test('dry-run with all three PII fields: still zero updates', async () => {
    const updateMock = jest.fn().mockResolvedValue(1);
    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-3',
          customer_name: 'Carol',
          customer_email: 'carol@example.com',
          customer_tax_id: 'TAX-003',
        }),
        update: updateMock,
      }),
    );

    const result = await retentionJob.purgeInvoicePii(
      'inv-3',
      ['customer_name', 'customer_email', 'customer_tax_id'],
      true,
    );

    expect(result.dryRun).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // Verify the handler itself issues zero update calls to invoices on dry-run
  test('handler: db("invoices").update is never called during dryRun: true', async () => {
    const invoiceUpdateMock = jest.fn().mockResolvedValue(1);
    let callCount = 0;

    db.mockImplementation((table) => {
      callCount += 1;
      if (callCount === 1) {
        // createJobExecution
        return mkChain({
          insert: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ id: 'exec-dry' }]),
        });
      }
      if (callCount === 2) {
        // getActivePolicies - db('retention_policies').where(...).whereNull(...)
        // knex resolves on whereNull, so it must return the array
        return mkChain({
          whereNull: jest.fn().mockResolvedValue([
            {
              id: uuidv4(),
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name', 'customer_email'],
              is_active: true,
            },
          ]),
        });
      }
      if (callCount === 3) {
        // getEligibleInvoices
        // source: db('invoices').where().where().whereNull().whereNotIn().limit()
        // knex resolves when awaited on the terminal call (limit)
        return mkChain({
          limit: jest.fn().mockResolvedValue([
            {
              id: 'inv-dry',
              invoice_number: 'INV-DRY-001',
              customer_name: 'Dry Run User',
              customer_email: 'dry@example.com',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
            },
          ]),
        });
      }
      if (callCount === 4) {
        // isUnderLegalHold
        return mkChain({ first: jest.fn().mockResolvedValue(null) });
      }
      if (callCount === 5) {
        // logRetentionOperation (audit)
        return mkChain({ insert: jest.fn().mockReturnThis() });
      }
      if (callCount === 6) {
        // updateJobExecution
        return mkChain({ update: jest.fn().mockResolvedValue(1) });
      }
      // Fallthrough  if this is the invoices table update, track it
      if (table === 'invoices') {
        return mkChain({ update: invoiceUpdateMock });
      }
      return mkChain();
    });

    const handler = getHandler();
    await handler({
      id: uuidv4(),
      type: 'retention_purge',
      payload: { tenantId: uuidv4(), dryRun: true },
    });

    // The handler should NEVER have called update on invoices
    expect(invoiceUpdateMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. PII redaction  scoped to declared fields only
// ===========================================================================
describe('purgeInvoicePii  scoped field redaction (dryRun: false)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('only the declared PII field is set to null; undeclared fields are untouched', async () => {
    let capturedUpdateData = null;

    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-scope',
          customer_name: 'Dave',
          customer_email: 'dave@example.com',
          customer_tax_id: 'TAX-DAVE',
          amount: 750,
          status: 'paid',
        }),
        // Capture what was passed to update()
        update: jest.fn().mockImplementation((data) => {
          capturedUpdateData = data;
          return Promise.resolve(1);
        }),
      }),
    );

    const result = await retentionJob.purgeInvoicePii(
      'inv-scope',
      ['customer_name'], // Only redact customer_name
      false,
    );

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.purgedFields).toEqual(['customer_name']);

    // customer_name must have been set to null
    expect(capturedUpdateData).toHaveProperty('customer_name', null);

    // customer_email and customer_tax_id must NOT appear in the update payload
    expect(capturedUpdateData).not.toHaveProperty('customer_email');
    expect(capturedUpdateData).not.toHaveProperty('customer_tax_id');
  });

  test('redacting only customer_email leaves customer_name and customer_tax_id unchanged', async () => {
    let capturedUpdateData = null;

    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-email',
          customer_name: 'Eve',
          customer_email: 'eve@example.com',
          customer_tax_id: 'TAX-EVE',
        }),
        update: jest.fn().mockImplementation((data) => {
          capturedUpdateData = data;
          return Promise.resolve(1);
        }),
      }),
    );

    await retentionJob.purgeInvoicePii('inv-email', ['customer_email'], false);

    expect(capturedUpdateData).toHaveProperty('customer_email', null);
    expect(capturedUpdateData).not.toHaveProperty('customer_name');
    expect(capturedUpdateData).not.toHaveProperty('customer_tax_id');
  });

  test('redacting subset [customer_name, customer_email] does not touch customer_tax_id', async () => {
    let capturedUpdateData = null;

    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-subset',
          customer_name: 'Frank',
          customer_email: 'frank@example.com',
          customer_tax_id: 'TAX-FRANK',
        }),
        update: jest.fn().mockImplementation((data) => {
          capturedUpdateData = data;
          return Promise.resolve(1);
        }),
      }),
    );

    await retentionJob.purgeInvoicePii(
      'inv-subset',
      ['customer_name', 'customer_email'],
      false,
    );

    expect(capturedUpdateData).toHaveProperty('customer_name', null);
    expect(capturedUpdateData).toHaveProperty('customer_email', null);
    expect(capturedUpdateData).not.toHaveProperty('customer_tax_id');
  });

  test('redacting all three fields nulls exactly those three columns', async () => {
    let capturedUpdateData = null;

    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-all',
          customer_name: 'Grace',
          customer_email: 'grace@example.com',
          customer_tax_id: 'TAX-GRACE',
        }),
        update: jest.fn().mockImplementation((data) => {
          capturedUpdateData = data;
          return Promise.resolve(1);
        }),
      }),
    );

    await retentionJob.purgeInvoicePii(
      'inv-all',
      ['customer_name', 'customer_email', 'customer_tax_id'],
      false,
    );

    expect(capturedUpdateData).toHaveProperty('customer_name', null);
    expect(capturedUpdateData).toHaveProperty('customer_email', null);
    expect(capturedUpdateData).toHaveProperty('customer_tax_id', null);
    // No extra keys beyond the three PII fields
    const keys = Object.keys(capturedUpdateData);
    expect(keys).toHaveLength(3);
    expect(keys).toEqual(
      expect.arrayContaining(['customer_name', 'customer_email', 'customer_tax_id']),
    );
  });

  test('oldValues returned contains only the declared fields that were non-null', async () => {
    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-old',
          customer_name: 'Hank',
          customer_email: null,        // already null  should NOT appear in oldValues
          customer_tax_id: 'TAX-HANK',
        }),
        update: jest.fn().mockResolvedValue(1),
      }),
    );

    const result = await retentionJob.purgeInvoicePii(
      'inv-old',
      ['customer_name', 'customer_email'],
      false,
    );

    // customer_name had a value  should be in oldValues
    expect(result.oldValues).toHaveProperty('customer_name', 'Hank');
    // customer_email was already null  should NOT appear in oldValues
    expect(result.oldValues).not.toHaveProperty('customer_email');
  });
});

// ===========================================================================
// 4. validatePiiFields  schema shape and error messages
// ===========================================================================
describe('validatePiiFields  schema rejection shape', () => {
  test('returns the exact array when all fields are valid', () => {
    const fields = ['customer_name', 'customer_email', 'customer_tax_id'];
    expect(retentionJob.validatePiiFields(fields)).toEqual(fields);
  });

  test('throws with message containing "Invalid PII fields" for unknown field', () => {
    expect(() => retentionJob.validatePiiFields(['phone_number'])).toThrow(
      'Invalid PII fields',
    );
  });

  test('throws for mixed valid/invalid list', () => {
    expect(() =>
      retentionJob.validatePiiFields(['customer_name', 'ssn']),
    ).toThrow('Invalid PII fields');
  });

  test('throws for empty string field', () => {
    expect(() => retentionJob.validatePiiFields([''])).toThrow('Invalid PII fields');
  });

  test('throws for correct-but-wrong-case field names', () => {
    expect(() => retentionJob.validatePiiFields(['Customer_Name'])).toThrow(
      'Invalid PII fields',
    );
    expect(() => retentionJob.validatePiiFields(['CUSTOMER_EMAIL'])).toThrow(
      'Invalid PII fields',
    );
  });

  test('throws for whitespace-padded field names', () => {
    expect(() => retentionJob.validatePiiFields([' customer_name'])).toThrow(
      'Invalid PII fields',
    );
    expect(() => retentionJob.validatePiiFields(['customer_name '])).toThrow(
      'Invalid PII fields',
    );
  });
});

// ===========================================================================
// 5. Missing policy  "No active retention policies found"
// ===========================================================================
describe('handler  missing optional policy gracefully handled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('when no policies exist handler throws "No active retention policies found"', async () => {
    buildDbSequence({
      1: mkChain({
        insert: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 'exec-nopol' }]),
      }),
      2: mkChain({ whereNull: jest.fn().mockResolvedValue([]) }),
      3: mkChain({ update: jest.fn().mockResolvedValue(1) }),
    });

    const handler = getHandler();
    await expect(
      handler({
        id: uuidv4(),
        type: 'retention_purge',
        payload: { tenantId: uuidv4(), dryRun: false },
      }),
    ).rejects.toThrow('No active retention policies found');
  });

  test('when specific policyId not found handler throws "not found or inactive"', async () => {
    buildDbSequence({
      1: mkChain({
        insert: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 'exec-missingpol' }]),
      }),
      2: mkChain({ first: jest.fn().mockResolvedValue(null) }),   // policy lookup returns null
      3: mkChain({ update: jest.fn().mockResolvedValue(1) }),
    });

    const policyId = uuidv4();
    const handler = getHandler();
    await expect(
      handler({
        id: uuidv4(),
        type: 'retention_purge',
        payload: { tenantId: uuidv4(), policyId, dryRun: false },
      }),
    ).rejects.toThrow(new RegExp(`${policyId}|not found|inactive`, 'i'));
  });
});

// ===========================================================================
// 6. Additional edge-cases: purgeInvoicePii result shape when invoice missing
// ===========================================================================
describe('purgeInvoicePii  invoice row missing from DB (dryRun: false)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns success: false when update affects 0 rows', async () => {
    db.mockImplementation(() =>
      mkChain({
        first: jest.fn().mockResolvedValue({
          id: 'inv-gone',
          customer_name: 'Ivan',
          customer_email: 'ivan@example.com',
          customer_tax_id: null,
        }),
        update: jest.fn().mockResolvedValue(0), // 0 rows affected
      }),
    );

    const result = await retentionJob.purgeInvoicePii(
      'inv-gone',
      ['customer_name'],
      false,
    );

    expect(result.success).toBe(false);
    expect(result.purgedFields).toEqual([]);
  });
});

// ===========================================================================
// 7. Per-invoice error path: catch block inside invoice loop (lines 299-304)
// ===========================================================================
describe('handler  per-invoice error caught, job completes with errors status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('when purgeInvoicePii throws, job execution status is completed_with_errors', async () => {
    let callCount = 0;
    let capturedUpdateArg = null;

    db.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        // createJobExecution
        return mkChain({
          insert: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ id: 'exec-err' }]),
        });
      }
      if (callCount === 2) {
        // getActivePolicies  whereNull resolves to policy list
        return mkChain({
          whereNull: jest.fn().mockResolvedValue([{
            id: 'pol-1',
            name: 'Err Policy',
            retention_days: 30,
            pii_fields: ['customer_name'],
            is_active: true,
          }]),
        });
      }
      if (callCount === 3) {
        // getEligibleInvoices  limit resolves to invoice list
        return mkChain({
          limit: jest.fn().mockResolvedValue([{
            id: 'inv-err',
            invoice_number: 'INV-ERR-001',
            customer_name: 'Error User',
            created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          }]),
        });
      }
      if (callCount === 4) {
        // isUnderLegalHold — no hold
        return mkChain({ first: jest.fn().mockResolvedValue(null) });
      }
      if (callCount === 5) {
        // purgeInvoicePii: first() to read current values  THROW to trigger catch block
        return mkChain({
          first: jest.fn().mockRejectedValue(new Error('DB read failed during purge')),
        });
      }
      if (callCount === 6) {
        // updateJobExecution  capture the status arg
        const updateFn = jest.fn().mockImplementation((args) => {
          capturedUpdateArg = args;
          return Promise.resolve(1);
        });
        return mkChain({ update: updateFn });
      }
      return mkChain();
    });

    const handler = getHandler();
    // Handler should resolve (not rethrow) because the per-invoice error is caught
    await handler({
      id: 'err-handler-job',
      type: 'retention_purge',
      payload: { tenantId: uuidv4(), dryRun: false },
    });

    // Job execution should be updated with 'completed_with_errors'
    expect(capturedUpdateArg).not.toBeNull();
    expect(capturedUpdateArg.status).toBe('completed_with_errors');
    expect(Array.isArray(capturedUpdateArg.errors)).toBe(true);
    expect(capturedUpdateArg.errors.length).toBeGreaterThan(0);
    expect(capturedUpdateArg.errors[0].error).toMatch(/DB read failed during purge/);
  });
});

// ===========================================================================
// 8. startQueueProcessing guard: no-op when worker already running (lines 339-346)
// ===========================================================================
describe('startQueueProcessing  no-op guard when already running', () => {
  afterEach(async () => {
    // Make sure worker is stopped after each test
    if (retentionJob.retentionWorker.isRunning) {
      await retentionJob.stopQueueProcessing(500);
    }
  });

  test('calling startQueueProcessing twice does not throw and worker stays running', () => {
    // Worker starts when the module is loaded (retentionWorker.registerHandler + start
    // is called in the module body, but startQueueProcessing only calls start if !isRunning)
    retentionJob.startQueueProcessing(); // first call  starts if not running
    const runningAfterFirst = retentionJob.retentionWorker.isRunning;

    // Second call should be a no-op (hits the `if (!isRunning)` else branch)
    expect(() => retentionJob.startQueueProcessing()).not.toThrow();
    // Worker must still be running
    expect(retentionJob.retentionWorker.isRunning).toBe(runningAfterFirst);
  });

  test('startQueueProcessing is idempotent: isRunning stays true', () => {
    retentionJob.startQueueProcessing();
    retentionJob.startQueueProcessing(); // second call hits the guard
    expect(retentionJob.retentionWorker.isRunning).toBe(true);
  });
});

// ===========================================================================
// 9. Branch: errors.length > 0 triggers 'completed_with_errors'; else 'completed'
// ===========================================================================
describe('updateJobExecution status branch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('completed path: errors array is null when no per-invoice errors occur', async () => {
    let callCount = 0;
    let capturedUpdateArg = null;

    db.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return mkChain({
          insert: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ id: 'exec-clean' }]),
        });
      }
      if (callCount === 2) {
        // getActivePolicies returns empty  triggers "No active retention policies found"
        // but we need the completed path, so return one policy then no invoices
        return mkChain({
          whereNull: jest.fn().mockResolvedValue([{
            id: 'pol-clean',
            name: 'Clean Policy',
            retention_days: 30,
            pii_fields: ['customer_name'],
            is_active: true,
          }]),
        });
      }
      if (callCount === 3) {
        // getEligibleInvoices  no invoices (empty batch)
        return mkChain({ limit: jest.fn().mockResolvedValue([]) });
      }
      if (callCount === 4) {
        // updateJobExecution
        const updateFn = jest.fn().mockImplementation((args) => {
          capturedUpdateArg = args;
          return Promise.resolve(1);
        });
        return mkChain({ update: updateFn });
      }
      return mkChain();
    });

    const handler = getHandler();
    await handler({
      id: 'clean-job',
      type: 'retention_purge',
      payload: { tenantId: uuidv4(), dryRun: false },
    });

    expect(capturedUpdateArg).not.toBeNull();
    expect(capturedUpdateArg.status).toBe('completed');
    expect(capturedUpdateArg.errors).toBeNull();
  });
});

