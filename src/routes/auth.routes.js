
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const {
  getJwtSecret,
  requireAuth,
} = require('../middleware/auth');

const router = express.Router();

const ALLOWED_DOMAIN = 'francisxavier.ac.in';
const JWT_ISSUER = 'fxec-rd-api';
const JWT_AUDIENCE = 'fxec-rd-client';
const SESSION_EXPIRY = '8h';

let googleClient;

function getGoogleClient() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();

  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured.');
  }

  if (!googleClient) {
    googleClient = new OAuth2Client(clientId);
  }

  return { client: googleClient, clientId };
}

function isConfigurationError(error) {
  const message = String(error?.message || '');

  return (
    message.includes('GOOGLE_CLIENT_ID is not configured') ||
    message.includes('JWT_SECRET must be configured')
  );
}

/**
 * POST /api/auth/google
 *
 * Receives a Google Identity Services credential,
 * verifies it with Google, and returns a Node.js JWT session.
 */
router.post('/google', async (req, res) => {
  try {
    const credential = String(req.body?.credential || '').trim();

    if (!credential) {
      return res.status(400).json({
        error: 'Google credential is required.',
        code: 'auth/missing-google-credential',
      });
    }

    const { client, clientId } = getGoogleClient();

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.sub || !payload.email) {
      return res.status(401).json({
        error: 'Google did not return a valid user identity.',
        code: 'auth/invalid-google-identity',
      });
    }

    const email = String(payload.email).trim().toLowerCase();
    const uid = String(payload.sub);
    const emailVerified = payload.email_verified === true;

    if (!emailVerified) {
      return res.status(403).json({
        error: 'Your Google email address must be verified.',
        code: 'auth/google-email-not-verified',
      });
    }

    // Require the exact permitted email domain.
    if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return res.status(403).json({
        error: `Access is restricted to @${ALLOWED_DOMAIN} accounts.`,
        code: 'auth/domain-restricted',
      });
    }

    const displayName = String(payload.name || email.split('@')[0]);
    const photoURL = String(payload.picture || '');

    const secret = getJwtSecret();

    const token = jwt.sign(
      {
        email,
        displayName,
      },
      secret,
      {
        algorithm: 'HS256',
        subject: uid,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: SESSION_EXPIRY,
      }
    );

    return res.status(200).json({
      token,
      user: {
        uid,
        email,
        displayName,
        photoURL,
      },
    });
  } catch (error) {
    if (isConfigurationError(error)) {
      console.error(
        'Google authentication configuration error:',
        error.message
      );

      return res.status(500).json({
        error: 'Google authentication is not configured correctly.',
        code: 'auth/configuration-error',
      });
    }

    // Keep internal verification details out of the API response.
    console.error(
      'Google sign-in verification failed:',
      error.message
    );

    return res.status(401).json({
      error: 'Google sign-in could not be verified. Please try again.',
      code: 'auth/google-verification-failed',
    });
  }
});

/**
 * GET /api/auth/me
 *
 * Validates an existing Node.js JWT session.
 */
router.get('/me', requireAuth, (req, res) => {
  return res.status(200).json({
    user: {
      uid: req.user.uid,
      email: req.user.email,
      displayName: req.user.displayName || '',
    },
  });
});

module.exports = router;
