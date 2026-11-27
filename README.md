# Family Budget

A private budgeting app for one household: a weekly envelope budget,
transactions, a debt payoff planner, and a grocery price planner.

## What it does

- **Budget**: zero-based envelope budgeting by week (weeks start Friday).
  Income goes into "Left to assign"; you assign it to envelopes until that
  reaches $0. Unspent money stays in its envelope and carries forward.
- **Transactions**: add spending by hand or import a bank's CSV file. The app
  remembers which envelope each payee goes in. Re-importing a file skips rows
  it already has.
- **Debts**: balances, rates and minimums, with a side-by-side comparison of
  paying smallest-balance-first (snowball) and highest-rate-first (avalanche).
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

## Privacy

This repository is public, and that's fine: it holds only the app's code. All
financial data lives in the Supabase database behind the sign-in. Never commit
a spreadsheet, bank file or setup file to this repository.

## Running it on your own computer

    npm start        then open http://localhost:8000
    npm test         checks the budgeting and price math

## Where things are

| File | What it's for |
|---|---|
| `index.html`, `styles.css` | The page and how it looks |
| `js/app.js` | Sign-in, the tabs, redrawing the screen |
| `js/views/` | One file per tab: budget, transactions, debts, groceries |
| `js/money.js` | Budget math, debt payoff math, reading bank files |
| `js/optimizer.js` | Grocery best-plan math |
| `js/db.js` | Storing data and syncing it with Supabase |
| `js/config.js` | Which Supabase project to use |
| `js/vendor/supabase.js` | Supabase's own library, copied in unchanged |
| `supabase/` | Database setup scripts |
| `tests/` | Automatic checks for the math |

## Not built yet

- Bills calendar (due dates and pay-from accounts)
- Automatic bank connections
- Account balances and reconciling against the bank
- Splitting one transaction across envelopes
- Linking debt payments to the debt balances
