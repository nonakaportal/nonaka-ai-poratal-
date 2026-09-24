// ============================================================
// NONAKA FINANCIAL PARTNERS — SHARED FORMATTERS
// Compact dollar formatting for chart labels and the Overview deltas.
// ============================================================

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
