// requireOrgAccess is what keeps one business from reading the books of
// another, so every way past it is tested here.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');

const supabase = require('../services/supabase/supabase.service');
const { requireOrgAccess } = require('../middleware/auth.middleware');

let tokenLookups;

test.beforeEach(() => {
    tokenLookups = 0;

    supabase.getUserFromToken = async token => {
        tokenLookups++;
        return token.startsWith('good') ? { id: 'user-1' } : null;
    };

    supabase.isUserInOrganization = async (userId, orgId) =>
        userId === 'user-1' && orgId === 'org-1';
});

// Resolves with what the middleware did: answered with a status, or let the
// request through.
function call(req) {
    return new Promise(resolve => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body, passed: false }); }
        };

        const fullReq = { headers: {}, query: {}, body: {}, ...req };

        requireOrgAccess(fullReq, res, () => resolve({ passed: true, req: fullReq }));
    });
}

const asMember = (token, org = 'org-1') => ({
    headers: { authorization: `Bearer ${token}` },
    query: { organizationId: org }
});

test('rejects a request with no token', async () => {
    const out = await call({ query: { organizationId: 'org-1' } });

    assert.equal(out.status, 401);
    assert.equal(out.body.code, 'AUTH_REQUIRED');
});

test('rejects a request with no organizationId', async () => {
    const out = await call({ headers: { authorization: 'Bearer good-a' } });

    assert.equal(out.status, 400);
});

test('rejects a token Supabase does not recognise', async () => {
    const out = await call(asMember('bad-token'));

    assert.equal(out.status, 401);
    assert.equal(out.body.code, 'AUTH_INVALID');
});

test('rejects a real user asking for an organization they are not in', async () => {
    const out = await call(asMember('good-b', 'org-2'));

    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'ORG_FORBIDDEN');
});

test('rejects repeated organizationId parameters', async () => {
    const out = await call(asMember('good-c', ['org-1', 'org-2']));

    assert.equal(out.passed, false);
});

test('lets a member through and attaches the user', async () => {
    const out = await call(asMember('good-d'));

    assert.equal(out.passed, true);
    assert.equal(out.req.user.id, 'user-1');
});

test('accepts organizationId from the body as well as the query', async () => {
    const out = await call({
        headers: { authorization: 'Bearer good-e' },
        body: { organizationId: 'org-1' }
    });

    assert.equal(out.passed, true);
});

test('remembers a successful check, but never a failed one', async () => {
    await call(asMember('good-f'));
    await call(asMember('good-f'));
    assert.equal(tokenLookups, 1, 'a second identical request should reuse the first check');

    await call(asMember('bad-f'));
    await call(asMember('bad-f'));
    assert.equal(tokenLookups, 3, 'a rejected token must be checked again every time');
});

test('a failure inside the check answers 500 rather than letting the request through', async () => {
    supabase.getUserFromToken = async () => { throw new Error('supabase down'); };

    const out = await call(asMember('good-g'));

    assert.equal(out.status, 500);
    assert.equal(out.passed, false);
});
