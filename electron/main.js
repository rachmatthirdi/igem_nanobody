const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// On native Wayland sessions, Chromium's default wayland ozone backend can
// segfault at startup when combined with Vulkan on some GPU/driver stacks
// ("--ozone-platform=wayland is not compatible with Vulkan"). --ozone-platform
// has to be a literal CLI argument - app.commandLine.appendSwitch() runs too
// late, after ozone has already initialized - so relaunch once with it added.
if (
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) &&
  !process.argv.includes('--ozone-platform=x11')
) {
  spawn(process.execPath, [...process.argv.slice(1), '--ozone-platform=x11'], {
    stdio: 'inherit',
    env: process.env,
  }).on('exit', (code) => process.exit(code ?? 0));
  return;
}

const ROOT = path.join(__dirname, '..');
const DIRS = {
  cachePdb: path.join(ROOT, 'cache', 'pdb'),
  cacheInterpro: path.join(ROOT, 'cache', 'interpro'),
  cacheAnchors: path.join(ROOT, 'cache', 'anchors'),
  projects: path.join(ROOT, 'projects'),
  output: path.join(ROOT, 'output'),
  python: path.join(ROOT, 'python'),
  work: path.join(ROOT, 'work'), // scratch dir for RFantibody/DiscoTope intermediate files
};

for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

let mainWindow = null;

// ---------------------------------------------------------------------------
// Platform detection (OS / WSL2) - picks a sensible default RFantibody exec
// mode instead of making every user figure it out for themselves. WSL2's
// Linux kernel reports process.platform === 'linux' just like a native Linux
// host, so it can't be told apart by platform alone - /proc/version (or the
// WSL_DISTRO_NAME/WSL_INTEROP env vars WSL sets) is what actually reveals it.
// Note this only matters when Electron itself runs on Windows and needs to
// reach INTO a WSL2 distro via wsl.exe; if Electron is already running as a
// Linux process (bare-metal or inside WSL2 via WSLg), 'native' is correct
// either way since it can invoke RFantibody with a plain bash shell.
// ---------------------------------------------------------------------------
function detectPlatformInfo() {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux' | ...
  let isWSL = false;
  if (platform === 'linux') {
    try {
      isWSL = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch {
      // /proc/version should always exist on Linux, but don't crash startup if it doesn't.
    }
    if (!isWSL && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) isWSL = true;
  }

  let label;
  let recommendedExecMode;
  if (platform === 'win32') {
    label = 'Windows';
    recommendedExecMode = 'wsl';
  } else if (platform === 'darwin') {
    label = 'macOS';
    recommendedExecMode = 'docker'; // no WSL on macOS; Docker Desktop is the only bridge (no GPU passthrough though)
  } else if (isWSL) {
    label = `Linux (WSL2${process.env.WSL_DISTRO_NAME ? `: ${process.env.WSL_DISTRO_NAME}` : ''})`;
    recommendedExecMode = 'native';
  } else {
    label = 'Linux (native)';
    recommendedExecMode = 'native';
  }

  return { platform, isWSL, label, recommendedExecMode };
}

const PLATFORM_INFO = detectPlatformInfo();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  condaExe: 'conda',
  toolsEnv: 'nanobody-tools',
  discotopeEnv: 'discotope',
  discotopeRepoDir: '',
  rfantibodyDir: '',
  rfantibodyExecMode: PLATFORM_INFO.recommendedExecMode, // 'wsl' | 'docker' | 'native'
  wslDistro: 'Ubuntu',
  dockerImage: 'rfantibody',
  caiOrganism: 'Escherichia coli general',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsToDisk(settings) {
  const merged = { ...getSettings(), ...settings };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ---------------------------------------------------------------------------
// Logging / progress helpers (streamed to renderer Live Console + progress bars)
// ---------------------------------------------------------------------------
function sendLog(level, text, source) {
  if (!mainWindow) return;
  mainWindow.webContents.send('console-log', {
    level, // 'info' | 'ok' | 'warn' | 'error'
    text,
    source,
    ts: Date.now(),
  });
}

function sendProgress(stage, percent, status, message) {
  if (!mainWindow) return;
  mainWindow.webContents.send('stage-progress', { stage, percent, status, message, ts: Date.now() });
}

function classifyLine(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('traceback') || l.includes('exception')) return 'error';
  if (l.includes('warn')) return 'warn';
  if (l.includes('done') || l.includes('success') || l.includes('✓') || l.includes('selesai')) return 'ok';
  return 'info';
}

// ---------------------------------------------------------------------------
// Subprocess runner: streams stdout/stderr line-by-line to the Live Console
// ---------------------------------------------------------------------------
function runProcess(cmd, args, { cwd, source, env } = {}) {
  return new Promise((resolve, reject) => {
    sendLog('info', `$ ${cmd} ${args.join(' ')}`, source);
    const child = spawn(cmd, args, {
      cwd: cwd || ROOT,
      env: { ...process.env, ...(env || {}) },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      text.split(/\r?\n/).filter(Boolean).forEach((line) => sendLog(classifyLine(line), line, source));
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      text.split(/\r?\n/).filter(Boolean).forEach((line) => sendLog(classifyLine(line) === 'info' ? 'warn' : classifyLine(line), line, source));
    });

    child.on('error', (err) => {
      sendLog('error', `Failed to run process: ${err.message}`, source);
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        sendLog('ok', `Process finished (${source})`, source);
        resolve({ code, stdout, stderr });
      } else {
        sendLog('error', `Process failed with code ${code} (${source})`, source);
        reject(new Error(`${source} exited with code ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`));
      }
    });
  });
}

