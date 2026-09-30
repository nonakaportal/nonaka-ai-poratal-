// The gate sits in front of every QuickBooks read. What matters: it asks
// once, never runs more than a few at a time, and always hands its slot back.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { RequestGate, MAX_IN_FLIGHT } = require('../services/quickbooks/request-gate');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = n => ({ realmId: 'realm-1', key: `realm-1|GET|report-${n}`, cacheable: true });

test('identical questions asked together share one call', async () => {
    const gate = new RequestGate();
    let calls = 0;

    const ask = () => gate.run(key(1), async () => { calls++; await wait(20); return { total: 5 }; });
    const answers = await Promise.all([ask(), ask(), ask()]);

    assert.equal(calls, 1);
    assert.deepEqual(answers, [{ total: 5 }, { total: 5 }, { total: 5 }]);
});

test('a finished answer is reused', async () => {
    const gate = new RequestGate();
    let calls = 0;
    const fn = async () => { calls++; return 1; };

    await gate.run(key(1), fn);
    await gate.run(key(1), fn);

    assert.equal(calls, 1);
});

test('each caller gets its own copy of the answer', async () => {
    const gate = new RequestGate();
    const fn = async () => ({ rows: [1, 2] });

    const first = await gate.run(key(1), fn);
    first.rows.push(99);

    assert.deepEqual(await gate.run(key(1), fn), { rows: [1, 2] });
});

test('never has more than the allowed number in flight for one company', async () => {
    const gate = new RequestGate();
    let active = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: 12 }, (_, n) =>
        gate.run(key(n), async () => {
            active++;
            peak = Math.max(peak, active);
            await wait(10);
            active--;
        })
    ));

    assert.ok(peak <= MAX_IN_FLIGHT, `peak was ${peak}`);
    assert.ok(peak > 1, 'calls should still overlap up to the limit');
});

test('a failed call hands its slot back, so later calls are not stuck behind it', async () => {
    const gate = new RequestGate();

    const failures = await Promise.allSettled(
        Array.from({ length: MAX_IN_FLIGHT * 2 }, (_, n) =>
            gate.run(key(`f${n}`), async () => { throw new Error('boom'); }))
    );

    assert.ok(failures.every(f => f.status === 'rejected'));

    const outcome = await Promise.race([
        gate.run(key('after'), async () => 'fine'),
        wait(1000).then(() => 'stuck')
    ]);

    assert.equal(outcome, 'fine');
});

test('a failed answer is not remembered', async () => {
    const gate = new RequestGate();
    let calls = 0;

    await assert.rejects(gate.run(key(1), async () => { calls++; throw new Error('boom'); }));
    await gate.run(key(1), async () => { calls++; return 'ok'; });

    assert.equal(calls, 2);
});

test('waits and asks again when QuickBooks says 429', async () => {
    const gate = new RequestGate();
    let calls = 0;

    const answer = await gate.run(key(1), async () => {
        calls++;

        if (calls === 1) {
            throw Object.assign(new Error('slow down'), { response: { status: 429 } });
        }

        return 'ok';
    });

    assert.equal(answer, 'ok');
    assert.equal(calls, 2);
});

test('does not retry an error that would fail the same way again', async () => {
    const gate = new RequestGate();
    let calls = 0;

    await assert.rejects(gate.run(key(1), async () => {
        calls++;
        throw Object.assign(new Error('bad request'), { response: { status: 400 } });
    }));

    assert.equal(calls, 1);
});
