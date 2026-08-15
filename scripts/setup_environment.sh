#!/usr/bin/env bash
set -e

TOOLS_DIR="$HOME/nanobody-designer-tools"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$TOOLS_DIR"

echo -e "\n\033[0;36m== 0. Checking & Auto-Installing System Packages ==\033[0m"
NEEDED_PKGS=""
for pkg in git curl wget unzip gcc g++; do
    if ! command -v $pkg &> /dev/null; then
        NEEDED_PKGS="$NEEDED_PKGS $pkg"
    fi
done

if [ -n "$NEEDED_PKGS" ]; then
    echo "Missing required system utilities:$NEEDED_PKGS."
    if command -v apt-get &> /dev/null; then
        echo "Installing missing dependencies via apt..."
        sudo apt-get update -y && sudo apt-get install -y git curl wget unzip build-essential
    else
        echo -e "\033[0;33mPlease install git, curl, wget, unzip, and build-essential manually using your Linux package manager.\033[0m"
    fi
else
    echo "All required system dependencies are present."
fi

echo -e "\n\033[0;36m== 1. Miniconda ==\033[0m"
MINICONDA_HOME="$HOME/miniconda3"
if ! command -v conda &> /dev/null && [ ! -f "$MINICONDA_HOME/bin/conda" ]; then
    INSTALLER="$HOME/Miniconda3-latest-Linux-x86_64.sh"
    echo "Downloading Miniconda installer..."
    curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o "$INSTALLER"
    
    echo "Installing Miniconda to $MINICONDA_HOME..."
    bash "$INSTALLER" -b -p "$MINICONDA_HOME"
    rm -f "$INSTALLER"
fi

if [ -f "$MINICONDA_HOME/etc/profile.d/conda.sh" ]; then
    source "$MINICONDA_HOME/etc/profile.d/conda.sh"
fi
export PATH="$MINICONDA_HOME/bin:$PATH"

if command -v conda &> /dev/null; then
    echo "Conda ready: $(which conda)"
else
    echo -e "\033[0;31mError: Conda binary not found.\033[0m" && exit 1
fi

echo -e "\n\033[0;36m== 2. Conda env: nanobody-tools ==\033[0m"
if ! conda env list | awk '{print $1}' | grep -qx 'nanobody-tools'; then
    if [ -f "$REPO_ROOT/environment-tools.yml" ]; then
        conda env create -f "$REPO_ROOT/environment-tools.yml"
    else
        echo "environment-tools.yml missing. Creating standard nanobody-tools environment..."
        conda create -n nanobody-tools python=3.10 -y
    fi
else
    echo "Env 'nanobody-tools' already exists, skipping."
fi

echo -e "\n\033[0;36m== 3. Conda env: discotope ==\033[0m"
if ! conda env list | awk '{print $1}' | grep -qx 'discotope'; then
    if [ -f "$REPO_ROOT/environment-discotope.yml" ]; then
        conda env create -f "$REPO_ROOT/environment-discotope.yml"
    else
        echo "environment-discotope.yml missing. Creating standard discotope environment..."
        conda create -n discotope python=3.10 -y
    fi
else
    echo "Env 'discotope' already exists, skipping."
fi

echo -e "\n\033[0;36m== 4. DiscoTope-3.0 ==\033[0m"
DISCOTOPE_DIR="$TOOLS_DIR/DiscoTope-3.0"
if [ ! -d "$DISCOTOPE_DIR/.git" ]; then
    rm -rf "$DISCOTOPE_DIR"
    git clone https://github.com/Magnushhoie/DiscoTope-3.0/ "$DISCOTOPE_DIR"
else
    echo "DiscoTope-3.0 repository ready at $DISCOTOPE_DIR."
fi

cd "$DISCOTOPE_DIR"
conda run -n discotope pip install -r requirements.txt || true
conda run -n discotope pip install .
if [ -f "models.zip" ]; then
    unzip -o models.zip -d .
fi
echo -e "\033[0;32mDiscoTope-3.0 ready at: $DISCOTOPE_DIR\033[0m"

echo -e "\n\033[0;36m== 5. RFantibody ==\033[0m"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
if ! command -v uv &> /dev/null; then
    echo "Installing Astral uv binary..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
fi

RFANTIBODY_DIR="$TOOLS_DIR/RFantibody"
if [ ! -d "$RFANTIBODY_DIR/.git" ]; then
    rm -rf "$RFANTIBODY_DIR"
    git clone https://github.com/RosettaCommons/RFantibody.git "$RFANTIBODY_DIR"
else
    echo "RFantibody repository ready at $RFANTIBODY_DIR."
fi

cd "$RFANTIBODY_DIR"
if [ -f "include/download_weights.sh" ]; then
    bash include/download_weights.sh || true
fi
uv sync
echo -e "\033[0;32mRFantibody ready at: $RFANTIBODY_DIR\033[0m"

echo -e "\n\033[0;32mSetup complete! Use these paths in application settings:\033[0m"
echo "  - Execution mode: local"
echo "  - DiscoTope path: $DISCOTOPE_DIR"
echo "  - RFantibody path: $RFANTIBODY_DIR"