function runCondaPython(envName, scriptPath, args, opts = {}) {
  const settings = getSettings();
  return runProcess(
    settings.condaExe,
    ['run', '-n', envName, '--no-capture-output', 'python', scriptPath, ...args],
    opts
  );
}

// Windows path -> WSL path (C:\foo\bar -> /mnt/c/foo/bar)
function toWslPath(winPath) {
  const resolved = path.resolve(winPath).replace(/\\/g, '/');
  const match = resolved.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return resolved;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

// Runs a shell command line inside the RFantibody checkout, via the configured
// execution backend (WSL / Docker / native Linux). RFantibody itself is
// Linux+CUDA oriented (bash scripts, `uv`), so on Windows this must cross a
// WSL2 or Docker boundary rather than running "natively".
function runRfantibodyCommand(commandLine, source) {
  const settings = getSettings();
  if (!settings.rfantibodyDir) {
    return Promise.reject(new Error('RFantibody path not configured. Open Settings and choose the RFantibody installation folder.'));
  }

  if (settings.rfantibodyExecMode === 'wsl') {
    const wslDir = toWslPath(settings.rfantibodyDir);
    const full = `cd '${wslDir}' && source .venv/bin/activate 2>/dev/null; ${commandLine}`;
    return runProcess('wsl.exe', ['-d', settings.wslDistro, '--', 'bash', '-lc', full], { source });
  }

  if (settings.rfantibodyExecMode === 'docker') {
    const full = `cd /workspace && ${commandLine}`;
    return runProcess(
      'docker',
      ['run', '--rm', '--gpus', 'all', '-v', `${settings.rfantibodyDir}:/workspace`, '-w', '/workspace', settings.dockerImage, 'bash', '-lc', full],
      { source }
    );
  }

  // native (Linux host running Electron directly)
  return runProcess('bash', ['-lc', `cd '${settings.rfantibodyDir}' && ${commandLine}`], { source });
}

// ---------------------------------------------------------------------------
// PDB helpers (pure JS, no external deps)
// ---------------------------------------------------------------------------
const AA_3TO1 = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
  PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', MSE: 'M',
};

