// backend/services/quickbooks/quickbooks.service.js

const axios = require('axios');
const crypto = require('crypto');

const supabaseService = require('../supabase/supabase.service');

class QuickBooksService {
    constructor() {
        this.clientId = process.env.QB_CLIENT_ID;
        this.clientSecret = process.env.QB_CLIENT_SECRET;
        this.redirectUri = process.env.QB_REDIRECT_URI;
        this.environment = process.env.QB_ENVIRONMENT || 'sandbox';

        this.baseUrl =
            this.environment === 'production'
                ? 'https://quickbooks.api.intuit.com'
                : 'https://sandbox-quickbooks.api.intuit.com';

        this.oauthBaseUrl =
            'https://appcenter.intuit.com/connect/oauth2';

        this.tokenUrl =
            'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

        // QuickBooks invalidates a refresh token the moment a new one
        // is issued, so concurrent requests for the same organization
        // must share a single in-flight refresh instead of each
        // racing to redeem the same refresh token.
        this._refreshPromises = new Map();

        console.log('QuickBooks service initialized');
    }

    // ==========================================================
    // OAUTH STATE
    // ==========================================================

    createOAuthState(organizationId) {
        if (!organizationId) {
            throw new Error('Organization ID is required');
        }

        const payload = JSON.stringify({
            organizationId,
            timestamp: Date.now()
        });

        const encodedPayload = Buffer
            .from(payload)
            .toString('base64url');

        const signature = crypto
            .createHmac('sha256', this.clientSecret)
            .update(encodedPayload)
            .digest('base64url');

        return `${encodedPayload}.${signature}`;
    }

    verifyOAuthState(state) {
        if (!state || !this.clientSecret) {
            throw new Error('Invalid OAuth state');
        }

        const parts = state.split('.');

        if (parts.length !== 2) {
            throw new Error('Invalid OAuth state format');
        }

        const [encodedPayload, signature] = parts;

        const expectedSignature = crypto
            .createHmac('sha256', this.clientSecret)
            .update(encodedPayload)
            .digest('base64url');

        const validSignature = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );

        if (!validSignature) {
            throw new Error('Invalid OAuth state signature');
        }

        const payload = JSON.parse(
            Buffer
                .from(encodedPayload, 'base64url')
                .toString('utf8')
        );

        // State expires after 10 minutes.
        if (
            !payload.timestamp ||
            Date.now() - payload.timestamp > 10 * 60 * 1000
        ) {
            throw new Error('OAuth state has expired');
        }

        if (!payload.organizationId) {
            throw new Error('Organization ID missing from OAuth state');
        }

