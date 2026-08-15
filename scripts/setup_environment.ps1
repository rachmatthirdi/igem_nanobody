#requires -Version 5.1
<#
Nanobody Designer — environment setup (Windows).

This script is NOT run automatically by the app. Review it, then run it
yourself in an elevated PowerShell window when you're ready:

    powershell -ExecutionPolicy Bypass -File scripts\setup_environment.ps1

What it does:
  1. Installs Miniconda (if not already present).
  2. Creates the `nanobody-tools` conda env (FreeSASA, CodonTransformer,
     PRODIGY) and the `discotope` conda env (PyTorch/CUDA base for
     DiscoTope-3.0).
  3. Clones DiscoTope-3.0 and installs it into the `discotope` env from its
     own requirements.txt / weights.
  4. Prints next steps for RFantibody, which is Linux+CUDA oriented (bash
     scripts, `uv`, GPU) and is NOT natively supported on Windows. This
     script gets WSL2 ready and gives you the exact commands to run *inside*
     WSL to install RFantibody there — it does not attempt to install a
     Linux ML stack from PowerShell.

After running this (and configuring RFantibody inside WSL), open the app's
Settings modal and point it at:
  - Conda env names (defaults already match this script: nanobody-tools, discotope)
  - DiscoTope-3.0 repo path
  - RFantibody repo path (the path as seen from WSL, e.g. \\wsl$\Ubuntu\home\<you>\RFantibody
    mapped back to a Windows path, or simply the Windows-side clone if you
    used the WSL filesystem's /mnt/c/... to place it under this project)
  - Execution mode: wsl (default) or docker
#>

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $env:USERPROFILE 'nanobody-designer-tools'
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

Write-Host "== 1. Miniconda ==" -ForegroundColor Cyan
$condaCmd = Get-Command conda -ErrorAction SilentlyContinue
if (-not $condaCmd) {
    $installerPath = Join-Path $env:TEMP 'Miniconda3-latest-Windows-x86_64.exe'
    Write-Host "Mengunduh installer Miniconda..."
    Invoke-WebRequest -Uri 'https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe' -OutFile $installerPath
    $minicondaHome = Join-Path $env:USERPROFILE 'miniconda3'
    Write-Host "Menginstal Miniconda ke $minicondaHome (silent)..."
    Start-Process -FilePath $installerPath -ArgumentList "/InstallationType=JustMe /RegisterPython=0 /AddToPath=1 /S /D=$minicondaHome" -Wait
    $env:Path = "$minicondaHome;$minicondaHome\Scripts;$minicondaHome\condabin;$env:Path"
    Write-Host "Miniconda terinstal. Anda mungkin perlu membuka terminal baru agar 'conda' dikenali PATH." -ForegroundColor Yellow
} else {
    Write-Host "Conda sudah terpasang: $($condaCmd.Source)"
}

Write-Host "`n== 2. Conda env: nanobody-tools ==" -ForegroundColor Cyan
conda env list | Select-String 'nanobody-tools' | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (conda env list | Select-String 'nanobody-tools')) {
    conda env create -f (Join-Path $RepoRoot 'environment-tools.yml')
} else {
    Write-Host "Env 'nanobody-tools' sudah ada, lewati."
}

Write-Host "`n== 3. Conda env: discotope ==" -ForegroundColor Cyan
if (-not (conda env list | Select-String 'discotope')) {
    conda env create -f (Join-Path $RepoRoot 'environment-discotope.yml')
} else {
    Write-Host "Env 'discotope' sudah ada, lewati."
}

Write-Host "`n== 4. DiscoTope-3.0 ==" -ForegroundColor Cyan
$discotopeDir = Join-Path $ToolsDir 'DiscoTope-3.0'
if (-not (Test-Path $discotopeDir)) {
    git clone https://github.com/Magnushhoie/DiscoTope-3.0/ $discotopeDir
} else {
    Write-Host "DiscoTope-3.0 sudah ter-clone di $discotopeDir, lewati clone."
}
Push-Location $discotopeDir
conda run -n discotope pip install -r requirements.txt
conda run -n discotope pip install .
if (Test-Path 'models.zip') {
    Expand-Archive -Path 'models.zip' -DestinationPath . -Force
} else {
    Write-Host "models.zip tidak ditemukan di repo - unduh model weights sesuai README DiscoTope-3.0 secara manual." -ForegroundColor Yellow
}
Pop-Location
Write-Host "DiscoTope-3.0 siap di: $discotopeDir" -ForegroundColor Green

Write-Host "`n== 5. RFantibody (perlu WSL2 + GPU passthrough) ==" -ForegroundColor Cyan
$wslInstalled = Get-Command wsl -ErrorAction SilentlyContinue
if (-not $wslInstalled) {
    Write-Host "WSL tidak ditemukan. Jalankan 'wsl --install' (perlu restart), lalu jalankan ulang bagian ini." -ForegroundColor Yellow
} else {
    Write-Host @"
RFantibody (RFdiffusion/ProteinMPNN/RF2) memakai skrip bash + 'uv' dan
ditujukan untuk Linux+CUDA - tidak didukung native di Windows. Jalankan
perintah berikut DI DALAM WSL2 (distro dengan NVIDIA CUDA driver terpasang):

  curl -LsSf https://astral.sh/uv/install.sh | sh
  source ~/.bashrc
  git clone https://github.com/RosettaCommons/RFantibody.git ~/RFantibody
  cd ~/RFantibody
  bash include/download_weights.sh
  uv sync

Setelah selesai, di Settings aplikasi Nanobody Designer:
  - Path RFantibody: path ke folder ~/RFantibody tsb (mis. lewat \\wsl$\<distro>\home\<user>\RFantibody)
  - Mode eksekusi: wsl
  - Distro WSL: nama distro Anda (mis. Ubuntu)
"@ -ForegroundColor White
}

Write-Host "`nSetup dasar selesai. Buka Settings di aplikasi untuk mengisi path DiscoTope-3.0 dan RFantibody di atas." -ForegroundColor Green
