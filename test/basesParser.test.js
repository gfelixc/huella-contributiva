// Pure-function tests (no browser). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONFIG } from '../src/config.js';
import path from 'node:path';
import { parseBasesReport, employeeMonths, summarizeEmployeeMonths } from '../src/basesParser.js';
import { resolveQuotaMonths, parseMonth } from '../src/quotas.js';

const SAMPLE = `
Régimen: TRABAJADOR AUTONOMO Empresa/Razón Social: Régimen Especial de Trab. Autónomo
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2023 --- --- --- --- 1.111,11 1.111,11 1.111,11 1.111,11 1.111,11 1.111,11 1.111,11 1.111,11
Régimen: GENERAL Empresa/Razón Social: ACME, S.L. CCC: 12345678901
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2023 1.000,00 Sin base registrada 2.000,00* Pendiente de actualizar --- --- --- --- --- --- --- ---
Régimen: GENERAL Empresa/Razón Social: OTHER SL CCC: 999
Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre
2023 500,00 --- --- --- --- --- --- --- --- --- --- ---
`;

test('parses sections, cells and self-employed flag', () => {
  const p = parseBasesReport(SAMPLE);
  assert.equal(p.sections.length, 3);
  assert.equal(p.sections[0].selfEmployed, true);
  assert.equal(p.sections[1].employer, 'ACME, S.L.');
  assert.equal(p.sections[1].ccc, '12345678901');
  const acme = p.sections[1].months;
  assert.deepEqual(acme.slice(0, 4).map((m) => m.status), ['base', 'no-base', 'base', 'pending']);
  assert.equal(acme[0].base, 1000);
  assert.equal(acme[2].provisional, true);
});

test('employee months skip RETA, "---" and pending; dedupe overlapping months', () => {
  const ms = employeeMonths(parseBasesReport(SAMPLE));
  assert.deepEqual(ms.map((m) => m.period), ['01/2023', '02/2023', '03/2023']);
  assert.equal(ms[0].employers.length, 2); // ACME + OTHER in 01/2023
});

test('from/to filter and month validation', () => {
  assert.deepEqual(resolveQuotaMonths({ basesText: SAMPLE, from: '02/2023' }).months.map((m) => m.period), ['02/2023', '03/2023']);
  assert.throws(() => parseMonth('13/2023'));
  assert.throws(() => resolveQuotaMonths({ basesText: SAMPLE, from: '05/2023', to: '01/2023' }));
});

// Optional check against the user's own saved report: opt-in only (HUELLA_TEST_REAL_DATA=1),
// asserts structural invariants only and prints nothing personal.
const dir = CONFIG.outputDir; // HUELLA_OUTPUT_DIR or ~/Documents/HuellaContributiva
const real = process.env.HUELLA_TEST_REAL_DATA === '1' && fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^contribution-bases-\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort().at(-1)
  : null;
test('real saved bases report (opt-in)', { skip: !real && 'set HUELLA_TEST_REAL_DATA=1 to run' }, () => {
  const ms = employeeMonths(parseBasesReport(fs.readFileSync(path.join(dir, real), 'utf8')));
  const labels = ms.map((m) => m.label);
  assert.deepEqual(labels, [...labels].sort());
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(ms.every((m) => m.employers.length > 0));
  console.log(`employee months: ${ms.length}, ranges: ${summarizeEmployeeMonths(ms).length}`);
});
