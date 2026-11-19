// Pure parser for the text extracted from the "Informe de bases de cotización" PDF.
// No browser, no I/O. The Spanish strings below match the report's own labels.
//
// Report layout (one section per regime + employer):
//   Régimen: GENERAL Empresa/Razón Social: EXAMPLE COMPANY, S.L. CCC: 00000000000
//   Enero Febrero ... Diciembre
//   2023 4.495,50 4.495,50 ... --- ---
// Cell values: an amount ("4.495,50", optionally "*" = provisional), "---" (no
// registration with that employer that month), "Sin base registrada" (registered
// without a recorded base) or "Pendiente de actualizar" (not available yet).

import { redactDeep } from './anonymize.js';

const SECTION_RE = /R[ée]gimen:\s*(.+?)\s+Empresa\/Raz[óo]n Social:\s*(.+?)(?:\s+CCC:\s*(\d+))?\s*$/i;
const YEAR_ROW_RE = /^\s*((?:19|20)\d{2})\s+(.+)$/;
const CELL_RE = /(\d{1,3}(?:\.\d{3})*,\d{2}\*?|---|Sin base registrada|Pendiente de actualizar)/gi;
// Self-employed regimes (RETA, incl. "TRABAJADOR AUTONOMO" and the sea workers' self-employed scheme).
const SELF_EMPLOYED_RE = /aut[óo]nomo|\bRETA\b|trab\.?\s*aut|cuenta propia/i;

const pad = (n) => String(n).padStart(2, '0');

