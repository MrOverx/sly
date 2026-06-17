const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_S3_PROFILE_FOLDER = process.env.AWS_S3_PROFILE_FOLDER || 'profiles';
const AWS_S3_PUBLIC_URL = process.env.AWS_S3_PUBLIC_URL || null;

const s3Client = new S3Client({ region: AWS_REGION });

function ensureS3Config() {
  if (!AWS_S3_BUCKET) {
    throw new Error('Missing required environment variable AWS_S3_BUCKET for S3 uploads');
  }
}

function sanitizeFileName(value) {
  if (!value || typeof value !== 'string') {
    return 'upload';
  }

  return value
    .replace(/[^a-zA-Z0-9-_\.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function getS3ObjectKey(originalName) {
  ensureS3Config();
  const ext = path.extname(originalName || '');
  const base = sanitizeFileName(path.basename(originalName || 'profile', ext));
  const randomId = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const name = base.length > 0 ? `${base}-${timestamp}-${randomId}` : `${timestamp}-${randomId}`;
  return `${AWS_S3_PROFILE_FOLDER}/${name}${ext}`;
}

function getPublicUrl(key) {
  ensureS3Config();
  const encodedKey = encodeURI(key);
  if (AWS_S3_PUBLIC_URL) {
    return `${AWS_S3_PUBLIC_URL.replace(/\/+$/, '')}/${encodedKey}`;
  }

  if (AWS_REGION === 'us-east-1') {
    return `https://${AWS_S3_BUCKET}.s3.amazonaws.com/${encodedKey}`;
  }

  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodedKey}`;
}

async function uploadProfileImageToS3(buffer, originalName, contentType) {
  if (!AWS_S3_BUCKET) {
    throw new Error('Cannot upload to S3 because AWS_S3_BUCKET is not configured');
  }

  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadProfileImageToS3 requires a Buffer payload');
  }

  const key = getS3ObjectKey(originalName);
  const command = new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    ACL: 'public-read',
    CacheControl: 'public, max-age=604800',
    ContentDisposition: 'inline',
  });

  await s3Client.send(command);
  return {
    key,
    url: getPublicUrl(key),
  }; 
}

module.exports = {
  uploadProfileImageToS3,
};
