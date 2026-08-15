"""
Shared E. coli K-12 codon usage reference + CAI / fallback codon-optimization
core logic, used by calculate_cai.py, codon_optimize.py and
build_anchor_construct.py / build_plasmid.py.

Codon usage frequencies (per 1000 codons) are the standard, widely-reproduced
Kazusa Codon Usage Database table for Escherichia coli K-12 (GenBank CDS set,
taxonomy id 83333). Only used to rank synonymous codons relative to each
other (Sharp & Li 1987 CAI weights), so small absolute deviations from the
live Kazusa table do not change results materially. If exact reproducibility
against the live database matters, replace this table with a fresh export
from https://www.kazusa.or.jp/codon/.
"""
import math

CODON_USAGE_PER_1000 = {
    'TTT': 22.1, 'TTC': 16.6, 'TTA': 13.9, 'TTG': 13.5,
    'CTT': 11.6, 'CTC': 10.9, 'CTA': 3.9,  'CTG': 52.6,
    'ATT': 30.4, 'ATC': 24.8, 'ATA': 4.4,  'ATG': 27.9,
    'GTT': 18.3, 'GTC': 15.3, 'GTA': 10.9, 'GTG': 26.4,
    'TCT': 8.5,  'TCC': 8.6,  'TCA': 7.2,  'TCG': 8.6,
    'CCT': 7.0,  'CCC': 5.5,  'CCA': 8.6,  'CCG': 23.2,
    'ACT': 8.0,  'ACC': 22.8, 'ACA': 6.4,  'ACG': 14.0,
    'GCT': 15.3, 'GCC': 25.4, 'GCA': 20.5, 'GCG': 33.4,
    'TAT': 16.1, 'TAC': 12.1, 'TAA': 2.0,  'TAG': 0.3,
    'CAT': 12.5, 'CAC': 9.3,  'CAA': 15.1, 'CAG': 29.1,
    'AAT': 17.6, 'AAC': 21.6, 'AAA': 33.1, 'AAG': 10.0,
    'GAT': 32.1, 'GAC': 19.1, 'GAA': 39.4, 'GAG': 18.4,
    'TGT': 5.2,  'TGC': 6.4,  'TGA': 1.0,  'TGG': 13.9,
    'CGT': 20.9, 'CGC': 21.5, 'CGA': 3.6,  'CGG': 5.4,
    'AGT': 8.9,  'AGC': 15.2, 'AGA': 2.1,  'AGG': 1.2,
    'GGT': 24.7, 'GGC': 27.7, 'GGA': 8.1,  'GGG': 11.1,
}

CODON_TO_AA = {
    'TTT': 'F', 'TTC': 'F', 'TTA': 'L', 'TTG': 'L',
    'CTT': 'L', 'CTC': 'L', 'CTA': 'L', 'CTG': 'L',
    'ATT': 'I', 'ATC': 'I', 'ATA': 'I', 'ATG': 'M',
    'GTT': 'V', 'GTC': 'V', 'GTA': 'V', 'GTG': 'V',
    'TCT': 'S', 'TCC': 'S', 'TCA': 'S', 'TCG': 'S',
    'CCT': 'P', 'CCC': 'P', 'CCA': 'P', 'CCG': 'P',
    'ACT': 'T', 'ACC': 'T', 'ACA': 'T', 'ACG': 'T',
    'GCT': 'A', 'GCC': 'A', 'GCA': 'A', 'GCG': 'A',
    'TAT': 'Y', 'TAC': 'Y', 'TAA': '*', 'TAG': '*',
    'CAT': 'H', 'CAC': 'H', 'CAA': 'Q', 'CAG': 'Q',
    'AAT': 'N', 'AAC': 'N', 'AAA': 'K', 'AAG': 'K',
    'GAT': 'D', 'GAC': 'D', 'GAA': 'E', 'GAG': 'E',
    'TGT': 'C', 'TGC': 'C', 'TGA': '*', 'TGG': 'W',
    'CGT': 'R', 'CGC': 'R', 'CGA': 'R', 'CGG': 'R',
    'AGT': 'S', 'AGC': 'S', 'AGA': 'R', 'AGG': 'R',
    'GGT': 'G', 'GGC': 'G', 'GGA': 'G', 'GGG': 'G',
}

AA_TO_CODONS = {}
for _codon, _aa in CODON_TO_AA.items():
    AA_TO_CODONS.setdefault(_aa, []).append(_codon)

# Sharp & Li (1987) relative adaptiveness weights: w_ij = f_ij / max(f_i*)
_CODON_WEIGHTS = {}
for _aa, _codons in AA_TO_CODONS.items():
    if _aa == '*':
        continue
    max_freq = max(CODON_USAGE_PER_1000[c] for c in _codons)
    for c in _codons:
        _CODON_WEIGHTS[c] = CODON_USAGE_PER_1000[c] / max_freq


def best_codon_for_aa(aa):
    codons = [c for c in AA_TO_CODONS.get(aa.upper(), []) if aa.upper() != '*']
    if not codons:
        return None
    return max(codons, key=lambda c: CODON_USAGE_PER_1000[c])


def fallback_optimize(protein_seq):
    """Deterministic high-usage-codon substitution (no ML model required)."""
    codons = []
    for aa in protein_seq.strip().upper():
        codon = best_codon_for_aa(aa)
        if codon is None:
            codon = 'NNN'
        codons.append(codon)
    return ''.join(codons)


def calculate_cai(dna_seq):
    """Sharp & Li (1987) Codon Adaptation Index for a DNA coding sequence."""
    seq = dna_seq.strip().upper().replace('U', 'T')
    codons = [seq[i:i + 3] for i in range(0, len(seq) - len(seq) % 3, 3)]
    log_weights = []
    unknown = []
    for codon in codons:
        aa = CODON_TO_AA.get(codon)
        if aa is None:
            unknown.append(codon)
            continue
        if aa == '*':
            continue  # stop codons excluded from CAI, standard practice
        w = _CODON_WEIGHTS.get(codon, 1.0)
        log_weights.append(math.log(w) if w > 0 else math.log(1e-6))

    if not log_weights:
        return {'cai': 0.0, 'numCodons': 0, 'unknownCodons': unknown}

    cai = math.exp(sum(log_weights) / len(log_weights))
    return {'cai': cai, 'numCodons': len(log_weights), 'unknownCodons': unknown}


def gc_content(dna_seq):
    seq = dna_seq.strip().upper()
    if not seq:
        return 0.0
    gc = sum(1 for b in seq if b in ('G', 'C'))
    return (gc / len(seq)) * 100.0
