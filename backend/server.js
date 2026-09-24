// backend/server.js

const path = require('path');

// Resolved from this file, not the working directory, so the server finds
// the repo-root .env whether it is started from backend/ or from the root.
require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');


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

// Render puts exactly one proxy in front of the app. Without this, req.ip is
// that proxy's address for every visitor, so the rate limits below would
// throttle all customers as if they were a single client.
app.set('trust proxy', 1);

const PORT =
  process.env.PORT || 3000;


// ============================================================
// MIDDLEWARE
// ============================================================

// This API is legitimately called cross-origin (the frontend runs on a
// different port). Helmet's default Cross-Origin-Resource-Policy is
// same-origin, which would make browsers block the response even
// though CORS allows it — relax just that one header for a JSON API.
// The frontend uses inline style="..."/onclick="..." attributes throughout
// index.html, plus the Chart.js CDN script and Google Fonts — Helmet's
// default CSP (script-src/style-src 'self' only) blocks all of that, so
// it's opened up to exactly what this app actually loads.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // No 'unsafe-inline' here on purpose — every page loads its JS from
      // a real file (js/*.js), so inline <script> blocks are never
      // needed and CSP can actually block one if an injection point ever
      // appears. Inline onclick="..." attributes still need
      // scriptSrcAttr below — that's a narrower allowance than this.
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"]
    }
  }
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

// Static assets are cached for an hour so a deploy reaches everyone within
// that window. HTML is left uncached, and bumping a page's ?v=N on a
// stylesheet or script makes browsers fetch the new file straight away.
app.use((req, res, next) => {
  if (/\.(css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif)$/i.test(req.path)) {
    res.set('Cache-Control', 'public, max-age=3600');
  }
  next();
});

// Serve the frontend from the same origin/port as the API. This is what
// lets api.js/auth.js/app.js call relative paths ("/api/...") and avoids
// CORS entirely in any environment where this server is the one hosting
// the frontend — the FRONTEND_URL allowlist above only matters when the
// frontend is served separately (e.g. local Live Server on :5500).
// `index: 'welcome.html'` only changes what's served for a bare "/" —
// index.html (the login/app SPA) is still served normally at its own
// explicit path, so the OAuth/email-confirmation redirects elsewhere
// that hardcode "/index.html" are unaffected.
app.use(express.static(path.join(__dirname, '../frontend'), { index: 'welcome.html' }));

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
  res.json({ status: 'success', message: 'API is running' });
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

  console.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    error: 'Something went wrong. Please try again.'
  });
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});