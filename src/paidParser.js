// Pure parser for the "Informe de cuotas ingresadas" (paid contributions report for RETA and
// other special regimes). No browser, no I/O. Works on the page snapshot text (tables rendered
// as "cell | cell" rows) and, as a fallback, on the text extracted from the PDF.
// The report is requested per year and lists, per liquidation period: regime, contribution
// base, paid quota and paid surcharge/interest. Spanish strings below are the report's labels.
import { parseAmount } from './quotaParser.js';

const pad = (n) => String(n).padStart(2, '0');
const KNOWN_REGIME_RE = /(aut[óo]nom|\bRETA\b|cuenta propia|r[ée]gimen especial del mar|agrari|empleados? de hogar|convenio especial)/i;

/**
 * Regime named on a context line (e.g. "RÉGIMEN ESPECIAL TRABAJADORES AUTÓNOMOS" or "Régimen: ...").
 * Bare labels ("Régimen") and sentences ("... en este régimen.") return null.
 */
function regimeFromLine(line) {
  const known = KNOWN_REGIME_RE.exec(line);
  if (known) return normalizeRegime(known[1]);
  const lab = /r[ée]gimen\s*:\s*(.+)$/i.exec(line);
  return lab && /[a-z]{4}/i.test(lab[1]) ? normalizeRegime(lab[1]) : null;
}
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTH_NAME_RE = new RegExp(`\\b(${MONTHS_ES.join('|')}|setiembre)\\b(?:\\s*(?:de\\s*)?((?:19|20)\\d{2}))?`, 'i');
const DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/;
const AMOUNT_RE = /-?\d{1,3}(?:\.\d{3})*,\d{2}\b/g;
const NO_DATA_RE = /no (existen|constan|hay|figuran|se han encontrado)\b[^.\n]{0,60}(datos|cuotas|ingresos|informaci)|sin datos para el|no se han encontrado (datos|resultados)/i;
const ERROR_RE = /se ha producido un error|error en la (consulta|petici)/i;

/** Short regime code: RETA (self-employed), REM (sea), SEA (agrarian), HOGAR, CE (special agreement) or the raw text. */
export function normalizeRegime(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/aut[óo]nom|\bRETA\b|cuenta propia|^0?521\b/i.test(t)) return 'RETA';
  if (/\bmar\b|^0?8\d{2}\b/i.test(t)) return 'REM';
  if (/general|^0?1\d{2}\b/i.test(t)) return 'GENERAL';
  if (/agrari/i.test(t)) return 'SEA';
  if (/hogar/i.test(t)) return 'HOGAR';
  if (/convenio/i.test(t)) return 'CE';
  return t.replace(/\s+/g, ' ').slice(0, 30);
}

/** Finds a liquidation period in a text cell/line → 'YYYY-MM' or null (full dates are ignored). */
export function findPeriod(text, defaultYear = null) {
  const t = String(text || '').replace(new RegExp(DATE_RE.source, 'g'), ' ');
  let m = /\b(0?[1-9]|1[0-2])\s*[/-]\s*((?:19|20)\d{2})\b/.exec(t);
  if (m) return `${m[2]}-${pad(Number(m[1]))}`;
  m = /\b((?:19|20)\d{2})\s*[/-]\s*(0[1-9]|1[0-2])\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /\b((?:19|20)\d{2})(0[1-9]|1[0-2])\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = MONTH_NAME_RE.exec(t);
  if (m) {
    const idx = m[1].toLowerCase() === 'setiembre' ? 8 : MONTHS_ES.indexOf(m[1].toLowerCase());
    const year = m[2] ? Number(m[2]) : defaultYear;
    if (year) return `${year}-${pad(idx + 1)}`;
  }
  return null;
}

