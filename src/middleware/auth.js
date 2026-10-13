
const jwt = require('jsonwebtoken');

const SUPER_ADMIN_EMAIL = (
  process.env.SUPER_ADMIN_EMAIL ||
  'klnarayanan@francisxavier.ac.in'
).trim().toLowerCase();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be configured with at least 32 characters.'
    );
  }

  return secret;
}

async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: 'Missing Node.js session token.',
        code: 'auth/unauthenticated',
      });
    }

    const decoded = jwt.verify(match[1].trim(), getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: 'fxec-rd-api',
      audience: 'fxec-rd-client',
    });

    const email = String(decoded.email || '')
      .trim()
      .toLowerCase();

    const uid = String(decoded.sub || decoded.uid || '');

    if (!email || !uid) {
      return res.status(401).json({
        error: 'Session token does not contain a valid user.',
        code: 'auth/invalid-token',
      });
    }

    req.user = {
      uid,
      email,
      displayName: String(decoded.displayName || ''),
      claims: decoded,
    };

    return next();
  } catch (error) {
    if (error.message?.includes('JWT_SECRET must be configured')) {
      console.error('Authentication configuration error:', error.message);

      return res.status(500).json({
        error: 'Authentication is not configured correctly.',
        code: 'auth/configuration-error',
      });
    }

    if (
      error.name === 'TokenExpiredError' ||
      error.name === 'JsonWebTokenError' ||
      error.name === 'NotBeforeError'
    ) {
      return res.status(401).json({
        error: 'Invalid or expired session token.',
        code: 'auth/invalid-token',
      });
    }

    console.error('Authentication error:', error.message);

    return res.status(500).json({
      error: 'Unable to authenticate this request.',
      code: 'auth/error',
    });
  }
}

function requireSuperAdmin(req, res, next) {
  if (!req.user?.email) {
    return res.status(401).json({
      error: 'Authentication required.',
      code: 'auth/unauthenticated',
    });
  }

  if (req.user.email.toLowerCase() !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({
      error: 'Only the super admin can perform this action.',
      code: 'auth/forbidden',
    });
  }

  return next();
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  getJwtSecret,
  SUPER_ADMIN_EMAIL,
};
