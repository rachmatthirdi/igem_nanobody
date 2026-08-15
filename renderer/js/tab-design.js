(function () {
  function $(id) { return document.getElementById(id); }
  let scaffoldLoaded = false;

  function wireSliders() {
    const pairs = [
      ['slider-backbone-number', 'val-backbone-number', (v) => v],
      ['slider-mpnn-designs', 'val-mpnn-designs', (v) => v],
      ['slider-mpnn-temp', 'val-mpnn-temp', (v) => Number(v).toFixed(2)],
    ];
    for (const [sliderId, valId, fmt] of pairs) {
      const slider = $(sliderId);
      slider.addEventListener('input', () => { $(valId).textContent = fmt(slider.value); });
    }
  }

  async function loadScaffold() {
    if (scaffoldLoaded) return;
    const scaffoldName = $('scaffold-select').value;
    try {
      const result = await window.api.getScaffoldSequence({ scaffoldName });
      window.AppState.scaffold = result;
      renderScaffoldSequence(result);
      renderCdrRanges(result.cdr);
      scaffoldLoaded = true;
    } catch (e) {
      $('scaffold-sequence').textContent = `⚠ ${e.message}`;
      window.ConsolePanel.log('warn', `Gagal memuat scaffold: ${e.message}`, 'design');
    }
  }

  function renderScaffoldSequence(scaffold) {
    const cdrResidues = new Set();
    for (const key of Object.keys(scaffold.cdr || {})) {
      for (const r of scaffold.cdr[key].residues) cdrResidues.add(r);
    }
    let html = '';
    scaffold.sequence.split('').forEach((aa, i) => {
      const resNum = scaffold.residueNumbers[i];
      html += cdrResidues.has(resNum) ? `<span class="aa-cdr" title="${resNum}">${aa}</span>` : `<span title="${resNum}">${aa}</span>`;
    });
    $('scaffold-sequence').innerHTML = html;
  }

  function renderCdrRanges(cdr) {
    for (const label of ['H1', 'H2', 'H3']) {
      const el = $(`cdr-${label.toLowerCase()}-range`);
      if (cdr && cdr[label]) el.textContent = `${cdr[label].start}-${cdr[label].end}`;
      else el.textContent = '(tidak ditemukan di REMARK PDBinfo-LABEL)';
    }
  }

  function setBadge(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = `badge ${cls}`;
  }

  function buildScaffoldConfig() {
    const cdrConfig = `H1:${$('cdr-h1-len').value},H2:${$('cdr-h2-len').value},H3:${$('cdr-h3-len').value}`;
    return {
      scaffold_name: $('scaffold-select').value,
      cdr_designed: ['H1', 'H2', 'H3'],
      cdr_config: cdrConfig,
      backbone_number: Number($('slider-backbone-number').value),
      mpnn_designs: Number($('slider-mpnn-designs').value),
      mpnn_temperature: Number($('slider-mpnn-temp').value),
    };
  }

  async function runPipeline() {
    if (!window.AppState.chainAPath || !window.AppState.hotspotResidues.length) {
      window.ConsolePanel.log('error', 'Selesaikan Tab Target (pilih hotspot) sebelum menjalankan AI Design Pipeline.', 'design');
      return;
    }
    if (!window.AppState.scaffold) {
      window.ConsolePanel.log('error', 'Scaffold belum termuat. Periksa path RFantibody di Settings.', 'design');
      return;
    }

    const cfg = buildScaffoldConfig();
    window.AppState.scaffoldConfig = cfg;
    $('btn-run-pipeline').disabled = true;
    $('btn-goto-screening').disabled = true;

    try {
      setBadge('badge-rfdiffusion', 'Berjalan...', 'badge-running');
      const rfd = await window.api.runRfdiffusion({
        targetPdbPath: window.AppState.chainAPath,
        pdbId: window.AppState.pdbId,
        scaffoldFilePath: window.AppState.scaffold.filePath,
        outputName: `${window.AppState.pdbId}_${Date.now()}`,
        numDesigns: cfg.backbone_number,
        designLoops: cfg.cdr_config,
        hotspotResidues: window.AppState.hotspotResidues,
      });
      window.AppState.backbones = rfd.backbones;
      window.AppState.backboneDir = rfd.backboneDir;
      window.AppState.targetTPath = rfd.targetTPath;
      setBadge('badge-rfdiffusion', `Selesai (${rfd.backbones.length} backbone)`, 'badge-ok');

      setBadge('badge-proteinmpnn', 'Berjalan...', 'badge-running');
      const mpnn = await window.api.runProteinMpnn({
        backboneDir: rfd.backboneDir,
        designsPerBackbone: cfg.mpnn_designs,
        temperature: cfg.mpnn_temperature,
      });
      window.AppState.seqDir = mpnn.seqDir;
      setBadge('badge-proteinmpnn', 'Selesai', 'badge-ok');

      setBadge('badge-rf2', 'Berjalan...', 'badge-running');
      const rf2 = await window.api.runRf2({ seqDir: mpnn.seqDir, numRecycles: 10 });
      window.AppState.rf2OutDir = rf2.rf2OutDir;
      setBadge('badge-rf2', 'Selesai', 'badge-ok');

      const scoring = await window.api.scoreCandidates({
        rf2OutDir: rf2.rf2OutDir,
        backboneDir: rfd.backboneDir,
        cdr: window.AppState.scaffold.cdr,
      });
      window.AppState.candidates = scoring.candidates || [];
      window.ConsolePanel.log('ok', `${window.AppState.candidates.length} kandidat siap discreening.`, 'design');
      $('btn-goto-screening').disabled = false;
      if (window.TabScreening) window.TabScreening.refresh();
    } catch (e) {
      window.ConsolePanel.log('error', `Pipeline gagal: ${e.message}`, 'design');
      ['badge-rfdiffusion', 'badge-proteinmpnn', 'badge-rf2'].forEach((id) => {
        if ($(id).textContent.includes('Berjalan')) setBadge(id, 'Gagal', 'badge-error');
      });
    } finally {
      $('btn-run-pipeline').disabled = false;
    }
  }

  async function checkGpuWarning() {
    try {
      const status = await window.api.checkGpu();
      $('gpu-warning-banner').style.display = status.cudaAvailable ? 'none' : '';
    } catch {
      $('gpu-warning-banner').style.display = '';
    }
  }

  window.TabDesign = {
    init() {
      wireSliders();
      $('btn-run-pipeline').addEventListener('click', runPipeline);
      $('btn-goto-screening').addEventListener('click', () => window.App.switchTab('screening'));
    },
    onActivate() {
      loadScaffold();
      checkGpuWarning();
    },
  };
})();
