// Core: opens Chrome (using the macOS keychain), lets the user pick their
// certificate in the native picker and captures report PDFs from Import@ss
// (Spanish Social Security portal). Never reads, exports or copies
// certificates or private keys.
//
// IMPORTANT: every text regex used to find buttons/links below is a Spanish
// label shown on the website and must stay in Spanish to match it.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { CONFIG } from './config.js';

export const PROJECT_DIR = CONFIG.projectDir;
export const PROFILE_DIR = CONFIG.profileDir; // HUELLA_CHROME_PROFILE (default <project>/.chrome-profile)
export const OUTPUT_DIR = CONFIG.outputDir; // HUELLA_OUTPUT_DIR (default ~/Documents/HuellaContributiva)

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PART_TIMEOUT_MS = 90 * 1000; // max wait for each additional date-range part
export const log = (...a) => console.error('[huella-contributiva]', ...a); // stderr: keep stdout clean (MCP/JSON)

// Matches a URL-encoded page title such as "Informe de tu vida laboral" (%20, + or space).
const titleRe = (...words) => new RegExp(words.join('(%20|\\+| )'), 'i');

// Report definitions. URLs and labels are taken from the live Import@ss pages.
export const REPORTS = {
  workHistory: {
    name: 'work history report (Informe de Vida Laboral)',
    filePrefix: 'work-history',
    // Official Import@ss page for the "Informe de tu vida laboral" procedure.
    entryUrl:
      'https://portal.seg-social.gob.es/wps/portal/importass/importass/Categorias/Vida%20laboral%20e%20informes/Informes%20sobre%20tu%20situacion%20laboral/Informe%20de%20tu%20vida%20laboral',
    infoPageUrlRe: titleRe('Informe', 'de', 'tu', 'vida', 'laboral'),
    // Target of the "Consultar vida laboral" button (authenticated area).
    servicePath: '/wps/myportal/importass/importass/tramites/datosvidalaboral',
    isServiceUrl: (url) => url.includes('datosvidalaboral') || /vidalaboral/i.test(url),
    isServiceUrlForLogin: (url) => url.includes('datosvidalaboral'),
    consultLabel: /consultar vida laboral/i, // site label
    downloadLabel: /descargar (el )?(informe|vida laboral)|^\s*descargar\s*$|obtener informe|ver informe|generar (el )?informe/i, // site labels
    supportsRanges: false,
  },
  contributionBases: {
    name: 'contribution bases report (Informe de bases de cotización)',
    filePrefix: 'contribution-bases',
    // Official Import@ss page for the "Informe de bases de cotización" procedure.
    entryUrl:
      'https://portal.seg-social.gob.es/wps/portal/importass/importass/Categorias/Vida+laboral+e+informes/Informes+de+tus+cotizaciones/Informe+de+bases+de+cotizacion',
    infoPageUrlRe: titleRe('Informe', 'de', 'bases', 'de', 'cotizaci'),
    // Target of the "Consultar bases" button (authenticated area).
    servicePath: '/wps/myportal/importass/importass/tramites/informebases',
    // "informebasesdomicilio" is the postal-delivery request: never treat it as the service.
    isServiceUrl: (url) => /tramites\/informebases(?!domicilio)/i.test(url),
    isServiceUrlForLogin: (url) => /tramites\/informebases(?!domicilio)/i.test(url),
    consultLabel: /consultar bases/i, // site label
    downloadLabel: /descargar (el )?(informe|bases)( de (bases de )?cotizaci[oó]n)?|^\s*descargar\s*$|^\s*descargar pdf\s*$|obtener informe|ver informe|generar (el )?informe/i, // site labels
    supportsRanges: true,
  },
};

export const today = () => formatIso(new Date());
export const pad = (n) => String(n).padStart(2, '0');
const formatIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const formatEs = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

/** Parses "DD/MM/YYYY", "YYYY-MM-DD" or "today". Returns a local Date or throws. */
export function parseDate(s) {
  if (!s || s === 'today') return new Date(new Date().toDateString());
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  throw new Error(`Invalid date "${s}" (use DD/MM/YYYY or YYYY-MM-DD)`);
}

