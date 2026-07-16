const fs = require('fs');
const path = require('path');
// Ensure the local backend node_modules folder is resolved even when the file
// is launched from a different CWD (for example, running nodemon from the root).
module.paths.unshift(path.join(__dirname, 'node_modules'));

// Logger must be imported before any logger calls during startup.
const { Logger } = require('./utils/logger');

// Load environment variables from the nearest .env file in the backend or workspace root.
const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
];
let envPathUsed = null;
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    envPathUsed = envPath;
    break;
  }
}
if (!envPathUsed) {
  require('dotenv').config();
}

if (envPathUsed) {
  Logger.info('env', `Loaded environment variables from: ${envPathUsed}`);
} else {
  Logger.warn('env', 'No .env found in backend search paths; relying on process environment only');
}
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT || null;
const hasAwsCreds = Boolean(
  process.env.AWS_ACCESS_KEY_ID ||
  process.env.AWS_SECRET_ACCESS_KEY ||
  process.env.AWS_SESSION_TOKEN ||
  process.env.AWS_PROFILE ||
  process.env.AWS_DEFAULT_PROFILE ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
  process.env.AWS_ROLE_ARN
);

if (process.env.NODE_ENV === 'production' && !hasAwsCreds) {
  Logger.warn('config', 'Running in production without AWS credentials. Proceeding with caution — set AWS credentials or configure USE_DEV_STORE if intended.');
}

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const {
  isDbConnected,
  isDevStoreEnabled,
  getUserById,
  getUserByEmail,
  findUserByLookup,
  createUser,
  updateUserById,
  deleteUserById,
  searchUsers,
  clearExpiredStatuses,
  getUsersByIds,
  getActiveBlock,
  putBlockedUser,
  deleteBlock,
  getReportsForUser,
  getReport,
  createReport,
  deleteBlocksForUser,
  deleteReportsForUserAndReporter,
  getUserStats,
  // Friend request management
  createFriendRequest,
  getFriendRequest,
  queryFriendRequestsForUser,
  acceptFriendRequest,
  denyFriendRequest,
  removeFriend,
  listFriends,
} = require('./utils/dynamoDBService');

const isDatabaseConnected = isDbConnected;

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function buildCompleteUserProfile(user) {
  if (!user) return null;
  const displayName = user.userName || user.name || user.displayName || 'User';
  const rawProfileImagePath = normalizeProfileImageReference(user.profileImagePath) || normalizeProfileImageReference(user.profile_image_path) || null;
  const safeProfileImageUrl = resolveProfileImageReference(user) || null;
  const fallbackProfileImagePath = !safeProfileImageUrl
    ? normalizeProfileImageReference(user.profileImageUrl) || normalizeProfileImageReference(user.profile_image_url) || null
    : null;
  const profileImagePath = rawProfileImagePath || fallbackProfileImagePath;
  const profileImageUrl = safeProfileImageUrl;
  const normalizedEmail = user.email ? String(user.email).trim().toLowerCase() : null;
  const emailVerified = user.emailVerified === true;
  const emailVerifiedAt = normalizeIsoTimestamp(user.emailVerifiedAt);
  const baseProfile = buildFriendCompleteUserProfile(user) || {};
  const normalizedUserId = normalizeId(user.userId || user.id || user._id || null);
  const rawOnlineValue = user.isOnline ?? user.online ?? user.is_online ?? user.online_status ?? user.onlineStatus;
  const storedOnline = rawOnlineValue === true || rawOnlineValue === 'true' || rawOnlineValue === '1';
  const isOnline = storedOnline || (global.onlineUsers && normalizedUserId ? global.onlineUsers.has(normalizedUserId) : false);
  const statusObject = user.status && typeof user.status === 'object' && !Array.isArray(user.status)
    ? user.status
    : null;
  const statusNoteEntries = Array.isArray(statusObject?.statusNote)
    ? statusObject.statusNote
    : [];
  const statusMediaEntries = Array.isArray(statusObject?.statusMedia)
    ? statusObject.statusMedia
    : (Array.isArray(user.statusMedia) ? user.statusMedia : []);
  const statusPayload = Object.keys(statusObject || {}).length || statusNoteEntries.length || statusMediaEntries.length
    ? {
        statusNote: statusNoteEntries,
        statusMedia: statusMediaEntries,
      }
    : { statusNote: [], statusMedia: [] };

  return {
    ...baseProfile,
    itemType: 'USER',
    userId: normalizedUserId || null,
    userName: displayName,
    email: user.email || null,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || (displayName ? String(displayName).charAt(0).toUpperCase() : 'U'),
    profileImagePath,
    profileImageUrl,
    pictureName: user.pictureName || null,
    useColorProfile: user.useColorProfile !== undefined ? Boolean(user.useColorProfile) : true,
    gender: user.gender || 'other',
    birthDate: normalizeIsoTimestamp(user.birthDate),
    country: user.country || null,
    status: statusPayload,
    bio: user.bio || null,
    interests: Array.isArray(user.interests) ? user.interests : [],
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    likedUserIds: Array.isArray(user.likedUserIds) ? user.likedUserIds : [],
    authType: user.authType || 'LOCAL',
    isGuest: user.isGuest === true,
    hasProfileChanged: user.hasProfileChanged === true,
    isOnline,
    isFriend: user.isFriend === true,
    lastDailyXpAwardedAt: normalizeIsoTimestamp(user.lastDailyXpAwardedAt),
    emailVerified,
    emailVerifiedAt,
    friends: Array.isArray(user.friends) ? user.friends : [],
    friendRequests: Array.isArray(user.friendRequests) ? user.friendRequests : [],
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

// ✅ Import optimization utilities
const { sendError, sendSuccess } = require('./utils/responseHandler');
const { validateUserData } = require('./utils/userRegistration');
const { userCache } = require('./utils/userCache');
const { normalizeFriendRequestStatus, buildFriendRequestPayload, buildCompleteUserProfile: buildFriendCompleteUserProfile, resolveProfileImageReference, normalizeProfileImageReference } = require('./utils/friendPayloadUtils');
const { sendOtpEmail, isEmailConfigured } = require('./utils/emailService');
const { createOtpForEmail, verifyOtpForEmail, startOtpCleanup, stopOtpCleanup } = require('./utils/otpStore');
const { uploadProfileImageToS3, replaceProfileImageInS3, deleteProfileImageFromS3, isS3Configured, isS3Url } = require('./utils/s3Service');
const { extractStatusNotePayload } = require('./utils/statusNoteUtils');
const cors = require('cors');
const multer = require('multer');

// Profile images are stored as S3 objects and referenced from DynamoDB metadata.
// The server does not write image files to its local filesystem or upload folder.
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const acceptedImageExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif',
    ]);
    const originalName = String(file.originalname || '').toLowerCase();
    const extension = path.extname(originalName);
    const isImageMime = typeof file.mimetype === 'string' && file.mimetype.startsWith('image/');
    const isImageExtension = acceptedImageExtensions.has(extension);

    if (isImageMime || isImageExtension) {
      return cb(null, true);
    }

    cb(new Error('Not an image! Please upload an image.'), false);
  },
});


// ✅ Import enhancement middleware
const { validateAuth, validateRegistration, validateProfileUpdate } = require('./middleware/validation');
const { globalRateLimit, createRateLimiter, startCleanupInterval, stopCleanupInterval } = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler, asyncHandler } = require('./middleware/errorHandler');

// ✅ Import enhancement utilities
const health = require('./utils/health');

// Set log level based on environment
Logger.setLevel(process.env.NODE_ENV === 'development' ? Logger.LOG_LEVELS.DEBUG : Logger.LOG_LEVELS.INFO);

// Safety: Prevent accidentally running with the local JSON dev store in production.
try {
  const { isDevStoreEnabled: _isDevStoreEnabled } = require('./utils/dynamoDBService');
  if (process.env.NODE_ENV === 'production' && _isDevStoreEnabled && _isDevStoreEnabled()) {
    Logger.error('startup', 'Refusing to start in production while local dev store is enabled. Set USE_DEV_STORE=false and provide AWS credentials.');
    process.exit(1);
  }
} catch (e) {
  // If the module cannot be resolved for some reason, log a warning but continue.
  Logger.warn('startup', 'Failed to verify dev store state during startup', e && e.message);
}

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);
app.disable('x-powered-by');
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.timeout = 120000;

const allowedOriginsRaw = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];

// Backwards-compatible developer convenience: allow wildcard in development only.
const defaultDevOrigins = ['http://localhost:3000', 'http://localhost:8080'];
let allowedOriginsSet = new Set(allowedOriginsRaw);

if (allowedOriginsSet.size === 0) {
  if (process.env.NODE_ENV === 'development') {
    allowedOriginsSet = new Set(defaultDevOrigins);
    Logger.info('cors', 'No ALLOWED_ORIGINS set; using development defaults', { allowedOrigins: defaultDevOrigins });
  } else {
    Logger.warn('cors', 'No ALLOWED_ORIGINS configured; CORS will be restricted. Set ALLOWED_ORIGINS in env to allow origins.');
  }
} else if (allowedOriginsSet.has('*') && process.env.NODE_ENV !== 'development') {
  Logger.warn('cors', 'Wildcard origin (*) detected in ALLOWED_ORIGINS in non-development environment. Removing wildcard for safety.');
  allowedOriginsSet.delete('*');
}

const isLocalhostOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const normalizeOrigin = (origin) => {
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch (error) {
    return origin;
  }
};

const isAllowedOrigin = (origin) => {
  // No origin (like from non-browser clients) is allowed
  if (!origin) return true;

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return true;

  // Check if origin is in explicit allowed list
  if (allowedOriginsSet.has(normalizedOrigin) || allowedOriginsSet.has('*')) {
    return true;
  }

  // Always allow localhost in development (critical for local testing)
  if (process.env.NODE_ENV === 'development' && isLocalhostOrigin(normalizedOrigin)) {
    return true;
  }

  // Check hostname patterns for AWS/deployment services
  try {
    const hostname = new URL(normalizedOrigin).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')) {
      return true;
    }
    if (hostname.endsWith('.amazonaws.com') || hostname.endsWith('.elasticbeanstalk.com') || hostname.endsWith('.app.github.dev')) {
      return true;
    }
  } catch (error) {
    // Ignore malformed origin values
  }

  // In development, allow all origins as a last resort (for Flutter web testing)
  if (process.env.NODE_ENV === 'development') {
    Logger.warn('cors', `Development mode: allowing origin despite not being in list: ${origin}`);
    return true;
  }

  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    Logger.warn('cors', `Blocked origin: ${origin}`);
    return callback(new Error('CORS policy: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-User-Id'],
  exposedHeaders: ['Content-Type'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 200, // For legacy browsers
  maxAge: 86400, // Cache preflight for 24 hours
};

// ✅ Add JSON parsing middleware with compression
app.use(compression()); // ✅ Gzip compression for all responses
app.use(helmet()); // ✅ Security headers (X-Frame-Options, Content-Security-Policy, etc.)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors(corsOptions));
// Parse cookies for refresh-token endpoints
app.use(cookieParser());

// Create rate limiters before routes that depend on them.
const registerLimiter = createRateLimiter('register', 20, 60 * 60); // 20 per hour
const loginLimiter = createRateLimiter('login', 15, 15 * 60); // 15 per 15 minutes
const deleteAccountLimiter = createRateLimiter('delete-account', 3, 60 * 60); // 3 per hour
const uploadLimiter = createRateLimiter('upload', 5, 60 * 60); // 5 uploads per hour

// Profile image upload endpoint
if (!isS3Configured()) {
  Logger.warn('upload', 'AWS_S3_BUCKET is not configured. /upload will return S3_CONFIG_MISSING until configured.');
}

app.post('/upload', uploadLimiter, upload.single('profileImage'), async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  if (!isS3Configured()) {
    return sendError(res, 500, 'S3 uploads are not configured', {
      code: 'S3_CONFIG_MISSING',
      details: 'AWS_S3_BUCKET environment variable is required',
    });
  }

  if (!req.file || !req.file.buffer) {
    return sendError(res, 400, 'No image file provided', 'UPLOAD_FAILED');
  }

  const userId = normalizeId(req.body.userId || req.headers['x-user-id']);
  if (!userId) {
    return sendError(res, 400, 'userId is required for profile image upload', 'VALIDATION_ERROR');
  }

  try {
    const existingUser = await getUserById(userId);
    if (!existingUser) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const previousUrl = existingUser.profileImageUrl || null;
    const uploaded = previousUrl && isS3Url(previousUrl)
      ? await replaceProfileImageInS3(
          req.file.buffer,
          req.file.originalname || `profile-${Date.now()}`,
          req.file.mimetype || 'application/octet-stream',
          userId,
          previousUrl,
        )
      : await uploadProfileImageToS3(
          req.file.buffer,
          req.file.originalname || `profile-${Date.now()}`,
          req.file.mimetype || 'application/octet-stream',
          userId,
        );

    const pictureName = normalizeStringInput(req.body.pictureName || req.body.picture_name);
    const updatedUser = await updateUserById(userId, {
      profileImageUrl: uploaded.url,
      profileImagePath: uploaded.url,
      pictureName: pictureName || existingUser.pictureName || null,
      updatedAt: new Date(),
    });

    userCache.invalidate(userId);

    const uploadedPayload = buildCompleteUserProfile(updatedUser) || null;
    try {
      if (uploadedPayload) {
        io.emit('profile_update', uploadedPayload);
        io.emit('profile_updated', uploadedPayload);
        io.emit('friend_profile_updated', {
          userId: uploadedPayload.userId,
          id: uploadedPayload.userId,
          profile: uploadedPayload,
          timestamp: Date.now(),
        });
      }
    } catch (broadcastErr) {
      Logger.warn('upload', 'Failed to broadcast profile update after image upload', {
        userId,
        error: broadcastErr?.message || broadcastErr,
      });
    }

    Logger.info('upload', 'Profile image uploaded and persisted to DynamoDB', {
      userId,
      key: uploaded.key,
      url: uploaded.url,
      replacedExisting: Boolean(previousUrl && isS3Url(previousUrl)),
    });

    return sendSuccess(res, {
      data: {
        url: uploaded.url,
        key: uploaded.key,
        profileImageUrl: uploadedPayload?.profileImageUrl || updatedUser?.profileImageUrl || uploaded.url,
        user: uploadedPayload,
      },
    }, 'Image uploaded successfully');
  } catch (err) {
    Logger.error('upload', 'Error uploading image to S3', err?.message || err);
    return sendError(res, 500, 'Failed to upload image to S3', {
      code: 'S3_UPLOAD_FAILED',
      details: err?.message || String(err),
    });
  }
});

app.delete(['/upload', '/upload/:userId'], async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const userId = normalizeId(req.params.userId || req.body.userId || req.query.userId || req.headers['x-user-id']);
  if (!userId) {
    return sendError(res, 400, 'userId is required for profile image deletion', 'VALIDATION_ERROR');
  }

  try {
    const existingUser = await getUserById(userId);
    if (!existingUser) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const previousUrl = existingUser.profileImageUrl || null;
    if (previousUrl && isS3Url(previousUrl)) {
      try {
        await deleteProfileImageFromS3(previousUrl);
      } catch (deleteErr) {
        Logger.warn('upload/delete', 'Unable to delete previous profile image from S3', {
          userId,
          previousUrl,
          error: deleteErr?.message || deleteErr,
        });
      }
    }

    const updatedUser = await updateUserById(userId, {
      profileImageUrl: null,
      profileImagePath: null,
      pictureName: null,
      updatedAt: new Date(),
    });
    userCache.invalidate(userId);

    Logger.info('upload/delete', 'Profile image removed and DynamoDB metadata cleared', { userId });

    return sendSuccess(res, {
      data: {
        profileImageUrl: null,
        user: buildCompleteUserProfile(updatedUser) || null,
      },
    }, 'Profile image removed successfully');
  } catch (err) {
    Logger.error('upload/delete', 'Error removing profile image', err?.message || err);
    return sendError(res, 500, 'Failed to remove profile image', {
      code: 'PROFILE_IMAGE_DELETE_FAILED',
      details: err?.message || String(err),
    });
  }
});


// ✅ Register global middleware (BEFORE routes)
app.use(globalRateLimit);

// ✅ Health check endpoint
app.get('/health', health.handleHealthCheck);

// ✅ Register database health check
health.registerService('database', async () => {
  const connected = await isDbConnected();
  return connected
    ? { status: 'healthy', message: 'DynamoDB accessible' }
    : { status: 'unhealthy', message: 'Unable to connect to DynamoDB' };
});

// Server startup tasks are triggered in startServer() so tests can require this module
// without creating nonstop background intervals.

// ========== DYNAMODB CONFIGURATION VALIDATION ==========
const DYNAMODB_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.DYNAMODB_REGION;
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || process.env.AWS_DYNAMODB_TABLE || 'oververseDB';

if (!DYNAMODB_REGION || !DYNAMODB_TABLE) {
  Logger.error('config', 'AWS_REGION and DYNAMODB_TABLE must be configured in the environment.');
  process.exit(1);
}

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || null;
const AWS_S3_PROFILE_FOLDER = process.env.AWS_S3_PROFILE_FOLDER || 'profiles';
const AWS_S3_PUBLIC_URL = process.env.AWS_S3_PUBLIC_URL || null;
const S3_CONFIGURED = Boolean(AWS_S3_BUCKET);

Logger.info('dynamodb', `🔐 DynamoDB region: ${DYNAMODB_REGION}, table: ${DYNAMODB_TABLE}`);
Logger.info('aws', `☁️ S3 uploads ${S3_CONFIGURED ? 'enabled' : 'disabled'}; bucket: ${AWS_S3_BUCKET || 'NOT_SET'}; publicUrl: ${AWS_S3_PUBLIC_URL || 'none'}; profileFolder: ${AWS_S3_PROFILE_FOLDER}`);
if (!S3_CONFIGURED) {
  Logger.warn('aws', '⚠️ S3 uploads are disabled because AWS_S3_BUCKET is not configured. Upload endpoints will return S3_CONFIG_MISSING.');
  if (process.env.NODE_ENV === 'production') {
    Logger.error('aws', 'Refusing to start in production without AWS_S3_BUCKET configured. Configure S3 before starting the server.');
    process.exit(1);
  }
}

// ========== CONFIGURATION ==========
const CONFIG = {
  PORT: process.env.PORT || 8080,
  // ✅ For development: Use 0.0.0.0 (accessible from Android emulator at 10.0.2.2)
  // For production: Set SERVER_IP env var to public IP
  SERVER_IP: process.env.SERVER_IP || 'localhost',
  // Host/interface to bind the HTTP server to (defaults to all interfaces for emulator access)
  SERVER_BIND: process.env.SERVER_BIND || '0.0.0.0',
  STALE_TIMEOUT: 5 * 60 * 1000, // 5 minutes
  CLEANUP_INTERVAL: 60 * 1000, // 60 seconds
  MAX_USERNAME_LENGTH: 50,
  // ✅ GROUP ROOM CAPACITY: 10-user limit per room with auto-replica creation
  GROUP_ROOM_CAPACITY: 10,
  // ✅ OPTIMIZE: Faster member list sync
  MEMBER_SYNC_INTERVAL: 500, // ms - how often to sync member list to room
  PRESENCE_BROADCAST_INTERVAL: 250, // ms - debounce status broadcasts
  // Optional TURN config via environment variables
  TURN_URL: process.env.TURN_URL || null,
  TURN_USERNAME: process.env.TURN_USERNAME || null,
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL || null,
  // Default ICE servers (will include TURN if provided via env)
  DEFAULT_ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  // Suggested media constraints clients can use to improve quality
  MEDIA_CONSTRAINTS: {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: true,
    // Suggested target bitrate in kbps for clients to try to apply via setParameters
    suggestedVideoBitrateKbps: 1000,
  },
};

let serverStarted = false;
let friendSystemCleanupInterval = null;
let voiceSpaceCleanupInterval = null;
let statusCleanupInterval = null;
let rateLimitCleanupInterval = null;
let otpCleanupInterval = null;
let socketRateLimitCleanupInterval = null;
let globalCleanupInterval = null;
let statsBroadcastInterval = null;
let isGracefulShutdown = false;
const trackedIntervals = new Set();

function trackInterval(intervalId) {
  if (intervalId) {
    trackedIntervals.add(intervalId);
  }
  return intervalId;
}

function clearTrackedInterval(intervalId) {
  if (intervalId) {
    try { clearInterval(intervalId); } catch (e) {}
    trackedIntervals.delete(intervalId);
  }
}

function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  server.listen(CONFIG.PORT, CONFIG.SERVER_BIND, () => {
    Logger.info('startup', 'WebSocket server listening', {
      bind: CONFIG.SERVER_BIND,
      advertisedIP: CONFIG.SERVER_IP,
      port: CONFIG.PORT,
    });

    // ✅ Start friend system cleanup (notifications, rate limits, profile cache)
    friendSystemCleanupInterval = trackInterval(startFriendSystemCleanup());

    // ✅ NEW: Start stale voice space cleanup timer
    const SPACE_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    voiceSpaceCleanupInterval = trackInterval(setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;
      for (const [spaceId, space] of activeVoiceSpaces.entries()) {
        if (space.participants.length === 0 && (now - space.createdAt > SPACE_IDLE_TIMEOUT)) {
          activeVoiceSpaces.delete(spaceId);
          cleanedCount++;
        }
      }
      if (cleanedCount > 0) {
        Logger.info('cleanup', `Removed ${cleanedCount} stale voice space(s)`, {});
        broadcastActiveSpaces();
      }
    }, SPACE_IDLE_TIMEOUT));

    // ✅ Start health monitoring and background cleanup intervals after server is bound
    if (health && typeof health.startMonitoring === 'function') {
      try {
        health.startMonitoring();
        Logger.info('startup', 'Health monitoring started');
      } catch (err) {
        Logger.warn('startup', 'Failed to start health monitoring', { err: err && err.message });
      }
    }

    rateLimitCleanupInterval = startCleanupInterval();
    otpCleanupInterval = startOtpCleanup();
    socketRateLimitCleanupInterval = startSocketRateLimitCleanup();
    // Cleanup status entries older than 27 hours (decompose after 27h)
    statusCleanupInterval = trackInterval(setInterval(async () => {
      try {
        const expirationDate = new Date(Date.now() - 27 * 60 * 60 * 1000);
        const result = await clearExpiredStatuses(expirationDate.toISOString());
        if (result > 0) {
          Logger.info('status_cleanup', `Cleared status for ${result} users`);
        }
      } catch (err) {
        Logger.error('status_cleanup', 'Failed to clean up expired statuses', err.message);
      }
    }, 15 * 60 * 1000)); // Check every 15 minutes
    globalCleanupInterval = trackInterval(setInterval(() => {
      try {
        const now = Date.now();

        // Clean video queue - with timeout notifications
        for (let i = videoQueue.length - 1; i >= 0; i--) {
          if (now - videoQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
            const stalUser = videoQueue.splice(i, 1)[0];
            const waitedMs = now - stalUser.joinedAt;

            if (io.sockets.sockets.get(stalUser.socketId)) {
              io.to(stalUser.socketId).emit('queue_timeout', {
                type: 'video',
                reason: 'No partner found - waited too long',
                waitedSeconds: Math.floor(waitedMs / 1000),
                maxWaitSeconds: Math.floor(CONFIG.STALE_TIMEOUT / 1000),
              });
            }

            socketQueues.delete(stalUser.socketId);
            Logger.info('cleanup', 'Removed stale video user', {
              socketId: stalUser.socketId,
              waitedSeconds: Math.floor(waitedMs / 1000),
            });
          }
        }

        // Clean chat queue - with timeout notifications
        for (let i = chatQueue.length - 1; i >= 0; i--) {
          if (now - chatQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
            const stalUser = chatQueue.splice(i, 1)[0];
            const waitedMs = now - stalUser.joinedAt;

            if (io.sockets.sockets.get(stalUser.socketId)) {
              io.to(stalUser.socketId).emit('queue_timeout', {
                type: 'chat',
                reason: 'No chat partner found - waited too long',
                waitedSeconds: Math.floor(waitedMs / 1000),
                maxWaitSeconds: Math.floor(CONFIG.STALE_TIMEOUT / 1000),
              });
            }

            socketQueues.delete(stalUser.socketId);
            Logger.info('cleanup', 'Removed stale chat user', {
              socketId: stalUser.socketId,
              waitedSeconds: Math.floor(waitedMs / 1000),
            });
          }
        }

        // Clean stale group message ID caches
        for (const [groupName, cache] of messageIdCache.entries()) {
          if (cache.timestamp && now - cache.timestamp > MESSAGE_CACHE_TIMEOUT) {
            messageIdCache.delete(groupName);
          }
        }

        try {
          for (const [groupName, roomSet] of groupChatRooms.entries()) {
            for (const memberSocketId of Array.from(roomSet)) {
              if (!io.sockets.sockets.has(memberSocketId) || !socketMetadata.has(memberSocketId)) {
                roomSet.delete(memberSocketId);
              }
            }
            if (roomSet.size === 0) {
              groupChatRooms.delete(groupName);
              messageIdCache.delete(groupName);
              Logger.info('cleanup', 'Removed stale empty group room during cleanup', { groupName });
            }
          }
        } catch (e) {
          Logger.warn('cleanup', 'Error cleaning stale groupChatRooms', { err: e && e.message });
        }

        try {
          for (const [spaceId, space] of Array.from(activeVoiceSpaces.entries())) {
            for (let i = space.participants.length - 1; i >= 0; i--) {
              const participant = space.participants[i];
              const participantSocketId = userSockets.get(participant.userId);
              if (!participantSocketId || !io.sockets.sockets.has(participantSocketId) || !socketMetadata.has(participantSocketId)) {
                space.participants.splice(i, 1);
                userToSpaceMap.delete(participant.userId);
                Logger.info('cleanup', `Removed offline participant ${participant.userId} from space ${spaceId}`);
              }
            }

            const hostSocketId = userSockets.get(String(space.hostId));
            const hostOnline = hostSocketId && io.sockets.sockets.has(hostSocketId);
            const age = Date.now() - (space.createdAt || 0);
            if (!hostOnline && age > CONFIG.STALE_TIMEOUT) {
              Logger.info('cleanup', `Closing stale space ${spaceId} because host offline for ${Math.floor(age/1000)}s`);
              try {
                closeSpaceAsHost(spaceId, 'stale_host_offline');
              } catch (err) {
                Logger.warn('cleanup', `Failed to close stale space ${spaceId}`, { err: err && err.message });
                activeVoiceSpaces.delete(spaceId);
                broadcastActiveSpaces();
              }
              continue;
            }

            if (!space.participants || space.participants.length === 0) {
              activeVoiceSpaces.delete(spaceId);
              Logger.info('cleanup', `Deleted empty voice space ${spaceId}`);
              io.emit('space_closed', { spaceId });
              broadcastActiveSpaces();
            } else {
              emitSpaceUpdated(space);
            }
          }
        } catch (e) {
          Logger.warn('cleanup', 'Error cleaning stale voice spaces', { err: e && e.message });
        }

        broadcastStats();
      } catch (error) {
        Logger.error('cleanup', 'Error during cleanup', error.message);
      }
    }, CONFIG.CLEANUP_INTERVAL));
    statsBroadcastInterval = trackInterval(setInterval(() => {
      try {
        broadcastStats();
      } catch (err) {
        Logger.error('periodicBroadcast', 'Error broadcasting stats', err.message);
      }
    }, 5000));
  });
}

// Start server only when this module is run directly. Tests should call
// `startServer()` explicitly so they can control lifecycle and ports.
if (require.main === module) {
  startServer();
}

