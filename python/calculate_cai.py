"""Sharp & Li (1987) Codon Adaptation Index for a DNA sequence.
Usage: python calculate_cai.py --dna <sequence> --out <out.json>
"""
import argparse
import json

from ecoli_codon_usage import calculate_cai, gc_content


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dna', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    cai_result = calculate_cai(args.dna)
    result = {
        'cai': round(cai_result['cai'], 4),
        'numCodons': cai_result['numCodons'],
        'unknownCodons': cai_result['unknownCodons'],
        'gc_content': round(gc_content(args.dna), 2),
        'method': 'Sharp & Li (1987), Kazusa E. coli K-12 codon usage table',
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(result, f)

    print(f"CAI = {result['cai']:.4f} ({result['numCodons']} kodon)")


if __name__ == '__main__':
    main()
