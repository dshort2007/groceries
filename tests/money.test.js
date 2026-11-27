// Checks the budgeting math. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, addDays, budgetFor, payoffPlan, readBankCsv, parseCsv, payeeKey } from '../js/money.js';

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
