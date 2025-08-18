import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';

interface AppleMusicConfig {
  keyId: string;
  teamId: string;
  privateKeyPath: string;
  issuer: string;
}

export class AppleMusicAuth {
  private config: AppleMusicConfig;

  constructor() {
    this.config = {
      keyId: process.env.APPLE_MUSIC_KEY_ID || '',
      teamId: process.env.APPLE_MUSIC_TEAM_ID || '',
      privateKeyPath: process.env.APPLE_MUSIC_PRIVATE_KEY_PATH || '',
      issuer: process.env.APPLE_MUSIC_ISSUER || ''
    };

    this.validateConfig();
  }

  private validateConfig(): void {
    const requiredFields = ['keyId', 'teamId', 'privateKeyPath', 'issuer'];
    const missingFields = requiredFields.filter(field => !this.config[field as keyof AppleMusicConfig]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required Apple Music configuration: ${missingFields.join(', ')}`);
    }
  }

    private getPrivateKey(): string {
    try {
      // Try to read from file path first
      if (fs.existsSync(this.config.privateKeyPath)) {
        return fs.readFileSync(this.config.privateKeyPath, 'utf8');
      }

      // If not a file path, treat as the key content itself
      return this.config.privateKeyPath;
    } catch (error) {
      throw new Error(`Failed to read Apple Music private key: ${error}`);
    }
  }

  public generateDeveloperToken(): string {
    const privateKey = this.getPrivateKey();

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.config.issuer,
      iat: now,
      exp: now + (6 * 30 * 24 * 60 * 60), // 6 months from now
      aud: 'appstoreconnect-v1'
    };

    const options: jwt.SignOptions = {
      algorithm: 'ES256',
      keyid: this.config.keyId,
      header: {
        alg: 'ES256',
        kid: this.config.keyId,
        typ: 'JWT'
      }
    };

    try {
      return jwt.sign(payload, privateKey, options);
    } catch (error) {
      throw new Error(`Failed to generate Apple Music developer token: ${error}`);
    }
  }
}

// Singleton instance
let authInstance: AppleMusicAuth | null = null;

export function generateDeveloperToken(): string {
  if (!authInstance) {
    authInstance = new AppleMusicAuth();
  }
  return authInstance.generateDeveloperToken();
}
