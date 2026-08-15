(function () {
  function $(id) { return document.getElementById(id); }

  function wireAnchorCards() {
    document.querySelectorAll('.anchor-card').forEach((card) => {
      card.addEventListener('click', async () => {
        document.querySelectorAll('.anchor-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        const anchorKey = card.dataset.anchor; // 'intimin' | 'lpp-ompa'

        if (anchorKey === 'intimin') {
          await fetchAndShowAnchor('intimin');
        } else {
          // Lpp-OmpA is a fusion of two source sequences.
          const lpp = await fetchAnchorRaw('lpp');
          const ompA = await fetchAnchorRaw('ompA');
          if (!lpp || !ompA) return;
          const combined = {
            type: 'lpp-ompa',
            sequence: lpp.sequence + ompA.sequence,
            label: 'Lpp-OmpA (fusion)',
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
      window.ConsolePanel.log('error', `Gagal mengambil anchor ${type}: ${e.message}`, 'construct');
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
    $('anchor-sequence-card').style.display = '';
    $('anchor-sequence-meta').textContent = `${anchor.label} — ${anchor.sequence.length} residu — sumber: ${anchor.source}${anchor.fromCache ? ' (cache)' : ' (live)'}`;
    $('anchor-sequence-view').textContent = anchor.sequence;
    $('btn-build-anchor-construct').disabled = false;
  }

  function refreshCandidateOptions() {
    const select = $('construct-candidate-select');
    select.innerHTML = '';
    const withDna = window.AppState.candidates.filter((c) => c.dna);
    if (!withDna.length) {
      select.innerHTML = '<option value="">Belum ada kandidat dengan DNA teroptimasi (selesaikan Tab Screening dulu)</option>';
      return;
    }
    for (const c of withDna) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.id} (CAI ${c.cai?.toFixed(3) ?? '-'})`;
      select.appendChild(opt);
    }
  }

  async function buildAnchorConstruct() {
    const candidateId = $('construct-candidate-select').value;
    const candidate = window.AppState.candidates.find((c) => c.id === candidateId);
    if (!candidate || !window.AppState.anchor) {
      window.ConsolePanel.log('warn', 'Pilih anchor dan kandidat nanobody terlebih dahulu.', 'construct');
      return;
    }
    window.AppState.constructCandidateId = candidateId;
    try {
      const result = await window.api.buildAnchorConstruct({
        anchorSeq: window.AppState.anchor.sequence,
        nanobodyDna: candidate.dna,
        organism: $('f-organism') ? $('f-organism').value : undefined,
      });
      window.AppState.constructDna = result.construct_dna;
      window.AppState.constructComponents = result.components;
      $('anchor-construct-preview').textContent = result.construct_dna;
      $('btn-build-plasmid').disabled = false;
    } catch (e) {
      window.ConsolePanel.log('error', `Gagal membangun konstruk anchor: ${e.message}`, 'construct');
    }
  }

  function wirePelbToggle() {
    $('chk-pelb').addEventListener('change', () => {
      document.querySelector('.insert-chip-pelb').style.display = $('chk-pelb').checked ? '' : 'none';
    });
  }

  async function buildPlasmid() {
    if (!window.AppState.constructDna) {
      window.ConsolePanel.log('warn', 'Bangun konstruk anchor terlebih dahulu.', 'construct');
      return;
    }
    const candidate = window.AppState.candidates.find((c) => c.id === window.AppState.constructCandidateId);
    try {
      const result = await window.api.buildPlasmid({
        constructDna: window.AppState.constructDna,
        vector: $('vector-select').value,
        includePelb: $('chk-pelb').checked,
        candidateId: window.AppState.constructCandidateId,
        cai: candidate?.cai,
      });
      window.AppState.plasmid = result;
      $('plasmid-preview').style.display = '';
      $('plasmid-fasta-preview').textContent = result.preview;
      $('plasmid-meta').textContent = `Panjang: ${result.lengthBp} bp | GC%: ${result.gcContent?.toFixed(1)}% | CAI: ${result.cai?.toFixed(3) ?? '-'} | File: ${result.fastaPath}`;
      window.ConsolePanel.log('ok', `FASTA final disimpan: ${result.fastaPath}`, 'construct');
    } catch (e) {
      window.ConsolePanel.log('error', `Gagal merakit plasmid: ${e.message}`, 'construct');
    }
  }

  window.TabConstruct = {
    init() {
      wireAnchorCards();
      wirePelbToggle();
      $('btn-build-anchor-construct').addEventListener('click', buildAnchorConstruct);
      $('btn-build-plasmid').addEventListener('click', buildPlasmid);
      $('btn-open-output').addEventListener('click', () => window.api.openOutputFolder());
    },
    onActivate() { refreshCandidateOptions(); },
    refreshCandidateOptions,
  };
})();
