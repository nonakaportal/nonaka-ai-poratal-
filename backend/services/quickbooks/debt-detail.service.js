// backend/services/quickbooks/debt-detail.service.js
//
// The Debt page listed each loan and card with a balance and nothing
// else, which tells an owner what they owe but not whether they are
// getting anywhere. This adds the history behind each balance: what has
// been paid off, what the payments actually look like, and how long the
// balance would take to clear if they carry on as they have been.
//
// Everything is read out of the General Ledger, which carries a dated
// line for every movement on every account. Interest rates, contractual
// repayment amounts and maturity dates are NOT in QuickBooks — an
// account has no field for them — so they are not shown rather than
// guessed at.

const quickbooksService = require('./quickbooks.service');

// Two years is enough to see a repayment rhythm and usually reaches
// back past the opening balance, without pulling a report so large it
// slows the page down.
const HISTORY_MONTHS = 24;

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function toISODate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

function parseAmount(value) {
    if (value === null || value === undefined || value === '') {
        return 0;
    }

    // Report cells arrive as strings, occasionally parenthesised for
    // negatives and with thousands separators.
    const text = String(value).trim();
    const negative = /^\(.*\)$/.test(text);
    const n = Number(text.replace(/[(),$]/g, ''));

    if (!Number.isFinite(n)) {
        return 0;
    }

    return negative ? -Math.abs(n) : n;
}

// The General Ledger nests each account's lines under a section whose
// header names the account. QuickBooks ignores the account filter on
// this report, so the whole ledger comes back and the sections for the
// accounts we care about are picked out here.
function extractSections(report) {
    const columns = (report?.Columns?.Column || []).map(c => c.ColType || c.ColTitle);
    const index = name => columns.indexOf(name);

    const at = {
        date: index('tx_date'),
        type: index('txn_type'),
        num: index('doc_num'),
        name: index('name'),
        memo: index('memo'),
        split: index('split_acc'),
        amount: index('subt_nat_amount'),
        balance: index('rbal_nat_amount')
    };

    const sections = new Map();

    const walk = (rows, path = []) => {
        for (const row of rows || []) {
            const header = row?.Header?.ColData?.[0]?.value;
            const next = header ? [...path, header] : path;
            const account = next[next.length - 1];

            if (row?.ColData && account) {
                const cell = i => (i >= 0 ? row.ColData[i]?.value : undefined);

                if (!sections.has(account)) {
                    sections.set(account, []);
                }

                sections.get(account).push({
                    date: String(cell(at.date) || '').slice(0, 10),
                    type: cell(at.type) || '',
                    docNumber: cell(at.num) || null,
                    party: cell(at.name) || '',
                    memo: cell(at.memo) || '',
                    split: cell(at.split) || '',
                    amount: parseAmount(cell(at.amount)),
                    runningBalance: parseAmount(cell(at.balance))
                });
            }

            if (row?.Rows?.Row) {
                walk(row.Rows.Row, next);
            }
        }
    };

    walk(report?.Rows?.Row);

    return sections;
}

function monthKey(iso) {
    return String(iso || '').slice(0, 7);
}

// On a liability account a positive line increases what is owed — new
// borrowing, or a card purchase — and a negative line pays it down.
function summariseMovements(lines) {
    const payments = lines.filter(l => l.amount < 0);
    const increases = lines.filter(l => l.amount > 0);

    const paidOff = round2(payments.reduce((sum, l) => sum + Math.abs(l.amount), 0));
    const borrowed = round2(increases.reduce((sum, l) => sum + l.amount, 0));

    // Averaged over the months that actually had a payment, not over
    // the whole window: a loan paid quarterly should report what the
    // quarterly payment is, not a twelfth of the year.
    const byMonth = new Map();

    for (const p of payments) {
        const key = monthKey(p.date);
        byMonth.set(key, (byMonth.get(key) || 0) + Math.abs(p.amount));
    }

    const paymentMonths = [...byMonth.values()];

    const typicalPayment = paymentMonths.length
        ? round2(paymentMonths.reduce((a, b) => a + b, 0) / paymentMonths.length)
        : null;

    const lastPayment = payments.length
        ? [...payments].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
        : null;

    return {
        paidOff,
        borrowed,
        paymentCount: payments.length,
        paymentMonths: byMonth.size,
        typicalPayment,
        lastPayment: lastPayment
            ? {
                date: lastPayment.date,
                amount: round2(Math.abs(lastPayment.amount)),
                description:
                    lastPayment.memo ||
                    lastPayment.party ||
                    lastPayment.type ||
                    'Payment'
            }
            : null
    };
}

