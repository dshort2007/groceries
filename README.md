# Family Budget

A private budgeting app for one household: a weekly envelope budget,
transactions, a debt payoff planner, and a grocery price planner.

## What it does

- **Overview**: where things stand today (cash, money left to assign, bills
  due, debt), a list of loose ends that each link to where you fix them,
  this month's spending against plan, and a few observations.
- **Budget**: zero-based envelope budgeting by week (weeks start Friday).
  Income goes into "Left to assign"; you assign it to envelopes until that
  reaches $0. Unspent money stays in its envelope and carries forward.
- **Transactions**: add spending by hand or import a bank's CSV file. The app
  remembers which envelope each payee goes in, and re-importing a file skips
  rows it already has. One purchase can be split across several envelopes.
  Accounts show a running balance you can check against the bank.
- **Bills**: what's due this week and in the next 30 days, which account it
  comes from, and whether its envelope has enough in it. Marking a bill paid
  records the transaction and moves it to its next due date. Bills whose
  amount changes (utilities) take this month's amount right on the row and
  estimate the next one from recent payments. When a matching payment shows
  up among your transactions, the bill offers to mark itself paid.
- **Debts**: balances, rates and minimums, with a side-by-side comparison of
  paying smallest-balance-first (snowball) and highest-rate-first (avalanche).
  Link a debt to an envelope and payments from it bring the balance down.
- **Groceries**: compare prices across stores and find the cheapest plan.

Each family member signs in with their own login. Changes sync between
devices within about 15 seconds, and each envelope, transaction or debt syncs
on its own, so two people can work at the same time.

## One-time Supabase setup

1. Create a login for each person under **Authentication > Users > Add user**
   (leave **Auto Confirm User** ticked).
2. Open `supabase/setup-finance.sql`, put those emails in the last statement,
   paste the whole thing into the **SQL Editor**, and Run.

Only logins listed in that last statement can see or change anything.
`supabase/setup.sql` is the setup for the earlier grocery-only version.

## Automatic bank connections (optional)

The app can pull transactions from your banks through Plaid. Plaid's secret
key and the tokens that unlock each bank are kept on Supabase's servers, in a
small server-side program (`supabase/functions/plaid/index.ts`) and a locked
table that no browser can read.

1. **Plaid dashboard**: copy your client ID and your Sandbox and Production
   secrets. Add this app's address (ending in `/`) to the allowed redirect
   URIs.
2. **Supabase SQL Editor**: run `supabase/setup-plaid.sql`.
3. **Supabase > Edge Functions > Secrets**: add `PLAID_CLIENT_ID`,
   `PLAID_SECRET` and `PLAID_ENV` (`sandbox` to test with Plaid's fake bank,
   `production` for real banks).
4. **Supabase > Edge Functions**: create a function named `plaid`, paste in
   the contents of `supabase/functions/plaid/index.ts`, and deploy. Turn off
   the "Verify JWT" option: the function does its own, stricter check (signed
   in *and* on the family list).

Then use **Transactions > Bank connections** in the app.

## Privacy

This repository is public, and that's fine: it holds only the app's code. All
financial data lives in the Supabase database behind the sign-in. Never commit
a spreadsheet, bank file, setup file or secret key to this repository.

## Running it on your own computer

    npm start        then open http://localhost:8000
    npm test         checks the budgeting and price math

## Where things are

| File | What it's for |
|---|---|
| `index.html`, `styles.css` | The page and how it looks |
| `sw.js` | Makes browsers pick up a newly published version on the next reload |
| `js/app.js` | Sign-in, the tabs, redrawing the screen |
| `js/views/` | One file per tab, plus `shared.js` for pickers they share |
| `js/money.js` | Budget math, debt payoff math, reading bank files |
| `js/optimizer.js` | Grocery best-plan math |
| `js/db.js` | Storing data and syncing it with Supabase |
| `js/config.js` | Which Supabase project to use |
| `js/vendor/supabase.js` | Supabase's own library, copied in unchanged |
| `supabase/` | Database setup scripts, and the server-side bank function |
| `tests/` | Automatic checks for the math |

## Not built yet

- Adding interest to debt balances automatically
- Reports (spending over time)
