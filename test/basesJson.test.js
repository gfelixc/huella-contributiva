// Contribution bases report → full / anonymised JSON. Invented fixtures only; no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseBasesHeader, buildBasesJson, anonymizeBases, isBasesAnonymized, toParsedBases, employeeMonths, selfEmployedMonths, parseBasesReport,
} from '../src/basesParser.js';
import { saveBasesJson, loadContributionBases, basesView, basesToolPayload } from '../src/basesReport.js';
import { resolveQuotaMonths } from '../src/quotas.js';
import { resolvePaidMonths, retaMonthsFromBases } from '../src/paidQuotas.js';
import { resolveSepeRequest } from '../src/sepe.js';
import { buildContributionsReport } from '../src/contributionsReport.js';

const MONTHS = 'Enero Febrero Marzo Abril Mayo Junio Julio Agosto Septiembre Octubre Noviembre Diciembre';
const header = (range) => `--- Page 1 ---
INFORME INTEGRAL DE BASES DE COTIZACIÓN

REFERENCIA DE VERIFICACIÓN

Código: 0AB0C-DEFGH-IJ0KL-MNOPQ-RSTUV-WXYZA Fecha: 02/01/2026

La autenticidad de este documento puede ser comprobada hasta la fecha 02/07/2026 en la
Sede Electrónica de la Seguridad Social.

Página 1 de 2

Datos identificativos
Apellidos y Nombre Nº Seg. Social Doc. identificativo Periodo informe

PERSONA DE EJEMPLO 000000000000 DNI: 00000000T ${range}
`;
const PART1 = `${header('01/2019 - 12/2022')}
Régimen: GENERAL Empresa/Razón Social: EXAMPLE COMPANY, S.L. CCC: 00000000000

${MONTHS}
2021 --- --- 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00 1.000,00
2022 1.100,00 1.100,00 Sin base registrada --- --- --- --- --- --- --- --- ---
`;
const PART2 = `${header('01/2023 - 12/2025')}
Régimen: TRABAJADOR AUTONOMO Empresa/Razón Social: Régimen Especial de Trab. Autónomos

${MONTHS}
2024 --- --- --- --- 500,00 500,00 500,00 500,00 500,00 500,00 500,00 500,00*
2025 500,00 500,00 500,00 500,00 500,00 500,00 500,00 500,00 500,00 500,00 Pendiente de actualizar

• *: Base provisional no computable (pendiente de regularizar).
`;
const PARTS = [
  { text: PART1, pdfPath: '/absolute/path/to/contribution-bases-2026-01-02-part1.pdf', txtPath: '/absolute/path/to/contribution-bases-2026-01-02-part1.txt' },
  { text: PART2, pdfPath: '/absolute/path/to/contribution-bases-2026-01-02-part2.pdf', txtPath: '/absolute/path/to/contribution-bases-2026-01-02-part2.txt' },
];
const NOW = new Date(2026, 0, 15);

test('header: identity and report metadata', () => {
  const h = parseBasesHeader(PART1);
  assert.deepEqual(h.identity, { fullName: 'PERSONA DE EJEMPLO', socialSecurityNumber: '000000000000', idDocument: '00000000T', idDocumentType: 'DNI', verificationCode: '0AB0C-DEFGH-IJ0KL-MNOPQ-RSTUV-WXYZA' });
  assert.deepEqual(h.meta, { title: 'INFORME INTEGRAL DE BASES DE COTIZACIÓN', issueDate: '2026-01-02', verifiableUntil: '2026-07-02', requestedFrom: '2019-01', requestedTo: '2022-12', pages: 2 });
});

test('multi-part report merges into one full JSON', () => {
  const j = buildBasesJson(PARTS, { fetchedAt: '2026-01-02T10:00:00.000Z' });
  assert.equal(j.kind, 'contribution-bases');
  assert.equal(j.source.parts.length, 2);
  assert.equal(j.source.requestedFrom, '2019-01');
  assert.equal(j.source.requestedTo, '2025-12');
  assert.equal(j.identity.fullName, 'PERSONA DE EJEMPLO');
  assert.deepEqual(j.sections.map((s) => [s.part, s.regime, s.ccc, s.selfEmployed]), [[1, 'GENERAL', '00000000000', false], [2, 'TRABAJADOR AUTONOMO', null, true]]);
  assert.deepEqual(j.employers, [{ name: 'EXAMPLE COMPANY, S.L.', ccc: '00000000000', regime: 'GENERAL' }]);
  assert.equal(j.totals.byYear[2021], 10000);
  assert.equal(j.totals.sections[0].monthsNoBase, 1);
  assert.equal(j.totals.sections[1].provisionalMonths, 1);
  assert.equal(j.totals.sections[1].monthsPending, 1);
  assert.equal(j.totals.employeeMonths, 13);
  // Same sections as parsing the concatenated text.
  assert.deepEqual(employeeMonths(toParsedBases(j)), employeeMonths(parseBasesReport(`${PART1}\n${PART2}`)));
});

