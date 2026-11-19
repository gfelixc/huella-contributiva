// SEPE (Servicio Público de Empleo Estatal) benefit certificates ("Obtén un certificado de tu
// prestación" → "Obtención de certificados"), with the user's digital certificate.
// READ-ONLY use of the service: it only opens the certificate types, selects a year or a period,
// chooses "Desea descargarlo desde internet" and presses "Mostrar" / "Obtener" to download the PDF.
// It never uses the postal option ("recibirlo por correo al domicilio"), never presses
// "Confirmar", and never touches requests, changes, de-registration, appointments, address,
// bank account or job-seeker renewal.
//
// IMPORTANT: every text regex used to find buttons, links and fields below is a
// Spanish label shown on the website and must stay in Spanish to match it.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OUTPUT_DIR, CERT_HINT, launchChrome, attachPdfCapture, clickByText, extractText, log, today, pad,
} from './importass.js';
import { fileName, rawFilesFor, rawFilesBlock, OUTPUT_DIR_LABEL } from './paths.js';
import { loadWorkHistory } from './workHistoryPage.js';
import { loadContributionBases } from './basesReport.js';
import { settle, pageText, pageHtml, fillField } from './quotas.js';
import { collectRanges, parseMonthList } from './quotas.js';
import { parseSepeCertificate, parseBenefitPeriods, selectSepeRecords, sepeToCsv, formatSepeCompact } from './sepeParser.js';

export const SEPE_PREFIX = 'sepe';
const SEPE_TIMEOUT_MS = 10 * 60 * 1000;
export const SEPE = {
  // Official procedure page and the "Obtención de certificados" button target (live pages).
  infoUrl: 'https://sede.sepe.gob.es/portalSede/procedimientos-y-servicios/personas/proteccion-por-desempleo/obtencion-de-certificados.html',
  entryUrl: 'https://sede.sepe.gob.es/DServiciosPrestanetWEB/CertificadosPrestaWeb.do',
  // "Certificado digital, DNI electrónico o usuario Cl@ve" → SEPE login → Cl@ve → back here (types list).
  typesUrl: 'https://sede.sepe.gob.es/DServiciosPrestanetWEB/TipoAutenticadoAction.do',
};

// Site labels (Spanish).
const ACCESS_LINK = /^\s*certificado digital, dni electr[oó]nico o usuario cl@ve\s*$/i; // entry page
const SEPE_LOGIN_CERT = /^\s*certificado digital o dni electr[oó]nico\s*$/i;           // SEPE login page
const CLAVE_CERT = /dnie\s*\/?\s*certificado|certificado electr[oó]nico|certificado digital/i; // Cl@ve gateway
const LOGIN_FORBIDDEN = /m[oó]vil|\bpin\b|sms|permanente|europe|eidas|registr/i;
const TYPE_ANNUAL = /^\s*de importes anuales\s*$/i;
const TYPE_PERIOD = /^\s*de importes por per[ií]odo\s*$/i;
const ACCEPT = /^\s*aceptar\s*$/i;     // only on the year / period selection screen
const SHOW = /^\s*mostrar\s*$/i;       // only after "descargarlo desde internet" is selected
const OBTAIN = /^\s*obtener\s*$/i;     // downloads the certificate PDF
const INTERNET_OPTION = /descargarlo desde internet/i;
const POSTAL_OPTION = /correo al domicilio/i;
// Never clicked anywhere in the SEPE flow (on top of the global blocklist).
export const SEPE_FORBIDDEN = /correo|domicilio|confirmar|solicitud(es)? de prestaci|presolicitud|modific|baja|cita|cuenta|banc|renovar|renovaci|demanda|desist|enviar|registro|firmar|salir|volver|cerrar sesi|desconect|pin tel/i;
// Cookie banner of the SEPE e-office: a full-page veil (".cookies-veil.js-cookies-banner.is-visible") that
// intercepts every click until it is answered. "Rechazar todas" only declines optional cookies.
const COOKIE_REJECT = /^\s*rechazar todas\s*$/i;
const COOKIE_VEIL = '.cookies-veil, .js-cookies-banner'; // shown while body has .has-cookie-banner (fixed, z-index 5000)
const ACCESS_PATH = /^\/DServiciosPrestanetWEB\/TipoAutenticadoAction\.do$/i;
const SELECT_TEXT = /certificado de importes anuales percibidos|certificado de importe percibido por per[ií]odo|ejercicio|desde/i;
const ONE_PER_DAY_TEXT = /no se permite solicitar en el mismo d[ií]a/i;

