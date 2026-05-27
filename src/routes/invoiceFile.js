/**
 * @fileoverview Invoice File Operations with Integrity Verification
 *
 * Handles PDF upload, storage, and SHA-256 hash-based integrity verification.
 * Protects against file tampering by computing and storing cryptographic hashes.
 *
 * @module routes/invoiceFile
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const storageService = require('../services/storage');
const router = express.Router();

const invoiceFiles = new Map();

function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * POST /api/invoices/:id/presigned-upload
 * Generate a presigned upload URL scoped to this invoice.
 */
router.post('/:id/presigned-upload', express.json(), async (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid invoice ID',
    });
  }

  try {
    const { fileName, mimeType, fileSize } = req.body;

    if (!fileName || !mimeType || fileSize == null) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'fileName, mimeType, and fileSize are required',
      });
    }

    const tenantId = req.user?.id || req.user?.sub || 'unknown';

    const result = await storageService.getPresignedUploadUrl({
      tenantId,
      invoiceId: id,
      fileName,
      mimeType,
      fileSize,
    });

    return res.status(201).json({
      data: {
        invoiceId: id,
        uploadUrl: result.url,
        fileKey: result.key,
      },
      message: 'Presigned upload URL generated',
    });
  } catch (error) {
    if (error.code === 'INVALID_MIME_TYPE' || error.code === 'FILE_TOO_LARGE') {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message,
      });
    }
    console.error('Presigned upload error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate presigned upload URL',
    });
  }
});

/**
 * POST /api/invoices/:id/file
 * Upload PDF file for an invoice and compute integrity hash.
 */
router.post('/:id/file', express.raw({ type: 'application/pdf', limit: '5mb' }), (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid invoice ID',
    });
  }

  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/pdf')) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Content-Type must be application/pdf',
    });
  }

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'No file data provided',
    });
  }

  const fileHash = computeHash(req.body);
  const fileSize = req.body.length;

  invoiceFiles.set(id, {
    invoiceId: id,
    fileData: req.body,
    fileHash,
    fileSize,
    contentType: 'application/pdf',
    uploadedAt: new Date().toISOString(),
  });

  return res.status(201).json({
    data: {
      invoiceId: id,
      fileHash,
      fileSize,
      uploadedAt: invoiceFiles.get(id).uploadedAt,
    },
    message: 'Invoice file uploaded successfully',
  });
});

/**
 * GET /api/invoices/:id/file
 * Retrieve the PDF file for an invoice.
 */
router.get('/:id/file', (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid invoice ID',
    });
  }

  const fileRecord = invoiceFiles.get(id);

  if (!fileRecord) {
    return res.status(404).json({
      error: 'Not Found',
      message: `No file found for invoice ${id}`,
    });
  }

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Length', fileRecord.fileSize);
  res.set('X-File-Hash', fileRecord.fileHash);
  return res.send(fileRecord.fileData);
});

/**
 * GET /api/invoices/:id/file/verify
 * Verify integrity of uploaded PDF by comparing stored hash with current file hash.
 */
router.get('/:id/file/verify', (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid invoice ID',
    });
  }

  const fileRecord = invoiceFiles.get(id);

  if (!fileRecord) {
    return res.status(404).json({
      error: 'Not Found',
      message: `No file found for invoice ${id}`,
    });
  }

  const currentHash = computeHash(fileRecord.fileData);
  const storedHash = fileRecord.fileHash;
  const isValid = currentHash === storedHash;

  return res.json({
    data: {
      invoiceId: id,
      isValid,
      storedHash,
      currentHash,
      uploadedAt: fileRecord.uploadedAt,
      verifiedAt: new Date().toISOString(),
    },
    message: isValid ? 'File integrity verified' : 'File integrity check failed',
  });
});

/**
 * POST /api/invoices/:id/file/verify
 * Verify integrity of a provided PDF against the stored hash.
 */
router.post('/:id/file/verify', express.raw({ type: 'application/pdf', limit: '5mb' }), (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid invoice ID',
    });
  }

  const fileRecord = invoiceFiles.get(id);

  if (!fileRecord) {
    return res.status(404).json({
      error: 'Not Found',
      message: `No file found for invoice ${id}`,
    });
  }

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'No file data provided for verification',
    });
  }

  const providedHash = computeHash(req.body);
  const storedHash = fileRecord.fileHash;
  const isValid = providedHash === storedHash;

  return res.json({
    data: {
      invoiceId: id,
      isValid,
      storedHash,
      providedHash,
      uploadedAt: fileRecord.uploadedAt,
      verifiedAt: new Date().toISOString(),
    },
    message: isValid ? 'File integrity verified' : 'File integrity check failed - file may have been tampered with',
  });
});

module.exports = router;
