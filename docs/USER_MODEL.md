User model - new/validated fields

- `avatarLetter`: single ASCII letter (A-Z). Trimmed and upper-cased on input.
- `useColorProfile`: boolean flag controlling avatar color usage.
- `likedUserIds`: array of userId strings (max 500 entries).
- `friends`: array of objects { `friendId`: string, `addedAt`: ISO date string } (max 1000 entries).
- Friend-requests handling is currently disabled in validation; incoming `friendRequests` payloads are ignored by the server.
- `isOnline`, `isFriend`, `hasProfileChanged`: booleans.
- `xp`: object preserved; expected numeric subfields like `base`, `daily`, `social` when present.
- `lastDailyXpAwardedAt`: ISO date string.

Validation is applied in `middleware/validation.js` — invalid types or malformed data return `400 VALIDATION_ERROR`.