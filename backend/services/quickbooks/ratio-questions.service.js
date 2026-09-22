// backend/services/quickbooks/ratio-questions.service.js
//
// The ratios page names nine ratios and defines each one correctly.
// That is useful to somebody who already knows why they should care.
//
// These are the same numbers phrased as the questions they answer, and
// the one comparison nobody makes for themselves: whether the business
// is paying its suppliers faster than its customers are paying it, and
// what that gap costs.
//
// The formulas match the ones the ratio cards use, so the two cannot
// disagree.

const quickbooksService = require('./quickbooks.service');

function round1(n) {
    return Math.round(Number(n || 0) * 10) / 10;
}

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function formatter(currency = 'USD') {
    let format;

    try {
        format = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format;
    } catch {
        format = n => `${Math.round(Number(n))}`;
    }

    return n => format(Number(n || 0));
}

function findSection(nodes, needle) {
    for (const node of nodes || []) {
        if (String(node?.name || '').toLowerCase().includes(needle)) {
            return round2(node.amount);
        }

        const inside = findSection(node?.children, needle);

        if (inside !== null) return inside;
    }

    return null;
}

// How many days the P&L actually covers, so a collection figure is
// pro-rated against the period rather than an assumed 365-day year.
function periodLength(period) {
    if (!period?.startDate || !period?.endDate) {
        return null;
    }

    const days = Math.round(
        (new Date(period.endDate) - new Date(period.startDate)) / 86400000
    ) + 1;

    return days > 0 ? days : null;
}

// A days-to-pay figure is only as good as the flow it is measured
// against. If a business has $1,600 of unpaid bills but only recorded
// $400 of cost in the period, the arithmetic says 1,400 days, which is
// arithmetic rather than information. Anything beyond a year means the
// denominator is too small to divide by.
function daysMeasure(balance, flow, days) {
    if (balance === null || !flow || flow <= 0 || !days) {
        return { value: null, reliable: false, reason: 'no-flow' };
    }

    const value = round1((balance / flow) * days);

    if (value > 365) {
        return { value, reliable: false, reason: 'out-of-range' };
    }

    return { value, reliable: true };
}

function keepQuestion(pl, money) {
    const income = round2(pl?.income);
    const grossProfit = round2(pl?.grossProfit);
    const netIncome = round2(pl?.netIncome);

    if (!income) {
        return {
            key: 'keep',
            question: 'How much of each sale do you actually keep?',
            tone: 'quiet',
            headline: 'No sales in this period',
            detail: 'There is nothing to work this out from.',
            facts: []
        };
    }

    const gross = round1((grossProfit / income) * 100);
    const net = round1((netIncome / income) * 100);

    const facts = [
        { label: 'Left after doing the work', value: `${gross}%`, term: 'Gross margin' },
        { label: 'Left after everything', value: `${net}%`, term: 'Net margin' }
    ];

    if (net < 0) {
        return {
            key: 'keep',
            question: 'How much of each sale do you actually keep?',
            tone: 'bad',
            headline: 'Nothing — you are losing money on the year',
            // A margin percentage is also "dollars per hundred dollars of
            // sales", which is the form an owner can picture.
            detail:
                `Every ${money(100)} of sales leaves ${money(gross)} ` +
                'after the work is done, and that is not covering what it ' +
                'costs to run the business.',
            facts
        };
    }

    return {
        key: 'keep',
        question: 'How much of each sale do you actually keep?',
        tone: net < 5 ? 'warn' : 'good',
        headline: `About ${money(net)} of every ${money(100)}`,
        detail:
            `The work itself leaves ${gross}% of each sale. By the time the ` +
            `running costs are paid, ${net}% is left.` +
            (net < 5
                ? ' That is thin enough that one bad month would remove it.'
                : ''),
        facts
    };
}

function gettingPaidQuestion(dso, money) {
    if (!dso.reliable) {
        return {
            key: 'getting-paid',
            question: 'How long do your customers take to pay you?',
            tone: 'quiet',
            headline: 'Not enough in the books to say',
            detail:
                dso.reason === 'out-of-range'
                    ? 'What your customers owe is very large next to the sales ' +
                      'recorded in this period, which usually means invoices ' +
                      'have gone unpaid far longer than the period covers. The ' +
                      'Customers page lists them individually.'
                    : 'There were no sales recorded in this period to measure ' +
                      'collection against.',
            facts: []
        };
    }

    const days = Math.round(dso.value);

    return {
        key: 'getting-paid',
        question: 'How long do your customers take to pay you?',
        tone: days > 60 ? 'bad' : days > 45 ? 'warn' : 'good',
        headline: `About ${days} days`,
        detail:
            days > 60
                ? 'That is a long wait. Money you have already earned is ' +
                  'sitting with your customers instead of in your account.'
                : days > 45
                    ? 'Slower than most small businesses can comfortably carry.'
                    : 'That is a reasonable wait for an invoice.',
        facts: [{ label: 'Average wait for payment', value: `${days} days`, term: 'Days sales outstanding' }]
    };
}

