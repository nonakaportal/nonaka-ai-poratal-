// backend/services/quickbooks/bills-schedule.service.js
//
// Answers "what do I actually have to pay, and when" — the question an
// owner asks on a Monday morning. The Accounts Payable report already
// on the Bills page looks backwards (how long has this been outstanding);
// this looks forwards (what lands this week, what can wait).
//
// Every figure comes from the unpaid balance and due date carried by the
// Bill records themselves. Nothing is estimated.

const quickbooksService = require('./quickbooks.service');
const { toISODate, startOfToday } = require('./format');

const DAY_MS = 24 * 60 * 60 * 1000;

// Last calendar day of the month `today` falls in. Day 0 of the next
// month is the last day of this one, which also handles December.
function endOfMonth(today) {
    const d = new Date(today);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

// A bill reduced to what the page shows. Only unpaid balances count: a
// settled bill is not something the owner has to plan around.
function toBill(record) {
    const amount = Number(record?.Balance || 0);

    if (!(amount > 0)) {
        return null;
    }

    const due = record?.DueDate ? String(record.DueDate).slice(0, 10) : null;

    return {
        id: record?.Id || null,
        docNumber: record?.DocNumber || null,
        vendor: record?.VendorRef?.name || 'Unknown supplier',
        amount,
        dueDate: due,
        total: Number(record?.TotalAmt || 0)
    };
}

// How a due date reads to someone looking at it today. This is the whole
// point of the feature: "in 3 days" is actionable, "2026-09-25" is not.
function describeTiming(dueDate, today) {
    if (!dueDate) {
        return { days: null, label: 'No due date on the bill' };
    }

    const days = Math.round(
        (new Date(`${dueDate}T00:00:00Z`).getTime() - today.getTime()) / DAY_MS
    );

    if (days < -1) return { days, label: `${Math.abs(days)} days late` };
    if (days === -1) return { days, label: 'Due yesterday' };
    if (days === 0) return { days, label: 'Due today' };
    if (days === 1) return { days, label: 'Due tomorrow' };

    return { days, label: `Due in ${days} days` };
}

// Four buckets an owner can act on, plus a fifth for bills QuickBooks
// holds without a due date. Undated bills are surfaced rather than
// dropped — they are still money owed, and silently omitting them would
// make the page's total disagree with the books.
function bucketOf(bill, today) {
    if (!bill.dueDate) {
        return 'undated';
    }

    const todayIso = toISODate(today);

    if (bill.dueDate < todayIso) {
        return 'overdue';
    }

    // "This week" means the next seven days including today, not the
    // remainder of a calendar week — a bill due on Sunday matters just
    // as much when today is Saturday.
    const weekEnd = toISODate(new Date(today.getTime() + 6 * DAY_MS));

    if (bill.dueDate <= weekEnd) {
        return 'thisWeek';
    }

    if (bill.dueDate <= toISODate(endOfMonth(today))) {
        return 'laterThisMonth';
    }

    return 'later';
}

function summarise(bills) {
    return {
        count: bills.length,
        total: Math.round(bills.reduce((sum, b) => sum + b.amount, 0) * 100) / 100,
        bills
    };
}

// Groups unpaid bills by when they fall due.
function buildBillsSchedule(records, { today = startOfToday() } = {}) {
    const groups = {
        overdue: [],
        thisWeek: [],
        laterThisMonth: [],
        later: [],
        undated: []
    };

    for (const record of records || []) {
        const bill = toBill(record);

        if (!bill) continue;

        const timing = describeTiming(bill.dueDate, today);

        groups[bucketOf(bill, today)].push({
            ...bill,
            daysUntilDue: timing.days,
            timing: timing.label
        });
    }

    // Soonest first within each group; undated bills have nothing to sort
    // by, so they keep the largest amount at the top instead.
    for (const key of Object.keys(groups)) {
        groups[key].sort((a, b) =>
            key === 'undated'
                ? b.amount - a.amount
                : String(a.dueDate).localeCompare(String(b.dueDate))
        );
    }

    const outstanding = Object.values(groups)
        .flat()
        .reduce((sum, b) => sum + b.amount, 0);

    return {
        asOf: toISODate(today),
        weekEnds: toISODate(new Date(today.getTime() + 6 * DAY_MS)),
        monthEnds: toISODate(endOfMonth(today)),
        totalOutstanding: Math.round(outstanding * 100) / 100,
        overdue: summarise(groups.overdue),
        thisWeek: summarise(groups.thisWeek),
        laterThisMonth: summarise(groups.laterThisMonth),
        later: summarise(groups.later),
        undated: summarise(groups.undated)
    };
}

async function getBillsSchedule(connection) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const bills = await quickbooksService.getBills(
        accessToken,
        connection.realmId
    );

    return buildBillsSchedule(bills);
}

module.exports = {
    getBillsSchedule,
    buildBillsSchedule,
    _internals: { toBill, describeTiming, bucketOf, endOfMonth }
};
