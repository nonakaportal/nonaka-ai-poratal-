// The QuickBooks callback saves whichever company Intuit authorized into the
// organization named in the state. A state made by one person must not be
// usable to attach a different person's company — only the browser that
// asked for the link can finish it, once, while that person is still a
// member of the organization.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const supabase = require('../services/supabase/supabase.service');
const qb = require('../services/quickbooks/quickbooks.service');

let members;
let saved;

supabase.getUserFromToken = async token => ({ 'owner-token': { id: 'owner' }, 'attacker-token': { id: 'attacker' } })[token] || null;
supabase.isUserInOrganization = async (userId, orgId) => members.has(`${userId}|${orgId}`);
supabase.saveQuickBooksTokens = async (orgId, tokens) => { saved.push({ orgId, realmId: tokens.realm_id }); };
qb.exchangeCodeForTokens = async () => ({ access_token: 'qb-access', refresh_token: 'qb-refresh', expires_in: 3600 });

const routes = require('../routes/quickbooks.routes');

test.beforeEach(() => {
    members = new Set(['owner|org-owner', 'attacker|org-attacker']);
    saved = [];
});

function request(path, headers = {}) {
    const app = express();
    app.use('/api/quickbooks', routes);

    return new Promise(resolve => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path, headers }, res => {
                let body = '';
                res.on('data', chunk => (body += chunk));
                res.on('end', () => {
                    server.close();
                    resolve({ status: res.statusCode, headers: res.headers, body });
                });
            });
        });
    });
}

// Starts a connection the way the portal does: as a signed-in member,
// keeping the cookie the browser would keep.
async function startConnection(token, org) {
    const res = await request(
        `/api/quickbooks/connect-url?organizationId=${org}`,
        { authorization: `Bearer ${token}` }
    );

    const state = new URL(JSON.parse(res.body).authUrl).searchParams.get('state');
    const setCookie = res.headers['set-cookie'][0];

    return { state, setCookie, cookie: setCookie.split(';')[0] };
}

const callback = (state, cookie) =>
    request(
        `/api/quickbooks/callback?code=auth-code&realmId=realm-1&state=${encodeURIComponent(state)}`,
        cookie ? { cookie } : {}
    );

test('the one-time cookie is HttpOnly, Lax, short-lived and only sent to the callback', async () => {
    const { setCookie } = await startConnection('owner-token', 'org-owner');

    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/api\/quickbooks\/callback/);
    assert.match(setCookie, /Max-Age=600/);
});

test('the browser that started the connection can finish it', async () => {
    const { state, cookie } = await startConnection('owner-token', 'org-owner');

    const res = await callback(state, cookie);

    assert.equal(res.status, 302);
    assert.match(res.headers.location, /connected=true/);
    assert.deepEqual(saved, [{ orgId: 'org-owner', realmId: 'realm-1' }]);
});

test("a link someone else made can't be finished in the victim's browser", async () => {
    // The attacker makes a link for their own organization and gets the
    // victim to approve it. The victim's browser never had the cookie.
    const { state } = await startConnection('attacker-token', 'org-attacker');

    const res = await callback(state, null);

    assert.match(res.headers.location, /qb_error=1/);
    assert.deepEqual(saved, []);
});

test("another browser's cookie doesn't match", async () => {
    const attacker = await startConnection('attacker-token', 'org-attacker');
    const owner = await startConnection('owner-token', 'org-owner');

    const res = await callback(attacker.state, owner.cookie);

    assert.match(res.headers.location, /qb_error=1/);
    assert.deepEqual(saved, []);
});

test('a finished link cannot be used a second time', async () => {
    const { state, cookie } = await startConnection('owner-token', 'org-owner');

    await callback(state, cookie);
    const replay = await callback(state, cookie);

    assert.match(replay.headers.location, /qb_error=1/);
    assert.equal(saved.length, 1);
});

test('a state made before this check existed is refused', async () => {
    const state = qb.createOAuthState('org-owner');
    const { cookie } = await startConnection('owner-token', 'org-owner');

    const res = await callback(state, cookie);

    assert.match(res.headers.location, /qb_error=1/);
    assert.deepEqual(saved, []);
});

test('someone removed from the organization mid-way cannot finish', async () => {
    const { state, cookie } = await startConnection('owner-token', 'org-owner');

    members.delete('owner|org-owner');
    const res = await callback(state, cookie);

    assert.match(res.headers.location, /qb_error=1/);
    assert.deepEqual(saved, []);
});

test('the callback always clears the cookie', async () => {
    const { state, cookie } = await startConnection('owner-token', 'org-owner');

    const res = await callback(state, cookie);

    assert.match(res.headers['set-cookie'][0], /^nfp_qb_oauth=;.*Max-Age=0/);
});
