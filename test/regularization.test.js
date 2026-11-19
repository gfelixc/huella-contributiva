// RETA annual regularisation: pure parsing, selection and safety rules. Synthetic texts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRegularization, parseAmountEs, selectRegularizationRecords, regularizationToCsv, formatRegularizationCompact, regularizationYears,
  parseRegularizationCards, isRegularizationHistoryPage, isRegularizationQueryForm, isRegularizationInfoPage, resolutionYear, checkResolutionPdf, regularizationPaymentEvidence,
} from '../src/regularizationParser.js';
import { REG_FORBIDDEN, REGULARIZATION, isBlockedNavigation, classifyRegularizationFiles, isAllowedResolutionButton, createResolutionStore, resolutionUrlFromOnclick } from '../src/regularization.js';

const REFUND = `Regularización de cuotas del ejercicio 2024
Rendimientos netos computables comunicados: 18.000,00
Base de cotización provisional  Base de cotización definitiva  Diferencia
ENERO 1.200,00 1.000,00 -200,00
FEBRERO 1.200,00 1.000,00 -200,00
Importe a devolver: 123,45
La devolución se realizará de oficio antes del 30 de abril.`;

const CLAIM = `Resolución de regularización del año 2024
Diferencias a ingresar: 1.234,56 euros
Fecha límite de ingreso: 31/03/2026
Estado: pendiente de pago`;

test('amounts in Spanish format', () => {
  assert.equal(parseAmountEs('1.234,56'), 1234.56);
  assert.equal(parseAmountEs('-200,00'), -200);
  assert.equal(parseAmountEs(null), null);
});

test('refund: amount, sign, income and month table', () => {
  const r = parseRegularization(REFUND);
  assert.deepEqual([r.year, r.status, r.amount, r.signedAmount, r.netIncome], [2024, 'refund', 123.45, -123.45, 18000]);
  assert.equal(r.dueDate, null);
  assert.equal(r.months.length, 2);
  assert.deepEqual(r.months[0], { period: '2024-01', values: [1200, 1000, -200], provisionalBase: 1200, definitiveBase: 1000, difference: -200 });
});

test('claim: amount, due date, payment status', () => {
  const r = parseRegularization(CLAIM);
  assert.deepEqual([r.year, r.status, r.amount, r.signedAmount, r.dueDate, r.paymentStatus], [2024, 'claim', 1234.56, 1234.56, '2026-03-31', 'pending']);
});

test('no difference, not regularisable, pending, unknown', () => {
  assert.equal(parseRegularization('Regularización del ejercicio 2023. No existen diferencias entre las bases.').status, 'no-difference');
  const nr = parseRegularization('Periodos no regularizables: tarifa plana', { year: 2023 });
  assert.deepEqual([nr.status, nr.year, nr.amount, nr.signedAmount], ['not-regularisable', 2023, 0, 0]);
  assert.equal(parseRegularization('Su regularización está pendiente de notificar', { year: 2025 }).status, 'pending');
  const u = parseRegularization('Página de inicio', { year: 2025 });
  assert.equal(u.status, 'unknown');
  assert.match(u.message, /saved for review/);
});

test('month table follows the header column order', () => {
  const r = parseRegularization(`Ejercicio 2024
Mes Diferencia Base definitiva Base provisional
03/2024 50,00 1.050,00 1.000,00`);
  assert.deepEqual([r.months[0].period, r.months[0].provisionalBase, r.months[0].definitiveBase, r.months[0].difference], ['2024-03', 1000, 1050, 50]);
});

