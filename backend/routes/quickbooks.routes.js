// backend/routes/quickbooks.routes.js

const express = require('express');

const router = express.Router();

const quickbooksService =
    require('../services/quickbooks/quickbooks.service');

const supabaseService =
    require('../services/supabase/supabase.service');

const { requireOrgAccess } =
    require('../middleware/auth.middleware');

const cashProjectionService =
    require('../services/quickbooks/cash-projection.service');

const billsScheduleService =
    require('../services/quickbooks/bills-schedule.service');

// ============================================================
// HELPER
// ============================================================

async function getConnection(organizationId) {
    if (!organizationId) {
        return null;
    }

    const connection =
        await supabaseService.getQuickBooksTokens(
            organizationId
        );

    if (!connection) {
        return null;
    }

    return {
        organizationId:
            connection.organization_id,

        realmId:
            connection.realm_id,

        accessToken:
            connection.access_token,

        refreshToken:
            connection.refresh_token,

        expiresAt:
            connection.token_expires_at
                ? new Date(
                    connection.token_expires_at
                ).getTime()
                : 0,

        expiresIn: null,

        connectedAt:
            connection.created_at,

        updatedAt:
            connection.updated_at
    };
}

// ============================================================
// GET /api/quickbooks/connect-url
//
// Returns the QuickBooks authorization URL as JSON instead of
// redirecting directly, because a plain top-level navigation (the
// previous /connect behavior) can't carry an Authorization header —
// there would be no way to verify who's actually asking to connect an
// organization's QuickBooks. The frontend fetches this URL first (with
// its session token), then navigates the browser to the returned
// authUrl for the actual OAuth handoff to Intuit.
// ============================================================

router.get('/connect-url', requireOrgAccess, (req, res) => {
    try {
        const {
            organizationId
        } = req.query;

        const authUrl =
            quickbooksService.getAuthorizationUrl(
                organizationId
            );

        console.log(
            'Issuing QuickBooks authorization URL...'
        );

        res.json({ authUrl });
    } catch (error) {
        console.error(
            'Error generating QB auth URL:',
            error
        );

        res.status(500).json({
            error:
                'Failed to generate QuickBooks connection URL'
        });
    }
});

// ============================================================
// GET /api/quickbooks/callback
// ============================================================

router.get('/callback', async (req, res) => {
    const {
        code,
        realmId,
        state
    } = req.query;

    if (!code) {
        return res.status(400).json({
            error:
                'Authorization code missing'
        });
    }

    if (!realmId) {
        return res.status(400).json({
            error:
                'QuickBooks Realm ID missing'
        });
    }

    if (!state) {
        return res.status(400).json({
            error:
                'OAuth state missing'
        });
    }

    try {
        // --------------------------------------------------------
        // Verify OAuth state
        // --------------------------------------------------------

        const stateData =
            quickbooksService.verifyOAuthState(
                state
            );

        const organizationId =
            stateData.organizationId;

        console.log(
            'Organization:',
            organizationId
        );

        // --------------------------------------------------------
        // Exchange authorization code
        // --------------------------------------------------------

        console.log(
            'Exchanging QuickBooks authorization code...'
        );

        const tokens =
            await quickbooksService.exchangeCodeForTokens(
                code
            );

        if (
            !tokens ||
            !tokens.access_token
        ) {
            return res.status(500).json({
                error:
                    'QuickBooks access token was not received'
            });
        }

        // --------------------------------------------------------
        // Save connection to Supabase
        // --------------------------------------------------------

        const savedConnection =
            await supabaseService.saveQuickBooksTokens(
                organizationId,
                {
                    realm_id:
                        realmId,

                    access_token:
                        tokens.access_token,

                    refresh_token:
                        tokens.refresh_token,

                    expires_in:
                        tokens.expires_in
                }
            );

        console.log(
            'QuickBooks connection saved to Supabase'
        );

        console.log(
            'Realm ID:',
            realmId
        );

        // --------------------------------------------------------
        // Redirect back to frontend
        // --------------------------------------------------------
        const frontendUrl =
            process.env.FRONTEND_URL ||
            'http://127.0.0.1:5500';
        res.redirect(
            `${frontendUrl}/index.html?connected=true`
        );
    } catch (error) {
        console.error(
            'OAuth callback failed:',
            error.response?.data ||
            error.message
        );

        const frontendUrl =
            process.env.FRONTEND_URL ||
            'http://127.0.0.1:5500';

        res.redirect(
            `${frontendUrl}/index.html?qb_error=1`
        );
    }
});

