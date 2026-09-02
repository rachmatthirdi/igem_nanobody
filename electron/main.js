const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

// On native Wayland sessions, Chromium's default wayland ozone backend can
// segfault at startup when combined with Vulkan on some GPU/driver stacks
// ("--ozone-platform=wayland is not compatible with Vulkan"). --ozone-platform
// has to be a literal CLI argument - app.commandLine.appendSwitch() runs too
// late, after ozone has already initialized - so relaunch once with it added.
if (
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY) &&
  !process.argv.includes("--ozone-platform=x11")
) {
  spawn(process.execPath, [...process.argv.slice(1), "--ozone-platform=x11"], {
    stdio: "inherit",
    env: process.env,
  }).on("exit", (code) => process.exit(code ?? 0));
  return;
}

const ROOT = path.join(__dirname, "..");
const DIRS = {
  cachePdb: path.join(ROOT, "cache", "pdb"),
  cacheInterpro: path.join(ROOT, "cache", "interpro"),
  cacheAnchors: path.join(ROOT, "cache", "anchors"),
  cacheWeights: path.join(ROOT, "cache", "weights"), // model weights the app fetches itself (licenses that forbid redistribution)
  projects: path.join(ROOT, "projects"),
  output: path.join(ROOT, "output"),
  python: path.join(ROOT, "python"),
  work: path.join(ROOT, "work"), // scratch dir for RFantibody/DiscoTope intermediate files
};

for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

let mainWindow = null;

// ---------------------------------------------------------------------------
// Platform detection (OS / WSL2) - display-only info for the System Monitor
// sidebar. Every heavy tool now runs inside the Docker image regardless of
// host OS, so this no longer picks an execution mode - just a friendly label.
// ---------------------------------------------------------------------------
function detectPlatformInfo() {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux' | ...
  let isWSL = false;
  if (platform === "linux") {
    try {
      isWSL = /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
    } catch {
      // /proc/version should always exist on Linux, but don't crash startup if it doesn't.
    }
    if (!isWSL && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP))
      isWSL = true;
  }

  let label;
  if (platform === "win32") label = "Windows";
  else if (platform === "darwin") label = "macOS";
  else if (isWSL)
    label = `Linux (WSL2${process.env.WSL_DISTRO_NAME ? `: ${process.env.WSL_DISTRO_NAME}` : ""})`;
  else label = "Linux (native)";

  return { platform, isWSL, label };
}

const PLATFORM_INFO = detectPlatformInfo();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  installMode: "", // '' (Docker image not built yet) | 'docker' - Docker is the only execution path
  dockerImage: "rachmatthirdi/igem_brawijaya:latest",
  caiOrganism: "Escherichia coli general",
  gpuOverride: "auto", // 'auto' | 'on' | 'off' - manual escape hatch for when
  // auto-detection gets it wrong (e.g. nvidia-smi present but the check fails
  // for some host-specific reason, or the user wants to force CPU for testing)
};

// Conda env names and repo paths baked into the Docker image by
// docker/Dockerfile - fixed, not user-configurable, since Docker is now the
// only way these tools run.
const TOOLS_ENV = "nanobody-tools";
const DISCOTOPE_ENV = "discotope";
const DOCKER_TOOL_PATHS = {
  discotopeRepoDir: "/opt/tools/DiscoTope-3.0",
  rfantibodyDir: "/opt/tools/RFantibody",
  rf2WeightPath: "/opt/tools/RFantibody/weights/RF2_ab.pt",
};

// RF2's weights are Rosetta-DL licensed (non-commercial, no redistribution
// by licensees) - unlike RFdiffusion/ProteinMPNN's weights, we can't bundle
// this into a published image. Each install fetches its own copy here and
// it gets bind-mounted into the container at the path RF2 already expects,
// which also makes this the one weight file safe to skip baking into any
// image meant for a public registry.
const RF2_WEIGHT_URL = "https://files.ipd.uw.edu/pub/RFantibody/RF2_ab.pt";
const RF2_WEIGHT_PATH = path.join(DIRS.cacheWeights, "RF2_ab.pt");

// Retries a long-running network operation on failure. Both Docker Hub
// pulls and the RF2 weight download have hit real, observed transient
// failures live during testing (connection reset, DNS EAI_AGAIN) that
// otherwise kill a many-minutes-long transfer over one blip - Docker and
// downloadFileWithProgress both resume/skip already-fetched data on a
// fresh attempt, so a retry is cheap, not a full restart.
async function withRetry(fn, { maxAttempts = 5, stage, what }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      const delaySec = attempt * 10;
      sendLog(
        "warn",
        `${what} failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in ${delaySec}s...`,
        stage,
      );
      sendProgress(
        stage,
        0,
        "running",
        `Failed, retrying in ${delaySec}s (attempt ${attempt}/${maxAttempts})...`,
      );
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
}

async function ensureRf2Weights() {
  if (fs.existsSync(RF2_WEIGHT_PATH)) return;
  sendProgress("rf2-weights", 0, "running", "Downloading RF2 weights...");
  await withRetry(
    () =>
      downloadFileWithProgress(
        RF2_WEIGHT_URL,
        RF2_WEIGHT_PATH,
        "rf2-weights",
        "RF2 weights",
      ),
    { stage: "rf2-weights", what: "RF2 weight download" },
  );
  sendProgress("rf2-weights", 100, "done", "RF2 weights downloaded.");
}

