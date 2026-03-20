# Chat Progress - 2026-03-20

## Context

User asked to review the saved chat note at:

- `D:\Personal files\Personal\New\Personal projects\warcraft\notes\chat-review-2026-03-19.md`

That note contained a prior review of the Warcraft project and highlighted these priority areas:

1. Auth/security hotfix
2. Socket authorization hardening
3. Production fallback hardening
4. Modularization
5. Test suite

## What Was Reviewed Again

The project folder was re-checked:

- `D:\Personal files\Personal\New\Personal projects\warcraft`

Main server/client files inspected again:

- `server/src/routes/auth.js`
- `server/src/routes/rooms.js`
- `server/src/routes/social.js`
- `server/src/middleware/auth.js`
- `server/src/index.js`
- `client/main.js`
- `client/src/renderer/app.js`

## Changes Implemented

### 1. Auth Security Hardening

Updated:

- `server/src/routes/auth.js`
- `server/src/middleware/auth.js`

Implemented:

- `forgot-password` no longer returns reset tokens in API responses
- password reset tokens are stored hashed before DB insert
- `reset-password` now validates hashed token values
- Discord linking flow now requires authenticated token input and uses signed state
- production mode no longer silently falls back to guest-style optional auth
- production mode returns `503` instead of using unsafe in-memory fallback for auth flows that require DB

### 2. Socket / Room Authorization Hardening

Updated:

- `server/src/index.js`
- `server/src/routes/rooms.js`

Implemented:

- added room membership verification helper in `rooms.js`
- `room:join` guarded by server-side membership validation
- `chat:message` guarded by membership validation
- `room:host_ip` guarded
- `zt:authorize` guarded
- `room:zt_ip` guarded
- `room:ready` guarded
- `room:get_zt_ips` guarded
- `room:refresh_zt` guarded

### 3. Production Fallback Hardening

Updated:

- `server/src/routes/rooms.js`
- `server/src/routes/social.js`

Implemented:

- production mode now rejects DB-backed room/social actions with `503` when DB is unavailable
- removed reliance on in-memory fallback paths for production safety in these modules

### 4. Client Adjustments

Updated:

- `client/main.js`
- `client/src/renderer/app.js`

Implemented:

- Discord link flow now passes the current auth token when initiating link
- forgot-password UI no longer expects a reset token to be returned directly from the backend

## Test Foundation Added

Updated:

- `server/package.json`
- `server/tests/server.test.js`

Implemented:

- added a server test script
- added a lightweight integration/smoke test runner without bringing in a full external test framework

Smoke coverage includes:

- `GET /`
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/forgot-password` expected `503` without DB
- `GET /rooms` expected `503` in production mode without DB

## Verification Performed

Syntax checks passed for:

- `server/src/routes/auth.js`
- `server/src/routes/rooms.js`
- `server/src/routes/social.js`
- `server/src/index.js`
- `client/main.js`
- `server/tests/server.test.js`

Dependency install:

- `npm.cmd install`

Test run:

- `npm.cmd test`

Observed result:

- both custom smoke tests passed
- migration logs reported missing local DB (`wc3platform`), which was expected in this no-DB smoke environment

## Notable Notes

- Git status could not be read normally at first because the repo is marked with dubious ownership under the sandbox user.
- `npm.ps1` was blocked by PowerShell execution policy, so `npm.cmd` was used instead.
- Initial attempts to use Node's built-in test runner isolation hit sandbox/process limitations, so the test setup was converted into a custom single-process runner.

## Current Outcome

The first meaningful hardening pass is complete:

- auth flow is safer
- reset token leak is closed
- Discord linking is harder to abuse
- socket room access is server-validated in key paths
- production fallback behavior is stricter
- smoke tests now exist and pass locally after dependency install

## Suggested Next Steps

1. Add real email delivery for password reset
2. Add DB-backed integration tests for auth/rooms/socket flows
3. Refactor oversized server/client files into modules
4. Add more assertions around ZeroTier and room lifecycle behavior
