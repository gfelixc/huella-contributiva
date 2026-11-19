// Pure parsers for the work history ("vida laboral"). No browser, no I/O.
// - parseWorkHistoryPage: HTML of the Import@ss service page "Tu vida laboral" (AFPH02VidaLaboral,
//   /tramites/datosvidalaboral): summary paragraph, the employer/regime filter options and one table row
//   per period (title button + cells Empleador | TRL | Régimen | Contrato | Jornada | Categoría |
//   Fecha real alta | Fecha alta | Fecha baja | Días cotizados). Hidden cells are in the HTML too.
// - parseWorkHistoryIdentity: identifying data printed in the work history PDF (only when the PDF is requested).
// - anonymizeWorkHistory: the same JSON without identifying data.
// - benefitPeriodsFromWorkHistory: unemployment benefit periods (ERTE…) for the other tools.
// The Spanish strings below are the site's / document's own labels.

import { redactDeep, isAnonymized as isAnonymizedFor } from './anonymize.js';

export const WORK_HISTORY_SCHEMA_VERSION = 1;
const pad = (n) => String(n).padStart(2, '0');
const MONTHS_ABBR = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const MONTHS_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', ordf: 'ª', ordm: 'º' };
export const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
const textOf = (html) => decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tagAttrs, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tagAttrs || ''); return m ? decodeEntities(m[1]) : null; };

