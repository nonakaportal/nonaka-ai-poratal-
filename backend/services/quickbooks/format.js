// backend/services/quickbooks/format.js
//
// Some of the plain-English sentences these services produce name real
// amounts and dates. Those have to read like money and like dates, not
// like raw fields — "755" and "2026-07-04" in the middle of a sentence
// look like a bug to the person reading it.
//
// This portal serves many businesses, and their QuickBooks companies do
// not all keep books in dollars, so nothing here assumes a currency.
// Every caller passes the one its own report reported.

function money(currency = 'USD', { decimals = 2 } = {}) {
    let format;

    try {
        format = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        }).format;
    } catch {
        // An unrecognised currency code should degrade, not throw: the
        // figure still has to reach the owner.
        format = n => `${Number(n).toFixed(decimals)} ${currency}`;
    }

    return n => format(Number(n || 0));
}

// "4 July 2026" rather than "2026-07-04". Parsed as UTC because these
// dates are calendar days from QuickBooks, not instants, and letting
// the server's timezone shift them would move a due date by a day.
function longDate(iso) {
    if (!iso) return '';

    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);

    if (Number.isNaN(d.getTime())) return String(iso);

    return d.toLocaleDateString('en-US', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

// Shared by the services: amounts to the cent, and calendar days in UTC
// (QuickBooks dates are days, not instants).
function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function toISODate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

function startOfToday() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

module.exports = { money, longDate, round2, toISODate, startOfToday };
