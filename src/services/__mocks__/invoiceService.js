'use strict';

module.exports = {
  getInvoices: jest.fn().mockResolvedValue([]),
  getInvoiceById: jest.fn().mockResolvedValue(null),
  createInvoice: jest.fn().mockResolvedValue(null),
  updateInvoice: jest.fn().mockResolvedValue(null),
  deleteInvoice: jest.fn().mockResolvedValue(null),
  getInvoicesByKycStatus: jest.fn().mockReturnValue([]),
  updateInvoiceKycStatus: jest.fn().mockReturnValue(null),
};
