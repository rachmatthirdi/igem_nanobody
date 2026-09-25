"""
Core codon-optimization logic shared by codon_optimize.py (CLI) and
build_anchor_construct.py (in-process, for the anchor + linker segments).

Primary path: CodonTransformer (https://github.com/adibvafa/CodonTransformer,
`pip install CodonTransformer`) - a trained model, organism-aware.
Fallback (no GPU / package / model-download required): deterministic
highest-usage-codon substitution from the E. coli K-12 table in
ecoli_codon_usage.py. The fallback is only calibrated for E. coli; for any
other organism it is used verbatim but flagged with a warning since it is
not organism-specific.
"""

from ecoli_codon_usage import (
    CODON_TO_AA,
    calculate_cai,
    fallback_optimize,
    gc_content,
)

START_CODON = "ATG"
STOP_CODON = "TGA"
STOP_CODONS = ("TAA", "TAG", "TGA")


def strip_start_stop(dna_seq):
    """Drops a leading ATG and a trailing stop codon from a complete CDS.

    For embedding one as an internal segment of a fusion, where its stop codon
    would truncate everything downstream of it.
    """
    dna_seq = dna_seq.strip().upper()
    dna_seq = dna_seq.removeprefix(START_CODON)
    if dna_seq[-3:] in STOP_CODONS:
        dna_seq = dna_seq[:-3]
    return dna_seq


def optimize_sequence(
    protein_seq, organism="Escherichia coli general", add_start_stop=True
):
    """Codon-optimizes protein_seq for organism.

    add_start_stop wraps the result as a complete CDS (ATG ... TGA). Pass
    False for anything embedded mid-fusion (anchor, linker, PelB), where a
    stop codon would truncate everything downstream of it.
    """
    protein_seq = protein_seq.strip().upper()
    warnings = []
    method = None
    dna_seq = None

    try:
        import torch
        from CodonTransformer.CodonPrediction import predict_dna_sequence
        from transformers import AutoTokenizer, BigBirdForMaskedLM

        # Pinned to a specific commit (rather than the `main` branch) so the
        # model can't silently change out from under this pipeline.
        model_revision = "9744dcc920d813066391fc828d7a590207f148e8"
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        tokenizer = AutoTokenizer.from_pretrained(
            "adibvafa/CodonTransformer", revision=model_revision
        )
        model = BigBirdForMaskedLM.from_pretrained(
            "adibvafa/CodonTransformer", revision=model_revision
        ).to(device)

        # CodonTransformer emits a standalone CDS: it forces the first codon to
        # ATG, which *consumes* the real first residue (QVQLVES... came back as
        # MVQLVES..., one residue short). Prepending a Met gives that forced
        # ATG something of its own to land on, so every input residue is still
        # encoded by the model. Both ends are normalized away just below.
        output = predict_dna_sequence(
            protein="M" + protein_seq,
            organism=organism,
            device=device,
            tokenizer=tokenizer,
            model=model,
            attention_type="original_full",
            deterministic=True,
            # Defaults to False, which lets this masked LM return codons for
            # residues other than the ones asked for: (GGGGS)x3 came back as
            # KRKKSGGGGSGGGAS. On, the output is constrained to the input
            # protein. The translation check below stays as the backstop.
            match_protein=True,
        )
        # Read the DNA straight off the returned DNASequencePrediction.
        # format_model_output() is a Jupyter *display* helper that returns a
        # formatted str with no .predicted_dna, so the old path fell through
        # to str(formatted) and then kept every ACGT character - harvesting
        # letters out of the header text ("ORGANISM" -> GA, "ESCHERICHIA COLI
        # GENERAL" -> CCACGA, ...) and prepending them to the real sequence,
        # which planted a spurious TGA stop inside the coding sequence.
        dna_seq = output.predicted_dna.strip().upper()
        # Strip the model's own start/stop so dna_seq holds codons for the
        # protein alone, whichever stop codon the model happened to pick. The
        # add_start_stop block below is then the single place start/stop get
        # attached, identically for both the model and fallback paths.
        dna_seq = dna_seq.removeprefix(START_CODON)
        if dna_seq[-3:] in STOP_CODONS:
            dna_seq = dna_seq[:-3]
        # Verify the DNA actually encodes the requested protein. The model is a
        # masked LM, not a lookup: a (GGGGS)x3 linker came back translating to
        # KRKKSGGGGSGGGAS - right length, wrong residues. Checking length alone
        # would wave that through, so translate and compare, and fall back to
        # the deterministic table rather than emit DNA for a different protein.
        translated = "".join(
            CODON_TO_AA.get(dna_seq[i : i + 3], "?")
            for i in range(0, len(dna_seq) - len(dna_seq) % 3, 3)
        )
        if translated != protein_seq:
            raise ValueError(
                f"CodonTransformer returned DNA translating to {translated!r}, "
                f"expected {protein_seq!r}"
            )
        method = "CodonTransformer"
    # Deliberately broad: this is the gate to the deterministic fallback, and
    # what it has to absorb is wide-ranging and not all foreseeable - seen in
    # practice: ImportError (sklearn absent), OSError (libstdc++ ABI mismatch),
    # TypeError (upstream signature drift), plus model-download failures and
    # the ValueError raised above. Narrowing it would let an unanticipated
    # error take codon optimization down entirely rather than degrade.
    # Degradation is not silent: codon_optimize.py prints every warning to the
    # Live Console, and the returned `method` records which path produced the
    # sequence.
    except Exception as e:  # noqa: BLE001
        warnings.append(
            f"CodonTransformer tidak tersedia/gagal ({e}); menggunakan fallback tabel E. coli K-12."
        )
        dna_seq = fallback_optimize(protein_seq)
        method = "fallback_table (E. coli K-12 high-usage codon)"
        if "coli" not in organism.lower():
            warnings.append(
                f'Fallback hanya dikalibrasi untuk E. coli, bukan "{organism}".'
            )

    if add_start_stop:
        dna_seq = START_CODON + dna_seq + STOP_CODON

    cai_result = calculate_cai(dna_seq)
    return {
        "sequence_dna": dna_seq,
        "cai": round(cai_result["cai"], 4),
        "gc_content": round(gc_content(dna_seq), 2),
        "method": method,
        "organism": organism,
        "warnings": warnings,
    }
