/**
 * DYNAMODB DUMMY DATA - PRACTICAL EXAMPLES
 * 
 * Shows how dummy data flows through the DynamoDB saving logic
 * Run examples with: node dynamodb_dummy_data_examples.js
 */

// ============================================================================
// 1. EXAMPLE USER DATA - Various User Types
// ============================================================================

const EXAMPLE_USERS = {
  
  // New user just registered
  newUser: {
    userId: "user_new_001",
    email: "newuser@gmail.com",
    userName: "newuser123",
    password: "hashedPasswordHere",
    authType: "MAIL"
  },
  
  // Fully populated active user
  activeUser: {
    userId: "user123",
    userName: "john_doe",
    name: "John Doe",
    email: "john@example.com",
    authType: "MAIL",
    gender: "male",
    country: "India",
    bio: "Love meeting new people and gaming!",
    interests: ["gaming", "photography", "travel"],
    status: "active",
    avatarColor: "#128C7E",
    useColorProfile: true,
    profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
    isOnline: true,
    xp: { total: 2500, level: 5, daily: 150 },
    likedUserIds: ["user456", "user789"],
    friendIds: ["user456", "user789"],
    friends: [
      { friendId: "user456", status: "accepted", addedAt: "2024-06-01T12:00:00.000Z" },
      { friendId: "user789", status: "accepted", addedAt: "2024-05-15T08:30:00.000Z" }
    ],
    friendRequests: [
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
          profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user999/profile.jpg",
          avatarColor: "#95E1D3",
          avatarLetter: "C"
        },
        createdAt: "2024-07-07T16:45:00.000Z",
        updatedAt: "2024-07-07T16:45:00.000Z"
      }
    ]
  },
  
  // Guest user (limited profile)
  guestUser: {
    userId: "guest_user_111",
    userName: "GuestUser111",
    authType: "GUEST",
    isGuest: true,
    gender: "other",
    avatarColor: "#FF6B6B"
  }
};

// ============================================================================
// 2. EXAMPLE FRIEND REQUEST DATA LIFECYCLE
// ============================================================================

const FRIEND_REQUEST_LIFECYCLE = {
  userId: "user123",
  friendRequests: [
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
        profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user999/profile.jpg",
        avatarColor: "#95E1D3",
        avatarLetter: "C"
      },
      createdAt: "2024-07-07T16:45:00.000Z",
      updatedAt: "2024-07-07T16:45:00.000Z"
    }
  ],
  afterAcceptanceOrDenial: {
    friendRequests: []
  }
};

// ============================================================================
// 3. FRIEND ITEM - Bidirectional Records
// ============================================================================

const FRIEND_ITEM_EXAMPLES = {
  
  // From user123's perspective
  friendItem_fromUser123: {
    userId: "user123",           // Hash Key
    friendId: "user456",          // Sort Key in composite
    itemType: "FRIEND",
    requestId: "user123|user456",
    senderId: "user123",
    recipientId: "user456",
    status: "accepted",
    RequestType: "FRIEND_REQUEST_OUTGOING",
    ReceiverIdUserId: "user456",
    isRead: true,
    To: {
      userId: "user456",
      userName: "alice_wonder",
      profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user456/profile.jpg",
      avatarColor: "#FF6B6B",
      avatarLetter: "A"
    },
    friendIndexKey: "FRIEND_BY_FRIEND#user456",
    createdAt: "2024-06-01T12:00:00.000Z",
    updatedAt: "2024-06-15T10:30:00.000Z"
  },
  
  // Same friendship from user456's perspective (separate record)
  friendItem_fromUser456: {
    userId: "user456",           // Different user
    friendId: "user123",          // Friend ID is reversed
    itemType: "FRIEND",
    requestId: "user456|user123",
    senderId: "user456",
    recipientId: "user123",
    status: "accepted",
    RequestType: "FRIEND_REQUEST_INCOMING",
    ReceiverIdUserId: "user123",
    isRead: true,
    To: {
      userId: "user123",
      userName: "john_doe",
      profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
      avatarColor: "#128C7E",
      avatarLetter: "J"
    },
    friendIndexKey: "FRIEND_BY_FRIEND#user123",
    createdAt: "2024-06-01T12:00:00.000Z",
    updatedAt: "2024-06-15T10:30:00.000Z"
  }
};

