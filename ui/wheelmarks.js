// The garage's augmented-reality marks on wheels (shown with the weld points, F): beside each
// wheel's hub a coil spring between up / down arrows (its suspension), and at the foot of a
// steering wheel the steering symbol inside a turning arrow, drawn over the tyre. The spring and
// the arrow ring are the game's own AR models (models/augmented_reality/spring.mdl and
// decals_locator.mdl, read from its archives), the symbol is its icon ui/textures/svg/icn_steering.svg.
import * as THREE from 'three';

const SPRING = 'models/augmented_reality/spring.mdl';
const RING = 'models/augmented_reality/decals_locator.mdl';
const ICON = 'ui/textures/svg/icn_steering.svg';

export const isWheel = (path) => (path || '').startsWith('models/constructor/chassis/wheels/');

export class WheelMarks {
  constructor(viewer, getInfo) {
    this.v = viewer;
    this.getInfo = getInfo;
    this.group = new THREE.Group();
    this.group.name = 'wheel-marks';
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthWrite: false });
    this.overMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
    this.arrow = new THREE.ConeGeometry(0.022, 0.055, 12);
    this.parts = null; // { spring, ring, icon } once loaded
  }

  // The game's models and icon (once per game data; flush() after a change of game folder).
  load() {
    if (!this.loading) {
      const geometry = async (path) => {
        const g = await this.v.makeModel(await this.getInfo(path), 0);
        const geo = g.children.find((c) => c.isMesh)?.geometry || null;
        this.templates = [...(this.templates || []), g]; // keeps the cached geometry alive
        return geo;
      };
      const icon = fetch('https://xo.data/raw?path=' + encodeURIComponent(ICON)).then((r) => (r.ok ? r.text() : Promise.reject(new Error('no icon'))))
        .then((svg) => new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = 128;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 8, 8, 112, 112);
            ctx.globalCompositeOperation = 'source-in'; // the icon's shape, in white
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 128, 128);
            const t = new THREE.CanvasTexture(c);
            t.colorSpace = THREE.SRGBColorSpace;
            res(t);
          };
          img.onerror = rej;
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/(fill|stroke)="(?!none)[^"]*"/g, '$1="#ffffff"'));
        }))
        .catch(() => null);
      this.loading = Promise.all([geometry(SPRING).catch(() => null), geometry(RING).catch(() => null), icon])
        .then(([spring, ring, icon]) => (this.parts = { spring, ring, icon }));
    }
    return this.loading;
  }

  flush() {
    this.clear();
    for (const g of this.templates || []) this.v.disposeModel(g);
    this.templates = null;
    this.parts?.icon?.dispose();
    this.parts = null;
    this.loading = null;
  }

  clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if (c.userData.own) { c.geometry.dispose(); if (c.material !== this.lineMat) c.material.dispose(); }
    }
  }

  // wheels: [{ inst, steer }] (visible ones only); on: AR is showing.
  async update(wheels, on) {
    const token = (this.token = (this.token || 0) + 1);
    if (!on || !wheels.length) { this.clear(); this.v.dirty = true; return; }
    await this.load();
    if (token !== this.token) return; // a newer update came in while the models loaded
    this.clear();
    const { spring, ring, icon } = this.parts;
    for (const { inst, steer } of wheels) {
      const g = inst.group;
      g.updateMatrixWorld(true);
      const box = g.userData.box;
      const M = g.matrixWorld;
      // the axle points out of the vehicle along the wheel's -X (its mount is at x = 0)
      const hubLocal = box.getCenter(new THREE.Vector3());
      const outLocal = new THREE.Vector3(box.min.x, hubLocal.y, hubLocal.z);
      const hub = hubLocal.clone().applyMatrix4(M), outer = outLocal.applyMatrix4(M);
      const axle = outer.clone().sub(hub);
      if (axle.lengthSq() < 1e-8) axle.set(-1, 0, 0).transformDirection(M);
      axle.normalize();
      const radius = (box.max.y - box.min.y) / 2;
      const side = outer.clone().addScaledVector(axle, 0.04);
      // suspension: an up / down arrow line from the hub to above the tyre, the spring on its upper part
      const top = side.clone().add(new THREE.Vector3(0, radius * 1.25, 0));
      this.group.add(this.line([side, top]), this.line([side, side.clone().addScaledVector(axle, Math.max(0.12, radius * 0.45))]));
      this.group.add(this.cone(top, 1), this.cone(side.clone().add(new THREE.Vector3(0, 0.03, 0)), -1));
      if (spring) {
        const s = new THREE.Mesh(spring, this.mat);
        const len = radius * 0.75;
        s.scale.setScalar(len / 0.285);
        s.rotation.x = -Math.PI / 2; // the model lies along +Z: stand it up
        s.position.copy(side).add(new THREE.Vector3(0, radius * 0.25, 0));
        this.group.add(s);
      }
      // steering: the symbol in its turning arrow at the wheel's foot, beside the tyre
      if (steer) {
        const foot = side.clone().addScaledVector(axle, radius * 0.35);
        foot.y = new THREE.Box3().copy(box).applyMatrix4(M).min.y + 0.01;
        const size = radius * 1.1;
        if (ring) {
          const r = new THREE.Mesh(ring, this.overMat);
          r.scale.setScalar(size / 0.3);
          r.position.copy(foot);
          r.renderOrder = 7;
          this.group.add(r);
        }
        if (icon) {
          const m = new THREE.MeshBasicMaterial({ map: icon, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
          const p = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.55, size * 0.55), m);
          p.userData.own = true; // (its own geometry and material: freed with it)
          p.rotation.x = -Math.PI / 2;
          p.position.copy(foot).add(new THREE.Vector3(0, 0.002, 0));
          p.renderOrder = 8;
          this.group.add(p);
        }
      }
    }
    this.v.dirty = true;
  }

  line(points) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), this.lineMat);
    l.renderOrder = 6;
    l.userData.own = true; // (its own geometry)
    return l;
  }

  cone(at, dir) {
    const c = new THREE.Mesh(this.arrow, this.mat);
    c.position.copy(at);
    if (dir < 0) c.rotation.z = Math.PI;
    return c;
  }
}
