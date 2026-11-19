// RETA annual regularisation (art. 308.1.c LGSS, RD 2064/1995 art. 46): the Import@ss services
// "Regularización anual de cuotas de Trabajo Autónomo" (current year) and "... de años anteriores".
// READ-ONLY: it logs in with the user's certificate, opens the "años anteriores" page, reads the result
// cards and downloads the resolution PDF of each requested year (the only button it clicks there is the
// explicitly allowlisted "Resolución <year>" DESCARGAR button), and saves a snapshot of every page. The
// current-year service is a query SUBMISSION form ("Vas a solicitar una consulta") and is never used in
// automatic mode. It never keeps a higher base, opts, cancels, pays, downloads or uses the payment document,
// sends a query, requests anything, touches bank data, acts as a representative, accepts, confirms or
// signs. It NEVER opens Social Security (NOTESS) or DEHú notifications: navigations there are blocked,
// because opening a notification counts as legal receipt.
//
// IMPORTANT: every text regex used to find buttons, links and fields below is a Spanish label shown on
// the website and must stay in Spanish to match it.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  OUTPUT_DIR, CERT_HINT, launchChrome, attachPdfCapture, extractText, autoStep, log, today,
} from './importass.js';
import { fileName, rawFilesFor, rawFilesBlock, OUTPUT_DIR_LABEL } from './paths.js';
import { settle, pageText, pageHtml } from './quotas.js';
import { retaMonthsFromBases, summarizePaidContributions } from './paidQuotas.js';
import { loadContributionBases } from './basesReport.js';
import {
  parseRegularization, parseRegularizationCards, checkResolutionPdf, resolutionYear, regularizationPaymentEvidence, isRegularizationHistoryPage, isRegularizationQueryForm, isRegularizationInfoPage, selectRegularizationRecords, regularizationToCsv, formatRegularizationCompact, regularizationYears,
} from './regularizationParser.js';

export const REG_PREFIX = 'reta-regularisation';
const REG_TIMEOUT_MS = 10 * 60 * 1000;
export const REGULARIZATION = {
  infoUrl: 'https://portal.seg-social.gob.es/wps/portal/importass/importass/Categorias/consulta+de+pagos+y+deudas/pagosdevoluciones_/regularizacionreta',
  // Targets of the info page links (live page): current-year service and previous years.
  services: {
    current: 'https://portal.seg-social.gob.es/wps/portal/importass/importass/tramites/consultaRegularizacionAutonomos',
    previous: 'https://portal.seg-social.gob.es/wps/myportal/importass/importass/tramites/regularizacionCuotasAnyosAnteriores',
  },
};
const SERVICE_URL_RE = /tramites\/(consultaRegularizacionAutonomos|regularizacionCuotasAnyosAnteriores)/i;
const SERVICE_TEXT = /regularizaci[oó]n/i;

// Never clicked (on top of the global blocklist). Spanish site labels.
export const REG_FORBIDDEN = new RegExp([
  'manten', 'optar', 'opci[oó]n', 'anular', 'renunci', 'desisti',
  'pag(o|ar|ue)', 'tarjeta', 'documento de (pago|ingreso)', 'ingres(o|ar)', 'abonar', 'cargo',
  'formular', 'consulta personalizada', 'plantea', 'pregunta', 'contacta', 'solicit', 'reclama', 'recurso', 'alegaci',
  'banc', 'cuenta', 'iban', 'domicilia',
  'apoderad', 'poderdante', 'representa',
  'confirm', 'aceptar', 'firm', 'enviar', 'guardar', 'grabar', 'modific', 'cambi', 'baja', 'alta\\b',
  'notifica', 'deh[uú]', 'notess', 'buz[oó]n',
  'salir', 'cerrar sesi', 'desconect',
].join('|'), 'i');
// Navigations that are always blocked (electronic notifications: opening one is a legal act).
export const BLOCKED_NAVIGATION = /dehu\.redsara|\bdeh(?:u|ú|%c3%ba)(?![a-z])|notess|notificacion(es)?(telematicas|electronicas)?(\/|\.|%2f|$)|\/notificaciones|sede\.seg-social\.gob\.es\/[^?]*notifica/i;
export const isBlockedNavigation = (url) => BLOCKED_NAVIGATION.test(String(url || ''));


/**
 * Explicit allowlist (pure): the only button clicked on the "años anteriores" page is the resolution
 * download of a requested year: <button name="accion" value="DESCARGAR">Resolución 2024</button>.
 * It downloads the PDF (fetch + blob) and changes nothing. Everything else stays under REG_FORBIDDEN.
 */
