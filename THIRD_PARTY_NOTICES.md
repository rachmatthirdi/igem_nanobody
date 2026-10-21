# Third-party components

CATCHERs Generator is released under the [MIT License](LICENSE). That
license covers the source code in this repository only. The tools below are
separate works under their own licenses. This file is a summary for readers and
is not legal advice. Each tool keeps its own license file, and the originals
are the authority.

## Tools in the Docker image

Read from the license files and package metadata inside the published image
(`rachmatthirdi/igem_brawijaya`, digest
`sha256:f5cc30e2a20816563ba558fb941b600f971e0f2035958d01305dee5060ac0843`).

| Component | License | Where it was read |
| --- | --- | --- |
| RFantibody (RFdiffusion, ProteinMPNN and RF2 code) | MIT, Copyright 2025 Nathaniel Bennett and Joseph Watson | `LICENSE` in the repository inside the image |
| **DiscoTope-3.0** | **Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)** | `LICENSE` in the repository inside the image |
| FreeSASA | MIT | Package metadata |
| PRODIGY (`prodigy-prot`) | Apache-2.0 | Package metadata |
| CodonTransformer | Apache-2.0 | Package metadata |
| Transformers | Apache-2.0 | Package metadata |
| PyTorch | BSD-3-Clause | Package metadata |
| NumPy | BSD | Package metadata |
| Biopython | Biopython License Agreement | Package metadata |

## Model weights

| Weights | License | Source of this information |
| --- | --- | --- |
| RFdiffusion and ProteinMPNN | BSD / MIT, redistributable | Stated in [README.md](README.md); not independently checked |
| **RF2 (`RF2_ab.pt`)** | **[Rosetta-DL Non-Commercial license](https://github.com/RosettaCommons/Rosetta-DL/blob/main/LICENSE.md)** | Stated in [README.md](README.md); not independently checked |

The RF2 weights are not in the image. Each installation downloads its own copy
from the official source on the first Design run.

## Non-commercial restriction

DiscoTope-3.0 and the RF2 weights are licensed for **non-commercial use only**.
The MIT license on this application does not remove those limits.
Academic and competition use is covered. Commercial use of the full pipeline
would need permission from the authors of those components.

## JavaScript dependencies

Read from `package-lock.json`.

| Package | Version | License |
| --- | --- | --- |
| Electron | 41.10.7 | MIT |
| Lucide | 1.59.0 | ISC |
| pdbe-molstar | 3.1.3 | Apache-2.0 |

All 316 packages in the lock file, including transitive ones, use permissive
licenses: 282 MIT, 21 ISC, 5 Apache-2.0, 4 BSD-3-Clause, 2 BSD-2-Clause, 1
Python-2.0 and 1 0BSD.