// Set once by the check-gpu handler; gates whether `--gpus all` is passed to
// `docker run` so Docker mode doesn't hard-fail on machines without
// nvidia-container-toolkit.
let GPU_AVAILABLE = false;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsToDisk(settings) {
  const merged = { ...getSettings(), ...settings };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

// ---------------------------------------------------------------------------
// Logging / progress helpers (streamed to renderer Live Console + progress bars)
// ---------------------------------------------------------------------------
function sendLog(level, text, source) {
  if (!mainWindow) return;
  mainWindow.webContents.send("console-log", {
    level, // 'info' | 'ok' | 'warn' | 'error'
    text,
    source,
    ts: Date.now(),
  });
}

function sendProgress(stage, percent, status, message) {
  if (!mainWindow) return;
  mainWindow.webContents.send("stage-progress", {
    stage,
    percent,
    status,
    message,
    ts: Date.now(),
  });
}

function classifyLine(line) {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("traceback") || l.includes("exception"))
    return "error";
  if (l.includes("warn")) return "warn";
  if (
    l.includes("done") ||
    l.includes("success") ||
    l.includes("✓") ||
    l.includes("selesai")
  )
    return "ok";
  return "info";
}

// ---------------------------------------------------------------------------
// Subprocess runner: streams stdout/stderr line-by-line to the Live Console
// ---------------------------------------------------------------------------
function runProcess(cmd, args, { cwd, source, env } = {}) {
  return new Promise((resolve, reject) => {
    sendLog("info", `$ ${cmd} ${args.join(" ")}`, source);
    const child = spawn(cmd, args, {
      cwd: cwd || ROOT,
      env: { ...process.env, ...(env || {}) },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => sendLog(classifyLine(line), line, source));
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) =>
          sendLog(
            classifyLine(line) === "info" ? "warn" : classifyLine(line),
            line,
            source,
          ),
        );
    });

    child.on("error", (err) => {
      sendLog("error", `Failed to run process: ${err.message}`, source);
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        sendLog("ok", `Process finished (${source})`, source);
        resolve({ code, stdout, stderr });
      } else {
        sendLog(
          "error",
          `Process failed with code ${code} (${source})`,
          source,
        );
        reject(
          new Error(
            `${source} exited with code ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Real byte-level progress for Docker pulls and standalone file downloads
// ---------------------------------------------------------------------------
function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatMB(bytes) {
  return (bytes / 1e6).toFixed(1);
}

// Pulls via the Docker Engine API (not the `docker` CLI) so we get real
// per-layer byte counts to aggregate into one overall percentage - the CLI's
// own multi-line progress output is meant for terminal rendering, not
// machine parsing, and doesn't expose stable byte totals.
function pullDockerImageWithProgress(imageRef, stage) {
  return new Promise((resolve, reject) => {
    const lastColon = imageRef.lastIndexOf(":");
    const hasTag = lastColon > imageRef.lastIndexOf("/");
    const fromImage = hasTag ? imageRef.slice(0, lastColon) : imageRef;
    const tag = hasTag ? imageRef.slice(lastColon + 1) : "latest";

    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path: `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
        method: "POST",
      },
      (res) => {
        let buf = "";
        const layers = new Map();
        const startedAt = Date.now();
        let lastEmit = 0;
        let sawError = null;

        res.on("data", (chunk) => {
          buf += chunk.toString();
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.error) {
              sawError = msg.error;
              continue;
            }
            if (
              msg.id &&
              msg.progressDetail &&
              typeof msg.progressDetail.total === "number" &&
              msg.progressDetail.total > 0
            ) {
              layers.set(msg.id, {
                current: msg.progressDetail.current,
                total: msg.progressDetail.total,
              });
              const now = Date.now();
              if (now - lastEmit < 400) continue;
              lastEmit = now;
              let cur = 0,
                tot = 0;
              for (const v of layers.values()) {
                cur += v.current;
                tot += v.total;
              }
              const elapsed = (now - startedAt) / 1000;
              const rate = cur / elapsed;
              const eta = rate > 0 ? (tot - cur) / rate : NaN;
              const percent = Math.min(99, (cur / tot) * 100);
              sendProgress(
                stage,
                percent,
                "running",
                `Pulling image: ${percent.toFixed(0)}% (${formatMB(cur)}MB/${formatMB(tot)}MB)` +
                  (isFinite(eta) ? ` — ${formatEta(eta)} remaining` : ""),
              );
            } else if (msg.status) {
              sendLog(
                "info",
                msg.status + (msg.id ? ` ${msg.id}` : ""),
                "docker-pull",
              );
            }
          }
        });

        res.on("end", () => {
          if (sawError) reject(new Error(sawError));
          else resolve();
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Downloads a single file with real byte-level progress (Content-Length
// based). Used for weight files whose license permits users fetching their
// own copy but forbids us pre-bundling it into a published image.
function downloadFileWithProgress(url, destPath, stage, label) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part`;
    const file = fs.createWriteStream(tmpPath);
    const startedAt = Date.now();
    let lastEmit = 0;

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(tmpPath, () => {});
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        const total = parseInt(res.headers["content-length"], 10) || 0;
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit < 400) return;
          lastEmit = now;
          const elapsed = (now - startedAt) / 1000;
          const rate = received / elapsed;
          const eta = rate > 0 && total > 0 ? (total - received) / rate : NaN;
          const percent =
            total > 0 ? Math.min(99, (received / total) * 100) : 0;
          sendProgress(
            stage,
            percent,
            "running",
            `Downloading ${label}: ${percent.toFixed(0)}% (${formatMB(received)}MB/${formatMB(total)}MB)` +
              (isFinite(eta) ? ` — ${formatEta(eta)} remaining` : ""),
          );
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            fs.renameSync(tmpPath, destPath);
            resolve();
          });
        });
      })
      .on("error", (e) => {
        file.close();
        fs.unlink(tmpPath, () => {});
        reject(e);
      });
  });
}

const DOCKER_NOT_READY_MSG =
  'The Docker image isn\'t built yet. Open Settings and click "Build Docker image" (or use the install prompt on launch).';

function requireDocker() {
  const settings = getSettings();
  if (settings.installMode !== "docker") throw new Error(DOCKER_NOT_READY_MSG);
  return settings;
}

function runCondaPython(envName, scriptPath, args, opts = {}) {
  const settings = requireDocker();
  const gpuFlags = GPU_AVAILABLE ? ["--gpus", "all"] : [];
  // Mount ROOT at the same absolute path inside the container so every
  // caller's host-absolute paths (under ROOT/work, ROOT/cache, ROOT/python)
  // resolve unchanged - no path translation needed.
  return runProcess(
    "docker",
    [
      "run",
      "--rm",
      ...gpuFlags,
      "-v",
      `${ROOT}:${ROOT}`,
      "-w",
      ROOT,
      settings.dockerImage,
      "conda",
      "run",
      "-n",
      envName,
      "--no-capture-output",
      "python",
      scriptPath,
      ...args,
    ],
    opts,
  );
}

// Runs a shell command line inside the RFantibody checkout baked into the
// Docker image (uv-managed venv, e.g. `uv run rfdiffusion ...`).
function runRfantibodyCommand(commandLine, source, extraMounts = []) {
  const settings = requireDocker();
  const rfantibodyDir = DOCKER_TOOL_PATHS.rfantibodyDir;
  const gpuFlags = GPU_AVAILABLE ? ["--gpus", "all"] : [];
  const mountFlags = extraMounts.flatMap((m) => ["-v", m]);
  const full = `cd '${rfantibodyDir}' && ${commandLine}`;
  // ROOT is mounted so output paths under DIRS.work (which live under ROOT,
  // not rfantibodyDir) are visible inside the container too.
  return runProcess(
    "docker",
    [
      "run",
      "--rm",
      ...gpuFlags,
      "-v",
      `${ROOT}:${ROOT}`,
      ...mountFlags,
      "-w",
      rfantibodyDir,
      settings.dockerImage,
      "bash",
      "-lc",
      full,
    ],
    { source },
  );
}

// ---------------------------------------------------------------------------
// PDB helpers (pure JS, no external deps)
// ---------------------------------------------------------------------------
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

function extractChain(pdbText, chainId) {
  const lines = pdbText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.startsWith("ATOM") || line.startsWith("HETATM")) {
      const chain = line.charAt(21);
      if (chain === chainId) out.push(line);
    } else if (
      line.startsWith("REMARK") ||
      line.startsWith("TER") ||
      line.startsWith("END")
    ) {
      out.push(line);
    }
  }
  return out.join("\n") + "\n";
}

function renameChain(pdbText, fromChain, toChain) {
  return (
    pdbText
      .split(/\r?\n/)
      .map((line) => {
        if (
          (line.startsWith("ATOM") ||
            line.startsWith("HETATM") ||
            line.startsWith("TER")) &&
          line.charAt(21) === fromChain
        ) {
          return line.slice(0, 21) + toChain + line.slice(22);
        }
        return line;
      })
      .join("\n") + "\n"
  );
}

function parseChainSequence(pdbText, chainId) {
  const seenRes = new Set();
  let sequence = "";
  const residueNumbers = [];
  for (const line of pdbText.split(/\r?\n/)) {
    if (!line.startsWith("ATOM")) continue;
    if (line.charAt(21) !== chainId) continue;
    if (line.slice(12, 16).trim() !== "CA") continue;
    const resName = line.slice(17, 20).trim();
    const resNum = line.slice(22, 26).trim();
    const key = resNum;
    if (seenRes.has(key)) continue;
    seenRes.add(key);
    sequence += AA_3TO1[resName] || "X";
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
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCacheJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
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
    if (entry.isFile() && matchFn(entry.name))
      return path.join(dir, entry.name);
  }
  if (maxDepth > 0) {
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = findFileRecursive(
          path.join(dir, entry.name),
          matchFn,
          maxDepth - 1,
        );
        if (found) return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPC: Tab 1 - Target
// ---------------------------------------------------------------------------
ipcMain.handle("fetch-pdb", async (_evt, pdbId) => {
  const id = pdbId.trim().toUpperCase();
  const pdbPath = path.join(DIRS.cachePdb, `${id}.pdb`);
  const chainAPath = path.join(DIRS.cachePdb, `${id}_chainA.pdb`);

  sendProgress(
    "download-pdb",
    10,
    "running",
    `Downloading ${id}.pdb from RCSB...`,
  );
  let pdbText;
  if (fs.existsSync(pdbPath)) {
    pdbText = fs.readFileSync(pdbPath, "utf8");
    sendLog("info", `${id}.pdb found in local cache.`, "download-pdb");
  } else {
    const url = `https://files.rcsb.org/download/${id}.pdb`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(`RCSB returned status ${res.status} for PDB ID "${id}"`);
    pdbText = await res.text();
    fs.writeFileSync(pdbPath, pdbText, "utf8");
  }
  sendProgress("download-pdb", 60, "running", "Extracting Chain A...");

  const chainAText = extractChain(pdbText, "A");
  fs.writeFileSync(chainAPath, chainAText, "utf8");

  let title = "";
  try {
    const tRes = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${id}`);
    if (tRes.ok) {
      const data = await tRes.json();
      title = data?.struct?.title || "";
    }
  } catch (e) {
    sendLog(
      "warn",
      `Failed to fetch structure title: ${e.message}`,
      "download-pdb",
    );
  }

  const sizeKB = Math.round(Buffer.byteLength(pdbText, "utf8") / 1024);
  sendProgress("download-pdb", 100, "done", `Done (${sizeKB} KB)`);

  return { pdbId: id, pdbPath, chainAPath, sizeKB, title };
});

ipcMain.handle("read-pdb-file", async (_evt, filePath) => {
  return fs.readFileSync(filePath, "utf8");
});

ipcMain.handle("get-structure-title", async (_evt, pdbId) => {
  const res = await fetch(
    `https://data.rcsb.org/rest/v1/core/entry/${pdbId.toUpperCase()}`,
  );
  if (!res.ok) throw new Error(`data.rcsb.org status ${res.status}`);
  const data = await res.json();
  return data?.struct?.title || "";
});

ipcMain.handle("run-interpro", async (_evt, { pdbId, forceRefresh }) => {
  const id = pdbId.trim().toUpperCase();
  const cacheFile = path.join(DIRS.cacheInterpro, `${id}.json`);

  if (!forceRefresh) {
    const cached = readCacheJson(cacheFile);
    if (cached) {
      sendLog(
        "info",
        `InterPro domains for ${id} loaded from cache.`,
        "interpro",
      );
      sendProgress(
        "interpro",
        100,
        "done",
        `${cached.length} domains loaded from cache`,
      );
      return { domains: cached, fromCache: true };
    }
  }

  sendProgress("interpro", 20, "running", "Contacting EBI InterPro API...");
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
    sendProgress("interpro", 100, "done", `${domains.length} domains found`);
  } catch (e) {
    sendLog("warn", `InterPro fetch failed: ${e.message}`, "interpro");
    const cached = readCacheJson(cacheFile);
    if (cached) {
      sendLog("info", "Using stale cache as a fallback.", "interpro");
      return { domains: cached, fromCache: true };
    }
    sendProgress("interpro", 100, "error", e.message);
    domains = [];
  }

  return { domains, fromCache: false };
});

ipcMain.handle("run-freesasa", async (_evt, { chainAPath }) => {
  sendProgress("freesasa", 10, "running", "Running FreeSASA...");
  try {
    const outJson = path.join(DIRS.work, `sasa_${Date.now()}.json`);
    await runCondaPython(
      TOOLS_ENV,
      path.join(DIRS.python, "run_freesasa.py"),
      [chainAPath, outJson],
      { source: "freesasa" },
    );
    const result = readCacheJson(outJson);
    sendProgress(
      "freesasa",
      100,
      "done",
      `${result?.residues?.length || 0} residues analyzed`,
    );
    return result;
  } catch (e) {
    sendProgress("freesasa", 100, "error", e.message);
    throw e;
  }
});

ipcMain.handle("run-discotope", async (_evt, { chainAPath, pdbId }) => {
  sendProgress("discotope", 10, "running", "Loading DiscoTope-3.0 model...");
  try {
    const inDir = path.join(DIRS.work, `discotope_in_${Date.now()}`);
    const outDir = path.join(DIRS.work, `discotope_out_${Date.now()}`);
    fs.mkdirSync(inDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(chainAPath, path.join(inDir, `${pdbId}.pdb`));

    const scriptPath = `${DOCKER_TOOL_PATHS.discotopeRepoDir}/discotope3/main.py`;
    const modelsDir = `${DOCKER_TOOL_PATHS.discotopeRepoDir}/models`;
    sendProgress("discotope", 30, "running", "Predicting epitopes...");
    await runCondaPython(
      DISCOTOPE_ENV,
      scriptPath,
      ["--pdb_dir", inDir, "--out_dir", outDir, "--models_dir", modelsDir],
      { source: "discotope" },
    );

    // Real output filename per discotope3/main.py: {out_dir}/{out_name}/{pdb}_discotope3.csv,
    // where out_name = basename of --pdb_dir (get_basename_no_ext(args.pdb_dir) in main()) -
    // i.e. always one directory deeper than out_dir itself, so this must recurse.
    // Real column order (verified against the source, not guessed):
    // pdb, chain, res_id, residue, DiscoTope-3.0_score, calibrated_score, epitope, rsa, pLDDTs, length, alphafold_struc_flag
    const csvPath = findFileRecursive(outDir, (f) =>
      f.endsWith("_discotope3.csv"),
    );
    if (!csvPath)
      throw new Error("DiscoTope-3.0 did not produce an output CSV file.");

    const csvText = fs.readFileSync(csvPath, "utf8");
    const lines = csvText.trim().split(/\r?\n/);
    const header = lines[0].split(",").map((h) => h.trim());
    // PDB insertion codes (e.g. "49A") aren't plain integers - parseInt would
    // silently truncate them to 49, colliding with the real residue 49
    // instead of erroring, so require a clean numeric match and drop rows
    // that don't have one (every downstream consumer needs a plain int
    // anyway, same as run_freesasa.py's equivalent skip).
    const residues = lines
      .slice(1)
      .map((line) => {
        const cols = line.split(",");
        const row = {};
        header.forEach((h, i) => (row[h] = cols[i]));
        if (!/^\d+$/.test(String(row["res_id"]).trim())) return null;
        return {
          resNum: parseInt(row["res_id"], 10),
          residue: row["residue"],
          discotopeScore: parseFloat(row["DiscoTope-3.0_score"]),
          calibratedScore: parseFloat(row["calibrated_score"]),
          rsa: parseFloat(row["rsa"]),
          plddt: parseFloat(row["pLDDTs"]),
          predictedEpitope:
            String(row["epitope"]).trim().toLowerCase() === "true",
        };
      })
      .filter(Boolean);

    sendProgress(
      "discotope",
      100,
      "done",
      `${residues.length} residues predicted`,
    );
    return { residues };
  } catch (e) {
    sendProgress("discotope", 100, "error", e.message);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// IPC: Tab 2 - Design
// ---------------------------------------------------------------------------
ipcMain.handle("get-scaffold-sequence", async (_evt, { scaffoldName }) => {
  const settings = requireDocker();
  const fileMap = {
    "3DWT": "h-NbBCII10.pdb",
  };
  const fileName = fileMap[scaffoldName] || "h-NbBCII10.pdb";
  const filePath = `${DOCKER_TOOL_PATHS.rfantibodyDir}/scripts/examples/example_inputs/${fileName}`;
  // The scaffold file lives inside the Docker image, not on the host, so read
  // it out via a one-off container run instead of fs.readFileSync.
  const { stdout: pdbText } = await runProcess(
    "docker",
    ["run", "--rm", settings.dockerImage, "cat", filePath],
    { source: "scaffold" },
  );
  const { sequence, residueNumbers } = parseChainSequence(pdbText, "H");
  const cdr = parseCdrRemarks(pdbText);
  return { scaffoldName, filePath, sequence, residueNumbers, cdr };
});

ipcMain.handle("run-rfdiffusion", async (_evt, params) => {
  const {
    targetPdbPath,
    pdbId,
    scaffoldFilePath,
    outputName,
    numDesigns,
    designLoops,
    hotspotResidues,
  } = params;
  sendProgress(
    "rfdiffusion",
    5,
    "running",
    "Preparing target file (rename Chain A -> T)...",
  );

  const targetText = fs.readFileSync(targetPdbPath, "utf8");
  const targetT = renameChain(targetText, "A", "T");
  const targetTPath = path.join(DIRS.work, `${pdbId}_target_chainT.pdb`);
  fs.writeFileSync(targetTPath, targetT, "utf8");

  // RFdiffusion needs a dedicated output directory (its -o is a filename
  // prefix inside that directory) so ProteinMPNN can later point -i at it
  // without picking up unrelated files from the shared work/ scratch dir.
  const relOutDir = path.join("work", outputName || `rfdiff_${Date.now()}`);
  const outDirAbs = path.join(ROOT, relOutDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  // Absolute path: runRfantibodyCommand executes with cwd = the RFantibody
  // checkout inside the container, not this app's ROOT, so a relative -o
  // would land inside the RFantibody checkout instead of our work/ dir.
  const outPrefix = path.join(outDirAbs, "design");
  const hotspotStr = hotspotResidues.map((r) => `T${r}`).join(",");

  sendProgress("rfdiffusion", 20, "running", "Running RFdiffusion...");
  await runRfantibodyCommand(
    `uv run rfdiffusion -t '${targetTPath}' -f '${scaffoldFilePath}' -o '${outPrefix}' -n ${numDesigns} -l "${designLoops}" -h "${hotspotStr}"`,
    "rfdiffusion",
  );

  const backbones = fs
    .readdirSync(outDirAbs)
    .filter((f) => f.endsWith(".pdb"))
    .map((f) => path.join(outDirAbs, f));

  sendProgress(
    "rfdiffusion",
    100,
    "done",
    `${backbones.length} backbones generated`,
  );
  return { backbones, backboneDir: outDirAbs, targetTPath };
});

ipcMain.handle("run-proteinmpnn", async (_evt, params) => {
  const { backboneDir, designsPerBackbone, temperature } = params;
  sendProgress("proteinmpnn", 10, "running", "Running ProteinMPNN...");
  const outDir = path.join("work", `mpnn_out_${Date.now()}`);
  const outDirAbs = path.join(ROOT, outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  await runRfantibodyCommand(
    `uv run proteinmpnn -i '${backboneDir}' -o '${outDirAbs}' -n ${designsPerBackbone} -t ${temperature}`,
    "proteinmpnn",
  );

  sendProgress("proteinmpnn", 100, "done", "Candidate sequences generated");
  return { seqDir: outDirAbs };
});

ipcMain.handle("run-rf2", async (_evt, params) => {
  const { seqDir, numRecycles } = params;
  await ensureRf2Weights();
  sendProgress("rf2", 10, "running", "Running RF2 (RoseTTAFold2)...");
  const outDir = path.join("work", `rf2_out_${Date.now()}`);
  const outDirAbs = path.join(ROOT, outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const { stdout } = await runRfantibodyCommand(
    `uv run rf2 -i '${seqDir}' -o '${outDirAbs}' -r ${numRecycles || 10}`,
    "rf2",
    [`${RF2_WEIGHT_PATH}:${DOCKER_TOOL_PATHS.rf2WeightPath}:ro`],
  );

  // RF2 only reports pLDDT on stdout ("Completed: <stem> - Best pLDDT: X") -
  // its output PDBs leave the B-factor column zeroed, so score_candidates.py
  // can't read confidence from the structure file itself. Persist it here as
  // a same-stem sidecar (matching find_pae()'s companion-file convention) so
  // scoring survives past this process exiting.
  for (const m of stdout.matchAll(
    /Completed:\s*(\S+)\s*-\s*Best pLDDT:\s*([\d.]+)/g,
  )) {
    const [, stem, plddt] = m;
    writeCacheJson(path.join(outDirAbs, `${stem}_metrics.json`), {
      plddt: Number(plddt),
    });
  }

  sendProgress("rf2", 100, "done", "Structure prediction done");
  return { rf2OutDir: outDirAbs };
});

ipcMain.handle("score-candidates", async (_evt, params) => {
  const { rf2OutDir, backboneDir, cdr, toolsEnvOverride } = params;
  sendProgress("scoring", 10, "running", "Computing candidate metrics...");

  const cdrJsonPath = path.join(DIRS.work, `cdr_${Date.now()}.json`);
  writeCacheJson(cdrJsonPath, cdr || {});
  const outJson = path.join(DIRS.work, `candidates_${Date.now()}.json`);

  await runCondaPython(
    toolsEnvOverride || TOOLS_ENV,
    path.join(DIRS.python, "score_candidates.py"),
    [
      "--rf2_dir",
      rf2OutDir,
      "--backbone_dir",
      backboneDir,
      "--cdr_json",
      cdrJsonPath,
      "--out",
      outJson,
    ],
    { source: "scoring" },
  );

  const result = readCacheJson(outJson) || { candidates: [] };
  sendProgress(
    "scoring",
    100,
    "done",
    `${result.candidates.length} candidates scored`,
  );
  return result;
});

// ---------------------------------------------------------------------------
// IPC: Tab 3 - Screening
// ---------------------------------------------------------------------------
ipcMain.handle("import-metrics-dialog", async (_evt, { candidates }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose RF2 Metrics File",
    filters: [{ name: "Metrics", extensions: ["json", "csv", "sc"] }],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths[0]) return { candidates, imported: false };

  const filePath = res.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  let parsedRows = [];

  if (ext === ".json") {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    parsedRows = Array.isArray(data) ? data : data.candidates || [];
  } else {
    const text = fs.readFileSync(filePath, "utf8").trim();
    const lines = text.split(/\r?\n/);
    const sep = ext === ".csv" ? "," : /\s+/;
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

  sendLog(
    "ok",
    `Metrics imported from ${path.basename(filePath)}, ${parsedRows.length} rows.`,
    "import-metrics",
  );
  return {
    candidates: Array.from(byId.values()),
    imported: true,
    fileName: path.basename(filePath),
  };
});

ipcMain.handle("codon-optimize", async (_evt, { aminoAcidSeq, organism }) => {
  const settings = getSettings();
  sendProgress("codon-optimize", 10, "running", "Running CodonTransformer...");
  const outJson = path.join(DIRS.work, `codon_${Date.now()}.json`);
  await runCondaPython(
    TOOLS_ENV,
    path.join(DIRS.python, "codon_optimize.py"),
    [
      "--protein",
      aminoAcidSeq,
      "--organism",
      organism || settings.caiOrganism,
      "--out",
      outJson,
    ],
    { source: "codon-optimize" },
  );
  const result = readCacheJson(outJson);
  sendProgress("codon-optimize", 100, "done", `Method: ${result?.method}`);
  return result;
});

ipcMain.handle("calculate-cai", async (_evt, { dnaSeq }) => {
  const outJson = path.join(DIRS.work, `cai_${Date.now()}.json`);
  await runCondaPython(
    TOOLS_ENV,
    path.join(DIRS.python, "calculate_cai.py"),
    ["--dna", dnaSeq, "--out", outJson],
    { source: "cai" },
  );
  return readCacheJson(outJson);
});

// ---------------------------------------------------------------------------
// IPC: Tab 4 - Construct
// ---------------------------------------------------------------------------
const UNIPROT_ACCESSIONS = {
  lpp: { primary: "P69776", label: "Lpp (Braun's lipoprotein)" },
  ompA: { primary: "P0A910", label: "OmpA" },
  intimin: { primary: "P43261", fallback: "A1DZE6", label: "Intimin (EaeA)" },
  pelb: { primary: "Q04085", label: "PelB signal peptide (pectate lyase B)" },
};

async function fetchUniprotFasta(accession) {
  const res = await fetch(
    `https://rest.uniprot.org/uniprotkb/${accession}.fasta`,
  );
  if (!res.ok) throw new Error(`UniProt status ${res.status} for ${accession}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0];
  const sequence = lines.slice(1).join("");
  return { header, sequence, accession };
}

ipcMain.handle("fetch-anchor", async (_evt, { type, forceRefresh }) => {
  const entry = UNIPROT_ACCESSIONS[type];
  if (!entry) throw new Error(`Unknown anchor type: ${type}`);
  const cacheFile = path.join(DIRS.cacheAnchors, `fetch_${type}_result.json`);

  if (!forceRefresh) {
    const cached = readCacheJson(cacheFile);
    if (cached) return { ...cached, fromCache: true };
  }

  sendProgress(
    "anchor-fetch",
    20,
    "running",
    `Fetching ${entry.label} sequence from UniProt...`,
  );
  let result;
  try {
    const data = await fetchUniprotFasta(entry.primary);
    result = {
      ...data,
      label: entry.label,
      source: `https://rest.uniprot.org/uniprotkb/${entry.primary}`,
    };
  } catch (e) {
    if (entry.fallback) {
      sendLog(
        "warn",
        `${entry.primary} failed (${e.message}), trying fallback ${entry.fallback}...`,
        "anchor-fetch",
      );
      const data = await fetchUniprotFasta(entry.fallback);
      result = {
        ...data,
        label: entry.label,
        source: `https://rest.uniprot.org/uniprotkb/${entry.fallback}`,
      };
    } else {
      const cached = readCacheJson(cacheFile);
      if (cached) {
        sendLog("warn", "Fetch failed, using stale cache.", "anchor-fetch");
        return { ...cached, fromCache: true };
      }
      throw e;
    }
  }

  writeCacheJson(cacheFile, result);
  sendProgress(
    "anchor-fetch",
    100,
    "done",
    `${result.sequence.length} residues received`,
  );
  return { ...result, fromCache: false };
});

ipcMain.handle("build-anchor-construct", async (_evt, params) => {
  const { anchorSeq, nanobodyDna, organism } = params;
  const settings = getSettings();
  sendProgress(
    "anchor-construct",
    20,
    "running",
    "Building anchor + linker + nanobody construct...",
  );
  const argsJson = path.join(DIRS.work, `anchor_args_${Date.now()}.json`);
  const outJson = path.join(DIRS.work, `anchor_out_${Date.now()}.json`);
  writeCacheJson(argsJson, {
    anchor_aa: anchorSeq,
    nanobody_dna: nanobodyDna,
    organism: organism || settings.caiOrganism,
  });

  await runCondaPython(
    TOOLS_ENV,
    path.join(DIRS.python, "build_anchor_construct.py"),
    ["--args_json", argsJson, "--out", outJson],
    { source: "anchor-construct" },
  );

  const result = readCacheJson(outJson);
  sendProgress("anchor-construct", 100, "done", "Construct built");
  return result;
});

ipcMain.handle("build-plasmid", async (_evt, params) => {
  const settings = getSettings();
  sendProgress("plasmid", 20, "running", "Assembling insert & FASTA...");

  let pelbAminoAcidSeq = null;
  if (params.includePelb) {
    sendProgress(
      "plasmid",
      35,
      "running",
      "Fetching PelB sequence from UniProt...",
    );
    try {
      const { sequence } = await fetchUniprotFasta(
        UNIPROT_ACCESSIONS.pelb.primary,
      );
      pelbAminoAcidSeq = sequence;
    } catch (e) {
      sendLog(
        "warn",
        `Failed to fetch PelB from UniProt: ${e.message}. PelB will be skipped.`,
        "plasmid",
      );
    }
  }

  const argsJson = path.join(DIRS.work, `plasmid_args_${Date.now()}.json`);
  writeCacheJson(argsJson, {
    ...params,
    pelbAminoAcidSeq,
    output_dir: DIRS.output,
  });
  const outJson = path.join(DIRS.work, `plasmid_out_${Date.now()}.json`);

  await runCondaPython(
    TOOLS_ENV,
    path.join(DIRS.python, "build_plasmid.py"),
    ["--args_json", argsJson, "--out", outJson],
    { source: "plasmid" },
  );

  const result = readCacheJson(outJson);
  sendProgress(
    "plasmid",
    100,
    "done",
    `FASTA saved: ${result?.fastaPath ? path.basename(result.fastaPath) : ""}`,
  );
  return result;
});

ipcMain.handle("open-output-folder", async () => {
  await shell.openPath(DIRS.output);
  return true;
});

// ---------------------------------------------------------------------------
// IPC: Cross-tab
// ---------------------------------------------------------------------------
ipcMain.handle("get-platform-info", async () => PLATFORM_INFO);

async function detectGpu() {
  // check_gpu.py's nvidia-smi fallback needs no conda env or torch, so it
  // can run directly on the host - unlike the Docker path below, which
  // requires an image that likely doesn't exist yet on a fresh install.
  // Try that first so GPU status is accurate before the user has built
  // anything, not just "not detected" until they do.
  const scriptPath = path.join(DIRS.python, "check_gpu.py");
  for (const pythonExe of ["python3", "python"]) {
    const res = spawnSync(pythonExe, [scriptPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (res.error || res.status !== 0 || !res.stdout) continue;
    try {
      return JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    } catch {
      continue;
    }
  }

  try {
    const { stdout } = await runCondaPython(DISCOTOPE_ENV, scriptPath, [], {
      source: "gpu-check",
    });
    return JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch (e) {
    sendLog("warn", `Pre-flight GPU check failed: ${e.message}`, "gpu-check");
    return {
      cudaAvailable: false,
      gpuName: null,
      vramTotalGb: null,
      error: e.message,
    };
  }
}

ipcMain.handle("check-gpu", async () => {
  const detected = await detectGpu();
  const { gpuOverride } = getSettings();

  let result = detected;
  if (gpuOverride === "on" && !detected.cudaAvailable) {
    result = {
      ...detected,
      cudaAvailable: true,
      gpuName: detected.gpuName || "Forced on (manual override)",
    };
  } else if (gpuOverride === "off" && detected.cudaAvailable) {
    result = { ...detected, cudaAvailable: false };
  }

  GPU_AVAILABLE = !!result.cudaAvailable;
  return result;
});

// ---------------------------------------------------------------------------
// IPC: Installation (Docker build)
// ---------------------------------------------------------------------------
ipcMain.handle("check-docker", async () => {
  try {
    const res = spawnSync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { encoding: "utf8", timeout: 5000 },
    );
    if (res.error || res.status !== 0)
      return { available: false, version: null };
    return { available: true, version: res.stdout.trim() };
  } catch {
    return { available: false, version: null };
  }
});

// Actually verifies Docker can reach the GPU (driver + nvidia-container-
// toolkit both working), rather than trusting the "Force GPU on" setting
// blindly - that setting only skips our own detection script, it can't make
// Docker's GPU passthrough work if it isn't actually configured on the host.
// Uses ubuntu:22.04 (small, likely already pulled) instead of our own image,
// so this works even before the Docker build has run.
ipcMain.handle("test-gpu-docker", async () => {
  const res = spawnSync(
    "docker",
    ["run", "--rm", "--gpus", "all", "ubuntu:22.04", "nvidia-smi"],
    { encoding: "utf8", timeout: 60000 },
  );
  if (res.error) return { success: false, message: res.error.message };
  if (res.status !== 0)
    return {
      success: false,
      message: (res.stderr || res.stdout || "Unknown error").trim(),
    };
  return { success: true, message: res.stdout.trim() };
});

// Pulls the pre-built image from Docker Hub - the default, recommended path
// for most users, since it skips the ~20-30 min local build (conda solves,
// weight downloads, uv sync) entirely. Doesn't include RF2_ab.pt (see the
// Dockerfile's note on why); ensureRf2Weights() fetches that separately on
// first use of the Design pipeline.
ipcMain.handle("pull-docker-image", async () => {
  const settings = getSettings();
  sendProgress("install", 0, "running", "Pulling Docker image...");
  await withRetry(
    () => pullDockerImageWithProgress(settings.dockerImage, "install"),
    { stage: "install", what: "Docker image pull" },
  );
  saveSettingsToDisk({ installMode: "docker" });
  sendProgress("install", 100, "done", "Docker image ready.");
  return getSettings();
});

// Builds from the local Dockerfile instead of pulling - for anyone who's
// modified docker/Dockerfile, or would rather build from source than trust
// a prebuilt image. Not exposed as the primary Settings button (that's
// pull-docker-image above); kept available for that case.
ipcMain.handle("run-docker-build", async () => {
  const settings = getSettings();
  sendProgress("install", 10, "running", "Building Docker image...");
  await runProcess(
    "docker",
    [
      "build",
      "-f",
      path.join(ROOT, "docker", "Dockerfile"),
      "-t",
      settings.dockerImage,
      ROOT,
    ],
    { source: "docker-build" },
  );
  saveSettingsToDisk({ installMode: "docker" });
  sendProgress("install", 100, "done", "Docker image ready.");
  return getSettings();
});

ipcMain.handle("save-project", async (_evt, state) => {
  const id = state.id || `project_${Date.now()}`;
  const filePath = path.join(DIRS.projects, `${id}.json`);
  const payload = { ...state, id, savedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return { id, filePath };
});

ipcMain.handle("load-project", async (_evt, id) => {
  const filePath = path.join(DIRS.projects, `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
});

ipcMain.handle("list-projects", async () => {
  return fs
    .readdirSync(DIRS.projects)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const data = readCacheJson(path.join(DIRS.projects, f));
      return {
        id: data?.id || f.replace(".json", ""),
        name: data?.name || data?.pdbId || f,
        savedAt: data?.savedAt,
      };
    })
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
});

ipcMain.handle("delete-project", async (_evt, id) => {
  const filePath = path.join(DIRS.projects, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
});

ipcMain.handle("get-settings", async () => getSettings());
ipcMain.handle("save-settings", async (_evt, settings) =>
  saveSettingsToDisk(settings),
);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  if (process.env.DEBUG_CONSOLE_FORWARD) {
    mainWindow.webContents.on(
      "console-message",
      (_e, level, message, line, sourceId) => {
        console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
      },
    );
  }
  mainWindow.loadFile(path.join(ROOT, "renderer", "index.html"));
  if (process.env.DEBUG_AUTOTEST_PDB) {
    mainWindow.webContents.once("did-finish-load", () => {
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
