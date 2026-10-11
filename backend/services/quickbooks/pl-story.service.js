// backend/services/quickbooks/pl-story.service.js
//
// A Profit & Loss statement is a list of totals that assumes you
// already know how they relate. This turns the same figures into the
// sequence they actually describe: you sold this much, it cost this to
// deliver, that left this, running the business took this, and this is
// what you kept.
//
// Every figure is the one QuickBooks reports. Nothing is recalculated
// from the account lines, so the story cannot disagree with the
// statement printed underneath it.

const quickbooksService = require('./quickbooks.service');
const { money, round2 } = require('./format');

function shareOf(value, base) {
    if (!base) return null;

    return Math.round((value / Math.abs(base)) * 1000) / 10;
}

// Turns a section's flat account list back into the shape the report
// shows it in: top-level accounts in their original order, with
// sub-accounts nested under the category they belong to.
//
// Each row carries its own total so a reader can check the arithmetic
// without adding the children up themselves.
function groupLines(accounts) {
    const order = [];
    const groups = new Map();

    for (const account of accounts || []) {
        const name = String(account?.name || '').trim();

        if (!name) continue;

        const amount = round2(account?.amount);
        const parent = String(account?._group || '').trim();

        if (!parent) {
            order.push({
                name,
                amount,
                // A parent account that was also posted to directly.
                // Worth flagging, or it reads like a duplicate of the
                // category sitting next to it.
                ownPosting: Boolean(account?._isOwnPosting)
            });
            continue;
        }

        let group = groups.get(parent);

        if (!group) {
            group = { name: parent, amount: 0, items: [] };
            groups.set(parent, group);
            order.push(group);
        }

        group.amount = round2(group.amount + amount);
        group.items.push({ name, amount });
    }

    return order;
}

// A subtotal has no accounts of its own — it is the rows above it,
// combined. Showing that arithmetic is the honest equivalent of
// opening it up.
function sumOf(lines) {
    return round2(
        (lines || []).reduce((total, line) => total + Number(line.amount || 0), 0)
    );
}

// Each step is either money arriving, money leaving, or a subtotal that
// falls out of the two. The distinction is what lets the page draw them
// differently without hard-coding which row is which.
function buildSteps(report) {
    const income = round2(report?.income);
    const cogs = round2(report?.costOfGoodsSold);
    const grossProfit = round2(report?.grossProfit);
    const expenses = round2(report?.expenses);
    const netOperatingIncome = round2(report?.netOperatingIncome);
    const netOther = round2(report?.netOtherIncome);
    const netIncome = round2(report?.netIncome);

    const accounts = report?.accounts || {};

    const incomeLines = groupLines(accounts.income);
    const cogsLines = groupLines(accounts.cogs);
    const expenseLines = groupLines(accounts.expenses);
    const otherLines = groupLines(accounts.otherIncomeExpense);

    // Says whether the accounts listed under a row actually add up to
    // the row. They should — but if a report is shaped in a way this
    // code didn't expect, the page should admit it rather than show a
    // list that quietly disagrees with the figure above it.
    const detail = (lines, total) => ({
        lines,
        linesTotal: sumOf(lines),
        adds_up: Math.abs(sumOf(lines) - round2(total)) < 0.02
    });

    const steps = [
        {
            key: 'sales',
            kind: 'in',
            label: 'What you sold',
            term: 'Revenue',
            amount: income,
            share: 100,
            explain: 'Everything you invoiced or took payment for in this period.',
            ...detail(incomeLines, income)
        },
        {
            key: 'cogs',
            kind: 'out',
            label: 'What it cost to deliver it',
            term: 'Cost of goods sold',
            amount: cogs,
            share: shareOf(cogs, income),
            // Deliberately not "materials and stock": this portal serves
            // service businesses as well as ones that sell goods, and a
            // consultancy has neither.
            explain:
                'The costs that only exist because you made the sale — ' +
                'whatever you had to buy in, or pay someone, to deliver it.',
            ...detail(cogsLines, cogs)
        },
        {
            key: 'gross',
            kind: 'subtotal',
            label: 'Left after those direct costs',
            term: 'Gross profit',
            amount: grossProfit,
            share: shareOf(grossProfit, income),
            explain:
                'What each sale leaves behind before you pay for anything ' +
                'else. This is the number that has to cover everything below.',
            // A subtotal owns no accounts. Opening it shows the sum it
            // came from instead.
            workings: [
                { name: 'What you sold', amount: income },
                { name: 'Less what it cost to deliver it', amount: round2(-cogs) }
            ]
        },
        {
            key: 'opex',
            kind: 'out',
            label: 'What it costs to run the business',
            term: 'Operating expenses',
            amount: expenses,
            share: shareOf(expenses, income),
            explain:
                'Rent, insurance, software, accountants — the costs you pay ' +
                'whether or not you sell anything.',
            ...detail(expenseLines, expenses)
        }
    ];

    // Only worth a row when there is something in it. Most small
    // businesses have nothing here, and an empty "other" line invites
    // the question of what it is.
    if (netOther !== 0) {
        steps.push({
            key: 'operating',
            kind: 'subtotal',
            label: 'Left from trading',
            term: 'Operating profit',
            amount: netOperatingIncome,
            share: shareOf(netOperatingIncome, income),
            explain: 'What the business itself made, before anything unusual.',
            workings: [
                { name: 'Left after those direct costs', amount: grossProfit },
                { name: 'Less what it costs to run the business', amount: round2(-expenses) }
            ]
        });

        steps.push({
            key: 'other',
            kind: netOther >= 0 ? 'in' : 'out',
            label:
                netOther >= 0
                    ? 'Other money in'
                    : 'Other costs',
            term: 'Other income and expenses',
            amount: round2(Math.abs(netOther)),
            share: shareOf(Math.abs(netOther), income),
            explain:
                'Things outside your day-to-day trading — interest, ' +
                'one-offs, and anything your bookkeeper put here.',
            ...detail(otherLines, Math.abs(netOther))
        });
    }

    steps.push({
        key: 'kept',
        kind: 'result',
        label: 'What you kept',
        term: 'Net profit',
        amount: netIncome,
        share: shareOf(netIncome, income),
        explain:
            'What is left once everything is paid. Not the same as cash ' +
            'in the bank — money owed to you counts here before it arrives.',
        workings: netOther !== 0
            ? [
                { name: 'Left from trading', amount: netOperatingIncome },
                { name: netOther >= 0 ? 'Plus other money in' : 'Less other costs', amount: netOther }
            ]
            : [
                { name: 'Left after those direct costs', amount: grossProfit },
                { name: 'Less what it costs to run the business', amount: round2(-expenses) }
            ]
    });

    return steps;
}

