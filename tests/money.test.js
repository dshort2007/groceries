// Checks the budgeting math. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, addDays, addMonths, budgetFor, payoffPlan, readBankCsv, parseCsv, payeeKey, parts, accountBalances, dueAfter, debtStatus, monthlyTargets, billEstimate, findPayment, splitJob, billMonthly, occurrences, paycheckPlan, goalStatus, monthsEnding, monthlyReport, periodOf, suggestBills, priceChanges, netWorth, expectedIncome } from '../js/money.js';

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
  assert.equal(budgetFor(data, '2026-11-20').leftToAssign, 650); // 1000 in, 350 assigned including next week's 100
  assert.equal(budgetFor(data, '2026-11-27').leftToAssign, 1150);
  assert.equal(budgetFor(data, '2026-11-20').assignedLater, 100); // next week's groceries
  assert.equal(budgetFor(data, '2026-11-27').assignedLater, 0);
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
  assert.equal(budgetFor({ ...data, accounts }, '2026-11-20').leftToAssign, 650); // before it existed
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
  assert.deepEqual(goalStatus({ amount: 1000 }, 250, '2026-11-28'), { target: 1000, remaining: 750, share: 0.25, reached: false, perWeek: null, perMonth: null, weeksLeft: null, late: false });
  const dated = goalStatus({ amount: 1000, date: '2027-01-09' }, 250, '2026-11-28');
  assert.equal(dated.weeksLeft, 6);
  assert.equal(dated.perWeek, 125);
  assert.equal(dated.perMonth, 375); // two months left
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

