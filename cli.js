#!/usr/bin/env node
// huella-contributiva CLI: read-only access to your own Social Security and SEPE records (see README.md).
import {
  extractText,
} from './src/importass.js';
import { fetchContributionBases, basesView, basesToolPayload, loadContributionBases } from './src/basesReport.js';
import { fetchWorkHistoryFromPage, workHistoryView, workHistoryToolPayload, loadWorkHistory } from './src/workHistoryPage.js';
import { fetchQuotaCalculations, latestQuotaCalculations, resolveQuotaMonths, summarizeQuotaSnapshots, quotaView, DEFAULT_QUOTAS_FROM } from './src/quotas.js';
import { employersLabel } from './src/basesParser.js';
import { fetchPaidContributions, paidView, resolvePaidMonths, latestPaidContributions } from './src/paidQuotas.js';
import { generateContributionsReport } from './src/contributionsReport.js';
import { fetchSepeBenefits, sepeView, resolveSepeRequest } from './src/sepe.js';
import { fetchRetaRegularization, regularizationView, regularizationPlan } from './src/regularization.js';
import { generateDashboard } from './src/dashboard.js';
import { refreshAll, formatRefreshAll, DEFAULT_MAX_AGE_DAYS } from './src/refreshAll.js';
import fs from 'node:fs/promises';
import { sanitizePaths, fileName, OUTPUT_DIR_LABEL } from './src/paths.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
// Every value after a flag until the next "--flag" (e.g. --months 01/2022,06/2023 or --months 01/2022 06/2023).
// Repeatable: every occurrence of the flag is collected (e.g. --range A --range B).
const flagValues = (name) => {
  const vals = [];
  let found = false;
  rest.forEach((v, i) => {
    if (v !== name) return;
    found = true;
    for (const x of rest.slice(i + 1)) { if (x.startsWith('--')) break; vals.push(x); }
  });
  return found ? vals : undefined;
};
const selectionFlags = () => ({ from: flag('--from'), to: flag('--to'), ranges: flagValues('--range'), months: flagValues('--months') });
// Output carries file names only (no absolute paths with the username); the folder is ~/Documents/HuellaContributiva.
const print = (t) => process.stdout.write(sanitizePaths(t));
const out = (o) => print(JSON.stringify(o, null, 2) + '\n');
const timeoutMs = flag('--timeout') ? Number(flag('--timeout')) * 1000 : undefined;
const auto = !rest.includes('--manual');

