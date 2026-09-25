"""Screen an assembled insert for internal restriction sites and remove them.

build_plasmid.py flanks the insert with NdeI (CATATG) and XhoI (CTCGAG) so it
can be ligated into pET-28a(+)/pET-22b(+). Codon optimization upstream of that
is free to pick any synonymous codon, so nothing stops it from planting a
second CATATG or CTCGAG *inside* the insert - and a single internal copy makes
the double digest cut the insert into pieces instead of releasing it intact,
which fails the cloning silently at the bench rather than loudly in the app.

The fix is frame-aware synonymous substitution: an internal site always
overlaps one to three codons of the CDS, and swapping any one of them for a
synonymous codon that breaks the recognition sequence leaves the protein
identical. Substitutions are re-scanned after every pass because a swap can
plant a new site of its own.
"""

from ecoli_codon_usage import AA_TO_CODONS, CODON_TO_AA, CODON_USAGE_PER_1000

# The cloning enzymes build_plasmid.py uses. Both are palindromic, so one
# strand's recognition sequence is enough - no reverse complement needed.
RESTRICTION_SITES = {"NdeI": "CATATG", "XhoI": "CTCGAG"}


def find_sites(seq, sites=RESTRICTION_SITES):
    """All occurrences of every site, as (name, index, site), left to right.

    Overlapping hits count separately (start is advanced by 1, not by
    len(site)) so a run like CATATGCATATG reports both.
    """
    hits = []
    for name, site in sites.items():
        start = 0
        while True:
            idx = seq.find(site, start)
            if idx < 0:
                break
            hits.append((name, idx, site))
            start = idx + 1
    return sorted(hits, key=lambda h: h[1])


def _synonymous_codons(codon):
    """Alternative codons for the same residue, highest E. coli usage first.

    Returns nothing for stop codons and for anything not in the standard
    table, so neither can be substituted away.
    """
    aa = CODON_TO_AA.get(codon)
    if aa is None or aa == "*":
        return []
    return sorted(
        (c for c in AA_TO_CODONS[aa] if c != codon),
        key=lambda c: CODON_USAGE_PER_1000[c],
        reverse=True,
    )


def remove_internal_sites(
    insert,
    cds_start,
    cds_end,
    allowed,
    sites=RESTRICTION_SITES,
    max_passes=200,
):
    """Removes restriction sites from `insert` by synonymous substitution.

    cds_start/cds_end bound the region that may be edited: the coding
    sequence, excluding the stop codon and the flanking cloning sites.
    cds_start must be the first base of a codon, and both are 0-based with
    cds_end exclusive.

    `allowed` is the set of (name, index) occurrences that are supposed to be
    there - the flanking NdeI/XhoI sites the caller added deliberately.

    Returns (sequence, changes, unresolved). `changes` records every
    substitution made; `unresolved` lists any site that no synonymous swap
    could remove, so the caller can surface it rather than ship a construct
    that won't digest.
    """
    seq = insert
    changes = []

    def offenders(s):
        return [h for h in find_sites(s, sites) if (h[0], h[1]) not in allowed]

    for _ in range(max_passes):
        current = offenders(seq)
        if not current:
            return seq, changes, []

        name, idx, site = current[0]
        # Codons overlapping [idx, idx + len(site)). Floor division keeps this
        # correct even when the site starts before cds_start (the flanking
        # NdeI overlaps the ATG codon), since those codons are skipped below.
        first_codon = cds_start + ((idx - cds_start) // 3) * 3
        fixed = False

        for codon_start in range(first_codon, idx + len(site), 3):
            if codon_start < cds_start or codon_start + 3 > cds_end:
                continue
            codon = seq[codon_start : codon_start + 3]
            for alt in _synonymous_codons(codon):
                candidate = seq[:codon_start] + alt + seq[codon_start + 3 :]
                # Accept only a net improvement: a swap that removes this site
                # but plants another one elsewhere leaves us no better off.
                if len(offenders(candidate)) < len(current):
                    changes.append(
                        {
                            "enzyme": name,
                            "site": site,
                            "position": idx,
                            "codonPosition": codon_start,
                            "from": codon,
                            "to": alt,
                            "residue": CODON_TO_AA.get(codon),
                        }
                    )
                    seq = candidate
                    fixed = True
                    break
            if fixed:
                break

        if not fixed:
            # Nothing synonymous breaks this site - e.g. it sits entirely in
            # the fixed flanks, or every alternative codon re-creates one.
            return seq, changes, current

    return seq, changes, offenders(seq)


def describe(changes, unresolved):
    """Human-readable lines for the Live Console / FASTA header."""
    lines = []
    for c in changes:
        lines.append(
            f"{c['enzyme']} site at bp {c['position'] + 1} removed: "
            f"{c['from']}->{c['to']} ({c['residue']}) at bp {c['codonPosition'] + 1}"
        )
    for name, idx, _site in unresolved:
        lines.append(
            f"WARNING: internal {name} site at bp {idx + 1} could not be removed "
            f"by synonymous substitution - this insert will not digest cleanly."
        )
    return lines
