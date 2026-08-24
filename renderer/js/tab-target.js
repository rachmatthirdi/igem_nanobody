(function () {
  let viewer3d = null;
  let residueIndex = []; // ordered list of residue numbers (chain A) used to lay out tracks
  let resMin = 0, resMax = 0;
  let resNumToAA = new Map(); // chain A resNum -> one-letter amino acid code, for labels like "L102"

  const AA_3TO1 = {
    ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
    GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
    PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', MSE: 'M',
  };

  function $(id) { return document.getElementById(id); }

  // Fallback residue numbering straight from chain A CA atoms, used when
  // both FreeSASA and DiscoTope failed (e.g. conda envs not set up yet) so
  // the domain track / 3D viewer still have something to lay out on.
  function residueNumbersFromChainA(pdbText) {
    const seen = new Set();
    for (const line of pdbText.split(/\r?\n/)) {
      if (!line.startsWith('ATOM')) continue;
      if (line.charAt(21) !== 'A') continue;
      if (line.slice(12, 16).trim() !== 'CA') continue;
      seen.add(parseInt(line.slice(22, 26), 10));
    }
    return [...seen].sort((a, b) => a - b);
  }

  // Chain A resNum -> one-letter amino acid code, so residues can be shown
  // as e.g. "L102" instead of a bare position number.
  function buildResNumToAA(pdbText) {
    const map = new Map();
    for (const line of pdbText.split(/\r?\n/)) {
      if (!line.startsWith('ATOM')) continue;
      if (line.charAt(21) !== 'A') continue;
      if (line.slice(12, 16).trim() !== 'CA') continue;
      const resNum = parseInt(line.slice(22, 26), 10);
      const resName = line.slice(17, 20).trim();
      map.set(resNum, AA_3TO1[resName] || 'X');
    }
    return map;
  }

  // Human-readable residue label, e.g. "L102"; falls back to the bare
  // number if the amino acid identity isn't known yet.
  function resLabel(resNum) {
    const aa = resNumToAA.get(resNum);
    return aa ? `${aa}${resNum}` : `${resNum}`;
  }

  function initViewerWhenReady() {
    if (viewer3d) return;
    const create = () => {
      viewer3d = new window.Viewer3D($('viewer3d-container'));
      viewer3d.onResidueClick((chain, resNum) => {
        if (chain !== 'A') return;
        toggleHotspot(resNum);
      });
    };
    if (window.Viewer3D) create();
    else window.addEventListener('viewer3d-ready', create, { once: true });
  }

  // ---------------- Phase 1: input ----------------
  function wireInput() {
    document.querySelectorAll('.example-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('pdb-id-input').value = btn.dataset.pdb;
      });
    });
    $('btn-analyze').addEventListener('click', runAnalysis);
    $('pdb-id-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runAnalysis();
    });
  }

  async function runAnalysis() {
    const pdbId = $('pdb-id-input').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(pdbId)) {
      window.ConsolePanel.log('error', 'PDB ID must be 4 alphanumeric characters.', 'target');
      return;
    }
    $('analysis-progress-card').style.display = '';
    $('hotspot-map-card').style.display = 'none';
    window.StateUtils.reset();
    window.AppState.pdbId = pdbId;

    let dl;
    try {
      dl = await window.api.fetchPdb(pdbId);
    } catch (e) {
      window.ConsolePanel.log('error', `Failed to download ${pdbId}: ${e.message}`, 'target');
      return;
    }
    window.AppState.pdbPath = dl.pdbPath;
    window.AppState.chainAPath = dl.chainAPath;
    window.AppState.structureTitle = dl.title;

    const [interpro, sasa, disco] = await Promise.allSettled([
      window.api.runInterpro({ pdbId, forceRefresh: false }),
      window.api.runFreesasa({ chainAPath: dl.chainAPath }),
      window.api.runDiscotope({ chainAPath: dl.chainAPath, pdbId }),
    ]);

    window.AppState.domains = interpro.status === 'fulfilled' ? interpro.value.domains : [];
    window.AppState.sasaResidues = sasa.status === 'fulfilled' ? sasa.value.residues : [];
    window.AppState.discotopeResidues = disco.status === 'fulfilled' ? disco.value.residues : [];

    if (disco.status === 'rejected') {
      window.ConsolePanel.log('warn', `DiscoTope-3.0 did not run: ${disco.reason.message}`, 'target');
    }
    if (sasa.status === 'rejected') {
      window.ConsolePanel.log('warn', `FreeSASA did not run: ${sasa.reason.message}`, 'target');
    }

    await renderHotspotMap();
  }

  // ---------------- Phase 3: hotspot map ----------------
  async function renderHotspotMap() {
    $('hotspot-map-card').style.display = '';
    $('structure-title').textContent = window.AppState.structureTitle || '';

    let fullPdbText = null;
    initViewerWhenReady();
    try {
      fullPdbText = await window.api.readPdbFile(window.AppState.pdbPath);
      resNumToAA = buildResNumToAA(fullPdbText);
      if (viewer3d) setTimeout(() => viewer3d.loadPdb(fullPdbText), 50);
    } catch (e) {
      window.ConsolePanel.log('warn', `Failed to load 3D structure: ${e.message}`, 'target');
    }

    // residue index derived from SASA (chain A canonical numbering), falling
    // back to DiscoTope, and finally to chain A itself if both external
    // tools are unavailable (e.g. conda envs not yet installed) - the
    // domain track and 3D viewer should still work even then.
    const source = window.AppState.sasaResidues.length ? window.AppState.sasaResidues : window.AppState.discotopeResidues;
    residueIndex = source.length
      ? [...new Set(source.map((r) => r.resNum))].sort((a, b) => a - b)
      : fullPdbText ? residueNumbersFromChainA(fullPdbText) : [];
    resMin = residueIndex[0] ?? 0;
    resMax = residueIndex[residueIndex.length - 1] ?? 0;

    renderDomainTrack();
    renderDomainTable();
    renderSasaTrack();
    renderDiscotopeTrack();
    renderHotspotChips();
  }

  function resToPct(resNum) {
    if (resMax === resMin) return 0;
    return ((resNum - resMin) / (resMax - resMin)) * 100;
  }

  function showTooltip(evt, html) {
    const tip = $('track-tooltip');
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const containerRect = document.querySelector('.tracks-container').getBoundingClientRect();
    tip.style.left = `${evt.clientX - containerRect.left + 12}px`;
    tip.style.top = `${evt.clientY - containerRect.top - 10}px`;
  }
  function hideTooltip() { $('track-tooltip').classList.add('hidden'); }

  function renderDomainTrack() {
    const el = $('track-domains');
    el.innerHTML = '';
    const domains = window.AppState.domains || [];
    const lanes = []; // each lane: list of {start,end}

    const segments = [];
    for (const dom of domains) {
      for (const loc of dom.locations || []) {
        segments.push({ ...loc, dom });
      }
    }
    segments.sort((a, b) => a.start - b.start);

    for (const seg of segments) {
      let laneIdx = lanes.findIndex((lane) => lane.every((s) => seg.start > s.end || seg.end < s.start));
      if (laneIdx === -1) {
        lanes.push([]);
        laneIdx = lanes.length - 1;
      }
      lanes[laneIdx].push(seg);
    }

    lanes.forEach((lane, laneIdx) => {
      const laneEl = document.createElement('div');
      laneEl.className = 'track-domain-lane';
      lane.forEach((seg) => {
        const segEl = document.createElement('div');
        segEl.className = 'track-domain-seg';
        const left = resToPct(seg.start);
        const width = Math.max(resToPct(seg.end) - left, 1);
        segEl.style.left = `${left}%`;
        segEl.style.width = `${width}%`;
        segEl.textContent = seg.dom.name || seg.dom.accession;
        segEl.addEventListener('mouseenter', (e) => showTooltip(e, `<b>${seg.dom.accession}</b><br>${seg.dom.name || ''}<br>${seg.start}-${seg.end}`));
        segEl.addEventListener('mousemove', (e) => showTooltip(e, `<b>${seg.dom.accession}</b><br>${seg.dom.name || ''}<br>${seg.start}-${seg.end}`));
        segEl.addEventListener('mouseleave', hideTooltip);
        laneEl.appendChild(segEl);
      });
      el.appendChild(laneEl);
    });

    if (!segments.length) {
      el.innerHTML = '<div style="padding:6px;color:var(--text-dim);font-size:11px">No InterPro domains found.</div>';
    }
  }

  function renderDomainTable() {
    const tbody = document.querySelector('#domain-table tbody');
    tbody.innerHTML = '';
    for (const dom of window.AppState.domains || []) {
      const posStr = (dom.locations || []).map((l) => `${l.start}-${l.end}`).join(', ');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${dom.accession || ''}</td><td>${dom.name || ''}</td><td>${dom.type || ''}</td><td>${posStr}</td>`;
      tbody.appendChild(tr);
    }
  }

  function colorScaleBlue(t) {
    // t in [0,1] -> light to saturated blue
    const l = 85 - t * 55;
    return `hsl(212, 70%, ${l}%)`;
  }
  function colorScaleOrangeRed(t) {
    const hue = 40 - t * 40; // 40 (orange) -> 0 (red)
    const l = 75 - t * 35;
    return `hsl(${hue}, 80%, ${l}%)`;
  }

  function cellWidthPct() {
    return Math.max(100 / Math.max(residueIndex.length, 1), 0.15);
  }

  function renderSasaTrack() {
    const el = $('track-sasa');
    el.innerHTML = '';
    const byRes = new Map(window.AppState.sasaResidues.map((r) => [r.resNum, r]));
    const maxRsa = 1.0;
    const w = cellWidthPct();
    for (const resNum of residueIndex) {
      const r = byRes.get(resNum);
      const rsa = r ? Math.min(r.rsa ?? 0, maxRsa) : 0;
      const cell = document.createElement('div');
      cell.className = 'track-cell';
      cell.dataset.res = resNum;
      cell.style.left = `${resToPct(resNum)}%`;
      cell.style.width = `${w}%`;
      cell.style.background = colorScaleBlue(rsa);
      cell.addEventListener('mouseenter', (e) => showTooltip(e, `Res ${resLabel(resNum)}${r ? `<br>SASA: ${r.sasa?.toFixed(1)} Å²<br>RSA: ${(r.rsa ?? 0).toFixed(2)}` : '<br>no data'}`));
      cell.addEventListener('mousemove', (e) => showTooltip(e, `Res ${resLabel(resNum)}${r ? `<br>SASA: ${r.sasa?.toFixed(1)} Å²<br>RSA: ${(r.rsa ?? 0).toFixed(2)}` : '<br>no data'}`));
      cell.addEventListener('mouseleave', hideTooltip);
      cell.addEventListener('click', () => toggleHotspot(resNum));
      el.appendChild(cell);
    }
  }

  function renderDiscotopeTrack() {
    const el = $('track-discotope');
    el.innerHTML = '';
    const byRes = new Map(window.AppState.discotopeResidues.map((r) => [r.resNum, r]));
    const w = cellWidthPct();
    for (const resNum of residueIndex) {
      const r = byRes.get(resNum);
      const score = r ? Math.min(Math.max(r.discotopeScore ?? 0, 0), 1) : 0;
      const cell = document.createElement('div');
      cell.className = 'track-cell';
      cell.dataset.res = resNum;
      cell.style.left = `${resToPct(resNum)}%`;
      cell.style.width = `${w}%`;
      cell.style.background = colorScaleOrangeRed(score);
      if (r?.predictedEpitope) cell.style.boxShadow = 'inset 0 0 0 1px #fff';
      cell.addEventListener('mouseenter', (e) => showTooltip(e, `Res ${resLabel(resNum)}${r ? `<br>DiscoTope: ${score.toFixed(2)}<br>Epitope: ${r.predictedEpitope ? 'Yes' : 'No'}` : '<br>no data'}`));
      cell.addEventListener('mousemove', (e) => showTooltip(e, `Res ${resLabel(resNum)}${r ? `<br>DiscoTope: ${score.toFixed(2)}<br>Epitope: ${r.predictedEpitope ? 'Yes' : 'No'}` : '<br>no data'}`));
      cell.addEventListener('mouseleave', hideTooltip);
      cell.addEventListener('click', () => toggleHotspot(resNum));
      el.appendChild(cell);
    }
  }

  // ---------------- Hotspot selection ----------------
  function toggleHotspot(resNum) {
    const arr = window.AppState.hotspotResidues;
    const idx = arr.indexOf(resNum);
    if (idx === -1) arr.push(resNum);
    else arr.splice(idx, 1);
    arr.sort((a, b) => a - b);
    renderHotspotChips();
    syncTrackHighlights();
  }

  function syncTrackHighlights() {
    const set = new Set(window.AppState.hotspotResidues);
    document.querySelectorAll('#track-sasa .track-cell, #track-discotope .track-cell').forEach((cell) => {
      cell.classList.toggle('hotspot-selected', set.has(Number(cell.dataset.res)));
    });
    if (viewer3d) viewer3d.highlightResidues('A', window.AppState.hotspotResidues);
  }

  function renderHotspotChips() {
    const container = $('hotspot-chips');
    container.innerHTML = '';
    for (const resNum of window.AppState.hotspotResidues) {
      const chip = document.createElement('span');
      chip.className = 'hotspot-chip';
      chip.textContent = `${resLabel(resNum)} ✕`;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => toggleHotspot(resNum));
      container.appendChild(chip);
    }
    $('hotspot-count').textContent = `${window.AppState.hotspotResidues.length} residues selected`;
    syncTrackHighlights();
  }

  function wireHotspotControls() {
    $('btn-select-epitope').addEventListener('click', () => {
      const epitopes = window.AppState.discotopeResidues.filter((r) => r.predictedEpitope).map((r) => r.resNum);
      window.AppState.hotspotResidues = [...new Set(epitopes)].sort((a, b) => a - b);
      renderHotspotChips();
    });
    $('btn-select-top20').addEventListener('click', () => {
      const top20 = [...window.AppState.discotopeResidues]
        .sort((a, b) => (b.discotopeScore ?? 0) - (a.discotopeScore ?? 0))
        .slice(0, 20)
        .map((r) => r.resNum);
      window.AppState.hotspotResidues = [...new Set(top20)].sort((a, b) => a - b);
      renderHotspotChips();
    });
    $('btn-clear-hotspots').addEventListener('click', () => {
      window.AppState.hotspotResidues = [];
      renderHotspotChips();
    });
    $('btn-goto-design').addEventListener('click', () => {
      if (!window.AppState.hotspotResidues.length) {
        window.ConsolePanel.log('warn', 'Select at least one hotspot residue before continuing to Design.', 'target');
        return;
      }
      window.App.switchTab('design');
    });
  }

  window.TabTarget = { init() { wireInput(); wireHotspotControls(); } };
})();
