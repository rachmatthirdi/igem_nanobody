const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const {
  downloadFileWithProgress: downloadFile,
  formatEta,
  formatMB,
} = require("./download");

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
  cacheDiscotope: path.join(ROOT, "cache", "discotope"),
  cacheAnchors: path.join(ROOT, "cache", "anchors"),
  cacheWeights: path.join(ROOT, "cache", "weights"), // model weights the app fetches itself (licenses that forbid redistribution)
  cacheHf: path.join(ROOT, "cache", "hf"), // HuggingFace cache (CodonTransformer's model), kept out of the throwaway container
  cacheTorch: path.join(ROOT, "cache", "torch"), // torch.hub cache (DiscoTope's ESM-IF1 weights), same reason as cacheHf
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
// otherwise kill a many-minutes-long transfer over one blip. A Docker pull
// genuinely resumes - it skips the layers that already finished. A file
// download does not: there is no Range request here, so each attempt starts
// from zero. Retrying is still worth it (a restarted download beats a failed
// install), and downloadFileWithProgress checks the finished size against
// Content-Length, so a retry can never promote a truncated file.
async function withRetry(fn, { maxAttempts = 5, stage, what }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // A user-initiated cancel isn't a transient failure - retrying would
      // just restart the download right after they asked it to stop.
      if (e.cancelled || attempt === maxAttempts) throw e;
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

// Same transient-failure class applies to the small JSON/FASTA lookups
// (RCSB, InterPro, UniProt) - a dropped connection shouldn't fail the whole
// pipeline. Only retries connection-level errors and 5xx (may recover); a
// 4xx (e.g. a mistyped PDB ID) is not transient, so it fails immediately
// instead of making the user wait through backoff for a typo.
async function fetchWithRetry(url, opts, { stage, what }) {
  return withRetry(
    async () => {
      const res = await fetch(url, opts);
      if (!res.ok && res.status >= 500) {
        throw new Error(`${what} returned status ${res.status}`);
      }
      return res;
    },
    { stage, what },
  );
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
// Tracks in-flight work so cancelPipeline() can stop it. Containers are
// tracked by name as well as by child process: `docker run` detaches the
// container from its client, so killing the client alone leaves the container
// (and its GPU/CPU work) running.
const activeChildren = new Set();
const activeContainers = new Set();
let pipelineCancelRequested = false;

function newContainerName(label) {
  const name = `nbd_${label}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  activeContainers.add(name);
  return name;
}

function cancelPipeline() {
  // The flag is set before the "is anything running" check, not after it.
  // Stop pressed in the gap between two stages - RFdiffusion's container has
  // exited, ProteinMPNN's hasn't spawned yet - finds nothing to kill, but the
  // next stage still has to refuse to start. Returning early without setting
  // the flag let the pipeline carry on as if Stop had never been pressed.
  pipelineCancelRequested = true;
  const wasRunning = activeChildren.size > 0 || activeContainers.size > 0;
  for (const name of activeContainers) {
    spawnSync("docker", ["kill", name], { timeout: 10000 });
  }
  activeContainers.clear();
  for (const child of activeChildren) child.kill("SIGTERM");
  activeChildren.clear();
  return wasRunning;
}

// Clears a pending cancel. Only a new pipeline run may do this: the flag is
// deliberately sticky between stages, so anything that clears it on the way
// past reopens the hole above. runProcess() used to clear it whenever no
// child was live, which is exactly the between-stages moment a Stop needs it
// to survive.
function resetPipelineCancel() {
  pipelineCancelRequested = false;
}

function runProcess(cmd, args, { cwd, source, env } = {}) {
  return new Promise((resolve, reject) => {
    // Honour a cancel that arrived before this stage got as far as spawning.
    if (pipelineCancelRequested) {
      sendLog("warn", `Not starting ${source}: stopped by user.`, source);
      reject(cancelledError());
      return;
    }
    sendLog("info", `$ ${cmd} ${args.join(" ")}`, source);
    const child = spawn(cmd, args, {
      cwd: cwd || ROOT,
      env: { ...process.env, ...(env || {}) },
    });
    activeChildren.add(child);

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
      activeChildren.delete(child);
      sendLog("error", `Failed to run process: ${err.message}`, source);
      reject(pipelineCancelRequested ? cancelledError() : err);
    });

    child.on("close", (code) => {
      activeChildren.delete(child);
      if (pipelineCancelRequested) {
        sendLog("warn", `Stopped by user (${source})`, source);
        reject(cancelledError());
        return;
      }
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
// Tracks the in-flight pull request so cancelDockerPull() can abort it from
// a separate IPC call - only one pull runs at a time in practice.
let activePullReq = null;
let pullCancelRequested = false;
let lastPullPercent = 0;

function cancelDockerPull() {
  if (!activePullReq) return false;
  pullCancelRequested = true;
  activePullReq.destroy();
  return true;
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

    pullCancelRequested = false;

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
              lastPullPercent = percent;
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
          activePullReq = null;
          if (sawError) reject(new Error(sawError));
          else resolve();
        });
        res.on("error", (e) => {
          activePullReq = null;
          reject(pullCancelRequested ? cancelledError() : e);
        });
      },
    );
    activePullReq = req;
    req.on("error", (e) => {
      activePullReq = null;
      reject(pullCancelRequested ? cancelledError() : e);
    });
    req.end();
  });
}

function cancelledError() {
  const e = new Error("Cancelled by user.");
  e.cancelled = true;
  return e;
}

// formatEta / formatMB / the downloader itself live in ./download.js so the
// completeness and redirect handling can be tested against a local server
// without booting Electron. This wrapper keeps the existing call signature and
// wires the module's callbacks to the Live Console.
function downloadFileWithProgress(url, destPath, stage, label) {
  return downloadFile({
    url,
    destPath,
    label,
    onProgress: (percent, message) =>
      sendProgress(stage, percent, "running", message),
    onLog: (text) => sendLog("info", text, stage),
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
  // opts.forceGpu bypasses the GPU_AVAILABLE gate for the pre-flight GPU
  // check itself (see detectGpu()) - that call's whole job is to *determine*
  // GPU_AVAILABLE, so gating it on GPU_AVAILABLE (still false at that point)
  // meant the in-container torch.cuda.is_available() check could never see
  // a real GPU, permanently reporting "not detected" on any host where the
  // host-level python3 check above it doesn't run (e.g. no system Python -
  // this app doesn't require one). Forcing --gpus all here is safe even on
  // GPU-less machines: `docker run --gpus all` just fails with a device-
  // driver error instead, which the caller's catch block already turns into
  // cudaAvailable: false the same as before.
  const gpuFlags =
    opts.forceGpu || GPU_AVAILABLE ? ["--gpus", "all"] : [];
  // `conda run` leaves the env's own lib dir off the loader path, so Ubuntu
  // 22.04's system libstdc++ (CXXABI up to 1.3.13) wins over the env's newer
  // one (1.3.17). conda-forge libs built against the newer ABI then fail to
  // load - e.g. libicui18n.so.78 - which silently sent CodonTransformer down
  // its fallback-table path instead of running the actual model.
  // HF_HOME keeps CodonTransformer's downloaded model under cache/ rather
  // than inside the container, where --rm throws it away every run.
  // TORCH_HOME does the same for DiscoTope's ESM-IF1 weights (torch.hub.
  // load_state_dict_from_url downloads there, progress bar disabled) -
  // without it every discotope run re-fetched several hundred MB from
  // dl.fbaipublicfiles.com from scratch, which is slow and silently looks
  // "stuck" on a slow connection since torch.hub was called with progress=False.
  const envFlags = [
    "-e",
    `LD_LIBRARY_PATH=/opt/conda/envs/${envName}/lib`,
    "-e",
    `HF_HOME=${DIRS.cacheHf}`,
    "-e",
    `TORCH_HOME=${DIRS.cacheTorch}`,
  ];
  // Mount ROOT at the same absolute path inside the container so every
  // caller's host-absolute paths (under ROOT/work, ROOT/cache, ROOT/python)
  // resolve unchanged - no path translation needed.
  const containerName = newContainerName(opts.source || envName);
  return runProcess(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      ...gpuFlags,
      ...envFlags,
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
  ).finally(() => activeContainers.delete(containerName));
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
  const containerName = newContainerName(source);
  return runProcess(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
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
  ).finally(() => activeContainers.delete(containerName));
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
    const res = await fetchWithRetry(url, undefined, {
      stage: "download-pdb",
      what: `RCSB PDB download for "${id}"`,
    });
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
    const res = await fetchWithRetry(url, undefined, {
      stage: "interpro",
      what: "InterPro API",
    });
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

ipcMain.handle("run-discotope", async (_evt, { chainAPath, pdbId, forceRefresh }) => {
  const id = (pdbId || "").trim().toUpperCase();
  const cacheFile = id
    ? path.join(DIRS.cacheDiscotope, `${id}.json`)
    : null;

  if (cacheFile && !forceRefresh) {
    const cached = readCacheJson(cacheFile);
    if (cached) {
      sendLog(
        "info",
        `DiscoTope-3.0 results for ${id} loaded from cache.`,
        "discotope",
      );
      sendProgress(
        "discotope",
        100,
        "done",
        `${cached.residues.length} residues loaded from cache`,
      );
      return { residues: cached.residues, fromCache: true };
    }
  }

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

    if (cacheFile) writeCacheJson(cacheFile, { residues });

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

// Stops whatever pipeline stage is running. The running stage's promise
// rejects with a cancelled error, so runPipeline() in the renderer stops
// instead of proceeding to the next stage.
ipcMain.handle("cancel-pipeline", async () => {
  // `cancelled` is now always true - the request is always recorded, even
  // with nothing live to kill. `wasRunning` says whether a stage was actually
  // interrupted, which is the only part the UI wording depends on.
  return { cancelled: true, wasRunning: cancelPipeline() };
});

// Starts a fresh pipeline run: the one place a pending cancel is cleared.
ipcMain.handle("begin-pipeline", async () => {
  resetPipelineCancel();
  return true;
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
// Surface-display anchors are *domain fragments*, not whole proteins. A
// UniProt entry gives the full-length native protein: P43261 is 934 aa of
// intimin, P0A910 is all 346 aa of OmpA including its own signal peptide and
// periplasmic domain. Fusing those whole entries produces a construct that is
// mostly passenger protein and that carries extra signal peptides mid-chain,
// so each anchor records the sub-range that is the published display
// scaffold - 143 aa for Lpp-OmpA and 660 for intimin, against 424 and 934 if
// the entries were taken whole.
//
// Ranges are 1-based inclusive in *UniProt* coordinates. The classic
// Lpp-OmpA hybrid (Francisco et al. 1992) and Int660 are defined in mature-
// protein numbering in the literature, so the signal-peptide offset is added
// here once, in `region`, rather than being re-derived at each call site.
const ANCHOR_DEFS = {
  "lpp-ompa": {
    label: "Lpp-OmpA (surface-display fusion)",
    // Lpp's own signal peptide is included, so this anchor is exported on its
    // own and must not have PelB prepended on top of it.
    hasNativeSignal: true,
    segments: [
      {
        name: "Lpp",
        primary: "P69776",
        region: [1, 29],
        regionNote:
          "signal peptide (1-20) + first 9 residues of mature Lpp (21-29)",
      },
      {
        name: "OmpA",
        primary: "P0A910",
        // Mature OmpA 46-159; the entry's signal peptide is 1-21, so mature
        // n maps to UniProt n+21. Signal peptide deliberately excluded - Lpp
        // upstream already supplies one.
        region: [67, 180],
        regionNote:
          "mature OmpA 46-159 (UniProt 67-180), the membrane-spanning region used for display",
      },
    ],
  },
  intimin: {
    label: "Intimin (EaeA), Int660",
    hasNativeSignal: true,
    segments: [
      {
        name: "Intimin",
        primary: "P43261",
        fallback: "A1DZE6",
        // Int660: signal peptide + LysM + β-barrel, truncated before the
        // C-terminal D3/lectin domain that binds Tir rather than displaying
        // a passenger.
        region: [1, 660],
        regionNote:
          "Int660 - N-terminal 660 residues (signal peptide, LysM and β-barrel), without the C-terminal D3 lectin domain",
      },
    ],
  },
};

// The PelB leader is a fixed 22-residue sequence, so it belongs with the other
// invariant parts of the insert (NdeI/XhoI, the His-tag, the GS linker) rather
// than behind a network fetch. It used to be fetched from UniProt Q04085 -
// which has since been *deleted* and now answers 200 with an empty body, so
// that path silently produced no PelB while the FASTA header still claimed one.
// Verified identical to the signal peptide annotated at residues 1-22 of
// P0C1C1 (PLY2_PECCA, Pectobacterium carotovorum pectate lyase), and to the
// leader encoded in the pET-22b(+) backbone.
const PELB_SIGNAL_PEPTIDE = {
  sequence: "MKYLLPTAAAGLLLLAAQPAMA",
  reference: "UniProt P0C1C1 residues 1-22 (signal peptide)",
};

async function fetchUniprotFasta(accession, stage = "anchor-fetch") {
  const res = await fetchWithRetry(
    `https://rest.uniprot.org/uniprotkb/${accession}.fasta`,
    undefined,
    { stage, what: `UniProt fetch (${accession})` },
  );
  if (!res.ok) throw new Error(`UniProt status ${res.status} for ${accession}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0];
  const sequence = lines.slice(1).join("");
  // A deleted entry still answers 200 - with an empty body (Q04085, the
  // accession this app used to fetch PelB from, was deleted from UniProt and
  // now returns zero bytes under a 200). Without this check that came back as
  // an empty sequence and quietly propagated as "no PelB" while the FASTA
  // header still advertised one.
  if (!sequence) {
    throw new Error(
      `UniProt returned an empty sequence for ${accession} - the entry has probably been deleted or merged.`,
    );
  }
  return { header, sequence, accession };
}

// Cuts the display domain out of a full-length UniProt sequence. A short
// entry means the accession's sequence isn't what the range was written
// against (entry revised, or the fallback accession is numbered differently),
// which has to surface as an error - silently returning a truncated anchor
// would ship a construct nobody can tell is wrong by looking at it.
function sliceRegion(sequence, region, what) {
  if (!region) return sequence;
  const [start, end] = region;
  if (sequence.length < end) {
    throw new Error(
      `${what}: UniProt sequence is ${sequence.length} aa but the display domain is defined as residues ${start}-${end}. ` +
        `The accession's sequence has probably changed - the range in ANCHOR_DEFS needs rechecking.`,
    );
  }
  return sequence.slice(start - 1, end);
}

