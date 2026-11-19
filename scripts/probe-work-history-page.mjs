// Read-only probe: logs in to Import@ss with the user's certificate, opens the
// "Informe de tu vida laboral" service page and saves snapshots of what the page
// shows (text, HTML, screenshot, visible buttons/links) WITHOUT clicking any
// download button. Used to check whether the report data is visible on screen.
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPORTS, OUTPUT_DIR, launchChrome, autoStep, log, today, CERT_HINT } from '../src/importass.js';

const timeoutMs = Number(process.env.PROBE_TIMEOUT_S || 300) * 1000;
// Same report definition, but a download label that never matches: the flow stops on the service page.
const report = { ...REPORTS.workHistory, downloadLabel: /(?!)/ };

const context = await launchChrome();
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
    if (/tramites\/datosvidalaboral/i.test(p.url())) { target = p; break; }
    await autoStep(p, attempts, report, state).catch(() => {});
  }
  if (!target) await new Promise((r) => setTimeout(r, 2500));
}

if (!target) {
  log('Service page not reached before the timeout. Nothing saved.');
} else {
  await target.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await target.waitForTimeout(6000);
  // Expand every period row (read-only accordion buttons) to reveal its details.
  if (process.env.PROBE_EXPAND === '1') {
    const SKIP = /descargar|informar|filtrar|buscar|search|exit|salir/i;
    const rows = target.locator('button');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const b = rows.nth(i);
      const label = ((await b.innerText().catch(() => '')) || '').trim();
      if (!label || SKIP.test(label) || !(await b.isVisible().catch(() => false))) continue;
      log(`expanding row: "${label.replace(/\s+/g, ' ').slice(0, 60)}"`);
      await b.click({ timeout: 5000 }).catch((e) => log('  click failed:', e.message.split('\n')[0]));
      await target.waitForTimeout(1500);
    }
    await target.waitForTimeout(2000);
  }
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `work-history-probe-${today()}${process.env.PROBE_EXPAND === '1' ? '-expanded' : ''}`);
  const text = await target.locator('body').innerText().catch(() => '');
  const controls = await target.locator('button, a, input[type=submit], input[type=button], [role=button], [role=tab]')
    .evaluateAll((els) => els.filter((e) => e.offsetParent !== null)
      .map((e) => `${e.tagName.toLowerCase()} | ${(e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')} | ${e.getAttribute('href') || ''}`)
      .filter((l) => !/\|\s*\|\s*$/.test(l))).catch(() => []);
  await fs.writeFile(`${base}-page.txt`, `URL: ${target.url()}\n\n${text}`, 'utf8');
  await fs.writeFile(`${base}-page.html`, await target.content(), 'utf8');
  await fs.writeFile(`${base}-controls.txt`, controls.join('\n'), 'utf8');
  await target.screenshot({ path: `${base}-page.png`, fullPage: true }).catch(() => {});
  log(`Saved ${base}-page.txt/.html/.png and ${base}-controls.txt (no download clicked).`);
}
await context.close().catch(() => {});
