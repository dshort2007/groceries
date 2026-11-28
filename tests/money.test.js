// Checks the budgeting math. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, addDays, addMonths, budgetFor, payoffPlan, readBankCsv, parseCsv, payeeKey, parts, accountBalances, dueAfter, debtStatus, monthlyTargets, billEstimate, findPayment, splitJob, billMonthly, occurrences, paycheckPlan, goalStatus, monthsEnding, monthlyReport } from '../js/money.js';

test('weeks start on Friday', () => {
  assert.equal(weekStart('2026-11-27'), '2026-11-27'); // a Friday
  assert.equal(weekStart('2026-11-26'), '2026-11-20'); // Thursday
  assert.equal(weekStart('2026-12-02'), '2026-11-27'); // Wednesday
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
});

const envelopes = [{ id: 'groc' }, { id: 'gas' }];
const data = {
  envelopes,
  transactions: [
    { date: '2026-11-20', amount: 1000, envelopeId: 'income' },
    { date: '2026-11-21', amount: -80, envelopeId: 'groc' },
    { date: '2026-11-27', amount: 500, envelopeId: 'income' },
    { date: '2026-11-28', amount: -150, envelopeId: 'groc' },
    { date: '2026-11-29', amount: 20, envelopeId: 'groc' }, // refund
    { date: '2026-11-29', amount: -300, envelopeId: 'transfer' },
    { date: '2026-11-30', amount: -12, envelopeId: '' },
  ],
  assignments: [
    { week: '2026-11-20', envelopeId: 'groc', amount: 200 },
    { week: '2026-11-20', envelopeId: 'gas', amount: 50 },
    { week: '2026-11-27', envelopeId: 'groc', amount: 100 },
  ],
};

test('income minus everything assigned is left to assign', () => {
  assert.equal(budgetFor(data, '2026-11-20').leftToAssign, 750);
  assert.equal(budgetFor(data, '2026-11-27').leftToAssign, 1150);
});

test('unspent envelope money rolls into the next week', () => {
  const first = budgetFor(data, '2026-11-20').rows.get('groc');
  assert.deepEqual(first, { assigned: 200, assignedMonth: 200, spent: 80, available: 120 });
  const second = budgetFor(data, '2026-11-27').rows.get('groc');
  assert.equal(second.assigned, 100);
  assert.equal(second.spent, 130); // 150 spent, 20 refunded
  assert.equal(second.available, 90); // 120 carried + 100 - 130
  assert.equal(budgetFor(data, '2026-11-27').rows.get('gas').available, 50);
});

test('transfers are ignored and unfiled transactions are counted', () => {
  const b = budgetFor(data, '2026-11-27');
  assert.equal(b.needsEnvelope, 1);
  assert.equal(b.incomeThisWeek, 500);
});

const debts = [
  { name: 'Big low-rate', balance: 5000, apr: 5, minPayment: 100 },
  { name: 'Small', balance: 500, apr: 10, minPayment: 25 },
  { name: 'High-rate', balance: 3000, apr: 28, minPayment: 90 },
];

test('snowball pays the smallest balance first, avalanche the highest rate', () => {
  const snowball = payoffPlan(debts, 200, 'snowball');
  const avalanche = payoffPlan(debts, 200, 'avalanche');
  assert.equal(snowball.order[0].name, 'Small');
  assert.equal(avalanche.order[0].name, 'High-rate');
  assert.ok(avalanche.totalInterest < snowball.totalInterest);
  assert.equal(snowball.monthly, 415);
  const withIds = debts.map((d, i) => ({ ...d, id: 'd' + i }));
  assert.deepEqual(payoffPlan(withIds, 200, 'snowball').attack, ['d1', 'd2', 'd0']);
  assert.deepEqual(payoffPlan(withIds, 200, 'avalanche').attack, ['d2', 'd1', 'd0']);
  assert.equal(payoffPlan(withIds, 200, 'avalanche').order[0].id, 'd2');
});

test('a single debt matches a hand calculation', () => {
  // $1,000 at 12% with $500 a month: interest 10.00, 5.10, 0.151 -> 3 months
  const plan = payoffPlan([{ name: 'A', balance: 1000, apr: 12, minPayment: 500 }], 0, 'snowball');
  assert.equal(plan.months, 3);
  assert.equal(plan.totalInterest, 15.25);
});

