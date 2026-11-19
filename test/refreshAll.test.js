// Orchestration tests with mocks only: no browser, no network, no saved data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, parseStepList, selectSteps, ageDays, planStep, gapMonths, refreshAll, formatRefreshAll } from '../src/refreshAll.js';

const FRESH = {
  today: '2026-03-10', basesDay: '2026-03-09', workHistoryDay: '2026-03-10', quotaSaved: true, quotaGaps: [], paidSaved: true, paidGaps: [],
  regYears: [2023, 2024], regStatus: { 2023: 'refund', 2024: 'no-difference' }, sepeYears: [2020], sepeSavedYears: [2020],
};

test('step names, aliases and selection', () => {
  assert.deepEqual(STEPS, ['bases', 'workHistory', 'quotas', 'paid', 'regularization', 'sepe']);
  assert.deepEqual(parseStepList('work-history, regularisation sepe'), ['workHistory', 'regularization', 'sepe']);
  assert.deepEqual(parseStepList(['RETA', 'quota']), ['regularization', 'quotas']);
  assert.throws(() => parseStepList('payments'), /Unknown step/);
  const sel = selectSteps({ only: 'bases,paid,sepe', skip: 'sepe' });
  assert.deepEqual(sel.filter((s) => s.selected).map((s) => s.step), ['bases', 'paid']);
  assert.equal(sel.find((s) => s.step === 'sepe').reason, 'in --skip');
  assert.equal(sel.find((s) => s.step === 'quotas').reason, 'not in --only');
});

test('staleness rules', () => {
  assert.equal(ageDays('2026-03-01', '2026-03-10'), 9);
  assert.equal(ageDays(null, '2026-03-10'), Infinity);
  for (const step of STEPS) assert.equal(planStep(step, FRESH).action, 'skip', step);
  assert.equal(planStep('bases', { ...FRESH, basesDay: '2026-03-01' }).action, 'fetch');
  assert.equal(planStep('bases', { ...FRESH, basesDay: '2026-03-01' }, { maxAgeDays: 30 }).action, 'skip');
  assert.equal(planStep('workHistory', { ...FRESH, workHistoryDay: null }).reason, 'no work history saved');
  assert.equal(planStep('bases', FRESH, { maxAgeDays: 0 }).action, 'fetch'); // saved yesterday, max age 0
  assert.deepEqual(planStep('quotas', { ...FRESH, quotaGaps: ['2025-01', '2025-02'] }).args, { months: ['2025-01', '2025-02'] });
  assert.deepEqual(planStep('quotas', { ...FRESH, quotaSaved: false }).args, {});
  assert.deepEqual(planStep('paid', { ...FRESH, paidGaps: ['2026-01'] }).args, { months: ['2026-01'] });
  assert.deepEqual(planStep('regularization', { ...FRESH, regStatus: { 2023: 'refund', 2024: 'pending' } }).args, { years: [2024] });
  assert.deepEqual(planStep('regularization', { ...FRESH, regStatus: {} }).args, { years: [2023, 2024] });
  assert.equal(planStep('regularization', { ...FRESH, regYears: [] }).action, 'skip');
  assert.deepEqual(planStep('sepe', { ...FRESH, sepeYears: [2020, 2021] }).args, { years: [2021] });
  assert.equal(planStep('sepe', { ...FRESH, sepeYears: [] }).action, 'skip');
  for (const step of STEPS) assert.equal(planStep(step, FRESH, { force: true }).action, 'fetch', step);
  assert.deepEqual(planStep('sepe', FRESH, { force: true }).args, { years: [2020] });
});

test('gap months: no refetch of months queried without data or of the month just finished', () => {
  const g = gapMonths([
    { period: '2025-01', regime: 'GENERAL', reason: 'employee month without quota calculation' },
    { period: '2025-02', regime: 'GENERAL', reason: 'quota calculation without data' },
    { period: '2026-01', regime: 'RETA', reason: 'self-employed month missing from the paid contributions report' },
    { period: '2026-02', regime: 'RETA', reason: 'last month: probably not yet processed in the paid contributions report' },
  ]);
  assert.deepEqual(g, { quotaGaps: ['2025-01'], paidGaps: ['2026-01'] });
});

/** Mock environment: a state that changes as steps run, recording every call. */
function mockDeps({ state = {}, fail = [], throwOn = [], reportFails = false } = {}) {
  const calls = [];
  let current = { ...FRESH, basesDay: null, workHistoryDay: null, quotaSaved: false, paidSaved: false, regStatus: {}, sepeSavedYears: [], ...state };
  const fetcher = (step) => async (context, args) => {
    calls.push(['fetch', step, args, context.id]);
    if (throwOn.includes(step)) throw new Error(`${step} exploded\nstack`);
    if (fail.includes(step)) return { ok: false, message: `${step} failed: address check`, files: [] };
    if (step === 'bases') current = { ...current, basesDay: current.today };
    if (step === 'workHistory') current = { ...current, workHistoryDay: current.today, sepeYears: [2020] };
    return { ok: true, message: `${step} done`, files: [`/Users/example/Documents/HuellaContributiva/${step}-2026-03-10.txt`] };
  };
  const deps = {
    collectState: async () => { calls.push(['state']); return current; },
    launchChrome: async () => { calls.push(['launch']); return { id: 'ctx', close: async () => calls.push(['close']) }; },
    tidy: async () => calls.push(['tidy']),
    fetchers: Object.fromEntries(STEPS.map((s) => [s, fetcher(s)])),
    buildReport: async () => { calls.push(['report']); if (reportFails) throw new Error('no data'); return { filePath: '/Users/example/Documents/HuellaContributiva/combined-report-2026-03-10.json' }; },
    buildDashboard: async (o) => { calls.push(['dashboard', o]); return { filePath: '/Users/example/Documents/HuellaContributiva/dashboard-2026-03-10.html' }; },
  };
  return { deps, calls };
}