const USAGE = `Usage:
  node cli.js fetch [--timeout SECONDS] [--manual] [--pdf]
      Reads the work history from the Import@ss page into work-history-<day>.json (full) and
      work-history-<day>.anon.json; prints the full JSON file name + the anonymised JSON.
      --pdf: also download the official PDF (only when explicitly wanted).
  node cli.js fetch-bases [--timeout SECONDS] [--manual] [--from DATE] [--to DATE] [--chunk-years N] [--keep-open]
      Downloads the bases report PDF(s) and writes contribution-bases-<day>.json (full) and .anon.json;
      prints the full JSON file name, the PDF file names and the anonymised JSON.
      Contribution bases report (Informe de bases de cotización).
      Without --from/--to the site's complete (unfiltered) report is downloaded.
      DATE is DD/MM/YYYY, YYYY-MM-DD or "today". --chunk-years splits the range into
      several requests (one PDF per part). --keep-open keeps the window open afterwards
      and saves every extra PDF you download, until you close it or the timeout expires.
  node cli.js fetch-quotas [--timeout SECONDS] [--manual] [--keep-open] [--from MM/YYYY] [--to MM/YYYY]
                           [--range FROM-TO ...] [--months M1,M2,...] [--refresh-bases] [--all-months]
      Quota calculations (Consulta de cálculos de cuotas para trabajador). Read-only.
      By default queries only the months worked as an employee (any non-RETA regime), taken
      from the latest saved contribution bases report; if none is saved (or with
      --refresh-bases) the bases report is downloaded first in the same browser session.
      --range adds one or more ranges (repeatable or comma separated; "02/2018-12/2018" or
      "2018-02-2018-12"); --from/--to is a single range. Range months are limited to employee
      months unless --all-months.
      --months adds individual months (MM/YYYY or YYYY-MM, comma or space separated), queried
      even if they are not employee months; alone it queries exactly those months; together with
      ranges (or --all-months) the union is queried, all in one browser session.
      --from/--to filter that list. --all-months queries every month from --from
      (default ${DEFAULT_QUOTAS_FROM}) to --to (default last month) instead.
      Saves a .txt/.html/.png snapshot per result page (plus any PDF offered).
      --manual: no automatic clicks; a snapshot is saved whenever a new result page appears.
      --keep-open: after the automatic queries, keep saving snapshots until you close the window.
      Default timeout: 1200 s.
  node cli.js show            Latest work history: full JSON file name + anonymised JSON (alias: latest).
  node cli.js show-bases      Latest contribution bases: full JSON file name + anonymised JSON (alias: latest-bases).
                              Builds the JSON pair from a saved report text if none exists yet.
  node cli.js latest-quotas   Paths of the latest saved quota calculations.
  node cli.js summarize-quotas [YYYY-MM-DD]
                              Re-parse saved quota snapshots (no browser) and write
                              quota-calculation-<day>.summary.csv/.summary.json (default: latest day).
  node cli.js show-quotas [--detail summary|breakdown|full] [--from ..] [--to ..] [--range ..] [--months ..] [--day YYYY-MM-DD]
                              Compact view of saved quota calculations (no browser).
  node cli.js employee-months [--from ..] [--to ..] [--range ..] [--months ..] [--all-months]
                              Preview the months fetch-quotas would query (no browser).
  node cli.js fetch-paid-quotas [--timeout SECONDS] [--manual] [--keep-open] [--from ..] [--to ..]
                                [--range FROM-TO ...] [--months M1,M2,...] [--refresh-bases] [--all-months]
      Paid contributions report for RETA / special regimes (Informe de cuotas ingresadas). Read-only.
      The site issues the report per year: one query (+ certified PDF) per year of the selected
      months, all in one browser session. Default selection: every self-employed (RETA) month in the
      latest saved bases report, up to last month (bases report downloaded first, same session, if
      none is saved or with --refresh-bases). --range/--from/--to limit it to self-employed months in
      any range (every month with --all-months); --months adds individual months (union). Default timeout: 600 s.
  node cli.js show-paid-quotas [--detail summary|breakdown|full] [--from ..] [--to ..] [--range ..] [--months ..] [--day YYYY-MM-DD]
                              Compact view of the saved paid contributions (latest capture per year; no browser);
                              writes paid-contribution.summary.csv/.json.
  node cli.js paid-months [--from ..] [--to ..] [--range ..] [--months ..] [--all-months]
                              Preview the months/years fetch-paid-quotas would request (no browser).
  node cli.js latest-paid-quotas   Files of the latest paid contributions capture.
  node cli.js contributions-report [--from ..] [--to ..] [--range ..] [--months ..] [--payer all|worker|employer|public_agency]
                                   [--payer-name TEXT] [--group-by payer,year,year_payer,regime,month|all]
                                   [--payments] [--refresh]
      Combined JSON report of every contribution paid by you or your employers, built from the saved
      quota calculations (employee months: worker share withheld from payroll + employer share, per
      liquidation) and paid contributions report (RETA months: paid directly), cross-checked with the
      bases report. No browser by default. Writes ~/Documents/HuellaContributiva/combined-report-YYYY-MM-DD.json
      (-filtered.json with filters) and prints aggregates, gaps and notes (--payments: every entry).
      --refresh: first fetch the missing months (gaps) in one Chrome session, then rebuild.
  node cli.js fetch-sepe [--years 2020,2021] [--from ..] [--to ..] [--range ..] [--months ..] [--all-years]
                         [--period MM/YYYY-MM/YYYY|auto] [--timeout SECONDS] [--manual] [--keep-open]
      SEPE benefit certificates (sede.sepe.gob.es "Obtención de certificados"), certificate login.
      One "Certificado de importes anuales" per year (gross benefit, IRPF withheld, Social Security
      deduction) and optionally one "Certificado de importes por periodo" (max 12 months; the site
      allows one per day; "auto" = first benefit period in the work history report). Default years:
      the unemployment benefit periods (e.g. ERTE) in the saved work history report, else 2020.
      Always "descargarlo desde internet"; never the postal option or any confirmation.
  node cli.js show-sepe [--years 2020] [--detail summary|full]
                              Compact view of the saved SEPE certificates (no browser);
                              writes sepe-benefits.summary.csv/.json.
  node cli.js sepe-plan [same selection flags]   Preview the certificates fetch-sepe would request (no browser).
  node cli.js fetch-regularization [--years 2023,2024] [--manual] [--keep-open] [--timeout SECONDS]
      RETA annual regularisation (Import@ss "Regularización anual de cuotas de años anteriores"), certificate
      login. Automatic: reads the result card of every year and downloads the resolution PDF of each requested
      year (only the "Resolución <year>" DESCARGAR button is clicked) → reta-regularisation-YYYY-MM-DD-<year>.pdf/.txt,
      plus page snapshots (-page.txt/html/png). Never uses the current-year query form, never keeps/changes a
      base, pays or requests anything, never opens NOTESS/DEHú notifications. Closes Chrome when done unless
      --keep-open (then every page/PDF is saved until you close the window). --manual: no clicks, you navigate.
  node cli.js show-regularization [--years 2024] [--detail summary|full]
                              Compact view of the saved regularisation results (no browser);
                              writes reta-regularisation.summary.csv/.json.
  node cli.js regularization-plan [--years 2024]   Years and services fetch-regularization would check (no browser).
  node cli.js dashboard [--report <combined-report-*.json>] [--regenerate] [--template] [--open]
      Local HTML dashboard (file://, no server, no network): KPIs, Sankey flow, drill-down, timeline,
      notes/gaps. Embeds the latest saved contributions report (or --report; --regenerate rebuilds it
      from saved data first, no browser) → dashboard-YYYY-MM-DD.html, plus the empty
      dashboard-template.html (load any report by file picker or drag and drop).
  node cli.js refresh-all [--dry-run] [--force] [--only LIST] [--skip LIST] [--max-age DAYS] [--no-open] [--json]
      (aliases: all, dashboard --refresh-all) One command for everything: in ONE Chrome session (you pick the
      certificate; the SEPE site may ask again) fetches only what is missing or stale, in this order:
      bases, work-history, quotas, paid, regularisation, sepe; then builds the combined report, writes the
      dashboard and opens it (unless --no-open). A failed step does not stop the others.
      Stale: bases / work history saved more than --max-age days ago (default ${DEFAULT_MAX_AGE_DAYS}); quotas: employee
      months without a quota calculation; paid: self-employed months missing from the paid report (not the
      month just finished); regularisation: years without a final result; SEPE: benefit years without an
      annual certificate. --force refetches everything; LIST: comma-separated step names.
      --dry-run prints the plan without opening Chrome. --json prints the result as JSON.
  node cli.js extract <file.pdf>`;


