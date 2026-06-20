const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_S3_PROFILE_FOLDER = process.env.AWS_S3_PROFILE_FOLDER || 'profiles';
const AWS_S3_PUBLIC_URL = process.env.AWS_S3_PUBLIC_URL || null;
const AWS_S3_ACL = process.env.AWS_S3_ACL || null;

const s3Client = new S3Client({ region: AWS_REGION });

function ensureS3Config() {
  if (!AWS_S3_BUCKET) {
    throw new Error('Missing required environment variable AWS_S3_BUCKET for S3 uploads');
  }
}

function isS3Configured() {
  return Boolean(AWS_S3_BUCKET);
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

function getS3ObjectKey(originalName, userId = null) {
  ensureS3Config();
  const ext = path.extname(originalName || '');
  const base = sanitizeFileName(path.basename(originalName || 'profile', ext));
  const randomId = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const name = base.length > 0 ? `${base}-${timestamp}-${randomId}` : `${timestamp}-${randomId}`;
  const folderBase = AWS_S3_PROFILE_FOLDER.replace(/\/+$/, '');

  if (userId && typeof userId === 'string' && userId.trim().length > 0) {
    const sanitizedUserId = sanitizeFileName(userId);
    return `${folderBase}/${sanitizedUserId}/profilepic/${name}${ext}`;
  }

  return `${folderBase}/${name}${ext}`;
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

function getS3ObjectKeyFromUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const candidate = url.trim();
  const normalizedPublicUrl = AWS_S3_PUBLIC_URL ? AWS_S3_PUBLIC_URL.replace(/\/+$/, '') : null;

  if (normalizedPublicUrl && candidate.startsWith(normalizedPublicUrl)) {
    return candidate.slice(normalizedPublicUrl.length).replace(/^\/+/, '');
  }

  try {
    const parsedUrl = new URL(candidate);
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.replace(/^\/+/, '');

    if (AWS_S3_BUCKET && hostname === `${AWS_S3_BUCKET}.s3.amazonaws.com`) {
      return pathname;
    }

    if (AWS_S3_BUCKET && hostname === `${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`) {
      return pathname;
    }

    if (AWS_S3_BUCKET && hostname === `s3.${AWS_REGION}.amazonaws.com` && pathname.startsWith(`${AWS_S3_BUCKET}/`)) {
      return pathname.slice(AWS_S3_BUCKET.length + 1);
    }

    if (AWS_S3_BUCKET && hostname === 's3.amazonaws.com' && pathname.startsWith(`${AWS_S3_BUCKET}/`)) {
      return pathname.slice(AWS_S3_BUCKET.length + 1);
    }

    return null;
  } catch (err) {
    return null;
  }
}

function isS3Url(url) {
  return Boolean(getS3ObjectKeyFromUrl(url));
}

async function deleteProfileImageFromS3(url) {
  if (!AWS_S3_BUCKET) {
    throw new Error('Cannot delete from S3 because AWS_S3_BUCKET is not configured. Set AWS_S3_BUCKET in the environment to enable deletes.');
  }

  const key = getS3ObjectKeyFromUrl(url);
  if (!key) {
    console.warn(
      `[s3Service] Skipping delete because URL is not recognized as a managed S3 object: ${url}`,
    );
    return false;
  }

  const command = new DeleteObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
  });

  await s3Client.send(command);
  return true;
}

async function uploadProfileImageToS3(buffer, originalName, contentType, userId = null) {
  if (!AWS_S3_BUCKET) {
    throw new Error('Cannot upload to S3 because AWS_S3_BUCKET is not configured. Set AWS_S3_BUCKET in the environment to enable uploads.');
  }

  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadProfileImageToS3 requires a Buffer payload');
  }

  const key = getS3ObjectKey(originalName, userId);
  const commandParams = {
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=604800',
    ContentDisposition: 'inline',
  };

  if (AWS_S3_ACL) {
    commandParams.ACL = AWS_S3_ACL;
  }

  const sendUploadCommand = async (params) => {
    const command = new PutObjectCommand(params);
    return await s3Client.send(command);
  };

  try {
    await sendUploadCommand(commandParams);
  } catch (error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (AWS_S3_ACL && message.includes('acl') && message.includes('not allow')) {
      console.warn('[s3Service] ACL rejected by bucket, retrying upload without ACL');
      delete commandParams.ACL;
      await sendUploadCommand(commandParams);
    } else {
      throw error;
    }
  }

  return {
    key,
    url: getPublicUrl(key),
  }; 
}

module.exports = {
  uploadProfileImageToS3,
  deleteProfileImageFromS3,
  isS3Configured,
  isS3Url,
};
