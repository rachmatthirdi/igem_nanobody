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
  }

  function onSelectCandidate(id, checked, checkbox) {
    const sel = window.AppState.selectedCandidateIds;
    if (checked) {
      if (sel.length >= MAX_SELECTED) {
        checkbox.checked = false;
        window.ConsolePanel.log('warn', `Maksimal ${MAX_SELECTED} kandidat dapat dipilih untuk codon optimization.`, 'screening');
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
    $('selected-candidates-summary').textContent = sel.length ? sel.join(', ') : 'Belum ada kandidat dipilih.';
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

  async function extractAminoAcidSeq(candidate) {
    const pdbText = await window.api.readPdbFile(candidate.pdbPath);
    const seenRes = new Set();
    const AA_3TO1 = { ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V',MSE:'M' };
    let seq = '';
    for (const line of pdbText.split(/\r?\n/)) {
      if (!line.startsWith('ATOM')) continue;
      if (line.charAt(21) !== 'H') continue;
      if (line.slice(12, 16).trim() !== 'CA') continue;
      const resNum = line.slice(22, 26).trim();
      if (seenRes.has(resNum)) continue;
      seenRes.add(resNum);
      seq += AA_3TO1[line.slice(17, 20).trim()] || 'X';
    }
    return seq;
  }

  async function runCodonOptimization() {
    const organism = $('f-organism').value;
    const resultsEl = $('codon-results');
    resultsEl.innerHTML = '';
    $('btn-codon-optimize').disabled = true;

    for (const id of window.AppState.selectedCandidateIds) {
      const candidate = window.AppState.candidates.find((c) => c.id === id);
      if (!candidate) continue;
      try {
        const aaSeq = candidate.aminoAcidSeq || (await extractAminoAcidSeq(candidate));
        candidate.aminoAcidSeq = aaSeq;
        const result = await window.api.codonOptimize({ aminoAcidSeq: aaSeq, organism });
        candidate.dna = result.sequence_dna;
        candidate.cai = result.cai;
        candidate.gcContent = result.gc_content;
        candidate.codonMethod = result.method;

        const div = document.createElement('div');
        div.className = 'card';
        div.innerHTML = `
          <div class="section-label">${id} — metode: ${result.method}</div>
          <div class="sequence-view">${result.sequence_dna}</div>
          <div class="anchor-meta">CAI: ${result.cai?.toFixed(3)} &nbsp;|&nbsp; GC%: ${result.gc_content?.toFixed(1)}%</div>
        `;
        resultsEl.appendChild(div);
      } catch (e) {
        window.ConsolePanel.log('error', `Codon optimization gagal untuk ${id}: ${e.message}`, 'screening');
      }
    }
    $('btn-codon-optimize').disabled = false;
    if (window.TabConstruct) window.TabConstruct.refreshCandidateOptions();
  }

  function wireImport() {
    $('btn-import-metrics').addEventListener('click', async () => {
      const res = await window.api.importMetricsDialog({ candidates: window.AppState.candidates });
      if (res.imported) {
        window.AppState.candidates = res.candidates;
        $('import-status').textContent = `Diimpor dari ${res.fileName}`;
        renderTable();
      }
    });
  }

  window.TabScreening = {
    init() {
      wireFilters();
      wireImport();
      $('btn-codon-optimize').addEventListener('click', runCodonOptimization);
    },
    refresh() { renderTable(); },
  };
})();