test('selection: latest day with a result, PDF preferred, missing fields completed', () => {
  const recs = selectRegularizationRecords([
    { ...parseRegularization(CLAIM), day: '2026-02-01', kind: 'page', source: 'a-page.txt' },
    { ...parseRegularization('Regularización del ejercicio 2024. Diferencias a ingresar: 1.234,56', { year: 2024 }), day: '2026-03-01', kind: 'pdf', source: 'b.txt' },
    { ...parseRegularization(CLAIM), day: '2026-03-01', kind: 'page', source: 'c-page.txt' },
    { ...parseRegularization('nada', { year: 2025 }), day: '2026-03-01', kind: 'page', source: 'd-page.txt' },
  ]);
  assert.deepEqual(recs.map((r) => [r.year, r.status]), [[2024, 'claim'], [2025, 'unknown']]);
  assert.equal(recs[0].sources[0], 'b.txt');
  assert.equal(recs[0].dueDate, '2026-03-31'); // completed from the same-day page
  assert.match(regularizationToCsv(recs), /^year,status,amount/);
  assert.match(formatRegularizationCompact(recs, { years: [2023, 2024, 2025] }), /not fetched \/ unknown yet: 2023, 2025/);
});

test('years: explicit validation and default from RETA months', () => {
  const now = new Date(2026, 10, 16);
  assert.deepEqual(regularizationYears({ retaMonths: ['2022-11', '2023-05', '2024-01', '2026-02'], now }).years, [2023, 2024]);
  assert.deepEqual(regularizationYears({ years: ['2024,2025'], now }).years, [2024, 2025]);
  assert.throws(() => regularizationYears({ years: ['2022'], now }), /2023\.\.2025/);
  assert.throws(() => regularizationYears({ years: ['2026'], now }), /No RETA regularisation/);
  assert.throws(() => regularizationYears({ years: ['abc'], now }), /Invalid year/);
  assert.deepEqual(regularizationYears({ retaMonths: [], now }).years, []);
});

test('saved file names', () => {
  const list = classifyRegularizationFiles(['reta-regularisation-2026-03-01-2024.txt', 'reta-regularisation-2026-03-01-anteriores-1-page.txt',
    'reta-regularisation-2026-03-01-2024.pdf', 'reta-regularisation.summary.csv', 'other.txt']);
  assert.deepEqual(list.map((f) => [f.day, f.label, f.kind]), [['2026-03-01', '2024', 'pdf'], ['2026-03-01', 'anteriores-1', 'page']]);
});

test('safety: forbidden labels are never clicked, read-only labels are allowed', () => {
  for (const label of ['Mantener base', 'Optar por la base', 'Anular', 'Pagar', 'Pago con tarjeta', 'Obtener documento de pago', 'Formular consulta',
    'Solicitar devolución', 'Cuenta bancaria', 'Apoderamiento: apoderado', 'Confirmar', 'Aceptar', 'Firmar', 'Notificaciones', 'Acceder a DEHú', 'Salir'])
    assert.ok(REG_FORBIDDEN.test(label), `must be forbidden: ${label}`);
  for (const label of ['Consultar', 'Ver detalle', 'Descargar resolución', 'Regularización de cuotas', 'Años anteriores', '2024'])
    assert.ok(!REG_FORBIDDEN.test(label), `must be allowed: ${label}`);
});

test('safety: notification navigations are blocked, the services are not', () => {
  for (const url of ['https://dehu.redsara.es/', 'https://sede.seg-social.gob.es/wps/portal/sede/sede/Notificaciones', 'https://example.invalid/notess/inbox'])
    assert.ok(isBlockedNavigation(url), url);
  for (const url of [REGULARIZATION.services.current, REGULARIZATION.services.previous, REGULARIZATION.infoUrl])
    assert.ok(!isBlockedNavigation(url), url);
});