async function stopServer() {
  try {
    if (io && typeof io.close === 'function') {
      await new Promise((resolve) => {
        try {
          io.close(() => resolve());
        } catch (e) {
          resolve();
        }
      });
    }

    if (server && typeof server.close === 'function') {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch (e) {
          resolve();
        }
      });
    }

    if (voiceSpaceCleanupInterval) {
      clearTrackedInterval(voiceSpaceCleanupInterval);
      voiceSpaceCleanupInterval = null;
    }
    if (health && typeof health.stopMonitoring === 'function') {
      try { health.stopMonitoring(); } catch (e) { /* ignore */ }
    }
    if (statusCleanupInterval) {
      clearTrackedInterval(statusCleanupInterval);
      statusCleanupInterval = null;
    }
    if (rateLimitCleanupInterval) {
      clearTrackedInterval(rateLimitCleanupInterval);
      rateLimitCleanupInterval = null;
    }
    if (otpCleanupInterval) {
      clearTrackedInterval(otpCleanupInterval);
      otpCleanupInterval = null;
    }
    if (socketRateLimitCleanupInterval) {
      clearTrackedInterval(socketRateLimitCleanupInterval);
      socketRateLimitCleanupInterval = null;
    }
    if (globalCleanupInterval) {
      clearTrackedInterval(globalCleanupInterval);
      globalCleanupInterval = null;
    }
    if (statsBroadcastInterval) {
      clearTrackedInterval(statsBroadcastInterval);
      statsBroadcastInterval = null;
    }
    stopCleanupInterval();
    stopOtpCleanup();
    for (const intervalId of Array.from(trackedIntervals)) {
      clearTrackedInterval(intervalId);
    }

    if (pendingVoiceSpaceDisconnects && pendingVoiceSpaceDisconnects.size > 0) {
      for (const timeoutId of pendingVoiceSpaceDisconnects.values()) {
        try { clearTimeout(timeoutId); } catch (e) { /* ignore */ }
      }
      pendingVoiceSpaceDisconnects.clear();
    }
  } finally {
    serverStarted = false;
  }
}

function getPort() {
  try {
    const addr = server && server.address && server.address();
    if (addr && typeof addr.port === 'number' && addr.port > 0) return addr.port;
  } catch (e) {}
  return CONFIG.PORT;
}

// ✅ OPTIMIZED: Socket.IO Configuration for deployment compatibility
const io = socketIO(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error('CORS policy: Origin not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  },

  // ✅ OPTIMIZED: Enable WebSocket Compression (reduces payload bandwidth significantly)
  perMessageDeflate: {
    threshold: 1024, // Compress responses larger than 1KB
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
  },

  // ✅ OPTIMIZED: Transport options - allow both websocket and polling for AWS/load balancer compatibility
  transports: ['websocket', 'polling'],
  // Allow older engine.io v3 clients (mobile clients may use older engines)
  allowEIO3: true,

  // ✅ OPTIMIZED: Connection timing for faster dead-connection detection
  pingInterval: 10000,  // Check connection every 10s
  pingTimeout: 5000,    // Wait 5s for pong before disconnecting

  // ✅ CRITICAL FIX: Payload settings
  // Increased from 100KB to 5MB to allow profile images in register_user payload
  // Server-side validation will discard large images before re-emitting
  maxHttpBufferSize: 5 * 1024 * 1024,  // 5MB max payload (allows initial profile image upload)

  // ✅ OPTIMIZED: Connection settings
  upgrade: true,           // Allow upgrade from polling to WebSocket
  rememberUpgrade: true,   // Remember which transport works
  connectTimeout: 10000,   // 10s to establish connection
});

// ✅ NEW: Global Socket.IO error handler for connection issues
io.engine.on('connection_error', (err) => {
  Logger.error('io_engine', '❌ Socket.IO connection error', {
    code: err.code,
    message: err.message,
    transport: err.req?.url || 'unknown',
  });
});

// ✅ IN-MEMORY VOICE SPACES (Temporary, Volatile - Not Persistent)
// Format: spaceId -> { spaceId, spaceName, description, hostId, hostName, hostAvatar, hostAvatarColor, hostProfileImageUrl, isPrivate, speakerLimit, participants: [], createdAt, status }
const activeVoiceSpaces = new Map(); // spaceId -> space object

// Track user's current space for auto-cleanup on disconnect
const userToSpaceMap = new Map(); // userId -> spaceId

// Delay cleanup for temporary disconnects so quick reconnects do not destroy voice spaces
const pendingVoiceSpaceDisconnects = new Map(); // userId -> timeoutId
const VOICE_SPACE_DISCONNECT_GRACE_MS = 10000;

function getSpaceStatus(space) {
  let currentListeners = 0;
  let currentSpeakers = 0;
  for (const participant of space.participants || []) {
    const role = String(participant.role || '').trim().toLowerCase();
    if (role == 'speaker' || role == 'onstage') {
      currentSpeakers += 1;
    } else if (role == 'listener') {
      currentListeners += 1;
    }
  }
  return {
    currentListeners,
    currentSpeakers,
    participantCount: (space.participants || []).length,
  };
}

function serializeSpace(space) {
  const status = getSpaceStatus(space);
  return {
    ...space,
    ...status,
    participants: undefined,
  };
}

function getSortedActiveSpaces() {
  return Array.from(activeVoiceSpaces.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(serializeSpace);
}

function broadcastActiveSpaces() {
  io.emit('active_spaces_updated', { spaces: getSortedActiveSpaces() });
}

function emitSpaceUpdated(space) {
  const payload = {
    spaceId: space.spaceId,
    participants: space.participants,
    ...getSpaceStatus(space),
  };
  io.to(`space:${space.spaceId}`).emit('space_updated', payload);
  try {
    const room = io.sockets.adapter.rooms.get(`space:${space.spaceId}`);
    const socketsInRoom = room ? room.size : 0;
    Logger.debug('emitSpaceUpdated', `Updated space:${space.spaceId} (participants=${payload.participantCount}, socketsInRoom=${socketsInRoom})`);
  } catch (err) {
    Logger.warn('emitSpaceUpdated', 'Could not inspect room membership', err && err.message);
  }
}

function getSafeProfileImageReference(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:')
  ) {
    return trimmed;
  }
  return null;
}

async function resolveUserProfileMetadata(
  userId,
  userMeta = {},
  fallbackName = 'User',
  fallbackColor = '#128C7E',
  fallbackLetter = 'U',
) {
  const normalizedUserId = normalizeId(userId);
  const meta = {
    userId: normalizedUserId,
    ...(userMeta || {}),
  };

  const hasImage = Boolean(
    resolveProfileImageReference(meta) ||
    normalizeProfileImageReference(meta.profileImagePath) ||
    normalizeProfileImageReference(meta.profileImageUrl),
  );
  const hasName = Boolean(meta.userName);
  const hasLetter = Boolean(meta.avatarLetter);
  const hasColor = Boolean(meta.avatarColor);

  if ((!hasImage || !hasName || !hasLetter || !hasColor) && normalizedUserId) {
    try {
      const dbUser = await getUserById(normalizedUserId);
      if (dbUser) {
        const completeProfile = buildCompleteUserProfile(dbUser) || {};
        meta.userName =
          meta.userName || completeProfile.userName || completeProfile.name || fallbackName;
        meta.avatarColor = meta.avatarColor || completeProfile.avatarColor || fallbackColor;
        meta.avatarLetter =
          meta.avatarLetter ||
          completeProfile.avatarLetter ||
          (meta.userName ? String(meta.userName).charAt(0).toUpperCase() : fallbackLetter);
        meta.profileImagePath =
          meta.profileImagePath || completeProfile.profileImagePath || completeProfile.profileImageUrl || null;
        meta.profileImageUrl =
          meta.profileImageUrl ||
          completeProfile.profileImageUrl ||
          getSafeProfileImageReference(completeProfile.profileImagePath) ||
          null;
      }
    } catch (error) {
      Logger.warn('resolveUserProfileMetadata', 'Unable to fetch DB profile for user', {
        userId: normalizedUserId,
        error: error && error.message,
      });
    }
  }

  const resolvedName =
    String(meta.userName || fallbackName || normalizedUserId || 'User').trim() || 'User';
  const resolvedColor =
    String(meta.avatarColor || fallbackColor || '#128C7E').trim() || '#128C7E';
  const resolvedLetter =
    String(meta.avatarLetter || resolvedName[0] || fallbackLetter || 'U').trim().toUpperCase();
  const resolvedImage =
    resolveProfileImageReference(meta) ||
    getSafeProfileImageReference(meta.profileImageUrl) ||
    getSafeProfileImageReference(meta.profileImagePath) ||
    null;

  return {
    userId: normalizedUserId,
    userName: resolvedName,
    avatarColor: resolvedColor,
    avatarLetter: resolvedLetter,
    profileImageUrl: resolvedImage,
    profileImagePath: resolvedImage,
  };
}

function buildParticipant(userId, meta, role) {
  const safeImageUrl =
    getSafeProfileImageReference(meta.profileImageUrl) || getSafeProfileImageReference(meta.profileImagePath) || null;
  return {
    userId,
    userName: meta.userName,
    role,
    avatarColor: meta.avatarColor,
    avatarLetter: meta.avatarLetter,
    profileImageUrl: safeImageUrl,
    profileImagePath: safeImageUrl,
    joinedAt: Date.now(),
  };
}

function scheduleVoiceSpaceDisconnectCleanup(userId, spaceId, reason = 'participant_disconnected', socketId = null) {
  if (!userId || !spaceId) return;

  if (pendingVoiceSpaceDisconnects.has(userId)) {
    clearTimeout(pendingVoiceSpaceDisconnects.get(userId));
    pendingVoiceSpaceDisconnects.delete(userId);
  }

  const timeoutId = setTimeout(() => {
    pendingVoiceSpaceDisconnects.delete(userId);
    const space = activeVoiceSpaces.get(spaceId);
    if (!space) {
      userToSpaceMap.delete(userId);
      return;
    }

    const participantIdx = space.participants.findIndex((p) => String(p.userId) === String(userId));
    if (participantIdx === -1) {
      userToSpaceMap.delete(userId);
      return;
    }

    const removedParticipant = space.participants.splice(participantIdx, 1)[0];
    Logger.info('voice_space_disconnect', 'Removed disconnected participant after grace period', {
      socketId,
      userId,
      spaceId,
      reason,
      remainingParticipants: space.participants.length,
    });

    if (String(removedParticipant.userId) === String(space.hostId)) {
      closeSpaceAsHost(spaceId, reason);
    } else if (space.participants.length === 0) {
      activeVoiceSpaces.delete(spaceId);
      io.emit('space_closed', { spaceId, reason });
      Logger.info('voice_space_disconnect', `Deleted empty space ${spaceId} after disconnect timeout`, { spaceId, userId, reason });
      broadcastActiveSpaces();
    } else {
      emitSpaceUpdated(space);
      broadcastActiveSpaces();
    }

    userToSpaceMap.delete(userId);
  }, VOICE_SPACE_DISCONNECT_GRACE_MS);

  pendingVoiceSpaceDisconnects.set(userId, timeoutId);
  Logger.info('voice_space_disconnect', 'Scheduled voice space cleanup after disconnect grace period', {
    socketId,
    userId,
    spaceId,
    graceMs: VOICE_SPACE_DISCONNECT_GRACE_MS,
    reason,
  });
}

function cancelVoiceSpaceDisconnectCleanup(userId) {
  if (!userId) return;
  const timeoutId = pendingVoiceSpaceDisconnects.get(userId);
  if (!timeoutId) return;
  clearTimeout(timeoutId);
  pendingVoiceSpaceDisconnects.delete(userId);
  Logger.info('voice_space_disconnect', 'Cancelled scheduled voice space cleanup', { userId });
}

function closeSpaceAsHost(spaceId, reason = 'host_disconnected') {
  const space = activeVoiceSpaces.get(spaceId);
  if (!space) return;

  for (const participant of space.participants) {
    const participantSocketId = userSockets.get(participant.userId);
    if (participantSocketId) {
      io.to(participantSocketId).emit('space_closed_by_host', { spaceId, reason });
      io.sockets.sockets.get(participantSocketId)?.leave(`space:${spaceId}`);
    }
    userToSpaceMap.delete(participant.userId);
  }

  activeVoiceSpaces.delete(spaceId);
  io.emit('space_closed', { spaceId });
  Logger.info('space', `Closed space ${spaceId} because host disconnected`, { reason });
  broadcastActiveSpaces();
}

// ✅ Helper: Normalize any incoming ID-like value to a trimmed string
function normalizeId(id) {
  if (id === undefined || id === null) return '';
  try {
    return String(id)
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/^'+|'+$/g, '');
  } catch (e) {
    return '';
  }
}

// ========== FRIEND REQUESTS & FRIENDS ENDPOINTS ==========

// Note: canonical friend endpoints are implemented later in this file. The earlier
// duplicate block has been removed to avoid route shadowing and stale behavior.

// Simple lookup endpoint to help debug join-by-invite behavior from clients
app.get('/room/by-invite/:code', (req, res) => {
  try {
    const code = (req.params.code || '').toString().trim().toUpperCase();
    if (!code) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CODE',
          message: 'Invite code is required and cannot be empty',
        },
      });
    }

    for (const room of rooms.values()) {
      if (room.inviteCode && room.inviteCode.toUpperCase() === code) {
        return res.json({
          success: true,
          room: {
            roomId: room.roomId,
            roomName: room.roomName,
            creatorName: room.creatorName,
            memberCount: room.memberIds.length,
            maxMembers: room.maxMembers,
            status: room.status,
          },
        });
      }
    }
    return res.status(404).json({
      success: false,
      error: {
        code: 'ROOM_NOT_FOUND',
        message: 'Room with the specified invite code not found',
      },
    });
  } catch (err) {
    Logger.error('http', 'Error in /room/by-invite', err && err.message);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred while looking up the room',
      },
    });
  }
});

// Helper: sign access and refresh tokens for a user
function signTokensForUser(user) {
  const accessSecret = process.env.JWT_SECRET || 'dev_jwt_secret';
  const refreshSecret = process.env.JWT_REFRESH_SECRET || accessSecret;
  const accessTtl = process.env.JWT_ACCESS_EXPIRES || '15m';
  const refreshTtl = process.env.JWT_REFRESH_EXPIRES || '30d';

  const accessToken = jwt.sign({ sub: user.userId, email: user.email, authType: user.authType }, accessSecret, { expiresIn: accessTtl });
  const refreshToken = jwt.sign({ sub: user.userId }, refreshSecret, { expiresIn: refreshTtl });
  return { accessToken, refreshToken };
}

// ========== NEW: REGISTER ENDPOINT ==========
app.post('/auth/register', registerLimiter, validateRegistration, asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const {
      userId: requestedUserId,
      userName,
      email,
      password,
      gender,
      country,
      avatarColor,
      birthDate,
      profileImageUrl,
      pictureName,
      emailVerified,
    } = req.body;

    if (!userName || !email || !password) {
      return sendError(res, 400, 'userName, email, and password are required', 'VALIDATION_ERROR');
    }

    const emailValue = String(email).trim();
    const normalizedEmail = emailValue.toLowerCase();
    const newUserId = requestedUserId && String(requestedUserId).trim().length > 0
      ? String(requestedUserId).trim()
      : `local_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const existingUserById = await getUserById(newUserId);
    const existingUserByEmail = await getUserByEmail(normalizedEmail);
    if (existingUserById || existingUserByEmail) {
      return sendError(res, 409, 'User already exists', 'USER_EXISTS');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const birthDateValue = birthDate ? new Date(String(birthDate)) : null;

    const savedUser = await createUser({
      userId: newUserId,
      userName: String(userName).trim(),
      email: emailValue,
      passwordHash: hashedPassword,
      authType: 'MAIL',
      isGuest: false,
      gender: gender ? String(gender).toLowerCase() : 'other',
      country: country || null,
      status: null,
      bio: null,
      interests: [],
      birthDate: birthDateValue,
      avatarColor: avatarColor || '#128C7E',
      profileImageUrl: profileImageUrl || null,
      pictureName: pictureName || null,
      emailVerified: emailVerified === true,
      emailVerifiedAt: emailVerified === true ? new Date() : null,
      profileComplete: true,
      lastLogin: new Date(),
    });

    Logger.info('auth/register', '✅ New user registered', { userId: newUserId, email: normalizedEmail });

    // Issue JWT tokens (access + refresh) and set refresh token as HttpOnly cookie
    try {
      const tokens = signTokensForUser(savedUser);
      const refreshCookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: '/',
      };
      res.cookie('refreshToken', tokens.refreshToken, refreshCookieOptions);

      return sendSuccess(res, {
        accessToken: tokens.accessToken,
        user: {
          ...buildCompleteUserProfile(savedUser),
          lastLogin: savedUser.lastLogin,
          createdAt: savedUser.createdAt,
        },
      }, 'User registered successfully');
    } catch (tokenErr) {
      Logger.error('auth/register', 'Failed to sign JWT tokens', tokenErr && tokenErr.message);
      // Fall back to returning user without tokens
      return sendSuccess(res, {
        user: {
          ...buildCompleteUserProfile(savedUser),
          lastLogin: savedUser.lastLogin,
          createdAt: savedUser.createdAt,
        },
      }, 'User registered successfully');
    }
  } catch (err) {
    Logger.error('auth/register', 'Error registering user', err.message);
    return sendError(res, 500, 'Registration error', { details: err.message });
  }
}));

// ========== NEW: LOGIN ENDPOINT ==========
app.post('/auth/login', loginLimiter, validateAuth, asyncHandler(async (req, res) => {
  // Allow login against local dev store during development; if not using dev store,
  // require a live database connection.
  if (!isDevStoreEnabled() && !await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { userId, email, password } = req.body;
    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;

    Logger.debug('auth/login', 'Login request received', {
      userId: userId ? String(userId).trim() : null,
      email: normalizedEmail ? normalizedEmail.replace(/(.{2}).+@/, '$1***@') : null,
    });

    if (!userId && !normalizedEmail) {
      return sendError(res, 400, 'userId or email is required');
    }

    if (!password) {
      return sendError(res, 400, 'Password is required', 'VALIDATION_ERROR');
    }

    const lookup = { $or: [] };
    if (userId) lookup.$or.push({ userId: String(userId).trim() });
    if (normalizedEmail) {
      lookup.$or.push({ email: normalizedEmail });
    }

    if (lookup.$or.length === 0) {
      return sendError(res, 400, 'userId or email is required');
    }

    Logger.debug('auth/login', 'Looking up user for login', { lookup });
    let user = await findUserByLookup(lookup);

    if (!user && normalizedEmail) {
      Logger.debug('auth/login', 'Retrying login lookup by direct email query', { email: normalizedEmail });
      user = await getUserByEmail(normalizedEmail);
    }

    if (!user) {
      Logger.warn('auth/login', 'Login failed: no user found for login lookup', { lookup });
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (!user.passwordHash) {
      return sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const updatedUser = await updateUserById(user.userId, { lastLogin: new Date() });
    const currentUser = updatedUser || user;

    Logger.info('auth/login', '✅ User logged in', { userId: currentUser.userId, email: currentUser.email });

    return sendSuccess(res, {
      user: {
        ...buildCompleteUserProfile(currentUser),
        lastLogin: currentUser.lastLogin,
        createdAt: currentUser.createdAt,
      },
    }, 'Login successful');
  } catch (err) {
    Logger.error('auth/login', 'Error during login', err.message);
    return sendError(res, 500, 'Login error', { details: err.message });
  }
}));

app.post('/auth/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken || null;
  if (!refreshToken) {
    return sendError(res, 401, 'Refresh token is required', 'AUTH_REQUIRED');
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'dev_jwt_secret');
    const user = await getUserById(decoded.sub);
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const tokens = signTokensForUser(user);
    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return sendSuccess(res, {
      accessToken: tokens.accessToken,
      user: buildCompleteUserProfile(user),
    }, 'Token refreshed successfully');
  } catch (err) {
    Logger.warn('auth/refresh', 'Refresh token invalid or expired', { error: err && err.message });
    return sendError(res, 401, 'Invalid or expired refresh token', 'INVALID_TOKEN');
  }
}));

const sendOtpLimiter = createRateLimiter('send-otp', 10, 15 * 60); // 10 per 15 minutes
const verifyOtpLimiter = createRateLimiter('verify-otp', 15, 15 * 60); // 15 per 15 minutes

app.post('/auth/send-otp', sendOtpLimiter, asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  if (!isEmailConfigured()) {
    return sendError(res, 503, 'OTP email service is not configured', 'OTP_CONFIG_ERROR');
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    
    // ✅ Check if email already exists
    const existingUser = await getUserByEmail(normalizedEmail);
    if (existingUser) {
      return sendError(res, 409, 'Account with this email already exists. Please login instead.', 'EMAIL_ALREADY_EXISTS');
    }
    
    const otp = await createOtpForEmail(normalizedEmail);

    sendOtpEmail(normalizedEmail, otp)
      .then((info) => {
        Logger.info('auth/send-otp', 'OTP email queued for delivery', {
          to: normalizedEmail,
          messageId: info.messageId,
        });
      })
      .catch((sendError) => {
        Logger.error(
          'auth/send-otp',
          'OTP email delivery failed after response was returned',
          sendError?.message || sendError,
        );
      });

    return sendSuccess(res, {
      email: normalizedEmail,
      expiresIn: Number(process.env.OTP_EXPIRE_SECONDS || 300),
    }, 'OTP requested. Check your email shortly.');
  } catch (err) {
    const message = err?.message || 'Unable to send OTP';
    Logger.error('auth/send-otp', 'Error sending OTP', message);

    if (err?.code === 'OTP_RESEND_WAIT') {
      return sendError(res, 429, message, {
        code: 'OTP_RESEND_WAIT',
        resetTime: new Date(err.resetTime).toISOString(),
      });
    }

    return sendError(res, 500, message, { code: 'OTP_SEND_ERROR', details: err?.message });
  }
}));

// ✅ NEW: Check if email is available for signup (frontend can use this before sending OTP)
app.post('/auth/check-email-available', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const existingUser = await getUserByEmail(normalizedEmail);
    
    if (existingUser) {
      return sendSuccess(res, { available: false }, 'Email is already registered');
    }
    
    return sendSuccess(res, { available: true }, 'Email is available');
  } catch (err) {
    Logger.error('auth/check-email-available', 'Error checking email availability', err.message);
    return sendError(res, 500, 'Unable to check email availability', { details: err.message });
  }
}));

app.post('/auth/verify-otp', verifyOtpLimiter, asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email, otp } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  if (!otp || typeof otp !== 'string' || otp.trim().length === 0) {
    return sendError(res, 400, 'OTP is required', 'INVALID_OTP');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const result = await verifyOtpForEmail(normalizedEmail, otp.trim());

  if (!result.success) {
    const reason = result.reason || 'OTP_INVALID';
    const message = reason === 'OTP_EXPIRED'
      ? 'OTP expired. Please request a new one.'
      : reason === 'OTP_TOO_MANY_ATTEMPTS'
        ? 'Too many verification attempts. Please request a new OTP.'
        : 'OTP did not match. Please try again.';

    return sendError(res, 400, message, reason);
  }

  return sendSuccess(res, { verified: true }, 'OTP verified successfully');
}));

const forgotPasswordLimiter = createRateLimiter('forgot-password', 5, 15 * 60);
const resetPasswordLimiter = createRateLimiter('reset-password', 5, 15 * 60);

app.post('/auth/forgot-password', forgotPasswordLimiter, asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const user = await getUserByEmail(normalizedEmail);
  if (!user) {
    Logger.info('auth/forgot-password', 'Password reset request for unknown email', { email: normalizedEmail });
  }

  try {
    const otp = await createOtpForEmail(normalizedEmail);
    await sendOtpEmail(normalizedEmail, otp);
    return sendSuccess(res, { email: normalizedEmail }, 'Password reset OTP sent if the email is registered');
  } catch (err) {
    Logger.error('auth/forgot-password', 'Error sending password reset OTP', err.message);
    return sendError(res, 500, 'Unable to send password reset OTP', { code: 'OTP_SEND_ERROR', details: err?.message });
  }
}));

// Development-only helper: create and return OTP for an email (ONLY in development)
if (process.env.NODE_ENV === 'development') {
  app.post('/auth/dev-create-otp', asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || email.trim() === '') {
      return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
    }
    try {
      const normalizedEmail = String(email).toLowerCase().trim();
      const otp = await createOtpForEmail(normalizedEmail);
      Logger.info('auth/dev-create-otp', 'Dev OTP created', { email: normalizedEmail });
      return sendSuccess(res, { email: normalizedEmail, otp }, 'Dev OTP created (development only)');
    } catch (err) {
      Logger.error('auth/dev-create-otp', 'Error creating dev OTP', err && err.message);
      return sendError(res, 500, 'Unable to create OTP', { details: err && err.message });
    }
  }));
}

app.post('/auth/reset-password', resetPasswordLimiter, asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email, otp, newPassword } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }
  if (!otp || typeof otp !== 'string' || otp.trim() === '') {
    return sendError(res, 400, 'OTP is required', 'INVALID_OTP');
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return sendError(res, 400, 'New password must be at least 6 characters', 'INVALID_PASSWORD');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const result = await verifyOtpForEmail(normalizedEmail, otp.trim());
  if (!result.success) {
    const reason = result.reason || 'OTP_INVALID';
    const message = reason === 'OTP_EXPIRED'
      ? 'OTP expired. Please request a new one.'
      : reason === 'OTP_TOO_MANY_ATTEMPTS'
        ? 'Too many verification attempts. Please request a new OTP.'
        : 'OTP did not match. Please try again.';

    return sendError(res, 400, message, reason);
  }

  const user = await getUserByEmail(normalizedEmail);
  if (!user) {
    return sendError(res, 404, 'Email is not registered', 'USER_NOT_FOUND');
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await updateUserById(user.userId, {
      passwordHash: hashedPassword,
      emailVerified: true,
      emailVerifiedAt: new Date(),
    });

    Logger.info('auth/reset-password', 'Password reset successfully', { email: normalizedEmail, userId: user.userId });
    return sendSuccess(res, { email: normalizedEmail }, 'Password reset successfully');
  } catch (err) {
    Logger.error('auth/reset-password', 'Error resetting password', err.message);
    return sendError(res, 500, 'Unable to reset password', { code: 'RESET_PASSWORD_ERROR', details: err?.message });
  }
}));

// ========== NEW: CHECK EMAIL EXISTS ENDPOINT ==========
// ✅ CRITICAL: Frontend calls this to check if email is registered (for new/existing user detection)
// Called when checking email during signup/login flow to determine if a user exists
app.get('/auth/check-email', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const { email } = req.query;

    if (!email || typeof email !== 'string' || email.trim() === '') {
      return sendError(res, 400, 'Email query parameter is required', 'INVALID_EMAIL');
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Query for user with this email (case-insensitive)
    const existingUser = await getUserByEmail(normalizedEmail);

    if (existingUser) {
      // ✅ EMAIL EXISTS - Return normalized frontend user profile
      Logger.info('auth/check-email', '✅ Email found in database', { email: normalizedEmail, userId: existingUser.userId });

      return sendSuccess(res, {
        exists: true,
        user: buildCompleteUserProfile(existingUser),
      }, 'Email found - returning user');
    } else {
      // ✅ EMAIL NOT FOUND - New user, should proceed to profile creation
      Logger.info('auth/check-email', 'ℹ️ Email not found in database', { email: normalizedEmail });
      
      return sendError(res, 404, 'Email not registered', 'EMAIL_NOT_FOUND');
    }
  } catch (err) {
    Logger.error('auth/check-email', 'Error checking email', err.message);
    return sendError(res, 500, 'Email check error', { details: err.message });
  }
}));

// ========== NEW: GUEST LOGIN ENDPOINT ==========
// ✅ OPTIMIZED: Quick guest account creation with TTL cleanup
const guestLimiter = createRateLimiter('guest-login', 20, 60); // 20 per minute
app.post('/auth/guest-login', guestLimiter, asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { deviceId } = req.body;
    
    // ✅ OPTIMIZED: Generate unique guest ID based on timestamp + random
    const guestId = `guest_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const guestName = `Guest${Math.floor(Math.random() * 9000) + 1000}`;

    // ✅ Create guest user (auto-expire after 24 hours)
    // Generate temporary email for guest to maintain database integrity
    const guestEmail = `guest_${guestId}@guest.slyxy.local`;
    const guestUser = await createUser({
      userId: guestId,
      userName: guestName,
      email: guestEmail,
      authType: 'GUEST',
      isGuest: true,
      gender: 'other',
      country: null,
      avatarColor: '#6200EE',
      profileImageUrl: null,
      lastLogin: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      profileComplete: false,
    });

    Logger.info('auth/guest-login', '✅ Guest account created', { userId: guestId, deviceId });

    return sendSuccess(res, {
      user: {
        ...buildCompleteUserProfile(guestUser),
        lastLogin: guestUser.lastLogin,
      },
    }, 'Guest account created');
  } catch (err) {
    Logger.error('auth/guest-login', 'Error creating guest account', err.message);
    return sendError(res, 500, 'Guest login error', { details: err.message });
  }
}));

