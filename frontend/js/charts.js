// ============================================================
// NONAKA FINANCIAL PARTNERS — CHART ENGINE
// Renders QuickBooks-derived financial visualizations
// Uses Chart.js (loaded from CDN)
// ============================================================
(function () {
"use strict";

const CHART_REGISTRY = {};

// ── THEME & COLOR HELPERS ──────────────────────────────────
function getColors() {
  // Dark only — mirrors tokens.css, which no longer has a light theme.
  return {
    primary:      "#BEC2FF",   // Periwinkle accent
    secondary:    "#33375E",   // Accent 900
    success:      "#6BBF93",
    danger:       "#EF8F86",
    warning:      "#FFB689",
    purple:       "#C9CCFF",   // Accent 400
    teal:         "#50D8E9",   // Cyan — data emphasis
    grid:         "rgba(228,225,230,0.07)",
    text:         "#8F8FA1",
    textPrimary:  "#E4E1E6",
    bg:           "#1C1C1E",
    border:       "rgba(228,225,230,0.10)",
  };
}

// ── CHART REGISTRY MANAGEMENT ──────────────────────────────
function destroyChart(id) {
  if (CHART_REGISTRY[id]) {
    try { CHART_REGISTRY[id].destroy(); } catch(e) {}
    delete CHART_REGISTRY[id];
  }
}

function registerChart(id, chart) {
  destroyChart(id);
  CHART_REGISTRY[id] = chart;
  return chart;
}

// — GLOBAL CHART DEFAULTS ──────────────────────────────────
function applyDefaults() {
  if (!window.Chart) return;

  const colors = getColors();

  Chart.defaults.font.family = "'Geist', system-ui, -apple-system, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = colors.text;
  // Charts draw in with the same long, soft ease-out as the page
  // entrance, and not at all for reduced-motion users.
  Chart.defaults.animation.duration =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 900;
  Chart.defaults.animation.easing = "easeOutQuart";
}

// ── KPI SPARKLINES ─────────────────────────────────────────
function renderKPISparklines(kpis = []) {
  if (!kpis || kpis.length === 0) return;

  const colors = getColors();

  kpis.forEach(kpi => {
    const canvas = document.getElementById(`spark-${kpi.id}`);
    if (!canvas || !kpi.trend || kpi.trend.length === 0) return;

    destroyChart(`spark-${kpi.id}`);

    const last = kpi.trend[kpi.trend.length - 1];
    const first = kpi.trend[0];
    const color = last >= first ? colors.success : colors.danger;

    const grad = canvas.getContext("2d").createLinearGradient(0, 0, 0, 36);
    grad.addColorStop(0, color + "40");
    grad.addColorStop(1, color + "00");

    registerChart(`spark-${kpi.id}`, new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: kpi.trend.map((_, i) => i),
        datasets: [{
          data: kpi.trend,
          borderColor: color,
          backgroundColor: grad,
          borderWidth: 1.8,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
        }]
      },
      options: {
        responsive: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: {
          x: { display: false },
          y: { display: false }
        }
      }
    }));
  });
}

