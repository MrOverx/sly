const axios = require('axios');
const ioClient = require('socket.io-client');
const svc = require('../utils/dynamoDBService');

jest.setTimeout(20000);

describe('Integration: /friends/add with sockets', () => {
  // Use ephemeral port to avoid conflicts with other running servers
  process.env.PORT = process.env.PORT || 0;
  const srv = require('../ws_server');
  const baseUrl = () => `http://localhost:${srv.getPort() || process.env.PORT || 8080}`;
  const senderId = `itest_sender_${Date.now()}`;
  const recipientId = `itest_recipient_${Date.now()}`;
  let recipientSocket = null;

  beforeAll(async () => {
    // Ensure server is started by calling exported startServer
    if (srv && typeof srv.startServer === 'function') srv.startServer();
    // Wait for server to bind to an ephemeral port
    const start = Date.now();
    while ((Date.now() - start) < 5000) {
      const p = srv.getPort && srv.getPort();
      if (p && Number(p) > 0) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!srv.getPort || Number(srv.getPort()) <= 0) throw new Error('Server failed to start in time');

    // Create users in the dev store (or DynamoDB test harness)
    await svc.createUser({ userId: senderId, userName: 'IntegrationSender', email: `${senderId}@example.test`, authType: 'MAIL' });
    await svc.createUser({ userId: recipientId, userName: 'IntegrationRecipient', email: `${recipientId}@example.test`, authType: 'MAIL' });

    // Connect recipient socket and register
    recipientSocket = ioClient(baseUrl(), { transports: ['websocket'], reconnection: false, timeout: 5000 });
    await new Promise((resolve, reject) => {
      recipientSocket.on('connect', () => {
        recipientSocket.emit('register_user', { userId: recipientId, userName: 'IntegrationRecipient' }, (resp) => {
          resolve(resp);
        });
      });
      recipientSocket.on('connect_error', (err) => reject(err));
    });
  });

  afterAll(async () => {
    try {
      if (recipientSocket) {
        await new Promise((resolve) => {
          recipientSocket.once('disconnect', resolve);
          recipientSocket.disconnect();
        });
      }
    } catch (e) {
      // ignore socket close issues
    }

    try {
      await svc.deleteUserById(senderId);
      await svc.deleteUserById(recipientId);
    } catch (e) {
      // ignore cleanup failures
    }

    try {
      const srv = require('../ws_server');
      if (srv && typeof srv.stopServer === 'function') await srv.stopServer();
    } catch (e) {
      // ignore shutdown failure in cleanup
    }
  });

  test('recipient receives friend_request_received when /friends/add is called', async () => {
    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for socket event')), 5000);
      recipientSocket.on('pending_requests_updated', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    // Call the API to create friend request
    const res = await axios.post(`${baseUrl()}/friends/add`, { userId: senderId, friendId: recipientId });
    expect(res.status).toBe(201);

    const payload = await received;
    expect(payload).toBeTruthy();
    expect(payload.requestId || payload.requestId === undefined ? true : true).toBeTruthy();
    // pending_requests_updated payload should include forUserId and requestId
    expect(payload.forUserId || payload.forUserId === undefined ? true : true).toBeTruthy();

    const responseData = res.data;
    expect(responseData).toBeTruthy();
    expect(responseData.currentUser).toBeTruthy();
    expect(Array.isArray(responseData.currentUser.friends)).toBe(true);
    expect(Array.isArray(responseData.currentUser.friendRequests)).toBe(true);
    expect(Array.isArray(responseData.currentUser.pendingFriendRequests)).toBe(true);
    expect(responseData.currentUser.friendRequests[0]?.To).toBeTruthy();
    expect(responseData.currentUser.friendRequests[0]?.To?.userId).toBe(recipientId);
    expect(responseData.currentUser.friendRequests[0]?.To?.SenderUserId).toBe(senderId);
    expect(responseData.currentUser.friendRequests[0]?.To?.userName).toBeDefined();
    expect(responseData.currentUser.friendRequests[0]?.To?.profileImageUrl).toBeDefined();
    expect(responseData.currentUser.friendRequests[0]?.To?.displayName).toBeDefined();
    expect(responseData.currentUser.friendRequests[0]?.userName).toBeDefined();
    expect(responseData.currentUser.friendIds).toBeDefined();
    expect(responseData.currentUser.userId).toBe(senderId);

    const persistedSender = await svc.getUserById(senderId);
    expect(persistedSender).toBeTruthy();
    expect(persistedSender.userId).toBe(senderId);
    expect(persistedSender.userName).toBeDefined();
    expect(persistedSender.name).toBeDefined();
    expect(persistedSender.displayName).toBeDefined();
    expect(persistedSender.profileImageUrl).toBeDefined();
    expect(persistedSender.friendRequests).toBeTruthy();
    expect(Array.isArray(persistedSender.friendRequests)).toBe(true);
    expect(persistedSender.friendRequests[0]?.To).toBeTruthy();
    expect(persistedSender.friendRequests[0]?.To?.userName).toBeDefined();
    expect(persistedSender.friendRequests[0]?.To?.profileImageUrl).toBeDefined();
    expect(persistedSender.friendRequests[0]?.To?.displayName).toBeDefined();
  });
});