        return payload;
    }

    getAuthorizationUrl(organizationId) {
        const state = this.createOAuthState(
            organizationId
        );

        const params = new URLSearchParams({
            client_id: this.clientId,
            response_type: 'code',
            redirect_uri: this.redirectUri,
            scope: 'com.intuit.quickbooks.accounting',
            state
        });

        return `${this.oauthBaseUrl}?${params.toString()}`;
    }

    // ==========================================================
    // OAUTH TOKEN EXCHANGE
    // ==========================================================

    async exchangeCodeForTokens(code) {
        try {
            const response = await axios.post(
                this.tokenUrl,

                new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: this.redirectUri
                }),

                {
                    headers: {
                        Authorization:
                            'Basic ' +
                            Buffer
                                .from(
                                    `${this.clientId}:${this.clientSecret}`
                                )
                                .toString('base64'),

                        Accept: 'application/json',

                        'Content-Type':
                            'application/x-www-form-urlencoded'
                    }
                }
            );

            return response.data;
        } catch (error) {
            console.error(
                'Error exchanging code for tokens:',
                error.response?.data || error.message
            );

            throw error;
        }
    }

    // ==========================================================
    // REFRESH ACCESS TOKEN
    // ==========================================================

    async refreshAccessToken(refreshToken) {
        try {
            const response = await axios.post(
                this.tokenUrl,

                new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken
                }),

                {
                    headers: {
                        Authorization:
                            'Basic ' +
                            Buffer
                                .from(
                                    `${this.clientId}:${this.clientSecret}`
                                )
                                .toString('base64'),

                        Accept: 'application/json',

                        'Content-Type':
                            'application/x-www-form-urlencoded'
                    }
                }
            );

            return response.data;
        } catch (error) {
            console.error(
                'Error refreshing access token:',
                error.response?.data || error.message
            );

            throw error;
        }
    }

    // ==========================================================
    // GET VALID ACCESS TOKEN
    // ==========================================================

    async getValidAccessToken(connection) {
        if (!connection) {
            throw new Error(
                'QuickBooks connection not found'
            );
        }

        const expiresAt =
            connection.expiresAt || 0;

        const now = Date.now();

        // Token is still valid.
        if (now < expiresAt - 60000) {
            return connection.accessToken;
        }

        const organizationId = connection.organizationId;

        // A refresh for this organization is already in flight —
        // share it instead of redeeming the same refresh token
        // twice (QuickBooks invalidates it the moment a new one
        // is issued, so concurrent refreshes fail each other).
        if (this._refreshPromises.has(organizationId)) {
            return this._refreshPromises.get(organizationId);
        }

        const refreshPromise = this._refreshAndPersist(connection)
            .finally(() => {
                this._refreshPromises.delete(organizationId);
            });

        this._refreshPromises.set(organizationId, refreshPromise);

        return refreshPromise;
    }

    async _refreshAndPersist(connection) {
        console.log(
            'QuickBooks access token expired. Refreshing...'
        );

        if (!connection.refreshToken) {
            throw new Error(
                'QuickBooks refresh token not available'
            );
        }

        const tokens =
            await this.refreshAccessToken(
                connection.refreshToken
            );

        if (!tokens?.access_token) {
            throw new Error(
                'QuickBooks did not return a new access token'
            );
        }

        const expiresIn =
            Number(tokens.expires_in || 3600);

        const accessToken = tokens.access_token;

        const refreshToken =
            tokens.refresh_token ||
            connection.refreshToken;

        // Save refreshed tokens to Supabase.
        await supabaseService.updateQuickBooksTokens(
            connection.organizationId,
            {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: expiresIn
            }
        );

        // Update local object for this request.
        connection.accessToken = accessToken;
        connection.refreshToken = refreshToken;
        connection.expiresIn = expiresIn;
        connection.expiresAt = Date.now() + expiresIn * 1000;

        console.log(
            'QuickBooks access token refreshed and saved'
        );

        return accessToken;
    }

    // ==========================================================
    // QUICKBOOKS API
    // ==========================================================

    async makeApiRequest(
        accessToken,
        realmId,
        endpoint,
        method = 'GET',
        data = null
    ) {
        try {
            const url =
                `${this.baseUrl}/v3/company/${realmId}/${endpoint}`;

            const config = {
                method,
                url,

                headers: {
                    Authorization:
                        `Bearer ${accessToken}`,

                    Accept:
                        'application/json',

                    'Content-Type':
                        'application/json'
                }
            };

            if (data !== null) {
                config.data = data;
            }

            const response =
                await axios(config);

            return response.data;
        } catch (error) {
            console.error(
                'QuickBooks API request failed:',
                error.response?.data || error.message
            );

            throw error;
        }
    }

    // ==========================================================
    // COMPANY INFO
    // ==========================================================

    async getCompanyInfo(
        accessToken,
        realmId
    ) {
        try {
            const url =
                `${this.baseUrl}/v3/company/${realmId}/companyinfo/${realmId}`;

            const response =
                await axios.get(url, {
                    headers: {
                        Authorization:
                            `Bearer ${accessToken}`,

                        Accept:
                            'application/json'
                    }
                });

            return response.data;
        } catch (error) {
            console.error(
                'Failed to fetch CompanyInfo:',
                error.response?.data || error.message
            );

            throw error;
        }
    }

    // ==========================================================
    // PROFIT & LOSS
    // ==========================================================

    async getProfitAndLoss(
        accessToken,
        realmId,
        startDate,
        endDate
    ) {
        try {
            const endpoint =
                `reports/ProfitAndLoss` +
                `?start_date=${encodeURIComponent(startDate)}` +
                `&end_date=${encodeURIComponent(endDate)}`;

            return await this.makeApiRequest(
                accessToken,
                realmId,
                endpoint
            );
        } catch (error) {
            console.error(
                'Failed to fetch Profit & Loss:',
                error.response?.data || error.message
            );

            throw error;
        }
    }
 parseProfitAndLoss(report) {

    try {

        const result = {

            period: {
                startDate:
                    report?.Header?.StartPeriod || null,

                endDate:
                    report?.Header?.EndPeriod || null
            },

            currency:
                report?.Header?.Currency || "USD",

            reportBasis:
                report?.Header?.ReportBasis || "Accrual",

            income: 0,

            costOfGoodsSold: 0,

            grossProfit: 0,

            expenses: 0,

            netOperatingIncome: 0,

            otherExpenses: 0,

            netOtherIncome: 0,

            netIncome: 0,

            accounts: {

                income: [],

                cogs: [],

                expenses: [],

                otherIncomeExpense: []

            }

        };


        // ======================================================
        // HELPERS
        // ======================================================

        const TOP_LEVEL_PL_HEADERS = new Set([
            "income",
            "cost of goods sold",
            "cogs",
            "gross profit",
            "expenses",
            "other income",
            "other expenses",
            "other expense",
            "net operating income",
            "net other income",
            "net income"
        ]);

        const toNumber = (value) => {

            const number =
                Number(value);

            return Number.isFinite(number)
                ? number
                : 0;

        };


        const getAccount = (row) => {

            const columns =
                row?.ColData || [];

            return {

                id:
                    columns[0]?.id ||
                    null,

                name:
                    columns[0]?.value ||
                    "",

                amount:
                    toNumber(
                        columns[1]?.value
                    )

            };

        };


        // ======================================================
        // DETERMINE SECTION
        // ======================================================

        const getSection = (
            row,
            currentSection
        ) => {

            const group =
                String(
                    row?.group || ""
                ).toLowerCase();


            const headerName =
                String(
                    row?.Header
                        ?.ColData?.[0]
                        ?.value || ""
                ).toLowerCase();


            const summaryName =
                String(
                    row?.Summary
                        ?.ColData?.[0]
                        ?.value || ""
                ).toLowerCase();


            const text =
                `${group} ${headerName} ${summaryName}`;


            if (
                text.includes("income") &&
                !text.includes("other income")
            ) {

                return "income";

            }


            if (
                text.includes("cogs") ||
                text.includes("cost of goods sold")
            ) {

                return "cogs";

            }


            if (
                text.includes("expense") &&
                !text.includes("other expense")
            ) {

                return "expenses";

            }


            if (
                text.includes("other income") ||
                text.includes("other expense") ||
                text.includes("net other")
            ) {

                return "otherIncomeExpense";

            }


            return currentSection;

        };


        // ======================================================
        // SUMMARY TOTALS
        // ======================================================

        const parseSummary = (row) => {

            if (
                !row?.Summary?.ColData
            ) {

                return;

            }


            const group =
                row?.group;


            const value =
                toNumber(
                    row.Summary
                        .ColData?.[1]
                        ?.value
                );


            switch (group) {

                case "Income":

                    result.income =
                        value;

                    break;


                case "COGS":

                    result.costOfGoodsSold =
                        value;

                    break;


                case "GrossProfit":

                    result.grossProfit =
                        value;

                    break;


                case "Expenses":

                    result.expenses =
                        value;

                    break;


                case "NetOperatingIncome":

                    result.netOperatingIncome =
                        value;

                    break;


                case "OtherExpenses":

                    result.otherExpenses =
                        value;

                    break;


                case "NetOtherIncome":

                    result.netOtherIncome =
                        value;

                    break;


                case "NetIncome":

                    result.netIncome =
                        value;

                    break;

            }

        };


        // ======================================================
        // RECURSIVE QUICKBOOKS ROW PARSER
        // ======================================================

        const processRows = (
            rows,
            currentSection = null,
            parentGroup = null
        ) => {

            for (
                const row of rows || []
            ) {


                // ------------------------------------------------
                // Determine section BEFORE entering children
                // ------------------------------------------------

                const section =
                    getSection(
                        row,
                        currentSection
                    );


                // ------------------------------------------------
                // Read summary totals
                // ------------------------------------------------

                parseSummary(row);


                // ------------------------------------------------
                // Read actual account row
                // ------------------------------------------------

                if (
                    row?.ColData
                ) {

                    const account =
                        getAccount(row);


                    const name =
                        account.name
                            .trim();


                    /*
                     * Ignore empty rows and TOTAL rows.
                     */

                    if (
                        name &&
                        name.toUpperCase() !==
                            "TOTAL"
                    ) {

                        // Immediate parent section name (e.g.
                        // "Utilities" for "Gas & Electric", or
                        // "Job Materials" for a line nested two
                        // levels under "Landscaping Services").
                        // Null for lines with no parent group.
                        account._group =
                            parentGroup;


                        if (
                            section ===
                            "income"
                        ) {

                            result.accounts
                                .income
                                .push(account);

                        }


                        else if (
                            section ===
                            "cogs"
                        ) {

                            result.accounts
                                .cogs
                                .push(account);

                        }


                        else if (
                            section ===
                            "expenses"
                        ) {

                            result.accounts
                                .expenses
                                .push(account);

                        }


                        else if (
                            section ===
                            "otherIncomeExpense"
                        ) {

                            result.accounts
                                .otherIncomeExpense
                                .push(account);

                        }

                    }

                }


                // ------------------------------------------------
                // IMPORTANT:
                // Continue into nested QuickBooks rows
                // ------------------------------------------------

                if (
                    Array.isArray(
                        row?.Rows?.Row
                    )
                ) {

                    const headerName =
                        String(
                            row?.Header
                                ?.ColData?.[0]
                                ?.value || ""
                        ).trim();

                    // The report's own top-level blocks (Income,
                    // COGS, Expenses, Other Income/Expenses) are
                    // not a meaningful "_group" for their direct
                    // children — only genuine sub-categories like
                    // "Utilities" or "Job Materials" are.
                    const isTopLevelBlock =
                        TOP_LEVEL_PL_HEADERS.has(
                            headerName.toLowerCase()
                        );

                    const nextGroup =
                        headerName && !isTopLevelBlock
                            ? headerName
                            : parentGroup;

                    processRows(
                        row.Rows.Row,
                        section,
                        nextGroup
                    );

                }

            }

        };


        // ======================================================
        // START PARSING
        // ======================================================

        processRows(
            report?.Rows?.Row || []
        );


        // ======================================================
        // DEBUG
        // ======================================================

        console.log(
            "P&L ACCOUNT COUNTS:",
            {

                income:
                    result.accounts
                        .income.length,

                cogs:
                    result.accounts
                        .cogs.length,

                expenses:
                    result.accounts
                        .expenses.length,

                otherIncomeExpense:
                    result.accounts
                        .otherIncomeExpense.length

            }
        );


        console.log(
            "P&L ACCOUNT DETAILS:",
            result.accounts
        );


        return result;


    } catch (error) {

        console.error(
            "Failed to parse Profit & Loss:",
            error.message
        );

        throw error;

    }

}

    async getAccountsReceivable(
        accessToken,
        realmId,
        asOfDate
    ) {
        try {
            // AgedReceivables is a snapshot report — QuickBooks reads its
            // as-of date from `report_date`, not `start_date`. Passing
            // start_date silently gets ignored and the report defaults
            // to today regardless of the date requested.
            const endpoint =
                `reports/AgedReceivables` +
                `?report_date=${encodeURIComponent(asOfDate)}`;

            return await this.makeApiRequest(
                accessToken,
                realmId,
                endpoint
            );
        } catch (error) {
            console.error(
                'Failed to fetch Accounts Receivable:',
                error.response?.data || error.message
            );

            throw error;
        }
    }
    async getAccountsPayable(
        accessToken,
        realmId,
        asOfDate
    ) {
        try {
            const endpoint =
                `reports/AgedPayables` +
                `?report_date=${encodeURIComponent(asOfDate)}`;

            return await this.makeApiRequest(
                accessToken,
                realmId,
                endpoint
            );
        } catch (error) {
            console.error(
                'Failed to fetch Accounts Payable:',
                error.response?.data || error.message
            );

            throw error;
        }
    }
    async getInvoices(
        accessToken,
        realmId
    ) {
        try {
    
            const endpoint =
                `query?query=${encodeURIComponent(
                    "SELECT * FROM Invoice MAXRESULTS 1000"
                )}`;
    
            const response =
                await this.makeApiRequest(
                    accessToken,
                    realmId,
                    endpoint
                );
    
            return (
                response?.QueryResponse?.Invoice ||
                []
            );
    
        } catch (error) {
    
            console.error(
                'Failed to fetch invoices:',
                error.response?.data ||
                error.message
            );
    
            throw error;
        }
    } 
    async getAccounts(
        accessToken,
        realmId
    ) {
        try {
    
            const endpoint =
                `query?query=${encodeURIComponent(
                    "SELECT * FROM Account MAXRESULTS 1000"
                )}`;
    
            const response =
                await this.makeApiRequest(
                    accessToken,
                    realmId,
                    endpoint
                );
    
            return (
                response?.QueryResponse?.Account ||
                []
            );
    
        } catch (error) {
    
            console.error(
                "Failed to fetch QuickBooks accounts:",
                error.response?.data ||
                error.message
            );
    
            throw error;
        }
    }
    getDebtAccounts(accounts = []) {
    
        const debtKeywords = [
            "loan",
            "business loan",
            "bank loan",
            "term loan",
            "notes payable",
            "note payable",
            "line of credit"
        ];
    
        return accounts
            .filter(account => {
    
                const type =
                    String(
                        account.AccountType || ""
                    ).toLowerCase();
    
                const name =
                    String(
                        account.Name || ""
                    ).toLowerCase();
    
                const isCreditCard =
                    type === "credit card";
    
                const isLongTerm =
                    type ===
                    "long term liability";
    
                const isCurrentDebt =
                    type ===
                    "other current liability" &&
                    debtKeywords.some(
                        keyword =>
                            name.includes(keyword)
                    );
    
                return (
                    isCreditCard ||
                    isLongTerm ||
                    isCurrentDebt
                );
    
            })
            .map(account => {
    
                const type =
                    account.AccountType;
    
                let category =
                    "Current Debt";
    
                if (
                    type ===
                    "Long Term Liability"
                ) {
                    category =
                        "Long-Term Debt";
                }
    
                if (
                    type ===
                    "Credit Card"
                ) {
                    category =
                        "Credit Card Debt";
                }
    
                return {
    
                    id:
                        account.Id,
    
                    name:
                        account.Name,
    
                    fullName:
                        account.FullyQualifiedName ||
                        account.Name,
    
                    category,
    
                    accountType:
                        account.AccountType,
    
                    accountSubType:
                        account.AccountSubType,
    
                    balance:
                        Math.abs(
                            Number(
                                account.CurrentBalance ||
                                0
                            )
                        ),
    
                    currency:
                        account.CurrencyRef?.value ||
                        null,
    
                    active:
                        account.Active !== false,
    
                    subAccount:
                        account.SubAccount === true,
    
                    parentId:
                        account.ParentRef?.value ||
                        null,
    
                    lastUpdated:
                        account.MetaData?.LastUpdatedTime ||
                        null
    
                };
            });
    }
    async getExpenseTransactions(
        accessToken,
        realmId
    ) {
        try {
    
            const endpoint =
                `query?query=` +
                encodeURIComponent(
                    `SELECT * FROM Purchase MAXRESULTS 1000`
                );
    
            return await this.makeApiRequest(
                accessToken,
                realmId,
                endpoint
            );
    
        } catch (error) {
    
            console.error(
                'Failed to fetch expense transactions:',
                error.response?.data ||
                error.message
            );
    
            throw error;
        }
    }
    
    // ==========================================================
    // BALANCE SHEET
    // ==========================================================

    async getBalanceSheet(
        accessToken,
        realmId,
        asOfDate
    ) {
        try {
            // BalanceSheet only honors end_date when start_date is also
            // present — end_date alone is silently ignored and the
            // report falls back to its "this calendar year-to-date"
            // default, always showing today regardless of the date
            // requested. Balance Sheet is a snapshot, so both are set
            // to the same as-of date.
            const endpoint =
                `reports/BalanceSheet` +
                `?start_date=${encodeURIComponent(asOfDate)}` +
                `&end_date=${encodeURIComponent(asOfDate)}`;

            return await this.makeApiRequest(
                accessToken,
                realmId,
                endpoint
            );
        } catch (error) {
            console.error(
                'Failed to fetch Balance Sheet:',
                error.response?.data || error.message
            );

            throw error;
        }
    }
    

