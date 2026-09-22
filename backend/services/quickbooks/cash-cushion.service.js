// backend/services/quickbooks/cash-cushion.service.js
//
// The Scenarios page projects revenue, gross profit and net income.
// None of those answer the question the owner is really asking when
// they drag a slider: will there still be money in the bank.
//
// This walks today's real bank balance forward month by month, adding
// whatever the scenario's assumptions say the business will make or
// lose. It is deliberately labelled an estimate, because profit is not
// cash: it assumes customers pay and suppliers are paid inside the same
// month, which real businesses only approximately do.

const quickbooksService = require('./quickbooks.service');

// The baseline costs two QuickBooks calls, and slider drags ask for the
// same baseline over and over with different assumptions. Holding it
// briefly keeps dragging responsive without ever serving a stale number
// for long.
const BASELINE_TTL_MS = 5 * 60 * 1000;
const baselineCache = new Map();

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function toISODate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

// The three complete months before this one. The current month is
// excluded because it is partial, and a half-finished month would drag
// the monthly average down for no reason.
function recentCompleteMonths(today, count = 3) {
    const months = [];

    for (let i = count; i >= 1; i--) {
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
        const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 0));

        months.push({ startDate: toISODate(start), endDate: toISODate(end) });
    }

    return months;
}

// What a typical recent month looks like, from the books rather than
// from an assumption. `months` is how many actually loaded, so the
// average isn't distorted by a month that failed to fetch.
function averageMonth(reports) {
    const usable = (reports || []).filter(Boolean);

    if (!usable.length) {
        return null;
    }

    const sum = key =>
        usable.reduce((total, r) => total + Number(r?.[key] || 0), 0);

    return {
        months: usable.length,
        revenue: round2(sum('income') / usable.length),
        cogs: round2(sum('costOfGoodsSold') / usable.length),
        opex: round2(sum('expenses') / usable.length)
    };
}

// Compounds each assumption month by month, the same shape as the
// growth sliders on the page: a growth figure is annual, applied as an
// equal monthly step.
function monthlyRate(annualPercent) {
    return Math.pow(1 + Number(annualPercent || 0) / 100, 1 / 12);
}

// Walks the balance forward. Every month has its own revenue, costs and
// tax, so a business that is profitable but growing its costs faster
// than its sales still shows the balance turning down.
function projectCushion({ openingCash, baseline, params }) {
    const months = Math.max(1, Math.min(Number(params?.months) || 3, 24));

    const revStep = monthlyRate(params?.revGrowth);
    const cogsStep = monthlyRate(params?.cogsGrowth);
    const opexStep = monthlyRate(params?.opexGrowth);
    const taxRate = Math.max(0, Math.min(Number(params?.taxRate) || 0, 100)) / 100;

    let balance = Number(openingCash || 0);

    const timeline = [];
    let lowest = { month: 0, balance };
    let goesNegativeIn = null;

    for (let m = 1; m <= months; m++) {
        const revenue = baseline.revenue * Math.pow(revStep, m);
        const cogs = baseline.cogs * Math.pow(cogsStep, m);
        const opex = baseline.opex * Math.pow(opexStep, m);

        const preTax = revenue - cogs - opex;

        // A loss-making month does not generate a tax refund, so tax is
        // only taken when there is a profit to tax.
        const tax = preTax > 0 ? preTax * taxRate : 0;

        const change = preTax - tax;

        balance += change;

        timeline.push({
            month: m,
            revenue: round2(revenue),
            costs: round2(cogs + opex),
            tax: round2(tax),
            change: round2(change),
            balance: round2(balance)
        });

        if (balance < lowest.balance) {
            lowest = { month: m, balance: round2(balance) };
        }

        if (balance < 0 && goesNegativeIn === null) {
            goesNegativeIn = m;
        }
    }

    const end = round2(balance);
    const change = round2(end - Number(openingCash || 0));

    return {
        months,
        openingCash: round2(openingCash),
        endBalance: end,
        change,
        monthlyChange: round2(change / months),
        lowestPoint: lowest.month > 0 ? lowest : null,
        goesNegativeIn,
        timeline
    };
}

