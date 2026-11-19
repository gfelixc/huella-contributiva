// Pure parsers for SEPE (Servicio Público de Empleo Estatal) benefit data. No browser, no I/O.
// - parseSepeCertificate: text of a "Certificado de importes anuales / por periodo" (or IRPF) PDF:
//     "En el ejercicio 2018" | "En el período de 01/2018 a 12/2018"
//     "Importe bruto de la prestación por desempleo 701,68 €"
//     "Abono cuota fija REASS"  "Retención I.R.P.F."  "Deducción Seguridad Social 86,22 €"
//   (the IRPF certificate uses "Importe íntegro", "Retención I.R.P.F.", "Deducción por cotización a la S.S.").
// - parseBenefitPeriods: unemployment benefit lines of the work history report (vida laboral), e.g.
//     "GENERAL ----------- PRESTACION DESEMPLEO. SUSPENSION 16.04.2020 16.04.2020 12.07.2020 --- --- -- 88"
// The Spanish strings below are the documents' own labels.
import { parseAmount } from './quotaParser.js';

const pad = (n) => String(n).padStart(2, '0');
const AMOUNT = '(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2})';
const LABELS = {
  gross: /importe (bruto|[ií]ntegro)/i,
  reass: /cuota fija reass|\breass\b/i,
  irpf: /retenci[oó]n\s*i\.?\s*r\.?\s*p\.?\s*f\.?/i,
  ss: /deducci[oó]n (por cotizaci[oó]n a la )?(seguridad social|s\.\s*s\.?)/i,
};
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Parses one SEPE certificate text.
 * Returns { kind: 'annual' | 'period' | 'irpf' | 'unknown', status: 'ok' | 'no-amounts' | 'unparsed',
 *   year, periodFrom, periodTo ('YYYY-MM'), benefitType, gross, reass, irpf, ssDeduction, net, message }.
 */
export function parseSepeCertificate(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const flat = lines.join('\n');
  let kind = 'unknown';
  let year = null; let periodFrom = null; let periodTo = null;
  const per = /per[ií]odo de\s*(\d{1,2})\/(\d{4})\s*a\s*(\d{1,2})\/(\d{4})/i.exec(flat);
  const ej = /(?:en el ejercicio|ejercicio)\s*:?\s*((?:19|20)\d{2})/i.exec(flat);
  if (/retenciones e ingresos a cuenta/i.test(flat)) kind = 'irpf';
  if (per) {
    kind = 'period';
    periodFrom = `${per[2]}-${pad(Number(per[1]))}`; periodTo = `${per[4]}-${pad(Number(per[3]))}`;
    year = per[2] === per[4] ? Number(per[2]) : null;
  } else if (ej) {
    if (kind === 'unknown') kind = 'annual';
    year = Number(ej[1]); periodFrom = `${year}-01`; periodTo = `${year}-12`;
  }
  const benefitType = /subsidio/i.test(flat) && !/prestaci[oó]n\/subsidio/i.test(flat) ? 'unemployment subsidy (subsidio)'
    : /prestaci[oó]n contributiva/i.test(flat) ? 'contributory unemployment benefit'
      : /prestaci[oó]n\/subsidio|prestaci[oó]n por desempleo|prestaciones por desempleo/i.test(flat) ? 'unemployment benefit (prestación/subsidio)' : null;

  // 1) Label and amount on the same line.
  const values = {};
  for (const line of lines) {
    for (const [k, re] of Object.entries(LABELS)) {
      if (values[k] !== undefined || !re.test(line)) continue;
      const m = new RegExp(`(?:${re.source}).*?${AMOUNT}`, 'i').exec(line);
      values[k] = m ? parseAmount(m[m.length - 1]) : null;
    }
  }
  // 2) Layouts that put the amounts in a separate column block: assign in label order when the
  //    numbers of labels without a value and of following amount-only lines match.
  const missing = Object.keys(values).filter((k) => values[k] === null);
  if (missing.length && missing.length === Object.keys(values).length) {
    const amountLines = lines.filter((l) => new RegExp(`^${AMOUNT}\\s*€?$`).test(l)).map((l) => parseAmount(l));
    if (amountLines.length === missing.length) missing.forEach((k, i) => { values[k] = amountLines[i]; });
  }
  // The IRPF certificate puts the values in a table row: "2019 1.234,56 0,00 98,76".
  if (kind === 'irpf' && values.gross == null) {
    const row = lines.map((l) => new RegExp(`^((?:19|20)\\d{2})\\s+${AMOUNT}(?:\\s+${AMOUNT})?(?:\\s+${AMOUNT})?$`).exec(l)).find(Boolean);
    if (row) {
      year = year || Number(row[1]); periodFrom = periodFrom || `${row[1]}-01`; periodTo = periodTo || `${row[1]}-12`;
      values.gross = parseAmount(row[2]);
      if (row[4] !== undefined) { values.irpf = parseAmount(row[3]); values.ss = parseAmount(row[4]); } else if (row[3] !== undefined) values.ss = parseAmount(row[3]);
    }
  }
  const gross = values.gross ?? null;
  const irpf = values.irpf ?? null;
  const ssDeduction = values.ss ?? null;
  const reass = values.reass ?? null;
  const hasLabels = Object.keys(values).length > 0;
  let status = 'unparsed';
  let message = null;
  if (gross !== null || ssDeduction !== null) status = 'ok';
  else if (hasLabels || /no (ha percibido|consta|figura)|sin importes|no es beneficiari/i.test(flat)) {
    status = 'no-amounts';
    message = (lines.find((l) => /no (ha percibido|consta|figura)|no es beneficiari/i.test(l)) || 'certificate without amounts').slice(0, 160);
  }
  const net = gross !== null ? round2(gross - (irpf || 0) - (ssDeduction || 0)) : null;
  return { kind, status, year, periodFrom, periodTo, benefitType, gross, reass, irpf, ssDeduction, net, message };
}

