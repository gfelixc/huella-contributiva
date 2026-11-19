// RETA annual regularisation (art. 308.1.c LGSS): pure parsing of the Import@ss service pages and of the
// resolution PDF text. Heuristic on purpose: the exact layout is learned from saved snapshots.
// Every regex below matches Spanish text shown on the website / in the resolution and must stay in Spanish.

const AMOUNT = '(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+,\\d{2})';
const DATE = '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{4})';
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

export function parseAmountEs(s) {
  if (s === null || s === undefined) return null;
  const v = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
const isoDate = (s) => { const m = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s || ''); return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null; };
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Labels (normalised: no accents, lower case).
// The label prefix is optional: the "años anteriores" cards show just "A ingresar: 12,34 €".
const REFUND_AMOUNT = new RegExp(`(?:(?:importe|cantidad|cuantia|diferencia)s?(?: total)? )?(?:a devolver|a (?:tu|su) favor|de (?:la )?devolucion)[^\\d-]{0,40}${AMOUNT}`);
const CLAIM_AMOUNT = new RegExp(`(?:(?:importe|cantidad|cuantia|diferencia)s?(?: total)? )?(?:a ingresar|a pagar|a abonar|pendiente de (?:pago|ingreso))[^\\d-]{0,40}${AMOUNT}`);
const DEFINITIVE_BASE = new RegExp(`bases? (?:de cotizacion )?definitivas?(?: mensual(?:es)?)?[^\\d\\n]{0,40}${AMOUNT}`);
const PROVISIONAL_BASE = new RegExp(`bases? (?:de cotizacion )?provisional(?:es)?(?: mensual(?:es)?)?[^\\d\\n]{0,40}${AMOUNT}`);
const GENERIC_AMOUNT = new RegExp(`(resultado|diferencia|importe)( de la regularizacion| total)?\\s*:?\\s*${AMOUNT}`);
const REFUND_WORDS = /\ba devolver\b|a (tu|su) favor|devolucion de (oficio|cuotas|ingresos)|se (te|le) devolvera|resultado:? devolucion/;
const CLAIM_WORDS = /\ba ingresar\b|deber(a|as) ingresar|requieren? un ingreso|diferencias? a ingresar|reclamacion de (las )?cuotas|resultado:? (a )?ingres/;
const NO_DIFF_WORDS = /sin diferencias|no (se han detectado|existen|hay|resultan?) diferencias|no procede (la )?regularizacion|bases? (provisionales? )?(pasan? a|adquieren?|tienen?) (la condicion de |caracter )?definitiv/;
const NOT_REG_WORDS = /no regularizable|periodos? no regularizables?|no (es|son) objeto de regularizacion|excluid[oa]s? de (la )?regularizacion/;
const PENDING_WORDS = /pendiente de (notificar|resolver|regularizar)|en tramite|tramite de audiencia|no (dispone|disponemos|tiene|hay) (de )?(ninguna )?regularizacion|no (se ha|ha sido) (realizado|notificad)/;
const DUE = new RegExp(`(fecha limite|plazo (de|para el) (pago|ingreso)|antes del?|hasta el)[^\\d]{0,40}${DATE}`);
const REFUND_DATE = new RegExp(`(fecha (de )?(la )?devolucion|devolucion (realizada|efectuada|abonada)( el)?)[^\\d]{0,30}${DATE}`);
// Title of the resolution PDF: "RESOLUCIÓN SOBRE BASE DE COTIZACIÓN DEFINITIVA DEL AÑO 2023".
const RESOLUTION_YEAR = /resolucion sobre (?:la )?bases? de cotizacion definitivas? del? (?:ano|ejercicio) ((?:19|20)\d{2})|bases? de cotizacion provisionales? del (?:ano|ejercicio) ((?:19|20)\d{2})|correspondientes al (?:ano|ejercicio) ((?:19|20)\d{2})/;
const RESOLUTION_DATE = new RegExp(`fecha de (?:la )?resolucion:?\\s*${DATE}`);
// "resuelve CONFIRMAR como definitivas las bases de cotización provisionales": no difference.
const CONFIRMED_WORDS = /resuelve confirmar como definitivas|confirmar como definitivas las bases|tu cotizacion en (?:19|20)\d{2} fue correcta|no tienes que realizar ninguna actuacion/;
// Whole year under flat rate, benefit, exemption or late/ex-officio registration: bases kept as they were.
const EXEMPT_WORDS = /tarifa plana por inicio de actividad|no procede modificar las bases de cotizacion provisionales/;
// Electronic-reference boilerplate of the PDF (its "hasta la fecha" is a verification date, not a deadline).
const BOILERPLATE = /referencias electronicas|id\. cea|codigo electronico de autenticidad|la autenticidad de este documento|verificacion de integridad|^d[a-z0-9]{11} \d{2}\/\d{2}\/\d{4}/;

