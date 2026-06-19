/**
 * Input Validation Middleware
 * Provides reusable validation functions for API requests
 * 
 * Usage:
 * const { validateAuth, validateUserId } = require('./middleware/validation');
 * app.post('/auth/validate-token', validateAuth, handler);
 */

const { Logger } = require('../utils/logger');
const { sendError } = require('../utils/responseHandler');

/**
 * Validate authentication request body
 * Required: idToken or (email + password)
 */
function validateAuth(req, res, next) {
  try {
    const { idToken, email, password, userId } = req.body;

    if (!idToken && (!password || (!email && !userId))) {
      return sendError(res, 400, 'Missing required authentication fields', 'VALIDATION_ERROR');
    }

    // Sanitize inputs
    req.body = {
      idToken: idToken ? String(idToken).trim() : null,
      userId: userId ? String(userId).trim() : null,
      email: email ? String(email).toLowerCase().trim() : null,
      password: password ? String(password) : null,
      googleUserData: req.body.googleUserData || null,
    };

    Logger.debug('validation', 'Auth request validated', { method: req.method, path: req.path });
    next();
  } catch (err) {
    Logger.error('validation/auth', 'Validation error', err.message);
    sendError(res, 400, 'Invalid request format', 'VALIDATION_ERROR');
  }
}

/**
 * Validate user registration request
 * Required: userId, userName, email
 */
function validateRegistration(req, res, next) {
  try {
    const { userId, userName, email, password } = req.body;

    if (!userName || !email || !password) {
      return sendError(res, 400, 'Missing required fields: userName, email, password', 'VALIDATION_ERROR');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return sendError(res, 400, 'Invalid email format', 'VALIDATION_ERROR');
    }

    if (typeof password !== 'string' || password.length < 6) {
      return sendError(res, 400, 'Password must be at least 6 characters', 'VALIDATION_ERROR');
    }

    // Validate username length
    if (userName.length < 2 || userName.length > 50) {
      return sendError(res, 400, 'Username must be 2-50 characters', 'VALIDATION_ERROR');
    }

    // Sanitize inputs
    const safeUserId = userId ? String(userId).trim() : '';
    req.body = {
      userId: safeUserId,
      userName: String(userName).trim(),
      email: String(email).toLowerCase().trim(),
      password: password ? String(password) : null,
      gender: req.body.gender || 'other',
      country: req.body.country || null,
      avatarColor: req.body.avatarColor || '#128C7E',
      birthDate: req.body.birthDate ? String(req.body.birthDate).trim() : null,
      profileImageUrl: req.body.profileImageUrl ? String(req.body.profileImageUrl).trim() : null,
      pictureName: req.body.pictureName ? String(req.body.pictureName).trim() : null,
      emailVerified: req.body.emailVerified === true,
    };

    Logger.debug('validation', 'Registration request validated');
    next();
  } catch (err) {
    Logger.error('validation/registration', 'Validation error', err.message);
    sendError(res, 400, 'Invalid registration data', 'VALIDATION_ERROR');
  }
}

/**
 * Validate user profile update request
 * Optional: userName, gender, country, avatarColor, profileImageUrl
 */
