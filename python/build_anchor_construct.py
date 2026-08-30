"""Assemble anchor_dna + linker_dna + nanobody_dna.
Usage: python build_anchor_construct.py --args_json <in.json> --out <out.json>

in.json: { anchor_aa, nanobody_dna, organism }
"""

import argparse
import json

from codon_opt_core import optimize_sequence

LINKER_AA = "GGGGS" * 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--args_json", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.args_json, "r", encoding="utf-8") as f:
        params = json.load(f)

    anchor_aa = params["anchor_aa"]
    nanobody_dna = params["nanobody_dna"].strip().upper()
    organism = params.get("organism") or "Escherichia coli general"

    anchor_result = optimize_sequence(anchor_aa, organism)
    linker_result = optimize_sequence(LINKER_AA, organism)

    anchor_dna = anchor_result["sequence_dna"]
    linker_dna = linker_result["sequence_dna"]

    construct_dna = anchor_dna + linker_dna + nanobody_dna
    components = [
        {"name": "Anchor", "start": 0, "end": len(anchor_dna)},
        {
            "name": "Linker",
            "start": len(anchor_dna),
            "end": len(anchor_dna) + len(linker_dna),
        },
        {
            "name": "Nanobody",
            "start": len(anchor_dna) + len(linker_dna),
            "end": len(construct_dna),
        },
    ]

    result = {
        "construct_dna": construct_dna,
        "components": components,
        "anchor_method": anchor_result["method"],
        "linker_aa": LINKER_AA,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f)

    print(f"Konstruk anchor+linker+nanobody selesai: {len(construct_dna)} bp.")


if __name__ == "__main__":
    main()
