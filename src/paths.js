// Path hygiene for tool output: responses carry file names only, never absolute paths (which contain the
// macOS username). The output folder is shown as a safe label: "~/…" inside the home folder (default
// "~/Documents/HuellaContributiva", or HUELLA_OUTPUT_DIR), otherwise only its folder name.
// Helpers; I/O only for existence checks of path candidates and rawFilesFor (lists file names).
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CONFIG, outputDirLabel } from './config.js';

export const OUTPUT_DIR_LABEL = CONFIG.outputDirLabel;
const HOME = CONFIG.home;
const OUTPUT_DIR = CONFIG.outputDir;
const PROJECT_DIR = CONFIG.projectDir;

/** File name of a path (null-safe). */
export const fileName = (p) => (p ? path.basename(String(p)) : null);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QUOTES = '"\'`';
const SENTENCE_PUNCT = /[.,;:!?]+$/;
// A path ends where the following character is one of these (or at the end of the text).
const isBoundary = (c) => c === undefined || /[\s.,;:!?)\]}"'`<>|]/.test(c);
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const decode = (s) => { if (!/%[0-9A-Fa-f]{2}/.test(s)) return s; try { return decodeURIComponent(s); } catch { return s; } };
const encodeForms = (p) => [...new Set([p, encodeURI(p), p.replace(/ /g, '%20')])];

/**
 * Where a path candidate that starts at `start` can end at most (hard delimiters): newline/tab, the matching
 * quote when the path is quoted, any quote or angle bracket, a ")" that closes a "(" opened before the path,
 * the start of another path, " key=" / ", key:" style separators.
 */
function hardEnd(text, start, opener, isPathStartAt) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === '\r' || c === '\t' || c === '<' || c === '>') return i;
    // A quoted path ends at its closing quote (it may contain the other quote characters, e.g. an apostrophe);
    // an unquoted path ends at any quote.
    if (QUOTES.includes(opener) ? c === opener : QUOTES.includes(c)) return i;
    if (c === '(') depth += 1;
    if (c === ')') { if (depth === 0) return i; depth -= 1; }
    if (i > start && /\s/.test(c)) {
      const rest = text.slice(i);
      if (/^\s+[A-Za-z_][\w.-]*=/.test(rest)) return i; // " rows=3"
      if (isPathStartAt(i + rest.match(/^\s+/)[0].length)) return i; // another path
    }
    if (c === ',' && /^,\s+[A-Za-z_][\w-]*[=:]/.test(text.slice(i))) return i; // ", key: …"
    if (i > start && c === '|' ) return i;
  }
  return text.length;
}

/**
 * Length of the path at the beginning of `c` (a candidate already cut at hard delimiters).
 * Order: the longest prefix that exists on disk; else the longest prefix ending in a file extension at a
 * boundary; else every "folder/" segment (spaces allowed) plus the last segment up to the first space.
 * `fixed` = length of a known prefix that is certainly part of the path.
 */
function pathLength(c, { fixed = 0, exists, decodeFirst = false }) {
  const ends = [];
  for (let i = Math.max(fixed, 1); i <= c.length; i++) if (isBoundary(c[i]) && !/\s/.test(c[i - 1])) ends.push(i);
  const asPath = (n) => (decodeFirst ? decode(c.slice(0, n)) : c.slice(0, n));
  for (let k = ends.length - 1; k >= 0 && k >= ends.length - 40; k--) {
    const n = ends[k]; const p = asPath(n).replace(/\/+$/, '');
    if (p.length > 1 && exists(p)) return n;
  }
  for (let k = ends.length - 1; k >= 0; k--) {
    const n = ends[k]; const last = c.slice(0, n).split('/').pop();
    if (EXT_RE.test(last) && !/^\.+$/.test(last)) return n;
  }
  const lastSlash = c.lastIndexOf('/');
  if (lastSlash < fixed) return fixed || c.length;
  const tail = c.slice(lastSlash + 1);
  const m = /^[^\s]*/.exec(tail)[0].replace(SENTENCE_PUNCT, '');
  return lastSlash + 1 + m.length;
}

/**
 * Replaces absolute paths in a text by their file names: the output folder itself becomes
 * "~/Documents/HuellaContributiva", the home folder "~", anything else its last segment. Handles spaces, accents and
 * parentheses in folder/file names, file:// URLs and %20-encoded paths, quoted and unquoted paths, several
 * paths per line and trailing punctuation. A text that is a JSON document is sanitised value by value.
 * options: home, outputDir, projectDir, exists (fs check) — for tests.
 */
