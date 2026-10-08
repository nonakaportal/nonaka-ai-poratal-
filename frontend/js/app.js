
(function () {
  "use strict";

  
  const state = {
    currentPage: "overview",
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
  
  
    // Same whole-number rounding as fmt(), but in the company's own
    // currency. fmt() hardcodes a dollar sign, and this portal serves
    // companies that don't keep their books in dollars.
    function formatCurrencyRounded(amount, currency = "USD") {
      const value = Number(amount || 0);

      const options = {
        style: "currency",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      };

      try {
        return new Intl.NumberFormat("en-US", { ...options, currency })
          .format(value);
      } catch {
        // An unrecognised code must not blank the page.
        return new Intl.NumberFormat("en-US", { ...options, currency: "USD" })
          .format(value);
      }
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

      const asOfDate = getPeriodAsOfDate(period);

      return apiGet(
        `/quickbooks/reports/balance-sheet?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          asOfDate
        )}`
      );
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
                                ? "✓ Balanced"
                                : "⚠ Not balanced"
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

            <!-- THE THREE QUESTIONS IT ANSWERS -->

            <div id="balance-questions-body" class="section-gap">
                ${renderSkeletonCard(5)}
            </div>


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
                                Assets
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
                                Total assets
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
                                Liabilities
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
                                Total liabilities
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
                                Equity
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
                                Total equity
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
                            Balance check
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
                <div class="card-title" style="margin-bottom:14px;">Assets, liabilities &amp; equity · last 6 months</div>
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
                        title: "Assets, liabilities & equity",
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

    loadBalanceQuestions();
}

    // ------------------------------------------------------------
    // THE THREE QUESTIONS A BALANCE SHEET ANSWERS
    //
    // The balance sheet is the report owners skip, because its three
    // totals only mean something once you know what question each one
    // answers. So the questions get asked out loud and the same figures
    // answer them. The judgement of what each answer means is made
    // server-side from the report itself.
    // ------------------------------------------------------------

    async function loadBalanceQuestions() {
      const body = document.getElementById("balance-questions-body");
      if (!body) return;

      const organizationId = getOrganizationId();
      if (!organizationId) return;

      const asOf = getPeriodAsOfDate(state.bsPeriod || "month");

      try {
        const data = await apiGet(
          `/quickbooks/balance-questions?organizationId=${encodeURIComponent(organizationId)}` +
          `&asOf=${encodeURIComponent(asOf)}`
        );

        renderBalanceQuestions(data);
      } catch (error) {
        console.error("Balance questions failed:", error);

        body.innerHTML = `
          <div class="card card-pad">
            <div class="empty-state">
              ${escapeHtml(
                error?.code === "QB_REAUTH_REQUIRED"
                  ? "Reconnect QuickBooks to see this."
                  : "Unable to read your balance sheet right now."
              )}
            </div>
          </div>
        `;
      }
    }

    function renderBalanceQuestions(data) {
      const body = document.getElementById("balance-questions-body");
      if (!body || !data) return;

      const currency = data.currency || "USD";
      const money = v => formatCurrency(Number(v || 0), currency);

      if (!data.hasData) {
        body.innerHTML = `
          <div class="card card-pad">
            <div class="empty-state">
              QuickBooks has nothing on the books as of this date.
            </div>
          </div>
        `;
        return;
      }

      const questions = data.questions || [];

      body.innerHTML = `
        <div class="bsq-grid">
          ${questions.map(q => `
            <div class="card card-pad bsq-card tone-${escapeHtml(q.tone || "quiet")}">
              <span class="bsq-question">${escapeHtml(q.question)}</span>
              <span class="bsq-headline">${escapeHtml(q.headline || "")}</span>

              ${q.parts?.length
                ? `<div class="bsq-parts">
                     ${q.parts.map(part => `
                       <div class="bsq-part">
                         <span>${escapeHtml(part.label)}</span>
                         <strong class="${Number(part.amount) < 0 ? "neg-val" : ""}">
                           ${Number(part.amount) < 0 ? "−" : ""}${money(Math.abs(part.amount))}
                         </strong>
                       </div>
                     `).join("")}
                   </div>`
                : ""}

              <span class="bsq-detail">${escapeHtml(q.detail || "")}</span>
            </div>
          `).join("")}
        </div>

        ${!data.balances
          ? `<div class="card card-pad bsq-warn">
               This balance sheet is out by ${money(Math.abs(data.drift))} — what the
               business owns doesn't match what it owes plus what's yours.
               That's a bookkeeping problem worth raising with whoever keeps
               your books, and it means the answers above may be off.
             </div>`
          : ""}
      `;
    }

    // A whole statement page that failed to load. Offers the one useful
    // next step: try again, or reconnect when the connection itself is
    // the problem. retryCall is always a fixed string from this file.
    function pageLoadErrorHtml(title, error, retryCall) {
      const reconnect =
        error?.code === "QB_REAUTH_REQUIRED" || error?.code === "QB_NOT_CONNECTED";

      return `
        <div class="card card-pad">
          <div style="font-size:18px;font-weight:600;">Unable to load ${escapeHtml(title)}</div>
          <p style="margin-top:8px;color:var(--text-secondary);">
            ${escapeHtml(error?.message || "Something went wrong. Please try again.")}
          </p>
          <button class="btn btn-primary" style="margin-top:16px;"
                  onclick="${reconnect ? "NFK_App.connectQuickBooks()" : retryCall}">
            ${reconnect ? "Reconnect QuickBooks" : "Try again"}
          </button>
        </div>
      `;
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
        console.error("Failed to load Balance Sheet:", error);

        if (page) {
          page.innerHTML = pageLoadErrorHtml(
            "what you own & owe", error, `NFK_App.setBSPeriod('${period}')`
          );
        }
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

      const { startDate, endDate } = getPeriodRange(period);

      return apiGet(
        `/quickbooks/reports/profit-and-loss?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          startDate
        )}&endDate=${encodeURIComponent(
          endDate
        )}`
      );
    }

    async function loadInvoices() {
      const organizationId = getOrganizationId();

      if (!organizationId) {
        throw new Error("Organization ID is missing");
      }

      return apiGet(
        `/quickbooks/invoices?organizationId=${encodeURIComponent(organizationId)}`
      );
    }

    async function loadDebt() {
      const organizationId = getOrganizationId();

      if (!organizationId) {
        throw new Error("Organization ID is missing");
      }

      return apiGet(
        `/quickbooks/debt?organizationId=${encodeURIComponent(organizationId)}`
      );
    }
    
    
    // Draws the page frame straight away. The period, basis and currency
    // in the header come from the same P&L story the body is built from,
    // so the page needs one request, not a report fetch followed by the
    // story fetch.
    function renderProfitAndLoss() {

        const page =
            document.getElementById("page-pl");

        if (!page) return;

        page.innerHTML = `

            <div class="pl-page">

                <!-- HEADER -->

                <div class="pl-page-header">

                    <div>

                        <div class="pl-page-title">
                            What you kept
                            <span class="page-title-term">Profit &amp; Loss</span>
                        </div>

                        <div class="pl-page-subtitle" id="pl-page-subtitle">&nbsp;</div>

                    </div>


                    <div class="pl-header-actions">

                        ${renderPeriodSelector(state.plPeriod, "setPLPeriod")}

                        <div class="statement-badge" id="pl-currency-badge" style="display:none;"></div>

                    </div>

                </div>
    
    
                <!-- THE STATEMENT ITSELF. Every row opens to the
                     accounts behind it, so there is no second copy
                     of the same figures further down the page. -->

                <div class="section-gap" id="pl-story-body">
                    ${renderSkeletonCard(5)}
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

        loadPLStory();
    }

    // ------------------------------------------------------------
    // THE SAME FIGURES, READ AS A SEQUENCE
    //
    // A Profit & Loss is a list of totals that assumes you already know
    // how they relate to each other. This walks the same figures in the
    // order they actually happen, so an owner can see where the money
    // went between what they sold and what they kept. Every number is
    // the one QuickBooks reports, so the story can't disagree with the
    // statement printed underneath it.
    // ------------------------------------------------------------

    async function loadPLStory() {
      const body = document.getElementById("pl-story-body");
      if (!body) return;

      const organizationId = getOrganizationId();
      if (!organizationId) return;

      const { startDate, endDate } = getPeriodRange(state.plPeriod || "month");

      try {
        const story = await apiGet(
          `/quickbooks/pl-story?organizationId=${encodeURIComponent(organizationId)}` +
          `&startDate=${encodeURIComponent(startDate)}` +
          `&endDate=${encodeURIComponent(endDate)}`
        );

        renderPLStory(story);
      } catch (error) {
        console.error("P&L story failed:", error);

        body.innerHTML = `
          <div class="empty-state">
            ${escapeHtml(
              error?.code === "QB_REAUTH_REQUIRED"
                ? "Reconnect QuickBooks to see this."
                : "Unable to work out where your profit went right now."
            )}
          </div>
        `;
      }
    }

    // Every row on the statement opens to show what is inside it: the
    // accounts for the rows that have accounts, and the sum it came
    // from for the subtotals, which have none. Same behaviour on every
    // row, so nothing looks clickable that isn't.
    function renderPLStep(step, { money, widthOf }) {
      const detailRow = (name, amount, extra = "") => `
        <div class="plstory-line ${extra}">
          <span class="plstory-line-name">${escapeHtml(name)}</span>
          <span class="plstory-line-amount">${money(amount)}</span>
        </div>
      `;

      let inside = "";

      if (Array.isArray(step.lines) && step.lines.length) {
        inside = step.lines.map(line => {
          if (Array.isArray(line.items) && line.items.length) {
            return `
              <div class="plstory-line-group">
                ${detailRow(line.name, line.amount, "is-group")}
                ${line.items.map(item =>
                  detailRow(item.name, item.amount, "is-child")).join("")}
              </div>
            `;
          }

          // A parent account posted to directly, sitting next to the
          // category of the same name. Saying so stops it reading as
          // a mistake.
          return detailRow(
            line.ownPosting ? `${line.name} — posted directly` : line.name,
            line.amount
          );
        }).join("");

        inside += `
          ${detailRow("Total", step.linesTotal, "is-total")}
          ${step.adds_up === false
            ? `<div class="plstory-line-warn">
                 These lines come to ${money(step.linesTotal)}, not
                 ${money(step.amount)}. The figure above is the one
                 QuickBooks reports.
               </div>`
            : ""}
        `;
      } else if (Array.isArray(step.workings) && step.workings.length) {
        inside = `
          ${step.workings.map(w => detailRow(w.name, w.amount)).join("")}
          ${detailRow("Leaves", step.amount, "is-total")}
        `;
      } else {
        inside = `<div class="plstory-line-empty">
                    QuickBooks has no accounts recorded under this.
                  </div>`;
      }

      return `
        <details class="card card-pad plstory-step kind-${escapeHtml(step.kind)}">
          <summary class="plstory-summary">
            <div class="plstory-step-top">
              <span class="plstory-label">
                <span class="plstory-name">${escapeHtml(step.label)}</span>
                <span class="plstory-term">${escapeHtml(step.term)}</span>
              </span>
              <span class="plstory-right">
                <strong class="plstory-amount">
                  ${step.kind === "out" ? "−" : ""}${money(Math.abs(step.amount))}
                </strong>
                <svg class="plstory-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
                </svg>
              </span>
            </div>

            <div class="plstory-bar">
              <span
                class="plstory-bar-fill"
                style="width:${widthOf(step.amount)}%"
              ></span>
            </div>

            <div class="plstory-step-foot">
              <span class="plstory-explain">${escapeHtml(step.explain)}</span>
              ${step.share !== null && step.share !== undefined
                ? `<span class="plstory-share">${Number(step.share)}% of sales</span>`
                : ""}
            </div>
          </summary>

          <div class="plstory-detail">${inside}</div>
        </details>
      `;
    }

    function renderPLStory(story) {
      const body = document.getElementById("pl-story-body");
      if (!body || !story) return;

      const currency = story.currency || "USD";

      const subtitle = document.getElementById("pl-page-subtitle");
      if (subtitle) {
        subtitle.textContent =
          `${story.period?.startDate || "—"} → ${story.period?.endDate || "—"} · ` +
          `${story.reportBasis || "Accrual"}`;
      }

      const badge = document.getElementById("pl-currency-badge");
      if (badge) {
        badge.textContent = currency;
        badge.style.display = "";
      }
      const money = v => formatCurrency(Number(v || 0), currency);

      const steps = story.steps || [];
      const verdict = story.verdict || {};

      // Bars are drawn against sales, so the shrinking left-hand edge
      // is the point: each cost takes a bite out of what came in.
      const sales = Math.abs(Number(steps[0]?.amount || 0));
      const widthOf = amount =>
        sales > 0
          ? Math.max(Math.min((Math.abs(amount) / sales) * 100, 100), 0.8)
          : 0;

      body.innerHTML = `
        <div class="card card-pad plstory-verdict">
          <div class="plstory-head">
            <span class="cashproj-eyebrow">Where the money went</span>
            <span class="cashproj-title">${escapeHtml(verdict.headline || "")}</span>
            <span class="plstory-sub">${escapeHtml(verdict.detail || "")}</span>
          </div>
          ${steps.length
            ? `<div class="plstory-figures">
                 <div class="plstory-figure">
                   <span class="summary-label">${escapeHtml(steps[0].label || "What you sold")}</span>
                   <strong>${money(steps[0].amount)}</strong>
                 </div>
                 <div class="plstory-figure">
                   <span class="summary-label">${escapeHtml(steps.at(-1).label || "What you kept")}</span>
                   <strong class="${Number(steps.at(-1).amount) < 0 ? "is-neg" : ""}">${money(steps.at(-1).amount)}</strong>
                   ${sales > 0 && Number.isFinite(Number(steps.at(-1).share))
                     ? `<span class="summary-sub">${Number(steps.at(-1).share)}¢ of every $1 sold</span>`
                     : ""}
                 </div>
               </div>`
            : ""}
        </div>

        <div class="plstory-steps">
          ${steps.map(step => renderPLStep(step, { money, widthOf })).join("")}
        </div>

        ${!story.reconciliation?.balances
          ? `<div class="plstory-warn">
               These steps come to ${money(
                 Number(steps.at(-1)?.amount || 0) +
                 Number(story.reconciliation?.difference || 0)
               )}, which is ${money(Math.abs(story.reconciliation?.difference || 0))}
               away from the total QuickBooks reports. The statement below is
               the one to trust.
             </div>`
          : ""}
      `;
    }

    function setPLPeriod(period) {
      state.plPeriod = period;
      renderProfitAndLoss();
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

      return apiGet(
        `/quickbooks/reports/cash-flow?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          startDate
        )}&endDate=${encodeURIComponent(
          endDate
        )}`
      );
    }
    
    
// The page below is three columns of account movements and a waterfall.
// This is the one-line answer they add up to: how much is in the bank,
// whether that is more or less than the owner started with, and — the
// part the columns don't say out loud — whether the change came from
// trading or from somewhere else.
//
// Cash going up is not automatically good news. A business that covered
// a trading loss by borrowing shows a rising balance, and that is worth
// saying plainly rather than leaving someone to spot it in the numbers.
function cashFlowVerdict({
    openingCash,
    closingCash,
    netChange,
    operatingTotal,
    investingTotal,
    financingTotal,
    currency
}) {
    // Rounded to match every other figure on this page — a sentence
    // reads better without cents, and the summary row below would
    // otherwise disagree with the headline by a few pence.
    const money = value =>
        formatCurrencyRounded(Math.abs(Number(value || 0)), currency);

    const change = Number(netChange || 0);
    const trading = Number(operatingTotal || 0);

    // Under a cent either way is rounding, not a movement.
    const FLAT = 0.005;

    const others = [
        {
            label: "loans or owner funding",
            outLabel: "loan repayments or money taken out",
            amount: Number(financingTotal || 0)
        },
        {
            label: "selling assets",
            outLabel: "buying assets",
            amount: Number(investingTotal || 0)
        }
    ];

    const biggestOther = others
        .slice()
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];

    const headline = `You have ${money(closingCash)} in the bank`;

    if (!Number.isFinite(closingCash)) {
        return {
            tone: "quiet",
            headline: "Cash position unavailable",
            detail: "QuickBooks did not return a closing balance for this period."
        };
    }

    if (Math.abs(change) < FLAT) {
        return {
            tone: "quiet",
            headline,
            detail:
                `That is where you started the period too — money came in ` +
                `and went out, and it balanced out to the same place.`
        };
    }

    const direction = change > 0 ? "more" : "less";
    const movement =
        `${money(change)} ${direction} than the ${money(openingCash)} ` +
        `you started with.`;

    if (change > 0) {
        // Rising cash that trading did not pay for is the case worth
        // flagging: it looks like success and often isn't.
        if (trading <= 0 && biggestOther && biggestOther.amount > 0) {
            return {
                tone: "warn",
                headline,
                detail:
                    `That is ${movement} But it did not come from trading — ` +
                    `the business spent ${money(trading)} more than it took ` +
                    `in day to day, and the balance went up because of ` +
                    `${biggestOther.label}.`
            };
        }

        // Trading being positive is not the same as trading having paid
        // for the rise. Only say so when it actually covers it.
        if (trading >= change) {
            return {
                tone: "pos",
                headline,
                detail:
                    `That is ${movement} Day-to-day trading brought in ` +
                    `${money(trading)}, which is what paid for it.`
            };
        }

        const helper = biggestOther && biggestOther.amount > 0
            ? ` The rest came from ${biggestOther.label}.`
            : "";

        return {
            tone: "pos",
            headline,
            detail:
                `That is ${movement} Day-to-day trading brought in ` +
                `${money(trading)} of that.${helper}`
        };
    }

    // Falling cash — say which half of the business it went out on.
    if (trading > 0 && biggestOther && biggestOther.amount < 0) {
        return {
            tone: "warn",
            headline,
            detail:
                `That is ${movement} Trading itself brought in ` +
                `${money(trading)}; the balance still fell because of ` +
                `${biggestOther.outLabel}.`
        };
    }

    return {
        tone: "neg",
        headline,
        detail:
            `That is ${movement} The business paid out ${money(trading)} ` +
            `more than it took in day to day.`
    };
}

function cashFlowVerdictHtml(figures) {
    const verdict = cashFlowVerdict(figures);

    return `
        <section class="card card-pad cf-verdict tone-${escapeHtml(verdict.tone)}">
            <div class="plstory-head" style="margin-bottom:0;">
                <span class="cashproj-eyebrow">What this comes to</span>
                <span class="cashproj-title">${escapeHtml(verdict.headline)}</span>
                <span class="plstory-sub">${escapeHtml(verdict.detail)}</span>
            </div>
        </section>
    `;
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

        return formatCurrencyRounded(
            Number(value || 0),
            currency
        );

    }


    function signedAmount(value) {

        const n =
            Number(value || 0);

        return n < 0
            ? `-${formatCurrencyRounded(Math.abs(n), currency)}`
            : `+${formatCurrencyRounded(n, currency)}`;

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
        total,
        totalLabel,
        note
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

                ${note
                    ? `<ul class="cf-activity-note">${note.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
                    : ""}

                <div class="cf-row-list">

                    ${renderRows(accounts)}

                </div>


                <div class="cf-activity-footer">

                    <span>
                        ${totalLabel || `Net ${title}`}
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


            <!-- WHAT IT ALL COMES TO -->

            ${cashFlowVerdictHtml({
                openingCash,
                closingCash,
                netChange,
                operatingTotal,
                investingTotal,
                financingTotal,
                currency
            })}


            <!-- WATERFALL -->

            <section class="cf-waterfall">

                <div class="cf-waterfall-head">

                    <h2>
                        How your balance moved
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
                    "Day-to-day trading",
                    icon_flow(),
                    operating,
                    operatingTotal,
                    "Total from trading",
                    [
                        "Green = cash in, red = cash out",
                        "Unpaid sales show red until paid",
                        "Unpaid bills show green (cash kept longer)"
                    ]
                )}

                ${activityCard(
                    "Buying and selling assets",
                    icon_scale(),
                    investing,
                    investingTotal,
                    "Total from assets",
                    [
                        "Green = cash from selling assets",
                        "Red = cash spent buying assets"
                    ]
                )}

                ${activityCard(
                    "Loans and owner funding",
                    icon_ar(),
                    financing,
                    financingTotal,
                    "Total from loans and funding",
                    [
                        "Green = new loans or owner money in",
                        "Red = repayments or money taken out"
                    ]
                )}

            </div>


            <!-- BOTTOM SUMMARY -->

            <section class="cf-summary">

                <div class="cf-summary-item">

                    <span>
                        Opening balance
                    </span>

                    <strong>
                        ${amount(openingCash)}
                    </strong>

                </div>


                <div class="cf-summary-item">

                    <span>
                        From trading
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
                        Assets
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
                        Funding
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
                        Closing balance
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
                        ${icon_forecast()}
                    </span>

                    <div>

                        <strong>
                            Change over the period
                        </strong>

                        <small>
                            Trading, assets and funding combined
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
                    "Opening",
                    "Trading",
                    "Assets",
                    "Funding",
                    "Closing"
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
        console.error("Failed to load Cash Flow:", error);

        if (page) {
          page.innerHTML = pageLoadErrorHtml(
            "money in & out", error, `NFK_App.setCFPeriod('${period}')`
          );
        }
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
    
      const startDate = toISODate(new Date());

      return apiGet(
        `/quickbooks/reports/accounts-receivable?organizationId=${encodeURIComponent(
          organizationId
        )}&startDate=${encodeURIComponent(
          startDate
        )}`
      );
    }

    async function loadAccountsPayable() {
      const organizationId = getOrganizationId();

      if (!organizationId) {
        throw new Error("Organization ID is missing.");
      }

      const today = toISODate(new Date());

      return apiGet(
        `/quickbooks/reports/accounts-payable` +
        `?organizationId=${encodeURIComponent(organizationId)}` +
        `&startDate=${encodeURIComponent(today)}`
      );
    }


  // ============================================================
  // QUICKBOOKS STATUS
  // ============================================================

  async function checkQBConnection() {
    const organizationId = getOrganizationId();

    if (!organizationId) return null;

    try {
      const status = await apiGet(
        `/quickbooks/status?organizationId=${encodeURIComponent(organizationId)}`
      );

      state.qbCompanyName = status.companyName || null;

      return status;
    } catch (error) {
      console.error("QuickBooks status check failed:", error);

      return null;
    }
  }

  // One connect flow for the whole portal — the one on the Connect screen,
  // which also recovers an expired session before giving up.
  function connectQuickBooks() {
    window.NFK_Auth?.connectQB?.();
  }

  // ============================================================
  // INITIALIZE APP
  //
  // Only builds the empty shell. Data loads when auth.js calls
  // enterPortal() for a signed-in, connected owner, so nothing is
  // fetched for someone still on the login or Connect screen.
  // ============================================================

  function init() {
    buildSidebar();

    buildAllPages();

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
            <div style="font-weight:600;margin-bottom:6px;">
              AI API key not configured
            </div>
            <p style="color:var(--text-secondary);">
              ${escapeHtml(error.message || "Add an AI API key to the backend's .env file.")}
              Then reload this page.
            </p>
          </div>
        `;
      }

      if (error?.code === "QB_NOT_CONNECTED") {
        return `
          <div class="card card-pad">
            <div style="font-weight:600;margin-bottom:6px;">
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
            <div style="font-weight:600;margin-bottom:6px;">
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
          <div style="font-weight:600;margin-bottom:6px;">
            Unable to load
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
            <div style="font-size:40px;font-weight:600;line-height:1;color:${color};">
              ${Math.round(health.score)}
            </div>
            <div>
              <div class="card-title">Financial health</div>
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
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:12px;">
              <span style="color:${healthRatingColor(f.impact === "positive" ? "good" : f.impact === "negative" ? "critical" : "fair")};font-weight:600;">
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
    // INSIGHT CARD
    //
    // Anomaly and recommendation cards open in place to show the longer
    // explanation that came back with them. A native <details> keeps it
    // keyboard-accessible with no extra JS. Results cached from before the
    // explanation fields existed just render as plain, non-opening cards.
    // --------------------------------------------------------

    const cap = s => { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); };

    // Which page a finding's category is about, so an opened card can
    // send the owner straight to the numbers behind it.
    const INSIGHT_PAGES = {
      revenue: { id: "pl", label: "What you kept" },
      expenses: { id: "pl", label: "What you kept" },
      margin: { id: "pl", label: "What you kept" },
      cashflow: { id: "cash-flow", label: "Money in & out" },
      receivables: { id: "working-capital", label: "Money owed to you" },
      payables: { id: "ap-vendors", label: "Bills to pay" },
      debt: { id: "debt-register", label: "Loans & cards" }
    };

    // status: "High severity" / "High priority"; tone: neg | warn | pos
    // colours that chip. figures: optional [{label, value}] from the AI.
    function insightCardHtml({ kind, status, tone, category, title, description, basis, details, figures = [] }) {
      const sections = details.filter(d => d.text);
      const page = INSIGHT_PAGES[String(category || "").toLowerCase()];
      const question = `Tell me more about this: ${title}`;

      const summaryHtml = `
        <div class="insight-chips">
          <span class="chip chip-${tone}">${escapeHtml(status)}</span>
          <span class="chip chip-muted">${escapeHtml(cap(category))}</span>
        </div>
        <div class="insight-title">${escapeHtml(title)}</div>
        <div class="insight-body ai-msg-markdown">${renderMarkdown(description)}</div>
      `;

      if (sections.length === 0) {
        return `<div class="insight-card ${kind}">${summaryHtml}<div class="insight-basis">${escapeHtml(basis)}</div></div>`;
      }

      const figuresHtml = Array.isArray(figures) && figures.length
        ? `<div class="insight-figures">${figures.slice(0, 3).map(f => `
            <div class="insight-figure">
              <span class="stat-label">${escapeHtml(f.label)}</span>
              <strong>${escapeHtml(f.value)}</strong>
            </div>`).join("")}</div>`
        : "";

      return `
        <details class="insight-card insight-expandable ${kind}">
          <summary>
            ${summaryHtml}
            <span class="insight-more">Show the full explanation</span>
          </summary>
          <div class="insight-details">
            ${figuresHtml}
            <div class="insight-detail-grid">
              ${sections.map(sec => `
                <div class="insight-detail">
                  <div class="insight-detail-heading">${escapeHtml(sec.heading)}</div>
                  <div class="insight-body ai-msg-markdown">${renderMarkdown(sec.text)}</div>
                </div>
              `).join("")}
            </div>
            <div class="insight-foot">
              <span class="insight-basis">${escapeHtml(basis)}</span>
              <span class="insight-actions">
                <button type="button" class="btn btn-ghost" data-ask="${escapeHtml(question)}"
                        onclick="NFK_App.askFromTopbar(this.dataset.ask)">${icon_ai()} Ask about this</button>
                ${page
                  ? `<button type="button" class="btn btn-primary" onclick="NFK_App.nav('${page.id}')">Open ${escapeHtml(page.label)}</button>`
                  : ""}
              </span>
            </div>
          </div>
        </details>
      `;
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

        body.innerHTML = anomalies.map(item => insightCardHtml({
          kind: "anomaly",
          status: `${cap(item.severity)} severity`,
          tone: ({ high: "neg", medium: "warn", low: "muted" })[String(item.severity || "").toLowerCase()] || "muted",
          category: item.category,
          title: item.title,
          description: item.description,
          basis: item.evidence,
          figures: item.keyFigures,
          details: [
            { heading: "What happened, in numbers", text: item.explanation },
            { heading: "What it means going forward", text: item.futureImpact }
          ]
        })).join("");
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

        body.innerHTML = recommendations.map(item => insightCardHtml({
          kind: "recommendation",
          status: `${cap(item.priority)} priority`,
          tone: "pos",
          category: item.category,
          title: item.title,
          description: item.description,
          basis: item.expectedImpact,
          details: [
            { heading: "How to do it", text: item.steps },
            { heading: "The benefit, in numbers", text: item.benefit }
          ]
        })).join("");
      } catch (error) {
        console.error("❌ Failed to load AI recommendations:", error);
        body.innerHTML = aiErrorCardHtml(error);
      }
    }


    const AI_INSIGHT_TABS = [
      { id: "anomalies", label: "Things to watch" },
      { id: "recommendations", label: "Things to do" }
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
                  <h1 class="page-title">Ask NFP AI</h1>
                  <p class="page-subtitle">Your financial analyst · Answers come from your live QuickBooks numbers</p>
              </div>
  
          </div>
  
  
          <div
              class="ai-chat-panel"
              id="ai-page-chat"
              style="display:block;"
          >
  
  
              <div
                  class="ai-chat-messages"
                  id="ai-page-messages"
              >
  
                  <div class="ai-chat-msg ai-msg">
  
                      <div class="ai-msg-avatar">${icon_ai()}</div>
                      <div class="ai-msg-bubble">Hi, I'm NFP AI. Ask me anything about your revenue, cash, bills or customers.</div>
  
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
                      aria-label="Ask NFP AI a question"
                      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();NFK_App.sendPageChat();}"
                  ></textarea>

                  <button
                      class="ai-send-btn"
                      id="ai-page-send"
                      aria-label="Send question"
                      onclick="NFK_App.sendPageChat()"
                  ><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></button>
  
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
        { id: "worst", label: "Worst case" },
        { id: "base", label: "Base case" },
        { id: "best", label: "Best case" }
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

        <div class="card card-pad section-gap" id="cash-cushion-body">
          ${renderSkeletonCard(4)}
        </div>

        <div class="card card-pad">
          <div class="card-title" style="margin-bottom:14px;">Revenue, Gross Profit & Net Income</div>
          <div id="scenario-chart-wrap" style="height:340px;display:flex;align-items:center;justify-content:center;">
            <p style="color:var(--text-muted);">Loading your real 12-month history from QuickBooks...</p>
          </div>
        </div>
      `;

      loadCashCushion();

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
      // The cushion depends only on the assumptions, not on the chart's
      // history, so it is refreshed even when the history failed to load.
      loadCashCushion({ debounce: 350 });

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
          "Projected gross profit",
          formatCurrency(projection.endOfHorizon.grossProfit),
          "At end of horizon",
          projection.endOfHorizon.grossProfit < 0
        ) +
        outcomeCard(
          "Projected net income",
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

    // ------------------------------------------------------------
    // EACH LOAN AND CARD, WITH THE HISTORY BEHIND IT
    //
    // A balance on its own says what is owed but not whether it is
    // going anywhere. This shows what has been paid off, what the
    // payments look like, and how long the balance takes to clear at
    // that rate. Interest rates and agreed repayment amounts are not
    // fields QuickBooks holds, so the page says so rather than leaving
    // blanks that look like a loading failure.
    // ------------------------------------------------------------

    async function loadDebtDetail() {
      const body = document.getElementById("debt-detail-body");
      if (!body) return;

      const organizationId = getOrganizationId();
      if (!organizationId) return;

      try {
        const detail = await apiGet(
          `/quickbooks/debt-detail?organizationId=${encodeURIComponent(organizationId)}`
        );

        renderDebtDetail(detail);
      } catch (error) {
        console.error("Debt detail failed:", error);

        body.innerHTML = `
          <div class="card card-pad">
            <div class="empty-state">
              ${escapeHtml(
                error?.code === "QB_REAUTH_REQUIRED"
                  ? "Reconnect QuickBooks to see your loans and cards."
                  : "Unable to load your loans and cards right now."
              )}
            </div>
          </div>
        `;
      }
    }

    function debtClearanceLine(account) {
      const clearance = account.clearance;

      if (!clearance) {
        if (!(account.balance > 0)) {
          return { tone: "good", text: "Nothing owed on this." };
        }

        return {
          tone: "quiet",
          text: "No payments recorded against this yet, so there's nothing to work out a payoff date from."
        };
      }

      if (clearance.known) {
        const when = new Date(`${clearance.clearsOn}-01T00:00:00Z`)
          .toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
            timeZone: "UTC"
          });

        return {
          tone: "good",
          text: `Clear in about ${clearance.months} ${
            clearance.months === 1 ? "month" : "months"
          } — around ${when}.`,
          meta: clearance.basis
        };
      }

      if (clearance.reason === "growing") {
        return {
          tone: "bad",
          text: "This balance is higher than it was, so it isn't on track to be paid off."
        };
      }

      if (clearance.reason === "flat") {
        return {
          tone: "warn",
          text: "You're adding to this about as fast as you pay it down, so the balance is staying put."
        };
      }

      return {
        tone: "quiet",
        text: "Only one payment so far — not enough to tell how long this will take."
      };
    }

    function renderDebtDetail(detail) {
      const body = document.getElementById("debt-detail-body");
      if (!body || !detail) return;

      const money = v => formatCurrency(Number(v || 0));
      const accounts = detail.accounts || [];

      const byCategory = category =>
        accounts
          .filter(a => a.category === category)
          .reduce((sum, a) => sum + Number(a.balance || 0), 0);

      const current = byCategory("Current Debt");
      const longTerm = byCategory("Long-Term Debt");
      const card = byCategory("Credit Card Debt");

      const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = money(value);
      };

      setText("debt-total", current + longTerm + card);
      setText("debt-current", current);
      setText("debt-long-term", longTerm);
      setText("debt-credit-card", card);

      if (!accounts.length) {
        body.innerHTML = `
          <div class="card card-pad">
            <div class="empty-state">
              QuickBooks shows no loans or credit cards on your books.
            </div>
          </div>
        `;
        return;
      }

      const shortDate = iso => {
        if (!iso) return "";
        return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC"
        });
      };

      body.innerHTML = `
        ${accounts.map(account => {
          const verdict = debtClearanceLine(account);
          const paidOff = Number(account.paidOff || 0);

          return `
            <div class="card card-pad loan-card">

              <div class="loan-head">
                <div>
                  <span class="loan-name">${escapeHtml(account.name || "Unnamed")}</span>
                  <span class="loan-kind">${escapeHtml(account.category || "")}</span>
                </div>
                <strong class="loan-balance">${money(account.balance)}</strong>
              </div>

              ${Number(account.clearedShare) > 0
                ? `<div class="loan-progress">
                     <div class="loan-progress-bar">
                       <span style="width:${Number(account.clearedShare)}%"></span>
                     </div>
                     <span class="loan-progress-label">
                       ${Number(account.clearedShare)}% of this has been paid off
                     </span>
                   </div>`
                : ""}

              <div class="loan-facts">
                <div class="loan-fact">
                  <span class="loan-fact-label">Paid off in the last 2 years</span>
                  <strong class="${paidOff > 0 ? "pos-val" : ""}">${money(paidOff)}</strong>
                </div>

                <div class="loan-fact">
                  <span class="loan-fact-label">Typical payment</span>
                  <strong>${
                    account.typicalPayment
                      ? money(account.typicalPayment)
                      : "<span class='loan-none'>None recorded</span>"
                  }</strong>
                </div>

                <div class="loan-fact">
                  <span class="loan-fact-label">Last payment</span>
                  <strong>${
                    account.lastPayment
                      ? `${money(account.lastPayment.amount)}
                         <span class="loan-fact-meta">${escapeHtml(shortDate(account.lastPayment.date))}</span>`
                      : "<span class='loan-none'>None yet</span>"
                  }</strong>
                </div>
              </div>

              <div class="loan-verdict tone-${escapeHtml(verdict.tone)}">
                ${escapeHtml(verdict.text)}
                ${verdict.meta
                  ? `<span class="loan-verdict-meta">${escapeHtml(verdict.meta)}</span>`
                  : ""}
              </div>

              ${account.recent?.length
                ? `<details class="loan-history">
                     <summary>Recent movements (${account.recent.length})</summary>
                     <div class="loan-history-rows">
                       ${account.recent.map(row => `
                         <div class="loan-history-row">
                           <span class="loan-history-date">${escapeHtml(shortDate(row.date))}</span>
                           <span class="loan-history-desc" title="${escapeHtml(row.description)}">
                             ${escapeHtml(row.description)}
                           </span>
                           <strong class="${row.direction === "payment" ? "pos-val" : "neg-val"}">
                             ${row.direction === "payment" ? "−" : "+"}${money(Math.abs(row.amount))}
                           </strong>
                           <span class="loan-history-bal">${money(row.balance)}</span>
                         </div>
                       `).join("")}
                     </div>
                   </details>`
                : ""}

            </div>
          `;
        }).join("")}

        <div class="card card-pad loan-note">
          ${escapeHtml(detail.notInQuickBooks || "")}
          ${!detail.ledgerAvailable
            ? " The transaction history behind these balances could not be read this time, so only the balances are shown."
            : ""}
        </div>
      `;
    }

    // ------------------------------------------------------------
    // WHAT'S LEFT IN THE BANK
    //
    // The outcome cards above this one are all profit figures. This is
    // the one an owner actually acts on: how much money is in the
    // account at the end, starting from today's real balance and their
    // own recent trading. The projection is done server-side; a slider
    // drag fires a lot of requests, so it is debounced and the server
    // caches the baseline behind it.
    // ------------------------------------------------------------

    let cushionTimer = null;
    let cushionRequest = 0;

    function loadCashCushion({ debounce = 0 } = {}) {
      clearTimeout(cushionTimer);

      // The figures on screen belong to the previous set of assumptions.
      // Leaving them looking authoritative while a new answer is on its
      // way would show the owner a number that is already wrong, so the
      // card is visibly marked as recalculating.
      document
        .getElementById("cash-cushion-body")
        ?.classList.add("is-pending");

      cushionTimer = setTimeout(async () => {
        const body = document.getElementById("cash-cushion-body");
        if (!body) return;

        const organizationId = getOrganizationId();
        if (!organizationId) return;

        const params = new URLSearchParams({
          organizationId,
          months: scenarioParams.months,
          revGrowth: scenarioParams.revGrowth,
          cogsGrowth: scenarioParams.cogsGrowth,
          opexGrowth: scenarioParams.opexGrowth,
          taxRate: scenarioParams.taxRate
        });

        // Slider drags can overlap, and an older reply landing last
        // would show a figure for assumptions that are no longer set.
        const ticket = ++cushionRequest;

        try {
          const cushion = await apiGet(`/quickbooks/cash-cushion?${params}`);

          if (ticket === cushionRequest) {
            renderCashCushion(cushion);
            body.classList.remove("is-pending");
          }
        } catch (error) {
          console.error("Cash cushion failed:", error);

          if (ticket !== cushionRequest) return;

          body.classList.remove("is-pending");

          body.innerHTML = `
            <div class="empty-state">
              ${escapeHtml(
                error?.code === "QB_REAUTH_REQUIRED"
                  ? "Reconnect QuickBooks to estimate your bank balance."
                  : "Unable to estimate your bank balance right now."
              )}
            </div>
          `;
        }
      }, debounce);
    }

    function renderCashCushion(cushion) {
      const body = document.getElementById("cash-cushion-body");
      if (!body || !cushion) return;

      const money = v => formatCurrency(Number(v || 0));

      if (!cushion.available) {
        body.innerHTML = `
          <div class="cushion-head">
            <span class="cashproj-eyebrow">What's left in the bank</span>
            <span class="cashproj-title">Not enough history yet</span>
          </div>
          <div class="cashproj-nodata">${escapeHtml(cushion.reason || "")}</div>
        `;
        return;
      }

      const months = Number(cushion.months || 0);
      const verdict = cushion.verdict || {};
      const change = Number(cushion.change || 0);

      const monthWord = months === 1 ? "month" : "months";

      // The lowest point only tells the owner something new when it
      // isn't simply the last month of an always-falling balance.
      const dip =
        cushion.lowestPoint &&
        cushion.lowestPoint.month < months &&
        cushion.lowestPoint.balance < Number(cushion.openingCash || 0)
          ? cushion.lowestPoint
          : null;

      body.innerHTML = `
        <div class="cushion-head">
          <span class="cashproj-eyebrow">What's left in the bank</span>
          <span class="cashproj-title">
            Projected bank balance in ${months} ${monthWord}
          </span>
        </div>

        <div class="cushion-main">
        <div class="cushion-figures">
          <div class="cushion-figure">
            <span class="cashproj-figure-label">In the bank today</span>
            <strong>${money(cushion.openingCash)}</strong>
          </div>

          <div class="cushion-arrow" aria-hidden="true">&rarr;</div>

          <div class="cushion-figure">
            <span class="cashproj-figure-label">
              After ${months} ${monthWord}
            </span>
            <strong class="${Number(cushion.endBalance) < 0 ? "neg-val" : ""}">
              ${money(cushion.endBalance)}
            </strong>
            <span class="cushion-delta ${change >= 0 ? "pos-val" : "neg-val"}">
              ${change >= 0 ? "+" : "−"}${money(Math.abs(change))}
            </span>
          </div>

          <div class="cushion-figure">
            <span class="cashproj-figure-label">Typical month</span>
            <strong class="${Number(cushion.monthlyChange) >= 0 ? "pos-val" : "neg-val"}">
              ${Number(cushion.monthlyChange) >= 0 ? "+" : "−"}${money(Math.abs(cushion.monthlyChange))}
            </strong>
          </div>
        </div>

        <div class="cushion-verdict tone-${escapeHtml(verdict.tone || "good")}">
          <span class="cushion-verdict-head">${escapeHtml(verdict.headline || "")}</span>
          <span class="cushion-verdict-body">${escapeHtml(verdict.detail || "")}</span>
          ${dip
            ? `<span class="cushion-verdict-meta">
                 Lowest point is month ${dip.month}, at ${money(dip.balance)}.
               </span>`
            : ""}
        </div>
        </div>

        <div class="cushion-basis">
          Based on your last ${Number(cushion.monthsOfHistory || 0)}
          ${Number(cushion.monthsOfHistory) === 1 ? "month" : "months"} of
          trading — about ${money(cushion.baseline?.revenue)} a month coming in
          and ${money(Number(cushion.baseline?.cogs || 0) + Number(cushion.baseline?.opex || 0))}
          going out — moved by the assumptions you set above.
          ${escapeHtml(cushion.assumption || "")}
        </div>
      `;
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


    let pageChatBusy = false;

    async function sendPageChat(prefill = null) {
        const input = document.getElementById("ai-page-input");
        const messages = document.getElementById("ai-page-messages");
        const sendBtn = document.getElementById("ai-page-send");

        const question = (prefill || input?.value || "").trim();

        // One question at a time: an answer can take a while, and a second
        // send before it lands would interleave the conversation.
        if (!question || !messages || pageChatBusy) return;

        const organizationId = getOrganizationId();
        if (!organizationId) return;

        pageChatBusy = true;
        if (sendBtn) sendBtn.disabled = true;

        const append = html => {
            messages.insertAdjacentHTML("beforeend", html);
            messages.scrollTop = messages.scrollHeight;
        };

        const aiBubble = inner => `
            <div class="ai-chat-msg ai-msg">
                <div class="ai-msg-avatar">${icon_ai()}</div>
                ${inner}
            </div>
        `;

        append(`
            <div class="ai-chat-msg user-msg">
                <div class="ai-msg-bubble">${escapeHtml(question)}</div>
            </div>
        `);

        if (input) input.value = "";

        append(aiBubble(`
            <div class="ai-msg-bubble ai-typing-bubble" id="ai-page-typing" aria-label="NFP AI is thinking">
                <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
            </div>
        `));

        const clearTyping = () =>
            document.getElementById("ai-page-typing")?.closest(".ai-chat-msg")?.remove();

        try {
            const response = await apiPost("/ai/ask", {
                organizationId,
                question,
                history: nonakaChatHistory
            });

            const answer = response?.answer || "No answer received.";

            nonakaChatHistory.push(
                { role: "user", content: question },
                { role: "assistant", content: answer }
            );

            clearTyping();
            append(aiBubble(`<div class="ai-msg-bubble ai-msg-markdown">${renderMarkdown(answer)}</div>`));
        } catch (error) {
            console.error("NFP AI request failed:", error);

            const errorText =
                error?.code === "AI_KEY_NOT_CONFIGURED"
                    ? "NFP AI needs an AI API key configured in the backend's .env file before it can answer questions."
                    : error?.code === "QB_NOT_CONNECTED"
                    ? "Connect QuickBooks first so I have real data to answer from."
                    : error?.code === "QB_REAUTH_REQUIRED" || error?.code === "AI_NO_CREDITS"
                    ? error.message
                    : "Sorry, I couldn't process that question right now.";

            clearTyping();
            append(aiBubble(`<div class="ai-msg-bubble">${escapeHtml(errorText)}</div>`));
        } finally {
            pageChatBusy = false;
            if (sendBtn) sendBtn.disabled = false;
            input?.focus();
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
      title: "Money in vs. money out",
      metrics: [
        { key: "revenue", label: "Money in", color: "primary" },
        { key: "totalExpenses", label: "Money out", color: "danger" }
      ]
    },
    {
      id: "revenue-profit",
      title: "Money in vs. what you kept",
      metrics: [
        { key: "revenue", label: "Money in", color: "primary" },
        { key: "netIncome", label: "What you kept", color: "success" }
      ]
    },
    {
      id: "revenue-gross-net",
      title: "Money in, money left after costs & what you kept",
      metrics: [
        { key: "revenue", label: "Money in", color: "primary" },
        { key: "grossProfit", label: "Money left after costs", color: "purple" },
        { key: "netIncome", label: "What you kept", color: "success" }
      ]
    },
    {
      id: "expenses-profit",
      title: "Money out vs. what you kept",
      metrics: [
        { key: "totalExpenses", label: "Money out", color: "danger" },
        { key: "netIncome", label: "What you kept", color: "success" }
      ]
    },
    {
      id: "cash-flow",
      title: "Cash from running the business",
      metrics: [
        { key: "operatingCashFlow", label: "Cash from running the business", color: "warning" }
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
        <div class="scenario-slider-label" style="margin-bottom:10px;">Financial view</div>
        <div class="period-selector" id="forecast-view-tabs" style="width:fit-content;max-width:100%;flex-wrap:wrap;margin-bottom:20px;"></div>

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

  // ------------------------------------------------------------
  // THE RATIOS, AS THE QUESTIONS THEY ANSWER
  //
  // The cards below this define nine ratios correctly, which helps if
  // you already know why you should care about them. These are the
  // same figures asked as questions — including the comparison nobody
  // runs for themselves, between how long customers take to pay and
  // how long the business takes to pay its own bills.
  // ------------------------------------------------------------

  async function loadRatioQuestions() {
    const body = document.getElementById("ratio-questions-body");
    if (!body) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    const { startDate, endDate } = getPeriodRange("year");

    try {
      const data = await apiGet(
        `/quickbooks/ratio-questions?organizationId=${encodeURIComponent(organizationId)}` +
        `&startDate=${encodeURIComponent(startDate)}` +
        `&endDate=${encodeURIComponent(endDate)}`
      );

      renderRatioQuestions(data);
    } catch (error) {
      console.error("Ratio questions failed:", error);

      body.innerHTML = `
        <div class="card card-pad">
          <div class="empty-state">
            ${escapeHtml(
              error?.code === "QB_REAUTH_REQUIRED"
                ? "Reconnect QuickBooks to see this."
                : "Unable to work out your health checks right now."
            )}
          </div>
        </div>
      `;
    }
  }

  function renderRatioQuestions(data) {
    const body = document.getElementById("ratio-questions-body");
    if (!body || !data) return;

    const questions = data.questions || [];

    if (!questions.length) {
      body.innerHTML = "";
      return;
    }

    // The cash gap is the one worth leading with, so it gets the full
    // width and the rest sit underneath it.
    const lead = questions.find(q => q.key === "cash-gap");
    const rest = questions.filter(q => q.key !== "cash-gap");

    const factsHtml = facts => facts?.length
      ? `<div class="rq-facts">
           ${facts.map(f => `
             <div class="rq-fact">
               <span class="rq-fact-label">
                 ${escapeHtml(f.label)}
                 ${f.term ? `<span class="rq-fact-term">${escapeHtml(f.term)}</span>` : ""}
               </span>
               <strong>${escapeHtml(f.value)}</strong>
             </div>
           `).join("")}
         </div>`
      : "";

    const card = (q, extraClass = "") => `
      <div class="card card-pad rq-card tone-${escapeHtml(q.tone || "quiet")} ${extraClass}">
        <span class="rq-question">${escapeHtml(q.question)}</span>
        <span class="rq-headline">${escapeHtml(q.headline || "")}</span>
        <span class="rq-detail">${escapeHtml(q.detail || "")}</span>
        ${factsHtml(q.facts)}
      </div>
    `;

    body.innerHTML = `
      <div class="rq-head">
        <span class="cashproj-eyebrow">The questions behind the numbers</span>
        <span class="cashproj-title">Your last 12 months, in plain terms</span>
      </div>

      ${lead ? card(lead, "is-lead") : ""}

      <div class="rq-grid">
        ${rest.map(q => card(q)).join("")}
      </div>
    `;
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
            <span style="font-size:12px;color:var(--text-muted);">Click for details</span>
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

      <div id="ratio-questions-body" class="section-gap">
        ${renderSkeletonCard(5)}
      </div>

      <div class="ratios-detail-head section-gap">
        <span class="ratios-detail-title">The ratios behind those answers</span>
        <span class="ratios-detail-sub">
          The same figures in their accounting form. Click any card for the
          full calculation and its trend.
        </span>
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

    loadRatioQuestions();

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
          <div class="kpi-value" style="font-size:24px;">${formatKPIValue(entry.value, entry.format)}</div>
        </div>
        <button class="btn btn-ghost" onclick="NFK_App.closeKPIModal()">✕</button>
      </div>

      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:20px;">
        ${escapeHtml(entry.interp)}
      </p>

      <div class="card card-pad" style="margin-bottom:20px;background:var(--bg-subtle);">
        <div class="card-title" style="margin-bottom:10px;">How this is calculated</div>
        <p style="font-family:var(--font-mono);font-size:12px;color:var(--text-primary);margin-bottom:14px;line-height:1.6;">
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
          : `<p style="font-size:12px;color:var(--text-muted);">Loading historical trend from QuickBooks, or not enough historical data is available yet.</p>`
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

      const factorTone = f =>
        f.impact === "positive" ? ["pos", "Good"]
        : f.impact === "negative" ? ["neg", "Needs attention"]
        : ["muted", "Fair"];

      container.innerHTML = `
        <div class="card card-pad ovw-col health-card-overview health-score-card-clickable" onclick="NFK_App.openHealthDetail()" title="Open the full breakdown">
          <div class="ovw-col-head">
            <h2 class="card-title">Financial health</h2>
            <span class="section-link">Why? →</span>
          </div>
          <div class="ovw-health-top">
            <div class="ovw-ring" role="img" aria-label="Financial health score ${pct} out of 100, ${escapeHtml(health.rating)}"
                 style="background: conic-gradient(${color} ${pct}%, #2A292D 0);">
              <div class="ovw-ring-inner">
                <span class="ovw-ring-score">${pct}</span>
                <span class="ovw-ring-of">out of 100</span>
              </div>
            </div>
            <div class="ovw-health-text">
              <span class="ovw-health-rating" style="color:${color};">${escapeHtml(health.rating)}</span>
              <span class="ovw-health-summary">${escapeHtml(firstSentence)}</span>
            </div>
          </div>
          <ul class="ovw-factors">
            ${health.factors.map(f => {
              const [tone, word] = factorTone(f);
              return `
                <li class="ovw-factor">
                  <span>${escapeHtml(f.label)}</span>
                  <span class="ovw-factor-word tone-${tone}">${word}</span>
                </li>`;
            }).join("")}
          </ul>
        </div>
      `;
    } catch (error) {
      console.error("❌ Failed to load overview health score:", error);
      container.innerHTML = `
        <div class="card card-pad ovw-col">
          <div class="ovw-col-head"><h2 class="card-title">Financial health</h2></div>
          ${aiErrorCardHtml(error)}
        </div>
      `;
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
    title: "Money in vs. money out",
    metrics: [
      { key: "revenue", label: "Money in", color: "primary" },
      { key: "totalExpenses", label: "Money out", color: "danger" }
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

  // In, out and kept over the twelve months the chart shows, from the same
  // history. A month that didn't load is left out rather than counted as 0.
  function renderTrendTotals() {
    const el = document.getElementById("overview-trend-totals");
    const history = overviewState.history;
    if (!el || !history) return;

    const sum = key => history.reduce((t, h) => t + (Number.isFinite(h[key]) ? h[key] : 0), 0);
    const moneyIn = sum("revenue");
    const moneyOut = sum("totalExpenses");

    el.innerHTML = `
      <span><i class="is-in"></i>In <strong>${formatCurrency(moneyIn)}</strong></span>
      <span><i class="is-out"></i>Out <strong>${formatCurrency(moneyOut)}</strong></span>
      <span>Kept <strong class="${moneyIn - moneyOut >= 0 ? "pos-val" : "neg-val"}">${formatCurrency(moneyIn - moneyOut)}</strong></span>
    `;
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
      renderTrendTotals();

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
          status: `${capWord(item.severity)} severity`,
          tone: ({ high: "neg", medium: "warn" })[(item.severity || "").toLowerCase()] || "muted",
          category: capWord(item.category)
        })),
        ...topRecommendation.map((item, i) => ({
          id: `rec-${i}`,
          kind: "positive",
          weight: (rank[(item.priority || "").toLowerCase()] ?? 3) + 0.5,
          title: item.title,
          body: item.description,
          meta: item.expectedImpact,
          status: `${capWord(item.priority)} priority`,
          tone: "pos",
          category: capWord(item.category)
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

  const capWord = s => { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); };

  function renderOverviewAlerts() {
    const body = document.getElementById("overview-alerts-body");
    if (!body || !overviewState.alerts) return;

    const visible = overviewState.alerts.filter(
      alert => !overviewState.dismissedAlerts.includes(alert.id)
    );

    if (!visible.length) {
      body.innerHTML = `<p class="ovw-muted">Nothing flagged right now.</p>`;
      return;
    }

    body.innerHTML = visible
      .map(
        alert => `
        <div class="ovw-item tone-${alert.tone === "pos" ? "pos" : alert.tone === "neg" ? "neg" : "warn"} is-linked"
             onclick="NFK_App.nav('ai-insights')" role="link" tabindex="0"
             aria-label="${escapeHtml(alert.title)} — open what we noticed">
          <span class="ovw-item-icon" aria-hidden="true">${alert.kind === "positive" ? icon_bulb() : icon_alert()}</span>
          <span class="ovw-item-text">
            <span class="ovw-item-title">${escapeHtml(alert.title)}</span>
            <span class="ovw-item-detail">${escapeHtml(alert.meta || alert.status || "")}</span>
          </span>
          <button
            class="alert-dismiss"
            title="Dismiss"
            aria-label="Dismiss"
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

  // The hero cash figure counts up from zero once when the Overview
  // renders — the one number the page is about. Skipped for anyone
  // who asks their system for reduced motion.
  function countUpHeroCash(value, currency) {
    const el = document.querySelector("#page-overview .metric-card.is-hero .stat-val");
    if (!el || !Number.isFinite(value)) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const start = performance.now();
    const duration = 1100;

    const tick = now => {
      const k = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = formatCurrency(value * eased, currency);
      if (k < 1) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  function renderOverview({ pl, bs, cf, ar, ap, debt }) {

    const page =
      document.getElementById("page-overview");

    if (!page) return;

    const currency =
      pl?.currency || bs?.currency || "USD";

    // Left null (rendered as "—") when the report behind them failed.
    const income = pl?.error ? null : Number(pl?.income || 0);
    const netIncome = pl?.error ? null : Number(pl?.netIncome || 0);

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
    function metricCard(label, value, priorValue, isError, glyph, secondaryLabel, sparklineId, goTo, extraClass = "") {
      const hasDelta =
        !isError &&
        Number.isFinite(value) &&
        Number.isFinite(priorValue) &&
        priorValue !== 0;

      const pct = hasDelta
        ? ((value - priorValue) / Math.abs(priorValue)) * 100
        : null;

      const up = hasDelta && pct >= 0;

      // Each headline is a summary of a page. Clicking it opens that
      // page, which is what someone reaching for a number on the
      // Overview is about to do anyway.
      const opens = goTo
        ? ` data-goto="${escapeHtml(goTo)}" role="link" tabindex="0"` +
          ` aria-label="${escapeHtml(label)} — open the full page"`
        : "";

      return `
        <div class="stat-card metric-card${goTo ? " is-linked" : ""}${extraClass ? ` ${extraClass}` : ""}"${opens}>

          <div class="metric-glyph">${glyph}</div>

          <div class="stat-label">${escapeHtml(label)}${
            secondaryLabel
              ? ` <span class="stat-sub-quiet">· ${escapeHtml(secondaryLabel)}</span>`
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

    // A plain figure card for totals that have no prior-period
    // comparison (what customers owe, what you owe).
    function totalCard(label, value, note, isError, goTo) {
      return `
        <div class="stat-card metric-card is-linked" data-goto="${goTo}" role="link" tabindex="0"
             aria-label="${escapeHtml(label)} — open the full page">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-val">${isError || !Number.isFinite(value) ? "—" : formatCurrency(Number(value), currency)}</div>
          <div class="stat-sub"><span class="stat-sub-quiet">${isError ? "Unable to load" : escapeHtml(note)}</span></div>
        </div>
      `;
    }

    const arTotal = ar?.error ? null : Number(ar?.total || 0);
    const apTotal = ap?.error ? null : Number(ap?.total || 0);
    const summaryLine = overviewSummaryLine({
      income, netIncome, cashBalance, periodLabel, currency
    });

    page.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Overview</h1>
          ${summaryLine
            ? `<p class="overview-summary">${escapeHtml(summaryLine)}</p>`
            : `<p class="page-subtitle">${escapeHtml(overviewSubtitle)}</p>`}
        </div>

        <div class="page-header-actions">
          ${renderPeriodSelector(state.overviewPeriod, "setOverviewPeriod")}

          <button class="btn btn-primary" onclick="NFK_App.nav('ai-insights')">
            AI Insights
          </button>
        </div>
      </div>

      <!-- 1. Cash on hand: the figure beside a wide line of the last year. -->
      <section class="card ovw-cash section-gap" aria-label="Cash on hand">
        <div class="ovw-cash-main">
          ${metricCard("Cash on hand", cashBalance, priorCash, !!cf?.error, icon_wallet(), null, null, "cash-flow", "is-hero")}

          <dl class="ovw-cash-split" id="ovw-cash-split" hidden></dl>

          <div class="overview-runway is-linked"
               data-goto="forecast" role="link" tabindex="0"
               aria-label="How long your cash lasts — open the forecast">
            <span class="overview-runway-icon">${icon_clock()}</span>
            <div class="overview-runway-text" id="overview-cash-runway">
              <div class="stat-label">How long your cash lasts</div>
              <div class="stat-val">
                <span class="skeleton-line skeleton-shimmer" style="width:70px;height:18px;display:inline-block;margin:0;"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="ovh-curve" id="overview-cash-curve"></div>
      </section>

      <!-- 2. Key figures, five across. -->
      <div class="overview-figures section-gap">
        ${metricCard("Money earned", income, priorIncome, !!pl?.error, icon_pl(), "Revenue", "overview-spark-income", "pl")}
        ${metricCard("What you kept", netIncome, priorNetIncome, !!pl?.error, icon_forecast(), "Net income", "overview-spark-netincome", "pl")}
        ${metricCard("Left after short-term bills", workingCapital, priorWorkingCapital, !!bs?.error, icon_scale(), null, null, "balance-sheet")}
        ${totalCard("Owed to you", arTotal, "Unpaid customer invoices", !!ar?.error, "working-capital")}
        ${totalCard("Bills to pay", apTotal, "Unpaid bills from suppliers", !!ap?.error, "ap-vendors")}
      </div>

      <!-- 3. Where your cash is heading: one band across the page. -->
      <section class="card ovw-ahead section-gap" id="cash-projection-body" aria-label="Where your cash is heading">
        ${renderSkeletonCard(3)}
      </section>

      <!-- 4. Health, what we noticed, and what to do this week. -->
      <div class="ovw-three section-gap">
        <div id="overview-health-score">
          <div class="card card-pad ovw-col">
            <div class="ovw-col-head"><h2 class="card-title">Financial health</h2></div>
            <p class="ovw-muted">Working out your health score…</p>
          </div>
        </div>

        <section class="card card-pad ovw-col" aria-labelledby="ovw-noticed-h">
          <div class="ovw-col-head">
            <h2 class="card-title" id="ovw-noticed-h">What we noticed</h2>
            <a href="#" class="section-link" onclick="event.preventDefault(); NFK_App.nav('ai-insights')">See all →</a>
          </div>
          <div id="overview-alerts-body" class="ovw-list">
            <p class="ovw-muted">Scanning your data…</p>
          </div>
        </section>

        <section class="card card-pad ovw-col" aria-labelledby="ovw-week-h">
          <div class="ovw-col-head">
            <h2 class="card-title" id="ovw-week-h">This week</h2>
            <span class="ovw-muted ovw-small">From your books</span>
          </div>
          <div id="overview-this-week" class="ovw-list">
            ${renderSkeletonCard(3)}
          </div>
        </section>
      </div>

      <!-- 5. Money in vs money out, across the page. -->
      <section class="card card-pad section-gap" aria-labelledby="ovw-trend-h">
        <div class="card-header ovw-trend-head">
          <div>
            <h2 class="card-title" id="ovw-trend-h">Money in vs. money out</h2>
            <div class="card-sub">Last 12 months</div>
          </div>

          <div class="ovw-trend-side">
            <div class="ovw-trend-totals" id="overview-trend-totals"></div>

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
        </div>

        <div class="chart-frame" id="overview-trend-body">
          <div class="skeleton-line skeleton-shimmer" style="height:100%;margin:0;"></div>
        </div>
      </section>

      <div class="grid-2 section-gap">
        <div class="card card-pad is-linked" id="money-in-body"
             data-goto="pl" role="link" tabindex="0"
             aria-label="Where the money came from — open what you kept">
          ${renderSkeletonCard(5)}
        </div>

        <div class="card card-pad is-linked" id="money-out-body"
             data-goto="pl" role="link" tabindex="0"
             aria-label="Biggest things money went out on — open what you kept">
          ${renderSkeletonCard(5)}
        </div>
      </div>

      <!-- 6. Loans and cards, a strip across the page. -->
      <div class="card card-pad overview-debt is-linked section-gap"
           data-goto="debt-register" role="link" tabindex="0"
           aria-label="Loans and cards — open the full page">
        <div class="overview-debt-title">
          <div class="card-title">Loans &amp; cards</div>
          <div class="card-sub">What the business still owes</div>
        </div>
        ${
          debt?.error
            ? `<div class="stat-sub neg">Unable to load debt data</div>`
            : (() => {
                const soon = Number(debt?.currentDebt || 0);
                const later = Number(debt?.longTermDebt || 0);
                const total = Number(debt?.totalDebt || 0);
                const soonPct = total > 0 ? (soon / total) * 100 : 0;

                return `
                  <div class="overview-debt-mid">
                    ${total > 0
                      ? `<div class="overview-debt-bar" aria-hidden="true">
                           <span class="is-soon" style="width:${soonPct.toFixed(1)}%"></span>
                           <span class="is-later" style="width:${(100 - soonPct).toFixed(1)}%"></span>
                         </div>`
                      : ""}
                    <div class="overview-debt-legend">
                      <span><i class="is-soon"></i>Due within a year <strong>${formatCurrency(soon, currency)}</strong></span>
                      <span><i class="is-later"></i>Due later <strong>${formatCurrency(later, currency)}</strong></span>
                    </div>
                  </div>
                  <div class="overview-debt-total">
                    <span class="stat-label">Total</span>
                    <strong>${formatCurrency(total, currency)}</strong>
                  </div>
                `;
              })()
        }
      </div>
    `;

    countUpHeroCash(cashBalance, currency);

    loadOverviewHealthScore();
    loadOverviewTrendChart();
    loadOverviewAlerts();
    loadCashProjection();
    loadCashHistory();
    loadMoneyFlow();
  }

  // ------------------------------------------------------------
  // CASH OVER THE LAST YEAR
  //
  // The line under "Cash in the bank": the balance at the end of each of
  // the last twelve months, ending on today's. It doesn't depend on the
  // period toggle, so it is kept for the organization rather than asked
  // for again every time the toggle moves.
  // ------------------------------------------------------------

  async function loadCashHistory() {
    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      if (overviewState.cashHistory?.organizationId !== organizationId) {
        const history = await apiGet(
          `/quickbooks/cash-history?organizationId=${encodeURIComponent(organizationId)}`
        );

        overviewState.cashHistory = { organizationId, ...history };
      }

      renderCashHistory(overviewState.cashHistory);
    } catch (error) {
      // The figure above still stands on its own; the line is extra.
      console.error("Cash history failed:", error);
    }
  }

  function renderCashHistory(history) {
    const slot = document.getElementById("overview-cash-curve");
    if (!slot) return;

    const points = (history?.points || []).filter(p => Number.isFinite(Number(p.balance)));
    const values = points.map(p => Number(p.balance));

    // A flat line would only say "no data", so nothing is drawn.
    if (values.length < 2 || Math.min(...values) === Math.max(...values)) {
      slot.innerHTML = "";
      return;
    }

    // Drawn in a 1000 x 100 box that stretches to the card, so the line can
    // run edge to edge at any width. The end marker is an element placed by
    // percentage rather than an SVG circle, which the stretch would squash.
    const currency = history.currency || "USD";
    const RIGHT = 940, TOP = 8, BOTTOM = 96;
    const min = Math.min(...values), max = Math.max(...values);

    const pts = values.map((v, i) => [
      (i / (values.length - 1)) * RIGHT,
      TOP + (1 - (v - min) / (max - min)) * (BOTTOM - TOP)
    ]);

    const line = monotonePath(pts);
    const [endX, endY] = pts[pts.length - 1];
    const label =
      `Bank balance at the end of each month, from ${points[0].label} ` +
      `(${formatCurrency(values[0], currency)}) to ${points[points.length - 1].label} ` +
      `(${formatCurrency(values[values.length - 1], currency)})`;

    slot.innerHTML = `
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}">
        <defs>
          <linearGradient id="ovh-curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style="stop-color:var(--positive);stop-opacity:0.22" />
            <stop offset="1" style="stop-color:var(--positive);stop-opacity:0" />
          </linearGradient>
        </defs>
        <path d="${line} L${endX},100 L0,100 Z" fill="url(#ovh-curve-fill)" />
        <path class="ovh-curve-line" d="${line}" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="ovh-curve-dot" style="left:${endX / 10}%;top:calc(40px + (100% - 74px) * ${(endY / 100).toFixed(3)})"></span>
      <span class="ovh-curve-caption">Month-end balance · last 12 months</span>
      <span class="ovh-curve-axis"><span>${escapeHtml(points[0].label)}</span><span>Today</span></span>
    `;
  }


  // Monotone cubic through the points (Fritsch–Carlson), as an SVG path.
  // Unlike a plain smooth curve it never bulges past a real point, so it
  // can't show a rise or dip that isn't in the numbers.
  function monotonePath(pts) {
    const n = pts.length;
    const dx = [], slope = [];

    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
    }

    const m = [slope[0]];
    for (let i = 1; i < n - 1; i++) {
      m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    }
    m[n - 1] = slope[n - 2];

    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / slope[i], b = m[i + 1] / slope[i], h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * slope[i];
        m[i + 1] = t * b * slope[i];
      }
    }

    const f = v => v.toFixed(1);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;

    for (let i = 0; i < n - 1; i++) {
      const third = dx[i] / 3;
      d += ` C${f(pts[i][0] + third)},${f(pts[i][1] + m[i] * third)}` +
           ` ${f(pts[i + 1][0] - third)},${f(pts[i + 1][1] - m[i + 1] * third)}` +
           ` ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
    }

    return d;
  }

  // ------------------------------------------------------------
  // WHERE THE MONEY CAME FROM, AND WHAT IT WENT ON
  //
  // The P&L page shows every line. These two cards answer the shorter
  // question: which handful of things actually moved the needle this
  // period. Ranking, sub-account roll-up and the share arithmetic are
  // all done server-side.
  // ------------------------------------------------------------

  async function loadMoneyFlow() {
    const inBody = document.getElementById("money-in-body");
    const outBody = document.getElementById("money-out-body");

    if (!inBody || !outBody) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    const { startDate, endDate } = getPeriodRange(state.overviewPeriod || "month");

    try {
      const flow = await apiGet(
        `/quickbooks/money-flow?organizationId=${encodeURIComponent(organizationId)}` +
        `&startDate=${encodeURIComponent(startDate)}` +
        `&endDate=${encodeURIComponent(endDate)}`
      );

      renderMoneyFlowCard("money-in-body", {
        eyebrow: "Where the money came from",
        emptyText: "QuickBooks recorded no income in this period.",
        tone: "pos",
        data: flow.moneyIn,
        currency: flow.currency,
        creditNote: n =>
          `${n} refund or discount line${n === 1 ? "" : "s"} reduced this, shown on the P&L page.`
      });

      renderMoneyFlowCard("money-out-body", {
        eyebrow: "Biggest things money went out on",
        emptyText: "QuickBooks recorded no costs in this period.",
        tone: "neg",
        data: flow.moneyOut,
        currency: flow.currency,
        creditNote: n =>
          `${n} credit line${n === 1 ? "" : "s"} reduced this, shown on the P&L page.`
      });
    } catch (error) {
      console.error("Money flow failed:", error);

      const message =
        error?.code === "QB_REAUTH_REQUIRED"
          ? "Reconnect QuickBooks to see this."
          : "Unable to work out this breakdown right now.";

      // The request outlives the page: changing the period or leaving
      // the Overview replaces this markup, so by the time a failure
      // comes back these elements may be gone.
      for (const id of ["money-in-body", "money-out-body"]) {
        const el = document.getElementById(id);

        if (el) {
          el.innerHTML = `
            <div class="empty-state">${escapeHtml(message)}</div>
          `;
        }
      }
    }
  }

  function renderMoneyFlowCard(
    targetId,
    { eyebrow, emptyText, tone, data, currency, creditNote }
  ) {
    const body = document.getElementById(targetId);
    if (!body) return;

    const money = v => formatCurrency(Number(v || 0), currency);
    const rows = data?.rows || [];

    if (!rows.length) {
      body.innerHTML = `
        <div class="moneyflow-head">
          <span class="cashproj-eyebrow">${escapeHtml(eyebrow)}</span>
          <span class="cashproj-title">Nothing recorded</span>
        </div>
        <div class="cashproj-nodata">${escapeHtml(emptyText)}</div>
      `;
      return;
    }

    const hidden = Math.max(
      0,
      Number(data.categoryCount || 0) - rows.filter(r => !r.isRemainder).length
    );

    body.innerHTML = `
      <div class="moneyflow-head">
        <span class="cashproj-eyebrow">${escapeHtml(eyebrow)}</span>
        <span class="cashproj-title">${money(data.total)}</span>
        <span class="moneyflow-sub">
          across ${Number(data.categoryCount || 0)}
          ${Number(data.categoryCount) === 1 ? "category" : "categories"}
        </span>
      </div>

      <div class="moneyflow-rows">
        ${rows.map(row => `
          <div class="moneyflow-row${row.isRemainder ? " is-rest" : ""}">
            <div class="moneyflow-row-top">
              <span class="moneyflow-name" title="${escapeHtml(row.name)}">
                ${escapeHtml(row.name)}
              </span>
              <span class="moneyflow-share">${Number(row.share || 0)}%</span>
              <strong class="moneyflow-amount">${money(row.amount)}</strong>
            </div>

            <div class="moneyflow-bar">
              <span
                class="moneyflow-bar-fill ${tone}"
                style="width:${Math.max(Number(row.share || 0), 0.6)}%"
              ></span>
            </div>

            ${row.parts?.length
              ? `<div class="moneyflow-parts">${
                  row.parts
                    .slice(0, 4)
                    .map(p => `${escapeHtml(p.name)} ${money(p.amount)}`)
                    .join(" · ")
                }${row.parts.length > 4 ? ` · +${row.parts.length - 4} more` : ""}</div>`
              : ""}
          </div>
        `).join("")}
      </div>

      ${data.credits
        ? `<div class="moneyflow-note">${escapeHtml(creditNote(data.credits.count))}</div>`
        : hidden > 0
          ? `<div class="moneyflow-note">The ${hidden} smallest ${
              hidden === 1 ? "category is" : "categories are"
            } grouped into the last row.</div>`
          : ""}
    `;
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
    const customerCount = Number(overdue.customerCount || 0);
    const supplierCount = Number(overdue.supplierCount || 0);

    // With nothing dated in the window the chart would be a flat line
    // that implies a forecast we don't have, so say what's actually
    // known instead of drawing a straight line and calling it a
    // projection.
    const hasForwardMovement = movementDays > 0;

    const tile = ({ tone, icon, label, value, valueTone = "", goTo, aria }) => `
      <div class="ovh-row tone-${tone}${goTo ? " is-linked" : ""}"
           ${goTo ? `data-goto="${goTo}" role="link" tabindex="0" aria-label="${escapeHtml(aria)}"` : ""}>
        <span class="ovh-icon${goTo ? " is-square" : ""}">${icon}</span>
        <div class="ovh-row-text">
          <span class="ovh-label">${escapeHtml(label)}</span>
          <strong class="ovh-figure${valueTone ? ` ${valueTone}` : ""}">${value}</strong>
        </div>
      </div>
    `;

    const notes = [
      tip?.suggestion ? escapeHtml(tip.suggestion) : "",
      !hasForwardMovement
        ? "Nothing new is dated in the next 30 days — everything unpaid is already past its due date."
        : ""
    ].filter(Boolean);

    body.innerHTML = `
      <div class="ovh-head">
        <div>
          <div class="ovh-eyebrow">Next 30 days</div>
          <h2 class="ovh-title">Where your cash is heading</h2>
        </div>
        <a href="#" class="section-link" onclick="event.preventDefault(); NFK_App.nav('forecast')">Full forecast →</a>
      </div>

      <div class="ovh-tiles">
        ${tile({ tone: "pos", icon: icon_bank(), label: "In the bank now", value: money(projection.openingCash) })}
        ${Number.isFinite(projection.safeFloor)
          ? tile({ tone: "neg", icon: icon_arrow_up_right(), label: "Usual monthly outgoings", value: money(projection.safeFloor) })
          : ""}
        ${tile({
          tone: "quiet-pos", icon: icon_doc(), label: `Already owed to you · ${customerCount} overdue`,
          value: money(overdue.customersOweYou), valueTone: "pos-val",
          goTo: "working-capital", aria: "Already owed to you — open money owed to you"
        })}
        ${tile({
          tone: "quiet-neg", icon: icon_doc(), label: `You already owe · ${supplierCount} overdue`,
          value: money(overdue.youOweSuppliers), valueTone: "neg-val",
          goTo: "ap-vendors", aria: "You already owe — open bills to pay"
        })}
      </div>

      ${hasForwardMovement
        ? `<div class="chart-frame cashproj-chart ovh-chart"><canvas id="chart-cash-projection"></canvas></div>`
        : ""}

      ${notes.length
        ? `<div class="ovh-row tone-warn ovh-note">
             <span class="ovh-icon">${icon_bulb()}</span>
             <div class="ovh-row-text">
               <span class="ovh-row-head">Worth knowing</span>
               <p class="ovh-text">${notes.join(" ")}</p>
               ${tip?.bill
                 ? `<span class="ovh-meta">${escapeHtml(tip.bill.party)} · ${money(tip.bill.amount)} · due ${escapeHtml(tip.bill.dueDate)}</span>`
                 : ""}
             </div>
           </div>`
        : ""}
    `;

    if (hasForwardMovement && window.NFK_Charts?.renderCashProjection) {
      window.NFK_Charts.renderCashProjection("chart-cash-projection", projection);
    }

    overviewState.projection = projection;
    renderCashSplit();
    renderThisWeek();
  }

  // Under the cash figure: how much of it is actually in bank accounts.
  // "Cash on hand" comes from the cash flow report, which also counts money
  // held outside a bank account (in QuickBooks, usually payments received
  // but not yet deposited); the projection's opening balance is the bank
  // accounts alone. Shown only when the two genuinely differ.
  function renderCashSplit() {
    const el = document.getElementById("ovw-cash-split");
    const cash = overviewState.cashBalance;
    const bank = Number(overviewState.projection?.openingCash);
    if (!el || !Number.isFinite(cash) || !Number.isFinite(bank)) return;

    const elsewhere = cash - bank;
    if (Math.abs(elsewhere) < 0.5) return;

    const currency = overviewState.projection?.currency || "USD";

    el.innerHTML = `
      <dt>In bank accounts</dt><dd>${formatCurrency(bank, currency)}</dd>
      <dt>Not yet in the bank</dt><dd>${formatCurrency(elsewhere, currency)}</dd>
    `;
    el.hidden = false;
  }

  // A short list of things worth doing now, taken straight from the books:
  // money waiting to be banked, invoices to chase, bills to pay. Each line
  // appears only when its number is real and above zero.
  function renderThisWeek() {
    const el = document.getElementById("overview-this-week");
    const projection = overviewState.projection;
    if (!el || !projection) return;

    const currency = projection.currency || "USD";
    const money = v => formatCurrency(Number(v || 0), currency);
    const overdue = projection.overdue || {};
    const items = [];

    const cash = overviewState.cashBalance;
    const bank = Number(projection.openingCash);
    if (Number.isFinite(cash) && Number.isFinite(bank) && cash - bank >= 0.5) {
      items.push({
        tone: "pos", icon: icon_bank(), goTo: "cash-flow",
        title: "Bank the money you're holding",
        detail: `${money(cash - bank)} received but not yet in a bank account`
      });
    }

    if (Number(overdue.customersOweYou) > 0) {
      const n = Number(overdue.customerCount || 0);
      items.push({
        tone: "warn", icon: icon_doc(), goTo: "working-capital",
        title: `Chase ${n} overdue invoice${n === 1 ? "" : "s"}`,
        detail: `${money(overdue.customersOweYou)} customers should already have paid`
      });
    }

    if (Number(overdue.youOweSuppliers) > 0) {
      const n = Number(overdue.supplierCount || 0);
      items.push({
        tone: "neg", icon: icon_doc(), goTo: "ap-vendors",
        title: `Pay ${n} overdue bill${n === 1 ? "" : "s"}`,
        detail: `${money(overdue.youOweSuppliers)} already past its due date`
      });
    }

    el.innerHTML = items.length
      ? items.map(item => `
          <div class="ovw-item tone-${item.tone} is-linked" data-goto="${item.goTo}" role="link" tabindex="0"
               aria-label="${escapeHtml(item.title)} — open the page">
            <span class="ovw-item-icon">${item.icon}</span>
            <span class="ovw-item-text">
              <span class="ovw-item-title">${escapeHtml(item.title)}</span>
              <span class="ovw-item-detail">${escapeHtml(item.detail)}</span>
            </span>
          </div>
        `).join("")
      : `<p class="ovw-muted">Nothing needs your attention this week.</p>`;
  }

  // ------------------------------------------------------------
  // WHO TO CHASE FIRST
  //
  // The aging bar below this card is the accountant's view of the same
  // money: buckets of thirty days. This is the owner's view — what is
  // at risk, what is merely late, and what isn't due yet. The banding
  // and the arithmetic happen server-side.
  // ------------------------------------------------------------

  async function loadInvoiceUrgency() {
    const body = document.getElementById("invoice-urgency-body");
    if (!body) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      const urgency = await apiGet(
        `/quickbooks/invoice-urgency?organizationId=${encodeURIComponent(organizationId)}`
      );

      renderInvoiceUrgency(urgency);
    } catch (error) {
      console.error("Invoice urgency failed:", error);

      body.innerHTML = `
        <div class="empty-state">
          ${escapeHtml(
            error?.code === "QB_REAUTH_REQUIRED"
              ? "Reconnect QuickBooks to see who owes you."
              : "Unable to load who owes you right now."
          )}
        </div>
      `;
    }
  }

  // A summary card as a row of equal figure blocks — the headline first,
  // then the numbers behind it — so a wide card is filled with figures
  // instead of a heading in one corner and a caption in the other.
  // cells: [{ label, value, sub, tone }] — tone: "warn" | "neg" | "pos"
  function summaryStripHtml(cells) {
    return `
      <div class="summary-strip">
        ${cells.map((c, i) => `
          <div class="summary-cell${i === 0 ? " is-lead" : ""}">
            <span class="summary-label">${escapeHtml(c.label)}</span>
            <span class="summary-value${c.tone ? ` is-${c.tone}` : ""}">${escapeHtml(c.value)}</span>
            ${c.sub ? `<span class="summary-sub">${escapeHtml(c.sub)}</span>` : ""}
          </div>`).join("")}
      </div>
    `;
  }

  function renderInvoiceUrgency(urgency) {
    const body = document.getElementById("invoice-urgency-body");
    if (!body || !urgency) return;

    const money = v => formatCurrency(Number(v || 0));

    const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

    const invoiceRow = invoice => `
      <div class="billsched-row">
        <div class="billsched-who">
          <span class="billsched-vendor">${escapeHtml(invoice.customer || "Unknown customer")}</span>
          ${invoice.docNumber
            ? `<span class="billsched-ref">Invoice ${escapeHtml(String(invoice.docNumber))}</span>`
            : ""}
        </div>
        <span class="billsched-when">${escapeHtml(invoice.timing || "")}</span>
        <strong class="billsched-amount">${money(invoice.amount)}</strong>
      </div>
    `;

    const group = (band, { title, note, tone = "", showWhenEmpty = false }) => {
      const count = Number(band?.count || 0);

      if (!count && !showWhenEmpty) return "";

      return `
        <div class="card card-pad billsched-group ${count ? tone : ""}">
          <div class="billsched-group-head">
            <div>
              <span class="billsched-group-title">${escapeHtml(title)}</span>
              <span class="billsched-group-count">${plural(count, "invoice")}</span>
            </div>
            <strong>${money(band?.total)}</strong>
          </div>
          ${note ? `<div class="billsched-group-note">${escapeHtml(note)}</div>` : ""}
          ${count
            ? renderInvoiceRows(band.invoices || [])
            : `<div class="billsched-none">Nothing here — good news.</div>`}
        </div>
      `;
    };

    // A band can run to twenty-odd rows. The first few are what gets
    // acted on today; the rest stay one click away rather than being
    // dropped, so the list still agrees with the total above it.
    const VISIBLE = 8;

    function renderInvoiceRows(invoices) {
      const head = invoices.slice(0, VISIBLE);
      const tail = invoices.slice(VISIBLE);

      return `
        <div class="billsched-rows">
          ${head.map(invoiceRow).join("")}
          ${tail.length
            ? `<details class="urgency-more">
                 <summary>Show the other ${tail.length} (${money(
                   tail.reduce((sum, i) => sum + Number(i.amount || 0), 0)
                 )})</summary>
                 ${tail.map(invoiceRow).join("")}
               </details>`
            : ""}
        </div>
      `;
    }

    const owed = Number(urgency.totalOwed || 0);

    if (!owed) {
      body.innerHTML = `
        <div class="billsched-head">
          <span class="cashproj-eyebrow">Who to chase first</span>
          <span class="cashproj-title">Nobody owes you anything</span>
        </div>
        <div class="cashproj-nodata">
          QuickBooks shows no unpaid customer invoices on your books right now.
        </div>
      `;
      return;
    }

    const share = Number(urgency.overdueShare || 0);
    const oldest = urgency.oldest;

    const bandCell = (band, label, tone) => {
      const count = Number(band?.count || 0);
      return {
        label,
        value: money(band?.total),
        sub: count ? plural(count, "invoice") : "None",
        tone: count ? tone : ""
      };
    };

    body.innerHTML = `
      <div class="card card-pad billsched-summary">
        ${summaryStripHtml([
          { label: "Who to chase first", value: `${money(owed)} owed to you` },
          { label: "Already late", value: `${share}%`, sub: "of what you're owed", tone: share > 0 ? "warn" : "" },
          bandCell(urgency.atRisk, "At risk", "neg"),
          bandCell(urgency.dueThisWeek, "Due this week", "")
        ])}

      ${oldest
        ? `<div class="urgency-call">
             <span class="urgency-call-head">Start with ${escapeHtml(oldest.customer)}</span>
             <span class="urgency-call-body">
               ${money(oldest.amount)} has been unpaid for ${Number(oldest.daysLate)} days${
                 oldest.docNumber ? ` on invoice ${escapeHtml(String(oldest.docNumber))}` : ""
               } — the longest of anything you're owed.
             </span>
           </div>`
        : ""}
      </div>

      <div class="billsched-groups">
      ${group(urgency.atRisk, {
        title: "At risk",
        note: `More than ${Number(urgency.atRiskAfterDays)} days past due. The longer these sit, the harder they get to collect.`,
        tone: "is-overdue",
        showWhenEmpty: true
      })}

      ${group(urgency.late, {
        title: "Late",
        note: "Past the date you asked to be paid, but not yet a problem.",
        tone: "is-soon",
        showWhenEmpty: true
      })}

      ${group(urgency.dueThisWeek, {
        title: "Due this week",
        note: "Not late. Worth knowing what's about to land.",
        tone: "is-upcoming",
        showWhenEmpty: true
      })}

      ${group(urgency.dueLater, {
        title: "Due later",
        note: "Nothing to do yet."
      })}

      ${group(urgency.undated, {
        title: "No due date recorded",
        note: "QuickBooks has no due date on these, so they can't be placed on the calendar."
      })}
      </div>
    `;
  }

  // ------------------------------------------------------------
  // WHAT'S DUE, AND WHEN
  //
  // The Accounts Payable report below this card looks backwards — how
  // long a bill has been sitting unpaid. This looks forwards: what has
  // to be paid this week, what can wait until later in the month. The
  // grouping is done server-side from each bill's own due date.
  // ------------------------------------------------------------

  async function loadBillsSchedule() {
    const body = document.getElementById("bills-schedule-body");
    if (!body) return;

    const organizationId = getOrganizationId();
    if (!organizationId) return;

    try {
      const schedule = await apiGet(
        `/quickbooks/bills-schedule?organizationId=${encodeURIComponent(organizationId)}`
      );

      renderBillsSchedule(schedule);
    } catch (error) {
      console.error("Bills schedule failed:", error);

      body.innerHTML = `
        <div class="empty-state">
          ${escapeHtml(
            error?.code === "QB_REAUTH_REQUIRED"
              ? "Reconnect QuickBooks to see what's due."
              : "Unable to load your upcoming bills right now."
          )}
        </div>
      `;
    }
  }

  function renderBillsSchedule(schedule) {
    const body = document.getElementById("bills-schedule-body");
    if (!body || !schedule) return;

    const money = v => formatCurrency(Number(v || 0));

    const plural = (n, word) =>
      `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

    const billRow = bill => `
      <div class="billsched-row">
        <div class="billsched-who">
          <span class="billsched-vendor">${escapeHtml(bill.vendor || "Unknown supplier")}</span>
          ${bill.docNumber
            ? `<span class="billsched-ref">Bill ${escapeHtml(String(bill.docNumber))}</span>`
            : ""}
        </div>
        <span class="billsched-when">${escapeHtml(bill.timing || "")}</span>
        <strong class="billsched-amount">${money(bill.amount)}</strong>
      </div>
    `;

    // A group with nothing in it is still worth showing when it is one
    // the owner would look for — "Overdue: none" is reassuring, and its
    // absence would leave them wondering whether it was checked.
    const group = (bucket, { title, note, tone = "", showWhenEmpty = false }) => {
      const count = Number(bucket?.count || 0);

      if (!count && !showWhenEmpty) return "";

      // An empty group is good news, so it keeps the neutral colour —
      // a red or amber $0.00 would read as a warning about nothing.
      return `
        <div class="card card-pad billsched-group ${count ? tone : ""}">
          <div class="billsched-group-head">
            <div>
              <span class="billsched-group-title">${escapeHtml(title)}</span>
              <span class="billsched-group-count">${plural(count, "bill")}</span>
            </div>
            <strong>${money(bucket?.total)}</strong>
          </div>
          ${note ? `<div class="billsched-group-note">${escapeHtml(note)}</div>` : ""}
          ${count
            ? `<div class="billsched-rows">${(bucket.bills || []).map(billRow).join("")}</div>`
            : `<div class="billsched-none">Nothing here — you're up to date.</div>`}
        </div>
      `;
    };

    const dayMonth = iso => {
      if (!iso) return "";
      const d = new Date(`${iso}T00:00:00Z`);
      return d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        timeZone: "UTC"
      });
    };

    const total = Number(schedule.totalOutstanding || 0);

    if (!total) {
      body.innerHTML = `
        <div class="billsched-head">
          <span class="cashproj-eyebrow">What's due, and when</span>
          <span class="cashproj-title">Nothing outstanding</span>
        </div>
        <div class="cashproj-nodata">
          QuickBooks has no unpaid supplier bills on your books right now.
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="card card-pad billsched-summary">
        ${summaryStripHtml([
          { label: "What's due, and when", value: `${money(total)} still to pay` },
          {
            label: "Overdue",
            value: money(schedule.overdue?.total),
            sub: Number(schedule.overdue?.count || 0) ? plural(schedule.overdue.count, "bill") : "None",
            tone: Number(schedule.overdue?.count || 0) ? "neg" : ""
          },
          {
            label: "Due this week",
            value: money(schedule.thisWeek?.total),
            sub: `To ${dayMonth(schedule.weekEnds)}`,
            tone: Number(schedule.thisWeek?.count || 0) ? "warn" : ""
          },
          {
            label: "Later this month",
            value: money(schedule.laterThisMonth?.total),
            sub: Number(schedule.laterThisMonth?.count || 0) ? plural(schedule.laterThisMonth.count, "bill") : "None"
          }
        ])}
      </div>

      <div class="billsched-groups">
      ${group(schedule.overdue, {
        title: "Overdue",
        note: "Past the date agreed with your supplier. Worth dealing with first.",
        tone: "is-overdue",
        showWhenEmpty: true
      })}

      ${group(schedule.thisWeek, {
        title: "Due this week",
        note: `Everything due between today and ${dayMonth(schedule.weekEnds)}.`,
        tone: "is-soon",
        showWhenEmpty: true
      })}

      ${group(schedule.laterThisMonth, {
        title: "Due later this month",
        note: `Falls due before ${dayMonth(schedule.monthEnds)}.`,
        tone: "is-upcoming"
      })}

      ${group(schedule.later, {
        title: "Due after this month",
        note: "Not urgent, but already on your books."
      })}

      ${group(schedule.undated, {
        title: "No due date recorded",
        note: "QuickBooks has no due date on these, so they can't be placed on the calendar."
      })}
      </div>
    `;
  }

  // The prior-period figures are what every headline delta is measured
  // against, so the page waits for them alongside the current ones. Drawn
  // without them, a card could compare this quarter against whatever the
  // previous period selection happened to load.
  async function loadOverview(period) {
    const page = document.getElementById("page-overview");

    if (page) {
      page.innerHTML = `
        ${renderSkeletonCard(2)}
        ${renderSkeletonStatGrid(4)}
        ${renderSkeletonCard(4)}
      `;
    }

    const [prior, results] = await Promise.all([
      loadOverviewComparison(period).catch(() => null),
      Promise.allSettled([
        loadProfitAndLoss(period),
        loadBalanceSheet(period),
        loadCashFlow(period),
        loadAccountsReceivable(),
        loadAccountsPayable(),
        loadDebt()
      ])
    ]);

    // A later period switch owns the page now.
    if (period !== state.overviewPeriod || state.currentPage !== "overview") return;

    overviewState.prior = prior;

    const [pl, bs, cf, ar, ap, debt] = results.map(r =>
      r.status === "fulfilled"
        ? r.value
        : { error: r.reason?.message || "Failed to load" }
    );

    renderOverview({ pl, bs, cf, ar, ap, debt });
  }

  function setOverviewPeriod(period) {
    state.overviewPeriod = period;
    return loadOverview(period);
  }

  // ------------------------------------------------------------
  // OFF-CANVAS SIDEBAR (narrow screens)
  //
  // Below the width set in the .sidebar-toggle-btn media rule, the
  // sidebar is fixed off-screen and slides in over the content rather
  // than sharing space with it — there isn't 244px to spare next to a
  // phone-width page. navigate() closes it on every page change, so
  // picking a page is also how you dismiss the menu.
  // ------------------------------------------------------------

  function toggleSidebar() {
    const sidebar = document.getElementById("app-sidebar");

    if (!sidebar) return;

    setSidebarOpen(!sidebar.classList.contains("open"));
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function setSidebarOpen(open) {
    const sidebar = document.getElementById("app-sidebar");
    const backdrop = document.getElementById("sidebar-backdrop");
    const toggleBtn = document.getElementById("sidebar-toggle-btn");
    const scrollHost = document.getElementById("view-app");

    if (sidebar) sidebar.classList.toggle("open", open);
    if (backdrop) backdrop.classList.toggle("open", open);
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", String(open));

    // The sidebar sits over the page rather than pushing it, so the
    // page underneath must stop scrolling while it's open or the
    // menu and the content scroll together.
    if (scrollHost) scrollHost.classList.toggle("scroll-locked", open);
  }

  function navigate(pageId) {
    closeSidebar();

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
      loadOverview(state.overviewPeriod);
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
          console.error("Balance Sheet failed:", error);

          if (page) {
            page.innerHTML = pageLoadErrorHtml(
              "what you own & owe", error, "NFK_App.nav('balance-sheet')"
            );
          }
        });
    }
      if (pageId === "pl") {
        renderProfitAndLoss();
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
            console.error("Cash Flow failed:", error);

            if (page) {
              page.innerHTML = pageLoadErrorHtml(
                "money in & out", error, "NFK_App.nav('cash-flow')"
              );
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
                <h1 class="page-title">Money owed to you <span class="page-title-term">Accounts Receivable</span></h1>
                <p class="page-subtitle">Read live from QuickBooks</p>
              </div>
            </div>

            <div class="section-gap" id="invoice-urgency-body">
              ${renderSkeletonCard(5)}
            </div>

          `;
        
          loadInvoiceUrgency();

        
        }    
        if (pageId === "ap-vendors") {
        
          const page =
            document.getElementById("page-ap-vendors");
        
          if (!page) return;
        
          page.innerHTML = `
            <div class="page-header">
              <div>
                <h1 class="page-title">Bills to pay <span class="page-title-term">Accounts Payable</span></h1>
                <p class="page-subtitle">Read live from QuickBooks</p>
              </div>
            </div>

            <div class="section-gap" id="bills-schedule-body">
              ${renderSkeletonCard(5)}
            </div>

          `;
          loadBillsSchedule();

        
        } 
        if (pageId === "invoices") {

    const page =
        document.getElementById("page-invoices");

    if (!page) return;

    page.innerHTML = `
        <div class="page-header">
            <div>
                <h1 class="page-title">Invoices</h1>
                <p class="page-subtitle">Read live from QuickBooks</p>
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
    
            <div id="invoices-list"><div style="padding:16px 22px;">${skeletonLine("92%")}${skeletonLine("86%")}${skeletonLine("90%")}</div></div>
    
            <div class="invoices-table-footer">
                <div
                    id="invoices-count"
                    class="invoices-count"
                >
                    Loading invoices…
                </div>
            </div>

        </div>
    `;

    loadInvoices()
      .then(data => {
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
                    "0 invoices";
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
                `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`;
        }

    })
        .catch(error => {
            console.error("Invoice loading failed:", error);

            const list = document.getElementById("invoices-list");
            const count = document.getElementById("invoices-count");

            if (count) count.textContent = "";

            if (list) {
                list.innerHTML = `
                    <div class="empty-state">
                        ${escapeHtml(
                          error?.code === "QB_REAUTH_REQUIRED"
                            ? "Reconnect QuickBooks to see your invoices."
                            : "Unable to load your invoices right now."
                        )}
                    </div>
                `;
            }
        });
        } 
        if (pageId === "debt-register") {

          const page =
              document.getElementById("page-debt-register");

          if (!page) return;

          page.innerHTML = `

              <div class="page-header">
                  <div>
                      <h1 class="page-title">Loans &amp; cards <span class="page-title-term">Debt</span></h1>
                      <p class="page-subtitle">Read live from QuickBooks</p>
                  </div>
              </div>

              <div class="debt-summary-grid">

                  <div class="card debt-summary-card">
                      <span>Total owed</span>
                      <strong id="debt-total">—</strong>
                  </div>

                  <div class="card debt-summary-card">
                      <span>Due within a year</span>
                      <strong id="debt-current">—</strong>
                  </div>

                  <div class="card debt-summary-card">
                      <span>Longer-term</span>
                      <strong id="debt-long-term">—</strong>
                  </div>

                  <div class="card debt-summary-card">
                      <span>On cards</span>
                      <strong id="debt-credit-card">—</strong>
                  </div>

              </div>

              <div id="debt-detail-body" class="section-gap">
                  ${renderSkeletonCard(5)}
              </div>
          `;

          loadDebtDetail();
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
        // Every group stays open: the whole map of the portal is in view,
        // and nothing hides behind a click.
        html += `
          <div class="nav-group" id="${group.id}">
            <div class="nav-group-heading">${group.label}</div>
            <div class="nav-group-items">
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

  // Up to two initials from the signed-in person's name, falling back to
  // their email, for the account button in the top bar.
  function userInitials() {
    let name = "";

    try {
      name = JSON.parse(localStorage.getItem("nfk_profile") || "null")?.full_name || "";
    } catch {
      name = "";
    }

    const words = name.trim().split(/\s+/).filter(Boolean);

    if (words.length) {
      return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
    }

    const email = window.NFK_Auth?.getCurrentUser?.()?.email || "";

    return email ? email[0].toUpperCase() : "?";
  }

  // Two letters standing in for a company in the switcher.
  function companyInitials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));
    return (words.slice(0, 2).map(w => w[0]).join("") || "?").toUpperCase();
  }

  // The card at the foot of the sidebar: whether the numbers are live.
  function renderSidebarQB(connected) {
    const el = document.getElementById("sidebar-qb");
    if (!el) return;

    el.hidden = false;
    el.className = `sidebar-qb ${connected ? "is-connected" : "is-disconnected"}`;
    el.innerHTML = connected
      ? `<span class="sidebar-qb-title"><span class="sidebar-qb-dot"></span>QuickBooks connected</span>
         <span class="sidebar-qb-text">Numbers come straight from your books. Nothing here changes them.</span>`
      : `<span class="sidebar-qb-title"><span class="sidebar-qb-dot"></span>QuickBooks not connected</span>
         <button type="button" class="sidebar-qb-action" onclick="NFK_App.connectQuickBooks()">Connect QuickBooks</button>`;
  }

  // knownStatus: a /status answer the caller already has, so the badge
  // doesn't ask QuickBooks again straight after login.
  async function buildTopBar(knownStatus = null) {
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

    // Most people belong to one company, and a switcher offering a
    // single choice is just clutter. It only appears when there is
    // somewhere to switch to.
    const organizations =
      window.NFK_Auth?.getOrganizations?.() || [];

    const canSwitch = organizations.length > 1;

    // Initial top bar
    el.innerHTML = `
      <button
        class="topbar-icon-btn sidebar-toggle-btn"
        id="sidebar-toggle-btn"
        onclick="NFK_App.toggleSidebar()"
        aria-label="Open menu"
        aria-expanded="false"
        aria-controls="app-sidebar"
        title="Menu"
      >
        ${icon_menu()}
      </button>

      <div
        class="client-switcher-wrap"
        style="position:relative;"
      >

        <div
          class="client-switcher${canSwitch ? " can-switch" : ""}"
          id="client-switcher-btn"
          ${canSwitch
            ? `role="button" tabindex="0" aria-haspopup="listbox"
               aria-expanded="false"
               title="Switch company"
               onclick="NFK_App.toggleClientDropdown()"
               onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();NFK_App.toggleClientDropdown();}"`
            : ""}
        >

          <span class="client-chip" id="client-chip" aria-hidden="true">${escapeHtml(companyInitials(companyName))}</span>

          <span id="client-name">
            ${escapeHtml(companyName)}
          </span>

          ${canSwitch
            ? `<span class="client-switcher-caret" aria-hidden="true">▾</span>`
            : ""}

        </div>

        ${canSwitch
          ? `<div class="client-dropdown" id="client-dropdown" role="listbox">
               <div class="client-dropdown-head">
                 Your companies
               </div>
               ${organizations.map(org => `
                 <button
                   class="client-dropdown-item${org.id === organization?.id ? " is-active" : ""}"
                   role="option"
                   aria-selected="${org.id === organization?.id}"
                   onclick="NFK_App.switchClient('${escapeHtml(org.id)}')"
                 >
                   <span class="client-dropdown-label">
                     <span>${escapeHtml(org.name || "Unnamed company")}</span>
                     ${org.id === organization?.id
                       ? `<span class="client-dropdown-sub" id="client-active-qb"></span>`
                       : ""}
                   </span>
                   ${org.id === organization?.id
                     ? `<span class="client-dropdown-tick">✓</span>`
                     : ""}
                 </button>
               `).join("")}
             </div>`
          : ""}

      </div>

      <!-- Asking NFP AI starts from anywhere: the question is carried
           over to the Ask NFP AI page and sent there. -->
      <form class="topbar-ask" role="search" onsubmit="event.preventDefault(); NFK_App.askFromTopbar(this.q.value); this.q.value='';">
        ${icon_ai()}
        <input
          name="q"
          id="topbar-ask-input"
          type="text"
          autocomplete="off"
          placeholder="Ask NFP AI — “How is my cash flow?”"
          aria-label="Ask NFP AI a question"
        >
        <kbd class="topbar-ask-kbd" aria-hidden="true">Ctrl K</kbd>
      </form>

      <div class="topbar-spacer"></div>

      <button
        type="button"
        class="qb-badge"
        id="qb-status-badge"
      >
        <span class="qb-status-dot"></span>
        <span class="qb-badge-label">Checking QuickBooks…</span>
      </button>

      <button
        type="button"
        class="user-avatar"
        onclick="NFK_App.nav('settings')"
        title="Account settings"
        aria-label="Account settings"
      >
        ${escapeHtml(userInitials())}
      </button>
    `;

    let status = knownStatus;

    if (status?.connected === undefined) {
      status = await checkQBConnection();
    } else {
      state.qbCompanyName = status.companyName || null;
    }

    // The badge next to the sidebar shows which company's data is
    // currently loaded — that's the connected QuickBooks company,
    // not this app's own organization name (which never changes
    // when you reconnect to a different QuickBooks company).
    if (status?.connected === true && status?.companyName) {
      const nameEl = document.getElementById("client-name");

      if (nameEl) {
        nameEl.textContent = status.companyName;
      }

      const chipEl = document.getElementById("client-chip");

      if (chipEl) {
        chipEl.textContent = companyInitials(status.companyName);
      }

      // For anyone with more than one company, the button then reads
      // differently from the list below it — the button names the
      // QuickBooks company, the list names the organizations they
      // switch between. Naming the connection on the selected row is
      // what ties the two together.
      const activeQB = document.getElementById("client-active-qb");

      if (activeQB) {
        activeQB.textContent = `QuickBooks: ${status.companyName}`;
      }
    }

    const badge =
      document.getElementById(
        "qb-status-badge"
      );

    renderSidebarQB(status?.connected === true);

    if (!badge) {
      return;
    }

    // A connected badge opens Settings, where the connection details and
    // the reconnect button live; only a broken connection goes straight
    // into the QuickBooks sign-in.
    if (status?.connected === true) {
      badge.className = "qb-badge connected";
      badge.title = "Connected to QuickBooks — connection details";
      badge.setAttribute("aria-label", badge.title);
      badge.onclick = () => navigate("settings");

      badge.innerHTML = `
        <span class="qb-status-dot"></span>
        <span class="qb-badge-label">Synced with QuickBooks</span>
      `;
    } else {
      badge.className = "qb-badge disconnected";
      badge.title = "QuickBooks not connected — connect now";
      badge.setAttribute("aria-label", badge.title);
      badge.onclick = connectQuickBooks;

      badge.innerHTML = `
        <span class="qb-status-dot"></span>
        <span class="qb-badge-label">Not connected</span>
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
        <div class="card-title" style="margin-bottom:16px;">QuickBooks connection</div>
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
              ${(p => p.charAt(0).toUpperCase() + p.slice(1))(
                page.replace("-", " ")
              )}
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

  function toggleClientDropdown() {
    const dd = document.getElementById("client-dropdown");
    const btn = document.getElementById("client-switcher-btn");

    if (!dd) return;

    const open = dd.classList.toggle("open");

    if (btn) btn.setAttribute("aria-expanded", String(open));
  }

  function switchClient(organizationId) {
    // Closing first means the dropdown isn't left hanging open behind
    // the reload if the switch is to the company already selected.
    document.getElementById("client-dropdown")?.classList.remove("open");

    window.NFK_Auth?.setActiveOrganization?.(organizationId);
  }

  function bindGlobalEvents() {
    // Escape closes the off-canvas sidebar, same as clicking the
    // backdrop. 900px matches the .sidebar-toggle-btn media rule —
    // the width below which the sidebar is off-canvas at all.
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;

      const sidebar = document.getElementById("app-sidebar");

      if (sidebar?.classList.contains("open")) closeSidebar();
    });

    // Ctrl/⌘+K jumps to the top bar's Ask NFP AI box from any page.
    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        const box = document.getElementById("topbar-ask-input");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      }
    });

    // Resizing past the breakpoint (rotating a tablet, undocking a
    // window) must not leave the menu stuck open and pinned over a
    // now-wide page.
    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) closeSidebar();
    });

    // Cards that summarise a page open it. One delegated listener
    // rather than an onclick on every card, so cards rendered later
    // work without being wired up individually.
    //
    // A card marks itself with data-goto="<page id>". Anything the
    // reader might click for its own sake — a link, a button, a
    // period toggle, an expandable row — is left alone, or opening
    // one would jump the page out from under them.
    document.addEventListener("click", e => {
      const card = e.target.closest?.("[data-goto]");

      if (!card) return;

      if (e.target.closest("a, button, input, select, textarea, summary, details")) {
        return;
      }

      navigate(card.dataset.goto);
    });

    // The same by keyboard. These are links in behaviour, so Enter
    // opens them; Space too, since they are focusable cards rather
    // than anchors.
    document.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;

      // Sidebar entries are focusable divs acting as buttons, so they need
      // the keys a real button would respond to.
      if (e.target.matches?.('div[role="button"][onclick]')) {
        e.preventDefault();
        e.target.click();
        return;
      }

      const card = e.target.closest?.("[data-goto]");

      if (!card || card !== e.target) return;

      e.preventDefault();
      navigate(card.dataset.goto);
    });

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

  // ============================================================
  // PUBLIC APP
  // ============================================================

  window.NFK_App = {
    nav: navigate,

    toggleSidebar,

    closeSidebar,

    setOverviewChartType,

    dismissOverviewAlert,

    _init: init,

    connectQuickBooks,

    checkQBConnection,

    buildTopBar,
    toggleClientDropdown,
    switchClient,

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

    // The top bar's question box: open Ask NFP AI and send the question
    // there, so the answer lands in the normal chat thread.
    askFromTopbar(question) {
      const q = String(question || "").trim();
      navigate("nonaka-ai");
      if (q) setTimeout(() => sendPageChat(q), 0);
    },

    updateScenarioParam,

    setScenarioMonths,

    applyScenarioPreset,

    switchInsightTab,

    switchForecastView,

    setForecastChartType,



    logout() {
      window.NFK_Auth.logout();
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

  // Line icons for the cash hero, drawn in currentColor.
  const lineIcon = paths =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  function icon_wallet() {
    return lineIcon('<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>');
  }

  function icon_bank() {
    return lineIcon('<path d="M3 21h18"/><path d="M6 17v-6"/><path d="M10 17v-6"/><path d="M14 17v-6"/><path d="M18 17v-6"/><path d="M12 3 20 8H4z"/>');
  }

  function icon_arrow_up_right() {
    return lineIcon('<path d="M7 17 17 7"/><path d="M8 7h9v9"/>');
  }

  function icon_info() {
    return lineIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>');
  }

  function icon_alert() {
    return lineIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>');
  }

  function icon_bulb() {
    return lineIcon('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>');
  }

  function icon_doc() {
    return lineIcon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>');
  }


  function icon_clock() {
    return lineIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
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

  // Shown only below the width where the sidebar goes off-canvas
  // (see the @media rule for .sidebar-toggle-btn) — opens it.
  function icon_menu() {
    return `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2.5 5.5A.75.75 0 013.25 4.75h13.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 5.5zM2.5 10a.75.75 0 01.75-.75h13.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 10zM3.25 14.75a.75.75 0 000 1.5h13.5a.75.75 0 000-1.5H3.25z" clip-rule="evenodd"/></svg>`;
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

  function icon_ops_sm() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z"/><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd"/></svg>`;
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