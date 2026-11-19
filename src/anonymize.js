// Shared helpers for the anonymised JSON copies (work history, contribution bases…). Pure, no I/O.
// - identityTokens: every identity value (and, for names, each word of 3+ letters) that must not appear.
// - redactDeep: replaces those tokens by "[redacted]" anywhere in a value, and absolute paths by file names.
// - isAnonymized: final leak check (no identity token, no absolute path).

const NAME_KEYS = new Set(['fullName', 'displayName', 'firstName', 'surnames']);
const SKIP_KEYS = new Set(['sources', 'idDocumentType']);
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A whole string that is an absolute file path: under a usual filesystem root, or ending in a file extension
// (portal URL paths such as "/wps/myportal/…" are left alone).
const ABS_PATH_RE = /^(?:\/(?:Users|home|private|var|tmp|Volumes|opt|mnt|root)\/\S*|\/[^\s/]+(?:\/[^\s/]+)*\/[^\s/]+\.[A-Za-z0-9]{2,5}|~\/\S*|[A-Za-z]:\\\S*)$/;
const ABS_PATH_ANYWHERE_RE = /(?:^|[\s"'(])(?:\/(?:Users|home|Volumes)\/|[A-Za-z]:\\Users\\)/;

/** Identity values to keep out of the anonymised copy (strings of 3+ characters). */
export function identityTokens(identity) {
  const out = new Set();
  for (const [k, v] of Object.entries(identity || {})) {
    if (SKIP_KEYS.has(k) || !v || typeof v !== 'string') continue;
    out.add(v.trim());
    if (NAME_KEYS.has(k)) for (const w of v.split(/[\s,]+/)) if (w.length >= 3) out.add(w);
    // ID numbers may also be printed with separators (e.g. "28 1234567890"): add the digits-only form.
    if (/\d/.test(v) && v.replace(/[\s.-]/g, '') !== v) out.add(v.replace(/[\s.-]/g, ''));
  }
  return [...out].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
}

const tokenRe = (tokens, flags = 'giu') => (tokens.length
  ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${tokens.map(esc).join('|')})(?![\\p{L}\\p{N}])`, flags) : null);

/** Deep copy with identity tokens replaced by "[redacted]" and absolute paths reduced to file names. */
export function redactDeep(value, identity) {
  const re = tokenRe(identityTokens(identity));
  const scrub = (v) => {
    if (typeof v === 'string') {
      const s = ABS_PATH_RE.test(v) ? v.split(/[\\/]/).pop() : v;
      return re ? s.replace(re, '[redacted]') : s;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(value);
}

/** True when no identity value of `identity` and no absolute user path appears in the serialised `anon`. */
export function isAnonymized(anon, identity) {
  const s = JSON.stringify(anon);
  if (ABS_PATH_ANYWHERE_RE.test(s)) return false;
  const tokens = identityTokens(identity).map(norm);
  const re = tokenRe(tokens, 'u');
  return !re || !re.test(norm(s));
}
