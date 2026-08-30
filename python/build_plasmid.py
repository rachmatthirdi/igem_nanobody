"""Assemble the final expression-construct insert and export a synthesis-ready FASTA.
Usage: python build_plasmid.py --args_json <in.json> --out <out.json>

in.json: {
  constructDna, vector, includePelb, pelbAminoAcidSeq (if includePelb),
  candidateId, output_dir, organism, cai (candidate's nanobody CAI, informational)
}

Insert layout: NdeI -> [PelB] -> Anchor -> Linker -> Nanobody -> His-Tag -> Stop -> XhoI
pET-28a(+)/pET-22b(+) are standard commercial vectors used only as metadata
labels here (no vector backbone sequence is fetched or fabricated).
"""

import argparse
import json
import os
import re

from codon_opt_core import optimize_sequence
from ecoli_codon_usage import calculate_cai, gc_content

NDEI = "CATATG"
XHOI = "CTCGAG"
HIS_TAG_DNA = "CATCACCATCACCATCAC"
STOP = "TAA"


def wrap(seq, width=60):
    return "\n".join(seq[i : i + width] for i in range(0, len(seq), width))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--args_json", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.args_json, "r", encoding="utf-8") as f:
        params = json.load(f)

    construct_dna = params["constructDna"].strip().upper()
    vector = params.get("vector", "pET-28a(+)")
    include_pelb = bool(params.get("includePelb"))
    candidate_id = params.get("candidateId") or "candidate"
    output_dir = params["output_dir"]
    organism = params.get("organism") or "Escherichia coli general"

    pelb_dna = ""
    if include_pelb:
        pelb_aa = params.get("pelbAminoAcidSeq")
        if pelb_aa:
            pelb_result = optimize_sequence(pelb_aa, organism)
            pelb_dna = pelb_result["sequence_dna"]

    insert = NDEI + pelb_dna + construct_dna + HIS_TAG_DNA + STOP + XHOI
    length_bp = len(insert)
    gc = gc_content(insert)
    cai = calculate_cai(insert)["cai"]

    safe_vector = re.sub(r"[^A-Za-z0-9]+", "", vector)
    safe_id = re.sub(r"[^A-Za-z0-9_-]+", "", candidate_id)
    file_name = f"{safe_id}_{safe_vector}_construct.fasta"
    os.makedirs(output_dir, exist_ok=True)
    fasta_path = os.path.join(output_dir, file_name)

    header = (
        f">{candidate_id}_construct | vector={vector}"
        f'{"+PelB" if include_pelb else ""} | length={length_bp}bp | GC%={gc:.1f} | CAI={cai:.3f}'
    )
    body = wrap(insert)
    fasta_text = f"{header}\n{body}\n"

    with open(fasta_path, "w", encoding="utf-8") as f:
        f.write(fasta_text)

    result = {
        "fastaPath": fasta_path,
        "preview": fasta_text,
        "lengthBp": length_bp,
        "gcContent": round(gc, 2),
        "cai": round(cai, 4),
        "includePelb": include_pelb,
        "vector": vector,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f)

    print(f"FASTA final ditulis ke {fasta_path} ({length_bp} bp).")


if __name__ == "__main__":
    main()