const toIsoDate = (s) => {
  const m = DATE_RE.exec(String(s || ''));
  return m ? `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}` : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** Maps header cells to column indexes (site labels, Spanish). */
function mapHeader(cells) {
  const find = (re, not) => cells.findIndex((c) => re.test(c) && !(not && not.test(c)));
  const ci = {
    period: find(/per[ií]odo|mes\b|liquidaci/i),
    regime: find(/r[ée]gimen/i),
    base: find(/base/i),
    quota: find(/cuota|importe ingresado|ingresad/i, /recargo|inter[eé]s|base/i),
    surcharge: find(/recargo/i),
    interest: find(/inter[eé]s/i, /recargo/i),
    date: find(/fecha/i),
    status: find(/estado|situaci/i),
  };
  return ci.period >= 0 && (ci.base >= 0 || ci.quota >= 0) ? ci : null;
}

/**
 * Parses one saved snapshot or PDF text of the report.
 * options: year (fallback year for rows that only show the month name), withRaw (keep each row's raw text).
 * Returns { status: 'ok' | 'no-data' | 'error' | 'unparsed', year, message, rows: [{ month, regime, base,
 *   quota, surcharge, interest, total, paymentDate, status, raw? }] }.
 */
export function parsePaidReport(text, { year = null, withRaw = false } = {}) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const yearHit = /(?:ejercicio|a[ñn]o)\s*:?\s*((?:19|20)\d{2})/i.exec(src);
  const ctxYear = year ? Number(year) : yearHit ? Number(yearHit[1]) : null;
  let contextRegime = null;
  const rows = [];
  const seen = new Set();
  const push = (row, raw) => {
    const key = `${row.month}|${row.regime}|${row.base}|${row.quota}|${row.surcharge}|${row.interest}|${row.paymentDate}`;
    if (seen.has(key)) return; // the same row appears in both the page text and the [Tables] block
    seen.add(key);
    row.total = round2((row.quota || 0) + (row.surcharge || 0) + (row.interest || 0));
    if (withRaw) row.raw = raw.slice(0, 200);
    rows.push(row);
  };

  // 1) Tables with a header row ("Periodo | Régimen | Base | Cuota | Recargo ..." — site labels).
  let header = null;
  for (const line of lines) {
    if (!line.includes('|')) contextRegime = regimeFromLine(line) || contextRegime;
    if (!line.includes('|')) { header = null; continue; }
    const cells = line.split('|').map((c) => c.trim());
    const h = mapHeader(cells);
    if (h && !findPeriod(cells[h.period], ctxYear)) { header = h; continue; }
    if (!header) continue;
    const month = findPeriod(cells[header.period], ctxYear);
    if (!month) continue;
    const amount = (i) => (i >= 0 ? parseAmount(cells[i]) : null);
    push({
      month,
      regime: header.regime >= 0 ? normalizeRegime(cells[header.regime]) : contextRegime,
      base: amount(header.base),
      quota: amount(header.quota),
      surcharge: amount(header.surcharge),
      interest: amount(header.interest),
      paymentDate: header.date >= 0 ? toIsoDate(cells[header.date]) : null,
      status: header.status >= 0 ? (cells[header.status] || null) : null,
    }, line);
  }

  // 2) Fallback for PDF text: a line with a period and at least two amounts
  //    (in report order: base, quota, surcharge, interest).
  if (!rows.length) {
    contextRegime = null;
    for (const line of lines) {
      contextRegime = regimeFromLine(line) || contextRegime;
      const month = findPeriod(line, ctxYear);
      if (!month) continue;
      const amounts = (line.replace(new RegExp(DATE_RE.source, 'g'), ' ').match(AMOUNT_RE) || []).map(parseAmount);
      if (amounts.length < 2) continue;
      const inline = /(aut[óo]nom|\bRETA\b|cuenta propia|\bmar\b|agrari|hogar|convenio)/i.exec(line);
      push({
        month,
        regime: inline ? normalizeRegime(inline[1]) : contextRegime,
        base: amounts[0],
        quota: amounts[1],
        surcharge: amounts.length > 2 ? amounts[2] : null,
        interest: amounts.length > 3 ? amounts[3] : null,
        paymentDate: toIsoDate(line),
        status: null,
      }, line);
    }
  }

  rows.sort((a, b) => a.month.localeCompare(b.month));
  const years = [...new Set(rows.map((r) => Number(r.month.slice(0, 4))))];
  const outYear = ctxYear || (years.length === 1 ? years[0] : null);
  if (rows.length) return { status: 'ok', year: outYear, message: null, rows };
  const msgLine = lines.find((l) => NO_DATA_RE.test(l) || ERROR_RE.test(l));
  if (msgLine && NO_DATA_RE.test(msgLine)) return { status: 'no-data', year: outYear, message: msgLine.slice(0, 160), rows: [] };
  if (msgLine) return { status: 'error', year: outYear, message: msgLine.slice(0, 160), rows: [] };
  return { status: 'unparsed', year: outYear, message: null, rows: [] };
}

const KIND_RANK = { page: 0, pdf: 1, snap: 2, 'manual-pdf': 3 };

/**
 * Pure: picks, for every year, the rows of the best saved file: newest capture day first,
 * then page snapshot > PDF text > manual snapshot > manual PDF. Files without rows only
 * count as "no-data" for their year when nothing better exists.
 * input: [{ file, day: 'YYYY-MM-DD', kind, year (or null), parsed }]
 * Returns { records: [{ ...row, source, day }], years: { [year]: { source, day, status, message } } }.
 */
