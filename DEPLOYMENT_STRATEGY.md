# Profile Data Persistence - Deployment Strategy

## Overview
This document outlines the deployment sequence and verification steps for the profile data persistence fix across frontend and backend systems.

## Deployment Order (CRITICAL - Must Follow)

### Phase 1: Backend Deployment (Go First ✅)
**Why First**: Frontend needs backend to be sending complete data before frontend can merge it properly

**Steps**:
1. **Backup Current Backend**
   ```bash
   cp ws_server.js ws_server.js.backup
   git commit -m "Backup before profile persistence update"
   ```

2. **Deploy Updated ws_server.js**
   - Changes: `buildCompleteUserProfile()` function added
   - Updated endpoints: `/users/profile`, `/users/search`, `/auth/login`, `/auth/register`, `/auth/guest-login`, `/user/:userId/update`
   - Updated socket event: `profile_update`
   - Restart server: `node ws_server.js`

3. **Verify Backend is Running**
   ```bash
   # Check logs for startup messages
   # Should see: "✅ Backend server running"
   ```

4. **Quick Backend Test**
   ```bash
   # Send test profile update request
   curl -X POST http://localhost:5000/user/TEST_USER_ID/update \
     -H "Content-Type: application/json" \
     -d '{ "bio": "Test bio" }'
   
   # Verify response includes all profile fields
   ```

**Verification Checklist**:
- [ ] Server starts without errors
- [ ] Database connections established
- [ ] Socket.IO listening on correct port
- [ ] Test request returns complete user profile
- [ ] Logs show backend ready for requests

---

### Phase 2: Frontend Deployment (Deploy After Backend ✅)
**Why After**: Ensures backend is sending complete data before frontend tries to merge it

**Files to Deploy**:
1. `lib/profile/profile_screen.dart`
   - Updated: `_onSocketProfileUpdated()` method
   - Now calls: `UserPreferences.mergeProfileUpdate(payload)`

2. `lib/services/user_preferences.dart`
   - Added: `mergeProfileUpdate()` method
   - Added: `_countPreservedFields()` helper

**Deployment Steps**:
1. **Backup Current Frontend**
   ```bash
   cd slyxy/
   git commit -am "Backup before profile persistence update"
   ```

2. **Update Files**
   - Ensure both files have latest changes
   - Run: `flutter pub get`

3. **Verify Compilation**
   ```bash
   flutter analyze
   # Should show no errors (warnings OK)
   flutter build apk --release  # or iOS
   # Should complete successfully
   ```

4. **Deploy to App Store / Play Store**
   - For production: Upload to app stores with release notes
   - For testing: Use debug/development build first
   - Release notes should mention: "Fixed profile data persistence - user profile data no longer lost after updates"

5. **Verify Frontend on Device**
   ```bash
   flutter run -release
   # Or install APK/IPA on test device
   ```

**Verification Checklist**:
- [ ] Code compiles without errors
- [ ] Flutter analyze passes
- [ ] No runtime errors on startup
- [ ] Socket connects to backend
- [ ] Profile screen loads and displays data

---

## Parallel Testing During Deployment

### Backend Verification (Before Frontend)
While backend is deployed, run these tests:

1. **Profile Update Endpoint Test**
   ```bash
   # Test that complete profile is returned
   POST /user/{userId}/update
   Payload: { "bio": "test" }
   Expected: Response includes email, gender, country, interests, etc.
   ```

2. **Socket Event Test**
   ```bash
   # Monitor socket events with simple client
   # Expect: profile_update with all 25+ fields
   ```

### Frontend Verification (After Backend)
After both deployed, run integration tests:

1. **Scenario 1**: Single device profile update
2. **Scenario 2**: Multi-device sync
3. **Scenario 3**: Field preservation check

---

## Rollback Procedure (If Issues Occur)

### Backend Rollback
```bash
# If backend has critical issues within 1 hour:
cd slyxyserver/
git checkout ws_server.js
node ws_server.js
# Restart service
```

### Frontend Rollback
```bash
cd slyxy/
git checkout lib/profile/profile_screen.dart lib/services/user_preferences.dart
flutter run -release
# Reinstall app on devices
```

---

## Deployment Environments

### Development Deployment ✅ (Recommended First)
1. Deploy backend to dev server
2. Deploy frontend to Android emulator/iOS simulator
3. Run all integration tests
4. Verify all scenarios pass
5. **Decision Point**: Ready for production?

