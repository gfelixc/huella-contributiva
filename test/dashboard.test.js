// Contributions dashboard: model + HTML generation, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import M from '../dashboard/model.cjs';
import { conceptsFromBreakdown, attachConcepts, jsonForScript, renderDashboardHtml } from '../src/dashboard.js';

const BREAKDOWN = [
  { concept: 'CONTINGENCIAS COMUNES', base: 2000, employerQuota: 472, workerQuota: 94, total: 566 },
  { concept: 'MECANISMO EQUIDAD INTERGENERACIONAL', base: 2000, employerQuota: 10, workerQuota: 2, total: 12 },
  { concept: 'LIQUIDO CONTINGENCIAS COMUNES', base: null, employerQuota: 482, workerQuota: 96, total: 578 },
  { concept: 'IT DE ACCIDENTES DE TRABAJO', base: 2000, employerQuota: 20, workerQuota: null, total: 20 },
  { concept: 'LIQUIDO DE ACCIDENTES DE TRABAJO', base: null, employerQuota: 20, workerQuota: null, total: 20 },
  { concept: 'OTRAS COTIZACIONES', base: 2000, employerQuota: 128, workerQuota: 34, total: 162 },
  { concept: 'LIQUIDO DE OTRAS COTIZACIONES', base: null, employerQuota: 128, workerQuota: 34, total: 162 },
  { concept: 'LIQUIDO DE TOTALES', base: null, employerQuota: 630, workerQuota: 130, total: 760 },
];
const pay = (id, extra) => ({ id, year: 2025, month: 1, period: '2025-01', regime: 'GENERAL', payerType: 'worker', payerName: 'self', channel: 'payroll withholding',
  employer: 'EXAMPLE COMPANY, S.L.', ccc: '00000000000', liquidationNumber: 1, liquidationType: 'L00', base: 2000, amount: 130, surcharge: 0, total: 130,
  sourceReport: 'quota-calculations', sourceFile: 'calc-2025-01.txt', ...extra });
const REPORT = {
  reportVersion: 1, generatedAt: '2025-03-01T10:00:00.000Z', currency: 'EUR',
  coverage: { from: '2024-12', to: '2025-02', months: 3, entries: 5 },
  aggregates: { grand: { entries: 5, total: 1690.5 } },
  gaps: [{ period: '2025-03', regime: 'RETA', reason: 'last month: probably not yet processed in the paid contributions report' }],
  notes: [
    { type: 'benefit-period', period: '2024-12', periodTo: '2025-01', kind: 'erte-suspension', message: 'ERTE (contract suspended, unemployment benefit) 2024-12-01..2025-01-31 (62 days) per the work history report; months 2024-12,2025-01; SEPE deductions included' },
    { type: 'base-mismatch', period: '2025-01', message: 'quota calculation base 1800 vs bases report 2000 (diff -200) — within the erte-suspension benefit period (part of the month paid by SEPE)' },
  ],
  payments: [
    pay(1),
    pay(2, { payerType: 'employer', payerName: 'EXAMPLE COMPANY, S.L.', channel: 'employer settlement', amount: 630, total: 630 }),
    { id: 3, year: 2025, month: 2, period: '2025-02', regime: 'RETA', payerType: 'worker', payerName: 'self', channel: 'direct payment', amount: 300, surcharge: 10.5, total: 310.5, sourceReport: 'paid-contributions' },
    { id: 4, year: 2024, month: null, period: '2024-12', periodFrom: '2024-12', periodTo: '2025-01', regime: 'GENERAL', payerType: 'public_agency', payerName: 'SEPE',
      channel: 'deducted from unemployment benefit', amount: 120, surcharge: null, total: 120, grossBenefit: 2000, irpfWithheld: 50, netBenefit: 1830, sourceReport: 'sepe-benefits' },
    pay(5, { month: 12, year: 2024, period: '2024-12', payerType: 'employer', payerName: 'EXAMPLE COMPANY, S.L.', channel: 'employer settlement', amount: 500, total: 500, sourceFile: 'calc-missing.txt' }),
  ],
};

