// Combined report of every Social Security contribution paid by the worker or his employers.
// Built from data the other tools already saved (no browser by default):
//   - quota calculations ("Consulta de cálculos de cuotas para trabajador"), employee months:
//     per liquidation, the worker share (withheld from the payroll) and the employer share;
//   - paid contributions report ("Informe de cuotas ingresadas"), self-employed (RETA) months:
//     paid directly by the worker;
//   - contribution bases report ("Informe de bases de cotización"): expected months and the
//     base of each month, used for gaps and data-quality notes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR, today, launchChrome, log } from './importass.js';
import { fileName } from './paths.js';
import { loadContributionBases } from './basesReport.js';
import { loadWorkHistory } from './workHistoryPage.js';
import { summarizeSepe } from './sepe.js';
import { summarizeRegularization } from './regularization.js';
import { toParsedBases, employeeMonths } from './basesParser.js';
import { parseRanges, normalizeMonth } from './quotaParser.js';
import { summarizeQuotaSnapshots, fetchQuotaCalculations } from './quotas.js';
import { summarizePaidContributions, retaMonthsFromBases, fetchPaidContributions } from './paidQuotas.js';

export const REPORT_PREFIX = 'combined-report';
export const REPORT_VERSION = 1;
const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const BASE_TOLERANCE = 0.01;
const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };

/** Regime code/name → GENERAL | RETA | other short code. */
export function regimeGroup(code) {
  const t = String(code || '').trim();
  if (!t) return null;
  if (/aut[óo]nom|\bRETA\b|cuenta propia|^0?521\b/i.test(t)) return 'RETA';
  if (/general|^0?1\d{2}\b/i.test(t)) return 'GENERAL';
  return t;
}

/** "L00-NORMAL" → { type: 'L00', label: 'NORMAL' }. */
function splitLiquidationType(s) {
  const m = /^\s*(L\d{2})\s*[-–:]?\s*(.*)$/i.exec(String(s || ''));
  return m ? { type: m[1].toUpperCase(), label: m[2].trim() || null } : { type: s || null, label: null };
}

/** Pure: month filter (union of ranges, from/to and months); no filter → everything. */
export function monthPredicate({ from, to, ranges, months } = {}) {
  const groups = parseRanges(ranges);
  const lo = normalizeMonth(from); const hi = normalizeMonth(to);
  if (lo || hi) groups.push({ from: lo, to: hi });
  const set = new Set((months || []).flatMap((x) => String(x).split(/[,;\s]+/)).filter(Boolean).map(normalizeMonth));
  if (!groups.length && !set.size) return () => true;
  return (period) => set.has(period) || groups.some((g) => (!g.from || period >= g.from) && (!g.to || period <= g.to));
}

/**
 * Pure: builds the report object.
 * input: { quotaRecords (summarizeQuotaSnapshots().records), paidRecords (summarizePaidContributions().records),
 *          basesText (optional), now (Date), filter: { from, to, ranges, months, payer: all|worker|employer, payerName } }
 * Returns the JSON report (see README "Contributions report").
 */
export function viaOf(p) {
  if (p.sourceReport === 'reta-regularization') return { via: 'self-employed', viaType: 'self-employed' };
  if (p.payerType === 'public_agency') return { via: p.payerName || 'SEPE', viaType: 'public_agency' };
  if (p.employer || p.ccc) return { via: p.employer || p.ccc, viaType: 'employer' };
  if (p.payerType === 'employer') return { via: p.payerName || null, viaType: 'employer' };
  return { via: 'self-employed', viaType: 'self-employed' };
}

