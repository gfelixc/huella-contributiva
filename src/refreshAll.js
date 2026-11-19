// One command for everything: refresh what is missing or stale in ONE Chrome session (the user picks
// the certificate), then build the combined report and the dashboard. It only calls the existing
// read-only fetchers (with their blocklists); it adds no clicks of its own. Output: file names only.
import fs from 'node:fs/promises';
import { OUTPUT_DIR, launchChrome, log, today } from './importass.js';
import { fileName, OUTPUT_DIR_LABEL } from './paths.js';
import { fetchContributionBases } from './basesReport.js';
import { latestWorkHistoryJson, loadWorkHistory, fetchWorkHistoryFromPage } from './workHistoryPage.js';
import { fetchQuotaCalculations } from './quotas.js';
import { fetchPaidContributions } from './paidQuotas.js';
import { regularizationPlan, summarizeRegularization, fetchRetaRegularization } from './regularization.js';
import { classifySepeFiles, fetchSepeBenefits } from './sepe.js';
import { loadSaved, buildFromSaved, generateContributionsReport } from './contributionsReport.js';
import { generateDashboard } from './dashboard.js';

/** Step order (bases first: the other plans depend on it; work history before SEPE). */
export const STEPS = ['bases', 'workHistory', 'quotas', 'paid', 'regularization', 'sepe'];
export const STEP_LABELS = {
  bases: 'contribution bases', workHistory: 'work history', quotas: 'quota calculations',
  paid: 'paid contributions', regularization: 'RETA regularisation', sepe: 'SEPE certificates',
};
const ALIASES = {
  bases: 'bases', 'contribution-bases': 'bases', workhistory: 'workHistory', 'work-history': 'workHistory', 'work_history': 'workHistory',
  quotas: 'quotas', quota: 'quotas', 'quota-calculations': 'quotas', paid: 'paid', 'paid-contributions': 'paid',
  regularization: 'regularization', regularisation: 'regularization', reta: 'regularization', sepe: 'sepe',
};
export const DEFAULT_MAX_AGE_DAYS = 7;
// Statuses that are final for a regularisation year; anything else (pending, unknown, missing) is fetched.
const FINAL_REG = new Set(['refund', 'claim', 'no-difference', 'not-regularisable']);

/** Pure: "a,b c" or ['a', 'b'] → step ids (throws on unknown names). */
export function parseStepList(input) {
  const raw = (Array.isArray(input) ? input : input ? [input] : []).flatMap((v) => String(v).split(/[,;\s]+/)).filter(Boolean);
  return [...new Set(raw.map((n) => {
    const id = ALIASES[n.toLowerCase()];
    if (!id) throw new Error(`Unknown step "${n}" (use: bases, work-history, quotas, paid, regularisation, sepe)`);
    return id;
  }))];
}

/** Pure: which steps run. Returns [{ step, selected, reason }] in STEPS order. */
export function selectSteps({ only, skip } = {}) {
  const o = parseStepList(only); const s = parseStepList(skip);
  return STEPS.map((step) => {
    if (o.length && !o.includes(step)) return { step, selected: false, reason: 'not in --only' };
    if (s.includes(step)) return { step, selected: false, reason: 'in --skip' };
    return { step, selected: true, reason: null };
  });
}

/** Pure: whole days between two YYYY-MM-DD dates. */
export function ageDays(day, todayIso) {
  if (!day) return Infinity;
  return Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
}

/**
 * Pure staleness rules. state (from collectState): { today, basesDay, workHistoryDay, quotaSaved, quotaGaps,
 * paidSaved, paidGaps, regYears, regStatus {year: status}, sepeYears, sepeSavedYears }.
 * Returns { action: 'fetch'|'skip', reason, args }.
 */
