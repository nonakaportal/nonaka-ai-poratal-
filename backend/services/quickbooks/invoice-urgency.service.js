// backend/services/quickbooks/invoice-urgency.service.js
//
// The Customers page had an aging bar, which is the accountant's view:
// buckets of 30 days. This is the owner's view of the same money — who
// to chase first, and what is merely not due yet.
//
// The mirror of the bills schedule, but for money coming in, and with
// one difference that matters: an invoice sitting unpaid for months is
// not just late, it is at risk, so it gets its own band rather than
// being lumped in with something a week overdue.

const quickbooksService = require('./quickbooks.service');
const { round2, toISODate, startOfToday } = require('./format');

const DAY_MS = 24 * 60 * 60 * 1000;

// Past this, an unpaid invoice stops being a timing problem and starts
// being a collection problem.
const AT_RISK_DAYS = 30;

// Only the unpaid part of an invoice matters here. A partly-paid
// invoice carries the remainder in Balance, which is what the customer
// still owes.
function toInvoice(record) {
    const amount = Number(record?.Balance || 0);

    if (!(amount > 0)) {
        return null;
    }

    return {
        id: record?.Id || null,
        docNumber: record?.DocNumber || null,
        customer: record?.CustomerRef?.name || 'Unknown customer',
        amount,
        total: Number(record?.TotalAmt || 0),
        dueDate: record?.DueDate ? String(record.DueDate).slice(0, 10) : null,
        issuedOn: record?.TxnDate ? String(record.TxnDate).slice(0, 10) : null
    };
}

function daysFromToday(iso, today) {
    if (!iso) return null;

    return Math.round(
        (new Date(`${iso}T00:00:00Z`).getTime() - today.getTime()) / DAY_MS
    );
}

function describeTiming(days) {
    if (days === null) return 'No due date on the invoice';
    if (days < -1) return `${Math.abs(days)} days late`;
    if (days === -1) return 'Due yesterday';
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';

    return `Due in ${days} days`;
}

function bandOf(days, today) {
    if (days === null) {
        return 'undated';
    }

    if (days < -AT_RISK_DAYS) return 'atRisk';
    if (days < 0) return 'late';
    if (days <= 6) return 'dueThisWeek';

    return 'dueLater';
}

function summarise(invoices) {
    return {
        count: invoices.length,
        total: round2(invoices.reduce((sum, i) => sum + i.amount, 0)),
        // Biggest first inside a band: if an owner only makes two phone
        // calls today, they should be the two that matter most.
        invoices: [...invoices].sort((a, b) => b.amount - a.amount)
    };
}

function buildInvoiceUrgency(records, { today = startOfToday() } = {}) {
    const bands = {
        atRisk: [],
        late: [],
        dueThisWeek: [],
        dueLater: [],
        undated: []
    };

    for (const record of records || []) {
        const invoice = toInvoice(record);

        if (!invoice) continue;

        const days = daysFromToday(invoice.dueDate, today);

        bands[bandOf(days, today)].push({
            ...invoice,
            daysUntilDue: days,
            daysLate: days !== null && days < 0 ? Math.abs(days) : 0,
            timing: describeTiming(days)
        });
    }

    const all = Object.values(bands).flat();

    const owed = round2(all.reduce((sum, i) => sum + i.amount, 0));

    const overdueTotal = round2(
        [...bands.atRisk, ...bands.late].reduce((sum, i) => sum + i.amount, 0)
    );

    // The single most useful number on the page: how much of what you
    // are owed is already late.
    const overdueShare = owed > 0
        ? Math.round((overdueTotal / owed) * 1000) / 10
        : 0;

    // The oldest unpaid invoice, which is usually the one worth a phone
    // call rather than another emailed reminder.
    const oldest = bands.atRisk.concat(bands.late).reduce(
        (worst, i) => (!worst || i.daysLate > worst.daysLate ? i : worst),
        null
    );

    return {
        asOf: toISODate(today),
        weekEnds: toISODate(new Date(today.getTime() + 6 * DAY_MS)),
        atRiskAfterDays: AT_RISK_DAYS,
        totalOwed: owed,
        overdueTotal,
        overdueShare,
        oldest: oldest
            ? {
                customer: oldest.customer,
                amount: oldest.amount,
                daysLate: oldest.daysLate,
                docNumber: oldest.docNumber
            }
            : null,
        atRisk: summarise(bands.atRisk),
        late: summarise(bands.late),
        dueThisWeek: summarise(bands.dueThisWeek),
        dueLater: summarise(bands.dueLater),
        undated: summarise(bands.undated)
    };
}

async function getInvoiceUrgency(connection) {
    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const invoices = await quickbooksService.getInvoices(
        accessToken,
        connection.realmId
    );

    return buildInvoiceUrgency(invoices);
}

module.exports = {
    getInvoiceUrgency,
    buildInvoiceUrgency,
    _internals: { toInvoice, bandOf, describeTiming, daysFromToday }
};
