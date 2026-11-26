# Nonaka Financial Partners portal

A read-only financial portal for small business owners. It connects to their
QuickBooks Online company and explains the numbers in plain language.

- `frontend/` — static pages served by the backend. `welcome.html` is the
  intro page, `index.html` is the login + portal, `js/app.js` renders the
  portal pages, `js/auth.js` handles sign-in and the QuickBooks connection.
- `backend/` — Express API: Supabase for accounts, QuickBooks for the data,
  NVIDIA's API for the AI features (Claude optional).

## How it fits together

A portal page asks `js/api.js` for data. That is the one place that knows the
`/api` base URL, attaches the session token, and silently refreshes and retries
once when a session has expired. The request reaches `backend/routes/`, where
`requireOrgAccess` checks the user belongs to the organization, then a service
in `backend/services/quickbooks/` reads QuickBooks, parses the report and
returns plain JSON. All the money arithmetic and the plain-English verdicts are
worked out in those services, so the frontend only draws them.

- `backend/services/quickbooks/quickbooks.service.js` — every QuickBooks call
  goes through its `makeApiRequest`; the `parse*` functions turn raw reports
  into the shapes the pages read.
- `backend/services/quickbooks/format.js` — shared money, date and rounding
  helpers for the services.
- `frontend/css/tokens.css` — colours, type scale and spacing.
  `css/glass.css` is loaded last on every page and gives the dark glass look;
  removing it restores the flat style.

## Run locally

1. Copy `.env.example` to `.env` at the repo root and fill it in.
2. `cd backend && npm install`
3. `npm start` (or `npm run dev` for auto-reload), then open
   `http://localhost:3000`.

`QB_ENVIRONMENT=sandbox` points at an Intuit sandbox company.

## Tests

`cd backend && npm test` runs the suite (Node's built-in runner, nothing extra to install). It
covers the organization access check, the QuickBooks OAuth state, the request gate, signup
cleanup, AI chat-history cleaning and the Profit & Loss parser. It needs no `.env` and makes no
network calls.

## More

- [API.md](API.md) — every endpoint, its auth, and its error codes.
- [FLOW.md](FLOW.md) — every screen, in the order a user meets it.
- [FEATURES.md](FEATURES.md) — what the portal must achieve.
- [DESIGN.md](DESIGN.md) — the design record. Its colours predate the
  current periwinkle palette; `tokens.css` is the source of truth.
