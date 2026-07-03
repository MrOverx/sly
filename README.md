# slyxyserver Backend

This folder contains the SLYXY backend server and backend test helpers.

## Recommended backend workflows

### Run the backend locally

From `slyxyserver/`:

```bash
npm install
npm run dev
```

Or from the repo root (`slyxy/`):

```bash
npm --prefix ../slyxyserver install
npm --prefix ../slyxyserver run dev
```

### Unit tests

From `slyxyserver/`:

```bash
npm test
```

From the repo root (`slyxy/`):

```bash
npm --prefix ../slyxyserver test
```

This runs Jest against `__tests__/` only. The `tests/` directory is reserved for helper scripts and smoke tests.

### Backend helper scripts

The `slyxyserver/tests/` folder contains utility scripts for local development and debugging:

- `tests/upsert_dev_user.js` - inserts or updates a sample user in the local JSON dev store.
- `tests/test_get_user_lookup.js` - validates the backend login lookup flow against the dev store.
- `tests/migrate_email_lower.js` - populates missing `emailLower` values in the local JSON dev store.
- `tests/smoke_test.js` - end-to-end smoke test against a running backend.
- `tests/smoke_test.ps1` - Windows PowerShell version of the same smoke test.

### Cross-platform smoke test

The smoke test is designed to run against a locally running backend on `http://localhost:8080`.

From the repo root (`slyxy/`):

```bash
npm run smoke:backend
```

This command does two things:

1. Seeds the local dev store with a sample user via `tests/upsert_dev_user.js`
2. Runs `tests/smoke_test.js`

If your backend is running on a different host or port, set `BASE_URL` before running:

```bash
BASE_URL=http://localhost:3000 npm run smoke:backend
```

### Running smoke test directly from `slyxyserver/`

If you prefer to run the smoke test directly inside the backend folder:

```bash
node tests/upsert_dev_user.js
node tests/smoke_test.js
```

### Notes on local dev store

The backend can use a local JSON fallback store when AWS credentials are not present and no local DynamoDB endpoint is configured. This is controlled by:

- `USE_DEV_STORE=true` to force the JSON dev store
- `USE_DEV_STORE=false` to prevent the fallback store

In production, the server is protected so it will refuse to start if `NODE_ENV=production` while the local dev store is enabled.

### Useful commands summary

From the repo root (`slyxy/`):

```bash
npm run test:backend        # Seed dev store and run test_get_user_lookup
npm run smoke:backend       # Seed dev store and run the smoke test
npm --prefix ../slyxyserver test  # Run backend unit tests
```

From the backend folder (`slyxyserver/`):

```bash
npm test
npm run dev
node tests/smoke_test.js
```
