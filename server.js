#!/usr/bin/env node
// huella-contributiva MCP server (stdio) for Spanish Social Security (Import@ss) and SEPE reports:
// the work history ("Tu vida laboral", read from the page into JSON), the contribution
// bases report ("Informe de bases de cotización") and the quota calculations
// query ("Consulta de cálculos de cuotas para trabajador") and the paid contributions
// report for RETA / special regimes ("Informe de cuotas ingresadas").
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchWorkHistoryFromPage, workHistoryView, workHistoryToolPayload } from './src/workHistoryPage.js';
import { fetchContributionBases, basesView, basesToolPayload } from './src/basesReport.js';
import { fetchQuotaCalculations, quotaView } from './src/quotas.js';
import { fetchPaidContributions, paidView } from './src/paidQuotas.js';
import { generateContributionsReport } from './src/contributionsReport.js';
import { fetchSepeBenefits, sepeView } from './src/sepe.js';
import { fetchRetaRegularization, regularizationView } from './src/regularization.js';
import { generateDashboard } from './src/dashboard.js';
import { refreshAll, formatRefreshAll, DEFAULT_MAX_AGE_DAYS } from './src/refreshAll.js';
import { sanitizeToolResult, fileName, OUTPUT_DIR_LABEL } from './src/paths.js';

const server = new McpServer({ name: 'huella-contributiva', version: '0.15.1' });

// Defence in depth: every tool response (and thrown error) is passed through sanitizePaths, so no absolute
// path (/Users/<name>/…, /home/<name>/…) can reach the LLM even if a message forgets to use file names.
const registerTool = server.registerTool.bind(server);
server.registerTool = (name, config, handler) => registerTool(name, config, async (...args) => {
  try { return sanitizeToolResult(await handler(...args)); } catch (e) { return sanitizeToolResult({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] }); }
});

// Work history tools: ONLY the full JSON file name + the anonymised JSON content (never page or PDF text).
const workHistoryResult = (r) => {
  if (!r.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, message: r.message }) }] };
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(r.message ? { message: r.message } : {}), ...workHistoryToolPayload(r) }, null, 1) }] };
};
const workHistoryLatestResult = (v) => (v.ok
  ? { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...v.payload }, null, 1) }] }
  : { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, message: v.message }) }] });
const detailParam = z.enum(['summary', 'breakdown', 'full']).optional()
  .describe('summary (default): compact rows + totals; breakdown: adds the concept lines of each month; full: the breakdown plus rawFiles ' +
    '(file names of the local raw snapshots in ~/Documents/HuellaContributiva). Raw page/PDF text is never returned.');
const rangesParam = z.array(z.union([
  z.string().describe('"MM/YYYY-MM/YYYY" or "YYYY-MM-YYYY-MM"'),
  z.object({ from: z.string().optional(), to: z.string().optional() }),
])).optional();
const timeoutParam = z.number().int().min(30).max(1800).optional().describe('Maximum wait time in seconds (default 300).');

server.registerTool(
  'get_work_history_report',
  {
    title: 'Get work history report',
    description:
      'Opens Google Chrome on the Spanish Social Security portal (Import@ss). The user picks their digital certificate in the macOS picker; ' +
      'the work history ("Tu vida laboral") is read directly from the service page (every period row expanded, read-only) and saved to ' +
      '~/Documents/HuellaContributiva as work-history-YYYY-MM-DD.json (with identifying data) and work-history-YYYY-MM-DD.anon.json (without). ' +
      'Returns ONLY the file name of the full JSON (in ~/Documents/HuellaContributiva) and the content of the anonymised JSON (summary, employers, periods with situation type, regime, ' +
      'contract, contribution group, dates and days). The PDF is downloaded only with download_pdf: true. Waits up to 5 minutes by default.',
    inputSchema: {
      timeout_seconds: timeoutParam,
      download_pdf: z.boolean().optional().describe('Also download the official PDF ("Descargar vida laboral"). Only when the user explicitly asks for the PDF. Default false.'),
    },
  },
  async ({ timeout_seconds, download_pdf }) => workHistoryResult(await fetchWorkHistoryFromPage({ timeoutMs: (timeout_seconds ?? 300) * 1000, downloadPdf: download_pdf === true }))
);

