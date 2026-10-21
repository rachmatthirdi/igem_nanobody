"""Unit tests for the pure-Python parts of python/ (standard library only).

Run from the repository root:
    python3 -m unittest discover -s tests -p "test_*.py" -v

These cover the logic that decides what ends up in the synthesis-ready insert:
restriction-site detection and removal, the E. coli codon table, the Codon
Adaptation Index, and GC content. They do not need Docker, numpy, or any model.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from codon_opt_core import strip_start_stop  # noqa: E402
from ecoli_codon_usage import (  # noqa: E402
    CODON_TO_AA,
    calculate_cai,
    fallback_optimize,
    gc_content,
)
from restriction_sites import find_sites, remove_internal_sites  # noqa: E402

PEPTIDE = "MKTAYIAKQRQISFVKSHFSRQ"


def translate(dna):
    return "".join(CODON_TO_AA[dna[i : i + 3]] for i in range(0, len(dna), 3))


class FindSitesTest(unittest.TestCase):
    def test_finds_ndei_and_xhoi_with_positions(self):
        hits = find_sites("AACATATGTTCTCGAGAA")
        self.assertEqual(hits, [("NdeI", 2, "CATATG"), ("XhoI", 10, "CTCGAG")])

    def test_adjacent_hits_are_both_reported(self):
        hits = find_sites("CATATGCATATG")
        self.assertEqual([h[1] for h in hits], [0, 6])

    def test_overlapping_hits_are_reported_separately(self):
        # The cloning sites cannot overlap themselves, so use a custom site.
        hits = find_sites("AAAA", {"poly": "AA"})
        self.assertEqual([h[1] for h in hits], [0, 1, 2])

    def test_no_site_returns_empty(self):
        self.assertEqual(find_sites("ATGGCTGCTTAA"), [])


class RemoveInternalSitesTest(unittest.TestCase):
    # NdeI flank + ATG GCT CAT ATG GCT (M A H M A) + stop + XhoI flank.
    # The in-frame CAT-ATG (His-Met) plants a second NdeI site at index 9.
    INSERT = "CATATG" + "GCT" + "CAT" + "ATG" + "GCT" + "TAA" + "CTCGAG"
    ALLOWED = {("NdeI", 0), ("XhoI", 21)}

    def test_removes_internal_site_without_changing_the_protein(self):
        before = translate(self.INSERT[3:18])
        seq, changes, unresolved = remove_internal_sites(
            self.INSERT, 3, 18, self.ALLOWED
        )
        self.assertEqual(unresolved, [])
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["residue"], "H")
        self.assertEqual(translate(seq[3:18]), before)
        self.assertEqual(len(seq), len(self.INSERT))
        offenders = [h for h in find_sites(seq) if (h[0], h[1]) not in self.ALLOWED]
        self.assertEqual(offenders, [])

    def test_flanking_sites_are_left_alone(self):
        seq, _, _ = remove_internal_sites(self.INSERT, 3, 18, self.ALLOWED)
        self.assertTrue(seq.startswith("CATATG"))
        self.assertTrue(seq.endswith("TAACTCGAG"))

    def test_reports_a_site_that_cannot_be_removed(self):
        # With an empty editable region nothing can be substituted, so the
        # site must be reported instead of silently shipped.
        seq, changes, unresolved = remove_internal_sites(self.INSERT, 3, 3, self.ALLOWED)
        self.assertEqual(seq, self.INSERT)
        self.assertEqual(changes, [])
        self.assertEqual(unresolved, [("NdeI", 9, "CATATG")])

    def test_clean_insert_is_returned_unchanged(self):
        clean = "CATATG" + "GCTGCTGCT" + "TAA" + "CTCGAG"
        seq, changes, unresolved = remove_internal_sites(
            clean, 3, 15, {("NdeI", 0), ("XhoI", 18)}
        )
        self.assertEqual((seq, changes, unresolved), (clean, [], []))


class CodonTableTest(unittest.TestCase):
    def test_fallback_optimize_round_trips_the_protein(self):
        dna = fallback_optimize(PEPTIDE)
        self.assertEqual(len(dna), 3 * len(PEPTIDE))
        self.assertEqual(translate(dna), PEPTIDE)

    def test_fallback_optimize_is_deterministic(self):
        self.assertEqual(fallback_optimize(PEPTIDE), fallback_optimize(PEPTIDE))

    def test_unknown_residue_becomes_nnn(self):
        self.assertEqual(fallback_optimize("AX"), fallback_optimize("A") + "NNN")


class CaiTest(unittest.TestCase):
    def test_all_best_codons_give_cai_of_one(self):
        result = calculate_cai(fallback_optimize(PEPTIDE))
        self.assertAlmostEqual(result["cai"], 1.0, places=9)
        self.assertEqual(result["numCodons"], len(PEPTIDE))
        self.assertEqual(result["unknownCodons"], [])

    def test_stop_codon_is_excluded(self):
        self.assertEqual(calculate_cai("ATGTAA")["numCodons"], 1)

    def test_unknown_codon_is_reported(self):
        self.assertEqual(calculate_cai("ATGNNN")["unknownCodons"], ["NNN"])

    def test_empty_sequence_gives_zero(self):
        self.assertEqual(calculate_cai("")["cai"], 0.0)

    def test_rare_codons_lower_the_index(self):
        best = calculate_cai(fallback_optimize("LLLL"))["cai"]
        rare = calculate_cai("CTACTACTACTA")["cai"]  # CTA is a rare Leu codon in E. coli
        self.assertLess(rare, best)


class GcContentTest(unittest.TestCase):
    def test_values(self):
        self.assertEqual(gc_content("GGCC"), 100.0)
        self.assertEqual(gc_content("ATAT"), 0.0)
        self.assertEqual(gc_content("ATGC"), 50.0)

    def test_empty_and_case(self):
        self.assertEqual(gc_content(""), 0.0)
        self.assertEqual(gc_content("gcat"), 50.0)


class StripStartStopTest(unittest.TestCase):
    def test_drops_start_and_stop(self):
        self.assertEqual(strip_start_stop("ATGAAATAA"), "AAA")

    def test_without_stop_only_drops_start(self):
        self.assertEqual(strip_start_stop("ATGAAA"), "AAA")

    def test_is_case_and_whitespace_tolerant(self):
        self.assertEqual(strip_start_stop(" atgaaataa\n"), "AAA")


if __name__ == "__main__":
    unittest.main()