test('concept lines: leaves grouped by their subtotal, per share', () => {
  const w = conceptsFromBreakdown(BREAKDOWN, 'worker');
  assert.deepEqual(w.map((c) => [c.group, c.concept, c.amount]), [
    ['CONTINGENCIAS COMUNES', 'CONTINGENCIAS COMUNES', 94], ['CONTINGENCIAS COMUNES', 'MECANISMO EQUIDAD INTERGENERACIONAL', 2], ['OTRAS COTIZACIONES', 'OTRAS COTIZACIONES', 34]]);
  const e = conceptsFromBreakdown(BREAKDOWN, 'employer');
  assert.equal(e.reduce((s, c) => s + c.amount, 0), 630);
  assert.ok(e.some((c) => c.group === 'ACCIDENTES DE TRABAJO'));
  const rep = attachConcepts(REPORT, { 'calc-2025-01.txt': BREAKDOWN });
  assert.equal(rep.payments[0].concepts.length, 3);
  assert.equal(rep.payments[4].concepts, undefined);
  assert.equal(REPORT.payments[0].concepts, undefined); // input not mutated
});

test('model: normalisation, flows add up, filters and KPIs', () => {
  const m = M.normalizeReport(attachConcepts(REPORT, { 'calc-2025-01.txt': BREAKDOWN }));
  assert.equal(m.entries.length, 5);
  const flows = M.toFlows(m.entries);
  assert.equal(M.round2(flows.reduce((s, f) => s + f.value, 0)), 1690.5);
  assert.ok(flows.some((f) => f.concept === 'Recargo' && f.value === 10.5));
  assert.ok(flows.some((f) => f.concept === 'IT de Accidentes de Trabajo'));
  assert.ok(flows.some((f) => f.concept === 'Cuota empresarial (total)')); // entry without breakdown
  const k = M.kpis(m.entries);
  assert.deepEqual([k.total, k.worker, k.employer, k.publicAgency, k.months], [1690.5, 440.5, 1130, 120, 3]);
  assert.equal(M.filterEntries(m.entries, { yearFrom: 2025, yearTo: 2025 }).length, 4); // the SEPE range reaches 2025
  assert.equal(M.filterEntries(m.entries, { payerTypes: ['public_agency'] })[0].payerLabel, 'SEPE');
  assert.equal(M.filterEntries(m.entries, { payers: ['EXAMPLE COMPANY, S.L.'] }).length, 2);
  assert.throws(() => M.normalizeReport({}), /payments/);
});

test('model: tree, Sankey graph and layout, timeline', () => {
  const m = M.normalizeReport(REPORT);
  const flows = M.toFlows(m.entries);
  const tree = M.buildTree(flows, ['year', 'payerType', 'concept']);
  assert.deepEqual(tree.children.map((c) => c.name), ['2024', '2025']); // chronological
  assert.equal(tree.value, 1690.5);
  assert.equal(M.round2(tree.children.reduce((s, c) => s + c.value, 0)), 1690.5);
  const byType = M.buildTree(flows, ['payerType']);
  assert.deepEqual(byType.children.map((c) => c.name), ['Empresas', 'Trabajador', 'Organismo público (SEPE / TGSS)']); // by value
  const g = M.sankeyGraph(flows, ['payer', 'regime', 'year', 'share']);
  for (let s = 0; s < 3; s++) {
    const out = M.round2(g.links.filter((l) => l.source.startsWith(`${s}:`)).reduce((a, l) => a + l.value, 0));
    assert.equal(out, 1690.5, `stage ${s} conserves the total`);
  }
  const L = M.sankeyLayout(g, { width: 800, height: 400 });
  for (const n of L.nodes) { assert.ok(n.y0 >= 0 && n.y1 <= 400.01, n.id); assert.ok(n.x1 <= 800); }
  assert.equal(L.links.length, g.links.length);
  const tl = M.timeline(flows, { granularity: 'month', stackBy: 'payerType' });
  assert.deepEqual(tl.rows.map((r) => r.key), ['2024-12', '2025-01', '2025-02']);
  assert.equal(tl.rows[0].stacks['Organismo público (SEPE / TGSS)'], 60); // SEPE certificate spread over its 2 months
  assert.equal(M.round2(tl.rows.reduce((s, r) => s + r.total, 0)), 1690.5);
});