// ========== PERFORMANCE: SYSTEM STATS ENDPOINT ==========
app.get('/stats/system', async (req, res) => {
  const cacheStats = userCache.getStats();
  const dbStats = await getUserStats();
  
  return sendSuccess(res, {
    cache: cacheStats,
    database: dbStats,
    timestamp: new Date().toISOString(),
  });
});

// ========== PERFORMANCE: CACHE MANAGEMENT ==========
app.post('/cache/clear', (req, res) => {
  const sizeBefore = userCache.cache.size;
  userCache.clear();
  Logger.info('cache/clear', 'Cache cleared', { sizeBefore });
  return sendSuccess(res, { cleared: sizeBefore });
});

// ========== NEW: GET USER PROFILE ENDPOINT ==========
async function handleGetUserProfile(req, res) {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const userId = String(req.params.userId || '').trim();
  if (!userId) {
    return sendError(res, 400, 'Missing userId', 'VALIDATION_ERROR');
  }

  try {
    // ✅ PERFORMANCE: Check cache first and deduplicate concurrent loads
    let user = userCache.get(userId);

    if (!user) {
      user = await userCache.getOrLoad(userId, async () => {
        const fetchedUser = await getUserById(userId);
        return fetchedUser || null;
      });

      if (!user) {
        return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
      }
    }

    return sendSuccess(res, {
      user: {
        ...buildCompleteUserProfile(user),
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
    });
  } catch (err) {
    Logger.error('user/get', 'Error retrieving user', err.message);
    return sendError(res, 500, 'Error retrieving user', { details: err.message });
  }
}

app.get('/users/profile', async (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) {
    return sendError(res, 400, 'Missing userId query parameter', 'VALIDATION_ERROR');
  }
  req.params.userId = userId;
  return handleGetUserProfile(req, res);
});

// ========== NEW: BATCH USERS ENDPOINT ==========
// Returns multiple user profiles by comma-separated ids query or JSON body array
app.get('/users/batch', async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const idsParam = Array.isArray(req.query.ids)
      ? String(req.query.ids[0])
      : String(req.query.ids || '').trim();

    let ids = [];
    if (idsParam) {
      ids = idsParam.split(',').map((s) => normalizeId(s)).filter(Boolean);
    }

    // Also accept POST-like body arrays for clients that prefer JSON
    if ((!ids || ids.length === 0) && Array.isArray(req.body?.ids)) {
      ids = req.body.ids.map((s) => normalizeId(String(s))).filter(Boolean);
    }

    if (!ids || ids.length === 0) {
      return sendSuccess(res, { users: [] });
    }

    // Protect backend from very large requests; cap to reasonable number
    const MAX_BATCH_IDS = 100;
    if (ids.length > MAX_BATCH_IDS) {
      Logger.warn('users/batch', `Requested ${ids.length} ids, trimming to ${MAX_BATCH_IDS}`);
      ids = ids.slice(0, MAX_BATCH_IDS);
    }

    const users = await getUsersByIds(ids);
    return sendSuccess(res, { users: users || [] });
  } catch (err) {
    Logger.error('users/batch', 'Error fetching users by ids', err.message);
    return sendError(res, 500, 'Error fetching users', { details: err.message });
  }
});

// ========== NEW: SEARCH USERS ENDPOINT ==========
app.get('/users/search', async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const queryValue = req.query.q;
    const searchText = Array.isArray(queryValue)
      ? String(queryValue[0]).trim()
      : String(queryValue ?? '').trim();

    if (!searchText) {
      return sendError(res, 400, 'Search query is required', 'VALIDATION_ERROR');
    }

    const users = await searchUsers(searchText);

    Logger.info('users/search', `Search results: ${users.length} users found`, {
      query: searchText,
      count: users.length,
    });

    users.forEach(user => {
      if (user.userId) userCache.set(user.userId, user);
    });

    return res.status(200).json(users.map((user) => ({
      ...buildCompleteUserProfile(user),
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    })));

  } catch (err) {
    Logger.error('users/search', 'Error searching users', err.message);
    return sendError(res, 500, 'Error searching users', { details: err.message });
  }
});

app.get('/users/:userId', async (req, res) => {
  req.params.userId = String(req.params.userId || '').trim();
  return handleGetUserProfile(req, res);
});

app.get('/user/:userId', async (req, res) => {
  req.params.userId = String(req.params.userId || '').trim();
  return handleGetUserProfile(req, res);
});

// ========== FRIEND REQUEST & FRIEND LIST ENDPOINTS ==========

// Frontend compatibility alias: POST /friends/add (accepts friendId or recipientId)
app.post('/friends/add', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { userId, friendId, recipientId } = req.body;
  const targetUserId = normalizeId(friendId || recipientId);
  if (!userId || !targetUserId) {
    return sendError(res, 400, 'userId and recipientId are required', 'VALIDATION_ERROR');
  }

  try {
    const response = await createFriendRequestAndNotify(userId, targetUserId, 'friends/add');
    return sendSuccess(res, response, 'Friend request sent successfully');
  } catch (err) {
    Logger.error('friends/add', 'Error sending friend request', err.message);
    return sendError(res, err.statusCode || 500, err.message || 'Failed to send friend request', err.code || 'SEND_REQUEST_FAILED');
  }
}));

// Send friend request: POST /friends/request/send
app.post('/friends/request/send', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { userId, targetUserId } = req.body;
  if (!userId || !targetUserId) {
    return sendError(res, 400, 'userId and targetUserId are required', 'VALIDATION_ERROR');
  }

  try {
    const response = await createFriendRequestAndNotify(userId, targetUserId, 'friends/request/send');
    return sendSuccess(res, response, 'Friend request sent successfully');
  } catch (err) {
    Logger.error('friends/request/send', 'Error sending friend request', err.message);
    return sendError(res, err.statusCode || 500, err.message || 'Failed to send friend request', err.code || 'SEND_REQUEST_FAILED');
  }
}));

// Accept friend request: POST /friends/request/accept
app.post('/friends/request/accept', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { requestId } = req.body;
  if (!requestId) {
    return sendError(res, 400, 'requestId is required', 'VALIDATION_ERROR');
  }

  try {
    const currentUserId = req.body.userId?.toString().trim();
    const fromUserId = req.body.fromUserId?.toString().trim();
    const resolved = await resolveFriendRequestParticipants(requestId, currentUserId, fromUserId);

    if (!resolved) {
      return sendError(res, 400, 'Unable to resolve friend request participants', 'INVALID_REQUEST');
    }

    const { senderId: userId, receiverId: targetUserId } = resolved;

    // 🔒 Check rate limit
    if (!checkFriendRateLimit(targetUserId, 'acceptRequest')) {
      return sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
    }

    const request = await getFriendRequest(userId, targetUserId);
    if (!request || request.status !== 'pending') {
      return sendError(res, 404, 'Friend request not found or not pending', 'REQUEST_NOT_FOUND');
    }

    // Accept request (add to both users' friend lists)
    await acceptFriendRequest(userId, targetUserId);

    // Load updated users
    const updatedUser = await getUserById(targetUserId);
    const senderUser = await getUserById(userId);

    // 🗑️ Clear caches for both users
    clearUserProfileCache(userId);
    clearUserProfileCache(targetUserId);

    Logger.info('friends/request/accept', '✅ Friend request accepted', { from: userId, to: targetUserId });

    // 📱 Emit real-time notification to sender
    notifyUserOfFriendEvent(userId, 'friend_request_accepted', {
      request: buildFriendRequestPayload({
        ...request,
        status: 'accepted',
        sender: buildFriendCompleteUserProfile(senderUser),
        receiver: buildFriendCompleteUserProfile(updatedUser),
      }),
      currentUser: buildFriendCompleteUserProfile(senderUser),
      friend: buildFriendCompleteUserProfile(updatedUser),
      newFriend: buildFriendCompleteUserProfile(updatedUser),
    });

    const shapedCurrentUser = buildFriendCompleteUserProfile(updatedUser);
    const shapedFriend = buildFriendCompleteUserProfile(senderUser);
    const shapedRequest = buildFriendRequestPayload({
      ...request,
      status: 'accepted',
      requestType: request.requestType || 'FRIEND_REQUEST_ACCEPTED',
      isIncoming: false,
      isOutgoing: false,
    });

    return sendSuccess(res, {
      currentUser: shapedCurrentUser,
      friend: shapedFriend,
      request: shapedRequest,
      updatedFriendsList: shapedCurrentUser?.friends || [],
      newFriend: shapedFriend,
    }, 'Friend request accepted');
  } catch (err) {
    Logger.error('friends/request/accept', 'Error accepting friend request', err.message);
    return sendError(res, 500, 'Failed to accept friend request', { details: err.message });
  }
}));

// Deny/reject friend request: POST /friends/request/deny
app.post('/friends/request/deny', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { requestId } = req.body;
  if (!requestId) {
    return sendError(res, 400, 'requestId is required', 'VALIDATION_ERROR');
  }

  try {
    const currentUserId = req.body.userId?.toString().trim();
    const fromUserId = req.body.fromUserId?.toString().trim();
    const resolved = await resolveFriendRequestParticipants(requestId, currentUserId, fromUserId);

    if (!resolved) {
      return sendError(res, 400, 'Unable to resolve friend request participants', 'INVALID_REQUEST');
    }

    const { senderId: userId, receiverId: targetUserId } = resolved;

    const request = await getFriendRequest(userId, targetUserId);
    if (!request) {
      return sendError(res, 404, 'Friend request not found', 'REQUEST_NOT_FOUND');
    }

    const denialResult = await denyFriendRequest(userId, targetUserId);
    const finalStatus = normalizeFriendRequestStatus(denialResult?.status || request.status || 'rejected');

    Logger.info('friends/request/deny', '✅ Friend request denied', { from: userId, to: targetUserId, status: finalStatus });

    const updatedSenderUser = await getUserById(userId);
    const updatedRecipientUser = await getUserById(targetUserId);

    clearUserProfileCache(userId);
    clearUserProfileCache(targetUserId);

    // 📱 Emit real-time notification to sender
    notifyUserOfFriendEvent(userId, 'friend_request_denied', {
      request: buildFriendRequestPayload({
        ...request,
        requestId: `${userId}|${targetUserId}`,
        status: finalStatus,
        requestType: 'FRIEND_REQUEST_DENIED',
        isIncoming: false,
        sender: buildFriendCompleteUserProfile(updatedSenderUser),
        receiver: buildFriendCompleteUserProfile(updatedRecipientUser),
      }),
      currentUser: buildFriendCompleteUserProfile(updatedSenderUser),
      friend: buildFriendCompleteUserProfile(updatedRecipientUser),
    });

    return sendSuccess(res, {
      currentUser: buildFriendCompleteUserProfile(updatedRecipientUser),
      request: buildFriendRequestPayload({
        ...request,
        requestId: `${userId}|${targetUserId}`,
        status: finalStatus,
        requestType: 'FRIEND_REQUEST_DENIED',
        isIncoming: false,
        isOutgoing: false,
      }),
    }, 'Friend request denied');
  } catch (err) {
    Logger.error('friends/request/deny', 'Error denying friend request', err.message);
    return sendError(res, 500, 'Failed to deny friend request', { details: err.message });
  }
}));

// Cancel outgoing friend request: POST /friends/request/cancel
app.post('/friends/request/cancel', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { requestId } = req.body;
  if (!requestId) {
    return sendError(res, 400, 'requestId is required', 'VALIDATION_ERROR');
  }

  try {
    const currentUserId = req.body.userId?.toString().trim();
    const fromUserId = req.body.fromUserId?.toString().trim();
    const resolved = await resolveFriendRequestParticipants(requestId, currentUserId, fromUserId);

    if (!resolved) {
      return sendError(res, 400, 'Unable to resolve friend request participants', 'INVALID_REQUEST');
    }

    const { senderId: userId, receiverId: targetUserId } = resolved;

    await denyFriendRequest(userId, targetUserId);

    Logger.info('friends/request/cancel', '✅ Friend request cancelled', { from: userId, to: targetUserId });

    // 📱 Emit real-time notification to recipient
    notifyUserOfFriendEvent(targetUserId, 'friend_request_cancelled', {
      request: buildFriendRequestPayload({
        requestId: `${userId}|${targetUserId}`,
        status: 'cancelled',
        requestType: 'FRIEND_REQUEST_CANCELLED',
        isIncoming: false,
        sender: buildFriendCompleteUserProfile(await getUserById(userId)),
        receiver: buildFriendCompleteUserProfile(await getUserById(targetUserId)),
      }),
      currentUser: buildFriendCompleteUserProfile(await getUserById(targetUserId)),
      friend: buildFriendCompleteUserProfile(await getUserById(userId)),
    });

    return sendSuccess(res, {
      currentUser: buildFriendCompleteUserProfile(await getUserById(userId)),
      request: buildFriendRequestPayload({
        requestId: `${userId}|${targetUserId}`,
        status: 'cancelled',
        requestType: 'FRIEND_REQUEST_CANCELLED',
        isIncoming: false,
        isOutgoing: false,
      }),
    }, 'Friend request cancelled');
  } catch (err) {
    Logger.error('friends/request/cancel', 'Error cancelling friend request', err.message);
    return sendError(res, 500, 'Failed to cancel friend request', { details: err.message });
  }
}));

// Remove friend: POST /friends/remove
app.post('/friends/remove', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const currentUserId = normalizeId(req.body.userId || req.body.currentUserId);
  const friendId = normalizeId(req.body.friendId || req.body.targetUserId || req.body.recipientId || req.body.fromUserId);

  if (!currentUserId || !friendId) {
    return sendError(res, 400, 'userId and friendId are required', 'VALIDATION_ERROR');
  }

  if (!checkFriendRateLimit(currentUserId, 'removeFriend')) {
    return sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
  }

  try {
    const [currentUser, friendUser] = await Promise.all([
      getUserById(currentUserId),
      getUserById(friendId),
    ]);

    if (!currentUser || !friendUser) {
      return sendError(res, 404, 'User or friend not found', 'USER_NOT_FOUND');
    }

    const removed = await removeFriend(currentUserId, friendId);
    if (!removed) {
      return sendError(res, 404, 'Friend relationship not found', 'NOT_FRIENDS');
    }

    clearUserProfileCache(currentUserId);
    clearUserProfileCache(friendId);

    Logger.info('friends/remove', '✅ Friend removed', { userId: currentUserId, friendId });

    notifyUserOfFriendEvent(friendId, 'friend_removed', {
      userId: currentUserId,
      friend: buildFriendCompleteUserProfile(currentUser),
    });

    return sendSuccess(res, {
      removed: true,
      currentUser: buildFriendCompleteUserProfile(currentUser),
      friend: buildFriendCompleteUserProfile(friendUser),
    }, 'Friend removed successfully');
  } catch (err) {
    Logger.error('friends/remove', 'Error removing friend', err.message);
    return sendError(res, 500, 'Failed to remove friend', { details: err.message });
  }
}));

// Get friends list: GET /friends/list?userId=<userId>
app.get('/friends/list', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const userId = normalizeId(req.query.userId);
  if (!userId) {
    return sendError(res, 400, 'userId query parameter is required', 'VALIDATION_ERROR');
  }

  // 🔒 Check rate limit
  if (!checkFriendRateLimit(userId, 'listFriends')) {
    return sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
  }

  try {
    const friendIds = await listFriends(userId);
    const [currentUser, friends] = await Promise.all([
      getUserById(userId),
      getUsersByIds(friendIds),
    ]);
    const userRecords = friends.map((friend) => {
      const profile = buildCompleteUserProfile(friend);
      return {
        ...profile,
        friendId: profile.userId,
        id: profile.userId,
      };
    });

    return sendSuccess(res, {
      friends: userRecords,
      count: userRecords.length,
      currentUser: buildCompleteUserProfile(currentUser),
    }, 'Friends list retrieved');
  } catch (err) {
    Logger.error('friends/list', 'Error retrieving friends list', err.message);
    return sendError(res, 500, 'Failed to retrieve friends list', { details: err.message });
  }
}));

// Get incoming friend requests: GET /friends/requests/incoming?userId=<userId>
app.get('/friends/requests/incoming', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const userId = normalizeId(req.query.userId);
  if (!userId) {
    return sendError(res, 400, 'userId query parameter is required', 'VALIDATION_ERROR');
  }

  // 🔒 Check rate limit
  if (!checkFriendRateLimit(userId, 'listFriends')) {
    return sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
  }

  try {
    const [requests, currentUser] = await Promise.all([
      queryFriendRequestsForUser(userId, 'incoming'),
      getUserById(userId),
    ]);

    const senderProfiles = await getUsersByIds(
      requests.map((req) => req.userId).filter(Boolean),
    );

    const senderProfileMap = new Map(
      senderProfiles.map((profile) => [String(profile.userId), profile]),
    );

    const enrichedRequests = requests.map((req) => {
      const sender = senderProfileMap.get(String(req.userId));
      return buildFriendRequestPayload({
        ...req,
        sender: sender ? buildFriendCompleteUserProfile(sender) : null,
        receiver: currentUser ? buildFriendCompleteUserProfile(currentUser) : null,
      });
    });

    return sendSuccess(res, {
      requests: enrichedRequests,
      count: enrichedRequests.length,
      currentUser: currentUser ? buildFriendCompleteUserProfile(currentUser) : null,
    }, 'Incoming friend requests retrieved');
  } catch (err) {
    Logger.error('friends/requests/incoming', 'Error retrieving incoming requests', err.message);
    return sendError(res, 500, 'Failed to retrieve incoming requests', { details: err.message });
  }
}));

// Get outgoing friend requests: GET /friends/requests/outgoing?userId=<userId>
app.get('/friends/requests/outgoing', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const userId = normalizeId(req.query.userId);
  if (!userId) {
    return sendError(res, 400, 'userId query parameter is required', 'VALIDATION_ERROR');
  }

  // 🔒 Check rate limit
  if (!checkFriendRateLimit(userId, 'listFriends')) {
    return sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
  }

  try {
    const [requests, currentUser] = await Promise.all([
      queryFriendRequestsForUser(userId, 'outgoing'),
      getUserById(userId),
    ]);

    const recipientProfiles = await getUsersByIds(
      requests.map((req) => req.targetUserId || req.receiverId || req.recipientId || req.targetUserId).filter(Boolean),
    );

    const recipientProfileMap = new Map(
      recipientProfiles.map((profile) => [String(profile.userId), profile]),
    );

    const enrichedRequests = requests.map((req) => {
      const recipientId = req.targetUserId || req.receiverId || req.recipientId || req.targetUserId;
      const recipient = recipientProfileMap.get(String(recipientId));
      return buildFriendRequestPayload({
        ...req,
        recipient: recipient ? buildFriendCompleteUserProfile(recipient) : null,
        receiver: recipient ? buildFriendCompleteUserProfile(recipient) : null,
        sender: currentUser ? buildFriendCompleteUserProfile(currentUser) : null,
      });
    });

    return sendSuccess(res, {
      requests: enrichedRequests,
      count: enrichedRequests.length,
      currentUser: currentUser ? buildFriendCompleteUserProfile(currentUser) : null,
    }, 'Outgoing friend requests retrieved');
  } catch (err) {
    Logger.error('friends/requests/outgoing', 'Error retrieving outgoing requests', err.message);
    return sendError(res, 500, 'Failed to retrieve outgoing requests', { details: err.message });
  }
}));

// ========== NEW: GET NOTIFICATIONS ENDPOINT ==========
app.get('/notifications', async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const userId = normalizeId(req.query.userId || req.headers['x-user-id']);
    if (!userId) return sendError(res, 400, 'userId is required');

    let user = userCache.get(userId);
    if (!user) {
      user = await getUserById(userId);
      if (user) userCache.set(userId, user);
    }

    // Notifications are stored as an array on the USER record under `notifications`.
    const notifications = Array.isArray(user?.notifications) ? user.notifications : [];

    const combined = [...notifications];

    return sendSuccess(res, { data: combined }, 'Notifications retrieved');
  } catch (err) {
    Logger.error('notifications/get', 'Error getting notifications', err?.message || err);
    return sendError(res, 500, 'Error getting notifications', { details: err?.message || String(err) });
  }
});

// Clear all notifications for the current user
app.post('/notifications/clear', asyncHandler(async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const userId = normalizeId(req.body.userId || req.headers['x-user-id']);
  if (!userId) {
    return sendError(res, 400, 'userId is required', 'VALIDATION_ERROR');
  }

  try {
    const user = await getUserById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    await updateUserById(userId, { notifications: [] });
    if (friendNotifications.has(userId)) {
      friendNotifications.delete(userId);
    }

    Logger.info('notifications/clear', '✅ Cleared user notifications', { userId });
    return sendSuccess(res, { cleared: true }, 'Notifications cleared');
  } catch (err) {
    Logger.error('notifications/clear', 'Error clearing notifications', err?.message || err);
    return sendError(res, 500, 'Failed to clear notifications', { details: err?.message || String(err) });
  }
}));

const VALID_GENDERS = ['male', 'female', 'other'];

