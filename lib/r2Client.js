/* eslint-disable no-undef */
/**
 * r2Client — Shared Cloudflare R2 / AWS S3 client.
 *
 * Extracted from server.js so webhook receivers (SignNow, Meta) can upload
 * files to R2 without duplicating the S3 configuration.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL
 *  OR: S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_NAME, S3_PUBLIC_URL
 */
'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL        = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const S3_REGION            = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY_ID     = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME       = process.env.S3_BUCKET_NAME;
const S3_PUBLIC_URL        = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');

let s3Client = null;
let activeBucket = null;
let activePublicUrl = null;

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  activeBucket = R2_BUCKET_NAME;
  activePublicUrl = R2_PUBLIC_URL;
} else if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && S3_BUCKET_NAME) {
  s3Client = new S3Client({
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
  activeBucket = S3_BUCKET_NAME;
  activePublicUrl = S3_PUBLIC_URL || `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com`;
}

function isConfigured() { return !!s3Client; }

/**
 * Upload a Buffer to R2/S3 and return the public URL + key.
 * @param {Buffer} buffer
 * @param {string} contentType
 * @param {string} fileName
 * @returns {Promise<{url: string, key: string}>}
 */
async function uploadBuffer(buffer, contentType, fileName) {
  if (!s3Client) throw new Error('R2/S3 not configured');
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ts = now.getTime();
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `uploads/${year}/${month}/${ts}-${sanitized}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: activeBucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ContentDisposition: `inline; filename="${sanitized}"`,
  }));
  const url = activePublicUrl ? `${activePublicUrl}/${key}` : `https://${activeBucket}/${key}`;
  return { url, key };
}

/**
 * Generate a presigned download URL for a private R2 object.
 * @param {string} key
 * @param {string} disposition
 * @returns {Promise<string>}
 */
async function getSignedDownloadUrl(key, disposition = 'inline') {
  if (!s3Client) throw new Error('R2/S3 not configured');
  const isAttachment = disposition === 'attachment';
  const fileName = key.split('/').pop() || 'file';
  const command = new GetObjectCommand({
    Bucket: activeBucket,
    Key: key,
    ResponseContentDisposition: isAttachment ? `attachment; filename="${fileName}"` : 'inline',
  });
  return getSignedUrl(s3Client, command, { expiresIn: 600 });
}

module.exports = { s3Client, activeBucket, activePublicUrl, isConfigured, uploadBuffer, getSignedDownloadUrl };