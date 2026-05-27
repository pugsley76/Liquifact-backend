const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
const DEFAULT_MAX_FILE_SIZE = 512 * 1024; // 512 KB
const DEFAULT_UPLOAD_URL_EXPIRY_SEC = 900; // 15 minutes
const DEFAULT_DOWNLOAD_URL_EXPIRY_SEC = 3600; // 1 hour
const MAX_DOWNLOAD_URL_EXPIRY_SEC = 86400; // 24 hours

function parseSize(sizeStr) {
  if (typeof sizeStr !== 'string' || sizeStr.trim() === '') {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(value * multipliers[unit]);
}

const MAX_FILE_SIZE = parseSize(process.env.BODY_LIMIT_INVOICE || '512kb');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

class StorageService {
  constructor() {
    this.bucket = process.env.S3_BUCKET || 'liquifact-invoices';
    this.maxFileSize = MAX_FILE_SIZE;
  }

  _sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      return 'unnamed';
    }
    let name = filename.replace(/\\/g, '/');
    name = path.basename(name);
    name = name.replace(/\0/g, '');
    name = name.replace(/\.\./g, '');
    name = name.replace(/[<>:"|?*\\/]/g, '_');
    return name.slice(0, 255) || 'unnamed';
  }

  _validateMimeType(mimeType) {
    return ALLOWED_MIME_TYPES.includes(mimeType);
  }

  _generateKey(tenantId, invoiceId, safeName) {
    const uuid = crypto.randomUUID();
    return `tenants/${tenantId}/invoices/${invoiceId}/${uuid}-${safeName}`;
  }

  async uploadFile(fileBuffer, fileName, mimeType, tenantId = 'unknown', invoiceId = 'unknown') {
    if (fileBuffer.length > this.maxFileSize) {
      const err = new Error(`File size ${fileBuffer.length} exceeds maximum of ${this.maxFileSize} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }
    if (!this._validateMimeType(mimeType)) {
      const err = new Error(`Invalid MIME type: "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_MIME_TYPE';
      throw err;
    }

    const safeName = this._sanitizeFilename(fileName);
    const key = this._generateKey(tenantId, invoiceId, safeName);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    });
    await s3Client.send(command);
    return key;
  }

  async getPresignedUploadUrl({ tenantId, invoiceId, fileName, mimeType, fileSize }) {
    if (!this._validateMimeType(mimeType)) {
      const err = new Error(`Invalid MIME type: "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_MIME_TYPE';
      throw err;
    }
    if (fileSize > this.maxFileSize) {
      const err = new Error(`File size ${fileSize} exceeds maximum of ${this.maxFileSize} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    const safeName = this._sanitizeFilename(fileName);
    const key = this._generateKey(tenantId, invoiceId, safeName);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: fileSize,
    });

    const url = await getSignedUrl(s3Client, command, {
      expiresIn: DEFAULT_UPLOAD_URL_EXPIRY_SEC,
    });
    return { url, key };
  }

  async getSignedUrl(key, expiresIn = DEFAULT_DOWNLOAD_URL_EXPIRY_SEC) {
    const safeExpiry = Math.min(Math.max(Math.floor(expiresIn), 1), MAX_DOWNLOAD_URL_EXPIRY_SEC);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn: safeExpiry });
  }
}

module.exports = new StorageService();
module.exports.StorageService = StorageService;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.DEFAULT_MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;