/** Year of a resolution text (title first), or null. Used to verify a downloaded PDF. */
export function resolutionYear(text) {
  const one = norm(text).replace(/\s+/g, ' ');
  const t = RESOLUTION_YEAR.exec(one);
  if (t) return Number(t[1] || t[2] || t[3]);
  const y = YEAR.exec(one);
  return y ? Number(y[1] || y[2]) : null;
}

const YEAR = /regularizacion[^\n]{0,80}?(?:del? |ejercicio |ano )((?:19|20)\d{2})|(?:ejercicio|ano) (?:regularizado|de regularizacion)?:?\s*((?:19|20)\d{2})/;
// Payment status only from an explicit status label ("Estado: pagada"), never from loose words such as
// "podrá ser ingresado" in the resolution. Whether a claim was paid is decided from evidence in the combined report.
const PAYMENT_STATUS = [
  ['paid', /\b(?:estado|situacion)(?: del? (?:pago|ingreso))?:? (?:pagad[oa]|ingresad[oa]|abonad[oa]|cobrad[oa])\b/],
  ['refunded', /\b(?:estado|situacion):? devuelt[oa]\b|devolucion (?:realizada|efectuada|abonada)/],
  ['pending', /\b(?:estado|situacion):? pendiente de (?:pago|ingreso|devolucion)/],
];
// Income lines of the resolution ("Información utilizada"), all on the normalised one-line text.
const INCOME_LINES = {
  declaredIncome: new RegExp(`rendimientos declarados o comprobados en el impuesto sobre la renta de las personas fisicas han sido de ${AMOUNT}`),
  deductedQuotas: new RegExp(`cuotas de la seguridad social deducidas en el impuesto sobre la renta de las personas fisicas han sido de ${AMOUNT}`),
  incomePlusQuotas: new RegExp(`suma de los citados rendimientos y las cuotas de la seguridad social,? ${AMOUNT}`),
  genericDeduction: new RegExp(`deduccion por gastos genericos del \\d+(?:,\\d+)? por ciento,? ${AMOUNT}`),
  annualComputableIncome: new RegExp(`importe anual computable para la determinacion de la base de cotizacion definitiva de ${AMOUNT}`),
  monthlyComputableIncomeStated: new RegExp(`rendimientos mensuales computables para la determinacion de dicha base en ese ejercicio son de ${AMOUNT}`),
};
// Fallback for other layouts: "Rendimientos netos computables: 18.000,00" (label immediately followed by the amount).
const NET_INCOME = new RegExp(`rendimientos? netos?(?: computables?)?(?: anuales?)?(?: comunicados?)?:?\\s*${AMOUNT}`);
const GENERIC_PCT = /deduccion por gastos genericos del (\d+(?:,\d+)?) por ciento/;
const DEF_BASE_SENTENCE = new RegExp(`(?:importe de la )?base de cotizacion definitiva del (?:ano|ejercicio) (?:19|20)\\d{2} es de ${AMOUNT}`);
const PROV_AVG_SENTENCE = new RegExp(`promedio mensual de sus bases de cotizacion provisionales del (?:ano|ejercicio) (?:19|20)\\d{2} (?:es|fue) de ${AMOUNT}`);
const DUE_RULE = /hasta el ultimo dia del mes siguiente a aquel en que se notifique/;
const PAYMENT_DOCUMENT = /documento de pago que se adjunta|boletin pago regularizacion/;
const MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Income figures of the resolution (kept in the summary files; never logged). */
export function parseIncome(one) {
  const out = {};
  for (const [k, re] of Object.entries(INCOME_LINES)) { const m = re.exec(one); if (m) out[k] = parseAmountEs(m[1]); }
  const pct = GENERIC_PCT.exec(one); if (pct) out.genericDeductionPct = parseAmountEs(pct[1].includes(',') ? pct[1] : `${pct[1]},00`);
  // The stated monthly figure can be inconsistent with the annual one (seen in real letters): flag it.
  if (out.monthlyComputableIncomeStated != null && out.annualComputableIncome != null) {
    out.monthlyComputableIncomeDerived = round2(out.annualComputableIncome / 12);
    out.monthlyComputableIncomeInconsistent = out.monthlyComputableIncomeStated > out.annualComputableIncome;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Monthly rows: "ENERO 1.000,00 1.200,00 ...", "01/2024 1.000,00 ..." or "Dic/2024 30,00 40,00 10,00 -" (two or more
 * amounts). In the resolution's table "Cuotas por bases provisionales | Cuotas por bases definitivas | Resultado de la
 * regularización | Información adicional" the values are QUOTAS: provisionalQuota, definitiveQuota, difference, info.
 */
function monthRows(lines, year) {
  const out = [];
  let order = null; // column order from a header line, e.g. ['provisional', 'definitiva', 'diferencia']
  const quotaTable = lines.some((x) => /cuotas por bases/.test(norm(x)));
  for (const raw of lines) {
    const l = norm(raw);
    if (quotaTable) {
      const q = new RegExp(`^(${MONTH_ABBR.join('|')})[a-z]*\\s*/\\s*((?:19|20)\\d{2})\\s+${AMOUNT}\\s+${AMOUNT}\\s+${AMOUNT}\\s*(.*)$`).exec(l);
      if (q) {
        const info = raw.replace(/^.*\d,\d{2}\s*€?\s*/, '').trim();
        out.push({ period: `${q[2]}-${pad(MONTH_ABBR.indexOf(q[1]) + 1)}`, values: [q[3], q[4], q[5]].map(parseAmountEs),
          provisionalQuota: parseAmountEs(q[3]), definitiveQuota: parseAmountEs(q[4]), difference: parseAmountEs(q[5]), info: info && info !== '-' ? info : null });
        continue;
      }
    }
    if (/base[^|\t]{0,20}provisional/.test(l) && /definitiv/.test(l)) {
      order = [...l.matchAll(/provisional|definitiv|cuota|diferencia/g)].map((m) => m[0]);
      continue;
    }
    let period = null;
    let rest = l;
    const mName = new RegExp(`^\\s*(${MONTHS.join('|')})\\b(?:\\s+(?:de\\s+)?((?:19|20)\\d{2}))?`).exec(l);
    const mNum = /^\s*(\d{1,2})\s*[/-]\s*((?:19|20)\d{2})\b/.exec(l);
    if (mName) { period = `${mName[2] || year || '????'}-${pad(MONTHS.indexOf(mName[1]) + 1)}`; rest = l.slice(mName[0].length); }
    else if (mNum && Number(mNum[1]) >= 1 && Number(mNum[1]) <= 12) { period = `${mNum[2]}-${pad(mNum[1])}`; rest = l.slice(mNum[0].length); }
    if (!period) continue;
    const nums = [...rest.matchAll(new RegExp(AMOUNT, 'g'))].map((m) => parseAmountEs(m[1]));
    if (nums.length < 2) continue;
    const row = { period, values: nums };
    if (order && order.length) {
      const pick = (name) => { const i = order.indexOf(name); return i >= 0 && i < nums.length ? nums[i] : null; };
      row.provisionalBase = pick('provisional'); row.definitiveBase = pick('definitiv'); row.difference = pick('diferencia');
    } else { row.provisionalBase = nums[0]; row.definitiveBase = nums[1]; row.difference = nums.length >= 3 ? nums[nums.length - 1] : null; }
    out.push(row);
  }
  return out;
}

/**
 * Parses a regularisation page or resolution text.
 * Returns { year, status: 'refund'|'claim'|'no-difference'|'not-regularisable'|'pending'|'unknown', amount (always >= 0),
 *   signedAmount (claim +, refund −), dueDate, refundDate, netIncome, paymentStatus, months[], message }.
 */
export function parseRegularization(text, { year: hintYear = null } = {}) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).filter((l) => !BOILERPLATE.test(norm(l)));
  const flat = norm(lines.join('\n'));
  const one = flat.replace(/\n/g, ' ');
  const year = resolutionYear(one) ?? (hintYear ? Number(hintYear) : null);

  let status = 'unknown'; let amount = null;
  const refund = REFUND_AMOUNT.exec(one); const claim = CLAIM_AMOUNT.exec(one);
  const refundAmt = refund ? parseAmountEs(refund[refund.length - 1]) : null;
  const claimAmt = claim ? parseAmountEs(claim[claim.length - 1]) : null;
  if (refundAmt && !claimAmt) { status = 'refund'; amount = refundAmt; }
  else if (claimAmt && !refundAmt) { status = 'claim'; amount = claimAmt; }
  else if (refundAmt && claimAmt) { // both labels: the larger non-zero one decides (the other is usually 0,00)
    if (refundAmt >= claimAmt) { status = 'refund'; amount = refundAmt; } else { status = 'claim'; amount = claimAmt; }
  } else if (REFUND_WORDS.test(one) && !CLAIM_WORDS.test(one)) status = 'refund';
  else if (CLAIM_WORDS.test(one) && !REFUND_WORDS.test(one)) status = 'claim';
  if ((status === 'refund' || status === 'claim') && amount === null) {
    const g = GENERIC_AMOUNT.exec(one);
    if (g) amount = Math.abs(parseAmountEs(g[g.length - 1]));
  }
  if (status === 'unknown' || ((status === 'refund' || status === 'claim') && !amount)) {
    if (NO_DIFF_WORDS.test(one) || CONFIRMED_WORDS.test(one)) { status = 'no-difference'; amount = 0; }
    else if (NOT_REG_WORDS.test(one)) { status = 'not-regularisable'; amount = 0; }
    else if (PENDING_WORDS.test(one) && status === 'unknown') status = 'pending';
  }
  const due = DUE.exec(one); const rdate = REFUND_DATE.exec(one);
  const income = parseIncome(one);
  const totalRow = new RegExp(`\\btotal\\s+${AMOUNT}\\s*€?\\s+${AMOUNT}\\s*€?\\s+${AMOUNT}`).exec(one);
  let paymentStatus = null;
  for (const [k, re] of PAYMENT_STATUS) if (re.test(one)) { paymentStatus = k; break; }
  const months = monthRows(lines, year);
  const defBase = DEF_BASE_SENTENCE.exec(one) || DEFINITIVE_BASE.exec(flat); const provBase = PROV_AVG_SENTENCE.exec(one) || PROVISIONAL_BASE.exec(flat);
  // Payment information as a sanitised summary (the payment document contains account and reference numbers).
  const payInfo = [PAYMENT_DOCUMENT.test(one) ? 'payment document attached' : null, DUE_RULE.test(one) ? 'without surcharge until the last day of the month after notification' : null].filter(Boolean).join('; ') || null;
  const signedAmount = amount === null ? null : status === 'refund' ? -round2(amount) : status === 'claim' ? round2(amount) : 0;
  const message = status === 'unknown' ? 'no regularisation result recognised (page saved for review)' : null;
  return {
    year, status, amount: amount === null ? null : round2(amount), signedAmount,
    dueDate: status === 'claim' && due ? isoDate(due[due.length - 1]) : null,
    refundDate: rdate ? isoDate(rdate[rdate.length - 1]) : null,
    netIncome: income && income.annualComputableIncome != null ? income.annualComputableIncome : (() => { const m = NET_INCOME.exec(one); return m ? parseAmountEs(m[1]) : null; })(),
    income,
    totals: totalRow ? { provisionalQuota: parseAmountEs(totalRow[1]), definitiveQuota: parseAmountEs(totalRow[2]), difference: parseAmountEs(totalRow[3]) } : null,
    paymentStatus, months, message,
    definitiveBase: defBase ? parseAmountEs(defBase[1]) : null,
    provisionalBase: provBase ? parseAmountEs(provBase[1]) : null,
    paymentInfo: payInfo,
    resolutionDate: (() => { const m = RESOLUTION_DATE.exec(one); return m ? isoDate(m[1]) : null; })(),
    confirmedBases: CONFIRMED_WORDS.test(one) || null,
    exemptYear: EXEMPT_WORDS.test(one) || null,
  };
}

