(function () {
  function $(id) {
    return document.getElementById(id);
  }
  let cdrAuto = {}; // auto-detected {H1:{start,end,residues}, ...}, kept for the reset (↺) button
  let gpuAvailable = null; // null = unknown yet

  // Per-unit durations backing the Phase 5 ETA hint. CPU figures are measured
  // end-to-end on a real (no-GPU) run of this app; GPU figures are typical
  // published benchmarks for these models, not measured here - both are
  // rough guides, not guarantees (actual time depends on target/scaffold size).
  const ETA = {
    rfdiffusionPerBackbone: { gpu: 20, cpu: 610 },
    proteinmpnnPerSequence: { gpu: 1.5, cpu: 1.5 },
    rf2PerSequence: { gpu: 10, cpu: 180 },
  };

  function formatDuration(totalSeconds) {
    if (totalSeconds < 60) return `~${Math.round(totalSeconds)}s`;
    const totalMinutes = totalSeconds / 60;
    if (totalMinutes < 60) return `~${Math.round(totalMinutes)} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = Math.round(totalMinutes % 60);
    return `~${hours}h${minutes ? ` ${minutes}min` : ""}`;
  }

  function updatePipelineEta() {
    const el = $("pipeline-eta-hint");
    if (!el) return;
    const backboneNumber = Number($("slider-backbone-number").value);
    const mpnnDesigns = Number($("slider-mpnn-designs").value);
    const totalSequences = backboneNumber * mpnnDesigns;
    const mode = gpuAvailable ? "gpu" : "cpu";

    const rfdiffusionSec = backboneNumber * ETA.rfdiffusionPerBackbone[mode];
    const proteinmpnnSec = totalSequences * ETA.proteinmpnnPerSequence[mode];
    const rf2Sec = totalSequences * ETA.rf2PerSequence[mode];
    const totalSec = rfdiffusionSec + proteinmpnnSec + rf2Sec;

    const modeLabel =
      gpuAvailable === null
        ? "checking GPU..."
        : gpuAvailable
          ? "GPU"
          : "CPU (GPU not detected)";
    el.textContent = `Phase 5 time estimate: ${formatDuration(totalSec)} (${modeLabel}) — RFdiffusion ${formatDuration(rfdiffusionSec)}, ProteinMPNN ${formatDuration(proteinmpnnSec)}, RF2 ${formatDuration(rf2Sec)}. Rough estimate, depends on target/scaffold size.`;
  }

  function wireSliders() {
    const pairs = [
      ["slider-backbone-number", "val-backbone-number", (v) => v],
      ["slider-mpnn-designs", "val-mpnn-designs", (v) => v],
      ["slider-mpnn-temp", "val-mpnn-temp", (v) => Number(v).toFixed(2)],
    ];
    for (const [sliderId, valId, fmt] of pairs) {
      const slider = $(sliderId);
      slider.addEventListener("input", () => {
        $(valId).textContent = fmt(slider.value);
        updatePipelineEta();
      });
    }
  }

  async function loadScaffold() {
    if (window.AppState.scaffold) return;
    const scaffoldName = $("scaffold-select").value;
    try {
      const result = await window.api.getScaffoldSequence({ scaffoldName });
      window.AppState.scaffold = result;
      cdrAuto = JSON.parse(JSON.stringify(result.cdr || {}));
      renderScaffoldSequence(result);
      renderCdrRanges(result.cdr);
    } catch (e) {
      $("scaffold-sequence").textContent = `⚠ ${e.message}`;
      window.ConsolePanel.log(
        "warn",
        `Failed to load scaffold: ${e.message}`,
        "design",
      );
    }
  }

  function renderScaffoldSequence(scaffold) {
    const cdrResidues = new Set();
    for (const key of Object.keys(scaffold.cdr || {})) {
      for (const r of scaffold.cdr[key].residues) cdrResidues.add(r);
    }
    let html = "";
    scaffold.sequence.split("").forEach((aa, i) => {
      const resNum = scaffold.residueNumbers[i];
      html += cdrResidues.has(resNum)
        ? `<span class="aa-cdr" title="${resNum}">${aa}</span>`
        : `<span title="${resNum}">${aa}</span>`;
    });
    $("scaffold-sequence").innerHTML = html;
  }

  function range(start, end) {
    const arr = [];
    for (let r = start; r <= end; r++) arr.push(r);
    return arr;
  }

  function renderCdrRanges(cdr) {
    for (const label of ["H1", "H2", "H3"]) {
      const startEl = $(`cdr-${label.toLowerCase()}-start`);
      const endEl = $(`cdr-${label.toLowerCase()}-end`);
      const entry = cdr && cdr[label];
      startEl.value = entry ? entry.start : "";
      endEl.value = entry ? entry.end : "";
      updateCdrEditedMark(label);
    }
  }

  function updateCdrEditedMark(label) {
    const startEl = $(`cdr-${label.toLowerCase()}-start`);
    const endEl = $(`cdr-${label.toLowerCase()}-end`);
    const auto = cdrAuto[label];
    const edited =
      !auto ||
      String(auto.start) !== startEl.value ||
      String(auto.end) !== endEl.value;
    startEl.classList.toggle("cdr-edited", edited);
    endEl.classList.toggle("cdr-edited", edited);
  }

  // User-edited CDR boundaries override the auto-detected ones (from the
  // scaffold's REMARK PDBinfo-LABEL lines) in AppState.scaffold.cdr, which
  // feeds both the sequence highlight and the final candidate scoring step.
  function onCdrRangeEdit(label) {
    const startEl = $(`cdr-${label.toLowerCase()}-start`);
    const endEl = $(`cdr-${label.toLowerCase()}-end`);
    const start = parseInt(startEl.value, 10);
    const end = parseInt(endEl.value, 10);
    if (
      !window.AppState.scaffold ||
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end
    ) {
      updateCdrEditedMark(label);
      return;
    }
    window.AppState.scaffold.cdr = window.AppState.scaffold.cdr || {};
    window.AppState.scaffold.cdr[label] = {
      start,
      end,
      residues: range(start, end),
    };
    updateCdrEditedMark(label);
    renderScaffoldSequence(window.AppState.scaffold);
    window.ConsolePanel.log(
      "info",
      `CDR ${label} range manually changed: ${start}-${end}.`,
      "design",
    );
  }

  function resetCdrRange(label) {
    if (!window.AppState.scaffold) return;
    const auto = cdrAuto[label];
    window.AppState.scaffold.cdr = window.AppState.scaffold.cdr || {};
    if (auto)
      window.AppState.scaffold.cdr[label] = JSON.parse(JSON.stringify(auto));
    else delete window.AppState.scaffold.cdr[label];
    renderCdrRanges(window.AppState.scaffold.cdr);
    renderScaffoldSequence(window.AppState.scaffold);
  }

  function wireCdrRangeEditing() {
    for (const label of ["H1", "H2", "H3"]) {
      $(`cdr-${label.toLowerCase()}-start`).addEventListener("change", () =>
        onCdrRangeEdit(label),
      );
      $(`cdr-${label.toLowerCase()}-end`).addEventListener("change", () =>
        onCdrRangeEdit(label),
      );
    }
    document.querySelectorAll(".btn-reset-cdr").forEach((btn) => {
      btn.addEventListener("click", () => resetCdrRange(btn.dataset.cdr));
    });
  }

  function setBadge(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = `badge ${cls}`;
  }

  function buildScaffoldConfig() {
    const cdrConfig = `H1:${$("cdr-h1-len").value},H2:${$("cdr-h2-len").value},H3:${$("cdr-h3-len").value}`;
    return {
      scaffold_name: $("scaffold-select").value,
      cdr_designed: ["H1", "H2", "H3"],
      cdr_config: cdrConfig,
      backbone_number: Number($("slider-backbone-number").value),
      mpnn_designs: Number($("slider-mpnn-designs").value),
      mpnn_temperature: Number($("slider-mpnn-temp").value),
    };
  }

  async function runPipeline() {
    if (
      !window.AppState.chainAPath ||
      !window.AppState.hotspotResidues.length
    ) {
      window.ConsolePanel.log(
        "error",
        "Complete the Target tab (select hotspots) before running the AI Design Pipeline.",
        "design",
      );
      return;
    }
    if (!window.AppState.scaffold) {
      window.ConsolePanel.log(
        "error",
        "Scaffold not loaded yet. Check the RFantibody path in Settings.",
        "design",
      );
      return;
    }

    const cfg = buildScaffoldConfig();
    window.AppState.scaffoldConfig = cfg;
    $("btn-run-pipeline").disabled = true;
    $("btn-goto-screening").disabled = true;

    try {
      setBadge("badge-rfdiffusion", "Running...", "badge-running");
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
      setBadge(
        "badge-rfdiffusion",
        `Done (${rfd.backbones.length} backbones)`,
        "badge-ok",
      );

      setBadge("badge-proteinmpnn", "Running...", "badge-running");
      const mpnn = await window.api.runProteinMpnn({
        backboneDir: rfd.backboneDir,
        designsPerBackbone: cfg.mpnn_designs,
        temperature: cfg.mpnn_temperature,
      });
      window.AppState.seqDir = mpnn.seqDir;
      setBadge("badge-proteinmpnn", "Done", "badge-ok");

      setBadge("badge-rf2-weights", "Running...", "badge-running");
      setBadge("badge-rf2", "Running...", "badge-running");
      const rf2 = await window.api.runRf2({
        seqDir: mpnn.seqDir,
        numRecycles: 10,
      });
      window.AppState.rf2OutDir = rf2.rf2OutDir;
      setBadge("badge-rf2-weights", "Done", "badge-ok");
      setBadge("badge-rf2", "Done", "badge-ok");

      const scoring = await window.api.scoreCandidates({
        rf2OutDir: rf2.rf2OutDir,
        backboneDir: rfd.backboneDir,
        cdr: window.AppState.scaffold.cdr,
      });
      window.AppState.candidates = scoring.candidates || [];
      window.ConsolePanel.log(
        "ok",
        `${window.AppState.candidates.length} candidates ready for screening.`,
        "design",
      );
      $("btn-goto-screening").disabled = false;
      if (window.TabScreening) window.TabScreening.refresh();
    } catch (e) {
      window.ConsolePanel.log(
        "error",
        `Pipeline failed: ${e.message}`,
        "design",
      );
      [
        "badge-rfdiffusion",
        "badge-proteinmpnn",
        "badge-rf2-weights",
        "badge-rf2",
      ].forEach((id) => {
        if ($(id).textContent.includes("Running"))
          setBadge(id, "Failed", "badge-error");
      });
    } finally {
      $("btn-run-pipeline").disabled = false;
    }
  }

  async function checkGpuWarning() {
    try {
      const status = await window.api.checkGpu();
      gpuAvailable = !!status.cudaAvailable;
      $("gpu-warning-banner").style.display = status.cudaAvailable
        ? "none"
        : "";
    } catch {
      gpuAvailable = false;
      $("gpu-warning-banner").style.display = "";
    }
    updatePipelineEta();
  }

  window.TabDesign = {
    init() {
      wireSliders();
      wireCdrRangeEditing();
      updatePipelineEta();
      $("btn-run-pipeline").addEventListener("click", runPipeline);
      $("btn-goto-screening").addEventListener("click", () =>
        window.App.switchTab("screening"),
      );
      $("btn-gpu-warning-settings").addEventListener("click", async () => {
        await window.App.openSettingsModal();
        const field = $("set-gpuOverride");
        field.scrollIntoView({ block: "center" });
        field.focus();
      });
    },
    onActivate() {
      loadScaffold();
      checkGpuWarning();
    },
  };
})();