/** Parses the report text into sections with per-month cells. */
export function parseBasesReport(text) {
  const sections = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const sec = SECTION_RE.exec(line);
    if (sec) {
      const [, regime, employer, ccc] = sec;
      current = {
        regime: regime.trim(),
        employer: employer.trim(),
        ccc: ccc || null,
        selfEmployed: SELF_EMPLOYED_RE.test(regime) || SELF_EMPLOYED_RE.test(employer),
        months: [],
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const row = YEAR_ROW_RE.exec(line);
    if (!row) continue;
    const cells = row[2].match(CELL_RE);
    if (!cells || !cells.length || cells.length > 12) continue;
    const year = Number(row[1]);
    // Cells are listed from January onwards; trailing future months may be missing.
    cells.forEach((cell, i) => {
      const status = cell === '---' ? 'none'
        : /^sin base/i.test(cell) ? 'no-base'
          : /^pendiente/i.test(cell) ? 'pending'
            : 'base';
      const base = status === 'base' ? Number(cell.replace(/\*$/, '').replace(/\./g, '').replace(',', '.')) : null;
      current.months.push({ year, month: i + 1, status, base, provisional: cell.endsWith('*') });
    });
  }
  return { sections };
}

/**
 * Months with an employee registration (any regime that is not self-employed), sorted
 * and de-duplicated. A month counts if it has a base or "Sin base registrada".
 * Returns [{ year, month, label: 'YYYY-MM', period: 'MM/YYYY', employers: [{ employer, ccc, regime, base }] }].
 */
export function employeeMonths(parsed) {
  const byKey = new Map();
  for (const s of parsed.sections) {
    if (s.selfEmployed) continue;
    for (const m of s.months) {
      if (m.status !== 'base' && m.status !== 'no-base') continue;
      const label = `${m.year}-${pad(m.month)}`;
      if (!byKey.has(label)) byKey.set(label, { year: m.year, month: m.month, label, period: `${pad(m.month)}/${m.year}`, employers: [] });
      byKey.get(label).employers.push({ employer: s.employer, ccc: s.ccc, regime: s.regime, base: m.base });
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Groups consecutive months per employer into human-readable ranges (for logs/reports). */
export function summarizeEmployeeMonths(months) {
  const ranges = [];
  const key = (e) => `${e.employer}|${e.ccc}`;
  const employers = new Map();
  for (const m of months) for (const e of m.employers) {
    if (!employers.has(key(e))) employers.set(key(e), { employer: e.employer, ccc: e.ccc, months: [] });
    employers.get(key(e)).months.push(m);
  }
  for (const { employer, ccc, months: ms } of employers.values()) {
    let start = ms[0];
    let prev = ms[0];
    const idx = (m) => m.year * 12 + m.month;
    for (const m of ms.slice(1).concat([null])) {
      if (m && idx(m) === idx(prev) + 1) { prev = m; continue; }
      ranges.push({ employer, ccc, from: start.period, to: prev.period, count: idx(prev) - idx(start) + 1 });
      if (m) { start = m; prev = m; }
    }
  }
  return ranges.sort((a, b) => a.from.split('/').reverse().join('').localeCompare(b.from.split('/').reverse().join('')));
}

/** "EXAMPLE COMPANY, S.L. (CCC 00000000000); ..." */
export const employersLabel = (m) => (m.employers || []).map((e) => `${e.employer}${e.ccc ? ` (CCC ${e.ccc})` : ''}`).join('; ');

/**
 * Months registered in a self-employed regime (RETA etc.): base, "Sin base registrada" or
 * "Pendiente de actualizar". Sorted, de-duplicated.
 * Returns [{ year, month, label, period, regimes: [string], base }] plus `lastReportMonth`
 * (latest month with any data in the whole report, 'YYYY-MM') and `activeAtEnd` (the
 * self-employed registration is still present in that month).
 */
export function selfEmployedMonths(parsed) {
  const byKey = new Map();
  let last = null;
  for (const s of parsed.sections) {
    for (const m of s.months) {
      if (m.status === 'none') continue;
      const label = `${m.year}-${pad(m.month)}`;
      if (!last || label > last) last = label;
      if (!s.selfEmployed) continue;
      if (!byKey.has(label)) byKey.set(label, { year: m.year, month: m.month, label, period: `${pad(m.month)}/${m.year}`, regimes: [], base: null });
      const e = byKey.get(label);
      if (!e.regimes.includes(s.regime)) e.regimes.push(s.regime);
      if (m.base !== null && e.base === null) e.base = m.base;
    }
  }
  const months = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { months, lastReportMonth: last, activeAtEnd: Boolean(months.length && months.at(-1).label === last) };
}

// --- Structured JSON (full + anonymised) -------------------------------------------------

export const BASES_SCHEMA_VERSION = 1;
const isoDate = (d) => { const m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(d || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const monthIso = (mmYyyy) => { const m = /^(\d{2})\/(\d{4})$/.exec(mmYyyy || ''); return m ? `${m[2]}-${m[1]}` : null; };
// "Apellidos y Nombre | Nº Seg. Social | Doc. identificativo | Periodo informe" values line (report header).
const IDENTITY_LINE_RE = /^(.+?)\s+(\d{2}\s?\d{8}\s?\d{2}|\d{10,12})\s+(DNI|NIE|NIF|Pasaporte|PAS|[A-Za-z.]{2,12}):\s*(\S+)\s+(\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{4})\s*$/i;

/**
 * Header data of one report text (one PDF part): identity values and metadata.
 * identity: fullName, socialSecurityNumber, idDocument, idDocumentType, verificationCode (the document's
 * "Código" lets anyone retrieve it, so it is treated as identifying).
 * meta: title, issueDate, verifiableUntil, requestedFrom/To ('YYYY-MM'), pages.
 */
export function parseBasesHeader(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
  const identity = { fullName: null, socialSecurityNumber: null, idDocument: null, idDocumentType: null, verificationCode: null };
  const meta = { title: null, issueDate: null, verifiableUntil: null, requestedFrom: null, requestedTo: null, pages: null };
  let pages = 0;
  for (const line of lines) {
    if (!meta.title && /^INFORME .*BASES DE COTIZACI/i.test(line)) meta.title = line;
    const code = /^C[óo]digo:\s*(\S+)\s+Fecha:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(line);
    if (code && !identity.verificationCode) { identity.verificationCode = code[1]; meta.issueDate = isoDate(code[2]); }
    const until = /comprobada hasta la fecha\s+(\d{2}\/\d{2}\/\d{4})/i.exec(line);
    if (until && !meta.verifiableUntil) meta.verifiableUntil = isoDate(until[1]);
    const pg = /^P[áa]gina\s+\d+\s+de\s+(\d+)/i.exec(line);
    if (pg) pages = Math.max(pages, Number(pg[1]));
    const id = IDENTITY_LINE_RE.exec(line);
    if (id && !identity.fullName) {
      identity.fullName = id[1].trim();
      identity.socialSecurityNumber = id[2].replace(/\s/g, '');
      identity.idDocumentType = id[3].toUpperCase();
      identity.idDocument = id[4];
      meta.requestedFrom = monthIso(id[5]);
      meta.requestedTo = monthIso(id[6]);
    }
  }
  meta.pages = pages || null;
  return { identity, meta };
}

const round2 = (n) => Math.round(n * 100) / 100;
const ym = (m) => `${m.year}-${pad(m.month)}`;

/** Computed totals (the report itself prints no totals). */
export function basesTotals(sections) {
  const per = sections.map((s) => {
    const withBase = s.months.filter((m) => m.status === 'base');
    const active = s.months.filter((m) => m.status !== 'none');
    return {
      regime: s.regime, employer: s.employer, ccc: s.ccc, selfEmployed: s.selfEmployed,
      firstMonth: active.length ? ym(active[0]) : null, lastMonth: active.length ? ym(active.at(-1)) : null,
      monthsWithBase: withBase.length, monthsNoBase: s.months.filter((m) => m.status === 'no-base').length,
      monthsPending: s.months.filter((m) => m.status === 'pending').length, provisionalMonths: s.months.filter((m) => m.provisional).length,
      sumBases: round2(withBase.reduce((a, m) => a + m.base, 0)),
    };
  });
  const byYear = {};
  for (const s of sections) for (const m of s.months) if (m.status === 'base') byYear[m.year] = round2((byYear[m.year] || 0) + m.base);
  const emp = employeeMonths({ sections }); const se = selfEmployedMonths({ sections });
  return {
    sections: per, byYear,
    sumBases: round2(per.reduce((a, s) => a + s.sumBases, 0)),
    employeeMonths: emp.length, selfEmployedMonths: se.months.length, lastReportMonth: se.lastReportMonth, selfEmployedActiveAtEnd: se.activeAtEnd,
  };
}

/**
 * Full JSON (with identifying data) from the text of every downloaded part.
 * parts: [{ text, pdfPath, txtPath }]. Sections keep the parseBasesReport shape (consumers use them directly)
 * plus the part number.
 */
export function buildBasesJson(parts, { fetchedAt = null } = {}) {
  const sections = []; const partInfo = []; let identity = null;
  parts.forEach((p, i) => {
    const h = parseBasesHeader(p.text);
    if (!identity || (!identity.fullName && h.identity.fullName)) identity = { ...h.identity };
    const parsed = parseBasesReport(p.text);
    for (const s of parsed.sections) sections.push({ ...s, part: i + 1 });
    partInfo.push({ part: i + 1, pdfPath: p.pdfPath || null, txtPath: p.txtPath || null, ...h.meta, sections: parsed.sections.length, verificationCode: h.identity.verificationCode });
  });
  const extraCodes = partInfo.map((p) => p.verificationCode).filter((c) => c && c !== (identity && identity.verificationCode));
  const ranges = partInfo.filter((p) => p.requestedFrom || p.requestedTo);
  return {
    schemaVersion: BASES_SCHEMA_VERSION,
    kind: 'contribution-bases',
    source: {
      report: 'Informe de bases de cotización', method: 'pdf-text', fetchedAt,
      issueDate: partInfo.map((p) => p.issueDate).filter(Boolean).sort().at(-1) || null,
      requestedFrom: ranges.map((p) => p.requestedFrom).filter(Boolean).sort()[0] || null,
      requestedTo: ranges.map((p) => p.requestedTo).filter(Boolean).sort().at(-1) || null,
      parts: partInfo.map(({ verificationCode, ...rest }) => rest),
    },
    identity: { ...(identity || {}), otherVerificationCodes: extraCodes.length ? extraCodes : undefined, sources: { all: 'report header' } },
    legend: {
      base: 'monthly contribution base in EUR as printed in the report (one base per month and employer; the report has no split by contingency and no days)',
      none: '"---": no registration with that employer that month',
      'no-base': '"Sin base registrada": registered without a recorded base, or excluded from contributions',
      pending: '"Pendiente de actualizar": not available yet',
      provisional: '"*": provisional base, pending regularisation',
    },
    regimes: [...new Set(sections.map((s) => s.regime))],
    employers: [...new Map(sections.filter((s) => s.ccc || !s.selfEmployed).map((s) => [`${s.employer}|${s.ccc}`, { name: s.employer, ccc: s.ccc, regime: s.regime }])).values()],
    sections,
    totals: basesTotals(sections),
  };
}

/** The parsed shape the month selections use ({ sections }), from a full/anon JSON or a report text. */
export function toParsedBases(input) {
  if (!input) return null;
  if (typeof input === 'string') return parseBasesReport(input);
  if (Array.isArray(input.sections) && input.sections.every((s) => Array.isArray(s.months))) return { sections: input.sections };
  if (Array.isArray(input.sections)) return { sections: input.sections.map(expandCompactSection) };
  return null;
}

// Compact month cells for the anonymised copy: number = base, "1234.56*" = provisional base,
// null = "---", "no-base", "pending". One array per year, January first.
const compactCell = (m) => (m.status === 'base' ? (m.provisional ? `${m.base}*` : m.base) : m.status === 'none' ? null : m.status);
function expandCompactSection(s) {
  const months = [];
  for (const [year, cells] of Object.entries(s.years || {})) cells.forEach((c, i) => {
    const prov = typeof c === 'string' && c.endsWith('*');
    const status = c === null ? 'none' : c === 'no-base' ? 'no-base' : c === 'pending' ? 'pending' : 'base';
    months.push({ year: Number(year), month: i + 1, status, base: status === 'base' ? Number(String(c).replace(/\*$/, '')) : null, provisional: prov });
  });
  const { years, ...rest } = s;
  return { ...rest, months };
}

/** Pure: anonymised, compact copy of the full JSON (no identity; companies, CCCs, months and bases kept). */
export function anonymizeBases(full) {
  const { identity, sections, ...rest } = full;
  const compact = sections.map(({ months, ...s }) => {
    const years = {};
    for (const m of months) { (years[m.year] ||= []); years[m.year][m.month - 1] = compactCell(m); }
    for (const y of Object.keys(years)) years[y] = Array.from(years[y], (v) => (v === undefined ? null : v));
    return { ...s, years };
  });
  const out = redactDeep({ ...rest, sections: compact }, identity);
  out.monthCells = 'sections[].years: one array per year, January first; number = base, "N*" = provisional base, null = "---", "no-base", "pending"';
  out.anonymized = true;
  out.removed = ['identity (full name, ID document, Social Security number, document verification code)'];
  return out;
}

export { isAnonymized as isBasesAnonymized } from './anonymize.js';
