// ============================================================
// NONAKA FINANCIAL PARTNERS — API CLIENT
// Handles communication with the Node.js / Express Backend
// ============================================================

const API_BASE_URL = "/api";

// ============================================================
// ORGANIZATION
// ============================================================

// Temporary for development.
// Later this will come automatically from Supabase Auth.
const ORGANIZATION_ID =
  "bcd0bfcb-74c7-4054-9ee3-ce6b4140a379";

// ============================================================
// API CLIENT
// ============================================================

const NFK_API = {

  // ----------------------------------------------------------
  // Generic Request
  // ----------------------------------------------------------

  async _request(endpoint, options = {}) {
    try {
      const res = await fetch(
        `${API_BASE_URL}${endpoint}`,
        {
          headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
          },
          ...options
        }
      );

      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({
            error: "Unknown error"
          }));

        throw new Error(
          err.error ||
          `API Error: ${res.status}`
        );
      }

      return await res.json();

    } catch (error) {
      console.error(
        `API Request failed for ${endpoint}:`,
        error
      );

      throw error;
    }
  },

  // ==========================================================
  // QUICKBOOKS
  // ==========================================================

  getQBStatus: () => {
    const query = new URLSearchParams({
      organizationId: ORGANIZATION_ID
    });

    return NFK_API._request(
      `/quickbooks/status?${query}`
    );
  },

  getCompany: () => {
    const query = new URLSearchParams({
      organizationId: ORGANIZATION_ID
    });

    return NFK_API._request(
      `/quickbooks/company?${query}`
    );
  },

  // ==========================================================
  // PROFIT & LOSS
  // ==========================================================

  getProfitAndLoss: ({
    startDate,
    endDate
  } = {}) => {

    const query = new URLSearchParams({
      organizationId: ORGANIZATION_ID,
      startDate: startDate || "2026-01-01",
      endDate: endDate || "2026-08-20"
    });

    return NFK_API._request(
      `/quickbooks/reports/profit-and-loss?${query}`
    );
  },

  // ==========================================================
  // BALANCE SHEET
  // ==========================================================

  getBalanceSheet: ({
    startDate
  } = {}) => {

    const query = new URLSearchParams({
      organizationId: ORGANIZATION_ID,
      startDate: startDate || "2026-08-20"
    });

    return NFK_API._request(
      `/quickbooks/reports/balance-sheet?${query}`
    );
  },

    // ==========================================================
    // CASH FLOW
    // ==========================================================
    
    getCashFlow: ({
      startDate,
      endDate
    } = {}) => {
    
      const query = new URLSearchParams({
        organizationId: ORGANIZATION_ID,
        startDate: startDate || "2026-01-01",
        endDate: endDate || "2026-08-20"
      });
    
      return NFK_API._request(
        `/quickbooks/reports/cash-flow?${query}`
      );
    },
    
    
    // ==========================================================
    // ACCOUNTS RECEIVABLE
    // ==========================================================
    
    getAccountsReceivable: ({
      startDate
    } = {}) => {
    
      const query = new URLSearchParams({
        organizationId: ORGANIZATION_ID,
        startDate: startDate || "2026-01-01"
      });
    
      return NFK_API._request(
        `/quickbooks/reports/accounts-receivable?${query}`
      );
    },
    
    // ==========================================================
    // ACCOUNTS PAYABLE
    // ==========================================================
    
    getAccountsPayable: ({
      startDate
    } = {}) => {
    
      const query = new URLSearchParams({
        organizationId: ORGANIZATION_ID,
        startDate: startDate || "2026-01-01"
      });
    
      return NFK_API._request(
        `/quickbooks/reports/accounts-payable?${query}`
      );
    },

  // ==========================================================
  // ENTITIES
  // ==========================================================

  // These will be connected when their backend routes
  // are implemented.

  getInvoices: () =>
    NFK_API._request(
      `/invoices?organizationId=${ORGANIZATION_ID}`
    ),

  getBills: () =>
    NFK_API._request(
      `/bills?organizationId=${ORGANIZATION_ID}`
    ),

  getCustomers: () =>
    NFK_API._request(
      `/customers?organizationId=${ORGANIZATION_ID}`
    ),

  getVendors: () =>
    NFK_API._request(
      `/vendors?organizationId=${ORGANIZATION_ID}`
    ),

  // ==========================================================
  // KPIs & AI
  // ==========================================================

  getKPIs: () =>
    NFK_API._request(
      `/kpis?organizationId=${ORGANIZATION_ID}`
    ),

  getFinancialHealth: () =>
    NFK_API._request(
      `/financial-health?organizationId=${ORGANIZATION_ID}`
    ),

  askNonakaAI: (question) =>
    NFK_API._request(
      "/ai/chat",
      {
        method: "POST",

        body: JSON.stringify({
          question,
          organizationId: ORGANIZATION_ID
        })
      }
    )
};

// ============================================================
// GLOBAL
// ============================================================

window.NFK_API = NFK_API;