// The chain has to land on the figure QuickBooks reports. If it does
// not, something in the report is shaped in a way this code did not
// expect, and saying so is better than printing a story that silently
// disagrees with the statement below it.
function reconcile(report, steps) {
    const income = round2(report?.income);
    const cogs = round2(report?.costOfGoodsSold);
    const expenses = round2(report?.expenses);
    const netOther = round2(report?.netOtherIncome);
    const netIncome = round2(report?.netIncome);

    const walked = round2(income - cogs - expenses + netOther);
    const difference = round2(walked - netIncome);

    return {
        balances: Math.abs(difference) < 0.02,
        difference
    };
}

function describeResult(report) {
    // Not every company on this portal keeps its books in dollars.
    const fmt = money(report?.currency || 'USD', { decimals: 0 });
    const income = round2(report?.income);
    const netIncome = round2(report?.netIncome);
    const grossProfit = round2(report?.grossProfit);
    const expenses = round2(report?.expenses);

    if (!income) {
        return {
            tone: 'quiet',
            headline: 'No sales recorded in this period',
            detail:
                'There is nothing to break down. Pick a longer period, or ' +
                'check the sales have been entered in QuickBooks.'
        };
    }

    const margin = shareOf(netIncome, income);

    if (netIncome < 0) {
        // The useful thing is not "you lost money", it's which half of
        // the business the loss came from.
        const cause =
            grossProfit < 0
                ? 'The work itself is costing more than it brings in, before ' +
                  'you have paid a single running cost.'
                : 'The work makes money, but the running costs are bigger ' +
                  'than what it leaves behind.';

        return {
            tone: 'bad',
            headline: `You spent ${Math.abs(margin)}% more than you made`,
            detail: cause
        };
    }

    if (margin !== null && margin < 5) {
        return {
            tone: 'warn',
            headline: `You kept ${margin}% of what you sold`,
            detail:
                'That is a thin margin — a slow month or one unexpected ' +
                'cost would wipe it out.'
        };
    }

    return {
        tone: 'good',
        headline: `You kept ${margin}% of what you sold`,
        detail:
            `Out of every ${fmt(100)} you sold, about ${fmt(Math.round(margin))} ` +
            `stayed in the business after ${expenses > 0 ? 'costs' : 'everything'}.`
    };
}

function buildPLStory(report) {
    const steps = buildSteps(report);

    return {
        period: report?.period || null,
        currency: report?.currency || 'USD',
        reportBasis: report?.reportBasis || 'Accrual',
        steps,
        verdict: describeResult(report),
        reconciliation: reconcile(report, steps)
    };
}

async function getPLStory(connection, { startDate, endDate } = {}) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const report = await quickbooksService.getProfitAndLoss(
        accessToken,
        connection.realmId,
        startDate,
        endDate
    );

    return buildPLStory(quickbooksService.parseProfitAndLoss(report));
}

module.exports = {
    getPLStory,
    buildPLStory,
    _internals: { buildSteps, reconcile, describeResult, shareOf, groupLines, sumOf }
};
