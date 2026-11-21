# Amplifier

Amplifier is the helper service for **AmpleMusic**, the Apple Music app in the car.

Logging into Apple Music on a car screen is awkward, so the car shows a QR code. You scan it on your phone, sign in there, and Amplifier passes the login back to the car so the car can play your music.

## Overview

Amplifier is a Firebase backend (Cloud Functions, Hosting, Firestore, Auth) that runs that cross-device login flow for the AmpleMusic Android automotive app.

**Key Features:**
- Cross-device authentication via QR codes
- Apple Music / MusicKit token handoff to the car
- Firebase Authentication (Sign in with Apple on the phone)
- Short-lived session management with cleanup
- Rate limiting and security controls

## How It Works

1. **Car app**: Creates a session, keeps a poll secret, shows a QR code (`sessionId` only)
2. **User**: Scans the QR code on a phone or computer
3. **Web page**: User signs in with Apple (Firebase Auth) and authorizes Apple Music (MusicKit)
4. **Backend**: Stores the completed session and short-lived tokens for the car
5. **Car app**: Polls with `sessionId` + poll secret until success, then receives tokens once

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Car as AmpleMusic<br/>(car)
  participant Amp as Amplifier<br/>(Firebase)
  participant Apple as Apple<br/>(SIWA + MusicKit)

  Car->>Amp: Create session
  Amp-->>Car: sessionId + pollSecret
  Note over Car: QR shows sessionId only<br/>pollSecret stays on car

  User->>Car: Scan QR with phone
  User->>Amp: Open auth.html?sessionId=…
  User->>Apple: Sign in with Apple
  Apple-->>Amp: Firebase identity (via Firebase Auth)
  User->>Apple: MusicKit authorize
  Apple-->>Amp: Music user token
  Amp->>Amp: Store tokens on session<br/>(short-lived developer JWT + user token)

  loop Until success or expiry
    Car->>Amp: Poll with sessionId + pollSecret
    Amp-->>Car: pending / success + tokens (once)
  end

  Car->>Apple: Play music with tokens
```

**Who does what**
- **AmpleMusic (car)** — starts the session, shows the QR, keeps the poll secret, then uses the tokens to talk to Apple Music.
- **Amplifier** — brokers the handoff: session, phone auth page, short-lived tokens, one-time delivery to the car.
- **Apple** — Sign in with Apple (who you are) and MusicKit (permission to use Apple Music). Those are two different steps.

## Prerequisites

- Node.js 24 (Cloud Functions 2nd gen runtime; keep local Node aligned)
- Firebase CLI
- Apple Developer Account (Sign in with Apple **and** MusicKit / Media Services)
- Firebase project with Authentication enabled (production: `amplemusic-prod`)

## Setup

Apple uses **two different keys**. Do not reuse one for the other.

| Purpose | Example Key ID | Stored where |
|---------|----------------|--------------|
| **Sign in with Apple** (Firebase Auth on `auth.html`) | `RU5TXX2DP2` | Firebase Auth → Apple provider (Team ID, Key ID, `.p8`) |
| **MusicKit** developer JWT | `U2RCA774DG` | Secret Manager `APPLE_MUSIC_PRIVATE_KEY` + deploy params |

### 1. Apple Developer

1. Create a **Media Services** key for MusicKit; download its `.p8` once; note Key ID and Team ID.
2. Create (or reuse) a key with **Sign in with Apple** enabled for Firebase Auth; keep that `.p8` separate.
3. Services ID (web SIWA), e.g. `house.icy.amplemusic.service`, with:
   - Domains: `ample.icy.house` (and optionally `amplemusic-prod.firebaseapp.com`)
   - Return URLs: `https://ample.icy.house/__/auth/handler` (authDomain must match the page origin for redirect SIWA)

More detail: `PRODUCTION_SETUP.md`.

### 2. Firebase project

```bash
firebase login
firebase use amplemusic-prod   # see .firebaserc
```

Enable **Authentication → Sign-in method → Apple** with the SIWA Services ID, Team ID, Key ID, and SIWA `.p8` (not the MusicKit key).

### 3. MusicKit environment (Functions)

Params and secrets replace the old `functions.config()` / `.runtimeconfig.json` flow.