test('payments that never cover the interest are reported, not looped forever', () => {
  const plan = payoffPlan([{ name: 'A', balance: 10000, apr: 30, minPayment: 100 }], 0, 'snowball');
  assert.equal(plan.never, true);
});

test('reads a bank file with one signed Amount column', () => {
  const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
    '11/25/2026,11/26/2026,"KROGER #432, NEWNAN GA",Groceries,Sale,-84.12,\n' +
    '11/24/2026,11/25/2026,Payment Thank You,,Payment,"1,200.00",\n';
  const { rows } = readBankCsv(csv);
  assert.deepEqual(rows[0], { date: '2026-11-25', payee: 'KROGER #432, NEWNAN GA', amount: -84.12, importKey: '2026-11-25|84.12|KROGER #432, NEWNAN GA|1' });
  assert.equal(rows[1].amount, 1200);
});

test('reads a bank file with separate Debit and Credit columns', () => {
  const csv = 'Account,Checking\n\nDate,Description,Debit,Credit\n2026-11-25,COFFEE,4.50,\n2026-11-25,COFFEE,4.50,\n2026-11-26,PAYCHECK,,2430.40\n';
  const { rows } = readBankCsv(csv);
  assert.deepEqual(rows.map((r) => r.amount), [-4.5, -4.5, 2430.4]);
  assert.notEqual(rows[0].importKey, rows[1].importKey);
});

test('explains what is wrong with an unreadable file', () => {
  assert.match(readBankCsv('a,b\n1,2\n').error, /Date column/);
  assert.equal(parseCsv('a,"b ""x"""\r\n').at(0)[1], 'b "x"');
});

test('payee names are simplified for remembering envelopes', () => {
  assert.equal(payeeKey('KROGER #432 NEWNAN GA'), payeeKey('Kroger #118 Newnan'));
  assert.equal(payeeKey('WAL-MART #1234'), 'WAL MART');
});

test('a split purchase comes out of each envelope it was split across', () => {
  const split = { date: '2026-11-28', amount: -80, envelopeId: 'split', splits: [{ envelopeId: 'groc', amount: -60 }, { envelopeId: 'gas', amount: -20 }] };
  assert.equal(parts(split).length, 2);
  const b = budgetFor({ ...data, transactions: [...data.transactions, split] }, '2026-11-27');
  assert.equal(b.rows.get('groc').available, 30); // was 90
  assert.equal(b.rows.get('gas').available, 30); // was 50
  assert.equal(b.needsEnvelope, 1); // unchanged: every piece has an envelope

  const half = { ...split, splits: [{ envelopeId: 'groc', amount: -60 }, { envelopeId: '', amount: -20 }] };
  assert.equal(budgetFor({ ...data, transactions: [half] }, '2026-11-27').needsEnvelope, 1);
});

test('money already in the bank is available to assign; card debt is not', () => {
  const accounts = [
    { id: 'chk', type: 'checking', startBalance: 400, startDate: '2026-11-27' },
    { id: 'card', type: 'credit', startBalance: -900, startDate: '2026-11-27' },
  ];
  assert.equal(budgetFor({ ...data, accounts }, '2026-11-27').leftToAssign, 1550); // 1150 + 400
  assert.equal(budgetFor({ ...data, accounts }, '2026-11-20').leftToAssign, 750); // before it existed
});

test('account balances are the starting balance plus every transaction', () => {
  const accounts = [{ id: 'chk', startBalance: 100 }, { id: 'card', startBalance: -50 }];
  const txs = [
    { accountId: 'chk', amount: -30 },
    { accountId: 'chk', amount: 500 },
    { accountId: 'card', amount: -20.1 },
    { accountId: 'card', amount: -0.2 },
    { amount: -999 },
  ];
  const b = accountBalances(accounts, txs);
  assert.equal(b.get('chk'), 570);
  assert.equal(b.get('card'), -70.3);
});

