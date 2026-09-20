# Nonaka Financial Partners — Feature Inventory

A plain-English description of every screen and what it does, for use as a
Stitch design brief alongside DESIGN.md. This is not code — it's what the
app needs to show and let a small-business owner do.

## Who this is for
A small-business owner (bakery, contractor, shop owner, service provider) —
not an accountant. Many are new to running a business and find financial
terminology intimidating. The app connects to their QuickBooks Online
account and turns that data into something they can actually understand
and act on.

## Authentication
- **Sign up**: full name, email, password, organization/business name. Sends
  a confirmation email (link) before the account is usable.
- **Log in**: email + password.
- **Forgot password**: sends a reset email (link) to set a new password.
- **Connect QuickBooks**: after first login, an OAuth flow connects the
  user's real QuickBooks Online company. Shows a step-by-step "connecting"
  animation, then confirms which company got linked (with an option to
  disconnect and reconnect if the wrong one was linked).

## Home / Overview (the main daily screen)
The first thing the user sees after logging in. Currently shows:
- 6 headline number cards: money earned this period, what you kept (net
  income), cash balance, cushion after short-term bills (working capital),
  cash runway (months of cash left at current spending pace), and a
  tax set-aside estimate (with an editable tax rate)
- A 12-month "money in vs. money out" trend chart (bar or line toggle)
- A financial health score (AI-generated, with plain-language reasoning)
- AI-generated alerts/insights specific to this business's data
- A summary of what customers owe you and what bills you owe, plus a
  simple debt breakdown
- A button to scan a receipt (photo → AI reads vendor/amount/date/category)
- A button to open the fuller AI Insights page

## Reports (secondary/detailed section — for people who want full detail)
- **Profit & Loss**: the standard accounting statement
- **Balance Sheet**: the standard accounting statement
- **Cash Flow**: the standard accounting statement
These are kept as real, detailed accounting reports on purpose — this is
where a bookkeeper or a curious owner can see everything in full. They are
NOT the first thing shown; the plain-language Overview is.

## Operations
- **Customers**: what customers owe you (Accounts Receivable), aging
  breakdown, individual customer balances
- **Bills & Vendors**: what you owe suppliers (Accounts Payable), aging
  breakdown, individual vendor balances
- **Invoices**: list of invoices

## Business Performance
- **Business Ratios**: 9 financial ratios (margins, current ratio,
  debt-to-equity, working capital, days to collect/pay) — each with a
  plain-language explanation of what it means, a value, and a trend
- **Debt**: current debt, long-term debt, total debt breakdown

## Financial Intelligence
- **Forecast**: 5 different trend views (money in/out, profit trends, etc.)
  built from 6-12 months of real QuickBooks history, no invented numbers
- **AI Insights**: anomalies (AI-detected unusual patterns) and
  recommendations (AI-suggested actions), each grounded in specific real
  numbers from the business's own data — never generic advice
- **Scenarios**: a "what if" planning tool — sliders for sales growth,
  cost growth, tax rate — shows projected outcomes (profit, margin) over
  a chosen number of months, against the business's real recent history

## NFP AI (chat)
A conversational AI the owner can ask direct questions like "why did my
profit fall?" or "who owes me money?" — answers are grounded in the
business's real current QuickBooks data, plain language, with the specific
numbers behind the answer shown.

## Design philosophy already established (do not undo this)
- **Plain language first, accounting terms second.** Every dashboard-facing
  screen leads with a plain phrase ("Customers owe you," "What you kept")
  and keeps the real accounting term small and secondary, never deleted.
- **Detailed reports stay separate.** Advanced/technical screens are kept
  intact for people who want them, just not the default first experience.
- **Every AI-generated insight is grounded in a real number** from the
  business's actual data — never a generic or invented claim.