export function buildContributionsReport({ quotaRecords = [], paidRecords = [], sepeRecords = [], benefitPeriods = [], regularizationRecords = [], bases = null, basesText = null, now = new Date(), filter = {}, sources = {} } = {}) {
  const inSel = monthPredicate(filter);
  const payerOk = (p) => (!filter.payer || filter.payer === 'all' || p.payerType === filter.payer)
    && (!filter.payerName || String(p.payerName || '').toLowerCase().includes(String(filter.payerName).toLowerCase())
      || String(p.employer || '').toLowerCase().includes(String(filter.payerName).toLowerCase()));
  const lastMonth = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })();

  // Bases report: expected months and bases per (month, CCC) and per RETA month.
  // bases: the full bases JSON (preferred); basesText: report text (tests / old callers).
  const parsedBases = toParsedBases(bases ?? basesText);
  const empMonths = parsedBases ? employeeMonths(parsedBases) : [];
  const empBase = new Map(); // `${period}|${ccc}` → base
  for (const m of empMonths) for (const e of m.employers) empBase.set(`${m.label}|${e.ccc || e.employer}`, e.base);
  const provisional = new Set();
  if (parsedBases) for (const s of parsedBases.sections) for (const m of s.months) if (m.provisional) provisional.add(`${m.year}-${pad(m.month)}`);
  const reta = parsedBases ? retaMonthsFromBases(parsedBases, { now }) : { months: [] };
  const retaBase = new Map();
  if (parsedBases) for (const s of parsedBases.sections) if (s.selfEmployed) for (const m of s.months) if (m.base !== null) retaBase.set(`${m.year}-${pad(m.month)}`, m.base);

  const payments = [];
  const notes = [];
  const gaps = [];
  const add = (p) => {
    const [y, mo] = p.period.split('-').map(Number);
    payments.push({ year: y, month: mo, ...p, total: round2((p.amount || 0) + (p.surcharge || 0)) });
  };

  // 1) Employee months: one entry per liquidation and payer.
  const quotaByMonth = new Map();
  for (const r of quotaRecords) {
    if (!quotaByMonth.has(r.month)) quotaByMonth.set(r.month, []);
    quotaByMonth.get(r.month).push(r);
    if (r.status !== 'ok') {
      if (inSel(r.month)) notes.push({ type: 'quota-not-ok', period: r.month, message: `quota calculation ${r.status}${r.liquidation ? ` (${r.liquidation})` : ''}`, sourceFile: r.source });
      continue;
    }
    const liqNumber = r.liquidation ? Number(String(r.liquidation).replace(/\D/g, '')) || 1 : 1;
    const { type, label } = splitLiquidationType(r.liquidationType);
    const common = {
      period: r.month, regime: regimeGroup(r.regime) || 'GENERAL', regimeCode: r.regime || null,
      employer: r.employer || null, ccc: r.ccc || null,
      liquidationNumber: liqNumber, liquidationType: type, liquidationLabel: label,
      base: r.base ?? null, basesReportBase: empBase.get(`${r.month}|${r.ccc || r.employer}`) ?? null,
      surcharge: null, sourceReport: 'quota-calculations', sourceFile: r.source || null,
    };
    if (r.workerQuota !== null && r.workerQuota !== undefined) add({ ...common, payerType: 'worker', payerName: 'self', channel: 'payroll withholding', amount: r.workerQuota });
    if (r.employerQuota !== null && r.employerQuota !== undefined) add({ ...common, payerType: 'employer', payerName: r.employer || null, channel: 'employer settlement', amount: r.employerQuota });
  }

  // 2) Self-employed months: paid directly by the worker.
  const paidByMonth = new Map();
  for (const r of paidRecords) {
    if (!paidByMonth.has(r.month)) paidByMonth.set(r.month, []);
    paidByMonth.get(r.month).push(r);
    const n = paidByMonth.get(r.month).length;
    add({
      period: r.month, regime: regimeGroup(r.regime) || 'RETA', regimeCode: r.regime || null,
      payerType: 'worker', payerName: 'self', employer: null, ccc: null, channel: 'direct payment',
      liquidationNumber: n, liquidationType: null, liquidationLabel: null,
      base: r.base ?? null, basesReportBase: retaBase.get(r.month) ?? null,
      amount: r.quota ?? 0, surcharge: round2((r.surcharge || 0) + (r.interest || 0)),
      paymentDate: r.paymentDate || null, paymentStatus: r.status || null,
      sourceReport: 'paid-contributions', sourceFile: r.source || null,
    });
  }

  // 2b) SEPE: the worker share of the contributions deducted by SEPE from unemployment benefits
  //     (certificate totals per year or period; no monthly breakdown in the certificates).
  //     Annual certificates are used; a period certificate only for years without an annual one.
  const benefitMonths = new Map(); // 'YYYY-MM' → benefit period kind (from the work history report)
  for (const bp of benefitPeriods) for (const m of bp.months) benefitMonths.set(m, bp.kind);
  const annualYears = new Set(sepeRecords.filter((r) => r.kind === 'annual' && r.status === 'ok').map((r) => r.year));
  const inRange = (from, to) => { for (let m = from; m && m <= to; m = nextPeriod(m)) if (inSel(m)) return true; return false; };
  for (const r of sepeRecords) {
    if (r.status !== 'ok' || !r.ssDeduction) continue;
    if (r.kind !== 'annual' && r.year && annualYears.has(r.year)) {
      if (inRange(r.periodFrom, r.periodTo)) notes.push({ type: 'sepe-period-certificate', period: r.periodFrom, periodTo: r.periodTo, message: `SEPE ${r.kind} certificate ${r.periodFrom}..${r.periodTo}: gross ${r.gross}, IRPF ${r.irpf ?? 0}, SS deducted ${r.ssDeduction} (already included in the annual certificate)`, sourceFile: r.source });
      continue;
    }
    const months = [...benefitMonths.keys()].filter((m) => m >= r.periodFrom && m <= r.periodTo).sort();
    const from = months[0] || r.periodFrom; const to = months.at(-1) || r.periodTo;
    payments.push({
      year: Number(from.slice(0, 4)), month: null, period: from, periodFrom: from, periodTo: to,
      regime: 'GENERAL', regimeCode: 'SEPE', payerType: 'public_agency', payerName: 'SEPE', employer: null, ccc: null,
      channel: 'deducted from unemployment benefit', liquidationNumber: 1, liquidationType: `SEPE ${r.kind} certificate`, liquidationLabel: r.benefitType,
      base: null, basesReportBase: null, amount: r.ssDeduction, surcharge: null, total: r.ssDeduction,
      grossBenefit: r.gross, irpfWithheld: r.irpf, netBenefit: r.net, benefitOverlap: months.length ? [...new Set(months.map((m) => benefitMonths.get(m)))].join(',') : null,
      sourceReport: 'sepe-benefits', sourceFile: r.source,
    });
  }
  // Benefit periods (ERTE etc.) from the work history report: flag the overlapping entries.
  for (const p of payments) if (p.month !== null && benefitMonths.has(p.period)) p.benefitOverlap = benefitMonths.get(p.period);
  for (const bp of benefitPeriods) {
    const ms = bp.months.filter(inSel);
    if (!ms.length) continue;
    const sepeCovered = payments.some((p) => p.payerType === 'public_agency' && p.periodFrom <= ms.at(-1) && p.periodTo >= ms[0]);
    notes.push({
      type: 'benefit-period', period: ms[0], periodTo: ms.at(-1), kind: bp.kind,
      message: `${bp.kind === 'erte-suspension' ? 'ERTE (contract suspended, unemployment benefit)' : bp.kind === 'erte-reduction' ? 'ERTE (reduced hours, partial benefit)' : 'unemployment benefit'} ${bp.from}..${bp.to}${bp.days ? ` (${bp.days} days)` : ''} per the work history report; months ${ms.join(',')}`
        + (sepeCovered ? '; SEPE deductions included' : '; no SEPE certificate saved for it (fetch-sepe)'),
    });
  }

  // 2c) RETA annual regularisation (art. 308.1.c LGSS). Per year with a claim (worker pays the difference,
  //     positive) or a refund (TGSS returns it, negative), reconciled PER MONTH against the paid contributions
  //     report when the resolution's monthly table is available: if a month's paid quota already equals the
  //     definitive quota, the difference is already included there (no extra entry; the month is annotated).
  //     Only the unreconciled remainder becomes a separate entry. Monthly RETA entries get baseStatus:
  //     'regularised' (paid quota = definitive quota, difference included), 'superseded' (provisional quota
  //     adjusted by a difference not yet in the paid report), 'definitive' (no difference) or 'provisional'
  //     (no result saved yet, years from 2023).
  const regByYear = new Map(regularizationRecords.filter((r) => r && r.year).map((r) => [Number(r.year), r]));
  const retaByYear = new Map();
  for (const p of payments) if (p.regime === 'RETA' && p.month !== null) (retaByYear.get(p.year) || retaByYear.set(p.year, []).get(p.year)).push(p);
  const lastYear = now.getFullYear() - 1;
  const reconciliation = new Map(); // year → { remainder, included: [{period, difference, paid, provisionalQuota, definitiveQuota}], open: [...] }
  for (const [year, list] of retaByYear) {
    if (year < 2023) continue;
    const r = regByYear.get(year);
    const known = r && r.status !== 'unknown' && r.status !== 'pending';
    const adjusting = known && (r.status === 'claim' || r.status === 'refund');
    const table = adjusting && Array.isArray(r.months) ? r.months.filter((m) => m.difference != null && m.definitiveQuota != null) : [];
    const rec = { remainder: null, included: [], open: [] };
    if (table.length) {
      rec.remainder = 0;
      for (const m of table) {
        const rows = list.filter((p) => p.period === m.period);
        const paid = round2(rows.reduce((a, p) => a + (p.amount || 0), 0));
        const diff = Number(m.difference) || 0;
        if (Math.abs(diff) < 0.005) { rows.forEach((p) => { p.baseStatus = 'definitive'; }); continue; }
        if (rows.length && Math.abs(paid - m.definitiveQuota) < 0.01) {
          rec.included.push({ period: m.period, difference: diff, paid, provisionalQuota: m.provisionalQuota, definitiveQuota: m.definitiveQuota });
          notes.push({ type: 'regularised-month', period: m.period, regime: 'RETA', year, difference: diff, provisionalQuota: m.provisionalQuota, definitiveQuota: m.definitiveQuota,
            message: `regularised: paid quota ${paid.toFixed(2)} = definitive quota, includes ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} RETA ${year} regularisation (provisional ${Number(m.provisionalQuota).toFixed(2)})` });
          rows.forEach((p) => { p.baseStatus = 'regularised'; p.regularization = { year, includedDifference: diff, provisionalQuota: m.provisionalQuota, definitiveQuota: m.definitiveQuota }; p.regularizationYear = year; });
        } else {
          rec.remainder = round2(rec.remainder + diff);
          rec.open.push({ period: m.period, difference: diff, paid: rows.length ? paid : null, provisionalQuota: m.provisionalQuota, definitiveQuota: m.definitiveQuota });
          rows.forEach((p) => { p.baseStatus = 'superseded'; p.regularizationYear = year; });
        }
      }
      for (const p of list) if (!p.baseStatus) p.baseStatus = 'definitive'; // months outside the table are not regularised
      // Rounding or months missing from the table: keep the resolution total authoritative.
      const total = r.signedAmount ?? (r.status === 'refund' ? -Math.abs(r.amount || 0) : Math.abs(r.amount || 0));
      const tableSum = round2(table.reduce((a, m) => a + (Number(m.difference) || 0), 0));
      if (Math.abs(tableSum - total) >= 0.01) rec.remainder = round2(rec.remainder + (total - tableSum));
    } else {
      // Without a quota table, months listed in the record (if any) are the affected ones.
      const affected = adjusting && r.months && r.months.length ? new Set(r.months.map((m) => m.period)) : null;
      for (const p of list) {
        if (!known) p.baseStatus = 'provisional';
        else if (adjusting && (!affected || affected.has(p.period))) { p.baseStatus = 'superseded'; p.regularizationYear = year; }
        else p.baseStatus = 'definitive';
      }
    }
    reconciliation.set(year, rec);
    if (!known && year <= lastYear) {
      notes.push({ type: 'regularization-pending', period: `${year}-01`, periodTo: `${year}-12`, year, regime: 'RETA', status: r ? r.status : 'not-fetched',
        message: `RETA ${year}: provisional bases; no regularisation result saved${r && r.status === 'pending' ? ' (service shows it as pending)' : ''} (fetch-regularization)` });
    }
  }
  const eur = (n) => Number(n).toFixed(2);
  const monthName = (period) => new Date(Number(period.slice(0, 4)), Number(period.slice(5)) - 1, 1).toLocaleString('en-GB', { month: 'short' });
  for (const r of regByYear.values()) {
    const year = Number(r.year);
    const list = (retaByYear.get(year) || []).map((p) => p.period).sort();
    const from = list[0] || `${year}-01`; const to = list.at(-1) || `${year}-12`;
    const rec = reconciliation.get(year) || { remainder: null, included: [], open: [] };
    const signed = r.status === 'refund' ? -Math.abs(r.amount || 0) : Math.abs(r.amount || 0);
    // Amount still to add: the unreconciled remainder when a monthly table was reconciled, else the whole result.
    const amount = r.status === 'claim' || r.status === 'refund' ? round2(rec.remainder ?? signed) : 0;
    const includedTotal = round2(rec.included.reduce((a, m) => a + m.difference, 0));
    if (amount && Math.abs(amount) >= 0.01) {
      payments.push({
        year, month: null, period: from, periodFrom: from, periodTo: to, regime: 'RETA', regimeCode: 'RETA',
        payerType: amount < 0 ? 'public_agency' : 'worker', payerName: amount < 0 ? 'TGSS' : 'self', employer: null, ccc: null,
        channel: amount < 0 ? 'regularization refund' : 'regularization payment',
        liquidationNumber: 1, liquidationType: 'REGULARIZATION', liquidationLabel: `RETA annual regularisation ${year}${rec.included.length ? ' (remainder not in the paid report)' : ''}`,
        base: null, basesReportBase: null, amount, surcharge: null, total: amount,
        dueDate: r.dueDate || null, refundDate: r.refundDate || null, paymentStatus: null, netIncome: r.netIncome ?? null,
        sourceReport: 'reta-regularization', sourceFile: r.source || null,
      });
    }
    if (r.status !== 'unknown' && r.status !== 'pending') {
      // Payment status from evidence only: the paid contributions report shows the definitive quota.
      const reflected = rec.included.length > 0 && Math.abs(amount) < 0.01;
      const evidence = rec.included.map((m) => `${monthName(m.period)} ${m.period.slice(0, 4)} quota ${eur(m.paid)}`).join(', ');
      const paymentEvidence = rec.included.length ? `paid contributions report: ${evidence} = definitive quota (includes ${includedTotal >= 0 ? '+' : ''}${eur(includedTotal)})` : null;
      const paymentStatus = r.status === 'claim' || r.status === 'refund'
        ? (reflected ? (r.status === 'claim' ? 'paid' : 'refunded') : rec.included.length ? 'partly reflected' : 'not reflected in the paid report')
        : null;
      notes.push({ type: 'reta-regularization', period: from, periodTo: to, year, regime: 'RETA', status: r.status, amount: r.amount ?? null,
        signedAmount: r.status === 'claim' || r.status === 'refund' ? signed : 0,
        includedInPaid: includedTotal || 0, remainder: amount || 0, reconciledMonths: rec.included, openMonths: rec.open,
        dueDate: r.dueDate || null, refundDate: r.refundDate || null, resolutionDate: r.resolutionDate || null, paymentStatus, paymentEvidence, sourceFile: r.source || null,
        message: `RETA ${year} regularisation: ${r.status}${r.amount ? ` ${eur(r.amount)}` : ''}`
          + (reflected ? `, already reflected in paid report (${evidence})` : rec.included.length ? `, ${eur(includedTotal)} reflected in paid report (${evidence}), ${eur(amount)} added` : '')
          + (r.dueDate ? `, due ${r.dueDate}` : '') + (r.refundDate ? `, refunded ${r.refundDate}` : '') });
    }
  }
  // 3) Gaps: months expected from the bases report without any payment data.
  if (parsedBases) {
    for (const m of empMonths) {
      if (!inSel(m.label)) continue;
      const ok = (quotaByMonth.get(m.label) || []).some((r) => r.status === 'ok');
      if (!ok) gaps.push({ period: m.label, regime: 'GENERAL', employers: m.employers.map((e) => e.employer), reason: quotaByMonth.has(m.label) ? 'quota calculation without data' : 'employee month without quota calculation' });
    }
    for (const m of reta.months) {
      if (!inSel(m.label) || m.label > lastMonth) continue;
      if (paidByMonth.has(m.label)) continue;
      const reason = m.label === lastMonth ? 'last month: probably not yet processed in the paid contributions report'
        : retaBase.has(m.label) ? 'self-employed month missing from the paid contributions report'
          : 'self-employed month not yet in the paid contributions report (nor in the bases report)';
      gaps.push({ period: m.label, regime: 'RETA', reason });
    }
  }

  // 4) Data-quality notes.
  // Base mismatches: one check per (month, regime, CCC). For employee months the bases report base
  // should equal the normal liquidation's base or the sum of all liquidations of that month.
  const groupsForBase = new Map();
  for (const p of payments) {
    if (p.payerType !== 'worker' || !inSel(p.period) || p.basesReportBase === null || p.base === null) continue;
    const k = `${p.period}|${p.regime}|${p.ccc || ''}`;
    if (!groupsForBase.has(k)) groupsForBase.set(k, []);
    groupsForBase.get(k).push(p);
  }
  for (const list of groupsForBase.values()) {
    const ref = list[0].basesReportBase;
    const sum = round2(list.reduce((acc, q) => acc + (q.base || 0), 0));
    const matches = list.some((q) => Math.abs(q.base - ref) <= BASE_TOLERANCE) || Math.abs(sum - ref) <= BASE_TOLERANCE;
    if (matches) continue;
    const p = list[0];
    const what = p.sourceReport === 'paid-contributions' ? 'paid report base' : list.length > 1 ? `quota calculation bases ${list.map((q) => `${q.liquidationType || `liq${q.liquidationNumber}`} ${q.base}`).join(' + ')}` : 'quota calculation base';
    notes.push({
      type: 'base-mismatch', period: p.period, regime: p.regime, ...(p.ccc ? { ccc: p.ccc } : {}),
      message: `${what}${list.length > 1 || p.sourceReport === 'paid-contributions' ? '' : ` ${p.base}`}${p.sourceReport === 'paid-contributions' ? ` ${p.base}` : ''} vs bases report ${ref} (diff ${round2((list.length > 1 ? sum : p.base) - ref)})`
        + (benefitMonths.has(p.period) ? ` — within the ${benefitMonths.get(p.period)} benefit period (part of the month paid by SEPE)` : ''),
      sourceFile: p.sourceFile,
    });
  }
  for (const k of new Set(payments.filter((p) => inSel(p.period) && provisional.has(p.period)).map((p) => p.period))) {
    notes.push({ type: 'provisional-base', period: k, message: 'the bases report marks a base of this month as provisional (*)' });
  }
  // Reduced self-employed quota: quota/base well below the full rate of that year (highest ratio seen
  // in the year, or overall). Consecutive months with the same quota and base are grouped in one note.
  const retaPays = payments.filter((p) => p.sourceReport === 'paid-contributions' && p.base > 0 && inSel(p.period)).sort((x, y) => x.period.localeCompare(y.period));
  const maxAll = Math.max(0, ...retaPays.map((p) => p.amount / p.base));
  const maxByYear = new Map();
  for (const p of retaPays) maxByYear.set(p.year, Math.max(maxByYear.get(p.year) || 0, p.amount / p.base));
  let run = null;
  const flush = () => {
    if (!run) return;
    notes.push({ type: 'reduced-quota', period: run.from, ...(run.to !== run.from ? { periodTo: run.to } : {}), regime: 'RETA',
      message: `quota ${run.amount} on base ${run.base} = ${Math.round(run.pct)}% of the full rate (reduction / bonus / flat rate?)` });
    run = null;
  };
  for (const p of retaPays) {
    const full = Math.max(maxByYear.get(p.year) || 0, maxAll * 0.97);
    const pct = full ? (p.amount / p.base / full) * 100 : 100;
    const next = run && p.amount === run.amount && p.base === run.base && p.period === nextPeriod(run.to);
    if (pct >= 90) { flush(); continue; }
    if (next) { run.to = p.period; continue; }
    flush();
    run = { from: p.period, to: p.period, amount: p.amount, base: p.base, pct };
  }
  flush();
  const both = [...quotaByMonth.keys()].filter((k) => paidByMonth.has(k) && inSel(k));
  if (both.length) notes.push({ type: 'multiple-activity', periods: both, message: 'months with both employee (GENERAL) and self-employed (RETA) contributions' });
  const dedupNotes = [...new Map(notes.map((n) => [JSON.stringify(n), n])).values()]
    .sort((a, b) => String(a.period || a.periods?.[0]).localeCompare(String(b.period || b.periods?.[0])) || a.type.localeCompare(b.type));

  const selected = payments.filter((p) => (p.month === null ? inRange(p.periodFrom, p.periodTo) : inSel(p.period)) && payerOk(p))
    .sort((a, b) => a.period.localeCompare(b.period) || a.regime.localeCompare(b.regime) || a.liquidationNumber - b.liquidationNumber || a.payerType.localeCompare(b.payerType) * -1);
  // via / viaType: the employment the contribution belongs to, for every entry (also the worker share withheld
  // from the payroll of an employer): the employer name, 'self-employed' (RETA) or the public agency (SEPE).
  const ordered = selected.map((p, i) => ({ id: i + 1, ...p, ...viaOf(p) }));
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: now.toISOString(),
    currency: 'EUR',
    selection: { ranges: filter.ranges || null, from: filter.from || null, to: filter.to || null, months: filter.months || null, payer: filter.payer || 'all', payerName: filter.payerName || null },
    sources,
    coverage: coverage(ordered),
    aggregates: aggregate(ordered),
    gaps: gaps.sort((a, b) => a.period.localeCompare(b.period)),
    notes: dedupNotes,
    payments: ordered,
  };
}

