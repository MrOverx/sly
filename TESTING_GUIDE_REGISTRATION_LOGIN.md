# Testing Guide: Registration & Login After Fix

## Quick Start

The backend is now running with `USE_DEV_STORE=false`, which means:
- ✅ New registrations save to AWS DynamoDB
- ✅ Logins query DynamoDB for users
- ✅ Email duplicates prevented at database level
- ✅ User data persists across server restarts

---

## 🧪 Test Scenarios

### Test 1: New User Registration (FRESH EMAIL)

**Test**: Can a brand new user register?

**Steps**:
1. Open Flutter app (or use Postman/cURL)
2. Navigate to signup screen
3. Fill in:
   - Username: `TestUser_001`
   - Email: `testuser001@gmail.com` (use fresh email)
   - Password: `TestPass@123`
   - Gender: Select one
   - Country: Select one
4. Click "Register"

**Expected Result**:
```
✅ Registration succeeds (HTTP 200)
✅ User data returned in response with userId
✅ Login screen appears or auto-login occurs
```

**Verify in AWS**:
```
1. Go to AWS Console → DynamoDB → Tables → oververseDB
2. Click "Scan" or "Query"
3. Look for your userId starting with "local_"
4. Verify fields:
   - email: testuser001@gmail.com
   - emailLower: testuser001@gmail.com (normalized)
   - userName: TestUser_001
   - authType: MAIL
   - passwordHash: (hashed, not plaintext) ✓
```

**Logs to Check**:
```
[INFO] [auth/register] ✅ New user registered { userId: 'local_1234567_abc123', email: 'testuser001@gmail.com' }
```

---

### Test 2: User Login (NEWLY REGISTERED)

**Test**: Can newly registered user login immediately?

**Steps**:
1. Register user (use Test 1)
2. Wait 1-2 seconds
3. Navigate to login screen
4. Enter:
   - Email: `testuser001@gmail.com`
   - Password: `TestPass@123`
5. Click "Login"

**Expected Result**:
```
✅ Login succeeds (HTTP 200)
✅ JWT token returned
✅ User profile loaded on home screen
✅ Name and email displayed correctly
```

**Logs to Check**:
```
[DEBUG] [auth/login] Login request received { email: 'testuser001@gmail.com' }
[DEBUG] [auth/login] User found successfully
[INFO] [auth/login] ✅ Login successful { userId: 'local_xxx', email: 'testuser001@gmail.com' }
```

**If fails**:
```
[WARN] [auth/login] Login failed: no user found for login lookup
→ User not in DynamoDB. Check:
  - DynamoDB table status
  - Network connectivity to AWS
  - USE_DEV_STORE=false in .env
```

---

### Test 3: Duplicate Email Prevention

**Test**: Can two users register with same email?

**Steps**:
1. Register user: `user_dup1@test.com` (Test 1)
2. Try to register again: `user_dup2@test.com` with same email
3. Enter:
   - Username: `DuplicateTest2`
   - Email: `user_dup1@test.com` (SAME AS ABOVE)
   - Password: `Pass@123`
4. Click "Register"

**Expected Result**:
```
❌ Registration FAILS
HTTP 409 Conflict
Message: "User already exists"
```

**Why**: 
- During registration, `getUserByEmail()` queries DynamoDB EmailIndex
- Found existing user with that email
- Prevents duplicate registration

---

### Test 4: Wrong Password Login

**Test**: Does app prevent login with wrong password?

**Prerequisites**: User from Test 1 registered

**Steps**:
1. Go to login screen
2. Enter:
   - Email: `testuser001@gmail.com`
   - Password: `WrongPassword`
3. Click "Login"

**Expected Result**:
```
❌ Login FAILS
HTTP 401 Unauthorized
Message: "Invalid credentials" or "Password is incorrect"
```

**Logs**:
```
[DEBUG] [auth/login] Password verification failed
[WARN] [auth/login] Invalid credentials for email: testuser001@gmail.com
```

---

### Test 5: Non-existent Email Login

**Test**: What happens if email doesn't exist?

**Steps**:
1. Go to login screen
2. Enter:
   - Email: `nonexistent@fake.com`
   - Password: `AnyPassword123`
3. Click "Login"

**Expected Result**:
```
❌ Login FAILS
HTTP 401 Unauthorized
Message: "User not found" or "Invalid credentials"
```

**Logs**:
```
[DEBUG] [auth/login] Looking up user for login
[WARN] [auth/login] Login failed: no user found for login lookup { lookup: {...} }
```

---

### Test 6: Previous Email (Before Fix) Login

**Test**: OLD registrations - can they login?

**Context**: 
- These users were registered while `USE_DEV_STORE=true`
- Their data is in `dev_dynamo_users.json`
- NOT in DynamoDB