/** "26 may 2023" / "26 de mayo de 2023" / "26.05.2023" / "26/05/2023" → "2023-05-26" (null otherwise). */
export function parseDateEs(s) {
  const t = norm(s).trim();
  let m = /^(\d{1,2})\s+(?:de\s+)?([a-z]+)\.?\s+(?:de\s+)?(\d{4})$/.exec(t);
  if (m) {
    const mon = MONTHS_ABBR[m[2]] || MONTHS_ABBR[m[2].slice(0, 3)] || (MONTHS_FULL.indexOf(m[2]) + 1 || null);
    return mon ? `${m[3]}-${pad(mon)}-${pad(m[1])}` : null;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
}
const cellValue = (txt) => {
  const v = String(txt || '').replace(/^[^:]{1,40}:\s*/, '').trim();
  return !v || /^sin datos$/i.test(v) || v === '-' ? null : v;
};
const nameKey = (s) => norm(s).replace(/\b(s\.?\s?l\.?u?|s\.?\s?a\.?u?|s\.?\s?coop\.?)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Situation type of a period from its title, prefix and regime. */
export function situationOf({ title, prefix, regime }) {
  const t = norm(title); const p = norm(prefix); const r = norm(regime);
  if (/vacaciones retribuidas/.test(p) || /vacaciones retribuidas/.test(t)) return { situationType: 'paid-untaken-vacation', benefitKind: null };
  if (/prestacion|subsidio|desempleo/.test(t)) {
    return { situationType: 'unemployment-benefit', benefitKind: /suspensi/.test(t) ? 'erte-suspension' : /reducci/.test(t) ? 'erte-reduction' : 'unemployment' };
  }
  if (/autonomo|cuenta propia/.test(t) || /autonomo/.test(r)) return { situationType: 'self-employed', benefitKind: null };
  if (/convenio especial/.test(t)) return { situationType: 'special-agreement', benefitKind: null };
  return { situationType: 'employment', benefitKind: null };
}

/**
 * Parses the "Tu vida laboral" service page HTML. options: { url, fetchedAt, pageNumber }.
 * Returns the FULL JSON (with identity.displayName from the page header). Identity fields that only the
 * PDF prints (full name, ID document, Social Security number, birth date, address) are null here.
 */
export function parseWorkHistoryPage(html, { url = null, fetchedAt = null, pageNumber = 1 } = {}) {
  const src = String(html || '');
  // Header: the user's display name (link to the personal area).
  const header = /<a[^>]*href="[^"]*\/importass\/personal\/?"[^>]*class="[^"]*ss-header__action[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(src)
    || /<a[^>]*class="[^"]*ss-header__action[^"]*"[^>]*href="[^"]*\/importass\/personal\/?"[^>]*>([\s\S]*?)<\/a>/i.exec(src);
  const displayName = header ? textOf(header[1]) || null : null;

  // Summary paragraph.
  const summaryHtml = (/<section class="ss-content">([\s\S]*?)<\/section>/i.exec(src.slice(src.search(/has estado de alta un total/i) - 400 < 0 ? 0 : src.search(/has estado de alta un total/i) - 400)) || [null, ''])[1];
  const st = norm(textOf(summaryHtml || src));
  const num = (re) => { const m = re.exec(st); return m ? Number(m[1].replace(/\./g, '')) : null; };
  const dur = /(\d+)\s+anos?,\s*(\d+)\s+mes(?:es)?\s+y\s+(\d+)\s+dias?/.exec(st);
  const summary = {
    totalDaysRegistered: num(/de alta un total de\s+([\d.]+)\s+dias/),
    simultaneousDays: num(/de forma simultanea[^.]*?\s([\d.]+)\s+dias/),
    computableDays: num(/cuentan para las prestaciones[^.]*?son\s+([\d.]+)\s+dias/),
    computableDuration: dur ? { years: Number(dur[1]), months: Number(dur[2]), days: Number(dur[3]) } : null,
  };

  // Filter options: regimes and employers (name + CCC, employer codes).
  const employers = []; const regimes = [];
  const sel = /<select[^>]*id="empresa"[^>]*>([\s\S]*?)<\/select>/i.exec(src);
  if (sel) {
    for (const g of sel[1].matchAll(/<optgroup[^>]*label="([^"]*)"[^>]*>([\s\S]*?)<\/optgroup>/gi)) {
      const group = norm(decodeEntities(g[1]));
      for (const o of g[2].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)) {
        const t = textOf(o[1]);
        if (!t) continue;
        if (/empresa/.test(group)) { const m = /^(.*?)\s+(\d{9,12})$/.exec(t); employers.push({ name: m ? m[1] : t, ccc: m ? m[2] : null }); }
        else regimes.push(t);
      }
    }
  }
  const cccOf = (company) => {
    if (!company) return null;
    const k = nameKey(company);
    const hit = employers.find((e) => nameKey(e.name) === k) || employers.find((e) => k && (nameKey(e.name).startsWith(k) || k.startsWith(nameKey(e.name))));
    return hit ? hit.ccc : null;
  };

  // Period rows.
  const periods = [];
  const tbody = /<table[^>]*class="[^"]*ss-table[^"]*"[^>]*>[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(src);
  const rowsHtml = tbody ? [...tbody[1].matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)] : [];
  for (const [, , rowHtml] of rowsHtml) {
    const cells = [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map(([, a, inner]) => ({ id: attr(a, 'id') || '', cls: attr(a, 'class') || '', inner, text: textOf(inner) }));
    if (!cells.length) continue;
    const titleCell = cells.find((c) => /col--title/.test(c.cls)) || cells[0];
    const spans = [...titleCell.inner.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => textOf(m[1])).filter(Boolean);
    const title = spans.length ? spans.at(-1) : titleCell.text;
    const prefix = spans.length > 1 ? spans.slice(0, -1).join(' ') : null;
    const byId = (k) => cells.find((c) => new RegExp(`-${k}-\\d+$`).test(c.id));
    const byLabel = (re) => cells.find((c) => re.test(norm(c.text)));
    const regimeCell = byId('regime') || byLabel(/^regimen:/);
    const contractCell = byId('contract') || byLabel(/^contrato:/);
    const groupCell = byId('category') || byLabel(/^(grupo de cotizacion|categoria):/);
    const effectCell = byLabel(/^fecha efecto del alta:/);
    const start = cells.find((c) => /date-start/.test(c.cls));
    const end = cells.find((c) => /date-end/.test(c.cls));
    const daysCell = cells.find((c) => /col--floated/.test(c.cls)) || byLabel(/^\d[\d.]*\s+dias?$/);
    const regime = cellValue(regimeCell && regimeCell.text);
    const endText = end ? end.text : '';
    const sit = situationOf({ title, prefix, regime });
    const company = sit.situationType === 'employment' || sit.situationType === 'paid-untaken-vacation' ? title : null;
    periods.push({
      index: periods.length + 1, page: pageNumber, title, prefix, company, ccc: cccOf(company), ...sit,
      regime, trl: cellValue(byId('trl') && byId('trl').text), contract: cellValue(contractCell && contractCell.text),
      workday: cellValue(byId('journey') && byId('journey').text), contributionGroup: cellValue(groupCell && groupCell.text),
      effectDate: effectCell ? parseDateEs(cellValue(effectCell.text)) : null,
      startDate: start ? parseDateEs(start.text) : null,
      endDate: /^actual$/i.test(endText.trim()) ? null : parseDateEs(endText),
      current: /^actual$/i.test(endText.trim()),
      days: daysCell ? Number((/([\d.]+)/.exec(daysCell.text) || [null, ''])[1].replace(/\./g, '')) || 0 : null,
    });
  }
  const pg = /ss-pagination__info[^>]*>\s*(\d+)\s+de\s+(\d+)\s*</i.exec(src);
  return {
    schemaVersion: WORK_HISTORY_SCHEMA_VERSION,
    kind: 'work-history',
    source: { url, page: /AFPH02VidaLaboral/.test(src) ? 'AFPH02VidaLaboral' : null, method: 'service-page', fetchedAt, pages: pg ? Number(pg[2]) : 1, pdf: null },
    identity: { displayName, fullName: null, birthDate: null, socialSecurityNumber: null, idDocument: null, idDocumentType: null, address: null, sources: { displayName: displayName ? 'page header' : null, pdf: null } },
    summary,
    regimes,
    employers,
    periods,
    pagination: pg ? { current: Number(pg[1]), total: Number(pg[2]) } : { current: 1, total: 1 },
  };
}

/** Merges the parsed pages of a multi-page listing (periods renumbered; summary/identity from page 1). */
export function mergeWorkHistoryPages(pages) {
  if (!pages.length) return null;
  const first = pages[0];
  const seen = new Set(); const periods = [];
  for (const p of pages) for (const r of p.periods) {
    const k = [r.title, r.prefix, r.regime, r.startDate, r.endDate, r.days].join('|');
    if (seen.has(k)) continue;
    seen.add(k); periods.push({ ...r, index: periods.length + 1 });
  }
  return { ...first, source: { ...first.source, pages: pages.length }, periods, pagination: { current: 1, total: Math.max(pages.length, first.pagination.total) } };
}

/** Identifying data printed in the work history PDF text ("…resulta que D/Dª NAME, nacido/a el …"). */
export function parseWorkHistoryIdentity(pdfText) {
  const one = String(pdfText || '').replace(/\s+/g, ' ');
  const out = { fullName: null, birthDate: null, socialSecurityNumber: null, idDocument: null, idDocumentType: null, address: null };
  const name = /resulta que D\/D[ªa]\s+(.+?)\s*,\s*nacid[oa](?:\/a)?\s/i.exec(one);
  if (name) out.fullName = name[1].trim();
  const birth = /nacid[oa](?:\/a)?\s+el\s+(\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4})/i.exec(one);
  if (birth) out.birthDate = parseDateEs(birth[1]);
  const naf = /N[uú]mero de (?:la )?Seguridad Social\s+(\d{10,12})/i.exec(one);
  if (naf) out.socialSecurityNumber = naf[1];
  const doc = /\b(D\.?\s?N\.?\s?I\.?|N\.?\s?I\.?\s?E\.?|N\.?\s?I\.?\s?F\.?|Pasaporte)\s*:?\s*([0-9XYZ][0-9]{6,8}[A-Z])\b/i.exec(one);
  if (doc) { out.idDocument = doc[2]; out.idDocumentType = doc[1].replace(/[\s.]/g, '').toUpperCase(); }
  const addr = /domicilio en\s+(.+?)\s+ha figurado/i.exec(one);
  if (addr) out.address = addr[1].replace(/\s*,\s*$/, '').trim();
  return out;
}

