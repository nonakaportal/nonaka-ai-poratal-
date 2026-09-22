
(function () {
  "use strict";

  
  const state = {
    currentPage: "overview",
    clientId: 1,
    qbConnected: false,
    plPeriod: "month",
    cfPeriod: "month",
    bsPeriod: "month",
    overviewPeriod: "month"
  };

  // Conversation history sent to /ai/ask on every turn so NFP AI
  // has multi-turn context. Reset whenever the chat page is opened
  // fresh (see renderNonakaAI).
  let nonakaChatHistory = [];

  // Populated by renderKPIs()/loadKPITrends() — holds each KPI's
  // current value, calculation breakdown, and historical trend so
  // the detail modal can look it up by id when a card is clicked.
  let kpiDetailStore = {};

  const KPI_DEFS = [
    { id: "grossMargin", label: "Gross Margin", format: "pct", interp: "Percentage of revenue left after direct cost of goods sold." },
    { id: "operatingMargin", label: "Operating Margin", format: "pct", interp: "Percentage of revenue left after operating expenses." },
    { id: "netMargin", label: "Net Margin", format: "pct", interp: "Percentage of revenue left as net income after all expenses." },
    { id: "currentRatio", label: "Current Ratio", format: "ratio", interp: "Current assets divided by current liabilities — ability to cover short-term obligations." },
    { id: "debtToEquity", label: "Debt-to-Equity", format: "ratio", interp: "Total liabilities divided by total equity — leverage relative to owner investment." },
    { id: "debtRatio", label: "Debt Ratio", format: "pct", interp: "Percentage of total assets financed by liabilities." },
    { id: "workingCapital", label: "Working Capital", format: "currency", interp: "Current assets minus current liabilities." },
    { id: "daysSalesOutstanding", label: "Days Sales Outstanding", format: "days", interp: "Average days to collect payment after a sale." },
    { id: "daysPayableOutstanding", label: "Days Payable Outstanding", format: "days", interp: "Average days taken to pay vendors." }
  ];

  function formatKPIValue(value, format) {
    if (value === null || !Number.isFinite(value)) return "—";
    if (format === "pct") return `${value.toFixed(1)}%`;
    if (format === "ratio") return `${value.toFixed(2)}x`;
    if (format === "days") return `${value.toFixed(0)} days`;
    if (format === "currency") return formatCurrency(value);
    return String(value);
  }

  // ============================================================
  // API
  // ============================================================

  const API_BASE =
    window.NFK_CONFIG?.API_BASE ||
    "/api";

  function getOrganizationId() {
    return (
      window.NFK_Auth?.getOrganizationId?.() ||
      localStorage.getItem("nfk-organization-id")
    );
  }

  function authHeaders() {
    const token = window.NFK_Auth?.getAccessToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // A single expired/invalid session shows up as every in-flight API call
  // failing at once (a full page load can easily fire 10-20 requests) —
  // without this guard, each one would independently trigger its own
  // logout+redirect. This fires the redirect exactly once and lets the
  // rest of the failures pass through silently since the page is already
  // navigating away.
  let sessionExpiredHandled = false;

  function handleSessionExpired() {
    if (sessionExpiredHandled) return;
    sessionExpiredHandled = true;

    alert("Your session has expired. Please log in again.");
    window.NFK_Auth?.logout?.();
  }

  const SESSION_ERROR_CODES = new Set(["AUTH_INVALID", "AUTH_REQUIRED"]);

  // On an expired/invalid token, silently refresh and retry once before
  // giving up — the user should never see a session error while the
  // portal can still recover on its own. _isRetry guards against looping
  // if the retried request somehow fails the same way again.
  async function apiGet(endpoint, _isRetry = false) {
    const response = await fetch(
      `${API_BASE}${endpoint}`,
      { headers: authHeaders() }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      if (!_isRetry && SESSION_ERROR_CODES.has(data.code)) {
        try {
          await window.NFK_Auth.refreshSession();
          return apiGet(endpoint, true);
        } catch {
          handleSessionExpired();
        }
      }

      const error = new Error(
        data.error || "API request failed"
      );

      if (data.code) {
        error.code = data.code;
      }

      throw error;
    }

    return data;
  }
  async function apiPost(endpoint, body, _isRetry = false) {

      const response = await fetch(
          `${API_BASE}${endpoint}`,
          {
              method: "POST",

              headers: {
                  "Content-Type": "application/json",
                  ...authHeaders()
              },

              body: JSON.stringify(body)
          }
      );

      const data = await response
          .json()
          .catch(() => ({}));

      if (!response.ok) {
          if (!_isRetry && SESSION_ERROR_CODES.has(data.code)) {
              try {
                  await window.NFK_Auth.refreshSession();
                  return apiPost(endpoint, body, true);
              } catch {
                  handleSessionExpired();
              }
          }

          const error = new Error(
              data.error || "API request failed"
          );

          if (data.code) {
              error.code = data.code;
          }

          throw error;
      }

      return data;
  }
// ============================================================
// BALANCE SHEET UI
  // ============================================================
  // BALANCE SHEET
  // ============================================================
  
    function formatCurrency(amount, currency = "USD") {
      const value = Number(amount || 0);
  
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value);
    }
  
  
    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    // Tiny inline trend line for a metric card — reuses whatever monthly
    // history is already on hand (no extra API call). Renders nothing if
    // there isn't enough real data to draw a meaningful line.
    function sparklineSvg(values, width = 100, height = 28) {
      const clean = values.filter(v => Number.isFinite(v));
      if (clean.length < 2) return "";

      const min = Math.min(...clean);
      const max = Math.max(...clean);
      const range = max - min || 1;
      const stepX = width / (values.length - 1);

      const points = values
        .map((v, i) =>
          Number.isFinite(v)
            ? [i * stepX, height - ((v - min) / range) * height]
            : null
        )
        .filter(Boolean);

      if (points.length < 2) return "";

      const d = points
        .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ");

      const [lastX, lastY] = points[points.length - 1];
      const trendUp = clean[clean.length - 1] >= clean[0];
      const color = trendUp ? "var(--positive)" : "var(--negative)";

      return `
        <svg class="stat-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <path d="${d}" fill="none" style="stroke:${color};" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" style="fill:${color};" />
        </svg>
      `;
    }

    // --------------------------------------------------------
    // SKELETON LOADERS
    // Shown while a page's QuickBooks data is being fetched, in place
    // of a plain "Loading..." card.
    // --------------------------------------------------------

    function skeletonLine(width, height = "14px") {
      return `<div class="skeleton-line skeleton-shimmer" style="width:${width};height:${height};"></div>`;
    }

    function renderSkeletonStatGrid(count = 4) {
      return `
        <div class="stat-grid section-gap">
          ${Array.from({ length: count }).map(() => `
            <div class="stat-card">
              ${skeletonLine("50%", "11px")}
              <div style="margin:12px 0 10px;">${skeletonLine("75%", "26px")}</div>
              ${skeletonLine("40%", "12px")}
            </div>
          `).join("")}
        </div>
      `;
    }

    function renderSkeletonCard(lines = 5) {
      return `
        <div class="card card-pad">
          ${Array.from({ length: lines }).map((_, i) =>
            skeletonLine(i % 3 === 0 ? "45%" : i % 2 === 0 ? "85%" : "65%")
          ).join("")}
        </div>
      `;
    }

    // --------------------------------------------------------
    // PERIOD DATE MATH — shared by every "Month / Quarter / Year"
    // toggle across the statements/operations pages.
    //
    // Range reports (P&L, Cash Flow) use getPeriodRange(): the
    // selected period is still in progress, so "Month" means this
    // month to date, "Quarter" means this quarter to date, "Year"
    // means year to date.
    //
    // Snapshot reports (Balance Sheet, AR aging, AP aging) use
    // getPeriodAsOfDate(): a Balance Sheet is cumulative, not bounded
    // to a period, so QuickBooks' own "This Month/Quarter/Year" toggle
    // always shows a live snapshot as of today regardless of which
    // one is selected — this matches that behavior exactly.
    // --------------------------------------------------------

    function toISODate(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }

    function getPeriodRange(period) {
      const now = new Date();
      const endDate = toISODate(now);

      if (period === "current") {
        // Year-to-date — used by pages that don't offer a period
        // toggle (KPIs) so they keep showing the same "current state"
        // view regardless of what's selected elsewhere.
        return { startDate: `${now.getFullYear()}-01-01`, endDate };
      }

      if (period === "quarter") {
        const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
        const start = new Date(now.getFullYear(), qStartMonth, 1);
        return { startDate: toISODate(start), endDate };
      }

      if (period === "year") {
        return { startDate: `${now.getFullYear()}-01-01`, endDate };
      }

      // "month" (default): current month to date
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: toISODate(start), endDate };
    }

    function getPeriodAsOfDate(period) {
      // Balance Sheet is always a live snapshot as of today, no matter
      // which period toggle is selected — same as QuickBooks' own report.
      return toISODate(new Date());
    }

    // The comparison snapshot for the Balance Sheet's period-over-period
    // deltas: the end of the last fully completed month/quarter/year
    // relative to today (getPeriodAsOfDate() itself is always "today").
    function getPriorPeriodAsOfDate(period) {
      const now = new Date();

      if (period === "quarter") {
        const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
        return toISODate(new Date(now.getFullYear(), qStartMonth, 0));
      }

      if (period === "year" || period === "current") {
        return `${now.getFullYear() - 1}-12-31`;
      }

      // "month" (default): last day of the previous completed month
      return toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
    }

    function renderPeriodSelector(activePeriod, onSelectFnName) {
      const periods = [
        { id: "month", label: "Month" },
        { id: "quarter", label: "Quarter" },
        { id: "year", label: "Year" }
      ];

      return `
        <div class="period-selector">
          ${periods.map(p => `
            <button
              class="period-btn ${p.id === activePeriod ? "active" : ""}"
              onclick="NFK_App.${onSelectFnName}('${p.id}')"
            >
              ${p.label}
            </button>
          `).join("")}
        </div>
      `;
    }

    // Minimal markdown renderer for AI-generated text (chat answers,
    // insight narratives). Claude's free-text output routinely includes
    // **bold**, lists, and small pipe tables — dumping that raw through
    // escapeHtml() renders literal asterisks and pipe characters with no
    // line breaks. Escapes first, then applies formatting on top, so
    // this stays as safe as escapeHtml while looking readable.
    function renderMarkdown(text) {
      if (!text) return "";

      const inline = s => {
        let out = escapeHtml(s);
        out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
        out = out.replace(/`([^`]+?)`/g, "<code>$1</code>");
        return out;
      };

      const lines = String(text).replace(/\r\n/g, "\n").split("\n");
      const blocks = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) {
          i++;
          continue;
        }

        const isSepRow = str => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(str);

        if (line.includes("|") && lines[i + 1] && isSepRow(lines[i + 1])) {
          const headerCells = line.split("|").map(c => c.trim()).filter(c => c !== "");
          i += 2;

          const rows = [];
          while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
            rows.push(lines[i].split("|").map(c => c.trim()).filter(c => c !== ""));
            i++;
          }

          blocks.push(
            '<table class="md-table"><thead><tr>' +
            headerCells.map(c => `<th>${inline(c)}</th>`).join("") +
            "</tr></thead><tbody>" +
            rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
            "</tbody></table>"
          );
          continue;
        }

        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
            i++;
          }
          blocks.push("<ul>" + items.map(it => `<li>${inline(it)}</li>`).join("") + "</ul>");
          continue;
        }

        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
            i++;
          }
          blocks.push("<ol>" + items.map(it => `<li>${inline(it)}</li>`).join("") + "</ol>");
          continue;
        }

        const paraLines = [line];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^\s*[-*]\s+/.test(lines[i]) &&
          !/^\s*\d+[.)]\s+/.test(lines[i]) &&
          !(lines[i].includes("|") && lines[i + 1] && isSepRow(lines[i + 1]))
        ) {
          paraLines.push(lines[i]);
          i++;
        }
        blocks.push(`<p>${paraLines.map(inline).join("<br>")}</p>`);
      }

      return blocks.join("");
    }


    async function loadBalanceSheet(period = "month") {
      const organizationId = getOrganizationId();

      if (!organizationId) {
        throw new Error(
          "Organization ID is missing. Please log in first."
        );
      }

      console.log(
        "⚖️ Loading Balance Sheet for:",
        organizationId,
        period
      );

      const asOfDate = getPeriodAsOfDate(period);

      const data = await apiGet(
        `/quickbooks/reports/balance-sheet?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          asOfDate
        )}`
      );

      console.log("✅ Balance Sheet received:", data);

      return data;
    }

    // Fetches the current period's snapshot plus the equivalent snapshot
    // one full period further back, so the page can show a $/% delta
    // instead of just a static number. fetchBalanceSheetAsOf is defined
    // further down in this file but hoisted, so it's callable here.
    async function loadBalanceSheetComparison(period = "month") {
      const currentDate = getPeriodAsOfDate(period);
      const priorDate = getPriorPeriodAsOfDate(period);

      const [current, prior] = await Promise.all([
        fetchBalanceSheetAsOf(currentDate),
        fetchBalanceSheetAsOf(priorDate).catch(() => null)
      ]);

      return { current, prior };
    }

    // Six monthly Balance Sheet snapshots (as of the end of each of the
    // last 6 calendar months) for the Assets/Liabilities/Equity trend
    // chart. Fetched in parallel — a single-report snapshot call per
    // month, same load as the KPI/Scenarios trend fetches already do.
    async function loadBalanceSheetHistory(months = 6) {
      const periods = getMonthlyPeriods(months);

      // Sequential, not Promise.all — this page can already have the
      // comparison fetch (2 calls) in flight at the same time, and
      // firing 6+ concurrent QuickBooks report calls is what tripped
      // the sandbox's rate limit for the AI forecast trend earlier.
      const results = [];

      for (const p of periods) {
        results.push(
          await fetchBalanceSheetAsOf(p.endDate).catch(() => null)
        );
      }

      return periods.map((p, i) => {
        const bs = results[i];

        return {
          label: p.label,
          totalAssets: Number.isFinite(bs?.totalAssets) ? bs.totalAssets : null,
          totalLiabilities: Number.isFinite(bs?.totalLiabilities) ? bs.totalLiabilities : null,
          totalEquity: Number.isFinite(bs?.totalEquity) ? bs.totalEquity : null
        };
      });
    }


    function renderBalanceAccounts(
      accounts,
      currency
    ) {
      if (!Array.isArray(accounts) || accounts.length === 0) {
        return `
          <div class="statement-empty">
            No accounts found.
          </div>
        `;
      }
  
      return accounts
        .map(account => {
          const name =
            account.name ||
            account.accountName ||
            account.account_name ||
            "Unnamed Account";
  
          const amount =
            account.amount ??
            account.value ??
            account.balance ??
            0;
  
          return `
            <div class="statement-row">
  
              <span class="statement-account-name">
                ${escapeHtml(name)}
              </span>
  
              <strong class="statement-account-value">
                ${formatCurrency(
                  amount,
                  currency
                )}
              </strong>
  
            </div>
          `;
        })
        .join("");
    }
  
  
    function renderBalanceSection(
      title,
      accounts,
      total,
      currency,
      icon
    ) {
      return `
        <div class="card statement-card">
  
          <div class="statement-section-header">
  
            <div class="statement-section-title">
  
              <span class="statement-section-icon">
                ${icon}
              </span>
  
              <div>
                <h2>
                  ${title}
                </h2>
  
                <span>
                  ${
                    Array.isArray(accounts)
                      ? accounts.length
                      : 0
                  }
                  accounts
                </span>
              </div>
  
            </div>
  
            <strong class="statement-section-total">
              ${formatCurrency(
                total,
                currency
              )}
            </strong>
  
          </div>
  
  
          <div class="statement-rows">
  
            ${renderBalanceAccounts(
              accounts,
              currency
            )}
  
          </div>
  
  
          <div class="statement-total">
  
            <span>
              Total ${title}
            </span>
  
            <strong>
              ${formatCurrency(
                total,
                currency
              )}
            </strong>
  
          </div>
  
        </div>
      `;
    }
  
  
   function renderBalanceSheet(data, priorData = null) {

    const page =
        document.getElementById("page-balance-sheet");

    if (!page) {
        console.error("❌ Balance Sheet page not found");
        return;
    }

    function priorTotal(field) {
        const value = priorData?.[field];
        return Number.isFinite(value) ? value : null;
    }

    function deltaHtml(current, priorValue) {
        if (priorValue === null || priorValue === 0) {
            return `<div class="bs-delta stat-sub-quiet">No comparable prior period</div>`;
        }

        const pct = ((current - priorValue) / Math.abs(priorValue)) * 100;
        const up = pct >= 0;

        return `
            <div class="bs-delta ${up ? "pos" : "neg"}">
                ${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%
                <span class="stat-sub-quiet">vs ${formatCurrency(priorValue, data?.currency || "USD")} prior period</span>
            </div>
        `;
    }

    const currency =
        data?.currency || "USD";

    const assets =
        Array.isArray(data?.details?.assets)
            ? data.details.assets
            : [];

    const liabilities =
        Array.isArray(data?.details?.liabilities)
            ? data.details.liabilities
            : [];

    const equity =
        Array.isArray(data?.details?.equity)
            ? data.details.equity
            : [];


    const totalAssets =
        Number(data?.totalAssets || 0);

    const totalLiabilities =
        Number(data?.totalLiabilities || 0);

    const totalEquity =
        Number(data?.totalEquity || 0);

    const totalLiabilitiesAndEquity =
        Number(
            data?.totalLiabilitiesAndEquity ||
            totalLiabilities + totalEquity
        );


    const difference =
        totalAssets -
        totalLiabilitiesAndEquity;

    const isBalanced =
        Math.abs(difference) < 0.01;


    // =========================================================
    // HELPERS
    // =========================================================

    function accountName(account) {

        return (
            account?.name ||
            account?.accountName ||
            account?.account_name ||
            "Unnamed Account"
        );

    }


    function accountAmount(account) {

        return Number(
            account?.amount ??
            account?.value ??
            account?.balance ??
            0
        );

    }


    function renderAccount(account) {

        const value =
            accountAmount(account);

        return `
            <div class="bs-account-row">

                <span>
                    ${escapeHtml(
                        accountName(account)
                    )}
                </span>

                <strong class="${
                    value < 0
                        ? "negative"
                        : ""
                }">
                    ${formatCurrency(
                        value,
                        currency
                    )}
                </strong>

            </div>
        `;

    }


    function renderSection(section) {

        if (!section) {
            return "";
        }


        const name =
            section?.name ||
            "Other";


        const children =
            Array.isArray(section?.children)
                ? section.children
                : [];


        let sectionTotal;


        if (
            section?.summary &&
            section.summary.amount !== undefined
        ) {

            sectionTotal =
                Number(
                    section.summary.amount
                ) || 0;

        } else {

            sectionTotal =
                Number(
                    section?.amount
                ) || 0;

        }


        return `

            <div class="bs-section">

                <div class="bs-section-header">

                    <span>
                        ${escapeHtml(name)}
                    </span>

                    <strong>
                        ${formatCurrency(
                            sectionTotal,
                            currency
                        )}
                    </strong>

                </div>


                <div class="bs-section-accounts">

                  ${
                      children.length
                          ? children
                              .map(renderAccount)
                              .join("")
                          : `
                              <div class="bs-account-row">
              
                                  <span>
                                      ${escapeHtml(
                                          section?.name || "Unnamed"
                                      )}
                                  </span>
              
                                  <strong class="${
                                      sectionTotal < 0
                                          ? "negative"
                                          : ""
                                  }">
                                      ${formatCurrency(
                                          sectionTotal,
                                          currency
                                      )}
                                  </strong>
              
                              </div>
                          `
                  }
              
              </div>
              
            </div>

        `;

    }


    function renderSections(sections) {

        if (
            !Array.isArray(sections) ||
            !sections.length
        ) {

            return `
                <div class="bs-empty">
                    No accounts returned
                    by QuickBooks.
                </div>
            `;

        }


        return sections
            .map(renderSection)
            .join("");

    }


    function countAccounts(sections) {

        return sections.reduce(
            (total, section) => {

                const children =
                    Array.isArray(
                        section?.children
                    )
                        ? section.children
                        : [];

                return (
                    total +
                    children.length
                );

            },
            0
        );

    }


    // =========================================================
    // PAGE
    // =========================================================

    page.innerHTML = `

        <div class="bs-page">


            <!-- HEADER -->

            <div class="bs-header">

                <div>

                    <div class="bs-title">
                        What you own &amp; owe
                        <span class="page-title-term">Balance Sheet</span>
                    </div>

                    <div class="bs-subtitle">

                        As of
                        ${escapeHtml(
                            data?.period?.endDate ||
                            "—"
                        )}

                        ·

                        ${escapeHtml(
                            data?.reportBasis ||
                            "Accrual"
                        )}

                    </div>

                </div>


                <div class="bs-header-right">

                    ${renderPeriodSelector(state.bsPeriod, "setBSPeriod")}

                    <div class="
                        bs-status
                        ${
                            isBalanced
                                ? "balanced"
                                : "unbalanced"
                        }
                    ">

                        ${
                            isBalanced
                                ? "✓ BALANCED"
                                : "⚠ NOT BALANCED"
                        }

                    </div>

                    <div class="statement-badge">
                        ${escapeHtml(currency)}
                    </div>

                </div>

            </div>

            ${
                data?.hasData === false
                    ? `
                        <div class="bs-no-data-banner">
                            <strong>No QuickBooks data as of ${escapeHtml(data?.period?.endDate || "this date")}.</strong>
                            <p>This company's books don't go back that far yet — try a more recent period.</p>
                        </div>
                    `
                    : ""
            }

            <!-- THREE COLUMNS -->

            <div class="bs-columns">


                <!-- ASSETS -->

                <section class="bs-card">

                    <div class="
                        bs-card-top
                        assets
                    ">

                        <div>

                            <span class="bs-card-label">
                                ASSETS
                            </span>

                            <h2>
                                ${formatCurrency(
                                    totalAssets,
                                    currency
                                )}
                            </h2>

                            ${deltaHtml(totalAssets, priorTotal("totalAssets"))}

                        </div>

                        <span class="bs-count">
                            ${countAccounts(assets)}
                            accounts
                        </span>

                    </div>


                    <div class="bs-card-body">

                        ${renderSections(
                            assets
                        )}


                        <div class="bs-total">

                            <span>
                                Total Assets
                            </span>

                            <strong>
                                ${formatCurrency(
                                    totalAssets,
                                    currency
                                )}
                            </strong>

                        </div>

                    </div>

                </section>


                <!-- LIABILITIES -->

                <section class="bs-card">

                    <div class="
                        bs-card-top
                        liabilities
                    ">

                        <div>

                            <span class="bs-card-label">
                                LIABILITIES
                            </span>

                            <h2>
                                ${formatCurrency(
                                    totalLiabilities,
                                    currency
                                )}
                            </h2>

                            ${deltaHtml(totalLiabilities, priorTotal("totalLiabilities"))}

                        </div>

                        <span class="bs-count">
                            ${countAccounts(
                                liabilities
                            )}
                            accounts
                        </span>

                    </div>


                    <div class="bs-card-body">

                        ${renderSections(
                            liabilities
                        )}


                        <div class="bs-total">

                            <span>
                                Total Liabilities
                            </span>

                            <strong>
                                ${formatCurrency(
                                    totalLiabilities,
                                    currency
                                )}
                            </strong>

                        </div>

                    </div>

                </section>


                <!-- EQUITY -->

                <section class="bs-card">

                    <div class="
                        bs-card-top
                        equity
                    ">

                        <div>

                            <span class="bs-card-label">
                                EQUITY
                            </span>

                            <h2 class="${
                                totalEquity < 0
                                    ? "negative"
                                    : ""
                            }">
                                ${formatCurrency(
                                    totalEquity,
                                    currency
                                )}
                            </h2>

                            ${deltaHtml(totalEquity, priorTotal("totalEquity"))}

                        </div>

                        <span class="bs-count">
                            ${countAccounts(equity)}
                            accounts
                        </span>

                    </div>


                    <div class="bs-card-body">

                        ${renderSections(
                            equity
                        )}


                        <div class="bs-total">

                            <span>
                                Total Equity
                            </span>

                            <strong class="${
                                totalEquity < 0
                                    ? "negative"
                                    : ""
                            }">
                                ${formatCurrency(
                                    totalEquity,
                                    currency
                                )}
                            </strong>

                        </div>

                    </div>

                </section>


            </div>


            <!-- BALANCE CHECK -->

            <section class="
                bs-check
                ${
                    isBalanced
                        ? "success"
                        : "error"
                }
            ">

                <div class="bs-check-left">

                    <div class="bs-check-icon">
                        ${
                            isBalanced
                                ? "✓"
                                : "!"
                        }
                    </div>

                    <div>

                        <strong>
                            Balance Check
                        </strong>

                        <span>
                            Assets should equal
                            Liabilities + Equity
                        </span>

                    </div>

                </div>


                <div class="bs-check-values">

                    <div>

                        <span>
                            Assets
                        </span>

                        <strong>
                            ${formatCurrency(
                                totalAssets,
                                currency
                            )}
                        </strong>

                    </div>


                    <div class="bs-check-equals">
                        =
                    </div>


                    <div>

                        <span>
                            Liabilities + Equity
                        </span>

                        <strong>
                            ${formatCurrency(
                                totalLiabilitiesAndEquity,
                                currency
                            )}
                        </strong>

                    </div>


                    <div class="bs-check-result">

                        ${
                            isBalanced
                                ? "✓ Balanced"
                                : `Difference: ${
                                    formatCurrency(
                                        difference,
                                        currency
                                    )
                                }`
                        }

                    </div>

                </div>

            </section>


            <!-- TREND -->

            <div class="card card-pad section-gap" style="margin-top:16px;">
                <div class="card-title" style="margin-bottom:14px;">Assets, Liabilities &amp; Equity — 6 Months</div>
                <div style="height:300px;">
                    <canvas id="chart-bs-trend"></canvas>
                </div>
            </div>


        </div>

    `;

    loadBalanceSheetHistory(6)
        .then(history => {
            if (window.NFK_Charts?.renderForecastTrend) {
                window.NFK_Charts.renderForecastTrend(
                    "chart-bs-trend",
                    history,
                    {
                        title: "Assets, Liabilities & Equity",
                        metrics: [
                            { key: "totalAssets", label: "Assets", color: "primary" },
                            { key: "totalLiabilities", label: "Liabilities", color: "danger" },
                            { key: "totalEquity", label: "Equity", color: "success" }
                        ]
                    },
                    "line"
                );
            }
        })
        .catch(error => {
            console.error("❌ Balance Sheet trend failed:", error);
        });
}

    async function setBSPeriod(period) {
      state.bsPeriod = period;

      const page = document.getElementById("page-balance-sheet");

      if (page) {
        page.innerHTML = renderSkeletonCard(10);
      }

      try {
        const { current, prior } = await loadBalanceSheetComparison(period);
        renderBalanceSheet(current, prior);
      } catch (error) {
        console.error("❌ Failed to load Balance Sheet for period:", period, error);
      }
    }

// ============================================================
// PROFIT & LOSS
// ============================================================

    async function loadProfitAndLoss(period = "month") {
      const organizationId = getOrganizationId();

      if (!organizationId) {
        throw new Error(
          "Organization ID is missing. Please log in first."
        );
      }

      console.log(
        "📊 Loading Profit & Loss for:",
        organizationId,
        period
      );

      const { startDate, endDate } = getPeriodRange(period);

      const data = await apiGet(
        `/quickbooks/reports/profit-and-loss?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          startDate
        )}&endDate=${encodeURIComponent(
          endDate
        )}`
      );

      console.log(
        "✅ Profit & Loss received:",
        data
      );

      return data;
    }
    async function loadInvoices() {
    
        const organizationId =
            getOrganizationId();
    
        if (!organizationId) {
    
            console.error(
                "❌ Organization ID is missing"
            );
    
            throw new Error(
                "Organization ID is missing"
            );
        }
    
        console.log(
            "📄 Loading invoices for:",
            organizationId
        );
    
        try {
    
            const data =
                await apiGet(
                    `/quickbooks/invoices?organizationId=${encodeURIComponent(
                        organizationId
                    )}`
                );
    
            console.log(
                "📄 Invoice API response:",
                data
            );
    
            return data;
    
        } catch (error) {
    
            console.error(
                "❌ Failed to load invoices:",
                error
            );
    
            throw error;
        }
    }
    async function loadDebt() {
    
        const organizationId =
            getOrganizationId();
    
        if (!organizationId) {
    
            console.error(
                "❌ Organization ID is missing"
            );
    
            throw new Error(
                "Organization ID is missing"
            );
        }
    
        console.log(
            "💳 Loading debt for:",
            organizationId
        );
    
        try {
    
            const data =
                await apiGet(
                    `/quickbooks/debt?organizationId=${encodeURIComponent(
                        organizationId
                    )}`
                );
    
            console.log(
                "💳 Debt API response:",
                data
            );
    
            return data;
    
        } catch (error) {
    
            console.error(
                "❌ Failed to load debt:",
                error
            );
    
            throw error;
        }
    }
    
    
    function renderProfitAndLoss(data) {
    
        const page =
            document.getElementById("page-pl");
    
        if (!page) {
            console.error("❌ Profit & Loss page not found");
            return;
        }
    
        const currency =
            data?.currency || "USD";
    
        console.log("NORMALIZED P&L DATA:", data);
    
        // ==========================================================
        // ACCOUNT DETAILS FROM PARSER
        // ==========================================================
    
        const accounts =
            data?.accounts || {};
    
        const income =
            Array.isArray(accounts.income)
                ? accounts.income
                : [];
    
        const costOfGoodsSold =
            Array.isArray(accounts.cogs)
                ? accounts.cogs
                : [];
    
        const expenses =
            Array.isArray(accounts.expenses)
                ? accounts.expenses
                : [];
    
        const otherIncomeExpense =
            Array.isArray(accounts.otherIncomeExpense)
                ? accounts.otherIncomeExpense
                : [];
    
    
        // ==========================================================
        // TOTALS
        // ==========================================================
    
        const totalIncome =
            Number(data?.income || 0);
    
        const totalCOGS =
            Number(data?.costOfGoodsSold || 0);
    
        const totalExpenses =
            Number(data?.expenses || 0);
    
        const grossProfit =
            Number(
                data?.grossProfit ??
                (totalIncome - totalCOGS)
            );
    
        const operatingIncome =
            Number(
                data?.netOperatingIncome ??
                (grossProfit - totalExpenses)
            );
    
        const otherExpenses =
            Number(data?.otherExpenses || 0);

        // QuickBooks' NetOtherIncome group is already net
        // (Other Income − Other Expenses) — same convention as
        // NetOperatingIncome and NetIncome elsewhere in this same
        // report. Subtracting otherExpenses again here would
        // double-count it.
        const netOtherIncome =
            Number(data?.netOtherIncome || 0);

        const otherNet =
            netOtherIncome;
    
        const netIncome =
            Number(
                data?.netIncome ??
                (operatingIncome + otherNet)
            );
    
    
        // ==========================================================
        // HELPERS
        // ==========================================================
    
        function accountName(account) {
    
            return (
                account?.name ||
                account?.accountName ||
                account?.account_name ||
                "Unnamed Account"
            );
    
        }
    
    
        function accountAmount(account) {
    
            return Number(
                account?.amount ??
                account?.value ??
                account?.balance ??
                0
            );
    
        }
    
    
        function renderAccountRows(accounts) {

            if (
                !Array.isArray(accounts) ||
                accounts.length === 0
            ) {
                return "";
            }

            // Accounts nested under a QuickBooks sub-category
            // (e.g. "Gas & Electric" under "Utilities") carry
            // that category's name in _group. Emit a label row
            // whenever the group changes so the real QuickBooks
            // hierarchy is visible instead of one flat list.
            let html = "";
            let currentGroup;

            accounts.forEach(account => {

                const group =
                    account?._group || null;

                if (group !== currentGroup) {

                    currentGroup = group;

                    if (group) {
                        html += `
                            <tr class="pl-group-row">
                                <td colspan="2">
                                    ${escapeHtml(group)}
                                </td>
                            </tr>
                        `;
                    }
                }

                const value =
                    accountAmount(account);

                html += `
                    <tr class="pl-account-row">

                        <td class="${group ? "pl-indent-2" : "pl-indent"}">
                            ${escapeHtml(
                                accountName(account)
                            )}
                        </td>

                        <td class="pl-number">
                            ${formatCurrency(
                                value,
                                currency
                            )}
                        </td>

                    </tr>
                `;
            });

            return html;

        }
    
    
        function renderSection(
            title,
            accounts,
            total,
            className = ""
        ) {
    
            return `
                <tr class="
                    pl-section-row
                    ${className}
                ">
    
                    <td>
                        <strong>
                            ${escapeHtml(title)}
                        </strong>
                    </td>
    
                    <td class="pl-number">
                        <strong>
                            ${formatCurrency(
                                total,
                                currency
                            )}
                        </strong>
                    </td>
    
                </tr>
    
                ${renderAccountRows(accounts)}
            `;
    
        }
    
    
        function renderTotal(
            title,
            value,
            className = "",
            valueColorClass = ""
        ) {

            return `
                <tr class="
                    pl-total-row
                    ${className}
                ">

                    <td>
                        <strong>
                            ${escapeHtml(title)}
                        </strong>
                    </td>

                    <td class="pl-number ${valueColorClass}">

                        <strong>
                            ${formatCurrency(
                                value,
                                currency
                            )}
                        </strong>

                    </td>

                </tr>
            `;

        }
    
    
        // ==========================================================
        // PAGE
        // ==========================================================
    
        page.innerHTML = `
    
            <div class="pl-page">
    
                <!-- HEADER -->
    
                <div class="pl-page-header">
    
                    <div>
    
                        <div class="pl-page-title">
                            What you kept
                            <span class="page-title-term">Profit &amp; Loss</span>
                        </div>
    
                        <div class="pl-page-subtitle">
    
                            ${escapeHtml(
                                data?.period?.startDate || "—"
                            )}
    
                            →
    
                            ${escapeHtml(
                                data?.period?.endDate || "—"
                            )}
    
                            ·
    
                            ${escapeHtml(
                                data?.reportBasis || "Accrual"
                            )}
    
                        </div>
    
                    </div>
    
    
                    <div class="pl-header-actions">

                        ${renderPeriodSelector(state.plPeriod, "setPLPeriod")}

                        <div class="statement-badge">
                            ${escapeHtml(currency)}
                        </div>

                    </div>

                </div>
    
    
                <!-- FINANCIAL STATEMENT -->
    
                <div class="pl-table-card">
    
                    <div class="pl-table-header">
    
                        <div>
    
                            <h2>
                                Profit & Loss Statement
                            </h2>
    
                            <p>
                                Actual financial data from QuickBooks
                            </p>
    
                        </div>
    
                        <span class="pl-live-badge">
                            ● QuickBooks Data
                        </span>
    
                    </div>
    
    
                    <div class="pl-table-wrapper">
    
                        <table class="pl-table">
    
                            <thead>
    
                                <tr>
    
                                    <th>
                                        Line Item
                                    </th>
    
                                    <th class="pl-number">
                                        Current Period
                                    </th>
    
                                </tr>
    
                            </thead>
    
    
                            <tbody>
    
                                <!-- REVENUE -->
    
                                ${renderSection(
                                    "Revenue",
                                    income,
                                    totalIncome,
                                    "income-section"
                                )}
    
    
                                <!-- COGS -->
    
                                ${renderSection(
                                    "Cost of Goods Sold",
                                    costOfGoodsSold,
                                    totalCOGS,
                                    "cogs-section"
                                )}
    
    
                                <!-- GROSS PROFIT -->
    
                                ${renderTotal(
                                    "Gross Profit",
                                    grossProfit,
                                    "gross-profit-row"
                                )}
    
    
                                <!-- OPERATING EXPENSES -->
    
                                ${renderSection(
                                    "Operating Expenses",
                                    expenses,
                                    totalExpenses,
                                    "expense-section"
                                )}
    
    
                                <!-- OPERATING INCOME -->
    
                                ${renderTotal(
                                    "Operating Income (EBIT)",
                                    operatingIncome,
                                    "operating-income-row"
                                )}
    
    
                                <!-- OTHER INCOME / EXPENSE -->
    
                                ${
                                    otherNet !== 0 ||
                                    otherIncomeExpense.length > 0
    
                                    ? `
    
                                        <tr class="
                                            pl-section-row
                                            other-section
                                        ">
    
                                            <td>
                                                <strong>
                                                    Other Income / Expense
                                                </strong>
                                            </td>
    
                                            <td class="pl-number">
                                                <strong>
                                                    ${formatCurrency(
                                                        otherNet,
                                                        currency
                                                    )}
                                                </strong>
                                            </td>
    
                                        </tr>
    
                                        ${renderAccountRows(
                                            otherIncomeExpense
                                        )}
    
                                    `
    
                                    : ""
                                }
    
    
                                <!-- OTHER EXPENSES FALLBACK -->
    
                                ${
                                    otherExpenses !== 0 &&
                                    otherIncomeExpense.length === 0
    
                                    ? `
    
                                        <tr class="pl-account-row">
    
                                            <td class="pl-indent">
                                                Other Expenses
                                            </td>
    
                                            <td class="pl-number">
                                                ${formatCurrency(
                                                    -Math.abs(
                                                        otherExpenses
                                                    ),
                                                    currency
                                                )}
                                            </td>
    
                                        </tr>
    
                                    `
    
                                    : ""
                                }
    
    
                                <!-- PROFIT -->

                                ${renderTotal(
                                    "Profit",
                                    netIncome,
                                    "pl-profit-row",
                                    netIncome >= 0
                                        ? "pl-profit-positive"
                                        : "pl-profit-negative"
                                )}
    
                            </tbody>
    
                        </table>
    
                    </div>
    
                </div>
    
    
                <!-- DATA NOTE -->
    
                <div class="pl-data-note">
    
                    <span>
                        🔄
                    </span>
    
                    <div>
    
                        <strong>
                            Live QuickBooks financial data
                        </strong>
    
                        <p>
                            Account balances are retrieved
                            from your connected QuickBooks company.
                        </p>
    
                    </div>
    
                </div>
    
            </div>

        `;
    }

    async function setPLPeriod(period) {
      state.plPeriod = period;

      const page = document.getElementById("page-pl");

      if (page) {
        page.innerHTML = renderSkeletonCard(10);
      }

      try {
        const data = await loadProfitAndLoss(period);
        renderProfitAndLoss(data);
      } catch (error) {
        console.error("❌ Failed to load Profit & Loss for period:", period, error);
      }
    }

    /* ============================================================
       ACCOUNTS PAYABLE
       ============================================================ */
    
    function renderAccountsPayable(data) {
    
        const page =
            document.getElementById(
                "page-ap-vendors"
            );
    
        if (!page) return;
    
        const aging =
            data?.aging || {};
    
        const vendors =
            data?.vendors || [];
    
        const total =
            Number(data?.total || 0);
    
        const getStatus = vendor => {
    
            if (Number(vendor.over90) > 0)
                return "90+ days";
    
            if (Number(vendor.days61to90) > 0)
                return "61–90 days";
    
            if (Number(vendor.days31to60) > 0)
                return "31–60 days";
    
            if (Number(vendor.days1to30) > 0)
                return "1–30 days";
    
            return "Current";
        };
    
        page.innerHTML = `
    
            <div class="page-header">
    
                <div>
                    <div class="page-title">
                        Bills to pay
                        <span class="page-title-term">Accounts Payable</span>
                    </div>
    
                    <div class="page-subtitle">
                        From QuickBooks
                    </div>
                </div>
    
            </div>
    
    
            <div class="card card-pad">
    
                <div class="card-header">
    
                    <span class="card-title">
                        Accounts Payable
                    </span>
    
                    <strong>
                        ${fmt(total)}
                    </strong>
    
                </div>
    
                <div>
    
                    Current:
                    <strong>
                        ${fmt(aging.current)}
                    </strong>
    
                    &nbsp;&nbsp;
    
                    1–30:
                    <strong>
                        ${fmt(aging.days1to30)}
                    </strong>
    
                    &nbsp;&nbsp;
    
                    31–60:
                    <strong>
                        ${fmt(aging.days31to60)}
                    </strong>
    
                    &nbsp;&nbsp;
    
                    61–90:
                    <strong>
                        ${fmt(aging.days61to90)}
                    </strong>
    
                    &nbsp;&nbsp;
    
                    90+:
                    <strong>
                        ${fmt(aging.over90)}
                    </strong>
    
                </div>
    
            </div>
    
    
            <div class="table-wrap">
    
                <table>
    
                    <thead>
    
                        <tr>
                            <th>Vendor</th>
                            <th class="num">Amount</th>
                            <th>Status</th>
                        </tr>
    
                    </thead>
    
                    <tbody>
    
                        ${vendors.map(vendor => `
    
                            <tr>
    
                                <td>
                                    ${escapeHtml(
                                        vendor.name
                                    )}
                                </td>
    
                                <td class="num">
                                    ${fmt(
                                        vendor.amount
                                    )}
                                </td>
    
                                <td>
                                    ${getStatus(vendor)}
                                </td>
    
                            </tr>
    
                        `).join("")}
    
                    </tbody>
    
                </table>
    
            </div>
        `;
    }
    
// ============================================================
// CASH FLOW
// ============================================================

    async function loadCashFlow(period = "month") {

      const organizationId =
        getOrganizationId();

      if (!organizationId) {
        throw new Error(
          "Organization ID is missing. Please log in first."
        );
      }

      const { startDate, endDate } = getPeriodRange(period);

      console.log(
        "💵 Loading Cash Flow for:",
        organizationId,
        period
      );
    
      const data = await apiGet(
        `/quickbooks/reports/cash-flow?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          startDate
        )}&endDate=${encodeURIComponent(
          endDate
        )}`
      );
    
      console.log(
        "✅ Cash Flow received:",
        data
      );
    
      return data;
    }
    
    
function renderCashFlow(data) {

    const page =
        document.getElementById(
            "page-cash-flow"
        );

    if (!page) return;


    const currency =
        data?.currency || "USD";

    const period =
        data?.period || {};


    const details =
        data?.details || {};


    const operating =
        Array.isArray(
            details.operatingActivities
        )
            ? details.operatingActivities
            : [];


    const investing =
        Array.isArray(
            details.investingActivities
        )
            ? details.investingActivities
            : [];


    const financing =
        Array.isArray(
            details.financingActivities
        )
            ? details.financingActivities
            : [];


    const operatingTotal =
        Number(
            data?.operatingActivities || 0
        );


    const investingTotal =
        Number(
            data?.investingActivities || 0
        );


    const financingTotal =
        Number(
            data?.financingActivities || 0
        );


    const netChange =
        Number(
            data?.cashIncrease || 0
        );


    const openingCash =
        Number(
            data?.openingCash || 0
        );


    const closingCash =
        Number(
            data?.closingCash ||
            data?.endingCash ||
            0
        );


    function amount(value) {

        return fmt(
            Number(value || 0)
        );

    }


    function signedAmount(value) {

        const n =
            Number(value || 0);

        return n < 0
            ? `-${fmt(Math.abs(n))}`
            : `+${fmt(n)}`;

    }


    function valueClass(value) {

        return Number(value || 0) < 0
            ? "cf-negative"
            : "cf-positive";

    }


    function renderRows(accounts) {

        if (!accounts.length) {

            return `
                <div class="cf-no-data">
                    No account activity available.
                </div>
            `;

        }


        return accounts.map(account => {

            const value =
                Number(
                    account?.amount || 0
                );


            return `
                <div class="cf-row">

                    <span class="cf-row-name">
                        ${escapeHtml(
                            account?.name ||
                            "Unnamed Account"
                        )}
                    </span>

                    <strong class="
                        cf-row-value
                        ${valueClass(value)}
                    ">
                        ${signedAmount(value)}
                    </strong>

                </div>
            `;

        }).join("");

    }


    function activityCard(
        title,
        icon,
        accounts,
        total
    ) {

        return `
            <section class="cf-activity-card">

                <div class="cf-activity-head">

                    <div class="cf-activity-title">

                        <span class="cf-activity-icon">
                            ${icon}
                        </span>

                        <span>
                            ${title}
                        </span>

                    </div>

                    <strong class="
                        cf-activity-total
                        ${valueClass(total)}
                    ">
                        ${signedAmount(total)}
                    </strong>

                </div>


                <div class="cf-row-list">

                    ${renderRows(accounts)}

                </div>


                <div class="cf-activity-footer">

                    <span>
                        Net ${title}
                    </span>

                    <strong class="
                        ${valueClass(total)}
                    ">
                        ${signedAmount(total)}
                    </strong>

                </div>

            </section>
        `;

    }


    page.innerHTML = `

        <div class="cf-dashboard">


            <!-- HEADER -->

            <div class="cf-header">

                <div>

                    <h1>
                        Money in &amp; out
                        <span class="page-title-term">Cash Flow</span>
                    </h1>

                    <p>
                        ${escapeHtml(
                            period.startDate || "—"
                        )}

                        →

                        ${escapeHtml(
                            period.endDate || "—"
                        )}

                        ·

                        ${escapeHtml(
                            data?.reportBasis ||
                            "Accrual"
                        )}
                    </p>

                </div>


                <div class="cf-header-right">

                    ${renderPeriodSelector(state.cfPeriod, "setCFPeriod")}

                </div>

            </div>


            <!-- WATERFALL -->

            <section class="cf-waterfall">

                <div class="cf-waterfall-head">

                    <h2>
                        Cash Waterfall —
                        Opening to Closing
                    </h2>

                    <span>

                        Opening
                        <strong>
                            ${amount(openingCash)}
                        </strong>

                        →

                        Closing
                        <strong>
                            ${amount(closingCash)}
                        </strong>

                    </span>

                </div>


                <div class="cf-chart-wrap">

                    <canvas
                        id="chart-waterfall"
                    ></canvas>

                </div>

            </section>


            <!-- ACTIVITY CARDS -->

            <div class="cf-activities">

                ${activityCard(
                    "Operating Activities",
                    "🏢",
                    operating,
                    operatingTotal
                )}

                ${activityCard(
                    "Investing Activities",
                    "📈",
                    investing,
                    investingTotal
                )}

                ${activityCard(
                    "Financing Activities",
                    "🏦",
                    financing,
                    financingTotal
                )}

            </div>


            <!-- BOTTOM SUMMARY -->

            <section class="cf-summary">

                <div class="cf-summary-item">

                    <span>
                        Opening Cash
                    </span>

                    <strong>
                        ${amount(openingCash)}
                    </strong>

                </div>


                <div class="cf-summary-item">

                    <span>
                        Operating
                    </span>

                    <strong class="
                        ${valueClass(
                            operatingTotal
                        )}
                    ">
                        ${signedAmount(
                            operatingTotal
                        )}
                    </strong>

                </div>


                <div class="cf-summary-item">

                    <span>
                        Investing
                    </span>

                    <strong class="
                        ${valueClass(
                            investingTotal
                        )}
                    ">
                        ${signedAmount(
                            investingTotal
                        )}
                    </strong>

                </div>


                <div class="cf-summary-item">

                    <span>
                        Financing
                    </span>

                    <strong class="
                        ${valueClass(
                            financingTotal
                        )}
                    ">
                        ${signedAmount(
                            financingTotal
                        )}
                    </strong>

                </div>


                <div class="
                    cf-summary-item
                    cf-summary-closing
                ">

                    <span>
                        Closing Cash Balance
                    </span>

                    <strong>
                        ${amount(closingCash)}
                    </strong>

                </div>

            </section>


            <!-- NET CHANGE -->

            <div class="cf-net-change">

                <div>

                    <span class="cf-net-icon">
                        💰
                    </span>

                    <div>

                        <strong>
                            Net Change in Cash
                        </strong>

                        <small>
                            Operating + Investing + Financing
                        </small>

                    </div>

                </div>


                <strong class="
                    cf-net-value
                    ${valueClass(netChange)}
                ">
                    ${signedAmount(netChange)}
                </strong>

            </div>

        </div>

    `;


    // ==========================================================
    // REAL QUICKBOOKS WATERFALL
    // ==========================================================

    if (
        window.NFK_Charts &&
        typeof
        window.NFK_Charts.renderCashWaterfall ===
        "function"
    ) {

        setTimeout(() => {

            window.NFK_Charts.renderCashWaterfall({

                labels: [
                    "Opening Cash",
                    "Operating CF",
                    "Investing CF",
                    "Financing CF",
                    "Closing Cash"
                ],

                values: [
                    openingCash,
                    operatingTotal,
                    investingTotal,
                    financingTotal,
                    closingCash
                ],

                types: [
                    "neutral",
                    "positive",
                    "negative",
                    "negative",
                    "neutral"
                ]

            });

        }, 80);

    }

}

    async function setCFPeriod(period) {
      state.cfPeriod = period;

      const page = document.getElementById("page-cash-flow");

      if (page) {
        page.innerHTML = renderSkeletonCard(9);
      }

      try {
        const data = await loadCashFlow(period);
        renderCashFlow(data);
      } catch (error) {
        console.error("❌ Failed to load Cash Flow for period:", period, error);
      }
    }

    // ============================================================
    // ACCOUNTS RECEIVABLE / PAYABLE
    // ============================================================

    async function loadAccountsReceivable() {
    
      const organizationId =
        getOrganizationId();
    
      if (!organizationId) {
        throw new Error(
          "Organization ID is missing. Please log in first."
        );
      }
    
      console.log(
        "💰 Loading Accounts Receivable for:",
        organizationId
      );

      const startDate = toISODate(new Date());

      const data = await apiGet(
        `/quickbooks/reports/accounts-receivable?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          startDate
        )}`
      );
    
      console.log(
        "✅ Accounts Receivable received:",
        data
      );
    
      return data;
    }
    async function loadAccountsPayable() {

    const organizationId =
        getOrganizationId();

    if (!organizationId) {
        throw new Error(
            "Organization ID is missing."
        );
    }

    console.log(
        "📊 Loading Accounts Payable for:",
        organizationId
    );

    const today = toISODate(new Date());

    const data =
        await apiGet(
            `/quickbooks/reports/accounts-payable` +
            `?organizationId=${encodeURIComponent(
                organizationId
            )}` +
            `&startDate=${encodeURIComponent(
                today
            )}`
        );

    console.log(
        "✅ Accounts Payable received:",
        data
    );

    return data;
}

    
//====================================================
  // QUICKBOOKS STATUS
  // ============================================================

  async function checkQBConnection() {
    const organizationId =
      getOrganizationId();

    if (!organizationId) {
      console.error(
        "❌ Organization ID is missing"
      );

      state.qbConnected = false;

      return null;
    }

    try {
      const status =
        await apiGet(
          `/quickbooks/status?organizationId=${encodeURIComponent(
            organizationId
          )}`
        );

      state.qbConnected =
        status.connected === true;

      state.qbCompanyName =
        status.companyName || null;

      return status;
    } catch (error) {
      console.error(
        "❌ QuickBooks status check failed:",
        error
      );

      state.qbConnected = false;

      return null;
    }
  }

  // ============================================================
  // CONNECT QUICKBOOKS
  // ============================================================

  async function connectQuickBooks() {
    const organizationId =
      getOrganizationId();

    const token =
      window.NFK_Auth?.getAccessToken?.();

    if (!organizationId || !token) {
      alert(
        "Organization ID is missing."
      );

      return;
    }

    try {
      const data = await apiGet(
        `/quickbooks/connect-url?organizationId=${encodeURIComponent(organizationId)}`
      );

      if (!data.authUrl) {
        throw new Error("Failed to start QuickBooks connection");
      }

      window.location.href = data.authUrl;
    } catch (error) {
      console.error("❌ Failed to start QuickBooks connection:", error);
      alert("Couldn't start the QuickBooks connection. Please try again.");
    }
  }

  // ============================================================
  // QUICKBOOKS CALLBACK
  // ============================================================

  function handleQBCallback() {
    const params =
      new URLSearchParams(
        window.location.search
      );

    if (
      params.get("connected") === "true"
    ) {
      state.qbConnected = true;

      console.log(
        "✅ QuickBooks connected successfully"
      );

      // Remove query parameters from URL
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname
      );
    }
  }

  // ============================================================
  // INITIALIZE APP
  // ============================================================

  async function init() {
    handleQBCallback();

    buildSidebar();

    buildAllPages();

    await buildTopBar();

    navigate("overview");

    bindGlobalEvents();
  }

  // ============================================================
  // NAVIGATION
  // ============================================================
    // --------------------------------------------------------
    // Shared error card for AI Insights sections — distinguishes
    // "no Claude key configured yet" and "QuickBooks not connected"
    // from a generic failure, since each needs different guidance.
    // --------------------------------------------------------

    function aiErrorCardHtml(error) {

      if (error?.code === "AI_KEY_NOT_CONFIGURED") {
        return `
          <div class="card card-pad">
            <div style="font-weight:700;margin-bottom:6px;">
              🔑 Claude API key not configured
            </div>
            <p style="color:var(--text-secondary);">
              Add a real <code>CLAUDE_API_KEY</code> to the backend's
              <code>.env</code> file to enable AI features, then reload
              this page.
            </p>
          </div>
        `;
      }

      if (error?.code === "QB_NOT_CONNECTED") {
        return `
          <div class="card card-pad">
            <div style="font-weight:700;margin-bottom:6px;">
              QuickBooks not connected
            </div>
            <p style="color:var(--text-secondary);">
              Connect QuickBooks first so NFP AI has real data to work with.
            </p>
          </div>
        `;
      }

      if (error?.code === "AI_NO_CREDITS") {
        return `
          <div class="card card-pad">
            <div style="font-weight:700;margin-bottom:6px;">
              AI features are paused
            </div>
            <p style="color:var(--text-secondary);">
              ${escapeHtml(error.message || "This account is out of Anthropic credits.")}
            </p>
          </div>
        `;
      }

      return `
        <div class="card card-pad">
          <div style="font-weight:700;margin-bottom:6px;">
            ⚠️ Unable to load
          </div>
          <p style="color:var(--text-secondary);">
            ${escapeHtml(error?.message || "Something went wrong.")}
          </p>
        </div>
      `;
    }


    // --------------------------------------------------------
    // HEALTH SCORE
    // --------------------------------------------------------

    function healthRatingColor(rating) {
      if (rating === "strong" || rating === "good") return "var(--positive)";
      if (rating === "fair") return "var(--warning)";
      return "var(--negative)";
    }

    function healthImpactIcon(impact) {
      if (impact === "positive") return "▲";
      if (impact === "negative") return "▼";
      return "•";
    }

    // Populated by loadOverviewHealthScore() so the detail modal can
    // show the same data without a second API call.
    let overviewHealthData = null;

    function openHealthDetail() {
      const health = overviewHealthData;
      if (!health) return;

      const overlay = document.getElementById("modal-overlay");
      const content = document.getElementById("modal-content");
      if (!overlay || !content) return;

      const color = healthRatingColor(health.rating);

      content.innerHTML = `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;">
          <div style="display:flex;gap:18px;align-items:center;">
            <div style="font-size:40px;font-weight:800;line-height:1;color:${color};">
              ${Math.round(health.score)}
            </div>
            <div>
              <div class="card-title">Financial Health Score</div>
              <div class="badge" style="background:${color}22;color:${color};margin-top:6px;text-transform:capitalize;">
                ${escapeHtml(health.rating)}
              </div>
            </div>
          </div>
          <button class="btn btn-ghost" onclick="NFK_App.closeKPIModal()">✕</button>
        </div>

        <div class="insight-body ai-msg-markdown" style="margin-bottom:18px;">
          ${renderMarkdown(health.summary)}
        </div>

        <div class="card-title" style="margin-bottom:10px;">Contributing Factors</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
          ${health.factors.map(f => `
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;">
              <span style="color:${healthRatingColor(f.impact === "positive" ? "good" : f.impact === "negative" ? "critical" : "fair")};font-weight:700;">
                ${healthImpactIcon(f.impact)}
              </span>
              <span>
                <strong>${escapeHtml(f.label)}:</strong>
                <span style="color:var(--text-secondary);"> ${escapeHtml(f.detail)}</span>
              </span>
            </div>
          `).join("")}
        </div>
      `;

      overlay.classList.add("open");
    }


    // --------------------------------------------------------
    // FORECAST
    // --------------------------------------------------------

    async function loadAIForecast() {
      const body = document.getElementById("insight-forecast-body");
      if (!body) return;

      const organizationId = getOrganizationId();
      if (!organizationId) return;

      try {
        const { forecast, trend } = await apiGet(
          `/ai/forecast?organizationId=${encodeURIComponent(organizationId)}`
        );

        const confidenceBadgeClass =
          forecast.confidence === "high"
            ? "badge-pos"
            : forecast.confidence === "low"
            ? "badge-warn"
            : "badge-ai";

        body.innerHTML = `
          <div class="insight-card forecast">
            <div class="insight-type-badge forecast">Forecast</div>
            <div class="insight-body ai-msg-markdown" style="margin-bottom:16px;">
              ${renderMarkdown(forecast.narrative)}
            </div>
            <div style="height:220px;margin-bottom:16px;">
              <canvas id="chart-ai-forecast"></canvas>
            </div>
            <ul style="margin:0 0 12px 18px;padding:0;color:var(--text-secondary);font-size:13px;line-height:1.7;">
              ${forecast.keyAssumptions.map(a => `<li>${renderMarkdown(a).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}
            </ul>
            <div class="insight-footer" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span class="badge ${confidenceBadgeClass}">
                ${escapeHtml(forecast.confidence)} confidence
              </span>
              <button class="btn btn-ghost" onclick="NFK_App.nav('forecast')">View full trends →</button>
            </div>
          </div>
        `;

        if (window.NFK_Charts?.renderForecastChart) {
          window.NFK_Charts.renderForecastChart(
            "chart-ai-forecast",
            trend,
            forecast.monthlyProjection
          );
        }
      } catch (error) {
        console.error("❌ Failed to load AI forecast:", error);
        body.innerHTML = aiErrorCardHtml(error);
      }
    }


    // --------------------------------------------------------
    // ANOMALIES
    // --------------------------------------------------------

    async function loadAIAnomalies() {
      const body = document.getElementById("insight-anomalies-body");
      if (!body) return;

      const organizationId = getOrganizationId();
      if (!organizationId) return;

      try {
        const { anomalies } = await apiGet(
          `/ai/anomalies?organizationId=${encodeURIComponent(organizationId)}`
        );

        if (!anomalies || anomalies.length === 0) {
          body.innerHTML = `
            <div class="card card-pad">
              <p style="color:var(--text-secondary);">
                No anomalies found in your current financial data.
              </p>
            </div>
          `;
          return;
        }

        body.innerHTML = anomalies.map(item => `
          <div class="insight-card anomaly" style="margin-bottom:16px;">
            <div class="insight-type-badge anomaly">
              ${escapeHtml(item.severity)} severity · ${escapeHtml(item.category)}
            </div>
            <div class="insight-title">${escapeHtml(item.title)}</div>
            <div class="insight-body ai-msg-markdown">${renderMarkdown(item.description)}</div>
            <div class="insight-basis">
              <span>📊</span>
              <span>${escapeHtml(item.evidence)}</span>
            </div>
          </div>
        `).join("");
      } catch (error) {
        console.error("❌ Failed to load AI anomalies:", error);
        body.innerHTML = aiErrorCardHtml(error);
      }
    }


    // --------------------------------------------------------
    // RECOMMENDATIONS
    // --------------------------------------------------------

    async function loadAIRecommendations() {
      const body = document.getElementById("insight-recommendations-body");
      if (!body) return;

      const organizationId = getOrganizationId();
      if (!organizationId) return;

      try {
        const { recommendations } = await apiGet(
          `/ai/recommendations?organizationId=${encodeURIComponent(organizationId)}`
        );

        if (!recommendations || recommendations.length === 0) {
          body.innerHTML = `
            <div class="card card-pad">
              <p style="color:var(--text-secondary);">
                No recommendations right now.
              </p>
            </div>
          `;
          return;
        }

        body.innerHTML = recommendations.map(item => `
          <div class="insight-card recommendation" style="margin-bottom:16px;">
            <div class="insight-type-badge recommendation">
              ${escapeHtml(item.priority)} priority · ${escapeHtml(item.category)}
            </div>
            <div class="insight-title">${escapeHtml(item.title)}</div>
            <div class="insight-body ai-msg-markdown">${renderMarkdown(item.description)}</div>
            <div class="insight-basis">
              <span>🎯</span>
              <span>${escapeHtml(item.expectedImpact)}</span>
            </div>
          </div>
        `).join("");
      } catch (error) {
        console.error("❌ Failed to load AI recommendations:", error);
        body.innerHTML = aiErrorCardHtml(error);
      }
    }


    const AI_INSIGHT_TABS = [
      { id: "anomalies", label: "⚠️ Anomalies" },
      { id: "recommendations", label: "💡 Recommendations" }
    ];

    function switchInsightTab(tabId) {
      AI_INSIGHT_TABS.forEach(t => {
        const pane = document.getElementById(`insight-tab-${t.id}`);
        const btn = document.getElementById(`insight-tabbtn-${t.id}`);
        if (pane) pane.style.display = t.id === tabId ? "block" : "none";
        if (btn) btn.classList.toggle("active", t.id === tabId);
      });
    }

    function renderAIInsights() {

      const page =
        document.getElementById("page-ai-insights");

      if (!page) return;

      page.innerHTML = `

        <div class="page-header">

          <div>
            <div class="page-title">
              What we noticed
            </div>

            <div class="page-subtitle">
              Generated by NFP AI · Based on live financial data
            </div>
          </div>

        </div>

        <div class="period-selector" id="insight-tabs" style="width:max-content;margin-bottom:16px;">
          ${AI_INSIGHT_TABS.map((t, i) => `
            <button
              class="period-btn ${i === 0 ? "active" : ""}"
              id="insight-tabbtn-${t.id}"
              onclick="NFK_App.switchInsightTab('${t.id}')"
            >${t.label}</button>
          `).join("")}
        </div>

        <div class="insight-section" id="insight-tab-anomalies">
          <div id="insight-anomalies-body">
            <div class="card card-pad"><p>Scanning your data for anomalies...</p></div>
          </div>
        </div>

        <div class="insight-section" id="insight-tab-recommendations" style="display:none;">
          <div id="insight-recommendations-body">
            <div class="card card-pad"><p>Generating recommendations...</p></div>
          </div>
        </div>

      `;

      loadAIAnomalies();
      loadAIRecommendations();
    }
      function renderNonakaAI() {

      const page =
          document.getElementById("page-nonaka-ai");

      if (!page) return;

      nonakaChatHistory = [];


      page.innerHTML = `
  
          <div class="page-header">
  
              <div>
                  <div class="page-title">
                      NFP AI
                  </div>
  
                  <div class="page-subtitle">
                      Your AI-powered financial analyst · Based on live financial data
                  </div>
              </div>
  
          </div>
  
  
          <div
              class="ai-chat-panel"
              id="ai-page-chat"
              style="display:block;"
          >
  
              <div class="ai-chat-header">
  
                  <div style="
                      display:flex;
                      align-items:center;
                      gap:12px;
                  ">
  
                      <div class="ai-fp-avatar">
                          ✦
                      </div>
  
                      <div>
  
                          <div class="ai-chat-title">
                              Ask NFP AI
                          </div>
  
                          <div class="ai-chat-subtitle">
                              Powered by live financial data
                          </div>
  
                      </div>
  
                  </div>
  
              </div>
  
  
              <div
                  class="ai-chat-messages"
                  id="ai-page-messages"
              >
  
                  <div class="ai-chat-msg ai-msg">
  
                      <div class="ai-msg-avatar">
                          ✦
                      </div>
  
                      <div class="ai-msg-bubble">
  
                          Hi! I'm NFP AI, your financial analyst.
                          I have access to your financial data.
  
                          <br><br>
  
                          What would you like to explore?
  
                      </div>
  
                  </div>
  
              </div>
  
  
              <div class="ai-chat-suggestions">

                <button
                    class="ai-suggestion-pill"
                    onclick="NFK_App.sendPageChat('What is our current revenue?')"
                >
                    What is our current revenue?
                </button>
            
                <button
                    class="ai-suggestion-pill"
                    onclick="NFK_App.sendPageChat('How is our cash flow?')"
                >
                    How is our cash flow?
                </button>
            
                <button
                    class="ai-suggestion-pill"
                    onclick="NFK_App.sendPageChat('Which invoices are most at risk?')"
                >
                    Which invoices are most at risk?
                </button>
            
                <button
                    class="ai-suggestion-pill"
                    onclick="NFK_App.sendPageChat('How is our gross margin trending?')"
                >
                    How is our gross margin trending?
                </button>
            
            </div>
  
  
              <div class="ai-chat-input-row">
  
                  <textarea
                      id="ai-page-input"
                      class="ai-chat-input"
                      placeholder="Ask about revenue, cash flow, margins..."
                      rows="1"
                  ></textarea>
  
                  <button
                      class="ai-send-btn"
                      onclick="NFK_App.sendPageChat()"
                  >
                      ➤
                  </button>
  
              </div>
  
          </div>
  
      `;
  }


    // ============================================================
    // SCENARIOS — what-if modeling with real 12-month history
    // ============================================================

    const SCENARIO_SLIDER_DEFS = [
      { id: "revGrowth", label: "Revenue Growth", min: -30, max: 60, suffix: "%" },
      { id: "cogsGrowth", label: "COGS Growth", min: -20, max: 40, suffix: "%" },
      { id: "opexGrowth", label: "Opex Growth", min: -20, max: 40, suffix: "%" },
      { id: "taxRate", label: "Tax Rate", min: 0, max: 40, suffix: "%" }
    ];

    const SCENARIO_PRESETS = {
      worst: { revGrowth: -10, cogsGrowth: 10, opexGrowth: 8, taxRate: 21, months: 6 },
      base: { revGrowth: 10, cogsGrowth: 5, opexGrowth: 5, taxRate: 21, months: 6 },
      best: { revGrowth: 25, cogsGrowth: 3, opexGrowth: 2, taxRate: 21, months: 6 }
    };

    let scenarioActuals = null;
    let scenarioParams = { ...SCENARIO_PRESETS.base };
    let scenarioActivePreset = "base";

    async function loadScenarioActuals() {
      const periods = getMonthlyPeriods(12);

      const results = await Promise.all(
        periods.map(period =>
          fetchProfitAndLossRange(period.startDate, period.endDate)
            .catch(() => null)
        )
      );

      return {
        labels: periods.map(p => p.label),
        revenue: results.map(r => r?.income ?? 0),
        gross: results.map(r => r?.grossProfit ?? 0),
        net: results.map(r => r?.netIncome ?? 0)
      };
    }

    function scenarioSliderHtml(def) {
      const value = scenarioParams[def.id];

      return `
        <div class="scenario-slider-group">
          <div class="scenario-slider-header">
            <span class="scenario-slider-label">${escapeHtml(def.label)}</span>
            <span
              class="scenario-slider-val ${value >= 0 ? "pos" : "neg"}"
              id="scenario-${def.id}-val"
            >${value}${def.suffix}</span>
          </div>
          <input
            type="range"
            class="scenario-range"
            id="scenario-${def.id}"
            min="${def.min}"
            max="${def.max}"
            step="1"
            value="${value}"
            oninput="NFK_App.updateScenarioParam('${def.id}', this.value)"
          />
          <div class="scenario-range-labels">
            <span>${def.min}${def.suffix}</span>
            <span>${def.max}${def.suffix}</span>
          </div>
        </div>
      `;
    }

    function scenarioMonthsButtonsHtml() {
      return [3, 6, 9, 12].map(m => `
        <button
          class="period-btn ${scenarioParams.months === m ? "active" : ""}"
          onclick="NFK_App.setScenarioMonths(${m})"
        >${m} mo</button>
      `).join("");
    }

    function scenarioPresetButtonsHtml() {
      const presets = [
        { id: "worst", label: "📉 Worst Case" },
        { id: "base", label: "Base Case" },
        { id: "best", label: "📈 Best Case" }
      ];

      return presets.map(p => `
        <button
          class="btn ${scenarioActivePreset === p.id ? "btn-primary" : "btn-ghost"}"
          id="scenario-preset-${p.id}"
          onclick="NFK_App.applyScenarioPreset('${p.id}')"
        >${p.label}</button>
      `).join("");
    }

    async function renderScenarios() {
      const page = document.getElementById("page-scenarios");
      if (!page) return;

      page.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">What if <span class="page-title-term">Scenarios</span></div>
            <div class="page-subtitle">
              What-if modeling from your real 12-month QuickBooks trend — not AI-generated, instant and fully under your control
            </div>
          </div>
        </div>

        <div class="scenario-panel section-gap">
          <div class="scenario-header">
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="scenario-icon">🎛️</span>
              <div>
                <div class="scenario-title">Adjust the assumptions</div>
                <div class="scenario-subtitle">Drag any slider — the chart and outcomes update instantly</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${scenarioPresetButtonsHtml()}
            </div>
          </div>

          <div class="scenario-sliders">
            ${SCENARIO_SLIDER_DEFS.map(scenarioSliderHtml).join("")}
          </div>

          <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
            <span class="scenario-slider-label">Forecast Horizon</span>
            <div class="period-selector" id="scenario-months-group">
              ${scenarioMonthsButtonsHtml()}
            </div>
          </div>

          <div class="scenario-outcomes" id="scenario-outcomes">
            <div class="scenario-kpi">
              <span class="scenario-kpi-label">Loading</span>
              <span class="scenario-kpi-val">—</span>
            </div>
          </div>
        </div>

        <div class="card card-pad">
          <div class="card-title" style="margin-bottom:14px;">Revenue, Gross Profit & Net Income</div>
          <div id="scenario-chart-wrap" style="height:340px;display:flex;align-items:center;justify-content:center;">
            <p style="color:var(--text-muted);">Loading your real 12-month history from QuickBooks...</p>
          </div>
        </div>
      `;

      try {
        scenarioActuals = await loadScenarioActuals();

        const chartWrap = document.getElementById("scenario-chart-wrap");

        if (chartWrap) {
          chartWrap.style.display = "block";
          chartWrap.innerHTML = `<canvas id="chart-pl-trend"></canvas>`;
        }

        updateScenarioChart();
      } catch (error) {
        console.error("❌ Failed to load scenario actuals:", error);

        const chartWrap = document.getElementById("scenario-chart-wrap");

        if (chartWrap) {
          chartWrap.innerHTML = `
            <p style="color:var(--text-secondary);">
              Unable to load historical data: ${escapeHtml(error.message)}
            </p>
          `;
        }
      }
    }

    function updateScenarioChart() {
      if (!scenarioActuals) return;

      if (window.NFK_Charts?.renderPLWithProjection) {
        window.NFK_Charts.renderPLWithProjection(scenarioParams, scenarioActuals);
      }

      if (!window.NFK_Charts?.computeScenarioProjection) return;

      const projection = window.NFK_Charts.computeScenarioProjection(
        scenarioParams,
        scenarioActuals
      );

      const anchorRevenue = projection.baselineAnchor?.revenue || 0;
      const revenueChangePct = anchorRevenue !== 0
        ? ((projection.endOfHorizon.revenue - anchorRevenue) / Math.abs(anchorRevenue)) * 100
        : 0;

      const netMargin = projection.endOfHorizon.revenue !== 0
        ? (projection.endOfHorizon.netIncome / projection.endOfHorizon.revenue) * 100
        : 0;

      const outcomes = document.getElementById("scenario-outcomes");
      if (!outcomes) return;

      function outcomeCard(label, value, sub, isNegative) {
        return `
          <div class="scenario-kpi">
            <span class="scenario-kpi-label">${escapeHtml(label)}</span>
            <span class="scenario-kpi-val ${isNegative ? "neg" : "pos"}">${value}</span>
            <span class="scenario-kpi-sub">${escapeHtml(sub)}</span>
          </div>
        `;
      }

      outcomes.innerHTML =
        outcomeCard(
          `Revenue in ${scenarioParams.months} mo`,
          formatCurrency(projection.endOfHorizon.revenue),
          `${revenueChangePct >= 0 ? "+" : ""}${revenueChangePct.toFixed(1)}% vs. recent monthly average`,
          revenueChangePct < 0
        ) +
        outcomeCard(
          "Projected Gross Profit",
          formatCurrency(projection.endOfHorizon.grossProfit),
          "At end of horizon",
          projection.endOfHorizon.grossProfit < 0
        ) +
        outcomeCard(
          "Projected Net Income",
          formatCurrency(projection.endOfHorizon.netIncome),
          "At end of horizon",
          projection.endOfHorizon.netIncome < 0
        ) +
        outcomeCard(
          "Net Margin",
          `${netMargin.toFixed(1)}%`,
          "Projected, end of horizon",
          netMargin < 0
        );
    }

    function updateScenarioParam(id, value) {
      scenarioParams[id] = Number(value);
      scenarioActivePreset = null;

      const def = SCENARIO_SLIDER_DEFS.find(d => d.id === id);
      const label = document.getElementById(`scenario-${id}-val`);

      if (label && def) {
        label.textContent = `${scenarioParams[id]}${def.suffix}`;
        label.className = `scenario-slider-val ${scenarioParams[id] >= 0 ? "pos" : "neg"}`;
      }

      ["worst", "base", "best"].forEach(p => {
        const btn = document.getElementById(`scenario-preset-${p}`);
        if (btn) btn.className = "btn btn-ghost";
      });

      updateScenarioChart();
    }

    function setScenarioMonths(months) {
      scenarioParams.months = months;

      const group = document.getElementById("scenario-months-group");

      if (group) {
        group.innerHTML = scenarioMonthsButtonsHtml();
      }

      updateScenarioChart();
    }

    function applyScenarioPreset(preset) {
      scenarioParams = { ...SCENARIO_PRESETS[preset] };
      scenarioActivePreset = preset;

      SCENARIO_SLIDER_DEFS.forEach(def => {
        const input = document.getElementById(`scenario-${def.id}`);
        const label = document.getElementById(`scenario-${def.id}-val`);
        const value = scenarioParams[def.id];

        if (input) input.value = value;

        if (label) {
          label.textContent = `${value}${def.suffix}`;
          label.className = `scenario-slider-val ${value >= 0 ? "pos" : "neg"}`;
        }
      });

      ["worst", "base", "best"].forEach(p => {
        const btn = document.getElementById(`scenario-preset-${p}`);
        if (btn) btn.className = `btn ${p === preset ? "btn-primary" : "btn-ghost"}`;
      });

      const monthsGroup = document.getElementById("scenario-months-group");
      if (monthsGroup) monthsGroup.innerHTML = scenarioMonthsButtonsHtml();

      updateScenarioChart();
    }


    async function sendPageChat(prefill = null) {
    
        const input =
            document.getElementById("ai-page-input");
    
        const messages =
            document.getElementById("ai-page-messages");
    
        const question =
            prefill ||
            input?.value?.trim();
    
        if (!question) return;
    
        const organizationId =
            getOrganizationId();
    
        if (!organizationId) {
            console.error(
                "❌ Organization ID is missing"
            );
            return;
        }
    
        messages.innerHTML += `
            <div class="ai-chat-msg user-msg">
                <div class="ai-msg-bubble">
                    ${escapeHtml(question)}
                </div>
            </div>
        `;
    
        if (input) {
            input.value = "";
        }
    
        try {

            console.log(
                "🤖 Sending question to NFP AI:",
                question
            );

            const response =
                await apiPost(
                    "/ai/ask",
                    {
                        organizationId,
                        question,
                        history: nonakaChatHistory
                    }
                );

            console.log(
                "🤖 NFP AI response:",
                response
            );

            const answer =
                response?.answer ||
                "No answer received.";

            nonakaChatHistory.push(
                { role: "user", content: question },
                { role: "assistant", content: answer }
            );

            messages.innerHTML += `
                <div class="ai-chat-msg ai-msg">

                    <div class="ai-msg-avatar">
                        ✦
                    </div>

                    <div class="ai-msg-bubble ai-msg-markdown">
                        ${renderMarkdown(answer)}
                    </div>

                </div>
            `;

            messages.scrollTop =
                messages.scrollHeight;

        } catch (error) {

            console.error(
                "❌ NFP AI request failed:",
                error
            );

            const errorText =
                error?.code === "AI_KEY_NOT_CONFIGURED"
                    ? "NFP AI needs a Claude API key configured in the backend's .env file before it can answer questions."
                    : error?.code === "QB_NOT_CONNECTED"
                    ? "Connect QuickBooks first so I have real data to answer from."
                    : "Sorry, I couldn't process that question right now.";

            messages.innerHTML += `
                <div class="ai-chat-msg ai-msg">

                    <div class="ai-msg-avatar">
                        ✦
                    </div>

                    <div class="ai-msg-bubble">
                        ${escapeHtml(errorText)}
                    </div>

                </div>
            `;
        }
    }
  // ------------------------------------------------------
  // Computes every KPI from a single {pl, bs, ar, ap} bundle.
  // Used both for the current live period and for each of the
  // historical monthly periods used in trend charts — one
  // formula, no duplication. Anything whose source data failed
  // (or is missing) stays null so it renders "—" instead of a
  // fabricated number, and the returned `formula`/`inputs` make
  // every number's origin traceable back to a real QuickBooks
  // report field.
  // ------------------------------------------------------

  function computeKPIValues({ pl, bs, ar, ap }) {

    function findSection(sections, needle) {
      const list = Array.isArray(sections) ? sections : [];

      const match = list.find(section =>
        String(section?.name || "")
          .toLowerCase()
          .includes(needle)
      );

      return match ? Number(match.amount || 0) : null;
    }

    function pctOf(numer, denom) {
      return denom !== null && denom !== 0 && numer !== null
        ? (numer / denom) * 100
        : null;
    }

    function ratioOf(numer, denom) {
      return denom !== null && denom !== 0 && numer !== null
        ? numer / denom
        : null;
    }

    function cur(v) {
      return v === null ? "N/A" : formatCurrency(v);
    }

    function pct1(v) {
      return v === null ? "N/A" : `${v.toFixed(1)}%`;
    }

    function ratio2(v) {
      return v === null ? "N/A" : `${v.toFixed(2)}x`;
    }

    function daysStr(v) {
      return v === null ? "N/A" : `${v.toFixed(0)} days`;
    }

    const income = pl?.error ? null : Number(pl?.income || 0);
    const grossProfit = pl?.error ? null : Number(pl?.grossProfit || 0);
    const netIncome = pl?.error ? null : Number(pl?.netIncome || 0);
    const netOperatingIncome =
      pl?.error ? null : Number(pl?.netOperatingIncome || 0);
    const costOfGoodsSold =
      pl?.error ? null : Number(pl?.costOfGoodsSold || 0);

    const totalAssets = bs?.error ? null : Number(bs?.totalAssets || 0);
    const totalLiabilities = bs?.error ? null : Number(bs?.totalLiabilities || 0);
    const totalEquity = bs?.error ? null : Number(bs?.totalEquity || 0);

    const currentAssetsSection = bs?.error
      ? null
      : findSection(bs?.details?.assets, "current assets");

    const currentLiabilitiesSection = bs?.error
      ? null
      : findSection(bs?.details?.liabilities, "current liabilities");

    const usedSectionFigures =
      currentAssetsSection !== null && currentLiabilitiesSection !== null;

    const currentAssets =
      currentAssetsSection !== null ? currentAssetsSection : totalAssets;

    const currentLiabilities =
      currentLiabilitiesSection !== null ? currentLiabilitiesSection : totalLiabilities;

    const assetsLabel = usedSectionFigures
      ? "Current Assets (Balance Sheet)"
      : "Total Assets (Balance Sheet)";

    const liabilitiesLabel = usedSectionFigures
      ? "Current Liabilities (Balance Sheet)"
      : "Total Liabilities (Balance Sheet)";

    const arTotal = ar?.error ? null : Number(ar?.total || 0);
    const apTotal = ap?.error ? null : Number(ap?.total || 0);

    // Days actually covered by the fetched P&L period — used to
    // pro-rate DSO/DPO instead of assuming a fixed 365-day year.
    const periodDays =
      pl?.period?.startDate && pl?.period?.endDate
        ? Math.max(
            1,
            Math.round(
              (new Date(pl.period.endDate) -
                new Date(pl.period.startDate)) /
                86400000
            ) + 1
          )
        : null;

    const grossMarginValue = pctOf(grossProfit, income);
    const operatingMarginValue = pctOf(netOperatingIncome, income);
    const netMarginValue = pctOf(netIncome, income);
    const currentRatioValue = ratioOf(currentAssets, currentLiabilities);

    const workingCapitalValue =
      currentAssets !== null && currentLiabilities !== null
        ? currentAssets - currentLiabilities
        : null;

    const debtToEquityValue = ratioOf(totalLiabilities, totalEquity);
    const debtRatioValue = pctOf(totalLiabilities, totalAssets);

    const dsoValue =
      arTotal !== null && income && income !== 0 && periodDays !== null
        ? (arTotal / income) * periodDays
        : null;

    const dpoValue =
      apTotal !== null &&
      costOfGoodsSold &&
      costOfGoodsSold !== 0 &&
      periodDays !== null
        ? (apTotal / costOfGoodsSold) * periodDays
        : null;

    return {
      grossMargin: {
        value: grossMarginValue,
        formula: `Gross Profit ÷ Revenue = ${cur(grossProfit)} ÷ ${cur(income)} = ${pct1(grossMarginValue)}`,
        inputs: [
          { label: "Gross Profit (P&L)", value: cur(grossProfit) },
          { label: "Revenue (P&L)", value: cur(income) }
        ]
      },
      operatingMargin: {
        value: operatingMarginValue,
        formula: `Net Operating Income ÷ Revenue = ${cur(netOperatingIncome)} ÷ ${cur(income)} = ${pct1(operatingMarginValue)}`,
        inputs: [
          { label: "Net Operating Income (P&L)", value: cur(netOperatingIncome) },
          { label: "Revenue (P&L)", value: cur(income) }
        ]
      },
      netMargin: {
        value: netMarginValue,
        formula: `Net Income ÷ Revenue = ${cur(netIncome)} ÷ ${cur(income)} = ${pct1(netMarginValue)}`,
        inputs: [
          { label: "Net Income (P&L)", value: cur(netIncome) },
          { label: "Revenue (P&L)", value: cur(income) }
        ]
      },
      currentRatio: {
        value: currentRatioValue,
        formula: `Current Assets ÷ Current Liabilities = ${cur(currentAssets)} ÷ ${cur(currentLiabilities)} = ${ratio2(currentRatioValue)}`,
        inputs: [
          { label: assetsLabel, value: cur(currentAssets) },
          { label: liabilitiesLabel, value: cur(currentLiabilities) }
        ]
      },
      debtToEquity: {
        value: debtToEquityValue,
        formula: `Total Liabilities ÷ Total Equity = ${cur(totalLiabilities)} ÷ ${cur(totalEquity)} = ${ratio2(debtToEquityValue)}`,
        inputs: [
          { label: "Total Liabilities (Balance Sheet)", value: cur(totalLiabilities) },
          { label: "Total Equity (Balance Sheet)", value: cur(totalEquity) }
        ]
      },
      debtRatio: {
        value: debtRatioValue,
        formula: `Total Liabilities ÷ Total Assets = ${cur(totalLiabilities)} ÷ ${cur(totalAssets)} = ${pct1(debtRatioValue)}`,
        inputs: [
          { label: "Total Liabilities (Balance Sheet)", value: cur(totalLiabilities) },
          { label: "Total Assets (Balance Sheet)", value: cur(totalAssets) }
        ]
      },
      workingCapital: {
        value: workingCapitalValue,
        formula: `Current Assets − Current Liabilities = ${cur(currentAssets)} − ${cur(currentLiabilities)} = ${cur(workingCapitalValue)}`,
        inputs: [
          { label: assetsLabel, value: cur(currentAssets) },
          { label: liabilitiesLabel, value: cur(currentLiabilities) }
        ]
      },
      daysSalesOutstanding: {
        value: dsoValue,
        formula: `(Accounts Receivable ÷ Revenue) × Days in Period = (${cur(arTotal)} ÷ ${cur(income)}) × ${periodDays ?? "N/A"} = ${daysStr(dsoValue)}`,
        inputs: [
          { label: "Accounts Receivable (AR Aging)", value: cur(arTotal) },
          { label: "Revenue (P&L)", value: cur(income) },
          { label: "Days in Period", value: periodDays === null ? "N/A" : String(periodDays) }
        ]
      },
      daysPayableOutstanding: {
        value: dpoValue,
        formula: `(Accounts Payable ÷ Cost of Goods Sold) × Days in Period = (${cur(apTotal)} ÷ ${cur(costOfGoodsSold)}) × ${periodDays ?? "N/A"} = ${daysStr(dpoValue)}`,
        inputs: [
          { label: "Accounts Payable (AP Aging)", value: cur(apTotal) },
          { label: "Cost of Goods Sold (P&L)", value: cur(costOfGoodsSold) },
          { label: "Days in Period", value: periodDays === null ? "N/A" : String(periodDays) }
        ]
      }
    };
  }

  // ------------------------------------------------------
  // Historical trend fetching — same report endpoints the
  // current-period KPIs use, called once per each of the last
  // 6 calendar months so every KPI card can show a real
  // (not fabricated) trend line.
  // ------------------------------------------------------

  function getMonthlyPeriods(count = 6) {
    const periods = [];
    const now = new Date();

    for (let i = count - 1; i >= 0; i--) {
      const periodStart = new Date(now.getFullYear(), now.getMonth() - i, 1);

      const periodEnd =
        i === 0
          ? now
          : new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

      const toISO = d => toISODate(d);

      periods.push({
        startDate: toISO(periodStart),
        endDate: toISO(periodEnd),
        label: periodStart.toLocaleDateString("en-US", { month: "short" })
      });
    }

    return periods;
  }

  async function fetchProfitAndLossRange(startDate, endDate) {
    const organizationId = getOrganizationId();

    if (!organizationId) {
      throw new Error("Organization ID is missing. Please log in first.");
    }

    return apiGet(
      `/quickbooks/reports/profit-and-loss?organizationId=${encodeURIComponent(
        organizationId
      )}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
  }

  async function fetchBalanceSheetAsOf(date) {
    const organizationId = getOrganizationId();

    if (!organizationId) {
      throw new Error("Organization ID is missing. Please log in first.");
    }

    return apiGet(
      `/quickbooks/reports/balance-sheet?organizationId=${encodeURIComponent(
        organizationId
      )}&startDate=${encodeURIComponent(date)}`
    );
  }

  async function fetchAccountsReceivableAsOf(date) {
    const organizationId = getOrganizationId();

    if (!organizationId) {
      throw new Error("Organization ID is missing. Please log in first.");
    }

    return apiGet(
      `/quickbooks/reports/accounts-receivable?organizationId=${encodeURIComponent(
        organizationId
      )}&startDate=${encodeURIComponent(date)}`
    );
  }

  async function fetchAccountsPayableAsOf(date) {
    const organizationId = getOrganizationId();

    if (!organizationId) {
      throw new Error("Organization ID is missing. Please log in first.");
    }

    return apiGet(
      `/quickbooks/reports/accounts-payable?organizationId=${encodeURIComponent(
        organizationId
      )}&startDate=${encodeURIComponent(date)}`
    );
  }

  async function loadKPITrends() {
    const periods = getMonthlyPeriods(6);

    return Promise.all(
      periods.map(async period => {
        const [plR, bsR, arR, apR] = await Promise.allSettled([
          fetchProfitAndLossRange(period.startDate, period.endDate),
          fetchBalanceSheetAsOf(period.endDate),
          fetchAccountsReceivableAsOf(period.endDate),
          fetchAccountsPayableAsOf(period.endDate)
        ]);

        const pick = r => (r.status === "fulfilled" ? r.value : { error: true });

        const values = computeKPIValues({
          pl: pick(plR),
          bs: pick(bsR),
          ar: pick(arR),
          ap: pick(apR)
        });

        return { label: period.label, values };
      })
    );
  }

  // ============================================================
  // FORECAST PAGE — real multi-metric trend views
  // ============================================================

  async function fetchCashFlowRange(startDate, endDate) {
    const organizationId = getOrganizationId();

    if (!organizationId) {
      throw new Error("Organization ID is missing. Please log in first.");
    }

    return apiGet(
      `/quickbooks/reports/cash-flow?organizationId=${encodeURIComponent(
        organizationId
      )}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    );
  }

  // P&L is fetched for all months concurrently (proven safe by the
  // Scenarios page's identical pattern). Cash Flow is fetched one month
  // at a time — each call already makes 2 sequential QuickBooks requests
  // internally (report + opening balance), so running 6 of those
  // concurrently on top of the P&L batch is what previously tripped
  // QuickBooks' sandbox rate limit for the AI forecast trend.
  async function loadForecastHistory(months = 6) {
    const periods = getMonthlyPeriods(months);

    const plResults = await Promise.all(
      periods.map(p =>
        fetchProfitAndLossRange(p.startDate, p.endDate).catch(() => null)
      )
    );

    const cfResults = [];
    for (const p of periods) {
      try {
        cfResults.push(await fetchCashFlowRange(p.startDate, p.endDate));
      } catch {
        cfResults.push(null);
      }
    }

    return periods.map((p, i) => {
      const pl = plResults[i];
      const cf = cfResults[i];

      const totalExpenses =
        Number.isFinite(pl?.costOfGoodsSold) && Number.isFinite(pl?.expenses)
          ? pl.costOfGoodsSold + pl.expenses
          : null;

      return {
        label: p.label,
        revenue: Number.isFinite(pl?.income) ? pl.income : null,
        grossProfit: Number.isFinite(pl?.grossProfit) ? pl.grossProfit : null,
        totalExpenses,
        netIncome: Number.isFinite(pl?.netIncome) ? pl.netIncome : null,
        operatingCashFlow: Number.isFinite(cf?.operatingActivities) ? cf.operatingActivities : null
      };
    });
  }

  // Titles/labels here are plain-language on purpose — they double as
  // both the tab-selector button text and the chart title, so one
  // change covers both. The underlying accounting terms aren't gone;
  // they're just not the first thing an owner reads (see the product
  // plan's jargon-translation rule).
  const FORECAST_VIEWS = [
    {
      id: "revenue-expenses",
      title: "Money In vs. Money Out",
      metrics: [
        { key: "revenue", label: "Money In", color: "primary" },
        { key: "totalExpenses", label: "Money Out", color: "danger" }
      ]
    },
    {
      id: "revenue-profit",
      title: "Money In vs. What You Kept",
      metrics: [
        { key: "revenue", label: "Money In", color: "primary" },
        { key: "netIncome", label: "What You Kept", color: "success" }
      ]
    },
    {
      id: "revenue-gross-net",
      title: "Money In, Money Left After Costs & What You Kept",
      metrics: [
        { key: "revenue", label: "Money In", color: "primary" },
        { key: "grossProfit", label: "Money Left After Costs", color: "purple" },
        { key: "netIncome", label: "What You Kept", color: "success" }
      ]
    },
    {
      id: "expenses-profit",
      title: "Money Out vs. What You Kept",
      metrics: [
        { key: "totalExpenses", label: "Money Out", color: "danger" },
        { key: "netIncome", label: "What You Kept", color: "success" }
      ]
    },
    {
      id: "cash-flow",
      title: "Cash From Running the Business",
      metrics: [
        { key: "operatingCashFlow", label: "Cash From Running the Business", color: "warning" }
      ]
    }
  ];

  // A view only appears in the selector if every metric it needs has
  // at least 2 real data points — otherwise there's nothing to chart.
  function forecastViewIsAvailable(view, history) {
    return view.metrics.every(
      m => history.filter(h => Number.isFinite(h[m.key])).length >= 2
    );
  }

  let forecastPageState = {
    history: null,
    availableViews: [],
    activeView: null,
    chartType: "line"
  };

  function renderActiveForecastChart() {
    const view = forecastPageState.availableViews.find(
      v => v.id === forecastPageState.activeView
    );

    if (!view || !forecastPageState.history) return;

    const titleEl = document.getElementById("forecast-chart-title");
    if (titleEl) titleEl.textContent = view.title;

    if (window.NFK_Charts?.renderForecastTrend) {
      window.NFK_Charts.renderForecastTrend(
        "chart-forecast-trend",
        forecastPageState.history,
        view,
        forecastPageState.chartType
      );
    }
  }

  function switchForecastView(viewId) {
    forecastPageState.activeView = viewId;

    forecastPageState.availableViews.forEach(v => {
      const btn = document.getElementById(`forecast-viewbtn-${v.id}`);
      if (btn) btn.classList.toggle("active", v.id === viewId);
    });

    renderActiveForecastChart();
  }

  function setForecastChartType(type) {
    forecastPageState.chartType = type;

    const lineBtn = document.getElementById("forecast-type-line");
    const barBtn = document.getElementById("forecast-type-bar");
    if (lineBtn) lineBtn.classList.toggle("active", type === "line");
    if (barBtn) barBtn.classList.toggle("active", type === "bar");

    renderActiveForecastChart();
  }

  async function renderForecastPage() {
    const page = document.getElementById("page-forecast");
    if (!page) return;

    forecastPageState = {
      history: null,
      availableViews: [],
      activeView: null,
      chartType: "line"
    };

    page.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Forecast</div>
          <div class="page-subtitle">Real financial trends from your QuickBooks history</div>
        </div>
      </div>

      <div class="card card-pad" id="forecast-loading">
        <p style="color:var(--text-secondary);">
          Loading your financial history from QuickBooks — this can take a little while...
        </p>
      </div>

      <div id="forecast-content" style="display:none;">
        <div class="scenario-slider-label" style="margin-bottom:10px;">Financial View</div>
        <div class="period-selector" id="forecast-view-tabs" style="width:max-content;flex-wrap:wrap;margin-bottom:20px;"></div>

        <div class="card card-pad">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
            <div class="card-title" id="forecast-chart-title">—</div>
            <div class="period-selector" id="forecast-chart-type-toggle">
              <button class="period-btn active" id="forecast-type-line" onclick="NFK_App.setForecastChartType('line')">Line</button>
              <button class="period-btn" id="forecast-type-bar" onclick="NFK_App.setForecastChartType('bar')">Bar</button>
            </div>
          </div>
          <div style="height:340px;">
            <canvas id="chart-forecast-trend"></canvas>
          </div>
        </div>
      </div>
    `;

    try {
      const history = await loadForecastHistory(6);

      forecastPageState.history = history;
      forecastPageState.availableViews = FORECAST_VIEWS.filter(v =>
        forecastViewIsAvailable(v, history)
      );

      const loading = document.getElementById("forecast-loading");
      const content = document.getElementById("forecast-content");

      if (forecastPageState.availableViews.length === 0) {
        if (loading) {
          loading.innerHTML = `
            <p style="color:var(--text-secondary);">
              Not enough historical QuickBooks data yet to build a trend view.
              Check back once more months of activity have been recorded.
            </p>
          `;
        }
        return;
      }

      forecastPageState.activeView = forecastPageState.availableViews[0].id;

      const tabs = document.getElementById("forecast-view-tabs");
      if (tabs) {
        tabs.innerHTML = forecastPageState.availableViews
          .map(
            (v, i) => `
              <button
                class="period-btn ${i === 0 ? "active" : ""}"
                id="forecast-viewbtn-${v.id}"
                onclick="NFK_App.switchForecastView('${v.id}')"
              >${escapeHtml(v.title)}</button>
            `
          )
          .join("");
      }

      if (loading) loading.style.display = "none";
      if (content) content.style.display = "block";

      renderActiveForecastChart();
    } catch (error) {
      console.error("❌ Failed to load Forecast history:", error);

      const loading = document.getElementById("forecast-loading");
      if (loading) {
        loading.innerHTML = `
          <p style="color:var(--text-secondary);">
            Unable to load financial history: ${escapeHtml(error.message)}
          </p>
        `;
      }
    }
  }

  function renderKPIs({ pl, bs, ar, ap }) {

    const page =
      document.getElementById("page-kpis");

    if (!page) return;

    const results = computeKPIValues({ pl, bs, ar, ap });

    kpiDetailStore = {};

    KPI_DEFS.forEach(def => {
      kpiDetailStore[def.id] = {
        ...def,
        ...results[def.id],
        trend: null,
        trendLabels: null
      };
    });

    function kpiCardHtml(def) {
      const entry = results[def.id];
      const hasValue = entry.value !== null && Number.isFinite(entry.value);

      return `
        <div class="kpi-card" onclick="NFK_App.openKPIDetail('${def.id}')" style="cursor:pointer;">
          <div class="kpi-label">${escapeHtml(def.label)}</div>
          <div class="kpi-value">${formatKPIValue(entry.value, def.format)}</div>
          <div class="kpi-interp">
            ${
              hasValue
                ? escapeHtml(def.interp)
                : "Unable to calculate — required QuickBooks data did not load."
            }
          </div>
          <div class="kpi-footer">
            <span style="font-size:11px;color:var(--text-muted);">Click for details</span>
            <div class="sparkline-wrap">
              <canvas id="spark-${def.id}" width="100" height="36"></canvas>
            </div>
          </div>
        </div>
      `;
    }

    page.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Health checks <span class="page-title-term">Business Ratios</span></h1>
          <p class="page-subtitle">Calculated from live QuickBooks data — click any card for the full calculation and trend</p>
        </div>
      </div>

      <div class="grid-kpi section-gap">
        ${KPI_DEFS.slice(0, 4).map(kpiCardHtml).join("")}
      </div>

      <div class="grid-kpi section-gap">
        ${KPI_DEFS.slice(4, 8).map(kpiCardHtml).join("")}
      </div>

      <div class="grid-kpi">
        ${KPI_DEFS.slice(8).map(kpiCardHtml).join("")}
      </div>
    `;

    // Historical trend loads separately so the cards with their
    // current values appear immediately; sparklines and the modal's
    // trend chart fill in once the 6 months of QuickBooks data
    // finish loading.
    loadKPITrends()
      .then(periodResults => {
        const labels = periodResults.map(p => p.label);

        const sparklineInput = [];

        KPI_DEFS.forEach(def => {
          const trend = periodResults.map(p => p.values[def.id]?.value ?? null);

          if (kpiDetailStore[def.id]) {
            kpiDetailStore[def.id].trend = trend;
            kpiDetailStore[def.id].trendLabels = labels;
          }

          const knownPoints = trend.filter(v => v !== null && Number.isFinite(v));

          if (knownPoints.length >= 2) {
            sparklineInput.push({ id: def.id, trend: knownPoints });
          }
        });

        if (window.NFK_Charts?.renderKPISparklines) {
          window.NFK_Charts.renderKPISparklines(sparklineInput);
        }
      })
      .catch(error => {
        console.error("❌ Failed to load KPI trends:", error);
      });
  }

  function openKPIDetail(kpiId) {
    const entry = kpiDetailStore[kpiId];

    if (!entry) return;

    const overlay = document.getElementById("modal-overlay");
    const content = document.getElementById("modal-content");

    if (!overlay || !content) return;

    const hasValue = entry.value !== null && Number.isFinite(entry.value);

    const inputsHtml = (entry.inputs || [])
      .map(input => `
        <div class="bs-account-row">
          <span>${escapeHtml(input.label)}</span>
          <strong>${escapeHtml(input.value)}</strong>
        </div>
      `)
      .join("");

    const hasTrend =
      Array.isArray(entry.trend) &&
      entry.trend.filter(v => v !== null && Number.isFinite(v)).length >= 2;

    content.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div class="kpi-label">${escapeHtml(entry.label)}</div>
          <div class="kpi-value" style="font-size:28px;">${formatKPIValue(entry.value, entry.format)}</div>
        </div>
        <button class="btn btn-ghost" onclick="NFK_App.closeKPIModal()">✕</button>
      </div>

      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;">
        ${escapeHtml(entry.interp)}
      </p>

      <div class="card card-pad" style="margin-bottom:20px;background:var(--bg-subtle);">
        <div class="card-title" style="margin-bottom:10px;">How this is calculated</div>
        <p style="font-family:var(--font-mono);font-size:12.5px;color:var(--text-primary);margin-bottom:14px;line-height:1.6;">
          ${
            hasValue
              ? escapeHtml(entry.formula)
              : "Unable to calculate — required QuickBooks data did not load."
          }
        </p>
        ${inputsHtml}
      </div>

      <div class="card-title" style="margin-bottom:10px;">6-Month Trend</div>
      ${
        hasTrend
          ? `<div style="height:180px;"><canvas id="modal-kpi-chart"></canvas></div>`
          : `<p style="font-size:12.5px;color:var(--text-muted);">Loading historical trend from QuickBooks, or not enough historical data is available yet.</p>`
      }
    `;

    overlay.classList.add("open");

    if (hasTrend && window.NFK_Charts?.renderKPIDetailChart) {
      window.NFK_Charts.renderKPIDetailChart(
        "modal-kpi-chart",
        entry.trendLabels,
        entry.trend
      );
    }
  }

  function closeKPIModal() {
    const overlay = document.getElementById("modal-overlay");

    if (overlay) {
      overlay.classList.remove("open");
    }
  }

  // Reuses the same AI-computed health score as the AI Insights page
  // (backend-cached for 5 minutes) — no second scoring calculation.
  async function loadOverviewHealthScore() {
    const container = document.getElementById("overview-health-score");
    if (!container) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      const { health } = await apiGet(
        `/ai/health-score?organizationId=${encodeURIComponent(organizationId)}`
      );

      overviewHealthData = health;

      const color = healthRatingColor(health.rating);
      const pct = Math.max(0, Math.min(100, Math.round(health.score)));
      const firstSentence =
        (health.summary || "").split(/(?<=[.!?])\s+/)[0] || "";

      container.innerHTML = `
        <div class="card card-pad health-score-card health-score-card-clickable" onclick="NFK_App.openHealthDetail()" title="Click for full breakdown">
          <div class="health-ring" style="background: conic-gradient(${color} ${pct}%, var(--bg-subtle) 0);">
            <div class="health-ring-hole"></div>
            <div class="health-ring-inner">
              <div class="health-ring-score">${pct}</div>
              <div class="health-ring-rating" style="color:${color};">${escapeHtml(health.rating)}</div>
            </div>
          </div>
          <div class="health-score-body">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <div class="card-title">Financial Health Score</div>
              <span class="badge badge-pos">Auto-updated</span>
            </div>
            <div class="health-score-summary">${escapeHtml(firstSentence)}</div>
            <div class="health-badge-row">
              ${health.factors.map(f => `
                <span class="health-badge ${f.impact === "positive" ? "pos" : f.impact === "negative" ? "neg" : "neutral"}">
                  ${escapeHtml(f.label)} ${f.impact === "positive" ? "✓" : f.impact === "negative" ? "⚠" : "•"}
                </span>
              `).join("")}
            </div>
          </div>
        </div>
      `;
    } catch (error) {
      console.error("❌ Failed to load overview health score:", error);
      container.innerHTML = `<div class="card card-pad">${aiErrorCardHtml(error)}</div>`;
    }
  }

  // ============================================================
  // OVERVIEW — headline metrics, 12-month trend, alerts
  // ============================================================

  // Comparable prior window for the delta under each headline figure:
  // the equivalent completed period immediately before this one.
  function getPriorPeriodRange(period) {
    const now = new Date();

    if (period === "quarter") {
      const qStart = Math.floor(now.getMonth() / 3) * 3;
      const start = new Date(now.getFullYear(), qStart - 3, 1);
      const end = new Date(now.getFullYear(), qStart, 0);
      return { startDate: toISODate(start), endDate: toISODate(end) };
    }

    if (period === "year" || period === "current") {
      const y = now.getFullYear() - 1;
      return { startDate: `${y}-01-01`, endDate: `${y}-12-31` };
    }

    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { startDate: toISODate(start), endDate: toISODate(end) };
  }

  let overviewState = {
    chartType: "bar",
    history: null,
    prior: null,
    dismissedAlerts: [],
    alerts: null
  };

  async function loadOverviewComparison(period) {
    const { startDate, endDate } = getPriorPeriodRange(period);

    const [plR, cfR, bsR] = await Promise.allSettled([
      fetchProfitAndLossRange(startDate, endDate),
      fetchCashFlowRange(startDate, endDate),
      fetchBalanceSheetAsOf(endDate)
    ]);

    const pick = r => (r.status === "fulfilled" ? r.value : null);
    return { pl: pick(plR), cf: pick(cfR), bs: pick(bsR) };
  }

  async function loadOverviewHistory(months = 12) {
    const periods = getMonthlyPeriods(months);

    const results = await Promise.all(
      periods.map(p =>
        fetchProfitAndLossRange(p.startDate, p.endDate).catch(() => null)
      )
    );

    return periods.map((p, i) => {
      const pl = results[i];

      const totalExpenses =
        Number.isFinite(pl?.costOfGoodsSold) && Number.isFinite(pl?.expenses)
          ? pl.costOfGoodsSold + pl.expenses
          : null;

      return {
        label: p.label,
        revenue: Number.isFinite(pl?.income) ? pl.income : null,
        totalExpenses
      };
    });
  }

  const OVERVIEW_TREND_VIEW = {
    title: "Money In vs. Money Out",
    metrics: [
      { key: "revenue", label: "Money In", color: "primary" },
      { key: "totalExpenses", label: "Money Out", color: "danger" }
    ]
  };

  function drawOverviewTrend() {
    if (!overviewState.history) return;

    if (window.NFK_Charts?.renderForecastTrend) {
      window.NFK_Charts.renderForecastTrend(
        "chart-overview-trend",
        overviewState.history,
        OVERVIEW_TREND_VIEW,
        overviewState.chartType
      );
    }
  }

  function setOverviewChartType(type) {
    overviewState.chartType = type;

    ["bar", "line"].forEach(t => {
      const btn = document.getElementById(`overview-chart-${t}`);
      if (btn) btn.classList.toggle("active", t === type);
    });

    drawOverviewTrend();
  }

  // Cash Runway — "at this pace, how long does your cash last." Uses the
  // same 12-month history the trend chart already fetches (no extra API
  // call), averaged over the last 3 months so one unusual month doesn't
  // swing the number wildly.
  function renderCashRunway() {
    const el = document.getElementById("overview-cash-runway");
    if (!el) return;

    const cashBalance = overviewState.cashBalance;
    const history = overviewState.history;

    const notEnoughData = () => {
      el.innerHTML = `
        <div class="stat-label">How long your cash lasts</div>
        <div class="stat-val">—</div>
        <div class="stat-sub-quiet">Not enough monthly history yet</div>
      `;
    };

    if (!Number.isFinite(cashBalance) || !history) {
      notEnoughData();
      return;
    }

    const recentMonths = history
      .filter(h => Number.isFinite(h.revenue) && Number.isFinite(h.totalExpenses))
      .slice(-3);

    if (recentMonths.length === 0) {
      notEnoughData();
      return;
    }

    const avgMonthlyBurn =
      recentMonths.reduce((sum, h) => sum + (h.totalExpenses - h.revenue), 0) /
      recentMonths.length;

    // Spending less than you're bringing in — there's no countdown to show.
    if (avgMonthlyBurn <= 0) {
      el.innerHTML = `
        <div class="stat-label">How long your cash lasts</div>
        <div class="stat-val pos-val">Growing</div>
        <div class="stat-sub-quiet">You're bringing in more than you're spending</div>
      `;
      return;
    }

    const months = Math.max(cashBalance, 0) / avgMonthlyBurn;
    const urgencyClass = months < 2 ? "neg-val" : months < 6 ? "" : "pos-val";

    el.innerHTML = `
      <div class="stat-label">How long your cash lasts</div>
      <div class="stat-val ${urgencyClass}">${months.toFixed(1)} months</div>
      <div class="stat-sub-quiet">At your recent spending pace</div>
    `;
  }

  // Fills in the two headline metric cards' sparkline slots once the
  // 12-month history they need has loaded. Net income isn't in the
  // history array directly — revenue minus total expenses is a close
  // enough proxy for a trend line (not the headline figure itself).
  function renderOverviewSparklines() {
    const history = overviewState.history;
    if (!history) return;

    const incomeEl = document.getElementById("overview-spark-income");
    if (incomeEl) {
      incomeEl.innerHTML = sparklineSvg(history.map(h => h.revenue));
    }

    const netIncomeEl = document.getElementById("overview-spark-netincome");
    if (netIncomeEl) {
      netIncomeEl.innerHTML = sparklineSvg(
        history.map(h =>
          Number.isFinite(h.revenue) && Number.isFinite(h.totalExpenses)
            ? h.revenue - h.totalExpenses
            : null
        )
      );
    }
  }

  async function loadOverviewTrendChart() {
    const wrap = document.getElementById("overview-trend-body");
    if (!wrap) return;

    try {
      overviewState.history = await loadOverviewHistory(12);
      renderCashRunway();
      renderOverviewSparklines();

      const usable = overviewState.history.filter(
        h => Number.isFinite(h.revenue) || Number.isFinite(h.totalExpenses)
      );

      if (usable.length < 2) {
        wrap.innerHTML = `
          <div class="empty-state">
            Not enough monthly history to chart yet.
          </div>
        `;
        return;
      }

      wrap.innerHTML = `<canvas id="chart-overview-trend"></canvas>`;
      drawOverviewTrend();
    } catch (error) {
      console.error("❌ Overview trend failed:", error);
      wrap.innerHTML = `
        <div class="empty-state">
          Unable to load monthly history.
        </div>
      `;
      renderCashRunway();
    }
  }

  // Anomalies and recommendations, folded into one ranked feed.
  async function loadOverviewAlerts() {
    const body = document.getElementById("overview-alerts-body");
    if (!body) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      const [anomR, recR] = await Promise.allSettled([
        apiGet(`/ai/anomalies?organizationId=${encodeURIComponent(organizationId)}`),
        apiGet(`/ai/recommendations?organizationId=${encodeURIComponent(organizationId)}`)
      ]);

      const anomalies =
        anomR.status === "fulfilled" ? anomR.value?.anomalies || [] : [];

      const recommendations =
        recR.status === "fulfilled" ? recR.value?.recommendations || [] : [];

      const rank = { high: 0, medium: 1, low: 2 };

      // The feed carries only what warrants attention now: the two
      // highest-risk anomalies and the single strongest recommendation.
      const topAnomalies = [...anomalies]
        .sort(
          (x, y) =>
            (rank[(x.severity || "").toLowerCase()] ?? 3) -
            (rank[(y.severity || "").toLowerCase()] ?? 3)
        )
        .slice(0, 2);

      const topRecommendation = [...recommendations]
        .sort(
          (x, y) =>
            (rank[(x.priority || "").toLowerCase()] ?? 3) -
            (rank[(y.priority || "").toLowerCase()] ?? 3)
        )
        .slice(0, 1);

      const alerts = [
        ...topAnomalies.map((item, i) => ({
          id: `anomaly-${i}`,
          kind: (item.severity || "").toLowerCase() === "high" ? "warning" : "info",
          weight: rank[(item.severity || "").toLowerCase()] ?? 3,
          title: item.title,
          body: item.description,
          meta: item.evidence,
          tag: `${item.severity} severity · ${item.category}`
        })),
        ...topRecommendation.map((item, i) => ({
          id: `rec-${i}`,
          kind: "positive",
          weight: (rank[(item.priority || "").toLowerCase()] ?? 3) + 0.5,
          title: item.title,
          body: item.description,
          meta: item.expectedImpact,
          tag: `${item.priority} priority · ${item.category}`
        }))
      ];

      overviewState.alerts = alerts;
      renderOverviewAlerts();
    } catch (error) {
      console.error("❌ Overview alerts failed:", error);
      body.innerHTML = `
        <div class="empty-state">
          Unable to load AI alerts.
        </div>
      `;
    }
  }

  function renderOverviewAlerts() {
    const body = document.getElementById("overview-alerts-body");
    if (!body || !overviewState.alerts) return;

    const visible = overviewState.alerts.filter(
      alert => !overviewState.dismissedAlerts.includes(alert.id)
    );

    if (!visible.length) {
      body.innerHTML = `
        <div class="empty-state">
          Nothing flagged right now.
        </div>
      `;
      return;
    }

    const glyph = {
      warning: icon_alert_warning(),
      info: icon_alert_info(),
      positive: icon_alert_ok()
    };

    body.innerHTML = visible
      .map(
        alert => `
        <div class="alert-row ${alert.kind}" onclick="NFK_App.nav('ai-insights')" style="cursor:pointer;">

          <span class="alert-glyph">${glyph[alert.kind]}</span>

          <div class="alert-content">
            <div class="alert-title">${escapeHtml(alert.title)}</div>
            <div class="alert-body ai-msg-markdown">${renderMarkdown(alert.body)}</div>
            <div class="alert-meta">${escapeHtml(alert.meta || "")}</div>
          </div>

          <button
            class="alert-dismiss"
            title="Dismiss"
            onclick="event.stopPropagation(); NFK_App.dismissOverviewAlert('${alert.id}')"
          >&times;</button>

        </div>
      `
      )
      .join("");
  }

  function dismissOverviewAlert(id) {
    if (!overviewState.dismissedAlerts.includes(id)) {
      overviewState.dismissedAlerts.push(id);
    }
    renderOverviewAlerts();
  }

  // ------------------------------------------------------------
  // TAX SET-ASIDE ESTIMATOR
  //
  // Real tax rates vary too much (entity type, state, deductions) for
  // this app to compute one accurately, so the owner sets their own
  // rough rate. Deliberately kept in localStorage rather than the
  // database — this is a per-user rule-of-thumb setting, not shared
  // organization data, and it means zero backend changes for a small,
  // low-stakes feature.
  // ------------------------------------------------------------

  const TAX_RATE_STORAGE_KEY = "nfk-tax-rate-pct";
  const DEFAULT_TAX_RATE_PCT = 25;

  function getTaxRatePct() {
    const stored = Number(localStorage.getItem(TAX_RATE_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 0 && stored <= 60
      ? stored
      : DEFAULT_TAX_RATE_PCT;
  }

  function taxSetAsideCardHtml(netIncome) {
    const rate = getTaxRatePct();

    const hasIncome = Number.isFinite(netIncome);
    const suggested = hasIncome && netIncome > 0 ? netIncome * (rate / 100) : 0;

    return `
      <div class="stat-card" id="overview-tax-setaside">
        <div class="stat-label">Tax Set-Aside</div>
        <div class="stat-val">
          ${hasIncome ? formatCurrency(suggested) : "—"}
        </div>
        <div class="stat-sub-quiet">
          ${
            hasIncome && netIncome <= 0
              ? "No profit this period — nothing to set aside"
              : `Suggested, at`
          }
          ${
            hasIncome && netIncome > 0
              ? `<input
                  type="number"
                  id="tax-rate-input"
                  value="${rate}"
                  min="0"
                  max="60"
                  style="width:40px;margin:0 3px;background:transparent;border:none;border-bottom:1px solid var(--border);color:inherit;font:inherit;text-align:center;"
                  onchange="NFK_App.updateTaxRate(this.value)"
                >% of profit`
              : ""
          }
        </div>
      </div>
    `;
  }

  // Called by the rate input's onchange — recalculates and re-renders
  // just this one card, so editing the rate doesn't reload the page
  // or lose scroll position.
  function updateTaxRate(rawValue) {
    const value = Math.min(60, Math.max(0, Number(rawValue) || 0));
    localStorage.setItem(TAX_RATE_STORAGE_KEY, String(value));

    const el = document.getElementById("overview-tax-setaside");
    if (el && Number.isFinite(overviewState.netIncome)) {
      el.outerHTML = taxSetAsideCardHtml(overviewState.netIncome);
    }
  }

  // The one-line answer to "how is my business doing", in the words an
  // owner would use. Built only from figures that actually loaded — each
  // clause is dropped if its number is missing, and the whole line is
  // dropped if none of them are available, so it can never assert
  // something the data doesn't support.
  function overviewSummaryLine({ income, netIncome, cashBalance, periodLabel, currency }) {
    const has = v => Number.isFinite(v);
    const money = v => formatCurrency(Number(v), currency);
    const period = (periodLabel || "this month").toLowerCase();

    const sentences = [];

    if (has(income) && income === 0) {
      sentences.push(`No money has come in ${period} yet.`);
    } else if (has(income) && has(netIncome)) {
      sentences.push(
        netIncome === 0
          ? `You brought in ${money(income)} ${period} and broke even.`
          : netIncome > 0
          ? `You brought in ${money(income)} ${period} and kept ${money(netIncome)} of it.`
          : `You brought in ${money(income)} ${period}, but spent ${money(Math.abs(netIncome))} more than that.`
      );
    } else if (has(income)) {
      sentences.push(`You brought in ${money(income)} ${period}.`);
    }

    if (has(cashBalance)) {
      sentences.push(`There's ${money(cashBalance)} in the bank right now.`);
    }

    return sentences.join(" ");
  }

  function renderOverview({ pl, bs, cf, ar, ap, debt }) {

    const page =
      document.getElementById("page-overview");

    if (!page) return;

    const currency =
      pl?.currency || bs?.currency || "USD";

    function statCard(label, value, isError) {
      return `
        <div class="stat-card">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-val">
            ${
              isError
                ? "—"
                : formatCurrency(Number(value || 0), currency)
            }
          </div>
          ${
            isError
              ? `<div class="stat-sub neg">Unable to load</div>`
              : ""
          }
        </div>
      `;
    }

    function ratioCard(label, value, isError, suffix = "%") {
      return `
        <div class="stat-card">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-val">
            ${
              isError || value === null
                ? "—"
                : `${value.toFixed(1)}${suffix}`
            }
          </div>
          ${
            isError || value === null
              ? `<div class="stat-sub neg">Unable to calculate</div>`
              : `<div class="stat-sub">Calculated from QuickBooks data</div>`
          }
        </div>
      `;
    }

    // ------------------------------------------------------
    // Ratios — computed only from real fetched QuickBooks
    // figures. Left null (rendered as "—") when the source
    // data needed for the calculation is unavailable.
    // ------------------------------------------------------

    const income = pl?.error ? null : Number(pl?.income || 0);
    const netIncome = pl?.error ? null : Number(pl?.netIncome || 0);
    const grossProfit = pl?.error ? null : Number(pl?.grossProfit || 0);

    const grossMargin =
      income && income !== 0
        ? (grossProfit / income) * 100
        : null;

    const netMargin =
      income && income !== 0
        ? (netIncome / income) * 100
        : null;

    const totalAssets = bs?.error ? null : Number(bs?.totalAssets || 0);
    const totalLiabilities = bs?.error ? null : Number(bs?.totalLiabilities || 0);

    const currentRatio =
      totalAssets !== null &&
      totalLiabilities !== null &&
      totalLiabilities !== 0
        ? totalAssets / totalLiabilities
        : null;

    const periodLabel =
      state.overviewPeriod === "quarter"
        ? "This Quarter"
        : state.overviewPeriod === "year"
        ? "Year to Date"
        : "This Month";

    const prior = overviewState.prior || {};

    const cashBalance = cf?.error ? null : Number(cf?.closingCash || 0);

    // Stashed for renderCashRunway(), which runs later once
    // overviewState.history has loaded (see loadOverviewTrendChart).
    overviewState.cashBalance = cashBalance;
    overviewState.netIncome = netIncome;

    const kpi = computeKPIValues({ pl, bs, ar, ap });
    const workingCapital = kpi?.workingCapital?.value ?? null;

    const priorIncome = Number.isFinite(prior.pl?.income) ? prior.pl.income : null;
    const priorNetIncome = Number.isFinite(prior.pl?.netIncome) ? prior.pl.netIncome : null;
    const priorCash = Number.isFinite(prior.cf?.closingCash) ? prior.cf.closingCash : null;

    const priorWorkingCapital = prior.bs
      ? (computeKPIValues({
          pl: prior.pl || { error: true },
          bs: prior.bs,
          ar: { error: true },
          ap: { error: true }
        })?.workingCapital?.value ?? null)
      : null;

    // "Last synced <date>" used to print today's date unconditionally,
    // which implied a sync job that doesn't exist — the app reads from
    // QuickBooks live on each request, so the figures are current by
    // construction. Say that instead of inventing a timestamp.
    const overviewSubtitle = [
      state.qbCompanyName || "QuickBooks",
      `FY ${new Date().getFullYear()}`,
      "Read live from QuickBooks"
    ].join(" · ");

    // Headline metric card: the figure, then its movement against
    // the comparable prior window. `secondaryLabel`, when given, shows
    // the accounting term in small muted text next to the plain-
    // language headline — per the product plan's rule of leading with
    // owner language and keeping the accounting term as an optional
    // secondary label, not deleting it.
    function metricCard(label, value, priorValue, isError, glyph, secondaryLabel, sparklineId) {
      const hasDelta =
        !isError &&
        Number.isFinite(value) &&
        Number.isFinite(priorValue) &&
        priorValue !== 0;

      const pct = hasDelta
        ? ((value - priorValue) / Math.abs(priorValue)) * 100
        : null;

      const up = hasDelta && pct >= 0;

      return `
        <div class="stat-card metric-card">

          <div class="metric-glyph">${glyph}</div>

          <div class="stat-label">${escapeHtml(label)}${
            secondaryLabel
              ? ` <span class="stat-sub-quiet">(${escapeHtml(secondaryLabel)})</span>`
              : ""
          }</div>

          <div class="stat-val">
            ${
              isError || !Number.isFinite(value)
                ? "—"
                : formatCurrency(Number(value), currency)
            }
          </div>

          ${sparklineId ? `<div class="stat-sparkline-slot" id="${sparklineId}"></div>` : ""}

          <div class="stat-sub">
            ${
              isError
                ? `<span class="neg">Unable to load</span>`
                : hasDelta
                ? `<span class="${up ? "pos" : "neg"}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%</span><span class="stat-sub-quiet">vs ${fmtShort(priorValue)} prior period</span>`
                : `<span class="stat-sub-quiet">No comparable prior period</span>`
            }
          </div>

        </div>
      `;
    }

    page.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Overview</h1>
          <p class="page-subtitle">${escapeHtml(overviewSubtitle)}</p>
        </div>

        <div class="page-header-actions">
          ${renderPeriodSelector(state.overviewPeriod, "setOverviewPeriod")}

          <button class="btn btn-primary" onclick="NFK_App.nav('ai-insights')">
            AI Insights
          </button>
        </div>
      </div>

      ${(() => {
        const line = overviewSummaryLine({
          income, netIncome, cashBalance, periodLabel, currency
        });
        return line ? `<p class="overview-summary">${escapeHtml(line)}</p>` : "";
      })()}

      <div class="stat-grid section-gap">
        ${metricCard(`Money earned (${periodLabel})`, income, priorIncome, !!pl?.error, icon_pl(), "Revenue", "overview-spark-income")}
        ${metricCard("What you kept", netIncome, priorNetIncome, !!pl?.error, icon_forecast(), "Net Income", "overview-spark-netincome")}
        ${metricCard("Cash in the bank", cashBalance, priorCash, !!cf?.error, icon_flow())}
        ${metricCard("Cushion after short-term bills", workingCapital, priorWorkingCapital, !!bs?.error, icon_scale(), "Working Capital")}

        <div class="stat-card" id="overview-cash-runway">
          <div class="stat-label">How long your cash lasts</div>
          <div class="stat-val">
            <span class="skeleton-line skeleton-shimmer" style="width:70px;height:22px;display:inline-block;margin:0;"></span>
          </div>
        </div>

        ${taxSetAsideCardHtml(netIncome)}
      </div>

      <div class="card card-pad section-gap" id="cash-projection-body">
        ${renderSkeletonCard(4)}
      </div>

      <div class="grid-2 section-gap">

        <div class="card card-pad">
          <div class="card-header">
            <div class="card-title">Money In vs. Money Out — 12 Months</div>

            <div class="period-selector">
              <button
                class="period-btn ${overviewState.chartType === "bar" ? "active" : ""}"
                id="overview-chart-bar"
                onclick="NFK_App.setOverviewChartType('bar')"
              >Bar</button>

              <button
                class="period-btn ${overviewState.chartType === "line" ? "active" : ""}"
                id="overview-chart-line"
                onclick="NFK_App.setOverviewChartType('line')"
              >Line</button>
            </div>
          </div>

          <div class="chart-frame" id="overview-trend-body">
            <div class="skeleton-line skeleton-shimmer" style="height:100%;margin:0;"></div>
          </div>
        </div>

        <div id="overview-health-score">
          <div class="card card-pad">
            <p style="color:var(--text-secondary);">Calculating financial health score...</p>
          </div>
        </div>

      </div>

      <div class="section-heading">AI Alerts &amp; Insights</div>

      <div id="overview-alerts-body" class="alert-list section-gap">
        <div class="card card-pad">
          <p style="color:var(--text-secondary);">Scanning your data...</p>
        </div>
      </div>

      <div class="grid-2">
        <div class="card card-pad">
          <div class="card-header">
            <div class="card-title">Receivables &amp; Payables</div>
          </div>

          <div class="bs-account-row">
            <span>Customers owe you <span class="stat-sub-quiet">(Accounts Receivable)</span></span>
            <strong>${ar?.error ? "—" : formatCurrency(Number(ar?.total || 0), currency)}</strong>
          </div>

          <div class="bs-account-row">
            <span>Bills you need to pay <span class="stat-sub-quiet">(Accounts Payable)</span></span>
            <strong>${ap?.error ? "—" : formatCurrency(Number(ap?.total || 0), currency)}</strong>
          </div>

          ${(() => {
            const arTotal = ar?.error ? null : Number(ar?.total || 0);
            const apTotal = ap?.error ? null : Number(ap?.total || 0);

            if (arTotal === null || apTotal === null || arTotal + apTotal === 0) {
              return "";
            }

            const sum = arTotal + apTotal;
            const arPct = (arTotal / sum) * 100;
            const apPct = 100 - arPct;

            return `
              <div class="cashflow-bar-wrap">
                <div class="cashflow-bar-label">Coming in vs. going out</div>
                <div class="cashflow-bar">
                  <div class="cashflow-bar-in" style="width:${arPct}%;"></div>
                  <div class="cashflow-bar-out" style="width:${apPct}%;"></div>
                </div>
                <div class="cashflow-bar-legend">
                  <span><span class="cashflow-dot cashflow-dot-in"></span>${formatCurrency(arTotal, currency)} coming in</span>
                  <span><span class="cashflow-dot cashflow-dot-out"></span>${formatCurrency(apTotal, currency)} going out</span>
                </div>
              </div>
            `;
          })()}

          <div class="bs-account-row">
            <span>Current Ratio</span>
            <strong>${currentRatio === null ? "—" : currentRatio.toFixed(2) + "x"}</strong>
          </div>
        </div>

        <div class="card card-pad">
          <div class="card-header">
            <div class="card-title">Debt Breakdown</div>
          </div>
          ${
            debt?.error
              ? `<div class="stat-sub neg">Unable to load debt data</div>`
              : `
                <div class="bs-account-row">
                  <span>Current Debt</span>
                  <strong>${formatCurrency(Number(debt?.currentDebt || 0), currency)}</strong>
                </div>
                <div class="bs-account-row">
                  <span>Long-Term Debt</span>
                  <strong>${formatCurrency(Number(debt?.longTermDebt || 0), currency)}</strong>
                </div>
                <div class="bs-account-row">
                  <span>Total Debt</span>
                  <strong>${formatCurrency(Number(debt?.totalDebt || 0), currency)}</strong>
                </div>
              `
          }
        </div>
      </div>
    `;

    loadOverviewHealthScore();
    loadOverviewTrendChart();
    loadOverviewAlerts();
    loadCashProjection();
  }

  // ------------------------------------------------------------
  // WHERE YOUR CASH IS HEADING
  //
  // The only forward-looking figure on the Overview that comes from
  // dated records rather than a trend: today's bank balance walked
  // forward through the due dates on unpaid invoices and bills. All of
  // the arithmetic happens server-side; this only draws the result.
  // ------------------------------------------------------------

  async function loadCashProjection() {
    const body = document.getElementById("cash-projection-body");
    if (!body) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      const projection = await apiGet(
        `/quickbooks/cash-projection?organizationId=${encodeURIComponent(organizationId)}&days=30`
      );

      renderCashProjection(projection);
    } catch (error) {
      console.error("Cash projection failed:", error);

      body.innerHTML = `
        <div class="empty-state">
          ${escapeHtml(
            error?.code === "QB_REAUTH_REQUIRED"
              ? "Reconnect QuickBooks to see where your cash is heading."
              : "Unable to work out your cash projection right now."
          )}
        </div>
      `;
    }
  }

  function renderCashProjection(projection) {
    const body = document.getElementById("cash-projection-body");
    if (!body || !projection) return;

    const currency = projection.currency || "USD";
    const money = v => formatCurrency(Number(v || 0), currency);

    const movementDays = (projection.timeline || []).filter(
      d => d.moneyIn || d.moneyOut
    ).length;

    const tip = projection.timingTip;
    const overdue = projection.overdue || {};

    // With nothing dated in the window the chart would be a flat line
    // that implies a forecast we don't have, so say what's actually
    // known instead of drawing a straight line and calling it a
    // projection.
    const hasForwardMovement = movementDays > 0;

    body.innerHTML = `
      <div class="cashproj-head">
        <div>
          <div class="cashproj-eyebrow">Next 30 days</div>
          <div class="cashproj-title">Where your cash is heading</div>
        </div>
        <div class="cashproj-figures">
          <div class="cashproj-figure">
            <span class="cashproj-figure-label">In the bank now</span>
            <strong>${money(projection.openingCash)}</strong>
          </div>
          ${
            Number.isFinite(projection.safeFloor)
              ? `<div class="cashproj-figure">
                   <span class="cashproj-figure-label">Your usual monthly outgoings</span>
                   <strong class="cashproj-floor">${money(projection.safeFloor)}</strong>
                 </div>`
              : ""
          }
        </div>
      </div>

      ${
        hasForwardMovement
          ? `<div class="chart-frame cashproj-chart"><canvas id="chart-cash-projection"></canvas></div>`
          : `<div class="cashproj-nodata">
               Nothing is currently dated in the next 30 days — every unpaid
               invoice and bill in your books is already past its due date,
               so there is no future timing to plot yet.
             </div>`
      }

      ${
        tip
          ? `<div class="cashproj-tip">
               <div class="cashproj-tip-head">Worth knowing</div>
               <p class="cashproj-tip-body">${escapeHtml(tip.suggestion)}</p>
               ${
                 tip.bill
                   ? `<div class="cashproj-tip-meta">${escapeHtml(tip.bill.party)} · ${money(tip.bill.amount)} · due ${escapeHtml(tip.bill.dueDate)}</div>`
                   : ""
               }
             </div>`
          : ""
      }

      <div class="cashproj-overdue">
        <div class="cashproj-overdue-item">
          <span>Already owed to you</span>
          <strong class="pos-val">${money(overdue.customersOweYou)}</strong>
          <span class="cashproj-overdue-meta">${Number(overdue.customerCount || 0)} overdue invoice${Number(overdue.customerCount) === 1 ? "" : "s"}</span>
        </div>
        <div class="cashproj-overdue-item">
          <span>You already owe</span>
          <strong class="neg-val">${money(overdue.youOweSuppliers)}</strong>
          <span class="cashproj-overdue-meta">${Number(overdue.supplierCount || 0)} overdue bill${Number(overdue.supplierCount) === 1 ? "" : "s"}</span>
        </div>
      </div>
    `;

    if (hasForwardMovement && window.NFK_Charts?.renderCashProjection) {
      window.NFK_Charts.renderCashProjection("chart-cash-projection", projection);
    }
  }

  async function setOverviewPeriod(period) {
    state.overviewPeriod = period;

    const page = document.getElementById("page-overview");

    if (page) {
      page.innerHTML = `
        ${renderSkeletonCard(2)}
        ${renderSkeletonStatGrid(4)}
        ${renderSkeletonCard(4)}
      `;
    }

    loadOverviewComparison(period)
      .then(prior => { overviewState.prior = prior; })
      .catch(() => { overviewState.prior = null; });

    const results = await Promise.allSettled([
      loadProfitAndLoss(period),
      loadBalanceSheet(period),
      loadCashFlow(period),
      loadAccountsReceivable(),
      loadAccountsPayable(),
      loadDebt()
    ]);

    const [pl, bs, cf, ar, ap, debt] = results.map(r =>
      r.status === "fulfilled"
        ? r.value
        : { error: r.reason?.message || "Failed to load" }
    );

    renderOverview({ pl, bs, cf, ar, ap, debt });
  }

  function navigate(pageId) {
    document
      .querySelectorAll(".page")
      .forEach(p =>
        p.classList.remove("active")
      );

    document
      .querySelectorAll(
        ".nav-item, .nav-flat-item"
      )
      .forEach(n =>
        n.classList.remove("active")
      );

    const pg =
      document.getElementById(
        "page-" + pageId
      );

    if (pg) {
      pg.classList.add("active");
    }

    const nav =
      document.querySelector(
        `.nav-item[data-page="${pageId}"], .nav-flat-item[data-page="${pageId}"]`
      );

    if (nav) {
      nav.classList.add("active");
    }

    state.currentPage =
      pageId;

    buildSidebar(pageId);

    window.scrollTo(0, 0);

    if (pageId === "overview") {

      const page =
        document.getElementById("page-overview");

      if (page) {
        page.innerHTML = `
          ${renderSkeletonCard(2)}
          ${renderSkeletonStatGrid(4)}
          ${renderSkeletonCard(4)}
        `;
      }

      loadOverviewComparison(state.overviewPeriod)
        .then(prior => { overviewState.prior = prior; })
        .catch(() => { overviewState.prior = null; });

      Promise.allSettled([
        loadProfitAndLoss(state.overviewPeriod),
        loadBalanceSheet(state.overviewPeriod),
        loadCashFlow(state.overviewPeriod),
        loadAccountsReceivable(),
        loadAccountsPayable(),
        loadDebt()
      ]).then(results => {
        const [pl, bs, cf, ar, ap, debt] = results.map(r =>
          r.status === "fulfilled"
            ? r.value
            : { error: r.reason?.message || "Failed to load" }
        );

        renderOverview({ pl, bs, cf, ar, ap, debt });
      });
    }

    if (pageId === "kpis") {

      const page =
        document.getElementById("page-kpis");

      if (page) {
        page.innerHTML = `
          ${renderSkeletonStatGrid(3)}
          ${renderSkeletonStatGrid(3)}
        `;
      }

      Promise.allSettled([
        loadProfitAndLoss("current"),
        loadBalanceSheet("current"),
        loadAccountsReceivable(),
        loadAccountsPayable()
      ]).then(results => {
        const [pl, bs, ar, ap] = results.map(r =>
          r.status === "fulfilled"
            ? r.value
            : { error: r.reason?.message || "Failed to load" }
        );

        renderKPIs({ pl, bs, ar, ap });
      });
    }

    if (pageId === "balance-sheet") {

      const page =
        document.getElementById(
          "page-balance-sheet"
        );
    
      if (page) {
        page.innerHTML = `
          ${renderSkeletonCard(2)}
          <div class="section-gap"></div>
          ${renderSkeletonCard(8)}
        `;
      }

      loadBalanceSheetComparison(state.bsPeriod)
        .then(({ current, prior }) => {
          renderBalanceSheet(current, prior);
        })
        .catch(error => {

          console.error(
            "❌ Balance Sheet failed:",
            error
          );
    
          if (page) {
            page.innerHTML = `
              <div class="card card-pad">
    
                <div style="
                  font-size:18px;
                  font-weight:600;
                ">
                  ⚠️ Unable to load Balance Sheet
                </div>
    
                <p style="margin-top:8px;">
                  ${escapeHtml(
                    error.message
                  )}
                </p>
    
                <button
                  onclick="NFK_App.nav('balance-sheet')"
                  style="
                    margin-top:16px;
                    padding:10px 16px;
                    border:none;
                    border-radius:8px;
                    cursor:pointer;
                  "
                >
                  🔄 Try Again
                </button>
    
              </div>
            `;
          }
        });
    }
      if (pageId === "pl") {
    
      const page =
        document.getElementById("page-pl");
    
      if (page) {
        page.innerHTML = `
          ${renderSkeletonCard(2)}
          <div class="section-gap"></div>
          ${renderSkeletonCard(10)}
        `;
      }

      loadProfitAndLoss(state.plPeriod)
        .then(data => {
          renderProfitAndLoss(data);
        })
        .catch(error => {

          console.error(
            "❌ Profit & Loss failed:",
            error
          );
    
          if (page) {
            page.innerHTML = `
              <div class="card card-pad">
    
                <div style="
                  font-size:18px;
                  font-weight:600;
                ">
                  ⚠️ Unable to load Profit & Loss
                </div>
    
                <p style="margin-top:8px;">
                  ${escapeHtml(error.message)}
                </p>
    
                <button
                  onclick="NFK_App.nav('pl')"
                  style="
                    margin-top:16px;
                    padding:10px 16px;
                    border:none;
                    border-radius:8px;
                    cursor:pointer;
                  "
                >
                  🔄 Try Again
                </button>
    
              </div>
            `;
          }
        });
      }
      if (pageId === "cash-flow") {
      
        const page =
          document.getElementById("page-cash-flow");
      
        if (page) {
      
          page.innerHTML = `
            ${renderSkeletonCard(2)}
            <div class="section-gap"></div>
            ${renderSkeletonCard(7)}
          `;

        }

        loadCashFlow(state.cfPeriod)
          .then(data => {

            renderCashFlow(data);

          })
          .catch(error => {
      
            console.error(
              "❌ Cash Flow failed:",
              error
            );
      
            if (page) {
      
              page.innerHTML = `
                <div class="card card-pad">
      
                  <div style="
                    font-size:18px;
                    font-weight:600;
                  ">
                    ⚠️ Unable to load Cash Flow
                  </div>
      
                  <p style="margin-top:8px;">
                    ${escapeHtml(
                      error.message
                    )}
                  </p>
      
                  <button
                    onclick="NFK_App.nav('cash-flow')"
                    style="
                      margin-top:16px;
                      padding:10px 16px;
                      border:none;
                      border-radius:8px;
                      cursor:pointer;
                    "
                  >
                    🔄 Try Again
                  </button>
      
                </div>
              `;
      
            }
      
          });
      
      }
        if (pageId === "working-capital") {
        
          const page =
            document.getElementById("page-working-capital");
        
          if (!page) return;
        
          page.innerHTML = `
            <div class="page-header">
              <div>
                <h1>Money owed to you <span class="page-title-term">Accounts Receivable</span></h1>
                <p>Read live from QuickBooks</p>
              </div>
            </div>

            <div class="card ar-summary-card">

              <div class="ar-summary-header">
                <h2>Customers owe you <span class="stat-sub-quiet">(Accounts Receivable)</span></h2>
        
                <strong id="ar-total">
                  ${formatCurrency(0)}
                </strong>
              </div>
        
              <div class="ar-aging-bar">
        
                <div
                  id="ar-current-bar"
                  class="ar-aging-segment ar-current">
                </div>
        
                <div
                  id="ar-30-bar"
                  class="ar-aging-segment ar-30">
                </div>
        
                <div
                  id="ar-60-bar"
                  class="ar-aging-segment ar-60">
                </div>
        
                <div
                  id="ar-90-bar"
                  class="ar-aging-segment ar-90">
                </div>
        
                <div
                  id="ar-over90-bar"
                  class="ar-aging-segment ar-over90">
                </div>
        
              </div>
        
              <div class="ar-aging-legend">
        
                <span>
                  <i class="dot current"></i>
                  Current (<span id="ar-current">0</span>)
                </span>
        
                <span>
                  <i class="dot d30"></i>
                  1–30 days (<span id="ar-30">0</span>)
                </span>
        
                <span>
                  <i class="dot d60"></i>
                  31–60 days (<span id="ar-60">0</span>)
                </span>
        
                <span>
                  <i class="dot d90"></i>
                  61–90 days (<span id="ar-90">0</span>)
                </span>
        
                <span>
                  <i class="dot over90"></i>
                  90+ days (<span id="ar-over90">0</span>)
                </span>
        
              </div>
        
            </div>
        
            <div class="card ar-customers-card">
        
              <div class="ar-table-header">
                <span>Customer</span>
                <span>Amount</span>
                <span>Status</span>
              </div>
        
              <div id="ar-customers-list"></div>
        
            </div>
          `;
        
          loadAccountsReceivable()
            .then(data => {
        
              console.log(
                "✅ AR data:",
                data
              );
        
              const total =
                Number(data?.total || 0);
        
              const aging =
                data?.aging || {};
              const agingTotal =
                Object.values(aging).reduce(
                  (sum, value) => sum + Number(value || 0),
                  0
                );
              
              const setAgingWidth = (id, value) => {
              
                const element =
                  document.getElementById(id);
              
                if (!element) return;
              
                const amount =
                  Number(value || 0);
              
                element.style.width =
                  agingTotal > 0
                    ? `${(amount / agingTotal) * 100}%`
                    : "0%";
              };
              
              setAgingWidth(
                "ar-current-bar",
                aging.current
              );
              
              setAgingWidth(
                "ar-30-bar",
                aging.days1to30
              );
              
              setAgingWidth(
                "ar-60-bar",
                aging.days31to60
              );
              
              setAgingWidth(
                "ar-90-bar",
                aging.days61to90
              );
              
              setAgingWidth(
                "ar-over90-bar",
                aging.over90
              );
        
              document.getElementById(
                "ar-total"
              ).textContent =
                formatCurrency(total);
        
              document.getElementById(
                "ar-current"
              ).textContent =
                formatCurrency(
                  aging.current || 0
                );
        
              document.getElementById(
                "ar-30"
              ).textContent =
                formatCurrency(
                  aging.days1to30 || 0
                );
        
              document.getElementById(
                "ar-60"
              ).textContent =
                formatCurrency(
                  aging.days31to60 || 0
                );
        
              document.getElementById(
                "ar-90"
              ).textContent =
                formatCurrency(
                  aging.days61to90 || 0
                );
        
              document.getElementById(
                "ar-over90"
              ).textContent =
                formatCurrency(
                  aging.over90 || 0
                );
        
        
              const customers =
                data?.customers || [];
        
              const list =
                document.getElementById(
                  "ar-customers-list"
                );
        
              list.innerHTML =
              customers.map(customer => {
                
                  let status = "Current";
                  let statusClass = "current";
                
                  if (Number(customer.over90) > 0) {
                    status = "90+ days";
                    statusClass = "over90";
                  } else if (Number(customer.days61to90) > 0) {
                    status = "61–90 days";
                    statusClass = "over90";
                  } else if (Number(customer.days31to60) > 0) {
                    status = "31–60 days";
                    statusClass = "warning";
                  } else if (Number(customer.days1to30) > 0) {
                    status = "1–30 days";
                    statusClass = "info";
                  }
                
                  return `
                    <div class="ar-customer-row">
                
                      <span>
                        ${escapeHtml(customer.name)}
                      </span>
                
                      <strong>
                        ${formatCurrency(
                          customer.amount || 0
                        )}
                      </strong>
                
                      <span class="ar-status ${statusClass}">
                        ${status}
                      </span>
                
                    </div>
                  `;
                
                }).join("")
        
            })
            .catch(error => {
        
              console.error(
                "❌ AR loading failed:",
                error
              );
        
            });
        
        }    
        if (pageId === "ap-vendors") {
        
          const page =
            document.getElementById("page-ap-vendors");
        
          if (!page) return;
        
          page.innerHTML = `
            <div class="page-header">
              <div>
                <h1>Bills to pay <span class="page-title-term">Accounts Payable</span></h1>
                <p>Read live from QuickBooks</p>
              </div>
            </div>

            <div class="card ar-summary-card">

              <div class="ar-summary-header">
                <h2>Bills you need to pay <span class="stat-sub-quiet">(Accounts Payable)</span></h2>
        
                <strong id="ap-total">
                  ${formatCurrency(0)}
                </strong>
              </div>
        
              <div class="ar-aging-bar">
        
                <div
                  id="ap-current-bar"
                  class="ar-aging-segment ar-current">
                </div>
        
                <div
                  id="ap-30-bar"
                  class="ar-aging-segment ar-30">
                </div>
        
                <div
                  id="ap-60-bar"
                  class="ar-aging-segment ar-60">
                </div>
        
                <div
                  id="ap-90-bar"
                  class="ar-aging-segment ar-90">
                </div>
        
                <div
                  id="ap-over90-bar"
                  class="ar-aging-segment ar-over90">
                </div>
        
              </div>
        
              <div class="ar-aging-legend">
        
                <span>
                  <i class="dot current"></i>
                  Current (<span id="ap-current">0</span>)
                </span>
        
                <span>
                  <i class="dot d30"></i>
                  1–30 days (<span id="ap-30">0</span>)
                </span>
        
                <span>
                  <i class="dot d60"></i>
                  31–60 days (<span id="ap-60">0</span>)
                </span>
        
                <span>
                  <i class="dot d90"></i>
                  61–90 days (<span id="ap-90">0</span>)
                </span>
        
                <span>
                  <i class="dot over90"></i>
                  90+ days (<span id="ap-over90">0</span>)
                </span>
        
              </div>
        
            </div>
        
            <div class="card ar-customers-card">
        
              <div class="ar-table-header">
                <span>Vendor</span>
                <span>Amount</span>
                <span>Status</span>
              </div>
        
              <div id="ap-vendors-list"></div>
        
            </div>
          `;
          console.log(
              " AP PAGE OPENED - calling loadAccountsPayable()"
          )
          loadAccountsPayable()
            .then(data => {
        
              console.log(
                "✅ AP data:",
                data
              );
        
              const total =
                Number(data?.total || 0);
        
              const aging =
                data?.aging || {};
        
              const agingTotal =
                Object.values(aging).reduce(
                  (sum, value) =>
                    sum + Number(value || 0),
                  0
                );
        
              const setAgingWidth = (
                id,
                value
              ) => {
        
                const element =
                  document.getElementById(id);
        
                if (!element) return;
        
                const amount =
                  Number(value || 0);
        
                element.style.width =
                  agingTotal > 0
                    ? `${(amount / agingTotal) * 100}%`
                    : "0%";
              };
        
              setAgingWidth(
                "ap-current-bar",
                aging.current
              );
        
              setAgingWidth(
                "ap-30-bar",
                aging.days1to30
              );
        
              setAgingWidth(
                "ap-60-bar",
                aging.days31to60
              );
        
              setAgingWidth(
                "ap-90-bar",
                aging.days61to90
              );
        
              setAgingWidth(
                "ap-over90-bar",
                aging.over90
              );
        
              document.getElementById(
                "ap-total"
              ).textContent =
                formatCurrency(total);
        
              document.getElementById(
                "ap-current"
              ).textContent =
                formatCurrency(
                  aging.current || 0
                );
        
              document.getElementById(
                "ap-30"
              ).textContent =
                formatCurrency(
                  aging.days1to30 || 0
                );
        
              document.getElementById(
                "ap-60"
              ).textContent =
                formatCurrency(
                  aging.days31to60 || 0
                );
        
              document.getElementById(
                "ap-90"
              ).textContent =
                formatCurrency(
                  aging.days61to90 || 0
                );
        
              document.getElementById(
                "ap-over90"
              ).textContent =
                formatCurrency(
                  aging.over90 || 0
                );
        
        
              const vendors =
                data?.vendors || [];
        
              const list =
                document.getElementById(
                  "ap-vendors-list"
                );
        
              list.innerHTML =
                vendors.map(vendor => {
        
                  let status = "Current";
                  let statusClass = "current";
        
                  if (Number(vendor.over90) > 0) {
                    status = "90+ days";
                    statusClass = "over90";
        
                  } else if (
                    Number(vendor.days61to90) > 0
                  ) {
                    status = "61–90 days";
                    statusClass = "over90";
        
                  } else if (
                    Number(vendor.days31to60) > 0
                  ) {
                    status = "31–60 days";
                    statusClass = "warning";
        
                  } else if (
                    Number(vendor.days1to30) > 0
                  ) {
                    status = "1–30 days";
                    statusClass = "info";
                  }
        
                  return `
                    <div class="ar-customer-row">
        
                      <span>
                        ${escapeHtml(vendor.name)}
                      </span>
        
                      <strong>
                        ${formatCurrency(
                          vendor.amount || 0
                        )}
                      </strong>
        
                      <span
                        class="ar-status ${statusClass}">
                        ${status}
                      </span>
        
                    </div>
                  `;
        
                }).join("");
        
            })
            .catch(error => {
        
              console.error(
                "❌ AP loading failed:",
                error
              );
        
            });
        
        } 
        if (pageId === "invoices") {

    const page =
        document.getElementById("page-invoices");

    if (!page) return;

    page.innerHTML = `
        <div class="page-header">
            <div>
                <h1>Invoices</h1>
                <p>Read live from QuickBooks</p>
            </div>
        </div>
    
        <div class="card invoices-card">
    
            <div class="invoices-table-header">
                <span>Invoice #</span>
                <span>Customer</span>
                <span>Amount</span>
                <span>Due Date</span>
                <span>Status</span>
            </div>
    
            <div id="invoices-list"></div>
    
            <div class="invoices-table-footer">
                <div class="invoice-pagination">
                    <button class="invoice-page active">1</button>
                    <button class="invoice-page">2</button>
                </div>
    
                <div
                    id="invoices-count"
                    class="invoices-count"
                >
                    Showing 0 invoices
                </div>
            </div>
    
        </div>
    `;
    
    console.log(
        "📄 INVOICES PAGE OPENED"
    );

    loadInvoices()
      .then(data => {
    
        console.log(
            "✅ Invoice data:",
            data
        );
    
        const invoices =
            data?.invoices || [];
    
        const list =
            document.getElementById(
                "invoices-list"
            );
    
        const count =
            document.getElementById(
                "invoices-count"
            );
    
        if (!list) return;
    
        if (!invoices.length) {
    
            list.innerHTML = `
                <div class="empty-state">
                    No invoices found.
                </div>
            `;
    
            if (count) {
                count.textContent =
                    "Showing 0 invoices";
            }
    
            return;
        }
    
        list.innerHTML =
            invoices.map(invoice => {
    
                const total =
                    Number(
                        invoice.TotalAmt || 0
                    );
    
                const balance =
                    Number(
                        invoice.Balance || 0
                    );
    
                const invoiceNumber =
                    invoice.DocNumber ||
                    invoice.Id ||
                    "";
    
                const customer =
                    invoice.CustomerRef?.name ||
                    "Unknown Customer";
    
                const dueDate =
                    invoice.DueDate
                        ? new Date(
                            invoice.DueDate +
                            "T00:00:00"
                        ).toLocaleDateString(
                            "en-US",
                            {
                                month: "short",
                                day: "numeric",
                                year: "numeric"
                            }
                        )
                        : "—";
    
                let status = "Paid";
                let statusClass = "paid";
    
                if (balance > 0) {
    
                    status = "Open";
                    statusClass = "open";
    
                    if (
                        invoice.DueDate &&
                        new Date(
                            invoice.DueDate +
                            "T00:00:00"
                        ) < new Date()
                    ) {
                        status = "Overdue";
                        statusClass = "overdue";
                    }
                }
    
                return `
                    <div class="invoice-row">
    
                        <span class="invoice-number">
                            ${escapeHtml(
                                invoiceNumber
                            )}
                        </span>
    
                        <span class="invoice-customer">
                            ${escapeHtml(
                                customer
                            )}
                        </span>
    
                        <strong class="invoice-amount">
                            ${formatCurrency(
                                total
                            )}
                        </strong>
    
                        <span class="invoice-due-date">
                            ${dueDate}
                        </span>
    
                        <span>
                            <span
                                class="invoice-status ${statusClass}"
                            >
                                ${status}
                            </span>
                        </span>
    
                    </div>
                `;
    
            }).join("");
    
        if (count) {
    
            count.textContent =
                `Showing 1–${invoices.length} of ${invoices.length}`;
        }
    
    })
        .catch(error => {

            console.error(
                "❌ Invoice loading failed:",
                error
            );

            const list =
                document.getElementById(
                    "invoices-list"
                );

            if (list) {

                list.innerHTML = `
                    <div class="empty-state">
                        Failed to load invoices.
                    </div>
                `;
            }

        });
        } 
        if (pageId === "debt-register") {
    
        const page =
            document.getElementById(
                "page-debt-register"
            );
    
        if (!page) return;
    
            page.innerHTML = `
            
                <div class="page-header">
            
                    <div>
                        <h1>Loans &amp; cards <span class="page-title-term">Debt</span></h1>
            
                        <p>
                            Read live from QuickBooks
                        </p>
                    </div>
            
                </div>
            
            
                <div class="debt-summary-grid">
            
                    <div class="card debt-summary-card">
            
                        <span>Total Debt</span>
            
                        <strong id="debt-total">
                            $0.00
                        </strong>
            
                    </div>
            
            
                    <div class="card debt-summary-card">
            
                        <span>Current Debt</span>
            
                        <strong id="debt-current">
                            $0.00
                        </strong>
            
                    </div>
            
            
                    <div class="card debt-summary-card">
            
                        <span>Long-Term Debt</span>
            
                        <strong id="debt-long-term">
                            $0.00
                        </strong>
            
                    </div>
            
            
                    <div class="card debt-summary-card">
            
                        <span>Credit Card Debt</span>
            
                        <strong id="debt-credit-card">
                            $0.00
                        </strong>
            
                    </div>
            
                </div>
            
            
                <div class="card debt-register-card">
            
                    <div class="debt-table">
            
                        <div class="debt-table-header">

                            <span>
                                Lender
                            </span>

                            <span>
                                Type
                            </span>

                            <span>
                                Balance
                                <small class="field-badge qb">
                                    QB SYNC
                                </small>
                            </span>

                        </div>
            
            
                        <div
                            id="debt-list"
                            class="debt-list"
                        ></div>
            
                    </div>
            
                </div>
            
            `;
                
        console.log(
            "💳 DEBT REGISTER OPENED"
        );
    
        loadDebt()
            .then(data => {
    
              const accounts =
                  data?.accounts || [];
              
              const current =
                  accounts
                      .filter(account =>
                          account.category === "Current Debt"
                      )
                      .reduce(
                          (sum, account) =>
                              sum + Number(account.balance || 0),
                          0
                      );
              
              const longTerm =
                  accounts
                      .filter(account =>
                          account.category === "Long-Term Debt"
                      )
                      .reduce(
                          (sum, account) =>
                              sum + Number(account.balance || 0),
                          0
                      );
              
              const creditCard =
                  accounts
                      .filter(account =>
                          account.category === "Credit Card Debt"
                      )
                      .reduce(
                          (sum, account) =>
                              sum + Number(account.balance || 0),
                          0
                      );
              
              const total =
                  current +
                  longTerm +
                  creditCard;

                document.getElementById(
                    "debt-total"
                ).textContent =
                    formatCurrency(total);
    
    
                document.getElementById(
                    "debt-current"
                ).textContent =
                    formatCurrency(current);
    
    
                document.getElementById(
                    "debt-long-term"
                ).textContent =
                    formatCurrency(longTerm);
    
    
                document.getElementById(
                    "debt-credit-card"
                ).textContent =
                    formatCurrency(
                        creditCard
                    );
    
    
                const list =
                    document.getElementById(
                        "debt-list"
                    );
    
                if (!list) return;
    
    
                if (!accounts.length) {
    
                    list.innerHTML = `
                        <div class="empty-state">
                            No debt accounts found.
                        </div>
                    `;
    
                    return;
                }
    
    
                list.innerHTML =
                    accounts.map(account => {
    
                        const balance =
                            Number(
                                account.balance || 0
                            );
    
                        const status =
                            balance > 0
                                ? "Active"
                                : "Paid / Zero";
    
    
                        const statusClass =
                            balance > 0
                                ? "active"
                                : "zero";
    
    
              return `
              
                  <div class="debt-row">
              
                      <span class="debt-lender">
                          ${escapeHtml(
                              account.name || "Unknown"
                          )}
                      </span>
              
              
                      <span>
                          ${escapeHtml(
                              account.category || "Debt"
                          )}
                      </span>


                      <strong class="debt-balance">
                          ${formatCurrency(
                              balance
                          )}
                      </strong>

                  </div>
              
              `;
                    }).join("");
    
            })
            .catch(error => {
    
                console.error(
                    "❌ Debt register loading failed:",
                    error
                );
    
                const list =
                    document.getElementById(
                        "debt-list"
                    );
    
                if (list) {
    
                    list.innerHTML = `
                        <div class="empty-state">
                            Failed to load debt data.
                        </div>
                    `;
    
                }
    
            });
        }
      
      if (pageId === "forecast") {

        renderForecastPage();

      }

      if (pageId === "ai-insights") {

        renderAIInsights();

      }
      if (pageId === "nonaka-ai") {

        renderNonakaAI();

      }

      if (pageId === "scenarios") {

        renderScenarios();

      }

      if (pageId === "settings") {

        renderSettings();

      }
  }



  // ============================================================
  // SIDEBAR
  // ============================================================

  // Navigation is labelled the way an owner would describe these things,
  // not the way an accountant would name the report behind them. The
  // accounting term still appears as the subtitle once the page opens, so
  // nothing is hidden from a bookkeeper — it just isn't the first thing a
  // first-time owner has to decode. Every item id is unchanged, so routing
  // and page state are untouched by the relabelling.
  const NAV_GROUPS = [
    {
      id: "g-overview",
      label: "Overview",
      icon: icon_home_sm(),
      flat: true,
      open: true,

      items: [
        {
          id: "overview",
          label: "Overview",
          icon: icon_home()
        }
      ]
    },

    {
      id: "g-ask",
      label: "Ask NFP AI",
      icon: icon_ai(),
      flat: true,
      open: true,

      items: [
        {
          id: "nonaka-ai",
          label: "Ask NFP AI",
          icon: icon_ai()
        }
      ]
    },

    {
      id: "g-money",
      label: "Your money",
      icon: icon_flow(),
      open: false,

      items: [
        {
          id: "cash-flow",
          label: "Money in & out",
          icon: icon_flow()
        },
        {
          id: "pl",
          label: "What you kept",
          icon: icon_pl()
        },
        {
          id: "balance-sheet",
          label: "What you own & owe",
          icon: icon_scale()
        },
        {
          id: "debt-register",
          label: "Loans & cards",
          icon: icon_ar()
        }
      ]
    },

    {
      id: "g-operations",
      label: "Customers & bills",
      icon: icon_ops_sm(),
      open: false,

      items: [
        {
          id: "working-capital",
          label: "Money owed to you",
          icon: icon_ar_cust()
        },
        {
          id: "invoices",
          label: "Invoices",
          icon: icon_ar()
        },
        {
          id: "ap-vendors",
          label: "Bills to pay",
          icon: icon_ap_vend()
        }
      ]
    },

    {
      id: "g-insights",
      label: "Looking ahead",
      icon: icon_gauge(),
      open: false,

      items: [
        {
          id: "forecast",
          label: "Forecast",
          icon: icon_forecast()
        },
        {
          id: "scenarios",
          label: "What if",
          icon: icon_scenarios()
        },
        {
          id: "ai-insights",
          label: "What we noticed",
          icon: icon_ai()
        },
        {
          id: "kpis",
          label: "Health checks",
          icon: icon_gauge()
        }
      ]
    },

    {
      id: "g-workspace",
      label: "Workspace",
      icon: icon_settings_sm(),
      flat: true,
      open: false,

      items: [
        {
          id: "settings",
          label: "Settings",
          icon: icon_settings()
        },
        {
          id: "__logout",
          label: "Log out",
          icon: icon_logout(),
          logout: true
        }
      ]
    }
  ];

  function buildSidebar(activePageId) {
    const sidebarNav =
      document.querySelector(
        ".sidebar-nav"
      );

    if (!sidebarNav) {
      return;
    }

    NAV_GROUPS.forEach(group => {
      if (
        activePageId &&
        !group.flat &&
        group.items.some(
          item =>
            item.id === activePageId
        )
      ) {
        group.open = true;
      }
    });

    function renderItem(
      item,
      isFlat
    ) {
      const baseClass =
        isFlat
          ? "nav-flat-item"
          : "nav-item";

      if (item.logout) {
        return `
          <div
            class="${baseClass} nav-item-logout"
            onclick="NFK_App.logout()"
            role="button"
            tabindex="0"
          >
            <span class="nav-icon">
              ${item.icon}
            </span>

            <span class="nav-label">
              ${item.label}
            </span>
          </div>
        `;
      }

      const isActive =
        item.id === activePageId;

      return `
        <div
          class="${baseClass} ${
            isActive ? "active" : ""
          }"
          data-page="${item.id}"
          onclick="NFK_App.nav('${item.id}')"
          role="button"
          tabindex="0"
        >
          <span class="nav-icon">
            ${item.icon}
          </span>

          <span class="nav-label">
            ${item.label}
          </span>

          ${
            isActive
              ? '<span class="nav-dot"></span>'
              : ""
          }
        </div>
      `;
    }

    let html = "";

    for (
      let gi = 0;
      gi < NAV_GROUPS.length;
      gi++
    ) {
      const group =
        NAV_GROUPS[gi];

      if (group.flat) {
        if (gi > 0) {
          html +=
            `<div class="nav-divider"></div>`;
        }

        html += `
          <div
            class="nav-flat-group"
            id="${group.id}"
          >
        `;

        for (
          const item of group.items
        ) {
          html += renderItem(
            item,
            true
          );
        }

        html += `</div>`;
      } else {
        const isOpen =
          group.open;

        html += `
          <div
            class="nav-group"
            id="${group.id}"
          >

            <button
              class="nav-group-header ${
                isOpen
                  ? "open"
                  : ""
              }"
              onclick="NFK_App.toggleNavGroup('${group.id}')"
              aria-expanded="${isOpen}"
            >

              <span class="nav-group-icon">
                ${group.icon}
              </span>

              <span class="nav-group-label">
                ${group.label}
              </span>

              <svg
                class="nav-chevron"
                viewBox="0 0 16 16"
                fill="currentColor"
                width="14"
                height="14"
              >
                <path
                  fill-rule="evenodd"
                  d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z"
                />
              </svg>

            </button>

            <div
              class="nav-group-items ${
                isOpen
                  ? "open"
                  : ""
              }"
              id="${group.id}-items"
            >
        `;

        for (
          const item of group.items
        ) {
          html += renderItem(
            item,
            false
          );
        }

        html += `
            </div>
          </div>
        `;
      }
    }

    sidebarNav.innerHTML =
      html;
  }

  // ============================================================
  // TOP BAR
  // ============================================================

  async function buildTopBar() {
    const el =
      document.getElementById(
        "topbar-inner"
      );

    if (!el) {
      return;
    }

    const organization =
      window.NFK_Auth?.getCurrentOrganization?.();

    const companyName =
      organization?.name ||
      "No Company Selected";

    // Initial top bar
    el.innerHTML = `
      <div
        class="client-switcher-wrap"
        style="position:relative;"
      >

        <div
          class="client-switcher"
          id="client-switcher-btn"
        >

          <span class="client-dot"></span>

          <span id="client-name">
            ${escapeHtml(companyName)}
          </span>

        </div>

      </div>

      <div class="topbar-spacer"></div>

      <button
        class="topbar-ai-btn"
        onclick="NFK_App.nav('nonaka-ai')"
        title="Open NFP AI"
      >
        ${icon_ai()}
        <span class="topbar-ai-btn-label">NFP AI</span>
      </button>

      <div
        class="qb-badge disconnected"
        id="qb-status-badge"
        onclick="NFK_App.connectQuickBooks()"
        title="Click to (re)connect QuickBooks"
      >
        <span class="qb-status-dot"></span>
        Checking QuickBooks...
      </div>

      <div
        class="user-avatar"
        onclick="NFK_App.nav('settings')"
      >
        AR
      </div>
    `;

    // Get real QuickBooks status
    const status =
      await checkQBConnection();

    // The badge next to the sidebar shows which company's data is
    // currently loaded — that's the connected QuickBooks company,
    // not this app's own organization name (which never changes
    // when you reconnect to a different QuickBooks company).
    if (status?.connected === true && status?.companyName) {
      const nameEl = document.getElementById("client-name");

      if (nameEl) {
        nameEl.textContent = status.companyName;
      }
    }

    const badge =
      document.getElementById(
        "qb-status-badge"
      );

    if (!badge) {
      return;
    }

    if (
      status?.connected === true
    ) {
      badge.className =
        "qb-badge connected";

      badge.innerHTML = `
        <span class="qb-status-dot"></span>
        Connected to QuickBooks
      `;
    } else {
      badge.className =
        "qb-badge disconnected";

      badge.innerHTML = `
        <span class="qb-status-dot"></span>
        Not Connected
      `;
    }
  }


  // ============================================================
  // SETTINGS
  // ============================================================

  async function loadSettingsQBStatus() {
    const body = document.getElementById("settings-qb-status");
    if (!body) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      const status = await apiGet(
        `/quickbooks/status?organizationId=${encodeURIComponent(organizationId)}`
      );

      if (status?.connected) {
        const connectedDate = status.connectedAt
          ? new Date(status.connectedAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric"
            })
          : "—";

        body.innerHTML = `
          <div class="settings-row">
            <div class="settings-row-label">Status</div>
            <div class="settings-row-value"><span class="badge badge-pos">Connected</span></div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">Realm ID</div>
            <div class="settings-row-value" style="font-family:var(--font-mono);">${escapeHtml(status.realmId || "—")}</div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">Connected since</div>
            <div class="settings-row-value">${escapeHtml(connectedDate)}</div>
          </div>
          <button class="btn btn-ghost" style="margin-top:12px;" onclick="NFK_App.connectQuickBooks()">Reconnect QuickBooks</button>
        `;
      } else {
        body.innerHTML = `
          <div class="settings-row">
            <div class="settings-row-label">Status</div>
            <div class="settings-row-value"><span class="badge badge-neg">Not connected</span></div>
          </div>
          <button class="btn btn-primary" style="margin-top:12px;" onclick="NFK_App.connectQuickBooks()">Connect QuickBooks</button>
        `;
      }
    } catch (error) {
      console.error("❌ Failed to load QuickBooks status for settings:", error);
      body.innerHTML = aiErrorCardHtml(error);
    }
  }

  function renderSettings() {
    const page = document.getElementById("page-settings");
    if (!page) return;

    const user = window.NFK_Auth?.getCurrentUser?.() || {};
    const organization = window.NFK_Auth?.getCurrentOrganization?.() || {};

    let profile = {};
    try {
      profile = JSON.parse(localStorage.getItem("nfk_profile") || "null") || {};
    } catch {
      profile = {};
    }

    page.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Settings</div>
          <div class="page-subtitle">Account, organization, and connection preferences</div>
        </div>
      </div>

      <div class="card card-pad section-gap">
        <div class="card-title" style="margin-bottom:16px;">Account</div>
        <div class="settings-row">
          <div class="settings-row-label">Name</div>
          <div class="settings-row-value">${escapeHtml(profile.full_name || "—")}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Email</div>
          <div class="settings-row-value">${escapeHtml(user.email || "—")}</div>
        </div>
      </div>

      <div class="card card-pad section-gap">
        <div class="card-title" style="margin-bottom:16px;">Organization</div>
        <div class="settings-row">
          <div class="settings-row-label">Organization name</div>
          <div class="settings-row-value">${escapeHtml(organization.name || "—")}</div>
        </div>
      </div>

      <div class="card card-pad section-gap">
        <div class="card-title" style="margin-bottom:16px;">QuickBooks Connection</div>
        <div id="settings-qb-status">
          <p style="color:var(--text-secondary);">Checking connection status...</p>
        </div>
      </div>

    `;

    loadSettingsQBStatus();
  }


  // ============================================================
  // PAGES
  // ============================================================

  function buildAllPages() {
    const pages = [
      "overview",
      "pl",
      "balance-sheet",
      "cash-flow",
      "working-capital",
      "ap-vendors",
      "invoices",
      "kpis",
      "forecast",
      "ai-insights",
      "scenarios",
      "nonaka-ai",
      "settings"
    ];

    pages.forEach(page => {
      const el =
        document.getElementById(
          `page-${page}`
        );

      if (
        el &&
        !el.innerHTML.trim()
      ) {
        el.innerHTML = `
          <div class="page-header">
            <div class="page-title">
              ${page
                .replace("-", " ")
                .toUpperCase()}
            </div>
          </div>

          <div class="card card-pad">
            <p>
              Content loading from backend...
            </p>
          </div>
        `;
      }
    });
  }

  // ============================================================
  // GLOBAL EVENTS
  // ============================================================

  function bindGlobalEvents() {
    document.addEventListener(
      "click",
      e => {
        const dd =
          document.getElementById(
            "client-dropdown"
          );

        if (
          dd &&
          !dd
            .closest(
              ".client-switcher-wrap"
            )
            ?.contains(e.target)
        ) {
          dd.classList.remove(
            "open"
          );
        }
      }
    );
  }

  // Called by charts.js when the theme toggles, so already-visible
  // charts pick up the new theme's colors immediately instead of only
  // on the next navigation. Only wired up for pages whose chart data is
  // already sitting in memory (no refetch needed) — other pages simply
  // pick up correct colors the next time their data loads.
  function redrawCurrentPageCharts() {
    if (state.currentPage === "forecast" && forecastPageState.history) {
      renderActiveForecastChart();
    } else if (state.currentPage === "scenarios" && scenarioActuals) {
      updateScenarioChart();
    }
  }

  // ============================================================
  // PUBLIC APP
  // ============================================================

  window.NFK_App = {
    nav: navigate,

    setOverviewChartType,

    dismissOverviewAlert,

    updateTaxRate,

    _init: init,

    connectQuickBooks,

    checkQBConnection,

    buildTopBar,

    openKPIDetail,

    openHealthDetail,

    closeKPIModal,

    loadBalanceSheet,

    renderBalanceSheet,

    setBSPeriod,

    loadProfitAndLoss,

    renderProfitAndLoss,

    setPLPeriod,

    loadCashFlow,

    renderCashFlow,

    setCFPeriod,

    setOverviewPeriod,

    sendPageChat,

    updateScenarioParam,

    setScenarioMonths,

    applyScenarioPreset,

    switchInsightTab,

    switchForecastView,

    setForecastChartType,

    redrawCurrentPageCharts,


    toggleNavGroup(groupId) {
      const group =
        NAV_GROUPS.find(
          g =>
            g.id === groupId
        );

      if (!group) {
        return;
      }

      group.open =
        !group.open;

      const header =
        document.querySelector(
          `#${groupId} .nav-group-header`
        );

      const items =
        document.getElementById(
          `${groupId}-items`
        );

      if (header) {
        header.classList.toggle(
          "open",
          group.open
        );
      }

      if (items) {
        items.classList.toggle(
          "open",
          group.open
        );
      }
    },

    logout() {
      window.NFK_Auth.logout();
    },

    toggleClientDD() {
      const dd =
        document.getElementById(
          "client-dropdown"
        );

      if (dd) {
        dd.classList.toggle(
          "open"
        );
      }
    }
  };

  // ============================================================
  // ICONS
  // ============================================================

  function icon_home() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/></svg>`;
  }

  function icon_alert_warning() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;
  }

  function icon_alert_info() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>`;
  }

  function icon_alert_ok() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`;
  }

  function icon_pl() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h7a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h4a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>`;
  }

  function icon_scale() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.616 1.738 5.42a1 1 0 01-.285 1.05A3.989 3.989 0 0115 14a3.989 3.989 0 01-2.667-1.019 1 1 0 01-.285-1.05l1.715-5.349L11 5.562V16h2a1 1 0 110 2H7a1 1 0 110-2h2V5.562L6.237 7.582l1.715 5.349a1 1 0 01-.285 1.05A3.989 3.989 0 015 15a3.989 3.989 0 01-2.667-1.019 1 1 0 01-.285-1.05l1.738-5.42-1.233-.617a1 1 0 01.894-1.788l1.599.799L9 4.323V3a1 1 0 011-1z"/></svg>`;
  }

  function icon_flow() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z"/><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clip-rule="evenodd"/></svg>`;
  }

  function icon_ar() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z"/><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd"/></svg>`;
  }

  function icon_ar_cust() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>`;
  }

  function icon_ap_vend() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd"/></svg>`;
  }

  function icon_gauge() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>`;
  }

  function icon_ai() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z"/></svg>`;
  }

  function icon_forecast() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M12 7a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 11-2 0V9.414l-4.293 4.293a1 1 0 01-1.414 0L8 11.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 11.586 14.586 8H13a1 1 0 01-1-1z"/></svg>`;
  }

  function icon_scenarios() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14c.015-.34.208-.646.477-.859a4 4 0 10-4.954 0c.27.213.462.519.476.859h4.001z"/></svg>`;
  }

  function icon_settings() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>`;
  }

  function icon_logout() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>`;
  }

  function icon_home_sm() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/></svg>`;
  }

  function icon_pl_sm() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h7a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h4a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>`;
  }

  function icon_ops_sm() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z"/><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd"/></svg>`;
  }

  function icon_ai_sm() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z"/></svg>`;
  }

  function icon_settings_sm() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>`;
  }

  // ============================================================
  // START APP
  // ============================================================

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      init
    );
  } else {
    init();
  }
})();