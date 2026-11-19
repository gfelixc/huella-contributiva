// "Consulta de cálculos de cuotas para trabajador" (contribution quota calculations)
// on Import@ss. READ-ONLY: it only fills the period selector, presses the query
// button and navigates back; it never clicks anything that changes data.
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
import { toParsedBases, employeeMonths, summarizeEmployeeMonths, employersLabel } from './basesParser.js';
import { loadContributionBases, fetchContributionBases } from './basesReport.js';
import {
  parseQuotaSnapshot, summarizeQuotaRecords, recordsToCsv, formatCompact, filterRecords, planSnapshotFiles, dedupeQuotaRecords,
  parseRanges,
} from './quotaParser.js';

export const QUOTAS_PREFIX = 'quota-calculation';
// First month of the default range when no bases report is used (--all-months without --from/--range).
export const DEFAULT_QUOTAS_FROM = '05/2023';
const QUOTAS_TIMEOUT_MS = 20 * 60 * 1000;

export const QUOTAS_REPORT = {
  name: 'quota calculations (Consulta de cálculos de cuotas para trabajador)',
  filePrefix: QUOTAS_PREFIX,
  // Official Import@ss page for the procedure.
  entryUrl:
    'https://portal.seg-social.gob.es/wps/portal/importass/importass/Categorias/Vida+laboral+e+informes/Informes+de+tus+cotizaciones/Consulta+de+calculos+de+cuotas+para+trabajador',
  infoPageUrlRe: /Consulta(%20|\+| )de(%20|\+| )calculos(%20|\+| )de(%20|\+| )cuotas/i,
  // The "Consultar cálculos" button opens this in a NEW window (window.open) and it
  // redirects to the legacy online service (idApp=363).
  servicePath: '/wps/portal/importass/Seguridad/PortalRedirectorN1P?idApp=363&N1&P',
  isServiceUrl: () => false, // handled by this module, not by the generic download step
  isServiceUrlForLogin: () => false,
  consultLabel: /^\s*consultar c[aá]lculos\s*$/i, // site label ("...como apoderado" is excluded)
  // The button opens a new window and the info page stays put, so click it only once.
  consultMaxAttempts: 1,
  downloadLabel: /$^/,
  supportsRanges: false,
};

// Extra blocklist for this service on top of the global one (site labels, Spanish):
// payments, direct debit, deferrals, refunds, changes of base/income, requests,
// confirmations, submissions, deletions, registrations/de-registrations.
export const QUOTA_FORBIDDEN = /pag(o|ar)|domicilia|aplaza|devoluci|modific|cambi|solicit|rendimiento|confirm|present|enviar|firm|tramit|borrar|eliminar|anular|baja|alta\b|guardar|grabar|regulariz|reclam|recurs|alegaci/i;
// The ONLY buttons this module clicks inside the service (site labels):
const QUERY_BUTTON = /^\s*aceptar\s*$/i;        // submits the period query (Figure 1 of the official manual); read-only
const CONTINUE_BUTTON = /^\s*continuar\s*$/i;   // opens the selected liquidation (Figure 2); read-only
const BACK_BUTTON = /^\s*atr[aá]s\s*$/i;        // navigates back; read-only
// Rows of the liquidation list page are links with this title (site label).
const LIQUIDATION_LINK = 'a[title^="Seleccione la liquidaci"]';
const DOWNLOAD_BUTTON = /descargar|imprimir|\bpdf\b|versi[oó]n imprimible/i;
const ERROR_TEXT = /se ha producido un (error|aviso)|no existe liquidaci|s[oó]lo estar[aá] disponible|no procede realizar/i;
const SERVICE_TEXT = /c[aá]lculos? de cuotas|cotizaci[oó]n/i;

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Parses "MM/YYYY" or "YYYY-MM". */
export function parseMonth(s) {
  let m = /^(\d{1,2})\/(\d{4})$/.exec(s || '');
  let r = m ? { year: Number(m[2]), month: Number(m[1]) } : null;
  if (!r && (m = /^(\d{4})-(\d{1,2})$/.exec(s || ''))) r = { year: Number(m[1]), month: Number(m[2]) };
  if (!r || r.month < 1 || r.month > 12) throw new Error(`Invalid month "${s}" (use MM/YYYY or YYYY-MM)`);
  return r;
}