function validateProfileUpdate(req, res, next) {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return sendError(res, 400, 'User ID is required', 'VALIDATION_ERROR');
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(res, 400, 'Invalid profile data: request body must be a JSON object', 'VALIDATION_ERROR');
    }

    // Validate optional fields
    const {
      userName,
      gender,
      country,
      avatarColor,
      status,
      bio,
      interests,
      xp,
      lastDailyXpAwardedAt,
      profileImageUrl,
      profileImagePath,
      pictureName,
      authType,
      email,
      isGuest,
    } = req.body;

    if (userName != null) {
      if (typeof userName !== 'string') {
        return sendError(res, 400, 'Invalid userName value', 'VALIDATION_ERROR');
      }
      const trimmedUserName = userName.trim();
      if (trimmedUserName.length > 0 && (trimmedUserName.length < 2 || trimmedUserName.length > 50)) {
        return sendError(res, 400, 'Username must be 2-50 characters', 'VALIDATION_ERROR');
      }
    }

    if (gender != null) {
      if (typeof gender !== 'string') {
        return sendError(res, 400, 'Invalid gender value', 'VALIDATION_ERROR');
      }
      const trimmedGender = gender.toLowerCase().trim();
      if (trimmedGender.length > 0 && !['male', 'female', 'other'].includes(trimmedGender)) {
        return sendError(res, 400, 'Invalid gender value', 'VALIDATION_ERROR');
      }
    }

    if (country != null && typeof country !== 'string') {
      return sendError(res, 400, 'Invalid country value', 'VALIDATION_ERROR');
    }

    if (avatarColor != null && typeof avatarColor !== 'string') {
      return sendError(res, 400, 'Invalid avatarColor value', 'VALIDATION_ERROR');
    }

    if (status != null) {
      if (typeof status !== 'string') {
        return sendError(res, 400, 'Invalid status value', 'VALIDATION_ERROR');
      }
      if (status.trim().length > 150) {
        return sendError(res, 400, 'Status cannot exceed 150 characters', 'VALIDATION_ERROR');
      }
    }

    if (bio != null) {
      if (typeof bio !== 'string') {
        return sendError(res, 400, 'Invalid bio value', 'VALIDATION_ERROR');
      }
      if (bio.trim().length > 500) {
        return sendError(res, 400, 'Bio cannot exceed 500 characters', 'VALIDATION_ERROR');
      }
    }

    if (profileImageUrl != null && typeof profileImageUrl !== 'string') {
      return sendError(res, 400, 'Invalid profileImageUrl value', 'VALIDATION_ERROR');
    }

    if (profileImagePath != null && typeof profileImagePath !== 'string') {
      return sendError(res, 400, 'Invalid profileImagePath value', 'VALIDATION_ERROR');
    }

    if (pictureName != null && typeof pictureName !== 'string') {
      return sendError(res, 400, 'Invalid pictureName value', 'VALIDATION_ERROR');
    }

    if (authType != null && typeof authType !== 'string') {
      return sendError(res, 400, 'Invalid authType value', 'VALIDATION_ERROR');
    }

    if (email != null && typeof email !== 'string') {
      return sendError(res, 400, 'Invalid email value', 'VALIDATION_ERROR');
    }

    if (isGuest != null && typeof isGuest !== 'boolean') {
      return sendError(res, 400, 'Invalid isGuest value', 'VALIDATION_ERROR');
    }

    if (xp != null && (typeof xp !== 'object' || Array.isArray(xp))) {
      return sendError(res, 400, 'Invalid xp value', 'VALIDATION_ERROR');
    }

    if (lastDailyXpAwardedAt != null && typeof lastDailyXpAwardedAt !== 'string') {
      return sendError(res, 400, 'Invalid lastDailyXpAwardedAt value', 'VALIDATION_ERROR');
    }

    const sanitizedInterests = Array.isArray(interests)
      ? interests
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0)
          .slice(0, 20)
      : undefined;

    const sanitizedXp = xp && typeof xp === 'object' && !Array.isArray(xp) ? xp : undefined;
    const sanitizedLastDailyXpAwardedAt = lastDailyXpAwardedAt
      ? String(lastDailyXpAwardedAt).trim()
      : undefined;

    // Sanitize inputs
    const sanitizedBody = {
      userId: String(userId).trim(),
    };

    if (userName && String(userName).trim().length > 0) {
      sanitizedBody.userName = String(userName).trim();
    }
    if (gender && String(gender).trim().length > 0) {
      sanitizedBody.gender = String(gender).toLowerCase();
    }
    if (country && String(country).trim().length > 0) {
      sanitizedBody.country = String(country).trim();
    }
    if (avatarColor && String(avatarColor).trim().length > 0) {
      sanitizedBody.avatarColor = String(avatarColor);
    }
    if (status && String(status).trim().length > 0) {
      sanitizedBody.status = String(status).trim();
    }
    if (bio && String(bio).trim().length > 0) {
      sanitizedBody.bio = String(bio).trim();
    }
    if (Array.isArray(sanitizedInterests)) {
      sanitizedBody.interests = sanitizedInterests;
    }
    if (req.body.profileImageUrl != null) {
      if (typeof req.body.profileImageUrl !== 'string') {
        return sendError(res, 400, 'Invalid profileImageUrl value', 'VALIDATION_ERROR');
      }
      const profileImageUrlValue = String(req.body.profileImageUrl);
      const trimmedUrl = profileImageUrlValue.trim();
      if (trimmedUrl.length > 0) {
        sanitizedBody.profileImageUrl = trimmedUrl;
      } else {
        // Preserve explicit removal requests so backend can clear the image.
        sanitizedBody.profileImageUrl = '';
      }
    }
    if (req.body.profileImagePath && String(req.body.profileImagePath).trim().length > 0) {
      sanitizedBody.profileImagePath = String(req.body.profileImagePath);
    }
    if (req.body.pictureName && String(req.body.pictureName).trim().length > 0) {
      sanitizedBody.pictureName = String(req.body.pictureName);
    }
    if (birthDate && String(birthDate).trim().length > 0) {
      sanitizedBody.birthDate = String(birthDate).trim();
    }
    if (req.body.email && String(req.body.email).trim().length > 0) {
      sanitizedBody.email = String(req.body.email).toLowerCase().trim();
    }
    if (req.body.authType && String(req.body.authType).trim().length > 0) {
      sanitizedBody.authType = String(req.body.authType).trim();
    }
    if (typeof req.body.isGuest === 'boolean') {
      sanitizedBody.isGuest = req.body.isGuest;
    }
    if (sanitizedXp) {
      sanitizedBody.xp = sanitizedXp;
    }
    if (sanitizedLastDailyXpAwardedAt) {
      sanitizedBody.lastDailyXpAwardedAt = sanitizedLastDailyXpAwardedAt;
    }

    req.body = sanitizedBody;

    Logger.debug('validation', 'Profile update validated', {
      userId: req.body.userId,
      hasStatus: !!status,
      hasBio: !!bio,
      hasInterests: Array.isArray(interests),
      hasXp: !!xp,
    });
    next();
  } catch (err) {
    Logger.error('validation/profile', 'Validation error', err.message, {
      rawBody: req.body,
      params: req.params,
    });
    sendError(res, 400, `Invalid profile data: ${err.message}`, 'VALIDATION_ERROR');
  }
}