// "Años anteriores" page (RALI05RegularizacionHistorico): one card per year, e.g.
//   Resolución 2024 / RÉGIMEN ESPECIAL TRABAJADORES AUTÓNOMOS / 2024 / A ingresar: 12,34 €
//   Resolución 2023 / ... / Sin diferencias        ("Resolución no dispobible" [sic] when there is no PDF)
const CARD_HEAD = /^resolucion\s+(?:((?:19|20)\d{2})|no\s+dispo\w*)\s*$/;
const CARD_END = /^\d+ de \d+$/;
export const isRegularizationHistoryPage = (text) => /RALI05RegularizacionHistorico|regularizaci[oó]n anual de cuotas de a[nñ]os anteriores/i.test(String(text || ''));
// The current-year service is a "Vas a solicitar una consulta" SUBMISSION form, never a data source.
export const isRegularizationQueryForm = (text) => /TRIA01RegularizacionAutonomos|vas a solicitar una consulta/i.test(String(text || ''));
// The public information page (no personal result).
export const isRegularizationInfoPage = (text) => /^URL: \S*\/Categorias\/[^\n]*regularizacionreta/im.test(String(text || ''));

/** Cards of the "años anteriores" page → [{ year, regime, status, amount, signedAmount, available, label }]. */
export function parseRegularizationCards(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const cards = []; let cur = null;
  const close = () => { if (cur) cards.push(cur); cur = null; };
  for (const raw of lines) {
    const l = norm(raw);
    const h = CARD_HEAD.exec(l);
    if (h) { close(); cur = { year: h[1] ? Number(h[1]) : null, available: Boolean(h[1]), regime: null, statusLine: null }; continue; }
    if (!cur) continue;
    if (CARD_END.test(l)) { close(); continue; }
    if (!cur.regime && /^regimen\b/.test(l)) { cur.regime = raw; continue; }
    if (/^(19|20)\d{2}$/.test(l)) { cur.year ??= Number(l); continue; }
    if (!cur.statusLine && /a ingresar|a devolver|a (tu|su) favor|sin diferencias|no regularizable|pendiente|en tramite|no dispo/.test(l)) cur.statusLine = raw;
    else if (cur.statusLine && l.length > 40) close(); // long text after the result: the card has ended
  }
  close();
  return cards.filter((c) => c.year).map((c) => {
    const l = norm(c.statusLine || '');
    const amt = (re) => { const m = new RegExp(`${re}\\s*:?\\s*${AMOUNT}`).exec(l); return m ? Math.abs(parseAmountEs(m[1])) : null; };
    let status = 'unknown'; let amount = null;
    if (/a ingresar/.test(l)) { status = 'claim'; amount = amt('a ingresar'); }
    else if (/a devolver|a (tu|su) favor/.test(l)) { status = 'refund'; amount = amt('(?:a devolver|a (?:tu|su) favor)'); }
    else if (/sin diferencias/.test(l)) { status = 'no-difference'; amount = 0; }
    else if (/no regularizable/.test(l)) { status = 'not-regularisable'; amount = 0; }
    else if (/pendiente|en tramite|no dispo/.test(l)) status = 'pending';
    const signedAmount = amount === null ? null : status === 'refund' ? -round2(amount) : status === 'claim' ? round2(amount) : 0;
    return {
      year: c.year, regime: c.regime, status, amount: amount === null ? null : round2(amount), signedAmount, available: c.available, label: c.statusLine,
      dueDate: null, refundDate: null, netIncome: null, paymentStatus: null, months: [], message: status === 'unknown' ? 'card without a recognised result' : null,
    };
  });
}

