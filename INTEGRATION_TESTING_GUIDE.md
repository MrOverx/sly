# Profile Data Persistence - Integration Testing Guide

## Overview
This guide provides comprehensive testing procedures to validate that profile data (email, bio, interests, gender, birthDate, country, etc.) is preserved across profile updates and synced correctly between frontend and backend.

## Pre-Testing Setup

### Backend Requirements
- Node.js server running: `node ws_server.js`
- MongoDB connected and responsive
- S3 configured (if testing profile image uploads)
- Logger configured to show info/debug messages

### Frontend Requirements  
- Flutter app running on device/emulator: `flutter run`
- Socket.IO connected to backend
- SharedPreferences initialized
- Device has internet connection to backend server

### Database Reset (Optional but Recommended)
Clear test user data before testing:
```javascript
// In MongoDB shell
db.users.deleteMany({ email: "test@integration.local" });
db.users.deleteMany({ email: "test2@integration.local" });
```

---

## Test Scenarios

### ✅ Scenario 1: Single Device - Basic Profile Update

**Objective**: Verify profile merge works on a single device after updating specific fields.

**Steps**:
1. Launch app and register user with full profile:
   - Email: `test@integration.local`
   - Username: `TestUser`
   - Gender: `Male`
   - Country: `United States`
   - Bio: `Original bio`
   - Interests: `[Gaming, Music]`
   - Birthdate: `1990-01-15`

2. Note initial data in SharedPreferences via logs:
   - Check Flutter console for: `[UserPreferences] Loaded user from storage`

3. Update ONLY the bio from profile screen:
   - Change bio to: `Updated bio`
   - Submit profile update

4. **Expected Result**:
   - Backend logs show: `✅ Broadcast profile_update to connected clients with all fields`
   - Frontend logs show: `✅ Profile merged successfully (preserved X fields)` where X ≥ 5
   - Verify email, gender, country, interests, birthdate remain unchanged
   - UI reflects updated bio

5. **Verification Checklist**:
   - [ ] Backend returns complete user object in response
   - [ ] Socket event includes all 25+ fields
   - [ ] Frontend merge function receives payload
   - [ ] Preserved fields count ≥ 5 (email, gender, country, interests, birthdate)
   - [ ] Updated field (bio) shows new value

---

### ✅ Scenario 2: Multi-Device Sync - Simultaneous Connection

**Objective**: Verify data syncs correctly when user is logged in on multiple devices.

**Setup**:
- Device A: Android Emulator
- Device B: iOS Simulator (or second Android)
- Same user account on both

**Steps**:
1. Register user on Device A with full profile (same as Scenario 1)
2. Launch app on Device B, log in with same credentials
3. Both devices should now show same user profile
4. On Device A, update only the bio: `Updated from Device A`
5. On Device B, trigger profile refresh (e.g., navigate away and back to profile screen)
6. On Device B, update only the status: `Available for chat`
7. On Device A, check if Device B's status update appears

**Expected Results**:
- Device B receives Device A's bio update via socket
- Device A receives Device B's status update via socket
- All fields except updated ones remain preserved
- Both devices show consistent profile state

**Verification Logs**:
- Backend: `profile_update` event broadcasts to all connected clients
- Frontend on both devices: `✅ Profile merged successfully (preserved 4+ fields)`

---

### ✅ Scenario 3: Partial Payload - Backend Sends Incomplete Data

**Objective**: Verify frontend correctly preserves unmapped fields when backend sends partial data.

**Steps**:
1. Create user with complete profile (Scenario 1)
2. Manually call backend update endpoint with PARTIAL payload:
   ```curl
   POST /user/{userId}/update
   Content-Type: application/json
   
   {
     "bio": "Only updating bio",
     "interests": ["NewHobby"]
   }
   ```

3. Observe what frontend receives in socket event

**Expected Result**:
- Backend buildCompleteUserProfile() includes ALL fields in response
- Socket payload includes email, gender, country, birthdate (not in request body)
- Frontend merge preserves all unmapped fields
- Logs show: `✅ Profile merged successfully (preserved 8+ fields)`

