# Combined tools image: conda envs (nanobody-tools, discotope) + DiscoTope-3.0 + RFantibody.
# Base is plain ubuntu:22.04, not nvidia/cuda: discotope's conda env pulls pytorch-cuda from the
# pytorch/nvidia channels, and RFantibody's `uv sync` installs its own pip torch wheel -- both
# bundle their own CUDA runtime, so the container only needs the NVIDIA driver passed through at
# `docker run` time, not a matching system CUDA toolkit baked into the image.
FROM ubuntu:22.04
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    CONDA_DIR=/opt/conda \
    PATH=/opt/conda/bin:/root/.local/bin:/root/.cargo/bin:$PATH

# 1. System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget unzip ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

# 2. Miniconda
RUN curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/miniconda.sh \
    && bash /tmp/miniconda.sh -b -p "$CONDA_DIR" \
    && rm /tmp/miniconda.sh \
    && conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main \
    && conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r

WORKDIR /opt/tools

# 3. nanobody-tools env (Python 3.10) -- FreeSASA, PRODIGY, CodonTransformer
COPY environment-tools.yml .
RUN conda env create -f environment-tools.yml && conda clean -afy

# 4. discotope env (Python 3.11 + PyTorch/CUDA 12.1)
COPY environment-discotope.yml .
RUN conda env create -f environment-discotope.yml && conda clean -afy

# 5. DiscoTope-3.0: clone and install into the discotope env from its own requirements.txt
#    (the pinned versions there are the source of truth, not environment-discotope.yml).
#    The repo ships its 100 XGBoost models as models.zip, not unpacked - main.py
#    expects the extracted XGB_n_of_100.json files directly under models/.
RUN git clone --depth 1 https://github.com/Magnushhoie/DiscoTope-3.0.git DiscoTope-3.0 \
    && cd DiscoTope-3.0 && unzip -o models.zip && cd .. \
    && conda run -n discotope pip install --no-cache-dir -r DiscoTope-3.0/requirements.txt \
    && conda run -n discotope pip install --no-cache-dir -e DiscoTope-3.0

# 6. uv + RFantibody: clone, download model weights, build its own venv via `uv sync`
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN git clone --depth 1 https://github.com/RosettaCommons/RFantibody.git RFantibody
WORKDIR /opt/tools/RFantibody
RUN bash include/download_weights.sh && uv sync

WORKDIR /workspace
HEALTHCHECK NONE
CMD ["/bin/bash"]
