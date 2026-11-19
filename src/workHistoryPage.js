// Work history ("vida laboral") read directly from the Import@ss service page (no PDF by default).
// Flow: info page → "Consultar vida laboral" → certificate login → /tramites/datosvidalaboral →
// expand every period row (read-only accordion buttons inside the table) → next pages if any →
// snapshot (txt/html/png) → full JSON (with identifying data) + anonymised copy.
// The PDF ("Descargar vida laboral") is downloaded ONLY when explicitly requested (downloadPdf).
// Tools/LLM only ever receive the full JSON PATH and the anonymised JSON CONTENT.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  REPORTS, OUTPUT_DIR, DEFAULT_TIMEOUT_MS, FORBIDDEN, log, today, launchChrome, attachPdfCapture, autoStep,
  savePdf, latestSaved, CERT_HINT,
} from './importass.js';
import { fileName, OUTPUT_DIR_LABEL } from './paths.js';
import {
  parseWorkHistoryPage, mergeWorkHistoryPages, parseWorkHistoryIdentity, withPdfIdentity, anonymizeWorkHistory,
  isAnonymized, benefitPeriodsFromWorkHistory,
} from './workHistoryParser.js';
import { parseBenefitPeriods } from './sepeParser.js';

export const WH_PREFIX = REPORTS.workHistory.filePrefix; // 'work-history'
const SERVICE_RE = /\/tramites\/datosvidalaboral/i;
// Never clicked on the service page (on top of the global FORBIDDEN list; site labels).
export const WH_FORBIDDEN = /descargar|informar|error|filtrar|filtro|buscar|search|exit|salir|cerrar|imprimir|enviar|aceptar|confirmar|modificar|solicit/i;
const JSON_RE = new RegExp(`^${WH_PREFIX}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);

/** Pure: the only payload tools return — the folder label, the full JSON FILE NAME and the anonymised JSON content. */
export function workHistoryToolPayload({ jsonPath, anon, pdfPath = null, note = null }) {
  const out = { folder: OUTPUT_DIR_LABEL, fullJsonFile: fileName(jsonPath) };
  if (pdfPath) out.pdfFile = fileName(pdfPath);
  if (note) out.note = note;
  out.workHistory = anon;
  return out;
}

/** Writes the full and anonymised JSON files for a given day. Returns { jsonPath, anonPath, anon }. */
export async function saveWorkHistoryJson(full, { dir = OUTPUT_DIR, day = today() } = {}) {
  const anon = anonymizeWorkHistory(full);
  if (!isAnonymized(anon, full)) throw new Error('Anonymisation check failed: identifying data still present; nothing written.');
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `${WH_PREFIX}-${day}.json`);
  const anonPath = path.join(dir, `${WH_PREFIX}-${day}.anon.json`);
  await fs.writeFile(jsonPath, JSON.stringify(full, null, 1), 'utf8');
  await fs.writeFile(anonPath, JSON.stringify(anon, null, 1), 'utf8');
  return { jsonPath, anonPath, anon };
}

/** Newest saved work history JSON: { day, jsonPath, anonPath, full, anon } or null. */
export async function latestWorkHistoryJson({ dir = OUTPUT_DIR } = {}) {
  const names = await fs.readdir(dir).catch(() => []);
  const days = names.map((f) => JSON_RE.exec(f)).filter(Boolean).map((m) => m[1]).sort();
  if (!days.length) return null;
  const day = days.at(-1);
  const jsonPath = path.join(dir, `${WH_PREFIX}-${day}.json`);
  const anonPath = path.join(dir, `${WH_PREFIX}-${day}.anon.json`);
  const full = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  let anon = null;
  try { anon = JSON.parse(await fs.readFile(anonPath, 'utf8')); } catch { /* regenerate below */ }
  if (!anon || !isAnonymized(anon, full)) anon = anonymizeWorkHistory(full);
  return { day, jsonPath, anonPath, full, anon };
}

/**
 * Work history for the other tools (SEPE, combined report…): JSON first; trivial fallback to the text of
 * an old PDF report. Returns { source: 'json'|'pdf-text', file, json|null, benefitPeriods } or null.
 */
export async function loadWorkHistory({ now = new Date(), dir = OUTPUT_DIR } = {}) {
  const j = await latestWorkHistoryJson({ dir }).catch(() => null);
  if (j) return { source: 'json', file: path.basename(j.jsonPath), day: j.day, json: j.full, benefitPeriods: benefitPeriodsFromWorkHistory(j.full, { now }) };
  const old = dir === OUTPUT_DIR ? await latestSaved().catch(() => null) : null;
  if (old) return { source: 'pdf-text', file: path.basename(old.txtPath), day: old.day ?? null, json: null, benefitPeriods: parseBenefitPeriods(old.text, { now }) };
  return null;
}

/** read_latest_work_history_report / CLI show: { ok, payload|message } (never raw page or PDF text). */
export async function workHistoryView({ dir = OUTPUT_DIR } = {}) {
  const j = await latestWorkHistoryJson({ dir }).catch(() => null);
  if (j) return { ok: true, payload: workHistoryToolPayload({ jsonPath: j.jsonPath, anon: j.anon, pdfPath: j.full.source && j.full.source.pdf ? j.full.source.pdf.pdfPath : null }) };
  const old = dir === OUTPUT_DIR ? await latestSaved().catch(() => null) : null;
  if (old) {
    return { ok: false, message: `Only an older PDF-based work history is saved (${path.basename(old.pdfPath || old.txtPath)} in ${OUTPUT_DIR_LABEL}); its text is not returned. Run get_work_history_report (CLI: fetch) to read the page and create the JSON.` };
  }
  return { ok: false, message: 'No work history saved yet. Run get_work_history_report (CLI: fetch).' };
}

// --- Browser (live; never run by tests) -------------------------------------------------

async function snapshot(page, label) {
  const base = path.join(OUTPUT_DIR, `${WH_PREFIX}-${today()}-${label}`);
  const text = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  await fs.writeFile(`${base}.txt`, `URL: ${page.url()}\n\n${text}`, 'utf8');
  await fs.writeFile(`${base}.html`, html, 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  return { html, files: [`${base}.txt`, `${base}.html`, `${base}.png`] };
}

/** Expands every period row: only the accordion buttons in the table's title cells. */
async function expandRows(page) {
  const btns = page.locator('table.ss-table tbody td[class*="col--title"] button.ss-collapse__btn, table.ss-table tbody tr.ss-table__row button.ss-collapse__btn');
  const n = await btns.count().catch(() => 0);
  let opened = 0;
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    const label = ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const info = await b.evaluate((e) => ({ expanded: e.getAttribute('aria-expanded'), type: e.getAttribute('type'), name: e.getAttribute('name'), value: e.getAttribute('value'), onclick: e.getAttribute('onclick') || '' })).catch(() => null);
    if (!info || info.expanded === 'true') continue;
    if (FORBIDDEN.test(label) || WH_FORBIDDEN.test(label) || info.type === 'submit' || info.name === 'accion' || /descargaDoc|accion!/i.test(info.onclick)) continue;
    if (!(await b.isVisible().catch(() => false))) continue;
    await b.click({ timeout: 5000 }).catch((e) => log('  expand failed:', e.message.split('\n')[0]));
    opened += 1;
    await page.waitForTimeout(400);
  }
  if (opened) log(`expanded ${opened} period row(s)`);
  await page.waitForTimeout(1000);
}

/** Clicks the pagination "next" control (read-only). Returns true when clicked. */
async function nextPage(page) {
  const cands = page.locator('.ss-pagination a, .ss-pagination button');
  const n = await cands.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = cands.nth(i);
    const meta = await el.evaluate((e) => ({ text: (e.innerText || '').trim(), aria: e.getAttribute('aria-label') || '', title: e.getAttribute('title') || '', cls: e.className || '', disabled: e.disabled || e.getAttribute('aria-disabled') === 'true' || /disabled/.test(e.className || '') })).catch(() => null);
    if (!meta || meta.disabled) continue;
    const label = `${meta.text} ${meta.aria} ${meta.title} ${meta.cls}`;
    if (FORBIDDEN.test(label) || WH_FORBIDDEN.test(label)) continue;
    if (!/siguiente|next|›|»|^>$/i.test(label.trim()) && !/^\s*[>›»]\s*$/.test(meta.text)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    log('automatic click (next page)');
    await el.click({ timeout: 5000 }).catch((e) => log('  click failed:', e.message.split('\n')[0]));
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    return true;
  }
  return false;
}

/** Explicitly requested only: the page's own "Descargar vida laboral" button (site label). */
async function downloadWorkHistoryPdf(page, capture) {
  const btn = page.locator('button[name="accion"][value="AC_DESC_VIDA_LABORAL"]').first();
  if (!(await btn.isVisible().catch(() => false))) { log('"Descargar vida laboral" button not found'); return null; }
  log('automatic click (requested PDF): "Descargar vida laboral"');
  await btn.click({ timeout: 5000 }).catch((e) => log('  click failed:', e.message.split('\n')[0]));
  const buf = await capture.nextPdf(Date.now() + 60000);
  if (!buf) { log('no PDF received within 60 s'); return null; }
  return savePdf(buf, WH_PREFIX, null);
}

/**
 * get_work_history_report: reads the work history from the service page and writes
 * work-history-YYYY-MM-DD.json (full) and .anon.json. options: timeoutMs, auto, downloadPdf,
 * context (a shared Chrome session, left open for the caller).
 * Returns { ok, message, jsonPath, anonPath, anon, pdfPath, files }.
 */
export async function fetchWorkHistoryFromPage({ timeoutMs = DEFAULT_TIMEOUT_MS, auto = true, downloadPdf = false, context: sharedContext = null } = {}) {
  // A download label that never matches: autoStep logs in and stops on the service page.
  const report = { ...REPORTS.workHistory, downloadLabel: /(?!)/ };
  const context = sharedContext || (await launchChrome());
  const capture = downloadPdf ? attachPdfCapture(context) : null;
  const files = [];
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(report.entryUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message));
    log(CERT_HINT);
    const attempts = new Map();
    const state = { ranges: [null], part: 0, rangeApplied: false, rangeFailed: false, pdfPending: false };
    const deadline = Date.now() + timeoutMs;
    let target = null;
    while (Date.now() < deadline && !target) {
      for (const p of context.pages()) {
        if (p.isClosed()) continue;
        if (SERVICE_RE.test(p.url())) { target = p; break; }
        if (auto) await autoStep(p, attempts, report, state).catch(() => {});
      }
      if (!target) await new Promise((r) => setTimeout(r, 2500));
    }
    if (!target) return { ok: false, message: 'The work history page was not reached before the timeout. Nothing saved.', files };
    await target.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await target.waitForSelector('table.ss-table', { timeout: 30000 }).catch(() => {});
    await target.waitForTimeout(3000);
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const fetchedAt = new Date().toISOString();
    const pages = [];
    for (let n = 1; n <= 50; n++) {
      await expandRows(target);
      const snap = await snapshot(target, n === 1 ? 'page' : `page-${n}`);
      files.push(...snap.files);
      const parsed = parseWorkHistoryPage(snap.html, { url: target.url().split('?')[0], fetchedAt, pageNumber: n });
      pages.push(parsed);
      if (parsed.pagination.current >= parsed.pagination.total) break;
      if (!(await nextPage(target))) { log('next page control not found; stopping at page', n); break; }
    }
    let full = mergeWorkHistoryPages(pages);
    if (!full.periods.length) return { ok: false, message: 'Work history page reached but no periods were found; snapshots saved.', files };
    let pdf = null;
    if (downloadPdf) {
      pdf = await downloadWorkHistoryPdf(target, capture);
      if (pdf) { files.push(pdf.pdfPath, pdf.txtPath); full = withPdfIdentity(full, parseWorkHistoryIdentity(pdf.text), { pdfPath: pdf.pdfPath, txtPath: pdf.txtPath }); }
    }
    const saved = await saveWorkHistoryJson(full);
    files.push(saved.jsonPath, saved.anonPath);
    log(`saved ${saved.jsonPath} and ${path.basename(saved.anonPath)} (${full.periods.length} periods)`);
    return {
      ok: true, jsonPath: saved.jsonPath, anonPath: saved.anonPath, anon: saved.anon, pdfPath: pdf ? pdf.pdfPath : null, files,
      message: downloadPdf && !pdf ? 'Work history saved from the page; the requested PDF could not be downloaded.' : null,
    };
  } finally {
    capture?.stop();
    if (!sharedContext) await context.close().catch(() => {});
  }
}
