const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel) {
  return (...args) => ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("api", {
  // Tab 1 - Target
  fetchPdb: invoke("fetch-pdb"),
  readPdbFile: invoke("read-pdb-file"),
  getStructureTitle: invoke("get-structure-title"),
  runInterpro: invoke("run-interpro"),
  runFreesasa: invoke("run-freesasa"),
  runDiscotope: invoke("run-discotope"),

  // Tab 2 - Design
  getScaffoldSequence: invoke("get-scaffold-sequence"),
  runRfdiffusion: invoke("run-rfdiffusion"),
  runProteinMpnn: invoke("run-proteinmpnn"),
  runRf2: invoke("run-rf2"),
  scoreCandidates: invoke("score-candidates"),

  // Tab 3 - Screening
  importMetricsDialog: invoke("import-metrics-dialog"),
  codonOptimize: invoke("codon-optimize"),
  calculateCai: invoke("calculate-cai"),

  // Tab 4 - Construct
  fetchAnchor: invoke("fetch-anchor"),
  buildAnchorConstruct: invoke("build-anchor-construct"),
  buildPlasmid: invoke("build-plasmid"),
  openOutputFolder: invoke("open-output-folder"),

  // Cross-tab
  getPlatformInfo: invoke("get-platform-info"),
  checkGpu: invoke("check-gpu"),
  saveProject: invoke("save-project"),
  loadProject: invoke("load-project"),
  listProjects: invoke("list-projects"),
  deleteProject: invoke("delete-project"),
  getSettings: invoke("get-settings"),
  saveSettings: invoke("save-settings"),
  checkDocker: invoke("check-docker"),
  pullDockerImage: invoke("pull-docker-image"),
  runDockerBuild: invoke("run-docker-build"),
  testGpuDocker: invoke("test-gpu-docker"),

  // Streaming event subscriptions
  onConsoleLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("console-log", listener);
    return () => ipcRenderer.removeListener("console-log", listener);
  },
  onStageProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("stage-progress", listener);
    return () => ipcRenderer.removeListener("stage-progress", listener);
  },
});
