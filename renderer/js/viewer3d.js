// Cartoon-quality 3D structure viewer built on PDBe Molstar (a wrapper
// around Mol*, https://github.com/PDBeurope/pdbe-molstar) instead of the
// old hand-rolled three.js CA-trace renderer. Structures are generated
// locally by the design pipeline (no PDB ID), so they're loaded as
// `customData` from a blob: URL rather than fetched from PDBe by ID.
//
// PDBeMolstarPlugin's build is a plain IIFE that attaches itself to
// `window.PDBeMolstarPlugin` (see index.html) - it isn't a real ES module,
// so it's referenced as a global here rather than `import`-ed.

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this._plugin = null;
    this._ready = null; // promise chain: serializes render/load/select calls
    this._blobUrl = null;
    this._onResidueClick = null;

    container.addEventListener("PDB.molstar.click", (e) => {
      const d = e.eventData;
      if (!this._onResidueClick || !d) return;
      if (d.auth_asym_id === undefined || d.auth_seq_id === undefined) return;
      this._onResidueClick(d.auth_asym_id, d.auth_seq_id);
    });
  }

  onResidueClick(cb) {
    this._onResidueClick = cb;
  }

  loadPdb(pdbText) {
    const blobUrl = URL.createObjectURL(
      new Blob([pdbText], { type: "chemical/x-pdb" }),
    );
    const prevBlobUrl = this._blobUrl;
    this._blobUrl = blobUrl;

    this._ready = (this._ready || Promise.resolve()).then(async () => {
      if (!this._plugin) {
        this._plugin = new window.PDBeMolstarPlugin();
        await this._plugin.render(this.container, {
          customData: { url: blobUrl, format: "pdb", binary: false },
          bgColor: { r: 5, g: 7, b: 10 },
          hideControls: true,
          hideCanvasControls: ["expand"],
        });
      } else {
        await this._plugin.load({
          url: blobUrl,
          format: "pdb",
          isBinary: false,
        });
      }
      if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
    });
    return this._ready;
  }

  highlightResidues(chain, resNums) {
    this._ready = (this._ready || Promise.resolve()).then(async () => {
      if (!this._plugin) return;
      if (!resNums.length) {
        await this._plugin.visual.clearSelection();
        return;
      }
      await this._plugin.visual.select({
        data: resNums.map((resNum) => ({
          auth_asym_id: chain,
          auth_seq_id: resNum,
          color: "#ffffff",
          focus: false,
        })),
      });
    });
  }
}

window.Viewer3D = Viewer3D;
window.dispatchEvent(new Event("viewer3d-ready"));
