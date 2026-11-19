// Path hygiene of tool output. Invented paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizePaths, sanitizeDeep, sanitizeToolResult, hasUserPath, rawFilesFor, rawFilesBlock, fileName, OUTPUT_DIR_LABEL } from '../src/paths.js';

const O = { home: '/Users/exampleuser', outputDir: '/Users/exampleuser/Documents/HuellaContributiva' };

test('absolute paths become file names; the output folder becomes the tilde label', () => {
  assert.equal(sanitizePaths('day=2026-01-01 csv=/Users/exampleuser/Documents/HuellaContributiva/quota-calculation-2026-01-01.summary.csv rows=3', O), 'day=2026-01-01 csv=quota-calculation-2026-01-01.summary.csv rows=3');
  assert.equal(sanitizePaths('Files in /Users/exampleuser/Documents/HuellaContributiva.', O), `Files in ${OUTPUT_DIR_LABEL}.`);
  assert.equal(sanitizePaths('file:///Users/exampleuser/Documents/HuellaContributiva/dashboard-2026-01-01.html\nnext', O), 'dashboard-2026-01-01.html\nnext');
  assert.equal(sanitizePaths('{"fullJsonPath":"/Users/exampleuser/Documents/HuellaContributiva/work-history-2026-01-01.json"}', O), '{"fullJsonPath":"work-history-2026-01-01.json"}');
  assert.equal(sanitizePaths("ENOENT: no such file, open '/home/someone/x/y.txt'", O), "ENOENT: no such file, open 'y.txt'");
  assert.equal(sanitizePaths('(/Users/exampleuser/tools/huella-contributiva/.chrome-profile) ok', O), '(.chrome-profile) ok');
  assert.equal(sanitizePaths('home: /Users/exampleuser', O), 'home: ~');
  // URLs and relative portal paths are untouched.
  const url = 'https://portal.seg-social.gob.es/wps/myportal/importass/importass/tramites/datosvidalaboral';
  assert.equal(sanitizePaths(url, O), url);
  assert.equal(sanitizePaths('period 01/2023-12/2024', O), 'period 01/2023-12/2024');
  assert.equal(sanitizePaths('custom home /srv/u1/Documents/HuellaContributiva/a.json', { home: '/srv/u1', outputDir: '/srv/u1/Documents/HuellaContributiva' }), 'custom home a.json');
});

test('deep sanitising and the MCP result guard', () => {
  assert.deepEqual(sanitizeDeep({ a: ['/Users/exampleuser/a/b.pdf'], n: 1 }, O), { a: ['b.pdf'], n: 1 });
  const r = sanitizeToolResult({ isError: true, content: [{ type: 'text', text: 'Error: open /Users/exampleuser/Documents/HuellaContributiva/x.txt' }, { type: 'image', data: 'x' }] }, O);
  assert.equal(r.content[0].text, 'Error: open x.txt');
  assert.equal(r.content[1].data, 'x');
  assert.equal(r.isError, true);
  assert.equal(hasUserPath(r.content[0].text), false);
  assert.equal(hasUserPath('x /home/abc/y'), true);
  assert.equal(fileName('/a/b/c.json'), 'c.json');
  assert.equal(fileName(null), null);
});

test('rawFiles lists the local siblings of each saved text (names only)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-paths-test-'));
  try {
    for (const f of ['snap-2026-01-01-01.txt', 'snap-2026-01-01-01.html', 'snap-2026-01-01-01.png', 'res-2024.pdf', 'res-2024.txt', 'other.txt']) await fs.writeFile(path.join(dir, f), 'x');
    const raw = await rawFilesFor(['snap-2026-01-01-01.txt', path.join(dir, 'res-2024.txt')], { dir });
    assert.deepEqual(raw, ['snap-2026-01-01-01.txt', 'snap-2026-01-01-01.html', 'snap-2026-01-01-01.png', 'res-2024.txt', 'res-2024.pdf']);
    const block = rawFilesBlock(raw);
    assert.match(block, /^rawFiles \(5, in ~\/Documents\/HuellaContributiva\)/);
    assert.match(block, /raw text stays local/);
    assert.ok(!block.includes(dir));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('MCP server guard: an error that contains an absolute path reaches the client as a file name', async () => {
  const { spawn } = await import('node:child_process');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-home-test-'));
  const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    let buf = ''; const res = {};
    server.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); res[m.id] = m; } catch { /* not JSON */ } } });
    const send = (o) => server.stdin.write(`${JSON.stringify(o)}\n`);
    const wait = async (id) => { for (let t = 0; t < 100 && !res[id]; t++) await new Promise((r) => setTimeout(r, 100)); return res[id]; };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await wait(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_contributions_dashboard', arguments: { report_path: '/home/exampleuser/Documents/HuellaContributiva/missing-report.json' } } });
    const m = await wait(2);
    const text = m.result.content.map((c) => c.text).join('\n');
    assert.equal(m.result.isError, true);
    assert.match(text, /missing-report\.json/);
    assert.equal(hasUserPath(text), false);
    assert.ok(!text.includes(home));
  } finally { server.kill(); await fs.rm(home, { recursive: true, force: true }); }
});
