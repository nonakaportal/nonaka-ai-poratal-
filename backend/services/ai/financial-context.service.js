// backend/services/ai/financial-context.service.js
//
// Builds the real, QuickBooks-derived data that gets fed to Claude for
// forecasts, anomaly detection, recommendations, and chat. Every figure
// here traces back to an actual QuickBooks report — nothing is invented.

const quickbooksService = require('../quickbooks/quickbooks.service');
const supabaseService = require('../supabase/supabase.service');

async function getConnection(organizationId) {
    const connection =
        await supabaseService.getQuickBooksTokens(organizationId);

    if (!connection) {
        return null;
    }

    return {
        organizationId: connection.organization_id,
        realmId: connection.realm_id,
        accessToken: connection.access_token,
        refreshToken: connection.refresh_token,
        expiresAt: connection.token_expires_at
            ? new Date(connection.token_expires_at).getTime()
            : 0
    };
}

function getMonthlyPeriods(count) {
    const periods = [];
    const now = new Date();

    for (let i = count - 1; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);

        const end =
            i === 0
                ? now
                : new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

        const toISO = d => d.toISOString().slice(0, 10);

        periods.push({
            startDate: toISO(start),
            endDate: toISO(end),
            label: start.toLocaleDateString('en-US', {
                month: 'short',
                year: '2-digit'
            })
        });
    }

    return periods;
}

// ============================================================
// Compact summaries — trimmed to what actually matters for AI
// reasoning, so prompts stay focused and token-efficient rather
// than dumping every raw QuickBooks field.
// ============================================================

function summarizeAccounts(accounts, limit = 8) {
    return [...accounts]
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, limit)
        .map(a => ({
            name: a.name,
            group: a._group || null,
            amount: Number(a.amount.toFixed(2))
        }));
}

function summarizePL(pl) {
    if (!pl) return null;

    return {
        period: pl.period,
        revenue: pl.income,
        costOfGoodsSold: pl.costOfGoodsSold,
        grossProfit: pl.grossProfit,
        operatingExpenses: pl.expenses,
        netOperatingIncome: pl.netOperatingIncome,
        netIncome: pl.netIncome,
        topIncomeAccounts: summarizeAccounts(pl.accounts?.income || []),
        topExpenseAccounts: summarizeAccounts(pl.accounts?.expenses || [])
    };
}

function summarizeBS(bs) {
    if (!bs) return null;

    return {
        period: bs.period,
        totalAssets: bs.totalAssets,
        totalLiabilities: bs.totalLiabilities,
        totalEquity: bs.totalEquity,
        isBalanced: bs.isBalanced
    };
}

function summarizeCF(cf) {
    if (!cf) return null;

    return {
        period: cf.period,
        operatingActivities: cf.operatingActivities,
        investingActivities: cf.investingActivities,
        financingActivities: cf.financingActivities,
        closingCash: cf.closingCash
    };
}

function summarizeAR(ar) {
    if (!ar) return null;

    return {
        total: ar.total,
        aging: ar.aging,
        topCustomersByBalance: [...(ar.customers || [])]
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 5)
            .map(c => ({ name: c.name, amount: c.amount, over90: c.over90 }))
    };
}

function summarizeAP(ap) {
    if (!ap) return null;

    return {
        total: ap.total,
        aging: ap.aging,
        topVendorsByBalance: [...(ap.vendors || [])]
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 5)
            .map(v => ({ name: v.name, amount: v.amount, over90: v.over90 }))
    };
}

function summarizeDebt(debtAccounts) {
    return (debtAccounts || []).map(d => ({
        name: d.name,
        category: d.category,
        balance: d.balance
    }));
}

// ============================================================
// SHORT-LIVED CACHE
//
// The Overview fires Anomalies, Recommendations, and the Health Score
// as 3 near-simultaneous requests. Without this, each one independently
// re-fetches the same snapshot/trend from QuickBooks — tripling the
// concurrent load and making the sandbox's 429 rate limit far more
// likely. In-flight requests are also shared, not just completed ones,
// so 3 requests landing at once trigger exactly one QuickBooks fetch.
// ============================================================

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function withCache(key, factory) {
    const cached = cache.get(key);

    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
        return cached.promise;
    }

    const promise = factory().catch(error => {
        cache.delete(key);
        throw error;
    });

    cache.set(key, { promise, time: Date.now() });

    return promise;
}

