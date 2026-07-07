const svc = require('./utils/dynamoDBService');
(async () => {
  const senderId = 'debug_sender_123';
  const recipientId = 'debug_recipient_123';

  try { await svc.deleteUserById(senderId); } catch (e) { }
  try { await svc.deleteUserById(recipientId); } catch (e) { }

  await svc.createUser({ userId: senderId, userName: 'DebugSender', email: `${senderId}@example.test`, authType: 'MAIL' });
  await svc.createUser({ userId: recipientId, userName: 'DebugRecipient', email: `${recipientId}@example.test`, authType: 'MAIL' });

  const senderUser = await svc.getUserById(senderId);
  const recipientUser = await svc.getUserById(recipientId);
  const request = await svc.createFriendRequest(senderId, recipientId, { senderUser, recipientUser });
  const sender = await svc.getUserById(senderId);
  console.log('request', JSON.stringify(request, null, 2));
  console.log('sender.friendRequests', JSON.stringify(sender.friendRequests, null, 2));
})();
