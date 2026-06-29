# Production Deployment Checklist - Profile Data Persistence Fix

## Deployment Date: _____________
## Deployed By: _____________
## Approval: Dev Lead: _____ | QA Lead: _____ | Product: _____

---

## Phase 0: Pre-Deployment Verification (Do NOT Skip)

### Code Review & Approval
- [ ] Backend changes reviewed and approved
- [ ] Frontend changes reviewed and approved
- [ ] All code changes documented
- [ ] Security review completed (no data exposure)
- [ ] Performance review completed (no regressions)

### Integration Testing Completion
- [ ] Scenario 1: Single device basic update ✅ PASSED
- [ ] Scenario 2: Multi-device sync ✅ PASSED
- [ ] Scenario 3: Partial payload preservation ✅ PASSED
- [ ] Scenario 4: Avatar update ✅ PASSED
- [ ] Scenario 5: Offline sync ✅ PASSED
- [ ] Scenario 6: Rapid sequential updates ✅ PASSED
- [ ] Scenario 7: Field type consistency ✅ PASSED
- [ ] Scenario 8: Error handling ✅ PASSED

### Pre-Deployment Verification
- [ ] Backend code compiles: `node -c ws_server.js` ✅
- [ ] Frontend code compiles: `flutter analyze` ✅ (no errors)
- [ ] Database backups created
- [ ] Current versions backed up in git
- [ ] Rollback procedure tested and ready
- [ ] Network connectivity verified between frontend and backend

### Risk Assessment
- [ ] No breaking changes identified
- [ ] No data migration needed
- [ ] No infrastructure changes needed
- [ ] Fallback plan documented
- [ ] Estimated deployment time: 30-45 minutes

---

## Phase 1: Backend Deployment

### Step 1.1: Prepare Backend Server
```bash
cd /path/to/slyxyserver
git status  # Verify working directory clean
git log --oneline -1  # Note current commit
git branch  # Verify on correct branch
```
- [ ] Working directory is clean
- [ ] On correct branch (likely main/master)
- [ ] Latest changes pulled

### Step 1.2: Backup Current Backend
```bash
cp ws_server.js ws_server.js.backup.$(date +%s)
git commit -am "Backup: Pre-profile-persistence-deployment"
```
- [ ] Current ws_server.js backed up with timestamp
- [ ] Backup committed to git
- [ ] Commit message clear and descriptive

### Step 1.3: Deploy Updated Backend
```bash
# Verify new code has profile changes
grep -n "buildCompleteUserProfile" ws_server.js  # Should find matches
node -c ws_server.js  # Verify syntax
```
- [ ] `buildCompleteUserProfile()` function present
- [ ] Function called in socket event: `io.emit('profile_update', buildCompleteUserProfile(user))`
- [ ] Function called in API responses for all endpoints
- [ ] Syntax check passes (no output = success)

### Step 1.4: Stop Old Backend Process
```bash
# Find running Node process
lsof -i :5000  # or use ps aux | grep node
kill -TERM <PID>
sleep 2
# Verify stopped
lsof -i :5000  # Should show nothing
```
- [ ] Old process gracefully terminated
- [ ] Port 5000 (or configured port) is free
- [ ] No lingering Node processes

### Step 1.5: Start New Backend Process
```bash
node ws_server.js &
# or use PM2 if available:
# pm2 restart slyxy-backend
```
- [ ] Backend starts without errors
- [ ] Logs show successful startup
- [ ] Database connections established
- [ ] Socket.IO listening on correct port
- [ ] No connection errors in logs

**Expected Logs**:
```
✅ Backend server running on port 5000
✅ Database connected
✅ Socket.IO listening
```

### Step 1.6: Quick Backend Verification
```bash
# Test that complete profile is returned
curl -X POST http://localhost:5000/user/TEST_USER/update \
  -H "Content-Type: application/json" \
  -d '{"bio": "test deployment"}'

# Response should include ALL fields:
# userId, userName, email, gender, country, 
# interests[], xp{}, likedUserIds[], birthDate, etc.
```
- [ ] API endpoint responds without error
- [ ] Response includes all 25+ profile fields
- [ ] Email field present in response
- [ ] Bio field shows updated value
- [ ] Gender field present (not updated)
- [ ] Country field present (not updated)

