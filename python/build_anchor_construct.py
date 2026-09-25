"""Assemble anchor_dna + linker_dna + nanobody_dna.
Usage: python build_anchor_construct.py --args_json <in.json> --out <out.json>

in.json: { anchor_aa, nanobody_dna, organism }
"""

import argparse
import json

from codon_opt_core import optimize_sequence, strip_start_stop

LINKER_AA = "GGGGS" * 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--args_json", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.args_json, "r", encoding="utf-8") as f:
        params = json.load(f)

    anchor_aa = params["anchor_aa"]
    # Phase 7 hands over a complete CDS (ATG ... TGA). Here the nanobody is an
    # internal segment: its stop codon would terminate translation before the
    # His-tag build_plasmid.py appends after it, and its ATG is redundant since
    # the NdeI site (CATATG) already supplies the start codon.
    nanobody_dna = strip_start_stop(params["nanobody_dna"])
    organism = params.get("organism") or "Escherichia coli general"

    # Both sit upstream of the nanobody in the fusion, so they must not carry
    # a start or stop codon of their own.
    anchor_result = optimize_sequence(anchor_aa, organism, add_start_stop=False)
    linker_result = optimize_sequence(LINKER_AA, organism, add_start_stop=False)

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
