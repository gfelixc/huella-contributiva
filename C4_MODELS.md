# Huella Contributiva — C4 models

Architecture of [Huella Contributiva](README.md) described with the [C4 model](https://c4model.com/): system context,
containers, components, and two dynamic views: one fetch and the one-command refresh. What reaches the LLM and what stays local is summarised in
the README section [What reaches the LLM and what stays local](README.md#what-reaches-the-llm-and-what-stays-local).

## Overview
The diagrams follow the [C4 model](https://c4model.com/) and are written as Mermaid flowcharts (GitHub renders them).
`<user>` stands for the macOS account name; it never appears in tool output.

## Level 1: System context
The User works with the tool through the CLI, or through an AI assistant acting as an MCP client. The tool runs only
on the User's Mac. It reaches the government e-offices through a local Google Chrome window over HTTPS, read-only.
Authentication uses the User's own certificate from the macOS Keychain, picked by the User in the system dialog. The AI
assistant (and the LLM behind it) receives only anonymised JSON, compact tables and file names.

```mermaid
flowchart TB
  user["User<br/>(certificate holder)"]
  assistant["AI assistant / LLM<br/>(MCP client)"]
  tool["Huella Contributiva<br/>local tool: CLI + MCP server"]
  keychain["macOS Keychain<br/>User's digital certificate"]
  files[("~/Documents/HuellaContributiva<br/>full data, local only")]
  ss["Social Security e-office<br/>Import@ss / ProsaInternet<br/>work history, bases, quotas,<br/>paid contributions, RETA regularisation"]
  sepe["SEPE e-office<br/>benefit certificates"]
  clave["Cl@ve gateway<br/>certificate authentication"]

  user -->|"asks questions"| assistant
  user -->|"runs CLI commands, opens the dashboard"| tool
  assistant -->|"MCP tool calls (stdio)"| tool
  tool -->|"anonymised JSON, compact tables, file names only"| assistant
  user -->|"picks the certificate in the system dialog"| keychain
  keychain -->|"TLS client certificate, used by Chrome"| tool
  tool -->|"read-only HTTPS via Chrome"| ss
  tool -->|"read-only HTTPS via Chrome"| sepe
  ss -->|"login redirect"| clave
  sepe -->|"login redirect"| clave
  tool -->|"writes full JSON, PDFs, snapshots, summaries"| files
```

## Level 2: Containers
Two entry points, the CLI and the stdio MCP server, share the core modules in `src/`. Every MCP response passes
through the server's output guard; the CLI prints through the same sanitiser. Browser steps run in the installed
Google Chrome driven by Playwright (`playwright-core`) with a persistent profile. Everything else (parsing, JSON
building, the combined report, the dashboard) works on the saved files without a browser.

```mermaid
flowchart LR
  user["User"]
  assistant["AI assistant / LLM<br/>(MCP client)"]

  subgraph tool["Huella Contributiva (Node.js, local)"]
    cli["CLI<br/>cli.js"]
    mcp["MCP server<br/>server.js, stdio, 15 tools"]
    guard["Output guard<br/>sanitizeToolResult (paths.js)<br/>file names only"]
    orch["Orchestrator<br/>src/refreshAll.js<br/>one Chrome session, missing/stale only"]
    core["Core modules<br/>src/"]
  end

  chrome["Google Chrome<br/>driven by Playwright<br/>profile .chrome-profile"]
  portals["Government e-offices<br/>Social Security, SEPE, Cl@ve"]
  full[("Full data<br/>full JSON, PDF, TXT, HTML, PNG,<br/>CSV/JSON summaries, manifests")]
  anonf[("Anonymised JSON<br/>*.anon.json")]
  report[("Combined report<br/>combined-report-*.json")]
  dash["Dashboard<br/>dashboard-*.html<br/>self-contained, file://"]

  user --> cli
  assistant -->|"stdio JSON-RPC"| mcp
  mcp --> core
  cli --> core
  cli -->|"refresh-all"| orch
  mcp -->|"refresh_all_and_dashboard"| orch
  orch -->|"fetchers, report, dashboard"| core
  core -->|"tool result text"| guard
  guard -->|"sanitised response"| assistant
  core -->|"launches, navigates, captures PDFs"| chrome
  chrome -->|"read-only HTTPS"| portals
  core -->|"writes"| full
  core -->|"writes (leak-checked)"| anonf
  full -->|"parsed, no browser"| core
  core -->|"writes"| report
  core -->|"embeds report"| dash
  report -.->|"file picker or drag and drop"| dash
  user -->|"opens in a browser"| dash
```

All three groups live in `~/Documents/HuellaContributiva`; they are split above only to show what may reach the LLM: the
anonymised JSON content, compact summaries computed from the files, and file names. Raw page/PDF text and the full
JSON stay local.

## Level 3: Components
- Entry points: `cli.js` (commands, prints through `sanitizePaths`) and `server.js` (15 tools; its `registerTool`
  wrapper passes every result and thrown error through `sanitizeToolResult`).
- Browser layer: `importass.js` (Chrome launch, certificate login steps, guarded clicks with blocklists, PDF capture,
  report definitions, the bases PDF flow) — used by every live fetcher.
- Work history: `workHistoryPage.js` (page flow, JSON pair, `loadWorkHistory()`, `workHistoryView()`, tool payload) and
  `workHistoryParser.js` (pure: page HTML → full JSON, PDF identity, anonymised copy, benefit periods).
  `workHistory.js` re-exports `importass.js` and both modules.
- Contribution bases: `basesReport.js` (download wrapper, JSON pair, `loadContributionBases()`, `basesView()`, tool
  payload) and `basesParser.js` (pure: report text → sections, header identity, totals, compact anonymised copy,
  employee and self-employed months).
- Privacy helpers: `anonymize.js` (identity tokens, deep redaction, leak check) and `paths.js` (path sanitiser,
  `rawFiles`, `sanitizeToolResult`).
- Fetchers + pure parsers: `quotas.js` + `quotaParser.js`, `paidQuotas.js` + `paidParser.js`, `sepe.js` + `sepeParser.js`,
  `regularization.js` + `regularizationParser.js`.
- Orchestrator: `refreshAll.js` (`refresh-all` / `refresh_all_and_dashboard`): reads the saved state, plans each step
  (missing or stale only), runs the existing fetchers in one shared Chrome context, then the combined report and the
  dashboard. It re-plans each step just before running it, because earlier steps change the later plans.
- Report and dashboard: `contributionsReport.js` (merge, dedupe, gaps, notes, reconciliation, aggregates) and
  `dashboard.js` (concept enrichment, inlines `dashboard/template.html`, `style.css`, `model.cjs`, `app.js`).

Data dependencies:
- The FULL bases JSON (`loadContributionBases()`) gives the employee months for the quota calculations, the
  self-employed (RETA) months for the paid contributions report, the RETA years (from 2023) for the regularisation and
  the first year for SEPE `--all-years`; the combined report uses it for expected months and reference bases.
- The FULL work history JSON (`loadWorkHistory()`) gives the unemployment benefit periods (ERTE): the default SEPE
  years and the benefit months of the combined report. If only an older work history PDF text is saved, its text is
  parsed as a fallback.
- The regularisation reads the paid contributions summary as payment evidence.
- All saved results feed the combined report; the dashboard embeds that report and re-parses the quota snapshots
  for the concept lines.
- Every module that names a file in its output uses `paths.js` (`fileName`, `OUTPUT_DIR_LABEL`); the fetchers with a
  `detail="full"` mode also use `rawFilesFor` / `rawFilesBlock`. Only the `rawFiles` edges are drawn below.

```mermaid
flowchart TB
  subgraph entry["Entry points"]
    cli["cli.js<br/>prints via sanitizePaths"]
    mcp["server.js<br/>15 tools"]
    guard["registerTool wrapper<br/>sanitizeToolResult"]
  end

  subgraph browser["Browser layer"]
    importass["importass.js<br/>Chrome launch, certificate login,<br/>guarded clicks, PDF capture,<br/>bases PDF flow"]
  end

  subgraph wh["Work history"]
    whpage["workHistoryPage.js<br/>page flow, JSON pair,<br/>loadWorkHistory, tool payload"]
    whparser["workHistoryParser.js<br/>page HTML → full JSON,<br/>anonymised JSON, benefit periods"]
    whre["workHistory.js<br/>re-exports"]
  end

  subgraph basesg["Contribution bases"]
    basesrep["basesReport.js<br/>download wrapper, JSON pair,<br/>loadContributionBases, tool payload"]
    bases["basesParser.js<br/>text → sections, identity,<br/>totals, compact anon copy, months"]
  end

  subgraph privacy["Privacy helpers"]
    anon["anonymize.js<br/>identity tokens, redaction,<br/>leak check"]
    paths["paths.js<br/>path sanitiser, rawFiles"]
  end

  subgraph fetchers["Fetchers and parsers"]
    quotas["quotas.js + quotaParser.js<br/>quota calculations"]
    paid["paidQuotas.js + paidParser.js<br/>paid contributions (RETA)"]
    sepe["sepe.js + sepeParser.js<br/>SEPE certificates"]
    reg["regularization.js + regularizationParser.js<br/>RETA regularisation"]
  end

  subgraph orchg["Orchestrator"]
    orch["refreshAll.js<br/>plan (missing/stale), one Chrome context,<br/>step summary"]
  end

  subgraph outputs["Report and dashboard"]
    report["contributionsReport.js<br/>merge, gaps, notes, reconciliation"]
    dashjs["dashboard.js<br/>concept enrichment, inlining"]
    dashsrc["dashboard/<br/>template.html, style.css,<br/>model.cjs, app.js"]
  end

  mcp --> guard
  guard -->|"uses"| paths
  cli -->|"uses"| paths
  cli --> whpage
  cli --> basesrep
  cli --> quotas
  cli --> paid
  cli --> sepe
  cli --> reg
  cli --> report
  cli --> dashjs
  mcp --> whpage
  mcp --> basesrep
  mcp --> quotas
  mcp --> paid
  mcp --> sepe
  mcp --> reg
  mcp --> report
  mcp --> dashjs
  cli -->|"refresh-all"| orch
  mcp -->|"refresh_all_and_dashboard"| orch
  orch -->|"launchChrome (once)"| importass
  orch -->|"shared context"| basesrep
  orch -->|"shared context"| whpage
  orch -->|"shared context, months"| quotas
  orch -->|"shared context, months"| paid
  orch -->|"shared context, years"| reg
  orch -->|"shared context, years"| sepe
  orch -->|"loadSaved, buildFromSaved: gaps"| report
  orch -->|"generateDashboard"| dashjs
  whre -.-> importass
  whre -.-> whpage
  whre -.-> whparser

  whpage --> importass
  basesrep --> importass
  quotas --> importass
  paid --> importass
  sepe --> importass
  reg --> importass

  whpage -->|"page HTML"| whparser
  basesrep -->|"report text"| bases
  whparser -->|"redaction, leak check"| anon
  bases -->|"redaction, leak check"| anon
  quotas -->|"rawFiles, file names"| paths
  paid -->|"rawFiles, file names"| paths
  sepe -->|"rawFiles, file names"| paths
  reg -->|"rawFiles, file names"| paths

  basesrep -->|"full JSON: employee months"| quotas
  basesrep -->|"full JSON: RETA months"| paid
  basesrep -->|"full JSON: RETA years"| reg
  basesrep -->|"full JSON: first year"| sepe
  basesrep -->|"full JSON: expected months, bases"| report
  whpage -->|"full JSON: benefit periods"| sepe
  whpage -->|"full JSON: benefit periods"| report
  quotas -->|"quota records"| report
  paid -->|"paid records"| report
  sepe -->|"SEPE records"| report
  reg -->|"claims, refunds, base status"| report
  paid -->|"paid records: payment evidence"| reg
  whpage -.->|"parseBenefitPeriods (old PDF text fallback)"| sepe
  dashjs -.->|"parseQuotaSnapshot: concept lines"| quotas
  report -->|"combined-report-*.json"| dashjs
  dashsrc -->|"inlined into one HTML file"| dashjs
```

## Dynamic view: `get_work_history_report`
```mermaid
sequenceDiagram
  autonumber
  participant A as AI assistant (MCP client)
  participant S as server.js + output guard
  participant W as workHistoryPage.js
  participant C as Chrome (importass.js)
  participant P as Import@ss
  participant X as workHistoryParser.js + anonymize.js
  participant F as ~/Documents/HuellaContributiva

  A->>S: tools/call get_work_history_report {download_pdf?}
  S->>W: fetchWorkHistoryFromPage
  W->>C: launch Chrome (persistent profile)
  C->>P: info page, "Consultar vida laboral", certificate login
  P-->>C: service page datosvidalaboral
  W->>C: expand period rows (accordion buttons only), next page if "1 de N"
  C-->>W: page HTML
  W->>F: snapshot work-history-YYYY-MM-DD-page.txt/.html/.png
  W->>X: parse each page's HTML, merge the pages (full JSON)
  opt download_pdf true (explicit request only)
    W->>C: click "Descargar vida laboral"
    C-->>W: PDF
    W->>F: work-history-YYYY-MM-DD.pdf/.txt
    W->>X: identity from the PDF text into the full JSON
  end
  W->>X: anonymise, leak check (nothing is written if it fails)
  W->>F: work-history-YYYY-MM-DD.json (full) + .anon.json
  W->>C: close Chrome (always, also on errors)
  W-->>S: file names + anonymised JSON
  S-->>A: {ok, folder, fullJsonFile, [pdfFile], workHistory} after sanitizeToolResult
```

## Dynamic view: `refresh_all_and_dashboard` / `refresh-all`
```mermaid
sequenceDiagram
  autonumber
  participant A as User (CLI) or AI assistant (MCP)
  participant O as refreshAll.js
  participant F as ~/Documents/HuellaContributiva
  participant R as contributionsReport.js + loaders
  participant C as Chrome (importass.js)
  participant X as Fetchers (bases, work history, quotas, paid, regularisation, SEPE)
  participant D as dashboard.js

  A->>O: refresh-all {force?, only?, skip?, max age?, dry run?, open?}
  loop each step in order: bases, work history, quotas, paid, regularisation, SEPE
    O->>R: collectState (saved files only, no browser)
    R->>F: read saved JSON, summaries, manifests
    R-->>O: saved dates, gap months, regularisation statuses, benefit years
    O->>O: planStep: fetch (missing or stale) or skip
    opt fetch and not a dry run
      O->>C: launch Chrome once (first fetch only, the User picks the certificate)
      O->>C: tidy up (close extra tabs, first tab to about:blank)
      O->>X: fetcher({context, months or years})
      X->>C: read-only navigation (blocklists, no submit)
      X->>F: full files + anonymised JSON
      X-->>O: ok or failed (+ file names), a failure does not stop the loop
    end
  end
  O->>C: close Chrome (always, also on errors)
  opt not a dry run
    O->>R: generateContributionsReport
    R->>F: combined-report-YYYY-MM-DD.json
    O->>D: generateDashboard {report, open}
    D->>F: dashboard-YYYY-MM-DD.html (opened in the browser unless --no-open)
  end
  O-->>A: one line per step (ok / skipped / failed / planned + reason), report and dashboard file names
```