```bash
# Non-secret MusicKit params (gitignored .env.<projectId>)
cat >> .env.amplemusic-prod <<'EOF'
APPLE_MUSIC_KEY_ID=YOUR_MUSICKIT_KEY_ID
APPLE_MUSIC_TEAM_ID=YOUR_TEAM_ID
APPLE_MUSIC_ISSUER=YOUR_TEAM_ID
EOF

# MusicKit private key in Secret Manager (not the SIWA key)
firebase functions:secrets:set APPLE_MUSIC_PRIVATE_KEY --project amplemusic-prod
```

For the emulator, put the same non-secret params in `.env` / `.env.local`, and the MusicKit private key in `.secret.local` as `APPLE_MUSIC_PRIVATE_KEY=...` (never commit these files).

### 4. Deploy

```bash
npm install
npm run build
npm run deploy
```

Runtime is **Node.js 24** (`engines.node` and `firebase.json` `runtime: nodejs24`). Functions are **2nd gen**.

Phone auth page: https://ample.icy.house/auth.html (also `amplemusic-prod.web.app`)

## API Endpoints

### POST /createSession
Car creates a server-issued session. Returns high-entropy `sessionId` + `pollSecret`. Put only `sessionId` in the QR; keep `pollSecret` on the car.

**Response:**
```json
{
  "success": true,
  "sessionId": "server-generated-id",
  "pollSecret": "car-held-secret"
}
```

### POST /initializeSession
Phone binds Sign in with Apple (Firebase Auth) to an existing session. Does not create or overwrite sessions.

**Headers:** `Authorization: Bearer <firebaseIdToken>`

**Request:**
```json
{
  "sessionId": "server-generated-id"
}
```

### POST /completeAuthentication
Phone completes authentication and stores short-lived tokens for the car. Tokens are not returned to the phone.

**Headers:** `Authorization: Bearer <firebaseIdToken>`

**Request:**
```json
{
  "sessionId": "server-generated-id"
}
```

### GET /getSessionStatus?sessionId=xxx
Car polls session status. Requires `X-Poll-Secret`. On success, tokens are returned to the car; a short redelivery window covers lost responses, then token fields are redacted.

**Headers:** `X-Poll-Secret: <pollSecret>`

**Response:**
```json
{
  "success": true,
  "status": "success|pending|error|consumed",
  "userAccessToken": "present during first handoff + short redelivery window"
}
```

### GET /health
Health check endpoint.

## Usage in AmpleMusic App

```kotlin
// 1. Create session on Amplifier (server issues IDs)
val created = apiClient.createSession()
val sessionId = created.sessionId
val pollSecret = created.pollSecret // keep on car only

// 2. Show QR with sessionId only
val qrUrl = "https://ample.icy.house/auth.html?sessionId=$sessionId"

// 3. Poll with poll secret until tokens arrive (retry-safe briefly)
while (true) {
    val status = apiClient.getSessionStatus(sessionId, pollSecret)
    when (status.status) {
        "success" -> {
            val appleMusicToken = status.userAccessToken
                ?: error("success without token; start a new session")
            // Use token for Apple Music API calls
            break
        }
        "consumed", "error" -> error("Session ended; show a new QR")
        else -> delay(2000) // pending
    }
}
```

## Security Features

- Server-issued `sessionId` + car-held `pollSecret` (QR never includes the secret)
- Authenticated car polling (`X-Poll-Secret`) with single-use token handoff (+ short redelivery window)
- Firestore `auth_sessions`: deny-all for client SDKs (Admin SDK / Functions only)
- Firebase Authentication on the phone auth path
- Short-lived sessions and short-lived handoff developer JWTs (real MusicKit user token tracked separately)
- Secrets in Secret Manager (not the repo)
- Rate limiting (durable abuse controls still tracked separately)

## Project Structure

```
Amplifier/
├── src/
│   ├── index.ts              # Main Firebase Functions
│   └── apple-music-auth.ts   # Apple Music token generation
├── public/
│   ├── auth.html            # Cross-device auth web page
│   └── auth-success.html    # Success confirmation page
├── .cursor/
│   ├── rules/               # Persistent agent rules for this repo
│   └── skills/              # Project skill for developing Amplifier
├── firebase.json            # Firebase configuration
└── package.json             # Dependencies
```

## License

ISC License