### Staging Deployment (Optional)
1. Deploy backend to staging server (production-like)
2. Deploy frontend build to test devices
3. Run full integration test suite
4. Performance testing
5. **Decision Point**: Ready for production?

### Production Deployment (Final)
1. Schedule deployment during low-traffic window
2. Deploy backend first (verify with quick tests)
3. Wait 10 minutes, monitor logs for errors
4. Deploy frontend to app stores
5. Monitor logs and user feedback for 24 hours

---

## Deployment Checklist

### Pre-Deployment
- [ ] All code committed to git
- [ ] Backend changes verified in ws_server.js
- [ ] Frontend changes verified in profile_screen.dart, user_preferences.dart
- [ ] Tests passing in dev environment
- [ ] Documentation updated
- [ ] Backup of current versions created

### Backend Deployment
- [ ] ws_server.js deployed to backend server
- [ ] Node.js server restarted
- [ ] Database connections verified
- [ ] Socket.IO listening
- [ ] Logs show no startup errors
- [ ] Quick test confirms complete profile response

### Frontend Deployment
- [ ] lib/profile/profile_screen.dart deployed
- [ ] lib/services/user_preferences.dart deployed
- [ ] App compiles successfully
- [ ] Socket connection established
- [ ] Profile screen functional

### Post-Deployment Testing
- [ ] Scenario 1: Single device update (bio change preserved all other fields)
- [ ] Scenario 2: Multi-device sync (updates synced correctly)
- [ ] Scenario 3: Partial payload (unmapped fields preserved)
- [ ] Scenario 4: Avatar update (other fields preserved)
- [ ] Logs show: "✅ Profile merged successfully (preserved X fields)" where X ≥ 5

### Monitoring (24 hours post-deployment)
- [ ] No crash reports in app store console
- [ ] Backend logs show normal profile_update events
- [ ] No increase in error rates
- [ ] User profile data remains consistent
- [ ] Multi-device sync working for active users
- [ ] Performance metrics stable

---

## Success Metrics

**Deployment is successful when**:
1. ✅ No data loss observed in any test scenario
2. ✅ Frontend merge logs show preserved fields ≥ 5
3. ✅ Backend includes all profile fields in responses
4. ✅ Socket events broadcast complete profiles
5. ✅ Multi-device sync working
6. ✅ No new error reports post-deployment
7. ✅ User profile consistency maintained

---

## Communication Plan

### To Product Team
"Profile data persistence issue is fixed. Users will no longer lose email, bio, interests, gender, birthdate, or country data after profile updates. Deploy starting with backend, then frontend."

### To Users (Release Notes)
"Fixed: User profile data (email, bio, interests, etc.) no longer lost after profile updates. Profile data now syncs correctly across devices in real-time."

### To Operations Team
"Standard deployment: Update backend first, then frontend. Monitor logs for 'profile_update' events with complete user data. No database migrations needed."

---

## Contingency Plan

### If Only Backend Deployed But Not Frontend
- **Status**: Partially fixed - backend sends complete data
- **Action**: Deploy frontend as soon as possible
- **Users Experience**: Intermittent data preservation (depends on app version)

### If Only Frontend Deployed But Not Backend
- **Status**: NOT fixed - frontend can't merge incomplete data
- **Action**: Don't deploy frontend yet, wait for backend
- **Users Experience**: Same as before (data loss continues)

### If Backend Deployed with Errors
- **Action**: Rollback immediately using `git checkout ws_server.js`
- **Recovery Time**: < 5 minutes
- **Impact**: None to users (old version resumes)

### If Frontend Deployed with Errors
- **Action**: Rollback using `git checkout lib/profile/profile_screen.dart lib/services/user_preferences.dart`
- **Recovery Time**: Users may need to reinstall app (1-24 hours)
- **Impact**: Users on broken version until app store updates

---

## Sign-Off

**Deployment Authorization**:
- Backend Ready: _____ (Dev Lead)
- Frontend Ready: _____ (Frontend Lead)
- Backend Deployed: _____ / _____ (Date/Time)
- Frontend Deployed: _____ / _____ (Date/Time)
- Testing Complete: _____ (QA)
- Production Ready: _____ (PM/Lead)

**Post-Deployment Monitoring**:
- 1 Hour: _____ (All systems nominal?)
- 24 Hours: _____ (Any issues reported?)
- 7 Days: _____ (User feedback collected?)

