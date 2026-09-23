# Backend API Architecture

## Routes

### Authentication (`/api/auth`)
- `POST /signup` — Create account, profile, organization
- `POST /login` — Authenticate; return session token + org list
- `POST /refresh` — Refresh expired session token
- `POST /forgot-password` — Send password reset email
- `POST /reset-password` — Set new password from reset link

### QuickBooks (`/api/quickbooks`)
- **OAuth Flow**
  - `GET /connect-url` — Get Intuit authorization URL
  - `GET /callback` — Handle Intuit OAuth callback
  - `DELETE /disconnect` — Revoke QB connection

- **Connection Status**
  - `GET /status` — QB connection state for organization
  - `GET /company` — Connected company name and metadata

- **Financial Data (all require QB connected)**
  - `GET /cash-projection` — Forecast bank balance 7-90 days out
  - `GET /bills-schedule` — Unpaid bills grouped by due date
  - `GET /money-flow` — Money in/out breakdown (P&L derived)
  - `GET /cash-cushion` — Bank balance projection under what-if scenarios
  - `GET /debt-detail` — Loan/card details with payment history
  - `GET /invoice-urgency` — At-risk invoices (overdue/soon due)
  - `GET /pl-story` — P&L narrative and key ratios
  - `GET /balance-questions` — Common balance sheet questions
  - `GET /ratio-questions` — Financial ratio interpretations

- **Debug/Internal**
  - `GET /expenses` — Expense breakdown
  - `GET /accounts-test` — List all GL accounts in realm
  - `GET /debt` — Raw liabilities for internal use

### AI (`/api/ai`)
- `POST /ask` — Chat with Claude about organization's financial data

## Services

### Core Services
- **`supabase.service.js`** — Database, auth, QB tokens
- **`quickbooks.service.js`** — QB OAuth, API calls, token refresh, report parsing
- **`ai.service.js`** — Claude integration, financial context building

### QB Data Services (compose `quickbooks.service`)
- **`cash-projection.service.js`** — Forecast logic (invoices + bills → runway)
- **`bills-schedule.service.js`** — Unpaid bills by due date
- **`money-flow.service.js`** — Cash flow statement visualization
- **`cash-cushion.service.js`** — Scenario projections
- **`debt-detail.service.js`** — Loan/card details
- **`invoice-urgency.service.js`** — At-risk invoice detection
- **`pl-story.service.js`** — P&L narrative + metrics
- **`balance-questions.service.js`** — Balance sheet interpretations
- **`ratio-questions.service.js`** — Financial ratios + explanations
- **`format.js`** — Currency/date formatting helpers
- **`request-gate.js`** — QB request deduplication + caching

### Utility Services
- **`cache.service.js`** — In-memory request memoization (NEW)
- **`response.service.js`** — Standardized response/error shapes (NEW)

## Middleware

### `auth.middleware.js`
- **`requireOrgAccess`** — Verify session + organization membership

Applied to all QB and sensitive endpoints to ensure cross-org access is impossible.

## Data Flow

```
Frontend (index.html + js/*.js)
   ↓ (HTTP/JSON)
Express Server (backend/server.js)
   ↓ (rate limit, CORS, auth)
Routes (auth/quickbooks/ai)
   ↓ (orchestrate services)
Services (supabase, QB, AI)
   ↓ (API calls)
External (Supabase, Intuit QB, Anthropic Claude)
```

## Error Handling

- **400** — Bad request (missing params, validation failed)
- **401** — Unauthorized (missing/invalid token)
- **403** — Forbidden (user not in organization)
- **500** — Server error (log server-side, don't leak details to client)

Common error codes:
- `QB_NOT_CONNECTED` — Organization has no active QB connection
- `QB_REAUTH_REQUIRED` — QB tokens expired; user must reconnect
- `AI_KEY_NOT_CONFIGURED` — Missing Claude API key in .env
- `AUTH_INVALID` — Session token is invalid or expired

## Performance Notes

- **QB API Rate Limits**: 500 req/min per app, shared across all organizations
- **Request Gate** (`request-gate.js`) handles deduplication + cache (CACHE_MS = 5000)
- **Cache Service** provides additional memoization for high-volume endpoints
- **Static Assets** served with Cache-Control headers (1 year for versioned, 1 hour for unversioned)

## Security

- All routes except `/auth/signup`, `/auth/login`, `/auth/forgot-password` require valid session
- Organization access verified on every request (session user must belong to org)
- Secrets (.env) never logged or exposed to client
- CORS restricted to configured FRONTEND_URL origins
- Rate limiting: 20/15m auth, 60/15m AI, 600/15m general API
- CSP allows only `'self'` + specific CDNs for Chart.js, Google Fonts