---

### ✅ Scenario 4: Avatar/Image Update - Preserve Other Fields

**Objective**: Verify that when profile image is updated, other profile fields are preserved.

**Steps**:
1. Create user with bio, interests, gender, country set
2. Upload new profile image via profile screen
3. Verify image updates
4. Check that bio, interests, gender, country remain unchanged

**Expected Result**:
- Image updated successfully
- All other profile data preserved
- Merge logs show: `✅ Profile merged successfully (preserved 5+ fields)`

---

### ✅ Scenario 5: Offline Profile Update - Sync When Online

**Objective**: Verify app handles profile updates during offline periods.

**Steps**:
1. Create user with full profile
2. Disable network (airplane mode or disconnect WiFi)
3. Attempt to update profile fields
4. Re-enable network
5. Verify app syncs changes

**Expected Result**:
- App queues update request (if implemented)
- When network returns, update is sent
- Backend responds with complete profile
- Frontend merges and preserves all fields

---

### ✅ Scenario 6: Rapid Sequential Updates

**Objective**: Verify data persistence with rapid back-to-back updates.

**Steps**:
1. Create user with complete profile
2. Rapidly update different fields in succession:
   - Update bio → wait 1 second
   - Update interests → wait 1 second
   - Update status → wait 1 second
   - Update country → wait 1 second

3. After each update, verify logs and check profile data

**Expected Result**:
- Each update triggers merge function
- Fields not in update are preserved from previous merge
- Final profile contains all updates plus original data
- No data loss during rapid updates

**Verification**:
- Frontend logs show multiple merge operations
- Each preserved count increases or stays stable
- No fields are null/undefined in final state

---

### ✅ Scenario 7: Field Type Consistency

**Objective**: Verify all field types are correctly handled during merge.

**Steps**:
1. Create user with various data types:
   - String fields: email, bio, status, gender, country, userName
   - Array fields: interests, likedUserIds
   - Object fields: xp{}
   - Boolean fields: isGuest, isOnline, isFriend, profileComplete
   - Date fields: birthDate, lastDailyXpAwardedAt
   - Numeric fields: avatarColor, userId

2. Update each field type independently
3. Verify merge handles all types correctly

**Expected Result**:
- All field types preserved correctly
- No type casting errors
- No null/undefined conversions
- Merge function respects data types

---

### ✅ Scenario 8: Error Handling - Malformed Socket Payload

**Objective**: Verify app handles corrupted/malformed profile updates gracefully.

**Steps**:
1. Inject malformed socket event from backend:
   ```javascript
   io.emit('profile_update', {
     userId: null,
     userName: undefined,
     email: 123,  // wrong type
     interests: "not_an_array",
   });
   ```

2. Observe app behavior and error handling

**Expected Result**:
- App catches error gracefully
- Does not crash
- Logs error with context
- Previous profile data remains intact
- User sees appropriate error message (or none)

---

## Success Criteria

### ✅ All Tests Pass When:

1. **Field Preservation**: No field is lost after any profile update
   - Email always preserved
   - Gender always preserved
   - Country always preserved
   - Interests always preserved
   - BirthDate always preserved
   - Bio preserved (unless updated)
   - Status preserved (unless updated)

2. **Backend Completeness**: Backend returns all 25+ fields in:
   - Socket events (`profile_update`)
   - API responses (all endpoints)
   - Login/Register responses

3. **Frontend Merge**: Merge function logs show:
   - `✅ Profile merged successfully (preserved X fields)` where X ≥ 5
   - Most updates should show preserved count ≥ 8

4. **Multi-Device Sync**: Updates propagate correctly:
   - Device A update → Device B receives via socket
   - Device B update → Device A receives via socket
   - No conflicts or data loss

5. **No Regressions**: Existing functionality works:
   - Profile display works
   - Profile editing works
   - Image upload works
   - Friend requests work
   - Chat works

---

## Logging & Monitoring

### Frontend Logs to Watch

**Success Indicators**:
```
✅ Profile merged successfully (preserved 8 fields)
✅ Loaded user from storage: [complete UserModel]
✅ Profile updated successfully in local storage
```

