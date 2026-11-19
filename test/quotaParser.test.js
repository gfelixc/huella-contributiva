// Pure-function tests with synthetic fixtures only (no browser, no real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseQuotaSnapshot, summarizeQuotaRecords, recordsToCsv, formatCompact, filterRecords } from '../src/quotaParser.js';

const result = (month, base, emp, wrk, tot, { employer = 'EXAMPLE COMPANY, S.L.', ccc = '00000000000', type = 'L00-NORMAL' } = {}) => `URL: https://example.invalid/
Datos de la liquidación
RÉGIMEN
0111
CCC
${ccc}
MES DE LIQUIDACIÓN
${month}
RAZÓN SOCIAL
${employer}
TIPO DE LIQUIDACIÓN
${type}
Cálculos globales del trabajador

[Tables]
Descripción | Base | Cuota Empresarial | Cuota Trabajador | Cuota Total
CONTINGENCIAS COMUNES | ${base} | 236,00 € | 47,00 € | 283,00 €
LIQUIDO CONTINGENCIAS COMUNES |  | 236,00 € | 47,00 € | 283,00 €
LIQUIDO DE TOTALES |  | ${emp} | ${wrk} | ${tot}
`;

const LIST = `RELACIóN DE LIQUIDACIONES DISPONIBLES PARA 3/2020
[Tables]
CCC | Tipo Liquidación | CCC Concertado | Fecha Control | Mes de Presentación
0111 0 0000000000 | L00 | -- | -- | 02/2020
011100000000001 | L13 | -- | -- | 02/2020
`;

test('parseAmount handles Spanish formats', () => {
  assert.equal(parseAmount('1.234,56 €'), 1234.56);
  assert.equal(parseAmount('3.750,00'), 3750);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('--'), null);
});

test('parses a result page into a compact record', () => {
  const r = parseQuotaSnapshot(result('03/2020', '1.000,00', '1.100,50 €', '200,25 €', '1.300,75 €'), { fileLabel: '2020-03' });
  assert.equal(r.status, 'ok');
  assert.equal(r.month, '2020-03');
  assert.equal(r.regime, '0111');
  assert.equal(r.ccc, '00000000000');
  assert.equal(r.employer, 'EXAMPLE COMPANY, S.L.');
  assert.equal(r.liquidationType, 'L00-NORMAL');
  assert.equal(r.base, 1000);
  assert.equal(r.employerQuota, 1100.5);
  assert.equal(r.workerQuota, 200.25);
  assert.equal(r.total, 1300.75);
  assert.equal(r.breakdown, undefined);
  assert.equal(parseQuotaSnapshot(result('03/2020', '1,00', '1,00 €', '1,00 €', '2,00 €'), { withBreakdown: true }).breakdown.length, 3);
});

test('list-only, no-data and unrecognized pages', () => {
  const l = parseQuotaSnapshot(LIST, { fileLabel: '2020-01' }); // the page's own month wins
  assert.equal(l.status, 'list-only');
  assert.equal(l.month, '2020-03');
  assert.deepEqual(l.liquidations.map((x) => [x.regime, x.ccc, x.type]), [['0111', '00000000000', 'L00'], ['0111', '00000000001', 'L13']]);
  const n = parseQuotaSnapshot('¡Atención! Se ha producido un Error:\nNo existe liquidación presentada', { fileLabel: '2020-02' });
  assert.equal(n.status, 'no-data');
  assert.equal(parseQuotaSnapshot('hello', { fileLabel: '2020-04' }).status, 'unparsed');
});