export function planStep(step, state, { force = false, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const fetch = (reason, args = {}) => ({ action: 'fetch', reason, args });
  const skip = (reason) => ({ action: 'skip', reason, args: null });
  const fresh = (day, what) => {
    if (force) return fetch('--force');
    if (!day) return fetch(`no ${what} saved`);
    const age = ageDays(day, state.today);
    return age > maxAgeDays ? fetch(`saved ${age} days ago (older than ${maxAgeDays})`) : skip(`saved ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`} (max age ${maxAgeDays})`);
  };
  switch (step) {
    case 'bases': return fresh(state.basesDay, 'contribution bases report');
    case 'workHistory': return fresh(state.workHistoryDay, 'work history');
    case 'quotas':
      if (force) return fetch('--force (every employee month)');
      if (!state.quotaSaved) return fetch('no quota calculations saved (every employee month)');
      return state.quotaGaps.length ? fetch(`${state.quotaGaps.length} employee month(s) without a quota calculation`, { months: state.quotaGaps }) : skip('no employee month missing');
    case 'paid':
      if (force) return fetch('--force (every self-employed month)');
      if (!state.paidSaved) return fetch('no paid contributions saved (every self-employed month)');
      return state.paidGaps.length ? fetch(`${state.paidGaps.length} self-employed month(s) missing from the paid report`, { months: state.paidGaps }) : skip('no self-employed month missing');
    case 'regularization': {
      if (!state.regYears.length) return skip('no RETA year from 2023 to last year in the bases report');
      const open = force ? state.regYears : state.regYears.filter((y) => !FINAL_REG.has(state.regStatus[y]));
      if (!open.length) return skip(`every year has a final result (${state.regYears.join(', ')})`);
      return fetch(force ? `--force (${open.join(', ')})` : `year(s) without a final result: ${open.join(', ')}`, { years: open });
    }
    case 'sepe': {
      if (!state.sepeYears.length) return skip('no unemployment benefit period in the work history');
      const missing = force ? state.sepeYears : state.sepeYears.filter((y) => !state.sepeSavedYears.includes(y));
      if (!missing.length) return skip(`annual certificates already saved (${state.sepeYears.join(', ')})`);
      return fetch(force ? `--force (${missing.join(', ')})` : `annual certificate(s) missing: ${missing.join(', ')}`, { years: missing });
    }
    default: throw new Error(`Unknown step ${step}`);
  }
}

/** Pure: gaps of the combined report → months to fetch (months already queried without data and the
 *  just-finished month, which the paid report usually lacks, are not refetched automatically). */
export function gapMonths(gaps = []) {
  return {
    quotaGaps: gaps.filter((g) => g.regime === 'GENERAL' && g.reason === 'employee month without quota calculation').map((g) => g.period),
    paidGaps: gaps.filter((g) => g.regime === 'RETA' && !/^last month/.test(g.reason)).map((g) => g.period),
  };
}

/** Reads the saved data (no browser) into the state planStep needs. */
export async function collectState({ now = new Date() } = {}) {
  const saved = await loadSaved();
  const report = buildFromSaved(saved, { now });
  const { quotaGaps, paidGaps } = gapMonths(report.gaps);
  const wh = await latestWorkHistoryJson().catch(() => null);
  let regYears = []; const regStatus = {};
  try { regYears = (await regularizationPlan({ now })).years; } catch { /* no bases */ }
  try { for (const r of (await summarizeRegularization()).records) if (!FINAL_REG.has(regStatus[r.year])) regStatus[r.year] = r.status; } catch { /* none saved */ }
  const whl = saved.workHistory || (await loadWorkHistory({ now }).catch(() => null));
  const sepeYears = [...new Set((whl ? whl.benefitPeriods : []).flatMap((p) => p.months.map((m) => Number(m.slice(0, 4)))))].filter((y) => y <= now.getFullYear()).sort();
  const names = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const sepeSavedYears = [...new Set(classifySepeFiles(names).map((f) => /^annual-(\d{4})$/.exec(f.label)).filter(Boolean).map((m) => Number(m[1])))];
  return {
    today: today(), basesDay: saved.bases ? saved.bases.day : null, workHistoryDay: wh ? wh.day : null,
    quotaSaved: Boolean(saved.quota), quotaGaps, paidSaved: Boolean(saved.paid), paidGaps,
    regYears, regStatus, sepeYears, sepeSavedYears,
  };
}

/** Fetchers used in a shared Chrome session; each returns the fetcher's own { ok, message, files }. */
export const FETCHERS = {
  bases: (context) => fetchContributionBases({ context }),
  workHistory: (context) => fetchWorkHistoryFromPage({ context }),
  quotas: (context, args) => fetchQuotaCalculations({ context, ...args }),
  paid: (context, args) => fetchPaidContributions({ context, ...args }),
  regularization: (context, args) => fetchRetaRegularization({ context, ...args }),
  sepe: (context, args) => fetchSepeBenefits({ context, ...args }),
};

/** Closes extra tabs between steps so a fetcher never acts on a page left by the previous one. */
async function tidyContext(context) {
  const pages = context.pages().filter((p) => !p.isClosed());
  for (const p of pages.slice(1)) await p.close().catch(() => {});
  if (pages[0]) await pages[0].goto('about:blank').catch(() => {});
}

const names = (files) => [...new Set((files || []).filter(Boolean).map((f) => fileName(typeof f === 'string' ? f : f.pdfPath || f.txtPath || '')))].filter(Boolean);

/**
 * Orchestrates the refresh. options: force, only, skip, maxAgeDays, open (dashboard in the browser),
 * dryRun (plan only, no browser, nothing written except the usual summary re-parse).
 * deps (tests): collectState, launchChrome, fetchers, tidy, buildReport, buildDashboard, now.
 * Returns { ok, dryRun, steps: [{ step, label, status: planned|conditional|ok|skipped|failed, reason, files }], report, dashboard, message }.
 */
// Steps whose plan depends on the data an earlier step fetches (a dry run cannot know it yet).
export const DEPENDS_ON = { quotas: 'bases', paid: 'bases', regularization: 'bases', sepe: 'workHistory' };

export async function refreshAll({ force = false, only, skip, maxAgeDays = DEFAULT_MAX_AGE_DAYS, open = true, dryRun = false } = {}, deps = {}) {
  const d = {
    collectState: () => collectState({ now: deps.now || new Date() }), launchChrome, fetchers: FETCHERS, tidy: tidyContext,
    buildReport: () => generateContributionsReport({}), buildDashboard: (o) => generateDashboard(o), ...deps,
  };
  if (!Number.isFinite(Number(maxAgeDays)) || Number(maxAgeDays) < 0) throw new Error(`Invalid max age "${maxAgeDays}" (days, 0 or more)`);
  const selection = selectSteps({ only, skip });
  const steps = [];
  let context = null;
  try {
    for (const { step, selected, reason } of selection) {
      const label = STEP_LABELS[step];
      if (!selected) { steps.push({ step, label, status: 'skipped', reason, files: [] }); continue; }
      let plan;
      try { plan = planStep(step, await d.collectState(), { force, maxAgeDays: Number(maxAgeDays) }); } catch (e) { steps.push({ step, label, status: 'failed', reason: `plan: ${e.message}`, files: [] }); continue; }
      const dep = DEPENDS_ON[step];
      if (plan.action === 'skip' && dryRun && dep && steps.some((s) => s.step === dep && s.status === 'planned')) {
        steps.push({ step, label, status: 'conditional', reason: `decided after the ${STEP_LABELS[dep]} step runs (now: ${plan.reason})`, files: [] });
        continue;
      }
      if (plan.action === 'skip') { steps.push({ step, label, status: 'skipped', reason: plan.reason, files: [] }); continue; }
      if (dryRun) { steps.push({ step, label, status: 'planned', reason: plan.reason, args: plan.args, files: [] }); continue; }
      try {
        if (!context) { log('Opening Chrome once for every step; pick your certificate when asked.'); context = await d.launchChrome(); } else await d.tidy(context);
        log(`step ${label}: ${plan.reason}`);
        const r = await d.fetchers[step](context, plan.args);
        steps.push({ step, label, status: r && r.ok ? 'ok' : 'failed', reason: (r && r.message) || (r && r.ok ? plan.reason : 'failed without a message'), files: names(r && r.files) });
      } catch (e) {
        steps.push({ step, label, status: 'failed', reason: e.message.split('\n')[0], files: [] });
      }
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }
  if (dryRun) {
    return { ok: true, dryRun: true, folder: OUTPUT_DIR_LABEL, steps, report: null, dashboard: null, message: 'Dry run: plan only (no browser, no fetch). Later steps are re-planned after earlier ones run.' };
  }
  let report = null; let dashboard = null; const problems = [];
  try { const r = await d.buildReport(); report = r.filePath; } catch (e) { problems.push(`combined report: ${e.message}`); }
  if (report) {
    try { const g = await d.buildDashboard({ reportPath: report, open }); dashboard = g.filePath; } catch (e) { problems.push(`dashboard: ${e.message}`); }
  }
  const failed = steps.filter((s) => s.status === 'failed').length;
  return {
    ok: Boolean(dashboard), dryRun: false, folder: OUTPUT_DIR_LABEL, steps, report: report ? fileName(report) : null, dashboard: dashboard ? fileName(dashboard) : null,
    message: [dashboard ? `Dashboard ${fileName(dashboard)} written${open ? ' and opened' : ''}.` : 'No dashboard written.', failed ? `${failed} step(s) failed (see steps).` : null, ...problems].filter(Boolean).join(' '),
  };
}

/** Compact text for the CLI/MCP: one line per step, then the report and the dashboard. */
export function formatRefreshAll(r) {
  const out = [`${r.dryRun ? 'Plan (dry run)' : 'Refresh'} in ${r.folder}:`];
  for (const s of r.steps) out.push(`- ${s.label}: ${s.status} (${s.reason})${s.args && Object.keys(s.args).length ? ` ${JSON.stringify(s.args)}` : ''}${s.files.length ? ` files=${s.files.length}: ${s.files.slice(0, 6).join(', ')}${s.files.length > 6 ? ', …' : ''}` : ''}`);
  if (!r.dryRun) out.push(`report=${r.report || '-'} dashboard=${r.dashboard || '-'}`);
  out.push(r.message);
  return out.join('\n');
}