function extractChain(pdbText, chainId) {
  const lines = pdbText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
      const chain = line.charAt(21);
      if (chain === chainId) out.push(line);
    } else if (line.startsWith('REMARK') || line.startsWith('TER') || line.startsWith('END')) {
      out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

function renameChain(pdbText, fromChain, toChain) {
  return pdbText
    .split(/\r?\n/)
    .map((line) => {
      if ((line.startsWith('ATOM') || line.startsWith('HETATM') || line.startsWith('TER')) && line.charAt(21) === fromChain) {
        return line.slice(0, 21) + toChain + line.slice(22);
      }
      return line;
    })
    .join('\n') + '\n';
}

function parseChainSequence(pdbText, chainId) {
  const seenRes = new Set();
  let sequence = '';
  const residueNumbers = [];
  for (const line of pdbText.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue;
    if (line.charAt(21) !== chainId) continue;
    if (line.slice(12, 16).trim() !== 'CA') continue;
    const resName = line.slice(17, 20).trim();
    const resNum = line.slice(22, 26).trim();
    const key = resNum;
    if (seenRes.has(key)) continue;
    seenRes.add(key);
    sequence += AA_3TO1[resName] || 'X';
    residueNumbers.push(parseInt(resNum, 10));
  }
  return { sequence, residueNumbers };
}

// RFantibody marks CDR loops via lines like: REMARK PDBinfo-LABEL:    32 H1
function parseCdrRemarks(pdbText) {
  const cdr = {};
  const re = /REMARK\s+PDBinfo-LABEL:\s*(\d+)\s+(H1|H2|H3|L1|L2|L3)/;
  for (const line of pdbText.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const resNum = parseInt(m[1], 10);
    const label = m[2];
    if (!cdr[label]) cdr[label] = { start: resNum, end: resNum, residues: [] };
    cdr[label].start = Math.min(cdr[label].start, resNum);
    cdr[label].end = Math.max(cdr[label].end, resNum);
    cdr[label].residues.push(resNum);
  }
  return cdr;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function readCacheJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCacheJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// discotope3/main.py always nests its real output one level deeper, under
// out_dir/<basename of --pdb_dir>/ (see get_basename_no_ext(args.pdb_dir) in
// its source) - so a flat readdirSync(outDir) never finds the CSV. Search
// recursively instead of assuming a flat layout.
function findFileRecursive(dir, matchFn, maxDepth = 3) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && matchFn(entry.name)) return path.join(dir, entry.name);
  }
  if (maxDepth > 0) {
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = findFileRecursive(path.join(dir, entry.name), matchFn, maxDepth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPC: Tab 1 - Target
// ---------------------------------------------------------------------------
ipcMain.handle('fetch-pdb', async (_evt, pdbId) => {
  const id = pdbId.trim().toUpperCase();
  const pdbPath = path.join(DIRS.cachePdb, `${id}.pdb`);
  const chainAPath = path.join(DIRS.cachePdb, `${id}_chainA.pdb`);

  sendProgress('download-pdb', 10, 'running', `Downloading ${id}.pdb from RCSB...`);
  let pdbText;
  if (fs.existsSync(pdbPath)) {
    pdbText = fs.readFileSync(pdbPath, 'utf8');
    sendLog('info', `${id}.pdb found in local cache.`, 'download-pdb');
  } else {
    const url = `https://files.rcsb.org/download/${id}.pdb`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RCSB returned status ${res.status} for PDB ID "${id}"`);
    pdbText = await res.text();
    fs.writeFileSync(pdbPath, pdbText, 'utf8');
  }
  sendProgress('download-pdb', 60, 'running', 'Extracting Chain A...');

  const chainAText = extractChain(pdbText, 'A');
  fs.writeFileSync(chainAPath, chainAText, 'utf8');

  let title = '';
  try {
    const tRes = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${id}`);
    if (tRes.ok) {
      const data = await tRes.json();
      title = data?.struct?.title || '';
    }
  } catch (e) {
    sendLog('warn', `Failed to fetch structure title: ${e.message}`, 'download-pdb');
  }

  const sizeKB = Math.round(Buffer.byteLength(pdbText, 'utf8') / 1024);
  sendProgress('download-pdb', 100, 'done', `Done (${sizeKB} KB)`);

  return { pdbId: id, pdbPath, chainAPath, sizeKB, title };
});

ipcMain.handle('read-pdb-file', async (_evt, filePath) => {
  return fs.readFileSync(filePath, 'utf8');
});

ipcMain.handle('get-structure-title', async (_evt, pdbId) => {
  const res = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${pdbId.toUpperCase()}`);
  if (!res.ok) throw new Error(`data.rcsb.org status ${res.status}`);
  const data = await res.json();
  return data?.struct?.title || '';
});

ipcMain.handle('run-interpro', async (_evt, { pdbId, forceRefresh }) => {
  const id = pdbId.trim().toUpperCase();
  const cacheFile = path.join(DIRS.cacheInterpro, `${id}.json`);

  if (!forceRefresh) {
    const cached = readCacheJson(cacheFile);
    if (cached) {
      sendLog('info', `InterPro domains for ${id} loaded from cache.`, 'interpro');
      sendProgress('interpro', 100, 'done', `${cached.length} domains loaded from cache`);
      return { domains: cached, fromCache: true };
    }
  }

  sendProgress('interpro', 20, 'running', 'Contacting EBI InterPro API...');
  const url = `https://www.ebi.ac.uk/interpro/api/entry/interpro/structure/pdb/${id}`;
  let domains = [];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`InterPro API status ${res.status}`);
    const data = await res.json();
    domains = (data.results || []).map((r) => {
      const meta = r.metadata || {};
      const locations = [];
      for (const s of r.structures || []) {
        for (const loc of s.entry_protein_locations || []) {
          for (const frag of loc.fragments || []) {
            locations.push({ start: frag.start, end: frag.end });
          }
        }
      }
      return {
        accession: meta.accession,
        name: meta.name,
        type: meta.type,
        locations,
      };
    });
    writeCacheJson(cacheFile, domains);
    sendProgress('interpro', 100, 'done', `${domains.length} domains found`);
  } catch (e) {
    sendLog('warn', `InterPro fetch failed: ${e.message}`, 'interpro');
    const cached = readCacheJson(cacheFile);
    if (cached) {
      sendLog('info', 'Using stale cache as a fallback.', 'interpro');
      return { domains: cached, fromCache: true };
    }
    sendProgress('interpro', 100, 'error', e.message);
    domains = [];
  }

  return { domains, fromCache: false };
});

