// backend/routes/quickbooks.routes.js
//
// QuickBooks integration routes. Every data route is read-only and scoped
// to one organization by requireOrgAccess.
//
//   GET    /connect-url                   OAuth authorization URL
//   GET    /callback                      OAuth callback from Intuit
//   DELETE /disconnect                    Unlink the connected company
//   GET    /status                        Connection state + company name
//   GET    /cash-projection               Bank balance over the next 7-90 days
//   GET    /cash-history                  Month-end bank balance, last 12 months
//   GET    /bills-schedule                Unpaid bills grouped by due date
//   GET    /money-flow                    Where money came from / went
//   GET    /cash-cushion                  Bank balance under Scenarios assumptions
//   GET    /debt-detail                   Loans and cards with payment history
//   GET    /invoice-urgency               Unpaid invoices by how urgent they are
//   GET    /pl-story                      Profit & Loss as a sequence of steps
//   GET    /balance-questions             Balance sheet as three questions
//   GET    /ratio-questions               Ratios as the questions they answer
//   GET    /debt                          Debt totals for the Overview card
//   GET    /invoices                      Every invoice, for the Invoices page
//   GET    /reports/profit-and-loss       Parsed P&L
//   GET    /reports/balance-sheet         Parsed Balance Sheet
//   GET    /reports/cash-flow             Parsed Cash Flow
//   GET    /reports/accounts-receivable   Parsed AR aging
//   GET    /reports/accounts-payable      Parsed AP aging

const express = require('express');

const router = express.Router();

const quickbooksService = require('../services/quickbooks/quickbooks.service');
const supabaseService = require('../services/supabase/supabase.service');
const { requireOrgAccess } = require('../middleware/auth.middleware');

const cashProjectionService = require('../services/quickbooks/cash-projection.service');
const billsScheduleService = require('../services/quickbooks/bills-schedule.service');
const moneyFlowService = require('../services/quickbooks/money-flow.service');
const cashCushionService = require('../services/quickbooks/cash-cushion.service');
const debtDetailService = require('../services/quickbooks/debt-detail.service');
const invoiceUrgencyService = require('../services/quickbooks/invoice-urgency.service');
const plStoryService = require('../services/quickbooks/pl-story.service');
const balanceQuestionsService = require('../services/quickbooks/balance-questions.service');
const ratioQuestionsService = require('../services/quickbooks/ratio-questions.service');
const financialContext = require('../services/ai/financial-context.service');
const aiRoutes = require('./ai');

const REAUTH_MESSAGE =
    'Your QuickBooks connection has expired. Reconnect to keep seeing your numbers.';

function frontendUrl() {
    return process.env.FRONTEND_URL || 'http://127.0.0.1:5500';
}

async function getConnection(organizationId) {
    const connection = await supabaseService.getQuickBooksTokens(organizationId);

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
            : 0,
        connectedAt: connection.created_at
    };
}

// Answers cached per organization would otherwise keep describing the
// previous QuickBooks company for a few minutes after it is swapped for
// another — the exact situation the disconnect button exists to fix.
function forgetOrganizationCaches(organizationId) {
    aiRoutes.forgetOrganization(organizationId);
    financialContext.forgetOrganization(organizationId);
    cashCushionService.forgetOrganization(organizationId);
}