// ============================================================
// DELETE /api/quickbooks/disconnect
//
// Unlinks whatever QuickBooks company is currently connected to this
// organization. Needed because OAuth can silently connect the wrong
// company — Intuit auto-authorizes using whatever account is already
// logged into the browser, with no confirmation step — so users need
// a way to undo that and reconnect with the right account.
// ============================================================

router.delete('/disconnect', requireOrgAccess, async (req, res) => {
    try {
        const {
            organizationId
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error: 'organizationId is required'
            });
        }

        await supabaseService.deleteQuickBooksTokens(
            organizationId
        );

        res.json({ success: true });
    } catch (error) {
        console.error(
            'Failed to disconnect QuickBooks:',
            error
        );

        res.status(500).json({
            error: 'Failed to disconnect QuickBooks'
        });
    }
});

// ============================================================
// GET /api/quickbooks/cash-projection
//
// Where the owner's cash is heading over the next N days, built from
// today's bank balance plus the due dates on their unpaid invoices and
// bills. The "safe floor" it warns against is derived from the
// business's own recent outgoings rather than a number we picked.
// ============================================================

router.get('/cash-projection', requireOrgAccess, async (req, res) => {
    try {
        const {
            organizationId,
            days
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error: 'organizationId is required'
            });
        }

        const connection =
            await getConnection(organizationId);

        if (!connection) {
            return res.status(400).json({
                error: 'QuickBooks is not connected',
                code: 'QB_NOT_CONNECTED'
            });
        }

        const horizon = Math.min(
            Math.max(parseInt(days, 10) || 30, 7),
            90
        );

        // The floor is "about a month of what you normally spend", so it
        // needs a few months of actual outgoings behind it. Each month
        // costs a P&L call, so this is deliberately just three — enough
        // to smooth out one unusual month without making the request slow.
        const accessToken =
            await quickbooksService.getValidAccessToken(connection);

        const monthlyOutflows = [];

        const now = new Date();

        for (let i = 3; i >= 1; i--) {
            const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
            const iso = d => d.toISOString().slice(0, 10);

            try {
                const report = await quickbooksService.getProfitAndLoss(
                    accessToken,
                    connection.realmId,
                    iso(start),
                    iso(end)
                );

                const parsed = quickbooksService.parseProfitAndLoss(report);

                const outgoings =
                    Number(parsed?.costOfGoodsSold || 0) +
                    Number(parsed?.expenses || 0);

                if (outgoings > 0) {
                    monthlyOutflows.push(outgoings);
                }
            } catch (monthError) {
                // A month that won't load just doesn't contribute to the
                // average — better a floor from two months than none.
                console.error(
                    'Cash projection: skipping a month of outgoings:',
                    monthError.message
                );
            }
        }

        const projection = await cashProjectionService.buildCashProjection(
            connection,
            { days: horizon, monthlyOutflows }
        );

        return res.json(projection);

    } catch (error) {
        if (error.code === 'QB_REAUTH_REQUIRED') {
            return res.status(400).json({
                error: 'Your QuickBooks connection has expired. Reconnect to keep seeing your numbers.',
                code: 'QB_REAUTH_REQUIRED'
            });
        }

        console.error(
            'Failed to build cash projection:',
            error.response?.data ||
            error.message
        );

        return res.status(500).json({
            error: 'Failed to work out your cash projection'
        });
    }
});

// ============================================================
// GET /api/quickbooks/bills-schedule
//
// Unpaid supplier bills grouped by when they fall due, so the owner can
// see what has to be paid this week separately from what can wait.
// ============================================================

