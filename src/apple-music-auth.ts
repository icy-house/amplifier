import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

interface AppleMusicConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
  issuer: string;
}

export class AppleMusicAuth {
  private config: AppleMusicConfig | null = null;

  constructor() {
    // Initialize Firebase Admin if not already initialized
    if (!admin.apps.length) {
      admin.initializeApp();
    }
  }

  private async loadConfig(): Promise<AppleMusicConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      // Get configuration from Firebase Functions config
      const functionsConfig = functions.config();

      // Get private key from Firebase Secret Manager
      const privateKey = await this.getPrivateKeyFromSecretManager();

      this.config = {
        keyId: functionsConfig.apple?.key_id || process.env.APPLE_MUSIC_KEY_ID || '',
        teamId: functionsConfig.apple?.team_id || process.env.APPLE_MUSIC_TEAM_ID || '',
        privateKey: privateKey,
        issuer: functionsConfig.apple?.issuer || process.env.APPLE_MUSIC_ISSUER || ''
      };

      this.validateConfig();
      return this.config;
    } catch (error) {
      throw new Error(`Failed to load Apple Music configuration: ${error}`);
    }
  }

  private async getPrivateKeyFromSecretManager(): Promise<string> {
    try {
      // For now, fallback to environment variable since Secret Manager requires additional setup
      // TODO: Implement proper Secret Manager integration when needed
      console.warn('Using environment variable for private key (Secret Manager not implemented)');

      // Fallback to environment variable
      const privateKeyPath = process.env.APPLE_MUSIC_PRIVATE_KEY_PATH || '';

      if (!privateKeyPath) {
        throw new Error('No private key available from environment variable');
      }

      // Try to read from file path first
      if (fs.existsSync(privateKeyPath)) {
        return fs.readFileSync(privateKeyPath, 'utf8');
      }

      // If not a file path, treat as the key content itself
      return privateKeyPath;
    } catch (error) {
      throw new Error(`Failed to get private key: ${error}`);
    }
  }

  private validateConfig(): void {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }

    const requiredFields = ['keyId', 'teamId', 'privateKey', 'issuer'];
    const missingFields = requiredFields.filter(field => !this.config![field as keyof AppleMusicConfig]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required Apple Music configuration: ${missingFields.join(', ')}`);
    }
  }

  public async generateDeveloperToken(): Promise<string> {
    const config = await this.loadConfig();

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: config.issuer,
      iat: now,
      exp: now + (6 * 30 * 24 * 60 * 60), // 6 months from now
      aud: 'appstoreconnect-v1'
    };

    const options: jwt.SignOptions = {
      algorithm: 'ES256',
      keyid: config.keyId,
      header: {
        alg: 'ES256',
        kid: config.keyId,
        typ: 'JWT'
      }
    };

    try {
      return jwt.sign(payload, config.privateKey, options);
    } catch (error) {
      throw new Error(`Failed to generate Apple Music developer token: ${error}`);
    }
  }
}

// Singleton instance
let authInstance: AppleMusicAuth | null = null;

export async function generateDeveloperToken(): Promise<string> {
  if (!authInstance) {
    authInstance = new AppleMusicAuth();
  }
  return authInstance.generateDeveloperToken();
}
