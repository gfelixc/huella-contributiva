// Runtime configuration from environment variables (all optional). No I/O.
//   HUELLA_OUTPUT_DIR      output folder (default ~/Documents/HuellaContributiva); "~" / "~/…" and relative paths accepted
//   HUELLA_CHROME_PROFILE  dedicated Chrome profile folder (default <project>/.chrome-profile)
//   HUELLA_CERT_LABEL      label of the certificate to pick, only printed as a hint (kept out of the code)
// Tool output never shows these absolute paths: the output folder is shown as a label (outputDirLabel).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT_LABEL = '~/Documents/HuellaContributiva';

/** Absolute path of an env value: "~" / "~/x" expand to the home folder, relative paths resolve against `cwd`. */
export function expandDir(value, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const v = String(value).trim();
  if (v === '~') return home;
  if (v.startsWith('~/')) return path.join(home, v.slice(2));
  return path.resolve(cwd, v);
}

/**
 * Safe label of the output folder for tool output: "~/<relative path>" inside the home folder, otherwise only the
 * folder name (an absolute path can contain the username).
 */
export function outputDirLabel(dir, { home = os.homedir() } = {}) {
  const d = path.resolve(dir).replace(/\/+$/, '');
  const h = path.resolve(home).replace(/\/+$/, '');
  if (d === h) return '~';
  if (d.startsWith(`${h}/`)) return `~/${d.slice(h.length + 1)}`;
  return path.basename(d) || '/';
}

/** Resolved configuration (pure: pass env/home/cwd in tests). */
export function resolveConfig({ env = process.env, home = os.homedir(), cwd = process.cwd(), projectDir = PROJECT_DIR } = {}) {
  const outputDir = env.HUELLA_OUTPUT_DIR?.trim()
    ? expandDir(env.HUELLA_OUTPUT_DIR, { home, cwd })
    : path.join(home, 'Documents', 'HuellaContributiva');
  const profileDir = env.HUELLA_CHROME_PROFILE?.trim()
    ? expandDir(env.HUELLA_CHROME_PROFILE, { home, cwd })
    : path.join(projectDir, '.chrome-profile');
  const certLabel = env.HUELLA_CERT_LABEL?.trim() || null;
  return { outputDir, outputDirLabel: outputDirLabel(outputDir, { home }), profileDir, certLabel, home, projectDir };
}

export const CONFIG = resolveConfig();
