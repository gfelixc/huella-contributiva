// SEPE benefit certificates: pure functions, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSepeCertificate, parseBenefitPeriods, monthsBetween, selectSepeRecords, sepeToCsv, formatSepeCompact } from '../src/sepeParser.js';
import { resolveSepeRequest, classifySepeFiles, SEPE_FORBIDDEN, findAccessLink, accessHref, hasCookieBanner } from '../src/sepe.js';
import { buildContributionsReport } from '../src/contributionsReport.js';

const ANNUAL = `
CERTIFICADO DE IMPORTES ANUALES
D./Dña. EXAMPLE PERSON, con DNI/NIE 00000000T, ha percibido prestaciones por desempleo
en el ejercicio 2020 por los siguientes importes:
Importe bruto 3.456,78 €
Abono cuota fija REASS 0,00 €
Retención I.R.P.F. 123,45 €
Deducción Seguridad Social 210,98 €
`;
const PERIOD = `
CERTIFICADO DE IMPORTES POR PERIODO
Prestación contributiva percibida en el periodo de 04/2020 a 07/2020
Importe bruto
Retención IRPF
Deducción Seguridad Social
3.000,00
100,00
150,00
`;
const IRPF = `
CERTIFICADO DE RETENCIONES E INGRESOS A CUENTA DEL IRPF
Ejercicio Importe íntegro Retenciones Deducción S.S.
2020 1.000,00 50,00 40,00
`;
const NONE = 'CERTIFICADO DE IMPORTES ANUALES\nEn el ejercicio 2019 no consta que haya percibido prestaciones.';

test('annual certificate: same-line labels and amounts', () => {
  const r = parseSepeCertificate(ANNUAL);
  assert.deepEqual([r.kind, r.status, r.year, r.periodFrom, r.periodTo], ['annual', 'ok', 2020, '2020-01', '2020-12']);
  assert.deepEqual([r.gross, r.reass, r.irpf, r.ssDeduction, r.net], [3456.78, 0, 123.45, 210.98, 3122.35]);
  assert.equal(r.benefitType, 'unemployment benefit (prestación/subsidio)');
});

test('period certificate: column block layout', () => {
  const r = parseSepeCertificate(PERIOD);
  assert.deepEqual([r.kind, r.status, r.periodFrom, r.periodTo, r.year], ['period', 'ok', '2020-04', '2020-07', 2020]);
  assert.deepEqual([r.gross, r.irpf, r.ssDeduction, r.net], [3000, 100, 150, 2750]);
  assert.equal(r.benefitType, 'contributory unemployment benefit');
});

test('IRPF certificate table row and certificates without amounts', () => {
  const r = parseSepeCertificate(IRPF);
  assert.deepEqual([r.kind, r.year, r.gross, r.irpf, r.ssDeduction], ['irpf', 2020, 1000, 50, 40]);
  const n = parseSepeCertificate(NONE);
  assert.equal(n.status, 'no-amounts');
  assert.equal(parseSepeCertificate('random text').status, 'unparsed');
});

const WORK_HISTORY = `
GENERAL EXAMPLE COMPANY, S.L. 01.01.2019 01.01.2019 --- 100 501 100 --- 600
GENERAL ----------- PRESTACION DESEMPLEO. SUSPENSION 16.04.2020 16.04.2020 12.07.2020 --- --- -- 88
`;

test('benefit periods from the work history report', () => {
  const p = parseBenefitPeriods(WORK_HISTORY, { now: new Date(2025, 0, 1) });
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].kind, p[0].from, p[0].to, p[0].days], ['erte-suspension', '2020-04-16', '2020-07-12', 88]);
  assert.deepEqual(p[0].months, ['2020-04', '2020-05', '2020-06', '2020-07']);
  assert.deepEqual(monthsBetween('2020-11-20', '2021-02-01'), ['2020-11', '2020-12', '2021-01', '2021-02']);
});

test('request resolution: defaults, explicit years, period validation', () => {
  const now = new Date(2025, 0, 1);
  assert.deepEqual(resolveSepeRequest({ workHistoryText: WORK_HISTORY, now }).years, [2020]);
  assert.equal(resolveSepeRequest({ now }).source, 'default year 2020');
  assert.deepEqual(resolveSepeRequest({ years: ['2021,2022'], ranges: [{ from: '2019-05', to: '2019-06' }], now }).years, [2019, 2021, 2022]);
  assert.deepEqual(resolveSepeRequest({ period: '04/2020-07/2020', now }).period, { from: '2020-04', to: '2020-07' });
  assert.deepEqual(resolveSepeRequest({ period: 'auto', workHistoryText: WORK_HISTORY, now }).period, { from: '2020-04', to: '2020-07' });
  assert.throws(() => resolveSepeRequest({ period: '01/2020-02/2021', now }), /at most 12/);
  assert.throws(() => resolveSepeRequest({ period: 'auto', now }), /needs an unemployment/);
  assert.throws(() => resolveSepeRequest({ years: ['20x0'], now }), /Invalid year/);
});

