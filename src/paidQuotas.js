// "Informe de cuotas ingresadas" (paid contributions report for RETA and other special
// regimes) on Import@ss. READ-ONLY: it only selects a year, presses the query button,
// saves the result page and the PDF offered by "Imprimir", and goes back to the form.
// It never clicks payments, direct debit, deferrals, refunds or any confirm/submit of changes.
//
// IMPORTANT: every text regex used to find buttons, links and fields below is a
// Spanish label shown on the website and must stay in Spanish to match it.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  OUTPUT_DIR, CERT_HINT, launchChrome, attachPdfCapture, autoStep, clickByText, extractText, log, today, pad,
  
} from './importass.js';
import { fileName, rawFilesFor, rawFilesBlock, OUTPUT_DIR_LABEL } from './paths.js';
import { toParsedBases, selfEmployedMonths } from './basesParser.js';
import { loadContributionBases, fetchContributionBases } from './basesReport.js';
import {
  QUOTA_FORBIDDEN, buildMonths, parseMonthList, collectRanges, firstVisible, fillField, settle, pageText, pageHtml,
} from './quotas.js';
import { filterRecords, normalizeMonth } from './quotaParser.js';
import { parsePaidReport, selectPaidRecords, summarizePaid, paidToCsv, formatPaidCompact } from './paidParser.js';

export const PAID_PREFIX = 'paid-contribution';
const PAID_TIMEOUT_MS = 10 * 60 * 1000;

export const PAID_REPORT = {
  name: 'paid contributions report (Informe de cuotas ingresadas)',
  filePrefix: PAID_PREFIX,
  // Official Import@ss page for the procedure.
  entryUrl:
    'https://portal.seg-social.gob.es/wps/portal/importass/importass/Categorias/Vida+laboral+e+informes/Informes+de+tus+cotizaciones/Informe+de+cuotas+ingresadas',
  infoPageUrlRe: /Informe(%20|\+| )de(%20|\+| )cuotas(%20|\+| )ingresadas/i,
  // "Solicitar informe" opens an identification-method popup; its "Continuar" (with the default
  // "Tengo Cl@ve ..., Certificado Electrónico ..." option) runs clickBotonConsultar(), which opens
  // this in a NEW window (idApp=110, "Informe de bases y cuotas ingresadas").
  servicePath: '/wps/portal/importass/Seguridad/PortalRedirectorN1P?idApp=110&N1&P',
  isServiceUrl: () => false, // handled by this module, not by the generic download step
  isServiceUrlForLogin: () => false,
  consultLabel: /^\s*solicitar informe\s*$/i, // site label ("...como apoderado" is excluded)
  consultPopup: { radio: '#atria-opcion-si', button: '#btn-atria-continuar' }, // site element ids
  consultMaxAttempts: 1,
  downloadLabel: /$^/,
  supportsRanges: false,
};

// Same extra blocklist as the quota calculations: payments, direct debit, deferrals, refunds,
// changes, requests, confirmations, submissions, deletions, registrations (site labels).
const PAID_FORBIDDEN = QUOTA_FORBIDDEN;
// The ONLY buttons clicked inside the service (site labels): the year query and the PDF.
const QUERY_BUTTON = /^\s*(continuar|aceptar|consultar)\s*$/i; // submits the year query; read-only
const PRINT_BUTTON = /^\s*(imprimir|descargar|descargar pdf|obtener pdf|ver pdf)\s*$/i; // generates the certified PDF
const BACK_BUTTON = /^\s*(atr[aá]s|volver)\s*$/i;
const SERVICE_TEXT = /cuotas ingresadas|bases y cuotas|cuotas.{0,20}ingresad/i;

// --- Month selection (pure) ------------------------------------------------------

const monthLabel = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const nextLabel = (label) => { const [y, m] = label.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };
const toMonth = (label) => { const [y, m] = label.split('-').map(Number); return { year: y, month: m, label, period: `${pad(m)}/${y}` }; };
const inAny = (label, groups) => groups.some((g) => (!g.from || label >= g.from) && (!g.to || label <= g.to));

