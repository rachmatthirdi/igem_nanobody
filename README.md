# Nanobody Designer

Desktop GUI (Electron) untuk pipeline desain nanobody: **Target → Desain → Screening → Konstruk**, mengorkestrasi RCSB PDB, InterPro, FreeSASA, DiscoTope-3.0, RFantibody (RFdiffusion/ProteinMPNN/RF2), PRODIGY, CodonTransformer, dan UniProt.

## Menjalankan aplikasi

```bash
npm install
npm start
```

Aplikasi akan langsung terbuka dan berfungsi penuh untuk:
- Tab **Target**: download PDB, InterPro, FreeSASA (jika env `nanobody-tools` sudah ada), hotspot/epitope map, viewer 3D.
- Tab **Screening**, **Konstruk**: filter, composite score, import manual, codon optimization (fallback tabel jika CodonTransformer belum terpasang), plasmid/FASTA export.
- Save/Load proyek, Live Console, Settings.

Untuk DiscoTope-3.0 dan seluruh pipeline AI (RFdiffusion/ProteinMPNN/RF2) di Tab **Desain**, environment eksternal perlu disiapkan lebih dulu (lihat di bawah) — GUI-nya sudah lengkap dan akan memanggil tool sungguhan begitu path-nya dikonfigurasi di Settings (⚙️ di header).

## Menyiapkan environment eksternal

Skrip `
chmod +x scripts/setup_environment.sh
./scripts/setup_environment.sh` 
**tidak dijalankan otomatis**. Baca isinya, lalu jalankan sendiri saat siap:

Skrip ini menginstal Miniconda, membuat conda env `nanobody-tools` dan `discotope`, meng-clone dan memasang DiscoTope-3.0. **RFantibody** (RFdiffusion/ProteinMPNN/RF2) memakai `uv` dan skrip bash yang ditujukan untuk Linux+CUDA — tidak didukung native di Windows, jadi dijalankan lewat **WSL2** (default) atau **Docker Desktop dengan GPU passthrough**; skrip ini mencetak perintah persis yang perlu dijalankan di dalam WSL.

Setelah environment siap, buka **Settings** (⚙️) di aplikasi dan isi:
- Conda env untuk tools (`nanobody-tools`) dan DiscoTope (`discotope`)
- Path repository DiscoTope-3.0
- Path instalasi RFantibody + mode eksekusi (WSL/Docker/Native)

## Batasan jujur (apa yang sudah teruji vs. belum)

Dikembangkan di lingkungan tanpa GPU NVIDIA, jadi:

**Sudah diuji end-to-end di lingkungan pengembangan** (Node 22, Python 3.12, akses internet): download PDB dari RCSB, ekstraksi Chain A, InterPro API, judul struktur data.rcsb.org, fetch UniProt (anchor + PelB), hotspot/domain/SASA/DiscoTope tracks di UI, viewer 3D, save/load proyek, perhitungan CAI, fallback codon table, perakitan plasmid/FASTA.

**Kode orkestrasi sudah ditulis mengikuti CLI/API asli tiap tool (diverifikasi dari repo aslinya), tapi BELUM bisa dijalankan/diuji di lingkungan ini** karena butuh GPU NVIDIA + instalasi besar di mesin Anda sendiri:
- DiscoTope-3.0 (`discotope3/main.py --pdb_dir ... --out_dir ...`)
- RFdiffusion/ProteinMPNN/RF2 via RFantibody (`uv run rfdiffusion|proteinmpnn|rf2 ...`, dijalankan lewat WSL/Docker)
- CodonTransformer (mengunduh model dari HuggingFace saat pertama dipakai)
- PRODIGY (`prodigy -q <pdb> --selection H T`)

Skema file output RF2 (pLDDT/PAE per kandidat) **belum 100% terdokumentasi resmi** oleh RFantibody untuk mode direktori — `python/score_candidates.py` membaca pLDDT dari kolom B-factor (konvensi umum), mencari file metrics pendamping secara heuristik untuk PAE, dan menghitung CDR/H3 RMSD sendiri lewat superposisi Kabsch manual. Jika skema sebenarnya berbeda di mesin Anda, sesuaikan `find_pae()` di file tersebut — jalur "Import Manual Metrics" di Tab Screening juga tersedia sebagai jalan pintas.

## Struktur proyek

```
electron/       main.js (IPC + orkestrasi subprocess), preload.js
renderer/       index.html, css/, js/ (per-tab logic + viewer 3D)
python/         FreeSASA, CAI, codon optimization, scoring, anchor/plasmid builder
scripts/        setup_environment.ps1 (instalasi Miniconda/DiscoTope/RFantibody - manual)
cache/          hasil fetch PDB/InterPro/anchor (offline-first)
projects/       proyek tersimpan (JSON)
output/         FASTA final siap sintesis
work/           file kerja sementara pipeline (dibuat otomatis)
```
