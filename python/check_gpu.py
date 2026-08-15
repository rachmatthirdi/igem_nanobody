"""Pre-flight GPU check. Prints a single JSON line to stdout.
Tries torch.cuda first (expected to run inside the `discotope` conda env,
which has torch installed); falls back to parsing `nvidia-smi` if torch
isn't available so the check still works even without that env active.
"""
import json
import shutil
import subprocess
import sys


def check_via_torch():
    import torch  # may raise ImportError - caller handles fallback
    if not torch.cuda.is_available():
        return {'cudaAvailable': False, 'gpuName': None, 'vramTotalGb': None}
    name = torch.cuda.get_device_name(0)
    vram_bytes = torch.cuda.get_device_properties(0).total_memory
    return {'cudaAvailable': True, 'gpuName': name, 'vramTotalGb': round(vram_bytes / (1024 ** 3), 1)}


def check_via_nvidia_smi():
    exe = shutil.which('nvidia-smi')
    if not exe:
        return {'cudaAvailable': False, 'gpuName': None, 'vramTotalGb': None}
    try:
        out = subprocess.check_output(
            [exe, '--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
            timeout=10,
        ).decode('utf-8', errors='ignore').strip()
        if not out:
            return {'cudaAvailable': False, 'gpuName': None, 'vramTotalGb': None}
        first_line = out.splitlines()[0]
        name, mem_mb = [p.strip() for p in first_line.split(',')]
        return {'cudaAvailable': True, 'gpuName': name, 'vramTotalGb': round(float(mem_mb) / 1024, 1)}
    except Exception:
        return {'cudaAvailable': False, 'gpuName': None, 'vramTotalGb': None}


def main():
    try:
        result = check_via_torch()
    except Exception:
        result = check_via_nvidia_smi()
    print(json.dumps(result))


if __name__ == '__main__':
    main()