// ============================================================
// PUBLIC
// ============================================================

async function buildFinancialSnapshotUncached(organizationId) {
    const connection = await getConnection(organizationId);

    if (!connection) {
        throw new Error('QuickBooks is not connected');
    }

    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const realmId = connection.realmId;

    const today = new Date();
    const yearStart = `${today.getFullYear()}-01-01`;
    const todayStr = today.toISOString().slice(0, 10);

    const [
        plReport,
        bsReport,
        cfReport,
        arReport,
        apReport,
        accounts
    ] = await Promise.all([
        quickbooksService.getProfitAndLoss(accessToken, realmId, yearStart, todayStr),
        quickbooksService.getBalanceSheet(accessToken, realmId, todayStr),
        quickbooksService.getCashFlow(accessToken, realmId, yearStart, todayStr),
        quickbooksService.getAccountsReceivable(accessToken, realmId, todayStr),
        quickbooksService.getAccountsPayable(accessToken, realmId, todayStr),
        quickbooksService.getAccounts(accessToken, realmId)
    ]);

    const pl = quickbooksService.parseProfitAndLoss(plReport);
    const bs = quickbooksService.parseBalanceSheet(bsReport);
    const cf = quickbooksService.parseCashFlow(cfReport);
    const ar = quickbooksService.parseAccountsReceivable(arReport);
    const ap = quickbooksService.parseAccountsPayable(apReport);
    const debtAccounts = quickbooksService.getDebtAccounts(accounts);

    return {
        asOf: todayStr,
        profitAndLoss: summarizePL(pl),
        balanceSheet: summarizeBS(bs),
        cashFlow: summarizeCF(cf),
        accountsReceivable: summarizeAR(ar),
        accountsPayable: summarizeAP(ap),
        debt: summarizeDebt(debtAccounts)
    };
}

async function buildMonthlyTrendUncached(organizationId, months = 6) {
    const connection = await getConnection(organizationId);

    if (!connection) {
        throw new Error('QuickBooks is not connected');
    }

    const accessToken =
        await quickbooksService.getValidAccessToken(connection);

    const realmId = connection.realmId;
    const periods = getMonthlyPeriods(months);

    // Fetching all N periods concurrently (N x 2 requests at once) trips
    // QuickBooks' sandbox rate limit (429). Fetch one period at a time
    // instead — slower, but reliable. Within a period, P&L + Balance
    // Sheet (2 requests) still run together, that's not the problem.
    const results = [];

    for (const period of periods) {
        const [plReport, bsReport] = await Promise.all([
            quickbooksService
                .getProfitAndLoss(accessToken, realmId, period.startDate, period.endDate)
                .catch(() => null),
            quickbooksService
                .getBalanceSheet(accessToken, realmId, period.endDate)
                .catch(() => null)
        ]);

        const pl = plReport ? quickbooksService.parseProfitAndLoss(plReport) : null;
        const bs = bsReport ? quickbooksService.parseBalanceSheet(bsReport) : null;

        results.push({
            label: period.label,
            startDate: period.startDate,
            endDate: period.endDate,
            revenue: pl?.income ?? null,
            grossProfit: pl?.grossProfit ?? null,
            operatingExpenses: pl?.expenses ?? null,
            netIncome: pl?.netIncome ?? null,
            totalAssets: bs?.totalAssets ?? null,
            totalLiabilities: bs?.totalLiabilities ?? null
        });
    }

    return results;
}

function buildFinancialSnapshot(organizationId) {
    return withCache(
        `snapshot:${organizationId}`,
        () => buildFinancialSnapshotUncached(organizationId)
    );
}

function buildMonthlyTrend(organizationId, months = 6) {
    return withCache(
        `trend:${organizationId}:${months}`,
        () => buildMonthlyTrendUncached(organizationId, months)
    );
}

// Called when an organization's QuickBooks company is connected or
// removed, so nothing cached describes the previous company.
function forgetOrganization(organizationId) {
    cache.delete(`snapshot:${organizationId}`);

    for (const key of cache.keys()) {
        if (key.startsWith(`trend:${organizationId}:`)) {
            cache.delete(key);
        }
    }
}

module.exports = {
    buildFinancialSnapshot,
    buildMonthlyTrend,
    forgetOrganization
};
