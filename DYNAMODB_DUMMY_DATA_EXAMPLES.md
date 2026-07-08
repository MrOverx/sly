# DynamoDB Dummy Data Examples - SLYXY Backend

Complete guide showing how data is saved to DynamoDB with real examples from the dynamoDBService.js logic.

---

## 1. USER DATA STRUCTURE

### Dummy User Data (What Goes Into Database)

```javascript
{
  // Primary Key (DynamoDB)
  userId: "user123",
  itemType: "USER",
  
  // Profile Information
  userName: "john_doe",
  name: "John Doe",
  displayName: "John Doe",
  email: "john@example.com",
  normalizedEmail: "john@example.com",
  emailLower: "john@example.com",
  emailVerified: true,
  emailVerifiedAt: "2024-01-15T10:30:00.000Z",
  
  // Authentication
  authType: "MAIL",  // Can be: MAIL, GOOGLE_OAUTH, LOCAL, GUEST
  passwordHash: "$2b$10$encrypted_hash_here",
  isGuest: false,
  
  // Profile Details
  gender: "male",
  country: "India",
  bio: "Love meeting new people and gaming!",
  interests: ["gaming", "photography", "travel"],
  birthDate: "1995-06-20T00:00:00.000Z",
  status: "active",  // active, inactive, busy
  statusUpdatedAt: "2024-07-08T14:22:30.000Z",
  
  // Avatar & Profile Image
  avatarColor: "#128C7E",
  avatarLetter: "J",
  useColorProfile: true,
  profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
  profileImagePath: "/profile-images/user123/profile.jpg",
  profile_image_url: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
  profile_image_path: "/profile-images/user123/profile.jpg",
  avatarUrl: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
  pictureName: "profile.jpg",
  hasProfileChanged: true,
  
  // Social & Gaming
  isFriend: false,
  isOnline: true,
  xp: {
    total: 2500,
    level: 5,
    daily: 150,
    weekly: 1200
  },
  likedUserIds: ["user456", "user789"],
  
  // Friends Management
  friendIds: ["user456", "user789", "user111"],
  friends: [
    {
      friendId: "user456",
      status: "accepted",
      addedAt: "2024-06-01T12:00:00.000Z",
      To: {
        userId: "user456",
        userName: "alice_wonder",
        profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user456/profile.jpg",
        avatarColor: "#FF6B6B",
        avatarLetter: "A"
      }
    },
    {
      friendId: "user789",
      status: "accepted",
      addedAt: "2024-05-15T08:30:00.000Z",
      To: {
        userId: "user789",
        userName: "bob_builder",
        profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user789/profile.jpg",
        avatarColor: "#4ECDC4",
        avatarLetter: "B"
      }
    }
  ],
  
  // Friend Requests
  friendRequests: {
    sent: [
      {
        requestId: "user123|user999",
        userId: "user123",
        senderId: "user123",
        recipientId: "user999",
        friendId: "user999",
        status: "pending",
        RequestType: "FRIEND_REQUEST_OUTGOING",
        ReceiverIdUserId: "user999",
        isRead: false,
        createdAt: "2024-07-07T16:45:00.000Z",
        updatedAt: "2024-07-07T16:45:00.000Z",
        To: {
          userId: "user999",
          userName: "charlie_brown",
          profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user999/profile.jpg",
          avatarColor: "#95E1D3",
          avatarLetter: "C"
        }
      }
    ],
    received: [
      {
        requestId: "user222|user123",
        userId: "user222",
        senderId: "user222",
        recipientId: "user123",
        friendId: "user222",
        status: "pending",
        RequestType: "FRIEND_REQUEST_INCOMING",
        ReceiverIdUserId: "user123",
        isRead: true,
        createdAt: "2024-07-06T10:15:00.000Z",
        updatedAt: "2024-07-06T10:15:00.000Z",
        To: {
          userId: "user222",
          userName: "diana_prince",
          profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user222/profile.jpg",
          avatarColor: "#F38181",
          avatarLetter: "D"
        }
      }
    ]
  },
  
  // Notifications
  notifications: [
    {
      id: "notif-uuid-1",
      fromUserId: "user456",
      toUserId: "user123",
      activity: "user456 accepted your friend request",
      notificationUserId: "user456",
      notificationUserName: "alice_wonder",
      notificationUserImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user456/profile.jpg",
      notificationUserAvatarColor: "#FF6B6B",
      notificationUserAvatarLetter: "A",
      type: "friend_request_accepted",
      isRead: false,
      createdAt: "2024-07-08T09:20:00.000Z",
      priority: "normal"
    }
  ],
  
  // Account Status
  isActive: true,
  profileComplete: true,
  
  // XP & Rewards
  lastDailyXpAwardedAt: "2024-07-08T00:00:00.000Z",
  
  // Timestamps
  createdAt: "2024-01-15T10:00:00.000Z",
  updatedAt: "2024-07-08T14:22:30.000Z",
  lastLogin: "2024-07-08T14:22:30.000Z"
}
```

