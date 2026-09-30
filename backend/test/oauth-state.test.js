// The QuickBooks callback trusts the organization named in the signed
// state, so a forged or stale state must never verify.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const qb = require('../services/quickbooks/quickbooks.service');

const sign = (payload, secret = process.env.QB_CLIENT_SECRET) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');

    return `${body}.${sig}`;
};

test('a state made for an organization verifies and names it', () => {
    const state = qb.createOAuthState('org-1');

    assert.equal(qb.verifyOAuthState(state).organizationId, 'org-1');
});

test('rejects a state whose payload was edited to another organization', () => {
    const [, sig] = qb.createOAuthState('org-1').split('.');
    const forged = Buffer.from(JSON.stringify({ organizationId: 'org-2', timestamp: Date.now() }))
        .toString('base64url');

    assert.throws(() => qb.verifyOAuthState(`${forged}.${sig}`), /signature/i);
});

test('rejects a state signed with a different secret', () => {
    const state = sign({ organizationId: 'org-1', timestamp: Date.now() }, 'someone-elses-secret');

    assert.throws(() => qb.verifyOAuthState(state), /signature/i);
});

test('rejects a signature of the wrong length as a bad signature, not a crash', () => {
    const [body] = qb.createOAuthState('org-1').split('.');

    assert.throws(() => qb.verifyOAuthState(`${body}.abc`), /Invalid OAuth state signature/);
});

test('rejects a state older than ten minutes', () => {
    const state = sign({ organizationId: 'org-1', timestamp: Date.now() - 11 * 60 * 1000 });

    assert.throws(() => qb.verifyOAuthState(state), /expired/i);
});

test('accepts a state just inside ten minutes', () => {
    const state = sign({ organizationId: 'org-1', timestamp: Date.now() - 9 * 60 * 1000 });

    assert.equal(qb.verifyOAuthState(state).organizationId, 'org-1');
});

test('rejects malformed input', () => {
    assert.throws(() => qb.verifyOAuthState(''), /Invalid OAuth state/);
    assert.throws(() => qb.verifyOAuthState('no-dot-here'), /format/i);
    assert.throws(() => qb.verifyOAuthState('a.b.c'), /format/i);
});

test('will not create a state without an organization', () => {
    assert.throws(() => qb.createOAuthState(''), /Organization ID/);
});
