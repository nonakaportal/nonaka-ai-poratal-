// backend/server.js

require('dotenv').config({
  path: '../.env'
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');



// ============================================================
// IMPORT SERVICES
// ============================================================

const supabaseService =
  require('./services/supabase/supabase.service');

const quickbooksService =
  require('./services/quickbooks/quickbooks.service');


// ============================================================
// IMPORT ROUTES
// ============================================================

const quickbooksRoutes = require('./routes/quickbooks.routes');
const authRoutes = require("./routes/auth.routes");
const aiRoutes = require("./routes/ai");


// ============================================================
// CREATE EXPRESS APP
// ============================================================

const app = express();

const PORT =
  process.env.PORT || 3000;


// ============================================================
// MIDDLEWARE
// ============================================================

// This API is legitimately called cross-origin (the frontend runs on a
// different port). Helmet's default Cross-Origin-Resource-Policy is
// same-origin, which would make browsers block the response even
// though CORS allows it — relax just that one header for a JSON API.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Wide-open CORS (the previous `cors()` with no options) let any
// website on the internet call these APIs cross-origin. Restrict it to
// the actual frontend origin(s) — comma-separated in FRONTEND_URL for
// multiple environments — instead of reflecting every origin.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://127.0.0.1:5500')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Same-origin requests, curl, and server-to-server calls send no
    // Origin header at all — allow those through; only browser
    // cross-origin requests carry one and need the allowlist check.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '1mb' }));

// Login/signup are the only unauthenticated, credential-checking
// routes in the app — the natural target for brute-force and
// credential-stuffing attempts, so they get a much tighter limit than
// everything else.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

// AI routes each cost a real Claude API call (money, and Anthropic's
// own rate limits) — cap abuse independently of the general API limit.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Please try again later.' }
});

// Baseline limit for everything else under /api, so no single client
// can hammer the QuickBooks integration or the server generally.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/ai', aiLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/ai", aiRoutes);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {

  res.json({

    status: 'success',

    message: 'API is running'

  });

});




// ============================================================
// QUICKBOOKS ROUTES
// ============================================================

app.use(
  '/api/quickbooks',
  quickbooksRoutes
);


// ============================================================
// 404 + ERROR HANDLING
//
// Placed last so it catches unmatched routes and anything passed to
// next(err) — including the CORS origin check above, which otherwise
// surfaces as a raw 500 with no body. Never forwards error.stack or
// other internals to the client; that only goes to the server log.
// ============================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  console.error('❌ Unhandled error:', err);

  res.status(err.status || 500).json({
    error: 'Something went wrong. Please try again.'
  });
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `🚀 Server running on http://localhost:${PORT}`
  );

  console.log(
    `📊 Health check: http://localhost:${PORT}/api/health`
  );

  console.log(
    `🔗 QB Status check: http://localhost:${PORT}/api/quickbooks/status`
  );

});