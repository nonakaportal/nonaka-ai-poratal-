// ============================================================
// NONAKA FINANCIAL PARTNERS — FRONTEND STATE & FORMATTERS
// Financial data is NO LONGER hardcoded here. It is fetched via api.js
// ============================================================
const NFK_DATA = {
  // Only keep UI/Session state and basic company info here.
  company: {
    name: "Loading...",
    legalName: "",
    address: { line1: "", city: "", state: "", postalCode: "" },
    country: "",
    qb_status: "disconnected", // connected | disconnected | needs_reauth
    qb_last_sync: null,
    quickbooksRealmId: null,
    clients: [] 
  },
  ui: {
    theme: localStorage.getItem("nfk-theme") || "light",
    currentPage: "overview"
  }
};

// ─ FORMATTERS (Keep these, they are needed for UI rendering) ──
function fmt(amount, opts = {}) {
  if (amount === null || amount === undefined) return "N/A";
  const abs = Math.abs(amount);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const sym = opts.noSym ? "" : "$";
  return amount < 0 ? `-${sym}${s}` : `${sym}${s}`;
}

function fmtShort(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs/1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs/1_000).toFixed(0)}K`;
  return `${sign}$${abs}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function changeArrow(pct) {
  if (pct > 0) return `<span class="pos">▲ ${Math.abs(pct).toFixed(1)}%</span>`;
  if (pct < 0) return `<span class="neg">▼ ${Math.abs(pct).toFixed(1)}%</span>`;
  return `<span class="neu">— 0%</span>`;
}

function statusBadge(status) {
  const map = {
    overdue: ["badge-overdue", "Overdue"],
    current: ["badge-current", "Current"],
    paid: ["badge-paid", "Paid"],
    partial: ["badge-partial", "Partial"],
    connected: ["badge-paid", "Connected"],
    disconnected: ["badge-overdue", "Disconnected"],
    needs_reauth: ["badge-watch", "Needs Reauth"],
  };
  const [cls, label] = map[status] || ["badge-na", status];
  return `<span class="badge ${cls}">${label}</span>`;
}