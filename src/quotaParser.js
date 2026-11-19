// Pure parser for the quota calculation snapshots (.txt files written by quotas.js).
// No browser, no I/O. Spanish strings below are the labels shown on the website.
//
// A result snapshot has header fields ("RÉGIMEN", "CCC", "MES DE LIQUIDACIÓN",
// "RAZÓN SOCIAL", "TIPO DE LIQUIDACIÓN", each followed by its value on the next line)
// and a "[Tables]" section with rows such as
//   Descripción | Base | Cuota Empresarial | Cuota Trabajador | Cuota Total
//   CONTINGENCIAS COMUNES | 1.000,00 | 236,00 € | 47,00 € | 283,00 €
//   LIQUIDO DE TOTALES |  | 319,00 € | 63,50 € | 382,50 €
// A month with several liquidations first shows a list page
// ("RELACIÓN DE LIQUIDACIONES DISPONIBLES PARA M/YYYY").

const HEADER_FIELDS = {
  regime: /^r[ée]gimen$/i,
  ccc: /^ccc$/i,
  month: /^mes de liquidaci[óo]n$/i,
  employer: /^raz[óo]n social$/i,
  liquidationType: /^tipo de liquidaci[óo]n$/i,
};
const LIST_RE = /RELACI[ÓOóo]N DE LIQUIDACIONES DISPONIBLES PARA\s+(\d{1,2})\/(\d{4})/i;
const NO_DATA_RE = /se ha producido un (error|aviso)|no existe liquidaci|s[oó]lo estar[aá] disponible|no procede realizar/i;
const TOTALS_ROW = /^LIQUIDO DE TOTALES$/i;
const BASE_ROW = /^CONTINGENCIAS COMUNES$/i;

const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