const RANK = { refund: 3, claim: 3, 'no-difference': 2, 'not-regularisable': 2, pending: 1, unknown: 0 };
// The card of the "años anteriores" page states the result literally, so it wins over the (heuristically parsed)
// resolution PDF for status and amount; the PDF then completes dates, income, bases and months.
const score = (r) => RANK[r.status] * 10 + (r.amount ? 4 : 0) + (r.kind === 'card' ? 3 : r.kind === 'pdf' ? 1 : 0) + (r.months && r.months.length ? 1 : 0);

/**
 * One record per year: the latest day with a recognised result; within a day the most informative
 * file (resolution PDF first). Fields missing in the best file are completed from the others of the same day.
 * parsed: [{ ...parseRegularization(), day, kind: 'pdf'|'page', source }].
 */
export function selectRegularizationRecords(parsed) {
  const byYear = new Map();
  for (const r of parsed) if (r.year) (byYear.get(r.year) || byYear.set(r.year, []).get(r.year)).push(r);
  const out = [];
  for (const [year, list] of byYear) {
    const known = list.filter((r) => r.status !== 'unknown');
    const pool = known.length ? known : list;
    const lastDay = pool.map((r) => r.day).sort().at(-1);
    const sameDay = pool.filter((r) => r.day === lastDay).sort((a, b) => score(b) - score(a));
    const best = { ...sameDay[0] };
    for (const r of sameDay.slice(1)) for (const k of ['dueDate', 'refundDate', 'netIncome', 'paymentStatus', 'definitiveBase', 'provisionalBase', 'paymentInfo', 'regime', 'resolutionDate', 'confirmedBases', 'exemptYear', 'income', 'totals']) if (best[k] == null && r[k] != null) best[k] = r[k];
    const pdf = sameDay.find((r) => r.kind === 'pdf' && r.status !== 'unknown');
    if (pdf && best.kind !== 'pdf' && pdf.amount != null && best.amount != null && Math.abs(pdf.amount - best.amount) >= 0.01) best.pdfAmount = pdf.amount; // shown as a discrepancy
    if (!best.months || !best.months.length) best.months = (sameDay.find((r) => r.months && r.months.length) || {}).months || [];
    best.sources = sameDay.map((r) => r.source);
    best.year = year;
    out.push(best);
  }
  return out.sort((a, b) => a.year - b.year);
}

