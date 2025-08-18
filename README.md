# Amplifier - Apple Music Authentication Backend

A secure Firebase Functions backend that provides Apple Music developer tokens for the AmpleMusic Android app.

## Overview

This backend service generates Apple Music developer tokens (JWTs) that are required for authenticating with Apple Music APIs. The tokens are generated securely on the server side and provided to the client app via HTTP endpoints.

**🔒 Security Features:**
- Firebase Authentication required for all token requests
- API key authentication for server-to-server communication
- Rate limiting to prevent abuse
- Request validation and logging
- CORS protection

## Prerequisites

1. **Node.js 18+** installed on your machine
2. **Firebase CLI** installed globally: `npm install -g firebase-tools`
3. **Apple Developer Account** with Apple Music API access
4. **Apple Music API Key** generated from Apple Developer Console
5. **Firebase Project** with Authentication enabled

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

2. **Enable Firebase Authentication:**
   - Go to Firebase Console → Authentication
   - Enable the authentication methods you need (Email/Password, Google, etc.)

3. **Initialize Firebase Functions:**
   ```bash
   cd Amplifier
   firebase use amplifier-backend
   firebase init functions
   ```
   - Choose TypeScript
   - Use existing project
   - Install dependencies with npm

### 3. Security Configuration

1. **Generate API Keys** (for server-to-server communication):
   ```bash
   # Generate secure random API keys
   openssl rand -hex 32
   openssl rand -hex 32
   ```

2. **Copy the environment template:**
   ```bash
   cp env.example .env
   ```

3. **Edit `.env` with your credentials:**
   ```bash
   # Apple Music Configuration
   APPLE_MUSIC_KEY_ID=YOUR_KEY_ID_HERE
   APPLE_MUSIC_TEAM_ID=YOUR_TEAM_ID_HERE
   APPLE_MUSIC_PRIVATE_KEY_PATH=/path/to/your/AuthKey_KEYID.p8
   APPLE_MUSIC_ISSUER=YOUR_ISSUER_ID_HERE

   # Security Configuration
   VALID_API_KEYS=your-generated-api-key-1,your-generated-api-key-2
   ALLOWED_USER_IDS=user1,user2,user3  # Optional: restrict to specific users
   ```

4. **Set Firebase environment variables:**
   ```bash
   firebase functions:config:set apple.key_id="YOUR_KEY_ID_HERE"
   firebase functions:config:set apple.team_id="YOUR_TEAM_ID_HERE"
   firebase functions:config:set apple.issuer="YOUR_ISSUER_ID_HERE"
   firebase functions:config:set apple.private_key_path="/path/to/your/AuthKey_KEYID.p8"
   firebase functions:config:set security.api_keys="your-generated-api-key-1,your-generated-api-key-2"
   firebase functions:config:set security.allowed_users="user1,user2,user3"
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
- `http://localhost:5001/amplifier-backend/us-central1/getAppleMusicToken` (requires authentication)
- `http://localhost:5001/amplifier-backend/us-central1/health` (no auth required)
- `http://localhost:5001/amplifier-backend/us-central1/authStatus` (for debugging auth)

### 6. Deploy to Firebase

```bash
npm run deploy
```

## API Endpoints

### GET/POST /getAppleMusicToken

Generates and returns an Apple Music developer token.

**Authentication Required:** Yes (Firebase Auth token or API key)

**Headers:**
```
Authorization: Bearer <firebase-id-token>
# OR
X-API-Key: <your-api-key>
```

**Response:**
```json
{
  "success": true,
  "developerToken": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IktFWUlEIn0...",
  "expiresIn": 3600,
  "generatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Error Responses:**
```json
// Authentication failed
{
  "success": false,
  "error": "No valid authentication token provided"
}

// Rate limit exceeded
{
  "success": false,
  "error": "Rate limit exceeded. Please try again later."
}
```

### GET /health

Health check endpoint (no authentication required).

**Response:**
```json
{
  "status": "healthy",
  "service": "Amplifier Apple Music Backend",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "security": "enabled"
}
```

### GET /authStatus

Check authentication status (for debugging).

**Authentication Required:** Yes

**Response:**
```json
{
  "success": true,
  "authenticated": true,
  "user": {
    "uid": "user123",
    "email": "user@example.com",
    "emailVerified": true
  },
  "error": null
}
```

## Usage in Android App

### Using Firebase Authentication

```kotlin
// Get Firebase Auth token
FirebaseAuth.getInstance().currentUser?.getIdToken(false)
    ?.addOnCompleteListener { task ->
        if (task.isSuccessful) {
            val token = task.result?.token
            // Make API request with token
            makeTokenRequest(token)
        }
    }

private fun makeTokenRequest(firebaseToken: String?) {
    val url = "https://us-central1-amplifier-backend.cloudfunctions.net/getAppleMusicToken"
    val request = Request.Builder()
        .url(url)
        .addHeader("Authorization", "Bearer $firebaseToken")
        .build()
    // Make HTTP request and use the returned developerToken
}
```

### Using API Key (Server-to-Server)

```kotlin
val url = "https://us-central1-amplifier-backend.cloudfunctions.net/getAppleMusicToken"
val request = Request.Builder()
    .url(url)
    .addHeader("X-API-Key", "your-api-key")
    .build()
// Make HTTP request and use the returned developerToken
```

## Security Features

### 🔐 Authentication
- **Firebase Authentication**: All requests must include a valid Firebase ID token
- **API Key Authentication**: Alternative authentication for server-to-server communication
- **User Restriction**: Optional whitelist of allowed user IDs

### 🛡️ Rate Limiting
- **Default**: 10 requests per minute per user/IP
- **Configurable**: Adjust limits via environment variables
- **In-Memory Storage**: For development (use Redis in production)

### 📝 Logging & Monitoring
- All token generation requests are logged (without sensitive data)
- Authentication failures are logged
- Rate limit violations are tracked

### 🔒 CORS Protection
- Proper CORS headers for cross-origin requests
- Preflight request handling

## Security Best Practices

- **Never commit your `.p8` private key file to version control**
- **Use Firebase Secret Manager for production secrets**
- **Generate strong, random API keys for production**
- **Implement proper user authentication in your app**
- **Monitor API usage and set up alerts for unusual activity**
- **Use HTTPS for all production requests**
- **Consider implementing additional rate limiting at the CDN level**

## Troubleshooting

### Common Issues

1. **"No valid authentication token provided"**
   - Ensure your app is properly authenticated with Firebase
   - Check that the Authorization header is correctly formatted
   - Verify the Firebase token hasn't expired

2. **"Rate limit exceeded"**
   - Reduce the frequency of requests
   - Implement client-side caching of tokens
   - Contact admin if you need higher limits

3. **"User not authorized to access this service"**
   - Check if user restriction is enabled
   - Verify the user ID is in the allowed list

### Debug Mode

To check authentication status:

```bash
curl -H "Authorization: Bearer YOUR_FIREBASE_TOKEN" \
  https://us-central1-amplifier-backend.cloudfunctions.net/authStatus
```

## Project Structure

```
Amplifier/
├── src/
│   ├── index.ts              # Main Firebase Functions with security
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
5. Ensure all security tests pass
6. Submit a pull request

## License

ISC License