router.get('/bills-schedule', requireOrgAccess, async (req, res) => {
    try {
        const { organizationId } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error: 'organizationId is required'
            });
        }

        const connection =
            await getConnection(organizationId);

        if (!connection) {
            return res.status(400).json({
                error: 'QuickBooks is not connected',
                code: 'QB_NOT_CONNECTED'
            });
        }

        const schedule =
            await billsScheduleService.getBillsSchedule(connection);

        return res.json(schedule);

    } catch (error) {
        if (error.code === 'QB_REAUTH_REQUIRED') {
            return res.status(400).json({
                error: 'Your QuickBooks connection has expired. Reconnect to keep seeing your numbers.',
                code: 'QB_REAUTH_REQUIRED'
            });
        }

        console.error(
            'Failed to load the bills schedule:',
            error.response?.data ||
            error.message
        );

        return res.status(500).json({
            error: 'Failed to load your upcoming bills'
        });
    }
});

// ============================================================
// GET /api/quickbooks/status
// ============================================================

router.get('/status', requireOrgAccess, async (req, res) => {
    try {
        const {
            organizationId
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error:
                    'organizationId is required'
            });
        }

        const connection =
            await getConnection(
                organizationId
            );

        if (!connection) {
            return res.json({
                connected: false,
                message:
                    'QuickBooks is not connected'
            });
        }

        // A saved row is not the same thing as a working connection.
        // Reporting "connected" purely because a row exists meant an
        // organization whose refresh token had been revoked still saw a
        // green badge while every data call failed, with nothing telling
        // the owner to reconnect. So the token is exercised here, and a
        // terminal auth failure is reported as needing reconnection.
        let companyName = null;

        try {
            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );

            const companyInfo =
                await quickbooksService.getCompanyInfo(
                    accessToken,
                    connection.realmId
                );

            companyName =
                companyInfo?.CompanyInfo?.CompanyName || null;
        } catch (companyError) {
            console.error(
                'Failed to verify QuickBooks connection for status:',
                companyError.response?.data ||
                companyError.message
            );

            if (companyError.code === 'QB_REAUTH_REQUIRED') {
                return res.json({
                    connected: false,
                    needsReconnect: true,
                    realmId: connection.realmId,
                    connectedAt: connection.connectedAt,
                    message:
                        'Your QuickBooks connection has expired. Reconnect to keep seeing your numbers.'
                });
            }

            // Anything else (a network blip, an Intuit outage) is
            // transient — the connection itself is still good, so don't
            // push the owner through a reconnect they don't need.
        }

        return res.json({
            connected: true,

            realmId:
                connection.realmId,

            connectedAt:
                connection.connectedAt,

            companyName
        });
    } catch (error) {
        console.error(
            'Failed to check QuickBooks status:',
            error
        );

        res.status(500).json({
            error:
                'Failed to check connection status'
        });
    }
});
router.get('/expenses', requireOrgAccess, async (req, res) => {
    try {
        const {
            organizationId
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error: 'organizationId is required'
            });
        }

        const connection =
            await getConnection(
                organizationId
            );

        if (!connection) {
            return res.status(404).json({
                error:
                    'QuickBooks is not connected'
            });
        }

        const expenses =
            await quickbooksService.getExpenseTransactions(
                connection.accessToken,
                connection.realmId
            );

        return res.json({
            expenses
        });

    } catch (error) {

        console.error(
            'Failed to fetch QuickBooks expenses:',
            error.response?.data ||
            error.message
        );

        return res.status(500).json({
            error:
                'Failed to fetch QuickBooks expenses'
        });
    }
});

