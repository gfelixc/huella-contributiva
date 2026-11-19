// Paid contributions report (Informe de cuotas ingresadas): pure functions, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaidReport, findPeriod, normalizeRegime, selectPaidRecords, summarizePaid, paidToCsv, formatPaidCompact } from '../src/paidParser.js';
import { resolvePaidMonths, retaMonthsFromBases, classifyPaidFiles } from '../src/paidQuotas.js';

// Page snapshot layout: body text + "[Tables]" rows "cell | cell" (as saved by the tool).
const PAGE = `URL: https://example.invalid/service

Informe de bases y cuotas ingresadas
Ejercicio: 2024
Periodo	Régimen	Base	Cuota	Recargo	Intereses	Fecha de ingreso

[Tables]
Periodo | Régimen | Base de cotización | Cuota ingresada | Recargo | Intereses | Fecha de ingreso
01/2024 | 0521 R.E. TRABAJADORES AUTONOMOS | 1.000,00 | 300,00 | 0,00 | 0,00 | 31/01/2024
02/2024 | 0521 R.E. TRABAJADORES AUTONOMOS | 1.000,00 | 300,00 | 60,00 | 1,50 | 15/04/2024
03/2024 | 0521 R.E. TRABAJADORES AUTONOMOS | 1.100,00 | 330,00 | 0,00 | 0,00 | 02/04/2024`;

// PDF text layout (fallback parser): month names, amounts in report order.
const PDF = `INFORME DE BASES Y CUOTAS INGRESADAS
Régimen: TRABAJADORES AUTONOMOS
Año 2025
Enero 2025 1.200,00 370,00 0,00
Febrero 2025 1.200,00 370,00 0,00
Fecha de emisión: 01/11/2026`;

