import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import * as admin from 'firebase-admin';
import { appleMusicPrivateKey, generateDeveloperToken } from './apple-music-auth';

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
});

if (!admin.apps.length) {
  admin.initializeApp();
}

const AUTH_SESSIONS = 'auth_sessions';
const SESSION_TTL_MS = 5 * 60 * 1000;
const POLL_SECRET_HEADER = 'x-poll-secret';

// Rate limiting store (in production, use Redis or similar)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

type SessionStatus = 'pending' | 'success' | 'error' | 'consumed';

interface AuthSession {
  sessionId: string;
  pollSecretHash: string;
  status: SessionStatus;
  firebaseUserId?: string;
  userEmail?: string | null;
  authProvider?: string;
  userAccessToken?: string;
  error?: string;
  createdAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
  expiresAt?: Date | FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
  tokensConsumedAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
}

function checkRateLimit(
  identifier: string,
  limit: number = 10,
  windowMs: number = 60000
): boolean {
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

function setCors(
  response: { set: (k: string, v: string) => void },
  methods: string,
  extraHeaders: string[] = []
): void {
  const allowHeaders = ['Content-Type', 'Authorization', POLL_SECRET_HEADER, ...extraHeaders];
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', methods);
  response.set('Access-Control-Allow-Headers', allowHeaders.join(', '));
}

function generateHighEntropyId(byteLength: number = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

function hashPollSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function verifyPollSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPollSecret(secret), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function clientIp(request: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip || 'unknown';
}

function getBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function getFirebaseIdToken(request: {
  get: (name: string) => string | undefined;
  body?: { firebaseIdToken?: string };
}): string | null {
  const fromHeader = getBearerToken(request.get('Authorization'));
  if (fromHeader) {
    return fromHeader;
  }
  const fromBody = request.body?.firebaseIdToken;
  return typeof fromBody === 'string' && fromBody.length > 0 ? fromBody : null;
}

function getPollSecret(request: {
  get: (name: string) => string | undefined;
}): string | null {
  const header = request.get(POLL_SECRET_HEADER);
  if (!header) {
    return null;
  }
  const secret = header.trim();
  return secret.length > 0 ? secret : null;
}

function isExpired(expiresAt: AuthSession['expiresAt']): boolean {
  if (!expiresAt) {
    return false;
  }
  if (expiresAt instanceof Date) {
    return expiresAt.getTime() < Date.now();
  }
  if (typeof (expiresAt as FirebaseFirestore.Timestamp).toDate === 'function') {
    return (expiresAt as FirebaseFirestore.Timestamp).toDate().getTime() < Date.now();
  }
  return false;
}

async function verifyFirebaseToken(
  idToken: string
): Promise<{
  authenticated: boolean;
  user?: admin.auth.DecodedIdToken;
  error?: string;
}> {
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return { authenticated: true, user: decodedToken };
  } catch (error) {
    console.error('Firebase authentication error:', error);
    return { authenticated: false, error: 'Invalid authentication token' };
  }
}

/**
 * Car creates a session. Returns server-generated sessionId + pollSecret.
 * QR must encode sessionId only; pollSecret stays on the car.
 */
export const createSession = onRequest(async (request, response) => {
  try {
    setCors(response, 'POST, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    if (request.method !== 'POST') {
      response.status(405).json({
        success: false,
        error: 'Method not allowed',
      });
      return;
    }

    const ip = clientIp(request);
    if (!checkRateLimit(`create_session_${ip}`, 20, 60000)) {
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
      });
      return;
    }

    const sessionId = generateHighEntropyId(32);
    const pollSecret = generateHighEntropyId(32);
    const sessionRef = admin.firestore().collection(AUTH_SESSIONS).doc(sessionId);

    const sessionData: AuthSession = {
      sessionId,
      pollSecretHash: hashPollSecret(pollSecret),
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    };

    await sessionRef.create(sessionData);

    console.log(`Session created: ${sessionId}`);

    response.status(200).json({
      success: true,
      sessionId,
      pollSecret,
      expiresAt: sessionData.expiresAt,
    });
  } catch (error) {
    console.error('Error in createSession:', error);
    response.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Phone binds Sign in with Apple identity to an existing server-created session.
 * Does not create or overwrite sessions; sessionId must already exist.
 */
export const initializeSession = onRequest(async (request, response) => {
  try {
    setCors(response, 'POST, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    if (request.method !== 'POST') {
      response.status(405).json({
        success: false,
        error: 'Method not allowed',
      });
      return;
    }

    const sessionId =
      typeof request.body?.sessionId === 'string' ? request.body.sessionId.trim() : '';
    const firebaseIdToken = getFirebaseIdToken(request);

    if (!sessionId || !firebaseIdToken) {
      response.status(400).json({
        success: false,
        error: 'Missing sessionId or firebase authentication',
      });
      return;
    }

    if (!checkRateLimit(`init_session_${sessionId}`, 5, 300000)) {
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
      });
      return;
    }

    const authResult = await verifyFirebaseToken(firebaseIdToken);
    if (!authResult.authenticated || !authResult.user) {
      response.status(401).json({
        success: false,
        error: authResult.error || 'Authentication failed',
      });
      return;
    }

    const user = authResult.user;
    const sessionRef = admin.firestore().collection(AUTH_SESSIONS).doc(sessionId);

    try {
      await admin.firestore().runTransaction(async (tx) => {
        const sessionDoc = await tx.get(sessionRef);
        if (!sessionDoc.exists) {
          throw Object.assign(new Error('Session not found'), { code: 404 });
        }

        const sessionData = sessionDoc.data() as AuthSession;

        if (isExpired(sessionData.expiresAt)) {
          throw Object.assign(new Error('Session has expired'), { code: 410 });
        }

        if (sessionData.status !== 'pending') {
          throw Object.assign(new Error('Session is no longer pending'), { code: 409 });
        }

        if (sessionData.firebaseUserId && sessionData.firebaseUserId !== user.uid) {
          throw Object.assign(new Error('Session does not belong to this user'), {
            code: 403,
          });
        }

        if (sessionData.firebaseUserId === user.uid) {
          return;
        }

        tx.update(sessionRef, {
          firebaseUserId: user.uid,
          userEmail: user.email ?? null,
          authProvider: user.firebase?.sign_in_provider || 'unknown',
        });
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (typeof code === 'number') {
        response.status(code).json({
          success: false,
          error: error instanceof Error ? error.message : 'Request failed',
        });
        return;
      }
      throw error;
    }

    console.log(`Session initialized for user: ${user.uid}, session: ${sessionId}`);

    response.status(200).json({
      success: true,
      sessionId,
      message: 'Session initialized successfully',
    });
  } catch (error) {
    console.error('Error in initializeSession:', error);
    response.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export const completeAuthentication = onRequest(
  { secrets: [appleMusicPrivateKey] },
  async (request, response) => {
    try {
      setCors(response, 'POST, OPTIONS');

      if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
      }

      if (request.method !== 'POST') {
        response.status(405).json({
          success: false,
          error: 'Method not allowed',
        });
        return;
      }

      const sessionId =
        typeof request.body?.sessionId === 'string' ? request.body.sessionId.trim() : '';
      const firebaseIdToken = getFirebaseIdToken(request);

      if (!sessionId || !firebaseIdToken) {
        response.status(400).json({
          success: false,
          error: 'Missing sessionId or firebase authentication',
        });
        return;
      }

      if (!checkRateLimit(`complete_auth_${sessionId}`, 3, 300000)) {
        response.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Please try again later.',
        });
        return;
      }

      const authResult = await verifyFirebaseToken(firebaseIdToken);
      if (!authResult.authenticated || !authResult.user) {
        response.status(401).json({
          success: false,
          error: authResult.error || 'Authentication failed',
        });
        return;
      }

      const user = authResult.user;
      const sessionRef = admin.firestore().collection(AUTH_SESSIONS).doc(sessionId);
      const sessionDoc = await sessionRef.get();

      if (!sessionDoc.exists) {
        response.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      const sessionData = sessionDoc.data() as AuthSession;

      if (!sessionData.firebaseUserId || sessionData.firebaseUserId !== user.uid) {
        response.status(403).json({
          success: false,
          error: 'Session does not belong to this user',
        });
        return;
      }

      if (isExpired(sessionData.expiresAt)) {
        response.status(410).json({
          success: false,
          error: 'Session has expired',
        });
        return;
      }

      if (sessionData.status !== 'pending') {
        response.status(409).json({
          success: false,
          error: 'Session is no longer pending',
        });
        return;
      }

      const developerToken = generateDeveloperToken();

      // Placeholder until MusicKit user-token flow lands (issue #4).
      const userAccessToken = developerToken;

      await sessionRef.update({
        status: 'success',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        userAccessToken,
        // Keep tokens available briefly for the car poll, then cleanup job removes them.
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      });

      console.log(`Authentication completed for user: ${user.uid}, session: ${sessionId}`);

      // Tokens are delivered only to the car via authenticated poll (single-use).
      response.status(200).json({
        success: true,
        sessionId,
        message: 'Authentication completed successfully',
      });
    } catch (error) {
      console.error('Error in completeAuthentication:', error);

      const sessionId = request.body?.sessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        try {
          const sessionRef = admin.firestore().collection(AUTH_SESSIONS).doc(sessionId);
          await sessionRef.update({
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (updateError) {
          console.error('Failed to update session with error:', updateError);
        }
      }

      response.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }
);

/**
 * Car polls session status. Requires pollSecret; tokens returned at most once.
 */
export const getSessionStatus = onRequest(async (request, response) => {
  try {
    setCors(response, 'GET, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    if (request.method !== 'GET') {
      response.status(405).json({
        success: false,
        error: 'Method not allowed',
      });
      return;
    }

    const sessionId =
      typeof request.query.sessionId === 'string' ? request.query.sessionId.trim() : '';
    if (!sessionId) {
      response.status(400).json({
        success: false,
        error: 'Missing sessionId parameter',
      });
      return;
    }

    const pollSecret = getPollSecret(request);
    if (!pollSecret) {
      response.status(401).json({
        success: false,
        error: 'Missing poll secret',
      });
      return;
    }

    if (!checkRateLimit(`get_status_${sessionId}`, 30, 60000)) {
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
      });
      return;
    }

    const sessionRef = admin.firestore().collection(AUTH_SESSIONS).doc(sessionId);

    let responseBody: {
      success: boolean;
      sessionId: string;
      status: SessionStatus;
      createdAt?: AuthSession['createdAt'];
      expiresAt?: AuthSession['expiresAt'];
      userAccessToken?: string;
      error?: string;
    };

    try {
      responseBody = await admin.firestore().runTransaction(async (tx) => {
        const sessionDoc = await tx.get(sessionRef);
        if (!sessionDoc.exists) {
          throw Object.assign(new Error('Session not found'), { code: 404 });
        }

        const sessionData = sessionDoc.data() as AuthSession;

        if (!verifyPollSecret(pollSecret, sessionData.pollSecretHash)) {
          throw Object.assign(new Error('Invalid poll secret'), { code: 401 });
        }

        if (sessionData.status === 'success' && sessionData.userAccessToken) {
          const token = sessionData.userAccessToken;
          tx.update(sessionRef, {
            status: 'consumed',
            userAccessToken: admin.firestore.FieldValue.delete(),
            tokensConsumedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return {
            success: true,
            sessionId: sessionData.sessionId,
            status: 'success' as SessionStatus,
            createdAt: sessionData.createdAt,
            expiresAt: sessionData.expiresAt,
            userAccessToken: token,
          };
        }

        return {
          success: true,
          sessionId: sessionData.sessionId,
          status: sessionData.status,
          createdAt: sessionData.createdAt,
          expiresAt: sessionData.expiresAt,
          error: sessionData.error,
        };
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (typeof code === 'number') {
        response.status(code).json({
          success: false,
          error: error instanceof Error ? error.message : 'Request failed',
        });
        return;
      }
      throw error;
    }

    response.status(200).json(responseBody);
  } catch (error) {
    console.error('Error in getSessionStatus:', error);
    response.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export const health = onRequest((request, response) => {
  response.status(200).json({
    status: 'healthy',
    service: 'Amplifier Apple Music Backend',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    description: 'Secure token provider requiring Firebase authentication',
  });
});

export const cleanupExpiredSessions = onSchedule('every 5 minutes', async () => {
  try {
    const now = new Date();
    const sessionsRef = admin.firestore().collection(AUTH_SESSIONS);

    const snapshot = await sessionsRef.where('expiresAt', '<', now).get();

    const batch = admin.firestore().batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    if (!snapshot.empty) {
      await batch.commit();
      console.log(`Cleaned up ${snapshot.size} expired sessions`);
    }
  } catch (error) {
    console.error('Error cleaning up expired sessions:', error);
    throw error;
  }
});