router.get('/accounts-test', requireOrgAccess, async (req, res) => {
    try {

        const {
            organizationId
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error:
                    'organizationId is required'
            });
        }

        const connection =
            await getConnection(
                organizationId
            );

        if (!connection) {
            return res.status(401).json({
                error:
                    'QuickBooks is not connected'
            });
        }

        const accessToken =
            await quickbooksService.getValidAccessToken(
                connection
            );

        const data =
            await quickbooksService.makeApiRequest(
                accessToken,
                connection.realmId,
                `query?query=${encodeURIComponent(
                    "SELECT * FROM Account MAXRESULTS 1000"
                )}`
            );

        console.log(
            "QUICKBOOKS ACCOUNTS:",
            JSON.stringify(
                data,
                null,
                2
            )
        );

        return res.json({
            accounts:
                data?.QueryResponse?.Account ||
                []
        });

    } catch (error) {

        console.error(
            'Failed to fetch QuickBooks accounts:',
            error.response?.data ||
            error.message
        );

        return res.status(500).json({
            error:
                'Failed to fetch QuickBooks accounts'
        });
    }
});
router.get('/debt', requireOrgAccess, async (req, res) => {
    try {

        const {
            organizationId
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error:
                    'organizationId is required'
            });
        }

        const connection =
            await getConnection(
                organizationId
            );

        if (!connection) {
            return res.status(401).json({
                error:
                    'QuickBooks is not connected'
            });
        }

        const accessToken =
            await quickbooksService.getValidAccessToken(
                connection
            );

        const accounts =
            await quickbooksService.getAccounts(
                accessToken,
                connection.realmId
            );

        const debtAccounts =
            quickbooksService.getDebtAccounts(
                accounts
            );

        const currentDebt =
            debtAccounts
                .filter(account =>
                    account.category ===
                    "Current Debt" ||
                    account.category ===
                    "Credit Card Debt"
                )
                .reduce(
                    (total, account) =>
                        total +
                        account.balance,
                    0
                );

        const longTermDebt =
            debtAccounts
                .filter(account =>
                    account.category ===
                    "Long-Term Debt"
                )
                .reduce(
                    (total, account) =>
                        total +
                        account.balance,
                    0
                );

        const totalDebt =
            currentDebt +
            longTermDebt;

        return res.json({

            currentDebt,

            longTermDebt,

            totalDebt,

            accounts:
                debtAccounts

        });

    } catch (error) {

        console.error(
            'Failed to fetch debt:',
            error.response?.data ||
            error.message
        );

        return res.status(500).json({
            error:
                'Failed to fetch debt data'
        });
    }
});

// ============================================================
// GET /api/quickbooks/company
// ============================================================

router.get('/company', requireOrgAccess, async (req, res) => {
    try {
        const {
            organizationId
        } = req.query;

        if (!organizationId) {
            return res.status(400).json({
                error:
                    'organizationId is required'
            });
        }

        const connection =
            await getConnection(
                organizationId
            );

        if (!connection) {
            return res.status(401).json({
                error:
                    'QuickBooks is not connected'
            });
        }

        const accessToken =
            await quickbooksService.getValidAccessToken(
                connection
            );

        const companyInfo =
            await quickbooksService.getCompanyInfo(
                accessToken,
                connection.realmId
            );

        console.log(
            'CompanyInfo received from QuickBooks'
        );

        res.json(companyInfo);
    } catch (error) {
        console.error(
            'Failed to fetch company information:',
            error.response?.data ||
            error.message
        );

        res.status(500).json({
            error:
                'Failed to fetch company information'
        });
    }
});

// ============================================================
// GET /api/quickbooks/reports/profit-and-loss
// ============================================================
router.get(
    '/reports/profit-and-loss',
    requireOrgAccess,
    async (req, res) => {
        try {
            const {
                organizationId,
                startDate,
                endDate
            } = req.query;

            if (!organizationId) {
                return res.status(400).json({
                    error:
                        'organizationId is required'
                });
            }

            if (!startDate || !endDate) {
                return res.status(400).json({
                    error:
                        'startDate and endDate are required'
                });
            }

            const connection =
                await getConnection(
                    organizationId
                );

            if (!connection) {
                return res.status(401).json({
                    error:
                        'QuickBooks is not connected'
                });
            }

            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );

            const report =
                await quickbooksService.getProfitAndLoss(
                    accessToken,
                    connection.realmId,
                    startDate,
                    endDate
                );

            console.log(
                "RAW P&L REPORT:",
                JSON.stringify(report, null, 2)
            );

            const normalizedReport =
            quickbooksService.parseProfitAndLoss(
                report
            );
            console.log(
                "NORMALIZED P&L:",
                normalizedReport
            );
            return res.json(normalizedReport);

        } catch (error) {

            console.error(
                'Failed to fetch Profit & Loss:',
                error.response?.data ||
                error.message
            );

            return res.status(500).json({
                error:
                    'Failed to fetch Profit & Loss'
            });
        }
    }
);