// Fetches one segment and trims it to its display domain, falling back to the
// segment's alternate accession if the primary can't be reached.
async function fetchAnchorSegment(segment, stage) {
  let data;
  try {
    data = await fetchUniprotFasta(segment.primary, stage);
  } catch (e) {
    if (!segment.fallback) throw e;
    sendLog(
      "warn",
      `${segment.primary} failed (${e.message}), trying fallback ${segment.fallback}...`,
      stage,
    );
    data = await fetchUniprotFasta(segment.fallback, stage);
  }
  const fullLength = data.sequence.length;
  const sequence = sliceRegion(
    data.sequence,
    segment.region,
    `${segment.name} (${data.accession})`,
  );
  return {
    name: segment.name,
    accession: data.accession,
    header: data.header,
    sequence,
    fullLength,
    region: segment.region,
    regionNote: segment.regionNote,
    source: `https://rest.uniprot.org/uniprotkb/${data.accession}`,
  };
}

ipcMain.handle("fetch-anchor", async (_evt, { type, forceRefresh }) => {
  const def = ANCHOR_DEFS[type];
  if (!def) throw new Error(`Unknown anchor type: ${type}`);
  // Cache key is versioned: caches written before anchors were trimmed to
  // their display domains hold full-length sequences, and reusing one would
  // silently undo that trimming on any machine that had already fetched.
  const cacheFile = path.join(DIRS.cacheAnchors, `fetch_${type}_v2.json`);

  if (!forceRefresh) {
    const cached = readCacheJson(cacheFile);
    if (cached) return { ...cached, fromCache: true };
  }

  sendProgress(
    "anchor-fetch",
    20,
    "running",
    `Fetching ${def.label} sequence from UniProt...`,
  );

  let segments;
  try {
    segments = [];
    for (const segment of def.segments) {
      segments.push(await fetchAnchorSegment(segment, "anchor-fetch"));
    }
  } catch (e) {
    const cached = readCacheJson(cacheFile);
    if (cached) {
      sendLog(
        "warn",
        `Fetch failed (${e.message}), using stale cache.`,
        "anchor-fetch",
      );
      return { ...cached, fromCache: true };
    }
    sendProgress("anchor-fetch", 100, "error", e.message);
    throw e;
  }

  for (const s of segments) {
    sendLog(
      "info",
      `${s.name} (${s.accession}): using residues ${s.region[0]}-${s.region[1]} of ${s.fullLength} - ${s.regionNote}`,
      "anchor-fetch",
    );
  }

  const result = {
    type,
    label: def.label,
    hasNativeSignal: !!def.hasNativeSignal,
    sequence: segments.map((s) => s.sequence).join(""),
    header: segments.map((s) => s.header).join(" | "),
    source: segments.map((s) => s.source).join(" + "),
    segments: segments.map(({ name, accession, region, regionNote, sequence, fullLength }) => ({
      name,
      accession,
      region,
      regionNote,
      length: sequence.length,
      fullLength,
    })),
  };

  writeCacheJson(cacheFile, result);
  sendProgress(
    "anchor-fetch",
    100,
    "done",
    `${result.sequence.length} residues (display domain)`,
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
    pelbAminoAcidSeq = PELB_SIGNAL_PEPTIDE.sequence;
    sendLog(
      "info",
      `PelB signal peptide: ${pelbAminoAcidSeq.length} aa (${PELB_SIGNAL_PEPTIDE.reference}).`,
      "plasmid",
    );
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
      forceGpu: true,
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
  try {
    await withRetry(
      () => pullDockerImageWithProgress(settings.dockerImage, "install"),
      { stage: "install", what: "Docker image pull" },
    );
  } catch (e) {
    if (e.cancelled)
      sendProgress("install", lastPullPercent, "cancelled", e.message);
    throw e;
  }
  saveSettingsToDisk({ installMode: "docker" });
  sendProgress("install", 100, "done", "Docker image ready.");
  return getSettings();
});

ipcMain.handle("cancel-docker-pull", async () => {
  return { cancelled: cancelDockerPull() };
});

// Where the ~19GB pulled image actually lands - Docker's own managed
// storage, not anywhere under this app's folder (see the DockerRootDir
// discussion in chat: it isn't a plain browsable directory once Docker uses
// the containerd snapshotter, but the path is still useful context for the
// user to know it's not living inside this app's install location).
ipcMain.handle("get-docker-storage-info", async () => {
  const settings = getSettings();
  const res = spawnSync(
    "docker",
    ["info", "--format", "{{.DockerRootDir}}"],
    { encoding: "utf8", timeout: 10000 },
  );
  const dockerRootDir =
    !res.error && res.status === 0 ? res.stdout.trim() : null;
  return { dockerRootDir, dockerImage: settings.dockerImage };
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
