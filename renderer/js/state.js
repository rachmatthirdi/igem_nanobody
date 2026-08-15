// Central, shared application state for the whole 4-tab pipeline.
// Plain object (no framework) - tab modules read/write it directly.
window.AppState = {
  id: null,
  name: null,

  // Tab 1 - Target
  pdbId: null,
  pdbPath: null,
  chainAPath: null,
  structureTitle: '',
  domains: [],
  sasaResidues: [],
  discotopeResidues: [],
  hotspotResidues: [], // array of residue numbers selected by the user

  // Tab 2 - Desain
  scaffold: null, // { scaffoldName, filePath, sequence, residueNumbers, cdr }
  scaffoldConfig: null, // { scaffold_name, cdr_designed, cdr_config, backbone_number, mpnn_designs, mpnn_temperature }
  backbones: [],
  targetTPath: null,
  seqDir: null,
  rf2OutDir: null,
  candidates: [], // [{ id, plddt, pae, cdrRmsd, h3Rmsd, dg, composite, pass, dna, cai, gcContent, pdbPath }]

  // Tab 3 - Screening
  selectedCandidateIds: [],
  filterWeights: { plddt: 0.2, pae: 0.2, cdrRmsd: 0.2, h3Rmsd: 0.2, dg: 0.2 },

  // Tab 4 - Konstruk
  anchor: null, // { type, sequence, header, label, source }
  constructCandidateId: null,
  constructDna: null,
  constructComponents: null,
  plasmid: null, // { fastaPath, preview, lengthBp, gcContent, cai, vector, includePelb }
};

window.StateUtils = {
  reset() {
    const fresh = {
      id: null, name: null,
      pdbId: null, pdbPath: null, chainAPath: null, structureTitle: '',
      domains: [], sasaResidues: [], discotopeResidues: [], hotspotResidues: [],
      scaffold: null, scaffoldConfig: null, backbones: [], targetTPath: null,
      seqDir: null, rf2OutDir: null, candidates: [],
      selectedCandidateIds: [], filterWeights: { plddt: 0.2, pae: 0.2, cdrRmsd: 0.2, h3Rmsd: 0.2, dg: 0.2 },
      anchor: null, constructCandidateId: null, constructDna: null, constructComponents: null, plasmid: null,
    };
    Object.assign(window.AppState, fresh);
  },

  serialize() {
    return JSON.parse(JSON.stringify(window.AppState));
  },

  applyLoaded(data) {
    Object.assign(window.AppState, data);
  },
};