server.registerTool(
  'read_latest_work_history_report',
  {
    title: 'Read latest saved work history report',
    description: 'Latest saved work history JSON in ~/Documents/HuellaContributiva, without opening the browser: returns ONLY the file name of the full JSON ' +
      'and the content of the anonymised JSON. If only an older PDF report exists it says so (its text is never returned).',
    inputSchema: {},
  },
  async () => workHistoryLatestResult(await workHistoryView())
);

server.registerTool(
  'get_contribution_bases_report',
  {
    title: 'Get contribution bases report',
    description:
      'Opens Google Chrome on Import@ss and downloads the contribution bases report ("Informe de bases de cotización"). The user picks their ' +
      'digital certificate in the macOS picker. Without from/to the complete (unfiltered) report is downloaded. With from/to (and optional ' +
      'chunk_years) the date filter is applied and one PDF per range is saved. PDFs go to ~/Documents/HuellaContributiva/contribution-bases-YYYY-MM-DD[-partN].pdf; ' +
      'their text is parsed locally into contribution-bases-YYYY-MM-DD.json (with identifying data) and .anon.json (without). Returns ONLY ' +
      '{ok, folder, fullJsonFile, pdfFiles, contributionBases} where contributionBases is the anonymised JSON (regime, employer, CCC and one compact ' +
      'array of monthly bases per year and section, plus computed totals).',
    inputSchema: {
      timeout_seconds: timeoutParam,
      from: z.string().optional().describe('Start date, DD/MM/YYYY or YYYY-MM-DD. Omit for the complete report.'),
      to: z.string().optional().describe('End date, DD/MM/YYYY, YYYY-MM-DD or "today" (default today when from is set).'),
      chunk_years: z.number().int().min(1).max(50).optional().describe('Split the from/to range into requests of at most this many years.'),
      keep_open: z.boolean().optional().describe('Keep the window open after the automatic download(s) and save any extra PDFs the user downloads until the window is closed or the timeout expires.'),
    },
  },
  async ({ timeout_seconds, from, to, chunk_years, keep_open }) => {
    try {
      const r = await fetchContributionBases({
        timeoutMs: (timeout_seconds ?? 300) * 1000, from, to, chunkYears: chunk_years, keepOpen: keep_open,
      });
      // ONLY the full JSON file name, PDF file names and the anonymised JSON (never the PDF text).
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, message: r.message }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...basesToolPayload(r) }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'read_latest_contribution_bases_report',
  {
    title: 'Read latest saved contribution bases report',
    description: 'Latest saved contribution bases report in ~/Documents/HuellaContributiva, without opening the browser: returns ONLY the file name of the ' +
      'full JSON, the PDF file names and the anonymised JSON (if only an older report text exists, the JSON pair is built from it first).',
    inputSchema: {},
  },
  async () => {
    const v = await basesView();
    return v.ok
      ? { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...v.payload }) }] }
      : { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, message: v.message }) }] };
  }
);