/** Splits [from, to] into consecutive ranges of at most `chunkYears` years. */
export function buildRanges(from, to, chunkYears) {
  if (!from && !to) return [null]; // no filter: site's full report
  const start = from ? parseDate(from) : null;
  const end = to ? parseDate(to) : parseDate('today');
  if (!start) throw new Error('--from is required when --to or --chunk-years is used');
  if (start > end) throw new Error('--from must be before --to');
  if (!chunkYears) return [{ from: start, to: end }];
  const ranges = [];
  let cur = start;
  while (cur <= end) {
    const next = new Date(cur.getFullYear() + chunkYears, cur.getMonth(), cur.getDate());
    const last = new Date(next.getTime() - 86400000);
    ranges.push({ from: cur, to: last < end ? last : end });
    cur = next;
  }
  return ranges;
}

export const isPdf = (buf) => buf && buf.length > 1000 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

// Button/link labels we must NEVER click (requests/submissions with side effects).
// These are Spanish site labels and must stay in Spanish to match the website.
export const FORBIDDEN = /domicilio|correo postal|modificaci|incorporaci|apoderad|poderdante|representa|sin certificado|sms|selfie|cerrar sesi|desconectar|salir/i;

export async function clickByText(page, regex, { roles = ['button', 'link'], label, forbidden = null, quiet = false } = {}) {
  for (const frame of page.frames()) {
    for (const role of roles) {
      const loc = frame.getByRole(role, { name: regex });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        const txt = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
        if (FORBIDDEN.test(txt) || (forbidden && forbidden.test(txt))) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        if (!quiet) log(`automatic click (${label}): "${txt.slice(0, 60)}"`);
        await el.click({ timeout: 5000 }).catch((e) => log('  click failed:', e.message.split('\n')[0]));
        return true;
      }
    }
  }
  return false;
}

// --- Date range filter (contribution bases report only) ---------------------

async function findDateInput(page, labelRe, index) {
  for (const frame of page.frames()) {
    const byLabel = frame.getByLabel(labelRe);
    const n = await byLabel.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = byLabel.nth(i);
      const tag = await el.evaluate((e) => e.tagName).catch(() => '');
      if (tag === 'INPUT' && (await el.isVisible().catch(() => false))) return el;
    }
  }
  // Fallback: the n-th visible date-like input (type=date or a DD/MM/AAAA placeholder; site text).
  for (const frame of page.frames()) {
    const loc = frame.locator('input[type="date"], input[placeholder*="dd/mm" i], input[placeholder*="aaaa" i], input[placeholder*="fecha" i]');
    const visible = [];
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) visible.push(loc.nth(i));
    if (visible.length >= 2) return visible[index];
  }
  return null;
}

async function fillDate(input, date) {
  const type = ((await input.getAttribute('type').catch(() => '')) || '').toLowerCase();
  const value = type === 'date' ? formatIso(date) : type === 'month' ? formatIso(date).slice(0, 7) : formatEs(date);
  await input.fill(value);
  await input.press('Tab').catch(() => {});
}

// Site labels: "Desde"/"Hasta", "Fecha inicio"/"Fecha fin", "Filtrar", "Aplicar", "Buscar". ("Aceptar" is deliberately not clicked.)
const FROM_LABEL = /desde|inicio|inicial/i;
const TO_LABEL = /hasta|fin\b|final/i;
const APPLY_LABEL = /^\s*(aplicar|filtrar|buscar)( filtros?)?\s*$/i;
const FILTER_TOGGLE_LABEL = /filtrar|filtros/i;