function sanitizeGenderInput(genderValue) {
  if (!genderValue || typeof genderValue !== 'string') {
    return null;
  }

  const normalized = String(genderValue).trim().toLowerCase();
  if (VALID_GENDERS.includes(normalized)) {
    return normalized;
  }

  if (normalized.startsWith('gender.')) {
    const candidate = normalized.substring('gender.'.length);
    if (VALID_GENDERS.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

function stripOuterQuotes(value) {
  if (value == null) return null;
  let text = String(value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      text = text.slice(1, -1).trim();
    }
  }
  return text === '' ? null : text;
}

function normalizeStringInput(value, maxLength = 0, lowerCase = false) {
  if (value == null) return null;
  const stripped = stripOuterQuotes(value);
  if (stripped == null) return null;
  const normalized = maxLength > 0 ? stripped.slice(0, maxLength) : stripped;
  return lowerCase ? normalized.toLowerCase() : normalized;
}

function normalizeInterests(value, maxItems = 20) {
  if (value == null) return null;
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  return list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeBooleanField(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

// ========== NEW: UPDATE USER PROFILE ENDPOINT ==========
app.post(['/user/:userId/update', '/users/:userId/update'], validateProfileUpdate, async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { userId } = req.params;
    const {
      userName,
      email,
      gender,
      country,
      status,
      statusNote,
      bio,
      interests,
      avatarColor,
      profileImageUrl,
      pictureName,
      birthDate,
      authType,
      isGuest,
      xp,
      lastDailyXpAwardedAt,
    } = req.body;

      const rawStatusNote = req.body.statusNote;
    const statusObject = status && typeof status === 'object' && !Array.isArray(status) ? status : null;
    const inlineStatusNote = statusObject
      ? statusObject.statusNote ?? statusObject
      : null;
    const nestedStatusNote = extractStatusNotePayload(status);
    const inlineStatusNoteObject = inlineStatusNote && !Array.isArray(inlineStatusNote) && typeof inlineStatusNote === 'object'
      ? inlineStatusNote
      : null;

    const statusMediaEntries = Array.isArray(statusObject?.statusMedia)
      ? statusObject.statusMedia
      : [];

    // ✅ NEW: Properly detect nested status array structure
    // Frontend now sends: { status: { statusNote: [array], statusMedia: [] } }
    const isNestedStatusArray = Array.isArray(inlineStatusNote);
    const nestedStatusArray = isNestedStatusArray ? inlineStatusNote : null;
    const hasStatusMedia = statusMediaEntries.length > 0;

    const hasStatusNote = (rawStatusNote && typeof rawStatusNote === 'object' && !Array.isArray(rawStatusNote) && rawStatusNote.note != null && String(rawStatusNote.note).trim().length > 0)
      || (isNestedStatusArray && nestedStatusArray.length > 0 && nestedStatusArray[0]?.note != null)
      || (inlineStatusNoteObject && inlineStatusNoteObject.note != null && String(inlineStatusNoteObject.note).trim().length > 0)
      || (nestedStatusNote && typeof nestedStatusNote === 'object' && nestedStatusNote.note != null && String(nestedStatusNote.note).trim().length > 0);
    const hasStatus = typeof status === 'string' && status.trim().length > 0
      || (isNestedStatusArray && nestedStatusArray.length > 0)
      || (inlineStatusNoteObject && inlineStatusNoteObject.note != null && String(inlineStatusNoteObject.note).trim().length > 0)
      || (nestedStatusNote && typeof nestedStatusNote === 'object' && nestedStatusNote.note != null && String(nestedStatusNote.note).trim().length > 0)
      || hasStatusMedia;
    const hasBio = typeof bio === 'string' && bio.trim().length > 0;
    const hasInterests = Array.isArray(req.body.interests);
    const hasProfileImageUrl = typeof profileImageUrl === 'string' && profileImageUrl.trim().length > 0;
    const isClearingProfileImage = typeof profileImageUrl === 'string' && profileImageUrl.trim().length === 0;

    Logger.info('user/update', 'Received profile update payload', {
      userId,
      hasGender: !!gender,
      hasCountry: !!country,
      hasImage: hasProfileImageUrl,
      isClearingImage: isClearingProfileImage,
      hasStatus,
      hasBio,
      hasInterests,
    });

    const existingUser = await getUserById(userId);
    if (!existingUser) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    Logger.debug('user/update', 'Profile update payload', {
      userId,
      payloadKeys: Object.keys(req.body),
      gender,
      country,
      hasProfileImageUrl,
    });

    const updateData = {
      updatedAt: new Date(),
    };

    const normalizedUserName = normalizeStringInput(userName);
    if (normalizedUserName) updateData.userName = normalizedUserName;

    const normalizedGender = sanitizeGenderInput(gender);
    if (normalizedGender) {
      updateData.gender = normalizedGender;
    } else if (gender != null) {
      Logger.warn('user/update', 'Invalid gender value ignored', { userId, gender });
    }

    const normalizedCountry = normalizeStringInput(country);
    if (normalizedCountry) updateData.country = normalizedCountry;

    if (hasStatusNote || hasStatus) {
      // Normalize incoming status input and append to the nested `status.statusNote` history.
      let incomingStatusNotes = [];
      let incomingStatusMedia = [];

      if (statusObject) {
        const rawStatusNoteEntries = Array.isArray(statusObject.statusNote)
          ? statusObject.statusNote
          : (statusObject.statusNote && typeof statusObject.statusNote === 'object')
              ? [statusObject.statusNote]
              : [];

        incomingStatusNotes = rawStatusNoteEntries
            .map((entry) => {
              if (typeof entry === 'string') {
                const normalizedNote = normalizeStringInput(entry, 150);
                return normalizedNote
                    ? { note: normalizedNote, color: null, createdAt: new Date().toISOString() }
                    : null;
              }

              if (entry && typeof entry === 'object') {
                const note = normalizeStringInput(entry.note, 150);
                return note
                    ? {
                        note,
                        color: entry.color ? normalizeStringInput(entry.color, 50) : null,
                        createdAt: entry.createdAt ? String(entry.createdAt).trim() : new Date().toISOString(),
                      }
                    : null;
              }

              return null;
            })
            .filter((entry) => entry != null);

        incomingStatusMedia = Array.isArray(statusObject.statusMedia)
            ? statusObject.statusMedia
            : [];
      }

      if (incomingStatusNotes.length === 0 && incomingStatusMedia.length === 0) {
        const sourceStatusNote = rawStatusNote && typeof rawStatusNote === 'object' && !Array.isArray(rawStatusNote)
          ? rawStatusNote
          : inlineStatusNoteObject || nestedStatusNote;

        const incomingNote = hasStatusNote
          ? normalizeStringInput(sourceStatusNote?.note, 150)
          : normalizeStringInput(status, 150);
        const incomingColor = hasStatusNote
          ? normalizeStringInput(sourceStatusNote?.color, 50)
          : null;

        if (incomingNote) {
          incomingStatusNotes = [{
            note: incomingNote,
            color: incomingColor || null,
            createdAt: new Date().toISOString(),
          }];
        }
      }

      const existingStatusNotes = Array.isArray(existingUser.status?.statusNote)
        ? existingUser.status.statusNote.slice()
        : [];
      const existingMedia = Array.isArray(existingUser.status?.statusMedia)
        ? existingUser.status.statusMedia.slice()
        : [];
      const mergedMedia = incomingStatusMedia.length ? incomingStatusMedia : existingMedia;
      const mergedStatusNotes = existingStatusNotes.concat(incomingStatusNotes);
      const mergedStatusPayload = {
        statusNote: mergedStatusNotes,
        statusMedia: mergedMedia,
      };

      updateData.status = mergedStatusPayload;
      updateData.statusUpdatedAt = new Date();
      updateData.updatedAt = new Date();
    }

    if (hasBio) {
      updateData.bio = normalizeStringInput(bio, 500);
    }

    if (hasInterests) {
      updateData.interests = normalizeInterests(interests, 20) || [];
    }

    if (xp && typeof xp === 'object') {
      updateData.xp = xp;
    }

    if (lastDailyXpAwardedAt) {
      try {
        const parsedXpDate = new Date(lastDailyXpAwardedAt);
        if (!Number.isNaN(parsedXpDate.getTime())) {
          updateData.lastDailyXpAwardedAt = parsedXpDate;
        }
      } catch (err) {
        Logger.warn('user/update', 'Invalid lastDailyXpAwardedAt format ignored', { lastDailyXpAwardedAt });
      }
    }

    const normalizedAvatarColor = normalizeStringInput(avatarColor);
    if (normalizedAvatarColor) {
      updateData.avatarColor = normalizedAvatarColor;
    }

    const normalizedProfileImageUrl = normalizeStringInput(profileImageUrl);
    const oldProfileImageUrl = existingUser.profileImageUrl;
    const shouldDeleteOldProfileImage = oldProfileImageUrl && (
      isClearingProfileImage ||
      (normalizedProfileImageUrl && normalizedProfileImageUrl !== oldProfileImageUrl)
    );
    const oldProfileImageIsManaged = oldProfileImageUrl && isS3Url(oldProfileImageUrl);

    if (shouldDeleteOldProfileImage && oldProfileImageIsManaged) {
      try {
        await deleteProfileImageFromS3(oldProfileImageUrl);
        Logger.info('user/update', 'Deleted previous profile image from S3', { userId, previousUrl: oldProfileImageUrl });
      } catch (deleteErr) {
        Logger.warn('user/update', 'Unable to delete previous profile image from S3', {
          userId,
          previousUrl: oldProfileImageUrl,
          error: deleteErr?.message || deleteErr,
        });
      }
    } else if (shouldDeleteOldProfileImage && oldProfileImageUrl) {
      Logger.info('user/update', 'Skipping S3 delete for non-managed profile image URL', {
        userId,
        previousUrl: oldProfileImageUrl,
      });
    }

    if (hasProfileImageUrl) {
      if (normalizedProfileImageUrl) {
        updateData.profileImageUrl = normalizedProfileImageUrl;
      }
    } else if (isClearingProfileImage) {
      updateData.profileImageUrl = null;
      updateData.profileImagePath = null;
      updateData.pictureName = null;
    }

    const normalizedPictureName = normalizeStringInput(pictureName);
    if (normalizedPictureName) updateData.pictureName = normalizedPictureName;

    const normalizedEmail = normalizeStringInput(email, 0, true);
    if (normalizedEmail) updateData.email = normalizedEmail;

    const normalizedAuthType = normalizeStringInput(authType);
    if (normalizedAuthType) updateData.authType = normalizedAuthType;
    const normalizedIsGuest = normalizeBooleanField(isGuest);
    if (normalizedIsGuest != null) updateData.isGuest = normalizedIsGuest;

    if (birthDate != null) {
      try {
        const parsed = new Date(String(birthDate));
        if (!Number.isNaN(parsed.getTime())) {
          updateData.birthDate = parsed;
        } else {
          throw new Error('Invalid date');
        }
      } catch (e) {
        Logger.warn('user/update', 'Invalid birthDate format', { birthDate });
      }
    }

    // ✅ Set profileComplete to true if both gender and country are provided
    if (normalizedGender && normalizedCountry) {
      updateData.profileComplete = true;
      Logger.info('user/update', '✅ Profile marked as complete', { userId });
    }

    const safeFields = ['email', 'userName', 'gender', 'country', 'status', 'statusNote', 'statusUpdatedAt', 'bio', 'interests', 'avatarColor', 'profileImageUrl', 'profileImagePath', 'avatarLetter', 'useColorProfile', 'pictureName', 'birthDate', 'authType', 'isGuest', 'xp', 'likedUserIds', 'friends', 'isOnline', 'isFriend', 'hasProfileChanged', 'lastDailyXpAwardedAt', 'profileComplete', 'updatedAt'];
    const safeUpdateData = {};
    for (const key of safeFields) {
      if (Object.prototype.hasOwnProperty.call(updateData, key)) {
        safeUpdateData[key] = updateData[key];
      }
    }

    const user = await updateUserById(userId, safeUpdateData);
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    // ✅ PERFORMANCE: Invalidate cache so next request gets fresh data
    userCache.invalidate(userId);

    // ✅ SYNC LIVE SOCKET METADATA: If the user is connected, refresh their live socket profile data
    try {
      const connectedSocketId = userSockets.get(userId);
      if (connectedSocketId) {
        const existingMeta = socketMetadata.get(connectedSocketId) || {};
        const shouldSyncProfileImage = Object.prototype.hasOwnProperty.call(req.body, 'profileImageUrl');

        socketMetadata.set(connectedSocketId, {
          ...existingMeta,
          userName: user.userName || existingMeta.userName,
          avatarColor: user.avatarColor || existingMeta.avatarColor,
          profileImageUrl: shouldSyncProfileImage
            ? (user.profileImageUrl || null)
            : existingMeta.profileImageUrl,
          profileImagePath: shouldSyncProfileImage
            ? (user.profileImagePath || user.profileImageUrl || null)
            : existingMeta.profileImagePath,
          country: user.country || existingMeta.country,
          gender: user.gender || existingMeta.gender,
          statusNote: user.statusNote || existingMeta.statusNote,
          status: user.status || existingMeta.status,
          bio: user.bio || existingMeta.bio,
          interests: Array.isArray(user.interests) ? user.interests : existingMeta.interests,
        });
        Logger.info('user/update', '✅ Synchronized socket metadata for updated user', { userId, socketId: connectedSocketId });
      }
    } catch (syncErr) {
      Logger.warn('user/update', 'Failed to sync socket metadata', { userId, error: syncErr && syncErr.message });
    }

    // ✅ BROADCAST: Notify connected clients of the profile change with ALL fields
    try {
      const payload = buildCompleteUserProfile(user);
      io.emit('profile_update', payload);
      io.emit('profile_updated', payload);
      io.emit('friend_profile_updated', {
        userId: payload.userId,
        id: payload.userId,
        profile: payload,
        timestamp: Date.now(),
      });
      Logger.info('user/update', '✅ Broadcast profile_update, profile_updated, and friend_profile_updated to connected clients', { userId });
    } catch (broadcastErr) {
      Logger.warn('user/update', 'Failed to broadcast profile_update or friend_profile_updated', { userId, error: broadcastErr && broadcastErr.message });
    }

    const profileCreated = (() => {
      try {
        const created = new Date(user.createdAt).getTime();
        const updated = new Date(user.updatedAt).getTime();
        return created === updated;
      } catch (e) {
        return false;
      }
    })();

    Logger.info('user/update', '✅ User profile updated or created', {
      userId,
      created: profileCreated,
    });

    return sendSuccess(res, {
      user: buildCompleteUserProfile(user),
    }, 'User profile updated successfully');
  } catch (err) {
    Logger.error('user/update', 'Error updating user', err.message);
    return sendError(res, 500, 'Error updating user', { details: err.message });
  }
});

// ========== DELETE USER ACCOUNT ENDPOINTS ==========
async function verifyDeleteCredentials(credentials = {}) {
  const normalizedEmail = credentials.email ? String(credentials.email).trim().toLowerCase() : null;
  const password = credentials.password;
  const explicitUserId = credentials.userId || credentials.id;

  if (!normalizedEmail || !password) {
    const error = new Error('Email and password are required');
    error.code = 'INVALID_CREDENTIALS';
    error.statusCode = 400;
    throw error;
  }

  let user = null;
  if (explicitUserId) {
    user = await getUserById(String(explicitUserId).trim());
  }
  if (!user && normalizedEmail) {
    user = await getUserByEmail(normalizedEmail);
  }

  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  if (!user.passwordHash) {
    const error = new Error('Invalid email or password');
    error.code = 'INVALID_CREDENTIALS';
    error.statusCode = 401;
    throw error;
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    const error = new Error('Invalid email or password');
    error.code = 'INVALID_CREDENTIALS';
    error.statusCode = 401;
    throw error;
  }

  return user;
}

async function deleteUserAccount(userId, requestContext = {}) {
  const normalizedUserId = String(userId || '').trim();

  if (!normalizedUserId) {
    const error = new Error('Invalid userId');
    error.code = 'INVALID_USER_ID';
    throw error;
  }

  Logger.info('user/delete', 'Processing account deletion request', {
    userId: normalizedUserId,
    timestamp: new Date().toISOString(),
    requestContext: requestContext && Object.keys(requestContext).length ? requestContext : undefined,
  });

  const user = await getUserById(normalizedUserId);
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  await deleteUserById(normalizedUserId);

  Logger.info('user/delete', '✅ User record deleted', { userId: normalizedUserId });

  const blockedDeleteCount = await deleteBlocksForUser(normalizedUserId);
  Logger.info('user/delete', '✅ Blocked user records cleaned up', {
    userId: normalizedUserId,
    deletedCount: blockedDeleteCount,
  });

  const reportDeleteCount = await deleteReportsForUserAndReporter(normalizedUserId);
  Logger.info('user/delete', '✅ Report records cleaned up', {
    userId: normalizedUserId,
    deletedCount: reportDeleteCount,
  });

  userCache.invalidate(normalizedUserId);
  Logger.info('user/delete', '✅ User cache invalidated', { userId: normalizedUserId });

  const userSocketId = userSockets.get(normalizedUserId);
  if (userSocketId) {
    try {
      io.to(userSocketId).emit('account_deleted_notification', {
        reason: 'Your account has been successfully deleted.',
        timestamp: Date.now(),
      });

      decomposeRoom(userSocketId, 'video');
      decomposeRoom(userSocketId, 'chat');

      const socket = io.of('/').sockets.get(userSocketId);
      if (socket) {
        socket.disconnect(true);
        Logger.info('user/delete', '✅ User socket disconnected', {
          userId: normalizedUserId,
          socketId: userSocketId,
        });
      }
    } catch (socketErr) {
      Logger.warn('user/delete', 'Error disconnecting user socket', {
        userId: normalizedUserId,
        socketId: userSocketId,
        error: socketErr && socketErr.message,
      });
    }
  }

  userSockets.delete(normalizedUserId);
  userGenderPreferences.delete(normalizedUserId);
  socketQueues.delete(userSocketId);

  Logger.info('user/delete', '✅ User account completely deleted', {
    userId: normalizedUserId,
    deletedAt: new Date().toISOString(),
    cleanupStats: {
      friendshipsCleaned: 0,
      blocksCleaned: blockedDeleteCount,
      reportsCleaned: reportDeleteCount,
    },
  });

  return {
    message: 'Account deleted successfully',
    userId: normalizedUserId,
    deletedAt: new Date().toISOString(),
  };
}

app.post('/auth/verify-account', deleteAccountLimiter, async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const user = await verifyDeleteCredentials(req.body || {});

    return sendSuccess(res, {
      exists: true,
      userId: user.userId,
      userName: user.userName,
      email: user.email,
      profileComplete: user.profileComplete || false,
    }, 'Account verified');
  } catch (err) {
    Logger.error('user/verify', 'Error verifying user account', err && err.message);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    const code = err && err.code ? err.code : 'INVALID_CREDENTIALS';
    return sendError(res, statusCode, err && err.message ? err.message : 'Error verifying user account', code);
  }
});

app.post('/auth/delete-account', deleteAccountLimiter, async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const verifiedUser = await verifyDeleteCredentials(req.body || {});
    const result = await deleteUserAccount(verifiedUser.userId, { source: 'auth/delete-account', body: req.body });
    return sendSuccess(res, result, 'User account deleted');
  } catch (err) {
    Logger.error('user/delete', 'Error deleting user account', err && err.message);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    const code = err && err.code ? err.code : 'DELETE_FAILED';
    return sendError(res, statusCode, err && err.message ? err.message : 'Error deleting user account', code);
  }
});

app.delete('/auth/account/:userId', deleteAccountLimiter, async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const result = await deleteUserAccount(req.params.userId, { source: 'auth/account/delete' });
    return sendSuccess(res, result, 'User account deleted');
  } catch (err) {
    Logger.error('user/delete', 'Error deleting user account', err && err.message);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    const code = err && err.code ? err.code : 'DELETE_FAILED';
    return sendError(res, statusCode, err && err.message ? err.message : 'Error deleting user account', code);
  }
});

app.delete('/user/:userId/delete', deleteAccountLimiter, async (req, res) => {
  if (!await isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const result = await deleteUserAccount(req.params.userId, { source: 'user/delete' });
    return sendSuccess(res, result, 'User account deleted');
  } catch (err) {
    Logger.error('user/delete', 'Error deleting user account', err && err.message);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    const code = err && err.code ? err.code : 'DELETE_FAILED';
    return sendError(res, statusCode, err && err.message ? err.message : 'Error deleting user account', code);
  }
});

// Room ID / Invite generation constants
const ROOM_CONSTS = {
  INVITE_CHARS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  INVITE_LENGTH: 6,
  ROOM_ID_CHARS: 'abcdefghijklmnopqrstuvwxyz0123456789',
  ROOM_ID_PREFIX: 'room_',
  ROOM_ID_LENGTH: 12,
  INVITE_LINK_PREFIX: 'omeglelol://join-room/',
  DEFAULT_MAX_MEMBERS: 100,
};

function generateInviteCode() {
  let code = '';
  for (let i = 0; i < ROOM_CONSTS.INVITE_LENGTH; i++) {
    code += ROOM_CONSTS.INVITE_CHARS.charAt(Math.floor(Math.random() * ROOM_CONSTS.INVITE_CHARS.length));
  }
  return code;
}

function generateRoomId() {
  let id = ROOM_CONSTS.ROOM_ID_PREFIX;
  for (let i = 0; i < ROOM_CONSTS.ROOM_ID_LENGTH; i++) {
    id += ROOM_CONSTS.ROOM_ID_CHARS.charAt(Math.floor(Math.random() * ROOM_CONSTS.ROOM_ID_CHARS.length));
  }
  return id;
}