// --- Selection (pure) -------------------------------------------------------------------

/**
 * Pure: years for the annual certificates and the optional period certificate.
 * years: explicit list; ranges/from/to/months: their years; default: the years of the unemployment
 * benefit periods in the work history report (vida laboral), else 2020. allYears: every year from
 * the first year in the bases report to last year.
 * period: 'MM/YYYY-MM/YYYY' (max 12 months, one per day on the site) or 'auto' (first benefit period).
 */
export function resolveSepeRequest({ years, from, to, ranges, months, allYears = false, period, benefitPeriods = null, workHistoryText = null, bases = null, basesText = null, now = new Date() } = {}) {
  const set = new Set();
  for (const y of (Array.isArray(years) ? years : years ? [years] : []).flatMap((v) => String(v).split(/[,;\s]+/)).filter(Boolean)) {
    if (!/^(19|20)\d{2}$/.test(y)) throw new Error(`Invalid year "${y}"`);
    set.add(Number(y));
  }
  const lastYear = now.getFullYear();
  for (const g of collectRanges({ from, to, ranges })) {
    const a = Number((g.from || '2002-01').slice(0, 4)); const b = Number((g.to || `${lastYear}-12`).slice(0, 4));
    for (let y = a; y <= b; y++) set.add(y);
  }
  for (const m of parseMonthList(months)) set.add(m.year);
  // benefitPeriods: from the work history JSON (preferred); workHistoryText: old PDF text fallback.
  const benefit = Array.isArray(benefitPeriods) ? benefitPeriods : workHistoryText ? parseBenefitPeriods(workHistoryText, { now }) : [];
  let source = 'explicit';
  if (!set.size && allYears) {
    // First year of the bases report: from the full bases JSON (preferred) or its text.
    const first = bases && Array.isArray(bases.sections) ? Math.min(...bases.sections.flatMap((s) => (s.months || []).map((m) => m.year).concat(Object.keys(s.years || {}).map(Number))))
      : basesText ? Math.min(...[...String(basesText).matchAll(/^\s*((?:19|20)\d{2})\s/gm)].map((m) => Number(m[1]))) : 2020;
    for (let y = Number.isFinite(first) ? first : 2020; y <= lastYear; y++) set.add(y);
    source = 'all years';
  }
  if (!set.size) {
    for (const p of benefit) for (const m of p.months) set.add(Number(m.slice(0, 4)));
    source = set.size ? 'benefit periods in the work history report' : 'default year 2020';
    if (!set.size) set.add(2020);
  }
  let periodReq = null;
  if (period) {
    if (period === 'auto') {
      const p = benefit[0];
      if (!p) throw new Error('period "auto" needs an unemployment benefit period in the saved work history report');
      periodReq = { from: p.months[0], to: p.months[Math.min(p.months.length, 12) - 1] };
    } else {
      const m = /^(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{4})$/.exec(String(period).trim()) || /^(\d{4})-(\d{1,2})\s*(?:-|\.\.)\s*(\d{4})-(\d{1,2})$/.exec(String(period).trim());
      if (!m) throw new Error(`Invalid period "${period}" (use MM/YYYY-MM/YYYY)`);
      const [fy, fm, ty, tm] = /^\d{4}$/.test(m[1]) ? [m[1], m[2], m[3], m[4]] : [m[2], m[1], m[4], m[3]];
      if (Number(fm) < 1 || Number(fm) > 12 || Number(tm) < 1 || Number(tm) > 12) throw new Error(`Invalid month in period "${period}"`);
      periodReq = { from: `${fy}-${pad(Number(fm))}`, to: `${ty}-${pad(Number(tm))}` };
    }
    const span = (Number(periodReq.to.slice(0, 4)) * 12 + Number(periodReq.to.slice(5))) - (Number(periodReq.from.slice(0, 4)) * 12 + Number(periodReq.from.slice(5))) + 1;
    if (span < 1) throw new Error('period start is after its end');
    if (span > 12) throw new Error('the SEPE period certificate covers at most 12 months');
  }
  const out = [...set].filter((y) => y <= lastYear).sort();
  if (!out.length) throw new Error('No year to request (future years only).');
  return { years: out, period: periodReq, source, benefitPeriods: benefit };
}

