# Backend API

Express server in `backend/server.js`. It serves the frontend from `frontend/`
(`/` is the intro page, `/index.html` the portal) and the JSON API under `/api`.

## Authentication

Everything except the `/api/auth/*` routes and the QuickBooks OAuth callback
needs `Authorization: Bearer <Supabase access token>` and an `organizationId`
(query string, or JSON body for `POST`). `requireOrgAccess` checks both: the
token must be valid and its user must belong to that organization.
Successful checks are remembered for 30 seconds (never past the token's own
expiry) so a page that fires many requests at once doesn't pay two Supabase
round trips per request.

| Status | `code`            | Meaning                                   |
|--------|-------------------|-------------------------------------------|
| 401    | `AUTH_REQUIRED`   | No token sent                             |
| 401    | `AUTH_INVALID`    | Token invalid or expired — refresh it     |
| 403    | `ORG_FORBIDDEN`   | User is not in that organization          |

## `/api/auth`

| Route                    | Purpose                                              |
|--------------------------|------------------------------------------------------|
| `POST /signup`           | Create user, profile, organization; sends confirmation email |
| `POST /login`            | Returns session, profile and every organization the user belongs to |
| `POST /refresh`          | Exchange a refresh token for a new session           |
| `POST /forgot-password`  | Send a reset email (same answer whether or not the email exists) |
| `POST /reset-password`   | Set a new password; only accepts a token from a recovery link |

## `/api/quickbooks`

All data routes are read-only. When QuickBooks can't answer, every route
responds the same way:

| Status | `code`               | Meaning                                         |
|--------|----------------------|-------------------------------------------------|
| 400    | `QB_NOT_CONNECTED`   | No QuickBooks company linked to the organization |
| 400    | `QB_REAUTH_REQUIRED` | QuickBooks refused the refresh token — reconnect |
| 400    | —                    | Missing or malformed `YYYY-MM-DD` date parameter |
| 500    | —                    | Anything else (details are logged, not returned) |

| Route                                  | Query                                  | Returns |
|----------------------------------------|----------------------------------------|---------|
| `GET /connect-url`                     |                                        | `{ authUrl }` to send the browser to Intuit |
| `GET /callback`                        | `code, realmId, state` (from Intuit)   | Redirect to `/index.html?connected=true` or `?qb_error=1` |
| `DELETE /disconnect`                   |                                        | `{ success: true }` |
| `GET /status`                          |                                        | `{ connected, companyName, realmId, connectedAt }` or `{ connected: false, needsReconnect }` |
| `GET /cash-projection`                 | `days` (7–90, default 30)              | Day-by-day bank balance from unpaid invoices and bills |
| `GET /bills-schedule`                  |                                        | Unpaid bills grouped by due date |
| `GET /invoice-urgency`                 |                                        | Unpaid invoices grouped by urgency |
| `GET /money-flow`                      | `startDate, endDate`                   | Top income and spending categories |
| `GET /pl-story`                        | `startDate, endDate`                   | P&L as ordered steps, with period and currency |
| `GET /balance-questions`               | `asOf` (optional)                      | Balance sheet answered as three questions |
| `GET /ratio-questions`                 | `startDate, endDate`                   | Ratios phrased as questions |
| `GET /cash-cushion`                    | `months, revGrowth, cogsGrowth, opexGrowth, taxRate` | Bank balance under the Scenarios assumptions |
| `GET /debt-detail`                     |                                        | Loans and cards with payment history |
| `GET /debt`                            |                                        | Debt totals for the Overview card |
| `GET /invoices`                        |                                        | Every invoice record |
| `GET /reports/profit-and-loss`         | `startDate, endDate`                   | Parsed P&L |
| `GET /reports/balance-sheet`           | `startDate` (the as-of date)           | Parsed Balance Sheet |
| `GET /reports/cash-flow`               | `startDate, endDate`                   | Parsed Cash Flow with opening/closing cash |
| `GET /reports/accounts-receivable`     | `startDate` (the as-of date)           | Parsed AR aging |
| `GET /reports/accounts-payable`        | `startDate` (the as-of date)           | Parsed AP aging |

## `/api/ai`

AI features (NVIDIA by default), grounded in the organization's QuickBooks data
(`services/ai/financial-context.service.js`). Results are cached per
organization for 5 minutes; the cache is cleared when the organization's
QuickBooks company is connected or disconnected.

| Route                 | Returns |
|-----------------------|---------|
| `GET /anomalies`      | `{ anomalies: [...] }` |
| `GET /recommendations`| `{ recommendations: [...] }` |
| `GET /health-score`   | `{ health: { score, rating, summary, factors } }` |
| `POST /ask`           | Body `{ organizationId, question, history }` → `{ answer }`. `question` is capped at 2,000 characters; `history` is reduced to the last 20 plain user/assistant turns. |

Extra error codes: `AI_KEY_NOT_CONFIGURED` (503), `AI_NO_CREDITS` (503).

## Rate limits (per IP, 15-minute window)

- `/api/auth/*`: 20
- `/api/ai/*`: 60
- everything under `/api`: 600

## QuickBooks request gate

`services/quickbooks/request-gate.js` sits in front of every QuickBooks read:
at most 3 calls in flight per company, identical reads within 60 seconds share
one answer, and a 429/503 from Intuit is retried with backoff instead of failing.
