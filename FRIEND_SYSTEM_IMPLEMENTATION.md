# Friend System Implementation Guide

## Overview
This document describes the complete friend request and friend list system for SLYXY.com backend, designed to match the frontend `UserModel` structure.

## Frontend Data Structures (Reference)

### FriendRef (Lightweight Friend Reference)
```dart
class FriendRef {
  final String friendId;
  final DateTime? addedAt;
}
```

### FriendRequestModel (Complete Friend Request)
```dart
class FriendRequestModel {
  final String requestId;           // "userId|targetUserId"
  final String userId;              // sender
  final String targetUserId;        // recipient
  final String status;              // 'pending'|'accepted'|'denied'
  final DateTime? createdAt;
  final String requestType;         // FRIEND_REQUEST_OUTGOING/INCOMING
  final bool isRead;
  final bool isReadByReceiver;
  final Map<String, dynamic>? sender;      // Full profile for display
  final Map<String, dynamic>? receiver;    // Full profile for display
}
```

### UserModel Friend Fields
```dart
class UserModel {
  final List<FriendRef> friends;              // Lightweight friend list
  final List<FriendRequestModel> friendRequests;  // All pending requests
  
  List<String> get friendIds => friends.map((f) => f.friendId).toList();
}
```

---

## Backend DynamoDB Schema

### 1. FRIEND_REQUEST Item (For Pending Requests)
```
PK: FRIEND#<userId>          (sender's ID)
SK: FRIEND#<targetUserId>    (recipient's ID)

Attributes:
- itemType: "FRIEND_REQUEST"
- requestId: "<userId>|<targetUserId>"
- userId: <sender's ID>
- targetUserId: <recipient's ID>
- status: "pending"|"accepted"|"denied"
- createdAt: ISO8601 timestamp
- updatedAt: ISO8601 timestamp
- isRead: boolean
- isReadByReceiver: boolean
- senderProfile: { userId, userName, ... }
- recipientProfile: { userId, userName, ... }
```

### 2. USER Item - Friends List (Updated on Accept)
```
PK: USER#<userId>
SK: METADATA

Attributes (added/updated on accept):
- friends: [
    { friendId: "<id1>", addedAt: "2026-07-08T..." },
    { friendId: "<id2>", addedAt: "2026-07-08T..." }
  ]
- friendIds: ["<id1>", "<id2>"]  // Denormalized for fast lookup
```

---

## API Endpoints

### 1. Send Friend Request
**POST /friends/request/send**

**Request:**
```json
{
  "userId": "user123",
  "targetUserId": "user456"
}
```

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "request": {
      "requestId": "user123|user456",
      "userId": "user123",
      "targetUserId": "user456",
      "status": "pending",
      "createdAt": "2026-07-08T12:00:00Z"
    }
  },
  "message": "Friend request sent successfully"
}
```

**Error Cases:**
- 400: userId/targetUserId missing or invalid
- 400: Cannot send request to yourself
- 404: User not found
- 409: Already friends
- 409: Request already pending

---

### 2. Accept Friend Request
**POST /friends/request/accept**

**Request:**
```json
{
  "requestId": "user123|user456"
}
```

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "currentUser": { /* full user profile with updated friendIds */ },
    "friend": { /* sender's profile */ }
  },
  "message": "Friend request accepted"
}
```

**Backend Operations:**
1. Find FRIEND_REQUEST item by requestId
2. Update request status to "accepted"
3. Add both users to each other's friend lists:
   - User123: friends array += { friendId: "user456", addedAt: now }
   - User456: friends array += { friendId: "user123", addedAt: now }

---

### 3. Deny Friend Request
**POST /friends/request/deny**

**Request:**
```json
{
  "requestId": "user123|user456"
}
```

**Response (Success):**
```json
{
  "success": true,
  "data": {},
  "message": "Friend request denied"
}
```

**Backend Operations:**
1. Delete FRIEND_REQUEST item
2. No changes to friend lists