/** Months from `from` to `to` inclusive (default: DEFAULT_QUOTAS_FROM to last month). */
export function buildMonths(from, to) {
  const start = parseMonth(from || DEFAULT_QUOTAS_FROM);
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = to ? parseMonth(to) : { year: lastMonth.getFullYear(), month: lastMonth.getMonth() + 1 };
  const out = [];
  for (let y = start.year, mo = start.month; y < end.year || (y === end.year && mo <= end.month);) {
    out.push({ year: y, month: mo, label: `${y}-${pad(mo)}`, period: `${pad(mo)}/${y}` });
    mo += 1; if (mo > 12) { mo = 1; y += 1; }
  }
  if (!out.length) throw new Error('--from must not be after --to');
  return out;
}

// --- Page helpers ----------------------------------------------------------------

export async function firstVisible(locator) {
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  return null;
}

/** Finds the period selector: month + year fields, or a single MM/AAAA period field. */
async function findPeriodFields(page) {
  for (const frame of page.frames()) {
    const month = (await firstVisible(frame.getByLabel(/^\s*mes\b/i)))
      || (await firstVisible(frame.locator('select[name*="mes" i], input[name*="mes" i], select[id*="mes" i], input[id*="mes" i]')));
    const year = (await firstVisible(frame.getByLabel(/a[ñn]o\b|ejercicio/i)))
      || (await firstVisible(frame.locator('select[name*="anio" i], input[name*="anio" i], select[name*="ano" i], input[name*="ano" i], select[id*="anio" i], input[id*="anio" i], select[name*="year" i], input[name*="year" i]')));
    if (month && year) return { frame, month, year };
    const period = (await firstVisible(frame.getByLabel(/periodo|per[ií]odo/i)))
      || (await firstVisible(frame.locator('input[name*="periodo" i], input[id*="periodo" i], input[placeholder*="mm/aaaa" i]')));
    if (period) return { frame, period };
  }
  return null;
}

export async function fillField(el, values) {
  const tag = await el.evaluate((e) => e.tagName).catch(() => '');
  if (tag === 'SELECT') {
    for (const v of values) {
      const ok = await el.selectOption({ value: v }, { timeout: 2000 }).then(() => true).catch(() => false)
        || await el.selectOption({ label: v }, { timeout: 2000 }).then(() => true).catch(() => false);
      if (ok) return true;
    }
    // Case-insensitive match on option labels (e.g. "MAYO")
    const opts = await el.locator('option').allTextContents().catch(() => []);
    const hit = opts.find((o) => values.some((v) => o.trim().toLowerCase() === v.toLowerCase()));
    if (hit) return el.selectOption({ label: hit }).then(() => true).catch(() => false);
    return false;
  }
  await el.fill(values[0]).catch(() => {});
  await el.press('Tab').catch(() => {});
  return true;
}

async function fillPeriod(fields, { year, month }) {
  if (fields.period) return fillField(fields.period, [`${pad(month)}/${year}`, `${pad(month)}${year}`, `${year}${pad(month)}`]);
  const okM = await fillField(fields.month, [pad(month), String(month), MONTHS_ES[month - 1], MONTHS_ES[month - 1].toUpperCase()]);
  const okY = await fillField(fields.year, [String(year)]);
  return okM && okY;
}

export async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

/** Visible text of every frame plus its tables rendered as "cell | cell" rows. */
export async function pageText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const data = await frame.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const tables = [...document.querySelectorAll('table')]
        .filter((t) => t.offsetParent !== null)
        .map((t) => [...t.rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')).filter((l) => l.replace(/[|\s]/g, '')).join('\n'))
        .filter(Boolean);
      return { body, tables };
    }).catch(() => null);
    if (!data) continue;
    if (data.body.trim()) parts.push(data.body.trim());
    if (data.tables.length) parts.push('[Tables]\n' + data.tables.join('\n\n'));
  }
  return parts.join('\n\n');
}

export async function pageHtml(page) {
  const chunks = [await page.content().catch(() => '')];
  for (const frame of page.frames().slice(1)) chunks.push(`\n<!-- frame: ${frame.url()} -->\n` + (await frame.content().catch(() => '')));
  return chunks.join('\n');
}