test('bills move forward by their repeat and keep their day of the month', () => {
  assert.equal(addMonths('2026-11-15', 1), '2026-12-15');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(dueAfter({ nextDue: '2027-01-31', every: 1, day: 31 }), '2027-02-28');
  assert.equal(dueAfter({ nextDue: '2027-02-28', every: 1, day: 31 }), '2027-03-31');
  assert.equal(dueAfter({ nextDue: '2026-11-15', every: 3 }), '2027-02-15');
});

test('payments from the linked envelope bring a debt balance down', () => {
  const debt = { balance: 1000, asOf: '2026-11-01', envelopeId: 'card-env' };
  const txs = [
    { date: '2026-10-28', amount: -100, envelopeId: 'card-env' }, // before the statement
    { date: '2026-11-01', amount: -50, envelopeId: 'card-env' }, // same day: already in the statement
    { date: '2026-11-10', amount: -200, envelopeId: 'card-env' },
    { date: '2026-11-12', amount: -90, envelopeId: 'split', splits: [{ envelopeId: 'card-env', amount: -40 }, { envelopeId: 'groc', amount: -50 }] },
    { date: '2026-11-15', amount: -75, envelopeId: 'groc' },
  ];
  assert.deepEqual(debtStatus(debt, txs), { paid: 240, balance: 760 });
  assert.deepEqual(debtStatus({ balance: 1000 }, txs), { paid: 0, balance: 1000 });

  // Entered the balance this morning, typed in a payment this afternoon.
  const sameDay = { ...debt, asOfAt: 1000 };
  const typedLater = { date: '2026-11-01', amount: -30, envelopeId: 'card-env', created: 2000 };
  const importedLater = { ...typedLater, importKey: 'x' };
  assert.equal(debtStatus(sameDay, [typedLater]).paid, 30);
  assert.equal(debtStatus(sameDay, [importedLater]).paid, 0);
});

test("an envelope's monthly target comes from its bills when it has any", () => {
  const envs = [{ id: 'rent', plan: 2137 }, { id: 'trash', plan: 0 }, { id: 'groc', plan: 440 }, { id: 'subs', plan: 5 }];
  const bills = [
    { envelopeId: 'rent', amount: 2145, every: 1 },
    { envelopeId: 'trash', amount: 72, every: 3 },
    { envelopeId: 'subs', amount: 9.99, every: 1 },
    { envelopeId: 'subs', amount: 120, every: 12 },
    { envelopeId: 'groc', amount: 0, every: 1 }, // no amount yet: ignored
  ];
  const t = monthlyTargets(envs, bills);
  assert.equal(t.get('rent').amount, 2145); // the bill wins over the typed 2137
  assert.equal(t.get('trash').amount, 24);
  assert.equal(t.get('subs').amount, 19.99);
  assert.equal(t.get('subs').bills.length, 2);
  assert.deepEqual(t.get('groc'), { amount: 440, bills: [] });
});

test('a changing bill is estimated from the last three payments', () => {
  assert.equal(billEstimate([]), null);
  assert.equal(billEstimate([{ amount: 300 }]), 300);
  assert.equal(billEstimate([{ amount: 100 }, { amount: 300 }, { amount: 310 }, { amount: 320.5 }]), 310.17);
});

test('spots the transaction that paid a bill', () => {
  const utilities = { id: 'b1', envelopeId: 'util', nextDue: '2026-12-01', amount: 300, variable: true, lastPaid: '2026-11-01' };
  const txs = [
    { id: 't0', date: '2026-11-01', amount: -290, envelopeId: 'util' }, // last month, already counted
    { id: 't1', date: '2026-12-03', amount: -318.42, envelopeId: 'util' },
    { id: 't2', date: '2026-12-20', amount: -50, envelopeId: 'util' }, // too far from the due date
    { id: 't3', date: '2026-12-02', amount: -40, envelopeId: 'groc' },
    { id: 't4', date: '2026-12-02', amount: 25, envelopeId: 'util' }, // a refund, not a payment
  ];
  assert.deepEqual(findPayment(utilities, txs, false), { tx: txs[1], amount: 318.42, gap: 2 });
  // A fixed bill, or one sharing its envelope, only matches a similar amount.
  assert.equal(findPayment({ ...utilities, variable: false }, txs, false), null);
  assert.equal(findPayment(utilities, txs, true), null);
  assert.equal(findPayment({ ...utilities, amount: 320 }, txs, true).tx.id, 't1');
  assert.equal(findPayment({ ...utilities, lastTxId: 't1' }, txs, false), null);
  assert.equal(findPayment({ ...utilities, envelopeId: '' }, txs, false), null);
});

