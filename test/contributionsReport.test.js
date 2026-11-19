// Combined contributions report: pure functions, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContributionsReport, formatReport, monthPredicate, regimeGroup } from '../src/contributionsReport.js';

const BASES = `
Régimen: TRABAJADOR AUTONOMO Empresa/Razón Social: Régimen Especial de Trab. Autónomo
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2025 --- --- 500,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00
Régimen: GENERAL Empresa/Razón Social: EXAMPLE COMPANY, S.L. CCC: 00000000000
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2025 2.000,00 2.000,00 2.000,00 --- --- --- --- ---
`;
const q = (month, extra = {}) => ({
  month, status: 'ok', regime: '0111', ccc: '00000000000', employer: 'EXAMPLE COMPANY, S.L.', liquidationType: 'L00-NORMAL',
  base: 2000, workerQuota: 130, employerQuota: 600, total: 730, liquidation: null, source: `calc-${month}.txt`, ...extra,
});
const QUOTAS = [
  q('2025-01'),
  q('2025-02', { liquidation: 'liq1', base: 1500 }),
  q('2025-02', { liquidation: 'liq2', liquidationType: 'L13-ATRASOS', base: 500, workerQuota: 30, employerQuota: 150 }),
  q('2025-03', { base: 1800 }), // mismatch vs bases report 2.000,00
];
const r = (month, quota, base = 1000) => ({ month, regime: 'RETA', base, quota, surcharge: 0, interest: null, total: quota, source: `paid-${month}.txt` });
const PAID = [r('2025-03', 300), r('2025-04', 300), r('2025-05', 80), r('2025-06', 80), r('2025-07', 300)]; // 2025-08 missing
const NOW = new Date(2025, 9, 10); // last month = 2025-09

test('payments: one entry per month, liquidation and payer', () => {
  const rep = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now: NOW });
  assert.equal(rep.payments.length, 4 * 2 + 5);
  const liq2 = rep.payments.find((p) => p.period === '2025-02' && p.liquidationNumber === 2 && p.payerType === 'employer');
  assert.deepEqual([liq2.year, liq2.month, liq2.regime, liq2.payerName, liq2.ccc, liq2.channel, liq2.liquidationType, liq2.amount],
    [2025, 2, 'GENERAL', 'EXAMPLE COMPANY, S.L.', '00000000000', 'employer settlement', 'L13', 150]);
  const w = rep.payments.find((p) => p.period === '2025-01' && p.payerType === 'worker');
  assert.equal(w.channel, 'payroll withholding');
  assert.equal(w.payerName, 'self');
  const reta = rep.payments.find((p) => p.period === '2025-04');
  assert.deepEqual([reta.regime, reta.channel, reta.amount, reta.surcharge, reta.sourceReport], ['RETA', 'direct payment', 300, 0, 'paid-contributions']);
  assert.equal(rep.payments[0].id, 1);
});

test('aggregates, gaps and notes', () => {
  const rep = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now: NOW });
  const a = rep.aggregates;
  assert.equal(a.grand.total, 130 * 3 + 30 + 600 * 3 + 150 + 300 * 3 + 80 * 2);
  assert.equal(a.byPayerType.find((g) => g.payerType === 'employer').total, 1950);
  assert.equal(a.byPayer.find((g) => g.channel === 'direct payment').total, 1060);
  assert.equal(a.byRegime.find((g) => g.regime === 'RETA').months, 5);
  assert.equal(a.byYear[0].year, 2025);
  assert.ok(a.byYearPayer.length >= 3);
  // 2025-08 is in the bases report but not paid; 2025-09 is last month (registration still active).
  assert.deepEqual(rep.gaps.map((g) => [g.period, g.regime]), [['2025-08', 'RETA'], ['2025-09', 'RETA']]);
  assert.match(rep.gaps[1].reason, /last month/);
  const types = rep.notes.map((n) => `${n.period}:${n.type}`);
  assert.ok(types.includes('2025-03:base-mismatch')); // GENERAL 1800 vs 2000 and RETA 1000 vs 500
  assert.equal(rep.notes.filter((n) => n.type === 'base-mismatch').length, 2);
  assert.ok(!types.includes('2025-02:base-mismatch')); // L00 + L13 add up to the bases report base
  assert.ok(types.includes('2025-05:reduced-quota'));
  assert.equal(rep.notes.find((n) => n.type === 'reduced-quota').periodTo, '2025-06');
  assert.ok(types.includes('undefined:multiple-activity') || rep.notes.some((n) => n.type === 'multiple-activity'));
});