function payingOutQuestion(dpo) {
    if (!dpo.reliable) {
        return {
            key: 'paying-out',
            question: 'How long do you take to pay your suppliers?',
            tone: 'quiet',
            headline: 'Not enough in the books to say',
            detail:
                dpo.reason === 'out-of-range'
                    ? 'What you owe suppliers is very large next to the costs ' +
                      'recorded in this period, so an average would be ' +
                      'misleading. The Bills page lists them individually.'
                    : 'No supplier costs were recorded in this period to ' +
                      'measure against.',
            facts: []
        };
    }

    const days = Math.round(dpo.value);

    return {
        key: 'paying-out',
        question: 'How long do you take to pay your suppliers?',
        tone: 'good',
        headline: `About ${days} days`,
        detail:
            'How long your bills sit before you settle them, on average.',
        facts: [{ label: 'Average time to pay a bill', value: `${days} days`, term: 'Days payable outstanding' }]
    };
}

// The comparison that matters and that nobody runs for themselves.
function cashGapQuestion(dso, dpo) {
    if (!dso.reliable || !dpo.reliable) {
        return {
            key: 'cash-gap',
            question: 'Are you paying out faster than you get paid?',
            tone: 'quiet',
            headline: 'Not enough in the books to say',
            detail:
                'This compares how long your customers take to pay with how ' +
                'long you take to pay. One of those two could not be worked ' +
                'out from this period.',
            facts: []
        };
    }

    const gap = Math.round(dso.value - dpo.value);

    const facts = [
        { label: 'Customers take', value: `${Math.round(dso.value)} days` },
        { label: 'You pay in', value: `${Math.round(dpo.value)} days` }
    ];

    if (gap <= 0) {
        return {
            key: 'cash-gap',
            question: 'Are you paying out faster than you get paid?',
            tone: 'good',
            headline: 'No — the money arrives first',
            detail:
                `You are paid about ${Math.abs(gap)} days before your own ` +
                'bills fall due, so your suppliers are effectively funding ' +
                'the gap rather than you.',
            gap,
            facts
        };
    }

    return {
        key: 'cash-gap',
        question: 'Are you paying out faster than you get paid?',
        tone: gap > 30 ? 'bad' : 'warn',
        headline: `Yes — by about ${gap} days`,
        detail:
            `You settle your bills around ${gap} days before your customers ` +
            'settle yours. For those days the business is covering the gap ' +
            'out of its own cash, which is the usual reason a profitable ' +
            'business still runs short.',
        gap,
        facts
    };
}

function borrowingQuestion(bs, money) {
    const assets = round2(bs?.totalAssets);
    const liabilities = round2(bs?.totalLiabilities);

    if (assets <= 0) {
        return {
            key: 'borrowing',
            question: 'How much of the business is funded by borrowing?',
            tone: 'quiet',
            headline: 'Nothing on the books to measure',
            detail: 'The balance sheet shows no assets.',
            facts: []
        };
    }

    const share = round1((liabilities / assets) * 100);

    const facts = [
        { label: 'What the business owes', value: money(liabilities) },
        { label: 'What it owns', value: money(assets) }
    ];

    if (share > 100) {
        return {
            key: 'borrowing',
            question: 'How much of the business is funded by borrowing?',
            tone: 'bad',
            headline: 'More than all of it',
            detail:
                `What the business owes comes to ${share}% of what it owns. ` +
                'Everything on the books is spoken for, and then some.',
            facts
        };
    }

    return {
        key: 'borrowing',
        question: 'How much of the business is funded by borrowing?',
        tone: share > 70 ? 'warn' : 'good',
        headline: `About ${Math.round(share)}% of it`,
        detail:
            share > 70
                ? 'Most of what the business owns is funded by what it owes. ' +
                  'That is fine while trading is steady.'
                : 'The rest is funded by you and by profits the business kept.',
        facts
    };
}

function buildRatioQuestions({ pl, bs, arTotal, apTotal }) {
    const money = formatter(pl?.currency || bs?.currency || 'USD');

    const days = periodLength(pl?.period);

    const dso = daysMeasure(arTotal, round2(pl?.income), days);
    const dpo = daysMeasure(apTotal, round2(pl?.costOfGoodsSold), days);

    return {
        period: pl?.period || null,
        currency: pl?.currency || 'USD',
        periodDays: days,
        questions: [
            keepQuestion(pl, money),
            cashGapQuestion(dso, dpo),
            gettingPaidQuestion(dso, money),
            payingOutQuestion(dpo),
            borrowingQuestion(bs, money)
        ]
    };
}

async function getRatioQuestions(connection, { startDate, endDate } = {}) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const asOf = endDate || new Date().toISOString().slice(0, 10);

    const [plReport, bsReport, arReport, apReport] = await Promise.all([
        quickbooksService.getProfitAndLoss(accessToken, connection.realmId, startDate, endDate),
        quickbooksService.getBalanceSheet(accessToken, connection.realmId, asOf),
        quickbooksService.getAccountsReceivable(accessToken, connection.realmId, asOf),
        quickbooksService.getAccountsPayable(accessToken, connection.realmId, asOf)
    ]);

    const pl = quickbooksService.parseProfitAndLoss(plReport);
    const bs = quickbooksService.parseBalanceSheet(bsReport);
    const ar = quickbooksService.parseAccountsReceivable(arReport);
    const ap = quickbooksService.parseAccountsPayable(apReport);

    return buildRatioQuestions({
        pl,
        bs,
        arTotal: round2(ar?.total),
        apTotal: round2(ap?.total)
    });
}

module.exports = {
    getRatioQuestions,
    buildRatioQuestions,
    _internals: {
        daysMeasure,
        periodLength,
        findSection,
        keepQuestion,
        cashGapQuestion,
        gettingPaidQuestion,
        payingOutQuestion,
        borrowingQuestion
    }
};
