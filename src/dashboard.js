// Local HTML dashboard for the combined contributions report (combined-report-*.json).
// The template (dashboard/*.html|css|js|cjs) contains no data; the generated file embeds one report.
import fs from 'node:fs/promises';
import { fileName, OUTPUT_DIR_LABEL } from './paths.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUTPUT_DIR, today, log } from './importass.js';
import { parseQuotaSnapshot } from './quotaParser.js';
import { REPORT_PREFIX, generateContributionsReport } from './contributionsReport.js';

const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');
export const DASHBOARD_PREFIX = 'dashboard';
const SUBTOTAL_ROW = /^LIQUIDO\b/i;

/**
 * Concept lines of one quota calculation for one share ('worker' | 'employer'):
 * the leaf rows (not the "LIQUIDO ..." subtotals), grouped by the subtotal that follows them.
 * Returns [{ group, concept, amount }].
 */
export function conceptsFromBreakdown(breakdown, share) {
  const key = share === 'employer' ? 'employerQuota' : 'workerQuota';
  const out = []; let pending = [];
  for (const row of breakdown || []) {
    const concept = String(row.concept || '').trim();
    if (SUBTOTAL_ROW.test(concept)) {
      const group = concept.replace(/^LIQUIDO\s+(DE\s+)?/i, '').trim() || 'OTROS';
      if (!/^TOTALES$/i.test(group)) for (const p of pending) out.push({ group, ...p });
      else for (const p of pending) out.push({ group: 'OTROS', ...p });
      pending = [];
      continue;
    }
    const amount = row[key];
    if (amount !== null && amount !== undefined && amount !== 0) pending.push({ concept, amount });
  }
  for (const p of pending) out.push({ group: 'OTROS', ...p });
  return out;
}

/** Adds payments[].concepts to the quota-calculation entries. breakdownByFile: { file: breakdown rows }. Returns a copy. */
export function attachConcepts(report, breakdownByFile) {
  const payments = report.payments.map((p) => {
    if (p.sourceReport !== 'quota-calculations' || !p.sourceFile || !breakdownByFile[p.sourceFile]) return p;
    const concepts = conceptsFromBreakdown(breakdownByFile[p.sourceFile], p.payerType === 'employer' ? 'employer' : 'worker');
    return concepts.length ? { ...p, concepts } : p;
  });
  return { ...report, payments };
}

/** Escapes JSON for an inline <script type="application/json"> block. */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Builds the self-contained HTML. data: null (empty template) or { report, label }. */
export async function renderDashboardHtml(data = null) {
  const [tpl, css, model, app] = await Promise.all(['template.html', 'style.css', 'model.cjs', 'app.js'].map((f) => fs.readFile(path.join(DASHBOARD_DIR, f), 'utf8')));
  return tpl
    .replace('__REPORT_DATA__', () => (data ? jsonForScript(data) : 'null'))
    .replace('/*__STYLE__*/', () => css)
    .replace('/*__MODEL__*/', () => model.replace(/<\/script/gi, '<\\/script'))
    .replace('/*__APP__*/', () => app.replace(/<\/script/gi, '<\\/script'));
}

/** Latest saved full (unfiltered) report path, or null. */
export async function latestReportPath() {
  const names = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const f = names.filter((n) => new RegExp(`^${REPORT_PREFIX}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(n)).sort().at(-1);
  return f ? path.join(OUTPUT_DIR, f) : null;
}

async function loadBreakdowns(report) {
  const files = [...new Set(report.payments.filter((p) => p.sourceReport === 'quota-calculations' && p.sourceFile).map((p) => p.sourceFile))];
  const out = {};
  for (const f of files) {
    const text = await fs.readFile(path.join(OUTPUT_DIR, path.basename(f)), 'utf8').catch(() => null);
    if (!text) continue;
    const rec = parseQuotaSnapshot(text, { withBreakdown: true });
    if (rec.breakdown) out[f] = rec.breakdown;
  }
  return out;
}

/**
 * Writes the dashboard HTML (no browser, no network).
 * reportPath: a combined-report-*.json (default: the latest saved one; generated from saved data if none or regenerate).
 * template: also/only write the empty template. open: open the file in the default browser (macOS `open`).
 */
export async function generateDashboard({ reportPath, regenerate = false, open = false, templateOnly = false } = {}) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const templatePath = path.join(OUTPUT_DIR, `${DASHBOARD_PREFIX}-template.html`);
  await fs.writeFile(templatePath, await renderDashboardHtml(null), 'utf8');
  if (templateOnly) {
    if (open) openFile(templatePath);
    return { templatePath, filePath: null, message: `Empty template written (load a report with the file picker or drag and drop): ${fileName(templatePath)} in ${OUTPUT_DIR_LABEL}` };
  }
  // A bare file name refers to the output folder (tools only see file names).
  const resolved = reportPath && !reportPath.includes('/') && !reportPath.includes('\\') ? path.join(OUTPUT_DIR, reportPath) : reportPath;
  let src = resolved ? path.resolve(resolved) : regenerate ? null : await latestReportPath();
  let report;
  if (src) report = JSON.parse(await fs.readFile(src, 'utf8'));
  else { const r = await generateContributionsReport({}); report = r.report; src = r.filePath; }
  if (!report || !Array.isArray(report.payments)) throw new Error(`${src} is not a contributions report (no payments).`);
  const enriched = attachConcepts(report, await loadBreakdowns(report));
  const withConcepts = enriched.payments.filter((p) => p.concepts).length;
  const filePath = path.join(OUTPUT_DIR, `${DASHBOARD_PREFIX}-${today()}.html`);
  await fs.writeFile(filePath, await renderDashboardHtml({ report: enriched, label: path.basename(src) }), 'utf8');
  const total = enriched.payments.reduce((s, p) => s + (Number(p.total) || 0), 0);
  if (open) openFile(filePath);
  return {
    filePath, templatePath, reportPath: src, entries: enriched.payments.length, withConcepts,
    total: Math.round(total * 100) / 100, grandTotal: report.aggregates && report.aggregates.grand ? report.aggregates.grand.total : null,
    message: `Dashboard written: ${fileName(filePath)} in ${OUTPUT_DIR_LABEL} (${enriched.payments.length} entries, ${withConcepts} with concept breakdown, total ${total.toFixed(2)} EUR).`,
  };
}

function openFile(file) {
  log('opening', file);
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
}
