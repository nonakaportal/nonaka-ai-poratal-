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

const supabaseService = require('../services/supabase/supabase.service');

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

        const user = await supabaseService.getUserFromToken(token);

        if (!user) {
            return res.status(401).json({
                error: 'Invalid or expired session',
                code: 'AUTH_INVALID'
            });
        }

        const organizationId = req.query.organizationId || req.body?.organizationId;

        if (!organizationId) {
            return res.status(400).json({
                error: 'organizationId is required'
            });
        }

        const belongs = await supabaseService.isUserInOrganization(user.id, organizationId);

        if (!belongs) {
            return res.status(403).json({
                error: 'You do not have access to this organization',
                code: 'ORG_FORBIDDEN'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('❌ Auth middleware failed:', error.message);

        res.status(500).json({
            error: 'Failed to verify authentication'
        });
    }
}

module.exports = { requireOrgAccess };
