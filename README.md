# Nanobody Designer

A desktop GUI (Electron) for a nanobody design pipeline: **Target → Design → Screening → Construct**. It orchestrates RCSB PDB, InterPro, FreeSASA, DiscoTope-3.0, RFantibody (RFdiffusion/ProteinMPNN/RF2), PRODIGY, CodonTransformer, and UniProt behind a single UI, and writes a ready-to-order plasmid FASTA at the end.

This guide walks through installing everything from a clean machine.

## What you get without any extra setup

```bash
npm install
npm start
```

This alone gives you a fully working app for:

- **Target** tab — download a PDB, run InterPro, hotspot/epitope map, live 3D viewer (Mol\*).
- **Screening**, **Construct** tabs — filtering, composite score chart, manual metrics import, codon optimization (falls back to a static codon-usage table if CodonTransformer isn't installed), anchor construct + plasmid/FASTA export.
- Save/Load project, Live Console, Settings.

**FreeSASA** and **DiscoTope-3.0** (Target tab) and the whole **AI Design pipeline** — RFdiffusion / ProteinMPNN / RF2 (Design tab) — need external tools set up first (see below). The GUI for all of it is already there; it calls the real tools as soon as their paths are configured in Settings (⚙️ in the header).

## Prerequisites

| Requirement           | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OS**                | Linux (native or WSL2) is the primary target — RFantibody's own scripts are Linux+CUDA-only. macOS and Windows work too, via the exec modes below.                                                                                                                                                                                                                                             |
| **Node.js**           | v18 or newer (tested with v24). `npm` comes with it.                                                                                                                                                                                                                                                                                                                                           |
| **git**               | to clone this repo and (via the setup script) DiscoTope-3.0 and RFantibody.                                                                                                                                                                                                                                                                                                                    |
| **Internet access**   | `npm install` downloads Electron's ~200 MB binary; the setup script downloads Miniconda, clones two repos, and pulls RFantibody's model weights (several GB).                                                                                                                                                                                                                                  |
| **NVIDIA GPU + CUDA** | optional but strongly recommended. RFdiffusion, ProteinMPNN, RF2, and DiscoTope-3.0 all auto-fall back to CPU when no GPU is detected — the app runs and produces correct output either way — but RFdiffusion/RF2 specifically go from **seconds** on a GPU to **minutes** on CPU. The app shows a live time estimate before you run the pipeline (Design tab) so you know what you're in for. |

You do **not** need Python installed on your system directly — every external tool runs inside its own conda environment, managed by the setup script.

## 1. Clone and install the app

```bash
git clone https://github.com/rachmatthirdi/igem_nanobody.git
cd igem_nanobody
npm install
npm start
```

`npm start` should open the app window. Try the **Target** tab first (e.g. the `5M13` quick example) — it needs nothing beyond what you just installed.

## 2. Install the external tools

A setup script automates the heavy lifting: Miniconda, two conda environments, DiscoTope-3.0, and RFantibody. It is **not run automatically** — read it, then run it yourself when ready:

```bash
chmod +x scripts/setup_environment.sh
./scripts/setup_environment.sh
```

What it does, step by step:

1. Installs missing system packages (`git`, `curl`, `wget`, `unzip`, a C/C++ toolchain) via `apt` if available.
2. Installs **Miniconda** to `~/miniconda3` (skipped if `conda` is already on your `PATH`).
3. Creates the **`nanobody-tools`** conda env (Python 3.10) from `environment-tools.yml` — FreeSASA, PRODIGY, CodonTransformer, and their dependencies.
4. Creates the **`discotope`** conda env (Python 3.10 + PyTorch/CUDA 12.1) from `environment-discotope.yml`.
5. Clones [DiscoTope-3.0](https://github.com/Magnushhoie/DiscoTope-3.0) into `~/nanobody-designer-tools/DiscoTope-3.0` and installs it (plus its bundled model weights) into the `discotope` env.
6. Installs [`uv`](https://astral.sh/uv) (Astral's Python package manager, needed by RFantibody), clones [RFantibody](https://github.com/RosettaCommons/RFantibody) into `~/nanobody-designer-tools/RFantibody`, downloads its model weights, and runs `uv sync` to build its virtual environment.

Run it on whichever machine will actually execute these tools — see the platform notes below for where that should be.

This step takes a while (weight downloads alone are several GB) and is safe to re-run: each stage skips work that's already done.

## 3. Platform-specific notes

RFantibody's scripts are Linux+CUDA-oriented, so where you run `setup_environment.sh` depends on your OS:

- **Linux (native)** — just run the script directly on the host. The app auto-detects this and defaults its RFantibody execution mode to **Native**.
- **Windows** — install [WSL2](https://learn.microsoft.com/windows/wsl/install) with a GPU-capable distro (e.g. Ubuntu) and NVIDIA's WSL CUDA driver, then run `setup_environment.sh` **inside** that WSL2 distro. The app auto-detects Windows and defaults to **WSL2** execution mode, invoking RFantibody through `wsl.exe`.
- **Linux GUI running inside WSL2 (WSLg)** — if the app itself is launched from within WSL2 (not from Windows), it's already a Linux process, so it's treated the same as native Linux (**Native** mode, no `wsl.exe` bridging needed).
- **macOS** — there's no WSL and Docker Desktop for Mac has no NVIDIA GPU passthrough, so the only path is **Docker Desktop** with a Linux+CUDA-capable image, which will run RFdiffusion/RF2 CPU-only. The app defaults to **Docker** mode here; you'll need to build/pull an image with RFantibody installed and point Settings at it.

You can see what the app detected in the **System Monitor** sidebar ("Detected OS" / "Exec mode"), and override the exec mode manually in Settings if the default isn't right for your setup.

## 4. Point the app at what you installed

Open **Settings** (⚙️ in the header) and fill in:

| Field                         | What to put there                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Conda executable              | Usually just `conda` (already on `PATH` after the setup script)                   |
| Conda env (tools)             | `nanobody-tools`                                                                  |
| Conda env (DiscoTope-3.0)     | `discotope`                                                                       |
| DiscoTope-3.0 repository path | `~/nanobody-designer-tools/DiscoTope-3.0` (or wherever you cloned it)             |
| RFantibody installation path  | `~/nanobody-designer-tools/RFantibody`                                            |
| RFantibody execution mode     | Auto-detected (Native / WSL2 / Docker) — change only if it's wrong for your setup |
| WSL distro                    | Only used in WSL2 mode — the distro name running RFantibody                       |
| Docker image                  | Only used in Docker mode — the image name/tag with RFantibody installed           |

Settings are saved locally and persist across restarts; they're only used as defaults on first run.

## 5. Verify it worked

- **Target tab**: analyze a PDB ID (e.g. `1CRN`) — FreeSASA and DiscoTope-3.0 progress bars should complete instead of showing a warning.
- **Design tab**: with hotspots selected on the Target tab, set Backbone Number and MPNN Designs/backbone to `1` (fastest smoke test) and run the pipeline. Watch the live time estimate at the bottom of the card — it adjusts to whether a GPU was detected.
- A full 1-design run has been verified end-to-end in this exact repo on CPU only (no GPU): RFdiffusion (~10 min), ProteinMPNN (~1s), RF2 (~3 min), producing a real scored candidate that carried through Screening → Construct into a valid plasmid FASTA. GPU timing will be dramatically faster — the code path is identical either way, `torch.cuda.is_available()` decides automatically.

## Project structure

```text
electron/       main.js (IPC + subprocess orchestration, OS/WSL detection), preload.js
renderer/       index.html, css/, js/ (per-tab logic, live 3D viewer via pdbe-molstar/Mol*)
python/         FreeSASA, CAI, codon optimization, scoring, anchor/plasmid builder
scripts/        setup_environment.sh (Miniconda/DiscoTope/RFantibody install - run manually)
cache/          fetched PDB/InterPro/anchor data (offline-first)
projects/       saved projects (JSON)
output/         final FASTA ready for synthesis
work/           pipeline scratch files (created automatically)
```

## Troubleshooting

- **"GPU: not detected" banner** — informational, not a blocker. RFdiffusion/ProteinMPNN/RF2 still run on CPU, just slower; see the time estimate on the Design tab.
- **`conda: command not found`** after running the setup script — open a new shell (or `source ~/miniconda3/etc/profile.d/conda.sh`) so your `PATH` picks up the newly installed Miniconda.
- **RFantibody step fails to find `uv`** — same cause; `uv` installs to `~/.cargo/bin` or `~/.local/bin`, which needs to be on `PATH`.
- **Wrong execution mode detected** — override it manually in Settings; auto-detection is only a starting default.