// ==========================================================
// GET OPENING CASH BALANCE
// ==========================================================

    async getOpeningCashBalance(
        accessToken,
        realmId,
        startDate
    ) {
        try {
    
            // Get the day before the Cash Flow start date
            const date =
                new Date(`${startDate}T00:00:00Z`);
    
            date.setUTCDate(
                date.getUTCDate() - 1
            );
    
            const previousDate =
                date.toISOString().slice(0, 10);
    
            console.log(
                "Fetching opening cash as of:",
                previousDate
            );
    
            // Get Balance Sheet for previous day
            const report =
                await this.getBalanceSheet(
                    accessToken,
                    realmId,
                    previousDate
                );
    
            const balanceSheet =
                this.parseBalanceSheet(report);
    
            const assets =
                balanceSheet?.details?.assets || [];
    
    
            let openingCash = 0;
    
    
            // ------------------------------------------------------
            // Recursively find cash/bank accounts
            // ------------------------------------------------------
    
            function findCashAccounts(
                rows,
                insideCashSection = false
            ) {
    
                for (const row of rows || []) {
    
                    const name =
                        String(
                            row?.name || ""
                        ).trim();
    
                    const lowerName =
                        name.toLowerCase();
    
    
                    const isCashSection =
                        lowerName.includes("cash") ||
                        lowerName.includes("bank accounts") ||
                        lowerName.includes("bank account") ||
                        lowerName === "bank";
    
    
                    const inCash =
                        insideCashSection ||
                        isCashSection;
    
    
                    // Regular account
                    if (
                        row?.type === "account" &&
                        inCash
                    ) {
    
                        openingCash +=
                            Number(
                                row.amount || 0
                            );
    
                    }
    
    
                    // Section
                    if (
                        row?.type === "section"
                    ) {
    
                        if (
                            Array.isArray(
                                row.children
                            ) &&
                            row.children.length > 0
                        ) {
    
                            findCashAccounts(
                                row.children,
                                inCash
                            );
    
                        } else if (inCash) {
    
                            // Section has no children.
                            // Use its own amount.
                            openingCash +=
                                Number(
                                    row.amount || 0
                                );
    
                        }
    
                    }
    
                }
    
            }
    
    
            findCashAccounts(assets);
    
    
            console.log(
                "Opening Cash:",
                openingCash
            );
    
    
            return {
                date: previousDate,
                amount: openingCash
            };
    
        } catch (error) {
    
            console.error(
                "Failed to fetch opening cash:",
                error.response?.data ||
                error.message
            );
    
            throw error;
        }
    }
    
    // ==========================================================
    // CASH FLOW
    // ==========================================================

    async getCashFlow(
        accessToken,
        realmId,
        startDate,
        endDate
    ) {
        try {
            const endpoint =
                `reports/CashFlow` +
                `?start_date=${encodeURIComponent(startDate)}` +
                `&end_date=${encodeURIComponent(endDate)}`;

            return await this.makeApiRequest(
                accessToken,
                realmId,
                endpoint
            );
        } catch (error) {
            console.error(
                'Failed to fetch Cash Flow:',
                error.response?.data || error.message
            );

            throw error;
        }
    }

    // ==========================================================
    // PARSE CASH FLOW
    // ==========================================================

    parseCashFlow(report) {

    const result = {
        period: {
            startDate:
                report?.Header?.StartPeriod || null,

            endDate:
                report?.Header?.EndPeriod || null
        },

        currency:
            report?.Header?.Currency || "USD",

        reportBasis:
            report?.Header?.ReportBasis || "Accrual",

        netIncome: 0,

        operatingActivities: 0,

        investingActivities: 0,

        financingActivities: 0,

        cashIncrease: 0,

        openingCash: 0,

        endingCash: 0,

        closingCash: 0,

        details: {
            operatingActivities: [],
            investingActivities: [],
            financingActivities: []
        }
    };


    // ==========================================================
    // FIND SUMMARY VALUES
    // ==========================================================

    function findSummaryValues(rows) {

        for (const row of rows || []) {

            const group =
                row?.group;

            const summaryValue =
                row?.Summary?.ColData?.[1]?.value;

            if (summaryValue !== undefined) {

                const value =
                    Number(summaryValue) || 0;

                switch (group) {

                    case "OperatingActivities":
                        result.operatingActivities = value;
                        break;

                    case "InvestingActivities":
                        result.investingActivities = value;
                        break;

                    case "FinancingActivities":
                        result.financingActivities = value;
                        break;

                    case "CashIncrease":
                        result.cashIncrease = value;
                        break;

                    case "EndingCash":
                        result.endingCash = value;
                        break;

                }
            }


            // Net Income

            if (
                row?.group === "NetIncome" &&
                row?.ColData
            ) {

                result.netIncome =
                    Number(
                        row.ColData?.[1]?.value
                    ) || 0;

            }


            // Search nested rows

            if (row?.Rows?.Row) {

                findSummaryValues(
                    row.Rows.Row
                );

            }

        }

    }


    findSummaryValues(
        report?.Rows?.Row || []
    );


    // ==========================================================
    // FLATTEN CASH FLOW ACCOUNT ROWS
    // ==========================================================

    function collectAccountRows(rows) {

        const accounts = [];

        for (const row of rows || []) {

            // Direct account/data row

            if (row?.ColData) {

                const name =
                    row.ColData?.[0]?.value || "";

                const amount =
                    Number(
                        row.ColData?.[1]?.value
                    ) || 0;

                // Ignore completely empty rows

                if (name) {

                    accounts.push({
                        type: "account",

                        id:
                            row.ColData?.[0]?.id ||
                            null,

                        name,

                        amount
                    });

                }

            }


            // Nested section

            if (row?.Rows?.Row) {

                accounts.push(
                    ...collectAccountRows(
                        row.Rows.Row
                    )
                );

            }

        }

        return accounts;

    }


    // ==========================================================
    // BUILD CASH FLOW DETAILS
    // ==========================================================

    const rows =
        report?.Rows?.Row || [];


    for (const row of rows) {

        const headerName =
            String(
                row?.Header?.ColData?.[0]?.value || ""
            ).trim().toUpperCase();


        if (
            headerName ===
            "OPERATING ACTIVITIES"
        ) {

            result.details.operatingActivities =
                collectAccountRows(
                    row?.Rows?.Row || []
                );

        }


        if (
            headerName ===
            "INVESTING ACTIVITIES"
        ) {

            result.details.investingActivities =
                collectAccountRows(
                    row?.Rows?.Row || []
                );

        }


        if (
            headerName ===
            "FINANCING ACTIVITIES"
        ) {

            result.details.financingActivities =
                collectAccountRows(
                    row?.Rows?.Row || []
                );

        }

    }



    // ==========================================================
    // OPENING / CLOSING CASH
    // ==========================================================

    result.closingCash =
        result.endingCash;



    // ==========================================================
    // DEBUG
    // ==========================================================

    console.log(
        "Cash Flow parsed:",
        {
            operating:
                result.operatingActivities,

            investing:
                result.investingActivities,

            financing:
                result.financingActivities,

            cashIncrease:
                result.cashIncrease,

            openingCash:
                result.openingCash,

            closingCash:
                result.closingCash,

            operatingAccounts:
                result.details
                    .operatingActivities.length,

            investingAccounts:
                result.details
                    .investingActivities.length,

            financingAccounts:
                result.details
                    .financingActivities.length
        }
    );


    return result;

}

    // ==========================================================
    // PARSE BALANCE SHEET
    // ==========================================================

 parseBalanceSheet(report) {
    // QuickBooks flags an as-of date with no recorded activity via
    // Header.Option NoReportData — e.g. a date before the company's
    // books started. Surfacing this lets the UI explain a genuine
    // "no data yet" period instead of showing a confusing all-zero
    // statement that looks broken.
    const noReportDataOption =
        (report?.Header?.Option || []).find(
            option => option.Name === 'NoReportData'
        );

    const result = {
        period: {
            startDate:
                report?.Header?.StartPeriod || null,

            endDate:
                report?.Header?.EndPeriod || null
        },

        currency:
            report?.Header?.Currency || null,

        reportBasis:
            report?.Header?.ReportBasis || null,

        hasData:
            !(noReportDataOption?.Value === 'true'),

        totalAssets: 0,

        totalLiabilities: 0,

        totalEquity: 0,

        totalLiabilitiesAndEquity: 0,

        details: {
            assets: [],
            liabilities: [],
            equity: []
        }
    };


    // ============================================================
    // Helpers
    // ============================================================

    const toNumber = (value) => {
        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : 0;
    };


    const getColDataValue = (row, index = 0) => {
        return row?.ColData?.[index]?.value ?? null;
    };


    const getColDataId = (row, index = 0) => {
        return row?.ColData?.[index]?.id ?? null;
    };


    // ============================================================
    // Parse QuickBooks rows
    // ============================================================

    const parseRows = (rows = []) => {

        const parsed = [];

        for (const row of rows) {

            // ----------------------------------------------------
            // Account row
            // ----------------------------------------------------

            if (row?.ColData) {

                const name =
                    getColDataValue(row, 0) || '';

                const amount =
                    toNumber(
                        getColDataValue(row, 1)
                    );

                parsed.push({
                    type: 'account',

                    id:
                        getColDataId(row, 0),

                    name,

                    amount
                });

                continue;
            }


            // ----------------------------------------------------
            // Section row
            // ----------------------------------------------------

            if (row?.Header?.ColData) {

                const header =
                    row.Header.ColData;

                const name =
                    header?.[0]?.value || '';

                const id =
                    header?.[0]?.id || null;


                const children =
                    row?.Rows?.Row
                        ? parseRows(
                            row.Rows.Row
                        )
                        : [];


                // QuickBooks can put the section
                // amount in Summary instead
                // of Header.

                const headerAmount =
                    toNumber(
                        header?.[1]?.value
                    );


                const summaryAmount =
                    toNumber(
                        row?.Summary
                            ?.ColData?.[1]
                            ?.value
                    );


                let amount =
                    summaryAmount ||
                    headerAmount;


                // ------------------------------------------------
                // If QuickBooks does not provide a section total,
                // calculate it from the actual account children.
                //
                // Do NOT create fake zero categories.
                // ------------------------------------------------

                if (
                    amount === 0 &&
                    children.length > 0
                ) {
                    amount =
                        sumRows(children);
                }


                const section = {
                    type: 'section',

                    id,

                    name,

                    amount,

                    children
                };


                // Preserve QuickBooks summary
                // when it exists.

                if (row?.Summary?.ColData) {

                    section.summary = {
                        name:
                            row.Summary
                                .ColData?.[0]
                                ?.value || '',

                        amount:
                            summaryAmount
                    };
                }


                parsed.push(section);
            }
        }

        return parsed;
    };


    // ============================================================
    // Sum actual account/section data
    // ============================================================

    function sumRows(rows = []) {

        let total = 0;

        for (const row of rows) {

            if (row.type === 'account') {

                total +=
                    toNumber(row.amount);

                continue;
            }


            if (row.type === 'section') {

                // Prefer the section's own total.
                // Do not add both section total
                // AND its children.

                if (
                    Number.isFinite(
                        Number(row.amount)
                    )
                ) {
                    total +=
                        toNumber(row.amount);
                }
            }
        }

        return total;
    }


    // ============================================================
    // Find top-level QuickBooks totals
    // ============================================================

    const findSummaryValues = (rows = []) => {

        for (const row of rows) {

            const group =
                row?.group;

            const summaryValue =
                row?.Summary
                    ?.ColData?.[1]
                    ?.value;


            if (
                summaryValue !== undefined
            ) {

                const value =
                    toNumber(summaryValue);


                switch (group) {

                    case 'TotalAssets':

                        result.totalAssets =
                            value;

                        break;


                    case 'Liabilities':

                        result.totalLiabilities =
                            value;

                        break;


                    case 'Equity':

                        result.totalEquity =
                            value;

                        break;


                    case 'TotalLiabilitiesAndEquity':

                        result.totalLiabilitiesAndEquity =
                            value;

                        break;
                }
            }


            if (row?.Rows?.Row) {

                findSummaryValues(
                    row.Rows.Row
                );
            }
        }
    };


    const rows =
        report?.Rows?.Row || [];


    findSummaryValues(rows);


    // ============================================================
    // Find Assets / Liabilities / Equity
    // ============================================================

    for (const row of rows) {

        const headerName =
            String(
                row?.Header
                    ?.ColData?.[0]
                    ?.value || ''
            ).trim();


        // --------------------------------------------------------
        // ASSETS
        // --------------------------------------------------------

        if (
            headerName.toUpperCase() ===
            'ASSETS'
        ) {

            result.details.assets =
                parseRows(
                    row?.Rows?.Row || []
                );
        }


        // --------------------------------------------------------
        // LIABILITIES + EQUITY
        // --------------------------------------------------------

        if (
            headerName.toUpperCase() ===
            'LIABILITIES AND EQUITY'
        ) {

            const liabilityEquityRows =
                row?.Rows?.Row || [];


            for (
                const section
                of liabilityEquityRows
            ) {

                const sectionName =
                    String(
                        section
                            ?.Header
                            ?.ColData?.[0]
                            ?.value || ''
                    ).trim();


                // ------------------------------------------------
                // LIABILITIES
                // ------------------------------------------------

                if (
                    sectionName.toLowerCase() ===
                    'liabilities'
                ) {

                    result.details.liabilities =
                        parseRows(
                            section
                                ?.Rows
                                ?.Row || []
                        );
                }


                // ------------------------------------------------
                // EQUITY
                // ------------------------------------------------

                if (
                    sectionName.toLowerCase() ===
                    'equity'
                ) {

                    result.details.equity =
                        parseRows(
                            section
                                ?.Rows
                                ?.Row || []
                        );
                }
            }
        }
    }


    // ============================================================
    // Fallback totals
    //
    // Only calculate when QuickBooks did not provide
    // the corresponding total.
    // ============================================================

    if (
        result.totalAssets === 0 &&
        result.details.assets.length > 0
    ) {

        result.totalAssets =
            sumRows(
                result.details.assets
            );
    }


    if (
        result.totalLiabilities === 0 &&
        result.details.liabilities.length > 0
    ) {

        result.totalLiabilities =
            sumRows(
                result.details.liabilities
            );
    }


    if (
        result.totalEquity === 0 &&
        result.details.equity.length > 0
    ) {

        result.totalEquity =
            sumRows(
                result.details.equity
            );
    }


    // ============================================================
    // Liabilities + Equity
    //
    // Calculate only if QuickBooks did not provide it.
    // ============================================================

    if (
        result.totalLiabilitiesAndEquity === 0
    ) {

        result.totalLiabilitiesAndEquity =
            result.totalLiabilities +
            result.totalEquity;
    }


    // ============================================================
    // Fundamental accounting equation:
    // Assets = Liabilities + Equity.
    //
    // Tolerant of sub-cent floating-point rounding only —
    // anything larger means bad data from QuickBooks or a
    // parsing bug, and callers need to know.
    // ============================================================

    result.balanceDifference =
        result.totalAssets -
        result.totalLiabilitiesAndEquity;

    result.isBalanced =
        Math.abs(result.balanceDifference) < 0.01;

    if (!result.isBalanced) {

        console.error(
            'Balance Sheet does not balance:',
            {
                totalAssets:
                    result.totalAssets,

                totalLiabilitiesAndEquity:
                    result.totalLiabilitiesAndEquity,

                difference:
                    result.balanceDifference
            }
        );
    }


    // ============================================================
    // Final diagnostic
    // ============================================================

    console.log(
        'Balance Sheet parsed:',
        {
            totalAssets:
                result.totalAssets,

            totalLiabilities:
                result.totalLiabilities,

            totalEquity:
                result.totalEquity,

            totalLiabilitiesAndEquity:
                result.totalLiabilitiesAndEquity,

            assetSections:
                result.details.assets
                    .map(section => ({
                        name:
                            section.name,

                        amount:
                            section.amount,

                        accounts:
                            section.children
                                ?.length || 0
                    })),

            liabilitySections:
                result.details.liabilities
                    .map(section => ({
                        name:
                            section.name,

                        amount:
                            section.amount,

                        accounts:
                            section.children
                                ?.length || 0
                    })),

            equitySections:
                result.details.equity
                    .map(section => ({
                        name:
                            section.name,

                        amount:
                            section.amount,

                        accounts:
                            section.children
                                ?.length || 0
                    }))
        }
    );


    return result;
}

    // ==========================================================
    // PARSE PROFIT & LOSS
    // ==========================================================

