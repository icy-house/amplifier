# Amplifier - Cross-Device Apple Music Authentication

A Firebase Functions backend that enables cross-device authentication for the AmpleMusic Android automotive app using Apple Music APIs.

## Overview

Amplifier provides a secure cross-device authentication flow where users can authenticate with Apple Music on their phone/computer and have that authentication transferred to their car's AmpleMusic app. The backend generates Apple Music developer tokens and manages authentication sessions between devices.

**Key Features:**
- Cross-device authentication flow via QR codes
- Apple Music developer token generation
- Firebase Authentication integration
- Session management with automatic cleanup
- Rate limiting and security controls

## How It Works

1. **Car App**: Displays QR code with session ID
2. **User**: Scans QR code on phone/computer
3. **Web Page**: User signs in with Apple via Firebase Auth
4. **Backend**: Generates Apple Music tokens and stores session
5. **Car App**: Polls for session completion and receives tokens

## Prerequisites

- Node.js 18+
- Firebase CLI
- Apple Developer Account with Music API access
- Firebase project with Authentication enabled

## Setup

### 1. Apple Developer Setup

1. Create Apple Music API key in [Apple Developer Console](https://developer.apple.com/account/)
2. Download the `.p8` private key file
3. Note your Key ID, Team ID, and Issuer ID

### 2. Firebase Configuration

```bash
# Create Firebase project
firebase login
firebase projects:create amplifier-backend

# Initialize functions
cd Amplifier
firebase use amplifier-backend
firebase init functions
```

### 3. Environment Setup

```bash
# Copy environment template
cp env.example .env

# Set Apple Music credentials
firebase functions:config:set apple.key_id="YOUR_KEY_ID"
firebase functions:config:set apple.team_id="YOUR_TEAM_ID"
firebase functions:config:set apple.issuer="YOUR_ISSUER_ID"
firebase functions:config:set apple.private_key_path="/path/to/AuthKey_KEYID.p8"
```

### 4. Deploy

```bash
npm install
npm run build
npm run deploy
```

## API Endpoints

### POST /initializeSession
Creates a new authentication session for cross-device flow.

**Request:**
```json
{
  "sessionId": "unique-session-id",
  "firebaseIdToken": "firebase-auth-token"
}
```

### POST /completeAuthentication
Completes authentication and generates Apple Music tokens.

**Request:**
```json
{
  "sessionId": "unique-session-id",
  "firebaseIdToken": "firebase-auth-token"
}
```

**Response:**
```json
{
  "success": true,
  "userAccessToken": "apple-music-developer-token"
}
```

### GET /getSessionStatus?sessionId=xxx
Check authentication session status (used by car app).

**Response:**
```json
{
  "success": true,
  "status": "success|pending|error",
  "userAccessToken": "token-if-success"
}
```

### GET /health
Health check endpoint.

## Usage in AmpleMusic App

```kotlin
// 1. Generate session ID and display QR code
val sessionId = UUID.randomUUID().toString()
val qrUrl = "https://amplifier-backend.web.app/auth.html?sessionId=$sessionId"

// 2. Initialize session
val response = apiClient.initializeSession(sessionId, firebaseToken)

// 3. Poll for completion
while (true) {
    val status = apiClient.getSessionStatus(sessionId)
    if (status.status == "success") {
        val appleMusicToken = status.userAccessToken
        // Use token for Apple Music API calls
        break
    }
    delay(2000) // Poll every 2 seconds
}
```

## Security Features

- **Firebase Authentication**: All requests require valid Firebase tokens
- **Rate Limiting**: Prevents abuse with configurable limits
- **Session Expiration**: Sessions auto-expire after 5 minutes
- **CORS Protection**: Proper cross-origin request handling
- **Automatic Cleanup**: Expired sessions are cleaned up every 5 minutes

## Project Structure

```
Amplifier/
├── src/
│   ├── index.ts              # Main Firebase Functions
│   └── apple-music-auth.ts   # Apple Music token generation
├── public/
│   ├── auth.html            # Cross-device auth web page
│   └── auth-success.html    # Success confirmation page
├── firebase.json            # Firebase configuration
└── package.json             # Dependencies
```

## License

ISC License
