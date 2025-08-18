import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// API keys for distribution (store in Firebase Secret Manager in production)
function getDistributableApiKeys(): string[] {
  try {
    const functionsConfig = functions.config();
    return functionsConfig.security?.api_keys?.split(',') || process.env.VALID_API_KEYS?.split(',') || [];
  } catch (error) {
    console.warn('Failed to get API keys from Firebase config, falling back to environment variable');
    return process.env.VALID_API_KEYS?.split(',') || [];
  }
}

const DISTRIBUTABLE_API_KEYS = getDistributableApiKeys();

// Request and response models
interface ApiKeyRequest {
  userId: string;
  deviceId: string;
  appVersion: string;
}

interface ApiKeyResponse {
  success: boolean;
  apiKey?: string;
  expiresAt?: string;
  error?: string;
}

// Rate limiting function
function checkRateLimit(identifier: string, limit: number = 5, windowMs: number = 300000): boolean {
  const now = Date.now();
  const record = rateLimitStore.get(identifier) || { count: 0, resetTime: now + windowMs };

  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + windowMs;
  }

  if (record.count >= limit) {
    return false;
  }

  record.count++;
  rateLimitStore.set(identifier, record);
  return true;
}

// Authentication middleware
async function authenticateRequest(request: functions.https.Request): Promise<{ authenticated: boolean; user?: admin.auth.DecodedIdToken; error?: string }> {
  try {
    // Check for Firebase Auth token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { authenticated: false, error: 'No valid authentication token provided' };
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    return { authenticated: true, user: decodedToken };
  } catch (error) {
    console.error('Authentication error:', error);
    return { authenticated: false, error: 'Invalid authentication token' };
  }
}

// HTTP function to distribute API keys to authenticated users
export const getApiKey = functions.https.onRequest(async (request, response) => {
  // Enable CORS
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    response.status(204).send('');
    return;
  }

  if (request.method !== 'POST') {
    response.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.'
    });
    return;
  }

  try {
    // Authenticate the request
    const authResult = await authenticateRequest(request);
    if (!authResult.authenticated) {
      response.status(401).json({
        success: false,
        error: authResult.error || 'Authentication failed'
      });
      return;
    }

    const user = authResult.user!;

    // Rate limiting per user
    const rateLimitId = `api_key_${user.uid}`;
    if (!checkRateLimit(rateLimitId, 5, 300000)) { // 5 requests per 5 minutes
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
      return;
    }

    // Parse request body
    const requestBody: ApiKeyRequest = request.body;

    if (!requestBody.userId || !requestBody.deviceId || !requestBody.appVersion) {
      response.status(400).json({
        success: false,
        error: 'Missing required fields: userId, deviceId, appVersion'
      });
      return;
    }

    // Verify the user ID matches the authenticated user
    if (requestBody.userId !== user.uid) {
      response.status(403).json({
        success: false,
        error: 'User ID mismatch'
      });
      return;
    }

    // Log the API key request for security monitoring
    console.log(`API key request from user: ${user.uid}, device: ${requestBody.deviceId}, app: ${requestBody.appVersion}`);

    // Get an available API key
    if (DISTRIBUTABLE_API_KEYS.length === 0) {
      response.status(503).json({
        success: false,
        error: 'No API keys available'
      });
      return;
    }

    // For now, use the first available key
    // In production, you might want to implement key rotation or user-specific key assignment
    const apiKey = DISTRIBUTABLE_API_KEYS[0];

    // Set expiration (24 hours from now)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Store the key assignment in Firestore for audit trail
    try {
      await admin.firestore().collection('api_key_assignments').add({
        userId: user.uid,
        deviceId: requestBody.deviceId,
        appVersion: requestBody.appVersion,
        apiKey: apiKey.substring(0, 8) + '...', // Store partial key for audit
        assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: expiresAt,
        ipAddress: request.ip
      });
    } catch (error) {
      console.warn('Failed to log API key assignment:', error);
      // Continue even if logging fails
    }

    const responseData: ApiKeyResponse = {
      success: true,
      apiKey: apiKey,
      expiresAt: expiresAt
    };

    response.status(200).json(responseData);

  } catch (error) {
    console.error('Error in getApiKey function:', error);
    response.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});
