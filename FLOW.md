# Nonaka Financial Partners — Detailed App Flow

A complete, screen-by-screen walkthrough of the app as it actually works
today, from the very first visit to every page a logged-in user can reach.
Companion to `FEATURES.md` (what exists) and `DESIGN.md` (how it should
look) — this document is about the *sequence* and *behavior*.

---

## 1. First visit — Login screen

A brand-new or returning visitor lands on a split screen:
- **Left panel**: brand message ("Your financial data, intelligently
  analyzed"), logo, three feature bullets.
- **Right panel**: the login card — email, password, "Remember me,"
  "Forgot password?" link, "Sign in" button, and a "Sign up" link at
  the bottom.

If a valid session already exists in the browser (from a previous visit),
the app skips this screen entirely and jumps to step 4.

---

## 2. Sign up

1. User clicks "Sign up" — the card swaps in place to a signup form:
   full name, email, password, confirm password, organization/business
   name, "Create account" button.
2. On submit, the backend:
   - Creates a real Supabase Auth user (this actually sends a
     confirmation email with a clickable link — not a bypass).
   - Creates a `profiles` row (name) and a brand-new `organizations` row
     (this business), and links the two via `user_organization`.
3. The user sees "Account created! Check your email for a confirmation
   link before logging in."
4. **The account cannot log in yet.** Supabase blocks `signInWithPassword`
   until the email is confirmed — this is enforced server-side, not just
   a UI suggestion.
5. User opens their email, clicks the confirmation link → Supabase marks
   the account confirmed → redirected back to the app.
6. User can now log in for the first time.

### If the email is already registered
The signup attempt is rejected with a clean "An account with this email
already exists. Please log in instead." — whether the existing account
is confirmed or not, and without ever leaking a raw database error to
the screen.

---

## 3. Log in

1. User enters email + password, clicks "Sign in."
2. Backend verifies the password against Supabase. Both "wrong password"
   and "no such account" return the identical generic error — no way to
   tell which is true, so the login form can't be used to probe which
   emails have accounts.
3. On success, the backend returns the user, their profile, their
   organization, and a session (access + refresh token) — all saved to
   `localStorage`.
4. The app now checks: **is a QuickBooks company already connected to
   this organization?**
   - **No** → route to step 4 (Connect QuickBooks).
   - **Yes** → route straight to step 7 (Overview / main app).

### Forgot password (branches off the login screen)
1. "Forgot password?" opens a small modal: enter your email, "Send Reset
   Link."
2. A real password-reset email is sent (if the account exists — the
   response is identical either way, same anti-enumeration principle as
   login).
3. Clicking the emailed link opens a dedicated `reset-password.html`
   page: new password, confirm password, "Reset Password."
4. On success: "Password updated. You can log in now." → back to the
   login screen.
5. An expired or reused link shows "This reset link is invalid or has
   expired" instead of a broken form.

---

## 4. Connect QuickBooks

1. A 3-step progress indicator: Sign In (done) → Connect Data (active) →
   done.
2. "Connect to QuickBooks Online" button. Clicking it:
   - Backend generates a signed, time-limited (10-minute) authorization
     URL tied to this specific organization.
   - Browser is sent to Intuit's real login/authorize screen.
3. **Important real-world behavior**: if the browser already has an
   active Intuit session (from earlier use), Intuit may skip its own
   login prompt and use whatever account is already signed in there —
   this is standard OAuth/SSO behavior, not something the app controls.
4. User authorizes → Intuit redirects back to the app's callback URL
   with an authorization code.
5. Backend exchanges the code for real access/refresh tokens, saves them
   scoped to this organization, and redirects the browser back into the
   app with `?connected=true`.
6. The app plays a short "connecting" animation (Opening OAuth window →
   Authenticating → Fetching company list → Pulling Chart of Accounts →
   Importing statements → Calculating metrics → Connection complete).
7. **Success screen** shows the actual connected company's name and a
   "Not your company? Disconnect and try again" link — this exists
   specifically because step 3's auto-login behavior can silently
   connect the wrong company; this is the safety net for that.
8. "Enter Portal →" → step 7 (Overview).

### Disconnecting later
From Settings or the success screen, "Disconnect" removes the saved
QuickBooks connection entirely, dropping the user back to this screen so
they can reconnect (ideally after signing out of Intuit in the browser
first, if the wrong company was the problem).

---

## 5. The main app shell (everything from here on shares this frame)

- **Sidebar** (left): grouped navigation — Overview; Reports; Customers
  & Bills; Insights; Ask NFP AI; Workspace (Settings, Log out).
- **Topbar**: organization name/switcher, "Ask NFP AI" quick-access
  button, a QuickBooks connection status badge (Connected / Needs
  reauth / Disconnected), theme toggle, user avatar/menu.
- Clicking any sidebar item swaps the visible page inside this shell —
  no full page reload.

---

## 6. Overview — the daily screen

This is where every login lands once QuickBooks is connected.

1. **Header**: "Financial Overview," organization name, last-synced
   timestamp, a Today/Week/Month period selector, an "AI Insights"
   shortcut button.
2. **Six headline cards**, all pulling from the same QuickBooks fetch:
   - Money earned this period (Revenue)
   - What you kept (Net Income)
   - Cash Balance
   - Cushion after short-term bills (Working Capital)
   - **Cash Runway** — months of cash left at the recent spending pace,
     or "Growing" if income exceeds spending. Computed entirely in the
     browser from data already fetched — no extra API call.
   - **Tax Set-Aside** — a suggested amount to set aside for taxes,
     based on this period's profit × an editable rate (stored per
     browser, not shared organization data).
