import * as functions from 'firebase-functions';
import { generateDeveloperToken } from './apple-music-auth';

// HTTP function to generate and return Apple Music developer token
export const getAppleMusicToken = functions.https.onRequest(async (request, response) => {
  try {
    // Set CORS headers for cross-origin requests
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    // Generate the developer token
    const developerToken = await generateDeveloperToken();

    response.status(200).json({
      success: true,
      developerToken,
      expiresIn: 3600 // Token expires in 1 hour
    });
  } catch (error) {
    console.error('Error generating Apple Music token:', error);
    response.status(500).json({
      success: false,
      error: 'Failed to generate Apple Music token'
    });
  }
});

// Health check endpoint
export const health = functions.https.onRequest((request, response) => {
  response.status(200).json({
    status: 'healthy',
    service: 'Amplifier Apple Music Backend',
    timestamp: new Date().toISOString()
  });
});
