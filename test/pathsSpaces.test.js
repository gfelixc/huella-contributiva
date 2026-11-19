// Sanitiser robustness: spaces, accents, parentheses, encoded forms, quotes. Invented paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizePaths, hasUserPath } from '../src/paths.js';

const HOME = '/Users/Jane Q Exámple';
const O = { home: HOME, outputDir: `${HOME}/Documents/HuellaContributiva`, projectDir: `${HOME}/tools/vida laboral (copy)`, exists: () => false };
const LEAK = /Jane|Exámple|Ex%C3%A1mple|Documents|tools\/|\/Users\/|\/home\//;
const clean = (t, opts = O) => { const r = sanitizePaths(t, opts); assert.ok(!LEAK.test(r.split('~/Documents/HuellaContributiva').join('')), `leak in: ${r}`); return r; };

test('known home with spaces and accents: plain text, punctuation, several paths per line', () => {
  assert.equal(clean(`csv=${HOME}/Documents/HuellaContributiva/calculo cuotas 2026.summary.csv rows=3`), 'csv=calculo cuotas 2026.summary.csv rows=3');
  assert.equal(clean(`Files in ${HOME}/Documents/HuellaContributiva.`), 'Files in ~/Documents/HuellaContributiva.');
  assert.equal(clean(`Saved ${HOME}/Documents/HuellaContributiva/a b.pdf, ${HOME}/Documents/HuellaContributiva/c d.txt; done.`), 'Saved a b.pdf, c d.txt; done.');
  assert.equal(clean(`see ${HOME}/Documents/HuellaContributiva/Informe (2024) final.pdf!`), 'see Informe (2024) final.pdf!');
  assert.equal(clean(`home is ${HOME} and project ${HOME}/tools/vida laboral (copy)`), 'home is ~ and project vida laboral (copy)');
  assert.equal(clean(`a=${HOME}/x y/one.json b=${HOME}/two files/two.json`), 'a=one.json b=two.json');
});

test('JSON documents are sanitised value by value (indentation kept)', () => {
  const doc = JSON.stringify({ fullJsonPath: `${HOME}/Documents/HuellaContributiva/vida laboral 2026.json`, dir: `${HOME}/Documents/HuellaContributiva`, files: [`${HOME}/My Files/a.pdf`], n: 1 }, null, 2);
  const r = JSON.parse(clean(doc));
  assert.deepEqual(r, { fullJsonPath: 'vida laboral 2026.json', dir: '~/Documents/HuellaContributiva', files: ['a.pdf'], n: 1 });
  assert.match(clean(doc), /\n {2}"fullJsonPath"/);
  // JSON embedded in a message: quoted values end at their quote.
  assert.equal(clean(`ok\n{"p":"${HOME}/Documents/HuellaContributiva/it's here.json","q":"x"}`), `ok\n{"p":"it's here.json","q":"x"}`);
});

test('file:// URLs and %20-encoded paths', () => {
  const enc = encodeURI(`${HOME}/Documents/HuellaContributiva/panel de cotizaciones.html`);
  assert.equal(clean(`open file://${enc} now`), 'open panel de cotizaciones.html now');
  assert.equal(clean(`file://${encodeURI(HOME)}/Documents/HuellaContributiva`), '~/Documents/HuellaContributiva');
  assert.equal(clean('x /Users/Other%20Person/Some%20Folder/f%20g.txt y'), 'x f g.txt y');
  assert.equal(clean('link file:///home/Other%20Person/d%C3%ADa.pdf.'), 'link día.pdf.');
});

test('quoted and unquoted unknown user paths with spaces', () => {
  assert.equal(clean("ENOENT: no such file, open '/Users/Other Person/My Docs/missing report.json'"), "ENOENT: no such file, open 'missing report.json'");
  assert.equal(clean('path "/home/Jo Doe/a b/c.txt" and \'/home/Jo Doe/d.txt\''), 'path "c.txt" and \'d.txt\'');
  assert.equal(clean('unquoted /Users/Other Person/Some Folder/file name.csv, then more'), 'unquoted file name.csv, then more');
  assert.equal(clean('(/Users/Other Person/Proj (old)/data.json) ok'), '(data.json) ok');
  assert.equal(clean('dir /home/jo/some folder/sub done'), 'dir sub done');
});

test('existing paths on disk are matched exactly (folders and files with spaces, no extension)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vl paths test '));
  try {
    const dir = path.join(root, 'Carpeta con espacios (1)'); await fs.mkdir(dir);
    const file = path.join(dir, 'informe sin extension'); await fs.writeFile(file, 'x');
    const opts = { home: root, outputDir: path.join(root, 'none'), projectDir: path.join(root, 'none2') };
    const r = sanitizePaths(`made ${file} and ${dir}. end`, opts);
    assert.equal(r, 'made informe sin extension and Carpeta con espacios (1). end');
    assert.ok(!r.includes(root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('URLs and relative paths are untouched; nothing of a user path ever survives', () => {
  const url = 'https://portal.seg-social.gob.es/wps/myportal/importass/importass/tramites/datosvidalaboral';
  assert.equal(clean(url), url);
  assert.equal(clean('period 01/2023-12/2024 and/or 3/4'), 'period 01/2023-12/2024 and/or 3/4');
  for (const t of ['/Users/', '/home/x', 'a /Users/b c/d', '"/Users/q r s"', 'file:///Users/z%20z/', '/Users/a/b/c.d.e.f.']) {
    assert.equal(hasUserPath(sanitizePaths(t, O)), false, t);
  }
});
