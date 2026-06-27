/**
 * S3 Upload Retry Helper
 * Implements exponential backoff for resilient S3 operations
 * 
 * Optional enhancement for slyxyserver/utils/s3Service.js
 * Can be integrated when S3 reliability needs to be further improved
 */

/**
 * Upload with exponential backoff retry
 * @param {Buffer} buffer - Image buffer
 * @param {string} originalName - Original filename
 * @param {string} contentType - MIME type (e.g., 'image/jpeg')
 * @param {string|null} userId - User ID for key generation
 * @param {number} maxAttempts - Max retry attempts (default 3)
 * @returns {Promise<{key, url}>} - Upload result
 */
async function uploadProfileImageWithRetry(
  buffer,
  originalName,
  contentType,
  userId = null,
  maxAttempts = 3
) {
  const baseDelayMs = 1000;
  const multiplier = 2;
  const jitterFraction = 0.1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Attempt upload
      return await uploadProfileImageToS3(buffer, originalName, contentType, userId);
    } catch (err) {
      if (attempt === maxAttempts) {
        // Final attempt failed - throw error
        throw err;
      }

      // Calculate exponential backoff with jitter
      const exponentialDelayMs = baseDelayMs * Math.pow(multiplier, attempt - 1);
      const jitterMs = exponentialDelayMs * jitterFraction * Math.random();
      const totalDelayMs = exponentialDelayMs + jitterMs;

      Logger.warn('s3Service', `Upload attempt ${attempt} failed. Retrying in ${totalDelayMs}ms`, {
        originalName,
        userId,
        error: err?.message || err,
        attempt: `${attempt}/${maxAttempts}`,
      });

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, totalDelayMs));
    }
  }
}

/**
 * Replace with exponential backoff retry
 * @param {Buffer} buffer - Image buffer
 * @param {string} originalName - Original filename
 * @param {string} contentType - MIME type
 * @param {string|null} userId - User ID
 * @param {string|null} previousUrl - Previous image URL (to delete)
 * @param {number} maxAttempts - Max retry attempts
 * @returns {Promise<{key, url}>} - Upload result
 */
async function replaceProfileImageWithRetry(
  buffer,
  originalName,
  contentType,
  userId = null,
  previousUrl = null,
  maxAttempts = 3
) {
  const baseDelayMs = 1000;
  const multiplier = 2;
  const jitterFraction = 0.1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Attempt replace (with old image cleanup)
      return await replaceProfileImageInS3(
        buffer,
        originalName,
        contentType,
        userId,
        previousUrl
      );
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }

      const exponentialDelayMs = baseDelayMs * Math.pow(multiplier, attempt - 1);
      const jitterMs = exponentialDelayMs * jitterFraction * Math.random();
      const totalDelayMs = exponentialDelayMs + jitterMs;

      Logger.warn('s3Service', `Replace attempt ${attempt} failed. Retrying in ${totalDelayMs}ms`, {
        originalName,
        userId,
        previousUrl,
        error: err?.message || err,
        attempt: `${attempt}/${maxAttempts}`,
      });

      await new Promise(resolve => setTimeout(resolve, totalDelayMs));
    }
  }
}

// Usage example in ws_server.js /upload endpoint:
/*
const uploaded = previousUrl && isS3Url(previousUrl)
  ? await replaceProfileImageWithRetry(
      req.file.buffer,
      req.file.originalname || `profile-${Date.now()}`,
      req.file.mimetype || 'application/octet-stream',
      userId,
      previousUrl,
      3 // maxAttempts
    )
  : await uploadProfileImageWithRetry(
      req.file.buffer,
      req.file.originalname || `profile-${Date.now()}`,
      req.file.mimetype || 'application/octet-stream',
      userId,
      3 // maxAttempts
    );
*/

module.exports = {
  uploadProfileImageWithRetry,
  replaceProfileImageWithRetry,
};
