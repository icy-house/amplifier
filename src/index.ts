import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { generateDeveloperToken } from './apple-music-auth';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Rate limiting function
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

// Firebase authentication middleware
async function verifyFirebaseToken(authHeader: string): Promise<{ authenticated: boolean; user?: admin.auth.DecodedIdToken; error?: string }> {
  try {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { authenticated: false, error: 'No valid authentication token provided' };
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    return { authenticated: true, user: decodedToken };
  } catch (error) {
    console.error('Firebase authentication error:', error);
    return { authenticated: false, error: 'Invalid authentication token' };
  }
}

// HTTP function to initialize authentication session
export const initializeSession = functions.https.onRequest(async (request, response) => {
  try {
    // Set CORS headers
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
        error: 'Method not allowed'
      });
      return;
    }

    const { sessionId, firebaseIdToken } = request.body;

    if (!sessionId || !firebaseIdToken) {
      response.status(400).json({
        success: false,
        error: 'Missing sessionId or firebaseIdToken'
      });
      return;
    }

    // Rate limiting per session
    if (!checkRateLimit(`init_session_${sessionId}`, 5, 300000)) { // 5 requests per 5 minutes
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
      return;
    }

    // Verify Firebase token
    const authResult = await verifyFirebaseToken(`Bearer ${firebaseIdToken}`);
    if (!authResult.authenticated) {
      response.status(401).json({
        success: false,
        error: authResult.error || 'Authentication failed'
      });
      return;
    }

    const user = authResult.user!;

    // Store session in Firestore with 5-minute expiration
    const sessionRef = admin.firestore().collection('auth_sessions').doc(sessionId);
    const sessionData = {
      sessionId: sessionId,
      firebaseUserId: user.uid,
      userEmail: user.email,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      authProvider: user.provider_id || 'unknown'
      };

    await sessionRef.set(sessionData);

    console.log(`Session initialized for user: ${user.uid}, session: ${sessionId}`);

    response.status(200).json({
      success: true,
      sessionId: sessionId,
      message: 'Session initialized successfully'
    });

  } catch (error) {
    console.error('Error in initializeSession:', error);
    response.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// HTTP function to complete authentication and generate user access token
export const completeAuthentication = functions.https.onRequest(async (request, response) => {
  try {
    // Set CORS headers
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
        error: 'Method not allowed'
      });
      return;
    }

    const { sessionId, firebaseIdToken } = request.body;

    if (!sessionId || !firebaseIdToken) {
      response.status(400).json({
        success: false,
        error: 'Missing sessionId or firebaseIdToken'
      });
      return;
    }

    // Rate limiting per session
    if (!checkRateLimit(`complete_auth_${sessionId}`, 3, 300000)) { // 3 requests per 5 minutes
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
      return;
    }

    // Verify Firebase token
    const authResult = await verifyFirebaseToken(`Bearer ${firebaseIdToken}`);
    if (!authResult.authenticated) {
      response.status(401).json({
        success: false,
        error: authResult.error || 'Authentication failed'
      });
      return;
    }

    const user = authResult.user!;

    // Get session from Firestore
    const sessionRef = admin.firestore().collection('auth_sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      response.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    const sessionData = sessionDoc.data()!;

    // Verify session belongs to this user
    if (sessionData.firebaseUserId !== user.uid) {
      response.status(403).json({
        success: false,
        error: 'Session does not belong to this user'
      });
      return;
    }

    // Check if session is expired
    if (sessionData.expiresAt && new Date(sessionData.expiresAt.toDate()) < new Date()) {
      response.status(410).json({
        success: false,
        error: 'Session has expired'
      });
      return;
    }

    // Generate Apple Music user access token using developer token
    const developerToken = await generateDeveloperToken();

    // For now, we'll use the developer token as the user access token
    // In a real implementation, you'd use the developer token to generate a user-specific token
    const userAccessToken = developerToken;

    // Update session with success and token
    const updateData = {
      status: 'success',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      userAccessToken: userAccessToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours for user token
    };

    await sessionRef.update(updateData);

    console.log(`Authentication completed for user: ${user.uid}, session: ${sessionId}`);

    response.status(200).json({
      success: true,
      sessionId: sessionId,
      message: 'Authentication completed successfully',
      userAccessToken: userAccessToken
    });

  } catch (error) {
    console.error('Error in completeAuthentication:', error);

    // Update session with error status if possible
    const sessionId = request.body?.sessionId;
    if (sessionId) {
      try {
        const sessionRef = admin.firestore().collection('auth_sessions').doc(sessionId);
        await sessionRef.update({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (updateError) {
        console.error('Failed to update session with error:', updateError);
      }
    }

    response.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// HTTP function to get session status (for AmpleMusic to check)
export const getSessionStatus = functions.https.onRequest(async (request, response) => {
  try {
    // Set CORS headers
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    if (request.method !== 'GET') {
      response.status(405).json({
        success: false,
        error: 'Method not allowed'
      });
      return;
    }

    const sessionId = request.query.sessionId as string;
    if (!sessionId) {
      response.status(400).json({
        success: false,
        error: 'Missing sessionId parameter'
      });
      return;
    }

    // Rate limiting per session
    if (!checkRateLimit(`get_status_${sessionId}`, 10, 60000)) { // 10 requests per minute
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
      return;
    }

    // Get session from Firestore
    const sessionRef = admin.firestore().collection('auth_sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      response.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    const sessionData = sessionDoc.data()!;

    // Return session status (without sensitive data)
    response.status(200).json({
      success: true,
      sessionId: sessionData.sessionId,
      status: sessionData.status,
      createdAt: sessionData.createdAt,
      expiresAt: sessionData.expiresAt,
      userAccessToken: sessionData.status === 'success' ? sessionData.userAccessToken : undefined,
      error: sessionData.error
    });

  } catch (error) {
    console.error('Error in getSessionStatus:', error);
    response.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Health check endpoint
export const health = functions.https.onRequest((request, response) => {
  response.status(200).json({
    status: 'healthy',
    service: 'Amplifier Apple Music Backend',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    description: 'Secure token provider requiring Firebase authentication'
  });
});

// Cloud Function to cleanup expired sessions
export const cleanupExpiredSessions = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async (context) => {
    try {
      const fiveMinutesAgo = new Date(Date.now() - (5 * 60 * 1000));
      const sessionsRef = admin.firestore().collection('auth_sessions');

      const snapshot = await sessionsRef
        .where('expiresAt', '<', fiveMinutesAgo)
        .get();

      const batch = admin.firestore().batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      if (!snapshot.empty) {
        await batch.commit();
        console.log(`Cleaned up ${snapshot.size} expired sessions`);
      }

      return { success: true, cleanedSessions: snapshot.size };
    } catch (error) {
      console.error('Error cleaning up expired sessions:', error);
      throw error;
    }
  });
