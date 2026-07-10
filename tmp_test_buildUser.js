const d = require('./utils/dynamoDBService');
const user = {
  userId: 'u1',
  friendRequests: [
    {
      createdAt: '2026-07-10T17:29:05.435Z',
      sender: { userId: '990692235', userName: 'ankit', profile_image_url: null },
      receiver: { userId: '626842746', userName: 'mrover', profile_image_url: null },
    }
  ]
};
const item = d.buildUserItem(user);
console.log(JSON.stringify((item.friendRequests || []).map(fr => ({ requestId: fr.requestId, sender: fr.sender, receiver: fr.receiver })), null, 2));
