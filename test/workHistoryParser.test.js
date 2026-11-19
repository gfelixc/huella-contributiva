// Invented fixture modelled on the markup of the "Tu vida laboral" page. No real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseWorkHistoryPage, parseDateEs, anonymizeWorkHistory, isAnonymized, parseWorkHistoryIdentity, withPdfIdentity,
  benefitPeriodsFromWorkHistory, mergeWorkHistoryPages, situationOf,
} from '../src/workHistoryParser.js';
import { saveWorkHistoryJson, latestWorkHistoryJson, workHistoryView, workHistoryToolPayload, loadWorkHistory, WH_FORBIDDEN } from '../src/workHistoryPage.js';
import { resolveSepeRequest } from '../src/sepe.js';

const row = (n, { prefix = null, title, regime, contract = 'Sin datos', group = 'Sin datos', effect, start, end, days, expanded = false }) => `
<tr class="ss-table__row${expanded ? ' ss-table__row--is-expanded' : ''}">
 <td id="content-table-1-title-${n}" class="ss-table__col--title">
  <button type="button" class="ss-collapse__btn ss-link" title="${expanded ? 'Cerrar' : 'Abrir'} ${title}" aria-expanded="${expanded}">${prefix ? `<span class="ss-size--16 u-display-block">${prefix}</span>` : ''}<span class="ss-size--16">${title}</span></button>
 </td>
 <td id="content-table-1-trl-${n}" class="ss-u-is-hidden"> Sin datos </td>
 <td id="content-table-1-regime-${n}" class="ss-table__col--item "> R&eacute;gimen: ${regime} </td>
 <td id="content-table-1-contract-${n}" class="ss-table__col--item${contract === 'Sin datos' ? ' ss-u-is-hidden' : ''}"> ${contract === 'Sin datos' ? contract : `Contrato: ${contract}`} </td>
 <td id="content-table-1-journey-${n}" class="ss-table__col--item ss-u-is-hidden"> Sin datos </td>
 <td id="content-table-1-category-${n}" class="ss-table__col--item${group === 'Sin datos' ? ' ss-u-is-hidden' : ''}"> ${group === 'Sin datos' ? group : `Grupo de cotización: ${group}`} </td>
 <td class="ss-table__col--item"> Fecha efecto del alta: ${effect} </td>
 <td class="ss-table__col--date-start">${start}</td>
 <td class="ss-table__col--date-end"> ${end} </td>
 <td class="ss-table__col--floated">${days} días</td>
</tr>`;

const page = ({ name = 'alex', pageInfo = '1 de 1', rows }) => `<html><body>
<header><a href="/wps/myportal/importass/importass/personal/" class="ss-header__action"> ${name} </a>
<button onclick="mostrarModalCierre()">Exit</button></header>
<div id="AFPH02VidaLaboral"></div>
<section class="ss-content">
 <p>Desde tu primer alta en el sistema, has estado de alta un total de <strong>1.200 días</strong>.</p>
 <p>De estos días, has estado de alta de forma simultánea en dos o más empresas o regímenes <strong>30 días</strong>.</p>
 <p>El total de días que cuentan para las prestaciones de la Seguridad Social son <strong>1170</strong> días, que equivalen a:</p>
 <p><strong>3 años, 2 meses y 15 días.</strong></p>
</section>
<select id="empresa"><option value="">Todas</option>
 <optgroup label="RÉGIMEN"><option>Trabajador Autonomo</option><option>Regimen General</option></optgroup>
 <optgroup label="EMPRESA"><option>Example Company, S.L. 00000000000</option></optgroup>
</select>
<button id="control-1">Filtrar por empresa o fecha</button>
<table class="ss-table"><thead><tr><th>Empleador</th><th>TRL</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<div class="ss-pagination" role="navigation"><span class="ss-pagination__info">${pageInfo}</span></div>
<button id="boton-sticky" name="accion" value="AC_DESC_VIDA_LABORAL">Descargar vida laboral</button>
<button name="accion" value="AC_INFORMAR_ERROR">Informar error</button>
</body></html>`;

const ROWS = [
  row(1, { title: 'TRABAJADOR AUTONOMO', regime: 'AUTONOMO', effect: '01 mar 2023', start: '01 mar 2023', end: 'Actual', days: 500 }),
  row(2, { prefix: 'VACACIONES RETRIBUIDAS Y NO DISFRUTADAS', title: 'EXAMPLE COMPANY, S.L.', regime: 'GENERAL', effect: '01 feb 2023', start: '01 feb 2023', end: '05 feb 2023', days: 5 }),
  row(3, { title: 'EXAMPLE COMPANY, S.L.', regime: 'GENERAL', contract: '100 - Indefinido Tiempo Completo', group: '05 - Oficiales administrativos', effect: '10 ene 2021', start: '10 ene 2021', end: '31 ene 2023', days: 600, expanded: true }),
  row(4, { title: 'PRESTACION DESEMPLEO. SUSPENSION', regime: 'GENERAL', effect: '16 abr 2020', start: '16 abr 2020', end: '12 jul 2020', days: 88 }),
  row(5, { title: 'OTHER EXAMPLE LTD', regime: 'GENERAL', effect: '01 sep 2019', start: '01 sep 2019', end: '15 abr 2020', days: 7 }),
];

