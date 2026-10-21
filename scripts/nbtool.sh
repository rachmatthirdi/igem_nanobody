#!/usr/bin/env bash
# Run one of the Python tools in python/ inside the tools image, without the app.
#
#   scripts/nbtool.sh <script.py> [arguments...]
#
# Run it from the folder that holds your files and give paths relative to that
# folder, because only the current folder is mounted into the container.
#
# Examples:
#   scripts/nbtool.sh run_freesasa.py 1ZVH_chainA.pdb sasa.json
#   scripts/nbtool.sh codon_optimize.py --protein MKTAYIAKQRQISFVKSHFSRQ --out codon.json
#   scripts/nbtool.sh calculate_cai.py --dna ATGAAAACCGCG --out cai.json
#
# Settings (environment variables):
#   NB_IMAGE  tools image   (default: rachmatthirdi/igem_brawijaya:latest)
#   NB_ENV    conda env     (default: nanobody-tools)
#   NB_CACHE  model cache   (default: <repo>/cache, shared with the app)
#
# Needs Docker and the tools image (see README). Works on Linux, macOS and WSL.

set -euo pipefail

IMAGE="${NB_IMAGE:-rachmatthirdi/igem_brawijaya:latest}"
ENV_NAME="${NB_ENV:-nanobody-tools}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${NB_CACHE:-$REPO/cache}"

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo
  echo "Available scripts:"
  (cd "$REPO/python" && ls ./*.py | sed 's|^\./|  |')
}

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  usage
  exit 0
fi

SCRIPT="$1"
shift

if [ ! -f "$REPO/python/$SCRIPT" ]; then
  echo "error: python/$SCRIPT does not exist." >&2
  echo >&2
  usage >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: Docker was not found on PATH. Install Docker and start it first." >&2
  exit 127
fi

mkdir -p "$CACHE/hf" "$CACHE/torch"

# --user keeps the files you create owned by you. USER and LOGNAME are needed
# because the image has no passwd entry for your uid, and libraries that call
# getpass.getuser() at import time would otherwise fail. LD_LIBRARY_PATH puts the
# env's own libstdc++ ahead of the system one, which `conda run` does not do.
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e USER=nanobody -e LOGNAME=nanobody \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e HF_HOME=/cache/hf -e TORCH_HOME=/cache/torch \
  -e "LD_LIBRARY_PATH=/opt/conda/envs/$ENV_NAME/lib" \
  -v "$PWD:/w" -v "$REPO/python:/py:ro" -v "$CACHE:/cache" \
  -w /w \
  "$IMAGE" \
  conda run -n "$ENV_NAME" --no-capture-output python "/py/$SCRIPT" "$@"
