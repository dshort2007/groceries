# Grocery Price Planner

Add your groceries, enter what each store charges, and the app works out the
cheapest way to buy everything: all at one store, or split across a few.

## What it does today

- **List**: add items and how much you need. Enter each store's price, package
  size and any coupon.
- **Best plan**: shows the cheapest plan, what to buy where, and how it
  compares with every single-store option. You can cap how many stores you're
  willing to visit and say how much an extra stop has to save to be worth it.
- **Stores**: add or remove stores, mark memberships (Sam's Club, Walmart+),
  and set per-trip fees such as delivery.

Everyone in the house signs in with the same email and password and sees the
same list, stores and prices. Changes show up on other devices within about
15 seconds. If the connection drops, changes are kept on the device and
uploaded when it's back.

One limit: the whole list is saved as a single record, so if two people make
changes within a few seconds of each other, the later save wins.

## One-time Supabase setup

1. In Supabase, open **SQL Editor**, paste in `supabase/setup.sql`, and Run.
2. Open **Authentication > Users > Add user > Create new user**. Enter the
   household email and a password, and leave **Auto Confirm User** ticked.
3. Optional: under **Authentication > Sign In / Providers**, turn off
   **Allow new users to sign up** so nobody else can create a login.

The project address and public key are in `js/config.js`.

## Running it

It's a plain web page with no install step. It does need to be served by a
web server rather than opened by double-clicking the file:

    npm start

Then open http://localhost:8000. (`npm start` just runs Python's built-in
web server.)

To check the price math:

    npm test

## Where things are

| File | What it's for |
|---|---|
| `index.html` | The page itself |
| `styles.css` | How it looks |
| `js/optimizer.js` | The price math and best-plan logic |
| `js/app.js` | The screens and buttons |
| `js/cloud.js` | Sign-in and syncing with Supabase |
| `js/storage.js` | The copy of the data kept on each device |
| `js/config.js` | Which Supabase project to use |
| `js/vendor/supabase.js` | Supabase's own library, copied in unchanged |
| `supabase/setup.sql` | One-time database setup |
| `tests/optimizer.test.js` | Automatic checks for the price math |

## Not built yet

- Hosting at a web address
- Separate accounts per person or per household
- Automatic prices from Kroger's developer API
- Price history
- Coupons that apply to a whole order ("$5 off $50")
