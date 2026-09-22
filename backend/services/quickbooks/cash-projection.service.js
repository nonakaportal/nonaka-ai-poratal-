// backend/services/quickbooks/cash-projection.service.js
//
// Answers "where is my cash heading over the next N days, and is it
// going to dip somewhere uncomfortable" from the owner's real books.
//
// Everything here is derived from QuickBooks records — today's cash
// balance, unpaid customer invoices, and unpaid supplier bills, each
// with the due date it actually carries. Nothing is estimated or
// invented: if a figure isn't in the books, it isn't in the projection.

const quickbooksService = require('./quickbooks.service');

const DAY_MS = 24 * 60 * 60 * 1000;

function toISODate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

function startOfToday() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Money the owner is owed or owes, reduced to the only three things the
// projection cares about: how much, when, and who.
function toMovements(records, { amountField = 'Balance', partyField, kind }) {
    return (records || [])
        .map(r => {
            const amount = Number(r?.[amountField] || 0);

            if (!(amount > 0) || !r?.DueDate) {
                return null;
            }

            return {
                kind,
                date: String(r.DueDate).slice(0, 10),
                amount,
                party: r?.[partyField]?.name || 'Unknown',
                docNumber: r?.DocNumber || r?.Id || null
            };
        })
        .filter(Boolean);
}

// Anything already past its due date is treated as landing immediately
// rather than being spread into the future. An invoice that was due in
// July is not going to arrive on a future date of our choosing, and
// pretending otherwise would flatter the projection.
function splitOverdue(movements, today) {
    const todayIso = toISODate(today);
    const overdue = [];
    const upcoming = [];

    for (const m of movements) {
        (m.date < todayIso ? overdue : upcoming).push(m);
    }

    return { overdue, upcoming };
}

// A floor worth warning about has to mean something to this business, so
// it's derived from what the business actually spends: roughly one month
// of recent outgoings, the buffer that covers payroll and suppliers if
// nothing comes in. Returns null when there isn't enough history to say.
function deriveSafeFloor(monthlyOutflows) {
    const usable = (monthlyOutflows || []).filter(v => Number.isFinite(v) && v > 0);

    if (usable.length === 0) {
        return null;
    }

    const avg = usable.reduce((a, b) => a + b, 0) / usable.length;

    return Math.round(avg);
}

function buildTimeline({ openingCash, upcoming, days, today }) {
    const byDate = new Map();

    for (const m of upcoming) {
        if (!byDate.has(m.date)) {
            byDate.set(m.date, { in: 0, out: 0, items: [] });
        }

        const bucket = byDate.get(m.date);

        if (m.kind === 'in') bucket.in += m.amount;
        else bucket.out += m.amount;

        bucket.items.push(m);
    }

    const timeline = [];
    let running = openingCash;

    for (let i = 0; i <= days; i++) {
        const date = toISODate(today.getTime() + i * DAY_MS);
        const bucket = byDate.get(date) || { in: 0, out: 0, items: [] };

        running += bucket.in - bucket.out;

        timeline.push({
            date,
            moneyIn: Math.round(bucket.in * 100) / 100,
            moneyOut: Math.round(bucket.out * 100) / 100,
            balance: Math.round(running * 100) / 100,
            items: bucket.items
        });
    }

    return timeline;
}