test('totals, CSV, compact text and filters', () => {
  const recs = [
    parseQuotaSnapshot(result('01/2020', '1.000,00', '300,00 €', '60,00 €', '360,00 €')),
    parseQuotaSnapshot(result('02/2020', '1.000,00', '300,00 €', '60,00 €', '360,00 €')),
    parseQuotaSnapshot(result('02/2020', '500,00', '10,00 €', '2,00 €', '12,00 €', { employer: 'OTHER EXAMPLE SL', ccc: '11111111111', type: 'L13-ATRASOS' })),
    parseQuotaSnapshot(LIST, { fileLabel: '2020-03' }),
  ];
  const s = summarizeQuotaRecords(recs);
  assert.equal(s.employers.length, 2);
  assert.deepEqual(s.grand, { rows: 3, months: 2, workerQuota: 122, employerQuota: 610, total: 732 });
  assert.equal(s.issues.length, 1);
  const csv = recordsToCsv(recs).trim().split('\n');
  assert.equal(csv.length, 5);
  assert.ok(csv[1].includes('"EXAMPLE COMPANY, S.L."'));
  assert.ok(csv[1].endsWith('1000.00,60.00,300.00,360.00'));
  const text = formatCompact(recs, s);
  assert.ok(text.includes('grand: months=2 rows=3 worker=122.00 employer=610.00 total=732.00'));
  assert.ok(!text.includes('[Tables]'));
  assert.equal(filterRecords(recs, { from: '02/2020', to: '2020-02' }).length, 2);
  assert.equal(filterRecords(recs, { months: ['01/2020'] }).length, 1);
  assert.throws(() => filterRecords(recs, { from: '13/2020' }));
});

import { planSnapshotFiles, dedupeQuotaRecords } from '../src/quotaParser.js';

const F = (file, month, kind) => ({ file, month, kind });

test('planSnapshotFiles: without manifest, liquidation files win over list/main pages', () => {
  const plan = planSnapshotFiles([
    F('a-2020-01.txt', '2020-01', 'main'), F('a-2020-01-list.txt', '2020-01', 'list'),
    F('a-2020-01-liq1.txt', '2020-01', 'liq1'), F('a-2020-01-liq2.txt', '2020-01', 'liq2'),
    F('a-2020-02.txt', '2020-02', 'main'), F('a-snap1.txt', null, 'snap'),
  ]);
  assert.deepEqual(plan.map((p) => p.file).sort(), ['a-2020-01-liq1.txt', 'a-2020-01-liq2.txt', 'a-2020-02.txt', 'a-snap1.txt']);
});

test('planSnapshotFiles: a re-fetched month uses only the files of its latest fetch', () => {
  const files = [
    F('a-2020-01.txt', '2020-01', 'main'), F('a-2020-01-list.txt', '2020-01', 'list'),
    F('a-2020-01-liq1.txt', '2020-01', 'liq1'), F('a-2020-01-liq2.txt', '2020-01', 'liq2'), F('a-2020-01-liq3.txt', '2020-01', 'liq3'),
    F('a-2020-02.txt', '2020-02', 'main'),
  ];
  const manifest = {
    '2020-01': { files: ['a-2020-01-list.txt', 'a-2020-01-liq1.txt', 'a-2020-01-liq3.txt'], failures: [{ liquidation: 'liq2', message: 'not opened: click failed' }] },
    '2020-02': { status: 'no-data', message: 'no liquidation' },
  };
  const plan = planSnapshotFiles(files, manifest);
  assert.deepEqual(plan.filter((p) => p.file).map((p) => p.file), ['a-2020-01-liq1.txt', 'a-2020-01-liq3.txt']);
  const synth = plan.filter((p) => p.synthetic).map((p) => [p.synthetic.month, p.synthetic.status, p.synthetic.liquidation]);
  assert.deepEqual(synth, [['2020-01', 'not-opened', 'liq2'], ['2020-02', 'no-data', null]]);
});

test('dedupeQuotaRecords drops exact duplicates and sorts', () => {
  const a = parseQuotaSnapshot(result('02/2020', '1,00', '1,00 €', '1,00 €', '2,00 €'));
  const b = parseQuotaSnapshot(result('01/2020', '1,00', '1,00 €', '1,00 €', '2,00 €'));
  const c = parseQuotaSnapshot(result('01/2020', '1,00', '1,00 €', '1,00 €', '2,00 €', { type: 'L13-ATRASOS' }));
  const out = dedupeQuotaRecords([a, b, { ...b }, c]);
  assert.deepEqual(out.map((r) => `${r.month} ${r.liquidationType}`), ['2020-01 L00-NORMAL', '2020-01 L13-ATRASOS', '2020-02 L00-NORMAL']);
});