### Step 1.7: Verify Backend Logs
```bash
# Monitor backend logs for any errors
tail -f /path/to/logs/backend.log | head -50
```
- [ ] No error messages in logs
- [ ] Only info/debug messages visible
- [ ] No database connection errors
- [ ] No socket connection errors
- [ ] Backend is responsive

### Step 1.8: Backend Deployment Complete ✅
- [ ] Backend deployed successfully
- [ ] All systems nominal
- [ ] Ready for frontend deployment
- [ ] **WAIT 5 minutes** before proceeding to ensure stability

---

## Phase 2: Frontend Deployment

### Step 2.1: Prepare Frontend Build Environment
```bash
cd /path/to/slyxy
git status  # Verify working directory clean
flutter clean
flutter pub get
```
- [ ] Working directory is clean
- [ ] Flutter cache cleaned
- [ ] Dependencies refreshed

### Step 2.2: Verify Frontend Changes
```bash
grep -n "mergeProfileUpdate" lib/services/user_preferences.dart
grep -n "_onSocketProfileUpdated" lib/profile/profile_screen.dart
```
- [ ] mergeProfileUpdate() method exists in user_preferences.dart
- [ ] _onSocketProfileUpdated() calls mergeProfileUpdate()
- [ ] Both files have latest changes

### Step 2.3: Verify Compilation
```bash
flutter analyze
# Should show no errors (warnings OK)

flutter build apk --release
# or for iOS:
# flutter build ios --release
```
- [ ] `flutter analyze` shows no errors
- [ ] Build completes successfully
- [ ] APK/IPA file generated without errors
- [ ] No build time errors in console
- [ ] Build artifacts are in correct location

### Step 2.4: Test on Development Device
```bash
flutter run -release  # or install APK on test device
```
- [ ] App installs and launches without crash
- [ ] Socket connects to backend
- [ ] Profile screen loads and displays current user
- [ ] No runtime errors in console

### Step 2.5: Test Single Device Scenario (5 min)
1. **Register test user** with full profile:
   - Email: `deployment-test@slyxy.local`
   - Username: `DeploymentTest`
   - Gender: `Male`
   - Country: `United States`
   - Bio: `Original deployment test bio`
   - Interests: `[Testing, Deployment]`
   - Birthdate: `1990-01-15`

2. **Update ONLY the bio**:
   - Change to: `Updated deployment test bio`
   - Submit update

3. **Check Flutter console logs** for:
   ```
   ✅ Profile merged successfully (preserved X fields)
   ✅ Loaded user from storage
   ```
   - [ ] Merge log shows preserved fields ≥ 5
   - [ ] Email NOT changed in display
   - [ ] Gender NOT changed in display
   - [ ] Country NOT changed in display
   - [ ] Interests NOT changed in display
   - [ ] Birthdate NOT changed in display
   - [ ] Bio UPDATED to new value

4. **Check backend logs** for:
   ```
   ✅ Broadcast profile_update to connected clients with all fields
   ```
   - [ ] Backend sent complete profile with all fields

**If Single Device Test FAILS**: 
- [ ] Rollback frontend: `git checkout lib/profile/profile_screen.dart lib/services/user_preferences.dart`
- [ ] Investigate error in logs
- [ ] Fix issue and test again
- [ ] Do NOT proceed to app store until test passes

### Step 2.6: Upload to App Stores

#### For Android (Google Play):
```bash
# Note: Requires Play Store account and certificates
cd android
./gradlew bundleRelease
# Upload bundle to Google Play Console
# Internal testing → Staged rollout → Production
```
- [ ] Release notes updated: "Fixed profile data persistence - user profile data no longer lost after updates"
- [ ] APK/Bundle signed with production key
- [ ] Uploaded to internal testing track first (20% users)
- [ ] Release notes mention: Profile data preservation fix