try {
  if (cmd === 'fetch') {
    const r = await fetchWorkHistoryFromPage({ timeoutMs, auto, downloadPdf: rest.includes('--pdf') });
    out(r.ok ? { ok: true, ...(r.message ? { message: r.message } : {}), ...workHistoryToolPayload(r) } : { ok: false, message: r.message });
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'fetch-bases') {
    const chunkYears = flag('--chunk-years') ? Number(flag('--chunk-years')) : undefined;
    const r = await fetchContributionBases({
      timeoutMs, auto, from: flag('--from'), to: flag('--to'), chunkYears, keepOpen: rest.includes('--keep-open'),
    });
    out(r.ok ? { ok: true, ...basesToolPayload(r) } : { ok: false, message: r.message });
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'fetch-quotas') {
    const r = await fetchQuotaCalculations({
      timeoutMs, auto, ...selectionFlags(), keepOpen: rest.includes('--keep-open'),
      allMonths: rest.includes('--all-months'), refreshBases: rest.includes('--refresh-bases'),
    });
    if (r.ok) print(`${r.message}\n${await quotaView({ months: r.months.map((m) => m.period) })}\n`);
    else out({ ok: false, message: r.message });
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'employee-months') {
    const saved = await loadContributionBases();
    if (!saved) { out({ ok: false, message: 'No saved contribution bases report found. Run fetch-bases first.' }); process.exit(1); }
    const { months, ranges, notEmployee } = resolveQuotaMonths({ ...selectionFlags(), allMonths: rest.includes('--all-months'), bases: saved.full });
    out({ ok: true, source: saved.file, count: months.length, ranges, notEmployee, months: months.map((m) => `${m.period} ${employersLabel(m)}`.trim()) });
  } else if (cmd === 'summarize-quotas') {
    const day = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
    const r = await summarizeQuotaSnapshots(day);
    out({ ok: true, day: r.day, csvPath: r.csvPath, jsonPath: r.jsonPath, rows: r.records.length, employers: r.summary.employers, grand: r.summary.grand, issues: r.summary.issues });
  } else if (cmd === 'show-quotas') {
    print(await quotaView({ detail: flag('--detail') || 'summary', ...selectionFlags(), day: flag('--day') }) + '\n');
  } else if (cmd === 'latest-quotas') {
    const r = await latestQuotaCalculations();
    out(r ? { ok: true, txtPath: r.txtPath, files: r.files, message: 'Latest saved quota calculations.' }
          : { ok: false, txtPath: null, message: 'No saved quota calculations found.' });
  } else if (cmd === 'fetch-paid-quotas') {
    const r = await fetchPaidContributions({
      timeoutMs, auto, ...selectionFlags(), keepOpen: rest.includes('--keep-open'),
      allMonths: rest.includes('--all-months'), refreshBases: rest.includes('--refresh-bases'),
    });
    if (r.ok) {
      const note = r.notSelfEmployed && r.notSelfEmployed.length ? `note: not self-employed months in the bases report (requested anyway): ${r.notSelfEmployed.join(', ')}\n` : '';
      print(`${r.message}\n${note}${await paidView({ months: r.months, expected: r.months })}\n`);
    } else out({ ok: false, message: r.message });
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'show-paid-quotas') {
    print(await paidView({ detail: flag('--detail') || 'summary', ...selectionFlags(), day: flag('--day') }) + '\n');
  } else if (cmd === 'paid-months') {
    const saved = await loadContributionBases();
    const r = resolvePaidMonths({ ...selectionFlags(), allMonths: rest.includes('--all-months'), bases: saved ? saved.full : null });
    out({ ok: true, source: saved ? saved.file : null, count: r.months.length, years: r.years, retaFirst: r.retaFirst, retaLast: r.retaLast, notSelfEmployed: r.notSelfEmployed, first: r.months[0]?.period ?? null, last: r.months.at(-1)?.period ?? null });
  } else if (cmd === 'latest-paid-quotas') {
    const r = await latestPaidContributions();
    out(r ? { ok: true, day: r.day, files: r.files } : { ok: false, message: 'No saved paid contributions report found.' });
  } else if (cmd === 'contributions-report') {
    const r = await generateContributionsReport({
      ...selectionFlags(), payer: flag('--payer'), payerName: flag('--payer-name'),
      groupBy: (flag('--group-by') || 'payer,year').split(','), includePayments: rest.includes('--payments'), refresh: rest.includes('--refresh'),
    });
    print(r.text + '\n');
  } else if (cmd === 'refresh-all' || cmd === 'all' || (cmd === 'dashboard' && rest.includes('--refresh-all'))) {
    const r = await refreshAll({
      force: rest.includes('--force'), only: flagValues('--only'), skip: flagValues('--skip'),
      maxAgeDays: flag('--max-age') ?? DEFAULT_MAX_AGE_DAYS, open: !rest.includes('--no-open'), dryRun: rest.includes('--dry-run'),
    });
    if (rest.includes('--json')) out(r); else print(formatRefreshAll(r) + '\n');
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'dashboard') {
    const r = await generateDashboard({ reportPath: flag('--report'), regenerate: rest.includes('--regenerate'), open: rest.includes('--open'), templateOnly: rest.includes('--template') });
    const { filePath, templatePath, reportPath, ...rest2 } = r;
    out({ ok: true, folder: OUTPUT_DIR_LABEL, dashboard: fileName(filePath), template: fileName(templatePath), report: fileName(reportPath), ...rest2 });
  } else if (cmd === 'fetch-sepe') {
    const r = await fetchSepeBenefits({
      timeoutMs, auto, keepOpen: rest.includes('--keep-open'), ...selectionFlags(), years: flagValues('--years'),
      allYears: rest.includes('--all-years'), period: flag('--period'),
    });
    if (r.ok) print(`${r.message}\n${await sepeView({})}\n`);
    else out({ ok: false, message: r.message });
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'show-sepe') {
    print(await sepeView({ detail: flag('--detail') || 'summary', years: flagValues('--years') }) + '\n');
  } else if (cmd === 'sepe-plan') {
    const wh = await loadWorkHistory();
    const bases = await loadContributionBases();
    const p = resolveSepeRequest({ ...selectionFlags(), years: flagValues('--years'), allYears: rest.includes('--all-years'), period: flag('--period'), benefitPeriods: wh ? wh.benefitPeriods : [], bases: bases ? bases.full : null });
    out({ ok: true, annualYears: p.years, period: p.period, source: p.source, benefitPeriods: p.benefitPeriods.map((b) => `${b.kind} ${b.from}..${b.to}`) });
  } else if (cmd === 'fetch-regularization') {
    if (!auto) process.stderr.write('Manual snapshot mode: navigate the regularisation service yourself; close the window when done.\n');
    const r = await fetchRetaRegularization({ years: flagValues('--years'), timeoutMs, auto, keepOpen: rest.includes('--keep-open') });
    print(`${r.message}\n${await regularizationView({})}\n`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'show-regularization') {
    print(await regularizationView({ detail: flag('--detail') || 'summary', years: flagValues('--years') }) + '\n');
  } else if (cmd === 'regularization-plan') {
    const p = await regularizationPlan({ years: flagValues('--years') });
    out({ ok: true, ...p });
  } else if (cmd === 'latest' || cmd === 'show') {
    const v = await workHistoryView();
    out(v.ok ? { ok: true, ...v.payload } : { ok: false, message: v.message });
    process.exit(v.ok ? 0 : 1);
  } else if (cmd === 'show-bases' || cmd === 'latest-bases') {
    const v = await basesView();
    out(v.ok ? { ok: true, ...v.payload } : { ok: false, message: v.message });
    process.exit(v.ok ? 0 : 1);
  } else if (cmd === 'extract' && rest[0]) {
    print(await extractText(await fs.readFile(rest[0])) + '\n');
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (e) {
  out({ pdfPath: null, txtPath: null, ok: false, message: `Error: ${e.message}` });
  process.exit(1);
}