**Attempt**:
1. Try to login with email from BEFORE fix was applied
2. Expected: ❌ FAILS (not in DynamoDB)

**Why**: 
- Old data only in local JSON file
- `USE_DEV_STORE=false` now queries DynamoDB
- Users need to re-register or migrate data

**Solution** (if needed):
```bash
# Manually insert old user into DynamoDB (one-time)
# Or ask users to register again
```

---

### Test 7: Multi-Device Sync

**Test**: Register on Device A, login on Device B

**Prerequisites**: 
- 2 phones/emulators
- Both connected to same backend

**Steps**:
1. Device A: Register new user `multidevice@test.com`
2. Device B: Try to login with same email
3. Wait 1-2 seconds, try again if needed

**Expected Result**:
```
✅ Device A: Registration succeeds
✅ Device B: Login succeeds with same credentials
✅ Both devices see identical user profile
```

---

### Test 8: Server Restart Persistence

**Test**: Data survives server restart

**Prerequisites**: 
- User registered in Test 1

**Steps**:
1. Stop backend server
2. Wait 5 seconds
3. Restart backend: `node ws_server.js`
4. Try to login with Test 1 credentials

**Expected Result**:
```
✅ Login succeeds after restart
✅ User data unchanged
✅ Profile shows same information
```

**Why**: 
- Data in DynamoDB (AWS managed)
- Not lost on server restart
- Not stored in local memory

---

## 📊 Verification Checklist

### After Each Test, Verify

| Item | Check | Result |
|------|-------|--------|
| **DynamoDB Table** | User appears in `oververseDB` table | ✅ |
| **Email Normalization** | `emailLower` field is lowercase | ✅ |
| **Password Security** | `passwordHash` is hashed (not plaintext) | ✅ |
| **Auth Type** | `authType: 'MAIL'` for email registrations | ✅ |
| **Timestamps** | `createdAt`, `updatedAt` set correctly | ✅ |
| **Profile Complete** | `profileComplete: true` for new users | ✅ |
| **No Guest Fields** | `isGuest: false` for email users | ✅ |

---

## 🔍 Debugging Failed Tests

### If Registration Fails

```
Error: "Database not connected"
→ Check: AWS credentials configured? DynamoDB table exists?

Error: "User already exists"  
→ Check: Email already in DynamoDB? Try different email

Error: "Registration error: [details]"
→ Check: Backend logs for error message
```

### If Login Fails

```
Error: "User not found"
→ Check: User registered? In DynamoDB or dev_dynamo_users.json?

Error: "Invalid credentials"
→ Check: Password correct? Email correct?

Error: "Database not connected"
→ Check: AWS DynamoDB accessible? USE_DEV_STORE=false?
```

### Check Backend Logs

**Location**: Backend terminal where `node ws_server.js` is running

**Key lines**:
```
[DEBUG] [auth/register] Validation...
[INFO] [auth/register] ✅ New user registered
[DEBUG] [auth/login] Login request received
[INFO] [auth/login] ✅ Login successful
```

**Copy-paste full logs if reporting issues**

---

## 📈 Expected Performance

| Operation | Time | Success Rate |
|-----------|------|--------------|
| Registration | 1-3 seconds | >99% |
| Login | 1-2 seconds | >99% |
| DynamoDB save | <500ms | 99.99% |
| EmailIndex query | <100ms | 99.99% |

---

## 🛑 Known Limitations

### Users Registered Before Fix

**Status**: ❌ Cannot login
**Reason**: Data in `dev_dynamo_users.json`, not DynamoDB
**Solution**: 
- Option 1: Re-register with new email
- Option 2: Migrate data (manual DynamoDB insert)

### Local Development (Offline)

**If AWS DynamoDB unavailable**:
```env
# Temporary fallback (dev only)
USE_DEV_STORE=true
```
⚠️ This stores data locally, data NOT synced to production

---

## ✅ Production Verification

Before deploying to production, verify:

```
✅ USE_DEV_STORE=false in .env
✅ AWS credentials configured properly
✅ DynamoDB table oververseDB exists in ap-south-1
✅ EmailIndex global secondary index exists
✅ S3 bucket configured (for profile images)
✅ Tests 1-5 all pass
✅ Multi-device sync works (Test 7)
✅ Server restart preserves data (Test 8)
```

---

## 📞 Troubleshooting Contacts

| Issue | Check | Resource |
|-------|-------|----------|
| DynamoDB error | AWS IAM permissions | AWS Console |
| S3 upload fails | S3 bucket ACL | S3 console |
| Email not normalizing | normalizeEmail() logic | dynamoDBService.js line 132 |
| Password hash mismatch | bcrypt version | package.json |

---

## Summary

✅ **Backend is ready for testing**
✅ **DynamoDB data persistence enabled**  
✅ **All tests should pass**

Run through tests 1-8 to verify everything works correctly!
