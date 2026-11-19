// Contribution bases report ("Informe de bases de cotización") as JSON.
// The report only comes as a PDF: the download flow is unchanged (ranges, chunks, keep-open); its text is
// parsed locally into contribution-bases-YYYY-MM-DD.json (full, with identifying data) and .anon.json.
// Tools/LLM only ever receive the full JSON PATH and the anonymised JSON CONTENT; every consumer of the
// bases report loads the FULL JSON through loadContributionBases().
import fs from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR, log, today, fetchContributionBasesReport, latestSavedFor } from './importass.js';
import { fileName, OUTPUT_DIR_LABEL } from './paths.js';
import { buildBasesJson, anonymizeBases, isBasesAnonymized } from './basesParser.js';

// Same as REPORTS.contributionBases.filePrefix (a literal: importass.js and quotas.js import each other).
export const BASES_PREFIX = 'contribution-bases';
const JSON_RE = new RegExp(`^${BASES_PREFIX}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
const TXT_RE = new RegExp(`^${BASES_PREFIX}-(\\d{4}-\\d{2}-\\d{2})(?:-part\\d+)?\\.txt$`);

/** Pure: the only payload tools return — the folder label, the full JSON file name, PDF file names, anonymised content. */
export function basesToolPayload({ jsonPath, anon }) {
  const pdfFiles = ((anon && anon.source && anon.source.parts) || []).map((p) => fileName(p.pdfPath)).filter(Boolean);
  return { folder: OUTPUT_DIR_LABEL, fullJsonFile: fileName(jsonPath), pdfFiles, contributionBases: anon };
}

/** Writes the full and anonymised JSON (refuses if the leak check fails). Returns { jsonPath, anonPath, anon }. */
export async function saveBasesJson(full, { dir = OUTPUT_DIR, day = today() } = {}) {
  const anon = anonymizeBases(full);
  if (!isBasesAnonymized(anon, full.identity)) throw new Error('Anonymisation check failed: identifying data still present; nothing written.');
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `${BASES_PREFIX}-${day}.json`);
  const anonPath = path.join(dir, `${BASES_PREFIX}-${day}.anon.json`);
  await fs.writeFile(jsonPath, JSON.stringify(full, null, 1), 'utf8');
  await fs.writeFile(anonPath, JSON.stringify(anon, null, 1), 'utf8');
  return { jsonPath, anonPath, anon };
}

/** Builds and saves the JSON pair from saved part files [{ pdfPath, txtPath }] (local parsing only). */
export async function buildBasesJsonFromFiles(files, { dir = OUTPUT_DIR, day = today(), fetchedAt = null } = {}) {
  const parts = [];
  for (const f of files) parts.push({ ...f, text: await fs.readFile(f.txtPath, 'utf8') });
  const full = buildBasesJson(parts, { fetchedAt });
  const saved = await saveBasesJson(full, { dir, day });
  return { ...saved, full, day };
}

async function savedTxtParts(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const txts = names.map((f) => ({ f, m: TXT_RE.exec(f) })).filter((x) => x.m);
  if (!txts.length) return null;
  const day = txts.map((x) => x.m[1]).sort().at(-1);
  const sameDay = txts.filter((x) => x.m[1] === day).map((x) => x.f);
  const parts = sameDay.filter((f) => /-part\d+\.txt$/.test(f)).sort((a, b) => Number(/-part(\d+)/.exec(a)[1]) - Number(/-part(\d+)/.exec(b)[1]));
  const chosen = parts.length ? parts : sameDay; // same rule as latestSavedFor
  return { day, files: chosen.map((f) => ({ txtPath: path.join(dir, f), pdfPath: path.join(dir, f.replace(/\.txt$/, '.pdf')) })) };
}

/**
 * The FULL bases JSON for the other tools: { source: 'json', day, jsonPath, anonPath, file, full, anon } or null.
 * If the newest saved report is a PDF/txt without JSON (older version), the JSON pair is built from it first.
 */
export async function loadContributionBases({ dir = OUTPUT_DIR } = {}) {
  const names = await fs.readdir(dir).catch(() => []);
  const jsonDay = names.map((f) => JSON_RE.exec(f)).filter(Boolean).map((m) => m[1]).sort().at(-1) || null;
  const txt = await savedTxtParts(dir);
  if (txt && (!jsonDay || txt.day > jsonDay)) {
    log(`building ${BASES_PREFIX}-${txt.day}.json from the saved report text`);
    const b = await buildBasesJsonFromFiles(txt.files, { dir, day: txt.day });
    return { source: 'json', day: txt.day, jsonPath: b.jsonPath, anonPath: b.anonPath, file: path.basename(b.jsonPath), full: b.full, anon: b.anon };
  }
  if (!jsonDay) return null;
  const jsonPath = path.join(dir, `${BASES_PREFIX}-${jsonDay}.json`);
  const anonPath = path.join(dir, `${BASES_PREFIX}-${jsonDay}.anon.json`);
  const full = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  let anon = null;
  try { anon = JSON.parse(await fs.readFile(anonPath, 'utf8')); } catch { /* rebuilt below */ }
  if (!anon || !isBasesAnonymized(anon, full.identity)) anon = anonymizeBases(full);
  return { source: 'json', day: jsonDay, jsonPath, anonPath, file: path.basename(jsonPath), full, anon };
}

/** read_latest_contribution_bases_report / CLI show-bases. */
export async function basesView({ dir = OUTPUT_DIR } = {}) {
  const b = await loadContributionBases({ dir });
  if (!b) return { ok: false, message: 'No contribution bases report saved yet. Run get_contribution_bases_report (CLI: fetch-bases).' };
  return { ok: true, payload: basesToolPayload({ jsonPath: b.jsonPath, anon: b.anon }) };
}

/**
 * get_contribution_bases_report: the existing PDF download flow, then the JSON pair.
 * options as fetchContributionBasesReport (timeoutMs, auto, from, to, chunkYears, keepOpen, context).
 * Returns { ok, message, jsonPath, anonPath, anon, full, files } (no report text).
 */
export async function fetchContributionBases(opts = {}) {
  const r = await fetchContributionBasesReport(opts);
  if (!r.ok) return { ok: false, message: r.message, files: r.files || [] };
  const b = await buildBasesJsonFromFiles(r.files, { fetchedAt: new Date().toISOString() });
  log(`saved ${b.jsonPath} and ${path.basename(b.anonPath)} (${b.full.sections.length} sections)`);
  return { ok: true, message: r.message, jsonPath: b.jsonPath, anonPath: b.anonPath, anon: b.anon, full: b.full, files: r.files };
}

// Old text loader kept for the equivalence check / debugging only (consumers use loadContributionBases).
export const latestContributionBasesText = () => latestSavedFor(BASES_PREFIX);
