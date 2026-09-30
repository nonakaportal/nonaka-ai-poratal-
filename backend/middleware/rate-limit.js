// backend/middleware/rate-limit.js
//
// One limit per IP address treats an office as a single visitor. Opening the
// Overview alone sends around twenty-five requests, so a business of ten
// people sharing one connection ran out of its 600-per-15-minutes after
// roughly two dozen page loads between them, and everyone then saw "too many
// requests". Signed-in traffic is therefore counted per session instead.
//
// A bearer token is not verified here (that happens in requireOrgAccess), so
// a caller could send a different made-up token every time to get a fresh
// bucket. The per-IP ceiling below is what bounds that: generous enough for a
// whole office, low enough to stop a flood.

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { ipKeyGenerator } = rateLimit;

const WINDOW_MS = 15 * 60 * 1000;

function bearerToken(req) {
    const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);

    return match ? match[1] : null;
}

// The bucket a request counts against: its session when it has one, its
// address when it doesn't. The token is hashed so it never sits in memory
// as a key.
function sessionKey(req) {
    const token = bearerToken(req);

    if (token) {
        return 'session:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
    }

    return 'ip:' + ipKeyGenerator(req.ip);
}

function limiter({ max, message, keyGenerator }) {
    return rateLimit({
        windowMs: WINDOW_MS,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        ...(keyGenerator && { keyGenerator }),
        ...(message && { message: { error: message } })
    });
}

// Login and signup: the target of password guessing, and people at the same
// office sign in from the same address only occasionally, so this stays per IP.
const authLimiter = limiter({
    max: 20,
    message: 'Too many attempts. Please try again later.'
});

// Bounds one address whatever tokens it sends. Sized for a whole office.
const ipCeiling = limiter({
    max: 3000,
    message: 'Too many requests from this network. Please try again later.'
});

// Everything else under /api, per signed-in session.
const apiLimiter = limiter({ max: 600, keyGenerator: sessionKey });

// Each AI route costs a real Claude call, so it has its own tighter budget.
const aiLimiter = limiter({
    max: 60,
    keyGenerator: sessionKey,
    message: 'Too many AI requests. Please try again later.'
});

module.exports = { authLimiter, ipCeiling, apiLimiter, aiLimiter, sessionKey };
