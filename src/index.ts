import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import * as admin from 'firebase-admin';
import {
  appleMusicPrivateKey,
  generateDeveloperToken,
  HANDOFF_DEVELOPER_TOKEN_TTL_SECONDS,
  WEB_DEVELOPER_TOKEN_TTL_SECONDS,
  WEB_MUSIC_ORIGINS,
} from './apple-music-auth';

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
});

if (!admin.apps.length) {
  admin.initializeApp();
}

const AUTH_SESSIONS = 'auth_sessions';
const SESSION_TTL_MS = 5 * 60 * 1000;
/** Allow the car to retry a successful poll briefly if the first response was lost. */
const TOKEN_REDELIVERY_WINDOW_MS = 2 * 60 * 1000;
const POLL_SECRET_HEADER = 'x-poll-secret';
/** MusicKit Music User Tokens are opaque; reject absurdly large bodies. */
const MAX_MUSIC_USER_TOKEN_LENGTH = 8192;

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
  /** MusicKit Music User Token from phone authorize(). */
  musicUserToken?: string;
  /** Short-lived MusicKit developer JWT for the car (no web origin claim). */
  developerToken?: string;
  error?: string;
  createdAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
  expiresAt?: Date | FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
  /** First successful poll that returned tokens; used for short idempotent redelivery. */
  tokensDeliveredAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
  tokensConsumedAt?: FirebaseFirestore.Timestamp | admin.firestore.FieldValue;
}

function sessionHasHandoffTokens(session: AuthSession): boolean {
  return (
    typeof session.musicUserToken === 'string' &&
    session.musicUserToken.length > 0 &&
    typeof session.developerToken === 'string' &&
    session.developerToken.length > 0
  );
}

function tokenFieldDeletes(): {
  musicUserToken: FirebaseFirestore.FieldValue;
  developerToken: FirebaseFirestore.FieldValue;
} {
  return {
    musicUserToken: admin.firestore.FieldValue.delete(),
    developerToken: admin.firestore.FieldValue.delete(),
  };
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

function clientIp(request: { ip?: string }): string {
  // Prefer the platform-resolved IP; do not trust client-supplied X-Forwarded-For.
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

function toMillis(
  value: Date | FirebaseFirestore.Timestamp | admin.firestore.FieldValue | undefined
): number | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof (value as FirebaseFirestore.Timestamp).toDate === 'function') {
    return (value as FirebaseFirestore.Timestamp).toDate().getTime();
  }
  return null;
}

function isExpired(expiresAt: AuthSession['expiresAt']): boolean {
  const millis = toMillis(expiresAt);
  return millis !== null && millis < Date.now();
}