export function sanitizePaths(text, opts = {}) {
  const s = String(text ?? '');
  const t = s.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const value = JSON.parse(t);
      const indentMatch = /\n( +)\S/.exec(t);
      const out = JSON.stringify(sanitizeDeep(value, opts), null, indentMatch ? indentMatch[1].length : undefined);
      return s.slice(0, s.indexOf(t[0])) + out + s.slice(s.lastIndexOf(t.at(-1)) + 1);
    } catch { /* not JSON: plain text below */ }
  }
  return sanitizeText(s, opts);
}

function sanitizeText(s, { home = HOME, outputDir = OUTPUT_DIR, projectDir = PROJECT_DIR, exists = existsSync } = {}) {
  const roots = [outputDir, projectDir, home].filter((p) => p && p.length > 1);
  const known = roots.flatMap((r) => encodeForms(r).map((form) => ({ form, root: r }))).sort((a, b) => b.form.length - a.form.length);
  const startRe = new RegExp(`(?:file://)?(?:${known.map((k) => esc(k.form)).join('|')}${known.length ? '|' : ''}/Users/|/home/)`, 'g');
  const isPathStartAt = (i) => { startRe.lastIndex = i; const m = startRe.exec(s); return Boolean(m && m.index === i); };
  const label = (p) => {
    const q = p.replace(/\/+$/, '');
    if (q === outputDir) return outputDir === OUTPUT_DIR ? OUTPUT_DIR_LABEL : outputDirLabel(outputDir, { home });
    if (q === home) return '~';
    return path.basename(q) || '~';
  };
  let out = ''; let pos = 0;
  startRe.lastIndex = 0;
  let m;
  while ((m = startRe.exec(s))) {
    const start = m.index;
    if (start < pos) continue;
    const prev = s[start - 1];
    // Only a real path start: beginning, or after whitespace / an opening delimiter / "=" / ":".
    if (prev !== undefined && !/[\s=("'`[{,;:]/.test(prev)) { startRe.lastIndex = start + 1; continue; }
    const end = hardEnd(s, start, prev, isPathStartAt);
    let cand = s.slice(start, end);
    const isUrl = cand.startsWith('file://');
    const body = isUrl ? cand.slice(7) : cand;
    const k = known.find((x) => body.startsWith(x.form) && (body.length === x.form.length || body[x.form.length] === '/' || isBoundary(body[x.form.length])));
    const encoded = isUrl || /%[0-9A-Fa-f]{2}/.test(body);
    const n = pathLength(body, { fixed: k ? k.form.length : 0, exists, decodeFirst: encoded });
    const raw = body.slice(0, n);
    out += s.slice(pos, start) + label(encoded ? decode(raw) : raw);
    pos = start + (isUrl ? 7 : 0) + n;
    startRe.lastIndex = pos;
  }
  out += s.slice(pos);
  // Last resort: never leave a user path behind (should not happen).
  return out.replace(/(^|[^A-Za-z0-9])\/(?:Users|home)\/[^\n"'`<>]*/g, '$1[path]');
}

/** True when a text still contains an absolute user path. */
export const hasUserPath = (text) => /(?:^|[^A-Za-z0-9])\/(?:Users|home)\/[^\s/]/.test(String(text ?? ''));

/** Deep-sanitises every string of a value (objects, arrays). */
export function sanitizeDeep(v, opts) {
  if (typeof v === 'string') return sanitizePaths(v, opts);
  if (Array.isArray(v)) return v.map((x) => sanitizeDeep(x, opts));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitizeDeep(x, opts)]));
  return v;
}

/**
 * Local raw files (file names) for the given saved texts: the txt itself plus the snapshot / PDF
 * siblings with the same stem (.html, .png, .pdf) that exist in `dir`.
 */
export async function rawFilesFor(sources, { dir = OUTPUT_DIR } = {}) {
  const names = new Set(await fs.readdir(dir).catch(() => []));
  const out = [];
  for (const src of sources) {
    const stem = fileName(src).replace(/\.(txt|html|png|pdf)$/i, '');
    for (const ext of ['txt', 'html', 'png', 'pdf']) {
      const f = `${stem}.${ext}`;
      if (names.has(f) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

export const RAW_NOTE = `detail "full" no longer returns raw page/PDF text (it can contain identifying data): it is the breakdown plus rawFiles, the local raw files in ${OUTPUT_DIR_LABEL} (raw text stays local).`;

/** Text block for the "full" views. */
export const rawFilesBlock = (files) => `rawFiles (${files.length}, in ${OUTPUT_DIR_LABEL}): ${files.join(' ') || '-'}\nnote: ${RAW_NOTE}`;

/** Sanitises every text item of an MCP tool result (used by the server's registerTool wrapper). */
export function sanitizeToolResult(result, opts) {
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: result.content.map((c) => (c && c.type === 'text' ? { ...c, text: sanitizePaths(c.text, opts) } : c)) };
}