**Warning Indicators**:
```
⚠️ Error handling socket profile update: 
⚠️ Cannot merge profile: no current user found
⚠️ Profile merge preserved 0 fields  // Too low - backend issue
```

### Backend Logs to Watch

**Success Indicators**:
```
✅ Broadcast profile_update to connected clients with all fields
✅ Synchronized socket metadata for updated user
✅ User profile updated or created
```

**Warning Indicators**:
```
⚠️ Failed to broadcast profile_update
error: user/update - Error updating user
```

### How to Enable Debug Logs

**Frontend (Dart)**:
```dart
// In main.dart or during initialization
debugPrint = (String? message, {int? wrapWidth}) {
  // Print to console
  print('[DEBUG] $message');
};
```

**Backend (Node.js)**:
```javascript
// Already enabled in Logger utility
// Check logs directory or console output
Logger.debug('user/update', 'Debug message here', { data });
```

---

## Test Execution Checklist

### Before Starting Tests
- [ ] Backend running and responding to requests
- [ ] Frontend compiles without errors
- [ ] Database is accessible and clean
- [ ] Logger output visible in console
- [ ] Network connectivity between frontend and backend verified

### Test Execution
- [ ] Scenario 1: Single device basic update ✅
- [ ] Scenario 2: Multi-device sync ✅
- [ ] Scenario 3: Partial payload preservation ✅
- [ ] Scenario 4: Avatar update with field preservation ✅
- [ ] Scenario 5: Offline sync ✅
- [ ] Scenario 6: Rapid sequential updates ✅
- [ ] Scenario 7: Field type consistency ✅
- [ ] Scenario 8: Error handling ✅

### Post-Test Verification
- [ ] All scenarios passed
- [ ] No data loss observed
- [ ] Logs show expected merge counts
- [ ] No regressions in existing features
- [ ] Performance acceptable (no lag/delays)

---

## Common Issues & Troubleshooting

### Issue: "Profile merged successfully (preserved 0 fields)"

**Cause**: Backend not including profile fields in socket event

**Solution**:
1. Verify `buildCompleteUserProfile()` function exists in ws_server.js
2. Check that `io.emit('profile_update', buildCompleteUserProfile(user))` is called
3. Restart backend server
4. Test again

---

### Issue: Email/Gender/Country showing as null

**Cause**: Frontend didn't preserve fields, or backend didn't include them

**Solution**:
1. Check backend response includes all fields
2. Verify UserModel.fromJson() handles all field names
3. Check if merge function has all fields in copyWith()
4. Look for field name mismatches (camelCase vs snake_case)

---

### Issue: Data loss on specific update

**Cause**: That field wasn't in payload and frontend overwrote it

**Solution**:
1. Ensure backend includes all fields in payload
2. Check merge logic preserves unmapped fields
3. Verify field is being tracked in merge function

---

### Issue: Multi-device sync not working

**Cause**: Socket connection not established on second device

**Solution**:
1. Verify both devices connect to same backend
2. Check SocketManager in app routes clients correctly
3. Verify socket listener added: `sock.on('profile_update', _onSocketProfileUpdated)`
4. Check network connectivity between devices and backend

---

## Performance Benchmarks

**Expected Performance**:
- Profile update API response: < 500ms
- Socket event broadcast: < 100ms
- Frontend merge operation: < 50ms
- UI update: < 200ms

**Total end-to-end update flow**: < 1 second (typical)

---

## Rollback Procedure

If integration testing reveals critical issues:

1. **Frontend Rollback**:
   ```bash
   git checkout lib/profile/profile_screen.dart lib/services/user_preferences.dart
   flutter run
   ```

2. **Backend Rollback**:
   ```bash
   git checkout ws_server.js
   node ws_server.js
   ```

---

## Sign-Off

Once all tests pass, document:
- **Date Tested**: ___________
- **Tester**: ___________
- **Environment**: Device: ___________ | Backend: ___________ | Network: ___________
- **All Tests Passed**: YES / NO
- **Issues Found**: ___________
- **Ready for Production**: YES / NO

