
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const pool = require('./db');

const authRoutes = require('./routes/auth.routes');
const documentsRoutes = require('./routes/documents.routes');
const adminRoutes = require('./routes/admin.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();

app.disable('x-powered-by');

// -----------------------------------------------------------------------------
// CORS configuration
// -----------------------------------------------------------------------------

const allowedOrigins = [
  'http://localhost:3000',
  'https://research-development-iota.vercel.app',
  ...(process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server requests and configured frontend origins.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      const error = new Error('Origin not allowed by CORS');
      error.status = 403;
      error.code = 'cors/origin-not-allowed';

      return callback(error);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));

app.use(
  morgan(
    process.env.NODE_ENV === 'production' ? 'combined' : 'dev'
  )
);

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');

    return res.json({
      ok: true,
      service: 'fxec-rd-api',
      database: 'connected',
    });
  } catch (error) {
    console.error('Database health check failed:', error.message);

    return res.status(503).json({
      ok: false,
      service: 'fxec-rd-api',
      database: 'unavailable',
    });
  }
});

// -----------------------------------------------------------------------------
// Public login-page statistics
// Returns aggregate counts only, not individual user or research documents.
// -----------------------------------------------------------------------------

app.get('/api/public/stats', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT collection_name, COUNT(*) AS total
      FROM documents
      WHERE collection_name IN ('users', 'publications', 'projects')
      GROUP BY collection_name
    `);

    const counts = Object.fromEntries(
      rows.map((row) => [
        row.collection_name,
        Number(row.total),
      ])
    );

    return res.json({
      researchers: counts.users || 0,
      publications: counts.publications || 0,
      projects: counts.projects || 0,
    });
  } catch (error) {
    console.error('Statistics query failed:', error.message);

    return res.status(500).json({
      error: 'Unable to load portal statistics.',
      code: 'stats/query-failed',
    });
  }
});

// -----------------------------------------------------------------------------
// Google authentication and Node.js JWT session endpoints
// POST /api/auth/google
// GET  /api/auth/me
// -----------------------------------------------------------------------------

app.use('/api/auth', authRoutes);

// -----------------------------------------------------------------------------
// Protected MySQL document compatibility API
// -----------------------------------------------------------------------------

app.use('/api/documents', documentsRoutes);

// -----------------------------------------------------------------------------
// Administration API
// -----------------------------------------------------------------------------

app.use('/api/admin', adminRoutes);

// -----------------------------------------------------------------------------
// Notifications API
// -----------------------------------------------------------------------------

app.use('/api/notifications', notificationsRoutes);

// -----------------------------------------------------------------------------
// Unknown API endpoints
// -----------------------------------------------------------------------------

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'API endpoint not found.',
      code: 'api/not-found',
    });
  }

  return next();
});

// -----------------------------------------------------------------------------
// Central error handler
// -----------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('API error:', err.message || err);

  const status = Number(err.status) || 500;

  return res.status(status).json({
    error:
      status < 500
        ? err.message
        : 'Internal server error',
    code: err.code || 'api/error',
  });
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

const port = Number(process.env.PORT || 5000);

app.listen(port, () => {
  console.log(`FXEC RD API listening on port ${port} (stats route enabled)`);
});