// Synthetic "años anteriores" page (same layout as the live page; invented amounts).
const HISTORY = `URL: https://portal.seg-social.gob.es/wps/myportal/importass/importass/tramites/regularizacionCuotasAnyosAnteriores

Mensajes pendientes
RALI05RegularizacionHistorico
Área personal Regularización anual de cuotas de años anteriores
Regularización anual de cuotas de años anteriores
Consulta tu regularización anual de cuotas de trabajo autónomo de años anteriores.
 Verás el resultado inicial de la regularización sin tener en cuenta los posibles cambios que hayan podido producirse posteriormente.
Resolución 2025
RÉGIMEN ESPECIAL TRABAJADORES AUTÓNOMOS
2025
A devolver: 1.010,10 €
Resolución 2024
RÉGIMEN ESPECIAL TRABAJADORES AUTÓNOMOS
2024
A ingresar: 11,11 €
Resolución no dispobible
RÉGIMEN ESPECIAL TRABAJADORES AUTÓNOMOS
2023
Sin diferencias
1 de 1
Treasury services
Vida laboral e informes`;

test('"años anteriores" cards: year, regime, status, amount, PDF availability', () => {
  assert.ok(isRegularizationHistoryPage(HISTORY));
  const cards = parseRegularizationCards(HISTORY);
  assert.deepEqual(cards.map((c) => [c.year, c.status, c.amount, c.signedAmount, c.available]),
    [[2025, 'refund', 1010.1, -1010.1, true], [2024, 'claim', 11.11, 11.11, true], [2023, 'no-difference', 0, 0, false]]);
  assert.match(cards[0].regime, /AUTÓNOMOS/);
  assert.deepEqual(parseRegularizationCards('Resolución 2024\nRÉGIMEN X\n2024\nPendiente de resolver').map((c) => c.status), ['pending']);
  assert.deepEqual(parseRegularizationCards('no cards here'), []);
});

test('page kinds: query form and info page are never data sources', () => {
  assert.ok(isRegularizationQueryForm('TRIA01RegularizacionAutonomos\nVas a solicitar una consulta por tu regularización'));
  assert.ok(!isRegularizationQueryForm(HISTORY));
  assert.ok(isRegularizationInfoPage(`URL: ${REGULARIZATION.infoUrl}\n\nRegularización`));
  assert.ok(!isRegularizationInfoPage(HISTORY));
});

test('card wins for status/amount, the resolution PDF completes the rest', () => {
  const pdfText = `RESOLUCIÓN SOBRE REGULARIZACIÓN DE CUOTAS DEL EJERCICIO 2024
Rendimientos netos computables: 15.000,00
Base de cotización definitiva: 1.050,00
Importe a ingresar: 11,11
Fecha límite de ingreso: 31/12/2026
Dicho importe podrá ser ingresado sin recargo hasta el último día del mes siguiente a aquel en que se notifique la presente resolución, utilizando el documento de pago que se adjunta.`;
  const pdf = parseRegularization(pdfText, { year: 2024 });
  assert.deepEqual([pdf.status, pdf.amount, pdf.dueDate, pdf.netIncome, pdf.definitiveBase], ['claim', 11.11, '2026-12-31', 15000, 1050]);
  assert.equal(pdf.paymentInfo, 'payment document attached; without surcharge until the last day of the month after notification');
  assert.equal(pdf.paymentStatus, null); // "podrá ser ingresado" is not evidence of payment
  const cards = parseRegularizationCards(HISTORY).map((c) => ({ ...c, day: '2026-11-17', kind: 'card', source: 'x-previous-1-page.txt' }));
  const recs = selectRegularizationRecords([...cards, { ...pdf, day: '2026-11-17', kind: 'pdf', source: 'x-2024.txt' }]);
  const r2024 = recs.find((r) => r.year === 2024);
  assert.deepEqual([r2024.kind, r2024.status, r2024.amount, r2024.dueDate, r2024.netIncome, r2024.definitiveBase, r2024.pdfAmount],
    ['card', 'claim', 11.11, '2026-12-31', 15000, 1050, undefined]);
  assert.deepEqual(r2024.sources, ['x-previous-1-page.txt', 'x-2024.txt']);
  assert.match(regularizationToCsv(recs), /x-2024\.txt/);
  // A PDF parsed to a different amount is flagged, the card amount is kept.
  const odd = selectRegularizationRecords([cards[1], { ...pdf, amount: 99, day: '2026-11-17', kind: 'pdf', source: 'x-2024.txt' }]);
  assert.deepEqual([odd[0].amount, odd[0].pdfAmount], [11.11, 99]);
  assert.match(formatRegularizationCompact(odd), /check/);
});