// --- Entry page (pure helpers) --------------------------------------------------------------

const decodeEntities = (t) => t.replace(/&nbsp;/g, ' ').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
  .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&amp;/g, '&');

/** Absolute URL of the certificate/Cl@ve access link, only if it is the expected SEPE e-office path. */
export function accessHref(href, baseUrl = SEPE.entryUrl) {
  try {
    const u = new URL(String(href || ''), baseUrl);
    return u.protocol === 'https:' && u.hostname === 'sede.sepe.gob.es' && ACCESS_PATH.test(u.pathname) ? u.href : null;
  } catch { return null; }
}

/** Finds the access link in the entry page HTML: { href, text, count } (null if absent). */
export function findAccessLink(html, baseUrl = SEPE.entryUrl) {
  const found = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const href = accessHref(m[1], baseUrl);
    if (href && ACCESS_LINK.test(text) && !LOGIN_FORBIDDEN.test(text)) found.push({ href, text });
  }
  return found.length ? { ...found[0], count: found.length } : null;
}

/** True when the HTML still shows the blocking cookie banner. */
export function hasCookieBanner(html) {
  return /class=["'][^"']*\bcookies-veil\b[^"']*\bis-visible\b/i.test(String(html || ''));
}

// --- Page helpers --------------------------------------------------------------------------

/** Answers the cookie banner with "Rechazar todas"; if that fails, hides the veil locally so it stops blocking clicks. */
async function dismissCookieBanner(page) {
  for (const frame of page.frames()) {
    const veil = frame.locator(COOKIE_VEIL);
    if (!(await veil.first().isVisible().catch(() => false))) continue;
    const btn = frame.locator('button.js-cookies-reject').first();
    const txt = ((await btn.textContent().catch(() => '')) || '').trim();
    if (COOKIE_REJECT.test(txt)) {
      log('cookie banner: "Rechazar todas"');
      await btn.click({ timeout: 3000 }).catch((e) => log('  cookie banner click failed:', e.message.split('\n')[0]));
      await page.waitForTimeout(500).catch(() => {});
    }
    if (await veil.first().isVisible().catch(() => false)) {
      log('cookie banner still visible: hiding it in this page only');
      await frame.evaluate(() => {
        document.querySelectorAll('.cookies-veil, .js-cookies-banner, .modal-backdrop').forEach((e) => { e.style.display = 'none'; });
        document.body.classList.remove('modal-open');
      }).catch(() => {});
    }
  }
}