test('filters: ranges/months union and payer', () => {
  const rep = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now: NOW, filter: { ranges: ['01/2025-01/2025'], months: ['2025-04'], payer: 'worker' } });
  assert.deepEqual(rep.payments.map((p) => `${p.period}/${p.payerType}`), ['2025-01/worker', '2025-04/worker']);
  assert.equal(rep.gaps.length, 0);
  const emp = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, now: NOW, filter: { payer: 'employer', payerName: 'example' } });
  assert.ok(emp.payments.every((p) => p.payerType === 'employer'));
  assert.equal(monthPredicate({})('1999-01'), true);
  assert.throws(() => monthPredicate({ ranges: ['bad'] }));
  assert.equal(regimeGroup('0521'), 'RETA');
  assert.equal(regimeGroup('0111'), 'GENERAL');
});

test('formatReport: compact by default, payments on request', () => {
  const rep = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now: NOW });
  const short = formatReport(rep, { filePath: '/absolute/path/to/report.json' });
  assert.match(short, /GRAND TOTAL: 3430\.00/);
  assert.match(short, /E1=EXAMPLE COMPANY, S\.L\. \(CCC 00000000000\)/);
  assert.match(short, /gaps \(2\)/);
  assert.doesNotMatch(short, /^payments:/m);
  const long = formatReport(rep, { includePayments: true, groupBy: ['all'] });
  assert.match(long, /^payments:/m);
  assert.match(long, /^month worker employer$/m);
});

test('via / viaType on every entry', async () => {
  const { viaOf } = await import('../src/contributionsReport.js');
  assert.deepEqual(viaOf({ payerType: 'worker', channel: 'payroll withholding', employer: 'EXAMPLE COMPANY, S.L.' }), { via: 'EXAMPLE COMPANY, S.L.', viaType: 'employer' });
  assert.deepEqual(viaOf({ payerType: 'worker', channel: 'direct payment', employer: null }), { via: 'self-employed', viaType: 'self-employed' });
  assert.deepEqual(viaOf({ payerType: 'public_agency', payerName: 'SEPE' }), { via: 'SEPE', viaType: 'public_agency' });
  const rep = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now: NOW });
  assert.ok(rep.payments.every((p) => p.via && p.viaType));
  assert.ok(rep.payments.filter((p) => p.regime === 'GENERAL').every((p) => p.via === 'EXAMPLE COMPANY, S.L.'));
});