test('file classification, record selection, CSV, compact view and safety list', () => {
  const files = classifySepeFiles(['sepe-2025-01-02-annual-2020.txt', 'sepe-2025-01-02-period-202004-202007.txt', 'sepe-2025-01-02-login-page.txt', 'other.txt']);
  assert.deepEqual(files.map((f) => f.label), ['annual-2020', 'period-202004-202007']);
  const a = { ...parseSepeCertificate(ANNUAL), day: '2025-01-01', source: 'a.txt' };
  const b = { ...parseSepeCertificate(ANNUAL), day: '2025-01-02', source: 'b.txt' };
  const sel = selectSepeRecords([a, b, { ...parseSepeCertificate('x'), day: '2025-01-03' }]);
  assert.deepEqual(sel.map((r) => r.source), ['b.txt']);
  assert.match(sepeToCsv(sel).split('\n')[1], /^annual,2020,2020-01,2020-12,ok,/);
  assert.match(formatSepeCompact(sel, parseBenefitPeriods(WORK_HISTORY)), /210\.98/);
  for (const label of ['Desea recibirlo por correo al domicilio', 'CONFIRMAR', 'Modificar cuenta bancaria', 'Renovar demanda', 'Cita previa', 'Solicitud de prestaciones'])
    assert.match(label, SEPE_FORBIDDEN);
  for (const label of ['ACEPTAR', 'MOSTRAR', 'OBTENER', 'Desea descargarlo desde internet', 'De importes anuales'])
    assert.doesNotMatch(label, SEPE_FORBIDDEN);
});

test('contributions report: SEPE entries, ERTE overlap, no double counting', () => {
  const annual = { ...parseSepeCertificate(ANNUAL), day: '2025-01-02', source: 'sepe-annual-2020.txt' };
  const period = { ...parseSepeCertificate(PERIOD), day: '2025-01-02', source: 'sepe-period.txt' };
  const quota = { month: '2020-05', status: 'ok', regime: '0111', ccc: '00000000000', employer: 'EXAMPLE COMPANY, S.L.', liquidationType: 'L00-NORMAL',
    base: 1000, workerQuota: 60, employerQuota: 300, total: 360, liquidation: null, source: 'calc.txt' };
  const rep = buildContributionsReport({ quotaRecords: [quota], sepeRecords: [annual, period], benefitPeriods: parseBenefitPeriods(WORK_HISTORY), now: new Date(2025, 0, 1) });
  const sepe = rep.payments.filter((p) => p.payerType === 'public_agency');
  assert.equal(sepe.length, 1);
  assert.deepEqual([sepe[0].payerName, sepe[0].month, sepe[0].periodFrom, sepe[0].periodTo, sepe[0].amount, sepe[0].grossBenefit, sepe[0].benefitOverlap],
    ['SEPE', null, '2020-04', '2020-07', 210.98, 3456.78, 'erte-suspension']);
  assert.equal(rep.payments.find((p) => p.payerType === 'worker').benefitOverlap, 'erte-suspension');
  assert.ok(rep.notes.some((n) => n.type === 'benefit-period' && /SEPE deductions included/.test(n.message)));
  assert.ok(rep.notes.some((n) => n.type === 'sepe-period-certificate'));
  const agency = rep.aggregates.byPayerType.find((g) => g.payerType === 'public_agency') || rep.aggregates.byPayerType.public_agency;
  assert.ok(agency);
  assert.equal(rep.aggregates.grand.months, 1);
});

// Synthetic copy of the public entry page structure (cookie veil + the two access buttons).
const ENTRY_HTML = `
<div class="cookies-veil js-cookies-banner is-visible" role="dialog"><button class="js-cookies-accept">Aceptar todas</button>
<button class="js-cookies-reject btn">Rechazar todas</button></div>
<form name="TipoAutenticadoForm" method="post" action="/DServiciosPrestanetWEB/TipoAutenticadoAction.do"><ul class="lstBotoneras">
  <li><a href="/DServiciosPrestanetWEB/TipoAutenticadoAction.do" class="boton">Certificado digital, DNI electr&oacute;nico o usuario Cl@ve</a></li>
  <li><a href="/DServiciosPrestanetWEB/TipoDatosContrasteAction.do" class="boton">Pin Teléfono Móvil</a></li>
</ul></form>`;

test('entry page: access link, href validation and cookie banner detection', () => {
  const link = findAccessLink(ENTRY_HTML);
  assert.deepEqual(link, { href: 'https://sede.sepe.gob.es/DServiciosPrestanetWEB/TipoAutenticadoAction.do', text: 'Certificado digital, DNI electrónico o usuario Cl@ve', count: 1 });
  assert.equal(accessHref('/DServiciosPrestanetWEB/TipoDatosContrasteAction.do'), null);
  assert.equal(accessHref('https://example.com/DServiciosPrestanetWEB/TipoAutenticadoAction.do'), null);
  assert.equal(accessHref('http://sede.sepe.gob.es/DServiciosPrestanetWEB/TipoAutenticadoAction.do'), null);
  assert.equal(findAccessLink('<a href="/x">Certificado digital, DNI electrónico o usuario Cl@ve</a>'), null);
  assert.ok(hasCookieBanner(ENTRY_HTML));
  assert.ok(!hasCookieBanner(ENTRY_HTML.replace(' is-visible', '')));
});
