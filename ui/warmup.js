// Maps' shaders built ahead of the map. A map's first opening waited on its shaders (a lit map
// material takes 0.3 to 0.8 s to build and a map asks for 25 to 35 of them; the next maps share most),
// and every update that changes them leaves the GPU's built copies behind. So each map opened leaves
// here the recipes of its materials' shaders (what Viewer.makeMaterial was given, the mesh it drew,
// the sun's shadows and the fog it was drawn under), and while the app sits idle outside Maps they are
// built again, 8 at a time side by side on the GPU process's threads (KHR_parallel_shader_compile, never
// waited on), against the viewer's scene set as a map's (its fog, the sun's shadows, no rim light, the
// post chain's target): the very programs a map asks for (three's cache keys), which the GPU's own shader
// cache then has. They are built at every start: those already built come straight from that cache (a
// few ms) and stay in its memory, which keeps only the last 6 MB it was handed.
import * as THREE from 'three';
import { treeLook, grassLook } from './foliage.js';

const KEY = 'xo.mapShaders.v1';
const MAX = 200;   // recipes kept (the ones seen last)
const IDLE = 1500; // ms without a key, the mouse or the wheel before a batch is built
const BATCH = 8;   // recipes built side by side
const SLOTS = ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'alphaMap']; // (what is set is part of a shader)
const ANY = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); // (a texture in a slot: never drawn)
ANY.needsUpdate = true;

// (a short name for a program: three's cache key is a long list of its settings)
const hash = (s) => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
};
// Materials made outside Viewer.makeMaterial name their recipe (material.userData.warmKind and
// warmArgs, plain data) and their maker registers here how to make one again: kind -> (args) => material.
export const builders = {};

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch { /* full or blocked: built when a map asks */ } };

// The recipes of the shaders a map's meshes draw with now (root: the map's), kept with the others.
export function noteShaders(viewer, root) {
  const R = viewer.renderer, byKey = new Map(load().map((q) => [q.key, q]));
  const shadows = viewer.key.castShadow, fog = !!viewer.scene.fog;
  let added = 0;
  root.traverse((o) => {
    const m = o.material;
    if (!o.isMesh || !m || Array.isArray(m)) return;
    const x = m.userData.xo, kind = m.userData.warmKind, cp = R.properties.get(m).currentProgram;
    if (!cp || (!kind && (!x?.info || x.lamp))) return;
    const key = hash(cp.cacheKey);
    if (!byKey.has(key)) added++;
    byKey.delete(key); // (to the end: seen last)
    const ck = m.customProgramCacheKey();
    byKey.set(key, {
      key, ...(kind ? { kind, args: m.userData.warmArgs || {} } : {
        mi: x.info, hasTangent: x.hasTangent, texMax: x.texMax, prop: m.defines.XO_DUST !== undefined, roughMin: x.u.xoRoughMin.value,
        look: ck.endsWith('-grass3') ? 'grass' : /-(leaves1|bark1|board1)$/.test(ck) ? 'tree' : null,
      }),
      attrs: Object.fromEntries(Object.entries(o.geometry.attributes).map(([k, a]) => [k, a.itemSize])),
      instanced: !!o.isInstancedMesh, instanceColor: !!o.instanceColor, shadows, fog,
      slots: SLOTS.filter((k) => m[k]), // (the textures it has: a cut-out shows only once its own are in)
    });
  });
  save([...byKey.values()]);
  return added;
}

// Builds the kept recipes while the app is idle outside Maps (busy: something else is going on, e.g.
// an export). left: recipes still to build; built: the cache keys built (tests).
export class ShaderWarmup {
  constructor(viewer, { busy = () => false } = {}) {
    this.v = viewer;
    this.busy = busy;
    this.queue = [];
    this.left = 0;
    this.built = [];
    this.last = performance.now();
    const input = () => { this.last = performance.now(); };
    for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(t, input, { passive: true, capture: true });
  }

  start() {
    this.queue = load().reverse(); // (the ones seen last first)
    this.left = this.queue.length;
    this.step();
  }

  step() {
    if (!this.queue.length) return;
    setTimeout(async () => {
      if (this.v.mode !== 'map' && !this.busy() && performance.now() - this.last >= IDLE) {
        const batch = this.queue.splice(0, BATCH);
        try { await this.build(batch); } catch (e) { console.warn('shader warm-up:', e?.message || e); }
        this.left = this.queue.length;
      }
      this.step();
    }, 250);
  }

  // Recipes built at once: started together (the GPU process builds them side by side), then waited for
  // without holding anything up.
  async build(batch) {
    const v = this.v, R = v.renderer, S = v.scene;
    const made = [];
    for (const q of batch) {
      try {
        const x = this.make(q);
        if (x) made.push(x);
      } catch (e) { console.warn('shader warm-up:', e?.message || e); }
    }
    // the viewer's scene as a map's, for the moment the builds start
    const fog = S.fog, cast = v.key.castShadow, rim = v.rim.visible, rt = R.getRenderTarget();
    v.rim.visible = false;
    try {
      R.setRenderTarget(v.post?.scene || null);
      for (const x of made) {
        S.fog = x.q.fog ? v.mapFog || new THREE.Fog(0xffffff, 1, 2) : null;
        v.key.castShadow = x.q.shadows;
        R.compile(x.tmp, v.camera, S);
      }
    } finally {
      S.fog = fog;
      v.key.castShadow = cast;
      v.rim.visible = rim;
      R.setRenderTarget(rt);
    }
    const programs = made.map((x) => R.properties.get(x.m).currentProgram);
    while (!programs.every((p) => !p || p.isReady())) await new Promise((f) => setTimeout(f, 20));
    for (const [i, x] of made.entries()) {
      if (programs[i]) this.built.push(programs[i].cacheKey);
      if (x.q.kind) x.m.dispose(); else v.disposeMaterial(x.m);
      x.g.dispose();
    }
  }

  // A recipe's material on a mesh like the map's (its geometry's streams, its copies and their colours).
  make(q) {
    const v = this.v;
    if (q.kind && !builders[q.kind]) return null; // (its maker is not loaded)
    const m = q.kind ? builders[q.kind](q.args) : v.makeMaterial(q.mi, q.hasTangent, { texMax: q.texMax, roughMin: q.roughMin, prop: q.prop });
    if (q.look === 'tree') treeLook(m, q.mi, { min: [-1, 0, -1], max: [1, 4, 1] });
    else if (q.look === 'grass') grassLook(m, { wind: 1, luminance: 10 }, 1, () => null);
    for (const k of SLOTS) m[k] = q.slots?.includes(k) ? m[k] || ANY : null; // (the map's material's textures, as it was drawn)
    const g = new THREE.BufferGeometry();
    for (const [k, n] of Object.entries(q.attrs)) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(3 * n), n));
    const mesh = q.instanced ? new THREE.InstancedMesh(g, m, 1) : new THREE.Mesh(g, m);
    if (q.instanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
    const tmp = new THREE.Scene();
    tmp.add(mesh);
    return { q, m, g, tmp };
  }
}
