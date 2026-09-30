// A failed signup must leave nothing behind, and must never delete an
// account that existed before the request.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');

const supabase = require('../services/supabase/supabase.service');
const { undoSignup } = require('../routes/auth.routes')._internals;

let calls;

test.beforeEach(() => {
    calls = [];

    supabase.deleteMembershipsForOrganization = async id => { calls.push(`memberships:${id}`); };
    supabase.deleteOrganization = async id => { calls.push(`organization:${id}`); };
    supabase.deleteProfile = async id => { calls.push(`profile:${id}`); };
    supabase.deleteAuthUser = async id => { calls.push(`user:${id}`); };
});

const made = extra => ({
    userId: 'u1',
    userFresh: true,
    profile: false,
    organizationId: null,
    membership: false,
    ...extra
});

test('removes everything a full attempt wrote, newest first', async () => {
    await undoSignup(made({ profile: true, organizationId: 'o1', membership: true }));

    assert.deepEqual(calls, ['memberships:o1', 'organization:o1', 'profile:u1', 'user:u1']);
});

test('after a failed profile step, only the new auth user is removed', async () => {
    await undoSignup(made());

    assert.deepEqual(calls, ['user:u1']);
});

test('never deletes an auth user that was not brand new', async () => {
    await undoSignup(made({ userFresh: false, profile: true }));

    assert.deepEqual(calls, ['profile:u1']);
});

test('does nothing when nothing was written', async () => {
    await undoSignup(made({ userId: null, userFresh: false }));

    assert.deepEqual(calls, []);
});

test('one step failing does not stop the rest', async () => {
    supabase.deleteOrganization = async () => { throw new Error('locked'); };

    await undoSignup(made({ profile: true, organizationId: 'o1', membership: true }));

    assert.deepEqual(calls, ['memberships:o1', 'profile:u1', 'user:u1']);
});