function isWithinRedeliveryWindow(tokensDeliveredAt: AuthSession['tokensDeliveredAt']): boolean {
  const deliveredAt = toMillis(tokensDeliveredAt);
  if (deliveredAt === null) {
    return false;
  }
  return Date.now() - deliveredAt <= TOKEN_REDELIVERY_WINDOW_MS;
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
 * Prove the Music User Token works with Apple Music before storing it for the car.
 */
async function verifyMusicUserTokenWithApple(
  developerToken: string,
  musicUserToken: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch('https://api.music.apple.com/v1/me/storefront', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${developerToken}`,
        'Music-User-Token': musicUserToken,
      },
    });

    if (response.ok) {
      return { valid: true };
    }

    console.error(
      `Apple Music Music User Token probe failed: HTTP ${response.status}`
    );
    return { valid: false, error: 'Invalid Apple Music user token' };
  } catch (error) {
    console.error('Apple Music Music User Token probe error:', error);
    return { valid: false, error: 'Unable to verify Apple Music user token' };
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

/**
 * Phone fetches a short-lived MusicKit developer JWT (with web origin claim)
 * so MusicKit JS can call authorize(). Not for car handoff.
 */
export const getMusicKitDeveloperToken = onRequest(
  { secrets: [appleMusicPrivateKey] },
  async (request, response) => {
    try {
      setCors(response, 'GET, POST, OPTIONS');
      response.set('Cache-Control', 'no-store');

      if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
      }

      if (request.method !== 'GET' && request.method !== 'POST') {
        response.status(405).json({
          success: false,
          error: 'Method not allowed',
        });
        return;
      }

      const firebaseIdToken = getFirebaseIdToken(request);
      if (!firebaseIdToken) {
        response.status(401).json({
          success: false,
          error: 'Missing firebase authentication',
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

      if (!checkRateLimit(`musickit_dev_token_${authResult.user.uid}`, 10, 300000)) {
        response.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Please try again later.',
        });
        return;
      }

      const developerToken = generateDeveloperToken({
        expiresInSeconds: WEB_DEVELOPER_TOKEN_TTL_SECONDS,
        origins: WEB_MUSIC_ORIGINS,
      });

      response.status(200).json({
        success: true,
        developerToken,
        expiresInSeconds: WEB_DEVELOPER_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      console.error('Error in getMusicKitDeveloperToken:', error);
      response.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }
);

/**
 * Phone completes auth after MusicKit authorize(). Stores Music User Token +
 * a fresh short-lived developer JWT for the car. Tokens are not returned here.
 */
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
      const musicUserToken =
        typeof request.body?.musicUserToken === 'string'
          ? request.body.musicUserToken.trim()
          : '';
      const firebaseIdToken = getFirebaseIdToken(request);

      if (!sessionId || !firebaseIdToken) {
        response.status(400).json({
          success: false,
          error: 'Missing sessionId or firebase authentication',
        });
        return;
      }

      if (!musicUserToken || musicUserToken.length > MAX_MUSIC_USER_TOKEN_LENGTH) {
        response.status(400).json({
          success: false,
          error: 'Missing or invalid musicUserToken',
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

      // Fresh short-lived developer JWT for the car (no web origin claim).
      const developerToken = generateDeveloperToken({
        expiresInSeconds: HANDOFF_DEVELOPER_TOKEN_TTL_SECONDS,
      });

      const tokenProbe = await verifyMusicUserTokenWithApple(developerToken, musicUserToken);
      if (!tokenProbe.valid) {
        response.status(400).json({
          success: false,
          error: tokenProbe.error || 'Invalid Apple Music user token',
        });
        return;
      }

      try {
        await admin.firestore().runTransaction(async (tx) => {
          const sessionDoc = await tx.get(sessionRef);
          if (!sessionDoc.exists) {
            throw Object.assign(new Error('Session not found'), { code: 404 });
          }

          const sessionData = sessionDoc.data() as AuthSession;

          if (!sessionData.firebaseUserId || sessionData.firebaseUserId !== user.uid) {
            throw Object.assign(new Error('Session does not belong to this user'), {
              code: 403,
            });
          }

          if (isExpired(sessionData.expiresAt)) {
            throw Object.assign(new Error('Session has expired'), { code: 410 });
          }

          if (sessionData.status !== 'pending') {
            throw Object.assign(new Error('Session is no longer pending'), { code: 409 });
          }

          tx.update(sessionRef, {
            status: 'success',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            musicUserToken,
            developerToken,
            // Keep tokens available briefly for the car poll, then cleanup job removes them.
            expiresAt: new Date(Date.now() + SESSION_TTL_MS),
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
          await admin.firestore().runTransaction(async (tx) => {
            const sessionDoc = await tx.get(sessionRef);
            if (!sessionDoc.exists) {
              return;
            }
            const sessionData = sessionDoc.data() as AuthSession;
            // Never clobber a session that already succeeded or was consumed.
            if (sessionData.status !== 'pending') {
              return;
            }
            tx.update(sessionRef, {
              status: 'error',
              error: error instanceof Error ? error.message : 'Unknown error',
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
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
 * Car polls session status. Requires pollSecret.
 * Tokens are delivered only to holders of pollSecret, with a short idempotent
 * redelivery window, then redacted (single logical handoff).
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

    // Coarse IP limit before Firestore; authenticated polls are limited after secret check.
    const ip = clientIp(request);
    if (!checkRateLimit(`get_status_ip_${ip}`, 60, 60000)) {
      response.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
      });
      return;
    }

    const sessionRef = admin.firestore().collection(AUTH_SESSIONS).doc(sessionId);

    // Authenticate poll before counting against the car's session budget.
    // Unknown session and wrong secret both return 401 (no existence oracle).
    const precheck = await sessionRef.get();
    if (!precheck.exists) {
      response.status(401).json({
        success: false,
        error: 'Invalid poll credentials',
      });
      return;
    }

    const precheckData = precheck.data() as AuthSession;
    if (!verifyPollSecret(pollSecret, precheckData.pollSecretHash)) {
      response.status(401).json({
        success: false,
        error: 'Invalid poll credentials',
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

    let responseBody: {
      success: boolean;
      sessionId: string;
      status: SessionStatus;
      createdAt?: AuthSession['createdAt'];
      expiresAt?: AuthSession['expiresAt'];
      musicUserToken?: string;
      developerToken?: string;
      /** @deprecated Alias of musicUserToken for older car clients. */
      userAccessToken?: string;
      error?: string;
    };

    try {
      responseBody = await admin.firestore().runTransaction(async (tx) => {
        const sessionDoc = await tx.get(sessionRef);
        if (!sessionDoc.exists) {
          throw Object.assign(new Error('Invalid poll credentials'), { code: 401 });
        }

        const sessionData = sessionDoc.data() as AuthSession;

        if (!verifyPollSecret(pollSecret, sessionData.pollSecretHash)) {
          throw Object.assign(new Error('Invalid poll credentials'), { code: 401 });
        }

        const withinRedeliveryWindow =
          sessionData.status === 'consumed' &&
          isWithinRedeliveryWindow(sessionData.tokensDeliveredAt);

        // Expiry must not clobber an active redelivery window (lost first poll response).
        if (isExpired(sessionData.expiresAt) && !withinRedeliveryWindow) {
          if (sessionHasHandoffTokens(sessionData)) {
            tx.update(sessionRef, {
              ...tokenFieldDeletes(),
              tokensConsumedAt:
                sessionData.tokensConsumedAt || admin.firestore.FieldValue.serverTimestamp(),
              status: sessionData.status === 'pending' ? 'error' : 'consumed',
            });
          }
          throw Object.assign(new Error('Session has expired'), { code: 410 });
        }

        const canDeliverToken =
          sessionHasHandoffTokens(sessionData) &&
          (sessionData.status === 'success' || withinRedeliveryWindow);

        if (canDeliverToken) {
          if (!sessionData.tokensDeliveredAt) {
            // First successful handoff: mark delivered, extend TTL through the retry window.
            tx.update(sessionRef, {
              status: 'consumed',
              tokensDeliveredAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + TOKEN_REDELIVERY_WINDOW_MS),
            });
          }

          const musicUserToken = sessionData.musicUserToken as string;
          const developerToken = sessionData.developerToken as string;

          return {
            success: true,
            sessionId: sessionData.sessionId,
            status: 'success' as SessionStatus,
            createdAt: sessionData.createdAt,
            expiresAt: sessionData.expiresAt,
            musicUserToken,
            developerToken,
            userAccessToken: musicUserToken,
          };
        }

        // Past redelivery window: ensure token fields are gone.
        if (
          sessionData.status === 'consumed' &&
          sessionHasHandoffTokens(sessionData) &&
          !withinRedeliveryWindow
        ) {
          tx.update(sessionRef, {
            ...tokenFieldDeletes(),
            tokensConsumedAt:
              sessionData.tokensConsumedAt || admin.firestore.FieldValue.serverTimestamp(),
          });
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