/**
 * Pure: self-employed (RETA etc.) months from the bases report (full JSON, or its text), extended to last month
 * when the registration is still active at the end of the report (recent months may not be
 * in the bases report yet). Returns { months, first, last }.
 */
export function retaMonthsFromBases(bases, { now = new Date() } = {}) {
  const se = selfEmployedMonths(toParsedBases(bases) || { sections: [] });
  const last = monthLabel(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const labels = se.months.map((m) => m.label).filter((l) => l <= last);
  if (se.activeAtEnd && labels.length) for (let l = nextLabel(labels.at(-1)); l <= last; l = nextLabel(l)) labels.push(l);
  return { months: labels.map(toMonth), first: labels[0] || null, last: labels.at(-1) || null };
}

/**
 * Pure: decides which months (and therefore which years) to request.
 * - Default (no ranges/months): every self-employed month from the bases report up to last month.
 * - Ranges (from/to and/or `ranges`): self-employed months in ANY range; with allMonths every
 *   month of each range (no range → first self-employed month, or 05/2023, to last month).
 * - Explicit months: requested as given; alone → exactly those; with ranges → union.
 * The report is requested once per year. Returns { months, years, notSelfEmployed, retaFirst, retaLast }.
 */
export function resolvePaidMonths({ allMonths = false, from, to, ranges, months: explicitInput, bases = null, basesText = null, now = new Date() } = {}) {
  const explicit = parseMonthList(explicitInput);
  const groups = collectRanges({ from, to, ranges });
  const basesInput = bases ?? basesText; // full bases JSON (preferred) or report text
  const reta = basesInput ? retaMonthsFromBases(basesInput, { now }) : { months: [], first: null, last: null };
  const lastMonth = monthLabel(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  let sel = [];
  if (allMonths) {
    if (groups.length) sel = groups.flatMap((g) => buildMonths(g.from || reta.first || undefined, g.to || lastMonth));
    else sel = buildMonths(reta.first || undefined, lastMonth);
  } else if (groups.length) {
    sel = reta.months.filter((m) => inAny(m.label, groups));
  } else if (!explicit.length) {
    sel = reta.months;
  }
  const union = new Map(sel.filter((m) => m.label <= lastMonth).map((m) => [m.label, toMonth(m.label)]));
  const retaSet = new Set(reta.months.map((m) => m.label));
  const notSelfEmployed = [];
  for (const m of explicit) {
    if (basesInput && !retaSet.has(m.label)) notSelfEmployed.push(m.period);
    union.set(m.label, toMonth(m.label));
  }
  const out = [...union.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { months: out, years: [...new Set(out.map((m) => m.year))], notSelfEmployed, retaFirst: reta.first, retaLast: reta.last };
}

// --- Page helpers ------------------------------------------------------------------

/** Finds the year selector(s) of the service form ("Año"/"Ejercicio", site labels). */
async function findYearFields(page) {
  for (const frame of page.frames()) {
    const byLabel = frame.getByLabel(/a[ñn]o\b|ejercicio/i);
    const css = frame.locator('select[name*="anio" i], input[name*="anio" i], select[name*="annio" i], input[name*="annio" i], select[name*="ejercicio" i], input[name*="ejercicio" i], select[id*="anio" i], input[id*="anio" i], select[id*="ejercicio" i], input[id*="ejercicio" i], select[name*="year" i], input[name*="year" i]');
    const fields = [];
    for (const loc of [byLabel, css]) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        const tag = await el.evaluate((e) => e.tagName).catch(() => '');
        const type = ((await el.getAttribute('type').catch(() => '')) || '').toLowerCase();
        if (!['SELECT', 'INPUT'].includes(tag) || ['hidden', 'radio', 'checkbox', 'submit', 'button'].includes(type)) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        const id = await el.evaluate((e) => e.name || e.id || '').catch(() => '');
        if (!fields.some((f) => f.id === id)) fields.push({ el, id });
      }
      if (fields.length) break;
    }
    if (fields.length) return { frame, fields: fields.slice(0, 2).map((f) => f.el) };
  }
  return null;
}

async function findServicePage(context) {
  for (const p of context.pages()) {
    if (p.isClosed() || PAID_REPORT.infoPageUrlRe.test(p.url())) continue;
    const form = await findYearFields(p).catch(() => null);
    if (!form) continue;
    if (SERVICE_TEXT.test(await pageText(p).catch(() => ''))) return { page: p, form };
  }
  return null;
}

async function saveSnapshot(page, label) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `${PAID_PREFIX}-${today()}-${label}`);
  const text = await pageText(page);
  await fs.writeFile(`${base}.txt`, `URL: ${page.url()}\n\n${text}\n`, 'utf8');
  await fs.writeFile(`${base}.html`, await pageHtml(page), 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch((e) => log('screenshot failed:', e.message.split('\n')[0]));
  return { txtPath: `${base}.txt`, htmlPath: `${base}.html`, pngPath: `${base}.png`, text };
}

