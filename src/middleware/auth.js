const admin = require('firebase-admin');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Missing Firebase ID token', code: 'auth/unauthenticated' });
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    req.user = { uid: decoded.uid, email: (decoded.email || '').toLowerCase(), claims: decoded };
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired authentication token', code: 'auth/invalid-token' });
  }
}
function requireSuperAdmin(req, res, next) {
  const allowed = (process.env.SUPER_ADMIN_EMAIL || 'klnarayanan@francisxavier.ac.in').toLowerCase();
  if (!req.user || req.user.email !== allowed) return res.status(403).json({ error: 'Only the super admin can perform this action', code: 'auth/forbidden' });
  next();
}
module.exports = { requireAuth, requireSuperAdmin };
