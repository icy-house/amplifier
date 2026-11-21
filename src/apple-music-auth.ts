import * as jwt from 'jsonwebtoken';
import * as admin from 'firebase-admin';
import { defineSecret, defineString } from 'firebase-functions/params';

export const appleMusicKeyId = defineString('APPLE_MUSIC_KEY_ID', {
  description: 'Apple Music API Key ID',
});

export const appleMusicTeamId = defineString('APPLE_MUSIC_TEAM_ID', {
  description: 'Apple Developer Team ID',
});

export const appleMusicIssuer = defineString('APPLE_MUSIC_ISSUER', {
  description: 'Apple Music JWT issuer (typically Team ID)',
});

/** .p8 private key contents stored in Secret Manager */
export const appleMusicPrivateKey = defineSecret('APPLE_MUSIC_PRIVATE_KEY');

interface AppleMusicConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
  issuer: string;
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
      issuer: appleMusicIssuer.value(),
    };

    this.validateConfig();
    return this.config;
  }

  private validateConfig(): void {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }

    const requiredFields: (keyof AppleMusicConfig)[] = [
      'keyId',
      'teamId',
      'privateKey',
      'issuer',
    ];
    const missingFields = requiredFields.filter((field) => !this.config![field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required Apple Music configuration: ${missingFields.join(', ')}`
      );
    }
  }

  public generateDeveloperToken(): string {
    const config = this.loadConfig();

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: config.issuer,
      iat: now,
      exp: now + 6 * 30 * 24 * 60 * 60, // 6 months from now
      aud: 'appstoreconnect-v1',
    };

    const options: jwt.SignOptions = {
      algorithm: 'ES256',
      keyid: config.keyId,
      header: {
        alg: 'ES256',
        kid: config.keyId,
        typ: 'JWT',
      },
    };

    try {
      return jwt.sign(payload, config.privateKey, options);
    } catch (error) {
      throw new Error(`Failed to generate Apple Music developer token: ${error}`);
    }
  }
}

let authInstance: AppleMusicAuth | null = null;

export function generateDeveloperToken(): string {
  if (!authInstance) {
    authInstance = new AppleMusicAuth();
  }
  return authInstance.generateDeveloperToken();
}
