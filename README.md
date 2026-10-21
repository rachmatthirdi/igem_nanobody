# CATCHERs Generator

CATCHERs Generator is the desktop app (Electron) from **CATCHERs**
(Computationally Assisted Target-specific Cell-based Host Engineered
Recognitions), an iGEM project. It takes you from a target protein to a
synthesis-ready nanobody insert, in four steps:

Target → Design → Screening → Construct

It puts RCSB PDB, InterPro, FreeSASA, DiscoTope-3.0, RFantibody
(RFdiffusion, ProteinMPNN, RF2), PRODIGY, CodonTransformer and UniProt behind
one interface, with a live console that shows exactly what each tool is doing.

- [What each step does](#what-each-step-does)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Install the tools image](#install-the-tools-image)
- [Verify the install](#verify-the-install)
- [Settings](#settings)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Known issues](#known-issues)
- [Appendix: install without Docker](#appendix-install-without-docker)

#### Try It Online

You can try CATCHERs Generator using our hosted deployment:

**https://igem-brawijaya.ub.ac.id/**

Alternatively, you can install and run the application locally.



## What each step does

<!-- markdownlint-disable MD013 -->
| Step | What you do | What runs | Needs Docker |
| --- | --- | --- | --- |
| **Target** | Enter a PDB ID (e.g. `1ZVH`), inspect the structure, and pick hotspot residues on the SASA / DiscoTope tracks or in the 3D viewer | RCSB download, InterPro domains, FreeSASA, DiscoTope-3.0, Mol\* viewer | Only for FreeSASA and DiscoTope |
| **Design** | Choose the scaffold, CDR loop lengths (H1/H2/H3), number of backbones and sequences per backbone, then run | RFdiffusion → ProteinMPNN → RF2, then scoring (pLDDT, PAE, CDR/H3 RMSD, PRODIGY ΔG) | Yes |
| **Screening** | Filter and rank candidates by composite score, inspect each structure, select up to 3 | Scoring chart, filters, manual metrics import (`.json`, `.csv`, `.sc`) | No (re-scoring needs Docker) |
| **Construct** | Optimize codons, pick a display anchor (Lpp-OmpA or intimin Int660), choose a vector, build the insert | CodonTransformer (E. coli table fallback), UniProt anchor fetch, restriction-site screening | Yes |
<!-- markdownlint-enable MD013 -->

The final output is a FASTA in `output/`: an **NdeI → [PelB] → anchor →
GGGGS×3 linker → nanobody → His-tag → stop → XhoI** insert, labeled for
pET-28a(+) or pET-22b(+). It contains the insert only, not the vector
backbone. Internal NdeI/XhoI sites are removed by synonymous codon
substitution, and any that can't be removed are reported.

Projects can be saved and reopened from the header, and the design results
are auto-saved when a run finishes.

## Quick start

```bash
git clone https://github.com/rachmatthirdi/igem_nanobody.git
cd igem_nanobody
npm install
npm start
```

`npm install` downloads Electron (~200 MB). When the window opens, try the
**Target** tab with one of the quick examples (e.g. `1ZVH`): PDB download,
InterPro domains, the hotspot map and the 3D viewer work with nothing else
installed.

FreeSASA, DiscoTope-3.0, the whole Design pipeline, scoring and codon
optimization run inside Docker. On first launch the app offers a one-click
download (see [Install the tools image](#install-the-tools-image)).

## Requirements

<!-- markdownlint-disable MD013 -->
| Requirement | Notes |
| --- | --- |
| **Node.js** 18 or newer | Tested with v24. `npm` is included. |
| **git** | To clone this repo. |
| **Docker** | Docker Desktop (macOS/Windows) or Docker Engine (Linux); OrbStack and Colima also work. Installing it is not enough: **start it before you launch the app** and wait until it reports running, because the app talks to the running daemon. Needed for everything except the basic Target tab features. |
| **A supported host** | Linux, WSL2, macOS and Windows. The project folder is mounted at one fixed path inside the container (`/nbroot`) on every host, and paths are translated in and out, so the app follows whatever path your project lives at: `/home/you/igem`, `D:\work\igem`, anything. The one restriction is that the path must not contain a `:`, since `docker run -v src:dst` splits on colons. The app checks this at startup and says so. |
| **A shared project folder** | Once per launch the app checks that the project folder really round-trips into a container. A mount that is accepted but not shared makes every tool "succeed" while writing into the container, where `--rm` discards it. **On macOS and Windows,** add the project folder under Docker Desktop → Settings → Resources → File Sharing. |
| **Internet** | One-time downloads: Electron (~200 MB), the tools image (~19 GB compressed), and the RF2 weights (~281 MB, on the first Design run). |
| **Disk space** | The tools image is ~19 GB to download but about **53 GB on disk** once extracted. The app checks the free space where Docker stores its data before it starts the download. |
| **NVIDIA GPU** (optional) | Strongly recommended for Design. See below. |
<!-- markdownlint-enable MD013 -->

You do **not** need Python or conda on your machine. They live inside the
Docker image.

### GPU

RFdiffusion, ProteinMPNN, RF2 and DiscoTope-3.0 all fall back to CPU when no
GPU is detected, and produce correct output either way. The difference is
speed: RFdiffusion and RF2 take **seconds** per unit on a GPU and
**minutes** on CPU. The Design tab shows an estimate for your current settings.

- **Linux:** install the
  [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  so Docker can see the GPU.
- **Windows:** Docker Desktop with the WSL2 backend can pass an NVIDIA GPU
  through. This was verified on an RTX 3050 Laptop GPU (4 GB).
- **macOS:** there is no NVIDIA passthrough, so everything runs on CPU.

The app only passes `--gpus all` to Docker when it detects a GPU, so
CPU-only machines need no extra setup. 4 GB of VRAM ran the Design pipeline
with minimal settings (2 backbones, 1 sequence each); larger runs and larger
targets will need more. We haven't measured the limit.

## Install the tools image

On first launch, the app checks for Docker and shows an **Install the
design tools** card with a **Download tools image** button. It pulls
`rachmatthirdi/igem_brawijaya` from Docker Hub with real byte-level progress
and a time estimate in the Live Console. Re-run it any time from
**Settings → Download tools image**.

If Docker isn't found, the card says so, and tells a missing install apart
from one that is installed but not running. Click **Later** to keep using the
Target tab in the meantime.

From a terminal, the equivalent is:

```bash
docker pull rachmatthirdi/igem_brawijaya:latest
```

### Build from source instead

If you've changed `docker/Dockerfile`, or would rather not trust a prebuilt
image, use **Settings → Build from source instead**, or:

```bash
docker build -f docker/Dockerfile -t rachmatthirdi/igem_brawijaya:latest .
```

This takes 20-30 minutes the first time; Docker's layer cache makes later
rebuilds fast. The Dockerfile:

1. Installs system packages and **Miniconda**.
2. Creates the **`nanobody-tools`** conda env (Python 3.10, from
   `environment-tools.yml`): FreeSASA, PRODIGY, CodonTransformer and their
   dependencies, all version-pinned.
3. Creates the **`discotope`** conda env (Python 3.11, PyTorch, CUDA 12.1,
   from `environment-discotope.yml`).
4. Clones [DiscoTope-3.0](https://github.com/Magnushhoie/DiscoTope-3.0) and
   installs it, with its bundled model weights, into the `discotope` env.
5. Installs [`uv`](https://astral.sh/uv), clones
   [RFantibody](https://github.com/RosettaCommons/RFantibody), downloads the
   RFdiffusion and ProteinMPNN weights, and builds its environment with
   `uv sync`.

The base image is plain `ubuntu:22.04`, not `nvidia/cuda`. Both PyTorch
installs bundle their own CUDA runtime, so the container only needs the
NVIDIA **driver** passed through at `docker run` time.

> **Reproducibility:** the conda environments are pinned to exact versions.
> The DiscoTope-3.0 and RFantibody checkouts, Miniconda and `uv` are fetched
> at their latest version when the image is built.

### Why the RF2 weights aren't in the image

RFdiffusion's and ProteinMPNN's weights are BSD/MIT-licensed and fine to
redistribute. RF2's antibody-finetuned weights (`RF2_ab.pt`) are licensed
under the
[Rosetta-DL Non-Commercial license](https://github.com/RosettaCommons/Rosetta-DL/blob/main/LICENSE.md),
which forbids the software being "published, distributed, or otherwise
transferred" outside the licensee's own institution. They can't go into an
image on a public registry, even for non-commercial use.

Instead, each install downloads its own copy from the official University of
Washington server the first time you run the Design pipeline. The file is
cached in `cache/weights/` and mounted into the container automatically.
There's nothing to configure.

## Verify the install

- The **Install the design tools** card disappears once the download
  finishes. **Settings → Tools image** shows where Docker stored it.
- **Settings → Diagnostics → Test GPU access** runs a small
  `docker run --gpus all` container to confirm Docker can reach your GPU.
- **Target tab:** analyze `1CRN`. The FreeSASA and DiscoTope-3.0 progress
  bars should complete instead of showing a warning.
- **Design tab:** with hotspots selected on the Target tab, set *Backbone
  number* and *MPNN designs per backbone* to `1` and run the pipeline. This is
  the fastest end-to-end smoke test.

## Settings

Open **Settings** (the gear icon in the header). Settings persist across
restarts.

<!-- markdownlint-disable MD013 -->
| Setting | Default | Notes |
| --- | --- | --- |
| **Tools image name** | `rachmatthirdi/igem_brawijaya:latest` | Change only if you built or tagged the image under another name. |
| **GPU detection** | Auto-detect | Force GPU on or off if auto-detection gets it wrong. **Test GPU access** checks that Docker can really reach the GPU, rather than trusting the override. |
<!-- markdownlint-enable MD013 -->

## Project structure

```text
electron/    main.js (IPC, Docker orchestration), download.js (file downloader
             with redirect handling and a size check), preload.js
renderer/    index.html, css/, js/ (one module per tab, plus shared state,
             console, glossary, onboarding, error messages, and the Mol* viewer)
python/      Scripts that run inside Docker: FreeSASA, candidate scoring,
             codon optimization and CAI, anchor + plasmid assembly,
             restriction-site removal
docker/      Dockerfile for the combined tools image
docs/        PLATFORM_NOTES.md (platform test results, draft)
environment-tools.yml, environment-discotope.yml   conda environments
```

These folders are created at runtime and are git-ignored:

```text
cache/       fetched PDB / InterPro / DiscoTope / anchor data (offline-first),
             plus weights/ (RF2_ab.pt) and the HuggingFace and torch caches
projects/    saved projects (JSON)
output/      final FASTA files
work/        scratch files for the pipeline
```

## Troubleshooting

- **"Docker is installed, but it isn't running":** start Docker Desktop,
  OrbStack or Colima, wait until it reports running (`docker info` should print
  a `Server:` section), then reopen the app. The check runs once at launch, so
  starting Docker afterwards needs a restart of the app.
- **"The design tools aren't installed yet"** on a Target, Design, Screening
  or Construct action: open Settings and click **Download tools image**, or
  use the card shown on first launch.
- **"Not enough disk space to download the Docker image":** the disk that holds
  Docker's data has less than ~55 GB free. The message names the folder. Free
  some space there, or move Docker's data directory to a larger disk, then try
  again. The check is skipped when the app can't read that disk, which is the
  case for Docker Desktop on macOS and Windows: there, make sure the Docker
  Desktop virtual disk is large enough.
- **The image download fails or is slow:** click **Download tools image**
  again. Docker resumes from the layers that already finished.
- **"produced no readable output" or "doesn't exist on the host":** the container ran and reported success, but the host can't see the file it wrote. That means the project folder isn't really shared into the container. On macOS and Windows, add the project folder's parent under Docker Desktop → Settings → Resources → File Sharing. This used to fail silently: the run looked successful and the Live Console printed a plausible path for a file that had already been discarded with the container.
- **The RF2 weight download fails on the first Design run:** the file comes
  from `files.ipd.uw.edu`, which occasionally has brief outages. Retry the
  pipeline. A failed attempt restarts from zero (no resume), but the file is
  size-checked against the server's `Content-Length` before it's moved into
  place, so a dropped connection never leaves a truncated weight file.
- **GPU not passed through on Linux:** install the nvidia-container-toolkit,
  then use **Settings → Test GPU access**. If the GPU is real but still not
  detected, force it on under **GPU detection**.
- **`conda env create` fails with a Terms of Service error** (only when
  building a modified Dockerfile): recent conda releases require accepting the
  `defaults` channel terms. The shipped Dockerfile already runs
  `conda tos accept` for both channels right after installing Miniconda.

## Known issues

- **Target `5M13` crashes in RFdiffusion** with `ValueError: Non-positive
  determinant (left-handed or null coordinate frame) in rotation matrix`.
  Other targets (e.g. `1ZVH`) run fine. The cause hasn't been investigated, so
  `5M13` was removed from the quick examples. Other targets haven't all been
  verified either.
- The Settings sidebar shows *Docker storage* as `/var/lib/docker` on Windows.
  This is a display value only.
- Windows Task Manager shows the *3D* engine by default, so a busy GPU can
  look idle. Switch a graph to *Cuda* / *Compute*, or run `nvidia-smi`.

Platform test results are tracked in
[docs/PLATFORM_NOTES.md](docs/PLATFORM_NOTES.md).

## Run the tools without the app

The Python tools in `python/` also run on their own inside the tools image.
[`scripts/nbtool.sh`](scripts/nbtool.sh) wraps the `docker run` call on Linux,
macOS and WSL:

```bash
scripts/nbtool.sh run_freesasa.py 1ZVH_chainA.pdb sasa.json
scripts/nbtool.sh codon_optimize.py --protein MKTAYIAKQRQISFVKSHFSRQ --out codon.json
```

Run it from the folder that holds your files and give paths relative to that
folder, because only the current folder is mounted. `scripts/nbtool.sh --help`
lists the scripts and the settings (`NB_IMAGE`, `NB_ENV`, `NB_CACHE`).

## Tests

```bash
npm test
```

This runs three test files, and none of them needs Docker. `tests/aa.test.js`
covers the amino-acid table and `tests/disk-space.test.js` covers the free-space
check before the image download. Both use Node's built-in test runner.
`tests/test_tools.py`
covers restriction-site finding and removal, the E. coli codon table, the Codon
Adaptation Index and GC content, and uses only the Python standard library. On
Windows the Python suite needs `python` instead of `python3`: run
`python -m unittest discover -s tests -p "test_*.py"`.

They cover pure logic only: the insert, and the free-space check. They do not cover the Electron
main process, the interface, Docker orchestration or the scientific tools.

## License

MIT License. See [LICENSE](LICENSE).

The scientific tools in the Docker image are separate works under their own
licenses, and **DiscoTope-3.0 and the RF2 weights are licensed for
non-commercial use only**. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Appendix: install without Docker

Docker is the tested, recommended path. This appendix is for running the
tools yourself, for example to avoid the image download or to debug a tool
directly. It follows [docker/Dockerfile](docker/Dockerfile) step by step.

> **The app itself still needs Docker.** The Design, Screening and Construct
> tabs only launch tools through Docker (`electron/main.js` has no native
> execution path), so a manual install lets you run the tools from a terminal
> but not from the app. The basic Target tab features (PDB download, InterPro,
> viewer) need neither.

Pick your OS. WSL follows the Ubuntu steps almost exactly. macOS has real
differences, called out below.

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

WSL runs a real Ubuntu userspace, so follow the **Ubuntu / Linux** steps
above inside your WSL shell, plus:

1. Install WSL2 and an Ubuntu distro from **Windows PowerShell** (not inside
   WSL):

   ```powershell
   wsl --install -d Ubuntu-22.04
   ```

2. Open the new Ubuntu terminal and follow the whole **Ubuntu / Linux**
   section inside it. Nothing in it is WSL-specific.
3. **GPU (optional):** install only the regular Windows NVIDIA driver. Do
   *not* install a separate Linux driver inside WSL; it isn't needed and can
   conflict. Verify from inside WSL with `nvidia-smi`.
4. **Showing the app window:** on Windows 11, WSLg forwards Linux GUI apps
   to your desktop, so `npm start` just works. On Windows 10 you need a
   separate X server (e.g. VcXsrv) and `DISPLAY` set manually.

### macOS

macOS has no NVIDIA GPU, so everything runs on CPU. RFdiffusion and
RFantibody are research code built and tested primarily on Linux with CUDA,
so a native macOS install is **experimental and not verified to work**.
Expect to debug dependency issues.

1. **Xcode command line tools:**

   ```bash
   xcode-select --install
   ```

2. **Miniconda**, using the installer for your chip:

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

3. **`nanobody-tools` env.** It has no CUDA dependency and installs as-is:

   ```bash
   cd ~/igem_nanobody
   conda env create -f environment-tools.yml
   ```

4. **`discotope` env.** `environment-discotope.yml` pins `pytorch-cuda=12.1`,
   which doesn't exist on macOS, so create it manually without the `nvidia`
   channel:

   ```bash
   conda create -n discotope -c pytorch -c conda-forge \
     python=3.11 pytorch numpy pandas pip -y
   ```

5. **DiscoTope-3.0, uv/RFantibody, RF2 weights:** same commands as the
   **Ubuntu / Linux** steps 4-6. If `uv sync` fails on a native macOS
   dependency, that's the expected risk above; there's no macOS-tested
   fallback in this repo.
6. **Run the app:** `npm install && npm start`.
