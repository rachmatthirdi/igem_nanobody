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

from ecoli_codon_usage import calculate_cai, fallback_optimize, gc_content


def optimize_sequence(protein_seq, organism="Escherichia coli general"):
    protein_seq = protein_seq.strip().upper()
    warnings = []
    method = None
    dna_seq = None

    try:
        import torch
        from CodonTransformer.CodonJupyter import format_model_output
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

        output = predict_dna_sequence(
            protein=protein_seq,
            organism=organism,
            device=device,
            tokenizer=tokenizer,
            model=model,
            attention_type="original_full",
            deterministic=True,
        )
        formatted = format_model_output(output)
        dna_seq = getattr(formatted, "predicted_dna", None) or str(formatted)
        dna_seq = "".join(ch for ch in dna_seq.upper() if ch in "ACGT")
        method = "CodonTransformer"
    except Exception as e:
        warnings.append(
            f"CodonTransformer tidak tersedia/gagal ({e}); menggunakan fallback tabel E. coli K-12."
        )
        dna_seq = fallback_optimize(protein_seq)
        method = "fallback_table (E. coli K-12 high-usage codon)"
        if "coli" not in organism.lower():
            warnings.append(
                f'Fallback hanya dikalibrasi untuk E. coli, bukan "{organism}".'
            )

    cai_result = calculate_cai(dna_seq)
    return {
        "sequence_dna": dna_seq,
        "cai": round(cai_result["cai"], 4),
        "gc_content": round(gc_content(dna_seq), 2),
        "method": method,
        "organism": organism,
        "warnings": warnings,
    }
