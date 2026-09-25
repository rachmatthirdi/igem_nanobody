"""Assemble the final expression-construct insert and export a synthesis-ready FASTA.
Usage: python build_plasmid.py --args_json <in.json> --out <out.json>

in.json: {
  constructDna, vector, includePelb, pelbAminoAcidSeq (if includePelb),
  anchorHasNativeSignal, candidateId, output_dir, organism,
  cai (candidate's nanobody CAI, informational)
}

Insert layout: NdeI -> [PelB] -> Anchor -> Linker -> Nanobody -> His-Tag -> Stop -> XhoI
pET-28a(+)/pET-22b(+) are standard commercial vectors used only as metadata
labels here (no vector backbone sequence is fetched or fabricated).

After assembly the insert is screened for internal NdeI/XhoI sites, which
codon optimization can plant anywhere and which would stop the double digest
from releasing the insert intact. See restriction_sites.py.
"""

import argparse
import json
import os
import re

from codon_opt_core import optimize_sequence
from ecoli_codon_usage import calculate_cai, gc_content
from restriction_sites import describe, remove_internal_sites

NDEI = "CATATG"
XHOI = "CTCGAG"
HIS_TAG_DNA = "CATCACCATCACCATCAC"
STOP = "TAA"

# The ATG inside NdeI's CATATG is the start codon, so the reading frame opens
# 3 bases into the insert and every codon boundary follows from there.
CDS_OFFSET = 3


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

    notes = []

    # The display anchors (Lpp-OmpA, intimin) are exported by their own native
    # signal peptide, which is part of the anchor fragment itself. Prepending
    # PelB on top would put two signal peptides in tandem: the signal peptidase
    # cleaves the first one, leaving the second stranded inside the mature
    # protein instead of being removed, and the anchor no longer starts where
    # its own targeting sequence expects to.
    if include_pelb and params.get("anchorHasNativeSignal"):
        include_pelb = False
        notes.append(
            "PelB dilewati: anchor yang dipilih sudah membawa signal peptide "
            "native-nya sendiri, dua signal peptide berderet akan menggagalkan "
            "ekspor ke membran luar."
        )

    pelb_dna = ""
    if include_pelb:
        pelb_aa = params.get("pelbAminoAcidSeq")
        if not pelb_aa:
            # Never fall through silently: the FASTA header is written from
            # include_pelb, so dropping the sequence here while leaving the
            # flag set labels the construct "+PelB" when it has none.
            raise ValueError(
                "includePelb was set but no pelbAminoAcidSeq was supplied - "
                "refusing to emit a construct whose header claims a PelB it "
                "does not contain."
            )
        # Signal peptide, sits between NdeI and the anchor - no start/stop.
        pelb_result = optimize_sequence(pelb_aa, organism, add_start_stop=False)
        pelb_dna = pelb_result["sequence_dna"]

    insert = NDEI + pelb_dna + construct_dna + HIS_TAG_DNA + STOP + XHOI

    # Everything from the start codon up to (not including) the stop codon may
    # be re-coded synonymously; the flanking cloning sites and the stop may not.
    cds_start = CDS_OFFSET
    cds_end = len(NDEI) + len(pelb_dna) + len(construct_dna) + len(HIS_TAG_DNA)
    allowed_sites = {("NdeI", 0), ("XhoI", len(insert) - len(XHOI))}

    insert, changes, unresolved = remove_internal_sites(
        insert, cds_start, cds_end, allowed_sites
    )
    for line in describe(changes, unresolved):
        print(line)
        notes.append(line)
    if changes:
        print(
            f"{len(changes)} situs restriksi internal dihapus lewat substitusi "
            f"kodon sinonim (protein tidak berubah)."
        )

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
        "restrictionFixes": changes,
        "restrictionUnresolved": [
            {"enzyme": n, "position": i} for n, i, _ in unresolved
        ],
        "notes": notes,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f)

    print(f"FASTA final ditulis ke {fasta_path} ({length_bp} bp).")


if __name__ == "__main__":
    main()