export function isAllowedResolutionButton({ tag, name, value, text, disabled = false } = {}, year) {
  return String(tag || '').toLowerCase() === 'button' && !disabled
    && (name == null || name === '' || name === 'accion') && value === 'DESCARGAR'
    && new RegExp(`^\\s*resoluci[oó]n\\s+${Number(year)}\\s*$`, 'i').test(String(text || ''));
}

// Login helper for the shared autoStep (only its identification branch applies here).
const LOGIN_REPORT = {
  name: 'RETA annual regularisation', infoPageUrlRe: /(?!)/, isServiceUrl: () => false,
  isServiceUrlForLogin: (url) => SERVICE_URL_RE.test(url), consultLabel: /(?!)/, downloadLabel: /(?!)/, supportsRanges: false,
};

/** Plan without a browser: years (explicit or RETA years from the saved bases report) and the services. */
export async function regularizationPlan({ years, now = new Date() } = {}) {
  let retaMonths = [];
  if (!years || !years.length) {
    const bases = await loadContributionBases();
    if (bases) retaMonths = retaMonthsFromBases(bases.full, { now }).months.map((m) => m.label || m);
  }
  const r = regularizationYears({ years, retaMonths, now });
  return {
    ...r, services: REGULARIZATION.services, infoUrl: REGULARIZATION.infoUrl,
    notes: [
      'Year Y is regularised during Y+1 / early Y+2 (e.g. 2024: resolutions January–March 2026).',
      'Months under the flat rate (first 12 months) or with a benefit are not regularised.',
      'The service shows a result only after the notification was read or 10 days after it was issued; this tool never opens notifications.',
    ],
  };
}

async function saveSnapshot(page, label) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `${REG_PREFIX}-${today()}-${label}-page`);
  const text = await pageText(page);
  await fs.writeFile(`${base}.txt`, `URL: ${page.url()}\n\n${text}\n`, 'utf8');
  await fs.writeFile(`${base}.html`, await pageHtml(page), 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  return { txtPath: `${base}.txt`, text };
}

async function uniqueBase(label) {
  const names = new Set(await fs.readdir(OUTPUT_DIR).catch(() => []));
  let n = 1; let l = label;
  while (names.has(`${REG_PREFIX}-${today()}-${l}.pdf`)) { n += 1; l = `${label}-${n}`; }
  return path.join(OUTPUT_DIR, `${REG_PREFIX}-${today()}-${l}`);
}

async function pdfText(buf) {
  try { return await extractText(buf); } catch (e) { return `(Could not extract text: ${e.message})`; }
}

async function savePdf(buf, label, text = null) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  if (text === null) text = await pdfText(buf);
  const base = await uniqueBase(label);
  await fs.writeFile(`${base}.pdf`, buf);
  await fs.writeFile(`${base}.txt`, text, 'utf8');
  log(`saved resolution PDF ${path.basename(base)}.pdf`);
  return { pdfPath: `${base}.pdf`, txtPath: `${base}.txt`, text };
}