---

### 4. Cancel Outgoing Request
**POST /friends/request/cancel**

**Request:**
```json
{
  "requestId": "user123|user456"
}
```

**Backend Operations:**
- Same as deny (delete FRIEND_REQUEST)

---

### 5. Remove Friend
**POST /friends/remove**

**Request:**
```json
{
  "userId": "user123",
  "friendId": "user456"
}
```

**Response (Success):**
```json
{
  "success": true,
  "data": {},
  "message": "Friend removed successfully"
}
```

**Backend Operations:**
1. Remove from User123's friends list (filter out user456)
2. Remove from User456's friends list (filter out user123)

---

### 6. Get Friends List
**GET /friends/list?userId=user123**

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "friends": [
      {
        "userId": "user456",
        "userName": "Alice",
        "avatarColor": "#1A73E8",
        "profileImageUrl": "...",
        ...
      }
    ],
    "count": 1
  },
  "message": "Friends list retrieved"
}
```

---

### 7. Get Incoming Friend Requests
**GET /friends/requests/incoming?userId=user123**

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "requests": [
      {
        "requestId": "user789|user123",
        "userId": "user789",
        "targetUserId": "user123",
        "status": "pending",
        "createdAt": "2026-07-08T11:00:00Z",
        "sender": { /* full user profile */ }
      }
    ],
    "count": 1
  },
  "message": "Incoming friend requests retrieved"
}
```

---

### 8. Get Outgoing Friend Requests
**GET /friends/requests/outgoing?userId=user123**

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "requests": [
      {
        "requestId": "user123|user456",
        "userId": "user123",
        "targetUserId": "user456",
        "status": "pending",
        "createdAt": "2026-07-08T12:00:00Z",
        "recipient": { /* full user profile */ }
      }
    ],
    "count": 1
  },
  "message": "Outgoing friend requests retrieved"
}
```

---

## Persistence Layer Functions

### createFriendRequest(userId, targetUserId, metadata)
Creates a new friend request item.
- **Parameters:**
  - userId: Sender's ID
  - targetUserId: Recipient's ID
  - metadata: Optional { senderProfile, recipientProfile }
- **Returns:** Request item or null on error

### getFriendRequest(userId, targetUserId)
Retrieves a specific friend request.
- **Returns:** Request item or null

### queryFriendRequestsForUser(userId, direction)
Fetches pending requests for a user.
- **Parameters:**
  - direction: 'incoming' (requests TO user) or 'outgoing' (requests FROM user)
- **Returns:** Array of request items

### acceptFriendRequest(userId, targetUserId)
Accepts a friend request and updates both users' friend lists.
- **Operations:**
  1. Mark request as "accepted"
  2. Add targetUserId to userId's friends
  3. Add userId to targetUserId's friends

### denyFriendRequest(userId, targetUserId)
Rejects/deletes a friend request.
- **Operations:** Delete FRIEND_REQUEST item

### removeFriend(userId, friendId)
Removes a friend from both users' lists.
- **Operations:**
  1. Filter out friendId from userId's friends list
  2. Filter out userId from friendId's friends list

### listFriends(userId)
Returns all friend IDs for a user.
- **Returns:** Array of friend IDs

---

## Data Flow Examples

### Example 1: Send Friend Request
```
User123 → POST /friends/request/send { userId: "user123", targetUserId: "user456" }
         ↓
[Backend] createFriendRequest(user123, user456)
         ↓
[DynamoDB] INSERT FRIEND_REQUEST item
  PK: FRIEND#user123
  SK: FRIEND#user456
  status: pending
         ↓
[Response] requestId: "user123|user456", status: "pending"
         ↓
[Frontend] Store in currentUser.friendRequests
```

### Example 2: Accept Friend Request
```
User456 → POST /friends/request/accept { requestId: "user123|user456" }
         ↓
[Backend] acceptFriendRequest(user123, user456)
         ↓