function coverage(payments) {
  const periods = [...new Set(payments.filter((p) => p.month !== null).map((p) => p.period))].sort();
  const byRegime = {};
  for (const p of payments) if (p.month !== null) (byRegime[p.regime] ||= new Set()).add(p.period);
  return {
    from: periods[0] || null, to: periods.at(-1) || null, months: periods.length,
    monthsByRegime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, v.size])),
    entries: payments.length,
  };
}

/** Pure: totals by payer, payer type, year, year+payer, regime, channel and grand total. */
export function aggregate(payments) {
  const blank = () => ({ entries: 0, amount: 0, surcharge: 0, total: 0 });
  const bump = (acc, p) => { acc.entries += 1; acc.amount = round2(acc.amount + (p.amount || 0)); acc.surcharge = round2(acc.surcharge + (p.surcharge || 0)); acc.total = round2(acc.total + p.total); };
  const group = (keyFn, meta) => {
    const m = new Map();
    for (const p of payments) {
      const k = keyFn(p);
      if (!m.has(k)) m.set(k, { ...meta(p), months: new Set(), ...blank() });
      const g = m.get(k);
      bump(g, p); if (p.month !== null) g.months.add(p.period);
    }
    return [...m.values()].map(({ months, ...g }) => ({ ...g, months: months.size }));
  };
  const payerKey = (p) => (p.payerType === 'employer' ? `employer|${p.ccc || p.payerName}` : p.payerType === 'public_agency' ? `public_agency|${p.payerName}` : `worker|${p.channel}`);
  const payerMeta = (p) => (p.payerType === 'employer' ? { payerType: 'employer', payerName: p.payerName, ccc: p.ccc }
    : p.payerType === 'public_agency' ? { payerType: 'public_agency', payerName: p.payerName, channel: p.channel }
      : { payerType: 'worker', payerName: 'self', channel: p.channel });
  const grand = blank();
  for (const p of payments) bump(grand, p);
  return {
    byPayer: group(payerKey, payerMeta).sort((a, b) => b.total - a.total),
    byPayerType: group((p) => p.payerType, (p) => ({ payerType: p.payerType })),
    byYear: group((p) => p.year, (p) => ({ year: p.year })).sort((a, b) => a.year - b.year),
    byYearPayer: group((p) => `${p.year}|${payerKey(p)}`, (p) => ({ year: p.year, ...payerMeta(p) })).sort((a, b) => a.year - b.year || b.total - a.total),
    byRegime: group((p) => p.regime, (p) => ({ regime: p.regime })),
    byChannel: group((p) => p.channel, (p) => ({ channel: p.channel })),
    grand: { ...grand, months: new Set(payments.filter((p) => p.month !== null).map((p) => p.period)).size },
  };
}

