
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const pool = require('./db');
const documentsRoutes = require('./routes/documents.routes');
const adminRoutes = require('./routes/admin.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();

app.disable('x-powered-by');

// Allowed frontend origins
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
    origin: (origin, callback) => {
      // Allow requests without Origin, such as server-to-server requests.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));

app.use(
  morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')
);

// Health check
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

// Documents API — existing MySQL compatibility layer
app.use('/api/documents', documentsRoutes);

// Admin API — existing admin routes
app.use('/api/admin', adminRoutes);

// Notifications API — dedicated MySQL notifications table
app.use('/api/notifications', notificationsRoutes);

// 404 handler for unknown API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'API endpoint not found.',
      code: 'api/not-found',
    });
  }

  return next();
});

// Central error handler
app.use((err, _req, res, _next) => {
  console.error('API error:', err);

  const status = Number(err.status) || 500;

  return res.status(status).json({
    error:
      status < 500
        ? err.message
        : 'Internal server error',
    code: err.code || 'api/error',
  });
});

// Start server
const port = Number(process.env.PORT || 5000);

app.listen(port, () => {
  console.log(`FXEC RD API listening on port ${port}`);
});