test('pay and bills can fall on fixed days such as the 15th and the last day', () => {
  const twice = { monthDays: [15, 31] };
  assert.deepEqual(occurrences('2027-01-01', twice, '2027-01-20', '2027-03-16'), ['2027-01-31', '2027-02-15', '2027-02-28', '2027-03-15']);
  assert.deepEqual(occurrences('2027-01-01', { monthDays: [31] }, '2027-02-01', '2027-04-30'), ['2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(occurrences('2028-01-01', { monthDays: [31] }, '2028-02-01', '2028-02-29'), ['2028-02-29']); // leap year

  const loan = { nextDue: '2027-01-15', amount: 250, monthDays: [15, 31] };
  assert.equal(dueAfter(loan), '2027-01-31');
  assert.equal(dueAfter({ ...loan, nextDue: '2027-01-31' }), '2027-02-15');
  assert.equal(dueAfter({ ...loan, nextDue: '2027-02-15' }), '2027-02-28');
  assert.equal(billMonthly(loan), 500);
});

test('a pay schedule can end and a new one begin', () => {
  const paychecks = [
    { name: 'Old', amount: 2430.4, nextDate: '2026-11-27', days: 14, ends: '2026-12-31' },
    { name: 'New', amount: 2600, monthDays: [15, 31], starts: '2027-01-01' },
    { name: 'Hers', amount: 1020, monthDays: [31] },
  ];
  const plan = paycheckPlan(paychecks, [{ id: 'rent', name: 'Rent', amount: 2145, nextDue: '2027-01-01', every: 1 }], '2026-12-20', 50);
  assert.deepEqual(plan.map((p) => [p.from, p.amount, p.names.join('+')]), [
    ['2026-12-11', 2430.4, 'Old'],
    ['2026-12-25', 2430.4, 'Old'],
    ['2026-12-31', 1020, 'Hers'],
    ['2027-01-15', 2600, 'New'],
    ['2027-01-31', 3620, 'New+Hers'],
  ]);
  assert.deepEqual(plan[2].bills.map((b) => b.name), ['Rent']); // her month-end pay covers rent on the 1st
});

test('the budget can be looked at a month at a time', () => {
  assert.deepEqual(periodOf('2026-11-28', 'week'), { start: '2026-11-27', end: '2026-12-03' });
  assert.deepEqual(periodOf('2026-11-28', 'month'), { start: '2026-11-01', end: '2026-11-30' });
  assert.deepEqual(periodOf('2028-02-10', 'month'), { start: '2028-02-01', end: '2028-02-29' });

  // The same data as the weekly tests above, seen as the month of November.
  const nov = budgetFor(data, '2026-11-01', '2026-11-30');
  assert.equal(nov.leftToAssign, 1150); // 1500 income, 350 assigned
  assert.deepEqual(nov.rows.get('groc'), { assigned: 300, assignedMonth: 300, spent: 210, available: 90 });
  assert.equal(nov.incomeThisWeek, 1500);

  // A monthly assignment dated the 1st counts for that whole month, and
  // shows up in whichever week holds the 1st when looking week by week.
  const more = { ...data, assignments: [...data.assignments, { week: '2026-12-01', envelopeId: 'gas', amount: 80 }] };
  assert.equal(budgetFor(more, '2026-11-01', '2026-11-30').rows.get('gas').available, 50);
  assert.equal(budgetFor(more, '2026-12-01', '2026-12-31').rows.get('gas').assigned, 80);
  assert.equal(budgetFor(more, '2026-12-01', '2026-12-31').rows.get('gas').available, 130);
  assert.equal(budgetFor(more, '2026-11-27').rows.get('gas').assigned, 80);
});

test('spots regular payments that are not bills yet', () => {
  const tx = (id, date, payee, amount, extra = {}) => ({ id, date, payee, amount, envelopeId: '', ...extra });
  const txs = [
    tx('n1', '2026-09-24', 'NETFLIX.COM', -8.99, { plaidId: 'p1', accountId: 'chk' }), tx('n2', '2026-10-24', 'Netflix.com', -8.99, { plaidId: 'p2', accountId: 'chk', envelopeId: 'subs' }),
    tx('u1', '2026-09-01', 'GEORGIA POWER', -141.2), tx('u2', '2026-10-02', 'GEORGIA POWER', -160.02), tx('u3', '2026-11-01', 'GEORGIA POWER', -118.4),
    tx('g1', '2026-11-06', 'KROGER #432', -84), tx('g2', '2026-11-13', 'KROGER #432', -112.5), tx('g3', '2026-11-20', 'KROGER #432', -97.1), // weekly but varying: shopping
    tx('w1', '2026-10-05', 'WATER DEPT', -40), tx('w2', '2026-11-04', 'WATER DEPT', -55), // only two, and they differ
    tx('r1', '2026-10-01', 'FIRSTKEY HOMES', -2145), tx('r2', '2026-11-01', 'FIRSTKEY HOMES', -2145), // already a bill
    tx('y1', '2026-10-10', 'GYM', -35), tx('y2', '2026-11-10', 'GYM', -35), // dismissed
    tx('t1', '2026-10-15', 'To Savings', -100, { envelopeId: 'transfer' }), tx('t2', '2026-11-15', 'To Savings', -100, { envelopeId: 'transfer' }),
    tx('l1', '2026-10-30', 'EARNEST', -249.52), tx('l2', '2026-11-13', 'EARNEST', -249.52), tx('l3', '2026-11-27', 'EARNEST', -249.52),
    tx('i1', '2026-10-03', 'Paycheck', 2000, { envelopeId: 'income' }), tx('i2', '2026-11-03', 'Paycheck', 2000, { envelopeId: 'income' }),
  ];
  const bills = [{ name: 'Rent', payTo: 'FirstKey Homes', envelopeId: 'rent', nextDue: '2026-12-01' }];
  const found = suggestBills(txs, bills, ['GYM'], '2026-11-28');
  assert.deepEqual(found.map((f) => [f.name, f.amount, f.label, f.nextDue, f.variable]), [
    ['EARNEST', 249.52, 'every 2 weeks', '2026-12-11', false],
    ['GEORGIA POWER', 139.87, 'every month', '2026-12-01', true],
    ['Netflix.com', 8.99, 'every month', '2026-12-24', false],
  ]);
  const netflix = found[2];
  assert.equal(netflix.envelopeId, 'subs');
  assert.equal(netflix.accountId, 'chk');
  assert.equal(netflix.fromBank, true);
  // A bill with a matching name covers it, even if the bank words it differently.
  assert.equal(suggestBills(txs, [...bills, { name: 'Netflix', nextDue: '2026-12-24' }], [], '2026-11-28').some((f) => f.name === 'Netflix.com'), false);
  // Once it has a bill on the same envelope, it stops being suggested.
  assert.equal(suggestBills(txs, [...bills, { name: 'Streaming', envelopeId: 'subs', nextDue: '2026-12-24' }], [], '2026-11-28').some((f) => f.name === 'Netflix.com'), false);
});

test('notices when a regular payment changes price', () => {
  const tx = (date, payee, amount) => ({ date, payee, amount, envelopeId: 'x' });
  const txs = [
    tx('2026-08-24', 'NETFLIX.COM', -8.99), tx('2026-09-24', 'NETFLIX.COM', -8.99), tx('2026-10-24', 'NETFLIX.COM', -8.99), tx('2026-11-24', 'NETFLIX.COM', -9.99),
    tx('2026-09-02', 'AT&T', -259.12), tx('2026-10-02', 'AT&T', -259.12), tx('2026-11-02', 'AT&T', -184.39),
    tx('2026-09-01', 'POWER CO', -141), tx('2026-10-01', 'POWER CO', -160), tx('2026-11-01', 'POWER CO', -118), // always varies
    tx('2026-09-18', 'SPOTIFY', -11.99), tx('2026-10-18', 'SPOTIFY', -11.99), tx('2026-11-18', 'SPOTIFY', -11.99), // unchanged
    tx('2026-05-10', 'OLD GYM', -30), tx('2026-06-10', 'OLD GYM', -30), tx('2026-07-10', 'OLD GYM', -35), // long ago
  ];
  assert.deepEqual(priceChanges(txs, '2026-11-28'), [
    { name: 'AT&T', was: 259.12, now: 184.39, change: -74.73, date: '2026-11-02' },
    { name: 'NETFLIX.COM', was: 8.99, now: 9.99, change: 1, date: '2026-11-24' },
  ]);
});

test('net worth is cash in accounts minus what is owed', () => {
  const accounts = [{ id: 'chk', type: 'checking', startBalance: 1000 }, { id: 'sav', type: 'savings', startBalance: 250 }, { id: 'card', type: 'credit', startBalance: -400 }];
  const txs = [{ date: '2026-11-10', accountId: 'chk', amount: -200, envelopeId: 'loan' }, { date: '2026-11-11', accountId: 'card', amount: -50, envelopeId: 'groc' }];
  const debts = [{ balance: 5000, asOf: '2026-11-01', envelopeId: 'loan' }, { balance: 400 }];
  assert.deepEqual(netWorth(accounts, txs, debts), { cash: 1050, owed: 5200, net: -4150 });
});

test('counts pay that is expected but has not arrived yet', () => {
  const paychecks = [
    { name: 'Church', amount: 2430.4, nextDate: '2026-11-27', days: 14 },
    { name: 'Schools', amount: 1020, monthDays: [31] },
    { name: 'Next year', amount: 2600, monthDays: [15, 31], starts: '2027-01-01' },
    { name: 'No amount', amount: 0, nextDate: '2026-12-01', days: 7 },
  ];
  // Looking at December on Dec 10, with nothing received yet this month.
  assert.deepEqual(expectedIncome(paychecks, [], '2026-12-01', '2026-12-31', '2026-12-10'), [
    { date: '2026-12-11', name: 'Church', amount: 2430.4 },
    { date: '2026-12-25', name: 'Church', amount: 2430.4 },
    { date: '2026-12-31', name: 'Schools', amount: 1020 },
  ]);

  // On payday itself it's still expected until the deposit shows up...
  assert.equal(expectedIncome(paychecks, [], '2026-12-01', '2026-12-31', '2026-12-11').length, 3);
  // ...and once it has (a day late, a few cents different), it no longer is.
  const deposit = { id: 'd1', date: '2026-12-12', amount: 2430.32, envelopeId: 'income' };
  assert.deepEqual(expectedIncome(paychecks, [deposit], '2026-12-01', '2026-12-31', '2026-12-12').map((e) => e.date), ['2026-12-25', '2026-12-31']);
  // One deposit only answers for one payday.
  const two = [{ name: 'A', amount: 500, nextDate: '2026-12-11', days: 14 }, { name: 'B', amount: 500, nextDate: '2026-12-11', days: 14 }];
  assert.equal(expectedIncome(two, [{ id: 'x', date: '2026-12-11', amount: 500, envelopeId: 'income' }], '2026-12-01', '2026-12-20', '2026-12-11').length, 1);
  // A deposit that isn't filed as income yet doesn't count as arrived.
  assert.equal(expectedIncome(paychecks, [{ ...deposit, envelopeId: '' }], '2026-12-01', '2026-12-31', '2026-12-12').length, 3);
  // A payday well past with nothing to show for it is dropped, not carried.
  assert.deepEqual(expectedIncome(paychecks, [], '2026-12-01', '2026-12-31', '2026-12-20').map((e) => e.date), ['2026-12-25', '2026-12-31']);
  // A week with no payday in it expects nothing.
  assert.deepEqual(expectedIncome(paychecks, [], '2026-12-04', '2026-12-10', '2026-12-04'), []);
});
