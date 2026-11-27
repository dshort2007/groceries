// The budgeting math: weeks, envelopes, debt payoff and reading bank files.
// No screen code here, so it can all be tested (see tests/money.test.js).

const round2 = (n) => Math.round(n * 100) / 100;

// ---------- Dates (always plain "YYYY-MM-DD" text) ----------

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The first day of the budget week a date falls in. Weeks start on Friday
// (day 5), matching the paydays in the family spreadsheet.
export function weekStart(date, startDay = 5) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((day - startDay + 7) % 7));
}

// ---------- Envelope budget ----------
//
// How money flows:
//   - A transaction marked "income" adds to the pool waiting to be assigned.
//   - An assignment moves money from that pool into an envelope, for a week.
//   - A transaction filed under an envelope takes money out of it (or puts
//     it back, for a refund).
// An envelope's balance carries forward forever; the week is just the lens.

export function budgetFor({ envelopes, transactions, assignments }, week) {
  const end = addDays(week, 6);
  const month = week.slice(0, 7);
  const rows = new Map(
    envelopes.map((e) => [e.id, { assigned: 0, assignedMonth: 0, spent: 0, available: 0 }])
  );

  let income = 0;
  let incomeThisWeek = 0;
  let assignedTotal = 0;
  let needsEnvelope = 0;

  for (const a of assignments) {
    if (a.week > week) continue;
    const amount = Number(a.amount) || 0;
    assignedTotal += amount;
    const row = rows.get(a.envelopeId);
    if (!row) continue;
    row.available += amount;
    if (a.week === week) row.assigned += amount;
    if (a.week.slice(0, 7) === month) row.assignedMonth += amount;
  }

  for (const t of transactions) {
    const amount = Number(t.amount) || 0;
    if (!t.envelopeId) {
      needsEnvelope++;
      continue;
    }
    if (t.date > end) continue;
    if (t.envelopeId === 'income') {
      income += amount;
      if (t.date >= week) incomeThisWeek += amount;
      continue;
    }
    const row = rows.get(t.envelopeId);
    if (!row) continue; // transfers, or an envelope that no longer exists
    row.available += amount;
    if (t.date >= week) row.spent -= amount;
  }

  for (const row of rows.values()) {
    for (const key of Object.keys(row)) row[key] = round2(row[key]);
  }
  return {
    leftToAssign: round2(income - assignedTotal),
    incomeThisWeek: round2(incomeThisWeek),
    needsEnvelope,
    rows,
  };
}

// ---------- Debt payoff ----------
//
// Simulates paying every minimum each month, plus any extra, aimed at one
// debt at a time. When a debt is paid off its payment rolls to the next.
//   snowball  = smallest balance first (Dave Ramsey's method)
//   avalanche = highest interest rate first
// apr is a percent, e.g. 26.49.

export function payoffPlan(debts, extra, strategy) {
  const work = debts
    .filter((d) => Number(d.balance) > 0)
    .map((d) => ({
      name: d.name,
      balance: Number(d.balance),
      rate: (Number(d.apr) || 0) / 100 / 12,
      min: Number(d.minPayment) || 0,
    }));
  work.sort(
    strategy === 'snowball'
      ? (a, b) => a.balance - b.balance
      : (a, b) => b.rate - a.rate || a.balance - b.balance
  );

  const monthly = work.reduce((sum, d) => sum + d.min, 0) + (Number(extra) || 0);
  const order = [];
  let totalInterest = 0;
  let months = 0;

  while (work.some((d) => d.balance > 0)) {
    if (++months > 720) return { never: true, monthly: round2(monthly) };
    let pool = monthly;
    for (const d of work) {
      if (d.balance <= 0) continue;
      const interest = d.balance * d.rate;
      totalInterest += interest;
      d.balance += interest;
      const pay = Math.min(d.min, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of work) {
      if (d.balance <= 0 || pool <= 0) continue;
      const pay = Math.min(pool, d.balance);
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of work) {
      if (d.balance < 0.005 && !d.done) {
        d.balance = 0;
        d.done = true;
        order.push({ name: d.name, month: months });
      }
    }
  }
  return { months, totalInterest: round2(totalInterest), order, monthly: round2(monthly) };
}

// ---------- Reading bank files ----------

// Splits CSV text into rows of cells, handling quoted cells with commas.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

function parseDate(text) {
  const s = String(text).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

function parseAmount(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.includes('-');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Turns a bank's CSV into { date, payee, amount } rows. Money out is
// negative. Works out which columns are which from the header names.
export function readBankCsv(text) {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((r) => r.some((c) => /date/i.test(c)));
  if (headerIndex < 0) return { error: "Couldn't find a Date column in this file." };
  const header = rows[headerIndex].map((c) => c.trim().toLowerCase());
  const find = (...patterns) => {
    for (const p of patterns) {
      const i = header.findIndex((c) => p.test(c));
      if (i >= 0) return i;
    }
    return -1;
  };

  const dateCol = find(/^(transaction|trans\.?|posting|posted) ?date$/, /date/);
  const payeeCol = find(/description/, /payee|merchant/, /name|memo|details/);
  const amountCol = find(/^amount$/, /amount/);
  const debitCol = find(/debit|withdrawal/);
  const creditCol = find(/credit|deposit/);
  if (payeeCol < 0) return { error: "Couldn't find a Description column in this file." };
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    return { error: "Couldn't find an Amount column in this file." };
  }

  const out = [];
  const seen = new Map();
  for (const r of rows.slice(headerIndex + 1)) {
    const date = parseDate(r[dateCol]);
    let amount;
    if (amountCol >= 0) amount = parseAmount(r[amountCol]);
    else {
      const debit = Math.abs(parseAmount(r[debitCol]) || 0);
      const credit = Math.abs(parseAmount(r[creditCol]) || 0);
      amount = debit || credit ? credit - debit : null;
    }
    if (!date || amount === null) continue;
    const payee = (r[payeeCol] || '').trim().replace(/\s+/g, ' ');
    // The same purchase twice in one day is real, so number repeats. The
    // key lets a later import recognise rows it has already brought in.
    const base = `${date}|${Math.abs(amount).toFixed(2)}|${payee}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    out.push({ date, payee, amount, importKey: `${base}|${count}` });
  }
  if (out.length === 0) return { error: 'No transactions found in this file.' };
  return { rows: out };
}

// A simplified payee name used to remember "this store goes in that
// envelope": "KROGER #432 NEWNAN GA" and "Kroger #118 Newnan" both become
// "KROGER NEWNAN".
export function payeeKey(payee) {
  return String(payee || '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
}