// ============================================================================
// 4. NOTIFICATION DATA EXAMPLES
// ============================================================================

const NOTIFICATION_EXAMPLES = {
  
  // Friend request accepted notification
  friendRequestAccepted: {
    id: "notif-uuid-1",
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
    priority: "normal"
  },
  
  // Direct message notification
  directMessage: {
    id: "notif-uuid-2",
    fromUserId: "user789",
    toUserId: "user123",
    activity: "bob_builder sent you a message",
    notificationUserId: "user789",
    notificationUserName: "bob_builder",
    notificationUserImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user789/profile.jpg",
    notificationUserAvatarColor: "#4ECDC4",
    notificationUserAvatarLetter: "B",
    type: "direct_message",
    isRead: false,
    messageId: "msg-uuid-123",
    createdAt: "2024-07-08T11:15:00.000Z",
    priority: "high"
  },
  
  // Friend request received notification
  friendRequestReceived: {
    id: "notif-uuid-3",
    fromUserId: "user222",
    toUserId: "user123",
    activity: "diana_prince sent you a friend request",
    notificationUserId: "user222",
    notificationUserName: "diana_prince",
    notificationUserImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user222/profile.jpg",
    notificationUserAvatarColor: "#F38181",
    notificationUserAvatarLetter: "D",
    type: "friend_request_received",
    isRead: false,
    createdAt: "2024-07-08T13:45:00.000Z",
    priority: "normal"
  }
};

// ============================================================================
// 5. COMPLETE TRANSACTION EXAMPLE - Accept Friend Request
// ============================================================================

const TRANSACTION_EXAMPLE = {
  
  description: "Transaction when user999 accepts friend request from user123",
  
  transaction: {
    TransactItems: [
      {
        Put: {
          TableName: "oververseDB",
          Item: {
            userId: "user123",
            friendId: "user999",
            itemType: "FRIEND",
            status: "accepted",
            To: {
              userId: "user999",
              userName: "charlie_brown",
              profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user999/profile.jpg",
              avatarColor: "#95E1D3"
            },
            RequestType: "FRIEND_REQUEST_OUTGOING",
            createdAt: "2024-07-07T16:45:00.000Z",
            updatedAt: "2024-07-08T09:20:00.000Z"
          }
        }
      },
      {
        Put: {
          TableName: "oververseDB",
          Item: {
            userId: "user999",
            friendId: "user123",
            itemType: "FRIEND",
            status: "accepted",
            To: {
              userId: "user123",
              userName: "john_doe",
              profileImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user123/profile.jpg",
              avatarColor: "#128C7E"
            },
            RequestType: "FRIEND_REQUEST_INCOMING",
            createdAt: "2024-07-07T16:45:00.000Z",
            updatedAt: "2024-07-08T09:20:00.000Z"
          }
        }
      },
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
            ":emptyList": [],
            ":friendRef": [{ friendId: "user999", status: "accepted", addedAt: "2024-07-08T09:20:00.000Z" }],
            ":toAdd": ["user999"],
            ":notifEmpty": [],
            ":notifToAdd": [{
              fromUserId: "user999",
              toUserId: "user123",
              activity: "charlie_brown accepted your friend request",
              notificationUserId: "user999",
              notificationUserName: "charlie_brown",
              notificationUserImageUrl: "https://s3.amazonaws.com/slyxy-profile-images/user999/profile.jpg",
              type: "friend_request_accepted",
              isRead: false,
              createdAt: "2024-07-08T09:20:00.000Z"
            }],
            ":now": "2024-07-08T09:20:00.000Z"
          }
        }
      },
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
            ":emptyList": [],
            ":friendRef": [{ friendId: "user123", status: "accepted", addedAt: "2024-07-08T09:20:00.000Z" }],
            ":toAdd": ["user123"],
            ":updatedRequests": [],
            ":now": "2024-07-08T09:20:00.000Z"
          }
        }
      }
    ]
  }
};

