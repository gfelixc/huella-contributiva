// Month selection for the quota queries: pure functions, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonthList, resolveQuotaMonths } from '../src/quotas.js';

const BASES = `
Régimen: TRABAJADOR AUTONOMO Empresa/Razón Social: Régimen Especial de Trab. Autónomo
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2021 --- --- --- --- --- --- 100,00 100,00 100,00 100,00 100,00 100,00
Régimen: GENERAL Empresa/Razón Social: EXAMPLE COMPANY, S.L. CCC: 00000000000
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2021 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 --- --- --- --- --- ---
2020 --- --- --- --- --- --- --- --- --- 1.000,00 1.000,00 1.000,00
`;
const periods = (r) => r.months.map((m) => m.period);

test('parseMonthList: formats, separators, dedupe, sort, validation', () => {
  assert.deepEqual(parseMonthList('06/2021,2020-11 01/2021;06/2021').map((m) => m.period), ['11/2020', '01/2021', '06/2021']);
  assert.deepEqual(parseMonthList(['2021-02', '1/2021']).map((m) => m.label), ['2021-01', '2021-02']);
  assert.deepEqual(parseMonthList(undefined), []);
  assert.throws(() => parseMonthList('13/2021'));
  assert.throws(() => parseMonthList('2021/01'));
});

test('only a range (or nothing): employee months within the range', () => {
  assert.equal(resolveQuotaMonths({ basesText: BASES }).months.length, 9);
  assert.deepEqual(periods(resolveQuotaMonths({ basesText: BASES, from: '01/2021', to: '02/2021' })), ['01/2021', '02/2021']);
});

test('only explicit months: exactly those, flagged when not employee months', () => {
  const r = resolveQuotaMonths({ basesText: BASES, months: ['08/2021', '03/2021'] });
  assert.deepEqual(periods(r), ['03/2021', '08/2021']);
  assert.deepEqual(r.notEmployee, ['08/2021']);
  assert.equal(r.months[0].employers[0].employer, 'EXAMPLE COMPANY, S.L.');
  // Without a bases report the months are still queried (no annotation, no notes).
  const noBases = resolveQuotaMonths({ months: '05/2019' });
  assert.deepEqual(periods(noBases), ['05/2019']);
  assert.deepEqual(noBases.notEmployee, []);
});

test('range + explicit months: union, de-duplicated and sorted', () => {
  const r = resolveQuotaMonths({ basesText: BASES, from: '11/2020', to: '12/2020', months: '12/2020,03/2021,2019-01' });
  assert.deepEqual(periods(r), ['01/2019', '11/2020', '12/2020', '03/2021']);
  assert.deepEqual(r.notEmployee, ['01/2019']);
  const all = resolveQuotaMonths({ allMonths: true, from: '01/2022', to: '02/2022', months: ['06/2021'] });
  assert.deepEqual(periods(all), ['06/2021', '01/2022', '02/2022']);
});

import { parseRanges, filterRecords } from '../src/quotaParser.js';
import { collectRanges } from '../src/quotas.js';

test('parseRanges: formats, lists, objects and validation', () => {
  assert.deepEqual(parseRanges('02/2018-12/2018,2022-01-2023-06'), [{ from: '2018-02', to: '2018-12' }, { from: '2022-01', to: '2023-06' }]);
  assert.deepEqual(parseRanges(['1/2019..3/2019', { from: '2020-05' }]), [{ from: '2019-01', to: '2019-03' }, { from: '2020-05', to: null }]);
  assert.throws(() => parseRanges('12/2019-01/2019'));
  assert.throws(() => parseRanges('2019-13-2020-01'));
  assert.throws(() => parseRanges('02/2018'));
  assert.throws(() => parseRanges([{}]));
  assert.deepEqual(collectRanges({ from: '01/2020', to: '02/2020', ranges: ['2021-01-2021-02'] }), [{ from: '2021-01', to: '2021-02' }, { from: '2020-01', to: '2020-02' }]);
});

test('several ranges + legacy from/to + explicit months: union of employee months and explicit ones', () => {
  const r = resolveQuotaMonths({ basesText: BASES, ranges: ['10/2020-10/2020', '2021-05-2021-12'], from: '01/2021', to: '01/2021', months: ['09/2021'] });
  assert.deepEqual(periods(r), ['10/2020', '01/2021', '05/2021', '06/2021', '09/2021']);
  assert.deepEqual(r.notEmployee, ['09/2021']);
  const all = resolveQuotaMonths({ allMonths: true, ranges: ['01/2022-02/2022', '2022-02-2022-03'] });
  assert.deepEqual(periods(all), ['01/2022', '02/2022', '03/2022']);
});

test('filterRecords: union of ranges, from/to and months', () => {
  const recs = ['2020-01', '2020-02', '2020-03', '2020-04', '2020-05'].map((month) => ({ month }));
  const pick = (f) => filterRecords(recs, f).map((r) => r.month);
  assert.deepEqual(pick({}), ['2020-01', '2020-02', '2020-03', '2020-04', '2020-05']);
  assert.deepEqual(pick({ ranges: ['01/2020-02/2020'], months: ['2020-05'] }), ['2020-01', '2020-02', '2020-05']);
  assert.deepEqual(pick({ ranges: [{ from: '2020-04' }], from: '01/2020', to: '01/2020' }), ['2020-01', '2020-04', '2020-05']);
  assert.throws(() => pick({ ranges: ['bad'] }));
});