/**
 * Validate room creation request
 * Required: roomName, roomType
 */
function validateRoomCreate(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid room data' };
  }

  const { roomName, roomType } = data;

  if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
    return { valid: false, error: 'Room name is required and must be non-empty' };
  }

  if (roomName.length > 100) {
    return { valid: false, error: 'Room name exceeds 100 characters' };
  }

  if (!['public', 'private'].includes(roomType)) {
    return { valid: false, error: 'Room type must be "public" or "private"' };
  }

  return { valid: true };
}

/**
 * Validate socket metadata
 * Required: userId, userName, avatarColor
 */
function validateSocketMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { valid: false, error: 'Invalid metadata object' };
  }

  if (!metadata.userId || typeof metadata.userId !== 'string') {
    return { valid: false, error: 'userId is required and must be a string' };
  }

  if (!metadata.userName || typeof metadata.userName !== 'string') {
    return { valid: false, error: 'userName is required and must be a string' };
  }

  if (metadata.userName.length > 50) {
    return { valid: false, error: 'userName exceeds 50 characters' };
  }

  return { valid: true };
}

/**
 * Generic field length validator
 */
function validateFieldLength(field, minLength, maxLength) {
  if (typeof field !== 'string') {
    return { valid: false, error: `Field must be a string` };
  }

  if (field.length < minLength) {
    return { valid: false, error: `Field must be at least ${minLength} characters` };
  }

  if (field.length > maxLength) {
    return { valid: false, error: `Field exceeds ${maxLength} characters` };
  }

  return { valid: true };
}

module.exports = {
  // Middleware functions
  validateAuth,
  validateRegistration,
  validateProfileUpdate,
  // Validation functions
  validateRoomCreate,
  validateSocketMetadata,
  validateFieldLength,
};
