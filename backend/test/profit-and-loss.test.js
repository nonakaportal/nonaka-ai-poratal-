// The Profit & Loss parser feeds most of what the owner sees, so the
// figures it reads out of a QuickBooks report are pinned here.
require('./_env');

const test = require('node:test');
const assert = require('node:assert/strict');

const qb = require('../services/quickbooks/quickbooks.service');

const line = (name, value) => ({
    type: 'Data',
    ColData: [{ value: name, id: name }, { value }]
});

const section = (group, header, lines, total) => ({
    type: 'Section',
    group,
    Header: { ColData: [{ value: header }, { value: '' }] },
    Rows: { Row: lines },
    Summary: { ColData: [{ value: `Total ${header}` }, { value: total }] }
});

const totalRow = (group, title, value) => ({
    type: 'Section',
    group,
    Summary: { ColData: [{ value: title }, { value }] }
});

const report = {
    Header: { StartPeriod: '2026-08-01', EndPeriod: '2026-08-31', Currency: 'USD', ReportBasis: 'Cash' },
    Rows: {
        Row: [
            section('Income', 'Income', [line('Sales', '9000.00'), line('Services', '3000.00')], '12000.00'),
            section('COGS', 'Cost of Goods Sold', [line('Materials', '4000.00')], '4000.00'),
            totalRow('GrossProfit', 'Gross Profit', '8000.00'),
            section('Expenses', 'Expenses', [line('Rent', '2500.00'), line('Payroll', '3000.00')], '5500.00'),
            totalRow('NetOperatingIncome', 'Net Operating Income', '2500.00'),
            totalRow('NetIncome', 'Net Income', '2500.00')
        ]
    }
};

test('reads the report totals as numbers', () => {
    const pl = qb.parseProfitAndLoss(report);

    assert.equal(pl.income, 12000);
    assert.equal(pl.costOfGoodsSold, 4000);
    assert.equal(pl.grossProfit, 8000);
    assert.equal(pl.expenses, 5500);
    assert.equal(pl.netIncome, 2500);
});

test('the totals it reads agree with each other', () => {
    const pl = qb.parseProfitAndLoss(report);

    assert.equal(pl.income - pl.costOfGoodsSold, pl.grossProfit);
    assert.equal(pl.grossProfit - pl.expenses, pl.netIncome);
});

test('carries the period, currency and basis from the header', () => {
    const pl = qb.parseProfitAndLoss(report);

    assert.deepEqual(pl.period, { startDate: '2026-08-01', endDate: '2026-08-31' });
    assert.equal(pl.currency, 'USD');
    assert.equal(pl.reportBasis, 'Cash');
});

test('files each account under its own section', () => {
    const { accounts } = qb.parseProfitAndLoss(report);

    assert.deepEqual(accounts.income.map(a => a.name).sort(), ['Sales', 'Services']);
    assert.deepEqual(accounts.cogs.map(a => a.name), ['Materials']);
    assert.deepEqual(accounts.expenses.map(a => a.name).sort(), ['Payroll', 'Rent']);
});

test('an empty or missing report gives zeros, not a crash', () => {
    for (const empty of [undefined, {}, { Rows: {} }]) {
        const pl = qb.parseProfitAndLoss(empty);

        assert.equal(pl.income, 0);
        assert.equal(pl.netIncome, 0);
    }
});