/** Adds the PDF identity to a full JSON (values only where found). */
export function withPdfIdentity(full, identity, pdf = null) {
  const id = { ...full.identity };
  for (const [k, v] of Object.entries(identity || {})) if (v) id[k] = v;
  id.sources = { ...id.sources, pdf: Object.values(identity || {}).some(Boolean) ? 'work history PDF' : null };
  return { ...full, identity: id, source: { ...full.source, pdf } };
}

/**
 * Copy WITHOUT identifying data: no identity block, no absolute paths, and every identity value (and name
 * part) that might still appear anywhere else is replaced by "[redacted]". Companies, CCCs (employer codes),
 * dates, regimes and days are kept.
 */
export function anonymizeWorkHistory(full) {
  const { identity, ...rest } = full;
  const base = (p) => (p ? String(p).split('/').pop() : null);
  const source = { ...rest.source, pdf: rest.source && rest.source.pdf ? { pdf: base(rest.source.pdf.pdfPath), txt: base(rest.source.pdf.txtPath) } : null };
  return { ...redactDeep({ ...rest, source }, identity), anonymized: true, removed: ['identity (display name, full name, ID document, Social Security number, birth date, address)'] };
}

/** True when no identity value of `full` (and no absolute path) appears in the serialised `anon`. */
export function isAnonymized(anon, full) {
  return isAnonymizedFor(anon, full.identity);
}

const monthsBetween = (fromIso, toIso) => {
  const out = []; let [y, m] = fromIso.slice(0, 7).split('-').map(Number); const [ty, tm] = toIso.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
};

/**
 * Unemployment benefit periods (ERTE…) from the work history JSON, same shape as
 * sepeParser.parseBenefitPeriods: [{ kind, label, regime, from, to, days, months }].
 */
export function benefitPeriodsFromWorkHistory(json, { now = new Date() } = {}) {
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return (json && Array.isArray(json.periods) ? json.periods : [])
    .filter((p) => p.situationType === 'unemployment-benefit' && p.startDate)
    .map((p) => {
      const to = p.endDate || todayIso;
      return { kind: p.benefitKind || 'unemployment', label: p.title, regime: p.regime, from: p.startDate, to, days: p.days, months: monthsBetween(p.startDate, to) };
    })
    .sort((a, b) => a.from.localeCompare(b.from));
}