async function saveSnapshot(page, label) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `${QUOTAS_PREFIX}-${today()}-${label}`);
  const text = await pageText(page);
  await fs.writeFile(`${base}.txt`, `URL: ${page.url()}\n\n${text}\n`, 'utf8');
  await fs.writeFile(`${base}.html`, await pageHtml(page), 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch((e) => log('screenshot failed:', e.message.split('\n')[0]));
  return { txtPath: `${base}.txt`, htmlPath: `${base}.html`, pngPath: `${base}.png`, text };
}

async function savePdfAs(buf, label) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `${QUOTAS_PREFIX}-${today()}-${label}`);
  await fs.writeFile(`${base}.pdf`, buf);
  let text = '';
  try { text = await extractText(buf); } catch (e) { text = `(Could not extract text: ${e.message})`; }
  await fs.writeFile(`${base}.txt`, text, 'utf8');
  return { pdfPath: `${base}.pdf`, txtPath: `${base}.txt`, text };
}

/** Finds the page (tab) that shows the service's period selector. */
async function findServicePage(context) {
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    const fields = await findPeriodFields(p).catch(() => null);
    if (!fields) continue;
    const txt = await pageText(p).catch(() => '');
    if (SERVICE_TEXT.test(txt)) return { page: p, fields };
  }
  return null;
}

async function backToForm(page, formUrl) {
  if (await findPeriodFields(page)) return true;
  // The live result pages have no "Atrás" button and the browser Back button shows a
  // "Confirm Form Resubmission" error (POST pages), so re-open the service entry URL
  // (the session is reused). An "Atrás" button is still used if a page offers one.
  if (await clickByText(page, BACK_BUTTON, { roles: ['button', 'link'], label: 'back', forbidden: QUOTA_FORBIDDEN, quiet: true })) {
    await settle(page);
    if (await findPeriodFields(page)) return true;
  }
  if (formUrl) { await page.goto(formUrl, { timeout: 20000 }).catch(() => {}); await settle(page); }
  return Boolean(await findPeriodFields(page));
}

// --- Flow --------------------------------------------------------------------------

const monthIndex = (m) => m.year * 12 + m.month;

/**
 * Pure: parses individual months given as a string ("01/2022,06/2023", "2022-01 2023-06")
 * or an array of such strings. Returns sorted, de-duplicated month objects; throws on invalid input.
 */
