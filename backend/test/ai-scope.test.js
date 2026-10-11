// Ask NFP AI reads a company's books into the conversation, so it must only
// ever read the company the access check approved. It once took the
// organization from the request body while the check had looked at the query.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const supabase = require('../services/supabase/supabase.service');

const lookedUp = [];

supabase.getUserFromToken = async token => (token === 'member-token' ? { id: 'user-1' } : null);
supabase.isUserInOrganization = async (userId, orgId) => userId === 'user-1' && orgId === 'org-own';
supabase.getQuickBooksTokens = async orgId => { lookedUp.push(orgId); return null; };

const aiRoutes = require('../routes/ai.routes');

function ask(query, body) {
    const app = express();
    app.use(express.json());
    app.use('/api/ai', aiRoutes);

    return new Promise(resolve => {
        const server = app.listen(0, () => {
            const data = JSON.stringify(body);
            const req = http.request({
                port: server.address().port,
                method: 'POST',
                path: `/api/ai/ask${query}`,
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(data),
                    authorization: 'Bearer member-token'
                }
            }, res => {
                let out = '';
                res.on('data', chunk => (out += chunk));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(out) }); });
            });
            req.end(data);
        });
    });
}

test.beforeEach(() => { lookedUp.length = 0; });

test('own organization in the query and another in the body is refused before any books are read', async () => {
    const out = await ask('?organizationId=org-own', { organizationId: 'org-other', question: 'Summarise my numbers' });

    assert.equal(out.status, 400);
    assert.deepEqual(lookedUp, []);
});

test('another organization in the body alone is refused', async () => {
    const out = await ask('', { organizationId: 'org-other', question: 'Summarise my numbers' });

    assert.equal(out.status, 403);
    assert.deepEqual(lookedUp, []);
});

test('a member asking about their own organization reads only that one', async () => {
    await ask('', { organizationId: 'org-own', question: 'Summarise my numbers' });

    assert.deepEqual(lookedUp, ['org-own']);
});
