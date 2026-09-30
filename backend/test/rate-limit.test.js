// The point of keying by session: people sharing one office connection
// must not share one budget.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionKey } = require('../middleware/rate-limit');

const req = (token, ip = '203.0.113.5') => ({
    ip,
    headers: token ? { authorization: `Bearer ${token}` } : {}
});

test('two people on the same office IP get different buckets', () => {
    assert.notEqual(sessionKey(req('token-ana')), sessionKey(req('token-ben')));
});

test('one session keeps one bucket across requests', () => {
    assert.equal(sessionKey(req('token-ana')), sessionKey(req('token-ana')));
});

test('the same session counts together even if its IP changes', () => {
    assert.equal(
        sessionKey(req('token-ana', '198.51.100.1')),
        sessionKey(req('token-ana', '198.51.100.2'))
    );
});

test('a request with no token falls back to its IP address', () => {
    assert.match(sessionKey(req(null)), /^ip:/);
    assert.notEqual(
        sessionKey(req(null, '198.51.100.1')),
        sessionKey(req(null, '198.51.100.2'))
    );
});

test('the token itself is not kept in the key', () => {
    assert.ok(!sessionKey(req('token-secret-value')).includes('token-secret-value'));
});