test('orchestration: order, one Chrome session, tidy between steps, report + dashboard', async () => {
  const { deps, calls } = mockDeps();
  const r = await refreshAll({}, deps);
  const fetched = calls.filter((c) => c[0] === 'fetch').map((c) => c[1]);
  assert.deepEqual(fetched, ['bases', 'workHistory', 'quotas', 'paid', 'regularization', 'sepe']);
  assert.equal(calls.filter((c) => c[0] === 'launch').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'tidy').length, 5);
  assert.ok(calls.findIndex((c) => c[0] === 'close') < calls.findIndex((c) => c[0] === 'report'), 'Chrome closed before the report');
  assert.deepEqual(calls.find((c) => c[0] === 'dashboard')[1], { reportPath: '/Users/example/Documents/HuellaContributiva/combined-report-2026-03-10.json', open: true });
  assert.equal(r.ok, true);
  assert.equal(r.report, 'combined-report-2026-03-10.json');
  assert.equal(r.dashboard, 'dashboard-2026-03-10.html');
  assert.deepEqual(r.steps[0].files, ['bases-2026-03-10.txt']);
  const text = formatRefreshAll(r);
  assert.ok(!/\/Users\//.test(text) && /dashboard=dashboard-2026-03-10\.html/.test(text));
});

test('orchestration: a failed or throwing step does not stop the others', async () => {
  const { deps, calls } = mockDeps({ fail: ['paid'], throwOn: ['quotas'] });
  const r = await refreshAll({ open: false }, deps);
  assert.deepEqual(calls.filter((c) => c[0] === 'fetch').map((c) => c[1]), STEPS);
  const by = Object.fromEntries(r.steps.map((s) => [s.step, s]));
  assert.equal(by.quotas.status, 'failed'); assert.equal(by.quotas.reason, 'quotas exploded');
  assert.equal(by.paid.status, 'failed'); assert.match(by.paid.reason, /address check/);
  assert.equal(by.sepe.status, 'ok');
  assert.equal(calls.find((c) => c[0] === 'dashboard')[1].open, false);
  assert.match(r.message, /2 step\(s\) failed/);
});

test('orchestration: nothing stale → no Chrome; only/skip; dry run never launches Chrome', async () => {
  let m = mockDeps({ state: FRESH });
  let r = await refreshAll({}, m.deps);
  assert.ok(!m.calls.some((c) => c[0] === 'launch' || c[0] === 'fetch'));
  assert.ok(r.steps.every((s) => s.status === 'skipped'));
  assert.equal(r.ok, true);

  m = mockDeps();
  r = await refreshAll({ only: ['bases', 'sepe'], skip: 'sepe' }, m.deps);
  assert.deepEqual(m.calls.filter((c) => c[0] === 'fetch').map((c) => c[1]), ['bases']);

  m = mockDeps();
  r = await refreshAll({ dryRun: true }, m.deps);
  assert.ok(!m.calls.some((c) => ['launch', 'fetch', 'report', 'dashboard'].includes(c[0])));
  assert.equal(r.dryRun, true);
  assert.ok(r.steps.every((s) => s.status === 'planned'));
  assert.deepEqual(r.steps.find((s) => s.step === 'regularization').args, { years: [2023, 2024] });

  // A step that depends on data an earlier planned step fetches is "conditional" in a dry run (not "skipped").
  m = mockDeps({ state: { ...FRESH, basesDay: null, regYears: [], quotaGaps: [] } });
  r = await refreshAll({ dryRun: true }, m.deps);
  const st = Object.fromEntries(r.steps.map((s) => [s.step, s.status]));
  assert.deepEqual(st, { bases: 'planned', workHistory: 'skipped', quotas: 'conditional', paid: 'conditional', regularization: 'conditional', sepe: 'skipped' });
});

test('orchestration: report failure → ok false, no dashboard; invalid max age', async () => {
  const m = mockDeps({ state: FRESH, reportFails: true });
  const r = await refreshAll({}, m.deps);
  assert.equal(r.ok, false); assert.equal(r.dashboard, null); assert.match(r.message, /combined report: no data/);
  await assert.rejects(() => refreshAll({ maxAgeDays: -1 }, m.deps), /Invalid max age/);
});
