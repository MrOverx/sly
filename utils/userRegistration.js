/**
 * User Registration & Validation Utilities
 * Extracted from repeated socket.on handlers: create_room, join_room, register_user, etc.
 */

const { Logger } = require('./logger');

/**
 * Validate user data structure
 * Used in register_user, create_room, join_room, etc.
 * @param {object} userData - User data to validate
 * @param {object} CONFIG - Configuration with validation limits
 * @returns {object} {valid: boolean, error: string|null}
 */
function validateUserData(userData, CONFIG = {}) {
  const maxUsernameLength = CONFIG.MAX_USERNAME_LENGTH || 50;

  if (!userData || typeof userData !== 'object') {
    return { valid: false, error: 'Invalid user data object' };
  }

  if (typeof userData.userId !== 'string' || userData.userId.trim().length === 0) {
    return { valid: false, error: 'Invalid userId' };
  }

  if (typeof userData.userName !== 'string' || userData.userName.trim().length === 0) {
    return { valid: false, error: 'Invalid userName' };
  }

  if (userData.userName.length > maxUsernameLength) {
    return { valid: false, error: `userName exceeds ${maxUsernameLength} characters` };
  }

  return { valid: true };
}

module.exports = {
  validateUserData,
};
