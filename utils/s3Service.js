const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1',
});

function getS3Config() {
  return {
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1',
    bucket: process.env.AWS_S3_BUCKET || null,
    profileFolder: process.env.AWS_S3_PROFILE_FOLDER || 'profiles',
    publicUrl: process.env.AWS_S3_PUBLIC_URL || null,
    acl: process.env.AWS_S3_ACL || null,
  };
}

function ensureS3Config() {
  const { bucket } = getS3Config();
  if (!bucket) {
    throw new Error('Missing required environment variable AWS_S3_BUCKET for S3 uploads');
  }
}

function isS3Configured() {
  return Boolean(getS3Config().bucket);
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
  const { profileFolder } = getS3Config();
  const ext = path.extname(originalName || '');
  const folderBase = profileFolder.replace(/\/+$/, '');

  if (userId && typeof userId === 'string' && userId.trim().length > 0) {
    const sanitizedUserId = sanitizeFileName(userId);
    const currentFileName = 'current' + (ext || '.png');
    return `${folderBase}/${sanitizedUserId}/profilepic/${currentFileName}`;
  }

  const base = sanitizeFileName(path.basename(originalName || 'profile', ext));
  const fallbackName = base.length > 0 ? `${base}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}` : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  return `${folderBase}/${fallbackName}${ext}`;
}

function getPublicUrl(key) {
  ensureS3Config();
  const { region, bucket, publicUrl } = getS3Config();
  const encodedKey = encodeURI(key);
  if (publicUrl) {
    return `${publicUrl.replace(/\/+$/, '')}/${encodedKey}`;
  }

  if (region === 'us-east-1') {
    return `https://${bucket}.s3.amazonaws.com/${encodedKey}`;
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function getS3ObjectKeyFromUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const { region, bucket, publicUrl } = getS3Config();
  const candidate = url.trim();
  const normalizedPublicUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : null;

  if (normalizedPublicUrl && candidate.startsWith(normalizedPublicUrl)) {
    return candidate.slice(normalizedPublicUrl.length).replace(/^\/+/, '');
  }

  try {
    const parsedUrl = new URL(candidate);
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.replace(/^\/+/, '');

    if (bucket && hostname === `${bucket}.s3.amazonaws.com`) {
      return pathname;
    }

    if (bucket && hostname === `${bucket}.s3.${region}.amazonaws.com`) {
      return pathname;
    }

    if (bucket && hostname === `s3.${region}.amazonaws.com` && pathname.startsWith(`${bucket}/`)) {
      return pathname.slice(bucket.length + 1);
    }

    if (bucket && hostname === 's3.amazonaws.com' && pathname.startsWith(`${bucket}/`)) {
      return pathname.slice(bucket.length + 1);
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
  const { bucket } = getS3Config();
  if (!bucket) {
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
    Bucket: bucket,
    Key: key,
  });

  await s3Client.send(command);
  return true;
}

async function uploadProfileImageToS3(buffer, originalName, contentType, userId = null) {
  const { bucket, acl } = getS3Config();
  if (!bucket) {
    throw new Error('Cannot upload to S3 because AWS_S3_BUCKET is not configured. Set AWS_S3_BUCKET in the environment to enable uploads.');
  }

  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadProfileImageToS3 requires a Buffer payload');
  }

  const key = getS3ObjectKey(originalName, userId);
  const commandParams = {
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=604800',
    ContentDisposition: 'inline',
  };

  if (acl) {
    commandParams.ACL = acl;
  }

  const sendUploadCommand = async (params) => {
    const command = new PutObjectCommand(params);
    return await s3Client.send(command);
  };

  try {
    await sendUploadCommand(commandParams);
  } catch (error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (acl && message.includes('acl') && message.includes('not allow')) {
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

async function replaceProfileImageInS3(buffer, originalName, contentType, userId = null, previousUrl = null) {
  const { bucket } = getS3Config();
  if (!bucket) {
    throw new Error('Cannot replace S3 profile image because AWS_S3_BUCKET is not configured.');
  }

  try {
    if (previousUrl && typeof previousUrl === 'string' && previousUrl.trim().length > 0) {
      await deleteProfileImageFromS3(previousUrl);
    }
  } catch (error) {
    console.warn('[s3Service] Failed to delete previous profile image before replacement:', error?.message || error);
  }

  return uploadProfileImageToS3(buffer, originalName, contentType, userId);
}

module.exports = {
  uploadProfileImageToS3,
  replaceProfileImageInS3,
  deleteProfileImageFromS3,
  isS3Configured,
  isS3Url,
  getS3ObjectKey,
};