test('RETA annual regularisation: claim, refund, base status and notes', () => {
  const now = new Date(2026, 10, 16); // 2025 can already be regularised
  const base = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now });
  // No result saved: provisional bases and a pending note.
  assert.ok(base.payments.filter((p) => p.regime === 'RETA').every((p) => p.baseStatus === 'provisional'));
  assert.equal(base.notes.find((n) => n.type === 'regularization-pending').year, 2025);

  const claim = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now,
    regularizationRecords: [{ year: 2025, status: 'claim', amount: 250.5, dueDate: '2026-12-31', months: [{ period: '2025-03' }], source: 'reg-2025.txt' }] });
  const e = claim.payments.find((p) => p.sourceReport === 'reta-regularization');
  assert.deepEqual([e.payerType, e.payerName, e.channel, e.amount, e.month, e.periodFrom, e.periodTo, e.via, e.viaType, e.liquidationType, e.dueDate],
    ['worker', 'self', 'regularization payment', 250.5, null, '2025-03', '2025-07', 'self-employed', 'self-employed', 'REGULARIZATION', '2026-12-31']);
  assert.equal(claim.payments.find((p) => p.period === '2025-03' && p.regime === 'RETA' && p.month !== null).baseStatus, 'superseded');
  assert.equal(claim.payments.find((p) => p.period === '2025-04' && p.regime === 'RETA').baseStatus, 'definitive');
  assert.equal(round(claim.aggregates.grand.total - base.aggregates.grand.total), 250.5);
  assert.ok(!claim.notes.some((n) => n.type === 'regularization-pending'));
  assert.equal(claim.notes.find((n) => n.type === 'reta-regularization').status, 'claim');

  const refund = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now,
    regularizationRecords: [{ year: 2025, status: 'refund', amount: 100, refundDate: '2026-04-15', months: [], source: 'reg-2025.txt' }] });
  const r = refund.payments.find((p) => p.sourceReport === 'reta-regularization');
  assert.deepEqual([r.payerType, r.payerName, r.channel, r.amount, r.total, r.via], ['public_agency', 'TGSS', 'regularization refund', -100, -100, 'self-employed']);
  assert.ok(refund.payments.filter((p) => p.regime === 'RETA' && p.month !== null).every((p) => p.baseStatus === 'superseded'));
  assert.equal(round(refund.aggregates.grand.total - base.aggregates.grand.total), -100);
  assert.equal(buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now, filter: { payer: 'public_agency' },
    regularizationRecords: [{ year: 2025, status: 'refund', amount: 100 }] }).aggregates.grand.total, -100);

  const none = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now, regularizationRecords: [{ year: 2025, status: 'no-difference', amount: 0 }] });
  assert.ok(none.payments.filter((p) => p.regime === 'RETA').every((p) => p.baseStatus === 'definitive'));
  assert.equal(none.aggregates.grand.total, base.aggregates.grand.total);
});
const round = (n) => Math.round(n * 100) / 100;

test('RETA regularisation reconciled per month with the paid contributions report', () => {
  const now = new Date(2026, 10, 16);
  const base = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now });
  const months = [
    { period: '2025-05', provisionalQuota: 80, definitiveQuota: 80, difference: 0 },
    { period: '2025-06', provisionalQuota: 50, definitiveQuota: 80, difference: 30 }, // paid report shows 80: already included
    { period: '2025-07', provisionalQuota: 300, definitiveQuota: 310, difference: 10 }, // paid report shows 300: not yet included
  ];
  // Fully reflected: no extra entry, the total is unchanged and the month is annotated.
  const full = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now,
    regularizationRecords: [{ year: 2025, status: 'claim', amount: 30, signedAmount: 30, months: months.slice(0, 2) }] });
  assert.equal(full.aggregates.grand.total, base.aggregates.grand.total);
  assert.ok(!full.payments.some((p) => p.sourceReport === 'reta-regularization'));
  const jun = full.payments.find((p) => p.period === '2025-06' && p.regime === 'RETA');
  assert.deepEqual([jun.baseStatus, jun.regularization.includedDifference, jun.regularization.provisionalQuota], ['regularised', 30, 50]);
  assert.equal(full.payments.find((p) => p.period === '2025-05' && p.regime === 'RETA').baseStatus, 'definitive');
  const note = full.notes.find((n) => n.type === 'reta-regularization');
  assert.deepEqual([note.paymentStatus, note.includedInPaid, note.remainder], ['paid', 30, 0]);
  assert.match(note.message, /claim 30\.00, already reflected in paid report \(Jun 2025 quota 80\.00\)/);
  assert.match(full.notes.find((n) => n.type === 'regularised-month').message, /includes \+30\.00 RETA 2025 regularisation \(provisional 50\.00\)/);

  // Partly reflected: only the remainder (10) becomes an entry.
  const part = buildContributionsReport({ quotaRecords: QUOTAS, paidRecords: PAID, basesText: BASES, now,
    regularizationRecords: [{ year: 2025, status: 'claim', amount: 40, signedAmount: 40, months }] });
  const e = part.payments.find((p) => p.sourceReport === 'reta-regularization');
  assert.equal(e.amount, 10);
  assert.equal(round(part.aggregates.grand.total - base.aggregates.grand.total), 10);
  assert.equal(part.payments.find((p) => p.period === '2025-07' && p.regime === 'RETA').baseStatus, 'superseded');
  assert.equal(part.notes.find((n) => n.type === 'reta-regularization').paymentStatus, 'partly reflected');
});
