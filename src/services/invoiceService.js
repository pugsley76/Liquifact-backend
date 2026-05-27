/*
 * Consolidated Invoice Service
 * Canonical implementation that supports both query-style `getInvoices(queryParams)`
 * used by API routes/tests and tenant-scoped `getInvoices(tenantId, status)` used elsewhere.
 *
 * Preserves soft-delete via `deleted_at`, tenant scoping, KYC helpers, and exports
 * a `mockInvoices` array for tests that rely on in-memory fixtures.
 */

'use strict';

const db = require('../db/knex');
const { applyQueryOptions } = require('../utils/queryBuilder');
const logger = require('../logger');

const INVOICE_QUERY_CONFIG = {
  allowedFilters: ['status', 'smeId', 'buyerId', 'dateFrom', 'dateTo'],
  allowedSortFields: ['amount', 'date'],
  columnMap: {
    smeId: 'sme_id',
    buyerId: 'buyer_id',
    dateFrom: 'date',
    dateTo: 'date',
  },
};

const mockInvoices = [
  {
    id: 'inv_1',
    status: 'pending_verification',
    amount: 1000,
    customer: 'Alice Corp',
    ownerId: 'user_1',
    smeId: 'sme_001',
    kycStatus: 'pending',
    kycRecordId: null,
    kycStatusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
  },
  {
    id: 'inv_2',
    status: 'verified',
    amount: 2000,
    customer: 'Bob Inc',
    ownerId: 'user_1',
    smeId: 'sme_002',
    kycStatus: 'verified',
    kycRecordId: 'kyc_sme_002_001',
    kycStatusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
  },
];

async function getInvoices(arg1 = {}, arg2) {
  // If first argument is an object, treat it as queryParams (even empty {})
  if (arg1 && typeof arg1 === 'object') {
    const queryParams = arg1;
    try {
      let query = db('invoices').select('*');
      query = applyQueryOptions(query, queryParams, INVOICE_QUERY_CONFIG);
      return await query;
    } catch (err) {
      logger.error({ err }, 'Error fetching invoices');
      throw new Error('Database error while fetching invoices');
    }
  }

  // Otherwise treat args as (tenantId, status)
  const tenantId = arg1;
  const status = arg2;
  if (!tenantId) {
    throw new TypeError('tenantId is required');
  }

  let query = db('invoices').where({ tenant_id: tenantId, deleted_at: null }).orderBy('created_at', 'desc');
  if (status) query = query.where({ status });
  return await query;
}

async function getInvoiceById(id, tenantId) {
  if (!id || typeof id !== 'string') {
    throw new TypeError('Invalid invoice ID');
  }
  const invoice = await db('invoices').where({ invoice_id: id, tenant_id: tenantId, deleted_at: null }).first();
  return invoice || null;
}

async function createInvoice(invoiceData, tenantId) {
  const { amount, customer, status = 'pending', metadata } = invoiceData || {};
  const invoiceId = `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const [newInvoice] = await db('invoices')
    .insert({ invoice_id: invoiceId, amount, customer, status, tenant_id: tenantId, metadata: metadata || null })
    .returning('*');
  return newInvoice;
}

async function updateInvoice(id, updates = {}, tenantId) {
  if (!id) throw new TypeError('invoice id required');
  const nowVal = db && db.fn && typeof db.fn.now === 'function' ? db.fn.now() : new Date().toISOString();
  const [updated] = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).update({ ...updates, updated_at: nowVal }).returning('*');
  return updated || null;
}

async function deleteInvoice(id, tenantId) {
  if (!id) throw new TypeError('invoice id required');
  const nowVal = db && db.fn && typeof db.fn.now === 'function' ? db.fn.now() : new Date().toISOString();
  const [updated] = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).update({ deleted_at: nowVal }).returning('*');
  return updated || null;
}

function getInvoicesByKycStatus(userId, kycStatus) {
  if (!userId) throw new TypeError('User ID required');
  let filtered = mockInvoices.filter((inv) => inv.ownerId === userId && !inv.deletedAt);
  if (kycStatus) filtered = filtered.filter((inv) => inv.kycStatus === kycStatus);
  return filtered;
}

function updateInvoiceKycStatus(invoiceId, newKycStatus, kycRecordId = null) {
  const invoice = mockInvoices.find((inv) => inv.id === invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  const validStatuses = ['pending', 'verified', 'rejected', 'exempted'];
  if (!validStatuses.includes(newKycStatus)) throw new Error(`Invalid KYC status: ${newKycStatus}`);
  const previousStatus = invoice.kycStatus;
  invoice.kycStatus = newKycStatus;
  invoice.kycRecordId = kycRecordId;
  invoice.kycStatusUpdatedAt = new Date().toISOString();
  logger.info({ invoiceId, previousStatus, newStatus: newKycStatus }, 'Invoice KYC status updated');
  return invoice;
}

module.exports = {
  getInvoices,
  getInvoiceById,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  getInvoicesByKycStatus,
  updateInvoiceKycStatus,
  mockInvoices,
  INVOICE_QUERY_CONFIG,
};