export const REGULARIZATION_CSV_COLUMNS = ['year', 'status', 'amount', 'signed_amount', 'due_date', 'refund_date', 'resolution_date', 'net_income', 'payment_status', 'payment_evidence', 'definitive_base', 'months', 'resolution_pdf', 'source'];

export function regularizationToCsv(records) {
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [REGULARIZATION_CSV_COLUMNS.join(','), ...records.map((r) => [r.year, r.status, r.amount, r.signedAmount, r.dueDate, r.refundDate, r.resolutionDate, r.netIncome, r.paymentStatus, r.paymentEvidence,
    r.definitiveBase, (r.months || []).map((m) => m.period).join(' '), (r.sources || []).find((x) => !/-page\.txt$/.test(x)) || '', r.source].map(esc).join(','))].join('\n') + '\n';
}

const f2 = (n) => (n === null || n === undefined ? '-' : n.toFixed(2));
export function formatRegularizationCompact(records, plan = null) {
  const out = ['RETA annual regularisation, EUR; cols: year status amount signed due/refund payment months pdf source'];
  for (const r of records) {
    const pdf = (r.sources || []).some((x) => !/-page\.txt$/.test(x)) ? 'pdf' : r.available === false ? 'no-pdf' : '-';
    out.push([r.year, r.status, f2(r.amount), f2(r.signedAmount), r.dueDate || r.refundDate || (r.resolutionDate ? `resolved ${r.resolutionDate}` : '-'), r.paymentStatus || '-', (r.months || []).length || '-', pdf, r.source].join(' ')
      + (r.pdfAmount != null ? ` (resolution PDF parsed ${f2(r.pdfAmount)}: check)` : '')
      + (r.paymentEvidence ? ` [${r.paymentEvidence}]` : ''));
  }
  if (!records.length) out.push('(no regularisation result saved yet)');
  if (plan && plan.years && plan.years.length) {
    const have = new Set(records.filter((r) => r.status !== 'unknown').map((r) => r.year));
    const missing = plan.years.filter((y) => !have.has(y));
    if (missing.length) out.push(`not fetched / unknown yet: ${missing.join(', ')}`);
  }
  return out.join('\n');
}