function generateMatchId() {
  return `m_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function buildIceServers() {
  const list = Array.isArray(CONFIG.DEFAULT_ICE_SERVERS) ? [...CONFIG.DEFAULT_ICE_SERVERS] : [];
  if (CONFIG.TURN_URL && CONFIG.TURN_USERNAME && CONFIG.TURN_CREDENTIAL) {
    list.push({
      urls: CONFIG.TURN_URL,
      username: CONFIG.TURN_USERNAME,
      credential: CONFIG.TURN_CREDENTIAL,
    });
  }
  return list;
}

// In-memory rooms store: roomId -> room object
// room object fields: roomId, roomName, creatorId, creatorName, description,
// roomType ('public'|'private'), inviteCode, inviteLink, createdAt, memberIds (userIds), maxMembers, status
const rooms = new Map();

// ========== STATE MANAGEMENT ==========
const videoPairings = new Map(); // socket.id -> { peerId, userData }
const chatPairings = new Map();
const videoQueue = []; // Array of { socketId, userData, joinedAt }
const chatQueue = []; // Array of { socketId, userData, joinedAt }
const userSockets = new Map(); // userId -> socketId
const socketMetadata = new Map(); // socketId -> { userId, userName, joinedAt }
const socketQueues = new Map(); // socket.id -> 'video' | 'chat' (track which queue user is in)
const rateLimitMap = new Map(); // socketId -> { count, resetTime } for abuse prevention
// ========== FRIEND SYSTEM CACHING & NOTIFICATIONS ==========
// User profile cache to avoid repeated DB lookups
const userProfileCache = new Map(); // userId -> { profile, cachedAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Friend notification queue for users who are offline
const friendNotifications = new Map(); // userId -> [{ event, data, timestamp }]
const FRIEND_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiting configuration for friend endpoints
const FRIEND_RATE_LIMITS = {
  sendRequest: { maxRequests: 10, windowMs: 60000 }, // 10 requests per minute
  acceptRequest: { maxRequests: 20, windowMs: 60000 }, // 20 per minute
  removeFriend: { maxRequests: 10, windowMs: 60000 }, // 10 requests per minute
  listFriends: { maxRequests: 30, windowMs: 60000 }, // 30 per minute
};

// Rate limit tracking per user per endpoint
const friendRateLimitMap = new Map(); // `${userId}:${endpoint}` -> { count, resetAt }

// Helper: Get cached user profile or fetch from DB
async function getCachedUserProfile(userId) {
  if (!userId) return null;
  
  try {
    const cached = userProfileCache.get(userId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.profile;
    }
    
    const profile = await getUserById(userId);
    if (profile) {
      userProfileCache.set(userId, { profile, cachedAt: Date.now() });
    }
    return profile;
  } catch (err) {
    Logger.error('getCachedUserProfile', 'Error fetching cached profile', { userId, error: err.message });
    return null;
  }
}

// Helper: Clear user profile cache
function clearUserProfileCache(userId) {
  userProfileCache.delete(userId);
}

async function createFriendRequestAndNotify(userId, targetUserId, routeTag) {
  if (!userId || !targetUserId) {
    throw new Error('Invalid friend request participants');
  }

  if (userId === targetUserId) {
    const err = new Error('Cannot send friend request to yourself');
    err.code = 'INVALID_REQUEST';
    err.statusCode = 400;
    throw err;
  }

  if (!checkFriendRateLimit(userId, 'sendRequest')) {
    const err = new Error('Too many friend requests. Please try again later.');
    err.code = 'RATE_LIMIT_EXCEEDED';
    err.statusCode = 429;
    throw err;
  }

  const existingFriends = await listFriends(userId);
  if (existingFriends.includes(String(targetUserId))) {
    const err = new Error('Already friends with this user');
    err.code = 'ALREADY_FRIENDS';
    err.statusCode = 409;
    throw err;
  }

  const existing = await getFriendRequest(userId, targetUserId);
  if (existing && existing.status === 'pending') {
    const err = new Error('Friend request already pending');
    err.code = 'REQUEST_PENDING';
    err.statusCode = 409;
    throw err;
  }

  const senderUser = await getCachedUserProfile(userId);
  const recipientUser = await getCachedUserProfile(targetUserId);

  if (!senderUser || !recipientUser) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const request = await createFriendRequest(userId, targetUserId, {
    senderProfile: {
      userId: senderUser.userId,
      userName: senderUser.userName,
      profileImageUrl: senderUser.profileImageUrl,
    },
    recipientProfile: {
      userId: recipientUser.userId,
      userName: recipientUser.userName,
      profileImageUrl: recipientUser.profileImageUrl,
    },
  });

  Logger.info(routeTag, '✅ Friend request created', { from: userId, to: targetUserId });

  const shapedRequest = buildFriendRequestPayload(request);
  const shapedSender = buildFriendCompleteUserProfile(senderUser);
  const shapedRecipient = buildFriendCompleteUserProfile(recipientUser);

  notifyUserOfFriendEvent(targetUserId, 'friend_request_received', {
    request: buildFriendRequestPayload({
      ...request,
      sender: shapedSender,
      receiver: shapedRecipient,
    }),
    currentUser: shapedRecipient,
    friend: shapedSender,
    sender: shapedSender,
    recipient: shapedRecipient,
  });

  return {
    request: shapedRequest,
    currentUser: shapedSender,
    friend: shapedRecipient,
    sender: shapedSender,
    recipient: shapedRecipient,
  };
}

async function resolveFriendRequestParticipants(requestId, currentUserId, fromUserId) {
  if (!requestId || !currentUserId) return null;
  const normalizedRequestId = String(requestId).trim();
  const normalizedCurrentUserId = String(currentUserId).trim();
  const normalizedFromUserId = String(fromUserId || '').trim();

  if (!normalizedRequestId || !normalizedCurrentUserId) return null;

  let currentUserLookupId = normalizedCurrentUserId;
  if (normalizedFromUserId && normalizedFromUserId !== normalizedCurrentUserId) {
    currentUserLookupId = normalizedFromUserId;
  }

  if (normalizedRequestId.includes('|')) {
    const parts = normalizedRequestId
        .split('|')
        .map((part) => part.toString().trim())
        .filter((part) => part !== '');
    if (parts.length === 2) {
      return {
        senderId: parts[0],
        receiverId: parts[1],
      };
    }
  }

  const currentUser = await getUserById(currentUserLookupId);
  if (!currentUser || !Array.isArray(currentUser.friendRequests)) return null;

  const request = currentUser.friendRequests.find((item) => {
    const candidate = String(item.requestId || item.id || item._id || '').trim();
    return candidate === normalizedRequestId;
  });
  if (!request) return null;

  const senderId = String(
    request?.sender?.userId || request?.sender?.id || request?.fromUserId || request?.userId || ''
  ).trim();
  const receiverId = String(
    request?.receiver?.userId || request?.receiver?.id || request?.receiver?.recipientId || request?.receiver?.targetUserId || request?.receiver?.toUserId || request?.recipientId || request?.receiverId || request?.targetUserId || request?.toUserId || ''
  ).trim();

  const requestType = String(request?.requestType || '').toUpperCase();
  const isIncoming = requestType.includes('INCOMING') || request?.isIncoming === true;
  const isOutgoing = requestType.includes('OUTGOING') || request?.isOutgoing === true;

  if (senderId && receiverId) {
    return { senderId, receiverId };
  }
  if (isIncoming) {
    return {
      senderId: senderId !== '' ? senderId : normalizedCurrentUserId,
      receiverId: normalizedCurrentUserId,
    };
  }
  if (isOutgoing) {
    return {
      senderId: normalizedCurrentUserId,
      receiverId: receiverId !== '' ? receiverId : normalizedCurrentUserId,
    };
  }

  if (senderId && !receiverId) {
    return { senderId, receiverId: normalizedCurrentUserId };
  }
  if (receiverId && !senderId) {
    return { senderId: normalizedCurrentUserId, receiverId };
  }

  return null;
}

// Helper: Emit real-time friend event to user if they're online
function notifyUserOfFriendEvent(userId, eventName, data) {
  try {
    const socketId = userSockets.get(userId);
    if (socketId && io.sockets.sockets.has(socketId)) {
      io.to(socketId).emit(eventName, data);
      Logger.debug('friend_event', `✅ Emitted ${eventName} to user ${userId}`, { socketId });
    } else {
      // Queue notification for offline users
      if (!friendNotifications.has(userId)) {
        friendNotifications.set(userId, []);
      }
      const notifications = friendNotifications.get(userId);
      notifications.push({ event: eventName, data, timestamp: Date.now() });
      Logger.debug('friend_event', `📝 Queued ${eventName} for offline user ${userId}`);
    }
  } catch (err) {
    Logger.error('notifyUserOfFriendEvent', 'Error notifying user', { userId, eventName, error: err.message });
  }
}

// Helper: Check and enforce friend rate limits
function checkFriendRateLimit(userId, endpoint) {
  const key = `${userId}:${endpoint}`;
  const limit = FRIEND_RATE_LIMITS[endpoint];
  if (!limit) return true; // No limit configured
  
  const record = friendRateLimitMap.get(key);
  const now = Date.now();
  
  if (!record || now > record.resetAt) {
    // New window
    friendRateLimitMap.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }
  
  if (record.count < limit.maxRequests) {
    record.count++;
    return true;
  }
  
  return false;
}

// Periodic cleanup for friend notifications and rate limits
function startFriendSystemCleanup() {
  return setInterval(() => {
    try {
      const now = Date.now();
      let notifRemoved = 0;
      let rateLimitRemoved = 0;
      
      // Clean expired friend notifications
      for (const [userId, notifications] of friendNotifications.entries()) {
        const filtered = notifications.filter(n => now - n.timestamp <= FRIEND_NOTIFICATION_TTL_MS);
        notifRemoved += (notifications.length - filtered.length);
        if (filtered.length > 0) {
          friendNotifications.set(userId, filtered);
        } else {
          friendNotifications.delete(userId);
        }
      }
      
      // Clean expired rate limit records
      for (const [key, record] of friendRateLimitMap.entries()) {
        if (now > record.resetAt) {
          friendRateLimitMap.delete(key);
          rateLimitRemoved++;
        }
      }
      
      // Clean user profile cache
      for (const [userId, cached] of userProfileCache.entries()) {
        if (now - cached.cachedAt > CACHE_TTL_MS) {
          userProfileCache.delete(userId);
        }
      }
      
      if (notifRemoved > 0 || rateLimitRemoved > 0) {
        Logger.debug('friend_cleanup', 'Friend system cleanup completed', { 
          notificationsRemoved: notifRemoved, 
          rateLimitsRemoved: rateLimitRemoved 
        });
      }
    } catch (e) {
      Logger.warn('friend_cleanup', 'Error during friend system cleanup', { error: e?.message });
    }
  }, 10 * 60 * 1000); // run every 10 minutes
}

function startSocketRateLimitCleanup() {
  return setInterval(() => {
    try {
      const now = Date.now();
      let removedCount = 0;
      for (const [socketId, record] of rateLimitMap.entries()) {
        if (!record || now > record.resetTime + RATE_LIMIT_CONFIG.checkIntervalMs * 2) {
          rateLimitMap.delete(socketId);
          removedCount++;
        }
      }
      if (removedCount > 0) {
        Logger.debug('rateLimit', 'Cleaned stale socket rate limit records', { removedCount });
      }
    } catch (e) {
      Logger.warn('rateLimit', 'Error during socket rate limit cleanup', { err: e && e.message });
    }
  }, 5 * 60 * 1000); // run every 5 minutes
}

// Background cleanup intervals are started inside startServer() so tests can require this module
// without creating nonstop timers.
// Star gifting state: counts per room or match and one-time gift tracking
const starCounts = new Map(); // key -> number (roomId or matchId)
const oneTimeGifts = new Set(); // `${socketId}:${key}` to prevent duplicate gifts

// ========== REPORTING & BLOCKING SYSTEM ==========
const REPORT_CONFIG = {
  reportWindowMs: 24 * 60 * 60 * 1000,    // 24 hours
  
  // Progressive blocking (matching frontend implementation)
  blockDuration_1report_Ms: 10 * 60 * 1000,      // 10 minutes
  blockDuration_3reports_Ms: 3 * 60 * 60 * 1000, // 3 hours
  blockDuration_5reports_Ms: 24 * 60 * 60 * 1000, // 1 day (24 hours)
};

// ========== GENDER FILTER SYSTEM ==========
const userGenderPreferences = new Map(); // userId -> 'male'|'female'|'other'|'all'


// Check if a user is currently blocked
async function isUserBlocked(userId) {
  try {
    const block = await getActiveBlock(userId);
    return !!block;
  } catch (err) {
    Logger.error('isUserBlocked', 'Error checking block status', err.message);
    return false;
  }
}

// Record a report and apply progressive blocking
async function recordReport(reportedUserId, reporterId, reason = 'User reported') {
  try {
    Logger.info('recordReport', 'Processing report', { reportedUserId, reporterId });

    if (!reportedUserId || !reporterId) {
      Logger.warn('recordReport', 'Invalid inputs', { reportedUserId, reporterId });
      return false;
    }

    // Check if this reporter already reported this user in last 24 hours
    const existingReport = await getReport(reportedUserId, reporterId);
    if (existingReport) {
      Logger.warn('recordReport', 'Duplicate report from same reporter within 24 hours', {
        reportedUserId,
        reporterId,
      });
      return false;
    }

    await createReport(reportedUserId, reporterId, reason);

    // Count recent unique reports in the last window
    const reports = await getReportsForUser(reportedUserId);
    const cutoff = new Date(Date.now() - REPORT_CONFIG.reportWindowMs).toISOString();
    const recentReports = reports
      .filter((report) => report.createdAt && report.createdAt >= cutoff)
      .map((report) => report.reporterId);
    const uniqueReporters = Array.from(new Set(recentReports));
    const reportCount = uniqueReporters.length;

    Logger.info('recordReport', 'Recent report count', { reportedUserId, count: reportCount });

    let blockDuration = null;
    let blockReason = '';

    if (reportCount >= 5) {
      blockDuration = REPORT_CONFIG.blockDuration_5reports_Ms;
      blockReason = '5+ reports - 24 hour block';
    } else if (reportCount >= 3) {
      blockDuration = REPORT_CONFIG.blockDuration_3reports_Ms;
      blockReason = '3+ reports - 3 hour block';
    } else if (reportCount >= 1) {
      blockDuration = REPORT_CONFIG.blockDuration_1report_Ms;
      blockReason = '1+ reports - 10 minute block';
    }

    if (blockDuration) {
      const blockedUntil = new Date(Date.now() + blockDuration);
      await putBlockedUser({
        userId: reportedUserId,
        blockedByUserId: reporterId,
        reason: blockReason,
        blockType: 'report',
        blockDuration,
        blockedUntil,
        reportCount,
        reporters: uniqueReporters,
      });

      Logger.warn('recordReport', `User blocked: ${blockReason}`, {
        reportedUserId,
        reporterId,
        reportCount,
      });
    }

    return true;
  } catch (err) {
    Logger.error('recordReport', 'Error recording report', err.message);
    return false;
  }
}

// ========== RATE LIMITING ==========
const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 30,
  checkIntervalMs: 60000, // 1 minute
};

function checkRateLimit(socketId) {
  const now = Date.now();
  const limit = rateLimitMap.get(socketId);
  
  if (!limit || now > limit.resetTime) {
    rateLimitMap.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_CONFIG.checkIntervalMs });
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
    return false;
  }
  
  limit.count++;
  return true;
}

// ========== VALIDATION & UTILITIES ==========
function isValidSocketId(socketId) {
  return typeof socketId === 'string' && socketId.length > 0;
}

// ✅ Helper function to sanitize nested reply chains (reply to a reply)
function _sanitizeNestedReply(replyData) {
  if (!replyData || typeof replyData !== 'object') return null;
  
  const replyUserName = (replyData.userName || replyData.senderName || '').trim();
  const finalReplyUserName = replyUserName || replyData.userId || 'Unknown User';
  
  const sanitized = {
    messageId: replyData.messageId || null,
    userName: finalReplyUserName.substring(0, 50),
    message: replyData.message || null,
    timestamp: replyData.timestamp || null,
    mediaUrl: replyData.mediaUrl || replyData.media || replyData.media_url || null,
    mediaType: replyData.mediaType || null,
    senderProfileImagePath: replyData.senderProfileImagePath || replyData.profileImagePath || replyData.profile_image_path || null,
    avatarColor: replyData.avatarColor || '#128C7E',
    avatarLetter: ((replyData.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
  };
  
  // ✅ Recursively handle deeper nested replies
  if (replyData.replyTo && typeof replyData.replyTo === 'object') {
    sanitized.replyTo = _sanitizeNestedReply(replyData.replyTo);
  }
  
  return sanitized;
}

// ========== ROOM MANAGEMENT ==========

function decomposeRoom(socketId, roomType = 'video') {
  if (!isValidSocketId(socketId)) {
    Logger.warn('decomposeRoom', 'Invalid socketId provided');
    return;
  }

  const pairings = roomType === 'video' ? videoPairings : chatPairings;
  const queue = roomType === 'video' ? videoQueue : chatQueue;

  Logger.info('decomposeRoom', `Decomposing ${roomType} room`, { socketId });

  try {
    if (pairings.has(socketId)) {
      const pairing = pairings.get(socketId);
      const peerId = pairing.peerId;

      if (!isValidSocketId(peerId)) {
        Logger.warn('decomposeRoom', 'Invalid peerId in pairing', { socketId, peerId });
        return;
      }

      // Notify peer
      io.to(peerId).emit('partner_left', {
        reason: 'partner_left',
        timestamp: Date.now(),
      });

      // Remove both sides
      pairings.delete(socketId);
      pairings.delete(peerId);
      socketQueues.delete(peerId);

      // Requeue peer
      queue.push({
        socketId: peerId,
        userData: socketMetadata.get(peerId) || {},
        joinedAt: Date.now(),
      });
      socketQueues.set(peerId, roomType);

      Logger.info('decomposeRoom', `Peer requeued`, { peerId, queueSize: queue.length });
    } else {
      // Remove from queue if present
      const queueIndex = queue.findIndex((item) => item.socketId === socketId);
      if (queueIndex !== -1) {
        queue.splice(queueIndex, 1);
        socketQueues.delete(socketId);
        Logger.info('decomposeRoom', `Removed from queue`, { socketId, queueSize: queue.length });
      }
    }
  } catch (error) {
    Logger.error('decomposeRoom', 'Error during room decomposition', error.message);
  }
}

async function getFreshUserProfile(userId) {
  try {
    if (!userId) return null;

    const user = await getUserById(userId);

    if (user) {
      Logger.debug('getFreshUserProfile', 'Fetched fresh user profile', { userId, hasProfileImageUrl: !!user.profileImageUrl });
    } else {
      Logger.warn('getFreshUserProfile', 'User not found in DynamoDB', { userId });
    }

    return user;
  } catch (error) {
    Logger.error('getFreshUserProfile', 'Error fetching fresh profile', { userId, error: error.message });
    return null;
  }
}

async function attemptMatch(roomType = 'video') {
  try {
    const pairings = roomType === 'video' ? videoPairings : chatPairings;
    const queue = roomType === 'video' ? videoQueue : chatQueue;

    Logger.info('attemptMatch', `Checking queue for ${roomType} pairing`, {
      queueSize: queue.length,
      currentPairings: pairings.size,
    });

    if (queue.length < 2) {
      Logger.warn('attemptMatch', `Not enough users in ${roomType} queue to match`, {
        needed: 2,
        available: queue.length,
      });
      return false;
    }

    // Pop first valid user from the head of the queue
    let user1 = null;
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (isValidSocketId(candidate?.socketId)) {
        user1 = candidate;
        break;
      }
      Logger.warn('attemptMatch', 'Skipping invalid socket in queue', { socketId: candidate?.socketId });
    }
    if (!user1) {
      Logger.warn('attemptMatch', 'No valid user found at head of queue');
      return false;
    }

    // Find a partner later in the queue to avoid shifting twice; splice out the partner when found
    const partnerIndex = queue.findIndex(item => isValidSocketId(item?.socketId) && item.socketId !== user1.socketId);
    if (partnerIndex === -1) {
      // No suitable partner currently - requeue user1 to the end
      queue.push(user1);
      return false;
    }
    const user2 = queue.splice(partnerIndex, 1)[0];
    
    // ✅ CRITICAL FIX: AWAIT async blocking check instead of fire-and-forget
    const user1Blocked = user1.userData && user1.userData.userId && (await isUserBlocked(user1.userData.userId));
    const user2Blocked = user2.userData && user2.userData.userId && (await isUserBlocked(user2.userData.userId));
    
    if (user1Blocked) {
      Logger.warn('attemptMatch', 'User1 is blocked, requeuing User2', { user1Id: user1.socketId, user2Id: user2.socketId });
      queue.push(user2);
      return false;
    }
    
    if (user2Blocked) {
      Logger.warn('attemptMatch', 'User2 is blocked, requeuing User1', { user1Id: user1.socketId, user2Id: user2.socketId });
      queue.push(user1);
      return false;
    }

    // ✅ CRITICAL: Prevent self-pairing (same socket matched with itself)
    if (user1.socketId === user2.socketId) {
      Logger.warn('attemptMatch', 'Attempted self-pairing, requeuing both', {
        socketId: user1.socketId,
        roomType,
      });
      // Requeue both to end of queue to avoid immediate re-matching
      queue.push(user1);
      queue.push(user2);
      return false;
    }

    Logger.info('attemptMatch', `Matched ${roomType} pair`, {
      user1Id: user1.socketId,
      user1Name: user1.userData?.userName,
      user1DataValid: user1.userData ? 'YES' : 'NULL',
      user2Id: user2.socketId,
      user2Name: user2.userData?.userName,
      user2DataValid: user2.userData ? 'YES' : 'NULL',
    });

    // ✅ DEFENSIVE: Ensure userData is always valid (fallback if not)
    const ensureUserData = (userData, socketId) => {
      if (!userData) {
        Logger.warn('attemptMatch', 'userData missing, creating fallback', { socketId });
        return {
          userId: `user_${socketId.substring(0, 8)}`,
          userName: `User_${socketId.substring(0, 8)}`,
          avatarColor: '#128C7E',
          avatarLetter: 'U',
          profileImagePath: null,
        };
      }
      return userData;
    };

    const user1DataValid = ensureUserData(user1.userData, user1.socketId);
    const user2DataValid = ensureUserData(user2.userData, user2.socketId);

    // ✅ NEW: Fetch fresh profiles from DynamoDB to get latest profileImageUrl
    // This ensures profile images are always current, not stale socket-register data
    const user1FreshProfile = user1DataValid.userId ? await getFreshUserProfile(user1DataValid.userId) : null;
    const user2FreshProfile = user2DataValid.userId ? await getFreshUserProfile(user2DataValid.userId) : null;
    
    // Merge fresh profile data with socket metadata
    // Fresh profile takes priority for profileImageUrl, but keep other socket data as fallback
    if (user1FreshProfile) {
      user1DataValid.profileImageUrl = user1FreshProfile.profileImageUrl || user1DataValid.profileImageUrl;
      user1DataValid.userName = user1FreshProfile.userName || user1DataValid.userName;
      user1DataValid.avatarColor = user1FreshProfile.avatarColor || user1DataValid.avatarColor;
      user1DataValid.gender = user1FreshProfile.gender || user1DataValid.gender;
      user1DataValid.country = user1FreshProfile.country || user1DataValid.country;
    }
    if (user2FreshProfile) {
      user2DataValid.profileImageUrl = user2FreshProfile.profileImageUrl || user2DataValid.profileImageUrl;
      user2DataValid.userName = user2FreshProfile.userName || user2DataValid.userName;
      user2DataValid.avatarColor = user2FreshProfile.avatarColor || user2DataValid.avatarColor;
      user2DataValid.gender = user2FreshProfile.gender || user2DataValid.gender;
      user2DataValid.country = user2FreshProfile.country || user2DataValid.country;
    }
    Logger.info('attemptMatch', 'Merged fresh profiles from DynamoDB', {
      user1: { id: user1DataValid.userId, hasProfileImageUrl: !!user1DataValid.profileImageUrl },
      user2: { id: user2DataValid.userId, hasProfileImageUrl: !!user2DataValid.profileImageUrl },
    });

    // ✅ NEW: Check gender compatibility AFTER data validation
    const user1Gender = userGenderPreferences.get(user1DataValid.userId) || 'all';
    const user2Gender = userGenderPreferences.get(user2DataValid.userId) || 'all';
    const user1UserGender = user1DataValid.gender || 'other';
    const user2UserGender = user2DataValid.gender || 'other';

    Logger.info('attemptMatch', 'Gender compatibility check', {
      user1Id: user1.socketId,
      user1PreferredGender: user1Gender,
      user1ActualGender: user1UserGender,
      user2Id: user2.socketId,
      user2PreferredGender: user2Gender,
      user2ActualGender: user2UserGender,
    });

    // ✅ IMPROVED: If EITHER user selected "All", they're open to everyone → MATCH
    // Otherwise, check mutual compatibility:
    // - User1's preference must match User2's actual gender
    // - User2's preference must match User1's actual gender
    
    const user1HasAllFilter = user1Gender === 'all';
    const user2HasAllFilter = user2Gender === 'all';

    // If either has "All" selected, they match (open to everyone)
    if (!user1HasAllFilter && !user2HasAllFilter) {
      // Both have specific preferences - check mutual compatibility
      if (user1Gender !== user2UserGender) {
        Logger.warn('attemptMatch', 'Gender mismatch - user1 preference incompatible', {
          user1Gender: user1Gender,
          user2ActualGender: user2UserGender,
          action: 'requeue_user2',
        });
        queue.push(user2);
        return false;
      }

      if (user2Gender !== user1UserGender) {
        Logger.warn('attemptMatch', 'Gender mismatch - user2 preference incompatible', {
          user2Gender: user2Gender,
          user1ActualGender: user1UserGender,
          action: 'requeue_user1',
        });
        queue.push(user1);
        return false;
      }
    }

    Logger.info('attemptMatch', 'Gender compatibility passed - proceeding with match', {
      user1: user1DataValid.userId,
      user2: user2DataValid.userId,
    });

    // Normalize outgoing partner data for the matching event using canonical frontend-compatible profile.
    const normalizeOutgoingUser = (ud) => buildCompleteUserProfile(ud);
    const user1Out = normalizeOutgoingUser(user1DataValid);
    const user2Out = normalizeOutgoingUser(user2DataValid);

    // Create pairing with validated (normalized) user data
    const matchId = generateMatchId();
    pairings.set(user1.socketId, {
      peerId: user2.socketId,
      userData: user2Out,
      matchId,
    });
    pairings.set(user2.socketId, {
      peerId: user1.socketId,
      userData: user1Out,
      matchId,
    });
    socketQueues.delete(user1.socketId);
    socketQueues.delete(user2.socketId);

    // Notify both users - send matched event with peers array
    const iceServers = buildIceServers();
    const matchedData1 = {
      peers: [user1.socketId, user2.socketId],
      peerId: user2.socketId,
      initiator: true,
      remoteUser: user2Out,
      matchId,
      iceServers,
      mediaConstraints: CONFIG.MEDIA_CONSTRAINTS,
      matchedAt: Date.now(),
    };
    const matchedData2 = {
      peers: [user1.socketId, user2.socketId],
      peerId: user1.socketId,
      initiator: false,
      remoteUser: user1Out,
      matchId,
      iceServers,
      mediaConstraints: CONFIG.MEDIA_CONSTRAINTS,
      matchedAt: Date.now(),
    };

    Logger.info('attemptMatch', `Matched ${roomType} pair, storing in ${roomType === 'video' ? 'videoPairings' : 'chatPairings'}`, {
      user1: { socketId: user1.socketId, userName: user1.userData?.userName },
      user2: { socketId: user2.socketId, userName: user2.userData?.userName },
      pairingsSize: pairings.size,
    });

    Logger.info('attemptMatch', 'Sending matched events to both peers', {
      user1: user1.socketId,
      user2: user2.socketId,
      roomType,
    });

    io.to(user1.socketId).emit('matched', matchedData1);
    io.to(user2.socketId).emit('matched', matchedData2);

    Logger.info('attemptMatch', `Successfully matched and notified ${roomType} pair, verifying pairings...`, {
      user1InPairings: pairings.has(user1.socketId),
      user2InPairings: pairings.has(user2.socketId),
      pairingForUser1: pairings.get(user1.socketId) ? 'exists' : 'missing',
      pairingForUser2: pairings.get(user2.socketId) ? 'exists' : 'missing',
    });

    // ✅ NEW: Send connection_ready event after both users are matched 
    // This ensures client waits for server confirmation before showing animation
    setImmediate(() => {
      try {
        // connection_ready is advisory; use volatile to avoid buffering if client is slow
        io.volatile.to(user1.socketId).emit('connection_ready', {
          matchId,
          peerId: user2.socketId,
          readyAt: Date.now(),
        });
        io.volatile.to(user2.socketId).emit('connection_ready', {
          matchId,
          peerId: user1.socketId,
          readyAt: Date.now(),
        });
        Logger.info('attemptMatch', 'connection_ready events sent to both peers', {
          user1: user1.socketId,
          user2: user2.socketId,
        });
      } catch (err) {
        Logger.error('attemptMatch', 'Error sending connection_ready', err.message);
      }
    });

    return true;
  } catch (error) {
    Logger.error('attemptMatch', 'Error during matching', error.message);

    return false;
  }
}

function broadcastStats() {
  try {
    const stats = {
      videoQueueSize: videoQueue.length,
      chatQueueSize: chatQueue.length,
      videoPairings: videoPairings.size,
      chatPairings: chatPairings.size,
      totalPairings: videoPairings.size + chatPairings.size,
      totalOnline: socketMetadata.size,
    };

    // Use volatile emits for high-frequency/non-critical telemetry to avoid building up server-side buffers
    io.volatile.emit('stats', stats);
    io.volatile.emit('online_count', stats.totalOnline);
  } catch (error) {
    Logger.error('broadcastStats', 'Error broadcasting stats', error.message);
  }
}

// ========== GROUP CHAT ROOMS ==========
const groupChatRooms = new Map(); // roomName -> Set of socketIds
const messageIdCache = new Map(); // groupName -> { ids: Set, timestamp }
const MESSAGE_CACHE_TIMEOUT = 30000; // 30 seconds

function getSafeAvatarLetter(userName, fallback = 'U') {
  const trimmed = typeof userName === 'string' ? userName.trim() : '';
  if (!trimmed) return fallback;
  return trimmed.charAt(0).toUpperCase();
}

function cleanupSocketUserState(userId, socketId) {
  const normalizedUserId = normalizeId(userId);
  if (normalizedUserId) {
    userSockets.delete(normalizedUserId);
    userGenderPreferences.delete(normalizedUserId);
    userToSpaceMap.delete(normalizedUserId);
    pendingVoiceSpaceDisconnects.delete(normalizedUserId);
  }
  if (socketId) {
    socketMetadata.delete(socketId);
    socketQueues.delete(socketId);
  }
}

// ========== SOCKET.IO CONNECTION HANDLER ==========
io.on('connection', (socket) => {
  Logger.info('connection', '🟢 Client connected', { socketId: socket.id });
  health.updateSocketConnections(io.of('/').sockets.size);

  // Try to disable Nagle (TCP_NODELAY) to reduce buffering/delays on slow networks
  try {
    const transportSocket = socket.conn && socket.conn.transport && socket.conn.transport.socket;
    if (transportSocket && typeof transportSocket.setNoDelay === 'function') {
      transportSocket.setNoDelay(true);
      Logger.info('connection', '✅ TCP_NODELAY (setNoDelay) enabled on socket', { socketId: socket.id });
    }
  } catch (err) {
    Logger.warn('connection', 'Could not set TCP_NODELAY on socket', { socketId: socket.id, error: err && err.message });
  }

  // ✅ NEW: Add error handler to catch transport errors early
  socket.on('error', (error) => {
    Logger.error('socket_error', '❌ Socket error event', {
      socketId: socket.id,
      error: error?.message || String(error),
      code: error?.code,
    });
  });

  socket.emit('SignallingClient', socket.id);

  // Preserve handshake userId so home-screen socket connections can still receive notifications
  const handshakeUserId = socket.handshake?.query?.userId;
  if (handshakeUserId) {
    socket.data = socket.data || {};
    const hId = normalizeId(handshakeUserId);
    socket.data.userId = hId;
    userSockets.set(hId, socket.id);
    socketMetadata.set(socket.id, {
      userId: hId,
      joinedAt: Date.now(),
    });
  }

  // User registration - MINIMAL data only for socket identification
  socket.on('register_user', (userData, callback) => {
    try {
      // ✅ NEW: Log incoming user data size for diagnostics
      const incomingDataSize = JSON.stringify(userData).length;
      Logger.info('register_user', `📥 Received user data (${Math.round(incomingDataSize / 1024)}KB)`, {
        socketId: socket.id,
        dataSizeBytes: incomingDataSize,
        hasProfileImage: userData?.profileImagePath ? 'yes' : 'no',
        profileImageSizeKB: userData?.profileImagePath ? Math.round(userData.profileImagePath.length / 1024) : 0,
      });

      const validation = validateUserData(userData);

      if (!validation.valid) {
        Logger.warn('register_user', `❌ Validation failed: ${validation.error}`, { socketId: socket.id });
        const errorResponse = {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: validation.error,
          },
        };
        socket.emit('error', errorResponse);
        if (typeof callback === 'function') callback(errorResponse);
        return;
      }

      // Extract profile image from multiple possible keys
      const profileImageCandidates = [
        'profileImagePath',
        'profile_image_path',
        'profileImage',
        'profile_pic',
        'photo',
        'avatarUrl',
        'img',
      ];
      let profileImagePath = null;
      for (const k of profileImageCandidates) {
        if (userData[k]) {
          profileImagePath = userData[k];
          break;
        }
      }

      // ✅ CRITICAL: Validate image size (prevent "transport error" / "transport close")
      const MAX_IMAGE_SIZE = 100 * 1024; // 100KB limit for real-time socket emission
      if (profileImagePath && typeof profileImagePath === 'string') {
        const imageSizeBytes = profileImagePath.length; // Base64 string length approximates byte size
        if (imageSizeBytes > MAX_IMAGE_SIZE) {
          Logger.warn('register_user', `⚠️ Image too large (${Math.round(imageSizeBytes / 1024)}KB) - discarding to prevent transport error`, {
            socketId: socket.id,
            userId: userData.userId,
            imageSizeKB: Math.round(imageSizeBytes / 1024),
            maxSizeKB: Math.round(MAX_IMAGE_SIZE / 1024),
          });
          // Discard large image to prevent 'transport error' / 'transport close'
          profileImagePath = null;
        }
      }

      // Store MINIMAL socket metadata (only what's needed for real-time features)
      const normalizedUserId = normalizeId(userData.userId);
      socketMetadata.set(socket.id, {
        userId: normalizedUserId,
        userName: userData.userName,
        avatarColor: userData.avatarColor || '#128C7E',
        avatarLetter: userData.avatarLetter || getSafeAvatarLetter(userData.userName),
        profileImagePath: profileImagePath || null,
        joinedAt: Date.now(),
        // NOTE: Email, authType, isGuest are stored LOCALLY on phone
        // Backend only keeps what's needed for video/chat identification
      });

      socket.data = socket.data || {};
      socket.data.userId = normalizedUserId;
      socket.data.userName = userData.userName;
      userSockets.set(normalizedUserId, socket.id);

      // Simple logging - no sensitive data stored
      Logger.info('register_user', '✅ User registered', {
        socketId: socket.id,
        userId: userData.userId,
        userName: userData.userName,
        hasProfileImage: profileImagePath !== null,
        imageSizeKB: profileImagePath ? Math.round(profileImagePath.length / 1024) : 0,
      });

      broadcastStats();
      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (error) {
      Logger.error('register_user', 'Error registering user', error.message);
      socket.emit('error', { message: 'Registration failed' });
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Registration failed' });
      }
    }
  });

  socket.on('_room_reconnected', (data, callback) => {
    try {
      const userId = normalizeId(
        data?.userId || socket.data?.userId || socket.handshake?.query?.userId,
      );
      if (!userId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Missing userId' });
        }
        return;
      }

      const prevSocketId = userSockets.get(userId);
      if (prevSocketId && prevSocketId !== socket.id) {
        socketMetadata.delete(prevSocketId);
      }

      cancelVoiceSpaceDisconnectCleanup(userId);

      const existingMeta = socketMetadata.get(socket.id) || {};
      socketMetadata.set(socket.id, {
        ...existingMeta,
        userId,
        reconnectedAt: Date.now(),
      });
      userSockets.set(userId, socket.id);
      socket.data = socket.data || {};
      socket.data.userId = userId;

      const pendingSpaceId = userToSpaceMap.get(userId);
      if (pendingSpaceId) {
        const pendingSpace = activeVoiceSpaces.get(pendingSpaceId);
        if (pendingSpace && pendingSpace.participants.some((p) => String(p.userId) === String(userId))) {
          socket.join(`space:${pendingSpaceId}`);
          Logger.info('_room_reconnected', 'Auto-joined socket back into voice space on reconnect', {
            userId,
            socketId: socket.id,
            spaceId: pendingSpaceId,
          });
        }
      }

      Logger.info('_room_reconnected', 'Socket reconnected and re-registered', {
        userId,
        socketId: socket.id,
        previousSocketId: prevSocketId,
      });

      broadcastStats();
      if (typeof callback === 'function') {
        callback({ success: true, userId });
      }
    } catch (err) {
      Logger.error('_room_reconnected', 'Error handling reconnect', err.message);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Reconnect failed' });
      }
    }
  });

  socket.on('set_user_online_status', (data, callback) => {
    try {
      const userId = normalizeId(data?.userId || socket.data?.userId || socket.handshake?.query?.userId);
      if (!userId) {
        const error = { success: false, error: 'Missing userId' };
        if (typeof callback === 'function') callback(error);
        return;
      }

      const isOnline = data?.isOnline === true;
      const statusPayload = {
        userId,
        userName: data?.userName || socket.data?.userName || null,
        isOnline,
        timestamp: new Date().toISOString(),
      };

      Logger.info('set_user_online_status', 'Received online status update', {
        socketId: socket.id,
        userId,
        isOnline,
      });

      // Maintain an in-memory online users set for quick presence checks
      if (!global.onlineUsers) global.onlineUsers = new Set();
      try {
        if (isOnline) {
          global.onlineUsers.add(userId);
          // also map userSockets if not already set
          if (!userSockets.get(userId)) userSockets.set(userId, socket.id);
        } else {
          global.onlineUsers.delete(userId);
        }
      } catch (e) {
        Logger.warn('presence', 'Failed to update onlineUsers set', { userId, error: e && e.message });
      }

      // Emit presence update to the user's friends only (reduce noise)
      (async () => {
        try {
          const friendsList = await listFriends(userId).catch(() => null) || [];
          const friendIds = (Array.isArray(friendsList) ? friendsList : []).map(f => (f.userId || f.id || f.friendId || '').toString()).filter(Boolean);
          // Notify each friend individually (queues if offline)
          for (const fid of friendIds) {
            notifyUserOfFriendEvent(fid, 'friend_status_update', {
              userId,
              friendId: userId,
              isOnline,
              userName: statusPayload.userName,
              timestamp: statusPayload.timestamp,
            });
          }
        } catch (e) {
          Logger.warn('presence', 'Error notifying friends of presence change', { userId, error: e && e.message });
        }
      })();

      // Also emit user_online_status globally for compatibility with older clients
      io.emit('user_online_status', statusPayload);
      if (typeof callback === 'function') callback({ success: true, status: statusPayload });
    } catch (err) {
      Logger.error('set_user_online_status', 'Error handling online status update', err.message);
      if (typeof callback === 'function') callback({ success: false, error: 'Failed to update online status' });
    }
  });

  // Update user status (mic/camera) and notify room members
  socket.on('update_user_status', (data, callback) => {
    try {
      Logger.info('update_user_status', 'Received status update', { socketId: socket.id, data });
      const meta = socketMetadata.get(socket.id) || {};
      const userId = meta.userId;
      if (!userId) {
        if (callback) callback({ success: false, error: 'User not registered' });
        return;
      }

      const micOn = data && typeof data.micOn === 'boolean' ? data.micOn : true;
      const cameraOn = data && typeof data.cameraOn === 'boolean' ? data.cameraOn : true;

      // Persist status on socket metadata
      meta.status = { micOn, cameraOn };
      socketMetadata.set(socket.id, meta);

      // Find rooms where this user is present and notify members (including sender)
      for (const room of rooms.values()) {
        if (room.memberIds && room.memberIds.includes(userId) && room.status === 'active') {
          for (const memberId of room.memberIds) {
            const memberSocketId = userSockets.get(memberId);
              if (memberSocketId) {
              // Use volatile emit for status updates to avoid buffering on slow clients
              io.volatile.to(memberSocketId).emit('room_member_updated', {
                roomId: room.roomId,
                userId,
                status: { micOn, cameraOn },
              });
            }
          }
        }
      }

      if (callback) callback({ success: true });
    } catch (err) {
      Logger.error('update_user_status', 'Error updating user status', err && err.message);
      if (callback) callback({ success: false, error: 'Failed to update status' });
    }
  });

  // ========== GROUP ROOM EVENTS ==========
  // Create a new room (public/private)
  socket.on('create_room', (data, callback) => {
    try {
      let meta = socketMetadata.get(socket.id);
      // If socket not registered, allow auto-registration when client provides user info
      if (!meta) {
        const userPayload = data && (data.user || data.userId || data.userName) ? (data.user || {
          userId: data.userId,
          userName: data.userName,
          avatarColor: data.avatarColor,
          avatarLetter: data.avatarLetter,
          profileImagePath: data.profileImagePath,
        }) : null;

        if (userPayload) {
          const validation = validateUserData(userPayload);
          if (validation.valid) {
            const normalizedUserId = normalizeId(userPayload.userId);
            socketMetadata.set(socket.id, {
              userId: normalizedUserId,
              userName: userPayload.userName,
              avatarColor: userPayload.avatarColor || '#128C7E',
              avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
              profileImagePath: userPayload.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(normalizedUserId, socket.id);
            meta = socketMetadata.get(socket.id) || {};
            Logger.info('create_room', 'Auto-registered user from create_room payload', { socketId: socket.id, userId: normalizedUserId });
            broadcastStats();
          } else {
            if (callback) callback({ success: false, error: validation.error });
            return;
          }
        } else {
          const err = 'User not registered';
          if (callback) callback({ success: false, error: err });
          return;
        }
      }

      const roomName = (data && data.roomName) ? String(data.roomName).trim() : null;
      if (!roomName) {
        if (callback) callback({ success: false, error: 'Invalid room name' });
        return;
      }

      const roomType = (data && data.roomType) === 'public' ? 'public' : 'private';
      let maxMembers = (data && Number.isInteger(data.maxMembers) && data.maxMembers > 0) ? data.maxMembers : ROOM_CONSTS.DEFAULT_MAX_MEMBERS;
      if (maxMembers < 2) maxMembers = 2;
      if (maxMembers > 500) maxMembers = ROOM_CONSTS.DEFAULT_MAX_MEMBERS;

      const inviteCode = roomType === 'private' ? generateInviteCode() : null;
      const inviteLink = inviteCode ? ROOM_CONSTS.INVITE_LINK_PREFIX + inviteCode : null;
      const roomId = generateRoomId();

      const room = {
        roomId,
        roomName,
        creatorId: meta.userId,
        creatorName: meta.userName,
        description: (data && data.description) ? String(data.description).trim() : null,
        roomType,
        inviteCode,
        inviteLink,
        createdAt: new Date().toISOString(),
        memberIds: [meta.userId],
        maxMembers,
        status: 'active',
      };

      rooms.set(roomId, room);

      Logger.info('create_room', 'Room created', {
        roomId,
        roomName,
        roomType,
        inviteCode,
        creatorId: meta.userId,
        totalRooms: rooms.size,
      });

      // Inform caller
      if (callback) callback({ success: true, room });

      // Broadcast updated public rooms list
      if (roomType === 'public') {
        // Use volatile broadcast for rooms list updates to avoid queuing when many clients are slow
        io.volatile.emit('rooms_updated', { type: 'public', rooms: Array.from(rooms.values()).filter(r => r.roomType === 'public' && r.status === 'active') });
      }
    } catch (error) {
      Logger.error('create_room', 'Error creating room', error.message);
      if (callback) callback({ success: false, error: 'Failed to create room' });
    }
  });

  // Join a room by invite code or roomId
  socket.on('join_room', (data, callback) => {
    try {
      const inviteCode = data && data.inviteCode ? String(data.inviteCode).trim() : null;
      const roomId = data && data.roomId ? String(data.roomId).trim() : null;
      
      Logger.info('join_room', 'Received join request', {
        socketId: socket.id,
        inviteCode,
        roomId,
      });

      let meta = socketMetadata.get(socket.id) || {};
      let userId = meta.userId;

      // If client included user info with the join request, auto-register the socket.
      if (!userId && data && (data.user || data.userId || data.userName)) {
        try {
          const userPayload = data.user || {
            userId: data.userId,
            userName: data.userName,
            avatarColor: data.avatarColor,
            avatarLetter: data.avatarLetter,
            profileImagePath: data.profileImagePath,
          };

          const validation = validateUserData(userPayload);
          if (validation.valid) {
            const normalizedUserId = normalizeId(userPayload.userId);
            socketMetadata.set(socket.id, {
              userId: normalizedUserId,
              userName: userPayload.userName,
              avatarColor: userPayload.avatarColor || '#128C7E',
              avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
              profileImagePath: userPayload.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(normalizedUserId, socket.id);
            meta = socketMetadata.get(socket.id) || {};
            userId = meta.userId;
            Logger.info('join_room', 'Auto-registered user from join payload', { socketId: socket.id, userId });
            broadcastStats();
          } else {
            Logger.warn('join_room', `Auto-registration failed validation: ${validation.error}`, { socketId: socket.id });
          }
        } catch (e) {
          Logger.error('join_room', 'Auto-registration error', e && e.message);
        }
      }

      if (!userId) {
        Logger.warn('join_room', 'User not registered for this socket', {
          socketId: socket.id,
          registeredUsers: Array.from(socketMetadata.keys()),
        });
        if (callback) callback({ success: false, error: 'User not registered' });
        return;
      }

      let room = null;
      if (inviteCode) {
        Logger.info('join_room', 'Searching for room by inviteCode', {
          searchCode: inviteCode.toUpperCase(),
          totalRooms: rooms.size,
          roomCodes: Array.from(rooms.values()).map(r => ({
            roomId: r.roomId,
            inviteCode: r.inviteCode,
            status: r.status,
          })),
        });

        for (const r of rooms.values()) {
          if (r.inviteCode && r.inviteCode.toUpperCase() === inviteCode.toUpperCase() && r.status === 'active') {
            room = r;
            Logger.info('join_room', 'Room found by inviteCode', {
              roomId: r.roomId,
              roomName: r.roomName,
            });
            break;
          }
        }

        if (!room) {
          Logger.warn('join_room', 'Room not found by inviteCode', {
            searchedCode: inviteCode.toUpperCase(),
            totalRooms: rooms.size,
          });
        }
      } else if (roomId) {
        room = rooms.get(roomId) || null;
        if (room && room.status !== 'active') room = null;
      }

      if (!room) {
        if (callback) callback({ success: false, error: 'Room not found' });
        return;
      }

      if (room.memberIds.includes(userId)) {
        if (callback) callback({ success: true, room });
        return;
      }

      if (room.memberIds.length >= room.maxMembers) {
        if (callback) callback({ success: false, error: 'Room is full' });
        return;
      }

      room.memberIds.push(userId);
      rooms.set(room.roomId, room);

      Logger.info('join_room', 'User joined room', { roomId: room.roomId, userId, totalMembers: room.memberIds.length });

      // ✅ OPTIMIZE: Build complete member details with caching
      const buildMemberDetails = () => {
        return room.memberIds.map(memberId => {
          const memberSocketId = userSockets.get(memberId);
          const memberMeta = memberSocketId ? socketMetadata.get(memberSocketId) : {};
          return {
            userId: memberId,
            userName: memberMeta.userName || `User ${memberId.substring(0, 6)}`,
            avatarColor: memberMeta.avatarColor || '#128C7E',
            avatarLetter: memberMeta.avatarLetter || 'U',
            profileImagePath: memberMeta.profileImagePath || null,
            status: memberMeta.status || { micOn: true, cameraOn: true },
          };
        });
      };

      const completeMemberDetails = buildMemberDetails();
      const totalMembers = room.memberIds.length;

      // ✅ OPTIMIZE: Send to new member immediately on same tick
      setImmediate(() => {
        try {
          io.to(socket.id).emit('room_member_list', {
            roomId: room.roomId,
            memberIds: room.memberIds,
            memberDetails: completeMemberDetails,
            timestamp: Date.now(),
          });
        } catch (err) {
          Logger.error('join_room', 'Error sending room_member_list to new member', err.message);
        }
      });

      // ✅ OPTIMIZE: Broadcast to others with reduced payload
      for (const memberId of room.memberIds) {
        if (memberId !== userId) { // Don't send duplicate to the new joiner
          const memberSocketId = userSockets.get(memberId);
          if (memberSocketId) {
            setImmediate(() => {
              try {
                // Use volatile emit for room updates to avoid buffering on slow clients
                io.volatile.to(memberSocketId).emit('room_member_list_updated', {
                  roomId: room.roomId,
                  memberIds: room.memberIds,
                  memberDetails: completeMemberDetails,
                  totalMembers: totalMembers,
                  newMemberId: userId,
                  newMemberName: meta.userName,
                  timestamp: Date.now(),
                });
              } catch (err) {
                Logger.error('join_room', 'Error sending room_member_list_updated to member', err.message);
              }
            });
          }
        }
      }

      if (callback) callback({ success: true, room, memberIds: room.memberIds });
    } catch (error) {
      Logger.error('join_room', 'Error joining room', error.message);
      if (callback) callback({ success: false, error: 'Failed to join room' });
    }
  });

  // List public rooms (simple discovery)
  socket.on('list_public_rooms', (data, callback) => {
    try {
      const publicRooms = Array.from(rooms.values()).filter(r => r.roomType === 'public' && r.status === 'active');
      if (callback) callback({ success: true, rooms: publicRooms });
    } catch (error) {
      Logger.error('list_public_rooms', 'Error listing public rooms', error.message);
      if (callback) callback({ success: false, error: 'Failed to list rooms' });
    }
  });

  // Voice space handlers consolidated later in this file (use in-memory `activeVoiceSpaces`)

  // ✅ NEW: Report a user (DynamoDB-backed)
  socket.on('report_user', async (data, callback) => {
    try {
      Logger.info('report_user', 'RECEIVED report_user event', { data });
      
      const reportedUserId = (data && data.reportedUserId) || (data && data.userId);
      const reporterId = (data && data.reporterId) || (socketMetadata.get(socket.id)?.userId);
      const reason = (data && data.reason) || 'Unspecified';
      
      Logger.info('report_user', 'Parsed data', { reportedUserId, reporterId, reason });
      
      if (!reportedUserId || !reporterId) {
        Logger.warn('report_user', 'Missing reportedUserId or reporterId', { data });
        if (callback) callback({ success: false, error: 'Missing required fields' });
        return;
      }
      
      // Prevent self-reporting
      if (reportedUserId === reporterId) {
        Logger.warn('report_user', 'User attempted self-report', { userId: reportedUserId });
        if (callback) callback({ success: false, error: 'Cannot report yourself' });
        return;
      }
      
      // Record report in DynamoDB
      const result = await recordReport(reportedUserId, reporterId, reason);
      Logger.info('report_user', `User ${reportedUserId} reported by ${reporterId}`, { 
        reported: reportedUserId, 
        reporter: reporterId, 
        recordResult: result 
      });
      
      // Check if user is now blocked
      const isBlocked = await isUserBlocked(reportedUserId);
      if (isBlocked) {
        Logger.warn('report_user', 'Reported user is now blocked', { reportedUserId });
        
        // If reported user is online, disconnect them gracefully
        const reportedUserSocketId = userSockets.get(reportedUserId);
        if (reportedUserSocketId) {
          io.to(reportedUserSocketId).emit('user_blocked_notification', {
            reason: 'Your account has been temporarily blocked due to community reports.',
            timestamp: Date.now(),
          });
          
          // Decompose any active pairings
          decomposeRoom(reportedUserSocketId, 'video');
          decomposeRoom(reportedUserSocketId, 'chat');
          
          Logger.info('report_user', 'Blocked user disconnected from pairings', { reportedUserId, socketId: reportedUserSocketId });
        }
      }
      
      // Send notification to the reported user if they're online
      const reportedUserSocketId = userSockets.get(reportedUserId);
      Logger.info('report_user', `Looking up online status for ${reportedUserId}`, { 
        socketId: reportedUserSocketId, 
        allOnlineUsers: Array.from(userSockets.keys()).length 
      });
      
      if (reportedUserSocketId) {
        io.to(reportedUserSocketId).emit('report_notification', {
          reporterId: reporterId,
          reason: reason,
          timestamp: Date.now(),
        });
        Logger.info('report_user', `Notification sent to ${reportedUserId}`, { socketId: reportedUserSocketId });
      }
      
      if (callback) callback({ success: true, message: 'Report recorded successfully', isBlocked });
    } catch (error) {
      Logger.error('report_user', 'Error recording report', error.message);
      if (callback) callback({ success: false, error: 'Failed to record report' });
    }
  });

  // ✅ NEW: Handle gender filter preference from frontend
  socket.on('set_gender_preference', (data, callback) => {
    try {
      const socketMeta = socketMetadata.get(socket.id);
      if (!socketMeta || !socketMeta.userId) {
        Logger.warn('gender_preference', 'Invalid user metadata', { socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid user' });
        return;
      }

      const { gender } = data;
      const validGenders = ['male', 'female', 'other', 'all'];
      
      if (!gender || !validGenders.includes(gender)) {
        Logger.warn('gender_preference', 'Invalid gender value', { gender, socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid gender value' });
        return;
      }

      userGenderPreferences.set(socketMeta.userId, gender);
      Logger.info('gender_preference', 'Gender filter set successfully', { 
        userId: socketMeta.userId, 
        gender,
        socketId: socket.id
      });
      
      if (callback) callback({ success: true });
    } catch (error) {
      Logger.error('gender_preference', 'Error setting gender preference', error.message);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Find partner for video/chat (DynamoDB-backed blocking checks)
  socket.on('find_partner', async (data) => {
    try {
      const roomType = (data && data.type) || 'video';
      const userData = socketMetadata.get(socket.id);

      Logger.info('find_partner', `🔍 User requesting ${roomType} partner`, {
        socketId: socket.id,
        userId: userData?.userId,
        userName: userData?.userName,
      });

      // Rate limiting check
      if (!checkRateLimit(socket.id)) {
        Logger.warn('find_partner', '⏱️ Rate limit exceeded', { socketId: socket.id });
        // ✅ IMPROVED: Better rate limit error response
        socket.emit('error', {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.',
          retryAfter: 60,
        });
        return;
      }

      if (!isValidSocketId(socket.id)) {
        Logger.warn('find_partner', 'Invalid socket ID', { socketId: socket.id });
        socket.emit('error', {
          code: 'INVALID_SOCKET',
          message: 'Invalid or missing socket ID. Please reconnect.',
        });
        return;
      }

      // ✅ NEW: Check if user is blocked by reports (DynamoDB-backed, async)
      if (userData && userData.userId) {
        const blocked = await isUserBlocked(userData.userId);
        if (blocked) {
          Logger.warn('find_partner', 'Blocked user attempted to find partner', { 
            userId: userData.userId, 
            userName: userData.userName 
          });
          
          const blockInfo = await getActiveBlock(userData.userId);
          const remainingMs = blockInfo && blockInfo.blockedUntil 
            ? Math.max(0, new Date(blockInfo.blockedUntil).getTime() - Date.now())
            : 0;
          
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const hours = Math.floor(remainingSeconds / 3600);
          const minutes = Math.floor((remainingSeconds % 3600) / 60);
          
          let timeStr = '';
          if (hours > 0) {
            timeStr = `${hours}h ${minutes}m`;
          } else {
            timeStr = `${minutes}m`;
          }
          
          socket.emit('error', {
            code: 'USER_BLOCKED',
            message: `You are blocked from pairing. Blocked for ${timeStr}.`,
            remainingSeconds: remainingSeconds,
            blockedUntil: blockInfo?.blockedUntil,
          });
          return;
        }
      }

      const queue = roomType === 'chat' ? chatQueue : videoQueue;
      const pairings = roomType === 'chat' ? chatPairings : videoPairings;

      // Check if already paired
      if (pairings.has(socket.id)) {
        Logger.info('find_partner', 'User already paired', { socketId: socket.id, roomType });
        socket.emit('already_paired', {
          message: 'You are already in a conversation. End it before starting a new one.',
        });
        return;
      }

      // ✅ NEW: Check if already in queue to prevent duplicates
      if (queue.some((item) => item.socketId === socket.id)) {
        Logger.warn('find_partner', 'User already in queue', { socketId: socket.id, roomType });
        socket.emit('queued', {
          queuePosition: queue.findIndex((item) => item.socketId === socket.id) + 1,
          type: roomType,
        });
        return;
      }

      // ✅ DEFENSIVE: Ensure userData exists before queueing
      if (!userData) {
        Logger.error('find_partner', 'userData not found for socket', {
          socketId: socket.id,
          hasMetadata: socketMetadata.has(socket.id),
          metadataKeys: socketMetadata.get(socket.id) ? Object.keys(socketMetadata.get(socket.id)) : [],
        });
        socket.emit('error', {
          code: 'NOT_REGISTERED',
          message: 'Please register first via register_user',
        });
        return;
      }

      const queuedUser = {
        socketId: socket.id,
        userData: userData,
        joinedAt: Date.now(),
      };
      queue.push(queuedUser);
      socketQueues.set(socket.id, roomType);

      Logger.info('find_partner', 'User added to queue', {
        socketId: socket.id,
        roomType,
        userDataKeys: Object.keys(userData),
        queuePosition: queue.length,
        queueSize: queue.length,
      });

      socket.emit('queued', {
        queuePosition: queue.length,
        type: roomType,
      });

      Logger.info('find_partner', 'Attempting to match after queueing', {
        socketId: socket.id,
        roomType,
        queueSizeBeforeMatch: queue.length,
      });

      const matchResult = await attemptMatch(roomType);

      Logger.info('find_partner', 'Match attempt completed', {
        socketId: socket.id,
        roomType,
        matched: matchResult,
        queueSizeAfterMatch: queue.length,
      });

      broadcastStats();
    } catch (error) {
      Logger.error('find_partner', 'Error finding partner', error.message);
      socket.emit('error', { message: 'Failed to find partner' });
    }
  });

  // Quick invite check (socket) - useful for clients to validate invite codes before joining
  socket.on('check_invite', (data, callback) => {
    try {
      const code = data && typeof data === 'string' ? data.toString().trim().toUpperCase() : (data && data.inviteCode ? String(data.inviteCode).trim().toUpperCase() : null);
      if (!code) {
        if (typeof callback === 'function') callback({ success: false, error: 'Invalid invite code' });
        return;
      }

      for (const r of rooms.values()) {
        if (r.inviteCode && r.inviteCode.toUpperCase() === code && r.status === 'active') {
          if (typeof callback === 'function') callback({ success: true, room: r });
          return;
        }
      }
      if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
    } catch (err) {
      Logger.error('check_invite', 'Error checking invite', err && err.message);
      if (typeof callback === 'function') callback({ success: false, error: 'Internal error' });
    }
  });

  // Handle 'next' button
  socket.on('next', () => {
    try {
      if (videoPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'video');
      } else if (chatPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'chat');
      }
    } catch (error) {
      Logger.error('next', 'Error processing next', error.message);
    }
  });

  // Room leave
  socket.on('room_leave', (data) => {
    try {
      const roomType = (data && data.type) || 'video';
      Logger.info('room_leave', `User leaving ${roomType} room`, { socketId: socket.id });
      decomposeRoom(socket.id, roomType);
      broadcastStats();
    } catch (error) {
      Logger.error('room_leave', 'Error leaving room', error.message);
    }
  });

  // Switch to chat
  socket.on('switch_to_chat', (data) => {
    try {
      Logger.info('switch_to_chat', 'User switching to chat', { socketId: socket.id });

      if (videoPairings.has(socket.id)) {
        const pairing = videoPairings.get(socket.id);
        const peerId = pairing.peerId;

        if (isValidSocketId(peerId)) {
          io.to(peerId).emit('partner_switched', {
            reason: 'partner_switched_to_chat',
            timestamp: Date.now(),
          });

          videoPairings.delete(socket.id);
          videoPairings.delete(peerId);
          socketQueues.delete(peerId);

          chatQueue.push({
            socketId: peerId,
            userData: socketMetadata.get(peerId) || {},
            joinedAt: Date.now(),
          });
          socketQueues.set(peerId, 'chat');
        }
      }

      chatQueue.push({
        socketId: socket.id,
        userData: socketMetadata.get(socket.id) || {},
        joinedAt: Date.now(),
      });
      socketQueues.set(socket.id, 'chat');

      socket.emit('queued', {
        type: 'chat',
        queuePosition: chatQueue.length,
      });

      attemptMatch('chat');
      broadcastStats();
    } catch (error) {
      Logger.error('switch_to_chat', 'Error switching to chat', error.message);
      socket.emit('error', { message: 'Failed to switch to chat' });
    }
  });

  // WebRTC - offer
  socket.on('offer', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      Logger.info('offer', '📤 Received offer from initiator', {
        fromId: socket.id,
        peerId,
        matchId: pairing?.matchId,
        hasPairingForSender: videoPairings.has(socket.id),
        videoPairingSize: videoPairings.size,
        offerSdpLength: data?.sdpOffer?.sdp?.length || 0,
      });
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('offer', '📤➡️ Forwarding offer to peer', {
          fromId: socket.id,
          toId: peerId,
          hasPairingForReceiver: videoPairings.has(peerId),
        });
        // Include sender id and matchId for easier routing/debugging on client
        const out = Object.assign({}, data || {}, {
          fromId: socket.id,
          matchId: pairing?.matchId,
          forwardedAt: Date.now(),
        });
        io.to(peerId).emit('makeCall', out);
      } else {
        Logger.warn('offer', '⚠️ No valid peer found for offer', {
          fromId: socket.id,
          peerId,
          hasPairingForSender: videoPairings.has(socket.id),
          videoPairingSize: videoPairings.size,
        });
      }
    } catch (error) {
      Logger.error('offer', '❌ Error sending offer', error.message);
    }
  });

  // WebRTC - answer
  socket.on('answer', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      Logger.info('answer', '📨 Received answer from responder', {
        fromId: socket.id,
        peerId,
        matchId: pairing?.matchId,
        hasPairingForSender: videoPairings.has(socket.id),
        videoPairingSize: videoPairings.size,
        answerSdpLength: data?.sdpAnswer?.sdp?.length || 0,
      });
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('answer', '📨➡️ Forwarding answer to peer', {
          fromId: socket.id,
          toId: peerId,
          hasPairingForReceiver: videoPairings.has(peerId),
        });
        const out = Object.assign({}, data || {}, {
          fromId: socket.id,
          matchId: pairing?.matchId,
          forwardedAt: Date.now(),
        });
        io.to(peerId).emit('callAnswered', out);
      } else {
        Logger.warn('answer', '⚠️ No valid peer found for answer', {
          fromId: socket.id,
          peerId,
          hasPairingForSender: videoPairings.has(socket.id),
          videoPairingSize: videoPairings.size,
        });
      }
    } catch (error) {
      Logger.error('answer', '❌ Error sending answer', error.message);
    }
  });

  // WebRTC - ICE candidates
  socket.on('IceCandidate', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('IceCandidate', '❄️ Forwarding ICE candidate', {
          fromId: socket.id,
          toId: peerId,
          matchId: pairing?.matchId,
          candidate: data?.candidate?.substring(0, 50) || 'none',
        });
        const out = Object.assign({}, data || {}, {
          fromId: socket.id,
          matchId: pairing?.matchId,
          forwardedAt: Date.now(),
        });
        io.to(peerId).emit('IceCandidate', out);
      } else {
        Logger.warn('IceCandidate', '⚠️ No valid peer for ICE candidate', {
          fromId: socket.id,
          peerId,
          hasPairingForSender: videoPairings.has(socket.id),
        });
      }
    } catch (error) {
      Logger.error('IceCandidate', '❌ Error sending ICE candidate', error.message);
    }
  });

  // ===== Voice Space WebRTC Signaling =====
    // Voice Space Emoji Reactions
    socket.on('space_reaction', (data) => {
      try {
        const spaceId = data && data.spaceId ? String(data.spaceId) : null;
        const userId = data && data.userId ? String(data.userId) : null;
        const reaction = data && data.reaction ? String(data.reaction) : null;
        if (!spaceId || !userId || !reaction) return;
        const space = activeVoiceSpaces.get(spaceId);
        if (!space) return;
        io.to(`space:${spaceId}`).emit('space_reaction', { userId, reaction });
      } catch (err) {
        Logger.error('space_reaction', 'Error broadcasting reaction', err && err.message);
      }
    });

    // Offer from a participant to the host for space-based voice connection
    socket.on('space_webrtc_offer', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      if (!spaceId) return;
      const space = activeVoiceSpaces.get(spaceId);
      if (!space) return;
      const hostSocketId = userSockets.get(space.hostId);
      if (hostSocketId) {
        const out = Object.assign({}, data || {}, { fromUserId: (socketMetadata.get(socket.id) || {}).userId, forwardedAt: Date.now() });
        io.to(hostSocketId).emit('space_webrtc_offer', out);
      }
    } catch (err) {
      Logger.error('space_webrtc_offer', 'Error forwarding space offer', err && err.message);
    }
  });

  // Answer from host to a specific participant
  socket.on('space_webrtc_answer', (data) => {
    try {
      const targetUserId = data && (data.targetUserId || data.to || data.userId) ? String(data.targetUserId || data.to || data.userId) : null;
      if (!targetUserId) return;
      const targetSocketId = userSockets.get(targetUserId);
      if (targetSocketId) io.to(targetSocketId).emit('space_webrtc_answer', data);
    } catch (err) {
      Logger.error('space_webrtc_answer', 'Error forwarding space answer', err && err.message);
    }
  });

  // ICE candidate forwarding for space connections
  socket.on('space_webrtc_ice', (data) => {
    try {
      const targetUserId = data && (data.targetUserId || data.to || data.userId) ? String(data.targetUserId || data.to || data.userId) : null;
      if (!targetUserId) return;
      const targetSocketId = userSockets.get(targetUserId);
      if (targetSocketId) io.to(targetSocketId).emit('space_webrtc_ice', data);
    } catch (err) {
      Logger.error('space_webrtc_ice', 'Error forwarding space ICE', err && err.message);
    }
  });

  // ===== Voice Space Speak Request Flow =====
  socket.on('request_speak', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      if (!spaceId) return;
      const space = activeVoiceSpaces.get(spaceId);
      if (!space) return;
      const hostSocketId = userSockets.get(space.hostId);
      if (hostSocketId) {
        io.to(hostSocketId).emit('speak_request', {
          spaceId,
          userId: data.userId,
          userName: data.userName || 'Guest',
        });
      }
    } catch (err) {
      Logger.error('request_speak', 'Error broadcasting speak request', err && err.message);
    }
  });

  socket.on('approve_speak_request', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      let userId = data && data.userId ? String(data.userId) : null;
      const userName = data && data.userName ? String(data.userName) : null;
      const assignedRole = data && data.assignedRole ? data.assignedRole : 'OnStage';
      if (!spaceId || (!userId && !userName)) return;

      const space = activeVoiceSpaces.get(spaceId);
      if (space) {
        let participant = null;
        if (userId) {
          participant = space.participants.find((p) => p.userId === userId);
        }
        if (!participant && userName) {
          const normalizedUserName = userName.trim().toLowerCase();
          participant = space.participants.find((p) => {
            const candidateName = (p.userName || p.name || p.displayName || '').toString().trim().toLowerCase();
            return candidateName === normalizedUserName;
          });
          if (participant) {
            userId = participant.userId;
          }
        }

        if (participant) {
          participant.role = assignedRole;
          emitSpaceUpdated(space);
          broadcastActiveSpaces();
        }
      }

      // Find the user by ID first, then by name
      let targetSocketId = null;
      if (userId) targetSocketId = userSockets.get(userId);
      if (!targetSocketId && userName) {
        const normalizedUserName = userName.trim().toLowerCase();
        for (const [uId, sockId] of userSockets.entries()) {
          const meta = socketMetadata.get(sockId);
          if (meta && meta.userName && meta.userName.trim().toLowerCase() === normalizedUserName) {
            targetSocketId = sockId;
            break;
          }
        }
      }

      if (targetSocketId) {
        io.to(targetSocketId).emit('speak_request_approved', {
          spaceId,
          userName,
          userId,
          assignedRole,
        });
        Logger.info('approve_speak_request', `Approved ${userName || userId} to speak`, {
          spaceId,
          userId,
          assignedRole,
        });
      }
    } catch (err) {
      Logger.error('approve_speak_request', 'Error approving speak request', err && err.message);
    }
  });

  socket.on('decline_speak_request', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      const userName = data && data.userName ? String(data.userName) : null;
      if (!spaceId || !userName) return;

      // Find the user by name and notify them
      for (const [userId, sockId] of userSockets.entries()) {
        const meta = socketMetadata.get(sockId);
        if (meta && meta.userName === userName) {
          io.to(sockId).emit('speak_request_declined', {
            spaceId,
            userName,
            userId,
          });
          break;
        }
      }
    } catch (err) {
      Logger.error('decline_speak_request', 'Error declining speak request', err && err.message);
    }
  });

  socket.on('destage_user', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      const userId = data && data.userId ? String(data.userId) : null;
      if (!spaceId || !userId) return;

      const space = activeVoiceSpaces.get(spaceId);
      if (space) {
        const participant = space.participants.find((p) => p.userId === userId);
        if (participant) {
          participant.role = 'Listener';
          emitSpaceUpdated(space);
          broadcastActiveSpaces();
          Logger.info('destage_user', `Destaged user ${userId} in space ${spaceId}`);
        }
      }
    } catch (err) {
      Logger.error('destage_user', 'Error destaging user', err && err.message);
    }
  });

  socket.on('promote_to_speaker', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      const userId = data && data.userId ? String(data.userId) : null;
      if (!spaceId || !userId) return;

      const space = activeVoiceSpaces.get(spaceId);
      if (space) {
        const participant = space.participants.find((p) => p.userId === userId);
        if (participant) {
          participant.role = 'Speaker';
          emitSpaceUpdated(space);
          broadcastActiveSpaces();
          Logger.info('promote_to_speaker', `Promoted user ${userId} to speaker in space ${spaceId}`);
        }
      }
    } catch (err) {
      Logger.error('promote_to_speaker', 'Error promoting user to speaker', err && err.message);
    }
  });

  socket.on('kick_participant', (data) => {
    try {
      const spaceId = data && data.spaceId ? String(data.spaceId) : null;
      const targetUserId = data && data.targetUserId ? String(data.targetUserId) : null;
      if (!spaceId || !targetUserId) return;

      const space = activeVoiceSpaces.get(spaceId);
      if (space) {
        const participantIdx = space.participants.findIndex((p) => p.userId === targetUserId);
        if (participantIdx !== -1) {
          space.participants.splice(participantIdx, 1);
          emitSpaceUpdated(space);
          broadcastActiveSpaces();
          io.to(spaceId).emit('participant_kicked', {
            spaceId,
            userId: targetUserId,
            kickedByUserId: data.kickedByUserId,
            kickedByUserName: data.kickedByUserName,
            action: 'kick'
          });
          Logger.info('kick_participant', `Kicked user ${targetUserId} from space ${spaceId}`);
        }
      }
    } catch (err) {
      Logger.error('kick_participant', 'Error kicking participant', err && err.message);
    }
  });

  // Chat message relay
  socket.on('message', (data) => {
    try {
      if (!data || (!data.message && !data.mediaUrl && !data.media && !data.mediaType)) {
        Logger.warn('message', 'Empty message or media', { socketId: socket.id });
        return;
      }

      const peerId = chatPairings.get(socket.id)?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        // Build payload allowing text and media (GIF / sticker / mp4)
        // ✅ CRITICAL: Include ALL media fields for proper GIF/image delivery
        const mediaUrl = data.mediaUrl || data.media || null;
        const mediaType = data.mediaType || null;

        // ✅ FIXED: Get sender metadata and fallback to message data if not in socketMetadata
        const senderMeta = socketMetadata.get(socket.id) || {};
        
        // Use profile image from message if not in socketMetadata (fallback)
        const profileImageFromMessage = data.profileImagePath || data.profile_image_path || data.profileImage || data.profile_pic || null;
        const profileImage = senderMeta.profileImagePath || profileImageFromMessage || null;
        
        const senderWithProfileImage = Object.assign({}, senderMeta, {
          // Use message-sent data as fallback if socketMetadata is incomplete
          userName: senderMeta.userName || data.userName || 'Anonymous',
          userId: senderMeta.userId || data.userId || socket.id,
          avatarColor: senderMeta.avatarColor || data.avatarColor || '#128C7E',
          avatarLetter: senderMeta.avatarLetter || data.avatarLetter || 'U',
          // Include profile image in all possible field names for compatibility
          profileImagePath: profileImage,
          profile_image_path: profileImage,
          profileImage: profileImage,
        });

        const payload = {
          message: data.message ? String(data.message).substring(0, 500) : null,
          mediaUrl: mediaUrl,
          mediaType: mediaType,
          messageId: data.messageId || null,
          sender: senderWithProfileImage,
          timestamp: data.timestamp || Date.now(),
        };

        // ✅ NEW: Include reply metadata if message is a reply (preserve media fields)
        if (data.replyTo && typeof data.replyTo === 'object') {
          const replyUserName = (data.replyTo.userName || data.replyTo.senderName || '').trim();
          const finalReplyUserName = replyUserName || data.replyTo.userId || 'Unknown User';
          
          payload.replyTo = {
            messageId: data.replyTo.messageId || null,
            userName: finalReplyUserName.substring(0, 50),
            message: data.replyTo.message || null,
            timestamp: data.replyTo.timestamp || null,
            mediaUrl: data.replyTo.mediaUrl || data.replyTo.media || data.replyTo.media_url || null,
            mediaType: data.replyTo.mediaType || null,
            senderProfileImagePath: data.replyTo.senderProfileImagePath || data.replyTo.profileImagePath || data.replyTo.profile_image_path || null,
            avatarColor: data.replyTo.avatarColor || '#128C7E',
            avatarLetter: ((data.replyTo.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
            replyTo: data.replyTo.replyTo && typeof data.replyTo.replyTo === 'object'
              ? _sanitizeNestedReply(data.replyTo.replyTo)
              : null,
          };
        }

        Logger.info('message', 'Relaying message to peer', {
          from: socket.id,
          to: peerId,
          hasMessage: !!payload.message,
          hasMediaUrl: !!mediaUrl,
          mediaType: mediaType,
          mediaUrlLength: mediaUrl ? mediaUrl.length : 0,
          messageId: payload.messageId,
          hasReply: !!payload.replyTo,
          senderProfileImagePath: senderMeta.profileImagePath || 'MISSING',
        });

        // Send to peer
        io.to(peerId).emit('receiveMessage', payload);
      } else {
        Logger.warn('message', 'No valid peer found', { socketId: socket.id, hasChatPairing: chatPairings.has(socket.id) });
      }
    } catch (error) {
      Logger.error('message', 'Error relaying message', error.message);
    }
  });

  // One-time star gift for peer or room
  socket.on('gift_star', (data, callback) => {
    try {
      // Accept either { roomId } or { groupName } for group rooms, or empty for pair match-based gift
      const roomId = data && data.roomId ? String(data.roomId) : null;
      const groupName = data && data.groupName ? String(data.groupName) : null;
      const pairing = chatPairings.get(socket.id) || videoPairings.get(socket.id);
      const matchId = pairing && pairing.matchId ? pairing.matchId : null;

      // Prefer explicit roomId, then groupName (if provided), else matchId
      const key = roomId || groupName || matchId || null;
      if (!key) {
        if (callback) callback({ success: false, error: 'No valid target for gift' });
        return;
      }

      const giftKey = `${socket.id}:${key}`;
      if (oneTimeGifts.has(giftKey)) {
        if (callback) callback({ success: false, error: 'Already gifted' });
        return;
      }

      // Mark as gifted
      oneTimeGifts.add(giftKey);
      const prev = starCounts.get(key) || 0;
      const next = prev + 1;
      starCounts.set(key, next);

      // Notify recipient(s)
      if (matchId && pairing && pairing.peerId) {
        const peerId = pairing.peerId;
        io.to(peerId).emit('star_gifted', {
          from: socketMetadata.get(socket.id),
          to: socketMetadata.get(peerId),
          matchId,
          totalStars: next,
          timestamp: Date.now(),
        });
        // also notify sender with confirmation
        io.to(socket.id).emit('star_gifted_confirm', { totalStars: next, key, timestamp: Date.now() });
      } else if (roomId || groupName) {
        // Broadcast to room members (match by roomId or groupName)
        const room = Array.from(rooms.values()).find(r => (roomId && (r.roomId === roomId || r.roomId === String(roomId))) || (groupName && r.roomName === groupName));
        if (room) {
          for (const memberId of room.memberIds) {
            const memberSocketId = userSockets.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit('star_gifted', {
                from: socketMetadata.get(socket.id),
                roomId: room.roomId,
                totalStars: next,
                timestamp: Date.now(),
              });
            }
          }
        }
        io.to(socket.id).emit('star_gifted_confirm', { totalStars: next, key, timestamp: Date.now() });
      }

      if (callback) callback({ success: true, totalStars: next });
    } catch (err) {
      Logger.error('gift_star', 'Error processing star gift', err && err.message);
      if (callback) callback({ success: false, error: 'Failed to gift star' });
    }
  });

  // ========== TYPING INDICATORS ==========
  // ✅ NEW: Send typing indicator when user types in direct message
  socket.on('send_typing', (data) => {
    try {
      const { recipientId, isTyping } = data;
      const senderMeta = socketMetadata.get(socket.id) || {};
      const senderId = senderMeta.userId;
      
      if (!senderId || !recipientId) {
        Logger.warn('send_typing', 'Missing senderId or recipientId', { senderId, recipientId });
        return;
      }

      const recipientSocketId = userSockets.get(recipientId);
      if (!recipientSocketId) {
        Logger.debug('send_typing', 'Recipient not online, skipping typing indicator', { senderId, recipientId });
        return;
      }

      // Send typing indicator to recipient
      io.to(recipientSocketId).emit('user_typing', {
        senderId,
        senderName: senderMeta.userName || 'Unknown',
        isTyping,
        timestamp: Date.now(),
      });
    } catch (err) {
      Logger.error('send_typing', 'Error sending typing indicator', err && err.message);
    }
  });

  // ========== DIRECT MESSAGE EVENTS ==========
  // ✅ NEW: Handle direct messages with proper routing and offline storage
  socket.on('send_direct_message', async (data) => {
    try {
      const { recipientId: rawRecipientId, content, message, text, messageId } = data;
      const senderMeta = socketMetadata.get(socket.id) || {};
      const senderId = normalizeId(senderMeta.userId);
      const recipientId = normalizeId(rawRecipientId || data.to || data.recipient);
      // keep backward compat: if recipientId empty, try a few keys
      // (already attempted above)
      const messageText = content || message || text || '';
      const mediaUrl = data.mediaUrl || data.gifUrl || data.media || data.image || data.media_url || null;
      const mediaType = data.mediaType || data.type || data.gifType || data.media_type || null;
      const finalMessageId = messageId || `msg_${Date.now()}`;
      
      if (!senderId || !recipientId) {
        Logger.warn('send_direct_message', 'Missing senderId or recipientId', { senderId, recipientId });
        return;
      }

      const mediaFallback = mediaUrl
        ? (mediaType === 'gif'
            ? 'GIF'
            : mediaType === 'image'
                ? 'Image'
                : mediaType === 'video'
                    ? 'Video'
                    : 'Media')
        : '';

      // Build message payload
      // ✅ NEW: Fetch fresh sender profile from DynamoDB for latest profileImageUrl
      const senderFreshProfile = senderId ? await getFreshUserProfile(senderId) : null;
      const safeSenderImage =
        senderFreshProfile?.profileImageUrl ||
        senderMeta.profileImageUrl ||
        getSafeProfileImageReference(senderMeta.profileImagePath) ||
        getSafeProfileImageReference(data.profileImagePath) ||
        getSafeProfileImageReference(data.senderProfileImagePath) ||
        null;
      
      const messagePayload = {
        id: finalMessageId,
        messageId: finalMessageId,
        senderId: senderId,
        senderName: (senderFreshProfile?.userName || senderMeta.userName || 'Unknown'),
        recipientId: recipientId,
        message: messageText,
        content: messageText || mediaFallback,
        text: messageText || mediaFallback,
        mediaUrl,
        mediaType,
        replyTo: data.replyTo || null,
        profileImagePath: safeSenderImage,
        profileImageUrl: senderFreshProfile?.profileImageUrl || senderMeta.profileImageUrl || safeSenderImage || null,
        senderProfileImagePath: safeSenderImage,
        avatarColor: (senderFreshProfile?.avatarColor || senderMeta.avatarColor || '#128C7E'),
        avatarLetter: senderMeta.avatarLetter || 'U',
        timestamp: new Date().toISOString(),
      };

      const recipientSocketId = userSockets.get(recipientId);
      
      if (recipientSocketId) {
        // ✅ IMPORTANT: Recipient is online - send message immediately
        io.to(recipientSocketId).emit('direct_message', messagePayload);
        Logger.info('send_direct_message', 'Message sent to online recipient', {
          senderId: senderId,
          recipientId: recipientId,
          recipientSocketId,
        });
      } else {
        // Recipient is offline: do not persist direct messages on the server.
        Logger.info('send_direct_message', 'Recipient offline; direct message will not be stored by backend', {
          senderId,
          recipientId,
        });
      }
    } catch (err) {
      Logger.error('send_direct_message', 'Error sending direct message', err && err.message);
    }
  });

  // ✅ NEW: Handle message seen/read receipt - Notify sender that their message was read
  socket.on('message_seen', (data) => {
    try {
      const senderId = normalizeId(data.senderId);
      const recipientId = normalizeId(data.recipientId);
      const senderSocketId = userSockets.get(senderId);

      if (senderSocketId) {
        // ✅ Send read receipt confirmation back to sender
        io.to(senderSocketId).emit('message_read_receipt', {
          senderId: recipientId,
          senderName: data.senderName || 'User',
          timestamp: data.timestamp || new Date().toISOString(),
        });
        Logger.info('message_seen', 'Read receipt sent to sender', {
          senderId,
          recipientId,
          senderName: data.senderName,
        });
      } else {
        Logger.info('message_seen', 'Sender offline, skipping read receipt', {
          senderId,
          recipientId,
        });
      }
    } catch (err) {
      Logger.error('message_seen', 'Error processing read receipt', err && err.message);
    }
  });

  // ========== VOICE SPACE HANDLERS (IN-MEMORY, VOLATILE) ==========

  // Get all active voice spaces (broadcast from in-memory store)
  socket.on('get_active_spaces', (data, callback) => {
    try {
      const spaces = Array.from(activeVoiceSpaces.values()).sort(
        (a, b) => b.createdAt - a.createdAt
      );

      if (callback) callback({ success: true, spaces });
      Logger.info('get_active_spaces', `📡 Returned ${spaces.length} active spaces`);
    } catch (error) {
      Logger.error('get_active_spaces', 'Error fetching active spaces', error.message);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Create a new voice space
  socket.on('create_space', async (data, callback) => {
    let callbackCalled = false;
    const callbackOnce = (response) => {
      if (!callbackCalled && typeof callback === 'function') {
        callbackCalled = true;
        callback(response);
      }
    };

    // Safety timeout: guarantee response within 10 seconds
    const timeoutId = setTimeout(() => {
      if (!callbackCalled) {
        Logger.error('create_space', 'Timeout waiting for callback response', { socketId: socket.id });
        callbackOnce({ success: false, error: 'Server operation timed out' });
      }
    }, 10000);

    try {
      Logger.debug('create_space', 'Event received', { socketId: socket.id, hasCallback: typeof callback === 'function' });
      
      const incomingUser = data?.user || null;
      const incomingUserId = normalizeId(data.userId || incomingUser?.userId || socket.data?.userId);
      const userNamePayload = incomingUser?.userName || data.userName || socket.data?.userName;
      const userId = incomingUserId;
      const spaceName = String(data.spaceName || 'Voice Space').substring(0, 100);
      const description = String(data.description || '').substring(0, 300);

      Logger.debug('create_space', 'Extracted create space details', { socketId: socket.id, userId, spaceName });

      if (!userId) {
        Logger.warn('create_space', 'Missing userId in create_space payload', { socketId: socket.id });
        clearTimeout(timeoutId);
        callbackOnce({ success: false, error: 'Missing userId' });
        return;
      }

      // Auto-register socket if not already registered and client supplied user data
      let userMeta = socketMetadata.get(socket.id);
      if (!userMeta && (incomingUserId || userNamePayload)) {
        const userPayload = incomingUser || {
          userId: data.userId || socket.data?.userId,
          userName: data.userName || socket.data?.userName,
          avatarColor: data.avatarColor,
          avatarLetter: data.avatarLetter,
          profileImagePath: data.profileImagePath,
        };
        const validation = validateUserData(userPayload);
        if (validation.valid) {
          const normalizedId = normalizeId(userPayload.userId);
          socketMetadata.set(socket.id, {
            userId: normalizedId,
            userName: userPayload.userName,
            avatarColor: userPayload.avatarColor || '#128C7E',
            avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'H'),
            profileImagePath: userPayload.profileImagePath || null,
            joinedAt: Date.now(),
          });
          socket.data = socket.data || {};
          socket.data.userId = normalizedId;
          socket.data.userName = userPayload.userName;
          userSockets.set(normalizedId, socket.id);
          userMeta = socketMetadata.get(socket.id);
          Logger.info('create_space', 'Auto-registered user for create_space', { socketId: socket.id, userId: normalizedId });
          broadcastStats();
        }
      }

      const existingHostSpace = Array.from(activeVoiceSpaces.values()).find(
        (space) => String(space.hostId) === userId,
      );
      if (existingHostSpace) {
        Logger.info('create_space', 'User already has an active voice space', { socketId: socket.id, spaceId: existingHostSpace.spaceId });
        clearTimeout(timeoutId);
        callbackOnce({
          success: false,
          error: 'You already have one active voice space. Close it before creating a new one.',
        });
        return;
      }

      Logger.debug('create_space', 'Resolving user profile metadata', { socketId: socket.id, userId });
      const profileMeta = await resolveUserProfileMetadata(userId, userMeta, userNamePayload || 'Host', '#8A2BE2', 'H');
      Logger.debug('create_space', 'Resolved user profile metadata', { socketId: socket.id, userId, resolvedName: profileMeta?.userName });

      // Generate unique spaceId
      const spaceId = `space_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const newSpace = {
        spaceId,
        name: spaceName,
        description: description,
        hostId: String(userId),
        hostName: profileMeta.userName,
        hostAvatar: profileMeta.avatarLetter,
        hostAvatarColor: profileMeta.avatarColor,
        hostProfileImageUrl: profileMeta.profileImageUrl || profileMeta.profileImagePath || null,
        hostProfileImagePath: profileMeta.profileImagePath || profileMeta.profileImageUrl || null,
        isPrivate: data.isPrivate || false,
        speakerLimit: Math.min(Math.max(data.speakerLimit || 5, 1), 50),
        roomType: String(data.roomType || 'FREE').substring(0, 20),
        participants: [buildParticipant(userId, profileMeta, 'Host')],
        createdAt: Date.now(),
        status: 'active',
      };

      activeVoiceSpaces.set(spaceId, newSpace);
      userToSpaceMap.set(userId, spaceId);
      socket.join(`space:${spaceId}`);

      Logger.info('create_space', `✨ Space created: ${spaceId}`, {
        spaceName,
        hostId: userId,
        hostName: profileMeta.userName,
      });

      // Emit updated space state to the host immediately
      emitSpaceUpdated(newSpace);
      socket.emit('space_created', {
        success: true,
        space: newSpace,
        assignedRole: 'Host',
      });

      // Broadcast updated spaces list to ALL clients
      broadcastActiveSpaces();

      Logger.debug('create_space', 'Sending success callback', { socketId: socket.id, spaceId });
      clearTimeout(timeoutId);
      callbackOnce({
        success: true,
        space: {
          spaceId: newSpace.spaceId,
          name: newSpace.name,
          description: newSpace.description,
          hostId: newSpace.hostId,
          hostName: newSpace.hostName,
          speakerLimit: newSpace.speakerLimit,
          roomType: newSpace.roomType,
          currentSpeakers: newSpace.participants.filter((p) => p.role === 'Speaker').length,
          currentListeners: newSpace.participants.filter((p) => p.role === 'Listener').length,
        },
        assignedRole: 'Host',
      });
      Logger.debug('create_space', 'Callback completed', { socketId: socket.id, spaceId });
    } catch (error) {
      Logger.error('create_space', 'Error creating space', {
        message: error.message,
        stack: error.stack,
        code: error.code,
        name: error.name,
      });
      clearTimeout(timeoutId);
      callbackOnce({ success: false, error: error.message });
    }
  });

  // Join a voice space
  socket.on('join_space', async (data, callback) => {
    try {
      const incomingUser = data?.user || null;
      const incomingUserId = normalizeId(data.userId || incomingUser?.userId || socket.data?.userId);
      const userNamePayload = incomingUser?.userName || data.userName || socket.data?.userName;
      const userId = incomingUserId;
      const spaceId = String(data.spaceId || '');
      const requestedRole = data.requestedRole || 'Listener';

      if (!userId || !spaceId) {
        if (callback) callback({ success: false, error: 'Missing userId or spaceId' });
        return;
      }

      const space = activeVoiceSpaces.get(spaceId);
      if (!space) {
        if (callback) callback({ success: false, error: 'Space not found or expired' });
        return;
      }

      // Check if user already in space
      const existingParticipant = space.participants.find((p) => p.userId === userId);
      if (existingParticipant) {
        // If the socket was previously disconnected or retries joining, treat as idempotent success.
        // Ensure socket is in the room and mappings are set, then respond with success instead of error.
        try {
          cancelVoiceSpaceDisconnectCleanup(userId);
          userToSpaceMap.set(userId, spaceId);
          socket.join(`space:${spaceId}`);
          // Update socket metadata mapping if missing
          if (!socketMetadata.get(socket.id)) {
            socketMetadata.set(socket.id, {
              userId,
              userName: existingParticipant.userName,
              avatarColor: existingParticipant.avatarColor,
              avatarLetter: existingParticipant.avatarLetter,
              profileImagePath: existingParticipant.profileImagePath || existingParticipant.profileImageUrl || null,
              profileImageUrl: existingParticipant.profileImageUrl || existingParticipant.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(userId, socket.id);
          }

          // Re-emit updated state to the re-joining socket
          socket.emit('space_joined', {
            success: true,
            space,
            assignedRole: existingParticipant.role,
          });

          // Also invoke callback if provided
          if (callback) {
            callback({ success: true, space, assignedRole: existingParticipant.role });
          }

          // Broadcast updates to other participants (no participant list change expected)
          emitSpaceUpdated(space);
          broadcastActiveSpaces();
        } catch (err) {
          Logger.error('join_space', 'Error handling idempotent join for existing participant', err?.message || err);
          if (callback) callback({ success: false, error: 'Already in space' });
        }
        return;
      }

      // Auto-register socket if not already registered and client supplied user data
      let userMeta = socketMetadata.get(socket.id);
      if (!userMeta && (incomingUserId || userNamePayload)) {
        const userPayload = incomingUser || {
          userId: data.userId,
          userName: data.userName,
          avatarColor: data.avatarColor,
          avatarLetter: data.avatarLetter,
          profileImagePath: data.profileImagePath,
        };
        const validation = validateUserData(userPayload);
        if (validation.valid) {
          const normalizedId = normalizeId(userPayload.userId);
          socketMetadata.set(socket.id, {
            userId: normalizedId,
            userName: userPayload.userName,
            avatarColor: userPayload.avatarColor || '#128C7E',
            avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
            profileImagePath: userPayload.profileImagePath || null,
            joinedAt: Date.now(),
          });
          socket.data = socket.data || {};
          socket.data.userId = normalizedId;
          userSockets.set(normalizedId, socket.id);
          userMeta = socketMetadata.get(socket.id);
          Logger.info('join_space', 'Auto-registered user for join_space', { socketId: socket.id, userId: normalizedId });
          broadcastStats();
        }
      }

      userMeta = userMeta || socketMetadata.get(socket.id) || {};
      const participantMeta = await resolveUserProfileMetadata(userId, userMeta, userNamePayload || 'Guest', '#128C7E', 'U');

      // Determine role: FREE rooms auto-assign open speaker slots, otherwise listener by default.
      let assignedRole = 'Listener';
      const normalizedRoomType = String(space.roomType || 'FREE').toUpperCase();
      const currentSpeakers = space.participants.filter((p) => {
        const role = String(p.role || '').trim().toLowerCase();
        return role === 'speaker' || role === 'onstage';
      }).length;

      if (normalizedRoomType === 'FREE') {
        if (currentSpeakers < space.speakerLimit) {
          assignedRole = 'Speaker';
        }
      } else if (requestedRole === 'Speaker') {
        if (currentSpeakers < space.speakerLimit) {
          assignedRole = 'Speaker';
        }
      }

      // Add participant to space (use fresh profile data when available)
      space.participants.push(buildParticipant(userId, participantMeta, assignedRole));

      userToSpaceMap.set(userId, spaceId);
      socket.join(`space:${spaceId}`);

      try {
        const room = io.sockets.adapter.rooms.get(`space:${spaceId}`);
        const socketsInRoom = room ? room.size : 0;
        Logger.info('join_space', `User ${participantMeta.userName} (${userId}) joined space ${spaceId} as ${assignedRole} (participants=${space.participants.length}, socketsInRoom=${socketsInRoom})`);
      } catch (err) {
        Logger.info('join_space', `User ${participantMeta.userName} (${userId}) joined space ${spaceId} as ${assignedRole} (participants=${space.participants.length})`);
      }

      Logger.info('join_space', `👤 ${participantMeta.userName} (${userId}) joined space ${spaceId} as ${assignedRole}`, {
        spaceId,
        userId,
        role: assignedRole,
        totalParticipants: space.participants.length,
      });

      // Notify all participants in space of the update
      emitSpaceUpdated(space);
      socket.emit('space_joined', {
        success: true,
        space,
        assignedRole,
      });

      // Broadcast updated spaces list globally
      broadcastActiveSpaces();

      if (callback) {
        callback({
          success: true,
          space,
          assignedRole,
        });
      }
    } catch (error) {
      Logger.error('join_space', 'Error joining space', error.message);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Leave a voice space
  socket.on('leave_space', (data, callback) => {
    try {
      const userId = normalizeId(data.userId);
      const spaceId = String(data.spaceId || '');

      if (!userId || !spaceId) {
        if (callback) callback({ success: false, error: 'Missing userId or spaceId' });
        return;
      }

      const space = activeVoiceSpaces.get(spaceId);
      if (!space) {
        if (callback) callback({ success: false, error: 'Space not found' });
        return;
      }

      const participantIndex = space.participants.findIndex((p) => p.userId === userId);
      if (participantIndex === -1) {
        if (callback) callback({ success: false, error: 'Not in space' });
        return;
      }

      const leftParticipant = space.participants[participantIndex];
      space.participants.splice(participantIndex, 1);

      userToSpaceMap.delete(userId);
      socket.leave(`space:${spaceId}`);

      Logger.info('leave_space', `👋 ${leftParticipant.userName} left space ${spaceId}`, {
        spaceId,
        userId,
        remainingParticipants: space.participants.length,
      });

      if (leftParticipant.userId === space.hostId) {
        closeSpaceAsHost(spaceId, 'host_disconnected');
      } else if (space.participants.length === 0) {
        activeVoiceSpaces.delete(spaceId);
        io.emit('space_closed', { spaceId });
        Logger.info('leave_space', `🗑️ Space ${spaceId} deleted (no participants)`, {});
      } else {
        emitSpaceUpdated(space);
      }

      // Broadcast updated spaces list globally
      broadcastActiveSpaces();

      if (callback) callback({ success: true });
    } catch (error) {
      Logger.error('leave_space', 'Error leaving space', error.message);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('space_left', (data, callback) => {
    socket.emit('leave_space', data, callback);
  });

  // Close a voice space as the host
  function handleCloseSpaceRequest(data, callback) {
    try {
      const userId = normalizeId(data.userId);
      const spaceId = String(data.spaceId || '');

      if (!userId || !spaceId) {
        if (callback) callback({ success: false, error: 'Missing userId or spaceId' });
        return;
      }

      const space = activeVoiceSpaces.get(spaceId);
      if (!space) {
        if (callback) callback({ success: false, error: 'Space not found' });
        return;
      }

      if (String(space.hostId) !== String(userId)) {
        if (callback) callback({ success: false, error: 'Only the host can close this space' });
        return;
      }

      closeSpaceAsHost(spaceId, 'host_closed');
      if (callback) callback({ success: true });
    } catch (error) {
      Logger.error('close_space', 'Error closing space', error.message);
      if (callback) callback({ success: false, error: error.message });
    }
  }

  const closeSpaceEvents = ['close_space', 'space_close', 'close_space_by_host'];
  closeSpaceEvents.forEach((eventName) => socket.on(eventName, handleCloseSpaceRequest));

  // Disconnect - Clean up user's voice spaces
  socket.on('disconnect', (reason) => {
    try {
      Logger.info('disconnect', `Client disconnected: ${reason}`, { socketId: socket.id });

      // ✅ NEW: Auto-leave voice spaces
      const userData = socketMetadata.get(socket.id);
      if (userData) {
        cancelVoiceSpaceDisconnectCleanup(userData.userId);
        const userSpaceId = userToSpaceMap.get(userData.userId);
        if (userSpaceId) {
          const space = activeVoiceSpaces.get(userSpaceId);
          if (space) {
            const isHost = String(space.hostId) === String(userData.userId);
            scheduleVoiceSpaceDisconnectCleanup(
              userData.userId,
              userSpaceId,
              isHost ? 'host_disconnected' : 'participant_disconnected',
              socket.id,
            );
          }
        }
      }

      // Decompose pairings
      if (videoPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'video');
      } else if (chatPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'chat');
      }

      // Remove from queues
      const videoIdx = videoQueue.findIndex((item) => item.socketId === socket.id);
      if (videoIdx !== -1) videoQueue.splice(videoIdx, 1);

      const chatIdx = chatQueue.findIndex((item) => item.socketId === socket.id);
      if (chatIdx !== -1) chatQueue.splice(chatIdx, 1);

      // Clean metadata
      cleanupSocketUserState(userData?.userId, socket.id);

      // Emit offline presence on disconnect so clients can update status reliably
      try {
        const disconnectedUserId = normalizeId(userData?.userId);
        if (disconnectedUserId) {
          if (global.onlineUsers) global.onlineUsers.delete(disconnectedUserId);
          const offlinePayload = {
            userId: disconnectedUserId,
            userName: userData?.userName || null,
            isOnline: false,
            timestamp: new Date().toISOString(),
          };
          io.emit('user_online_status', offlinePayload);

          (async () => {
            try {
              const friendsList = await listFriends(disconnectedUserId).catch(() => null) || [];
              const friendIds = (Array.isArray(friendsList) ? friendsList : []).map(f => (f.userId || f.id || f.friendId || '').toString()).filter(Boolean);
              for (const fid of friendIds) {
                notifyUserOfFriendEvent(fid, 'friend_status_update', {
                  userId: disconnectedUserId,
                  isOnline: false,
                  userName: offlinePayload.userName,
                  timestamp: offlinePayload.timestamp,
                });
              }
            } catch (e) {
              Logger.warn('presence', 'Error notifying friends of disconnect presence change', { userId: disconnectedUserId, error: e && e.message });
            }
          })();
        }
      } catch (e) {
        Logger.warn('disconnect', 'Error emitting offline presence on disconnect', { socketId: socket.id, error: e && e.message });
      }

      // ✅ FIX: Remove this socket from any groupChatRooms to avoid memory leaks
      try {
        for (const [groupName, roomSet] of groupChatRooms.entries()) {
          if (roomSet && roomSet.has && roomSet.has(socket.id)) {
            roomSet.delete(socket.id);
            try { socket.leave(`group_${groupName}`); } catch (e) {}
            if (roomSet.size === 0) {
              groupChatRooms.delete(groupName);
              messageIdCache.delete(groupName);
              Logger.info('disconnect', 'Cleaned empty group room after disconnect', { groupName });
            }
          }
        }
      } catch (e) {
        Logger.warn('disconnect', 'Error cleaning groupChatRooms for socket', { socketId: socket.id, err: e && e.message });
      }
      socketQueues.delete(socket.id);
      health.updateSocketConnections(io.of('/').sockets.size);

      broadcastStats();
    } catch (error) {
      Logger.error('disconnect', 'Error during disconnect cleanup', error.message);
    }
  });

  // ========== GROUP CHAT EVENTS ==========
  
  // Message deduplication uses the shared global cache
  
  // ✅ NEW: Get group members list (for members dialog)
  socket.on('get_group_members', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet) {
        if (callback) callback({ success: false, members: [], memberCount: 0 });
        return;
      }

      // ✅ Get all members with complete profile data for animations
      const members = [];
      for (const memberSocketId of roomSet) {
        const memberMeta = socketMetadata.get(memberSocketId) || {};
        members.push({
          socketId: memberSocketId,
          userId: memberMeta.userId || '',
          userName: memberMeta.userName || 'Unknown User',
          avatarColor: memberMeta.avatarColor || '#128C7E',
          avatarLetter: (memberMeta.avatarLetter || (memberMeta.userName ? memberMeta.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
          profileImagePath: memberMeta.profileImagePath || null,
          senderProfileImagePath: memberMeta.profileImagePath || null,
        });
      }

      Logger.info('get_group_members', 'Fetched group members', {
        groupName,
        memberCount: members.length,
      });

      if (callback) {
        callback({
          success: true,
          groupName,
          members,
          memberCount: members.length,
        });
      }
    } catch (error) {
      Logger.error('get_group_members', 'Error getting group members', error.message);
      if (callback) callback({ success: false, error: 'Failed to get members' });
    }
  });

  // User joins a group
  socket.on('join_group', async (data, callback) => {
    try {
      let groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        Logger.warn('join_group', 'Invalid group name', { socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      // ✅ NEW: Room replica system - if room is at capacity, find or create a replica
      const baseGroupName = data && data.groupName ? String(data.groupName).trim() : groupName;
      let replicaIndex = 0;
      let actualRoomName = baseGroupName;
      let isReplica = false;
      
      // Find the first available room (base or replica) with space
      while (groupChatRooms.has(actualRoomName)) {
        const currentSet = groupChatRooms.get(actualRoomName);
        if (currentSet.size < CONFIG.GROUP_ROOM_CAPACITY) {
          // Found a room with space
          groupName = actualRoomName;
          isReplica = replicaIndex > 0;
          break;
        }
        // Room is full, try next replica
        replicaIndex++;
        actualRoomName = `${baseGroupName}_replica${replicaIndex}`;
      }

      // If no existing room has space, use the next available room name
      if (groupName === data.groupName) {
        groupName = actualRoomName;
        isReplica = replicaIndex > 0;
      }

      // Get or create room (main or replica)
      if (!groupChatRooms.has(groupName)) {
        groupChatRooms.set(groupName, new Set());
      }

      const roomSet = groupChatRooms.get(groupName);
      const wasAlreadyMember = roomSet.has(socket.id);

      // Add user to room
      roomSet.add(socket.id);
      socket.join(`group_${groupName}`);

      // Persist any profile image provided by the client when joining so the server
      // can use it for later group messages (helps when clients send data: URIs).
      try {
        const meta = socketMetadata.get(socket.id) || {};
        const incomingProfile = data?.profileImagePath || data?.senderProfileImagePath || data?.profile_image_path || data?.profileImage || data?.profile_pic || data?.photo || data?.avatarUrl || data?.img || null;
      const safeIncomingProfile = getSafeProfileImageReference(incomingProfile);
      if (safeIncomingProfile) {
        meta.profileImagePath = safeIncomingProfile;
        socketMetadata.set(socket.id, meta);
        Logger.info('join_group', 'Persisted incoming profile image from join_group', { socketId: socket.id, preview: String(safeIncomingProfile).substring(0, 64) });
      }
      } catch (err) {
        Logger.warn('join_group', 'Failed to persist incoming profile image to socketMetadata', { socketId: socket.id, err: err && err.message });
      }

      const memberCount = roomSet.size;

      Logger.info('join_group', 'User joined group', {
        socketId: socket.id,
        userName: data?.userName,
        groupName,
        memberCount,
        isReplica,
        wasAlreadyMember,
      });

      // ✅ FIXED: Send complete member list to new joiner (for animations)
      // ✅ NEW: Enrich members with fresh profiles from DynamoDB for latest profileImageUrl
      const allMembers = [];
      for (const memberSocketId of roomSet) {
        const memberMeta = socketMetadata.get(memberSocketId) || {};
        
        // Fetch fresh profile from DynamoDB if we have a userId
        const freshProfile = memberMeta.userId ? await getFreshUserProfile(memberMeta.userId) : null;
        
        const safeMemberImage = getSafeProfileImageReference(memberMeta.profileImagePath);
        const memberData = {
          socketId: memberSocketId,
          userId: memberMeta.userId || '',
          userName: (freshProfile?.userName || memberMeta.userName || 'Unknown User'),
          avatarColor: (freshProfile?.avatarColor || memberMeta.avatarColor || '#128C7E'),
          avatarLetter: memberMeta.avatarLetter || 'U',
          profileImagePath: safeMemberImage,
          profileImageUrl: freshProfile?.profileImageUrl || safeMemberImage || null,
          senderProfileImagePath: safeMemberImage,
        };
        allMembers.push(memberData);
      }

      const requestedGroupName = baseGroupName;

      // Send joiner the full member list
      socket.emit('group_members_list', {
        groupName,
        requestedGroupName,
        members: allMembers,
        memberCount,
        timestamp: new Date().toISOString(),
      });

      // Notify all users in group (including the new joiner) of new member with full data
      // ✅ NEW: Fetch fresh profile for the joiner to ensure latest profileImageUrl
      const joinerFreshProfile = data?.userId ? await getFreshUserProfile(data.userId) : null;
      
      const safeJoinerImage =
        joinerFreshProfile?.profileImageUrl ||
        getSafeProfileImageReference(data?.profileImageUrl) ||
        getSafeProfileImageReference(data?.profileImagePath) ||
        getSafeProfileImageReference(data?.senderProfileImagePath) ||
        null;
      io.to(`group_${groupName}`).emit('user_joined_group', {
        groupName,
        requestedGroupName,
        groupIcon: data?.groupIcon || '💬',
        groupId: data?.groupId || null,
        senderSocketId: socket.id,
        userId: data?.userId,
        userName: (joinerFreshProfile?.userName || data?.userName || 'Unknown User'),
        profileImagePath: safeJoinerImage,
        profileImageUrl: joinerFreshProfile?.profileImageUrl || data?.profileImageUrl || safeJoinerImage || null,
        senderProfileImagePath: safeJoinerImage,
        avatarColor: (joinerFreshProfile?.avatarColor || data?.avatarColor || '#128C7E'),
        avatarLetter: data?.avatarLetter || 'U',
        memberCount,
        capacity: CONFIG.GROUP_ROOM_CAPACITY || 10,
        roomName: groupName,
        allMembers: allMembers,
        timestamp: new Date().toISOString(),
      });

      if (callback) {
        // ✅ FIXED: Send complete member list in callback response
        callback({
          success: true,
          groupName,
          requestedGroupName,
          memberCount,
          capacity: CONFIG.GROUP_ROOM_CAPACITY || 10,
          roomName: groupName,
          allMembers: allMembers,
          message: `Joined ${groupName}. Total members: ${memberCount}`,
        });
      }
    } catch (error) {
      Logger.error('join_group', 'Error joining group', error.message);
      if (callback) callback({ success: false, error: 'Failed to join group' });
    }
  });

  // User sends message to group
  socket.on('send_group_message', (data, callback) => {
    try {
      // ✅ NEW: Rate limiting for message sending (prevent spam)
      if (!checkRateLimit(socket.id)) {
        Logger.warn('send_group_message', 'Rate limit exceeded for user', { socketId: socket.id });
        if (callback) {
          callback({
            success: false,
            error: 'Too many messages. Please slow down.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: 60,
          });
        }
        return;
      }

      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      const message = data && data.message ? String(data.message).trim() : null;
      const clientMessageId = data && data.messageId ? String(data.messageId).trim() : null;
      const mediaUrl = data && data.mediaUrl ? String(data.mediaUrl).trim() : null;
      const mediaType = data && data.mediaType ? String(data.mediaType).trim() : null;

      // ✅ FIXED: Allow message if groupName exists AND (text OR media) is present
      if (!groupName || (!message && !mediaUrl)) {
        Logger.warn('send_group_message', 'Invalid message data', {
          socketId: socket.id,
          hasGroupName: !!groupName,
          hasMessage: !!message,
          hasMedia: !!mediaUrl,
          mediaType: mediaType || 'none',
        });
        if (callback) callback({ success: false, error: 'Invalid message data' });
        return;
      }

      // Validate user is in group
      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet || !roomSet.has(socket.id)) {
        Logger.warn('send_group_message', 'User not in group', {
          socketId: socket.id,
          groupName,
        });
        if (callback) callback({ success: false, error: 'Not in this group' });
        return;
      }

      // Use client messageId if provided (helps with deduplication), otherwise generate
      const serverMessageId = clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Initialize dedup cache for this group if needed
      if (!messageIdCache.has(groupName)) {
        messageIdCache.set(groupName, { ids: new Set(), timestamp: Date.now() });
      }
      
      const cache = messageIdCache.get(groupName);
      
      // Check if this message was already broadcast (deduplication)
      if (cache.ids.has(serverMessageId)) {
        Logger.warn('send_group_message', 'Duplicate message detected and skipped', {
          socketId: socket.id,
          groupName,
          messageId: serverMessageId,
        });
        if (callback) callback({ success: true, duplicate: true, messageId: serverMessageId });
        return;
      }
      
      // Add to dedup cache
      cache.ids.add(serverMessageId);
      cache.timestamp = Date.now();

      // ✅ CRITICAL FIX: Get sender's ACTUAL profile from server (not trusting client data)
      const senderMeta = socketMetadata.get(socket.id) || {};

      const messageData = {
        userId: senderMeta.userId || data?.userId || '',
        userName: (senderMeta.userName || data?.userName || 'Unknown User').substring(0, 50),
        message: message ? message.substring(0, 1000) : null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        senderProfileImagePath: senderMeta.profileImagePath || data?.senderProfileImagePath || data?.profileImagePath || data?.profile_image_path || null,
        profileImagePath: senderMeta.profileImagePath || data?.profileImagePath || data?.senderProfileImagePath || data?.profile_image_path || null,
        avatarColor: senderMeta.avatarColor || data?.avatarColor || '#128C7E',
        avatarLetter: (senderMeta.avatarLetter || data?.avatarLetter || (senderMeta.userName ? senderMeta.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
        timestamp: Date.now(),
        messageId: serverMessageId,
      };

      // If the client included reply metadata, preserve and forward it (including media)
      if (data.replyTo && typeof data.replyTo === 'object') {
        const replyUserName = (data.replyTo.userName || data.replyTo.senderName || '').trim();
        const finalReplyUserName = replyUserName || data.replyTo.userId || 'Unknown User';
        
        messageData.replyTo = {
          messageId: data.replyTo.messageId || null,
          userName: finalReplyUserName.substring(0, 50),
          message: data.replyTo.message || null,
          timestamp: data.replyTo.timestamp || null,
          mediaUrl: data.replyTo.mediaUrl || data.replyTo.media || data.replyTo.media_url || null,
          mediaType: data.replyTo.mediaType || null,
          senderProfileImagePath: data.replyTo.senderProfileImagePath || data.replyTo.profileImagePath || data.replyTo.profile_image_path || null,
          avatarColor: data.replyTo.avatarColor || '#128C7E',
          avatarLetter: ((data.replyTo.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
          replyTo: data.replyTo.replyTo && typeof data.replyTo.replyTo === 'object'
            ? _sanitizeNestedReply(data.replyTo.replyTo)
            : null,
        };
      }

      Logger.info('send_group_message', 'Broadcasting message to others (not sender)', {
        socketId: socket.id,
        groupName,
        userName: messageData.userName,
        messageId: serverMessageId,
        roomSize: roomSet.size,
      });

      // Broadcast to OTHER users in the group (NOT including sender - they use optimistic update)
      socket.to(`group_${groupName}`).emit('group_message', messageData);

      if (callback) {
        callback({
          success: true,
          messageId: serverMessageId,
          timestamp: messageData.timestamp,
          data: messageData,
        });
      }
    } catch (error) {
      Logger.error('send_group_message', 'Error sending message', error.message);
      if (callback) callback({ success: false, error: 'Failed to send message' });
    }
  });

  // User sends message to room using a generic roomType
  socket.on('send_room_message', (data, callback) => {
    try {
      const roomType = data && data.roomType ? String(data.roomType).trim().toLowerCase() : null;
      if (!roomType) {
        if (callback) callback({ success: false, error: 'Missing roomType' });
        return;
      }

      if (roomType === 'group') {
        const groupName = data.groupName || data.roomName || data.roomId || null;
        const message = data && data.message ? String(data.message).trim() : null;
        const mediaUrl = data && data.mediaUrl ? String(data.mediaUrl).trim() : null;
        const mediaType = data && data.mediaType ? String(data.mediaType).trim() : null;
        const clientMessageId = data && data.messageId ? String(data.messageId).trim() : null;

        if (!groupName || (!message && !mediaUrl)) {
          if (callback) callback({ success: false, error: 'Invalid group message data' });
          return;
        }

        const roomSet = groupChatRooms.get(groupName);
        if (!roomSet || !roomSet.has(socket.id)) {
          if (callback) callback({ success: false, error: 'Not in this group' });
          return;
        }

        const serverMessageId = clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        if (!messageIdCache.has(groupName)) {
          messageIdCache.set(groupName, { ids: new Set(), timestamp: Date.now() });
        }

        const cache = messageIdCache.get(groupName);
        if (cache.ids.has(serverMessageId)) {
          if (callback) callback({ success: true, duplicate: true, messageId: serverMessageId });
          return;
        }

        cache.ids.add(serverMessageId);
        cache.timestamp = Date.now();

        const senderMeta = socketMetadata.get(socket.id) || {};
        const safeSenderGroupImage =
          senderMeta.profileImageUrl ||
          getSafeProfileImageReference(senderMeta.profileImagePath) ||
          getSafeProfileImageReference(data?.senderProfileImagePath) ||
          getSafeProfileImageReference(data?.profileImagePath) ||
          getSafeProfileImageReference(data?.profile_image_path) ||
          null;
        const messageData = {
          userId: senderMeta.userId || data?.userId || '',
          userName: (senderMeta.userName || data?.userName || 'Unknown User').substring(0, 50),
          message: message ? message.substring(0, 1000) : null,
          mediaUrl: mediaUrl || null,
          mediaType: mediaType || null,
          senderProfileImagePath: safeSenderGroupImage,
          profileImagePath: safeSenderGroupImage,
          profileImageUrl: senderMeta.profileImageUrl || safeSenderGroupImage || null,
          avatarColor: senderMeta.avatarColor || data?.avatarColor || '#128C7E',
          avatarLetter: (senderMeta.avatarLetter || data?.avatarLetter || (senderMeta.userName ? senderMeta.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
          timestamp: Date.now(),
          messageId: serverMessageId,
          roomType: 'group',
          roomId: groupName,
        };

        if (data.replyTo && typeof data.replyTo === 'object') {
          const replyUserName = (data.replyTo.userName || data.replyTo.senderName || '').trim();
          const finalReplyUserName = replyUserName || data.replyTo.userId || 'Unknown User';
          messageData.replyTo = {
            messageId: data.replyTo.messageId || null,
            userName: finalReplyUserName.substring(0, 50),
            message: data.replyTo.message || null,
            timestamp: data.replyTo.timestamp || null,
            mediaUrl: data.replyTo.mediaUrl || data.replyTo.media || data.replyTo.media_url || null,
            mediaType: data.replyTo.mediaType || null,
            senderProfileImagePath: data.replyTo.senderProfileImagePath || data.replyTo.profileImagePath || data.replyTo.profile_image_path || null,
            avatarColor: data.replyTo.avatarColor || '#128C7E',
            avatarLetter: ((data.replyTo.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
            replyTo: data.replyTo.replyTo && typeof data.replyTo.replyTo === 'object'
              ? _sanitizeNestedReply(data.replyTo.replyTo)
              : null,
          };
        }

        socket.to(`group_${groupName}`).emit('group_message', messageData);
        if (callback) callback({ success: true, messageId: serverMessageId, timestamp: messageData.timestamp, data: messageData });
        return;
      }

      if (roomType === 'connection' || roomType === 'direct') {
        const targetRoomId = data.roomId || data.spaceId;
        if (!targetRoomId) {
          if (callback) callback({ success: false, error: 'Missing roomId for connection roomType' });
          return;
        }

        const roomSet = io.sockets.adapter.rooms.get(targetRoomId);
        if (!roomSet || !roomSet.has(socket.id)) {
          if (callback) callback({ success: false, error: 'Not in this connection room' });
          return;
        }

        const messageData = {
          ...data,
          roomType,
          roomId: targetRoomId,
          timestamp: Date.now(),
          messageId: data.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          senderId: socketMetadata.get(socket.id)?.userId || data?.userId || null,
          senderName: socketMetadata.get(socket.id)?.userName || data?.userName || 'Unknown User',
        };

        socket.to(targetRoomId).emit('room_message', messageData);
        if (callback) callback({ success: true, messageId: messageData.messageId, data: messageData });
        return;
      }

      if (callback) callback({ success: false, error: `Unsupported roomType: ${roomType}` });
    } catch (error) {
      Logger.error('send_room_message', 'Error routing room message', error.message);
      if (callback) callback({ success: false, error: 'Failed to send room message' });
    }
  });

  // User leaves group
  socket.on('leave_group', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet) {
        if (callback) callback({ success: false, error: 'Group not found' });
        return;
      }

      const wasInGroup = roomSet.has(socket.id);
      roomSet.delete(socket.id);
      socket.leave(`group_${groupName}`);

      const memberCount = roomSet.size;

      Logger.info('leave_group', 'User left group', {
        socketId: socket.id,
        userName: (data?.userName || 'Unknown User').substring(0, 50),
        groupName,
        memberCount,
        wasInGroup,
      });

      // Notify remaining users in group
      if (memberCount > 0) {
        // Build updated member list for remaining users
        const remainingMembers = [];
        for (const memberSocketId of roomSet) {
          const memberMeta = socketMetadata.get(memberSocketId) || {};
          remainingMembers.push({
            socketId: memberSocketId,
            userId: memberMeta.userId || '',
            userName: memberMeta.userName || 'Unknown User',
            avatarColor: memberMeta.avatarColor || '#128C7E',
            avatarLetter: memberMeta.avatarLetter || 'U',
            profileImagePath: memberMeta.profileImagePath || null,
            senderProfileImagePath: memberMeta.profileImagePath || null,
          });
        }

        io.to(`group_${groupName}`).emit('user_left_group', {
          groupName,
          userId: data?.userId || '',
          userName: (data?.userName || 'Unknown User').substring(0, 50),
          memberCount,
          capacity: CONFIG.GROUP_ROOM_CAPACITY || 10,
          roomName: groupName,
          allMembers: remainingMembers,
          timestamp: Date.now(),
        });
      } else {
        // Clean up empty room and its dedup cache
        groupChatRooms.delete(groupName);
        messageIdCache.delete(groupName); // Clean up dedup cache for empty group
        Logger.info('leave_group', 'Removed empty group room and cleaned cache', { groupName });
      }

      if (callback) {
        callback({
          success: true,
          groupName,
          memberCount,
          message: `Left ${groupName}`,
        });
      }
    } catch (error) {
      Logger.error('leave_group', 'Error leaving group', error.message);
      if (callback) callback({ success: false, error: 'Failed to leave group' });
    }
  });

}); // Close io.on('connection')

// Cleanup and maintenance intervals are created inside startServer() so they can be stopped cleanly.

// ✅ Register 404 and error handlers (MUST be LAST)
app.use(notFoundHandler);
app.use(errorHandler);



// ========== GRACEFUL SHUTDOWN ==========
// Handle graceful shutdown on SIGTERM/SIGINT (production standard signals)
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    Logger.warn('shutdown', 'Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  Logger.info('shutdown', `${signal} received, initiating graceful shutdown...`, {
    signal,
    timestamp: new Date().toISOString(),
    activeConnections: io.of('/').sockets.size,
  });

  try {
    // ✅ Step 1: Stop accepting new connections
    server.close(async () => {
      Logger.info('shutdown', 'HTTP server closed, no new connections accepted');
    });

    // ✅ Step 2: Disconnect all Socket.IO clients gracefully
    Logger.info('shutdown', 'Disconnecting Socket.IO clients...', {
      activeConnections: io.of('/').sockets.size,
    });
    
    const sockets = io.of('/').sockets;
    for (const [socketId, socket] of sockets) {
      try {
        socket.disconnect(true); // Force disconnect with reconnection disabled
      } catch (err) {
        Logger.warn('shutdown', 'Error disconnecting socket', {
          socketId,
          error: err.message,
        });
      }
    }
    Logger.info('shutdown', 'Socket.IO clients disconnected');

    // ✅ Step 3: Stop health monitoring
    if (health && health.stopMonitoring) {
      try {
        health.stopMonitoring();
        Logger.info('shutdown', 'Health monitoring stopped');
      } catch (err) {
        Logger.warn('shutdown', 'Error stopping health monitoring', { error: err.message });
      }
    }

    // ✅ Step 4: Clean shutdown without legacy database shutdown since DynamoDB is used
    Logger.info('shutdown', 'Skipping legacy database shutdown; using DynamoDB via AWS SDK');

    // ✅ Step 5: Clear in-memory state
    Logger.info('shutdown', 'Clearing in-memory state...', {
      videoPairings: videoPairings.size,
      chatPairings: chatPairings.size,
      videoQueue: videoQueue.length,
      chatQueue: chatQueue.length,
      groupRooms: groupChatRooms.size,
      socketMetadata: socketMetadata.size,
    });
    
    videoPairings.clear();
    chatPairings.clear();
    videoQueue.length = 0;
    chatQueue.length = 0;
    rooms.clear();
    groupChatRooms.clear();
    socketMetadata.clear();
    userSockets.clear();
    socketQueues.clear();
    rateLimitMap.clear();
    userGenderPreferences.clear();

    Logger.info('shutdown', '✅ Graceful shutdown completed successfully', {
      signal,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });

    process.exit(0);
  } catch (err) {
    Logger.error('shutdown', 'Error during graceful shutdown', {
      signal,
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
};

// Handle SIGTERM (production termination signal)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle SIGINT (Ctrl+C in development)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ========== ERROR HANDLING ==========
process.on('uncaughtException', (error) => {
  Logger.error('uncaughtException', 'Uncaught exception', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('unhandledRejection', 'Unhandled rejection', String(reason));
});

module.exports = { startServer, stopServer, getPort };