test('a job splits by percentage and always adds back up', () => {
  assert.deepEqual(splitJob(347.67, { business: 50, family: 50 }), { business: 173.84, family: 173.83, personal: 0 });
  assert.deepEqual(splitJob(600, { business: 40, family: 35 }), { business: 240, family: 210, personal: 150 });
  for (const total of [193.95, 458.88, 627.81, 0.01]) {
    const s = splitJob(total, { business: 33.3, family: 33.3 });
    assert.equal(Math.round((s.business + s.family + s.personal) * 100), Math.round(total * 100));
  }
});

test('bills can repeat every week or every two weeks', () => {
  const loan = { nextDue: '2026-12-04', days: 14, amount: 249.52, envelopeId: 'loan' };
  assert.equal(dueAfter(loan), '2026-12-18');
  assert.equal(dueAfter({ nextDue: '2026-12-25', days: 14 }), '2027-01-08');
  assert.equal(billMonthly(loan), 540.63); // 26 payments a year
  assert.equal(billMonthly({ amount: 50, days: 7 }), 216.67); // 52 a year
  assert.equal(billMonthly({ amount: 72, every: 3 }), 24);
  assert.equal(monthlyTargets([{ id: 'loan' }], [loan]).get('loan').amount, 540.63);

  // A payment 8 days from the due date belongs to the next fortnight.
  const txs = [{ id: 't1', date: '2026-12-12', amount: -249.52, envelopeId: 'loan' }, { id: 't2', date: '2026-12-05', amount: -249.52, envelopeId: 'loan' }];
  assert.equal(findPayment(loan, txs, false).tx.id, 't2');
  assert.equal(findPayment(loan, [txs[0]], false), null);
});

test('finds every date something repeating falls on', () => {
  assert.deepEqual(occurrences('2026-11-27', { days: 14 }, '2026-11-01', '2026-12-31'), ['2026-11-13', '2026-11-27', '2026-12-11', '2026-12-25']);
  assert.deepEqual(occurrences('2026-12-01', { every: 1 }, '2026-12-01', '2027-02-15'), ['2026-12-01', '2027-01-01', '2027-02-01']);
  assert.deepEqual(occurrences('2027-01-31', { every: 1, day: 31 }, '2027-02-01', '2027-03-31'), ['2027-02-28', '2027-03-31']);
  assert.deepEqual(occurrences('2026-12-15', { every: 3 }, '2026-12-16', '2027-06-30'), ['2027-03-15', '2027-06-15']);
  assert.deepEqual(occurrences('2026-12-15', { every: 1 }, '2026-10-01', '2026-11-30'), ['2026-10-15', '2026-11-15']);
});

test('lines bills up against paydays', () => {
  const paychecks = [
    { name: 'Church', amount: 2430.4, nextDate: '2026-11-27', days: 14 },
    { name: 'Photography', amount: 1000, nextDate: '2026-12-11', every: 1 },
  ];
  const bills = [
    { id: 'rent', name: 'Rent', amount: 2145, nextDue: '2026-12-01', every: 1 },
    { id: 'loan', name: 'Loan', amount: 250, nextDue: '2026-12-04', days: 14 },
    { id: 'late', name: 'Late one', amount: 40, nextDue: '2026-11-20', every: 1 },
    { id: 'blank', name: 'No amount', amount: 0, nextDue: '2026-12-02', every: 1 },
  ];
  const plan = paycheckPlan(paychecks, bills, '2026-11-28', 42);
  assert.deepEqual(plan.map((p) => [p.from, p.until, p.amount]), [
    ['2026-11-27', '2026-12-10', 2430.4],
    ['2026-12-11', '2026-12-24', 3430.4], // both land the same day
    ['2026-12-25', '2027-01-07', 2430.4],
    ['2027-01-08', '2027-01-09', 2430.4],
  ]);
  const first = plan[0];
  assert.equal(first.current, true);
  assert.deepEqual(first.bills.map((b) => [b.name, b.date, b.overdue]), [['Late one', '2026-11-20', true], ['Rent', '2026-12-01', false], ['Loan', '2026-12-04', false]]);
  assert.equal(first.billsTotal, 2435);
  assert.equal(first.left, -4.6);
  assert.deepEqual(plan[1].bills.map((b) => b.name), ['Loan', 'Late one']); // Dec 18 and Dec 20
  assert.deepEqual(plan[2].bills.map((b) => [b.name, b.date]), [['Rent', '2027-01-01'], ['Loan', '2027-01-01']]);
  assert.deepEqual(paycheckPlan([], bills, '2026-11-28'), []);
});

