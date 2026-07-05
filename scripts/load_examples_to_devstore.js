const path = require('path');
const fs = require('fs');
const svc = require('../utils/dynamoDBService');

async function load() {
  const p = path.resolve(__dirname, '..', 'examples', 'dummy_users_and_requests.json');
  if (!fs.existsSync(p)) {
    console.error('Examples file not found:', p);
    process.exit(1);
  }

  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);

  if (!svc.isDevStoreEnabled()) {
    console.warn('[load_examples_to_devstore] Dev store is not enabled. This script will only run against the local JSON dev store.');
    console.warn('Set USE_DEV_STORE=true or run in test environment to use the dev store. Aborting.');
    process.exit(1);
  }

  const users = Array.isArray(data.users) ? data.users : [];
  const requests = Array.isArray(data.friendRequests) ? data.friendRequests : [];

  for (const u of users) {
    try {
      const created = await svc.createUser(u);
      console.log('[load] Created user:', created.userId);
    } catch (err) {
      if (String(err.message || err) === 'USER_EXISTS') {
        console.log('[load] User already exists, skipping:', u.userId);
      } else {
        console.error('[load] Failed to create user', u.userId, err && err.message);
      }
    }
  }

  for (const r of requests) {
    try {
      const created = await svc.createFriendRequest(r.userId, r.recipientId);
      console.log('[load] Created friend request:', created.requestId);
      if (r.status && String(r.status).toLowerCase() === 'accepted') {
        await svc.updateFriendRequestStatus(r.userId, r.recipientId, 'accepted');
        console.log('[load] Marked request accepted:', created.requestId);
      }
    } catch (err) {
      console.error('[load] Failed to create friend request', r && r.requestId, err && err.message);
    }
  }

  console.log('[load] Done.');
  process.exit(0);
}

load().catch((err) => {
  console.error('Script error:', err && err.message);
  process.exit(1);
});