---

## 2. FRIEND ITEM STRUCTURE (Separate Record)

### How Friend Connections Are Stored

```javascript
// FRIEND Item for user123's perspective of user456
{
  userId: "user123",
  friendId: "user456",
  itemType: "FRIEND",
  
  // Request Metadata
  requestId: "user123|user456",
  senderId: "user123",
  recipientId: "user456",
  status: "accepted",
  
  // Reference Data (Rich Profile Snapshot)
  To: {
    userId: "user456",
    userName: "alice_wonder",
    name: "Alice Wonder",
    email: "alice@example.com",
    avatarColor: "#FF6B6B",
    avatarLetter: "A",
    profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user456/profile.jpg",
    profileImagePath: "/profile-images/user456/profile.jpg",
    gender: "female",
    country: "USA",
    bio: "Photography enthusiast",
    status: "active"
  },
  
  // Request Type Markers
  RequestType: "FRIEND_REQUEST_OUTGOING",
  ReceiverIdUserId: "user456",
  isRead: true,
  
  // Timestamps
  friendIndexKey: "FRIEND_BY_FRIEND#user456",
  createdAt: "2024-06-01T12:00:00.000Z",
  updatedAt: "2024-06-15T10:30:00.000Z"
}

// Same friendship from user456's perspective (separate record)
{
  userId: "user456",
  friendId: "user123",
  itemType: "FRIEND",
  
  requestId: "user456|user123",
  senderId: "user456",
  recipientId: "user123",
  status: "accepted",
  
  To: {
    userId: "user123",
    userName: "john_doe",
    name: "John Doe",
    email: "john@example.com",
    avatarColor: "#128C7E",
    avatarLetter: "J",
    profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
    profileImagePath: "/profile-images/user123/profile.jpg",
    gender: "male",
    country: "India",
    bio: "Love meeting new people and gaming!",
    status: "active"
  },
  
  RequestType: "FRIEND_REQUEST_INCOMING",
  ReceiverIdUserId: "user123",
  isRead: true,
  
  friendIndexKey: "FRIEND_BY_FRIEND#user123",
  createdAt: "2024-06-01T12:00:00.000Z",
  updatedAt: "2024-06-15T10:30:00.000Z"
}
```

---

## 3. FRIEND REQUEST REFERENCE STRUCTURE

### Pending Friend Request (Not Yet Accepted)

```javascript
{
  requestId: "user123|user999",
  userId: "user123",
  senderId: "user123",
  recipientId: "user999",
  friendId: "user999",
  status: "pending",
  
  RequestType: "FRIEND_REQUEST_OUTGOING",
  ReceiverIdUserId: "user999",
  isRead: false,
  
  To: {
    userId: "user999",
    userName: "charlie_brown",
    name: "Charlie Brown",
    profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user999/profile.jpg",
    avatarColor: "#95E1D3",
    avatarLetter: "C",
    email: "charlie@example.com",
    gender: "male",
    country: "UK",
    status: "active"
  },
  
  createdAt: "2024-07-07T16:45:00.000Z",
  updatedAt: "2024-07-07T16:45:00.000Z"
}
```

### Received Pending Request (Incoming)

```javascript
{
  requestId: "user222|user123",
  userId: "user222",
  senderId: "user222",
  recipientId: "user123",
  friendId: "user222",
  status: "pending",
  
  RequestType: "FRIEND_REQUEST_INCOMING",
  ReceiverIdUserId: "user123",
  isRead: true,
  
  To: {
    userId: "user222",
    userName: "diana_prince",
    name: "Diana Prince",
    profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user222/profile.jpg",
    avatarColor: "#F38181",
    avatarLetter: "D",
    email: "diana@example.com",
    gender: "female",
    country: "Greece",
    status: "active"
  },
  
  createdAt: "2024-07-06T10:15:00.000Z",
  updatedAt: "2024-07-06T10:15:00.000Z"
}
```

---

