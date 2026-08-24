(function () {
  function $(id) { return document.getElementById(id); }
  const MAX_SELECTED = 3;

  const IDEAL = {
    plddt: { worst: 50, best: 95 },
    pae: { worst: 25, best: 2 },
    cdrRmsd: { worst: 6, best: 0.5 },
    h3Rmsd: { worst: 8, best: 1 },
    dg: { worst: 0, best: -15 },
  };

  function normalize(value, key) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    const { worst, best } = IDEAL[key];
    const t = (value - worst) / (best - worst);
    return Math.max(0, Math.min(1, t));
  }

  function compositeScore(c) {
    const w = window.AppState.filterWeights;
    const parts = [
      [normalize(c.plddt, 'plddt'), w.plddt],
      [normalize(c.pae, 'pae'), w.pae],
      [normalize(c.cdrRmsd, 'cdrRmsd'), w.cdrRmsd],
      [normalize(c.h3Rmsd, 'h3Rmsd'), w.h3Rmsd],
      [normalize(c.dg, 'dg'), w.dg],
    ].filter(([v]) => v !== null);
    if (!parts.length) return 0;
    const totalWeight = parts.reduce((s, [, wgt]) => s + wgt, 0);
    const sum = parts.reduce((s, [v, wgt]) => s + v * wgt, 0);
    return (sum / totalWeight) * 100;
  }

  function passesFilters(c) {
    const fPlddt = Number($('f-plddt').value);
    const fPae = Number($('f-pae').value);
    const fCdr = Number($('f-cdrrmsd').value);
    const fH3 = Number($('f-h3rmsd').value);
    const fDg = Number($('f-dg').value);
    return (
      (c.plddt ?? 0) >= fPlddt &&
      (c.pae ?? 999) <= fPae &&
      (c.cdrRmsd ?? 999) <= fCdr &&
      (c.h3Rmsd ?? 999) <= fH3 &&
      (c.dg ?? 999) <= fDg
    );
  }

  function fmt(v, digits = 1) {
    return v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(digits);
  }

  function renderTable() {
    const tbody = document.querySelector('#candidates-table tbody');
    tbody.innerHTML = '';
    const candidates = [...window.AppState.candidates];
    candidates.forEach((c) => { c.composite = compositeScore(c); c.pass = passesFilters(c); });
    candidates.sort((a, b) => b.composite - a.composite);

    for (const c of candidates) {
      const tr = document.createElement('tr');
      const checked = window.AppState.selectedCandidateIds.includes(c.id) ? 'checked' : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="cand-checkbox" data-id="${c.id}" ${checked} /></td>
        <td>${c.id}</td>
        <td>${fmt(c.plddt)}</td>
        <td>${fmt(c.pae)}</td>
        <td>${fmt(c.cdrRmsd)}</td>
        <td>${fmt(c.h3Rmsd)}</td>
        <td>${fmt(c.dg)}</td>
        <td>${fmt(c.composite, 1)}%</td>
        <td class="${c.pass ? 'status-pass' : 'status-fail'}">${c.pass ? 'PASS' : 'FAIL'}</td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.cand-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => onSelectCandidate(cb.dataset.id, cb.checked, cb));
    });

    updateSelectionSummary();
    renderChart(candidates);
  }

  function chartTooltipHtml(c) {
    return `<b>${c.id}</b><br>pLDDT ${fmt(c.plddt)} · PAE ${fmt(c.pae)}<br>CDR RMSD ${fmt(c.cdrRmsd)} Å · H3 RMSD ${fmt(c.h3Rmsd)} Å<br>ΔG ${fmt(c.dg)} kcal/mol`;
  }

  function showChartTooltip(evt, c) {
    const tip = $('chart-tooltip');
    tip.innerHTML = chartTooltipHtml(c);
    tip.classList.remove('hidden');
    const containerRect = document.querySelector('.candidates-chart').getBoundingClientRect();
    tip.style.left = `${evt.clientX - containerRect.left + 12}px`;
    tip.style.top = `${evt.clientY - containerRect.top - 10}px`;
  }
  function hideChartTooltip() { $('chart-tooltip').classList.add('hidden'); }

  // Ranked bar chart: composite score per candidate, colored by pass/fail.
  // Status is never color-alone - each bar also carries a PASS/FAIL text label.
  function renderChart(candidates) {
    const el = $('candidates-chart');
    el.innerHTML = '';
    if (!candidates.length) {
      el.innerHTML = '<div style="padding:6px;color:var(--text-dim);font-size:11px">No candidates yet.</div>';
      return;
    }
    for (const c of candidates) {
      const row = document.createElement('div');
      row.className = 'chart-row';

      const label = document.createElement('div');
      label.className = 'chart-label';
      label.textContent = c.id;
      label.title = c.id;

      const track = document.createElement('div');
      track.className = 'chart-bar-track';
      const fill = document.createElement('div');
      fill.className = `chart-bar-fill ${c.pass ? 'chart-bar-pass' : 'chart-bar-fail'}`;
      fill.style.width = `${Math.max(c.composite, 0).toFixed(1)}%`;
      track.appendChild(fill);
      track.addEventListener('mouseenter', (e) => showChartTooltip(e, c));
      track.addEventListener('mousemove', (e) => showChartTooltip(e, c));
      track.addEventListener('mouseleave', hideChartTooltip);

      const value = document.createElement('div');
      value.className = `chart-value ${c.pass ? 'status-pass' : 'status-fail'}`;
      value.textContent = `${fmt(c.composite, 1)}% ${c.pass ? 'PASS' : 'FAIL'}`;

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(value);
      el.appendChild(row);
    }
  }

  function onSelectCandidate(id, checked, checkbox) {
    const sel = window.AppState.selectedCandidateIds;
    if (checked) {
      if (sel.length >= MAX_SELECTED) {
        checkbox.checked = false;
        window.ConsolePanel.log('warn', `A maximum of ${MAX_SELECTED} candidates can be selected for codon optimization.`, 'screening');
        return;
      }
      sel.push(id);
    } else {
      const idx = sel.indexOf(id);
      if (idx !== -1) sel.splice(idx, 1);
    }
    updateSelectionSummary();
  }

  function updateSelectionSummary() {
    const sel = window.AppState.selectedCandidateIds;
    $('selected-candidates-summary').textContent = sel.length ? sel.join(', ') : 'No candidates selected yet.';
    $('btn-codon-optimize').disabled = sel.length === 0;
  }

  function wireFilters() {
    const map = [
      ['f-plddt', 'val-f-plddt', 0],
      ['f-pae', 'val-f-pae', 0],
      ['f-cdrrmsd', 'val-f-cdrrmsd', 1],
      ['f-h3rmsd', 'val-f-h3rmsd', 1],
      ['f-dg', 'val-f-dg', 1],
    ];
    for (const [sliderId, valId, digits] of map) {
      const slider = $(sliderId);
      slider.addEventListener('input', () => {
        $(valId).textContent = Number(slider.value).toFixed(digits);
        renderTable();
      });
    }
  }

  function wireImport() {
    $('btn-import-metrics').addEventListener('click', async () => {
      const res = await window.api.importMetricsDialog({ candidates: window.AppState.candidates });
      if (res.imported) {
        window.AppState.candidates = res.candidates;
        $('import-status').textContent = `Imported from ${res.fileName}`;
        renderTable();
      }
    });
  }

  window.TabScreening = {
    init() {
      wireFilters();
      wireImport();
    },
    refresh() { renderTable(); },
  };
})();
