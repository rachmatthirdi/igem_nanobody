"""CLI wrapper around codon_opt_core.optimize_sequence.
Usage: python codon_optimize.py --protein <AA_SEQ> --organism "<name>" --out <out.json>
"""

import argparse
import json

from codon_opt_core import optimize_sequence


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--protein", required=True)
    parser.add_argument("--organism", default="Escherichia coli general")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    result = optimize_sequence(args.protein, args.organism)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f)

    for w in result["warnings"]:
        print(f"WARNING: {w}")
    print(f"Codon optimization selesai ({result['method']}), CAI={result['cai']:.4f}")


if __name__ == "__main__":
    main()
