/**
 * Centralized Response Handler
 * Reduces code duplication for API responses across all endpoints
 */

/**
 * Build standardized error response
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string|object} errorCode - Error code or details object
 * @returns {object} Formatted error response
 */
function sendError(res, statusCode, message, errorCode = null, details = null) {
  const response = { success: false, message, error: message };
  if (errorCode) {
    if (typeof errorCode === 'string') {
      response.code = errorCode;
    } else {
      Object.assign(response, errorCode);
    }
  }
  if (details) {
    response.details = details;
  }
  return res.status(statusCode).json(response);
}

/**
 * Build standardized success response
 * @param {object} res - Express response object
 * @param {object} data - Response data
 * @param {string} message - Success message (optional)
 * @returns {void}
 */
function sendSuccess(res, data, message = 'Success') {
  const response = { success: true, message };
  if (data) Object.assign(response, data);
  return res.json(response);
}

module.exports = {
  sendError,
  sendSuccess,
};