parseAccountsReceivable(report) {

    const result = {
        total: 0,

        aging: {
            current: 0,
            days1to30: 0,
            days31to60: 0,
            days61to90: 0,
            over90: 0
        },

        customers: []
    };


    const rows =
        report?.Rows?.Row || [];


    const toNumber = (value) =>
        Number(value) || 0;


    const parseRows = (items) => {

        for (const row of items || []) {

            // Normal customer row
            if (row?.ColData) {

                const cols =
                    row.ColData;

                const name =
                    cols[0]?.value || "";

                const current =
                    toNumber(
                        cols[1]?.value
                    );

                const days1to30 =
                    toNumber(
                        cols[2]?.value
                    );

                const days31to60 =
                    toNumber(
                        cols[3]?.value
                    );

                const days61to90 =
                    toNumber(
                        cols[4]?.value
                    );

                const over90 =
                    toNumber(
                        cols[5]?.value
                    );

                const total =
                    toNumber(
                        cols[6]?.value
                    );


                if (name && total !== 0) {

                    result.customers.push({
                        id:
                            cols[0]?.id ||
                            null,

                        name,

                        current,

                        days1to30,

                        days31to60,

                        days61to90,

                        over90,

                        amount: total
                    });

                }

                continue;
            }


            // Customer section
            // e.g. Freeman Sporting Goods
            if (row?.Rows?.Row) {

                parseRows(
                    row.Rows.Row
                );

            }


            // Grand total
            if (
                row?.group ===
                "GrandTotal" &&
                row?.Summary?.ColData
            ) {

                const summary =
                    row.Summary.ColData;

                result.aging.current =
                    toNumber(
                        summary[1]?.value
                    );

                result.aging.days1to30 =
                    toNumber(
                        summary[2]?.value
                    );

                result.aging.days31to60 =
                    toNumber(
                        summary[3]?.value
                    );

                result.aging.days61to90 =
                    toNumber(
                        summary[4]?.value
                    );

                result.aging.over90 =
                    toNumber(
                        summary[5]?.value
                    );

                result.total =
                    toNumber(
                        summary[6]?.value
                    );
            }
        }
    };


    parseRows(rows);


    return result;
}

