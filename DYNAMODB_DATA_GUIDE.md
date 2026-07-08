# DynamoDB Data Saving - Complete Guide

**Quick Links:**
- 📖 **Full Documentation**: [DYNAMODB_DUMMY_DATA_EXAMPLES.md](./DYNAMODB_DUMMY_DATA_EXAMPLES.md)
- 💻 **Practical Examples**: [dynamodb_dummy_data_examples.js](./dynamodb_dummy_data_examples.js)
- 🔧 **Source Code**: [utils/dynamoDBService.js](./utils/dynamoDBService.js)

---

## 🎯 What This Shows

How data flows through the DynamoDB saving logic in SLYXY backend:
- User registration and profile updates
- Friend request creation and status changes
- Friend acceptance transactions
- Notification creation and storage
- Data preservation patterns

---

## 📊 Data Structures Overview

### 1. **USER Record**
```javascript
{
  userId: "user123",
  userName: "john_doe",
  email: "john@example.com",
  friends: [],           // Friend list
  friendRequests: {},    // Sent/Received requests
  notifications: [],     // Activity notifications
  xp: {},               // Gaming data
  // ... 20+ profile fields
}
```
**Stored in**: `FRIEND` table (prefix: "USER")  
**Key**: `userId`

---

### 2. **FRIEND Item**
```javascript
{
  userId: "user123",
  friendId: "user456",
  status: "accepted",
  To: {                 // Rich profile snapshot
    userId: "user456",
    userName: "alice",
    profileImageUrl: "...",
    // ... profile data
  },
  RequestType: "FRIEND_REQUEST_OUTGOING",
  isRead: true
}
```
**Stored in**: `FRIEND` table (prefix: "FRIEND")  
**Key**: `userId` + `friendId`  
**Important**: Creates **2 records** per friendship (one per user's perspective)

---

### 3. **Notification Item**
```javascript
{
  fromUserId: "user456",
  toUserId: "user123",
  activity: "alice_wonder accepted your friend request",
  notificationUserId: "user456",
  notificationUserName: "alice_wonder",
  notificationUserImageUrl: "...",
  type: "friend_request_accepted",
  isRead: false,
  createdAt: "2024-07-08T09:20:00.000Z"
}
```
**Stored in**: USER record's `notifications` array  
**Synced to**: Frontend's `NotificationCenter`

---

## 🔄 Common Operations

### Operation 1: Register New User

**Input** (from registration form):
```javascript
{
  email: "john@example.com",
  userName: "john_doe",
  password: "plain_text"
}
```

**Processing** (buildUserItem() in dynamoDBService.js):
- Hash password with bcrypt
- Normalize email
- Set default avatarColor, interests, etc.
- Create timestamps

**Saved to DynamoDB**:
```javascript
{
  userId: "user123",
  email: "john@example.com",
  userName: "john_doe",
  passwordHash: "$2b$10$...",
  friends: [],
  friendRequests: { sent: [], received: [] },
  notifications: [],
  createdAt: "2024-07-08T14:30:00.000Z",
  // ... more fields
}
```

---

### Operation 2: Send Friend Request

**Input**:
```javascript
const senderUserId = "user123";
const recipientUserId = "user999";
```

**Process**:
1. Build FRIEND item with `status: "pending"`
2. Enrich with sender/recipient profiles
3. Save to FRIEND table (sender's perspective)
4. Save to FRIEND table (recipient's perspective)
5. Update both users' friendRequests arrays

**Saved Records**:
```javascript
// Record 1: Sender sees it as "outgoing"
{
  userId: "user123",
  friendId: "user999",
  status: "pending",
  RequestType: "FRIEND_REQUEST_OUTGOING",
  To: { /* recipient profile */ }
}

// Record 2: Recipient sees it as "incoming"
{
  userId: "user999",
  friendId: "user123",
  status: "pending",
  RequestType: "FRIEND_REQUEST_INCOMING",
  To: { /* sender profile */ }
}

// Both users' USER records updated
user123.friendRequests.sent.push({...})
user999.friendRequests.received.push({...})
```

---

### Operation 3: Accept Friend Request

**Transaction** (Atomic - all or nothing):

**Step 1**: Create FRIEND record (sender → recipient)
```javascript
{
  userId: "user123",
  friendId: "user999",
  status: "accepted",
  To: { /* recipient profile */ }
}
```

**Step 2**: Create FRIEND record (recipient → sender)
```javascript
{
  userId: "user999",
  friendId: "user123",
  status: "accepted",
  To: { /* sender profile */ }
}
```

**Step 3**: Update user123
```javascript
{
  friends: [{ friendId: "user999", status: "accepted" }],
  friendIds: ["user999"],
  notifications: [{
    fromUserId: "user999",
    activity: "user999 accepted your friend request"
  }]
}
```

**Step 4**: Update user999
```javascript
{
  friends: [{ friendId: "user123", status: "accepted" }],
  friendIds: ["user123"],
  friendRequests.received: [{ /* updated */ }]
}
```

---

## 🔑 Key Patterns Used in Code

### Pattern 1: Data Preservation (Spread Operator)
```javascript
// ✅ CORRECT - Preserves all existing data
const updated = {
  ...currentUser,          // All existing fields
  bio: newBio,            // Override only this
  updatedAt: now
};

// ❌ WRONG - Loses all fields except these two
const updated = {
  bio: newBio,
  updatedAt: now
};
```

### Pattern 2: Enrich Before Saving
```javascript
// Fetch profiles first
const senderUser = await getUserById(senderId);
const recipientUser = await getUserById(recipientId);

// Enrich with profile metadata
const enriched = buildFriendRequestReference(
  request,
  status,
  senderId,
  { senderUser, recipientUser }  // ← Pass profiles
);

// Save enriched version
await saveToDatabase(enriched);
```

### Pattern 3: Bidirectional Creation
```javascript
// Create TWO records for ONE friendship
await saveRecord({
  userId: "user123",
  friendId: "user456",
  RequestType: "FRIEND_REQUEST_OUTGOING"
});

await saveRecord({
  userId: "user456",
  friendId: "user123",
  RequestType: "FRIEND_REQUEST_INCOMING"
});
```

---

## 📝 File Structure

| File | Purpose | Size |
|------|---------|------|
| [DYNAMODB_DUMMY_DATA_EXAMPLES.md](./DYNAMODB_DUMMY_DATA_EXAMPLES.md) | Complete documentation with 10 sections | ~5 KB |
| [dynamodb_dummy_data_examples.js](./dynamodb_dummy_data_examples.js) | Runnable JavaScript examples | ~8 KB |
| [utils/dynamoDBService.js](./utils/dynamoDBService.js) | Actual implementation | ~45 KB |

---

## 🚀 How to Use

### View Dummy Data in Code
```bash
# Run the examples file to see available data
cd slyxyserver
node dynamodb_dummy_data_examples.js
```

### Import in Your Code
```javascript
const examples = require('./dynamodb_dummy_data_examples.js');

// Use dummy data for testing
const testUser = examples.EXAMPLE_USERS.activeUser;
const testNotif = examples.NOTIFICATION_EXAMPLES.friendRequestAccepted;
const transaction = examples.TRANSACTION_EXAMPLE.transaction;
```

### Reference Full Documentation
See [DYNAMODB_DUMMY_DATA_EXAMPLES.md](./DYNAMODB_DUMMY_DATA_EXAMPLES.md) for:
- Detailed field descriptions
- Complete flow examples
- Database operation summary
- Dev store format
- Rules and best practices

---

## 🎓 Understanding the Logic

### Why Bidirectional Records?
**Query Efficiency**: 
- Get all friends of user123: `Query where userId='user123'`
- Get all friends of user456: `Query where userId='user456'`
- Without bidirectional, second query would fail

### Why Rich Metadata?
**Avoid N+1 Queries**:
- Store profile snapshot in FRIEND record
- Don't need to fetch user profile again later
- Frontend has complete data immediately

### Why Transactions?
**Data Consistency**:
- Accept must update BOTH users or NEITHER
- If only one succeeds, friendship becomes broken
- TransactWrite ensures atomicity

### Why Preserve Data?
**Prevent Loss**:
- User has 100 fields
- Update only changes 2
- Without spread operator: lose 98 fields
- Pattern: `{ ...user, field1: newValue }`

---

## 🔗 Related Systems

**Friend Request Flow**:
```
Registration → Update Profile → Send Request → 
  Accept/Deny → Notification → Friends List
```

**Data Sync**:
```
Backend DynamoDB ←→ Frontend (SharedPreferences) ←→ Socket.IO Events
```

**Profile Hydration**:
```
Missing Profile → Batch Fetch → Cache → Display
```

---

## 📚 Learning Path

1. **Start here**: [DYNAMODB_DUMMY_DATA_EXAMPLES.md](./DYNAMODB_DUMMY_DATA_EXAMPLES.md) (Sections 1-4)
2. **See flows**: [DYNAMODB_DUMMY_DATA_EXAMPLES.md](./DYNAMODB_DUMMY_DATA_EXAMPLES.md) (Sections 5-6)
3. **Run examples**: `node dynamodb_dummy_data_examples.js`
4. **Review patterns**: [DYNAMODB_DUMMY_DATA_EXAMPLES.md](./DYNAMODB_DUMMY_DATA_EXAMPLES.md) (Section 6)
5. **Study code**: [utils/dynamoDBService.js](./utils/dynamoDBService.js)

---

## 🐛 Common Issues & Solutions

### ❌ "Cannot access 'senderUser' before initialization"
**Cause**: Fetching profiles AFTER using them  
**Fix**: Move profile fetch BEFORE transaction
```javascript
// ✅ Correct order
const senderUser = await getUserById(...);
await transaction({ senderUser });

// ❌ Wrong order
await transaction({ senderUser });
const senderUser = await getUserById(...);  // Too late!
```

### ❌ "Missing profile data in notifications"
**Cause**: Not enriching request with profile metadata  
**Fix**: Pass profiles to buildFriendRequestReference()
```javascript
// ✅ Enrich
const enriched = buildFriendRequestReference(request, status, userId, {
  senderUser, recipientUser
});

// ❌ Not enriched
const enriched = buildFriendRequestReference(request, status, userId);
```

### ❌ "Friend list gets cleared after update"
**Cause**: Not preserving existing fields  
**Fix**: Use spread operator
```javascript
// ✅ Preserve
await updateUserById(userId, {
  ...currentUser,
  bio: newBio
});

// ❌ Lost!
await updateUserById(userId, { bio: newBio });
```

---

## 📞 Quick Reference

**When to Create What**:
- **USER Record**: When user registers/updates profile
- **FRIEND Item**: When friends connect (sends 2 records)
- **Notification**: When significant event happens
- **Friend Request Ref**: When request status changes

**Transaction Needed For**:
- Accepting friendship (updates both users)
- Denying friendship (updates both users)
- Batch friend operations

**Data Preservation Required For**:
- Any user update
- Friend request status change
- Profile enrichment

---

**Last Updated**: 2024-07-08  
**SLYXY Platform** - Real-time Social Networking Backend