async function savePdfAs(buf, label, txtLabel = `${label}-pdf`) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const pdfPath = path.join(OUTPUT_DIR, `${PAID_PREFIX}-${today()}-${label}.pdf`);
  const txtPath = path.join(OUTPUT_DIR, `${PAID_PREFIX}-${today()}-${txtLabel}.txt`);
  await fs.writeFile(pdfPath, buf);
  let text = '';
  try { text = await extractText(buf); } catch (e) { text = `(Could not extract text: ${e.message})`; }
  await fs.writeFile(txtPath, text, 'utf8');
  return { pdfPath, txtPath, text };
}

async function backToForm(page, formUrl) {
  if (await findYearFields(page)) return true;
  // Result pages are POST responses: the browser Back button would show "Confirm Form
  // Resubmission", so re-open the form URL (same session). "Atrás"/"Volver" is used if offered.
  if (await clickByText(page, BACK_BUTTON, { roles: ['button', 'link'], label: 'back', forbidden: PAID_FORBIDDEN, quiet: true })) {
    await settle(page);
    if (await findYearFields(page)) return true;
  }
  if (formUrl) { await page.goto(formUrl, { timeout: 20000 }).catch(() => {}); await settle(page); }
  return Boolean(await findYearFields(page));
}

// --- Flow --------------------------------------------------------------------------

/**
 * Opens Import@ss, logs in with the certificate (the user picks it) and requests the report
 * for every year of the selected months, all in ONE browser session. The default selection
 * (self-employed months) comes from the latest saved contribution bases report; if none is
 * saved (or refreshBases) it is downloaded first in the same session.
 * Returns { ok, message, months, years, notSelfEmployed, files }.
 */
export async function fetchPaidContributions({
  timeoutMs = PAID_TIMEOUT_MS, auto = true, from, to, ranges, months: explicitMonths, allMonths = false, refreshBases = false, keepOpen = false, context: sharedContext = null,
} = {}) {
  // Validate every filter before Chrome is opened.
  const explicit = parseMonthList(explicitMonths);
  const groups = collectRanges({ from, to, ranges });
  const needsBases = !(explicit.length && !groups.length) && !(allMonths && groups.length && groups.every((g) => g.from));
  const selection = { allMonths, from, to, ranges, months: explicitMonths };

  let plan = null;
  let basesInfo = null;
  const saved = refreshBases ? null : await loadContributionBases();
  if (saved) basesInfo = `saved bases report ${saved.file}`;
  if (!refreshBases && (saved || !needsBases)) plan = resolvePaidMonths({ ...selection, bases: saved ? saved.full : null });
  if (plan && !plan.months.length) return { ok: false, months: [], years: [], message: 'No months to request (no self-employed months in the selection). Check the range/months filters or use all_months.' };

  // A shared context (one Chrome session for several reports) is left open for the caller.
  const context = sharedContext || (await launchChrome());
  try {
    if (!plan) {
      log('Fetching the contribution bases report first to find the self-employed months…');
      const bases = await fetchContributionBases({ timeoutMs: Math.min(timeoutMs, 5 * 60 * 1000), auto, context });
      if (!bases.ok) return { ok: false, months: [], years: [], message: `Contribution bases report failed: ${bases.message}` };
      basesInfo = `freshly downloaded bases report ${path.basename(bases.jsonPath)}`;
      plan = resolvePaidMonths({ ...selection, bases: bases.full });
      if (!plan.months.length) return { ok: false, months: [], years: [], message: 'No months to request: the bases report shows no self-employed months in the selection.' };
    }
    if (plan.notSelfEmployed.length) log(`note: not self-employed months in the bases report (requested anyway): ${plan.notSelfEmployed.join(', ')}`);
    const r = await runPaidFlow(context, { timeoutMs, auto, years: plan.years, keepOpen });
    return { ...r, months: plan.months.map((m) => m.period), years: plan.years, notSelfEmployed: plan.notSelfEmployed, basesInfo };
  } finally {
    if (!sharedContext) await context.close().catch(() => {}); // always close Chrome, also on errors
  }
}