server.registerTool(
  'get_quota_calculations',
  {
    title: 'Get quota calculations',
    description:
      'Read-only. Opens Google Chrome on Import@ss, service "Consulta de cálculos de cuotas para trabajador" (monthly contribution quota ' +
      'calculations from liquidations filed by an employer through SLD / RED Directo). The user picks their digital certificate in the macOS picker. ' +
      'By default it only queries the months worked as an employee (any non-RETA regime), taken from the latest saved contribution bases report; ' +
      'one or more ranges (ranges, or from/to) and individual months (months) can be combined as a union in one browser session; ' +
      'if none is saved (or refresh_bases is true) the bases report is downloaded first in the same browser session. ' +
      'Saves a .txt/.html/.png snapshot per result page (and any PDF offered) to ~/Documents/HuellaContributiva/quota-calculation-YYYY-MM-DD-*, ' +
      'writes quota-calculation-YYYY-MM-DD.summary.csv/.summary.json and returns ONLY a compact table (one row per month/liquidation: ' +
      'type, employer id, base, worker quota, employer quota, total) plus per-employer and grand totals. Use detail for more. ' +
      'Never clicks anything that changes data. Can take several minutes (default timeout 20 min).',
    inputSchema: {
      timeout_seconds: z.number().int().min(60).max(3600).optional().describe('Maximum total time in seconds (default 1200).'),
      from: z.string().optional().describe('Optional filter: first month, MM/YYYY. With all_months the default is 05/2023.'),
      to: z.string().optional().describe('Optional filter: last month, MM/YYYY. With all_months the default is last month.'),
      refresh_bases: z.boolean().optional().describe('Download a fresh contribution bases report first (same browser session) instead of using the latest saved one.'),
      all_months: z.boolean().optional().describe('Query every month in the from/to range instead of only the employee months.'),
      ranges: rangesParam.describe('One or more month ranges, e.g. ["02/2018-12/2018", {"from":"01/2022","to":"06/2023"}]. Range months are limited to employee months unless all_months. from/to is a single extra range.'),
      months: z.array(z.string()).optional().describe('Individual months to query (MM/YYYY or YYYY-MM), even if they are not employee months. Alone: exactly these months; with ranges (or all_months): the union. One browser session.'),
      keep_open: z.boolean().optional().describe('After the automatic queries, keep saving a snapshot of every new result page the user opens until the window is closed or the timeout expires.'),
      manual: z.boolean().optional().describe('No automatic clicks: the user navigates and every new result page is saved.'),
      detail: detailParam,
    },
  },
  async ({ timeout_seconds, from, to, ranges, months, keep_open, manual, refresh_bases, all_months, detail }) => {
    try {
      const r = await fetchQuotaCalculations({
        timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined, from, to, keepOpen: keep_open, auto: !manual,
        refreshBases: refresh_bases, allMonths: all_months, ranges, months,
      });
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.message }] };
      const view = await quotaView({ detail: detail ?? 'summary', months: r.months.map((m) => m.period) });
      const note = r.notEmployee && r.notEmployee.length ? `\nnote: not employee months in the bases report (queried anyway): ${r.notEmployee.join(', ')}` : '';
      return { content: [{ type: 'text', text: `${r.message}${note}\n${view}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'read_latest_quota_calculations',
  {
    title: 'Read latest saved quota calculations',
    description:
      'Without opening the browser, re-parses the latest saved quota calculation snapshots and returns a compact table ' +
      '(one row per month/liquidation) plus per-employer and grand totals. Optional month filter and detail level; ' +
      'raw page text is never returned (detail="full" lists the local raw file names).',
    inputSchema: {
      detail: detailParam,
      from: z.string().optional().describe('Only months from this one, MM/YYYY or YYYY-MM.'),
      to: z.string().optional().describe('Only months up to this one, MM/YYYY or YYYY-MM.'),
      ranges: rangesParam.describe('Only months in any of these ranges ("MM/YYYY-MM/YYYY" strings or {from,to}).'),
      months: z.array(z.string()).optional().describe('Only these months (MM/YYYY or YYYY-MM). Filters are combined as a union.'),
      day: z.string().optional().describe('Capture day YYYY-MM-DD (default: latest).'),
    },
  },
  async ({ detail, from, to, ranges, months, day }) => {
    try {
      return { content: [{ type: 'text', text: await quotaView({ detail: detail ?? 'summary', from, to, ranges, months, day }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'get_paid_contributions_report',
  {
    title: 'Get paid contributions report (RETA)',
    description:
      'Opens Google Chrome on Import@ss ("Informe de cuotas ingresadas": bases and contributions paid in RETA / special regimes). The user picks ' +
      'their digital certificate in the macOS picker. The site issues the report per year, so one read-only query (plus the certified PDF) ' +
      'is made per year of the selected months, all in ONE browser session. Default selection: every self-employed month in the latest saved ' +
      'contribution bases report up to last month (downloaded first in the same session if none is saved, or with refresh_bases). ' +
      'ranges / from-to limit it to self-employed months in any range (every month with all_months); months adds individual months (union). ' +
      'Saves page snapshots and PDFs to ~/Documents/HuellaContributiva/paid-contribution-YYYY-MM-DD-<year>.*, writes paid-contribution.summary.csv/.json ' +
      'and returns ONLY a compact table (month, regime, base, quota, surcharge, total, payment date/status if shown) plus per-year and grand totals. ' +
      'Never clicks payments, direct debit, deferrals, refunds or any confirmation. Default timeout 10 min.',
    inputSchema: {
      timeout_seconds: z.number().int().min(60).max(3600).optional().describe('Maximum total time in seconds (default 600).'),
      from: z.string().optional().describe('Optional single range start, MM/YYYY or YYYY-MM.'),
      to: z.string().optional().describe('Optional single range end, MM/YYYY or YYYY-MM.'),
      ranges: rangesParam.describe('One or more month ranges, e.g. ["05/2023-12/2024", {"from":"2026-01"}]. Limited to self-employed months unless all_months.'),
      months: z.array(z.string()).optional().describe('Individual months (MM/YYYY or YYYY-MM), requested even if not self-employed months. Alone: exactly these; with ranges: the union.'),
      all_months: z.boolean().optional().describe('Every month of the ranges instead of only the self-employed months.'),
      refresh_bases: z.boolean().optional().describe('Download a fresh contribution bases report first (same browser session).'),
      keep_open: z.boolean().optional().describe('Afterwards keep saving every new result page / PDF the user opens until the window is closed.'),
      manual: z.boolean().optional().describe('No automatic clicks: the user navigates; result pages and PDFs are saved.'),
      detail: detailParam,
    },
  },
  async ({ timeout_seconds, from, to, ranges, months, all_months, refresh_bases, keep_open, manual, detail }) => {
    try {
      const r = await fetchPaidContributions({
        timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined, auto: !manual, from, to, ranges, months,
        allMonths: all_months, refreshBases: refresh_bases, keepOpen: keep_open,
      });
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.message }] };
      const note = r.notSelfEmployed && r.notSelfEmployed.length ? `\nnote: not self-employed months in the bases report (requested anyway): ${r.notSelfEmployed.join(', ')}` : '';
      const view = await paidView({ detail: detail ?? 'summary', months: r.months, expected: r.months });
      return { content: [{ type: 'text', text: `${r.message}${note}\n${view}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'read_latest_paid_contributions_report',
  {
    title: 'Read latest saved paid contributions report',
    description:
      'Without opening the browser, re-parses the saved paid contributions report ("Informe de cuotas ingresadas"; latest capture per year) ' +
      'and returns a compact table (month, regime, base, quota, surcharge, total, payment date/status if shown) plus per-year and grand totals. ' +
      'Optional month filters (union of from/to, ranges and months) and detail level; raw text is never returned (detail="full" lists the local raw file names).',
    inputSchema: {
      detail: detailParam,
      from: z.string().optional().describe('Only months from this one, MM/YYYY or YYYY-MM.'),
      to: z.string().optional().describe('Only months up to this one, MM/YYYY or YYYY-MM.'),
      ranges: rangesParam.describe('Only months in any of these ranges ("MM/YYYY-MM/YYYY" strings or {from,to}).'),
      months: z.array(z.string()).optional().describe('Only these months (MM/YYYY or YYYY-MM); months without a row are listed as missing.'),
      day: z.string().optional().describe('Only the capture of this day, YYYY-MM-DD (default: latest capture per year).'),
    },
  },
  async ({ detail, from, to, ranges, months, day }) => {
    try {
      return { content: [{ type: 'text', text: await paidView({ detail: detail ?? 'summary', from, to, ranges, months, day }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'get_contributions_report',
  {
    title: 'Get combined contributions report (who paid what, per month)',
    description:
      'Builds a combined JSON report of ALL Social Security contributions paid by the worker or his employers, from the data the other ' +
      'tools saved (no browser unless refresh=true): employee months from the quota calculations (per liquidation: worker share withheld ' +
      'from the payroll, employer share paid by the employer) and self-employed RETA months from the paid contributions report (paid ' +
      'directly by the worker) and SEPE certificates (worker contributions deducted from unemployment benefits, payer SEPE / public_agency) and the saved RETA annual regularisation (amount to pay = worker, positive; refund = TGSS, negative; RETA months get baseStatus provisional/superseded/definitive), cross-checked with the contribution bases and work history reports. One payment entry per (year, month, liquidation, payer) ' +
      'with regime, payer, CCC, channel, liquidation type, base, amount, surcharge and source file. Saves ' +
      '~/Documents/HuellaContributiva/combined-report-YYYY-MM-DD.json and returns, by default, only aggregates (by payer, year, regime, grand ' +
      'total), gaps and data-quality notes plus the file path; every entry only with include_payments=true.',
    inputSchema: {
      ranges: rangesParam.describe('Only months in any of these ranges ("MM/YYYY-MM/YYYY" strings or {from,to}).'),
      months: z.array(z.string()).optional().describe('Only these months (MM/YYYY or YYYY-MM); union with ranges.'),
      payer: z.enum(['all', 'worker', 'employer', 'public_agency']).optional().describe('Only payments by the worker (payroll withholding + RETA), by employers, or by a public agency (SEPE deductions from benefits). Default all.'),
      payer_name: z.string().optional().describe('Only payments whose payer/employer name contains this text.'),
      group_by: z.array(z.enum(['payer', 'year', 'year_payer', 'regime', 'month', 'all'])).optional().describe('Aggregates to print (default payer + year; grand total, gaps and notes are always included).'),
      include_payments: z.boolean().optional().describe('Also return every payment entry (one compact line each). Default false.'),
      refresh: z.boolean().optional().describe('First fetch the missing months (gaps) in ONE Chrome session (certificate needed), then rebuild. Default false (no browser).'),
    },
  },
  async ({ ranges, months, payer, payer_name, group_by, include_payments, refresh }) => {
    try {
      const r = await generateContributionsReport({ ranges, months, payer, payerName: payer_name, groupBy: group_by, includePayments: include_payments, refresh });
      return { content: [{ type: 'text', text: r.text }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'get_sepe_benefits_certificate',
  {
    title: 'Get SEPE unemployment benefit certificates',
    description:
      'Opens Google Chrome on the SEPE e-office (sede.sepe.gob.es, "Obtención de certificados"); the user picks their digital certificate in the ' +
      'macOS picker (Cl@ve gateway → DNIe / certificado electrónico). Downloads one "Certificado de importes anuales" per year (gross benefit, ' +
      'IRPF withheld, Social Security deduction; the site allows one per year per day) and optionally one "Certificado de importes por periodo" ' +
      '(max 12 months, one per day), all in ONE browser session. Default years: the unemployment benefit periods (e.g. ERTE) found in the saved ' +
      'work history report, else 2020. Always chooses "descargarlo desde internet"; never the postal option, never confirms anything, never ' +
      'touches requests, changes, de-registration, appointments, address, bank account or job-seeker renewal. Saves ~/Documents/HuellaContributiva/sepe-* ' +
      'and returns a compact summary (period, gross, IRPF, SS deducted, net).',
    inputSchema: {
      years: z.array(z.string()).optional().describe('Years for the annual certificates, e.g. ["2020"].'),
      ranges: rangesParam.describe('Month ranges; their years are requested.'),
      months: z.array(z.string()).optional().describe('Months (MM/YYYY or YYYY-MM); their years are requested.'),
      all_years: z.boolean().optional().describe('Every year from the first year of the bases report to this year.'),
      period: z.string().optional().describe('Also request a period certificate: "MM/YYYY-MM/YYYY" (max 12 months) or "auto" (first benefit period of the work history report).'),
      timeout_seconds: z.number().int().min(60).max(3600).optional().describe('Maximum total time in seconds (default 600).'),
      manual: z.boolean().optional().describe('No automatic clicks: the user navigates; every PDF is saved.'),
      keep_open: z.boolean().optional().describe('Afterwards keep saving every PDF the user downloads until the window is closed.'),
    },
  },
  async ({ years, ranges, months, all_years, period, timeout_seconds, manual, keep_open }) => {
    try {
      const r = await fetchSepeBenefits({ years, ranges, months, allYears: all_years, period, timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined, auto: !manual, keepOpen: keep_open });
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.message }] };
      return { content: [{ type: 'text', text: `${r.message}\n${await sepeView({})}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'get_reta_regularization',
  {
    title: 'Get the RETA annual regularisation (self-employed contributions)',
    description:
      'Opens Google Chrome on Import@ss (Seguridad Social); the user picks their digital certificate in the macOS picker. Reads the annual ' +
      'regularisation of self-employed (RETA) contributions (art. 308.1.c LGSS: provisional bases vs. the bases matching the real net income; ' +
      'result = refund, amount to pay, or no difference) from the "años anteriores" service. Strictly read-only: never ' +
      'keeps or changes a base, never pays, never generates a payment document, never asks a question or files a request, never touches bank ' +
      'accounts or representatives, never confirms or signs, and NEVER opens NOTESS/DEHú notifications (opening one counts as legal receipt). ' +
      'Automatic: goes to "años anteriores", parses the result card of every year and clicks only the allowlisted "Resolución <year>" ' +
      'download button per requested year (never the current-year query form). Every page is snapshotted and every PDF saved in ' +
      '~/Documents/HuellaContributiva/reta-regularisation-*; Chrome is closed afterwards unless keep_open.',
    inputSchema: {
      years: z.array(z.string()).optional().describe('Regularised years, e.g. ["2024"] (2023 or later, up to last year). Default: RETA years of the saved bases report.'),
      timeout_seconds: z.number().int().min(60).max(3600).optional().describe('Maximum total time in seconds (default 600).'),
      manual: z.boolean().optional().describe('No automatic clicks: the user navigates; every page and PDF is saved (recommended the first time).'),
      keep_open: z.boolean().optional().describe('Afterwards keep saving pages/PDFs until the window is closed.'),
    },
  },
  async ({ years, timeout_seconds, manual, keep_open }) => {
    try {
      const r = await fetchRetaRegularization({ years, timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined, auto: !manual, keepOpen: keep_open });
      return { isError: !r.ok, content: [{ type: 'text', text: `${r.message}\n${await regularizationView({})}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'read_latest_reta_regularization',
  {
    title: 'Read the saved RETA annual regularisation',
    description: 'Without opening the browser, re-parses the saved regularisation pages/PDFs (latest result per year) and returns year, status ' +
      '(refund | claim | no-difference | not-regularisable | pending | unknown), amount, due/refund date, payment status and the years still to check.',
    inputSchema: {
      years: z.array(z.string()).optional().describe('Only these years.'),
      detail: z.enum(['summary', 'full']).optional().describe('full also lists rawFiles: the local raw file names (raw text stays local, never returned).'),
    },
  },
  async ({ years, detail }) => {
    try {
      return { content: [{ type: 'text', text: await regularizationView({ years, detail: detail ?? 'summary' }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'read_latest_sepe_benefits',
  {
    title: 'Read saved SEPE benefit certificates',
    description: 'Without opening the browser, re-parses the saved SEPE certificates (latest per year/period) and returns a compact summary ' +
      '(period, gross benefit, IRPF withheld, Social Security deduction, net) plus the benefit periods (ERTE…) of the work history report.',
    inputSchema: {
      years: z.array(z.string()).optional().describe('Only these years.'),
      detail: z.enum(['summary', 'full']).optional().describe('full also lists rawFiles: the local certificate file names (raw text stays local, never returned).'),
    },
  },
  async ({ years, detail }) => {
    try {
      return { content: [{ type: 'text', text: await sepeView({ years, detail: detail ?? 'summary' }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'get_contributions_dashboard',
  {
    title: 'Contributions dashboard (local HTML)',
    description: 'Writes a self-contained local HTML dashboard (opens from file://, no server, no network) with the latest saved combined ' +
      'contributions report embedded: KPI cards (worker, employers, SEPE, total), Sankey flow, drill-down by payer type / payer / regime / ' +
      'year / month / share / concept, stacked timeline, notes and gaps, movements table. No browser automation. Returns file names (folder ~/Documents/HuellaContributiva).',
    inputSchema: {
      report_path: z.string().optional().describe('A combined-report-*.json file name in ~/Documents/HuellaContributiva to embed (default: the latest saved unfiltered report).'),
      regenerate: z.boolean().optional().describe('Rebuild the contributions report from saved data first (no browser).'),
      open: z.boolean().optional().describe('Open the dashboard in the default browser.'),
    },
  },
  async ({ report_path, regenerate, open }) => {
    try {
      const r = await generateDashboard({ reportPath: report_path, regenerate, open });
      return { content: [{ type: 'text', text: `${r.message}\nfolder: ${OUTPUT_DIR_LABEL}\ndashboard: ${fileName(r.filePath)}\nEmpty template: ${fileName(r.templatePath)}\nReport: ${fileName(r.reportPath)} (grand total ${r.grandTotal})` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'refresh_all_and_dashboard',
  {
    title: 'Refresh everything and build the dashboard',
    description: 'One call for everything. In ONE headful Chrome session (the user picks the certificate in the system dialog; the SEPE ' +
      'site may ask again) it fetches only what is missing or stale, in this order: contribution bases, work history, quota calculations, ' +
      'paid contributions, RETA regularisation, SEPE certificates; then builds the combined report, writes the local dashboard and opens it ' +
      'in the browser (unless open=false). Read-only, reusing the existing fetchers and their blocklists (never pays, confirms, submits, ' +
      'changes data, acts as a representative or opens notifications). A failed step does not stop the others. Stale: bases / work history ' +
      `saved more than max_age_days ago (default ${DEFAULT_MAX_AGE_DAYS}); quotas: employee months without a quota calculation; paid: ` +
      'self-employed months missing from the paid report (not the month just finished); regularisation: years without a final result; ' +
      'SEPE: benefit years without an annual certificate. Use dry_run=true first to see the plan without opening Chrome. Returns one line per ' +
      'step (ok / skipped / failed + reason, file names only) and the report and dashboard file names (folder ~/Documents/HuellaContributiva).',
    inputSchema: {
      dry_run: z.boolean().optional().describe('Only print the plan (no browser, no fetch). Default false.'),
      force: z.boolean().optional().describe('Refetch every step regardless of staleness. Default false.'),
      only: z.array(z.enum(['bases', 'work-history', 'quotas', 'paid', 'regularisation', 'sepe'])).optional().describe('Run only these steps.'),
      skip: z.array(z.enum(['bases', 'work-history', 'quotas', 'paid', 'regularisation', 'sepe'])).optional().describe('Skip these steps.'),
      max_age_days: z.number().int().min(0).optional().describe(`Bases / work history older than this many days are refetched (default ${DEFAULT_MAX_AGE_DAYS}).`),
      open: z.boolean().optional().describe('Open the dashboard in the default browser when done. Default true.'),
    },
  },
  async ({ dry_run, force, only, skip, max_age_days, open }) => {
    try {
      const r = await refreshAll({ dryRun: dry_run, force, only, skip, maxAgeDays: max_age_days ?? DEFAULT_MAX_AGE_DAYS, open: open ?? true });
      return { ...(r.ok ? {} : { isError: true }), content: [{ type: 'text', text: formatRefreshAll(r) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

await server.connect(new StdioServerTransport());
console.error('[huella-contributiva] MCP server ready (stdio)');