export function selectPaidRecords(parsedFiles) {
  const byYear = new Map();
  for (const f of parsedFiles) {
    const years = f.parsed.rows.length ? [...new Set(f.parsed.rows.map((r) => r.month.slice(0, 4)))] : (f.year || f.parsed.year) ? [String(f.year || f.parsed.year)] : [];
    for (const y of years) {
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(f);
    }
  }
  const records = [];
  const years = {};
  for (const [y, list] of [...byYear.entries()].sort()) {
    const has = (f) => f.parsed.rows.some((r) => r.month.startsWith(y));
    // Rows win over pages without rows, except a newer explicit "no data" answer of the year page.
    const pool = list.some(has) ? list.filter((f) => has(f) || (f.kind === 'page' && f.parsed.status === 'no-data')) : list;
    pool.sort((p, q) => q.day.localeCompare(p.day) || (has(q) - has(p)) || ((KIND_RANK[p.kind] ?? 9) - (KIND_RANK[q.kind] ?? 9)));
    const best = pool[0];
    const rows = best.parsed.rows.filter((r) => r.month.startsWith(y));
    years[y] = { source: best.file, day: best.day, status: rows.length ? 'ok' : best.parsed.status, message: best.parsed.message };
    for (const r of rows) records.push({ ...r, source: best.file, day: best.day });
  }
  records.sort((a, b) => a.month.localeCompare(b.month));
  return { records, years };
}

/** Per-year and grand totals. */
export function summarizePaid(records) {
  const blank = () => ({ months: 0, rows: 0, base: 0, quota: 0, surcharge: 0, interest: 0, total: 0 });
  const add = (acc, r) => {
    acc.rows += 1;
    for (const k of ['base', 'quota', 'surcharge', 'interest', 'total']) acc[k] = round2(acc[k] + (r[k] || 0));
  };
  const years = {};
  const grand = blank();
  const monthsByYear = new Map();
  for (const r of records) {
    const y = r.month.slice(0, 4);
    if (!years[y]) years[y] = blank();
    add(years[y], r); add(grand, r);
    if (!monthsByYear.has(y)) monthsByYear.set(y, new Set());
    monthsByYear.get(y).add(r.month);
  }
  for (const [y, set] of monthsByYear) years[y].months = set.size;
  grand.months = new Set(records.map((r) => r.month)).size;
  const regimes = [...new Set(records.map((r) => r.regime).filter(Boolean))];
  return { years, grand, regimes };
}

export const PAID_CSV_COLUMNS = ['month', 'regime', 'base', 'quota', 'surcharge', 'interest', 'total', 'payment_date', 'status', 'source'];

export function paidToCsv(records) {
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = records.map((r) => [r.month, r.regime, r.base, r.quota, r.surcharge, r.interest, r.total, r.paymentDate, r.status, r.source].map(esc).join(','));
  return [PAID_CSV_COLUMNS.join(','), ...lines].join('\n') + '\n';
}

const f2 = (n) => (n === null || n === undefined ? '-' : n.toFixed(2));

/**
 * Token-efficient text: one line per row, then per-year and grand totals.
 * detail: 'summary' | 'breakdown' (adds each row's raw report text when available).
 * missing: selected months that have no row (listed once).
 */
export function formatPaidCompact(records, summary, { detail = 'summary', missing = [] } = {}) {
  const hasInterest = records.some((r) => r.interest !== null && r.interest !== undefined);
  const hasDate = records.some((r) => r.paymentDate);
  const hasStatus = records.some((r) => r.status);
  const cols = ['month', 'regime', 'base', 'quota', 'surcharge', ...(hasInterest ? ['interest'] : []), 'total', ...(hasDate ? ['paid_on'] : []), ...(hasStatus ? ['status'] : [])];
  const out = [`paid contributions (cuotas ingresadas), EUR; cols: ${cols.join(' ')}`];
  for (const r of records) {
    out.push([r.month, r.regime || '-', f2(r.base), f2(r.quota), f2(r.surcharge), ...(hasInterest ? [f2(r.interest)] : []), f2(r.total),
      ...(hasDate ? [r.paymentDate || '-'] : []), ...(hasStatus ? [r.status ? r.status.replace(/\s+/g, '_') : '-'] : [])].join(' '));
    if (detail !== 'summary' && r.raw) out.push(`  | ${r.raw}`);
  }
  for (const [y, t] of Object.entries(summary.years)) out.push(`year ${y}: ${t.months} months base=${f2(t.base)} quota=${f2(t.quota)} surcharge=${f2(t.surcharge + t.interest)} total=${f2(t.total)}`);
  const g = summary.grand;
  out.push(`TOTAL: ${g.months} months, ${g.rows} rows; base=${f2(g.base)} quota=${f2(g.quota)} surcharge=${f2(g.surcharge + g.interest)} total=${f2(g.total)}`);
  if (missing.length) out.push(`missing (selected, not in the saved report): ${missing.join(' ')}`);
  return out.join('\n');
}