/** Best effort: fills the from/to date inputs and applies the filter. Returns true on success. */
async function applyDateRange(page, range) {
  let fromInput = await findDateInput(page, FROM_LABEL, 0);
  let toInput = await findDateInput(page, TO_LABEL, 1);
  if (!fromInput || !toInput) {
    await clickByText(page, FILTER_TOGGLE_LABEL, { label: 'open filter' });
    await page.waitForTimeout(1500);
    fromInput = await findDateInput(page, FROM_LABEL, 0);
    toInput = await findDateInput(page, TO_LABEL, 1);
  }
  if (!fromInput || !toInput) return false;
  log(`applying date range ${formatEs(range.from)} - ${formatEs(range.to)}`);
  await fillDate(fromInput, range.from);
  await fillDate(toInput, range.to);
  await clickByText(page, APPLY_LABEL, { roles: ['button'], label: 'apply filter' });
  await page.waitForTimeout(2500);
  return true;
}

// Download dialogs may offer "Informe completo" vs. a filtered report (site labels).
async function chooseReportOption(page, filtered) {
  const re = filtered ? /acotad|filtrad|b[uú]squeda|seleccionad/i : /complet/i;
  for (const frame of page.frames()) {
    const radio = frame.getByRole('radio', { name: re }).first();
    if ((await radio.count().catch(() => 0)) && (await radio.isVisible().catch(() => false))) {
      if (!(await radio.isChecked().catch(() => true))) {
        log(`selecting report option: ${filtered ? 'filtered' : 'complete'}`);
        await radio.check({ timeout: 3000 }).catch(() => {});
      }
      return true;
    }
  }
  return false;
}

// --- Automatic navigation ----------------------------------------------------

// Tries to advance through the flow on its own. If something doesn't match, it
// does nothing and the user can navigate manually in the open window.
export async function autoStep(page, attempts, report, state) {
  const url = page.url();
  const key = (s) => `${s}|${state.part}|${url.split('#')[0]}`;
  const tryOnce = async (step, max, fn) => {
    const k = key(step);
    const n = attempts.get(k) || 0;
    if (n >= max) return false;
    attempts.set(k, n + 1);
    return fn();
  };

  // 1) Procedure info page → consult button (e.g. "Consultar vida laboral", site label)
  if (report.infoPageUrlRe.test(url) && !url.includes('/myportal/')) {
    await tryOnce('consult', report.consultMaxAttempts ?? 2, async () => {
      const ok = await clickByText(page, report.consultLabel, { label: 'info page' });
      // Some pages show an identification-method popup after the consult button: keep the
      // "I have an electronic ID / certificate" option and press its "Continuar" (it only opens the service).
      if (ok && report.consultPopup) {
        await page.waitForTimeout(1000);
        await page.locator(report.consultPopup.radio).check({ timeout: 3000 }).catch(() => {});
        const btn = page.locator(report.consultPopup.button);
        if (await btn.isVisible().catch(() => false)) {
          log('automatic click (identification popup): "Continuar"');
          await btn.click({ timeout: 5000 }).catch((e) => log('  click failed:', e.message.split('\n')[0]));
        }
      }
      if (!ok) {
        // fallback: call the page's own JS function (site-defined name) or navigate to the target
        const ran = await page.evaluate(() => {
          // eslint-disable-next-line no-undef
          if (typeof clickBotonConsultar === 'function') { clickBotonConsultar(); return true; }
          return false;
        }).catch(() => false);
        if (!ran) await page.goto(new URL(report.servicePath, url).toString()).catch(() => {});
      }
    });
    return;
  }

  // 2) Identification screens (Import@ss / Cl@ve) → "DNIe o Certificado" (site label)
  const looksLikeLogin = /clave\.gob\.es|pasarela|identificacion|login|acceso|ipce|autentic/i.test(url) ||
    (await page.getByText(/Cl@ve|Identif[ií]cate|identificaci[oó]n/i).first().isVisible().catch(() => false));
  if (looksLikeLogin && !report.isServiceUrlForLogin(url)) {
    await tryOnce('certificate', 2, () =>
      clickByText(page, /DNI ?-?e.*certificado|certificado.*electr|^\s*DNIe\s*$|certificado digital|DNIe \/ Certificado/i, { label: 'login' }));
    // Cl@ve sometimes needs a second "Acceder" (site label) click after choosing the method
    await tryOnce('access', 1, () => clickByText(page, /^\s*acceder\s*$/i, { roles: ['button'], label: 'login' }));
    return;
  }

  // 3) Authenticated service area → (optional date range) → "Descargar" (site label)
  if (report.isServiceUrl(url)) {
    const range = state.ranges[state.part];
    if (range && !state.rangeApplied) {
      const applied = await tryOnce('range', 3, () => applyDateRange(page, range));
      if (applied) state.rangeApplied = true;
      else if ((attempts.get(key('range')) || 0) >= 3) {
        log('WARNING: could not find the date filter; downloading the unfiltered (complete) report instead.');
        state.ranges = [null];
        state.part = 0;
        state.rangeFailed = true;
      }
      return;
    }
    if (report.supportsRanges) await chooseReportOption(page, Boolean(range)).catch(() => {});
    await tryOnce('download', 3, async () => (await clickByText(page, report.downloadLabel, { label: 'service' })));
  }
}

