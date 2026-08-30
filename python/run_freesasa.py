"""Per-residue SASA/RSA via FreeSASA (https://freesasa.github.io/, `pip install freesasa`).
Usage: python run_freesasa.py <chainA.pdb> <out.json>
"""

import argparse
import json
import math

import freesasa

AA_3TO1 = {
    "ALA": "A",
    "ARG": "R",
    "ASN": "N",
    "ASP": "D",
    "CYS": "C",
    "GLN": "Q",
    "GLU": "E",
    "GLY": "G",
    "HIS": "H",
    "ILE": "I",
    "LEU": "L",
    "LYS": "K",
    "MET": "M",
    "PHE": "F",
    "PRO": "P",
    "SER": "S",
    "THR": "T",
    "TRP": "W",
    "TYR": "Y",
    "VAL": "V",
    "MSE": "M",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdb_path")
    parser.add_argument("out_path")
    args = parser.parse_args()

    structure = freesasa.Structure(args.pdb_path)
    result = freesasa.calc(structure)
    residue_areas = result.residueAreas()

    residues = []
    skipped = 0
    for chain_id, chain_residues in residue_areas.items():
        for res_num_str, area in chain_residues.items():
            # PDB insertion codes (e.g. "49A") aren't valid residue numbers -
            # skip rather than crash, since every downstream consumer
            # (hotspot selection, RFdiffusion's -h flag) expects plain ints
            # anyway and can't represent insertion-coded residues either.
            try:
                res_num = int(res_num_str)
            except ValueError:
                skipped += 1
                continue
            rsa = area.relativeTotal
            if rsa is None or (isinstance(rsa, float) and math.isnan(rsa)):
                rsa = None
            residues.append(
                {
                    "chain": chain_id,
                    "resNum": res_num,
                    "residue": AA_3TO1.get(area.residueType, area.residueType),
                    "sasa": round(area.total, 2),
                    "rsa": round(rsa, 4) if rsa is not None else None,
                }
            )
    if skipped:
        print(
            f"WARNING: {skipped} residu dengan insertion code dilewati (nomor residu tidak valid)."
        )

    residues.sort(key=lambda r: r["resNum"])
    with open(args.out_path, "w", encoding="utf-8") as f:
        json.dump({"residues": residues}, f)

    print(f"FreeSASA selesai: {len(residues)} residu dianalisis.")


if __name__ == "__main__":
    main()