// ============================================================
// GET /api/quickbooks/reports/balance-sheet
// ============================================================

router.get(
    '/reports/balance-sheet',
    requireOrgAccess,
    async (req, res) => {
        try {
            const {
                organizationId,
                startDate
            } = req.query;

            if (!organizationId) {
                return res.status(400).json({
                    error:
                        'organizationId is required'
                });
            }

            if (!startDate) {
                return res.status(400).json({
                    error:
                        'startDate is required',

                    example:
                        '/api/quickbooks/reports/balance-sheet?organizationId=YOUR_ORG_ID&startDate=2026-08-20'
                });
            }

            const connection =
                await getConnection(
                    organizationId
                );

            if (!connection) {
                return res.status(401).json({
                    error:
                        'QuickBooks is not connected'
                });
            }

            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );

            const report =
                await quickbooksService.getBalanceSheet(
                    accessToken,
                    connection.realmId,
                    startDate
                );

            const normalizedReport =
                quickbooksService.parseBalanceSheet(
                    report
                );

            res.json(normalizedReport);
        } catch (error) {
            console.error(
                'Failed to fetch Balance Sheet:',
                error.response?.data ||
                error.message
            );

            res.status(500).json({
                error:
                    'Failed to fetch Balance Sheet'
            });
        }
    }
);

// ============================================================
// GET /api/quickbooks/reports/cash-flow
// ============================================================

router.get(
    '/reports/cash-flow',
    requireOrgAccess,
    async (req, res) => {
        try {
            const {
                organizationId,
                startDate,
                endDate
            } = req.query;

            if (!organizationId) {
                return res.status(400).json({
                    error:
                        'organizationId is required'
                });
            }

            if (!startDate || !endDate) {
                return res.status(400).json({
                    error:
                        'startDate and endDate are required',

                    example:
                        '/api/quickbooks/reports/cash-flow?organizationId=YOUR_ORG_ID&startDate=2026-01-01&endDate=2026-08-20'
                });
            }

            const connection =
                await getConnection(
                    organizationId
                );

            if (!connection) {
                return res.status(401).json({
                    error:
                        'QuickBooks is not connected'
                });
            }

            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );

            const report =
                await quickbooksService.getCashFlow(
                    accessToken,
                    connection.realmId,
                    startDate,
                    endDate
                );

            const normalizedReport =
                quickbooksService.parseCashFlow(
                    report
                );

            // parseCashFlow reads the real "Cash at beginning of period"
            // figure straight from QuickBooks' own report — matches the
            // sandbox exactly. Only fall back to estimating it from the
            // prior day's Balance Sheet if that row wasn't present.
            if (!normalizedReport.openingCash) {
                const openingCash =
                    await quickbooksService.getOpeningCashBalance(
                        accessToken,
                        connection.realmId,
                        startDate
                    );

                normalizedReport.openingCash =
                    openingCash.amount;

                normalizedReport.openingCashDate =
                    openingCash.date;
            }

            normalizedReport.closingCash =
                normalizedReport.endingCash;

                console.log(
            "FINAL Cash Flow Opening Cash:",
            normalizedReport.openingCash
        );
        
        console.log(
            "FINAL Cash Flow Closing Cash:",
            normalizedReport.closingCash
        );

            res.json(normalizedReport);
        } catch (error) {
            console.error(
                'Failed to fetch Cash Flow:',
                error.response?.data ||
                error.message
            );

            res.status(500).json({
                error:
                    'Failed to fetch Cash Flow'
            });
        }
    }
);

