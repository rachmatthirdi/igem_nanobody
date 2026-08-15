// Simple CA-trace 3D structure viewer (three.js). Not a full cartoon/ribbon
// renderer - draws a tube along the CA backbone per chain plus small spheres
// per residue for picking/hotspot highlighting. Good enough to orient the
// user and let them click residues; not publication-grade.
import * as THREE from '../../node_modules/three/build/three.module.js';
import { OrbitControls } from '../../node_modules/three/examples/jsm/controls/OrbitControls.js';

const CHAIN_COLORS = {
  A: 0x4f8cff, // target / antigen
  H: 0x33c37c, // nanobody heavy chain
  L: 0xe0b13a,
  T: 0x4f8cff,
};
const DEFAULT_COLORS = [0xe0684f, 0x9b6fe0, 0x4fd0e0, 0xe04fa8, 0x8ce04f];

function parseCaAtoms(pdbText) {
  const chains = {};
  for (const line of pdbText.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue;
    if (line.slice(12, 16).trim() !== 'CA') continue;
    const chain = line.charAt(21);
    const resNum = parseInt(line.slice(22, 26), 10);
    const x = parseFloat(line.slice(30, 38));
    const y = parseFloat(line.slice(38, 46));
    const z = parseFloat(line.slice(46, 54));
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
    if (!chains[chain]) chains[chain] = [];
    chains[chain].push({ resNum, x, y, z });
  }
  return chains;
}

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070a);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const light1 = new THREE.DirectionalLight(0xffffff, 1.2);
    light1.position.set(1, 1, 1);
    this.scene.add(light1);
    this.scene.add(new THREE.AmbientLight(0x808090, 1.0));

    this.residueMeshes = []; // { mesh, chain, resNum }
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.raycaster = new THREE.Raycaster();
    this._onResidueClick = null;

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.renderer.domElement.addEventListener('click', (e) => this._handleClick(e));

    this._animate();
  }

  _resize() {
    const w = this.container.clientWidth || 300;
    const h = this.container.clientHeight || 300;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  onResidueClick(cb) {
    this._onResidueClick = cb;
  }

  _handleClick(event) {
    if (!this._onResidueClick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.residueMeshes.map((r) => r.mesh));
    if (hits.length) {
      const hit = this.residueMeshes.find((r) => r.mesh === hits[0].object);
      if (hit) this._onResidueClick(hit.chain, hit.resNum);
    }
  }

  loadPdb(pdbText) {
    this.group.clear();
    this.residueMeshes = [];

    const chains = parseCaAtoms(pdbText);
    const chainIds = Object.keys(chains);
    let colorIdx = 0;
    const box = new THREE.Box3();

    for (const chainId of chainIds) {
      const atoms = chains[chainId].sort((a, b) => a.resNum - b.resNum);
      if (atoms.length < 2) continue;
      const color = CHAIN_COLORS[chainId] ?? DEFAULT_COLORS[colorIdx++ % DEFAULT_COLORS.length];

      const points = atoms.map((a) => new THREE.Vector3(a.x, a.y, a.z));
      const curve = new THREE.CatmullRomCurve3(points);
      const tubeGeom = new THREE.TubeGeometry(curve, Math.max(points.length * 2, 8), 0.4, 6, false);
      const tubeMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
      const tube = new THREE.Mesh(tubeGeom, tubeMat);
      this.group.add(tube);

      const sphereGeom = new THREE.SphereGeometry(0.55, 8, 8);
      for (const atom of atoms) {
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
        const sphere = new THREE.Mesh(sphereGeom, mat);
        sphere.position.set(atom.x, atom.y, atom.z);
        this.group.add(sphere);
        this.residueMeshes.push({ mesh: sphere, chain: chainId, resNum: atom.resNum, baseColor: color });
        box.expandByPoint(sphere.position);
      }
    }

    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      this.group.position.sub(center);
      this.camera.position.set(0, 0, Math.max(size, 20));
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  highlightResidues(chain, resNums) {
    const set = new Set(resNums);
    for (const entry of this.residueMeshes) {
      if (entry.chain !== chain) continue;
      const selected = set.has(entry.resNum);
      entry.mesh.material.emissive = new THREE.Color(selected ? 0xffffff : 0x000000);
      entry.mesh.material.emissiveIntensity = selected ? 0.7 : 0;
      entry.mesh.scale.setScalar(selected ? 1.6 : 1);
    }
  }
}

window.Viewer3D = Viewer3D;
window.dispatchEvent(new Event('viewer3d-ready'));
