# Amplifier - Apple Music Authentication Backend

A Firebase Functions backend that provides Apple Music developer tokens for the AmpleMusic Android app.

## Overview

This backend service generates Apple Music developer tokens (JWTs) that are required for authenticating with Apple Music APIs. The tokens are generated securely on the server side and provided to the client app via HTTP endpoints.

## Prerequisites

1. **Node.js 18+** installed on your machine
2. **Firebase CLI** installed globally: `npm install -g firebase-tools`
3. **Apple Developer Account** with Apple Music API access
4. **Apple Music API Key** generated from Apple Developer Console

## Setup Instructions

### 1. Apple Developer Console Setup

1. Go to [Apple Developer Console](https://developer.apple.com/account/)
2. Navigate to **Certificates, Identifiers & Profiles**
3. Go to **Keys** section
4. Click **+** to create a new key
5. Enable **Apple Music API** access
6. Download the `.p8` private key file (you can only download this once!)
7. Note down:
   - **Key ID** (found in the key details)
   - **Team ID** (found in your developer account)
   - **Issuer ID** (found in your developer account)

### 2. Firebase Project Setup

1. **Create a new Firebase project:**
   ```bash
   firebase login
   firebase projects:create amplifier-backend
   ```

2. **Initialize Firebase Functions:**
   ```bash
   cd Amplifier
   firebase use amplifier-backend
   firebase init functions
   ```
   - Choose TypeScript
   - Use existing project
   - Install dependencies with npm

### 3. Environment Configuration

1. **Copy the environment template:**
   ```bash
   cp env.example .env
   ```

2. **Edit `.env` with your Apple Music credentials:**
   ```bash
   APPLE_MUSIC_KEY_ID=YOUR_KEY_ID_HERE
   APPLE_MUSIC_TEAM_ID=YOUR_TEAM_ID_HERE
   APPLE_MUSIC_PRIVATE_KEY_PATH=/path/to/your/AuthKey_KEYID.p8
   APPLE_MUSIC_ISSUER=YOUR_ISSUER_ID_HERE
   ```

3. **Set Firebase environment variables:**
   ```bash
   firebase functions:config:set apple.key_id="YOUR_KEY_ID_HERE"
   firebase functions:config:set apple.team_id="YOUR_TEAM_ID_HERE"
   firebase functions:config:set apple.issuer="YOUR_ISSUER_ID_HERE"
   firebase functions:config:set apple.private_key_path="/path/to/your/AuthKey_KEYID.p8"
   ```

### 4. Install Dependencies

```bash
npm install
```

### 5. Build and Test Locally

```bash
# Build TypeScript
npm run build

# Start Firebase emulator
npm run serve
```

The functions will be available at:
- `http://localhost:5001/amplifier-backend/us-central1/getAppleMusicToken`
- `http://localhost:5001/amplifier-backend/us-central1/health`

### 6. Deploy to Firebase

```bash
npm run deploy
```

## API Endpoints

### GET /getAppleMusicToken

Generates and returns an Apple Music developer token.

**Response:**
```json
{
  "success": true,
  "developerToken": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IktFWUlEIn0...",
  "expiresIn": 3600
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Failed to generate Apple Music token"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "service": "Amplifier Apple Music Backend",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Usage in Android App

Your Android app can call the deployed endpoint to get a developer token:

```kotlin
// Example HTTP request to get developer token
val url = "https://us-central1-amplifier-backend.cloudfunctions.net/getAppleMusicToken"
// Make HTTP request and use the returned developerToken
```

## Security Notes

- **Never commit your `.p8` private key file to version control**
- **Use Firebase environment variables for production secrets**
- **The developer token expires in 6 months, but we generate fresh ones on each request**
- **Consider implementing rate limiting for production use**

## Troubleshooting

### Common Issues

1. **"Missing required Apple Music configuration"**
   - Check that all environment variables are set correctly
   - Verify the private key file path is correct

2. **"Failed to read Apple Music private key"**
   - Ensure the `.p8` file exists and is readable
   - Check file permissions

3. **"Failed to generate Apple Music developer token"**
   - Verify your Apple Developer account has Apple Music API access
   - Check that the key ID, team ID, and issuer ID are correct

### Debug Mode

To run with debug logging:

```bash
DEBUG=* npm run serve
```

## Project Structure

```
Amplifier/
├── src/
│   ├── index.ts              # Main Firebase Functions entry point
│   └── apple-music-auth.ts   # Apple Music authentication logic
├── lib/                      # Compiled JavaScript (generated)
├── firebase.json             # Firebase configuration
├── .firebaserc              # Firebase project settings
├── tsconfig.json            # TypeScript configuration
├── package.json             # Dependencies and scripts
├── env.example              # Environment variables template
└── README.md                # This file
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `npm run serve`
5. Submit a pull request

## License

ISC License