3. **12-month "Money In vs. Money Out" chart** (bar/line toggle).
4. **Financial health score** — AI-generated 0-100 score with a
   plain-language explanation of what drove it, cached 5 minutes.
5. **AI Alerts & Insights feed** — anomalies and recommendations
   generated from this organization's real data, each grounded in a
   specific number, never generic advice.
6. **Customers owe you / Bills you need to pay** summary, plus a debt
   breakdown (current / long-term / total).

Every one of these numbers is fetched live from QuickBooks on page load
— nothing is pre-stored; a fresh fetch happens every visit.

---

## 7. Reports (Profit & Loss, Balance Sheet, Cash Flow)

Reached via the sidebar's "Reports" group — a deliberately separate
section for the standard, detailed accounting statements. Each has its
own period selector and shows the full account-level breakdown, not a
summary. These are the same reports an accountant or bookkeeper would
expect, kept intact rather than simplified — the Overview page is what
changed, not these.

---

## 8. Customers & Bills

- **Customers**: total owed to the business, aging buckets, per-customer
  balances — what QuickBooks calls Accounts Receivable.
- **Bills & Vendors**: total owed to suppliers, aging buckets,
  per-vendor balances — Accounts Payable.
- **Invoices**: the invoice list.

---

## 9. Insights

- **Forecast**: five different trend views (money in/out, profit,
  gross-profit breakdown, cash from operations) built from 6-12 months
  of real history — never an invented projection.
- **AI Insights**: the fuller anomalies + recommendations view (same
  engine as the Overview alerts feed, more detail).
- **Scenarios**: a what-if planning tool — sliders for sales growth,
  direct-cost growth, running-cost growth, tax rate — shows projected
  profit/margin outcomes against the business's real recent numbers.
- **Business Ratios**: nine financial ratios (margins, current ratio,
  debt-to-equity, days to collect/pay, etc.), each with a plain-language
  explanation and a trend.
- **Debt**: current/long-term/total debt in one place.

---

## 10. Ask NFP AI

A standing chat interface, reachable from the sidebar or the topbar
shortcut. The user types a question in plain language ("Why did my
profit fall?" / "Who owes me money?"); the AI answers using that
organization's real, current QuickBooks-derived data — never a generic
or invented answer — and shows the specific numbers behind the answer.

---

## 11. Settings

Account-level details: profile info, connected organization, QuickBooks
connection status with a disconnect option, theme preference.

---

## 12. Log out

Clears every piece of session data from the browser (`nfk_user`,
`nfk_profile`, `nfk_organization`, `nfk_user_organization`, `nfk_session`,
`nfk-organization-id`) and replaces the current page in browser history
with the login screen — so the back button can't return to an
authenticated page after logging out.

---

## Cross-cutting behaviors that apply everywhere

- **Every request that touches an organization's data is checked
  server-side**: the caller's session must be valid, and that specific
  user must actually belong to that specific organization — tested live
  with multiple real accounts, cross-org access is always rejected.
- **A session that expires mid-use** triggers one silent refresh attempt
  before asking the user to log in again — the user never sees a raw
  auth error while the app can still recover on its own.
- **Rate limiting** applies to every auth-related endpoint (signup,
  login, password reset) — bounded at 20 requests per 15 minutes per
  visitor.
- **AI features degrade gracefully**: a missing/expired Claude API key
  or an out-of-credits account shows a clear "AI needs to be configured"
  message rather than a broken page.
