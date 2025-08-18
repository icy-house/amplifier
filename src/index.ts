import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { generateDeveloperToken } from './apple-music-auth';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// API keys for server-to-server communication (store in Firebase Secret Manager in production)
function getValidApiKeys(): string[] {
  try {
    const functionsConfig = functions.config();
    return functionsConfig.security?.api_keys?.split(',') || process.env.VALID_API_KEYS?.split(',') || [];
  } catch (error) {
    console.warn('Failed to get API keys from Firebase config, falling back to environment variable');
    return process.env.VALID_API_KEYS?.split(',') || [];
  }
}

const VALID_API_KEYS = getValidApiKeys();

interface AuthenticatedRequest extends functions.https.Request {
  user?: admin.auth.DecodedIdToken;
}

// Rate limiting middleware
function checkRateLimit(identifier: string, limit: number = 10, windowMs: number = 60000): boolean {
  const now = Date.now();
  const record = rateLimitStore.get(identifier);

  if (!record || now > record.resetTime) {
    rateLimitStore.set(identifier, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (record.count >= limit) {
    return false;
  }

  record.count++;
  return true;
}

// Authentication middleware
async function authenticateRequest(request: AuthenticatedRequest): Promise<{ authenticated: boolean; user?: admin.auth.DecodedIdToken; error?: string }> {
  try {
    // Check for API key first (for server-to-server communication)
    const apiKey = request.headers['x-api-key'] || request.headers['authorization']?.replace('Bearer ', '');
    if (apiKey && typeof apiKey === 'string' && VALID_API_KEYS.includes(apiKey)) {
      return { authenticated: true };
    }

    // Check for Firebase Auth token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { authenticated: false, error: 'No valid authentication token provided' };
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    // Optional: Check if user has specific claims or is in allowed list
    // const allowedUsers = process.env.ALLOWED_USER_IDS?.split(',') || [];
    // if (allowedUsers.length > 0 && !allowedUsers.includes(decodedToken.uid)) {
    //   return { authenticated: false, error: 'User not authorized to access this service' };
    // }

    request.user = decodedToken;
    return { authenticated: true, user: decodedToken };
  } catch (error) {
    console.error('Authentication error:', error);
    return { authenticated: false, error: 'Invalid authentication token' };
  }
}

// HTTP function to generate and return Apple Music developer token
export const getAppleMusicToken = functions.https.onRequest(async (request: AuthenticatedRequest, response) => {
  try {
    // Set CORS headers for cross-origin requests
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    // Validate request method
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.status(405).json({
        success: false,
        error: 'Method not allowed'
      });
      return;
    }

    // Authenticate the request
    const authResult = await authenticateRequest(request);
    if (!authResult.authenticated) {
      response.status(401).json({
        success: false,
        error: authResult.error || 'Authentication failed'
      });
      return;
    }

    // Rate limiting
    const identifier = authResult.user?.uid ||
      (typeof request.headers['x-forwarded-for'] === 'string' ? request.headers['x-forwarded-for'] : '') ||
      request.ip ||
      'unknown';
    if (!checkRateLimit(identifier, 10, 60000)) { // 10 requests per minute
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
      return;
    }

    // Generate the developer token
    const developerToken = await generateDeveloperToken();

    // Log successful token generation (without sensitive data)
    console.log(`Apple Music token generated successfully for user: ${authResult.user?.uid || 'API_KEY'}`);

    response.status(200).json({
      success: true,
      developerToken,
      expiresIn: 3600, // Token expires in 1 hour
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating Apple Music token:', error);
    response.status(500).json({
      success: false,
      error: 'Failed to generate Apple Music token'
    });
  }
});

// Health check endpoint (no authentication required)
export const health = functions.https.onRequest((request, response) => {
  response.status(200).json({
    status: 'healthy',
    service: 'Amplifier Apple Music Backend',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    security: 'enabled'
  });
});

// Admin endpoint to check authentication status (for debugging)
export const authStatus = functions.https.onRequest(async (request: AuthenticatedRequest, response) => {
  try {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    const authResult = await authenticateRequest(request);

    response.status(200).json({
      success: true,
      authenticated: authResult.authenticated,
      user: authResult.user ? {
        uid: authResult.user.uid,
        email: authResult.user.email,
        emailVerified: authResult.user.email_verified
      } : null,
      error: authResult.error || null
    });
  } catch (error) {
    console.error('Auth status check error:', error);
    response.status(500).json({
      success: false,
      error: 'Failed to check authentication status'
    });
  }
});
