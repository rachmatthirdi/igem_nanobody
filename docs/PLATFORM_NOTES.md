<!--
DRAFT - not committed. Sections to paste into repo/README.md after review.
Only things actually observed are stated as fact; "Not tested" means exactly that.
Fill the TODO cells with the Linux results from the drylab team.
-->

## Tested platforms

| Platform | GPU | Target tab | Design tab | Screening / Construct |
| --- | --- | --- | --- | --- |
| Linux, no GPU | none | TODO (drylab) | TODO (drylab) | TODO (drylab) |
| Linux, GPU (drylab server) | TODO (model, VRAM) | TODO (drylab) | TODO (drylab) | TODO (drylab) |
| Windows 11 + Docker Desktop | NVIDIA RTX 3050 Laptop, 4 GB VRAM | Works (FreeSASA, DiscoTope, InterPro) | Works with minimal settings on `1ZVH`: RFdiffusion and ProteinMPNN completed. RF2 was fixed afterwards and not yet re-run to completion. | Not tested |

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
- The first Design run downloads the RF2 weights (~281 MB) and caches them
  under `cache/weights/`.