test('anonymised copy: no identity, file names only, compact month cells that round-trip', () => {
  const full = buildBasesJson(PARTS);
  const anon = anonymizeBases(full);
  const s = JSON.stringify(anon);
  for (const v of ['PERSONA DE EJEMPLO', 'EJEMPLO', '000000000000', '00000000T', '0AB0C-DEFGH', '/absolute/path']) assert.ok(!s.includes(v), v);
  assert.equal('identity' in anon, false);
  assert.ok(isBasesAnonymized(anon, full.identity));
  assert.equal(anon.source.parts[0].pdfPath, 'contribution-bases-2026-01-02-part1.pdf');
  assert.deepEqual(anon.sections[1].years['2024'], [null, null, null, null, 500, 500, 500, 500, 500, 500, 500, '500*']);
  assert.equal(anon.sections[1].years['2025'][10], 'pending');
  assert.equal(anon.sections[0].years['2022'][2], 'no-base');
  assert.equal(anon.sections[0].employer, 'EXAMPLE COMPANY, S.L.');
  assert.deepEqual(selfEmployedMonths(toParsedBases(anon)), selfEmployedMonths(toParsedBases(full)));
});

test('leak check rejects a copy that still carries identity data or an absolute path', () => {
  const full = buildBasesJson(PARTS);
  assert.equal(isBasesAnonymized({ note: 'PERSONA DE EJEMPLO' }, full.identity), false);
  assert.equal(isBasesAnonymized({ ssn: '000000000000' }, full.identity), false);
  assert.equal(isBasesAnonymized({ f: '/Users/someone/x.pdf' }, full.identity), false);
  assert.equal(isBasesAnonymized({ ok: 'EXAMPLE COMPANY' }, full.identity), true);
});

test('consumers: JSON input gives the same selections as the report text', () => {
  const text = `${PART1}\n${PART2}`;
  const full = JSON.parse(JSON.stringify(buildBasesJson(PARTS)));
  assert.deepEqual(resolveQuotaMonths({ bases: full }), resolveQuotaMonths({ basesText: text }));
  assert.deepEqual(resolveQuotaMonths({ bases: full, months: ['03/2021', '06/2024'] }), resolveQuotaMonths({ basesText: text, months: ['03/2021', '06/2024'] }));
  assert.deepEqual(resolvePaidMonths({ bases: full, now: NOW }), resolvePaidMonths({ basesText: text, now: NOW }));
  assert.deepEqual(retaMonthsFromBases(full, { now: NOW }), retaMonthsFromBases(text, { now: NOW }));
  assert.deepEqual(resolveSepeRequest({ bases: full, allYears: true, now: NOW }).years, resolveSepeRequest({ basesText: text, allYears: true, now: NOW }).years);
  const a = buildContributionsReport({ bases: full, now: NOW }); const b = buildContributionsReport({ basesText: text, now: NOW });
  delete a.generatedAt; delete b.generatedAt;
  assert.deepEqual(a, b);
});

test('saved JSON pair, view payload, and building the pair from an old saved text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-bases-test-'));
  try {
    assert.equal((await basesView({ dir })).ok, false);
    // Old version: only the report text exists → the JSON pair is built from it.
    await fs.writeFile(path.join(dir, 'contribution-bases-2026-01-01.txt'), PART1, 'utf8');
    const v = await basesView({ dir });
    assert.equal(v.ok, true);
    assert.deepEqual(Object.keys(v.payload), ['folder', 'fullJsonFile', 'pdfFiles', 'contributionBases']);
    assert.equal(v.payload.folder, '~/Documents/HuellaContributiva');
    assert.equal(v.payload.fullJsonFile, 'contribution-bases-2026-01-01.json');
    assert.deepEqual(v.payload.pdfFiles, ['contribution-bases-2026-01-01.pdf']);
    const s = JSON.stringify(v.payload.contributionBases);
    assert.ok(!s.includes('PERSONA DE EJEMPLO') && !s.includes('00000000T') && !s.includes(dir));
    assert.ok((await fs.readdir(dir)).includes('contribution-bases-2026-01-01.anon.json'));
    // A newer JSON pair wins; consumers get the FULL JSON.
    await saveBasesJson(buildBasesJson(PARTS), { dir, day: '2026-01-02' });
    const b = await loadContributionBases({ dir });
    assert.equal(b.file, 'contribution-bases-2026-01-02.json');
    assert.equal(b.full.identity.fullName, 'PERSONA DE EJEMPLO');
    assert.equal(b.full.sections.length, 2);
    assert.deepEqual(Object.keys(basesToolPayload({ jsonPath: 'x', anon: b.anon })), ['folder', 'fullJsonFile', 'pdfFiles', 'contributionBases']);
    assert.ok(!JSON.stringify(basesToolPayload({ jsonPath: path.join(dir, 'x.json'), anon: b.anon })).includes(dir));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
