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

Data is saved in the browser on the device you're using. It does not sync
between devices yet.

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
| `js/storage.js` | Saving and loading data |
| `tests/optimizer.test.js` | Automatic checks for the price math |

## Not built yet

- Accounts and syncing between devices and people
- Automatic prices from Kroger's developer API
- Price history
- Coupons that apply to a whole order ("$5 off $50")