test('model: Spanish notes, gaps and formatting', () => {
  const items = M.issues(M.normalizeReport(REPORT));
  assert.deepEqual(items.map((i) => i.level), ['warn', 'erte', 'info']);
  assert.match(items[0].text, /^Último mes/);
  assert.match(items[1].text, /del 01\/12\/2024 al 31\/01\/2025 \(62 días\).*Incluye la cuota retenida por el SEPE/);
  assert.match(items[2].text, /1\.800,00 € frente a 2\.000,00 €.*ERTE/);
  const pending = M.issues(M.normalizeReport({ ...REPORT, notes: [{ ...REPORT.notes[0], message: 'ERTE ... no SEPE certificate saved for it (fetch-sepe)' }] }));
  assert.ok(pending.some((i) => i.level === 'sepe'));
  assert.equal(M.formatEUR(123456.78), '123.456,78 €');
  assert.equal(M.formatEUR(-5), '−5,00 €');
  assert.match(M.toCsv(M.normalizeReport(REPORT).entries).split('\n')[4], /^4,2024-12\.\.2025-01,/);
});

test('HTML: self-contained, no external resources, safe embedding', async () => {
  assert.equal(jsonForScript({ a: '</script><b>&' }), '{"a":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}');
  const empty = await renderDashboardHtml(null);
  assert.match(empty, /<script id="report-data" type="application\/json">null<\/script>/);
  assert.ok(!/__REPORT_DATA__"?<\/script>|\/\*__(STYLE|MODEL|APP)__\*\//.test(empty.replace("raw !== '__REPORT_DATA__'", '')));
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(empty), 'no CDN / remote resources');
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(empty));
  const html = await renderDashboardHtml({ report: REPORT, label: 'synthetic.json' });
  const json = JSON.parse(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(json.report.aggregates.grand.total, 1690.5);
  assert.equal(json.label, 'synthetic.json');
});

test('employer dimension: worker share withheld through the employer, RETA and SEPE', () => {
  const m = M.normalizeReport(REPORT); // no via fields: derived from employer / channel / payer type
  const by = Object.fromEntries(m.entries.map((e) => [e.id, e.employerLabel]));
  assert.deepEqual(by, { 1: 'EXAMPLE COMPANY, S.L.', 2: 'EXAMPLE COMPANY, S.L.', 3: 'Autónomo (cuenta propia)', 4: 'SEPE', 5: 'EXAMPLE COMPANY, S.L.' });
  assert.equal(m.entries[0].payerLabel, 'Trabajador · retención en nómina'); // payer stays "who pays"
  const flows = M.toFlows(m.entries);
  const tree = M.buildTree(flows, ['employer', 'share']);
  const company = tree.children.find((c) => c.name === 'EXAMPLE COMPANY, S.L.');
  assert.equal(company.value, 1260);
  assert.deepEqual(company.children.map((c) => c.name), ['Cuota empresarial', 'Cuota del trabajador']);
  assert.equal(M.filterEntries(m.entries, { employers: ['EXAMPLE COMPANY, S.L.'], payerTypes: ['worker'] }).length, 1);
  const viaReport = { ...REPORT, payments: REPORT.payments.map((p) => (p.id === 1 ? { ...p, employer: null, via: 'OTHER EXAMPLE, S.A.', viaType: 'employer' } : p)) };
  assert.equal(M.normalizeReport(viaReport).entries[0].employerLabel, 'OTHER EXAMPLE, S.A.');
});

