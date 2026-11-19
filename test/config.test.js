// Configuration from environment variables (pure; no I/O) and the output-folder label in sanitised output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, outputDirLabel, expandDir } from '../src/config.js';
import { sanitizePaths } from '../src/paths.js';

const home = '/Users/exampleuser';
const projectDir = '/Users/exampleuser/code/huella-contributiva';
const base = { home, projectDir, cwd: '/Users/exampleuser/work' };

test('defaults: ~/Documents/HuellaContributiva and <project>/.chrome-profile, no certificate label', () => {
  const c = resolveConfig({ ...base, env: {} });
  assert.equal(c.outputDir, '/Users/exampleuser/Documents/HuellaContributiva');
  assert.equal(c.outputDirLabel, '~/Documents/HuellaContributiva');
  assert.equal(c.profileDir, '/Users/exampleuser/code/huella-contributiva/.chrome-profile');
  assert.equal(c.certLabel, null);
  assert.equal(resolveConfig({ ...base, env: { HUELLA_OUTPUT_DIR: '  ', HUELLA_CHROME_PROFILE: '' } }).outputDir, c.outputDir);
});

test('overrides: HUELLA_OUTPUT_DIR, HUELLA_CHROME_PROFILE, HUELLA_CERT_LABEL', () => {
  const c = resolveConfig({ ...base, env: { HUELLA_OUTPUT_DIR: '~/Documents/HC-test', HUELLA_CHROME_PROFILE: 'profile', HUELLA_CERT_LABEL: ' ACME CERT ' } });
  assert.equal(c.outputDir, '/Users/exampleuser/Documents/HC-test');
  assert.equal(c.outputDirLabel, '~/Documents/HC-test');
  assert.equal(c.profileDir, '/Users/exampleuser/work/profile');
  assert.equal(c.certLabel, 'ACME CERT');
  assert.equal(resolveConfig({ ...base, env: { HUELLA_OUTPUT_DIR: '/Volumes/Data/exampleuser/out/' } }).outputDirLabel, 'out');
  assert.equal(expandDir('~', { home }), home);
});

test('label never contains an absolute path or the username', () => {
  assert.equal(outputDirLabel('/Users/exampleuser/a b/Huella', { home }), '~/a b/Huella');
  assert.equal(outputDirLabel('/Users/exampleuser', { home }), '~');
  assert.equal(outputDirLabel('/Users/exampleuserX/out', { home }), 'out'); // not inside the home folder
  assert.equal(outputDirLabel('/srv/exampleuser/out', { home }), 'out');
});

test('sanitizer: a custom output folder becomes its label, files inside become file names', () => {
  const O = { home, outputDir: '/Users/exampleuser/Documents/HC-test', projectDir };
  assert.equal(sanitizePaths('Files in /Users/exampleuser/Documents/HC-test.', O), 'Files in ~/Documents/HC-test.');
  assert.equal(sanitizePaths('csv=/Users/exampleuser/Documents/HC-test/dashboard-2026-01-01.html rows=3', O), 'csv=dashboard-2026-01-01.html rows=3');
  const X = { home, outputDir: '/Volumes/Data/exampleuser/out', projectDir };
  const r = sanitizePaths('Files in /Volumes/Data/exampleuser/out and /Volumes/Data/exampleuser/out/a.json', X);
  assert.equal(r, 'Files in out and a.json');
  assert.ok(!/exampleuser/.test(sanitizePaths('profile /Users/exampleuser/tmp/clean/.chrome-profile', O)));
});

test('first run (empty HUELLA_OUTPUT_DIR): refresh-all --dry-run plans every step, no browser, safe label', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'huella-home-'));
  try {
    const out = path.join(fakeHome, 'Documents', 'HC-first-run');
    fs.mkdirSync(out, { recursive: true });
    const env = { ...process.env, HOME: fakeHome, HUELLA_OUTPUT_DIR: out, HUELLA_CHROME_PROFILE: path.join(fakeHome, 'profile') };
    delete env.HUELLA_CERT_LABEL;
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'cli.js'), 'refresh-all', '--dry-run', '--json'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.folder, '~/Documents/HC-first-run');
    assert.deepEqual(j.steps.map((s) => [s.step, s.status]), [['bases', 'planned'], ['workHistory', 'planned'], ['quotas', 'planned'], ['paid', 'planned'], ['regularization', 'conditional'], ['sepe', 'conditional']]);
    assert.ok(!r.stdout.includes(fakeHome) && !/\/Users\/|\/home\//.test(r.stdout));
    assert.ok(!fs.existsSync(path.join(fakeHome, 'profile')), 'no Chrome profile created by a dry run');
    assert.deepEqual(fs.readdirSync(out), [], 'a dry run on an empty folder writes nothing');
  } finally { fs.rmSync(fakeHome, { recursive: true, force: true }); }
});