// Rejects a request missing any of the named YYYY-MM-DD query parameters
// before it costs a QuickBooks call.
function requireDates(...names) {
    return (req, res, next) => {
        const missing = names.filter(name => !req.query[name]);

        if (missing.length) {
            return res.status(400).json({
                error: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required`
            });
        }

        const malformed = names.filter(
            name => !/^\d{4}-\d{2}-\d{2}$/.test(String(req.query[name]))
        );

        if (malformed.length) {
            return res.status(400).json({
                error: `${malformed.join(' and ')} must be a date in YYYY-MM-DD format`
            });
        }

        next();
    };
}

// Every data route has the same edges: no connection saved, a connection
// QuickBooks will no longer refresh, and an unexpected failure that must
// not leak internals. `load` only has to produce the response body.
function qbRoute(failMessage, load) {
    return async (req, res) => {
        try {
            const connection = await getConnection(req.organizationId);

            if (!connection) {
                return res.status(400).json({
                    error: 'QuickBooks is not connected',
                    code: 'QB_NOT_CONNECTED'
                });
            }

            return res.json(await load(connection, req.query));
        } catch (error) {
            if (error.code === 'QB_REAUTH_REQUIRED') {
                return res.status(400).json({
                    error: REAUTH_MESSAGE,
                    code: 'QB_REAUTH_REQUIRED'
                });
            }

            console.error(`${failMessage}:`, error.response?.data || error.message);

            return res.status(500).json({ error: failMessage });
        }
    };
}

// ============================================================
// OAUTH
//
// /connect-url returns the authorization URL as JSON instead of
// redirecting, because a top-level navigation can't carry the
// Authorization header needed to verify who is connecting. The frontend
// fetches this with its session, then navigates to the returned URL.
// ============================================================

router.get('/connect-url', requireOrgAccess, (req, res) => {
    try {
        const authUrl = quickbooksService.getAuthorizationUrl(req.organizationId);

        res.json({ authUrl });
    } catch (error) {
        console.error('Error generating QB auth URL:', error.message);

        res.status(500).json({
            error: 'Failed to generate QuickBooks connection URL'
        });
    }
});

router.get('/callback', async (req, res) => {
    const { code, realmId, state } = req.query;

    if (!code) {
        return res.status(400).json({ error: 'Authorization code missing' });
    }

    if (!realmId) {
        return res.status(400).json({ error: 'QuickBooks Realm ID missing' });
    }

    if (!state) {
        return res.status(400).json({ error: 'OAuth state missing' });
    }

    try {
        const { organizationId } = quickbooksService.verifyOAuthState(state);

        const tokens = await quickbooksService.exchangeCodeForTokens(code);

        if (!tokens?.access_token) {
            return res.status(500).json({
                error: 'QuickBooks access token was not received'
            });
        }

        await supabaseService.saveQuickBooksTokens(organizationId, {
            realm_id: realmId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in
        });

        forgetOrganizationCaches(organizationId);

        res.redirect(`${frontendUrl()}/index.html?connected=true`);
    } catch (error) {
        console.error('OAuth callback failed:', error.response?.data || error.message);

        res.redirect(`${frontendUrl()}/index.html?qb_error=1`);
    }
});

// Intuit can silently authorize whatever company is already signed in to
// the browser, so the owner needs a way to undo a wrong connection.
router.delete('/disconnect', requireOrgAccess, async (req, res) => {
    try {
        await supabaseService.deleteQuickBooksTokens(req.organizationId);

        forgetOrganizationCaches(req.organizationId);

        res.json({ success: true });
    } catch (error) {
        console.error('Failed to disconnect QuickBooks:', error.message);

        res.status(500).json({ error: 'Failed to disconnect QuickBooks' });
    }
});

// ============================================================
// GET /status
//
// A saved row is not the same thing as a working connection, so the token
// is exercised here. A terminal auth failure is reported as needing
// reconnection; anything transient (a network blip, an Intuit outage)
// still reports connected, so the owner isn't sent through a reconnect
// they don't need.
// ============================================================

router.get('/status', requireOrgAccess, async (req, res) => {
    try {
        const connection = await getConnection(req.organizationId);

        if (!connection) {
            return res.json({
                connected: false,
                message: 'QuickBooks is not connected'
            });
        }

        let companyName = null;

        try {
            const accessToken = await quickbooksService.getValidAccessToken(connection);
            const companyInfo = await quickbooksService.getCompanyInfo(accessToken, connection.realmId);

            companyName = companyInfo?.CompanyInfo?.CompanyName || null;
        } catch (companyError) {
            if (companyError.code === 'QB_REAUTH_REQUIRED') {
                return res.json({
                    connected: false,
                    needsReconnect: true,
                    realmId: connection.realmId,
                    connectedAt: connection.connectedAt,
                    message: REAUTH_MESSAGE
                });
            }

            console.error(
                'Failed to verify QuickBooks connection for status:',
                companyError.response?.data || companyError.message
            );
        }

        return res.json({
            connected: true,
            realmId: connection.realmId,
            connectedAt: connection.connectedAt,
            companyName
        });
    } catch (error) {
        console.error('Failed to check QuickBooks status:', error.message);

        res.status(500).json({ error: 'Failed to check connection status' });
    }
});

// ============================================================
// OWNER-FACING VIEWS
// ============================================================

// Where the cash is heading over the next N days. The "safe floor" it
// warns against is about a month of the business's own recent outgoings,
// so it needs a few months of P&L behind it — three is enough to smooth
// out one unusual month without making the request slow.
router.get(
    '/cash-projection',
    requireOrgAccess,
    qbRoute('Failed to work out your cash projection', async (connection, query) => {
        const days = Math.min(Math.max(parseInt(query.days, 10) || 30, 7), 90);

        const accessToken = await quickbooksService.getValidAccessToken(connection);

        const now = new Date();
        const iso = d => d.toISOString().slice(0, 10);

        const outgoings = await Promise.all(
            [3, 2, 1].map(async i => {
                const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

                try {
                    const parsed = quickbooksService.parseProfitAndLoss(
                        await quickbooksService.getProfitAndLoss(
                            accessToken,
                            connection.realmId,
                            iso(start),
                            iso(end)
                        )
                    );

                    return Number(parsed?.costOfGoodsSold || 0) + Number(parsed?.expenses || 0);
                } catch (monthError) {
                    // A month that won't load just doesn't contribute to
                    // the average — better a floor from two months than none.
                    console.error(
                        'Cash projection: skipping a month of outgoings:',
                        monthError.message
                    );

                    return 0;
                }
            })
        );

        return cashProjectionService.buildCashProjection(connection, {
            days,
            monthlyOutflows: outgoings.filter(v => v > 0)
        });
    })
);

// Month-end bank balance over the last year, for the line under the cash
// figure on the Overview.
router.get(
    '/cash-history',
    requireOrgAccess,
    qbRoute('Failed to load your cash history', async connection => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        return quickbooksService.getCashHistory(accessToken, connection.realmId, 12);
    })
);

router.get(
    '/bills-schedule',
    requireOrgAccess,
    qbRoute('Failed to load your upcoming bills', connection =>
        billsScheduleService.getBillsSchedule(connection)
    )
);

router.get(
    '/money-flow',
    requireOrgAccess,
    requireDates('startDate', 'endDate'),
    qbRoute('Failed to work out where your money went', (connection, { startDate, endDate }) =>
        moneyFlowService.getMoneyFlow(connection, { startDate, endDate })
    )
);

// Called as the Scenarios sliders move; the baseline behind it is cached
// per organization inside the service.
router.get(
    '/cash-cushion',
    requireOrgAccess,
    qbRoute('Failed to estimate your bank balance', (connection, query) =>
        cashCushionService.getCashCushion(connection, {
            months: Number(query.months),
            revGrowth: Number(query.revGrowth),
            cogsGrowth: Number(query.cogsGrowth),
            opexGrowth: Number(query.opexGrowth),
            taxRate: Number(query.taxRate)
        })
    )
);

router.get(
    '/debt-detail',
    requireOrgAccess,
    qbRoute('Failed to load your loans and cards', connection =>
        debtDetailService.getDebtDetail(connection)
    )
);

router.get(
    '/invoice-urgency',
    requireOrgAccess,
    qbRoute('Failed to load who owes you', connection =>
        invoiceUrgencyService.getInvoiceUrgency(connection)
    )
);

router.get(
    '/pl-story',
    requireOrgAccess,
    requireDates('startDate', 'endDate'),
    qbRoute('Failed to work out where your profit went', (connection, { startDate, endDate }) =>
        plStoryService.getPLStory(connection, { startDate, endDate })
    )
);

router.get(
    '/balance-questions',
    requireOrgAccess,
    qbRoute('Failed to read your balance sheet', (connection, { asOf }) =>
        balanceQuestionsService.getBalanceQuestions(connection, {
            asOf: /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))
                ? asOf
                : new Date().toISOString().slice(0, 10)
        })
    )
);

router.get(
    '/ratio-questions',
    requireOrgAccess,
    requireDates('startDate', 'endDate'),
    qbRoute('Failed to work out your health checks', (connection, { startDate, endDate }) =>
        ratioQuestionsService.getRatioQuestions(connection, { startDate, endDate })
    )
);

router.get(
    '/debt',
    requireOrgAccess,
    qbRoute('Failed to fetch debt data', async connection => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        const debtAccounts = quickbooksService.getDebtAccounts(
            await quickbooksService.getAccounts(accessToken, connection.realmId)
        );

        const sumOf = categories =>
            debtAccounts
                .filter(account => categories.includes(account.category))
                .reduce((total, account) => total + account.balance, 0);

        const currentDebt = sumOf(['Current Debt', 'Credit Card Debt']);
        const longTermDebt = sumOf(['Long-Term Debt']);

        return {
            currentDebt,
            longTermDebt,
            totalDebt: currentDebt + longTermDebt,
            accounts: debtAccounts
        };
    })
);

router.get(
    '/invoices',
    requireOrgAccess,
    qbRoute('Failed to fetch invoices', async connection => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        return {
            invoices: await quickbooksService.getInvoices(accessToken, connection.realmId)
        };
    })
);

// ============================================================
// PARSED REPORTS
// ============================================================

router.get(
    '/reports/profit-and-loss',
    requireOrgAccess,
    requireDates('startDate', 'endDate'),
    qbRoute('Failed to fetch Profit & Loss', async (connection, { startDate, endDate }) => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        return quickbooksService.parseProfitAndLoss(
            await quickbooksService.getProfitAndLoss(accessToken, connection.realmId, startDate, endDate)
        );
    })
);

router.get(
    '/reports/balance-sheet',
    requireOrgAccess,
    requireDates('startDate'),
    qbRoute('Failed to fetch Balance Sheet', async (connection, { startDate }) => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        return quickbooksService.parseBalanceSheet(
            await quickbooksService.getBalanceSheet(accessToken, connection.realmId, startDate)
        );
    })
);

router.get(
    '/reports/cash-flow',
    requireOrgAccess,
    requireDates('startDate', 'endDate'),
    qbRoute('Failed to fetch Cash Flow', async (connection, { startDate, endDate }) => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        const report = quickbooksService.parseCashFlow(
            await quickbooksService.getCashFlow(accessToken, connection.realmId, startDate, endDate)
        );

        // parseCashFlow reads the real "Cash at beginning of period" row
        // from QuickBooks' own report. Only estimate it from the prior
        // day's Balance Sheet if that row wasn't present.
        if (!report.openingCash) {
            const openingCash = await quickbooksService.getOpeningCashBalance(
                accessToken,
                connection.realmId,
                startDate
            );

            report.openingCash = openingCash.amount;
            report.openingCashDate = openingCash.date;
        }

        report.closingCash = report.endingCash;

        return report;
    })
);

router.get(
    '/reports/accounts-receivable',
    requireOrgAccess,
    requireDates('startDate'),
    qbRoute('Failed to fetch Accounts Receivable', async (connection, { startDate }) => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        return quickbooksService.parseAccountsReceivable(
            await quickbooksService.getAccountsReceivable(accessToken, connection.realmId, startDate)
        );
    })
);

router.get(
    '/reports/accounts-payable',
    requireOrgAccess,
    requireDates('startDate'),
    qbRoute('Failed to fetch Accounts Payable', async (connection, { startDate }) => {
        const accessToken = await quickbooksService.getValidAccessToken(connection);

        return quickbooksService.parseAccountsPayable(
            await quickbooksService.getAccountsPayable(accessToken, connection.realmId, startDate)
        );
    })
);

module.exports = router;
