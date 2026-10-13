
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const {
  getJwtSecret,
  requireAuth,
} = require('../middleware/auth');

const router = express.Router();

const ALLOWED_DOMAIN = 'francisxavier.ac.in';

function getGoogleClientId() {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured.');
  }

  return clientId;
}

router.post('/google', async (req, res) => {
  try {
    const credential = String(req.body?.credential || '').trim();

    if (!credential) {
      return res.status(400).json({
        error: 'Google credential is required.',
        code: 'auth/missing-google-credential',
      });
    }

    const clientId = getGoogleClientId();
    const googleClient = new OAuth2Client(clientId);

    // Verify the Google ID token with Google's public keys.
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });

    const payload = ticket.getPayload();

    if (!payload?.sub || !payload?.email) {
      return res.status(401).json({
        error: 'Google did not return a valid user identity.',
        code: 'auth/invalid-google-identity',
      });
    }

    const email = String(payload.email).trim().toLowerCase();
    const emailVerified = payload.email_verified === true;

    if (!emailVerified) {
      return res.status(403).json({
        error: 'Your Google email address must be verified.',
        code: 'auth/google-email-not-verified',
      });
    }

    if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return res.status(403).json({
        error: `Access is restricted to @${ALLOWED_DOMAIN} accounts.`,
        code: 'auth/domain-restricted',
      });
    }

    const uid = String(payload.sub);
    const displayName = String(payload.name || '');

    // This JWT configuration matches middleware/auth.js.
    const token = jwt.sign(
      {
        email,
        displayName,
      },
      getJwtSecret(),
      {
        algorithm: 'HS256',
        subject: uid,
        issuer: 'fxec-rd-api',
        audience: 'fxec-rd-client',
        expiresIn: '8h',
      }
    );

    return res.json({
      token,
      user: {
        uid,
        email,
        displayName,
        photoURL: payload.picture || '',
      },
    });
  } catch (error) {
    if (
      error.message?.includes('GOOGLE_CLIENT_ID is not configured') ||
      error.message?.includes('JWT_SECRET must be configured')
    ) {
      console.error('Google authentication configuration error:', error.message);

      return res.status(500).json({
        error: 'Google authentication is not configured correctly.',
        code: 'auth/configuration-error',
      });
    }

    console.error('Google sign-in verification failed:', error.message);

    return res.status(401).json({
      error: 'Google sign-in could not be verified. Please try again.',
      code: 'auth/google-verification-failed',
    });
  }
});

// Restore the currently authenticated Node.js session.
router.get('/me', requireAuth, (req, res) => {
  return res.json({
    user: {
      uid: req.user.uid,
      email: req.user.email,
      displayName: req.user.displayName,
    },
  });
});

module.exports = router;