const PDF_TEXT = `INFORME DE VIDA LABORAL
... resulta que D/Dª PERSONA DE EJEMPLO , nacido/a el 1 de enero de 1990 , con
Número de la Seguridad Social 000000000000 , D.N.I. 00000000T , domicilio en
CALLE EJEMPLO 1 , 00000 CIUDAD EJEMPLO
ha figurado en situación de alta en el Sistema de la Seguridad Social`;

test('Spanish page dates', () => {
  assert.equal(parseDateEs('01 mar 2023'), '2023-03-01');
  assert.equal(parseDateEs('5 dic 2020'), '2020-12-05');
  assert.equal(parseDateEs('1 de enero de 1990'), '1990-01-01');
  assert.equal(parseDateEs('16.04.2020'), '2020-04-16');
  assert.equal(parseDateEs('Actual'), null);
});

test('parses summary, employers and every period of the page', () => {
  const j = parseWorkHistoryPage(page({ rows: ROWS }), { url: 'https://example.invalid/datosvidalaboral', fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.source.page, 'AFPH02VidaLaboral');
  assert.deepEqual(j.summary, { totalDaysRegistered: 1200, simultaneousDays: 30, computableDays: 1170, computableDuration: { years: 3, months: 2, days: 15 } });
  assert.deepEqual(j.regimes, ['Trabajador Autonomo', 'Regimen General']);
  assert.deepEqual(j.employers, [{ name: 'Example Company, S.L.', ccc: '00000000000' }]);
  assert.equal(j.identity.displayName, 'alex');
  assert.equal(j.periods.length, 5);
  const [auto, vac, emp, erte, other] = j.periods;
  assert.equal(auto.situationType, 'self-employed');
  assert.equal(auto.current, true); assert.equal(auto.endDate, null); assert.equal(auto.days, 500); assert.equal(auto.company, null);
  assert.equal(vac.situationType, 'paid-untaken-vacation');
  assert.equal(vac.prefix, 'VACACIONES RETRIBUIDAS Y NO DISFRUTADAS');
  assert.equal(vac.ccc, '00000000000');
  assert.equal(emp.situationType, 'employment');
  assert.equal(emp.contract, '100 - Indefinido Tiempo Completo');
  assert.equal(emp.contributionGroup, '05 - Oficiales administrativos');
  assert.equal(emp.trl, null); assert.equal(emp.workday, null);
  assert.equal(emp.effectDate, '2021-01-10'); assert.equal(emp.startDate, '2021-01-10'); assert.equal(emp.endDate, '2023-01-31');
  assert.equal(emp.regime, 'GENERAL'); assert.equal(emp.ccc, '00000000000');
  assert.equal(erte.situationType, 'unemployment-benefit'); assert.equal(erte.benefitKind, 'erte-suspension');
  assert.equal(other.ccc, null);
  assert.deepEqual(j.pagination, { current: 1, total: 1 });
});

test('situation types', () => {
  assert.equal(situationOf({ title: 'PRESTACION DESEMPLEO. REDUCCION JORNADA' }).benefitKind, 'erte-reduction');
  assert.equal(situationOf({ title: 'SUBSIDIO DESEMPLEO' }).benefitKind, 'unemployment');
  assert.equal(situationOf({ title: 'X', regime: 'AUTONOMO' }).situationType, 'self-employed');
});

test('anonymised copy has no identifying data (page + PDF identity)', () => {
  const full = withPdfIdentity(parseWorkHistoryPage(page({ rows: ROWS })), parseWorkHistoryIdentity(PDF_TEXT), { pdfPath: '/absolute/path/to/work-history-2026-01-01.pdf', txtPath: '/absolute/path/to/work-history-2026-01-01.txt' });
  assert.equal(full.identity.fullName, 'PERSONA DE EJEMPLO');
  assert.equal(full.identity.birthDate, '1990-01-01');
  assert.equal(full.identity.socialSecurityNumber, '000000000000');
  assert.equal(full.identity.idDocument, '00000000T');
  assert.equal(full.identity.idDocumentType, 'DNI');
  assert.equal(full.identity.address, 'CALLE EJEMPLO 1 , 00000 CIUDAD EJEMPLO');
  const anon = anonymizeWorkHistory(full);
  const s = JSON.stringify(anon);
  assert.equal(anon.anonymized, true);
  assert.equal('identity' in anon, false);
  for (const v of ['alex', 'PERSONA DE EJEMPLO', 'PERSONA', '1990-01-01', '000000000000', '00000000T', 'CALLE EJEMPLO', '/absolute/path']) assert.ok(!s.includes(v), v);
  assert.ok(isAnonymized(anon, full));
  assert.equal(anon.periods.length, 5);
  assert.equal(anon.periods[2].company, 'EXAMPLE COMPANY, S.L.');
  assert.equal(anon.employers[0].ccc, '00000000000');
  assert.equal(anon.source.pdf.pdf, 'work-history-2026-01-01.pdf');
});

test('a display name that also appears elsewhere is redacted', () => {
  const full = parseWorkHistoryPage(page({ name: 'Zorblat', rows: [row(1, { title: 'ZORBLAT CONSULTING', regime: 'GENERAL', effect: '01 mar 2023', start: '01 mar 2023', end: 'Actual', days: 3 })] }));
  const anon = anonymizeWorkHistory(full);
  assert.ok(!/zorblat/i.test(JSON.stringify(anon)));
  assert.ok(isAnonymized(anon, full));
});

test('pagination: pages merged and renumbered', () => {
  const p1 = parseWorkHistoryPage(page({ rows: ROWS.slice(0, 3), pageInfo: '1 de 2' }), { pageNumber: 1 });
  const p2 = parseWorkHistoryPage(page({ rows: ROWS.slice(3), pageInfo: '2 de 2' }), { pageNumber: 2 });
  assert.deepEqual(p1.pagination, { current: 1, total: 2 });
  const m = mergeWorkHistoryPages([p1, p2]);
  assert.equal(m.periods.length, 5);
  assert.deepEqual(m.periods.map((p) => p.index), [1, 2, 3, 4, 5]);
  assert.equal(m.periods[4].page, 2);
  assert.equal(m.source.pages, 2);
});

test('benefit periods from the JSON feed the SEPE default years', () => {
  const j = parseWorkHistoryPage(page({ rows: ROWS }));
  const b = benefitPeriodsFromWorkHistory(j, { now: new Date(2025, 0, 1) });
  assert.deepEqual(b, [{ kind: 'erte-suspension', label: 'PRESTACION DESEMPLEO. SUSPENSION', regime: 'GENERAL', from: '2020-04-16', to: '2020-07-12', days: 88, months: ['2020-04', '2020-05', '2020-06', '2020-07'] }]);
  const plan = resolveSepeRequest({ benefitPeriods: b, now: new Date(2025, 0, 1) });
  assert.deepEqual(plan.years, [2020]);
});

test('row-expansion blocklist covers the page actions', () => {
  for (const l of ['Descargar vida laboral', 'Informar error', 'Filtrar por empresa o fecha', 'Exit', 'Salir']) assert.ok(WH_FORBIDDEN.test(l), l);
  assert.ok(!WH_FORBIDDEN.test('EXAMPLE COMPANY, S.L.'));
});

test('saved JSON files and the tool payload (path + anonymised content only)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-wh-test-'));
  try {
    const full = withPdfIdentity(parseWorkHistoryPage(page({ rows: ROWS })), parseWorkHistoryIdentity(PDF_TEXT));
    const saved = await saveWorkHistoryJson(full, { dir, day: '2026-01-01' });
    assert.equal(path.basename(saved.jsonPath), 'work-history-2026-01-01.json');
    assert.equal(path.basename(saved.anonPath), 'work-history-2026-01-01.anon.json');
    const latest = await latestWorkHistoryJson({ dir });
    assert.equal(latest.full.identity.fullName, 'PERSONA DE EJEMPLO');
    const v = await workHistoryView({ dir });
    assert.equal(v.ok, true);
    assert.deepEqual(Object.keys(v.payload), ['folder', 'fullJsonFile', 'workHistory']);
    assert.equal(v.payload.fullJsonFile, path.basename(saved.jsonPath));
    assert.ok(!JSON.stringify(v.payload).includes(dir));
    const s = JSON.stringify(v.payload.workHistory);
    assert.ok(!s.includes('PERSONA DE EJEMPLO') && !s.includes('00000000T') && !s.includes('alex'));
    assert.deepEqual(Object.keys(workHistoryToolPayload({ jsonPath: 'a', anon: {} })), ['folder', 'fullJsonFile', 'workHistory']);
    const wh = await loadWorkHistory({ dir, now: new Date(2025, 0, 1) });
    assert.equal(wh.source, 'json');
    assert.equal(wh.file, 'work-history-2026-01-01.json');
    assert.equal(wh.benefitPeriods.length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('no JSON saved: view says so without any report text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-wh-test-'));
  try {
    const v = await workHistoryView({ dir });
    assert.equal(v.ok, false);
    assert.match(v.message, /get_work_history_report/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