const f2 = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(2));

/**
 * Token-efficient text of a report: aggregates (group_by: payer|year|year_payer|regime|month|all),
 * gaps and notes; payments only with includePayments.
 */
export function formatReport(report, { filePath, groupBy = ['payer', 'year'], includePayments = false } = {}) {
  const groups = Array.isArray(groupBy) ? groupBy : [groupBy];
  const want = (g) => groups.includes(g) || groups.includes('all');
  const a = report.aggregates;
  const payerIds = new Map();
  const payerLabel = (g) => {
    if (g.payerType === 'public_agency') return g.payerName || 'agency';
    if (g.payerType !== 'employer') return `worker(${g.channel === 'direct payment' ? 'RETA direct' : 'payroll'})`;
    const key = g.ccc || g.payerName;
    if (!payerIds.has(key)) payerIds.set(key, `E${payerIds.size + 1}`);
    return payerIds.get(key);
  };
  const out = [];
  const c = report.coverage;
  out.push(`report=${filePath ? fileName(filePath) : '(not saved)'} entries=${c.entries} months=${c.months} (${Object.entries(c.monthsByRegime).map(([k, v]) => `${k} ${v}`).join(', ')}) ${c.from || '-'}..${c.to || '-'} EUR`);
  const employers = a.byPayer.filter((g) => g.payerType === 'employer');
  if (employers.length) out.push(`employers: ${employers.map((g) => `${payerLabel(g)}=${g.payerName}${g.ccc ? ` (CCC ${g.ccc})` : ''}`).join('; ')}`);
  out.push(`by payer type: ${a.byPayerType.map((g) => `${g.payerType}=${f2(g.total)}`).join(' ')}`);
  if (want('payer')) out.push(`by payer: ${a.byPayer.map((g) => `${payerLabel(g)}=${f2(g.total)} (${g.months}m)`).join(' ')}`);
  if (want('year')) out.push(...a.byYear.map((g) => `year ${g.year}: ${f2(g.total)} (${g.months}m${g.surcharge ? `, surcharge ${f2(g.surcharge)}` : ''})`));
  if (want('year_payer')) out.push(...a.byYearPayer.map((g) => `  ${g.year} ${payerLabel(g)}: ${f2(g.total)}`));
  if (want('regime')) out.push(`by regime: ${a.byRegime.map((g) => `${g.regime}=${f2(g.total)} (${g.months}m)`).join(' ')}`);
  if (want('month')) {
    const byMonth = new Map();
    for (const p of report.payments) {
      const e = byMonth.get(p.period) || { worker: 0, employer: 0 };
      e[p.payerType] = round2(e[p.payerType] + p.total); byMonth.set(p.period, e);
    }
    out.push('month worker employer', ...[...byMonth].map(([k, v]) => `${k} ${f2(v.worker)} ${f2(v.employer)}`));
  }
  out.push(`GRAND TOTAL: ${f2(a.grand.total)} (${a.grand.entries} entries, ${a.grand.months} months${a.grand.surcharge ? `, surcharge ${f2(a.grand.surcharge)}` : ''})`);
  out.push(report.gaps.length ? `gaps (${report.gaps.length}): ${report.gaps.map((g) => `${g.period} ${g.regime} ${g.reason}`).join('; ')}` : 'gaps: none');
  if (report.notes.length) out.push(`notes (${report.notes.length}):`, ...report.notes.map((n) => `  ${n.periodTo ? `${n.period}..${n.periodTo}` : n.period || (n.periods || []).join(',')} ${n.type}: ${n.message}`));
  if (includePayments) {
    out.push('payments: id period regime payer channel liq type base amount surcharge total source');
    for (const p of report.payments) out.push([p.id, p.month === null ? `${p.periodFrom}..${p.periodTo}` : p.period, p.regime, p.payerType === 'employer' ? payerLabel({ payerType: 'employer', ccc: p.ccc, payerName: p.payerName }) : p.payerType === 'public_agency' ? p.payerName : 'self', p.channel.replace(/ /g, '_'), p.liquidationNumber, p.liquidationType || '-', f2(p.base), f2(p.amount), f2(p.surcharge), f2(p.total), p.sourceFile || '-'].join(' '));
  }
  return out.join('\n');
}