#### For iOS (App Store):
```bash
# Note: Requires Apple Developer account and certificates
flutter build ios --release
# Open in Xcode and submit to App Store
```
- [ ] IPA built and signed
- [ ] Submitted to App Store for review
- [ ] Release notes updated
- [ ] TestFlight beta deployed first (optional)

- [ ] App store uploads queued or scheduled
- [ ] Release notes clear and mention profile fix
- [ ] Staged rollout planned (don't release to 100% immediately)

### Step 2.7: Frontend Deployment Complete ✅
- [ ] Frontend built successfully
- [ ] Single device test passed
- [ ] App stores updated
- [ ] Release scheduled or queued

---

## Phase 3: Staged Rollout (Recommended)

### Step 3.1: Internal Testing (Day 1)
- [ ] Deploy to 5% of users (or internal testing track)
- [ ] Monitor crash reports: `Analytics → Crashes` in app stores
- [ ] Monitor error logs on backend
- [ ] Check user feedback channels
- [ ] Expected: 0 critical issues

### Step 3.2: Beta Rollout (Day 2-3)
- [ ] Increase to 25% of users
- [ ] Continued monitoring
- [ ] Check success metrics (preserved fields logs)
- [ ] Monitor for data inconsistencies
- [ ] Expected: Profile updates working, no data loss

### Step 3.3: Full Production Rollout (Day 4+)
- [ ] Increase to 100% of users
- [ ] Continue monitoring
- [ ] Check user satisfaction
- [ ] Monitor error rates

---

## Phase 4: Post-Deployment Monitoring (24 Hours)

### Hour 1: Immediate Checks
- [ ] No crash spike in crash analytics
- [ ] Backend logs show normal profile_update events
- [ ] No increase in error rates (watch error logs)
- [ ] Socket connections stable
- [ ] Database queries performing normally
- [ ] API response times < 500ms

### Hour 2-4: Continued Monitoring
- [ ] Monitor for data corruption issues
- [ ] Check if multi-device users seeing consistent profiles
- [ ] Review user error reports (if any)
- [ ] Verify field preservation in sample profiles

### Hour 4-24: Extended Monitoring
- [ ] Daily crash report review
- [ ] Check error logs for pattern of issues
- [ ] Monitor user feedback on social media/app store reviews
- [ ] Verify no data inconsistencies emerged
- [ ] Performance metrics stable

### Monitoring Dashboards to Watch

**Backend Logs**:
- Search for errors: `error|ERROR|fail|FAIL`
- Search for profile updates: `profile_update`
- Check preserved field counts
- Monitor database connection pool

**Frontend Analytics** (if available):
- Crash rate should not increase
- Profile update completion rate should be 100%
- User retention stable

**App Store Reviews**:
- No new negative reviews about data loss
- Check for any profile-related complaints

---

## Success Metrics - Post Deployment

### ✅ Deployment is Successful When:

1. **No Crashes**: 
   - [ ] Crash rate not increased vs baseline
   - [ ] No new crash patterns
   - [ ] App stable for 24 hours

2. **Data Integrity**:
   - [ ] No profile data corruption reported
   - [ ] Multi-device profiles consistent
   - [ ] Email/bio/interests preserved on all updates

3. **Performance**:
   - [ ] API response times < 500ms
   - [ ] Socket events < 100ms
   - [ ] No noticeable lag in profile updates

4. **User Experience**:
   - [ ] No increase in support tickets
   - [ ] No complaints about data loss
   - [ ] Positive feedback on fix

5. **Logs Confirm Success**:
   - [ ] Backend logs show: `✅ Broadcast profile_update...`
   - [ ] Frontend logs show: `✅ Profile merged successfully (preserved 5+ fields)`

---

## Issues Found During Deployment

### Issue Found: _______________
- **Severity**: Critical / High / Medium / Low
- **Description**: _______________
- **Impact**: _______________
- **Resolution**: _______________
- **Resolution Time**: _______________
- **Outcome**: ✅ Resolved | ⚠️ Workaround | ❌ Rollback

---

## Rollback Procedure (If Needed)

### Quick Rollback (Within 1 Hour of Deployment)

#### Backend Rollback:
```bash
cd /path/to/slyxyserver
# Stop current process
kill -TERM <PID_OF_NODE>
# Restore backup
cp ws_server.js.backup.<timestamp> ws_server.js
# Verify restored version
node -c ws_server.js
# Restart
node ws_server.js &
```
- [ ] Backed up version restored
- [ ] Process restarted
- [ ] Backend responding normally
- [ ] Socket events working

#### Frontend Rollback:
```bash
cd /path/to/slyxy
# Restore to previous version
git checkout lib/profile/profile_screen.dart lib/services/user_preferences.dart
# Rebuild
flutter clean && flutter build apk --release
# Upload to app stores with urgent rollback note
```
- [ ] Code rolled back to previous version
- [ ] App rebuilt
- [ ] Rollback version submitted to app stores
- [ ] Users notified of rollback reason

---

## Sign-Off & Approval

### Pre-Deployment Sign-Off
- Dev Lead Approval: _______ (Name) _______ (Date/Time)
- QA Lead Approval: _______ (Name) _______ (Date/Time)
- Product Manager Approval: _______ (Name) _______ (Date/Time)

### Deployment Execution
- Backend Deployed By: _______ (Name) _______ (Date/Time)
- Backend Verified: _______ (Name) _______ (Date/Time)
- Frontend Deployed By: _______ (Name) _______ (Date/Time)
- Frontend Verified: _______ (Name) _______ (Date/Time)

### Post-Deployment Monitoring
- 1 Hour Check: _______ (Name) _______ (Date/Time) | Status: ___________
- 4 Hour Check: _______ (Name) _______ (Date/Time) | Status: ___________
- 24 Hour Check: _______ (Name) _______ (Date/Time) | Status: ___________

### Final Approval
- Deployment Success: ✅ YES | ❌ NO
- Issues: _______________
- Action Items: _______________
- Deployment Lead Sign-Off: _______ (Name) _______ (Date/Time)

---

## Communication Log

### Pre-Deployment
- [ ] Team notified of deployment window
- [ ] Users notified (if applicable)
- [ ] Stakeholders informed

### During Deployment
- [ ] Progress updates communicated
- [ ] Issues escalated immediately
- [ ] Monitoring dashboard shared

### Post-Deployment
- [ ] Deployment completion announced
- [ ] Release notes published
- [ ] User communication: "Profile data persistence fixed - your profile now updates without data loss"

---

## Appendix: Quick Commands Reference

```bash
# Backend Commands
cd slyxyserver
node -c ws_server.js                                    # Verify syntax
node ws_server.js &                                     # Start backend
lsof -i :5000                                           # Check port
kill -TERM <PID>                                        # Stop process
grep -n "buildCompleteUserProfile" ws_server.js         # Verify changes
tail -f backend.log | grep -i "error\|profile_update"   # Monitor logs

# Frontend Commands
cd slyxy
flutter analyze                                         # Check code
flutter build apk --release                             # Build APK
flutter run -release                                    # Test on device
grep -n "mergeProfileUpdate" lib/services/user_preferences.dart  # Verify changes

# Testing Commands
curl -X POST http://localhost:5000/user/TEST/update \
  -H "Content-Type: application/json" \
  -d '{"bio":"test"}'                                   # Test API response

# Database Commands (if needed)
# MongoDB shell
db.users.findOne({email: "test@slyxy.local"})          # Check user data
db.users.updateOne({userId: "TEST"}, {$set: {bio: ""}}) # Clear field for retest
```

---

**Next Step**: Execute this checklist step-by-step during actual deployment.

**Support Contact**: [DevOps Email/Slack] during deployment

**Estimated Total Time**: 45 minutes (Backend: 15 min + Frontend: 20 min + Monitoring: 10 min)

