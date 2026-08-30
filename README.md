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

## Prerequisites

- **Node.js** — v18 or newer (tested with v24). `npm` comes with it.
- **git** — to clone this repo.
- **Docker** — Required for FreeSASA, DiscoTope-3.0,
  CodonTransformer/PRODIGY, and RFdiffusion/ProteinMPNN/RF2.
  [Install Docker](https://docs.docker.com/get-docker/) (Docker Desktop on
  macOS/Windows, Docker Engine on Linux) with the daemon running.
- **Internet access** — `npm install` downloads Electron's ~200 MB binary;
  the Docker build downloads Miniconda, clones DiscoTope-3.0/RFantibody,
  and pulls RFantibody's model weights (several GB) — a one-time cost
  cached in Docker's image layers.
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
everything runs inside the one Docker image, built once from
`docker/Dockerfile`.

## 1. Clone and install the app

```bash
git clone https://github.com/rachmatthirdi/igem_nanobody.git
cd igem_nanobody
npm install
npm start
```

`npm start` should open the app window. Try the **Target** tab first (e.g.
the `5M13` quick example) — it needs nothing beyond what you just
installed.

## 2. Build the Docker image

On first launch, the app detects whether Docker is available and shows an
**"Install external tools"** dialog with a single **Build Docker image**
button — no terminal required. It builds `docker/Dockerfile` (Miniconda +
both conda environments + DiscoTope-3.0 + RFantibody, all pinned),
streaming progress into the Live Console at the bottom of the window. If
Docker isn't found, the dialog links to Docker's install page instead;
"Skip for now" leaves the Target tab usable in the meantime.

You can re-run the build any time from Settings (⚙️) → **Re-run Docker
build** — useful after pulling repo updates that touch the Dockerfile.

Equivalent from a terminal:

```bash
docker build -f docker/Dockerfile -t nanobody-designer-tools .
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
   its model weights, and runs `uv sync` to build its virtual
   environment.

This takes a while the first time (weight downloads alone are several
GB); Docker's layer cache makes re-builds after small changes fast.

The base image is plain `ubuntu:22.04`, not `nvidia/cuda`: DiscoTope's
conda env pulls `pytorch-cuda` from the pytorch/nvidia channels, and
RFantibody's `uv sync` installs its own pip torch wheel — both bundle
their own CUDA runtime, so the container only needs the NVIDIA **driver**
passed through at `docker run` time, not a matching system CUDA toolkit
baked into the image.

## 3. Verify it worked

- **System Monitor** sidebar should show "Docker tools: ✓
  nanobody-designer-tools" once the build finishes.
- **Target tab**: analyze a PDB ID (e.g. `1CRN`) — FreeSASA and
  DiscoTope-3.0 progress bars should complete instead of showing a
  warning.
- **Design tab**: with hotspots selected on the Target tab, set Backbone
  Number and MPNN Designs/backbone to `1` (fastest smoke test) and run
  the pipeline.

## Settings

Open **Settings** (⚙️ in the header):

- **Docker image tag** — Defaults to `nanobody-designer-tools`; change
  only if you built/tagged the image under another name.

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
cache/          fetched PDB/InterPro/anchor data (offline-first)
projects/       saved projects (JSON)
output/         final FASTA ready for synthesis
work/           pipeline scratch files (created automatically)
```

## Troubleshooting

- **"The Docker image isn't built yet" error** on
  Target/Design/Screening/Construct actions — open Settings and click
  "Re-run Docker build" (or use the install prompt shown on first
  launch).
- **Docker build fails on `conda env create` with a Terms of Service
  error** — recent conda releases gate the `defaults` channels behind an
  explicit ToS acceptance; `docker/Dockerfile` already runs
  `conda tos accept` for both channels right after installing Miniconda,
  so this should only surface if you're building a modified Dockerfile
  that skips that step.
- **GPU not passed through inside Docker on Linux** — install
  [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  and confirm `docker run --rm --gpus all ubuntu nvidia-smi` works
  outside the app first.