// How long the balance takes to clear at the rate the owner has actually
// been paying. Returns null whenever the history can't support an
// answer, which is honest and far more useful than a made-up date.
function estimateClearance({ balance, typicalPayment, paymentMonths, startBalance }) {
    if (!(balance > 0) || !typicalPayment || typicalPayment <= 0) {
        return null;
    }

    // One payment is an event, not a pattern.
    if (paymentMonths < 2) {
        return { known: false, reason: 'only-one-payment' };
    }

    // Whether the debt is actually going away is a question about the
    // balance over time, not about whether payments outweigh charges:
    // a loan's opening-balance entry counts as a charge and would
    // otherwise make every term loan look like it was growing.
    if (Number.isFinite(startBalance) && startBalance > 0) {
        const fall = startBalance - balance;

        if (fall <= 0) {
            return { known: false, reason: 'growing' };
        }

        // A balance that has barely moved is being spent back up about
        // as fast as it is paid down. Projecting a payoff date off the
        // payments alone would promise something the history doesn't
        // support.
        if (fall < startBalance * 0.1) {
            return { known: false, reason: 'flat' };
        }
    }

    const months = Math.ceil(balance / typicalPayment);

    const clearsOn = new Date();
    clearsOn.setUTCDate(1);
    clearsOn.setUTCMonth(clearsOn.getUTCMonth() + months);

    return {
        known: true,
        months,
        clearsOn: toISODate(clearsOn).slice(0, 7),
        // Named as an assumption so it can't be read as a commitment.
        basis: 'If you keep paying what you have been paying'
    };
}

function buildAccountDetail(account, lines) {
    const history = (lines || [])
        .filter(l => l.date)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const balance = Number(account.balance || 0);
    const movements = summariseMovements(history);

    // The earliest line's running balance less its own amount is what
    // was owed before the window opened.
    const first = history[0] || null;
    const openingBalance = first
        ? round2(Number(first.runningBalance || 0) - Number(first.amount || 0))
        : null;

    const startedAt = first?.date || null;

    // "How much of it have I cleared" only means something for debt that
    // is paid down towards zero. On a credit card the balance is spent
    // back up again every month, so the same arithmetic produces figures
    // like 468% — true as a ratio, meaningless as progress. It is left
    // off cards entirely, and only shown for a loan whose whole life is
    // visible in the window, since otherwise the starting figure is a
    // guess.
    const revolving = account.accountType === 'Credit Card';

    const everOwed = (openingBalance || 0) + movements.borrowed;

    const clearedShare =
        !revolving && openingBalance !== null && everOwed > 0
            ? Math.min(
                100,
                Math.round((movements.paidOff / everOwed) * 1000) / 10
            )
            : null;

    return {
        id: account.id,
        name: account.name,
        category: account.category,
        accountType: account.accountType,
        balance: round2(balance),
        currency: account.currency,
        openingBalance,
        startedAt,
        ...movements,
        clearedShare,
        clearance: estimateClearance({
            balance,
            typicalPayment: movements.typicalPayment,
            paymentMonths: movements.paymentMonths,
            // Where the balance stood at the start of the window, which
            // is what "is this going down" is measured against.
            startBalance: first ? Number(first.runningBalance || 0) : null
        }),
        // Newest first, and capped: the page shows a recent history, not
        // a full statement.
        recent: history
            .slice(-12)
            .reverse()
            .map(l => ({
                date: l.date,
                description: l.memo || l.party || l.type || 'Movement',
                type: l.type,
                amount: round2(l.amount),
                direction: l.amount < 0 ? 'payment' : 'increase',
                balance: round2(l.runningBalance)
            })),
        hasHistory: history.length > 0
    };
}

async function getDebtDetail(connection) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const accounts = quickbooksService.getDebtAccounts(
        await quickbooksService.getAccounts(accessToken, connection.realmId)
    );

    const end = new Date();
    const start = new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - HISTORY_MONTHS, 1)
    );

    let sections = new Map();

    try {
        const ledger = await quickbooksService.makeApiRequest(
            accessToken,
            connection.realmId,
            `reports/GeneralLedger` +
            `?start_date=${toISODate(start)}` +
            `&end_date=${toISODate(end)}`
        );

        sections = extractSections(ledger);
    } catch (error) {
        // Without the ledger the balances are still correct, so the page
        // degrades to what it showed before rather than failing outright.
        console.error(
            'Debt detail: ledger unavailable, falling back to balances only:',
            error.response?.data?.Fault?.Error?.[0]?.Detail || error.message
        );
    }

    const details = accounts.map(account => {
        const leafName = String(account.fullName || account.name)
            .split(':')
            .pop();

        const lines = sections.get(account.name) || sections.get(leafName) || [];

        return buildAccountDetail(account, lines);
    });

    const totals = details.reduce(
        (acc, d) => {
            acc.balance = round2(acc.balance + d.balance);
            acc.paidOff = round2(acc.paidOff + d.paidOff);
            return acc;
        },
        { balance: 0, paidOff: 0 }
    );

    return {
        historyFrom: toISODate(start),
        historyMonths: HISTORY_MONTHS,
        ledgerAvailable: sections.size > 0,
        totals,
        accounts: details.sort((a, b) => b.balance - a.balance),
        // Stated once, on the page, rather than leaving empty fields
        // that look like something failed to load.
        notInQuickBooks:
            'QuickBooks does not hold interest rates, agreed repayment ' +
            'amounts or end dates for a loan, so those are not shown here. ' +
            'Your loan agreement is the place to check them.'
    };
}

module.exports = {
    getDebtDetail,
    _internals: {
        extractSections,
        summariseMovements,
        estimateClearance,
        buildAccountDetail,
        parseAmount
    }
};
