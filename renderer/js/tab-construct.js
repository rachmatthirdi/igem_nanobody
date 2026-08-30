(function () {
  function $(id) {
    return document.getElementById(id);
  }

  async function extractAminoAcidSeq(candidate) {
    const pdbText = await window.api.readPdbFile(candidate.pdbPath);
    const seenRes = new Set();
    const AA_3TO1 = {
      ALA: "A",
      ARG: "R",
      ASN: "N",
      ASP: "D",
      CYS: "C",
      GLN: "Q",
      GLU: "E",
      GLY: "G",
      HIS: "H",
      ILE: "I",
      LEU: "L",
      LYS: "K",
      MET: "M",
      PHE: "F",
      PRO: "P",
      SER: "S",
      THR: "T",
      TRP: "W",
      TYR: "Y",
      VAL: "V",
      MSE: "M",
    };
    let seq = "";
    for (const line of pdbText.split(/\r?\n/)) {
      if (!line.startsWith("ATOM")) continue;
      if (line.charAt(21) !== "H") continue;
      if (line.slice(12, 16).trim() !== "CA") continue;
      const resNum = line.slice(22, 26).trim();
      if (seenRes.has(resNum)) continue;
      seenRes.add(resNum);
      seq += AA_3TO1[line.slice(17, 20).trim()] || "X";
    }
    return seq;
  }

  async function runCodonOptimization() {
    const organism = $("f-organism").value;
    const resultsEl = $("codon-results");
    resultsEl.innerHTML = "";
    $("btn-codon-optimize").disabled = true;

    for (const id of window.AppState.selectedCandidateIds) {
      const candidate = window.AppState.candidates.find((c) => c.id === id);
      if (!candidate) continue;
      try {
        const aaSeq =
          candidate.aminoAcidSeq || (await extractAminoAcidSeq(candidate));
        candidate.aminoAcidSeq = aaSeq;
        const result = await window.api.codonOptimize({
          aminoAcidSeq: aaSeq,
          organism,
        });
        candidate.dna = result.sequence_dna;
        candidate.cai = result.cai;
        candidate.gcContent = result.gc_content;
        candidate.codonMethod = result.method;

        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
          <div class="section-label">${id} — method: ${result.method}</div>
          <div class="sequence-view">${result.sequence_dna}</div>
          <div class="anchor-meta">CAI: ${result.cai?.toFixed(3)} &nbsp;|&nbsp; GC%: ${result.gc_content?.toFixed(1)}%</div>
        `;
        resultsEl.appendChild(div);
      } catch (e) {
        window.ConsolePanel.log(
          "error",
          `Codon optimization failed for ${id}: ${e.message}`,
          "construct",
        );
      }
    }
    $("btn-codon-optimize").disabled = false;
    refreshCandidateOptions();
  }

  function wireAnchorCards() {
    document.querySelectorAll(".anchor-card").forEach((card) => {
      card.addEventListener("click", async () => {
        document
          .querySelectorAll(".anchor-card")
          .forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        const anchorKey = card.dataset.anchor; // 'intimin' | 'lpp-ompa'

        if (anchorKey === "intimin") {
          await fetchAndShowAnchor("intimin");
        } else {
          // Lpp-OmpA is a fusion of two source sequences.
          const lpp = await fetchAnchorRaw("lpp");
          const ompA = await fetchAnchorRaw("ompA");
          if (!lpp || !ompA) return;
          const combined = {
            type: "lpp-ompa",
            sequence: lpp.sequence + ompA.sequence,
            label: "Lpp-OmpA (fusion)",
            source: `${lpp.source} + ${ompA.source}`,
            header: `${lpp.header} | ${ompA.header}`,
          };
          window.AppState.anchor = combined;
          showAnchor(combined);
        }
      });
    });
  }

  async function fetchAnchorRaw(type) {
    try {
      return await window.api.fetchAnchor({ type, forceRefresh: false });
    } catch (e) {
      window.ConsolePanel.log(
        "error",
        `Failed to fetch anchor ${type}: ${e.message}`,
        "construct",
      );
      return null;
    }
  }

  async function fetchAndShowAnchor(type) {
    const data = await fetchAnchorRaw(type);
    if (!data) return;
    window.AppState.anchor = { type, ...data };
    showAnchor(window.AppState.anchor);
  }

  function showAnchor(anchor) {
    $("anchor-sequence-card").style.display = "";
    $("anchor-sequence-meta").textContent =
      `${anchor.label} — ${anchor.sequence.length} residues — source: ${anchor.source}${anchor.fromCache ? " (cache)" : " (live)"}`;
    $("anchor-sequence-view").textContent = anchor.sequence;
    $("btn-build-anchor-construct").disabled = false;
  }

  function refreshCandidateOptions() {
    const select = $("construct-candidate-select");
    select.innerHTML = "";
    const withDna = window.AppState.candidates.filter((c) => c.dna);
    if (!withDna.length) {
      select.innerHTML =
        '<option value="">No candidates with optimized DNA yet (finish the Screening tab first)</option>';
      return;
    }
    for (const c of withDna) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.id} (CAI ${c.cai?.toFixed(3) ?? "-"})`;
      select.appendChild(opt);
    }
  }

  async function buildAnchorConstruct() {
    const candidateId = $("construct-candidate-select").value;
    const candidate = window.AppState.candidates.find(
      (c) => c.id === candidateId,
    );
    if (!candidate || !window.AppState.anchor) {
      window.ConsolePanel.log(
        "warn",
        "Select an anchor and a nanobody candidate first.",
        "construct",
      );
      return;
    }
    window.AppState.constructCandidateId = candidateId;
    try {
      const result = await window.api.buildAnchorConstruct({
        anchorSeq: window.AppState.anchor.sequence,
        nanobodyDna: candidate.dna,
        organism: $("f-organism") ? $("f-organism").value : undefined,
      });
      window.AppState.constructDna = result.construct_dna;
      window.AppState.constructComponents = result.components;
      $("anchor-construct-preview").textContent = result.construct_dna;
      $("btn-build-plasmid").disabled = false;
    } catch (e) {
      window.ConsolePanel.log(
        "error",
        `Failed to build anchor construct: ${e.message}`,
        "construct",
      );
    }
  }

  function wirePelbToggle() {
    $("chk-pelb").addEventListener("change", () => {
      document.querySelector(".insert-chip-pelb").style.display = $("chk-pelb")
        .checked
        ? ""
        : "none";
    });
  }

  async function buildPlasmid() {
    if (!window.AppState.constructDna) {
      window.ConsolePanel.log(
        "warn",
        "Build the anchor construct first.",
        "construct",
      );
      return;
    }
    const candidate = window.AppState.candidates.find(
      (c) => c.id === window.AppState.constructCandidateId,
    );
    try {
      const result = await window.api.buildPlasmid({
        constructDna: window.AppState.constructDna,
        vector: $("vector-select").value,
        includePelb: $("chk-pelb").checked,
        candidateId: window.AppState.constructCandidateId,
        cai: candidate?.cai,
      });
      window.AppState.plasmid = result;
      $("plasmid-preview").style.display = "";
      $("plasmid-fasta-preview").textContent = result.preview;
      $("plasmid-meta").textContent =
        `Length: ${result.lengthBp} bp | GC%: ${result.gcContent?.toFixed(1)}% | CAI: ${result.cai?.toFixed(3) ?? "-"} | File: ${result.fastaPath}`;
      window.ConsolePanel.log(
        "ok",
        `Final FASTA saved: ${result.fastaPath}`,
        "construct",
      );
    } catch (e) {
      window.ConsolePanel.log(
        "error",
        `Failed to assemble plasmid: ${e.message}`,
        "construct",
      );
    }
  }

  window.TabConstruct = {
    init() {
      wireAnchorCards();
      wirePelbToggle();
      $("btn-codon-optimize").addEventListener("click", runCodonOptimization);
      $("btn-build-anchor-construct").addEventListener(
        "click",
        buildAnchorConstruct,
      );
      $("btn-build-plasmid").addEventListener("click", buildPlasmid);
      $("btn-open-output").addEventListener("click", () =>
        window.api.openOutputFolder(),
      );
    },
    onActivate() {
      refreshCandidateOptions();
    },
    refreshCandidateOptions,
  };
})();