test('parsePaidReport: table snapshot with header mapping', () => {
  const r = parsePaidReport(PAGE, { year: 2024, withRaw: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[1], { month: '2024-02', regime: 'RETA', base: 1000, quota: 300, surcharge: 60, interest: 1.5, paymentDate: '2024-04-15', status: null, total: 361.5, raw: r.rows[1].raw });
});

test('parsePaidReport: PDF text fallback, no-data and unparsed', () => {
  const r = parsePaidReport(PDF);
  assert.equal(r.status, 'ok');
  assert.equal(r.year, 2025);
  assert.deepEqual(r.rows.map((x) => [x.month, x.regime, x.base, x.quota, x.surcharge, x.paymentDate]), [
    ['2025-01', 'RETA', 1200, 370, 0, null], ['2025-02', 'RETA', 1200, 370, 0, null]]);
  assert.equal(parsePaidReport('Ejercicio 2019\nNo existen datos de cuotas ingresadas para el ejercicio.').status, 'no-data');
  assert.equal(parsePaidReport('Se ha producido un error. Inténtelo más tarde.').status, 'error');
  assert.equal(parsePaidReport('nothing here').status, 'unparsed');
});

test('findPeriod / normalizeRegime', () => {
  assert.equal(findPeriod('05/2023'), '2023-05');
  assert.equal(findPeriod('2023-11'), '2023-11');
  assert.equal(findPeriod('202312'), '2023-12');
  assert.equal(findPeriod('Septiembre', 2024), '2024-09');
  assert.equal(findPeriod('31/01/2024'), null); // a full date is not a period
  assert.equal(normalizeRegime('0521 R.E. TRABAJADORES AUTONOMOS'), 'RETA');
  assert.equal(normalizeRegime('Régimen Especial del Mar'), 'REM');
});

test('selectPaidRecords: newest capture per year, page > pdf, rows beat empty pages', () => {
  const p = (text, year) => parsePaidReport(text, { year });
  const files = [
    { file: 'a-2026-01-01-2024.txt', day: '2026-01-01', kind: 'page', year: 2024, parsed: p(PAGE, 2024) },
    { file: 'b-2026-02-01-2024-pdf.txt', day: '2026-02-01', kind: 'pdf', year: 2024, parsed: p(PAGE.replace('300,00 | 0,00 | 0,00 | 31/01', '301,00 | 0,00 | 0,00 | 31/01'), 2024) },
    { file: 'c-2026-02-01-2024.txt', day: '2026-02-01', kind: 'page', year: 2024, parsed: p(PAGE, 2024) },
    { file: 'd-2026-03-01-2025.txt', day: '2026-03-01', kind: 'page', year: 2025, parsed: p('garbage', 2025) },
    { file: 'e-2026-01-01-2025-pdf.txt', day: '2026-01-01', kind: 'pdf', year: 2025, parsed: p(PDF, 2025) },
  ];
  const { records, years } = selectPaidRecords(files);
  assert.equal(years['2024'].source, 'c-2026-02-01-2024.txt');
  assert.equal(years['2025'].source, 'e-2026-01-01-2025-pdf.txt');
  assert.equal(records.length, 5);
  const s = summarizePaid(records);
  assert.equal(s.years['2024'].months, 3);
  assert.equal(s.grand.total, 300 + 361.5 + 330 + 370 + 370);
  assert.match(paidToCsv(records).split('\n')[0], /^month,regime,base,quota/);
  const txt = formatPaidCompact(records, s, { missing: ['2025-03'] });
  assert.match(txt, /^2024-02 RETA 1000\.00 300\.00 60\.00 1\.50 361\.50 2024-04-15$/m);
  assert.match(txt, /missing .*2025-03/);
});

test('classifyPaidFiles', () => {
  const c = classifyPaidFiles(['paid-contribution-2026-11-16-2024.txt', 'paid-contribution-2026-11-16-2024-pdf.txt', 'paid-contribution-2026-11-16-2024-error.txt',
    'paid-contribution-2026-11-16-snap1.txt', 'paid-contribution-2026-11-16-manual-pdf2.txt', 'paid-contribution.summary.csv']);
  assert.deepEqual(c.map((x) => [x.kind, x.year]), [['page', 2024], ['pdf', 2024], ['snap', null], ['manual-pdf', null]]);
});

const BASES = `
Régimen: TRABAJADOR AUTONOMO Empresa/Razón Social: Régimen Especial de Trab. Autónomo
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2025 100,00 100,00 100,00 100,00 100,00 Pendiente de actualizar
2024 --- --- --- --- --- --- --- --- --- 100,00 100,00 100,00
Régimen: GENERAL Empresa/Razón Social: EXAMPLE COMPANY, S.L. CCC: 00000000000
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2024 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 --- --- ---
`;
const NOW = new Date(2025, 8, 15); // 15/09/2025 → last month 08/2025
const periods = (r) => r.months.map((m) => m.period);

test('retaMonthsFromBases: RETA months, extended to last month while still active', () => {
  const r = retaMonthsFromBases(BASES, { now: NOW });
  assert.equal(r.first, '2024-10');
  assert.equal(r.last, '2025-08');
  assert.equal(r.months.length, 11);
});

test('resolvePaidMonths: default, ranges, explicit months, all_months', () => {
  const def = resolvePaidMonths({ basesText: BASES, now: NOW });
  assert.deepEqual(def.years, [2024, 2025]);
  assert.equal(def.months.length, 11);
  const rg = resolvePaidMonths({ basesText: BASES, now: NOW, ranges: ['01/2024-11/2024', '2025-07-2025-12'] });
  assert.deepEqual(periods(rg), ['10/2024', '11/2024', '07/2025', '08/2025']);
  const ex = resolvePaidMonths({ basesText: BASES, now: NOW, months: ['03/2024', '2025-01'] });
  assert.deepEqual(periods(ex), ['03/2024', '01/2025']);
  assert.deepEqual(ex.notSelfEmployed, ['03/2024']);
  const un = resolvePaidMonths({ basesText: BASES, now: NOW, from: '12/2024', to: '01/2025', months: ['06/2023'] });
  assert.deepEqual(periods(un), ['06/2023', '12/2024', '01/2025']);
  assert.deepEqual(un.years, [2023, 2024, 2025]);
  const all = resolvePaidMonths({ allMonths: true, now: NOW, ranges: ['01/2020-02/2020'] });
  assert.deepEqual(periods(all), ['01/2020', '02/2020']);
  assert.throws(() => resolvePaidMonths({ ranges: ['2020-13-2021-01'] }));
});