/** "1.234,56 €" → 1234.56; empty → null. */
export function parseAmount(s) {
  const t = String(s ?? '').replace(/€/g, '').replace(/\s+/g, '').trim();
  if (!t || !/\d/.test(t)) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const toLabel = (mmYYYY) => {
  const m = /^(\d{1,2})\/(\d{4})$/.exec(String(mmYYYY || '').trim());
  return m ? `${m[2]}-${pad(m[1])}` : null;
};

function headerFields(lines) {
  const out = {};
  for (let i = 0; i < lines.length - 1; i++) {
    for (const [key, re] of Object.entries(HEADER_FIELDS)) {
      if (out[key] === undefined && re.test(lines[i].trim())) out[key] = lines[i + 1].trim();
    }
  }
  return out;
}

/** Table rows as arrays of cells: prefers the "[Tables]" section, falls back to tab-separated page text. */
function tableRows(text) {
  const idx = text.indexOf('[Tables]');
  if (idx >= 0) {
    return text.slice(idx + 8).split(/\r?\n/).filter((l) => l.includes('|')).map((l) => l.split('|').map((c) => c.trim()));
  }
  return text.split(/\r?\n/).filter((l) => l.includes('\t')).map((l) => l.split('\t').map((c) => c.trim()));
}

/** Finds the calculations table (header with "Descripción" ... "Cuota Total") and maps its columns. */
function calculationRows(rows) {
  const h = rows.findIndex((r) => /^descripci[óo]n$/i.test(r[0] || '') && r.some((c) => /cuota total/i.test(c)));
  if (h < 0) return [];
  const head = rows[h].map((c) => c.toLowerCase());
  const col = (re) => head.findIndex((c) => re.test(c));
  const ci = { base: col(/^base$/), employer: col(/empresarial/), worker: col(/trabajador/), total: col(/cuota total/) };
  const out = [];
  for (const r of rows.slice(h + 1)) {
    if (/^descripci[óo]n$/i.test(r[0] || '')) break; // next table
    if (r.length < head.length - 1) continue;
    out.push({
      concept: r[0],
      base: ci.base >= 0 ? parseAmount(r[ci.base]) : null,
      employerQuota: ci.employer >= 0 ? parseAmount(r[ci.employer]) : null,
      workerQuota: ci.worker >= 0 ? parseAmount(r[ci.worker]) : null,
      total: ci.total >= 0 ? parseAmount(r[ci.total]) : null,
    });
  }
  return out;
}

/**
 * Parses one snapshot text into a compact record.
 * fileLabel: the month label from the file name ("YYYY-MM"), used when the page has none.
 * Returns { month, status: 'ok'|'list-only'|'no-data'|'unparsed', regime, ccc, employer,
 *           liquidationType, base, workerQuota, employerQuota, total, breakdown?, liquidations?, message? }.
 */
export function parseQuotaSnapshot(text, { fileLabel = null, withBreakdown = false } = {}) {
  const t = String(text || '');
  const lines = t.split(/\r?\n/);
  const list = LIST_RE.exec(t);
  const calc = calculationRows(tableRows(t));
  if (calc.length) {
    const f = headerFields(lines);
    const totals = calc.find((r) => TOTALS_ROW.test(r.concept));
    const baseRow = calc.find((r) => BASE_ROW.test(r.concept));
    const rec = {
      month: toLabel(f.month) || fileLabel,
      status: totals ? 'ok' : 'unparsed',
      regime: f.regime ?? null,
      ccc: f.ccc ?? null,
      employer: f.employer ?? null,
      liquidationType: f.liquidationType ?? null,
      base: baseRow ? baseRow.base : null,
      workerQuota: totals ? totals.workerQuota ?? 0 : null,
      employerQuota: totals ? totals.employerQuota ?? 0 : null,
      total: totals ? totals.total ?? 0 : null,
    };
    if (!totals) rec.message = 'no "LIQUIDO DE TOTALES" row';
    if (withBreakdown) rec.breakdown = calc;
    return rec;
  }
  if (list) {
    // Rows: CCC (regime code + account, possibly with spaces) | Tipo Liquidación | ... | Mes de Presentación
    const liquidations = tableRows(t)
      .filter((r) => /^[\d\s]{10,}$/.test(r[0] || '') && r.length >= 2)
      .map((r) => {
        const digits = r[0].replace(/\s+/g, '');
        return { regime: digits.length > 11 ? digits.slice(0, digits.length - 11) : null, ccc: digits.slice(-11), type: r[1], presentedIn: r[r.length - 1] };
      });
    return {
      month: `${list[2]}-${pad(list[1])}`, status: 'list-only', regime: null, ccc: null, employer: null, liquidationType: null,
      base: null, workerQuota: null, employerQuota: null, total: null, liquidations,
      message: `${liquidations.length} liquidation(s) listed but not opened`,
    };
  }
  if (NO_DATA_RE.test(t)) {
    const msg = lines.find((l) => NO_DATA_RE.test(l) || /no existe/i.test(l)) || 'no data';
    return { month: fileLabel, status: 'no-data', regime: null, ccc: null, employer: null, liquidationType: null, base: null, workerQuota: null, employerQuota: null, total: null, message: msg.trim().slice(0, 160) };
  }
  return { month: fileLabel, status: 'unparsed', regime: null, ccc: null, employer: null, liquidationType: null, base: null, workerQuota: null, employerQuota: null, total: null, message: 'unrecognized page' };
}

/** Per-employer and grand totals over the 'ok' records. */
export function summarizeQuotaRecords(records) {
  const ok = records.filter((r) => r.status === 'ok');
  const byEmployer = new Map();
  const grand = { rows: 0, months: 0, workerQuota: 0, employerQuota: 0, total: 0 };
  const monthsSeen = new Set();
  for (const r of ok) {
    const k = `${r.employer}|${r.ccc}`;
    if (!byEmployer.has(k)) byEmployer.set(k, { employer: r.employer, ccc: r.ccc, rows: 0, months: new Set(), from: r.month, to: r.month, workerQuota: 0, employerQuota: 0, total: 0 });
    const e = byEmployer.get(k);
    e.rows += 1; e.months.add(r.month);
    if (r.month < e.from) e.from = r.month;
    if (r.month > e.to) e.to = r.month;
    e.workerQuota += r.workerQuota; e.employerQuota += r.employerQuota; e.total += r.total;
    grand.rows += 1; monthsSeen.add(r.month);
    grand.workerQuota += r.workerQuota; grand.employerQuota += r.employerQuota; grand.total += r.total;
  }
  grand.months = monthsSeen.size;
  const employers = [...byEmployer.values()].map((e) => ({
    employer: e.employer, ccc: e.ccc, from: e.from, to: e.to, months: e.months.size, rows: e.rows,
    workerQuota: round2(e.workerQuota), employerQuota: round2(e.employerQuota), total: round2(e.total),
  })).sort((a, b) => a.from.localeCompare(b.from));
  for (const k of ['workerQuota', 'employerQuota', 'total']) grand[k] = round2(grand[k]);
  const issues = records.filter((r) => r.status !== 'ok').map((r) => ({ month: r.month, status: r.status, message: r.message, liquidations: r.liquidations }));
  return { employers, grand, issues };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? v.toFixed(2) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_COLUMNS = ['month', 'liquidation', 'status', 'regime', 'ccc', 'employer', 'liquidation_type', 'base_cc', 'worker_quota', 'employer_quota', 'total'];

/** CSV (dot decimals), one line per month/liquidation. */
export function recordsToCsv(records) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records) {
    lines.push([r.month, r.liquidation ?? '', r.status, r.regime, r.ccc, r.employer, r.liquidationType, r.base, r.workerQuota, r.employerQuota, r.total].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

const fmt = (n) => (n === null || n === undefined ? '-' : n.toFixed(2));

/**
 * Token-efficient text for MCP responses. Employers are listed once (E1, E2…) and
 * rows reference them. detail: 'summary' (rows + totals) | 'breakdown' (adds concept lines).
 */
export function formatCompact(records, summary, { detail = 'summary' } = {}) {
  const ids = new Map();
  summary.employers.forEach((e, i) => ids.set(`${e.employer}|${e.ccc}`, `E${i + 1}`));
  const out = ['employers:'];
  for (const e of summary.employers) {
    out.push(`${ids.get(`${e.employer}|${e.ccc}`)} ${e.employer} ccc=${e.ccc} ${e.from}..${e.to} months=${e.months} worker=${fmt(e.workerQuota)} employer=${fmt(e.employerQuota)} total=${fmt(e.total)}`);
  }
  out.push(`grand: months=${summary.grand.months} rows=${summary.grand.rows} worker=${fmt(summary.grand.workerQuota)} employer=${fmt(summary.grand.employerQuota)} total=${fmt(summary.grand.total)}`);
  out.push('rows (month liq type emp base worker employer total):');
  for (const r of records) {
    if (r.status !== 'ok') { out.push(`${r.month}${r.liquidation ? ` ${r.liquidation}` : ''} ${r.status}${r.message ? `: ${r.message}` : ''}`); continue; }
    const type = (r.liquidationType || '').split('-')[0] || '-';
    out.push(`${r.month} ${r.liquidation || '-'} ${type} ${ids.get(`${r.employer}|${r.ccc}`) || '?'} ${fmt(r.base)} ${fmt(r.workerQuota)} ${fmt(r.employerQuota)} ${fmt(r.total)}`);
    if (detail === 'breakdown' && r.breakdown) {
      for (const b of r.breakdown) out.push(`  ${b.concept}: base=${fmt(b.base)} worker=${fmt(b.workerQuota)} employer=${fmt(b.employerQuota)} total=${fmt(b.total)}`);
    }
  }
  if (summary.issues.length) out.push(`issues: ${summary.issues.length} (${summary.issues.map((i) => `${i.month} ${i.status}`).join(', ')})`);
  return out.join('\n');
}

/** Normalizes "MM/YYYY" or "YYYY-MM" to "YYYY-MM"; null for empty; throws on invalid input. */
export function normalizeMonth(s) {
  if (s === undefined || s === null || s === '') return null;
  const t = String(s).trim();
  const a = /^(\d{1,2})\/(\d{4})$/.exec(t);
  const b = /^(\d{4})-(\d{1,2})$/.exec(t);
  const [y, m] = a ? [a[2], Number(a[1])] : b ? [b[1], Number(b[2])] : [null, 0];
  if (y && m >= 1 && m <= 12) return `${y}-${pad(m)}`;
  throw new Error(`Invalid month "${s}" (use MM/YYYY or YYYY-MM)`);
}

const MONTH_TOKEN = '(\\d{1,2}\\/\\d{4}|\\d{4}-\\d{1,2})';
const RANGE_RE = new RegExp(`^${MONTH_TOKEN}\\s*(?:-|–|\\.\\.|to)\\s*${MONTH_TOKEN}$`, 'i');

/**
 * Parses one or more month ranges into [{ from: 'YYYY-MM', to: 'YYYY-MM' }].
 * Accepts strings "MM/YYYY-MM/YYYY", "YYYY-MM-YYYY-MM", "02/2018..12/2018" (several per string,
 * comma/semicolon/space separated), objects { from, to } (either end may be omitted = open),
 * or an array mixing both. Throws on invalid input or when from is after to.
 */
export function parseRanges(input) {
  if (input === undefined || input === null || input === '') return [];
  const items = (Array.isArray(input) ? input : [input]).flatMap((x) => (typeof x === 'string' ? x.split(/[,;\s]+/).filter(Boolean) : [x]));
  return items.map((it) => {
    let from;
    let to;
    if (typeof it === 'string') {
      const m = RANGE_RE.exec(it.trim());
      if (!m) throw new Error(`Invalid range "${it}" (use MM/YYYY-MM/YYYY or YYYY-MM-YYYY-MM)`);
      [from, to] = [normalizeMonth(m[1]), normalizeMonth(m[2])];
    } else if (it && typeof it === 'object') {
      [from, to] = [normalizeMonth(it.from), normalizeMonth(it.to)];
      if (!from && !to) throw new Error('A range needs at least "from" or "to"');
    } else {
      throw new Error(`Invalid range ${JSON.stringify(it)}`);
    }
    if (from && to && from > to) throw new Error(`Range start ${from} is after its end ${to}`);
    return { from, to };
  });
}

/**
 * Keeps records whose month (YYYY-MM) matches ANY of the filters: the from/to range,
 * any of `ranges`, or the explicit `months` list. No filters → all records.
 */
export function filterRecords(records, { from, to, months, ranges } = {}) {
  const all = parseRanges(ranges);
  const lo = normalizeMonth(from); const hi = normalizeMonth(to);
  if (lo || hi) {
    if (lo && hi && lo > hi) throw new Error('from must not be after to');
    all.push({ from: lo, to: hi });
  }
  const set = new Set((months || []).flatMap((x) => String(x).split(/[,;\s]+/)).filter(Boolean).map(normalizeMonth));
  if (!all.length && !set.size) return records.filter((r) => r.month);
  return records.filter((r) => r.month && (set.has(r.month) || all.some((g) => (!g.from || r.month >= g.from) && (!g.to || r.month <= g.to))));
}

/**
 * Decides which snapshot files feed the summary (pure).
 * files: [{ file, month: 'YYYY-MM'|null, kind: 'main'|'list'|'liqN'|'snap' }]
 * manifest: { 'YYYY-MM': { files: [...], status, message, failures: [{ liquidation, message }] } }
 * - Months in the manifest use exactly the files of their latest fetch (older snapshots of
 *   the same month are ignored), plus synthetic rows for "no-data" months and for
 *   liquidations that could not be opened.
 * - Other months: liquidation files (liqN) win over the month's list/main page.
 * - Snapshots without a month in the file name ('snap') are always included.
 * Returns [{ file, month, kind } | { synthetic: record }].
 */
export function planSnapshotFiles(files, manifest = {}) {
  const out = [];
  const empty = (month, status, message, liquidation = null) => ({
    synthetic: { month, liquidation, status, regime: null, ccc: null, employer: null, liquidationType: null, base: null, workerQuota: null, employerQuota: null, total: null, message, source: 'manifest' },
  });
  const byMonth = new Map();
  for (const f of files) {
    if (!f.month) { out.push(f); continue; }
    if (!byMonth.has(f.month)) byMonth.set(f.month, []);
    byMonth.get(f.month).push(f);
  }
  const months = new Set([...byMonth.keys(), ...Object.keys(manifest)]);
  for (const month of [...months].sort()) {
    const entry = manifest[month];
    const list = byMonth.get(month) || [];
    if (entry) {
      if (entry.status === 'no-data') { out.push(empty(month, 'no-data', entry.message || 'no data')); continue; }
      const wanted = new Set(entry.files || []);
      const chosen = list.filter((f) => wanted.has(f.file));
      const hasLiq = chosen.some((f) => f.kind.startsWith('liq'));
      for (const f of chosen) if (!(hasLiq && f.kind === 'list')) out.push(f);
      for (const fl of entry.failures || []) out.push(empty(month, 'not-opened', fl.message, fl.liquidation));
      continue;
    }
    const liq = list.filter((f) => f.kind.startsWith('liq'));
    out.push(...(liq.length ? liq : list));
  }
  return out;
}

/** Drops exact duplicates (same month, liquidation id, CCC, type and amounts), keeping the first. */
export function dedupeQuotaRecords(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const key = r.status === 'ok'
      ? ['ok', r.month, r.ccc, r.liquidationType, r.base, r.workerQuota, r.employerQuota, r.total].join('|')
      : [r.status, r.month, r.liquidation, r.message].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => (a.month || '').localeCompare(b.month || '') || (a.liquidation || '').localeCompare(b.liquidation || ''));
}
