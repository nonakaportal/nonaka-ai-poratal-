// The line under "Cash in the bank" is worked backwards from today's
// balance, so the arithmetic is pinned here against the report shape
// QuickBooks actually returns for summarize_column_by=Month.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');

const qb = require('../services/quickbooks/quickbooks.service');

const report = (titles, increases) => ({
    Header: { Currency: 'USD' },
    Columns: { Column: [{ ColTitle: '' }, ...titles.map(t => ({ ColTitle: t })), { ColTitle: 'Total' }] },
    Rows: {
        Row: [
            {
                type: 'Section',
                group: 'OperatingActivities',
                Summary: { ColData: [{ value: 'Net cash provided by operating activities' }, ...increases.map(v => ({ value: String(v) })), { value: '0' }] }
            },
            {
                type: 'Section',
                group: 'CashIncrease',
                Summary: {
                    ColData: [
                        { value: 'Net cash increase for period' },
                        ...increases.map(v => ({ value: v.toFixed(2) })),
                        { value: increases.reduce((a, b) => a + b, 0).toFixed(2) }
                    ]
                }
            }
        ]
    }
});

test('the last month ends on today\'s balance', () => {
    const { points } = qb.parseCashHistory(report(['Aug 2026', 'Sep 2026', 'Oct 1-8, 2026'], [100, -50, 25]), 1000);

    assert.equal(points.at(-1).balance, 1000);
    assert.equal(points.at(-1).label, 'Oct 1-8, 2026');
});

test('each earlier month is today less what changed after it', () => {
    const { points } = qb.parseCashHistory(report(['Aug 2026', 'Sep 2026', 'Oct 1-8, 2026'], [100, -50, 25]), 1000);

    // Oct ends 1000; Sep ended before Oct's +25; Aug ended before Sep's -50.
    assert.deepEqual(points.map(p => p.balance), [1025, 975, 1000]);
});

test('each month carries its own net change', () => {
    const { points } = qb.parseCashHistory(report(['Aug 2026', 'Sep 2026', 'Oct 1-8, 2026'], [100, -50, 25]), 1000);

    assert.deepEqual(points.map(p => p.change), [100, -50, 25]);
});

test('the Total column is not treated as a month', () => {
    const { points } = qb.parseCashHistory(report(['Sep 2026', 'Oct 2026'], [10, 20]), 500);

    assert.deepEqual(points.map(p => p.label), ['Sep 2026', 'Oct 2026']);
});

test('blank cells count as no change', () => {
    const r = report(['Sep 2026', 'Oct 2026'], [0, 0]);
    r.Rows.Row[1].Summary.ColData[1].value = '';

    assert.deepEqual(qb.parseCashHistory(r, 300).points.map(p => p.balance), [300, 300]);
});

test('a report without the net change row gives no points rather than wrong ones', () => {
    const r = report(['Sep 2026', 'Oct 2026'], [10, 20]);
    r.Rows.Row.pop();

    assert.deepEqual(qb.parseCashHistory(r, 500).points, []);
    assert.deepEqual(qb.parseCashHistory(undefined, 500).points, []);
});
