# Penny

A minimalist, multi-user personal finance web app. Describe a purchase, press Enter, check its category and choose Cash or Credit card, then save. Sign in with Google to keep a private journal, then explore daily, weekly, and monthly reports.

**Stack:** vanilla HTML/CSS/JavaScript, Vercel Node.js functions, OpenAI structured output, Google OAuth, and Turso SQLite. No frontend framework or bundler is required.

## Features

- Google sign-in, server-side sessions, sign-out, and private per-user expenses.
- One natural-language input, automatic categories, and a review popup with category correction and Cash/Credit card selection.
- Payment method shown in the expense feed, reports, and CSV exports. No card numbers or bank credentials are collected.
- A daily leak warning for repeated discretionary purchases under ₹500.
- Daily, weekly, and monthly reports with historical navigation, spending charts, categories, and previous-period comparisons.
- CSV downloads with spreadsheet formula protection.
- An explicitly labeled sample journal that needs no account or API credentials.
- Retry-safe inserts, exact integer money storage, per-user AI quotas, and responsive layouts.

## Run locally

Use Node.js 22.

```sh
npm ci
cp .env.example .env
# Fill in server credentials in .env.
npm run db:migrate
npm run dev
```

Open [localhost:3000](http://localhost:3000). For a credential-free preview, choose **Explore a sample journal** or open [the demo](http://localhost:3000/?demo=1).

Use `TURSO_DATABASE_URL=file:local.db` for a local development database; no Turso token is needed in that case. Local Google sign-in still needs a configured OAuth client and the callback `http://localhost:3000/api/auth?action=callback`. Live AI parsing requires an OpenAI key.

Sample entries stay in tab memory, use a local parser with common Indian foods, merchants, contextual category rules, and spelling aliases, and are never sent to the API or copied into a real account. Sample history contains only today's example expenses; older report periods are intentionally empty.

## Deploy

See [DEPLOYMENT.md](DEPLOYMENT.md) for the complete **private GitHub repository + Vercel** setup, Google redirect registration, database migration, environment variables, and live verification steps.

Required server variables are `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `OPENAI_API_KEY`. `OPENAI_MODEL` is optional and defaults to `gpt-4o-mini`. Never commit credentials. Only `public/` browser assets are copied to `dist/`; Vercel separately builds `api/` functions.

## Directory structure

```text
.
├── api/
│   ├── auth.js                   # Google login/callback, session, logout
│   ├── previewExpense.js         # Authenticated AI parse into a private draft
│   ├── parseExpense.js           # Confirm draft, category, and payment; save
│   ├── expenses.js               # This user's expenses today
│   ├── analytics.js              # This user's daily leak analytics
│   └── reports.js                # Daily/weekly/monthly JSON and CSV
├── lib/
│   ├── ai/OpenAIParser.js        # Strict schema, prompt, timeout, validation
│   ├── auth/
│   │   ├── AuthRepository.js     # Users, hashed sessions, OAuth transactions
│   │   ├── AuthService.js        # Login, cookie, nonce/PKCE/session lifecycle
│   │   ├── GoogleProvider.js     # Google's official token verifier
│   │   ├── config.js             # Fixed origin and authentication settings
│   │   ├── cookies.js            # Host-only cookies and random token helpers
│   │   └── index.js              # Shared authentication boundary
│   ├── db/
│   │   ├── client.js             # Reused remote libSQL client
│   │   └── ExpenseRepository.js  # User-scoped, parameterized queries
│   ├── domain/
│   │   ├── day.js                # India day boundaries
│   │   ├── expense.js            # Money/schema/category rules
│   │   ├── limits.js             # Server-side per-account AI quotas
│   │   ├── period.js             # Calendar periods and matched comparisons
│   │   └── reportCsv.js          # CSV escaping and formula protection
│   ├── http/
│   │   ├── ApiResponse.js        # Consistent success/error envelope
│   │   ├── ApiError.js           # Safe expected errors
│   │   ├── asyncHandler.js       # Sanitized async error boundary
│   │   └── request.js            # HTTP/input validation
│   └── services/
│       ├── ExpenseService.js     # Expense/report rules and quotas
│       └── container.js          # Dependency wiring
├── database/
│   ├── auth.sql                  # User, OAuth transaction, and session tables
│   └── schema.sql                # Expenses, constraints, indexes, quotas
├── public/
│   ├── index.html                # Welcome/sign-in, journal, report shell
│   ├── app.js                    # Account state and journal interactions
│   ├── expenseComposer.js        # Preview, correct category, choose payment, save
│   ├── expenseComposer.css       # Accessible responsive confirmation dialog
│   ├── classifyExpense.js        # Local category rules and spelling aliases
│   ├── styles.css                # Journal layout
│   ├── account.css               # Sign-in and navigation layout
│   ├── reports.js                # Reports and CSV downloads
│   ├── reports.css               # Responsive report layout
│   ├── demo.js                   # Optional local sample journal
│   ├── privacy.html              # Plain-language data information
│   └── favicon.svg
├── scripts/
│   ├── dev.js                    # Local HTTP server and API adapter
│   ├── build.js                  # Browser-only output
│   ├── check.js                  # Syntax checks
│   └── migrate.js                # Atomic, repeatable migration
├── tests/                        # Auth, isolation, reports, migration, parsing
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── vercel.json
├── DEPLOYMENT.md
└── README.md
```

## Authentication and isolation

Google OAuth uses a server authorization-code flow with **PKCE**, a random browser-bound state, and a nonce. Google's maintained library verifies ID-token signatures, audience, issuer, and expiration. Identity is keyed by the immutable Google subject, never matched to another account by email.

The browser receives a random session token in an `HttpOnly`, `SameSite=Lax`, host-only cookie. HTTPS uses `Secure` and a `__Host-` cookie name. SQLite stores only the token hash. Sessions expire after 30 days and are revoked on sign-out. Mutation requests must have the exact configured `APP_URL` origin; the app never accepts a client-supplied user ID.

Every expense, analytics, idempotency, and export query includes the authenticated `user_id`. Retrying one user's request cannot reveal another user's result. Missing authentication returns 401 even when demo mode exists in the browser.

Upgrading from the original single-user database preserves old expenses under `legacy-unclaimed`, an account that cannot sign in. It does not expose those rows to new users. An administrator must explicitly determine ownership before moving any historical data. Run `npm run db:migrate` when upgrading an existing database to enable payment tracking and drafts. Earlier expenses keep their original details and display “Payment not specified”.

## AI parsing and clean architecture

HTTP routes delegate to services, services delegate to the AI parser and repository, and the shared `ApiResponse`/`ApiError` classes standardize JSON. Native asynchronous `fetch` yields while waiting for OpenAI; remote libSQL calls are asynchronous. The provider call aborts after 12 seconds; Vercel functions have a 30-second duration limit.

The LLM must return exactly:

```json
{
  "item": "Dosa & coffee",
  "amount": 235,
  "category": "food_drink",
  "is_potential_leak": true
}
```

All fields are required. Extra keys, incorrect types, unknown categories, nonfinite numbers, and fractional paise are rejected. Missing or ambiguous amounts produce an internal zero sentinel that fails validation before storage. The prompt treats descriptions as untrusted purchase data, ignores embedded instructions, never guesses prices, and does not convert foreign currency. Categorization considers the original sentence, merchant, purpose, and common misspellings. Structural validation is deterministic; semantic categorization can still be imperfect, so every preview offers category correction before saving.

Previews are private, expire after 15 minutes, and are excluded from expenses and reports. Closing the popup saves nothing. Confirmation requires a payment method and a valid category; item and amount come from the server's draft. If you change the category, the leak flag is recalculated conservatively: food/drink, shopping, and entertainment qualify, while groceries, transport, bills, health, and other do not. Keeping the detected category preserves the parser's contextual flag. The ₹500 threshold is still applied separately by analytics.

The categories are `food_drink`, `shopping`, `entertainment`, `transport`, `groceries`, `bills`, `health`, and `other`. The API uses rupees; SQLite uses integer paise. Maximum amount per entry is ₹1,00,00,000. All entries are dated when submitted; mentioning an earlier date does not backdate them.

New parsing attempts are limited per account to **20 per minute and 200 per UTC day**, reserved atomically in the database before the paid call. Failed parsing counts toward the allowance. Replaying an already saved submission does not consume quota. Limits are shared across serverless instances, not held in process memory. Provider/account spend limits remain useful because these are per-user quotas rather than a global budget.

## Reports and leak rules

All displayed periods use **Asia/Kolkata (UTC+05:30)**:

| Report | Range | Average denominator |
| --- | --- | --- |
| Daily | One India calendar day | 1 day |
| Weekly | Monday through Sunday | Elapsed days for this week; 7 for a past week |
| Monthly | First through last day of the month | Elapsed days this month; full past month |

Days with no recorded purchases count in the average. Future dates are rejected. The previous-period comparison uses the same number of elapsed days on both sides, capped when the prior month is shorter; full-period totals remain unchanged.

A qualifying leak is `is_potential_leak = true AND amount_paise < 50000`. Exactly ₹500 is excluded. A warning requires at least three qualifying purchases in one category **on the same day**, including in weekly/monthly reports. The daily journal's velocity is today's accumulated leak total. Reports show the average leak total per included calendar day. Neither is a prediction.

CSV exports contain the selected period's purchases, dates, categories, payment methods, amounts, and flags. Quoting and formula-prefix protection prevent item names from becoming spreadsheet formulas. JSON and CSV both require the same authenticated session.

## Endpoints

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/auth?action=login` | Redirect to Google |
| GET | `/api/auth?action=callback` | Verify Google response, establish session |
| GET | `/api/auth?action=session` | `{user, configured}`; no tokens |
| POST | `/api/auth?action=logout` | Revoke session, clear cookie |
| POST | `/api/previewExpense` | Parse a private draft; no expense is saved |
| POST | `/api/parseExpense` | Confirm category and payment; save the draft |
| GET | `/api/expenses` | This user's expenses today |
| GET | `/api/analytics` | This user's daily insights |
| GET | `/api/reports?period=week&date=2026-09-24` | Selected report as JSON |
| GET | `/api/reports?period=month&date=2026-09-24&format=csv` | Selected purchases as CSV |

The date is optional and defaults to today. Period is `day`, `week`, or `month`.

Both POSTs require `Content-Type: application/json`. The browser supplies the session cookie and Origin automatically.

1. Preview: send `{ "text": "coffee for 80" }` to `/api/previewExpense`. The response contains `data.draft` with `id`, `item`, `amount`, `category`, `is_potential_leak`, and `expires_at`.
2. Confirm: send `{ "draft_id": "<preview UUID>", "payment_method": "cash", "category": "food_drink" }` to `/api/parseExpense` with a UUID `Idempotency-Key` header. Payment method must be `cash` or `credit_card`.

A successful save returns 201; an identical saved replay returns 200; reusing a key or confirmed draft with different choices returns 409. A draft can create only one expense, including retries with different keys. The unique key is scoped per user. The frontend keeps its draft and retry key in memory until a successful save; these are not retained across a page reload.

JSON envelope:

```json
{ "success": true, "data": {}, "message": "Success" }
```

Error envelope:

```json
{
  "success": false,
  "data": null,
  "message": "Sign in with Google to continue.",
  "error": { "code": "UNAUTHENTICATED" }
}
```

## Verification

```sh
npm run check
npm test
npm run build
```

Tests use Node's test runner, mocked Google/OpenAI services, and temporary SQLite databases. They check account/session security, cross-user isolation, replay and concurrency, precise money, IST/calendar boundaries, report arithmetic, CSV escaping, quotas, and atomic migration rollback. They never use production credentials or call paid APIs.

The UI includes responsive layouts, keyboard submission, loading/error/empty states, accessible labels, report amount tables, and reduced-motion support. The integration suite does not replace testing your real Google client and remote services after configuration.

## References

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Turso client reference](https://docs.turso.tech/sdk/ts/reference)
- [Vercel Node.js functions](https://vercel.com/docs/functions/runtimes/node-js)
