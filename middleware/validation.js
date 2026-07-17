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

const MAX_PROFILE_IMAGE_URL_LENGTH = 20000;
const MAX_INLINE_PROFILE_IMAGE_URL_LENGTH = 120 * 1024; // 120KB limit for persistent inline images

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
      birthDate,
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

    const statusObject = status != null && typeof status === 'object' && !Array.isArray(status)
      ? status
      : null;

    if (status != null && typeof status !== 'string' && !statusObject) {
      return sendError(res, 400, 'Invalid status value', 'VALIDATION_ERROR');
    }

    if (typeof status === 'string' && status.trim().length > 150) {
      return sendError(res, 400, 'Status cannot exceed 150 characters', 'VALIDATION_ERROR');
    }

    if (statusObject) {
      const statusNoteArray = Array.isArray(statusObject.statusNote)
        ? statusObject.statusNote
        : statusObject.statusNote
          ? [statusObject.statusNote]
          : [];

      if (!statusNoteArray.every((entry) => entry && typeof entry === 'object')) {
        return sendError(res, 400, 'Invalid status.statusNote value', 'VALIDATION_ERROR');
      }

      for (const entry of statusNoteArray) {
        const note = entry.note;
        const color = entry.color;
        const createdAt = entry.createdAt;

        if (note != null && typeof note !== 'string') {
          return sendError(res, 400, 'Invalid status.note value', 'VALIDATION_ERROR');
        }
        if (note != null && String(note).trim().length > 150) {
          return sendError(res, 400, 'Status note cannot exceed 150 characters', 'VALIDATION_ERROR');
        }
        if (color != null && typeof color !== 'string') {
          return sendError(res, 400, 'Invalid status.color value', 'VALIDATION_ERROR');
        }
        if (color != null && String(color).trim().length > 50) {
          return sendError(res, 400, 'Status color cannot exceed 50 characters', 'VALIDATION_ERROR');
        }
        if (createdAt != null && typeof createdAt !== 'string') {
          return sendError(res, 400, 'Invalid status.createdAt value', 'VALIDATION_ERROR');
        }
      }

      if (statusObject.statusMedia != null && !Array.isArray(statusObject.statusMedia)) {
        return sendError(res, 400, 'Invalid status.statusMedia value', 'VALIDATION_ERROR');
      }

      if (Array.isArray(statusObject.statusMedia) &&
          !statusObject.statusMedia.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
        return sendError(res, 400, 'Invalid status.statusMedia entries', 'VALIDATION_ERROR');
      }
    }

    if (req.body.statusNote != null) {
      const statusNote = req.body.statusNote;
      if (typeof statusNote !== 'object' || Array.isArray(statusNote)) {
        return sendError(res, 400, 'Invalid statusNote value', 'VALIDATION_ERROR');
      }

      const note = statusNote.note;
      const color = statusNote.color;
      if (note != null && typeof note !== 'string') {
        return sendError(res, 400, 'Invalid statusNote.note value', 'VALIDATION_ERROR');
      }
      if (note != null && String(note).trim().length > 150) {
        return sendError(res, 400, 'Status note cannot exceed 150 characters', 'VALIDATION_ERROR');
      }
      if (color != null && typeof color !== 'string') {
        return sendError(res, 400, 'Invalid statusNote.color value', 'VALIDATION_ERROR');
      }
      if (color != null && String(color).trim().length > 50) {
        return sendError(res, 400, 'Status note color cannot exceed 50 characters', 'VALIDATION_ERROR');
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

    // New domain fields validation
    const { avatarLetter, useColorProfile, likedUserIds, friends: friendsArr, isOnline, isFriend, hasProfileChanged } = req.body;

    if (avatarLetter != null) {
      if (typeof avatarLetter !== 'string') {
        return sendError(res, 400, 'Invalid avatarLetter value', 'VALIDATION_ERROR');
      }
      const letter = avatarLetter.trim();
      if (letter.length !== 1 || !/^[A-Za-z]$/.test(letter)) {
        return sendError(res, 400, 'avatarLetter must be a single ASCII letter', 'VALIDATION_ERROR');
      }
    }

    if (useColorProfile != null && typeof useColorProfile !== 'boolean') {
      return sendError(res, 400, 'Invalid useColorProfile value', 'VALIDATION_ERROR');
    }

    if (likedUserIds != null) {
      if (!Array.isArray(likedUserIds)) {
        return sendError(res, 400, 'likedUserIds must be an array', 'VALIDATION_ERROR');
      }
      if (likedUserIds.length > 500) {
        return sendError(res, 400, 'likedUserIds cannot exceed 500 entries', 'VALIDATION_ERROR');
      }
      for (const id of likedUserIds) {
        if (typeof id !== 'string' || String(id).trim().length === 0) {
          return sendError(res, 400, 'likedUserIds must contain non-empty strings', 'VALIDATION_ERROR');
        }
      }
    }

    if (friendsArr != null) {
      if (!Array.isArray(friendsArr)) {
        return sendError(res, 400, 'friends must be an array', 'VALIDATION_ERROR');
      }
      if (friendsArr.length > 1000) {
        return sendError(res, 400, 'friends cannot exceed 1000 entries', 'VALIDATION_ERROR');
      }
      for (const f of friendsArr) {
        if (!f || typeof f !== 'object') {
          return sendError(res, 400, 'each friend must be an object', 'VALIDATION_ERROR');
        }
        if (!f.friendId || typeof f.friendId !== 'string' || String(f.friendId).trim().length === 0) {
          return sendError(res, 400, 'friend.friendId is required and must be a non-empty string', 'VALIDATION_ERROR');
        }
        if (f.addedAt && isNaN(Date.parse(String(f.addedAt)))) {
          return sendError(res, 400, 'friend.addedAt must be a valid date string', 'VALIDATION_ERROR');
        }
      }
    }

    if (req.body.friendRequests != null) {
      if (!Array.isArray(req.body.friendRequests)) {
        return sendError(res, 400, 'friendRequests must be an array', 'VALIDATION_ERROR');
      }
      if (req.body.friendRequests.length > 1000) {
        return sendError(res, 400, 'friendRequests cannot exceed 1000 entries', 'VALIDATION_ERROR');
      }
      for (const request of req.body.friendRequests) {
        if (!request || typeof request !== 'object') {
          return sendError(res, 400, 'each friend request must be an object', 'VALIDATION_ERROR');
        }
        if (!request.requestId || typeof request.requestId !== 'string' || String(request.requestId).trim().length === 0) {
          return sendError(res, 400, 'friendRequest.requestId is required and must be a non-empty string', 'VALIDATION_ERROR');
        }
        if (!request.friendId || typeof request.friendId !== 'string' || String(request.friendId).trim().length === 0) {
          return sendError(res, 400, 'friendRequest.friendId is required and must be a non-empty string', 'VALIDATION_ERROR');
        }
        if (!request.userId || typeof request.userId !== 'string' || String(request.userId).trim().length === 0) {
          return sendError(res, 400, 'friendRequest.userId is required and must be a non-empty string', 'VALIDATION_ERROR');
        }
        if (request.isIncoming != null && typeof request.isIncoming !== 'boolean') {
          return sendError(res, 400, 'friendRequest.isIncoming must be a boolean', 'VALIDATION_ERROR');
        }
        if (request.status != null && typeof request.status !== 'string') {
          return sendError(res, 400, 'friendRequest.status must be a string', 'VALIDATION_ERROR');
        }
      }
    }

    if (isOnline != null && typeof isOnline !== 'boolean') {
      return sendError(res, 400, 'Invalid isOnline value', 'VALIDATION_ERROR');
    }

    if (isFriend != null && typeof isFriend !== 'boolean') {
      return sendError(res, 400, 'Invalid isFriend value', 'VALIDATION_ERROR');
    }

    if (hasProfileChanged != null && typeof hasProfileChanged !== 'boolean') {
      return sendError(res, 400, 'Invalid hasProfileChanged value', 'VALIDATION_ERROR');
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
    // ✅ NEW: Preserve nested status structure from frontend
    // Frontend sends: { 'status': { 'statusNote': [...], 'statusMedia': [] } }
    if (statusObject) {
      // Check if this is a nested status structure with statusNote array
      const statusNoteArray = statusObject.statusNote;
      const statusMediaArray = statusObject.statusMedia;
      
      if (Array.isArray(statusNoteArray) && statusNoteArray.length > 0) {
        // ✅ Nested structure detected - pass through as-is with all fields
        // This preserves createdAt timestamps and array structure
        const sanitizedStatusNotes = statusNoteArray.map((entry) => {
          const sanitized = {};
          if (entry.note != null && String(entry.note).trim().length > 0) {
            sanitized.note = String(entry.note).trim();
          }
          if (entry.color != null && String(entry.color).trim().length > 0) {
            sanitized.color = String(entry.color).trim();
          }
          if (entry.createdAt != null) {
            sanitized.createdAt = String(entry.createdAt).trim();  // ✅ PRESERVE createdAt
          }
          return sanitized;
        }).filter((entry) => entry.note);  // Only keep entries with notes
        
        if (sanitizedStatusNotes.length > 0) {
          sanitizedBody.status = {
            statusNote: sanitizedStatusNotes,
            statusMedia: Array.isArray(statusMediaArray) ? statusMediaArray : [],
          };
        }
      } else {
        // Fallback: Old format or inline statusNote object
        const note = inlineStatusNote?.note ?? statusObject.note;
        const color = inlineStatusNote?.color ?? statusObject.color;
        const sanitizedStatusNote = {};
        if (note != null && String(note).trim().length > 0) {
          sanitizedStatusNote.note = String(note).trim();
          sanitizedBody.status = String(note).trim();
        }
        if (color != null && String(color).trim().length > 0) {
          sanitizedStatusNote.color = String(color).trim();
        }
        if (Object.keys(sanitizedStatusNote).length > 0) {
          sanitizedBody.statusNote = sanitizedStatusNote;
        }
      }
    } else if (status && typeof status === 'string' && String(status).trim().length > 0) {
      // Legacy: Plain string status
      sanitizedBody.status = String(status).trim();
    }
    if (req.body.statusNote != null && typeof req.body.statusNote === 'object') {
      const rawStatusNote = req.body.statusNote;
      const note = rawStatusNote.note != null ? String(rawStatusNote.note).trim() : null;
      const color = rawStatusNote.color != null ? String(rawStatusNote.color).trim() : null;
      const sanitizedStatusNote = {};
      if (note != null && note.length > 0) sanitizedStatusNote.note = note;
      if (color != null && color.length > 0) sanitizedStatusNote.color = color;
      if (Object.keys(sanitizedStatusNote).length > 0) {
        sanitizedBody.statusNote = sanitizedStatusNote;
      }
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
      const lowerProfileImageUrl = trimmedUrl.toLowerCase();
      if (lowerProfileImageUrl.startsWith('data:')) {
        if (trimmedUrl.length > MAX_INLINE_PROFILE_IMAGE_URL_LENGTH) {
          return sendError(res, 400, 'Inline profile image payload exceeds maximum allowed size', 'VALIDATION_ERROR');
        }
      } else if (trimmedUrl.length > MAX_PROFILE_IMAGE_URL_LENGTH) {
        return sendError(res, 400, 'profileImageUrl cannot exceed 20000 characters', 'VALIDATION_ERROR');
      }
      if (trimmedUrl.length > 0) {
        sanitizedBody.profileImageUrl = trimmedUrl;
      } else {
        // Preserve explicit removal requests so backend can clear the image.
        sanitizedBody.profileImageUrl = '';
      }
    }
    if (req.body.profileImagePath != null) {
      if (typeof req.body.profileImagePath !== 'string') {
        return sendError(res, 400, 'Invalid profileImagePath value', 'VALIDATION_ERROR');
      }
      const profileImagePathValue = String(req.body.profileImagePath);
      const trimmedPath = profileImagePathValue.trim();
      const lowerProfileImagePath = trimmedPath.toLowerCase();
      if (lowerProfileImagePath.startsWith('data:')) {
        if (trimmedPath.length > MAX_INLINE_PROFILE_IMAGE_URL_LENGTH) {
          return sendError(res, 400, 'Inline profile image payload exceeds maximum allowed size', 'VALIDATION_ERROR');
        }
      } else if (trimmedPath.length > MAX_PROFILE_IMAGE_URL_LENGTH) {
        return sendError(res, 400, 'profileImagePath cannot exceed 20000 characters', 'VALIDATION_ERROR');
      }
      if (trimmedPath.length > 0) {
        sanitizedBody.profileImagePath = trimmedPath;
      }
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

    // Add new sanitized fields when present
    if (avatarLetter && String(avatarLetter).trim().length > 0) {
      sanitizedBody.avatarLetter = String(avatarLetter).trim().toUpperCase();
    }
    if (typeof useColorProfile === 'boolean') {
      sanitizedBody.useColorProfile = useColorProfile;
    }
    if (Array.isArray(likedUserIds)) {
      sanitizedBody.likedUserIds = likedUserIds
        .map((i) => String(i).trim())
        .filter((i) => i.length > 0)
        .slice(0, 500);
    }
    if (Array.isArray(friendsArr)) {
      sanitizedBody.friends = friendsArr.map((f) => ({
        friendId: String(f.friendId).trim(),
        addedAt: f.addedAt ? String(f.addedAt).trim() : undefined,
      }));
    }
    // friendRequests sanitized output removed per request
    if (typeof isOnline === 'boolean') {
      sanitizedBody.isOnline = isOnline;
    }
    if (typeof isFriend === 'boolean') {
      sanitizedBody.isFriend = isFriend;
    }
    if (typeof hasProfileChanged === 'boolean') {
      sanitizedBody.hasProfileChanged = hasProfileChanged;
    }
    if (typeof req.body.clearStatusNote === 'boolean') {
      sanitizedBody.clearStatusNote = req.body.clearStatusNote;
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
// Note: helper validators `validateRoomCreate`, `validateSocketMetadata`, and
// `validateFieldLength` were removed because they were internal, unused, and
// duplicated validation logic exists in the exported validators above.

module.exports = {
  validateAuth,
  validateRegistration,
  validateProfileUpdate,
};