test('allowlist: only the "Resolución <year>" DESCARGAR button', () => {
  const b = { tag: 'BUTTON', name: 'accion', value: 'DESCARGAR', text: ' Resolución 2024 ' };
  assert.ok(isAllowedResolutionButton(b, 2024));
  assert.ok(!isAllowedResolutionButton(b, 2023));
  assert.ok(!isAllowedResolutionButton({ ...b, disabled: true }, 2024));
  assert.ok(!isAllowedResolutionButton({ ...b, value: 'ENVIAR' }, 2024));
  assert.ok(!isAllowedResolutionButton({ ...b, tag: 'A' }, 2024));
  assert.ok(!isAllowedResolutionButton({ ...b, text: 'Resolución no dispobible' }, 2024));
  assert.ok(!isAllowedResolutionButton({ ...b, text: 'Pagar resolución 2024' }, 2024));
  assert.ok(!REG_FORBIDDEN.test('Resolución 2024')); // and the blocklist still covers everything else
});

// Synthetic resolution letter with the same structure as the real one (invented names, numbers and dates).
const resolutionText = (year, body) => `MODELO TA R 00 000
REFERENCIAS ELECTRÓNICAS
Id. CEA: Fecha: Código CEA: Página:
DAAAAAAAAAAA 01/02/2099 AAAAA-AAAAA 1
Este documento no será válido sin la referencia electrónica. La autenticidad de este documento puede ser comprobada hasta la fecha 01/02/2099 mediante el
Código Electrónico de Autenticidad en la Sede Electrónica de la Seguridad Social, a través del Servicio de Verificación de Integridad de Documentos.
Hola, EXAMPLE PERSON:
la Tesorería General de la Seguridad Social (TGSS) ha realizado la regularización de tus bases de cotización y cuotas de la Seguridad Social, como persona trabajadora por cuenta
propia, correspondientes al año ${year}, que, hasta este momento, eran provisionales.
RESOLUCIÓN SOBRE BASE DE COTIZACIÓN DEFINITIVA DEL AÑO ${year} COMO
PERSONA TRABAJADORA AUTÓNOMA
${body}
Contra esta resolución podrá interponerse recurso de alzada en el plazo de un mes.
Fecha de resolución: 03/02/${year + 2}`;
const CONFIRMED = (year) => resolutionText(year, `Con la información disponible, se ha constatado que durante la totalidad de ese ejercicio se encontró en
alguna de las siguientes situaciones: tarifa plana por inicio de actividad, percepción de una prestación.
No procede modificar las bases de cotización provisionales por la que cotizó durante estas situaciones.
En consecuencia, la Tesorería General de la Seguridad Social resuelve CONFIRMAR como definitivas

las bases de cotización provisionales del año ${year}.
De conformidad con lo establecido en esta resolución no existen diferencias en la cotización a la
Seguridad Social que deban ingresarse o devolverse.`);

test('resolution PDF: confirmed bases, no difference, resolution date, boilerplate ignored', () => {
  const r = parseRegularization(CONFIRMED(2030));
  assert.deepEqual([r.year, r.status, r.amount, r.dueDate, r.resolutionDate, r.confirmedBases, r.exemptYear],
    [2030, 'no-difference', 0, null, '2032-02-03', true, true]);
  const c = parseRegularization(resolutionText(2031, 'Importe a ingresar: 22,22\nFecha límite de ingreso: 31/03/2033'));
  assert.deepEqual([c.year, c.status, c.amount, c.dueDate, c.resolutionDate], [2031, 'claim', 22.22, '2033-03-31', '2033-02-03']);
  assert.equal(resolutionYear(CONFIRMED(2030)), 2030);
});