// ============================================================================
// 6. DATA PATTERNS - How Functions Transform Data
// ============================================================================

const DATA_PATTERNS = {
  
  // Pattern 1: Data Preservation via Spread Operator
  preservation_pattern: {
    before: {
      userId: "user123",
      userName: "john_doe",
      email: "john@example.com",
      bio: "Old bio",
      interests: ["gaming"],
      country: "India",
      status: "active",
      createdAt: "2024-01-01T00:00:00.000Z"
    },
    
    update_input: {
      bio: "Updated bio",
      interests: ["gaming", "coding"]
    },
    
    correct_approach: {
      // ✅ Spread existing first, then override
      userId: "user123",
      userName: "john_doe",
      email: "john@example.com",
      country: "India",
      status: "active",
      createdAt: "2024-01-01T00:00:00.000Z",
      bio: "Updated bio",
      interests: ["gaming", "coding"],
      updatedAt: "2024-07-08T14:30:00.000Z"
    },
    
    wrong_approach: {
      // ❌ Only includes updated fields - loses data!
      bio: "Updated bio",
      interests: ["gaming", "coding"],
      updatedAt: "2024-07-08T14:30:00.000Z"
      // ← Missing: userId, userName, email, country, status, createdAt
    }
  },
  
  // Pattern 2: Metadata Enrichment
  metadata_enrichment: {
    rawFriendRequest: {
      requestId: "user123|user999",
      userId: "user123",
      friendId: "user999",
      status: "pending"
    },
    
    withProfileMetadata: {
      requestId: "user123|user999",
      userId: "user123",
      friendId: "user999",
      status: "pending",
      To: {
        userId: "user999",
        userName: "charlie_brown",
        profileImageUrl: "https://...",
        avatarColor: "#95E1D3"
      },
      RequestType: "FRIEND_REQUEST_OUTGOING",
      ReceiverIdUserId: "user999",
      isRead: false
    }
  },
  
  // Pattern 3: Bidirectional Friend Record Creation
  bidirectional_pattern: {
    description: "Same friendship creates TWO records in FRIEND table",
    
    record_1: {
      userId: "user123",        // Perspective of user123
      friendId: "user456",
      status: "accepted",
      To: { userId: "user456", userName: "alice_wonder", profileImageUrl: "..." }
    },
    
    record_2: {
      userId: "user456",        // Perspective of user456
      friendId: "user123",
      status: "accepted",
      To: { userId: "user123", userName: "john_doe", profileImageUrl: "..." }
    },
    
    reason: "Allows efficient queries: 'Get all friends of user123' vs 'Get all friends of user456'"
  }
};

// ============================================================================
// 7. EXPORT FOR USE IN OTHER FILES
// ============================================================================

module.exports = {
  EXAMPLE_USERS,
  FRIEND_REQUEST_LIFECYCLE,
  FRIEND_ITEM_EXAMPLES,
  NOTIFICATION_EXAMPLES,
  TRANSACTION_EXAMPLE,
  DATA_PATTERNS
};

// ============================================================================
// 8. QUICK REFERENCE - Run from CLI
// ============================================================================

if (require.main === module) {
  console.log("🎯 DYNAMODB DUMMY DATA EXAMPLES\n");
  console.log("Available exports:");
  console.log("  - EXAMPLE_USERS: Various user types");
  console.log("  - FRIEND_REQUEST_LIFECYCLE: Request states over time");
  console.log("  - FRIEND_ITEM_EXAMPLES: Bidirectional friend records");
  console.log("  - NOTIFICATION_EXAMPLES: Different notification types");
  console.log("  - TRANSACTION_EXAMPLE: Complete transaction flow");
  console.log("  - DATA_PATTERNS: How data is transformed\n");
  
  console.log("📖 Usage in code:");
  console.log("  const examples = require('./dynamodb_dummy_data_examples.js');");
  console.log("  const newUser = examples.EXAMPLE_USERS.newUser;");
  console.log("  const notification = examples.NOTIFICATION_EXAMPLES.friendRequestAccepted;\n");
  
  console.log("📄 See DYNAMODB_DUMMY_DATA_EXAMPLES.md for detailed documentation");
}