[DynamoDB]
  1. UPDATE FRIEND_REQUEST status → "accepted"
  2. UPDATE USER#user123 friends += { friendId: user456, addedAt: now }
  3. UPDATE USER#user456 friends += { friendId: user123, addedAt: now }
         ↓
[Response] 
  currentUser: { friendIds: [..., user123], friends: [...] }
  friend: { userId: user123, userName: ... }
         ↓
[Frontend] 
  - Update currentUser.friends (add FriendRef)
  - Remove from friendRequests
  - Show in Chat tab as friend
```

### Example 3: Remove Friend
```
User123 → POST /friends/remove { userId: user123, friendId: user456 }
         ↓
[Backend] removeFriend(user123, user456)
         ↓
[DynamoDB]
  1. UPDATE USER#user123 friends -= { friendId: user456 }
  2. UPDATE USER#user456 friends -= { friendId: user123 }
         ↓
[Response] { success: true, message: "Friend removed" }
         ↓
[Frontend]
  - Remove from currentUser.friends
  - No longer appears in Chat tab
```

---

## Status Transitions

```
┌─────────────┐
│   PENDING   │ ← Initial state after request creation
└──────┬──────┘
       │
       ├─→ ACCEPTED (on acceptFriendRequest)
       │   - Both users' friend lists updated
       │   - Request remains in DB (historical)
       │
       └─→ DENIED (on denyFriendRequest or cancelFriendRequest)
           - Request deleted from DB
           - No friend relationship created
```

---

## Performance Optimizations

### 1. Denormalized friendIds
- Store both `friends` (full refs) and `friendIds` (IDs only)
- friendIds used for fast "is friend?" checks
- friends used for frontend display

### 2. Lightweight Friend References
- Store only { friendId, addedAt } in friends array
- Fetch full profiles on-demand when needed

### 3. Batch Profile Retrieval
- Use getUsersByIds() to fetch multiple friend profiles in one DB call
- Avoid N+1 queries

### 4. Caching
- Frontend caches friend profiles in UserModel
- Backend can implement user cache for frequently accessed profiles

### 5. Efficient Queries
- Use secondary indexes for direction-based queries (incoming/outgoing)
- Scan with FilterExpression (acceptable for small friend counts)

---

## Error Handling

### Common Errors

| Error | HTTP | Cause | Solution |
|-------|------|-------|----------|
| VALIDATION_ERROR | 400 | Missing/invalid parameters | Check request body |
| INVALID_REQUEST | 400 | Self-friend, duplicate request | Validate logic |
| USER_NOT_FOUND | 404 | User doesn't exist | Create user first |
| REQUEST_NOT_FOUND | 404 | No pending request to accept | Verify requestId |
| ALREADY_FRIENDS | 409 | Users already friends | Skip or show UI message |
| REQUEST_PENDING | 409 | Request already pending | Show duplicate prevention |
| DB_NOT_CONNECTED | 503 | Database unavailable | Retry later |

---

## No Data Loss Guarantees

✅ **Old Data Preservation:**
- Accepting a request does NOT delete anything
  - Previous friend list items remain
  - New friend is appended to list
  - Request status updated (not deleted)

✅ **User Profiles Preserved:**
- User data (userId, userName, email, etc.) never deleted by friend operations
- Only friend list arrays are modified

✅ **Request History:**
- Even after acceptance, request items remain in DB (for audit/history)
- Frontend can filter by status to show only pending requests

---

## Testing Checklist

- [ ] Send friend request between two users
- [ ] Accept friend request (both users see each other as friends)
- [ ] Deny friend request (request deleted, no friend relationship)
- [ ] Cancel outgoing request
- [ ] Remove friend (both users' lists updated)
- [ ] Query incoming requests (shows only requests TO current user)
- [ ] Query outgoing requests (shows only requests FROM current user)
- [ ] Get friends list (returns only accepted friends)
- [ ] Verify no data loss on operations
- [ ] Test with multiple requests/friends
- [ ] Verify profile enrichment in responses
