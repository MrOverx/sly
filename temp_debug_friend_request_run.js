const svc = require('./utils/dynamoDBService');
const fs = require('fs');
const path = require('path');
(async () => {
  const senderId = `debug_sender_${Date.now()}`;
  const recipientId = `debug_recipient_${Date.now()}`;
  try {
    // Remove any old test users by userId, using find/filter on dev store directly.
    const devPath = path.resolve(__dirname, 'dev_dynamo_users.json');
    const items = JSON.parse(fs.readFileSync(devPath, 'utf8') || '[]');
    const filtered = items.filter((it) => !(it.itemType === 'USER' && (it.userId === senderId || it.userId === recipientId)));
    fs.writeFileSync(devPath, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
  try {
    const senderBefore = await svc.getUserById('debug_sender_123');
    if (senderBefore) await svc.deleteUserById('debug_sender_123');
    const recipientBefore = await svc.getUserById('debug_recipient_123');
    if (recipientBefore) await svc.deleteUserById('debug_recipient_123');
  } catch (e) {
    // ignore
  }
  try {
    await svc.createUser({
      userId: senderId,
      userName: 'DebugSender',
      email: `${senderId}@example.test`,
      authType: 'MAIL',
      avatarColor: '#FF0000',
      avatarLetter: 'D',
      country: 'USA',
      status: 'Testing',
      profileImageUrl: 'https://example.com/s.png',
      profileImagePath: 'https://example.com/s.png',
      interests: ['music'],
      xp: { base: 10 },
    });
    await svc.createUser({
      userId: recipientId,
      userName: 'DebugRecipient',
      email: `${recipientId}@example.test`,
      authType: 'MAIL',
      avatarColor: '#00FF00',
      avatarLetter: 'R',
      country: 'USA',
      status: 'Testing',
      profileImageUrl: 'https://example.com/r.png',
      profileImagePath: 'https://example.com/r.png',
      interests: ['travel'],
      xp: { base: 20 },
    });
    const senderBefore = await svc.getUserById(senderId);
    const recipientBefore = await svc.getUserById(recipientId);
    console.log('BEFORE SENDER was full user:', !!senderBefore && senderBefore.itemType === 'USER');
    console.log('BEFORE RECIPIENT was full user:', !!recipientBefore && recipientBefore.itemType === 'USER');
    const req = await svc.createFriendRequest(senderId, recipientId, { senderUser: senderBefore, recipientUser: recipientBefore });
    console.log('FRIEND_REQ', JSON.stringify(req, null, 2));
    const senderAfter = await svc.getUserById(senderId);
    const recipientAfter = await svc.getUserById(recipientId);
    console.log('AFTER SENDER itemType', senderAfter?.itemType);
    console.log('AFTER SENDER friendRequests length', senderAfter?.friendRequests?.length);
    console.log('AFTER SENDER full:', JSON.stringify(senderAfter, null, 2));
    console.log('AFTER RECIPIENT itemType', recipientAfter?.itemType);
    console.log('AFTER RECIPIENT full:', JSON.stringify(recipientAfter, null, 2));
    const items = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'dev_dynamo_users.json'), 'utf8'));
    console.log('ALL ITEMS count', items.length);
    console.log('LATEST ITEMS', items.slice(-5).map((i) => ({ itemType: i.itemType, userId: i.userId, PK: i.PK, SK: i.SK, friendId: i.friendId })));
  } catch (err) {
    console.error('ERROR', err && err.message, err.stack);
  }
})();