export function parseMonthList(input) {
  if (input === undefined || input === null || input === '') return [];
  const tokens = (Array.isArray(input) ? input : [input]).flatMap((x) => String(x).split(/[\s,;]+/)).filter(Boolean);
  const byLabel = new Map();
  for (const t of tokens) {
    const { year, month } = parseMonth(t);
    const label = `${year}-${pad(month)}`;
    byLabel.set(label, { year, month, label, period: `${pad(month)}/${year}` });
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Pure: all range filters as [{ from, to }] ('YYYY-MM' or null = open end): the legacy
 * single from/to plus any number of `ranges` (see parseRanges for accepted formats).
 */
export function collectRanges({ from, to, ranges } = {}) {
  const out = parseRanges(ranges);
  if (from || to) {
    const [r] = parseRanges([{ from, to }]);
    out.push(r);
  }
  return out;
}

const labelIndex = (label) => { const [y, m] = label.split('-').map(Number); return y * 12 + m; };

/**
 * Pure: decides which months to query.
 * - Range selection (one or more ranges via from/to and/or `ranges`, or allMonths): with
 *   allMonths every month of each range (no range → 05/2023 to last month); otherwise the
 *   employee months found in the contribution bases report text that fall in ANY range
 *   (no range → all employee months).
 * - Explicit months (`months`): queried as given, even if they are not employee months.
 * - Only explicit months → exactly those; ranges and/or explicit months → union,
 *   de-duplicated and sorted.
 * Explicit months are annotated with their employers when the bases text is available;
 * those without an employee registration are returned in `notEmployee`.
 * Returns { months, ranges, notEmployee }.
 */
export function resolveQuotaMonths({ allMonths = false, from, to, ranges: rangeInput, bases = null, basesText = null, months: explicitInput } = {}) {
  const explicit = parseMonthList(explicitInput);
  const groups = collectRanges({ from, to, ranges: rangeInput });
  // bases: the full bases JSON (preferred); basesText: report text (tests / old callers).
  const parsedBases = toParsedBases(bases ?? basesText);
  const employee = parsedBases ? employeeMonths(parsedBases) : [];
  const employeeByLabel = new Map(employee.map((m) => [m.label, m]));
  const toPeriod = (label) => (label ? `${label.slice(5)}/${label.slice(0, 4)}` : undefined);

  let rangeMonths = [];
  if (allMonths) {
    rangeMonths = groups.length ? groups.flatMap((g) => buildMonths(toPeriod(g.from), toPeriod(g.to))) : buildMonths();
  } else if (groups.length) {
    rangeMonths = employee.filter((m) => groups.some((g) => (!g.from || labelIndex(m.label) >= labelIndex(g.from)) && (!g.to || labelIndex(m.label) <= labelIndex(g.to))));
  } else if (!explicit.length) {
    rangeMonths = employee;
  }

  const union = new Map(rangeMonths.map((m) => [m.label, employeeByLabel.get(m.label) || m]));
  const notEmployee = [];
  for (const m of explicit) {
    if (union.has(m.label)) continue;
    const emp = employeeByLabel.get(m.label);
    if (!emp && parsedBases) notEmployee.push(m.period);
    union.set(m.label, emp || m);
  }
  const months = [...union.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { months, ranges: summarizeEmployeeMonths(months.filter((m) => m.employers && m.employers.length)), notEmployee };
}

/**
 * Opens the service, logs in with the certificate and queries the selected months.
 * By default only the months worked as an employee (any non-RETA regime) are queried,
 * taken from the latest saved contribution bases report. If no bases report is saved,
 * or refreshBases is set, the bases report is downloaded first in the same browser session.
 * options: timeoutMs, auto, from/to (MM/YYYY filters), allMonths, refreshBases,
 *          keepOpen (afterwards, keep saving a snapshot every time the visible page changes).
 * Returns {ok, txtPath (combined summary), files, message, text, months}.
 */
export async function fetchQuotaCalculations({
  timeoutMs = QUOTAS_TIMEOUT_MS, auto = true, from, to, ranges, months: explicitMonths, keepOpen = false, allMonths = false, refreshBases = false, context: sharedContext = null,
} = {}) {
  // Validate every month/range filter before Chrome is opened.
  const explicit = parseMonthList(explicitMonths);
  const groups = collectRanges({ from, to, ranges });
  // The employee-month list from the bases report is only required for a range selection
  // (or no selection at all); explicit months alone are queried as given (a saved bases
  // report, if any, only annotates them).
  const needsBases = !allMonths && !(explicit.length && !groups.length);
  const selection = { allMonths, ranges: groups, months: explicit.map((m) => m.period) };
  const rangeText = groups.map((g) => `${g.from || '…'}..${g.to || '…'}`).join(', ');
  const describe = (src) => [
    allMonths ? `every month in ${rangeText || 'the default range'}`
      : (groups.length || !explicit.length) ? `employee (non-RETA) months${rangeText ? ` in ${rangeText}` : ''}${src ? ` from the ${src}` : ''}` : null,
    explicit.length ? `explicit months ${explicit.map((m) => m.period).join(', ')}` : null,
  ].filter(Boolean).join(' + ');

  let basesInfo = null;
  let plan = null;
  const saved = refreshBases ? null : await loadContributionBases();
  if (saved) basesInfo = `saved bases report ${saved.file}`;
  if (!refreshBases && (saved || !needsBases)) plan = resolveQuotaMonths({ ...selection, bases: saved ? saved.full : null });
  if (plan && !plan.months.length) {
    return { ok: false, txtPath: null, files: [], text: null, months: [], message: `No months to query (${describe(basesInfo)}). Check the range/months filters.` };
  }

  // A shared context (one Chrome session for several reports) is left open for the caller.
  const context = sharedContext || (await launchChrome());
  try {
    if (!plan) {
      log('Fetching the contribution bases report first to find the employee months…');
      const bases = await fetchContributionBases({ timeoutMs: Math.min(timeoutMs, 5 * 60 * 1000), auto, context });
      if (!bases.ok) return { ok: false, txtPath: null, files: [], text: null, months: [], message: `Contribution bases report failed: ${bases.message}` };
      basesInfo = `freshly downloaded bases report ${path.basename(bases.jsonPath)}`;
      plan = resolveQuotaMonths({ ...selection, bases: bases.full });
      if (!plan.months.length) return { ok: false, txtPath: null, files: [], text: null, months: [], message: 'No months to query: the bases report shows no employee (non-RETA) months in the selected range.' };
    }
    for (const r of plan.ranges) log(`employee period: ${r.from} - ${r.to} (${r.count} months) ${r.employer}${r.ccc ? ` CCC ${r.ccc}` : ''}`);
    if (plan.notEmployee.length) log(`note: not employee months in the bases report (queried anyway): ${plan.notEmployee.join(', ')}`);
    const r = await runQuotaFlow(context, { timeoutMs, auto, months: plan.months, keepOpen, basesInfo: describe(basesInfo), ranges: plan.ranges });
    return { ...r, months: plan.months.map((m) => ({ period: m.period, employers: employersLabel(m) })), notEmployee: plan.notEmployee };
  } finally {
    if (!sharedContext) await context.close().catch(() => {}); // always close Chrome, also on errors
  }
}

async function runQuotaFlow(context, { timeoutMs, auto, months, keepOpen, basesInfo = null, ranges = [] }) {
  const empSuffix = (m) => (m.employers && m.employers.length ? ` — ${employersLabel(m)}` : '');
  // Make "Imprimir" buttons harmless (no blocking print dialog); a PDF link still works.
  await context.addInitScript(() => { window.print = () => {}; });
  const capture = attachPdfCapture(context);
  const deadline = Date.now() + timeoutMs;
  const files = [];
  const summary = [];
  let pdfCount = 0;

  const drainPdfs = async (label) => {
    let buf;
    while ((buf = await capture.nextPdf(Date.now()))) {
      pdfCount += 1;
      files.push(await savePdfAs(buf, `${label}-pdf${pdfCount}`));
    }
  };

  const page = context.pages()[0] || (await context.newPage());
  log(`Fetching the ${QUOTAS_REPORT.name}. Opening`, QUOTAS_REPORT.entryUrl);
  await page.goto(QUOTAS_REPORT.entryUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message));
  log(CERT_HINT);
  log('The service opens in a new tab. If automation gets stuck, navigate manually (Consultar cálculos → DNIe o Certificado).');

  // Phase 1: reach the period selector (automatic clicks reuse the shared login flow).
  const attempts = new Map();
  const state = { ranges: [null], part: 0, rangeApplied: true };
  let service = null;
  const phase1Deadline = auto ? Math.min(deadline, Date.now() + Math.max(timeoutMs / 2, 5 * 60 * 1000)) : 0;
  while (auto && !capture.isClosed() && Date.now() < phase1Deadline) {
    service = await findServicePage(context);
    if (service) break;
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      await autoStep(p, attempts, QUOTAS_REPORT, state).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Phase 2: iterate the months (read-only queries).
  if (service && !capture.isClosed()) {
    const sp = service.page;
    const formUrl = sp.url();
    log(`Service found (${formUrl.slice(0, 100)}). Querying ${months.length} month(s): ${months[0].label} … ${months.at(-1).label}`);
    // Runs the month query from the period form (fill period + "Aceptar"). Returns { text } or { error, fatal }.
    const queryMonth = async (m) => {
      if (!(await findPeriodFields(sp)) && !(await backToForm(sp, formUrl))) return { error: 'period selector not found', fatal: true };
      const f = await findPeriodFields(sp);
      if (!f || !(await fillPeriod(f, m))) return { error: 'could not fill the period' };
      const clicked = await clickByText(sp, QUERY_BUTTON, { roles: ['button'], label: `query ${m.label}`, forbidden: QUOTA_FORBIDDEN, quiet: true });
      if (!clicked) return { error: 'query button not found', fatal: true };
      await settle(sp);
      return { text: await pageText(sp) };
    };
    const countTargets = async () => {
      const nLinks = await sp.locator(LIQUIDATION_LINK).count().catch(() => 0);
      if (nLinks) return { n: nLinks, kind: 'link' };
      const nRadios = await sp.getByRole('radio').count().catch(() => 0);
      const hasContinue = nRadios ? await sp.getByRole('button', { name: CONTINUE_BUTTON }).count().catch(() => 0) : 0;
      return nRadios && hasContinue ? { n: nRadios, kind: 'radio' } : { n: 0, kind: null };
    };

    for (const [mi, m] of months.entries()) {
      if (mi > 0 && mi % 10 === 0) log(`progress: ${mi}/${months.length} months queried (last ${months[mi - 1].label})`);
      const entry = { files: [], status: 'ok', failures: [] };
      if (capture.isClosed() || Date.now() >= deadline) { summary.push(`## ${m.label}${empSuffix(m)}\n(not queried: ${capture.isClosed() ? 'window closed' : 'timeout'})`); continue; }
      const q = await queryMonth(m);
      if (q.error) {
        summary.push(`## ${m.label}${empSuffix(m)}\n(not queried: ${q.error})`);
        log(`${m.label}: not queried (${q.error})`);
        if (q.fatal) break;
        continue;
      }
      if (ERROR_TEXT.test(q.text) && !(await sp.locator('table').count().catch(() => 0) > 2)) {
        const msg = (q.text.split('\n').filter((l) => ERROR_TEXT.test(l) || /liquidaci|periodo|disponible/i.test(l)).slice(0, 4).join(' ') || 'error').trim();
        summary.push(`## ${m.label}${empSuffix(m)}\n(no data) ${msg}`);
        Object.assign(entry, { status: 'no-data', message: msg.slice(0, 160) });
      } else {
        // Several liquidations in the month: a list page whose rows are links titled
        // "Seleccione la liquidación N" (site label); the manual's older layout uses radios + "Continuar".
        // The result page has no "Atrás" button and the browser Back button lands on a
        // "Confirm Form Resubmission" error, so for every liquidation after the first the
        // month query is re-run from the form and link N is clicked on the fresh list.
        const first = await countTargets();
        const targets = first.n ? [...Array(first.n).keys()] : [null];
        if (first.n) {
          const listSnap = await saveSnapshot(sp, `${m.label}-list`);
          files.push(listSnap);
          entry.files.push(path.basename(listSnap.txtPath));
        }
        for (const idx of targets) {
          const label = idx === null ? m.label : `${m.label}-liq${idx + 1}`;
          if (idx !== null) {
            if (idx > 0) {
              const again = await queryMonth(m);
              const now = again.error ? { n: 0 } : await countTargets();
              if (now.n <= idx) {
                const why = again.error || `list shows ${now.n} liquidation(s)`;
                log(`${label}: list not available on re-query (${why})`);
                entry.failures.push({ liquidation: `liq${idx + 1}`, message: `not opened: ${why}` });
                summary.push(`## ${label}${empSuffix(m)}\n(not opened: ${why})`);
                continue;
              }
            }
            let opened;
            if (first.kind === 'link') {
              opened = await sp.locator(LIQUIDATION_LINK).nth(idx).click({ timeout: 10000 }).then(() => true)
                .catch((e) => { log(`${label}: could not open liquidation:`, e.message.split('\n')[0]); return false; });
            } else {
              await sp.getByRole('radio').nth(idx).check({ timeout: 3000 }).catch(() => {});
              opened = await clickByText(sp, CONTINUE_BUTTON, { roles: ['button'], label: `open ${label}`, forbidden: QUOTA_FORBIDDEN, quiet: true });
            }
            if (!opened) {
              entry.failures.push({ liquidation: `liq${idx + 1}`, message: 'not opened: click failed' });
              summary.push(`## ${label}${empSuffix(m)}\n(not opened: click failed)`);
              continue;
            }
            await settle(sp);
          }
          // Prefer a PDF if the page offers one.
          if (await clickByText(sp, DOWNLOAD_BUTTON, { roles: ['button', 'link'], label: `pdf ${label}`, forbidden: QUOTA_FORBIDDEN, quiet: true })) {
            await capture.nextPdf(Date.now() + 8000).then(async (buf) => {
              if (buf) { pdfCount += 1; files.push(await savePdfAs(buf, `${label}-pdf${pdfCount}`)); }
            });
          }
          const snap = await saveSnapshot(sp, label);
          files.push(snap);
          entry.files.push(path.basename(snap.txtPath));
          summary.push(`## ${label}${empSuffix(m)}\n${snap.text}`);
        }
      }
      // Record exactly which files belong to this fetch of the month, so older snapshots
      // of the same month are ignored by the summary.
      await updateManifest(today(), { [m.label]: entry });
      await drainPdfs(m.label);
      await backToForm(sp, formUrl);
    }
  } else if (auto && !capture.isClosed()) {
    log('The period selector was not detected automatically; switching to snapshot mode.');
  }

  // Phase 3 (manual, fallback or keep-open): save a snapshot whenever the visible page changes.
  const snapshotMode = !auto || !service || keepOpen;
  if (snapshotMode && !capture.isClosed() && Date.now() < deadline) {
    log('Snapshot mode: navigate the service yourself; every new result page is saved. Close the window when done.');
    const seen = new Set();
    let n = 0;
    while (!capture.isClosed() && Date.now() < deadline) {
      for (const p of context.pages()) {
        if (p.isClosed() || !/seg-social/i.test(p.url())) continue;
        if (QUOTAS_REPORT.infoPageUrlRe.test(p.url())) continue; // the public info page is not a result
        const text = await pageText(p).catch(() => '');
        const hasTable = await p.locator('table').count().catch(() => 0);
        if (!hasTable || !SERVICE_TEXT.test(text)) continue;
        const h = crypto.createHash('sha256').update(text).digest('hex');
        if (seen.has(h)) continue;
        seen.add(h);
        n += 1;
        const snap = await saveSnapshot(p, `snap${n}`);
        files.push(snap);
        summary.push(`## snapshot ${n} (${p.url().slice(0, 80)})\n${snap.text}`);
      }
      await drainPdfs('manual');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  await drainPdfs('final').catch(() => {});
  capture.stop();

  const captured = files.filter((f) => f.pdfPath || f.htmlPath);
  if (!captured.length && !summary.length) {
    return { ok: false, txtPath: null, files: [], text: null, message: 'No quota calculation page or PDF was captured.' };
  }
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const txtPath = path.join(OUTPUT_DIR, `${QUOTAS_PREFIX}-${today()}.txt`);
  const header = [
    `Quota calculations (Consulta de cálculos de cuotas para trabajador) - captured ${new Date().toISOString()}`,
    `Months queried: ${months.length} (${months[0].period} … ${months.at(-1).period})`,
    `Month selection: ${basesInfo || 'every month in the range (--all-months)'}`,
    ...ranges.map((r) => `  ${r.from} - ${r.to} (${r.count} months): ${r.employer}${r.ccc ? ` (CCC ${r.ccc})` : ''}`),
  ].join('\n');
  const text = `${header}\n\n` + summary.join('\n\n');
  await fs.writeFile(txtPath, text, 'utf8');
  log(`done: ${months.length} month(s) queried; ${captured.length} file group(s) saved.`);
  const sum = await summarizeQuotaSnapshots(today());
  return {
    ok: true,
    txtPath,
    csvPath: sum.csvPath,
    jsonPath: sum.jsonPath,
    fileCount: files.length,
    message: `Queried ${months.length} month(s); ${sum.records.length} row(s), ${sum.summary.issues.length} issue(s). Snapshots and ${path.basename(sum.csvPath)} in ${OUTPUT_DIR_LABEL}.`,
    records: sum.records,
    summary: sum.summary,
    text: formatCompact(sum.records, sum.summary),
  };
}

/** Latest combined summary (quota-calculation-YYYY-MM-DD.txt) plus the other files of that day. */
export async function latestQuotaCalculations() {
  let names = [];
  try { names = await fs.readdir(OUTPUT_DIR); } catch { return null; }
  const combined = names.filter((f) => new RegExp(`^${QUOTAS_PREFIX}-\\d{4}-\\d{2}-\\d{2}\\.txt$`).test(f)).sort();
  if (!combined.length) return null;
  const latest = combined.at(-1);
  const day = latest.slice(QUOTAS_PREFIX.length + 1, QUOTAS_PREFIX.length + 11);
  const txtPath = path.join(OUTPUT_DIR, latest);
  const related = names.filter((f) => f.startsWith(`${QUOTAS_PREFIX}-${day}-`)).sort().map((f) => path.join(OUTPUT_DIR, f));
  return { txtPath, files: related, text: await fs.readFile(txtPath, 'utf8') };
}

// --- Compact summaries (no browser) --------------------------------------------------

const snapshotRe = (day) => new RegExp(`^${QUOTAS_PREFIX}-${day}-(?:(\\d{4}-\\d{2})(?:-(liq\\d+|list))?|(snap\\d+))\\.txt$`);

/** Latest day (YYYY-MM-DD) that has quota snapshots, or null. */
export async function latestQuotaDay() {
  let names = [];
  try { names = await fs.readdir(OUTPUT_DIR); } catch { return null; }
  const re = new RegExp(`^${QUOTAS_PREFIX}-(\\d{4}-\\d{2}-\\d{2})-`);
  return names.map((f) => re.exec(f)).filter(Boolean).map((m) => m[1]).sort().at(-1) || null;
}

/**
 * Re-parses the saved snapshots of one day into compact records and writes
 * quota-calculation-<day>.summary.csv and .summary.json. Returns { day, records, summary, csvPath, jsonPath }.
 */
export async function summarizeQuotaSnapshots(day, { withBreakdown = true } = {}) {
  const d = day || (await latestQuotaDay());
  if (!d) throw new Error('No saved quota snapshots found.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date "${d}" (use YYYY-MM-DD)`);
  const names = (await fs.readdir(OUTPUT_DIR)).sort();
  const re = snapshotRe(d);
  const entries = names.map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m);
  const manifest = await readManifest(d);
  if (!entries.length && !Object.keys(manifest).length) throw new Error(`No quota snapshots saved on ${d}.`);
  const plan = planSnapshotFiles(entries.map(({ f, m }) => ({ file: f, month: m[1] || null, kind: m[2] || (m[3] ? 'snap' : 'main') })), manifest);
  const records = [];
  for (const item of plan) {
    if (item.synthetic) { records.push(item.synthetic); continue; }
    const text = await fs.readFile(path.join(OUTPUT_DIR, item.file), 'utf8').catch(() => null);
    if (text === null) continue; // listed in the manifest but missing on disk
    const rec = parseQuotaSnapshot(text, { fileLabel: item.month, withBreakdown });
    rec.liquidation = item.kind && item.kind.startsWith('liq') ? item.kind : item.kind === 'snap' ? item.file.replace(/^.*-(snap\d+)\.txt$/, '$1') : null;
    rec.source = item.file;
    records.push(rec);
  }
  const deduped = dedupeQuotaRecords(records);
  const summary = summarizeQuotaRecords(deduped);
  const csvPath = path.join(OUTPUT_DIR, `${QUOTAS_PREFIX}-${d}.summary.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${QUOTAS_PREFIX}-${d}.summary.json`);
  await fs.writeFile(csvPath, recordsToCsv(deduped), 'utf8');
  const compactRecords = deduped.map(({ breakdown, ...r }) => r);
  await fs.writeFile(jsonPath, JSON.stringify({ day: d, currency: 'EUR', ...summary, records: compactRecords }, null, 1), 'utf8');
  return { day: d, records: deduped, summary, csvPath, jsonPath };
}

const manifestPath = (day) => path.join(OUTPUT_DIR, `${QUOTAS_PREFIX}-${day}.manifest.json`);

async function readManifest(day) {
  try { return JSON.parse(await fs.readFile(manifestPath(day), 'utf8')).months || {}; } catch { return {}; }
}

/** Merges per-month entries ({ files, status, message, failures }) into the day's manifest. */
async function updateManifest(day, months) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const current = await readManifest(day);
  const fetchedAt = new Date().toISOString();
  for (const [k, v] of Object.entries(months)) current[k] = { ...v, fetchedAt };
  await fs.writeFile(manifestPath(day), JSON.stringify({ day, months: current }, null, 1), 'utf8');
}
/**
 * Token-efficient view of saved results (used by the MCP tools).
 * detail: 'summary' (default: compact rows + totals) | 'breakdown' (adds concept lines)
 *         | 'full' (the breakdown plus `rawFiles`: the local snapshot file names; raw text stays local).
 * Month filter (union): from/to, ranges (one or more) and/or months (list); MM/YYYY or YYYY-MM.
 */
export async function quotaView({ day, detail = 'summary', from, to, months, ranges } = {}) {
  filterRecords([], { from, to, months, ranges }); // validate filters first
  const sum = await summarizeQuotaSnapshots(day);
  const filtered = filterRecords(sum.records, { from, to, months, ranges });
  const subSummary = filtered.length === sum.records.length ? sum.summary : summarizeQuotaRecords(filtered);
  const head = `day=${sum.day} csv=${fileName(sum.csvPath)} rows=${filtered.length}${filtered.length !== sum.records.length ? ` (filtered from ${sum.records.length})` : ''}`;
  if (detail === 'full') {
    const raw = await rawFilesFor([...new Set(filtered.map((r) => r.source))]);
    return `${head}\n${formatCompact(filtered, subSummary, { detail: 'breakdown' })}\n${rawFilesBlock(raw)}`;
  }
  return `${head}\n${formatCompact(filtered, subSummary, { detail })}`;
}