/**
 * Years whose regularisation can exist: RETA years from 2023 (first year of the real-income system) up to
 * the previous year, taken from the RETA months of the bases report (or explicit years).
 * Year Y is regularised during Y+1 / early Y+2.
 */
export function regularizationYears({ years, retaMonths = [], now = new Date() } = {}) {
  const last = now.getFullYear() - 1;
  const explicit = (Array.isArray(years) ? years : years ? [years] : []).flatMap((v) => String(v).split(/[,;\s]+/)).filter(Boolean);
  for (const y of explicit) if (!/^(19|20)\d{2}$/.test(y)) throw new Error(`Invalid year "${y}"`);
  if (explicit.length) {
    const ys = [...new Set(explicit.map(Number))].sort();
    const bad = ys.filter((y) => y < 2023 || y > last);
    if (bad.length) throw new Error(`No RETA regularisation exists for ${bad.join(', ')} (only 2023..${last}; year Y is regularised in Y+1)`);
    return { years: ys, source: 'explicit' };
  }
  const fromBases = [...new Set(retaMonths.map((m) => Number(String(m).slice(0, 4))))].filter((y) => y >= 2023 && y <= last).sort();
  return fromBases.length ? { years: fromBases, source: 'RETA months in the bases report' } : { years: [], source: 'no RETA months from 2023 in the bases report' };
}

