// ============================================================
// NONAKA FINANCIAL PARTNERS — CHART ENGINE
// Renders QuickBooks-derived financial visualizations
// Uses Chart.js (loaded from CDN)
// ============================================================
(function () {
"use strict";

const CHART_REGISTRY = {};

// ── THEME & COLOR HELPERS ──────────────────────────────────
function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getColors() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    primary:      "#D9954B",   // Warm Amber accent
    secondary:    "#3B2A1A",   // Warm section umber
    success:      isDark ? "#6FA37E" : "#3E7A54",
    danger:       isDark ? "#C4726B" : "#B8564E",
    warning:      isDark ? "#d4a86a" : "#a67535",
    purple:       "#E3AC71",   // Warm accent 400
    teal:         "#8fa8d9",   // Info — unchanged, low-priority per design review
    grid:         isDark ? "rgba(243,236,228,0.07)" : "rgba(46,40,34,0.08)",
    text:         isDark ? "#A89A87" : "#6E6355",
    textPrimary:  isDark ? "#F3ECE4" : "#2E2822",
    bg:           isDark ? "#211D19" : "#ffffff",
    border:       isDark ? "rgba(243,236,228,0.10)" : "rgba(46,40,34,0.12)",
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

  Chart.defaults.font.family = "'Outfit', system-ui, -apple-system, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = colors.text;
  Chart.defaults.animation.duration = 600;
  Chart.defaults.animation.easing = "easeInOutQuart";
}

// ── CASH FLOW WATERFALL ─────────────────────────────────────
function renderCashWaterfall(data = null) {

  const canvas =
    document.getElementById("chart-waterfall");

  if (!canvas) return;

  destroyChart("chart-waterfall");

  const colors = getColors();

  const chartData = data || {
    labels: [
      "Opening Cash",
      "Operating CF",
      "Investing CF",
      "Financing CF",
      "Closing Cash"
    ],

    values: [
      0,
      0,
      0,
      0,
      0
    ]
  };


  const values =
    chartData.values.map(
      value => Number(value || 0)
    );


  const opening =
    values[0];

  const operating =
    values[1];

  const investing =
    values[2];

  const financing =
    values[3];

  const closing =
    values[4];


  /*
   * Build real waterfall positions.
   *
   * Opening:
   * starts from zero.
   *
   * Operating / Investing / Financing:
   * start from the previous running balance.
   *
   * Closing:
   * starts from zero.
   */
const starts = [
    0,
    0,
    0,
    0,
    0
];


  const barValues = [
    opening,
    operating,
    investing,
    financing,
    closing
];


  // Scale the Y-axis to the data instead of a fixed/auto range, with
  // headroom reserved for the value labels the cashFlowLabelsPlugin
  // draws above/below each bar — otherwise a bar near the axis max
  // gets its label clipped by the canvas edge (small values get a
  // tight range, large values get a proportionally wider one).
  const positiveMax = Math.max(0, ...barValues);
  const negativeMin = Math.min(0, ...barValues);
  const valueRange = (positiveMax - negativeMin) || 1;
  const axisPadding = valueRange * 0.2;

  const yAxisMax = positiveMax + axisPadding;
  const yAxisMin = negativeMin < 0 ? negativeMin - axisPadding : 0;


  const barColors = [
    colors.primary,

    operating >= 0
      ? colors.success
      : colors.danger,

    investing >= 0
      ? colors.success
      : colors.danger,

    financing >= 0
      ? colors.success
      : colors.danger,

    colors.primary
  ];
const cashFlowLabelsPlugin = {
    id: "cashFlowLabels",

    afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        const meta = chart.getDatasetMeta(1);

        ctx.save();

        meta.data.forEach((bar, index) => {
            const value = barValues[index];

            if (!Number.isFinite(value)) return;

            ctx.font = "700 14px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = value < 0 ? "#e08a8f" : "#e9e9ed";

            const y = value < 0
                ? bar.y + 8
                : bar.y - 14;

            ctx.fillText(
                fmt(value),
                bar.x,
                y
            );
        });

        ctx.restore();
    }
};

  registerChart(
    "chart-waterfall",

    new Chart(
      canvas.getContext("2d"),
      {
        type: "bar",
        plugins: [
            cashFlowLabelsPlugin
        ],

        data: {

          labels:
            chartData.labels,

          datasets: [

            {
              label: "Position",

              data: starts,

              backgroundColor:
                "transparent",

              borderWidth: 0,

              stack: "waterfall",

              barPercentage: 0.85,

              categoryPercentage: 0.8
            },

            {
              label: "Cash Flow",

              data: barValues,

              backgroundColor:
                barColors.map(
                  color => color + "DD"
                ),

              borderColor:
                barColors,

              borderWidth: 1,

              borderRadius: 6,

              stack: "waterfall",

              barPercentage: 0.85,

              categoryPercentage: 0.8
            }

          ]

        },


        options: {

          responsive: true,

          maintainAspectRatio: false,


          plugins: {

            legend: {
              display: false
            },


            tooltip: {

              backgroundColor:
                colors.bg,

              titleColor:
                colors.textPrimary,

              bodyColor:
                colors.textPrimary,

              borderColor:
                colors.border,

              borderWidth: 1,

              padding: 12,


              callbacks: {

                label: function(ctx) {

                  if (
                    ctx.datasetIndex === 0
                  ) {
                    return null;
                  }

                  return (
                    " " +
                    ctx.label +
                    ": " +
                    fmt(
                      values[
                        ctx.dataIndex
                      ]
                    )
                  );

                }

              }

            }

          },


          scales: {

            x: {

              stacked: true,

              grid: {
                color:
                  colors.grid
              },

              ticks: {
                color:
                  colors.text
              }

            },


            y: {

              stacked: true,
              beginAtZero: true,
              suggestedMax: yAxisMax,
              suggestedMin: yAxisMin,

            grid: {
              color: ctx =>
                  Number(ctx.tick.value) === 0
                      ? "rgba(233,233,237,0.55)"
                      : colors.grid,

              lineWidth: ctx =>
                  Number(ctx.tick.value) === 0
                      ? 2
                      : 1
          },

              ticks: {

                color:
                  colors.text,

                callback:
                  value =>
                    fmtShort(value)

              }

            }

          }

        }

      }

    )

  );

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

// ── AI FORECAST (AI Insights) ──────────────────────────────
// trend: real monthly actuals from financial-context.service.js
// [{label, revenue, netIncome, ...}]
// projection: Claude's projection [{label, projectedRevenue, projectedNetIncome}]
function renderForecastChart(canvasId, trend = [], projection = []) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  destroyChart(canvasId);

  const colors = getColors();

  const historyLabels = trend.map(t => t.label);
  const projectionLabels = projection.map(p => p.label);
  const labels = [...historyLabels, ...projectionLabels];

  // Actual series: real values for history, null past that point.
  const actualRevenue = [
    ...trend.map(t => t.revenue),
    ...projection.map(() => null)
  ];
  const actualNet = [
    ...trend.map(t => t.netIncome),
    ...projection.map(() => null)
  ];

  // Projected series: null everywhere except the bridge point (the
  // last real month, so the dashed line visually connects to the
  // solid one instead of floating) and each real projected month.
  const projRevenue = new Array(labels.length).fill(null);
  const projNet = new Array(labels.length).fill(null);

  if (trend.length > 0) {
    projRevenue[trend.length - 1] = trend[trend.length - 1].revenue;
    projNet[trend.length - 1] = trend[trend.length - 1].netIncome;
  }

  projection.forEach((p, i) => {
    projRevenue[trend.length + i] = p.projectedRevenue;
    projNet[trend.length + i] = p.projectedNetIncome;
  });

  registerChart(canvasId, new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Revenue (actual)",
          data: actualRevenue,
          borderColor: colors.primary,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: colors.primary,
          spanGaps: false,
        },
        {
          label: "Net Income (actual)",
          data: actualNet,
          borderColor: colors.success,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: colors.success,
          spanGaps: false,
        },
        {
          label: "Revenue (projected)",
          data: projRevenue,
          borderColor: colors.primary,
          backgroundColor: "transparent",
          borderWidth: 2,
          borderDash: [5, 5],
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: colors.primary,
          spanGaps: true,
        },
        {
          label: "Net Income (projected)",
          data: projNet,
          borderColor: colors.success,
          backgroundColor: "transparent",
          borderWidth: 2,
          borderDash: [5, 5],
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: colors.success,
          spanGaps: true,
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
          labels: { boxWidth: 10, boxHeight: 10, color: colors.text, padding: 12, font: { size: 11 } }
        },
        tooltip: {
          backgroundColor: colors.bg,
          titleColor: colors.textPrimary,
          bodyColor: colors.textPrimary,
          borderColor: colors.border,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: ctx => ctx.raw === null ? undefined : ` ${ctx.dataset.label}: ${fmtShort(ctx.raw)}`
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
          labels: { boxWidth: 10, boxHeight: 10, color: colors.text, padding: 12, font: { size: 11 } }
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
          label: "Actual Revenue",
          data: revenue,
          borderColor: colors.primary,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: colors.primary
        },
        {
          label: "Actual Gross Profit",
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
          label: "Actual Net Income",
          data: net,
          borderColor: colors.success,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: colors.success
        },
        {
          label: "Projected Revenue",
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
          label: "Projected Gross",
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
          label: "Projected Net",
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

// ── REDRAW ALL (theme change) ──────────────────────────────
// Every real chart on this page reads its colors fresh from getColors()
// each time it's rendered, so the fix for "chart colors don't match the
// new theme" is just re-rendering whatever chart(s) the active page
// owns. Each page's own load function (loadKPITrends, renderForecastPage,
// updateScenarioChart, etc.) already knows its own data and calls the
// matching render*() function directly — this only needs to ask app.js
// to replay that for the page the user is currently on.
function redrawAll() {
  if (window.NFK_App?.redrawCurrentPageCharts) {
    window.NFK_App.redrawCurrentPageCharts();
  }
}

// ── PUBLIC API ──────────────────────────────────────────────
window.NFK_Charts = {
  redrawAll,
  renderCashWaterfall,
  renderKPISparklines,
  renderKPIDetailChart,
  renderForecastChart,
  renderForecastTrend,
  renderPLWithProjection,
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
