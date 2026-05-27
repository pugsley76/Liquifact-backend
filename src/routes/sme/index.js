/**
 * SME Routes Index
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const metricsRoutes = require('./metrics');
const multer = require('multer');
const storageService = require('../../services/storage');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 512 * 1024,
  },
});

router.use('/', metricsRoutes);

// POST /api/sme/invoice/presigned-url - Request a presigned upload URL
router.post('/invoice/presigned-url', express.json(), async (req, res) => {
  try {
    const { fileName, mimeType, fileSize } = req.body;

    if (!fileName || !mimeType || fileSize == null) {
      return res.status(400).json({
        error: 'fileName, mimeType, and fileSize are required',
      });
    }

    const tenantId = req.user?.id || req.user?.sub || 'unknown';
    const invoiceId = req.body.invoiceId || crypto.randomUUID();

    const result = await storageService.getPresignedUploadUrl({
      tenantId,
      invoiceId,
      fileName,
      mimeType,
      fileSize,
    });

    res.json({
      message: 'Presigned upload URL generated',
      uploadUrl: result.url,
      fileKey: result.key,
      invoiceId,
    });
  } catch (error) {
    if (error.code === 'INVALID_MIME_TYPE' || error.code === 'FILE_TOO_LARGE') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Presigned URL error:', error);
    res.status(500).json({ error: 'Failed to generate presigned upload URL' });
  }
});

// POST /api/sme/invoice - Upload PDF invoice
router.post('/invoice', upload.single('invoice'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Invoice file is required' });
    }

    const tenantId = req.user?.id || req.user?.sub || 'unknown';
    const invoiceId = req.body?.invoiceId || crypto.randomUUID();

    const key = await storageService.uploadFile(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      tenantId,
      invoiceId
    );

    const signedUrl = await storageService.getSignedUrl(key);

    res.json({
      message: 'Invoice uploaded successfully',
      fileKey: key,
      signedUrl,
      invoiceId,
    });
  } catch (error) {
    if (error.code === 'INVALID_MIME_TYPE' || error.code === 'FILE_TOO_LARGE') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload invoice' });
  }
});

module.exports = router;