## 4. NOTIFICATION DATA STRUCTURE

### Friend Request Accepted Notification

```javascript
{
  id: "notif-uuid-12345",
  fromUserId: "user456",
  toUserId: "user123",
  activity: "alice_wonder accepted your friend request",
  
  notificationUserId: "user456",
  notificationUserName: "alice_wonder",
  notificationUserImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user456/profile.jpg",
  notificationUserAvatarColor: "#FF6B6B",
  notificationUserAvatarLetter: "A",
  
  type: "friend_request_accepted",
  isRead: false,
  
  createdAt: "2024-07-08T09:20:00.000Z",
  updatedAt: "2024-07-08T09:20:00.000Z",
  
  priority: "normal"
}
```

### Direct Message Notification

```javascript
{
  id: "notif-uuid-67890",
  fromUserId: "user789",
  toUserId: "user123",
  activity: "bob_builder sent you a message: 'Hey! How are you?'",
  
  notificationUserId: "user789",
  notificationUserName: "bob_builder",
  notificationUserImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user789/profile.jpg",
  notificationUserAvatarColor: "#4ECDC4",
  notificationUserAvatarLetter: "B",
  
  type: "direct_message",
  isRead: false,
  
  createdAt: "2024-07-08T11:15:00.000Z",
  updatedAt: "2024-07-08T11:15:00.000Z",
  
  messageId: "msg-uuid-123",
  priority: "high"
}
```

---

## 5. COMPLETE FLOW EXAMPLES

### Example 1: Creating a New User

```javascript
// Input data from registration
const registrationData = {
  userId: "user123",
  email: "john@example.com",
  userName: "john_doe",
  password: "plain_text_password",
  authType: "MAIL"
};

// buildUserItem() processes it into:
const userRecord = {
  userId: "user123",
  userName: "john_doe",
  email: "john@example.com",
  normalizedEmail: "john@example.com",
  emailLower: "john@example.com",
  passwordHash: "$2b$10$hashed_by_bcrypt",
  authType: "MAIL",
  emailVerified: false,
  isGuest: false,
  gender: "other",
  country: null,
  status: null,
  bio: null,
  interests: [],
  profileComplete: false,
  avatarColor: "#128C7E",
  avatarLetter: "J",
  useColorProfile: true,
  isActive: true,
  itemType: "USER",
  friendIds: [],
  friends: [],
  friendRequests: { sent: [], received: [] },
  notifications: [],
  xp: {},
  likedUserIds: [],
  createdAt: "2024-07-08T14:30:00.000Z",
  updatedAt: "2024-07-08T14:30:00.000Z",
  lastLogin: "2024-07-08T14:30:00.000Z"
};

// Saved to DynamoDB via PutCommand
await client.send(new PutCommand({
  TableName: "oververseDB",
  Item: userRecord
}));
```

---

### Example 2: Sending a Friend Request

```javascript
// User123 sends request to User999
const newFriendRequest = buildFriendItem("user123", "user999", "pending");

// Before saving to DB, enrich with profile reference
const enrichedRequest = buildFriendRequestReference(
  newFriendRequest,
  "pending",
  "user123",
  {
    senderUser: {
      userId: "user123",
      userName: "john_doe",
      profileImageUrl: "https://...",
      avatarColor: "#128C7E"
    },
    recipientUser: {
      userId: "user999",
      userName: "charlie_brown",
      profileImageUrl: "https://...",
      avatarColor: "#95E1D3"
    }
  }
);

// Save to FRIEND table
await client.send(new PutCommand({
  TableName: "oververseDB",
  Item: {
    userId: "user123",
    friendId: "user999",
    itemType: "FRIEND",
    requestId: "user123|user999",
    status: "pending",
    To: enrichedRequest.To,
    RequestType: "FRIEND_REQUEST_OUTGOING",
    ReceiverIdUserId: "user999",
    createdAt: "2024-07-08T16:45:00.000Z"
  }
}));

// Update user123's friendRequests
const user123 = await getUserById("user123");
const updatedRequests = mergeFriendRequestReference(
  user123.friendRequests,
  enrichedRequest,
  "pending",
  "user123"
);

await updateUserById("user123", {
  ...user123,  // Preserve all fields
  friendRequests: updatedRequests
});

// Update user999's friendRequests (they receive it)
const user999 = await getUserById("user999");
const incomingRequest = {
  ...enrichedRequest,
  RequestType: "FRIEND_REQUEST_INCOMING",
  ReceiverIdUserId: "user999"
};

const user999UpdatedRequests = mergeFriendRequestReference(
  user999.friendRequests,
  incomingRequest,
  "pending",
  "user999"
);

await updateUserById("user999", {
  ...user999,  // Preserve all fields
  friendRequests: user999UpdatedRequests
});
```