test('works out what a savings goal needs each week', () => {
  assert.equal(goalStatus({ amount: 0 }, 50, '2026-11-28'), null);
  assert.deepEqual(goalStatus({ amount: 1000 }, 250, '2026-11-28'), { target: 1000, remaining: 750, share: 0.25, reached: false, perWeek: null, weeksLeft: null, late: false });
  const dated = goalStatus({ amount: 1000, date: '2027-01-09' }, 250, '2026-11-28');
  assert.equal(dated.weeksLeft, 6);
  assert.equal(dated.perWeek, 125);
  assert.equal(goalStatus({ amount: 1000, date: '2026-11-01' }, 250, '2026-11-28').late, true);
  assert.equal(goalStatus({ amount: 1000, date: '2027-01-09' }, 1200, '2026-11-28').reached, true);
  assert.equal(goalStatus({ amount: 1000 }, -40, '2026-11-28').remaining, 1000); // overspent counts as empty
});

test('reports income and spending by month, group and payee', () => {
  assert.deepEqual(monthsEnding('2027-01', 3), ['2026-11', '2026-12', '2027-01']);
  const envs = [{ id: 'groc', name: 'Groceries', group: 'Food' }, { id: 'out', name: 'Dining Out', group: 'Food' }, { id: 'gas', name: 'Gas', group: 'Car' }];
  const txs = [
    { date: '2026-10-05', amount: 2000, envelopeId: 'income', payee: 'Church' },
    { date: '2026-10-07', amount: -100, envelopeId: 'groc', payee: 'Kroger' },
    { date: '2026-11-03', amount: 2400, envelopeId: 'income', payee: 'Church' },
    { date: '2026-11-04', amount: -150.25, envelopeId: 'groc', payee: 'Kroger' },
    { date: '2026-11-06', amount: 20, envelopeId: 'groc', payee: 'Kroger' }, // refund
    { date: '2026-11-08', amount: -90, envelopeId: 'split', payee: 'Walmart', splits: [{ envelopeId: 'groc', amount: -60 }, { envelopeId: 'gas', amount: -30 }] },
    { date: '2026-11-09', amount: -500, envelopeId: 'transfer', payee: 'To savings' },
    { date: '2026-11-10', amount: -12, envelopeId: '', payee: 'Mystery' },
    { date: '2026-09-01', amount: -999, envelopeId: 'gas', payee: 'Old' },
  ];
  const r = monthlyReport(envs, txs, ['2026-10', '2026-11']);
  assert.deepEqual(r.months, [{ month: '2026-10', income: 2000, spent: 100, net: 1900 }, { month: '2026-11', income: 2400, spent: 220.25, net: 2179.75 }]);
  const food = r.groups.find((g) => g.name === 'Food');
  assert.deepEqual(food.byMonth, { '2026-10': 100, '2026-11': 190.25 });
  assert.deepEqual(food.envelopes[0], { id: 'groc', name: 'Groceries', byMonth: { '2026-10': 100, '2026-11': 190.25 } });
  assert.deepEqual(r.groups.find((g) => g.name === 'Car').byMonth, { '2026-11': 30 });
  assert.deepEqual(r.payees['2026-11'], [{ payee: 'Kroger', spent: 130.25 }, { payee: 'Walmart', spent: 90 }]);
});