/** Entry page step: click the access link (after the cookie banner); fall back to opening its href directly. */
async function openAccess(page) {
  await dismissCookieBanner(page);
  const links = page.locator('a[href*="TipoAutenticadoAction.do"]');
  const n = await links.count().catch(() => 0);
  let target = null;
  for (let i = 0; i < n; i++) {
    const el = links.nth(i);
    const text = ((await el.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const href = accessHref(await el.getAttribute('href').catch(() => null), page.url());
    if (!href || !ACCESS_LINK.test(text) || LOGIN_FORBIDDEN.test(text)) continue;
    target = href;
    if (!(await el.isVisible().catch(() => false))) continue;
    log(`automatic click (access): "${text}"`);
    try { await el.click({ timeout: 4000 }); return true; } catch (e) { log('  click failed:', e.message.split('\n')[0]); }
    break;
  }
  if (!target) { const f = findAccessLink(await pageHtml(page).catch(() => ''), page.url()); target = f ? f.href : null; }
  target = target || SEPE.typesUrl;
  log('opening the access link directly:', target);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto:', e.message.split('\n')[0]));
  return true;
}

async function saveSnapshot(page, label) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `${SEPE_PREFIX}-${today()}-${label}-page`);
  const text = await pageText(page);
  await fs.writeFile(`${base}.txt`, `URL: ${page.url()}\n\n${text}\n`, 'utf8');
  await fs.writeFile(`${base}.html`, await pageHtml(page), 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  return { txtPath: `${base}.txt`, text };
}

async function savePdf(buf, label) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `${SEPE_PREFIX}-${today()}-${label}`);
  await fs.writeFile(`${base}.pdf`, buf);
  let text = '';
  try { text = await extractText(buf); } catch (e) { text = `(Could not extract text: ${e.message})`; }
  await fs.writeFile(`${base}.txt`, text, 'utf8');
  return { pdfPath: `${base}.pdf`, txtPath: `${base}.txt`, text };
}

const click = async (page, re, label, roles = ['link', 'button']) => {
  await dismissCookieBanner(page);
  return clickByText(page, re, { roles, label, forbidden: SEPE_FORBIDDEN });
};

async function visibleSelects(page) {
  for (const frame of page.frames()) {
    const loc = frame.locator('select');
    const n = await loc.count().catch(() => 0);
    const vis = [];
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) vis.push(loc.nth(i));
    if (vis.length) return vis;
  }
  return [];
}

async function onTypesPage(page) {
  for (const frame of page.frames()) {
    if (await frame.getByRole('link', { name: TYPE_ANNUAL }).count().catch(() => 0)) return true;
    if (await frame.getByText(TYPE_ANNUAL).count().catch(() => 0)) return true;
  }
  return false;
}

async function openType(page, re, label) {
  if (await click(page, re, label)) return true; // also clears the cookie banner
  // The type boxes may be plain clickable elements.
  for (const frame of page.frames()) {
    const el = frame.getByText(re).first();
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 5000 }).catch(() => {}); return true; }
  }
  return false;
}

/**
 * After the year/period screen: select "Desea descargarlo desde internet", press "Mostrar", then
 * "Obtener" and wait for the PDF. Never continues on the postal path. Returns { buf, message }.
 */
async function downloadFromRequestScreen(page, capture, label) {
  await settle(page);
  const text = await pageText(page);
  if (ONE_PER_DAY_TEXT.test(text) && !/datos de solicitud/i.test(text)) return { message: 'the site allows only one certificate of this type per day' };
  const internet = page.getByLabel(INTERNET_OPTION).first();
  if (await internet.count().catch(() => 0)) await internet.check({ timeout: 3000 }).catch(() => {});
  const postal = page.getByLabel(POSTAL_OPTION).first();
  if (await postal.count().catch(() => 0)) {
    if (await postal.isChecked().catch(() => true)) return { message: 'could not select "descargarlo desde internet" (postal option still selected); stopped' };
    if (!(await internet.isChecked().catch(() => false))) return { message: '"descargarlo desde internet" is not selected; stopped' };
  }
  if (!(await click(page, SHOW, `show ${label}`, ['button', 'link']))) return { message: '"Mostrar" not found' };
  await settle(page);
  const after = await pageText(page);
  if (/datos de env[ií]o|confirmaci[oó]n/i.test(after) && !/obtenci[oó]n del certificado/i.test(after)) return { message: 'the postal-delivery screen appeared; stopped without confirming' };
  if (!(await click(page, OBTAIN, `obtain ${label}`, ['button', 'link']))) return { message: '"Obtener" not found' };
  const buf = await capture.nextPdf(Date.now() + 30000);
  return buf ? { buf } : { message: 'no PDF received after "Obtener"' };
}

