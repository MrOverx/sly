const f = require('./utils/friendPayloadUtils');
const payload = {
  createdAt: "2026-07-10T17:29:05.435Z",
  isIncoming: false,
  receiver: { userId: "626842746", profileImageUrl: null, userName: "mrover" },
  requestId: "990692235|626842746",
  requestType: "FRIEND_REQUEST_OUTGOING",
  sender: { userId: "990692235", userName: "ankit" },
  status: "pending"
};
console.log(JSON.stringify(f.buildFriendRequestPayload(payload), null, 2));