// --- PDF text extraction and saving ------------------------------------------

export async function extractText(pdfBuffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let lastY = null;
    let line = '';
    const lines = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.trimEnd()); line = ''; }
      else if (line && !line.endsWith(' ') && it.str && !it.str.startsWith(' ')) line += ' ';
      line += it.str;
      lastY = y;
      if (it.hasEOL) { lines.push(line.trimEnd()); line = ''; lastY = null; }
    }
    if (line) lines.push(line.trimEnd());
    pages.push(`--- Page ${p} ---\n` + lines.filter((l, i, a) => l || a[i - 1]).join('\n'));
  }
  await task.destroy?.();
  return pages.join('\n\n');
}

export async function savePdf(buf, filePrefix, partNumber) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const suffix = partNumber ? `-part${partNumber}` : '';
  const base = path.join(OUTPUT_DIR, `${filePrefix}-${today()}${suffix}`);
  const pdfPath = `${base}.pdf`;
  const txtPath = `${base}.txt`;
  await fs.writeFile(pdfPath, buf);
  let text = '';
  try { text = await extractText(buf); } catch (e) { text = `(Could not extract text: ${e.message})`; }
  await fs.writeFile(txtPath, text, 'utf8');
  log(`saved ${pdfPath}`);
  return { pdfPath, txtPath, text };
}

// --- Generic flow ------------------------------------------------------------

/** Launches the installed Google Chrome with the dedicated persistent profile. */
export async function launchChrome() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const downloadsDir = path.join(PROFILE_DIR, '_downloads');
  await fs.mkdir(downloadsDir, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    // Playwright adds --use-mock-keychain on macOS, which would prevent Chrome
    // from seeing the keychain certificates. Remove it.
    ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic', '--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check'],
  });
}

/**
 * Captures every PDF the context receives (downloads and application/pdf responses),
 * de-duplicated by content hash (a PDF may arrive both ways).
 * Returns { nextPdf(deadline), pending(), stop(), isClosed(), onCapture(fn) }.
 */
export function attachPdfCapture(context) {
  const seen = new Set();
  const queue = [];
  let wake = null;
  let closed = false;
  let stopped = false;
  let listener = null;
  const offer = (buf, origin) => {
    if (stopped || !isPdf(buf)) return;
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (seen.has(hash)) return;
    seen.add(hash);
    log(`PDF captured (${origin}, ${buf.length} bytes)`);
    queue.push(buf);
    listener?.();
    wake?.();
  };
  const nextPdf = (deadline) => new Promise((resolve) => {
    const check = () => {
      if (queue.length) return resolve(queue.shift());
      if (closed || stopped || Date.now() >= deadline) return resolve(null);
      wake = () => { wake = null; clearTimeout(t); check(); };
      const t = setTimeout(() => { wake = null; check(); }, Math.max(0, Math.min(1000, deadline - Date.now())));
    };
    check();
  });

  const watchPage = (page) => {
    page.on('download', async (dl) => {
      try {
        const p = await dl.path();
        if (p) offer(await fs.readFile(p), `download ${dl.suggestedFilename()}`);
      } catch (e) { log('error reading download:', e.message); }
    });
  };
  context.pages().forEach(watchPage);
  context.on('page', watchPage);

  context.on('response', async (res) => {
    if (stopped) return;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    const cd = (res.headers()['content-disposition'] || '').toLowerCase();
    if (!ct.includes('application/pdf') && !(ct.includes('octet-stream') && cd.includes('.pdf'))) return;
    let buf = null;
    try { buf = await res.body(); } catch { /* e.g. Chrome's built-in PDF viewer */ }
    if (!isPdf(buf)) {
      // Retry the same URL with the session cookies (GET only)
      if (res.request().method() === 'GET') {
        try { const r2 = await context.request.get(res.url()); buf = await r2.body(); } catch { /* ignore */ }
      }
    }
    offer(buf, `response ${res.url().slice(0, 100)}`);
  });
  context.on('close', () => { closed = true; wake?.(); });

  return {
    nextPdf,
    pending: () => queue.length,
    stop: () => { stopped = true; wake?.(); },
    isClosed: () => closed,
    onCapture: (fn) => { listener = fn; },
  };
}