// ============================================================
// GET /api/quickbooks/reports/accounts-receivable
// ============================================================

router.get(
    '/reports/accounts-receivable',
    requireOrgAccess,
    async (req, res) => {
        try {
            const {
                organizationId,
                startDate
            } = req.query;

            if (!organizationId) {
                return res.status(400).json({
                    error:
                        'organizationId is required'
                });
            }

            if (!startDate) {
                return res.status(400).json({
                    error:
                        'startDate is required'
                });
            }

            const connection =
                await getConnection(
                    organizationId
                );

            if (!connection) {
                return res.status(401).json({
                    error:
                        'QuickBooks is not connected'
                });
            }

            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );

            const report =
                await quickbooksService.getAccountsReceivable(
                    accessToken,
                    connection.realmId,
                    startDate
                );
            console.log(
                " RAW AR REPORT:",
                JSON.stringify(report, null, 2)
            );

            const normalizedReport =
                quickbooksService.parseAccountsReceivable(
                    report
                );

            res.json(normalizedReport);

        } catch (error) {

            console.error(
                'Failed to fetch Accounts Receivable:',
                error.response?.data ||
                error.message
            );

            res.status(500).json({
                error:
                    'Failed to fetch Accounts Receivable'
            });
        }
    }
);
router.get(
    '/reports/accounts-payable',
    requireOrgAccess,
    async (req, res) => {

        try {

            const {
                organizationId,
                startDate
            } = req.query;


            console.log(
                "AP REQUEST:",
                {
                    organizationId,
                    startDate
                }
            );


            if (!organizationId) {

                return res.status(400).json({
                    error:
                        'organizationId is required'
                });

            }


            if (!startDate) {

                return res.status(400).json({
                    error:
                        'startDate is required'
                });

            }


            const connection =
                await getConnection(
                    organizationId
                );


            console.log(
                "AP CONNECTION:",
                !!connection
            );


            if (!connection) {

                return res.status(401).json({
                    error:
                        'QuickBooks is not connected'
                });

            }


            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );


            console.log(
                "AP ACCESS TOKEN:",
                !!accessToken
            );


            console.log(
                "Calling QuickBooks AgedPayables..."
            );


            const report =
                await quickbooksService.getAccountsPayable(
                    accessToken,
                    connection.realmId,
                    startDate
                );


            console.log(
                "RAW AP REPORT:",
                JSON.stringify(
                    report,
                    null,
                    2
                )
            );


            const normalizedReport =
                quickbooksService.parseAccountsPayable(
                    report
                );


            console.log(
                "NORMALIZED AP:",
                normalizedReport
            );


            return res.json(
                normalizedReport
            );


        } catch (error) {

            console.error(
                'FAILED TO FETCH ACCOUNTS PAYABLE:',
                error.response?.data ||
                error.message
            );


            console.error(
                'FULL ERROR:',
                error
            );


            return res.status(500).json({
                error:
                    'Failed to fetch Accounts Payable'
            });

        }

    }
);
router.get(
    '/invoices',
    requireOrgAccess,
    async (req, res) => {

        try {

            const {
                organizationId
            } = req.query;

            if (!organizationId) {
                return res.status(400).json({
                    error:
                        'organizationId is required'
                });
            }

            const connection =
                await getConnection(
                    organizationId
                );

            if (!connection) {
                return res.status(401).json({
                    error:
                        'QuickBooks is not connected'
                });
            }

            const accessToken =
                await quickbooksService.getValidAccessToken(
                    connection
                );

            const invoices =
                await quickbooksService.getInvoices(
                    accessToken,
                    connection.realmId
                );

            console.log(
                "RAW INVOICES:",
                JSON.stringify(
                    invoices,
                    null,
                    2
                )
            );

            res.json({
                invoices
            });

        } catch (error) {

            console.error(
                'Failed to fetch invoices:',
                error.response?.data ||
                error.message
            );

            res.status(500).json({
                error:
                    'Failed to fetch invoices'
            });
        }
    }
);

// ============================================================
// EXPORT
// ============================================================

module.exports = router;