// Plain-language read on the result, so the owner isn't left to
// interpret a number on their own.
function describeCushion(projection, baseline) {
    const { endBalance, change, months, goesNegativeIn } = projection;

    if (goesNegativeIn !== null) {
        return {
            tone: 'bad',
            headline: `You run out of money in month ${goesNegativeIn}`,
            detail:
                'On these assumptions the account goes below zero before the ' +
                'end of the period. Something has to change — more sales, ' +
                'lower costs, or money in from somewhere else.'
        };
    }

    // One month of running costs is the same yardstick the Overview's
    // cash projection uses for its floor, so the two pages agree.
    const monthlyOutgoings = baseline.cogs + baseline.opex;

    if (monthlyOutgoings > 0 && endBalance < monthlyOutgoings) {
        return {
            tone: 'warn',
            headline: 'Your cushion gets thin',
            detail:
                `In ${months} months you'd have less in the bank than one ` +
                'month of your usual costs. That leaves no room for a late ' +
                'payment or an unexpected bill.'
        };
    }

    if (change < 0) {
        return {
            tone: 'warn',
            headline: 'Still comfortable, but shrinking',
            detail:
                `You'd end the period with less than you have today, though ` +
                'still enough to cover more than a month of costs.'
        };
    }

    return {
        tone: 'good',
        headline: 'Your cushion grows',
        detail:
            `On these assumptions you'd add money to the bank every month ` +
            `for the next ${months}.`
    };
}

async function loadBaseline(connection) {
    const cached = baselineCache.get(connection.organizationId);

    if (cached && Date.now() - cached.at < BASELINE_TTL_MS) {
        return cached.value;
    }

    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const today = new Date();
    const months = recentCompleteMonths(
        new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    );

    const reports = await Promise.all(
        months.map(m =>
            quickbooksService
                .getProfitAndLoss(accessToken, connection.realmId, m.startDate, m.endDate)
                .then(r => quickbooksService.parseProfitAndLoss(r))
                // A month that won't load simply doesn't contribute to the
                // average — better an average of two months than none.
                .catch(() => null)
        )
    );

    const tomorrow = toISODate(new Date(Date.now() + 24 * 60 * 60 * 1000));

    // getOpeningCashBalance reports the balance as of the day *before*
    // the date it is given, so tomorrow's opening balance is today's.
    // It answers with { date, amount }, not a bare number.
    const cashOnHand = await quickbooksService.getOpeningCashBalance(
        accessToken,
        connection.realmId,
        tomorrow
    );

    const value = {
        openingCash: round2(cashOnHand?.amount),
        baseline: averageMonth(reports),
        monthsRequested: months.length
    };

    baselineCache.set(connection.organizationId, { at: Date.now(), value });

    return value;
}

async function getCashCushion(connection, params = {}) {
    const { openingCash, baseline, monthsRequested } = await loadBaseline(connection);

    // Without any trading history there is nothing to project forward
    // from, and inventing a baseline would be making the answer up.
    if (!baseline || (!baseline.revenue && !baseline.cogs && !baseline.opex)) {
        return {
            available: false,
            reason:
                'There are not enough recent months in QuickBooks to estimate ' +
                'where your bank balance is heading.',
            openingCash: round2(openingCash),
            monthsOfHistory: baseline?.months || 0
        };
    }

    const projection = projectCushion({ openingCash, baseline, params });

    return {
        available: true,
        monthsOfHistory: baseline.months,
        monthsRequested,
        baseline,
        ...projection,
        verdict: describeCushion(projection, baseline),
        // Said plainly, because the number is only as good as this
        // assumption and the owner deserves to know that.
        assumption:
            'Assumes money comes in and goes out in the month it is earned ' +
            'or spent. Late-paying customers will make the real balance ' +
            'lower than this at times.'
    };
}

function clearBaselineCache() {
    baselineCache.clear();
}

module.exports = {
    getCashCushion,
    clearBaselineCache,
    _internals: {
        projectCushion,
        describeCushion,
        averageMonth,
        recentCompleteMonths,
        monthlyRate
    }
};