parseAccountsPayable(report) {
    try {

        const rows =
            report?.Rows?.Row || [];

        const aging = {
            current: 0,
            days1to30: 0,
            days31to60: 0,
            days61to90: 0,
            over90: 0
        };

        const vendors = [];


        rows.forEach(row => {

            /*
             * GRAND TOTAL
             * QuickBooks is authoritative for
             * the aging totals.
             */
            if (
                row?.group === "GrandTotal" &&
                row?.Summary?.ColData
            ) {

                const data =
                    row.Summary.ColData;

                aging.current =
                    Number(data[1]?.value || 0);

                aging.days1to30 =
                    Number(data[2]?.value || 0);

                aging.days31to60 =
                    Number(data[3]?.value || 0);

                aging.days61to90 =
                    Number(data[4]?.value || 0);

                aging.over90 =
                    Number(data[5]?.value || 0);

                return;
            }


            /*
             * Ignore any other summary rows.
             */
            if (row?.Summary) {
                return;
            }


            /*
             * VENDOR ROW
             */
            const colData =
                row?.ColData || [];

            const name =
                colData[0]?.value || "";

            /*
             * Ignore empty rows.
             */
            if (!name) {
                return;
            }


            const current =
                Number(
                    colData[1]?.value || 0
                );

            const days1to30 =
                Number(
                    colData[2]?.value || 0
                );

            const days31to60 =
                Number(
                    colData[3]?.value || 0
                );

            const days61to90 =
                Number(
                    colData[4]?.value || 0
                );

            const over90 =
                Number(
                    colData[5]?.value || 0
                );

            const amount =
                Number(
                    colData[6]?.value || 0
                );


            vendors.push({

                id:
                    colData[0]?.id || null,

                name,

                amount,

                current,

                days1to30,

                days31to60,

                days61to90,

                over90

            });

        });


        /*
         * Total comes directly from
         * the aging buckets.
         */
        const total =
            aging.current +
            aging.days1to30 +
            aging.days31to60 +
            aging.days61to90 +
            aging.over90;


        const result = {

            total,

            aging,

            vendors

        };


        console.log(
            "AP NORMALIZED DATA:",
            result
        );


        return result;


    } catch (error) {

        console.error(
            "Failed to parse Accounts Payable:",
            error.message
        );

        throw error;
    }
}


}

module.exports = new QuickBooksService();