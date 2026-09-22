// backend/services/quickbooks/money-flow.service.js
//
// Answers the two questions an owner asks about a period once they've
// seen the headline profit figure: where did the money come from, and
// what did it go on.
//
// The Profit & Loss report already carries every account line. All this
// does is rank them, roll sub-accounts up into the category they sit
// under, and work out each one's share — so the frontend draws a list
// instead of computing one.

const quickbooksService = require('./quickbooks.service');

// How many lines are worth reading before the tail stops being
// informative. Everything past this is summed into one "everything
// else" row so the total still adds up.
const TOP_N = 6;

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

// Sub-accounts are rolled into their parent because the parent is what
// the owner recognises: "Utilities" means something, "Gas & Electric"
// split from "Water" is detail they didn't ask for. The leaves are kept
// on each row so the UI can show what's inside without another call.
function rollUp(accounts) {
    const byCategory = new Map();

    for (const account of accounts || []) {
        const amount = Number(account?.amount || 0);
        const name = String(account?.name || '').trim();

        if (!name || !amount) continue;

        const category = String(account?._group || '').trim() || name;
        const existing = byCategory.get(category);

        if (existing) {
            existing.amount += amount;
            existing.parts.push({ name, amount: round2(amount) });
        } else {
            byCategory.set(category, {
                name: category,
                amount,
                parts: [{ name, amount: round2(amount) }]
            });
        }
    }

    return [...byCategory.values()].map(row => ({
        ...row,
        amount: round2(row.amount),
        // A single part that is just the row itself tells the UI nothing.
        parts: row.parts.length > 1
            ? row.parts.sort((a, b) => b.amount - a.amount)
            : []
    }));
}

// Ranks categories largest first and turns the tail into one row. Shares
// are of the ranked total, so they add to 100% and can't mislead.
function rank(categories, { topN = TOP_N } = {}) {
    // A negative line is a credit or refund sitting inside an income or
    // expense account. Ranking it alongside real spend would be
    // nonsense, so it's excluded from the list and reported separately
    // rather than quietly folded in.
    const positive = categories.filter(c => c.amount > 0);
    const credits = categories.filter(c => c.amount < 0);

    const total = positive.reduce((sum, c) => sum + c.amount, 0);

    const sorted = [...positive].sort((a, b) => b.amount - a.amount);
    const head = sorted.slice(0, topN);
    const tail = sorted.slice(topN);

    const withShare = head.map(c => ({
        name: c.name,
        amount: c.amount,
        share: total > 0 ? Math.round((c.amount / total) * 1000) / 10 : 0,
        parts: c.parts
    }));

    if (tail.length) {
        const rest = round2(tail.reduce((sum, c) => sum + c.amount, 0));

        withShare.push({
            name: `Everything else (${tail.length} more)`,
            amount: rest,
            share: total > 0 ? Math.round((rest / total) * 1000) / 10 : 0,
            parts: [],
            isRemainder: true
        });
    }

    return {
        total: round2(total),
        categoryCount: positive.length,
        rows: withShare,
        credits: credits.length
            ? {
                count: credits.length,
                total: round2(credits.reduce((sum, c) => sum + c.amount, 0))
            }
            : null
    };
}

function buildMoneyFlow(parsedReport, { topN = TOP_N } = {}) {
    const accounts = parsedReport?.accounts || {};

    const moneyIn = rank(rollUp(accounts.income), { topN });

    // Cost of sales and running costs are both money leaving the
    // business. An owner asking "what did I spend it on" does not think
    // in those two buckets, so they are ranked together.
    const moneyOut = rank(
        rollUp([...(accounts.cogs || []), ...(accounts.expenses || [])]),
        { topN }
    );

    return {
        period: parsedReport?.period || null,
        currency: parsedReport?.currency || 'USD',
        moneyIn,
        moneyOut,
        // What was left over, straight from the report's own total
        // rather than re-derived from the rankings above.
        kept: round2(parsedReport?.netIncome || 0)
    };
}

async function getMoneyFlow(connection, { startDate, endDate, topN = TOP_N } = {}) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const report = await quickbooksService.getProfitAndLoss(
        accessToken,
        connection.realmId,
        startDate,
        endDate
    );

    return buildMoneyFlow(
        quickbooksService.parseProfitAndLoss(report),
        { topN }
    );
}

module.exports = {
    getMoneyFlow,
    buildMoneyFlow,
    _internals: { rollUp, rank }
};