// --- Flow ------------------------------------------------------------------------------------

/**
 * Opens the SEPE certificates service, logs in with the user's certificate (Cl@ve gateway →
 * "DNIe / Certificado electrónico"; the user picks the certificate) and downloads one
 * "Certificado de importes anuales" per year (the site allows one per year per day) plus,
 * optionally, one "Certificado de importes por periodo" (one per day; max 12 months), all in ONE
 * browser session. options: years, from/to/ranges/months (→ years), allYears, period, timeoutMs,
 * auto, keepOpen, context (shared browser session).
 */
export async function fetchSepeBenefits({ timeoutMs = SEPE_TIMEOUT_MS, auto = true, keepOpen = false, context: sharedContext = null, ...sel } = {}) {
  // Validate before Chrome is opened.
  const wh = await loadWorkHistory();
  const bases = sel.allYears ? await loadContributionBases() : null;
  const plan = resolveSepeRequest({ ...sel, benefitPeriods: wh ? wh.benefitPeriods : [], bases: bases ? bases.full : null });
  if (plan.period) {
    const names = await fs.readdir(OUTPUT_DIR).catch(() => []);
    if (names.some((f) => f.startsWith(`${SEPE_PREFIX}-${today()}-period-`) && f.endsWith('.pdf'))) {
      log('A period certificate was already downloaded today (the site allows one per day); skipping it.');
      plan.period = null;
    }
  }
  const context = sharedContext || (await launchChrome());
  const results = {};
  const files = [];
  try {
    await context.addInitScript(() => { window.print = () => {}; });
    const capture = attachPdfCapture(context);
    const deadline = Date.now() + timeoutMs;
    const page = context.pages()[0] || (await context.newPage());
    log(`Fetching SEPE certificates: annual ${plan.years.join(', ')}${plan.period ? `; period ${plan.period.from}..${plan.period.to}` : ''} (${plan.source}). Opening`, SEPE.entryUrl);
    await page.goto(SEPE.entryUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message));
    log(CERT_HINT);
    log('If automation gets stuck: "Certificado digital, DNI electrónico o usuario Cl@ve" → "Certificado digital o DNI electrónico" → "DNIe / Certificado electrónico".');

    // Phase 1: log in until the certificate types list appears.
    const tried = new Map();
    const once = async (key, fn) => { if ((tried.get(key) || 0) >= 2) return false; tried.set(key, (tried.get(key) || 0) + 1); return fn(); };
    let ready = false;
    while (!capture.isClosed() && Date.now() < deadline) {
      const p = context.pages().filter((x) => !x.isClosed()).at(-1) || page;
      if (await onTypesPage(p)) { ready = true; break; }
      if (auto) {
        const url = p.url();
        if (/CertificadosPrestaWeb/i.test(url)) await once(`entry|${url}`, () => openAccess(p));
        else if (/GesUsuariosSEDE|login_recurso_protegido|isweb\.sepe/i.test(url)) await once(`sepe-login|${url}`, async () => { await dismissCookieBanner(p); return clickByText(p, SEPE_LOGIN_CERT, { label: 'login', forbidden: LOGIN_FORBIDDEN }); });
        else if (/clave\.gob\.es|pasarela/i.test(url)) await once(`clave|${url}`, () => clickByText(p, CLAVE_CERT, { roles: ['button', 'link', 'radio'], label: 'Cl@ve', forbidden: LOGIN_FORBIDDEN }));
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (!ready) return { ok: false, results, files, plan, message: capture.isClosed() ? 'The Chrome window was closed before login.' : 'The certificate types page was not reached (login not completed).' };
    const sp = context.pages().filter((x) => !x.isClosed()).at(-1);
    const backToTypes = async () => { if (!(await onTypesPage(sp))) { await sp.goto(SEPE.typesUrl, { timeout: 20000 }).catch(() => {}); await settle(sp); } return onTypesPage(sp); };

    // Phase 2: one annual certificate per year.
    if (auto) {
      for (const year of plan.years) {
        if (capture.isClosed() || Date.now() >= deadline) { results[`annual-${year}`] = 'not requested (window closed or timeout)'; continue; }
        if (!(await backToTypes())) { results[`annual-${year}`] = 'types page not available'; break; }
        if (!(await openType(sp, TYPE_ANNUAL, `annual ${year}`))) { results[`annual-${year}`] = '"De importes anuales" not found'; continue; }
        await settle(sp);
        const sels = await visibleSelects(sp);
        if (!sels.length || !SELECT_TEXT.test(await pageText(sp))) { files.push(await saveSnapshot(sp, `annual-${year}`)); results[`annual-${year}`] = 'year selector not found (page saved)'; continue; }
        const options = await sels[0].locator('option').allTextContents().catch(() => []);
        if (!options.some((o) => o.trim() === String(year))) { results[`annual-${year}`] = `year not offered (available: ${options.map((o) => o.trim()).filter(Boolean).join(', ')})`; continue; }
        await fillField(sels[0], [String(year)]);
        if (!(await click(sp, ACCEPT, `year ${year}`, ['button', 'link']))) { results[`annual-${year}`] = '"Aceptar" not found'; continue; }
        const r = await downloadFromRequestScreen(sp, capture, `annual ${year}`);
        if (r.buf) { files.push(await savePdf(r.buf, `annual-${year}`)); results[`annual-${year}`] = 'ok'; } else { files.push(await saveSnapshot(sp, `annual-${year}`)); results[`annual-${year}`] = r.message; }
        log(`annual ${year}: ${results[`annual-${year}`]}`);
      }
      // Optional period certificate (desde mes/año — hasta mes/año).
      if (plan.period && !capture.isClosed() && Date.now() < deadline && (await backToTypes())) {
        const key = `period-${plan.period.from.replace('-', '')}-${plan.period.to.replace('-', '')}`;
        if (await openType(sp, TYPE_PERIOD, 'period')) {
          await settle(sp);
          const sels = await visibleSelects(sp);
          if (sels.length >= 4) {
            const [fy, fm] = plan.period.from.split('-'); const [ty, tm] = plan.period.to.split('-');
            await fillField(sels[0], [fm, String(Number(fm))]); await fillField(sels[1], [fy]);
            await fillField(sels[2], [tm, String(Number(tm))]); await fillField(sels[3], [ty]);
            if (await click(sp, ACCEPT, 'period', ['button', 'link'])) {
              const r = await downloadFromRequestScreen(sp, capture, 'period');
              if (r.buf) { files.push(await savePdf(r.buf, key)); results[key] = 'ok'; } else { files.push(await saveSnapshot(sp, key)); results[key] = r.message; }
            } else results[key] = '"Aceptar" not found';
          } else { files.push(await saveSnapshot(sp, key)); results[key] = 'period selectors not found (page saved)'; }
        } else results[key] = '"De importes por periodo" not found';
        log(`${key}: ${results[key]}`);
      }
    }
    // Manual / keep-open: save every PDF the user downloads.
    if ((!auto || keepOpen) && !capture.isClosed()) {
      log('Manual mode: download certificates yourself in the window; every PDF is saved. Close the window when done.');
      let n = 0;
      for (;;) { const buf = await capture.nextPdf(deadline); if (!buf) break; n += 1; files.push(await savePdf(buf, `manual-${n}`)); }
    }
    capture.stop();
  } finally {
    if (!sharedContext) await context.close().catch(() => {});
  }
  const pdfs = files.filter((f) => f.pdfPath);
  if (!pdfs.length) return { ok: false, results, files: files.map((f) => f.txtPath), plan, message: `No SEPE certificate PDF was downloaded. ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}` };
  const sum = await summarizeSepe();
  return {
    ok: true, results, plan, files: files.map((f) => f.pdfPath || f.txtPath),
    message: `Downloaded ${pdfs.length} SEPE certificate(s). ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}. Summary ${fileName(sum.csvPath) || '-'} in ${OUTPUT_DIR_LABEL}.`,
  };
}

// --- Saved results (no browser) ----------------------------------------------------------------

const FILE_RE = new RegExp(`^${SEPE_PREFIX}-(\\d{4}-\\d{2}-\\d{2})-((?:annual-\\d{4})|(?:period-\\d{6}-\\d{6})|(?:manual-\\d+))\\.txt$`);

/** Pure: saved certificate text files → [{ file, day, label }] (page snapshots are excluded). */
export function classifySepeFiles(names) {
  return names.map((f) => ({ f, m: FILE_RE.exec(f) })).filter((x) => x.m).map(({ f, m }) => ({ file: f, day: m[1], label: m[2] }));
}

/** Re-parses every saved certificate (latest per kind/period) → sepe-benefits.summary.csv/.json. */
export async function summarizeSepe() {
  const names = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const list = classifySepeFiles(names);
  const parsed = [];
  for (const f of list) {
    const text = await fs.readFile(path.join(OUTPUT_DIR, f.file), 'utf8').catch(() => '');
    parsed.push({ ...parseSepeCertificate(text), source: f.file, day: f.day });
  }
  const records = selectSepeRecords(parsed);
  const wh = await loadWorkHistory();
  const periods = wh ? wh.benefitPeriods : [];
  // Nothing saved yet (e.g. a first run or a dry run): no summary files are written.
  if (!list.length) return { records, periods, unparsed: [], csvPath: null, jsonPath: null, files: 0 };
  const csvPath = path.join(OUTPUT_DIR, `${SEPE_PREFIX}-benefits.summary.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${SEPE_PREFIX}-benefits.summary.json`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(csvPath, sepeToCsv(records), 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify({ currency: 'EUR', records, benefitPeriods: periods, unparsed: parsed.filter((p) => p.status === 'unparsed').map((p) => p.source) }, null, 1), 'utf8');
  return { records, periods, unparsed: parsed.filter((p) => p.status === 'unparsed').map((p) => p.source), csvPath, jsonPath, files: list.length };
}

/** Compact view; detail 'full' adds `rawFiles` (local certificate file names; raw text stays local). Filters: years (list). */
export async function sepeView({ detail = 'summary', years } = {}) {
  const sum = await summarizeSepe();
  const ys = new Set((Array.isArray(years) ? years : years ? [years] : []).flatMap((v) => String(v).split(/[,;\s]+/)).filter(Boolean).map(Number));
  const recs = ys.size ? sum.records.filter((r) => ys.has(Number(String(r.periodFrom).slice(0, 4))) || ys.has(Number(String(r.periodTo).slice(0, 4)))) : sum.records;
  const head = `csv=${fileName(sum.csvPath) || '-'} certificates=${recs.length}${sum.unparsed.length ? ` unparsed: ${sum.unparsed.join(' ')}` : ''}`;
  if (!sum.files && !sum.periods.length) return `${head}\nNo SEPE certificate saved yet. Use fetch-sepe / get_sepe_benefits_certificate.`;
  const body = formatSepeCompact(recs, sum.periods);
  if (detail !== 'full') return `${head}\n${body}`;
  const raw = await rawFilesFor([...new Set(recs.map((r) => r.source))]);
  return `${head}\n${body}\n${rawFilesBlock(raw)}`;
}