const DATE_RE = /\b(\d{2})\.(\d{2})\.((?:19|20)\d{2})\b/g;
const BENEFIT_LINE_RE = /PRESTACI[OÓ]N(?: POR)? DESEMPLEO|SUBSIDIO(?: POR)? DESEMPLEO|DESEMPLEO\b/i;

/** Months 'YYYY-MM' touched by an ISO date range. */
export function monthsBetween(fromIso, toIso) {
  const out = [];
  let [y, m] = fromIso.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toIso.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

/**
 * Unemployment benefit periods from the work history report text.
 * Returns [{ kind: 'erte-suspension' | 'erte-reduction' | 'unemployment', label, regime, from, to (ISO dates),
 *   days, months: ['YYYY-MM'] }], sorted by start date. Open periods (no end date) end today.
 */
export function parseBenefitPeriods(workHistoryText, { now = new Date() } = {}) {
  const out = [];
  for (const raw of String(workHistoryText || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!BENEFIT_LINE_RE.test(line)) continue;
    const dates = [...line.matchAll(DATE_RE)].map((d) => `${d[3]}-${d[2]}-${d[1]}`);
    if (!dates.length) continue;
    const from = dates[0];
    const to = dates.length >= 3 ? dates[2] : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const kind = /SUSPENSI/i.test(line) ? 'erte-suspension' : /REDUCCI/i.test(line) ? 'erte-reduction' : 'unemployment';
    const days = /(\d{1,3}(?:\.\d{3})*)\s*$/.exec(line);
    const label = (/(PRESTACI[OÓ]N[^0-9]*|SUBSIDIO[^0-9]*)/i.exec(line) || [line])[0].trim();
    out.push({
      kind, label, regime: (/^([A-ZÁÉÍÓÚ. ]+?)\s+(?:-{3,}|\d)/.exec(line) || [null, null])[1],
      from, to, days: days ? Number(days[1].replace(/\./g, '')) : null, months: monthsBetween(from, to),
    });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

export const SEPE_CSV_COLUMNS = ['kind', 'year', 'period_from', 'period_to', 'status', 'benefit_type', 'gross', 'irpf', 'ss_deduction', 'reass', 'net', 'source'];

export function sepeToCsv(records) {
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [SEPE_CSV_COLUMNS.join(','), ...records.map((r) => [r.kind, r.year, r.periodFrom, r.periodTo, r.status, r.benefitType, r.gross, r.irpf, r.ssDeduction, r.reass, r.net, r.source].map(esc).join(','))].join('\n') + '\n';
}

/**
 * Pure: keeps the newest certificate per (kind, period) and orders them.
 * input: [{ ...parsed, source, day }]
 */
export function selectSepeRecords(parsed) {
  const best = new Map();
  for (const r of parsed) {
    if (r.status === 'unparsed') continue;
    const k = `${r.kind}|${r.periodFrom}|${r.periodTo}`;
    const cur = best.get(k);
    if (!cur || r.day > cur.day || (r.day === cur.day && r.status === 'ok' && cur.status !== 'ok')) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => String(a.periodFrom).localeCompare(String(b.periodFrom)) || a.kind.localeCompare(b.kind));
}

const f2 = (n) => (n === null || n === undefined ? '-' : n.toFixed(2));

/** Token-efficient text: one line per certificate, benefit periods (ERTE) and totals of the annual certificates. */
export function formatSepeCompact(records, periods = []) {
  const out = ['SEPE benefits, EUR; cols: kind period status gross irpf ss_deducted net'];
  for (const r of records) out.push([r.kind, r.periodFrom === r.periodTo || !r.periodTo ? r.periodFrom : `${r.periodFrom}..${r.periodTo}`, r.status, f2(r.gross), f2(r.irpf), f2(r.ssDeduction), f2(r.net)].join(' ') + (r.reass ? ` reass=${f2(r.reass)}` : ''));
  const annual = records.filter((r) => r.kind === 'annual' && r.status === 'ok');
  if (annual.length) {
    const t = (k) => round2(annual.reduce((a, r) => a + (r[k] || 0), 0));
    out.push(`TOTAL annual certificates (${annual.map((r) => r.year).join(',')}): gross=${f2(t('gross'))} irpf=${f2(t('irpf'))} ss_deducted=${f2(t('ssDeduction'))} net=${f2(t('net'))}`);
  }
  if (periods.length) out.push(`benefit periods (vida laboral): ${periods.map((p) => `${p.kind} ${p.from}..${p.to}${p.days ? ` (${p.days} days)` : ''}`).join('; ')}`);
  return out.join('\n');
}