// If the projection dips below the floor, look for the single biggest
// outgoing before the dip: moving it past the low point is usually the
// smallest change that restores the buffer. This is advice only — the
// app reads from QuickBooks and never writes to it, so nothing here
// reschedules anything on the owner's behalf.
function buildTimingTip({ timeline, floor }) {
    if (!Number.isFinite(floor)) {
        return null;
    }

    const dip = timeline.find(day => day.balance < floor);

    if (!dip) {
        return null;
    }

    const outgoingsBeforeDip = timeline
        .filter(day => day.date <= dip.date)
        .flatMap(day => day.items)
        .filter(item => item.kind === 'out')
        .sort((a, b) => b.amount - a.amount);

    const culprit = outgoingsBeforeDip[0];

    if (!culprit) {
        return {
            dipDate: dip.date,
            dipBalance: dip.balance,
            shortfall: Math.round((floor - dip.balance) * 100) / 100,
            bill: null,
            suggestion:
                'Your projected balance dips below your usual monthly outgoings, and it is not down to one single bill.'
        };
    }

    // The first day after the dip where the balance has recovered past
    // the floor — the earliest point this bill could move to without
    // reintroducing the same problem.
    const recovery = timeline.find(
        day => day.date > dip.date && day.balance >= floor
    );

    return {
        dipDate: dip.date,
        dipBalance: dip.balance,
        shortfall: Math.round((floor - dip.balance) * 100) / 100,
        bill: {
            party: culprit.party,
            amount: culprit.amount,
            dueDate: culprit.date,
            docNumber: culprit.docNumber
        },
        moveTo: recovery ? recovery.date : null,
        suggestion: recovery
            ? `Paying ${culprit.party} (${culprit.amount}) on ${recovery.date} instead of ${culprit.date} keeps you above your usual buffer.`
            : `${culprit.party} (${culprit.amount}) on ${culprit.date} is the largest payment before the dip.`
    };
}

async function buildCashProjection(connection, { days = 30, monthlyOutflows = [] } = {}) {
    const accessToken = await quickbooksService.getValidAccessToken(connection);

    const today = startOfToday();

    // getOpeningCashBalance reports the balance as of the day *before*
    // the date it's given (it exists to answer "what was in the bank
    // when this reporting period started"), so asking for tomorrow is
    // how you get today's closing cash. Reusing it means the recursive
    // walk over the balance sheet's bank accounts stays in one place.
    const tomorrow = toISODate(today.getTime() + DAY_MS);

    const [invoices, bills, cashOnHand] = await Promise.all([
        quickbooksService.getInvoices(accessToken, connection.realmId),
        quickbooksService.getBills(accessToken, connection.realmId),
        quickbooksService.getOpeningCashBalance(
            accessToken,
            connection.realmId,
            tomorrow
        )
    ]);

    const openingCash = Number(cashOnHand?.amount || 0);

    const inflows = toMovements(invoices, { partyField: 'CustomerRef', kind: 'in' });
    const outflows = toMovements(bills, { partyField: 'VendorRef', kind: 'out' });

    const invSplit = splitOverdue(inflows, today);
    const billSplit = splitOverdue(outflows, today);

    const overdueIn = invSplit.overdue.reduce((s, m) => s + m.amount, 0);
    const overdueOut = billSplit.overdue.reduce((s, m) => s + m.amount, 0);

    const upcoming = [...invSplit.upcoming, ...billSplit.upcoming];

    const timeline = buildTimeline({ openingCash, upcoming, days, today });

    const floor = deriveSafeFloor(monthlyOutflows);

    const lowest = timeline.reduce(
        (min, day) => (day.balance < min.balance ? day : min),
        timeline[0]
    );

    return {
        days,
        openingCash: Math.round(openingCash * 100) / 100,
        currency: cashOnHand?.currency || 'USD',

        safeFloor: floor,
        floorBasis: floor === null
            ? 'Not enough spending history to work out a safe buffer yet'
            : 'About one month of your recent outgoings',

        timeline,

        lowestPoint: {
            date: lowest?.date || null,
            balance: lowest?.balance ?? null,
            belowFloor: Number.isFinite(floor) ? (lowest?.balance ?? 0) < floor : null
        },

        closingBalance: timeline.length ? timeline[timeline.length - 1].balance : null,

        // Already-late money is reported separately rather than folded
        // into the forward line, so the owner can see it for what it is.
        overdue: {
            customersOweYou: Math.round(overdueIn * 100) / 100,
            customerCount: invSplit.overdue.length,
            youOweSuppliers: Math.round(overdueOut * 100) / 100,
            supplierCount: billSplit.overdue.length
        },

        upcomingCounts: {
            invoices: invSplit.upcoming.length,
            bills: billSplit.upcoming.length
        },

        timingTip: buildTimingTip({ timeline, floor })
    };
}

module.exports = {
    buildCashProjection,
    // exported for testing the pure pieces without hitting QuickBooks
    _internals: { toMovements, splitOverdue, deriveSafeFloor, buildTimeline, buildTimingTip }
};