test('stale capture: the second click must not reuse the first year\'s PDF', async () => {
  const pdfA = Buffer.from('%PDF-A'); const pdfA2 = Buffer.from('%PDF-A-other-copy'); const pdfB = Buffer.from('%PDF-B'); const pdfX = Buffer.from('%PDF-X');
  const texts = new Map([[pdfA, CONFIRMED(2030)], [pdfA2, CONFIRMED(2030)], [pdfB, resolutionText(2031, 'Importe a ingresar: 22,22')], [pdfX, 'no year here']]);
  const written = [];
  const store = createResolutionStore({ extract: async (b) => texts.get(b), save: async (b, label) => { written.push(label); return { pdfPath: `x-${label}.pdf` }; }, years: [2030, 2031] });
  assert.equal((await store.accept(pdfA, 2030)).year, 2030); // click 2030
  assert.equal(await store.accept(pdfA, 2031), null); // click 2031 → same bytes again (stale)
  assert.match(store.rejected.at(-1).reason, /same file as the 2030 resolution/);
  assert.equal(await store.accept(pdfA2, 2031), null); // different bytes but the 2030 resolution
  assert.match(store.rejected.at(-1).reason, /is the 2030 resolution, not 2031/);
  const b = await store.accept(pdfB, 2031); // the real 2031 PDF arrives
  assert.deepEqual([b.year, b.verified], [2031, true]);
  assert.deepEqual(written, ['2030', '2031']); // nothing saved under a wrong year
  const x = await store.accept(pdfX, 2031);
  assert.equal(x, null); // year not in the text and 2031 already saved: ignored
  assert.deepEqual(written, ['2030', '2031']);
  assert.equal(checkResolutionPdf({ hash: 'h', text: 'no year', year: 2031 }).verified, false);
});

test('late download of another requested year is kept for that year', async () => {
  const late = Buffer.from('%PDF-late');
  const store = createResolutionStore({ extract: async () => resolutionText(2031, 'Importe a devolver: 5,00'), save: async (b, label) => ({ pdfPath: `x-${label}.pdf` }), years: [2030, 2031] });
  const f = await store.accept(late, 2030); // clicked 2030, got 2031's PDF
  assert.equal(f.year, 2031);
  assert.ok(store.saved.has(2031) && !store.saved.has(2030));
  assert.equal(await store.acceptAny(late), null); // same bytes again: ignored
});