test('RETA regularisation: negative refunds in KPIs, Sankey, timeline and notes', () => {
  const rep = {
    ...REPORT,
    notes: [{ type: 'reta-regularization', period: '2025-01', periodTo: '2025-02', year: 2025, status: 'refund', amount: 50, refundDate: '2026-04-15', message: 'x' },
      { type: 'regularization-pending', period: '2024-01', periodTo: '2024-12', year: 2024, status: 'not-fetched', message: 'y' }],
    payments: [
      pay(1, { regime: 'RETA', payerName: 'self', channel: 'direct payment', employer: null, ccc: null, amount: 300, total: 300, baseStatus: 'superseded', sourceReport: 'paid-contributions' }),
      pay(2, { month: 2, period: '2025-02', regime: 'RETA', employer: null, ccc: null, channel: 'direct payment', amount: 300, total: 300, baseStatus: 'superseded', sourceReport: 'paid-contributions' }),
      pay(3, { month: null, periodFrom: '2025-01', periodTo: '2025-02', regime: 'RETA', payerType: 'public_agency', payerName: 'TGSS', employer: null, ccc: null,
        channel: 'regularization refund', liquidationType: 'REGULARIZATION', amount: -50, total: -50, via: 'self-employed', viaType: 'self-employed', sourceReport: 'reta-regularization' }),
    ],
  };
  const model = M.normalizeReport(rep);
  const flows = M.toFlows(model.entries);
  const k = M.kpis(model.entries);
  assert.deepEqual([k.total, k.regularization, k.refunds, k.regularizationEntries], [550, -50, -50, 1]);
  const refund = model.entries.find((e) => e.sourceReport === 'reta-regularization');
  assert.deepEqual([refund.payerLabel, refund.employerLabel, refund.baseStatus], ['TGSS · devolución de la regularización', 'Autónomo (cuenta propia)', null]);
  assert.equal(model.entries[0].baseStatus, 'superseded');
  assert.equal(M.DIMENSIONS.share.get(flows.find((f) => f.entryId === 3)), 'Devolución de cuotas (TGSS)');
  assert.equal(flows.find((f) => f.entryId === 3).group, 'Regularización anual RETA');
  const g = M.sankeyGraph(flows, ['payerType', 'year', 'share']);
  assert.equal(g.negative, -50);
  assert.ok(g.links.every((l) => l.value > 0));
  assert.ok(!g.nodes.some((n) => n.name === 'Devolución de cuotas (TGSS)'));
  const tl = M.timeline(flows, { granularity: 'month', stackBy: 'payerType' });
  assert.equal(tl.rows[0].stacks['Organismo público (SEPE / TGSS)'], -25);
  assert.equal(tl.rows[0].total, 275);
  const iss = M.issues(model);
  assert.ok(iss.some((i) => i.level === 'reg' && /devolución de 50,00/.test(i.text) && /15\/04\/2026/.test(i.text)));
  assert.ok(iss.some((i) => i.level === 'pending' && /fetch-regularization/.test(i.text)));
});

test('RETA regularisation already included in the paid quotas: KPI and notes', () => {
  const rep = { ...REPORT,
    notes: [{ type: 'reta-regularization', period: '2025-01', periodTo: '2025-12', year: 2025, status: 'claim', amount: 30, includedInPaid: 30, remainder: 0,
      reconciledMonths: [{ period: '2025-06', paid: 80, difference: 30 }], paymentStatus: 'paid', message: 'x' },
    { type: 'regularised-month', period: '2025-06', year: 2025, difference: 30, provisionalQuota: 50, definitiveQuota: 80, message: 'y' }],
    payments: [pay(1, { month: 6, period: '2025-06', regime: 'RETA', employer: null, ccc: null, channel: 'direct payment', amount: 80, total: 80, baseStatus: 'regularised',
      regularization: { year: 2025, includedDifference: 30, provisionalQuota: 50, definitiveQuota: 80 }, sourceReport: 'paid-contributions' })] };
  const model = M.normalizeReport(rep);
  const k = M.kpis(model.entries);
  assert.deepEqual([k.total, k.regularization, k.regularizationIncluded], [80, 0, 30]);
  const iss = M.issues(model);
  assert.ok(iss.some((i) => /Ya incluida en las cuotas ingresadas \(jun 2025: 80,00 €\)/.test(i.text)), JSON.stringify(iss.map((i) => i.text)));
  assert.ok(iss.some((i) => i.title.startsWith('Cuota regularizada') && /incluye \+30,00 €/.test(i.text)));
});
