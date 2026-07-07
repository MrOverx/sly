const svc = require('./utils/dynamoDBService');
const fs = require('fs');
const path = require('path');
(async () => {
  const senderId = 'debug_sender_123';
  const recipientId = 'debug_recipient_123';
  try {
    const sender = await svc.getUserById(senderId);
    if (sender) await svc.deleteUserById(senderId);
    const recipient = await svc.getUserById(recipientId);
    if (recipient) await svc.deleteUserById(recipientId);
  } catch (err) {
    console.error('cleanup error', err);
  }
  try {
    await svc.createUser({ userId: senderId, userName: 'Debug Sender', email: `${senderId}@example.com`, authType: 'MAIL' });
    await svc.createUser({ userId: recipientId, userName: 'Debug Recipient', email: `${recipientId}@example.com`, authType: 'MAIL' });
    const req = await svc.createFriendRequest(senderId, recipientId, {});
    console.log('created friend request', req);
    const senderUser = await svc.getUserById(senderId);
    const recipientUser = await svc.getUserById(recipientId);
    console.log('senderUser itemType', senderUser?.itemType);
    console.log('senderUser full', JSON.stringify(senderUser, null, 2));
    console.log('recipientUser itemType', recipientUser?.itemType);
    console.log('recipientUser full', JSON.stringify(recipientUser, null, 2));
    const devStorePath = path.resolve(__dirname, 'dev_dynamo_users.json');
    const raw = fs.readFileSync(devStorePath, 'utf8');
    const items = JSON.parse(raw);
    console.log('devStore item count', items.length);
    console.log('sender raw dev item', JSON.stringify(items.find(it => it.itemType === 'USER' && it.userId === senderId), null, 2));
    console.log('recipient raw dev item', JSON.stringify(items.find(it => it.itemType === 'USER' && it.userId === recipientId), null, 2));
  } catch (err) {
    console.error('test error', err);
  }
})();