test('download URL from the button onclick (same request as the click)', () => {
  const onclick = 'descargaDoc(this,"p0/IZ7_X=CZ6_Y=NJgenDoc=Eanio!2031=idSgda!ABC=accion!DESCARGAR==/");';
  assert.equal(resolutionUrlFromOnclick(onclick, 2031), 'p0/IZ7_X=CZ6_Y=NJgenDoc=Eanio!2031=idSgda!ABC=accion!DESCARGAR==/');
  assert.equal(resolutionUrlFromOnclick(onclick.replace(/"/g, '&quot;'), 2031), 'p0/IZ7_X=CZ6_Y=NJgenDoc=Eanio!2031=idSgda!ABC=accion!DESCARGAR==/');
  assert.equal(resolutionUrlFromOnclick(onclick, 2030), null); // other year
  assert.equal(resolutionUrlFromOnclick(onclick.replace('DESCARGAR', 'ENVIAR'), 2031), null);
  assert.equal(resolutionUrlFromOnclick('somethingElse()', 2031), null);
});

// Synthetic monthly table of a resolution (invented quotas and income).
const TABLE_LETTER = resolutionText(2031, `el importe de la base de cotización definitiva del año 2031 es de 1.111,11 euros.
El promedio mensual de sus bases de cotización provisionales del año 2031 es de 999,99 euros.
● Los rendimientos declarados o comprobados en el Impuesto sobre la Renta de las Personas Físicas han sido de
10.000,00 euros.
● Las cuotas de la Seguridad Social deducidas en el Impuesto sobre la Renta de las Personas Físicas han sido de
1.000,00 euros.
● A la suma de los citados rendimientos y las cuotas de la Seguridad Social, 11.000,00 euros, se le ha aplicado una
deducción por gastos genéricos del 7,00 por ciento, 770,00 euros, resultando un importe anual computable para la
determinación de la base de cotización definitiva de 10.230,00 euros.
● sus rendimientos mensuales computables para la determinación de
dicha base en ese ejercicio son de 99.999,99 euros.
Dicho importe podrá ser ingresado, sin recargo, hasta el
último día del mes siguiente a aquel en que se notifique la presente resolución, utilizando el documento de pago que se adjunta.
Mes
Cuotas por bases
provisionales a
01/01/2032
Cuotas por bases
definitivas a
01/02/2032
Resultado de la
regularización
Información
adicional*
Ene/2031 10,00 10,00 0,00 -

Nov/2031 20,00 25,00 5,00 -

Dic/2031 30,00 40,00 10,00 Texto informativo

TOTAL 60,00 € 75,00 € 15,00 €
RESULTADO ANUAL DE LA REGULARIZACIÓN: A INGRESAR 15,00 €`);

test('resolution monthly quota table, totals, bases and income lines', () => {
  const r = parseRegularization(TABLE_LETTER);
  assert.deepEqual([r.year, r.status, r.amount, r.definitiveBase, r.provisionalBase, r.netIncome, r.paymentStatus], [2031, 'claim', 15, 1111.11, 999.99, 10230, null]);
  assert.deepEqual(r.months.map((m) => [m.period, m.provisionalQuota, m.definitiveQuota, m.difference, m.info]),
    [['2031-01', 10, 10, 0, null], ['2031-11', 20, 25, 5, null], ['2031-12', 30, 40, 10, 'Texto informativo']]);
  assert.deepEqual(r.totals, { provisionalQuota: 60, definitiveQuota: 75, difference: 15 });
  assert.deepEqual([r.income.declaredIncome, r.income.deductedQuotas, r.income.incomePlusQuotas, r.income.genericDeduction, r.income.genericDeductionPct, r.income.annualComputableIncome],
    [10000, 1000, 11000, 770, 7, 10230]);
  assert.equal(r.income.monthlyComputableIncomeStated, 99999.99); // as printed in the letter
  assert.equal(r.income.monthlyComputableIncomeInconsistent, true); // larger than the annual figure
  assert.equal(r.income.monthlyComputableIncomeDerived, 852.5);
});

test('payment evidence from the paid contributions report, never guessed', () => {
  const rec = parseRegularization(TABLE_LETTER);
  const full = regularizationPaymentEvidence(rec, [{ month: '2031-11', regime: 'RETA', quota: 25 }, { month: '2031-12', regime: 'RETA', quota: 40 }]);
  assert.deepEqual([full.paymentStatus, full.includedInPaid, full.remainder], ['paid', 15, 0]);
  assert.match(full.paymentEvidence, /2031-12 quota 40\.00/);
  const part = regularizationPaymentEvidence(rec, [{ month: '2031-11', regime: 'RETA', quota: 20 }, { month: '2031-12', regime: 'RETA', quota: 40 }]);
  assert.deepEqual([part.paymentStatus, part.includedInPaid, part.remainder], ['partly reflected', 10, 5]);
  assert.equal(regularizationPaymentEvidence(rec, []).paymentStatus, 'not reflected in the paid report');
  assert.equal(regularizationPaymentEvidence({ status: 'claim', amount: 15, months: [] }, []).paymentStatus, null); // no table: unknown
});