// Optional: set HUELLA_CERT_LABEL to show which certificate to pick (kept out of source code on purpose).
export const CERT_HINT = CONFIG.certLabel
  ? `When the macOS certificate picker appears, choose "${CONFIG.certLabel}".`
  : 'When the macOS certificate picker appears, choose your own personal certificate.';

/**
 * Runs the flow for one report.
 * options: timeoutMs, auto (automatic clicks), ranges (array of {from,to} or [null]),
 *          keepOpen (after the automatic part(s), keep capturing PDFs the user downloads
 *          until the window is closed or the timeout expires).
 * Returns {ok, pdfPath, txtPath, files, message, text}.
 */
export async function runReportFlow(report, { timeoutMs = DEFAULT_TIMEOUT_MS, auto = true, ranges = [null], keepOpen = false, context: sharedContext = null } = {}) {
  // A shared context (e.g. bases report followed by quota queries in one session) is
  // left open for the caller; otherwise Chrome is launched and closed here.
  const context = sharedContext || (await launchChrome());
  const ownsContext = !sharedContext;
  const capture = attachPdfCapture(context);
  const nextPdf = capture.nextPdf;
  const state = { ranges, part: 0, rangeApplied: false, rangeFailed: false, pdfPending: false };
  // As soon as a PDF arrives, stop automatic clicking until it has been saved.
  capture.onCapture(() => { state.pdfPending = true; });

  const page = context.pages()[0] || (await context.newPage());
  log(`Fetching the ${report.name}. Opening`, report.entryUrl);
  await page.goto(report.entryUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message));
  log(CERT_HINT);
  log('If automation gets stuck, navigate manually (consult button → DNIe o Certificado → Descargar); the tool keeps waiting for a PDF.');

  let finished = false;
  const attempts = new Map();
  const deadline = Date.now() + timeoutMs;
  let autoOn = auto;
  const loop = (async () => {
    while (!finished && !capture.isClosed() && Date.now() < deadline) {
      // Do not click anything while a captured PDF is waiting to be saved, or
      // once every automatic part has been received.
      if (autoOn && !state.pdfPending && state.part < state.ranges.length) {
        for (const p of context.pages()) {
          if (p.isClosed()) continue;
          await autoStep(p, attempts, report, state).catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  })();

  const files = [];
  const multi = () => state.ranges.length > 1 || keepOpen;
  // Automatic part(s): one PDF per range (or a single unfiltered PDF).
  while (state.part < state.ranges.length) {
    const partDeadline = state.part === 0 ? deadline : Math.min(deadline, Date.now() + PART_TIMEOUT_MS);
    const buf = await nextPdf(partDeadline);
    if (!buf) break;
    files.push(await savePdf(buf, report.filePrefix, multi() ? files.length + 1 : 0));
    state.part += 1;
    state.rangeApplied = false;
    state.pdfPending = capture.pending() > 0;
  }
  const missingParts = state.ranges.length - Math.min(state.part, state.ranges.length);

  // Optional: keep capturing whatever the user downloads manually.
  if (keepOpen && !capture.isClosed() && files.length) {
    autoOn = false;
    log('Keep-open mode: download any extra PDFs in the window; close it (or wait for the timeout) when done.');
    for (;;) {
      const buf = await nextPdf(deadline);
      if (!buf) break;
      files.push(await savePdf(buf, report.filePrefix, files.length + 1));
    }
  }

  finished = true; // stops the loop and the capture
  capture.stop();
  await loop.catch(() => {});
  const closed = capture.isClosed();

  if (!files.length) {
    if (!closed && ownsContext) await context.close().catch(() => {});
    return {
      ok: false, pdfPath: null, txtPath: null, files: [], text: null,
      message: closed
        ? 'The Chrome window was closed before the PDF was obtained.'
        : `No PDF was received within ${Math.round(timeoutMs / 1000)} s.`,
    };
  }

  await new Promise((r) => setTimeout(r, 1500));
  if (!capture.isClosed() && ownsContext) await context.close().catch(() => {});
  let message = files.length === 1
    ? `The ${report.name} was downloaded and its text extracted.`
    : `${files.length} PDFs of the ${report.name} were downloaded and their text extracted.`;
  if (state.rangeFailed) message += ' The date filter could not be found, so the unfiltered (complete) report was downloaded.';
  if (missingParts > 0) message += ` ${missingParts} date-range part(s) were not received.`;
  const text = files.map((f) => (files.length > 1 ? `===== ${path.basename(f.pdfPath)} =====\n` : '') + f.text).join('\n\n');
  return {
    ok: true,
    pdfPath: files[0].pdfPath,
    txtPath: files[0].txtPath,
    files: files.map(({ pdfPath, txtPath }) => ({ pdfPath, txtPath })),
    message,
    text,
  };
}

/**
 * Latest saved report for a prefix. If the latest date has several parts, all
 * of them are returned (text concatenated in part order).
 */
export async function latestSavedFor(filePrefix) {
  let names = [];
  try { names = await fs.readdir(OUTPUT_DIR); } catch { return null; }
  const re = new RegExp(`^${filePrefix}-(\\d{4}-\\d{2}-\\d{2})(?:-part(\\d+))?\\.txt$`);
  const txts = names.map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m);
  if (!txts.length) return null;
  const latestDate = txts.map((x) => x.m[1]).sort().at(-1);
  const sameDay = txts.filter((x) => x.m[1] === latestDate);
  // Prefer the part files if this day has them; otherwise the single file.
  const parts = sameDay.filter((x) => x.m[2]).sort((a, b) => Number(a.m[2]) - Number(b.m[2]));
  const chosen = parts.length ? parts : sameDay;
  const files = [];
  for (const { f } of chosen) {
    const txtPath = path.join(OUTPUT_DIR, f);
    files.push({ txtPath, pdfPath: txtPath.replace(/\.txt$/, '.pdf'), text: await fs.readFile(txtPath, 'utf8') });
  }
  const text = files.map((x) => (files.length > 1 ? `===== ${path.basename(x.pdfPath)} =====\n` : '') + x.text).join('\n\n');
  return { txtPath: files[0].txtPath, pdfPath: files[0].pdfPath, files: files.map(({ pdfPath, txtPath }) => ({ pdfPath, txtPath })), text };
}

// --- Public API ----------------------------------------------------------------

export const fetchWorkHistoryReport = (opts = {}) =>
  runReportFlow(REPORTS.workHistory, { timeoutMs: opts.timeoutMs, auto: opts.auto });

export const latestSaved = () => latestSavedFor(REPORTS.workHistory.filePrefix);

export const fetchContributionBasesReport = ({ timeoutMs, auto, from, to, chunkYears, keepOpen, context } = {}) =>
  runReportFlow(REPORTS.contributionBases, { timeoutMs, auto, ranges: buildRanges(from, to, chunkYears), keepOpen, context });

export const latestContributionBases = () => latestSavedFor(REPORTS.contributionBases.filePrefix);

// Quota calculations live in quotas.js (re-exported here for convenience).
export { fetchQuotaCalculations, latestQuotaCalculations } from './quotas.js';
