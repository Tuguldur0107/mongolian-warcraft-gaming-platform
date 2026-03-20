# Warcraft Platform

Warcraft 3 / DotA community desktop app and backend server.

This repository now has two clear usage paths:

## 1. End Users

If someone only wants to use the app, they should not clone the repo.

1. Open the project's GitHub Releases page.
2. Download the latest Windows installer from `client/dist` release assets.
3. Install and launch the app.
4. Sign in and choose the Warcraft executable the first time.

The desktop app already points to the hosted production API by default, so end users do not need to run the backend locally.

## 2. Local Development

### Requirements

- Node.js 20+
- npm 10+
- PostgreSQL
- Windows, if you want to test the Electron + ZeroTier flow end-to-end

### Quick Start

```bash
npm run setup
copy server\.env.example server\.env
copy client\.env.example client\.env
npm start
```

What this does:

- installs `server` dependencies
- installs `client` dependencies
- starts the backend on `http://127.0.0.1:3000`
- starts the Electron app and points it at the local backend

## Environment Files

### `server/.env`

Minimum local configuration:

```env
PORT=3000
CLIENT_URL=*
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/warcraft
JWT_SECRET=change-this-in-production
```

Optional integrations:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `ZEROTIER_API_TOKEN`
- `ZEROTIER_DEFAULT_NETWORK`
- `RZR_BOT_URL`
- `WEBHOOK_SECRET`

### `client/.env`

```env
SERVER_URL=http://127.0.0.1:3000
```

The client also works without this file because production is the built-in fallback.

## Root Commands

Run these from the repository root:

- `npm run setup`: install both apps
- `npm start`: start server + Electron for local development
- `npm run server`: start only the backend
- `npm run client`: start only the Electron app
- `npm run test:server`: run backend tests
- `npm run build:client`: build the Windows installer

## Project Structure

- `client/`: Electron desktop app
- `server/`: Express API + Socket.IO backend
- `notes/`: local progress notes

## Packaging Recommendation

If the goal is to make installation easy for real users, distribute only the packaged Electron installer from GitHub Releases. Asking users to clone the repo, install Node.js, and run commands is still a developer workflow, not a user workflow.
