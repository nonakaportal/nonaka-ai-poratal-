// backend/middleware/auth.middleware.js
//
// Every QuickBooks and AI data route reads sensitive financial data by
// organizationId. Without this, any request that supplied a valid
// organizationId — no login required — could read that organization's
// P&L, Balance Sheet, Cash Flow, AR/AP, debt, and AI-generated insights.
// organizationId is a UUID, not a secret: it appears in the URL, browser
// history, and localStorage of every legitimate user, so treating it as
// authorization was never safe. This middleware requires a valid
// Supabase session and confirms that session's user actually belongs to
// the organization being requested before the route runs.

const crypto = require('crypto');
const supabaseService = require('../services/supabase/supabase.service');

// Opening the Overview sends around twenty-five requests at once, and each
// one used to cost two Supabase round trips before any real work started.
// A successful check is remembered briefly instead. Failures are never
// remembered, and 30 seconds bounds how long a revoked session could still
// be accepted.
const VERIFIED_TTL_MS = 30 * 1000;
const verified = new Map();

function cacheKey(token, organizationId) {
    return crypto
        .createHash('sha256')
        .update(`${token}|${organizationId}`)
        .digest('hex');
}

function readVerified(key) {
    const entry = verified.get(key);

    if (!entry) return null;

    if (entry.expires <= Date.now()) {
        verified.delete(key);
        return null;
    }

    return entry.user;
}

// The JWT's own expiry, so a remembered check never outlives the token.
// Only called after Supabase has verified the token, so the unverified
// decode here cannot be fed an attacker-chosen value.
function tokenExpiresAt(token) {
    try {
        const payload = JSON.parse(
            Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
        );

        return Number.isFinite(payload.exp) ? payload.exp * 1000 : Infinity;
    } catch {
        return Infinity;
    }
}

function rememberVerified(key, token, user) {
    // Expired entries are otherwise only dropped when the same key is
    // asked for again, so clear them out once there are enough to matter.
    if (verified.size >= 500) {
        const now = Date.now();

        for (const [k, entry] of verified) {
            if (entry.expires <= now) verified.delete(k);
        }
    }

    verified.set(key, {
        user,
        expires: Math.min(Date.now() + VERIFIED_TTL_MS, tokenExpiresAt(token))
    });
}

function extractBearerToken(req) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

async function requireOrgAccess(req, res, next) {
    try {
        const token = extractBearerToken(req);

        if (!token) {
            return res.status(401).json({
                error: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        // The organization checked here and the one the route then reads
        // must be the same. A request may name it in the query or the body,
        // but naming two different ones (or one twice, which arrives as an
        // array) is refused outright: letting one of them win quietly is how
        // a check on your own company once let a route read another's.
        const fromQuery = req.query?.organizationId;
        const fromBody = req.body?.organizationId;

        if (fromQuery !== undefined && fromBody !== undefined && fromQuery !== fromBody) {
            return res.status(400).json({
                error: 'Name the organization once per request'
            });
        }

        const organizationId = fromQuery ?? fromBody;

        if (!organizationId) {
            return res.status(400).json({
                error: 'organizationId is required'
            });
        }

        if (typeof organizationId !== 'string') {
            return res.status(400).json({
                error: 'organizationId must be a single value'
            });
        }

        const key = cacheKey(token, organizationId);
        const known = readVerified(key);

        if (known) {
            req.user = known;
            req.organizationId = organizationId;
            return next();
        }

        const user = await supabaseService.getUserFromToken(token);

        if (!user) {
            return res.status(401).json({
                error: 'Invalid or expired session',
                code: 'AUTH_INVALID'
            });
        }

        const belongs = await supabaseService.isUserInOrganization(user.id, organizationId);

        if (!belongs) {
            return res.status(403).json({
                error: 'You do not have access to this organization',
                code: 'ORG_FORBIDDEN'
            });
        }

        rememberVerified(key, token, user);

        // Routes read the organization from here, never from the request
        // again, so they can only ever act on the one checked above.
        req.user = user;
        req.organizationId = organizationId;
        next();
    } catch (error) {
        console.error('Auth middleware failed:', error.message);

        res.status(500).json({
            error: 'Failed to verify authentication'
        });
    }
}

module.exports = { requireOrgAccess };