// --- I/O ------------------------------------------------------------------------------

/** Everything saved locally that the combined report uses (no browser). */
export async function loadSaved() {
  const bases = await loadContributionBases().catch(() => null);
  const workHistory = await loadWorkHistory().catch(() => null);
  let quota = null; let paid = null; let sepe = null; let regularization = null;
  try { quota = await summarizeQuotaSnapshots(); } catch { /* none saved */ }
  try { paid = await summarizePaidContributions({}); } catch { /* none saved */ }
  try { sepe = await summarizeSepe(); } catch { /* none saved */ }
  try { regularization = await summarizeRegularization(); } catch { /* none saved */ }
  return { bases, quota, paid, sepe, workHistory, regularization };
}

/** Pure: the combined report from loadSaved() data (filter optional). */
export function buildFromSaved(s, { now = new Date(), filter = {} } = {}) {
  return buildContributionsReport({
    quotaRecords: s.quota ? s.quota.records : [], paidRecords: s.paid ? s.paid.records : [], bases: s.bases ? s.bases.full : null, now, filter,
    sepeRecords: s.sepe ? s.sepe.records : [], regularizationRecords: s.regularization ? s.regularization.records : [], benefitPeriods: s.workHistory ? s.workHistory.benefitPeriods : [],
    sources: {
      basesReport: s.bases ? s.bases.file : null,
      quotaCalculations: s.quota ? { day: s.quota.day, summary: path.basename(s.quota.csvPath) } : null,
      paidContributions: s.paid ? { summary: path.basename(s.paid.csvPath), years: s.paid.years } : null,
      sepeBenefits: s.sepe && s.sepe.records.length ? { summary: path.basename(s.sepe.csvPath), certificates: s.sepe.records.map((r) => r.source) } : null,
      workHistory: s.workHistory ? s.workHistory.file : null,
      retaRegularization: s.regularization && s.regularization.records.length ? { summary: path.basename(s.regularization.csvPath), years: s.regularization.records.map((r) => `${r.year} ${r.status}`) } : null,
    },
  });
}