ipcMain.handle('run-freesasa', async (_evt, { chainAPath }) => {
  sendProgress('freesasa', 10, 'running', 'Running FreeSASA...');
  const settings = getSettings();
  const outJson = path.join(DIRS.work, `sasa_${Date.now()}.json`);
  await runCondaPython(settings.toolsEnv, path.join(DIRS.python, 'run_freesasa.py'), [chainAPath, outJson], { source: 'freesasa' });
  const result = readCacheJson(outJson);
  sendProgress('freesasa', 100, 'done', `${result?.residues?.length || 0} residues analyzed`);
  return result;
});

ipcMain.handle('run-discotope', async (_evt, { chainAPath, pdbId }) => {
  const settings = getSettings();
  if (!settings.discotopeRepoDir) {
    throw new Error('DiscoTope-3.0 repository path not configured in Settings.');
  }
  sendProgress('discotope', 10, 'running', 'Loading DiscoTope-3.0 model...');

  const inDir = path.join(DIRS.work, `discotope_in_${Date.now()}`);
  const outDir = path.join(DIRS.work, `discotope_out_${Date.now()}`);
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(chainAPath, path.join(inDir, `${pdbId}.pdb`));

  const scriptPath = path.join(settings.discotopeRepoDir, 'discotope3', 'main.py');
  const modelsDir = path.join(settings.discotopeRepoDir, 'models');
  sendProgress('discotope', 30, 'running', 'Predicting epitopes...');
  await runCondaPython(
    settings.discotopeEnv,
    scriptPath,
    ['--pdb_dir', inDir, '--out_dir', outDir, '--models_dir', modelsDir],
    { source: 'discotope' }
  );

  // Real output filename per discotope3/main.py: {out_dir}/{out_name}/{pdb}_discotope3.csv,
  // where out_name = basename of --pdb_dir (get_basename_no_ext(args.pdb_dir) in main()) -
  // i.e. always one directory deeper than out_dir itself, so this must recurse.
  // Real column order (verified against the source, not guessed):
  // pdb, chain, res_id, residue, DiscoTope-3.0_score, calibrated_score, epitope, rsa, pLDDTs, length, alphafold_struc_flag
  const csvPath = findFileRecursive(outDir, (f) => f.endsWith('_discotope3.csv'));
  if (!csvPath) throw new Error('DiscoTope-3.0 did not produce an output CSV file.');

  const csvText = fs.readFileSync(csvPath, 'utf8');
  const lines = csvText.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim());
  const residues = lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    return {
      resNum: parseInt(row['res_id'], 10),
      residue: row['residue'],
      discotopeScore: parseFloat(row['DiscoTope-3.0_score']),
      calibratedScore: parseFloat(row['calibrated_score']),
      rsa: parseFloat(row['rsa']),
      plddt: parseFloat(row['pLDDTs']),
      predictedEpitope: String(row['epitope']).trim().toLowerCase() === 'true',
    };
  });

  sendProgress('discotope', 100, 'done', `${residues.length} residues predicted`);
  return { residues };
});

