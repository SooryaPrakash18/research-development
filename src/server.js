require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const admin = require('firebase-admin');

const pool = require('./db');
const documentsRoutes = require('./routes/documents.routes');
const adminRoutes = require('./routes/admin.routes');

// Firebase Admin initialization
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'fxec-rd';
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
  } else {
    // Use Application Default Credentials if configured
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  }
}

const app = express();

app.disable('x-powered-by');

// Allow local React development and your deployed Vercel frontend
const allowedOrigins = [
  'http://localhost:3000',
  'https://research-development-iota.vercel.app',
  ...(process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

app.use(
  helmet()
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header, such as server-to-server requests
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

    res.json({
      ok: true,
      service: 'fxec-rd-api',
      database: 'connected',
    });
  } catch (error) {
    console.error('Database health check failed:', error.message);

    res.status(503).json({
      ok: false,
      database: 'unavailable',
    });
  }
});

// API routes
app.use('/api/documents', documentsRoutes);
app.use('/api/admin', adminRoutes);

// Central error handler
app.use((err, _req, res, _next) => {
  console.error(err);

  const status = err.status || 500;

  res.status(status).json({
    error:
      status < 500
        ? err.message
        : 'Internal server error',
    code: err.code || 'api/error',
  });
});

// Render provides PORT automatically
const port = Number(process.env.PORT || 5000);

app.listen(port, () => {
  console.log(`FXEC RD API listening on port ${port}`);
});