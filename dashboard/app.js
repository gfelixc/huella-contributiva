/* Contributions dashboard UI: plain DOM + SVG, no external libraries (works from file://). */
(function () {
  'use strict';
  const M = window.ContribModel;
  const $ = (sel) => document.querySelector(sel);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const eur = (n) => M.formatEUR(n);
  const eur0 = (n) => M.formatEUR(n, 0);
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1).replace('.', ',')} %` : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  };

  // Colours: payer types are fixed; other categories cycle through a palette.
  const TYPE_COLORS = { Trabajador: '#2f6db5', Empresas: '#4f9d63', 'Organismo público (SEPE / TGSS)': '#ec8a35' };
  const PALETTE = ['#2f6db5', '#4f9d63', '#ec8a35', '#8a6bbe', '#e3b97f', '#3aa6a0', '#c8443b', '#7f8c9d', '#5b8fd1', '#a3c76d', '#f2b134', '#b39ddb', '#d98aa6', '#6c7a89'];
  // Sankey stage palettes (reference look: blue → blue → green/beige/grey → purple/grey/green → orange).
  const STAGE_PALETTES = [
    ['#2c5fa8', '#3f78c4', '#6c9bd8', '#90b6e6'],
    ['#3f7fc8', '#5b95d6', '#7fade2'],
    ['#4f9d63', '#e3c08d', '#f0a35e', '#8fc79b', '#c7a77a'],
    ['#8a6bbe', '#c9ccd3', '#4f9d63', '#b39ddb', '#a6adb8'],
    ['#ec8a35', '#f3a660', '#e07b2a', '#f6c18f', '#d46d1f'],
    ['#3aa6a0', '#7cc8c3', '#2d8580'],
  ];
  const SMALL_GREY = '#b9bec7';
  const colorCache = new Map();
  const colorFor = (name) => {
    if (TYPE_COLORS[name]) return TYPE_COLORS[name];
    if (!colorCache.has(name)) colorCache.set(name, PALETTE[colorCache.size % PALETTE.length]);
    return colorCache.get(name);
  };

  const SANKEY_PRESETS = [
    { id: 'employer-share-year', label: 'Empresa → Aportación trabajador/empresa → Año', stages: ['employer', 'share', 'year'] },
    { id: 'employer-type-year-group', label: 'Empresa → Tipo de pagador → Año → Grupo de conceptos', stages: ['employer', 'payerType', 'year', 'group'] },
    { id: 'payer-regime-year-share', label: 'Pagador → Régimen → Año → Aportación', stages: ['payer', 'regime', 'year', 'share'] },
    { id: 'type-payer-year', label: 'Tipo de pagador → Pagador → Año', stages: ['payerType', 'payer', 'year'] },
    { id: 'type-regime-group-concept', label: 'Tipo de pagador → Régimen → Grupo → Concepto', stages: ['payerType', 'regime', 'group', 'concept'] },
    { id: 'payer-share-group', label: 'Pagador → Aportación → Grupo de conceptos', stages: ['payer', 'share', 'group'] },
    { id: 'year-type-channel', label: 'Año → Tipo de pagador → Canal', stages: ['year', 'payerType', 'channel'] },
    { id: 'regime-year-share', label: 'Régimen → Año → Aportación (incl. regularización)', stages: ['regime', 'year', 'share'] },
  ];
  const DRILL_PRESETS = [
    { id: 'employer', label: 'Empresa → Año → Aportación → Mes → Concepto', dims: ['employer', 'year', 'share', 'month', 'concept'] },
    { id: 'who', label: 'Tipo → Pagador → Régimen → Año → Mes → Aportación → Concepto', dims: ['payerType', 'payer', 'regime', 'year', 'month', 'share', 'concept'] },
    { id: 'year-employer', label: 'Año → Empresa → Aportación → Concepto', dims: ['year', 'employer', 'share', 'concept'] },
    { id: 'time', label: 'Año → Mes → Pagador → Concepto', dims: ['year', 'month', 'payer', 'concept'] },
    { id: 'regime', label: 'Régimen → Año → Tipo de pagador → Grupo → Concepto', dims: ['regime', 'year', 'payerType', 'group', 'concept'] },
    { id: 'concept', label: 'Grupo → Concepto → Tipo de pagador → Año', dims: ['group', 'concept', 'payerType', 'year'] },
  ];
  const STACK_DIMS = ['payerType', 'employer', 'payer', 'regime', 'share', 'group', 'channel'];

  const state = {
    model: null, flows: [], years: [],
    filters: { yearFrom: null, yearTo: null, payerTypes: [], payers: [], employers: [], regimes: [] },
    sankeyStages: SANKEY_PRESETS[0].stages.slice(), drillDims: DRILL_PRESETS[0].dims.slice(), drillPath: [],
    gran: 'year', stackBy: 'payerType', sort: { col: 'period', dir: 1 }, search: '', expanded: new Set(['']),
  };

  // ---------- Loading ----------
  function load(json, origin) {
    let model;
    try { model = M.normalizeReport(json); } catch (e) { alert(e.message); return; }
    state.model = model;
    const years = new Set();
    for (const e of model.entries) { years.add(Number(String(e.from).slice(0, 4))); years.add(Number(String(e.to).slice(0, 4))); }
    state.years = [...years].filter(Boolean).sort((a, b) => a - b);
    state.filters = { yearFrom: state.years[0] || null, yearTo: state.years.at(-1) || null, payerTypes: [], payers: [], employers: [], regimes: [] };
    state.drillPath = []; state.expanded = new Set(['']); colorCache.clear();
    $('#app').hidden = false; $('#empty').hidden = true; $('#export-csv').disabled = false;
    const cov = model.meta.coverage;
    $('#subtitle').textContent = `${origin}${cov ? ` · ${M.periodLabel(cov.from)} – ${M.periodLabel(cov.to)} · ${cov.months} meses` : ''}${model.meta.generatedAt ? ` · generado ${new Date(model.meta.generatedAt).toLocaleString('es-ES')}` : ''}`;
    buildFilterControls();
    render();
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try { load(JSON.parse(reader.result), file.name); } catch (e) { alert(`No se pudo leer ${file.name}: ${e.message}`); }
    };
    reader.readAsText(file);
  }

  $('#file-input').addEventListener('change', (ev) => { if (ev.target.files[0]) readFile(ev.target.files[0]); ev.target.value = ''; });
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => { ev.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => {
    ev.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true;
    const f = ev.dataTransfer && ev.dataTransfer.files[0];
    if (f) readFile(f);
  });
  $('#export-csv').addEventListener('click', () => {
    const blob = new Blob([M.toCsv(filteredEntries())], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'filtered-contributions.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- Filters ----------
  const filteredEntries = () => M.filterEntries(state.model.entries, state.filters);

  function buildFilterControls() {
    const f = state.filters;
    for (const [id, key] of [['#f-year-from', 'yearFrom'], ['#f-year-to', 'yearTo']]) {
      const sel = $(id);
      sel.innerHTML = state.years.map((y) => `<option value="${y}">${y}</option>`).join('');
      sel.value = String(f[key]);
      sel.onchange = () => { f[key] = Number(sel.value); if (f.yearFrom > f.yearTo) { if (key === 'yearFrom') f.yearTo = f.yearFrom; else f.yearFrom = f.yearTo; } syncFilterControls(); render(); };
    }
    const types = [...new Set(state.model.entries.map((e) => e.payerType))];
    $('#f-payer-types').innerHTML = types.map((t) => `<span class="chip" data-v="${esc(t)}"><span class="dot" style="background:${TYPE_COLORS[M.PAYER_TYPE_LABEL[t]] || '#999'}"></span>${esc(M.PAYER_TYPE_LABEL[t] || t)}</span>`).join('')
      + (types.includes('public_agency') ? '' : '<span class="chip" title="Sin certificados del SEPE en el informe" style="opacity:.5;cursor:default">SEPE: sin datos</span>');
    const regimes = [...new Set(state.model.entries.map((e) => e.regime).filter(Boolean))];
    $('#f-regimes').innerHTML = regimes.map((r) => `<span class="chip" data-v="${esc(r)}">${esc(M.DIMENSIONS.regime.get({ regime: r }))}</span>`).join('');
    for (const [box, key] of [['#f-payer-types', 'payerTypes'], ['#f-regimes', 'regimes']]) {
      $(box).querySelectorAll('.chip[data-v]').forEach((chip) => { chip.onclick = () => { toggle(f[key], chip.dataset.v); syncFilterControls(); render(); }; });
    }
    const totals = new Map();
    for (const e of state.model.entries) totals.set(e.payerLabel, (totals.get(e.payerLabel) || 0) + e.total);
    const payers = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    $('#f-payers').innerHTML = payers.map(([p, v]) => `<label><input type="checkbox" value="${esc(p)}"> ${esc(p)} <span class="muted">${eur0(v)}</span></label>`).join('');
    $('#f-payers').querySelectorAll('input').forEach((cb) => { cb.onchange = () => { toggle(f.payers, cb.value); syncFilterControls(); render(); }; });
    const etotals = new Map();
    for (const e of state.model.entries) etotals.set(e.employerLabel, (etotals.get(e.employerLabel) || 0) + e.total);
    $('#f-employers').innerHTML = [...etotals.entries()].sort((a, b) => b[1] - a[1]).map(([p, v]) => `<label><input type="checkbox" value="${esc(p)}"> ${esc(p)} <span class="muted">${eur0(v)}</span></label>`).join('');
    $('#f-employers').querySelectorAll('input').forEach((cb) => { cb.onchange = () => { toggle(f.employers, cb.value); syncFilterControls(); render(); }; });
    $('#f-reset').onclick = () => { state.filters = { yearFrom: state.years[0], yearTo: state.years.at(-1), payerTypes: [], payers: [], employers: [], regimes: [] }; state.drillPath = []; buildFilterControls(); render(); };
    syncFilterControls();
  }

  function toggle(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

  function syncFilterControls() {
    const f = state.filters;
    $('#f-year-from').value = String(f.yearFrom); $('#f-year-to').value = String(f.yearTo);
    $('#f-payer-types').querySelectorAll('.chip[data-v]').forEach((c) => c.classList.toggle('on', f.payerTypes.includes(c.dataset.v)));
    $('#f-regimes').querySelectorAll('.chip[data-v]').forEach((c) => c.classList.toggle('on', f.regimes.includes(c.dataset.v)));
    $('#f-payers').querySelectorAll('input').forEach((cb) => { cb.checked = f.payers.includes(cb.value); });
    $('#f-payers-summary').textContent = f.payers.length ? `${f.payers.length} seleccionado(s)` : 'todos';
    $('#f-employers').querySelectorAll('input').forEach((cb) => { cb.checked = f.employers.includes(cb.value); });
    $('#f-employers-summary').textContent = f.employers.length ? `${f.employers.length} seleccionada(s)` : 'todas';
    const active = [];
    if (f.yearFrom !== state.years[0] || f.yearTo !== state.years.at(-1)) active.push(`${f.yearFrom}–${f.yearTo}`);
    if (f.payerTypes.length) active.push(f.payerTypes.map((t) => M.PAYER_TYPE_LABEL[t]).join(', '));
    if (f.regimes.length) active.push(f.regimes.join(', '));
    if (f.payers.length) active.push(`${f.payers.length} pagador(es)`);
    if (f.employers.length) active.push(f.employers.length === 1 ? f.employers[0] : `${f.employers.length} empresas`);
    $('#f-active').textContent = active.length ? `Filtro: ${active.join(' · ')}` : 'Sin filtros: se muestra todo el informe.';
  }

  // ---------- Render ----------
  function render() {
    const entries = filteredEntries();
    state.flows = M.toFlows(entries);
    renderKpis(entries);
    renderSankey();
    renderDrill();
    renderTimeline();
    renderTreeTable();
    renderIssues();
    renderMovements(entries);
    const grand = state.model.meta.grand;
    const all = M.kpis(state.model.entries);
    $('#footer').textContent = `Total del informe: ${eur(all.total)}${grand ? ` (JSON: ${eur(grand.total)}${Math.abs(grand.total - all.total) < 0.01 ? ', cuadra' : ', ¡no cuadra!'})` : ''} · ${all.entries} entradas · `
      + 'Fuentes: cálculos de cuotas, informe de cuotas ingresadas, certificados del SEPE e informe de bases (Import@ss). Panel local: no envía datos a ningún servidor.';
  }

  const pendingRegYears = () => state.model.notes.filter((n) => n.type === 'regularization-pending').map((n) => n.year);
  const regSub = (k) => {
    const parts = [];
    if (k.regularizationIncluded) parts.push(`incluida en cuotas ingresadas${k.regularization ? ` (${eur0(k.regularizationIncluded)})` : ''}`);
    if (k.regularizationEntries) parts.push(`${eur0(k.regularization)} aparte · + a ingresar / − devuelto`);
    const pend = pendingRegYears();
    if (pend.length) parts.push(`pendiente: ${pend.join(', ')}`);
    return parts.join(' · ') || 'sin datos';
  };

  const BASE_BADGE = {
    provisional: '<span class="badge grey" title="Base provisional: regularización anual pendiente">provisional</span>',
    superseded: '<span class="badge reg" title="Base provisional ajustada por la regularización anual">regularizada</span>',
    regularised: '<span class="badge reg" title="La cuota ingresada ya es la definitiva e incluye la diferencia de la regularización">incl. regularización</span>',
    definitive: '<span class="badge grey" title="Base definitiva">definitiva</span>',
  };

  function renderKpis(entries) {
    const k = M.kpis(entries);
    const has = (t) => state.model.entries.some((e) => e.payerType === t);
    const cards = [
      { label: 'Total cotizado', value: k.total, sub: `${k.months} meses · ${k.entries} entradas`, accent: '#1e4f8c', type: null },
      { label: 'Trabajador', value: k.worker, sub: `${pct(k.worker, k.total)} · nómina + RETA`, accent: TYPE_COLORS.Trabajador, type: 'worker' },
      { label: 'Empresas', value: k.employer, sub: `${pct(k.employer, k.total)} · cuota empresarial`, accent: TYPE_COLORS.Empresas, type: 'employer' },
      { label: 'SEPE / TGSS (organismos)', value: k.publicAgency, sub: has('public_agency') ? `SEPE ${eur0(k.sepe)}${k.refunds ? ` · devoluciones ${eur0(k.refunds)}` : ''}` : 'pendiente: sin certificado SEPE', accent: TYPE_COLORS['Organismo público (SEPE / TGSS)'], type: 'public_agency' },
      { label: 'Regularización RETA', value: k.regularization + k.regularizationIncluded, sub: regSub(k), accent: '#3aa6a0', type: null },
      { label: 'Periodo', text: k.from ? `${M.periodLabel(k.from)} – ${M.periodLabel(k.to)}` : '—', sub: state.model.gaps.length ? `${state.model.gaps.length} hueco(s) · ${state.model.notes.length} aviso(s)` : `${state.model.notes.length} aviso(s)`, accent: '#7f8c9d', type: null },
    ];
    const f = state.filters.payerTypes;
    $('#kpis').innerHTML = cards.map((c, i) => `<div class="kpi${c.type ? '' : ' static'}${c.type && f.length && !f.includes(c.type) ? ' off' : ''}" data-i="${i}" style="--accent:${c.accent}" ${c.type ? 'title="Clic para filtrar por este tipo de pagador"' : ''}>
      <div class="k-label">${esc(c.label)}</div><div class="k-value"${c.text ? ' style="font-size:17px"' : ''}>${c.text ? esc(c.text) : eur(c.value)}</div><div class="k-sub">${esc(c.sub)}</div></div>`).join('');
    $('#kpis').querySelectorAll('.kpi').forEach((el) => {
      const c = cards[Number(el.dataset.i)];
      if (!c.type) return;
      el.onclick = () => { const cur = state.filters.payerTypes; state.filters.payerTypes = cur.length === 1 && cur[0] === c.type ? [] : [c.type]; syncFilterControls(); render(); };
    });
  }

  // ---------- Sankey ----------
  function buildSankeyControls() {
    const preset = $('#sk-preset');
    if (!preset.options.length) {
      preset.innerHTML = SANKEY_PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('') + '<option value="custom">Personalizada</option>';
      preset.onchange = () => { const p = SANKEY_PRESETS.find((x) => x.id === preset.value); if (p) state.sankeyStages = p.stages.slice(); renderSankey(); };
    }
    const dimOptions = (sel) => ['<option value="">—</option>', ...Object.entries(M.DIMENSIONS).map(([k, d]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(d.label)}</option>`)].join('');
    const stages = state.sankeyStages.concat(state.sankeyStages.length < 6 ? [''] : []);
    $('#sk-stages').innerHTML = stages.map((s, i) => `${i ? '<span class="arrow">→</span>' : ''}<select data-i="${i}" aria-label="Etapa ${i + 1}">${dimOptions(s)}</select>`).join('');
    $('#sk-stages').querySelectorAll('select').forEach((sel) => {
      sel.onchange = () => {
        const i = Number(sel.dataset.i);
        if (sel.value) state.sankeyStages[i] = sel.value; else state.sankeyStages.splice(i, 1);
        state.sankeyStages = state.sankeyStages.filter(Boolean);
        const match = SANKEY_PRESETS.find((p) => p.stages.join() === state.sankeyStages.join());
        $('#sk-preset').value = match ? match.id : 'custom';
        renderSankey();
      };
    });
    const match = SANKEY_PRESETS.find((p) => p.stages.join() === state.sankeyStages.join());
    preset.value = match ? match.id : 'custom';
  }

  function renderSankey() {
    buildSankeyControls();
    const box = $('#sankey'); box.innerHTML = '';
    const stages = state.sankeyStages.length >= 2 ? state.sankeyStages : ['payerType', 'payer'];
    const graph = M.sankeyGraph(state.flows, stages);
    if (!graph.nodes.length) { box.innerHTML = '<p class="muted">No hay datos con estos filtros.</p>'; return; }
    if (graph.negative) {
      const note = document.createElement('p'); note.className = 'muted small';
      note.textContent = `Las devoluciones (${eur(graph.negative)}) no se dibujan como bandas; el total neto las descuenta.`;
      box.appendChild(note);
    }
    const width = Math.max(720, box.clientWidth || 1100);
    const maxNodes = Math.max(...stages.map((_, i) => graph.nodes.filter((n) => n.stage === i).length));
    const height = Math.max(460, Math.min(1400, maxNodes * 26));
    const padL = 6; const padR = 200; const padT = 26; const padB = 6;
    const layout = M.sankeyLayout(graph, { width: width - padL - padR, height: height - padT - padB, nodeWidth: 18, nodePadding: maxNodes > 30 ? 4 : 10 });
    const total = graph.nodes.filter((n) => n.stage === 0).reduce((s, n) => s + n.value, 0);
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Diagrama de Sankey de las cotizaciones' }, box);
    const g = svg('g', { transform: `translate(${padL},${padT})` }, root);
    // Node colours per stage (small nodes in grey, like the reference image).
    const color = new Map();
    for (let s = 0; s < stages.length; s++) {
      const col = layout.nodes.filter((n) => n.stage === s).sort((a, b) => b.value - a.value);
      const pal = STAGE_PALETTES[s % STAGE_PALETTES.length];
      col.forEach((n, i) => {
        const fixed = stages[s] === 'payerType' ? TYPE_COLORS[n.name] : null;
        color.set(n.id, fixed || (n.value / total < 0.015 && i > 0 ? SMALL_GREY : pal[i % pal.length]));
      });
    }
    const stageX = new Map(layout.nodes.map((n) => [n.stage, n.x0]));
    stages.forEach((d, i) => {
      const x = stageX.get(i) ?? 0;
      svg('text', { x: i === stages.length - 1 ? x + 18 : x, y: -10, class: 'stage-title', 'text-anchor': 'start' }, g).textContent = M.DIMENSIONS[d].label;
    });
    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
    const linkEls = [];
    const linksG = svg('g', {}, g);
    for (const l of layout.links) {
      const xm = (l.x0 + l.x1) / 2;
      const p = svg('path', { class: 'link', d: `M${l.x0},${l.sy}C${xm},${l.sy} ${xm},${l.ty} ${l.x1},${l.ty}`, stroke: color.get(l.source), 'stroke-width': Math.max(1, l.width) }, linksG);
      p.dataset.s = l.source; p.dataset.t = l.target;
      const s = nodeById.get(l.source); const t = nodeById.get(l.target);
      tip(p, () => `<b>${esc(s.name)} → ${esc(t.name)}</b>${eur(l.value)} · ${pct(l.value, s.value)} de «${esc(s.name)}»`);
      linkEls.push(p);
    }
    const nodesG = svg('g', {}, g);
    for (const n of layout.nodes) {
      const ng = svg('g', { class: 'node' }, nodesG);
      const r = svg('rect', { x: n.x0, y: n.y0, width: n.x1 - n.x0, height: Math.max(1, n.y1 - n.y0), fill: color.get(n.id), rx: 2 }, ng);
      tip(r, () => `<b>${esc(n.name)}</b>${esc(M.DIMENSIONS[n.dim].label)} · ${eur(n.value)} · ${pct(n.value, total)} del total`);
      r.addEventListener('mouseenter', () => linkEls.forEach((p) => p.classList.toggle('hl', p.dataset.s === n.id || p.dataset.t === n.id)));
      r.addEventListener('mouseleave', () => linkEls.forEach((p) => p.classList.remove('hl')));
      r.addEventListener('click', () => filterByNode(n));
      const h = n.y1 - n.y0;
      if (h >= 7 || layout.nodes.filter((m) => m.stage === n.stage).length <= 14) {
        const last = n.stage === stages.length - 1;
        const t = svg('text', { x: last ? n.x1 + 6 : n.x1 + 6, y: (n.y0 + n.y1) / 2, dy: '0.35em', 'text-anchor': 'start' }, ng);
        const name = n.name.length > 34 ? `${n.name.slice(0, 32)}…` : n.name;
        t.textContent = `${name} `;
        const v = svg('tspan', { class: 'v' }, t); v.textContent = eur0(n.value);
        if (!last) { t.setAttribute('paint-order', 'stroke'); t.setAttribute('stroke', 'rgba(255,255,255,.85)'); t.setAttribute('stroke-width', '3'); }
      }
    }
  }

  function filterByNode(n) {
    const f = state.filters;
    if (n.dim === 'payer') f.payers = [n.name];
    else if (n.dim === 'employer') f.employers = [n.name];
    else if (n.dim === 'payerType') { const code = Object.keys(M.PAYER_TYPE_LABEL).find((k) => M.PAYER_TYPE_LABEL[k] === n.name); if (code) f.payerTypes = [code]; }
    else if (n.dim === 'regime') { const e = state.model.entries.find((x) => M.DIMENSIONS.regime.get(x) === n.name); if (e) f.regimes = [e.regime]; }
    else if (n.dim === 'year') { f.yearFrom = Number(n.name); f.yearTo = Number(n.name); }
    else return;
    syncFilterControls(); render();
  }

  // ---------- Drill-down ----------
  function buildDrillControls() {
    const sel = $('#dd-preset');
    if (sel.options.length) return;
    sel.innerHTML = DRILL_PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    sel.onchange = () => { state.drillDims = DRILL_PRESETS.find((p) => p.id === sel.value).dims.slice(); state.drillPath = []; state.expanded = new Set(['']); renderDrill(); renderTreeTable(); };
  }

  function currentTree() { return M.buildTree(state.flows, state.drillDims, 'Total'); }

  function renderDrill() {
    buildDrillControls();
    const tree = currentTree();
    let node = tree; const trail = [tree];
    for (const name of state.drillPath) { const next = node.children.find((c) => c.name === name); if (!next) break; node = next; trail.push(node); }
    state.drillPath = trail.slice(1).map((n) => n.name);
    $('#dd-crumbs').innerHTML = trail.map((n, i) => `${i ? '<span class="sep">›</span>' : ''}${i === trail.length - 1 ? `<b>${esc(n.name)}</b>` : `<a data-depth="${i}">${esc(n.name)}</a>`}`).join('')
      + ` <span class="muted">· ${eur(node.value)}${trail.length > 1 ? ` · ${pct(node.value, tree.value)} del total` : ''}</span>`;
    $('#dd-crumbs').querySelectorAll('a').forEach((a) => { a.onclick = () => { state.drillPath = state.drillPath.slice(0, Number(a.dataset.depth)); renderDrill(); }; });
    const kids = node.children;
    const dim = kids[0] ? kids[0].dim : null;
    const max = Math.max(...kids.map((k) => Math.abs(k.value)), 1);
    $('#dd-bars').innerHTML = kids.length ? `<div class="muted small">${esc(dim ? M.DIMENSIONS[dim].label : '')} · ${kids.length} elemento(s)${kids[0] && kids[0].children.length ? ' · clic para bajar de nivel' : ''}</div>`
      + kids.map((k, i) => `<div class="bar${k.children.length ? ' drill' : ''}" data-i="${i}"><div class="name" title="${esc(k.name)}">${esc(k.name)}</div>
        <div class="track"><div class="fill" style="width:${(Math.abs(k.value) / max) * 100}%;background:${k.value < 0 ? '#c8443b' : dim === 'payerType' ? TYPE_COLORS[k.name] || colorFor(k.name) : colorFor(k.name)};opacity:.8"></div>
        <span class="val">${eur(k.value)} · ${pct(k.value, node.value)}</span></div></div>`).join('')
      : '<p class="muted">Último nivel.</p>';
    $('#dd-bars').querySelectorAll('.bar.drill').forEach((b) => { b.onclick = () => { state.drillPath.push(kids[Number(b.dataset.i)].name); renderDrill(); }; });
  }

  function renderTreeTable() {
    const tree = currentTree();
    const rows = [];
    const walk = (n, depth, key, parentValue) => {
      rows.push({ n, depth, key, parentValue });
      if (state.expanded.has(key)) n.children.forEach((c) => walk(c, depth + 1, `${key}/${c.name}`, n.value));
    };
    walk(tree, 0, '', tree.value);
    $('#tree-table tbody').innerHTML = rows.map(({ n, depth, key, parentValue }) => {
      const open = state.expanded.has(key);
      return `<tr class="l${Math.min(depth, 2)}"><td style="padding-left:${8 + depth * 18}px">${n.children.length ? `<span class="tog" data-k="${esc(key)}">${open ? '▾' : '▸'}</span>` : '<span class="tog"></span>'}${esc(n.name)}${n.dim ? `<span class="dimtag">${esc(M.DIMENSIONS[n.dim].label)}</span>` : ''}</td>
        <td class="num">${eur(n.value)}</td><td class="num"><span class="pct" style="width:${Math.min(60, (Math.abs(n.value) / (parentValue || 1)) * 60)}px"></span>${pct(n.value, parentValue)}</td>
        <td class="num">${pct(n.value, tree.value)}</td><td class="num">${n.months || '—'}</td><td class="num">${n.count}</td></tr>`;
    }).join('');
    $('#tree-table tbody').querySelectorAll('.tog[data-k]').forEach((t) => { t.onclick = () => { const k = t.dataset.k; if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k); renderTreeTable(); }; });
    $('#tt-expand').onclick = () => {
      const all = (n, key) => { state.expanded.add(key); n.children.forEach((c) => all(c, `${key}/${c.name}`)); };
      const t = currentTree();
      // Expanding everything can be large: stop at the month level if there are many rows.
      const depthLimit = state.model.entries.length > 400 ? 4 : 99;
      const limited = (n, key, d) => { if (d > depthLimit) return; state.expanded.add(key); n.children.forEach((c) => limited(c, `${key}/${c.name}`, d + 1)); };
      if (depthLimit === 99) all(t, ''); else limited(t, '', 0);
      renderTreeTable();
    };
    $('#tt-collapse').onclick = () => { state.expanded = new Set(['']); renderTreeTable(); };
  }

  // ---------- Timeline ----------
  document.querySelectorAll('.seg button[data-gran]').forEach((b) => {
    b.onclick = () => { state.gran = b.dataset.gran; document.querySelectorAll('.seg button[data-gran]').forEach((x) => x.classList.toggle('on', x === b)); renderTimeline(); };
  });

  function renderTimeline() {
    const sel = $('#tl-stack');
    if (!sel.options.length) {
      sel.innerHTML = STACK_DIMS.map((d) => `<option value="${d}">${esc(M.DIMENSIONS[d].label)}</option>`).join('');
      sel.onchange = () => { state.stackBy = sel.value; renderTimeline(); };
    }
    sel.value = state.stackBy;
    const box = $('#timeline'); box.innerHTML = '';
    const { rows, stackNames } = M.timeline(state.flows, { granularity: state.gran, stackBy: state.stackBy });
    // Gap months (no payment data) are appended so they are visible.
    const gapKeys = new Set(state.model.gaps.map((g) => (state.gran === 'month' ? g.period : g.period.slice(0, 4))));
    if (state.gran === 'month') for (const k of gapKeys) if (rows.length && k > rows.at(-1).key && Number(k.slice(0, 4)) <= state.filters.yearTo) rows.push({ key: k, total: 0, stacks: {} });
    if (!rows.length) { box.innerHTML = '<p class="muted">No hay datos con estos filtros.</p>'; $('#tl-legend').innerHTML = ''; return; }
    const width = Math.max(420, box.clientWidth || 600); const height = 320;
    const m = { l: 62, r: 10, t: 12, b: 34 };
    const iw = width - m.l - m.r; const ih = height - m.t - m.b;
    // Positive values stack upwards from 0, negative ones (refunds) downwards.
    const posSum = (r) => Object.values(r.stacks).filter((v) => v > 0).reduce((a, v) => a + v, 0);
    const negSum = (r) => Object.values(r.stacks).filter((v) => v < 0).reduce((a, v) => a + v, 0);
    const max = Math.max(...rows.map(posSum), 1); const min = Math.min(...rows.map(negSum), 0);
    const step = niceStep((max - min) / 5); const top = Math.ceil(max / step) * step; const bottom = Math.floor(min / step) * step;
    const y = (v) => ((top - v) / (top - bottom)) * ih;
    const bw = iw / rows.length;
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Evolución de las cotizaciones' }, box);
    const g = svg('g', { transform: `translate(${m.l},${m.t})` }, root);
    // ERTE / benefit periods shading.
    for (const bp of state.model.benefitPeriods) {
      const idx = rows.map((r, i) => (state.gran === 'month' ? r.key >= bp.from && r.key <= bp.to : r.key >= bp.from.slice(0, 4) && r.key <= bp.to.slice(0, 4)) ? i : -1).filter((i) => i >= 0);
      if (!idx.length) continue;
      const x0 = idx[0] * bw; const x1 = (idx.at(-1) + 1) * bw;
      svg('rect', { x: x0, y: 0, width: x1 - x0, height: ih, fill: '#8a6bbe', 'fill-opacity': 0.12 }, g);
      const t = svg('text', { x: (x0 + x1) / 2, y: 10, 'text-anchor': 'middle', 'font-size': 10, fill: '#5f43a0' }, g);
      t.textContent = bp.sepeIncluded ? 'ERTE' : 'ERTE · SEPE pendiente';
    }
    const grid = svg('g', { class: 'grid axis' }, g);
    for (let v = bottom; v <= top + 1e-6; v += step) {
      svg('line', { x1: 0, x2: iw, y1: y(v), y2: y(v) }, grid);
      svg('text', { x: -6, y: y(v), dy: '0.32em', 'text-anchor': 'end' }, grid).textContent = eur0(v);
    }
    const names = stackNames;
    const colorOf = (name) => (state.stackBy === 'payerType' ? TYPE_COLORS[name] || colorFor(name) : colorFor(name));
    rows.forEach((r, i) => {
      let acc = 0; let nacc = 0;
      const x = i * bw + Math.min(2, bw * 0.12);
      const w = Math.max(1, bw - 2 * Math.min(2, bw * 0.12));
      for (const name of names) {
        const v = r.stacks[name]; if (!v) continue;
        const from = v > 0 ? acc : nacc; const to = from + v;
        const attrs = { x, y: y(Math.max(from, to)), width: w, height: Math.max(0.5, Math.abs(y(to) - y(from))), fill: colorOf(name) };
        if (v < 0) Object.assign(attrs, { 'fill-opacity': 0.55, stroke: '#c8443b' });
        const rect = svg('rect', attrs, g);
        tip(rect, () => `<b>${esc(state.gran === 'month' ? M.periodLabel(r.key) : r.key)} · ${esc(name)}</b>${eur(v)} · ${pct(v, r.total)} · total ${eur(r.total)}`);
        if (v > 0) acc += v; else nacc += v;
      }
      if (gapKeys.has(r.key)) {
        const gx = svg('rect', { x, y: y(0) - 18, width: w, height: 18, fill: 'none', stroke: '#c8443b', 'stroke-dasharray': '3 2' }, g);
        tip(gx, () => `<b>Hueco ${esc(state.gran === 'month' ? M.periodLabel(r.key) : r.key)}</b>${esc(state.model.gaps.filter((gp) => gp.period.startsWith(r.key)).map((gp) => `${gp.regime}: ${gp.reason}`).join('; '))}`);
      }
      const label = state.gran === 'year' ? r.key : r.key.endsWith('-01') || i === 0 ? r.key.slice(0, 4) : '';
      if (label) svg('text', { x: i * bw + (state.gran === 'year' ? bw / 2 : 0), y: ih + 16, 'text-anchor': state.gran === 'year' ? 'middle' : 'start', class: 'axis' }, g).textContent = label;
    });
    svg('line', { x1: 0, x2: iw, y1: y(0), y2: y(0), stroke: '#9aa4b1' }, g);
    $('#tl-legend').innerHTML = names.map((n) => `<span><i style="background:${colorOf(n)}"></i>${esc(n)}</span>`).join('')
      + (state.model.benefitPeriods.length ? '<span><i style="background:#8a6bbe;opacity:.3"></i>ERTE / prestación</span>' : '')
      + (state.model.gaps.length ? '<span><i style="border:1px dashed #c8443b;background:none"></i>Hueco sin datos</span>' : '');
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- Issues ----------
  function renderIssues() {
    const list = M.issues(state.model);
    const f = state.filters;
    const visible = list.filter((i) => !i.period || (Number(i.period.slice(0, 4)) >= f.yearFrom && Number(i.period.slice(0, 4)) <= f.yearTo));
    $('#issues-count').textContent = `${visible.length} de ${list.length}`;
    $('#issues').innerHTML = visible.map((i) => `<li class="${i.level}"${i.original ? ` title="${esc(i.original)}"` : ''}><b>${esc(i.title)}</b>${esc(i.text)}</li>`).join('') || '<li>Sin avisos en este periodo.</li>';
  }

  // ---------- Movements ----------
  const MV_COLS = [
    { key: 'period', label: 'Periodo', get: (e) => (e.month === null ? `${e.from}..${e.to}` : e.period) },
    { key: 'regime', label: 'Régimen', get: (e) => e.regime || '' },
    { key: 'employerLabel', label: 'Empresa / empleador', get: (e) => e.employerLabel },
    { key: 'payerLabel', label: 'Pagador', get: (e) => e.payerLabel },
    { key: 'channel', label: 'Canal', get: (e) => M.CHANNEL_LABEL[e.channel] || e.channel },
    { key: 'liquidationType', label: 'Liq.', get: (e) => e.liquidationType || '' },
    { key: 'base', label: 'Base', num: true, get: (e) => e.base },
    { key: 'amount', label: 'Cuota', num: true, get: (e) => e.amount },
    { key: 'surcharge', label: 'Recargo', num: true, get: (e) => e.surcharge },
    { key: 'total', label: 'Total', num: true, get: (e) => e.total },
  ];

  $('#mv-search').addEventListener('input', (ev) => { state.search = ev.target.value.trim().toLowerCase(); renderMovements(filteredEntries()); });

  function renderMovements(entries) {
    const s = state.sort;
    $('#movements thead').innerHTML = `<tr>${MV_COLS.map((c) => `<th class="${c.num ? 'num' : ''}" data-k="${c.key}">${esc(c.label)}${s.col === c.key ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
    $('#movements thead').querySelectorAll('th').forEach((th) => { th.onclick = () => { s.dir = s.col === th.dataset.k ? -s.dir : 1; s.col = th.dataset.k; renderMovements(filteredEntries()); }; });
    const col = MV_COLS.find((c) => c.key === s.col);
    let list = entries.filter((e) => !state.search || MV_COLS.map((c) => c.get(e)).concat([e.periodLabel]).join(' ').toLowerCase().includes(state.search));
    list = list.slice().sort((a, b) => { const x = col.get(a); const y = col.get(b); return (col.num ? (x || 0) - (y || 0) : String(x).localeCompare(String(y))) * s.dir || a.id - b.id; });
    const shown = list.slice(0, 600);
    $('#movements tbody').innerHTML = shown.map((e) => `<tr data-id="${e.id}" title="Clic para ver los conceptos">${MV_COLS.map((c) => {
      const v = c.get(e);
      const badge = c.key === 'period' && e.benefitOverlap ? '<span class="badge">ERTE</span>'
        : c.key === 'period' && e.baseStatus ? BASE_BADGE[e.baseStatus] || ''
          : c.key === 'payerLabel' && e.sourceReport === 'reta-regularization' ? '<span class="badge reg">regularización</span>'
            : c.key === 'payerLabel' && e.payerType === 'public_agency' ? '<span class="badge sepe">SEPE</span>' : '';
      return `<td class="${c.num ? 'num' : ''}">${c.num ? (v === null || v === undefined ? '—' : eur(v)) : esc(v)}${badge}</td>`;
    }).join('')}</tr>`).join('');
    $('#movements tbody').querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.onclick = () => {
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('concepts')) { next.remove(); return; }
        const e = state.model.entries.find((x) => String(x.id) === tr.dataset.id);
        const parts = M.toFlows([e]);
        const extra = e.regularization ? ` · incluye ${e.regularization.includedDifference >= 0 ? '+' : ''}${eur(e.regularization.includedDifference)} de la regularización ${e.regularization.year} (cuota provisional ${eur(e.regularization.provisionalQuota)})` : e.sourceReport === 'reta-regularization' ? `${e.dueDate ? ` · fecha límite ${e.dueDate}` : ''}${e.refundDate ? ` · devuelta ${e.refundDate}` : ''}${e.paymentStatus ? ` · estado ${e.paymentStatus}` : ''}` : e.payerType === 'public_agency' ? ` · prestación bruta ${eur(e.grossBenefit)} · IRPF ${eur(e.irpfWithheld)} · neto ${eur(e.netBenefit)}` : '';
        const row = document.createElement('tr'); row.className = 'concepts';
        row.innerHTML = `<td colspan="${MV_COLS.length}">${parts.map((p) => `${esc(p.group)} › ${esc(p.concept)}: <b>${eur(p.value)}</b>`).join(' · ')}${extra}<br><span class="muted">${esc(e.sourceFile || '')}</span></td>`;
        tr.after(row);
      };
    });
    const sum = list.reduce((a, e) => a + e.total, 0);
    $('#mv-info').textContent = `${list.length} movimiento(s) · ${eur(sum)}${list.length > shown.length ? ` · se muestran ${shown.length}` : ''}`;
  }

  // ---------- Tooltip ----------
  const tooltip = $('#tooltip');
  function tip(el, html) {
    el.addEventListener('mousemove', (ev) => {
      tooltip.innerHTML = html(); tooltip.hidden = false;
      const x = Math.min(window.innerWidth - tooltip.offsetWidth - 10, ev.clientX + 14);
      tooltip.style.left = `${x}px`; tooltip.style.top = `${ev.clientY + 14}px`;
    });
    el.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.model) { renderSankey(); renderTimeline(); } }, 150); });

  // ---------- Embedded data ----------
  try {
    const raw = document.getElementById('report-data').textContent.trim();
    const embedded = raw && raw !== '__REPORT_DATA__' ? JSON.parse(raw) : null;
    if (embedded) load(embedded.report || embedded, embedded.label || 'Informe incrustado');
  } catch (e) {
    console.error(e);
    alert(`Los datos incrustados no son válidos: ${e.message}`);
  }
})();
