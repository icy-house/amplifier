import * as jwt from 'jsonwebtoken';
import * as admin from 'firebase-admin';
import { defineSecret, defineString } from 'firebase-functions/params';

export const appleMusicKeyId = defineString('APPLE_MUSIC_KEY_ID', {
  description: 'Apple Music API Key ID',
});

export const appleMusicTeamId = defineString('APPLE_MUSIC_TEAM_ID', {
  description: 'Apple Developer Team ID (MusicKit JWT iss claim)',
});

/** .p8 private key contents stored in Secret Manager */
export const appleMusicPrivateKey = defineSecret('APPLE_MUSIC_PRIVATE_KEY');

/** Short-lived developer JWT for car handoff after MusicKit authorize. */
export const HANDOFF_DEVELOPER_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Developer JWT for MusicKit JS on the phone auth page. */
export const WEB_DEVELOPER_TOKEN_TTL_SECONDS = 60 * 60;

/** Apple Music API maximum developer token lifetime (~6 months). */
export const MAX_DEVELOPER_TOKEN_TTL_SECONDS = 15_777_000;

/** Origins allowed to use web MusicKit developer tokens (JWT origin claim). */
export const WEB_MUSIC_ORIGINS = [
  'https://ample.icy.house',
  'https://amplemusic-prod.web.app',
  'https://amplemusic-prod.firebaseapp.com',
];

interface AppleMusicConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
}

export interface DeveloperTokenOptions {
  expiresInSeconds?: number;
  /** When set, JWT includes Apple's web-only `origin` claim. Omit for car/Android. */
  origins?: string[];
}

export class AppleMusicAuth {
  private config: AppleMusicConfig | null = null;

  constructor() {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
  }

  private loadConfig(): AppleMusicConfig {
    if (this.config) {
      return this.config;
    }

    this.config = {
      keyId: appleMusicKeyId.value(),
      teamId: appleMusicTeamId.value(),
      privateKey: appleMusicPrivateKey.value(),
    };

    this.validateConfig();
    return this.config;
  }

  private validateConfig(): void {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }

    const requiredFields: (keyof AppleMusicConfig)[] = ['keyId', 'teamId', 'privateKey'];
    const missingFields = requiredFields.filter((field) => !this.config![field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required Apple Music configuration: ${missingFields.join(', ')}`
      );
    }
  }

  /**
   * MusicKit developer JWT. `iss` is the Team ID. No App Store Connect `aud`.
   * Default lifetime is short for car handoff; do not issue long-lived tokens into sessions.
   */
  public generateDeveloperToken(
    options: DeveloperTokenOptions = {}
  ): string {
    const config = this.loadConfig();
    const expiresInSeconds =
      options.expiresInSeconds ?? HANDOFF_DEVELOPER_TOKEN_TTL_SECONDS;

    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error('expiresInSeconds must be a positive number');
    }
    if (expiresInSeconds > MAX_DEVELOPER_TOKEN_TTL_SECONDS) {
      throw new Error(
        `expiresInSeconds must be <= ${MAX_DEVELOPER_TOKEN_TTL_SECONDS} (Apple Music maximum)`
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const payload: jwt.JwtPayload = {
      iss: config.teamId,
      iat: now,
      exp: now + Math.floor(expiresInSeconds),
    };

    if (options.origins && options.origins.length > 0) {
      payload.origin = options.origins;
    }

    const signOptions: jwt.SignOptions = {
      algorithm: 'ES256',
      keyid: config.keyId,
      header: {
        alg: 'ES256',
        kid: config.keyId,
        typ: 'JWT',
      },
    };

    try {
      return jwt.sign(payload, config.privateKey, signOptions);
    } catch (error) {
      throw new Error(`Failed to generate Apple Music developer token: ${error}`);
    }
  }
}

let authInstance: AppleMusicAuth | null = null;

export function generateDeveloperToken(options?: DeveloperTokenOptions): string {
  if (!authInstance) {
    authInstance = new AppleMusicAuth();
  }
  return authInstance.generateDeveloperToken(options);
}