// ── KPI DETAIL TREND (modal) ───────────────────────────────
function renderKPIDetailChart(canvasId, labels = [], values = []) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  destroyChart(canvasId);

  const colors = getColors();

  const known = values.filter(v => v !== null && Number.isFinite(v));
  if (known.length < 2) return;

  const first = known[0];
  const last = known[known.length - 1];
  const color = last >= first ? colors.success : colors.danger;

  const grad = canvas.getContext("2d").createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, color + "33");
  grad.addColorStop(1, color + "00");

  registerChart(canvasId, new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: grad,
        borderWidth: 2.5,
        fill: true,
        tension: 0.35,
        spanGaps: true,
        pointRadius: 3,
        pointBackgroundColor: color,
        pointHoverRadius: 5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.bg,
          titleColor: colors.textPrimary,
          bodyColor: colors.textPrimary,
          borderColor: colors.border,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: ctx => ctx.raw === null ? "No data" : ` ${fmtShort(ctx.raw)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: colors.grid },
          ticks: { color: colors.text }
        },
        y: {
          grid: { color: colors.grid },
          ticks: { color: colors.text, callback: v => fmtShort(v) }
        }
      }
    }
  }));
}

// ── FORECAST PAGE — multi-metric trend, line or bar ────────
// history: real per-month data [{label, revenue, totalExpenses, ...}]
// view: { title, metrics: [{key, label, color}] } from FORECAST_VIEWS
function renderForecastTrend(canvasId, history = [], view, chartType = "line") {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !view) return;

  destroyChart(canvasId);

  const colors = getColors();
  const ctx = canvas.getContext("2d");
  const labels = history.map(h => h.label);
  const isBar = chartType === "bar";

  const datasets = view.metrics.map(m => {
    const color = colors[m.color] || colors.primary;
    const data = history.map(h => (Number.isFinite(h[m.key]) ? h[m.key] : null));

    if (isBar) {
      return {
        label: m.label,
        data,
        backgroundColor: color + "CC",
        borderRadius: 6,
        borderWidth: 0
      };
    }

    const grad = ctx.createLinearGradient(0, 0, 0, 300);
    grad.addColorStop(0, color + "33");
    grad.addColorStop(1, color + "02");

    return {
      label: m.label,
      data,
      borderColor: color,
      backgroundColor: grad,
      borderWidth: 2.5,
      tension: 0.35,
      fill: view.metrics.length === 1,
      pointRadius: 3,
      pointBackgroundColor: color,
      spanGaps: true
    };
  });

  registerChart(canvasId, new Chart(ctx, {
    type: isBar ? "bar" : "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          position: "top",
          labels: { boxWidth: 10, boxHeight: 10, color: colors.text, padding: 12, font: { size: 12 } }
        },
        tooltip: {
          backgroundColor: colors.bg,
          titleColor: colors.textPrimary,
          bodyColor: colors.textPrimary,
          borderColor: colors.border,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: ctx2 => (ctx2.raw === null || ctx2.raw === undefined) ? undefined : ` ${ctx2.dataset.label}: ${fmtShort(ctx2.raw)}`
          }
        }
      },
      scales: {
        x: { grid: { color: colors.grid }, ticks: { color: colors.text } },
        y: { grid: { color: colors.grid }, ticks: { color: colors.text, callback: v => fmtShort(v) } }
      }
    }
  }));
}

// ── P&L WITH PROJECTION SCENARIO ──────────────────────────
// Derives this company's real average COGS/Revenue and Opex/Revenue
// ratios from its actual historical months, instead of assuming a
// generic 40%/45% split that has nothing to do with the real business.
// Falls back to that generic split only when there's no usable history.
function computeBaselineRatios(actual) {
  let revSum = 0;
  let cogsSum = 0;
  let opexSum = 0;

  const months = actual?.revenue?.length || 0;

  for (let i = 0; i < months; i++) {
    const rev = Number(actual.revenue[i]);
    const gross = Number(actual.gross[i]);
    const net = Number(actual.net[i]);

    if (!Number.isFinite(rev) || rev <= 0) continue;
    if (!Number.isFinite(gross) || !Number.isFinite(net)) continue;

    revSum += rev;
    cogsSum += rev - gross;   // COGS = Revenue − Gross Profit
    opexSum += gross - net;   // Approximates Opex + tax = Gross − Net
  }

  if (revSum <= 0) {
    return { cogsRatio: 0.4, opexRatio: 0.45 };
  }

  return {
    cogsRatio: cogsSum / revSum,
    opexRatio: opexSum / revSum
  };
}

// Runs the actual month-by-month projection math. Shared by the chart
// renderer and anything (e.g. a summary panel) that needs the same
// numbers without re-drawing the chart.
function computeScenarioProjection(scenario = null, actualData = null) {
  const sc = scenario || {
    revGrowth: 10,
    cogsGrowth: 5,
    opexGrowth: 5,
    taxRate: 21,
    months: 6
  };

  const actual = actualData || {
    labels: ["Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"],
    revenue: [340000, 370000, 390000, 520000, 310000, 340000, 380000, 420000, 430000, 460000, 490000, 370000],
    gross: [140000, 155000, 165000, 210000, 125000, 140000, 155000, 170000, 175000, 185000, 198000, 150000],
    net: [50000, 60000, 70000, 120000, 40000, 45000, 60000, 65000, 70000, 80000, 90000, 60000]
  };

  const { cogsRatio, opexRatio } = computeBaselineRatios(actual);

  const numProjMonths = sc.months || 6;
  const labels = [...actual.labels];
  const revenue = [...actual.revenue];
  const gross = [...actual.gross];
  const net = [...actual.net];

  const projRev = new Array(actual.labels.length).fill(null);
  const projGross = new Array(actual.labels.length).fill(null);
  const projNet = new Array(actual.labels.length).fill(null);

  // Anchor growth on a trailing average, not the single most recent month.
  // The most recent month is often a partial, in-progress period (today's
  // date falls mid-month), and small-business revenue is naturally lumpy
  // — compounding growth off one unrepresentative month (near-$0 partial
  // month, or a one-off spike month) produces a wildly misleading dollar
  // projection even though the growth-rate math itself is correct.
  const anchorWindow = Math.min(3, revenue.length);
  const trailingAvg = arr =>
    arr.slice(-anchorWindow).reduce((sum, v) => sum + (Number(v) || 0), 0) / anchorWindow;

  const lastRev = trailingAvg(revenue);
  const lastGross = trailingAvg(gross);
  const lastNet = trailingAvg(net);

  projRev[revenue.length - 1] = lastRev;
  projGross[gross.length - 1] = lastGross;
  projNet[net.length - 1] = lastNet;

  let currRev = lastRev;
  let currGross = lastGross;
  let currNet = lastNet;

  const revMonthlyMult = 1 + (sc.revGrowth / 100 / 12);
  const opexMonthlyMult = 1 + (sc.opexGrowth / 100 / 12);

  for (let i = 1; i <= numProjMonths; i++) {
    labels.push(`M+${i}`);
    revenue.push(null);
    gross.push(null);
    net.push(null);

    currRev = Math.round(currRev * revMonthlyMult);
    const currCogs = Math.round((currRev * cogsRatio) * (1 + sc.cogsGrowth / 100 / 12));
    currGross = currRev - currCogs;
    const currOpex = Math.round((currRev * opexRatio) * opexMonthlyMult);
    const currEbit = currGross - currOpex;
    const currTax = currEbit > 0 ? Math.round(currEbit * (sc.taxRate / 100)) : 0;
    currNet = currEbit - currTax;

    projRev.push(currRev);
    projGross.push(currGross);
    projNet.push(currNet);
  }

  return {
    labels,
    revenue,
    gross,
    net,
    projRev,
    projGross,
    projNet,
    baselineRatios: { cogsRatio, opexRatio },
    baselineAnchor: { revenue: lastRev, grossProfit: lastGross, netIncome: lastNet },
    endOfHorizon: {
      revenue: currRev,
      grossProfit: currGross,
      netIncome: currNet
    }
  };
}

function renderPLWithProjection(scenario = null, actualData = null) {
  const canvas = document.getElementById("chart-pl-trend");
  if (!canvas) return;

  destroyChart("chart-pl-trend");

  const colors = getColors();
  const ctx = canvas.getContext("2d");

  const {
    labels,
    revenue,
    gross,
    net,
    projRev,
    projGross,
    projNet
  } = computeScenarioProjection(scenario, actualData);

  const gradProjNet = ctx.createLinearGradient(0, 0, 0, 200);
  gradProjNet.addColorStop(0, "rgba(145,132,217,0.22)");
  gradProjNet.addColorStop(1, "rgba(145,132,217,0.01)");

  registerChart("chart-pl-trend", new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Actual revenue",
          data: revenue,
          borderColor: colors.primary,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: colors.primary
        },
        {
          label: "Actual gross profit",
          data: gross,
          borderColor: colors.purple,
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.4,
          borderDash: [4, 3],
          pointRadius: 3,
          pointBackgroundColor: colors.purple
        },
        {
          label: "Actual net income",
          data: net,
          borderColor: colors.success,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: colors.success
        },
        {
          label: "Projected revenue",
          data: projRev,
          borderColor: colors.primary,
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.4,
          borderDash: [5, 5],
          pointRadius: 4,
          pointBackgroundColor: colors.primary
        },
        {
          label: "Projected gross profit",
          data: projGross,
          borderColor: colors.purple,
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.4,
          borderDash: [5, 5],
          pointRadius: 4,
          pointBackgroundColor: colors.purple
        },
        {
          label: "Projected net income",
          data: projNet,
          borderColor: colors.success,
          backgroundColor: gradProjNet,
          borderWidth: 2.5,
          tension: 0.4,
          borderDash: [5, 5],
          fill: true,
          pointRadius: 4,
          pointBackgroundColor: colors.success
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { boxWidth: 10, boxHeight: 10, color: colors.text, padding: 12 }
        },
        tooltip: {
          backgroundColor: colors.bg,
          titleColor: colors.textPrimary,
          bodyColor: colors.textPrimary,
          borderColor: colors.border,
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: ctx => ctx.raw !== null ? ` ${ctx.dataset.label}: ${fmtShort(ctx.raw)}` : null
          }
        }
      },
      scales: {
        x: {
          grid: { color: colors.grid },
          ticks: { color: colors.text }
        },
        y: {
          grid: { color: colors.grid },
          ticks: {
            color: colors.text,
            callback: v => fmtShort(v)
          }
        }
      }
    }
  }));
}

// ── PUBLIC API ──────────────────────────────────────────────
// The projected bank balance day by day, with the owner's safe floor
// drawn across it. The floor is the whole point of the chart — a
// balance of "fine on average" still hurts if it dips under payroll
// mid-month — so it's a dataset rather than decoration, and the days
// that fall below it are marked.
function renderCashProjection(canvasId, projection) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !projection?.timeline?.length) return;

  destroyChart(canvasId);

  const colors = getColors();
  const timeline = projection.timeline;
  const floor = Number.isFinite(projection.safeFloor) ? projection.safeFloor : null;

  const labels = timeline.map(d => {
    const [, m, day] = d.date.split("-");
    return `${day}/${m}`;
  });

  const datasets = [
    {
      label: "Projected cash",
      data: timeline.map(d => d.balance),
      borderColor: colors.teal,
      backgroundColor: "rgba(80,216,233,0.12)",
      borderWidth: 2.5,
      pointRadius: timeline.map(d => (d.moneyIn || d.moneyOut ? 3.5 : 0)),
      pointBackgroundColor: colors.teal,
      pointHoverRadius: 5,
      fill: true,
      tension: 0.25
    }
  ];

  if (floor !== null) {
    datasets.push({
      label: "Safe floor",
      data: timeline.map(() => floor),
      borderColor: colors.danger,
      borderWidth: 1.5,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
      tension: 0
    });
  }

  return registerChart(
    canvasId,
    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: colors.text, usePointStyle: true, boxWidth: 8, font: { size: 12 } }
          },
          tooltip: {
            backgroundColor: colors.bg,
            borderColor: colors.border,
            borderWidth: 1,
            titleColor: colors.textPrimary,
            bodyColor: colors.text,
            callbacks: {
              // The balance alone doesn't explain itself; what moved
              // that day is the part the owner can act on.
              afterBody(items) {
                const day = timeline[items[0].dataIndex];
                if (!day?.items?.length) return "";

                return day.items
                  .slice(0, 4)
                  .map(m =>
                    `${m.kind === "in" ? "+" : "-"}${Math.round(m.amount)} ${m.party}`
                  );
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: colors.text,
              font: { size: 12 },
              maxTicksLimit: 10,
              autoSkip: true
            }
          },
          y: {
            grid: { color: colors.grid },
            ticks: {
              color: colors.text,
              font: { size: 12 },
              callback: v =>
                Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v
            }
          }
        }
      }
    })
  );
}

window.NFK_Charts = {
  renderKPISparklines,
  renderKPIDetailChart,
  renderForecastTrend,
  renderPLWithProjection,
  renderCashProjection,
  computeScenarioProjection,
};

// ── INITIALIZATION ──────────────────────────────────────────
function waitForChart() {
  if (window.Chart) {
    applyDefaults();
  } else {
    setTimeout(waitForChart, 100);
  }
}

waitForChart();

})();