/**
 * Pure check of a PDF captured after clicking "Resolución <year>" (protects against stale captures):
 * savedHashes: Map(hash → year already saved). Returns { ok, year, reason }.
 *  - same bytes as a PDF saved for another year → rejected (stale capture);
 *  - resolution year in the text differs from the requested year → rejected (mismatch; `year` = the year found);
 *  - no year found in the text → accepted as unverified.
 */
export function checkResolutionPdf({ hash, text, year, savedHashes = new Map() }) {
  if (savedHashes.has(hash)) {
    const y = savedHashes.get(hash);
    return { ok: false, year: y, reason: y === year ? 'duplicate' : `same file as the ${y} resolution (stale capture)` };
  }
  const found = resolutionYear(text);
  if (found && found !== Number(year)) return { ok: false, year: found, reason: `the PDF is the ${found} resolution, not ${year}` };
  return { ok: true, year: Number(year), reason: found ? 'year verified' : 'year not found in the text (unverified)', verified: Boolean(found) };
}

/**
 * Payment evidence (pure): compares the resolution's monthly table with the paid contributions report.
 * paidRecords: [{ month: 'YYYY-MM', regime, quota }]. A month whose paid quota equals the definitive quota
 * (within 0.01) already includes its difference. Returns { paymentStatus, paymentEvidence, includedInPaid,
 * remainder } or nulls when there is nothing to compare (status from evidence only, never guessed).
 */
export function regularizationPaymentEvidence(record, paidRecords = []) {
  const none = { paymentStatus: null, paymentEvidence: null, includedInPaid: null, remainder: null };
  if (!record || (record.status !== 'claim' && record.status !== 'refund')) return none;
  const table = (record.months || []).filter((m) => m.difference != null && m.definitiveQuota != null && Math.abs(m.difference) >= 0.005);
  if (!table.length) return none;
  const paidBy = new Map();
  for (const p of paidRecords) if (p && p.month && (!p.regime || p.regime === 'RETA')) paidBy.set(p.month, round2((paidBy.get(p.month) || 0) + (Number(p.quota) || 0)));
  const included = []; let remainder = 0;
  for (const m of table) {
    const paid = paidBy.get(m.period);
    if (paid != null && Math.abs(paid - m.definitiveQuota) < 0.01) included.push({ period: m.period, paid, difference: m.difference });
    else remainder = round2(remainder + m.difference);
  }
  const includedInPaid = round2(included.reduce((a, m) => a + m.difference, 0));
  const ev = included.map((m) => `${m.period} quota ${m.paid.toFixed(2)}`).join(', ');
  return {
    paymentStatus: included.length && Math.abs(remainder) < 0.01 ? (record.status === 'claim' ? 'paid' : 'refunded') : included.length ? 'partly reflected' : 'not reflected in the paid report',
    paymentEvidence: included.length ? `paid contributions report: ${ev} = definitive quota` : null,
    includedInPaid, remainder,
  };
}
