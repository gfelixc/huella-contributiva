/*
 * Contributions dashboard: data model (no DOM). Runs in the browser (inlined into the dashboard HTML, exposed as
 * window.ContribModel) and in Node (tests). Input: the JSON written by `node cli.js contributions-report`
 * (combined-report-*.json), optionally enriched with payments[].concepts by `node cli.js dashboard`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContribModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  // UI labels (Spanish) for the report's English codes.
  const PAYER_TYPE_LABEL = { worker: 'Trabajador', employer: 'Empresas', public_agency: 'Organismo público (SEPE / TGSS)' };
  const CHANNEL_LABEL = {
    'payroll withholding': 'Retención en nómina',
    'employer settlement': 'Liquidación de la empresa',
    'direct payment': 'Pago directo (RETA)',
    'deducted from unemployment benefit': 'Deducida de la prestación por desempleo',
    'regularization payment': 'Pago de la regularización anual (RETA)',
    'regularization refund': 'Devolución de la regularización anual (RETA)',
  };
  const SHARE_LABEL = { worker: 'Cuota del trabajador', employer: 'Cuota empresarial', public_agency: 'Cuota del trabajador (retenida por SEPE)' };
  const REGIME_LABEL = { GENERAL: 'Régimen General', RETA: 'Autónomos (RETA)', REM: 'Mar', SEA: 'Agrario', HOGAR: 'Hogar' };

  /** Dimensions available for grouping, drill-down, Sankey stages and timeline stacks. */
  const DIMENSIONS = {
    payerType: { label: 'Tipo de pagador', get: (f) => PAYER_TYPE_LABEL[f.payerType] || f.payerType },
    payer: { label: 'Pagador', get: (f) => f.payerLabel },
    employer: { label: 'Empresa / empleador', get: (f) => f.employerLabel },
    channel: { label: 'Canal', get: (f) => CHANNEL_LABEL[f.channel] || f.channel },
    regime: { label: 'Régimen', get: (f) => REGIME_LABEL[f.regime] || f.regime || '—' },
    year: { label: 'Año', get: (f) => String(f.year) },
    month: { label: 'Mes', get: (f) => f.periodLabel },
    share: { label: 'Aportación', get: (f) => (f.sourceReport === 'reta-regularization' ? (f.total < 0 ? 'Devolución de cuotas (TGSS)' : 'Regularización a ingresar (trabajador)') : SHARE_LABEL[f.payerType] || f.payerType) },
    group: { label: 'Grupo de conceptos', get: (f) => f.group },
    concept: { label: 'Concepto', get: (f) => f.concept },
    liquidation: { label: 'Liquidación', get: (f) => f.liquidationType || '—' },
  };

  const SMALL_WORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'por', 'y', 'e', 'a', 'en', 'o']);
  const ACRONYMS = new Set(['it', 'ims', 'mei', 'reta', 'sepe', 'erte', 'fp', 'at', 'ep', 'ss', 'irpf', 'fogasa']);
  const titleCase = (s) => String(s || '').toLowerCase().replace(/[a-záéíóúñü]+/g, (w, i) => (ACRONYMS.has(w) ? w.toUpperCase()
    : i > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
  const periodLabel = (p) => { const [y, m] = String(p).split('-'); return m ? `${MONTHS_ES[Number(m) - 1]} ${y}` : String(p); };

  /** Employment the entry belongs to (also for the worker share withheld from an employer's payroll). */
  function employerLabelOf(p) {
    const viaType = p.viaType || (p.payerType === 'public_agency' ? 'public_agency' : p.employer || p.ccc || p.payerType === 'employer' ? 'employer' : 'self-employed');
    if (viaType === 'public_agency') return p.via || p.payerName || 'Organismo público';
    if (viaType === 'self-employed') return 'Autónomo (cuenta propia)';
    return (p.via && p.via !== 'self-employed' ? p.via : null) || p.employer || (p.payerType === 'employer' ? p.payerName : null) || p.ccc || 'Empresa';
  }

  function payerLabelOf(p) {
    if (p.sourceReport === 'reta-regularization') return Number(p.total ?? p.amount) < 0 ? 'TGSS · devolución de la regularización' : 'Trabajador · regularización RETA';
    if (p.payerType === 'employer') return p.payerName || p.employer || p.ccc || 'Empresa';
    if (p.payerType === 'public_agency') return p.payerName || 'Organismo público';
    return p.channel === 'direct payment' ? 'Trabajador · cuota RETA' : 'Trabajador · retención en nómina';
  }

  /** Validates and normalises a report JSON. Throws with a Spanish message on invalid input. */
  function normalizeReport(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.payments)) {
      throw new Error('El fichero no parece un informe de cotizaciones (falta "payments"). Genera uno con: node cli.js contributions-report');
    }
    const entries = json.payments.map((p, i) => {
      const ranged = p.month === null || p.month === undefined;
      const from = p.periodFrom || p.period; const to = p.periodTo || p.period;
      return {
        id: p.id ?? i + 1, year: Number(p.year) || Number(String(from).slice(0, 4)), month: ranged ? null : Number(p.month),
        period: p.period || from, from, to, periodLabel: ranged ? `${periodLabel(from)} – ${periodLabel(to)}` : periodLabel(p.period),
        regime: p.regime || null, payerType: p.payerType || 'worker', payerName: p.payerName || null, payerLabel: payerLabelOf(p),
        employerLabel: employerLabelOf(p), ccc: p.ccc || null, channel: p.channel || '', liquidationType: p.liquidationType || null, liquidationNumber: p.liquidationNumber ?? null,
        base: p.base ?? null, amount: Number(p.amount) || 0, surcharge: Number(p.surcharge) || 0, total: Number(p.total ?? (Number(p.amount) || 0) + (Number(p.surcharge) || 0)) || 0,
        concepts: Array.isArray(p.concepts) ? p.concepts : null, benefitOverlap: p.benefitOverlap || null,
        baseStatus: p.baseStatus || null, regularizationYear: p.regularizationYear ?? null, regularization: p.regularization || null,
        dueDate: p.dueDate || null, refundDate: p.refundDate || null, paymentStatus: p.paymentStatus || null,
        grossBenefit: p.grossBenefit ?? null, irpfWithheld: p.irpfWithheld ?? null, netBenefit: p.netBenefit ?? null,
        sourceReport: p.sourceReport || null, sourceFile: p.sourceFile || null,
      };
    });
    const benefitPeriods = (json.notes || []).filter((n) => n.type === 'benefit-period')
      .map((n) => ({ from: n.period, to: n.periodTo || n.period, kind: n.kind || 'benefit', sepeIncluded: /SEPE deductions included/i.test(n.message || '') }));
    return {
      meta: {
        generatedAt: json.generatedAt || null, currency: json.currency || 'EUR', coverage: json.coverage || null,
        grand: json.aggregates && json.aggregates.grand ? json.aggregates.grand : null, selection: json.selection || null, sources: json.sources || null,
      },
      entries, notes: json.notes || [], gaps: json.gaps || [], benefitPeriods,
    };
  }

  /**
   * Expands entries into flows: one per concept (quota calculations), or one per entry
   * ("Cuota RETA" + "Recargo", "Deducción SS de la prestación"). Flow values always add up to the entry total.
   */
  function toFlows(entries) {
    const flows = [];
    for (const e of entries) {
      const parts = [];
      if (e.concepts && e.concepts.length) {
        for (const c of e.concepts) if (c.amount) parts.push({ group: titleCase(c.group || 'Otros'), concept: titleCase(c.concept), value: Number(c.amount) });
        const diff = round2(e.amount - parts.reduce((s, x) => s + x.value, 0));
        if (Math.abs(diff) >= 0.01) parts.push({ group: 'Otros', concept: 'Ajuste / sin desglose', value: diff });
      } else if (e.sourceReport === 'reta-regularization') {
        parts.push({ group: 'Regularización anual RETA', concept: e.amount < 0 ? 'Devolución de cuotas' : 'Diferencia a ingresar', value: e.amount });
      } else if (e.payerType === 'public_agency') {
        parts.push({ group: 'Prestación por desempleo', concept: 'Deducción SS de la prestación', value: e.amount });
      } else if (e.regime === 'RETA') {
        parts.push({ group: 'Cuota de autónomos', concept: 'Cuota RETA', value: e.amount });
      } else {
        parts.push({ group: 'Sin desglose', concept: e.payerType === 'employer' ? 'Cuota empresarial (total)' : 'Cuota obrera (total)', value: e.amount });
      }
      if (e.surcharge) parts.push({ group: 'Recargos e intereses', concept: 'Recargo', value: e.surcharge });
      for (const p of parts) flows.push({ ...e, group: p.group, concept: p.concept, value: round2(p.value), entryId: e.id });
    }
    return flows;
  }

  /** Filters entries: yearFrom/yearTo (numbers), payerTypes / payers / regimes (arrays; empty = all). */
  function filterEntries(entries, f = {}) {
    const inSet = (arr, v) => !arr || !arr.length || arr.includes(v);
    return entries.filter((e) => {
      const y1 = Number(String(e.from).slice(0, 4)); const y2 = Number(String(e.to).slice(0, 4));
      if (f.yearFrom && y2 < f.yearFrom) return false;
      if (f.yearTo && y1 > f.yearTo) return false;
      return inSet(f.payerTypes, e.payerType) && inSet(f.payers, e.payerLabel) && inSet(f.employers, e.employerLabel) && inSet(f.regimes, e.regime);
    });
  }

  function kpis(entries) {
    const sum = (pred) => round2(entries.filter(pred).reduce((s, e) => s + e.total, 0));
    const months = new Set(entries.filter((e) => e.month !== null).map((e) => e.period));
    return {
      total: sum(() => true), worker: sum((e) => e.payerType === 'worker'), employer: sum((e) => e.payerType === 'employer'),
      publicAgency: sum((e) => e.payerType === 'public_agency'), sepe: sum((e) => e.sourceReport === 'sepe-benefits'),
      regularization: sum((e) => e.sourceReport === 'reta-regularization'), regularizationEntries: entries.filter((e) => e.sourceReport === 'reta-regularization').length,
      // Regularisation differences already included in the paid quotas (annotated months, not separate entries).
      regularizationIncluded: round2(entries.reduce((a, e) => a + (e.regularization && e.regularization.includedDifference ? e.regularization.includedDifference : 0), 0)),
      refunds: sum((e) => e.total < 0), entries: entries.length, months: months.size,
      from: [...months].sort()[0] || null, to: [...months].sort().at(-1) || null,
    };
  }

  /** Hierarchical tree over flows: { name, value, count, months, children[] } sorted by value (desc; years/months chronological). */
  function buildTree(flows, dims, rootName = 'Total') {
    const make = (name, key) => ({ name, key, value: 0, entryIds: new Set(), months: new Set(), children: new Map() });
    const root = make(rootName, '');
    for (const f of flows) {
      let node = root;
      const touch = (n) => { n.value += f.value; n.entryIds.add(f.entryId); if (f.month !== null) n.months.add(f.period); };
      touch(node);
      dims.forEach((d, i) => {
        const name = DIMENSIONS[d].get(f);
        if (!node.children.has(name)) node.children.set(name, make(name, d));
        node = node.children.get(name);
        node.sortKey = d === 'year' ? f.year : d === 'month' ? f.period : null;
        touch(node);
        if (i === dims.length - 1) node.leaf = true;
      });
    }
    const finish = (n) => {
      const kids = [...n.children.values()];
      const chrono = kids.length && kids[0].sortKey !== null && kids[0].sortKey !== undefined;
      kids.sort((a, b) => (chrono ? String(a.sortKey).localeCompare(String(b.sortKey)) : b.value - a.value));
      return { name: n.name, dim: n.key, value: round2(n.value), count: n.entryIds.size, months: n.months.size, children: kids.map(finish) };
    };
    return finish(root);
  }

  /**
   * Sankey graph over flows for the given stage dimensions.
   * Returns { nodes: [{id, name, stage, value}], links: [{source, target, value}], negative } (ids are 'stage:name').
   * Only positive flows are drawn; `negative` is the sum of the skipped negative flows (refunds).
   */
  function sankeyGraph(flows, stages) {
    const nodes = new Map(); const links = new Map();
    let negative = 0;
    for (const f of flows) {
      // Negative flows (refunds) cannot be drawn as bands: they are summed in `negative` instead.
      if (f.value < 0) { negative += f.value; continue; }
      if (!f.value) continue;
      const ids = stages.map((d, i) => {
        const name = DIMENSIONS[d].get(f); const id = `${i}:${name}`;
        if (!nodes.has(id)) nodes.set(id, { id, name, stage: i, dim: d, value: 0 });
        nodes.get(id).value += f.value;
        return id;
      });
      for (let i = 0; i < ids.length - 1; i++) {
        const k = `${ids[i]}→${ids[i + 1]}`;
        if (!links.has(k)) links.set(k, { source: ids[i], target: ids[i + 1], value: 0 });
        links.get(k).value += f.value;
      }
    }
    return {
      nodes: [...nodes.values()].map((n) => ({ ...n, value: round2(n.value) })),
      links: [...links.values()].map((l) => ({ ...l, value: round2(l.value) })).filter((l) => l.value > 0),
      negative: round2(negative),
    };
  }

  /**
   * Sankey layout (columns per stage, node heights proportional to value, links ordered to limit crossings).
   * Returns nodes with x0,x1,y0,y1 and links with sy (source y), ty (target y), width.
   */
  function sankeyLayout(graph, { width, height, nodeWidth = 16, nodePadding = 10, sortChronological = true } = {}) {
    const stages = Math.max(1, ...graph.nodes.map((n) => n.stage + 1));
    const byStage = Array.from({ length: stages }, () => []);
    for (const n of graph.nodes) byStage[n.stage].push({ ...n, inLinks: [], outLinks: [] });
    const nodeById = new Map(byStage.flat().map((n) => [n.id, n]));
    const links = graph.links.map((l) => ({ ...l, s: nodeById.get(l.source), t: nodeById.get(l.target) })).filter((l) => l.s && l.t);
    for (const l of links) { l.s.outLinks.push(l); l.t.inLinks.push(l); }
    for (const col of byStage) {
      const chrono = sortChronological && col.length && (col[0].dim === 'year' || col[0].dim === 'month');
      col.sort((a, b) => (chrono ? String(a.name).localeCompare(String(b.name)) : b.value - a.value));
    }
    // Scale: the fullest column (values + padding) fits the height.
    const ky = Math.min(...byStage.map((col) => (height - Math.max(0, col.length - 1) * nodePadding) / Math.max(1e-9, col.reduce((s, n) => s + n.value, 0))));
    const dx = stages > 1 ? (width - nodeWidth) / (stages - 1) : 0;
    byStage.forEach((col, i) => {
      const used = col.reduce((s, n) => s + n.value * ky, 0) + Math.max(0, col.length - 1) * nodePadding;
      let y = Math.max(0, (height - used) / 2);
      for (const n of col) {
        n.x0 = i * dx; n.x1 = n.x0 + nodeWidth; n.y0 = y; n.y1 = y + Math.max(1, n.value * ky); y = n.y1 + nodePadding;
      }
    });
    for (const n of nodeById.values()) {
      n.outLinks.sort((a, b) => a.t.y0 - b.t.y0); n.inLinks.sort((a, b) => a.s.y0 - b.s.y0);
      let sy = n.y0; for (const l of n.outLinks) { l.width = Math.max(1, l.value * ky); l.sy = sy + l.width / 2; sy += l.value * ky; }
      let ty = n.y0; for (const l of n.inLinks) { l.ty = ty + Math.max(1, l.value * ky) / 2; ty += l.value * ky; }
    }
    const strip = (n) => { const { inLinks, outLinks, ...rest } = n; return rest; };
    return {
      nodes: [...nodeById.values()].map(strip),
      links: links.map((l) => ({ source: l.source, target: l.target, value: l.value, width: l.width, sy: l.sy, ty: l.ty, x0: l.s.x1, x1: l.t.x0 })),
      ky,
    };
  }

  /** Timeline: [{ key ('YYYY' or 'YYYY-MM'), stacks: {name: value}, total }] plus the stack names (by value desc). */
  function timeline(flows, { granularity = 'year', stackBy = 'payerType' } = {}) {
    const rows = new Map(); const totals = new Map();
    for (const f of flows) {
      if (!f.value) continue;
      // Ranged entries (SEPE certificates, RETA regularisation) are spread evenly over their months;
      // negative values (refunds) are kept as negative stacks.
      const months = f.month !== null ? [f.period] : monthsBetween(f.from, f.to);
      const share = f.value / months.length;
      for (const m of months) {
        const key = granularity === 'month' ? m : m.slice(0, 4);
        const name = DIMENSIONS[stackBy].get(f);
        if (!rows.has(key)) rows.set(key, { key, stacks: {}, total: 0 });
        const r = rows.get(key); r.stacks[name] = (r.stacks[name] || 0) + share; r.total += share;
        totals.set(name, (totals.get(name) || 0) + share);
      }
    }
    const list = [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => ({ key: r.key, total: round2(r.total), stacks: Object.fromEntries(Object.entries(r.stacks).map(([k, v]) => [k, round2(v)])) }));
    return { rows: fillGaps(list, granularity), stackNames: [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k) };
  }

  function monthsBetween(from, to) {
    const out = []; let [y, m] = String(from).split('-').map(Number); const [ty, tm] = String(to || from).split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 1200) break; }
    return out.length ? out : [String(from)];
  }

  function fillGaps(rows, granularity) {
    if (rows.length < 2) return rows;
    const keys = granularity === 'month' ? monthsBetween(rows[0].key, rows.at(-1).key)
      : Array.from({ length: Number(rows.at(-1).key) - Number(rows[0].key) + 1 }, (_, i) => String(Number(rows[0].key) + i));
    const by = new Map(rows.map((r) => [r.key, r]));
    return keys.map((k) => by.get(k) || { key: k, total: 0, stacks: {} });
  }

  const num = (v) => formatEUR(Number(v));
  const isoDate = (d) => { const [y, m, day] = String(d).split('-'); return day ? `${day}/${m}/${y}` : d; };
  /** Spanish text for the report's (English) note and gap messages; falls back to the original message. */
  function noteTextEs(n) {
    const msg = String(n.message || n.reason || '');
    let m;
    if (n.reason !== undefined && /last month/i.test(msg)) return 'Último mes: probablemente aún no procesado en el informe de cuotas ingresadas.';
    if (n.reason !== undefined) return `Sin datos de pago para este mes (${msg}).`;
    const erte = /within the ([\w-]+) benefit period/i.test(msg) ? ' Dentro del periodo de ERTE / prestación: parte del mes la pagó el SEPE.' : '';
    if ((m = /(quota calculation|paid report) base (-?[\d.]+) vs bases report (-?[\d.]+) \(diff (-?[\d.]+)\)/i.exec(msg))) {
      return `Base del ${/paid/i.test(m[1]) ? 'informe de cuotas ingresadas' : 'cálculo de cuotas'} ${num(m[2])} frente a ${num(m[3])} del informe de bases (diferencia ${num(m[4])}).${erte}`;
    }
    if ((m = /quota (-?[\d.]+) on base (-?[\d.]+) = (\d+)% of the full rate/i.exec(msg))) {
      return `Cuota ${num(m[1])} sobre una base de ${num(m[2])}: ${m[3]} % de la cuota completa (reducción, bonificación, tarifa plana o permiso).`;
    }
    if (n.type === 'multiple-activity') return 'Meses con cotización como asalariado (Régimen General) y como autónomo (RETA) a la vez (pluriactividad).';
    if (n.type === 'benefit-period' && (m = /(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})(?: \((\d+) days\))?/.exec(msg))) {
      const what = n.kind === 'erte-suspension' ? 'ERTE (contrato suspendido, prestación por desempleo)' : n.kind === 'erte-reduction' ? 'ERTE (reducción de jornada, prestación parcial)' : 'Prestación por desempleo';
      return `${what} del ${isoDate(m[1])} al ${isoDate(m[2])}${m[3] ? ` (${m[3]} días)` : ''} según la vida laboral. `
        + (/SEPE deductions included/i.test(msg) ? 'Incluye la cuota retenida por el SEPE.' : 'No hay certificado del SEPE guardado (node cli.js fetch-sepe).');
    }
    if (n.type === 'regularization-pending') {
      return `Bases provisionales: no hay resultado de la regularización anual guardado${n.status === 'pending' ? ' (el servicio la muestra pendiente)' : ''}. Se consulta con node cli.js fetch-regularization (la Seguridad Social regulariza el año Y durante Y+1 / inicio de Y+2; los meses de tarifa plana o con prestación no se regularizan).`;
    }
    if (n.type === 'regularised-month') {
      return `La cuota ingresada (${num(n.definitiveQuota)}) ya es la cuota definitiva: incluye ${n.difference >= 0 ? '+' : ''}${num(n.difference)} de la regularización RETA ${n.year} (cuota provisional ${num(n.provisionalQuota)}).`;
    }
    if (n.type === 'reta-regularization') {
      const st = { refund: 'devolución', claim: 'diferencia a ingresar', 'no-difference': 'sin diferencias (bases definitivas)', 'not-regularisable': 'no regularizable (bases definitivas)' }[n.status] || n.status;
      const pay = { paid: 'pagada', refunded: 'devuelta', pending: 'pendiente' }[n.paymentStatus] || null;
      const reflected = n.includedInPaid && !n.remainder;
      return `Resultado: ${st}${n.amount ? ` de ${num(n.amount)}` : ''}${n.dueDate ? `; fecha límite de ingreso ${isoDate(n.dueDate)}` : ''}${n.refundDate ? `; devuelta el ${isoDate(n.refundDate)}` : ''}${n.resolutionDate ? `; resolución del ${isoDate(n.resolutionDate)}` : ''}${pay ? `; estado: ${pay}` : ''}.`
        + (reflected ? ` Ya incluida en las cuotas ingresadas (${(n.reconciledMonths || []).map((m) => `${periodLabel(m.period)}: ${num(m.paid)}`).join(', ')}); no se suma aparte.`
          : n.includedInPaid ? ` ${num(n.includedInPaid)} incluidos en las cuotas ingresadas; ${num(n.remainder)} se suman aparte.`
            : n.status === 'claim' || n.status === 'refund' ? ' Se suma como movimiento aparte (no consta en las cuotas ingresadas).' : '');
    }
    if (n.type === 'sepe-period-certificate') return `Certificado del SEPE por periodo (ya incluido en el certificado anual): ${msg}`;
    return msg;
  }

  /** Notes and gaps as display items: { level: 'warn'|'info'|'erte'|'sepe'|'reg'|'pending', title, text, period }. */
  function issues(model) {
    const out = [];
    for (const g of model.gaps) out.push({ level: 'warn', title: `Falta ${periodLabel(g.period)} · ${REGIME_LABEL[g.regime] || g.regime}`, text: noteTextEs(g), original: g.reason, period: g.period });
    for (const n of model.notes) {
      const period = n.periodTo ? `${periodLabel(n.period)} – ${periodLabel(n.periodTo)}` : n.period ? periodLabel(n.period) : (n.periods || []).map(periodLabel).join(', ');
      if (n.type === 'regularised-month') {
        out.push({ level: 'reg', title: `Cuota regularizada · ${period}`, text: noteTextEs(n), original: n.message, period: n.period });
      } else if (n.type === 'reta-regularization' || n.type === 'regularization-pending') {
        out.push({ level: n.type === 'regularization-pending' ? 'pending' : 'reg', title: `${n.type === 'regularization-pending' ? 'Regularización RETA pendiente' : 'Regularización anual RETA'} · ${n.year || period}`, text: noteTextEs(n), original: n.message, period: n.period });
      } else if (n.type === 'benefit-period') {
        out.push({ level: 'erte', title: `ERTE / prestación por desempleo · ${period}`, text: noteTextEs(n), original: n.message, period: n.period });
        if (!/SEPE deductions included/i.test(n.message || '')) out.push({ level: 'sepe', title: 'SEPE pendiente', text: 'No hay certificado del SEPE guardado para este periodo: la cuota del trabajador retenida de la prestación no está incluida (node cli.js fetch-sepe).', period: n.period });
      } else {
        const TITLES = { 'base-mismatch': 'Base distinta', 'reduced-quota': 'Cuota reducida', 'provisional-base': 'Base provisional', 'multiple-activity': 'Pluriactividad', 'quota-not-ok': 'Cálculo incompleto', 'sepe-period-certificate': 'Certificado SEPE por periodo' };
        out.push({ level: 'info', title: `${TITLES[n.type] || n.type} · ${period}`, text: noteTextEs(n), original: n.message, period: n.period });
      }
    }
    return out;
  }

  function formatEUR(n, digits = 2) {
    const v = Number(n) || 0;
    const [i, d] = Math.abs(v).toFixed(digits).split('.');
    return `${v < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${digits ? `,${d}` : ''} €`;
  }

  function toCsv(entries) {
    const cols = ['id', 'period', 'regime', 'payerType', 'payerLabel', 'employerLabel', 'channel', 'liquidationType', 'base', 'amount', 'surcharge', 'total', 'benefitOverlap', 'baseStatus', 'sourceFile'];
    const esc = (v) => (v === null || v === undefined ? '' : /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...entries.map((e) => cols.map((c) => esc(c === 'period' && e.month === null ? `${e.from}..${e.to}` : e[c])).join(','))].join('\n');
  }

  return { titleCase, noteTextEs, DIMENSIONS, PAYER_TYPE_LABEL, CHANNEL_LABEL, SHARE_LABEL, normalizeReport, toFlows, filterEntries, kpis, buildTree, sankeyGraph, sankeyLayout, timeline, monthsBetween, issues, formatEUR, periodLabel, toCsv, round2 };
});