async function runPaidFlow(context, { timeoutMs, auto, years, keepOpen }) {
  // Make "Imprimir" harmless if it calls window.print (no blocking dialog); a PDF link still works.
  await context.addInitScript(() => { window.print = () => {}; });
  const capture = attachPdfCapture(context);
  const deadline = Date.now() + timeoutMs;
  const files = [];
  const results = {};
  let manualPdf = 0;
  const drainPdfs = async () => {
    let buf;
    while ((buf = await capture.nextPdf(Date.now()))) { manualPdf += 1; files.push(await savePdfAs(buf, `manual-pdf${manualPdf}`, `manual-pdf${manualPdf}`)); }
  };

  const page = context.pages()[0] || (await context.newPage());
  log(`Fetching the ${PAID_REPORT.name} for ${years.join(', ')}. Opening`, PAID_REPORT.entryUrl);
  await page.goto(PAID_REPORT.entryUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message));
  log(CERT_HINT);
  log('The service opens in a new tab. If automation gets stuck, navigate manually (Solicitar informe → Continuar → DNIe o Certificado).');

  // Phase 1: reach the year form (shared login flow).
  const attempts = new Map();
  const state = { ranges: [null], part: 0, rangeApplied: true };
  let service = null;
  const phase1Deadline = auto ? Math.min(deadline, Date.now() + Math.max(timeoutMs / 2, 5 * 60 * 1000)) : 0;
  while (auto && !capture.isClosed() && Date.now() < phase1Deadline) {
    service = await findServicePage(context);
    if (service) break;
    for (const p of context.pages()) if (!p.isClosed()) await autoStep(p, attempts, PAID_REPORT, state).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Phase 2: one read-only query per year.
  if (service && !capture.isClosed()) {
    const sp = service.page;
    const formUrl = sp.url();
    log(`Service found (${formUrl.slice(0, 100)}). Requesting ${years.length} year(s).`);
    for (const year of years) {
      if (capture.isClosed() || Date.now() >= deadline) { results[year] = { status: 'not-queried', message: capture.isClosed() ? 'window closed' : 'timeout' }; continue; }
      if (!(await backToForm(sp, formUrl))) { results[year] = { status: 'not-queried', message: 'year form not found' }; break; }
      const form = await findYearFields(sp);
      let filled = true;
      for (const el of form.fields) filled = (await fillField(el, [String(year)])) && filled; // "desde/hasta" years: same year
      if (!filled) { results[year] = { status: 'not-queried', message: 'could not select the year' }; continue; }
      if (!(await clickByText(sp, QUERY_BUTTON, { roles: ['button'], label: `query ${year}`, forbidden: PAID_FORBIDDEN, quiet: true }))) {
        results[year] = { status: 'not-queried', message: 'query button not found' }; break;
      }
      await settle(sp);
      const parsed = parsePaidReport(await pageText(sp), { year });
      // Error pages are saved as YEAR-error (ignored by the summary); a page without rows never
      // replaces earlier rows of the same year in the summary (see selectPaidRecords).
      const label = parsed.status === 'error' ? `${year}-error` : String(year);
      const snap = await saveSnapshot(sp, label);
      files.push(snap);
      results[year] = { status: parsed.status, rows: parsed.rows.length, message: parsed.message };
      if (parsed.status === 'ok' || parsed.status === 'unparsed') {
        if (await clickByText(sp, PRINT_BUTTON, { roles: ['button', 'link'], label: `pdf ${year}`, forbidden: PAID_FORBIDDEN, quiet: true })) {
          const buf = await capture.nextPdf(Date.now() + 15000);
          if (buf) { files.push(await savePdfAs(buf, String(year))); results[year].pdf = true; }
          // Close any extra tab the PDF opened (keeps the service tab as the only one to drive).
          for (const p of context.pages()) if (p !== sp && !p.isClosed() && /\.pdf|blob:|imprimir|informe/i.test(p.url()) && !PAID_REPORT.infoPageUrlRe.test(p.url())) await p.close().catch(() => {});
        }
      }
      log(`${year}: ${parsed.status}${parsed.rows.length ? ` (${parsed.rows.length} rows)` : ''}${results[year].pdf ? ' + PDF' : ''}`);
    }
  } else if (auto && !capture.isClosed()) {
    log('The year form was not detected automatically; switching to snapshot mode.');
  }

  // Phase 3 (manual, fallback or keep-open): save every new result page and every PDF.
  if ((!auto || !service || keepOpen) && !capture.isClosed() && Date.now() < deadline) {
    log('Snapshot mode: navigate the service yourself; every new result page and PDF is saved. Close the window when done.');
    const seen = new Set();
    let n = 0;
    while (!capture.isClosed() && Date.now() < deadline) {
      for (const p of context.pages()) {
        if (p.isClosed() || !/seg-social/i.test(p.url()) || PAID_REPORT.infoPageUrlRe.test(p.url())) continue;
        const text = await pageText(p).catch(() => '');
        if (!SERVICE_TEXT.test(text) || parsePaidReport(text).status !== 'ok') continue;
        const h = crypto.createHash('sha256').update(text).digest('hex');
        if (seen.has(h)) continue;
        seen.add(h);
        n += 1;
        files.push(await saveSnapshot(p, `snap${n}`));
      }
      await drainPdfs();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await drainPdfs().catch(() => {});
  capture.stop();

  if (!files.length) return { ok: false, files: [], results, message: 'No paid contributions page or PDF was captured.' };
  const okYears = Object.entries(results).filter(([, v]) => v.status === 'ok').map(([y]) => y);
  const other = Object.entries(results).filter(([, v]) => v.status !== 'ok').map(([y, v]) => `${y}: ${v.status}${v.message ? ` (${v.message})` : ''}`);
  return {
    ok: true,
    files: files.map((f) => f.pdfPath || f.txtPath),
    results,
    message: `Requested ${years.length} year(s); ${okYears.length} with rows${other.length ? `; ${other.join('; ')}` : ''}. Files in ${OUTPUT_DIR_LABEL}.`,
  };
}

// --- Saved results (no browser) -------------------------------------------------------

const FILE_RE = new RegExp(`^${PAID_PREFIX}-(\\d{4}-\\d{2}-\\d{2})-(?:((?:19|20)\\d{2})(-pdf)?|(snap\\d+)|(manual-pdf\\d+))\\.txt$`);

/** Pure: classifies saved file names → [{ file, day, kind: page|pdf|snap|manual-pdf, year }]. */
export function classifyPaidFiles(names, { day } = {}) {
  return names.map((f) => ({ f, m: FILE_RE.exec(f) })).filter(({ m }) => m && (!day || m[1] === day)).map(({ f, m }) => ({
    file: f, day: m[1], kind: m[2] ? (m[3] ? 'pdf' : 'page') : m[4] ? 'snap' : 'manual-pdf', year: m[2] ? Number(m[2]) : null,
  }));
}

/**
 * Re-parses the saved pages/PDF texts (latest capture per year, or only `day`) and writes
 * paid-contribution[-DAY].summary.csv/.json. Returns { records, summary, years, csvPath, jsonPath }.
 */
export async function summarizePaidContributions({ day, withRaw = true } = {}) {
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid date "${day}" (use YYYY-MM-DD)`);
  let names = [];
  try { names = await fs.readdir(OUTPUT_DIR); } catch { /* none yet */ }
  const list = classifyPaidFiles(names, { day });
  if (!list.length) throw new Error(`No saved paid contributions report found${day ? ` for ${day}` : ''}. Use fetch-paid-quotas / get_paid_contributions_report.`);
  const parsedFiles = [];
  for (const f of list) {
    const text = await fs.readFile(path.join(OUTPUT_DIR, f.file), 'utf8').catch(() => '');
    parsedFiles.push({ ...f, parsed: parsePaidReport(text, { year: f.year, withRaw }) });
  }
  const { records, years } = selectPaidRecords(parsedFiles);
  const summary = summarizePaid(records);
  const base = path.join(OUTPUT_DIR, `${PAID_PREFIX}${day ? `-${day}` : ''}.summary`);
  await fs.writeFile(`${base}.csv`, paidToCsv(records), 'utf8');
  await fs.writeFile(`${base}.json`, JSON.stringify({ day: day || 'latest per year', currency: 'EUR', years, ...summary, records: records.map(({ raw, ...r }) => r) }, null, 1), 'utf8');
  return { records, summary, years, csvPath: `${base}.csv`, jsonPath: `${base}.json` };
}

/**
 * Token-efficient view of saved results (MCP/CLI).
 * detail: summary (rows + totals) | breakdown (adds each row's report line) | full (breakdown + `rawFiles`, the local
 * raw file names; raw text stays local).
 * Filters (union): from/to, ranges, months. `expected` (months) lists selected months without a row.
 */
export async function paidView({ day, detail = 'summary', from, to, ranges, months, expected } = {}) {
  filterRecords([], { from, to, ranges, months }); // validate filters first
  const sum = await summarizePaidContributions({ day });
  const filtered = filterRecords(sum.records, { from, to, ranges, months });
  const subSummary = filtered.length === sum.records.length ? sum.summary : summarizePaid(filtered);
  const want = [...(expected || []), ...(months || []).flatMap((x) => String(x).split(/[,;\s]+/)).filter(Boolean)].map(normalizeMonth);
  const have = new Set(filtered.map((r) => r.month));
  const missing = [...new Set(want)].filter((m) => !have.has(m)).sort();
  const yearNotes = Object.entries(sum.years).filter(([, v]) => v.status !== 'ok').map(([y, v]) => `${y}=${v.status}`);
  const head = `source=${day || 'latest per year'} csv=${fileName(sum.csvPath)} rows=${filtered.length}${filtered.length !== sum.records.length ? ` (filtered from ${sum.records.length})` : ''}${yearNotes.length ? ` years-without-rows: ${yearNotes.join(' ')}` : ''}`;
  const body = formatPaidCompact(filtered, subSummary, { detail: detail === 'summary' ? 'summary' : 'breakdown', missing });
  if (detail !== 'full') return `${head}\n${body}`;
  const raw = await rawFilesFor([...new Set(filtered.map((r) => r.source))]);
  return `${head}\n${body}\n${rawFilesBlock(raw)}`;
}

/** Files of the latest capture day. */
export async function latestPaidContributions() {
  let names = [];
  try { names = await fs.readdir(OUTPUT_DIR); } catch { return null; }
  const list = classifyPaidFiles(names);
  if (!list.length) return null;
  const day = list.map((f) => f.day).sort().at(-1);
  const files = names.filter((f) => f.startsWith(`${PAID_PREFIX}-${day}-`)).sort().map((f) => path.join(OUTPUT_DIR, f));
  return { day, files };
}
