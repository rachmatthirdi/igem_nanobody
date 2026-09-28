<!--
DRAFT. Sections to paste into repo/README.md after review.
Only things actually observed are stated as fact; "Not tested" means exactly that.
Fill the TODO cells with the Linux results from the drylab team.
-->

## Tested platforms

| Platform | GPU | Target tab | Design tab | Screening / Construct |
| --- | --- | --- | --- | --- |
| Linux, no GPU | none | TODO (drylab) | TODO (drylab) | TODO (drylab) |
| Linux, GPU (drylab server) | TODO (model, VRAM) | TODO (drylab) | TODO (drylab) | TODO (drylab) |
| Windows 11 + Docker Desktop | NVIDIA RTX 3050 Laptop, 4 GB VRAM | Works (FreeSASA, DiscoTope, InterPro) | Works with minimal settings on `1ZVH` (2 backbones, 1 sequence each): RFdiffusion, ProteinMPNN and RF2 ran | Screening produced a candidate; Construct ran with it: codon optimisation (CodonTransformer, CAI 0.919), anchor construct and plasmid assembly (pET-28a(+), 2409 bp FASTA). The exported FASTA lands in `output/` after the path fix below (re-run and checked). |

Windows notes:

- Docker Desktop on Windows *can* pass an NVIDIA GPU through to the container
  (WSL2 backend, `--gpus all`): on the test machine `nvidia-smi` inside the
  container succeeded and the GPU showed ~94% utilisation during RFdiffusion.
  <!-- TODO: replace the older README sentence saying Windows has no NVIDIA passthrough, if the team agrees. -->
- Windows Task Manager shows the *3D* engine by default, so the GPU can look
  idle at 0% while it is busy. Switch a graph to *Cuda*/*Compute*, or run
  `nvidia-smi`.
- The app translates Windows paths for Docker (project folder is mounted at
  `/nbroot` inside the container). This only applies on Windows; Linux/macOS
  behaviour is unchanged. <!-- TODO: confirm on the Linux server after merge. -->

Windows-only problems found and fixed while testing (none affect Linux):

1. The Docker socket path was hard-coded to `/var/run/docker.sock`; Windows
   uses the `//./pipe/docker_engine` named pipe, so the in-app image download
   could not connect.
2. Host paths such as `D:\...` were passed to `docker run -w/-v/-e`, which
   Docker rejects (FreeSASA and DiscoTope exited with code 125). The project
   folder is now mounted at `/nbroot` and paths are translated.
3. That translation also rewrote the host side of the RF2 weights mount, so
   Docker mounted an empty directory and RF2 failed with
   `IsADirectoryError ... RF2_ab.pt`. The host side of `-v` is now left alone.
4. Paths stored inside JSON argument files (the plasmid `output_dir`) are read
   by Python in the container, where a `D:\...` string is just a file name, so
   the FASTA was written to a stray folder in the repo root while the log
   reported success. The path is now translated; a re-run wrote the FASTA to
   `output/` as expected.

## Hardware requirements

The Target, Screening and Construct stages are light. The **Design** stage
(RFdiffusion / ProteinMPNN / RF2) is the demanding one.

- Tested: a 4 GB VRAM laptop GPU runs the Design pipeline with minimal
  settings (2 backbones, 1 sequence per backbone) and reached ~85 °C.
- Larger runs and larger targets will need more VRAM. We have not measured
  the limit; treat 4 GB as a lower bound for testing only.
  <!-- TODO: add the drylab server's GPU model, VRAM and a typical run time. -->

## Known issues

- **Target `5M13` crashes in the RFdiffusion step.** The run fails with
  `ValueError: Non-positive determinant (left-handed or null coordinate frame)
  in rotation matrix` (an all-zero rotation matrix). It was reproduced on
  Windows (Docker Desktop) and reported on WSL; other targets (e.g. `1ZVH`)
  run fine. The cause has not been investigated (possible suspects: the target
  structure or the selected hotspots), so `5M13` was removed from the quick
  examples. Other targets have not all been verified either.
- The Settings sidebar shows *Docker storage* as `/var/lib/docker` on Windows.
  This is only a display value and does not affect anything.
- The tools image downloads ~19 GB (compressed) but takes ~53 GB on disk once
  extracted, so plan disk space accordingly.
- The first Design run downloads the RF2 weights (~281 MB) and caches them
  under `cache/weights/`.