/**
 * Builds the combined report from saved data and writes
 * ~/Documents/HuellaContributiva/combined-report-YYYY-MM-DD.json (…-filtered.json when a filter is set).
 * refresh: first fetches the missing months (gaps) in ONE Chrome session (quota calculations and/or
 * paid contributions; bases report first if none is saved), then rebuilds.
 * Returns { report, filePath, text, refreshed }.
 */
export async function generateContributionsReport({ from, to, ranges, months, payer, payerName, refresh = false, groupBy, includePayments = false, now = new Date() } = {}) {
  const filter = { from, to, ranges, months, payer, payerName };
  monthPredicate(filter); // validate before anything else
  if (payer && !['all', 'worker', 'employer', 'public_agency'].includes(payer)) throw new Error(`Invalid payer "${payer}" (all | worker | employer | public_agency)`);
  let saved = await loadSaved();
  const build = (s) => buildFromSaved(s, { now, filter });
  let report = build(saved);
  let refreshed = null;
  if (refresh) {
    const empGaps = report.gaps.filter((g) => g.regime === 'GENERAL').map((g) => g.period);
    const retaGaps = report.gaps.filter((g) => g.regime === 'RETA').map((g) => g.period);
    const needBases = !saved.bases;
    if (needBases || empGaps.length || retaGaps.length || !saved.quota || !saved.paid) {
      refreshed = { quota: null, paid: null };
      const context = await launchChrome();
      try {
        if (needBases || !saved.quota || empGaps.length) {
          const r = await fetchQuotaCalculations({ context, ...(saved.quota && empGaps.length ? { months: empGaps } : { from, to, ranges }) });
          refreshed.quota = r.message;
        }
        if (!saved.paid || retaGaps.length) {
          const r = await fetchPaidContributions({ context, ...(saved.paid && retaGaps.length ? { months: retaGaps } : { from, to, ranges }) });
          refreshed.paid = r.message;
        }
      } finally {
        await context.close().catch(() => {});
      }
      saved = await loadSaved();
      report = build(saved);
    } else {
      log('refresh: nothing missing, no browser needed.');
    }
  }
  if (!report.payments.length && !saved.quota && !saved.paid) throw new Error('No saved quota calculations or paid contributions found. Run fetch-quotas / fetch-paid-quotas first (or use refresh).');
  if (refreshed) report.refreshed = refreshed;
  const filtered = Boolean(from || to || (ranges && ranges.length) || (months && months.length) || (payer && payer !== 'all') || payerName);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `${REPORT_PREFIX}-${today()}${filtered ? '-filtered' : ''}.json`);
  await fs.writeFile(filePath, JSON.stringify(report, null, 1), 'utf8');
  return { report, filePath, refreshed, text: formatReport(report, { filePath, groupBy, includePayments }) };
}