// ---------------------------------------------------------------------------
// IPC: Tab 2 - Design
// ---------------------------------------------------------------------------
ipcMain.handle('get-scaffold-sequence', async (_evt, { scaffoldName }) => {
  const settings = getSettings();
  if (!settings.rfantibodyDir) {
    throw new Error('RFantibody path not configured in Settings. Needs the scripts/examples/example_inputs/ folder from the RFantibody repo.');
  }
  const fileMap = {
    '3DWT': 'h-NbBCII10.pdb',
  };
  const fileName = fileMap[scaffoldName] || 'h-NbBCII10.pdb';
  const filePath = path.join(settings.rfantibodyDir, 'scripts', 'examples', 'example_inputs', fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Framework file not found: ${filePath}`);
  }
  const pdbText = fs.readFileSync(filePath, 'utf8');
  const { sequence, residueNumbers } = parseChainSequence(pdbText, 'H');
  const cdr = parseCdrRemarks(pdbText);
  return { scaffoldName, filePath, sequence, residueNumbers, cdr };
});

ipcMain.handle('run-rfdiffusion', async (_evt, params) => {
  const { targetPdbPath, pdbId, scaffoldFilePath, outputName, numDesigns, designLoops, hotspotResidues } = params;
  sendProgress('rfdiffusion', 5, 'running', 'Preparing target file (rename Chain A -> T)...');

  const targetText = fs.readFileSync(targetPdbPath, 'utf8');
  const targetT = renameChain(targetText, 'A', 'T');
  const targetTPath = path.join(DIRS.work, `${pdbId}_target_chainT.pdb`);
  fs.writeFileSync(targetTPath, targetT, 'utf8');

  // RFdiffusion needs a dedicated output directory (its -o is a filename
  // prefix inside that directory) so ProteinMPNN can later point -i at it
  // without picking up unrelated files from the shared work/ scratch dir.
  const relOutDir = path.join('work', outputName || `rfdiff_${Date.now()}`);
  const outDirAbs = path.join(ROOT, relOutDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  // Absolute path: runRfantibodyCommand executes with cwd = rfantibodyDir
  // (or /workspace under Docker), not this app's ROOT, so a relative -o
  // would land inside the RFantibody checkout instead of our work/ dir.
  const outPrefix = path.join(outDirAbs, 'design');
  const hotspotStr = hotspotResidues.map((r) => `T${r}`).join(',');

  sendProgress('rfdiffusion', 20, 'running', 'Running RFdiffusion...');
  await runRfantibodyCommand(
    `uv run rfdiffusion -t '${toWslPath(targetTPath)}' -f '${toWslPath(scaffoldFilePath)}' -o '${toWslPath(outPrefix)}' -n ${numDesigns} -l "${designLoops}" -h "${hotspotStr}"`,
    'rfdiffusion'
  );

  const backbones = fs
    .readdirSync(outDirAbs)
    .filter((f) => f.endsWith('.pdb'))
    .map((f) => path.join(outDirAbs, f));

  sendProgress('rfdiffusion', 100, 'done', `${backbones.length} backbones generated`);
  return { backbones, backboneDir: outDirAbs, targetTPath };
});

ipcMain.handle('run-proteinmpnn', async (_evt, params) => {
  const { backboneDir, designsPerBackbone, temperature } = params;
  sendProgress('proteinmpnn', 10, 'running', 'Running ProteinMPNN...');
  const outDir = path.join('work', `mpnn_out_${Date.now()}`);
  const outDirAbs = path.join(ROOT, outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  await runRfantibodyCommand(
    `uv run proteinmpnn -i '${toWslPath(backboneDir)}' -o '${toWslPath(outDirAbs)}' -n ${designsPerBackbone} -t ${temperature}`,
    'proteinmpnn'
  );

  sendProgress('proteinmpnn', 100, 'done', 'Candidate sequences generated');
  return { seqDir: outDirAbs };
});

ipcMain.handle('run-rf2', async (_evt, params) => {
  const { seqDir, numRecycles } = params;
  sendProgress('rf2', 10, 'running', 'Running RF2 (RoseTTAFold2)...');
  const outDir = path.join('work', `rf2_out_${Date.now()}`);
  const outDirAbs = path.join(ROOT, outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  await runRfantibodyCommand(
    `uv run rf2 -i '${toWslPath(seqDir)}' -o '${toWslPath(outDirAbs)}' -r ${numRecycles || 10}`,
    'rf2'
  );

  sendProgress('rf2', 100, 'done', 'Structure prediction done');
  return { rf2OutDir: outDirAbs };
});

ipcMain.handle('score-candidates', async (_evt, params) => {
  const { rf2OutDir, backboneDir, cdr, toolsEnvOverride } = params;
  const settings = getSettings();
  sendProgress('scoring', 10, 'running', 'Computing candidate metrics...');

  const cdrJsonPath = path.join(DIRS.work, `cdr_${Date.now()}.json`);
  writeCacheJson(cdrJsonPath, cdr || {});
  const outJson = path.join(DIRS.work, `candidates_${Date.now()}.json`);

  await runCondaPython(
    toolsEnvOverride || settings.toolsEnv,
    path.join(DIRS.python, 'score_candidates.py'),
    ['--rf2_dir', rf2OutDir, '--backbone_dir', backboneDir, '--cdr_json', cdrJsonPath, '--out', outJson],
    { source: 'scoring' }
  );

  const result = readCacheJson(outJson) || { candidates: [] };
  sendProgress('scoring', 100, 'done', `${result.candidates.length} candidates scored`);
  return result;
});

// ---------------------------------------------------------------------------
// IPC: Tab 3 - Screening
// ---------------------------------------------------------------------------
ipcMain.handle('import-metrics-dialog', async (_evt, { candidates }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose RF2 Metrics File',
    filters: [{ name: 'Metrics', extensions: ['json', 'csv', 'sc'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { candidates, imported: false };

  const filePath = res.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  let parsedRows = [];

  if (ext === '.json') {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    parsedRows = Array.isArray(data) ? data : data.candidates || [];
  } else {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    const lines = text.split(/\r?\n/);
    const sep = ext === '.csv' ? ',' : /\s+/;
    const header = lines[0].split(sep).map((h) => h.trim());
    parsedRows = lines.slice(1).map((line) => {
      const cols = line.split(sep);
      const row = {};
      header.forEach((h, i) => (row[h] = cols[i]));
      return row;
    });
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const row of parsedRows) {
    const id = row.id || row.tag || row.name;
    const target = byId.get(id);
    if (!target) continue;
    for (const [key, val] of Object.entries(row)) {
      if (target[key] === null || target[key] === undefined) {
        target[key] = isNaN(Number(val)) ? val : Number(val);
      }
    }
  }

  sendLog('ok', `Metrics imported from ${path.basename(filePath)}, ${parsedRows.length} rows.`, 'import-metrics');
  return { candidates: Array.from(byId.values()), imported: true, fileName: path.basename(filePath) };
});

ipcMain.handle('codon-optimize', async (_evt, { aminoAcidSeq, organism }) => {
  const settings = getSettings();
  sendProgress('codon-optimize', 10, 'running', 'Running CodonTransformer...');
  const outJson = path.join(DIRS.work, `codon_${Date.now()}.json`);
  await runCondaPython(
    settings.toolsEnv,
    path.join(DIRS.python, 'codon_optimize.py'),
    ['--protein', aminoAcidSeq, '--organism', organism || settings.caiOrganism, '--out', outJson],
    { source: 'codon-optimize' }
  );
  const result = readCacheJson(outJson);
  sendProgress('codon-optimize', 100, 'done', `Method: ${result?.method}`);
  return result;
});

ipcMain.handle('calculate-cai', async (_evt, { dnaSeq }) => {
  const settings = getSettings();
  const outJson = path.join(DIRS.work, `cai_${Date.now()}.json`);
  await runCondaPython(settings.toolsEnv, path.join(DIRS.python, 'calculate_cai.py'), ['--dna', dnaSeq, '--out', outJson], { source: 'cai' });
  return readCacheJson(outJson);
});

// ---------------------------------------------------------------------------
// IPC: Tab 4 - Construct
// ---------------------------------------------------------------------------
const UNIPROT_ACCESSIONS = {
  lpp: { primary: 'P69776', label: 'Lpp (Braun\'s lipoprotein)' },
  ompA: { primary: 'P0A910', label: 'OmpA' },
  intimin: { primary: 'P43261', fallback: 'A1DZE6', label: 'Intimin (EaeA)' },
  pelb: { primary: 'Q04085', label: 'PelB signal peptide (pectate lyase B)' },
};

async function fetchUniprotFasta(accession) {
  const res = await fetch(`https://rest.uniprot.org/uniprotkb/${accession}.fasta`);
  if (!res.ok) throw new Error(`UniProt status ${res.status} for ${accession}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0];
  const sequence = lines.slice(1).join('');
  return { header, sequence, accession };
}

ipcMain.handle('fetch-anchor', async (_evt, { type, forceRefresh }) => {
  const entry = UNIPROT_ACCESSIONS[type];
  if (!entry) throw new Error(`Unknown anchor type: ${type}`);
  const cacheFile = path.join(DIRS.cacheAnchors, `fetch_${type}_result.json`);

  if (!forceRefresh) {
    const cached = readCacheJson(cacheFile);
    if (cached) return { ...cached, fromCache: true };
  }

  sendProgress('anchor-fetch', 20, 'running', `Fetching ${entry.label} sequence from UniProt...`);
  let result;
  try {
    const data = await fetchUniprotFasta(entry.primary);
    result = { ...data, label: entry.label, source: `https://rest.uniprot.org/uniprotkb/${entry.primary}` };
  } catch (e) {
    if (entry.fallback) {
      sendLog('warn', `${entry.primary} failed (${e.message}), trying fallback ${entry.fallback}...`, 'anchor-fetch');
      const data = await fetchUniprotFasta(entry.fallback);
      result = { ...data, label: entry.label, source: `https://rest.uniprot.org/uniprotkb/${entry.fallback}` };
    } else {
      const cached = readCacheJson(cacheFile);
      if (cached) {
        sendLog('warn', 'Fetch failed, using stale cache.', 'anchor-fetch');
        return { ...cached, fromCache: true };
      }
      throw e;
    }
  }

  writeCacheJson(cacheFile, result);
  sendProgress('anchor-fetch', 100, 'done', `${result.sequence.length} residues received`);
  return { ...result, fromCache: false };
});

ipcMain.handle('build-anchor-construct', async (_evt, params) => {
  const { anchorSeq, nanobodyDna, organism } = params;
  const settings = getSettings();
  sendProgress('anchor-construct', 20, 'running', 'Building anchor + linker + nanobody construct...');
  const argsJson = path.join(DIRS.work, `anchor_args_${Date.now()}.json`);
  const outJson = path.join(DIRS.work, `anchor_out_${Date.now()}.json`);
  writeCacheJson(argsJson, { anchor_aa: anchorSeq, nanobody_dna: nanobodyDna, organism: organism || settings.caiOrganism });

  await runCondaPython(
    settings.toolsEnv,
    path.join(DIRS.python, 'build_anchor_construct.py'),
    ['--args_json', argsJson, '--out', outJson],
    { source: 'anchor-construct' }
  );

  const result = readCacheJson(outJson);
  sendProgress('anchor-construct', 100, 'done', 'Construct built');
  return result;
});

ipcMain.handle('build-plasmid', async (_evt, params) => {
  const settings = getSettings();
  sendProgress('plasmid', 20, 'running', 'Assembling insert & FASTA...');

  let pelbAminoAcidSeq = null;
  if (params.includePelb) {
    sendProgress('plasmid', 35, 'running', 'Fetching PelB sequence from UniProt...');
    try {
      const { sequence } = await fetchUniprotFasta(UNIPROT_ACCESSIONS.pelb.primary);
      pelbAminoAcidSeq = sequence;
    } catch (e) {
      sendLog('warn', `Failed to fetch PelB from UniProt: ${e.message}. PelB will be skipped.`, 'plasmid');
    }
  }

  const argsJson = path.join(DIRS.work, `plasmid_args_${Date.now()}.json`);
  writeCacheJson(argsJson, { ...params, pelbAminoAcidSeq, output_dir: DIRS.output });
  const outJson = path.join(DIRS.work, `plasmid_out_${Date.now()}.json`);

  await runCondaPython(
    settings.toolsEnv,
    path.join(DIRS.python, 'build_plasmid.py'),
    ['--args_json', argsJson, '--out', outJson],
    { source: 'plasmid' }
  );

  const result = readCacheJson(outJson);
  sendProgress('plasmid', 100, 'done', `FASTA saved: ${result?.fastaPath ? path.basename(result.fastaPath) : ''}`);
  return result;
});

ipcMain.handle('open-output-folder', async () => {
  await shell.openPath(DIRS.output);
  return true;
});

// ---------------------------------------------------------------------------
// IPC: Cross-tab
// ---------------------------------------------------------------------------
ipcMain.handle('get-platform-info', async () => PLATFORM_INFO);

ipcMain.handle('check-gpu', async () => {
  const settings = getSettings();
  try {
    const { stdout } = await runCondaPython(settings.discotopeEnv, path.join(DIRS.python, 'check_gpu.py'), [], { source: 'gpu-check' });
    const jsonLine = stdout.trim().split(/\r?\n/).pop();
    return JSON.parse(jsonLine);
  } catch (e) {
    sendLog('warn', `Pre-flight GPU check failed: ${e.message}`, 'gpu-check');
    return { cudaAvailable: false, gpuName: null, vramTotalGb: null, error: e.message };
  }
});

ipcMain.handle('save-project', async (_evt, state) => {
  const id = state.id || `project_${Date.now()}`;
  const filePath = path.join(DIRS.projects, `${id}.json`);
  const payload = { ...state, id, savedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { id, filePath };
});

ipcMain.handle('load-project', async (_evt, id) => {
  const filePath = path.join(DIRS.projects, `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
});

ipcMain.handle('list-projects', async () => {
  return fs
    .readdirSync(DIRS.projects)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const data = readCacheJson(path.join(DIRS.projects, f));
      return { id: data?.id || f.replace('.json', ''), name: data?.name || data?.pdbId || f, savedAt: data?.savedAt };
    })
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
});

ipcMain.handle('delete-project', async (_evt, id) => {
  const filePath = path.join(DIRS.projects, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
});

ipcMain.handle('get-settings', async () => getSettings());
ipcMain.handle('save-settings', async (_evt, settings) => saveSettingsToDisk(settings));

ipcMain.handle('pick-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  if (process.env.DEBUG_CONSOLE_FORWARD) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }
  mainWindow.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (process.env.DEBUG_AUTOTEST_PDB) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(`
          document.getElementById('pdb-id-input').value = '${process.env.DEBUG_AUTOTEST_PDB}';
          document.getElementById('btn-analyze').click();
        `);
      }, 500);
    });
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