---

### Example 3: Accepting a Friend Request (Transaction)

```javascript
// user999 accepts friend request from user123

// Step 1: Fetch both users' profiles
const senderUser = await getUserById("user123");
const recipientUser = await getUserById("user999");

// Step 2: Build the transaction
const transactionItems = [
  // 1. Create FRIEND record for user123 → user999
  {
    Put: {
      TableName: "oververseDB",
      Item: {
        userId: "user123",
        friendId: "user999",
        itemType: "FRIEND",
        status: "accepted",
        To: buildUserSnapshot(recipientUser),
        RequestType: "FRIEND_REQUEST_OUTGOING",
        createdAt: "2024-06-01T12:00:00.000Z",
        updatedAt: "2024-07-08T09:20:00.000Z"
      }
    }
  },
  
  // 2. Create FRIEND record for user999 → user123
  {
    Put: {
      TableName: "oververseDB",
      Item: {
        userId: "user999",
        friendId: "user123",
        itemType: "FRIEND",
        status: "accepted",
        To: buildUserSnapshot(senderUser),
        RequestType: "FRIEND_REQUEST_INCOMING",
        createdAt: "2024-06-01T12:00:00.000Z",
        updatedAt: "2024-07-08T09:20:00.000Z"
      }
    }
  },
  
  // 3. Update user123's record
  {
    Update: {
      TableName: "oververseDB",
      Key: { userId: "user123" },
      UpdateExpression: `
        SET friends = list_append(if_not_exists(friends, :emptyList), :friendRef),
            friendIds = list_append(if_not_exists(friendIds, :emptyList), :toAdd),
            notifications = list_append(if_not_exists(notifications, :notifEmpty), :notifToAdd),
            updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ':emptyList': [],
        ':friendRef': [{
          friendId: "user999",
          status: "accepted",
          addedAt: "2024-07-08T09:20:00.000Z"
        }],
        ':toAdd': ["user999"],
        ':notifEmpty': [],
        ':notifToAdd': [{
          fromUserId: "user999",
          toUserId: "user123",
          activity: "charlie_brown accepted your friend request",
          notificationUserId: "user999",
          notificationUserName: "charlie_brown",
          notificationUserImageUrl: "https://...",
          type: "friend_request_accepted",
          isRead: false,
          createdAt: "2024-07-08T09:20:00.000Z"
        }],
        ':now': "2024-07-08T09:20:00.000Z"
      }
    }
  },
  
  // 4. Update user999's record
  {
    Update: {
      TableName: "oververseDB",
      Key: { userId: "user999" },
      UpdateExpression: `
        SET friends = list_append(if_not_exists(friends, :emptyList), :friendRef),
            friendIds = list_append(if_not_exists(friendIds, :emptyList), :toAdd),
            friendRequests = :updatedRequests,
            updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ':emptyList': [],
        ':friendRef': [{
          friendId: "user123",
          status: "accepted",
          addedAt: "2024-07-08T09:20:00.000Z"
        }],
        ':toAdd': ["user123"],
        ':updatedRequests': {
          sent: [],
          received: [
            // Update status to "accepted"
            {
              requestId: "user123|user999",
              status: "accepted",
              RequestType: "FRIEND_REQUEST_INCOMING"
            }
          ]
        },
        ':now': "2024-07-08T09:20:00.000Z"
      }
    }
  }
];

// Execute transaction
await client.send(new TransactWriteCommand({
  TransactItems: transactionItems
}));

// Returns: { success: true, friends updated in both users' records }
```

---

### Example 4: Updating User Profile

```javascript
// User updates their profile information
const updates = {
  bio: "Updated bio - Love coding and gaming!",
  interests: ["coding", "gaming", "music"],
  country: "India",
  avatarColor: "#FF6B6B",
  gender: "male"
};

// sanitizeUserUpdates() ensures no restricted fields are updated
const sanitizedUpdates = sanitizeUserUpdates(updates);

// The update preserves all existing fields
const updateExpression = buildUpdateExpression({
  ...sanitizedUpdates,
  updatedAt: new Date().toISOString()
});

// Execute update
await client.send(new UpdateCommand({
  TableName: "oververseDB",
  Key: { userId: "user123" },
  UpdateExpression: updateExpression.expression,
  ExpressionAttributeValues: updateExpression.values,
  ReturnValues: "ALL_NEW"
}));

// Returns updated user object with all fields preserved
```

---

## 6. Key Data Patterns in dynamoDBService.js

### Pattern 1: Spread Operator for Data Preservation

```javascript
// ✅ CORRECT: Preserves all existing fields
const updated = {
  ...currentUser,           // Spread all existing fields first
  bio: newBio,             // Override only changed fields
  interests: newInterests,
  updatedAt: new Date().toISOString()
};

// ❌ WRONG: Loses all fields except specified ones
const updated = {
  bio: newBio,
  interests: newInterests
};
```

### Pattern 2: Enrich with Metadata Before Persistence

```javascript
// Fetch profiles first
let senderUser = userCache.get(userId);
if (!senderUser) {
  senderUser = await getUserById(userId);
}

// Pass profiles as metadata
const enriched = buildFriendRequestReference(
  request,
  status,
  userId,
  { senderUser, recipientUser }  // ← Metadata passed here
);

// Persist enriched data
await persistData(enriched);
```

### Pattern 3: Merge vs. Replace

```javascript
// ✅ MERGE: Combines old and new data
const merged = mergeFriendRequestReference(
  existingRequests,  // Keep existing
  newRequest,        // Add/update
  status
);

// ❌ REPLACE: Loses existing data
const replaced = [newRequest];  // ← Loses old requests!
```

---

## 7. Database Operations Summary

| Operation | Function | Input | Output |
|-----------|----------|-------|--------|
| Create User | buildUserItem() | Raw registration data | Complete USER record |
| Create Friend Request | buildFriendItem() | userId, friendId | Basic FRIEND record |
| Enrich Request | buildFriendRequestReference() | FRIEND record + profiles | FRIEND record with To/metadata |
| Merge Friend | mergeFriendList() | Existing friends + new friendId | Updated friend list |
| Persist Request | persistFriendRequestOnUser() | userId + request + status | Updated USER record |
| Accept Friendship | acceptFriendRequestTransaction() | Friend request + profiles | Transaction to both users |
| Create Notification | Create in-memory object | fromUserId, toUserId, activity | Notification record |
| Update User | updateUserById() | userId + updates object | Updated USER record |

---

## 8. Dev Store Fallback Format

When USE_DEV_STORE=true, data is saved as JSON in `dev_dynamo_users.json`:

```json
[
  {
    "userId": "user123",
    "itemType": "USER",
    "userName": "john_doe",
    "email": "john@example.com",
    "friends": [],
    "friendIds": [],
    "friendRequests": {
      "sent": [],
      "received": []
    },
    "notifications": [],
    "createdAt": "2024-07-08T14:30:00.000Z",
    "updatedAt": "2024-07-08T14:30:00.000Z"
  },
  {
    "userId": "user123",
    "friendId": "user456",
    "itemType": "FRIEND",
    "status": "accepted",
    "To": {
      "userId": "user456",
      "userName": "alice_wonder"
    }
  }
]
```

---

## 9. Critical Rules for DynamoDB Saving

1. **Always Preserve Existing Data** - Use spread operator when updating
2. **Enrich Before Persisting** - Fetch profiles and attach metadata
3. **Use Transactions for Relationships** - When updating multiple users, use TransactWrite
4. **Normalize Field Names** - Keep consistent naming (e.g., userId, not user_id)
5. **Include Timestamps** - All records need createdAt and updatedAt
6. **Create Bidirectional Records** - Friends go both ways (user → friend AND friend → user)
7. **Validate Data Types** - Convert dates to ISO strings before saving
8. **Handle Null Values** - removeUndefinedValues: true strips nulls during marshalling

---

## 10. Quick Reference: Common Data Shapes

```javascript
// Minimal User
{ userId: "123", itemType: "USER" }

// Minimal Friend
{ userId: "123", friendId: "456", itemType: "FRIEND", status: "pending" }

// Minimal Notification
{ fromUserId: "123", toUserId: "456", activity: "text", type: "friend_request_accepted" }

// Friend Request with Metadata
{
  requestId: "123|456",
  status: "pending",
  RequestType: "FRIEND_REQUEST_OUTGOING",
  To: { userId: "456", userName: "name", ... }
}
```

---

Generated from: `slyxyserver/utils/dynamoDBService.js`
Date: 2024-07-08
SLYXY Platform - Real-time Social Networking