async function installNavigationGuard(context) {
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && isBlockedNavigation(req.url())) {
      log(`BLOCKED navigation to a notification service (never opened by this tool): ${req.url().slice(0, 100)}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}


// Blob PDFs: the download button fetches the PDF and clicks an <a download href="blob:…">. Downloads and PDF
// responses are captured by attachPdfCapture; as a fallback the blob URLs created in the page are recorded
// (init script) and read back, and a tab that opens on a blob:/data: PDF is read too.
const BLOB_HOOK = () => {
  if (window.__vlPdfBlobs) return;
  window.__vlPdfBlobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (o) => {
    const u = orig(o);
    try { if (o instanceof Blob && (!o.type || /pdf|octet/i.test(o.type))) window.__vlPdfBlobs.push(u); } catch { /* ignore */ }
    return u;
  };
};
async function readBlobPdfs(page, urls = null) {
  const list = await page.evaluate(async (given) => {
    const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    const us = given || (window.__vlPdfBlobs ? window.__vlPdfBlobs.splice(0) : []);
    const out = [];
    for (const u of us) { try { out.push(toB64(await (await fetch(u)).arrayBuffer())); } catch { /* revoked */ } }
    return out;
  }, urls).catch(() => []);
  return list.map((b) => Buffer.from(b, 'base64')).filter((b) => b.subarray(0, 5).toString() === '%PDF-');
}

/**
 * Resolution PDF store: every captured PDF goes through checkResolutionPdf, so a stale capture (the same bytes
 * as another year's PDF, or a PDF whose title names another year) is never saved under the requested year.
 * deps: { extract(buf) → text, save(buf, label, text) → file, log }. Exported for tests.
 */
export function createResolutionStore({ extract, save, log: say = () => {}, years = [] }) {
  const savedHashes = new Map(); const saved = new Map(); const rejected = []; const all = [];
  const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  return {
    saved, rejected, all,
    /** A PDF captured right after clicking "Resolución <year>". Returns the saved file or null. */
    async accept(buf, year) {
      const hash = hashOf(buf); const text = await extract(buf);
      const c = checkResolutionPdf({ hash, text, year, savedHashes });
      if (!c.ok) {
        rejected.push({ year, reason: c.reason });
        say(`PDF rejected for ${year}: ${c.reason}`);
        // A late download of another requested year that is still missing is kept for that year.
        if (c.year && c.year !== year && years.includes(c.year) && !saved.has(c.year) && !savedHashes.has(hash)) return this.store(buf, c.year, text, hash, true);
        return null;
      }
      if (!c.verified && saved.has(year)) { rejected.push({ year, reason: 'unverified PDF after the verified one' }); say(`PDF ignored for ${year}: year not in the text and ${year} is already saved`); return null; }
      if (!c.verified) say(`PDF for ${year}: ${c.reason}`);
      return this.store(buf, year, text, hash, c.verified);
    },
    /** A PDF captured outside a click (late download, manual mode): saved under the year in its text. */
    async acceptAny(buf) {
      const hash = hashOf(buf); if (savedHashes.has(hash)) return null;
      const text = await extract(buf); const y = resolutionYear(text);
      if (y && saved.has(y)) { say(`PDF of ${y} ignored: a different ${y} resolution is already saved`); return null; }
      return this.store(buf, y, text, hash, Boolean(y));
    },
    async store(buf, year, text, hash, verified) {
      const label = year && verified ? String(year) : year ? `unverified-${year}` : 'manual';
      const f = { ...(await save(buf, label, text)), year, verified };
      savedHashes.set(hash, year); if (year && verified) saved.set(year, f);
      all.push(f);
      return f;
    },
  };
}

/** URL of the download fetch from the button's onclick="descargaDoc(this,"…anio!<year>…accion!DESCARGAR…")" (pure). */
export function resolutionUrlFromOnclick(onclick, year) {
  const m = /descargaDoc\(\s*this\s*,\s*(?:&quot;|["'])([^"'&]*(?:&(?!quot;)[^"'&]*)*)(?:&quot;|["'])\s*\)/.exec(String(onclick || ''));
  if (!m) return null;
  const u = m[1];
  return /accion!DESCARGAR/.test(u) && new RegExp(`anio!${Number(year)}(?!\\d)`).test(u) ? u : null;
}

/** Fetches the resolution with the same GET request descargaDoc makes (session cookies; read-only). */
async function fetchResolutionDirect(page, onclick, year) {
  const rel = resolutionUrlFromOnclick(onclick, year);
  if (!rel) return [];
  log(`fallback: same download request as the "Resolución ${year}" button`);
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(new URL(u, document.baseURI).href, { credentials: 'include' });
    const b = new Uint8Array(await r.arrayBuffer()); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }, rel).catch((e) => { log('  direct download failed:', e.message.split('\n')[0]); return null; });
  const buf = b64 ? Buffer.from(b64, 'base64') : null;
  return buf && buf.subarray(0, 5).toString() === '%PDF-' ? [buf] : [];
}

/**
 * Clicks the allowlisted "Resolución <year>" button and waits for a NEW PDF (download event, PDF response,
 * blob created after the click, or a new blob/data tab; after 12 s without one, the same GET request directly).
 * Every candidate goes through the store (stale/mismatch protection). Returns the saved file or null.
 */
async function downloadResolution(page, capture, store, year, timeoutMs = 45000) {
  const buttons = page.locator('button[value="DESCARGAR"]');
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = buttons.nth(i);
    const info = await el.evaluate((b) => ({ tag: b.tagName, name: b.getAttribute('name'), value: b.getAttribute('value'), text: b.innerText, disabled: b.disabled })).catch(() => null);
    if (!info || !isAllowedResolutionButton(info, year) || !(await el.isVisible().catch(() => false))) continue;
    const onclick = await el.getAttribute('onclick').catch(() => null);
    const context = page.context();
    // Reset the capture state: earlier PDFs (late downloads) are handled now, old blob URLs are dropped,
    // and the page's own download guard (loadFetch) must be idle.
    let late;
    while ((late = await capture.nextPdf(Date.now()))) await store.acceptAny(late);
    await page.evaluate(() => { if (window.__vlPdfBlobs) window.__vlPdfBlobs.length = 0; }).catch(() => {});
    await page.waitForFunction(() => !window.loadFetch, null, { timeout: 30000 }).catch(() => {});
    const before = new Set(context.pages());
    log(`automatic click (allowlisted download): "Resolución ${year}"`);
    const clickedAt = Date.now();
    await el.click({ timeout: 8000 }).catch((e) => log('  click failed:', e.message.split('\n')[0]));
    const deadline = clickedAt + timeoutMs;
    let direct = false;
    const tryAll = async (bufs) => { for (const b of bufs) { const f = await store.accept(b, year); if (f && f.year === year) return f; } return null; };
    while (Date.now() < deadline && !capture.isClosed()) {
      const buf = await capture.nextPdf(Date.now() + 1500); // download event or PDF response
      let f = buf ? await tryAll([buf]) : null;
      if (!f) f = await tryAll(await readBlobPdfs(page)); // blobs created after the click only
      if (!f) {
        for (const p of context.pages()) {
          if (before.has(p) || p.isClosed() || !/^(blob|data):/i.test(p.url())) continue;
          f = await tryAll(await readBlobPdfs(p, [p.url()]));
          await p.close().catch(() => {});
          if (f) break;
        }
      }
      if (f) return f;
      if (await page.locator('#modal-error-descarga:not([hidden])').isVisible().catch(() => false)) { log(`download error shown by the site for ${year}`); return null; }
      if (!direct && Date.now() - clickedAt > 12000) { direct = true; const d = await tryAll(await fetchResolutionDirect(page, onclick, year)); if (d) return d; }
    }
    return null;
  }
  log(`no "Resolución ${year}" download button (resolution not available?)`);
  return null;
}

/**
 * Fetches the regularisation result(s). options: years, timeoutMs, auto (automatic clicks; false = manual:
 * the user navigates, every page and PDF is saved), keepOpen, context (shared session).
 */
export async function fetchRetaRegularization({ years, timeoutMs = REG_TIMEOUT_MS, auto = true, keepOpen = false, context: sharedContext = null } = {}) {
  const plan = await regularizationPlan({ years }); // validates before Chrome is opened
  if (auto && !plan.years.length) return { ok: false, files: [], plan, message: `No year to check (${plan.source}). Use --years or --manual.` };
  const context = sharedContext || (await launchChrome());
  const files = []; const results = {}; const seen = new Set(); let snapN = 0;
  try {
    await installNavigationGuard(context);
    await context.addInitScript(() => { window.print = () => {}; });
    const capture = attachPdfCapture(context);
    const deadline = Date.now() + timeoutMs;
    const store = createResolutionStore({ extract: pdfText, save: savePdf, log, years: plan.years });
    const drainPdfs = async () => {
      let buf;
      while ((buf = await capture.nextPdf(Date.now()))) { const f = await store.acceptAny(buf); if (f) files.push(f); }
    };
    // Saves every new regularisation page (dedupe by content).
    const snapshotNew = async (labelHint = null) => {
      for (const p of context.pages()) {
        if (p.isClosed() || !/seg-social/i.test(p.url())) continue;
        const text = await pageText(p).catch(() => '');
        if (!SERVICE_TEXT.test(text)) continue;
        const h = crypto.createHash('sha256').update(text).digest('hex');
        if (seen.has(h)) continue;
        seen.add(h); snapN += 1;
        const y = parseRegularization(text).year;
        files.push(await saveSnapshot(p, `${labelHint || (y ? String(y) : 'page')}-${snapN}`));
      }
    };
    await context.addInitScript(BLOB_HOOK);
    const page = context.pages()[0] || (await context.newPage());
    // Automatic mode goes straight to "años anteriores" (the current-year service is a query form).
    const first = auto ? REGULARIZATION.services.previous : REGULARIZATION.infoUrl;
    log(`RETA regularisation: ${auto ? `years ${plan.years.join(', ')} (${plan.source})` : 'manual mode'}. Opening`, first);
    await page.goto(first, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message.split('\n')[0]));
    log(CERT_HINT);
    log('Notifications (NOTESS/DEHú) are blocked in this window. Do not keep a higher base, pay or confirm anything here.');

    if (auto) {
      const attempts = new Map();
      const url = REGULARIZATION.services.previous;
      const isHistory = async (x) => SERVICE_URL_RE.test(x.url()) && /regularizacionCuotasAnyosAnteriores/i.test(x.url()) && isRegularizationHistoryPage(await pageText(x).catch(() => ''));
      // Log in until the "años anteriores" page appears (shared identification step).
      const stepDeadline = Math.min(deadline, Date.now() + 4 * 60 * 1000);
      let sp = null;
      while (!capture.isClosed() && Date.now() < stepDeadline) {
        for (const x of context.pages()) if (!x.isClosed() && (await isHistory(x))) { sp = x; break; }
        if (sp) break;
        for (const x of context.pages()) {
          if (x.isClosed()) continue;
          const text = await pageText(x).catch(() => '');
          if (isRegularizationQueryForm(text)) { // never filled: go to the previous-years page instead
            log('current-year query form detected (never filled or submitted); opening "años anteriores"');
            await x.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
            continue;
          }
          if (/seg-social/i.test(x.url()) && /\/myportal\//.test(x.url()) && !SERVICE_URL_RE.test(x.url()) && attempts.get('reopen') !== true) {
            attempts.set('reopen', true); // logged in but landed elsewhere (personal area): open the service once
            await x.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
            continue;
          }
          await autoStep(x, attempts, LOGIN_REPORT, { ranges: [null], part: 0, rangeApplied: true }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!sp) { results.previous = 'service page not reached'; await snapshotNew('previous-unreached'); }
      else {
        await settle(sp);
        await snapshotNew('previous');
        const cards = parseRegularizationCards(await pageText(sp));
        results.cards = cards.map((c) => `${c.year} ${c.status}${c.amount ? ` ${c.amount}` : ''}${c.available ? '' : ' (no PDF)'}`).join(', ') || 'none';
        let clicks = 0;
        for (const year of plan.years) {
          if (capture.isClosed() || Date.now() >= deadline) break;
          const card = cards.find((c) => c.year === year);
          if (!card) { results[year] = 'not listed on the page'; continue; }
          if (!card.available) { results[year] = `${card.status} (resolution not available)`; continue; }
          if (store.saved.has(year)) { results[year] = `${card.status}; resolution PDF ${path.basename(store.saved.get(year).pdfPath)} (late download)`; continue; }
          if (clicks++) { // fresh page state before every further click
            await new Promise((r) => setTimeout(r, 2000));
            await sp.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await settle(sp);
            if (!(await isHistory(sp))) { await sp.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await settle(sp); }
          }
          const f = await downloadResolution(sp, capture, store, year);
          if (f) { files.push(f); results[year] = `${card.status}; resolution PDF ${path.basename(f.pdfPath)}${f.verified ? '' : ' (year not verified)'}`; }
          else { results[year] = `${card.status}; resolution PDF not captured${store.rejected.some((r) => r.year === year) ? ` (rejected: ${store.rejected.filter((r) => r.year === year).map((r) => r.reason).join('; ')})` : ''}`; await snapshotNew(`${year}-download`); }
        }
      }
      // Grace period: a download still in flight is checked (by the year in its text) before Chrome closes.
      const graceEnd = Date.now() + 5000; let late;
      while (!capture.isClosed() && (late = await capture.nextPdf(graceEnd))) { const f = await store.acceptAny(late); if (f) files.push(f); }
    }

    if ((!auto || keepOpen) && !capture.isClosed()) {
      log('Snapshot mode: navigate the regularisation service yourself (current year and "años anteriores"); every page with "regularización" and every PDF is saved. Close the window when done.');
      while (!capture.isClosed() && Date.now() < deadline) {
        await snapshotNew();
        await drainPdfs();
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    await drainPdfs().catch(() => {});
    capture.stop();
    for (const f of store.all) if (!files.includes(f)) files.push(f);
  } finally {
    if (!sharedContext) await context.close().catch(() => {});
  }
  const sum = await summarizeRegularization();
  const msg = `${files.length} file(s) saved in ${OUTPUT_DIR_LABEL}; ${sum.records.length} year(s) with a result: ${sum.records.map((r) => `${r.year} ${r.status}`).join(', ') || 'none'}`
    + (Object.keys(results).length ? `. Steps: ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}` : '');
  return { ok: files.length > 0, files: files.map((f) => f.pdfPath || f.txtPath), results, plan, message: msg };
}

// --- Saved results (no browser) ----------------------------------------------------------------

const FILE_RE = new RegExp(`^${REG_PREFIX}-(\\d{4}-\\d{2}-\\d{2})-(.+?)(-page)?\\.txt$`);

/** Pure: saved file names → [{ file, day, label, kind: 'pdf'|'page' }]. */
export function classifyRegularizationFiles(names) {
  return names.map((f) => ({ f, m: FILE_RE.exec(f) })).filter((x) => x.m)
    .map(({ f, m }) => ({ file: f, day: m[1], label: m[2], kind: m[3] ? 'page' : 'pdf' }));
}

/** Re-parses every saved page/PDF text → reta-regularisation.summary.csv/.json. */
export async function summarizeRegularization() {
  const names = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const list = classifyRegularizationFiles(names);
  const parsed = [];
  const skipped = [];
  for (const f of list) {
    const text = await fs.readFile(path.join(OUTPUT_DIR, f.file), 'utf8').catch(() => '');
    // Not data sources: the current-year query form and the public information page.
    if (f.kind === 'page' && (isRegularizationQueryForm(text) || isRegularizationInfoPage(text))) { skipped.push(f.file); continue; }
    if (f.kind === 'page' && isRegularizationHistoryPage(text)) {
      const cards = parseRegularizationCards(text);
      for (const c of cards) parsed.push({ ...c, day: f.day, kind: 'card', source: f.file });
      if (cards.length) continue;
    }
    const hint = /^((?:19|20)\d{2})\b/.exec(f.label);
    const r = parseRegularization(text, { year: hint ? Number(hint[1]) : null });
    // PDFs are named by the year that was clicked; the year in the resolution title wins if it differs.
    if (f.kind === 'pdf' && hint) r.year = resolutionYear(text) ?? Number(hint[1]);
    parsed.push({ ...r, day: f.day, kind: f.kind, source: f.file });
  }
  let paidRecords = [];
  try { paidRecords = (await summarizePaidContributions({ withRaw: false })).records || []; } catch { /* no paid report saved */ }
  // Payment status from evidence (paid contributions report), never from words in the resolution.
  const records = selectRegularizationRecords(parsed).map((r) => {
    const ev = regularizationPaymentEvidence(r, paidRecords);
    return { ...r, source: r.sources[0], paymentStatus: ev.paymentStatus ?? r.paymentStatus ?? null, paymentEvidence: ev.paymentEvidence, includedInPaid: ev.includedInPaid };
  });
  const csvPath = path.join(OUTPUT_DIR, `${REG_PREFIX}.summary.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${REG_PREFIX}.summary.json`);
  if (list.length) {
    await fs.writeFile(csvPath, regularizationToCsv(records), 'utf8');
    await fs.writeFile(jsonPath, JSON.stringify({ currency: 'EUR', records, unrecognised: [...new Set(parsed.filter((p) => p.status === 'unknown').map((p) => p.source))], skipped }, null, 1), 'utf8');
  }
  return { records, files: list.length, unrecognised: [...new Set(parsed.filter((p) => p.status === 'unknown').map((p) => p.source))], skipped, csvPath, jsonPath };
}

/** Compact view (no browser); detail 'full' adds `rawFiles` (local raw file names; raw text stays local). */
export async function regularizationView({ years, detail = 'summary' } = {}) {
  const sum = await summarizeRegularization();
  const ys = new Set((Array.isArray(years) ? years : years ? [years] : []).flatMap((v) => String(v).split(/[,;\s]+/)).filter(Boolean).map(Number));
  const recs = ys.size ? sum.records.filter((r) => ys.has(r.year)) : sum.records;
  let plan = null;
  try { plan = await regularizationPlan({}); } catch { /* no bases report */ }
  const head = `files=${sum.files}${sum.files ? ` csv=${fileName(sum.csvPath)}` : ''}${sum.unrecognised.length ? ` unrecognised: ${sum.unrecognised.join(', ')}` : ''}${sum.skipped.length ? ` skipped (form/info pages): ${sum.skipped.length}` : ''}`;
  if (!sum.files) return `${head}\nNo regularisation page saved yet. Use fetch-regularization --manual / get_reta_regularization.${plan && plan.years.length ? `\nYears to check: ${plan.years.join(', ')}` : ''}`;
  const body = formatRegularizationCompact(recs, plan);
  if (detail !== 'full') return `${head}\n${body}`;
  const raw = await rawFilesFor([...new Set(recs.flatMap((r) => r.sources || []))]);
  return `${head}\n${body}\n${rawFilesBlock(raw)}`;
}
