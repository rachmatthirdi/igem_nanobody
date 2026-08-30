"""
Score RF2-predicted nanobody candidates on 5 metrics: pLDDT, PAE, CDR RMSD,
H3 RMSD, ΔG (PRODIGY).

Usage:
  python score_candidates.py --rf2_dir <dir> --backbone_dir <dir> --cdr_json <cdr.json> --out <out.json>

Important caveat (also surfaced in the app): RFantibody's directory-mode RF2
output does not have a fully documented, versioned schema for per-candidate
confidence/metrics files. pLDDT is read from the predicted PDB's B-factor
column (the near-universal convention for per-residue confidence in
structure-prediction tools). PAE is looked up heuristically from a
same-stem companion metrics file (.json/.sc/_metrics.json/_scores.json) if
one exists next to the predicted PDB; if the file/keys aren't found it is
left null rather than guessed. CDR RMSD / H3 RMSD are computed directly here
via a manual Kabsch superposition (framework CA atoms) between each RF2
prediction and its originating RFdiffusion backbone, since RF2 does not
report per-loop RMSD itself.
"""

import argparse
import glob
import json
import os
import shutil
import subprocess

import numpy as np


def parse_ca_atoms(pdb_path, chain_id):
    """Returns {res_num: (np.array([x,y,z]), b_factor)} for CA atoms of a chain."""
    atoms = {}
    with open(pdb_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if not line.startswith("ATOM"):
                continue
            if line[21] != chain_id:
                continue
            if line[12:16].strip() != "CA":
                continue
            res_num = int(line[22:26])
            x, y, z = float(line[30:38]), float(line[38:46]), float(line[46:54])
            b_factor = float(line[60:66]) if line[60:66].strip() else 0.0
            atoms[res_num] = (np.array([x, y, z]), b_factor)
    return atoms


def kabsch(p, q):
    """Rotation R, translation t minimizing RMSD(R@p + t, q)."""
    p_mean, q_mean = p.mean(axis=0), q.mean(axis=0)
    pc, qc = p - p_mean, q - q_mean
    h = pc.T @ qc
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    dmat = np.diag([1.0, 1.0, d])
    r = vt.T @ dmat @ u.T
    t = q_mean - r @ p_mean
    return r, t


def rmsd(a, b):
    return float(np.sqrt(np.mean(np.sum((a - b) ** 2, axis=1))))


def compute_plddt(ca_atoms):
    if not ca_atoms:
        return None
    b_factors = [b for _, b in ca_atoms.values()]
    mean_b = sum(b_factors) / len(b_factors)
    return mean_b * 100 if mean_b <= 1.5 else mean_b


def find_plddt_sidecar(rf2_dir, stem):
    # RF2 leaves the predicted PDB's B-factor column zeroed rather than
    # writing per-residue pLDDT there, so compute_plddt() on the structure
    # itself always returns 0. The Electron main process parses RF2's stdout
    # for "Best pLDDT" and writes it to a same-stem sidecar instead - except
    # RF2's own stdout uses the design stem without the "_best" suffix that
    # ends up on the actual output PDB, so match by prefix like
    # match_backbone() does for the analogous backbone/candidate mismatch.
    sidecars = glob.glob(os.path.join(rf2_dir, "*_metrics.json"))
    bases = {os.path.basename(p)[: -len("_metrics.json")]: p for p in sidecars}
    matches = [b for b in bases if stem.startswith(b)]
    if not matches:
        return None
    path = bases[max(matches, key=len)]
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    val = data.get("plddt")
    if not isinstance(val, (int, float)):
        return None
    return val * 100 if val <= 1.5 else val


def find_pae(rf2_dir, stem):
    candidates = []
    for ext in (".json", ".sc", "_metrics.json", "_scores.json"):
        candidates.extend(glob.glob(os.path.join(rf2_dir, f"{stem}{ext}")))
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        val = _search_pae_key(data)
        if val is not None:
            return val
    return None


def _search_pae_key(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if "pae" in k.lower():
                if isinstance(v, (int, float)):
                    return float(v)
                if isinstance(v, list) and v and isinstance(v[0], (int, float)):
                    return float(sum(v) / len(v))
                if isinstance(v, list) and v and isinstance(v[0], list):
                    flat = [x for row in v for x in row]
                    if flat:
                        return float(sum(flat) / len(flat))
            found = _search_pae_key(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _search_pae_key(item)
            if found is not None:
                return found
    return None


def compute_dg(pdb_path):
    prodigy_exe = shutil.which("prodigy")
    if not prodigy_exe:
        print("WARNING: PRODIGY tidak ditemukan di PATH; ΔG dilewati.")
        return None
    try:
        out = (
            subprocess.check_output(
                [prodigy_exe, "-q", pdb_path, "--selection", "H", "T"],
                stderr=subprocess.STDOUT,
                timeout=120,
            )
            .decode("utf-8", errors="ignore")
            .strip()
        )
        last_line = out.splitlines()[-1]
        token = last_line.split()[-1]
        return float(token)
    except Exception as e:
        print(f"WARNING: PRODIGY gagal untuk {os.path.basename(pdb_path)}: {e}")
        return None


def match_backbone(candidate_stem, backbone_files):
    stems = {os.path.splitext(os.path.basename(b))[0]: b for b in backbone_files}
    matches = [s for s in stems if candidate_stem.startswith(s)]
    if matches:
        best = max(matches, key=len)
        return stems[best]
    if backbone_files:
        print(
            f"WARNING: tidak ada backbone yang cocok untuk {candidate_stem}, menggunakan {os.path.basename(backbone_files[0])} sebagai fallback."
        )
        return backbone_files[0]
    return None


def cdr_residues(cdr, keys):
    out = set()
    for k in keys:
        if k in cdr:
            out.update(cdr[k].get("residues", []))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rf2_dir", required=True)
    parser.add_argument("--backbone_dir", required=True)
    parser.add_argument("--cdr_json", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.cdr_json, "r", encoding="utf-8") as f:
        cdr = json.load(f)

    all_cdr_residues = cdr_residues(cdr, ["H1", "H2", "H3"])
    h3_residues = cdr_residues(cdr, ["H3"])

    backbone_files = sorted(glob.glob(os.path.join(args.backbone_dir, "*.pdb")))
    candidate_files = sorted(glob.glob(os.path.join(args.rf2_dir, "*.pdb")))

    candidates = []
    for pdb_path in candidate_files:
        stem = os.path.splitext(os.path.basename(pdb_path))[0]
        pred_atoms = parse_ca_atoms(pdb_path, "H")
        plddt = find_plddt_sidecar(args.rf2_dir, stem)
        if plddt is None:
            plddt = compute_plddt(pred_atoms)
        pae = find_pae(args.rf2_dir, stem)
        dg = compute_dg(pdb_path)

        cdr_rmsd, h3_rmsd = None, None
        backbone_path = match_backbone(stem, backbone_files)
        if backbone_path and pred_atoms:
            bb_atoms = parse_ca_atoms(backbone_path, "H")
            shared = set(pred_atoms) & set(bb_atoms)
            framework_res = sorted(shared - all_cdr_residues)
            if len(framework_res) >= 3:
                p_fw = np.array([pred_atoms[r][0] for r in framework_res])
                q_fw = np.array([bb_atoms[r][0] for r in framework_res])
                r_mat, t_vec = kabsch(p_fw, q_fw)

                cdr_res_present = sorted(shared & all_cdr_residues)
                if cdr_res_present:
                    p_cdr = np.array([pred_atoms[r][0] for r in cdr_res_present])
                    q_cdr = np.array([bb_atoms[r][0] for r in cdr_res_present])
                    p_cdr_aligned = (r_mat @ p_cdr.T).T + t_vec
                    cdr_rmsd = rmsd(p_cdr_aligned, q_cdr)

                h3_res_present = sorted(shared & h3_residues)
                if h3_res_present:
                    p_h3 = np.array([pred_atoms[r][0] for r in h3_res_present])
                    q_h3 = np.array([bb_atoms[r][0] for r in h3_res_present])
                    p_h3_aligned = (r_mat @ p_h3.T).T + t_vec
                    h3_rmsd = rmsd(p_h3_aligned, q_h3)
            else:
                print(
                    f"WARNING: residu framework tidak cukup untuk Kabsch alignment pada {stem}."
                )
        else:
            print(
                f"WARNING: tidak dapat menghitung CDR/H3 RMSD untuk {stem} (backbone/chain H tidak ditemukan)."
            )

        candidates.append(
            {
                "id": stem,
                "pdbPath": pdb_path,
                "plddt": round(plddt, 2) if plddt is not None else None,
                "pae": round(pae, 2) if pae is not None else None,
                "cdrRmsd": round(cdr_rmsd, 3) if cdr_rmsd is not None else None,
                "h3Rmsd": round(h3_rmsd, 3) if h3_rmsd is not None else None,
                "dg": round(dg, 2) if dg is not None else None,
            }
        )

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"candidates": candidates}, f)

    print(f"Scoring selesai untuk {len(candidates)} kandidat.")


if __name__ == "__main__":
    main()
