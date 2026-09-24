# Nonaka Financial Partners portal

A read-only financial portal for small business owners. It connects to their
QuickBooks Online company and explains the numbers in plain language.

- `frontend/` — static pages served by the backend. `welcome.html` is the
  intro page, `index.html` is the login + portal, `js/app.js` renders the
  portal pages, `js/auth.js` handles sign-in and the QuickBooks connection.
- `backend/` — Express API: Supabase for accounts, QuickBooks for the data,
  Claude for the AI features.

## Run locally

1. Copy `.env.example` to `.env` at the repo root and fill it in.
2. `cd backend && npm install`
3. `npm start` (or `npm run dev` for auto-reload), then open
   `http://localhost:3000`.

`QB_ENVIRONMENT=sandbox` points at an Intuit sandbox company.

## More

- [API.md](API.md) — every endpoint, its auth, and its error codes.
