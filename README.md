# Nanobody Designer

A desktop GUI (Electron) for a nanobody design pipeline: **Target → Design →
Screening → Construct**. It orchestrates RCSB PDB, InterPro, FreeSASA,
DiscoTope-3.0, RFantibody (RFdiffusion/ProteinMPNN/RF2), PRODIGY,
CodonTransformer, and UniProt behind a single UI, and writes a
ready-to-order plasmid FASTA at the end.

This guide walks through installing everything from a clean machine.

## What you get without any extra setup

```bash
npm install
npm start
```

- **Target** tab — download a PDB, run InterPro, hotspot/epitope map, live
  3D viewer (Mol\*).
- **Screening**, **Construct** tabs (browsing/UI only until Docker is set
  up) — filtering, composite score chart, manual metrics import.
- Save/Load project, Live Console, Settings.

**FreeSASA**, **DiscoTope-3.0** (Target tab), **CodonTransformer/PRODIGY**
(Screening/Construct), and the whole **AI Design pipeline** — RFdiffusion /
ProteinMPNN / RF2 (Design tab) — require Docker (see below). There's no
native/conda fallback: Docker is what pins every one of these tools to
exact, tested versions instead of letting each machine's own conda/pip
solve drift out from under you.

RF2's weights specifically aren't in the Docker image (its license doesn't
allow redistributing them - see [Settings](#settings)); the app downloads
that one file itself (~281 MB) the first time you run the Design pipeline,
straight from the official source. Everything else needed for the AI
Design pipeline is already in the image.

## Prerequisites

- **Node.js** — v18 or newer (tested with v24). `npm` comes with it.
- **git** — to clone this repo.
- **Docker** — Required for FreeSASA, DiscoTope-3.0,
  CodonTransformer/PRODIGY, and RFdiffusion/ProteinMPNN/RF2.
  [Install Docker](https://docs.docker.com/get-docker/) (Docker Desktop on
  macOS/Windows, Docker Engine on Linux) with the daemon running. See
  [Docker setup per OS](#docker-setup-per-os) — the pull itself is identical
  everywhere, but what it takes to have a reachable daemon is not.
- **A supported host** — Linux, WSL2 and macOS are the paths documented here.
  Windows support is being added separately (see `docs/PLATFORM_NOTES.md` on
  the `afif/add-windows-support` branch); on this branch a Windows host has no
  path translation, so the mount check below reports the failure instead of
  the app breaking further in. Whichever host you use, the project path must
  not contain a `:` — `docker run -v src:dst` splits on colons.
- **A working bind mount** — the app verifies once per launch that the project
  directory really round-trips into a container, since a mount that is
  accepted but not shared makes every tool "succeed" while writing into the
  container, where `--rm` discards it.
- **Internet access** — `npm install` downloads Electron's ~200 MB binary;
  getting the tools image downloads ~19 GB from Docker Hub (one-time,
  cached locally after that), plus a ~281 MB RF2 weight file on first
  Design pipeline run.
- **NVIDIA GPU + CUDA** — optional but strongly recommended, plus
  [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  on Linux for GPU passthrough into the container. RFdiffusion,
  ProteinMPNN, RF2, and DiscoTope-3.0 all auto-fall back to CPU when no
  GPU is detected — the app runs and produces correct output either way —
  but RFdiffusion/RF2 specifically go from **seconds** on a GPU to
  **minutes** on CPU. The app only passes `--gpus all` to Docker when it
  detects a GPU, so CPU-only machines need no extra setup. Docker Desktop
  on macOS/Windows has no NVIDIA passthrough, so RFdiffusion/RF2 run
  CPU-only there.

You do **not** need Python or conda installed on your system directly —
everything runs inside the one Docker image, downloaded once from Docker
Hub (or built locally from `docker/Dockerfile`, if you prefer).

## 1. Clone and install the app

```bash
git clone https://github.com/rachmatthirdi/igem_nanobody.git
cd igem_nanobody
npm install
npm start
```

`npm start` should open the app window. Try the **Target** tab first (e.g.
the `1ZVH` quick example) — it needs nothing beyond what you just
installed.

## 2. Get the tools image

On first launch, the app detects whether Docker is available and shows an
**"Install external tools"** dialog with a **Download tools image**
button — no terminal required. It pulls the pre-built image from Docker
Hub (`rachmatthirdi/igem_brawijaya`), streaming progress (with a real
byte-level percentage and time estimate) into the Live Console. If Docker
isn't found, the dialog links to Docker's install page instead; "Skip for
now" leaves the Target tab usable in the meantime.

You can re-run this any time from Settings (⚙️) → **Download tools
image**.

Equivalent from a terminal:

```bash
docker pull rachmatthirdi/igem_brawijaya:latest
```

**The same image everywhere.** The registry holds a single manifest, so the
bytes pulled are identical on Ubuntu, WSL and macOS, and identical whether or
not the machine has a GPU — there is no CPU-only variant to choose. CUDA
changes nothing about the pull or where the image is stored; it only decides
whether `--gpus all` is added at `docker run` time. A CPU-only machine still
downloads the CUDA-enabled PyTorch builds inside the image and simply doesn't
use them.

**Finding the daemon.** The app pulls over the Docker Engine API to get real
byte-level progress, and works out where the daemon listens rather than
assuming: `DOCKER_HOST` first, then the active `docker context`, then the
usual per-platform locations (`/var/run/docker.sock`, the rootless socket
under `$XDG_RUNTIME_DIR`, Docker Desktop for Linux's socket under `~/.docker/`,
and the `\\.\pipe\docker_engine` named pipe on Windows). If none of those
can be reached — an `ssh://` context, or a TLS-protected TCP daemon — it falls
back to running `docker pull` itself, which reports progress per layer instead
of per byte but works anywhere the CLI does.

### Docker setup per OS

The pull is byte-identical on every OS and on GPU and non-GPU machines
alike (single manifest, no variants). What differs is only what it takes
for a daemon to be reachable at all — which is where every failure this
project has actually seen came from.

**Ubuntu / Linux (native)** — install Docker Engine, then add yourself to
the `docker` group and **log out and back in**:

```bash
sudo usermod -aG docker "$USER"
```

The group change does not apply to your current session, so `docker` can
be installed and still fail with `permission denied` until you do. For
GPU, also install
[nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

**WSL2** — run the app **inside** the WSL shell, not from Windows. Then
either:

- enable Docker Desktop → Settings → Resources → **WSL Integration** for
  that distro (the socket inside the distro is then a proxy to Docker
  Desktop's daemon), or
- install Docker Engine inside the distro itself.

If you install Docker Engine inside WSL, note that **WSL has no systemd by
default**, so `sudo systemctl start docker` fails and the daemon does not
start on its own. Use `sudo service docker start`, and repeat it each time
the distro restarts. A daemon that was never started is the most common
cause of `connect ENOENT /var/run/docker.sock`.

For GPU in WSL, install **only the Windows NVIDIA driver** — WSL passes it
through automatically. Do not install a Linux driver inside the distro.

**macOS** — Docker Desktop, and add the project's directory under Settings
→ Resources → **File Sharing**, otherwise the bind mount is not really
shared and tools write into the container instead of onto your disk. No
NVIDIA passthrough exists, so everything runs on CPU.

**Windows (native)** — not covered by the steps on this branch; use WSL2 for
now. Windows support (mounting the project at a fixed container path and
translating paths) is in progress separately.

### Building from source instead

If you've modified `docker/Dockerfile` yourself, or would rather build
from source than trust a prebuilt image, Settings also has a **Build from
source instead** link, or from a terminal:

```bash
docker build -f docker/Dockerfile -t rachmatthirdi/igem_brawijaya:latest .
```

What it does, step by step:

1. Installs system packages (`git`, `curl`, `wget`, `unzip`, a C/C++
   toolchain).
2. Installs **Miniconda**.
3. Creates the **`nanobody-tools`** conda env (Python 3.10) from
   `environment-tools.yml` — FreeSASA, PRODIGY, CodonTransformer, and
   their dependencies.
4. Creates the **`discotope`** conda env (Python 3.11 + PyTorch/CUDA 12.1)
   from `environment-discotope.yml`.
5. Clones [DiscoTope-3.0](https://github.com/Magnushhoie/DiscoTope-3.0)
   and installs it (plus its bundled model weights) into the `discotope`
   env.
6. Installs [`uv`](https://astral.sh/uv) (Astral's Python package
   manager, needed by RFantibody), clones
   [RFantibody](https://github.com/RosettaCommons/RFantibody), downloads
   RFdiffusion's and ProteinMPNN's model weights, and runs `uv sync` to
   build its virtual environment. **RF2's weights are deliberately not
   downloaded here** — see below.

This takes a while the first time (weight downloads alone are several
GB); Docker's layer cache makes re-builds after small changes fast.

The base image is plain `ubuntu:22.04`, not `nvidia/cuda`: DiscoTope's
conda env pulls `pytorch-cuda` from the pytorch/nvidia channels, and
RFantibody's `uv sync` installs its own pip torch wheel — both bundle
their own CUDA runtime, so the container only needs the NVIDIA **driver**
passed through at `docker run` time, not a matching system CUDA toolkit
baked into the image.

### Why RF2's weights aren't in the image

RFdiffusion's and ProteinMPNN's weights are BSD/MIT-licensed and fine to
redistribute. RF2 (RoseTTAFold2)'s antibody-finetuned weights
(`RF2_ab.pt`), however, are licensed under the
[Rosetta-DL Non-Commercial license](https://github.com/RosettaCommons/Rosetta-DL/blob/main/LICENSE.md),
which forbids the software being "published, distributed, or otherwise
transferred" outside the licensee's own institution — so it can't be
baked into an image published to a public registry, even for
non-commercial use. Each install fetches its own copy instead, directly
from the same official University of Washington server the Dockerfile
uses for the others, the first time you run the Design pipeline. It's
cached after that and bind-mounted into the container automatically -
nothing to configure.

## 3. Verify it worked

- **System Monitor** sidebar should show "Docker tools: ✓
  rachmatthirdi/igem_brawijaya" once the download finishes.
- **Target tab**: analyze a PDB ID (e.g. `1CRN`) — FreeSASA and
  DiscoTope-3.0 progress bars should complete instead of showing a
  warning.
- **Design tab**: with hotspots selected on the Target tab, set Backbone
  Number and MPNN Designs/backbone to `1` (fastest smoke test) and run
  the pipeline.

## Manual installation (no Docker)

Docker is the tested, recommended path above — it pins every tool to exact
versions instead of whatever conda/pip resolves on your machine. If you'd
rather install everything natively yourself (e.g. to avoid the ~19 GB image
download, or to inspect/debug the tools directly), this section walks
through the same steps [docker/Dockerfile](docker/Dockerfile) runs,
adapted per OS.

**Heads up:** the Electron app's Screening/Design/Construct tabs currently
only launch tools through Docker (`electron/main.js` has no native
execution path yet). A manual install lets you run
FreeSASA/DiscoTope-3.0/RFantibody yourself from a terminal, but won't make
those app tabs work without Docker unless the app is also changed to call
your local conda envs instead. The **Target** tab needs neither Docker nor
this section.

Pick your OS below. WSL follows the Ubuntu steps almost exactly; macOS has
real differences (no CUDA, and RFantibody/RFdiffusion are primarily tested
on Linux+NVIDIA) called out explicitly.

### Ubuntu / Linux

#### 1. System packages

```bash
sudo apt-get update
sudo apt-get install -y git curl wget unzip build-essential
```

#### 2. Miniconda

```bash
curl -fsSL -o /tmp/miniconda.sh \
  https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash /tmp/miniconda.sh -b -p "$HOME/miniconda3"
source "$HOME/miniconda3/etc/profile.d/conda.sh"
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r
```

#### 3. The two conda envs

```bash
cd ~/igem_nanobody   # wherever you cloned this repo
conda env create -f environment-tools.yml
conda env create -f environment-discotope.yml
```

#### 4. DiscoTope-3.0

```bash
mkdir -p ~/tools && cd ~/tools
git clone --depth 1 https://github.com/Magnushhoie/DiscoTope-3.0.git
cd DiscoTope-3.0 && unzip -o models.zip
conda run -n discotope pip install --no-cache-dir -r requirements.txt
conda run -n discotope pip install --no-cache-dir -e .
```

#### 5. uv + RFantibody (RFdiffusion / ProteinMPNN / RF2)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

cd ~/tools
git clone --depth 1 https://github.com/RosettaCommons/RFantibody.git
cd RFantibody && mkdir -p weights && cd weights

curl -fSL --retry 10 --retry-delay 15 -o RFdiffusion_Ab.pt \
  https://files.ipd.uw.edu/pub/RFantibody/RFdiffusion_Ab.pt
curl -fSL --retry 10 --retry-delay 15 -o ProteinMPNN_v48_noise_0.2.pt \
  https://files.ipd.uw.edu/pub/RFantibody/ProteinMPNN_v48_noise_0.2.pt
curl -fSL --retry 10 --retry-delay 15 \
  -o RFab_noframework-nosidechains-5-10-23_trainingparamsadded.pt \
  "https://zenodo.org/records/17488258/files/RFab_noframework-nosidechains-5-10-23_trainingparamsadded.pt?download=1"

cd ~/tools/RFantibody
uv sync
```

#### 6. RF2 weights

```bash
mkdir -p ~/igem_nanobody/cache/weights
curl -fSL --retry 10 --retry-delay 15 \
  -o ~/igem_nanobody/cache/weights/RF2_ab.pt \
  https://files.ipd.uw.edu/pub/RFantibody/RF2_ab.pt
```

#### 7. Run the app

```bash
cd ~/igem_nanobody
npm install
npm start
```

### WSL (Windows Subsystem for Linux)

WSL runs a real Ubuntu userspace, so the steps are the **Ubuntu / Linux
section above, run inside your WSL shell**, plus:

1. Install WSL2 and an Ubuntu distro from **Windows PowerShell** (not
   inside WSL):

   ```powershell
   wsl --install -d Ubuntu-22.04
   ```

2. Open the new Ubuntu terminal and follow the whole **Ubuntu / Linux**
   section above inside it — same commands, same paths, nothing
   WSL-specific in that part.
3. **GPU (optional):** install only the regular Windows NVIDIA driver
   (from nvidia.com) — do *not* install a separate Linux driver inside
   WSL, it isn't needed and can conflict. WSL passes the Windows driver
   through automatically. Verify from inside WSL with:

   ```bash
   nvidia-smi
   ```

4. **Running the Electron app's window:** on Windows 11, WSLg forwards
   Linux GUI apps to your desktop automatically — `npm start` just works.
   On Windows 10, you need a separate X server (e.g. VcXsrv) and
   `DISPLAY` set manually.

### macOS

macOS has no NVIDIA GPU, so everything here runs CPU-only — RFdiffusion/RF2
in particular will be much slower than on a CUDA machine (this matches
what this README already says about Docker Desktop on macOS). More
importantly, **RFdiffusion/RFantibody are research code primarily built
and tested on Linux+CUDA** — installing them natively on macOS is not
verified to work; treat this path as experimental and expect to debug
dependency issues that don't come up on Linux.

#### 1. Prerequisites

```bash
xcode-select --install   # Xcode command line tools (git, clang, etc.)
```

**2. Miniconda** — pick the installer for your chip:

```bash
# Apple Silicon (M1/M2/M3/M4)
curl -fsSL -o /tmp/miniconda.sh \
  https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh
# Intel Mac
curl -fsSL -o /tmp/miniconda.sh \
  https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh

bash /tmp/miniconda.sh -b -p "$HOME/miniconda3"
source "$HOME/miniconda3/etc/profile.d/conda.sh"
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r
```

**3. `nanobody-tools` env** — no CUDA dependency, installs as-is:

```bash
cd ~/igem_nanobody
conda env create -f environment-tools.yml
```

**4. `discotope` env** — `environment-discotope.yml` pins
`pytorch-cuda=12.1`, which doesn't exist on macOS. Create it manually
instead, without the `nvidia` channel or the `pytorch-cuda` package:

```bash
conda create -n discotope -c pytorch -c conda-forge \
  python=3.11 pytorch numpy pandas pip -y
```

**5. DiscoTope-3.0, uv/RFantibody, RF2 weights** — same commands as the
**Ubuntu / Linux** section, steps 4–6. If RFantibody's `uv sync` fails on
a native macOS dependency, that's the expected risk mentioned above —
there's currently no macOS-tested fallback for it in this repo.

#### 6. Run the app

```bash
cd ~/igem_nanobody
npm install
npm start
```

## Settings

Open **Settings** (⚙️ in the header):

- **Docker image tag** — Defaults to `rachmatthirdi/igem_brawijaya:latest`;
  change only if you built/tagged the image under another name.
- **GPU detection** — Auto-detect (default), or force GPU on/off manually
  if auto-detection gets it wrong. A **Test GPU access** button in the
  same section actually runs a small `docker --gpus all` container to
  verify Docker can really reach your GPU, rather than just trusting the
  override.

Settings are saved locally and persist across restarts.

## Project structure

```text
electron/       main.js (IPC + subprocess orchestration, Docker
                detection/build), preload.js
renderer/       index.html, css/, js/ (per-tab logic, live 3D viewer via
                pdbe-molstar/Mol*)
python/         FreeSASA, CAI, codon optimization, scoring, anchor/plasmid
                builder (run inside Docker)
docker/         Dockerfile (combined tools image: conda envs +
                DiscoTope-3.0 + RFantibody)
cache/          fetched PDB/InterPro/anchor data (offline-first), plus
                weights/ (RF2_ab.pt, downloaded on first Design tab run),
                hf/ + torch/ (model caches) and home/ (HOME for container runs)
projects/       saved projects (JSON)
output/         final FASTA ready for synthesis
work/           pipeline scratch files (created automatically)
```

## Troubleshooting

- **"The Docker image isn't built yet" error** on
  Target/Design/Screening/Construct actions — open Settings and click
  "Download tools image" (or use the install prompt shown on first
  launch).
- **Docker pull fails or is slow** — Docker Hub itself is generally
  reliable, but if it fails partway, just click "Download tools image"
  again; Docker resumes from whichever layers already finished.
- **RF2 weight download fails on first Design run** — it's fetched
  directly from a University of Washington file server
  (`files.ipd.uw.edu`), which occasionally has brief outages. Just retry
  the pipeline. Each attempt restarts the download from the beginning
  (there's no resume), but the finished size is checked against the
  server's `Content-Length` before the file is moved into place, so a
  connection that drops partway is discarded rather than leaving a
  truncated weight file the app would treat as already downloaded.
- **Docker build fails on `conda env create` with a Terms of Service
  error** (only applies if building from source) — recent conda releases
  gate the `defaults` channels behind an explicit ToS acceptance;
  `docker/Dockerfile` already runs `conda tos accept` for both channels
  right after installing Miniconda, so this should only surface if you're
  building a modified Dockerfile that skips that step.
- **`connect ENOENT /var/run/docker.sock` when pulling** — nothing is
  listening at that socket. On WSL, the usual cause is that the daemon was
  never started (`sudo service docker start`) or that Docker Desktop's WSL
  Integration isn't enabled for the distro. The app finds the daemon
  dynamically (`DOCKER_HOST`, then the active `docker context`, then the
  per-platform defaults), so a socket in a non-standard location is handled —
  but no amount of searching helps if the daemon isn't running. Confirm with
  `docker context ls` and `ls -l /var/run/docker.sock`.
- **Docker daemon won't start after installing CUDA support** — if
  `/etc/docker/daemon.json` sets `"default-runtime": "nvidia"` and
  `nvidia-container-runtime` isn't working, `dockerd` refuses to start
  *entirely*, not just for GPU containers. The socket is then never created
  and every pull fails with `ENOENT`, which looks like a network problem but
  isn't. Run `sudo dockerd` in a terminal to see the real reason, and remove
  the `default-runtime` line to confirm. This is why "disabling CUDA" can
  make a pull start working — the pull never involved the GPU, the daemon did.
- **The install banner says Docker is unavailable** — the banner now names
  which of the three cases it is. "Not installed" means what it says.
  "Daemon isn't running" needs Docker Desktop started, or
  `sudo systemctl start docker` on Linux. "Permission denied" is the usual
  first-install slip on Linux: `sudo usermod -aG docker $USER`, then **log
  out and back in** — the group change doesn't apply to your existing
  session, which is why `docker` can be installed and still unreachable.
- **"produced no readable output" / "doesn't exist on the host"** — the
  container ran and reported success, but the host can't see the file it
  wrote, which means the project directory isn't really shared into the
  container. On macOS/Windows, add the project's parent directory under
  Docker Desktop → Settings → Resources → File Sharing. This used to fail
  silently: the run looked successful and the Live Console printed a
  plausible path for a file that had already been discarded with the
  container.
- **Output files owned by `root` (Linux)** — shouldn't happen any more: on
  Linux the app passes `--user <your uid>:<your gid>` to `docker run`, so
  files the container writes under `output/`, `work/` and `cache/` belong to
  you. The one exception is the RFantibody stages (RFdiffusion/ProteinMPNN/
  RF2), which must stay root because `uv` lives in `/root/.local/bin` and
  `/root` is mode 700 inside the image; those runs hand ownership back with
  a `chown` straight afterwards, including when they fail or you cancel
  them. Leftovers from an install that predates this are reclaimed once,
  automatically, before the first container command. If you still hit a
  root-owned file, `sudo chown -R "$USER:$USER" cache work output` clears it.
- **GPU not passed through inside Docker on Linux** — install
  [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
  then use Settings → **Test GPU access** to confirm Docker can reach it
  (this runs `docker run --rm --gpus all ubuntu:22.04 nvidia-smi` for
  you). If your GPU is real but still not detected, use the **GPU
  detection** override in Settings to force it on.
