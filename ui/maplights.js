// A map's own lights in Maps mode (/mapscene lights: the game's Lights_ entities, xo::MapLight):
//  - point lights and projectors light what is around them: the ones nearest the camera (by the
//    distance to the sphere they reach) are lit, picked again as the camera moves (bucket) and faded
//    out towards the last one picked: three's PointLight and SpotLight as their records, kept out of
//    the scene and lit by xolights.js's one shader loop (litNow). A picked light keeps its slot while it
//    stays picked; the ones the game keeps from shining through walls (shadows: shadowsEnabled or
//    enableSSCS) get their shadow drawn in their slot's block of lampshadows.js's atlas and stay dark
//    until it is in. Those with specularEnabled 0 do not shine on gloss.
//  - flares, the glow of a lamp's bulb or glass: sprites added onto the view at their luminance,
//    showing in the angle around the lamp's direction the game gives them
//  - beams, a lamp's light seen in the air: the game's beam sprite along the lamp's direction, turned
//    about it to face the camera, added onto the view
// Flares and beams dim with the fog between them and the camera (fog.js: what gets through it; the
// fog's own colour is in the view under them already)
// How bright: the game's own units at the environment's exposure, with the same factor as its sun
// (sky.js presetLevels), times the environment's EmissiveLumScale (2^EV) on all of it: the game dims
// its lamps' light with their glow at night (-2 .. -3 EV) and brightens it on some days, so a lamp
// is lost in the noon sun and lights the street at night; which lamps are on at all is the map's
// doing (a light lists the environments it is on in, the host filters by them). Flickering lights
// flicker, 30 times a second while one of them is lit.
import * as THREE from 'three';
import { FOG_GLSL, FOG_UNIFORMS } from './fog.js';
import { PROBE_UNIT } from './sky.js';
import { LampShadows, POINTS, SPOTS, POINT_NEAR } from './lampshadows.js'; // (POINTS: the spots' slots start there)
import { addLights, removeLights, packLights } from './xolights.js';

const MAX_POINT = POINTS, MAX_SPOT = SPOTS; // real lights at once (each one costs every pixel of the view)
const SHADE_NEW = 2;     // lamps' shadows drawn per frame for lamps just picked (they are dark until then)
const SHADE_AGAIN = 400; // ms: a lamp's shadow drawn again at most this often while the map's content changes
const REACH = 400; // metres: lights further than this from the camera are not picked
// What the view shows per game unit of light, against the sun's own factor: a light of power 1 gives
// LIGHT_GAIN game units of illuminance at 1 m (power / distance² with linearFalloff 0, the same unit
// without the square with linearFalloff 1), times 2^EmissiveLumScale. Checked against the game's
// captures (light_probes: their HDR against the view's at the probe centre, the lamps' light on what
// they reach, over the light around it in both): newyear_foray's porch lamps light their wall and
// the snow 4 times brighter in the noon capture (EmissiveLumScale 0) than in the night's (-2), in
// the captures' own units, the same lamps; with that factor the 160 fitted before still holds
// (median 159 over 17 views of newyear_foray's night and noon, bentmetal's rain and dark-fog sunset,
// chemical_plant's Halloween; cityruin's and the hangar's captures, older than their maps, show
// theirs 2-4 times dimmer). Flares, beams and glowing decals: their luminance (2^EV100 / 8 game
// units) times 2^EmissiveLumScale as it is (bentmetal's lava with newyear_foray's light_quad decals
// at a median 0.93 of that in the first fit; light_quad, now laid on both roof slopes by its opacity x
// AlbedoOpacity (mapview.js decalMaterial), at a median 0.76 over 6 views of the night capture and
// 1.03 over 4 of the noon one).
const LIGHT_GAIN = 160, GLOW_GAIN = 1;
const DAY_PER_LUX = 2.5 / 630; // without the game's sky: the plain sky's sun for a clear day's sunlight
// added onto the colour; the view's alpha stays as it is (post.js divides the colour by it)
const ADDED = {
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
};

const FLARE_VERT = /* glsl */ `
attribute vec3 iPos, iDir, iColor;
attribute vec4 iShape; // size, nebulosity, cos of half the angle it shows in, flicker seed (-1: none)
uniform float uGain, uTime;
${FOG_GLSL}
varying vec2 vXy;
varying vec3 vColor;
varying float vSoft;
float xoNoise(float t) { float i = floor(t), f = fract(t); vec2 h = fract(sin(vec2(i, i + 1.0) * 12.9898) * 43758.5453); return mix(h.x, h.y, f * f * (3.0 - 2.0 * f)); }
void main() {
  vec3 toCam = cameraPosition - iPos;
  float d = length(toCam);
  float facing = dot(iDir, toCam / max(d, 1e-4));
  float shows = smoothstep(iShape.z - 0.08, iShape.z + 0.08, facing);
  float flick = iShape.w < 0.0 ? 1.0 : 0.65 + 0.35 * xoNoise(uTime * 9.0 + iShape.w);
  vColor = iColor * uGain * shows * flick * exp2(-xoFogLine(iPos - cameraPosition, xoFogA.w));
  vSoft = iShape.y;
  vXy = position.xy * 2.0;
  // a camera-facing quad, pulled towards the camera so the lamp's own glass does not cut it
  vec4 c = viewMatrix * vec4(iPos + toCam / max(d, 1e-4) * min(iShape.x * 0.5, d * 0.5), 1.0);
  float size = max(iShape.x, -c.z * 0.004); // (at least a few pixels: far lamps still twinkle)
  c.xy += position.xy * size;
  gl_Position = projectionMatrix * c;
  if (shows <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
// The game's flare sprite (textures/flare, its round top: 64 px, its luminance 1 at the middle, 0 at
// the quad's edge) is (1 - r)^2.15 (1 + 1.5 r) to within 1.3 %; a nebulous flare (nebulosity: 0 or
// 0.47 on every map) softer towards (1 - r²)², the game's use of it unknown.
const FLARE_FRAG = /* glsl */ `
varying vec2 vXy;
varying vec3 vColor;
varying float vSoft;
void main() {
  float r = length(vXy);
  if (r >= 1.0) discard;
  float s = pow(1.0 - r, 2.15) * (1.0 + 1.5 * r), q = 1.0 - r * r;
  gl_FragColor = vec4(vColor * mix(s, q * q, vSoft), 1.0);
}`;

const BEAM_VERT = /* glsl */ `
attribute vec3 iPos, iDir, iColor;
attribute vec3 iShape; // length, width, flicker seed (-1: none)
uniform float uGain, uTime;
${FOG_GLSL}
varying vec3 vColor;
varying vec2 vUv;
float xoNoise(float t) { float i = floor(t), f = fract(t); vec2 h = fract(sin(vec2(i, i + 1.0) * 12.9898) * 43758.5453); return mix(h.x, h.y, f * f * (3.0 - 2.0 * f)); }
void main() {
  // the quad along the lamp's direction, turned about it to face the camera (from its middle: one plane)
  vec3 side = cross(iDir, cameraPosition - (iPos + iDir * iShape.x * 0.5));
  side = dot(side, side) > 1e-8 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  vec3 w = iPos + iDir * (position.y * iShape.x) + side * (position.x * iShape.y);
  float d = length(cameraPosition - w);
  float flick = iShape.z < 0.0 ? 1.0 : 0.65 + 0.35 * xoNoise(uTime * 9.0 + iShape.z);
  vColor = iColor * uGain * flick * exp2(-xoFogLine(w - cameraPosition, xoFogA.w)) * smoothstep(0.5, 4.0, d);
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
// The game's beam sprite (textures/beam, 128 x 128: the lamp at the top, a round bright head as wide
// as a fifth of the sprite, a cone widening to three quarters of it and fading out at the far end),
// to within 2.7 % rms: along it 1 for the first fifth then exp(-3.2 (t - 0.2)), gone by the end;
// across 1 - x² / R² with R = 1.41 (0.06 + 0.32 t^0.8) of the width; the head's round top 4 x².
const BEAM_FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
void main() {
  float x = vUv.x, t = vUv.y;
  float c = min(1.0, exp(-3.2 * (t - 0.2))) * smoothstep(-0.02, 0.02, t - 4.0 * x * x) * (1.0 - smoothstep(0.75, 1.0, t));
  float R = 1.41421 * (0.06 + 0.32 * pow(max(t, 0.0), 0.8));
  gl_FragColor = vec4(vColor * c * max(0.0, 1.0 - x * x / (R * R)), 1.0);
}`;

const lin = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

export class MapLights {
  // list: /mapscene lights (glTF space)
  constructor(viewer, list) {
    this.v = viewer;
    this.group = new THREE.Group();
    this.group.name = 'lights';
    this.perLux = DAY_PER_LUX;
    this.lum = 1; // the environment's EmissiveLumScale, 2^EV
    // what the view shows per game unit of luminance (EV100: 2^EV / 8), for whatever glows at a given
    // luminance: flares, beams, glowing decals (mapview.js decalMaterial)
    this.glow = { value: DAY_PER_LUX * GLOW_GAIN };
    this.shown = true;
    this.time = 0; // (seconds, for the flicker)
    this.ticked = 0;
    let seed = 0;
    const rec = (l) => ({
      pos: new THREE.Vector3(...l.pos), dir: new THREE.Vector3(...l.dir).normalize(), color: lin(l.color), power: l.power || 0,
      decay: l.linear ? 0 : 2, flicker: l.flicker ? (seed += 7.31) : -1, sphere: new THREE.Sphere(),
      shadows: !!l.shadows, spec: l.specular !== false,
    });
    this.points = list.filter((l) => l.kind === 'point').map((l) => {
      const r = rec(l);
      r.reach = l.radius;
      r.near = Math.min(POINT_NEAR, r.reach * 0.25);
      r.sphere.set(r.pos, r.reach);
      return r;
    });
    this.spots = list.filter((l) => l.kind === 'spot').map((l) => {
      const r = rec(l);
      // the game's frustum (fov across and up) as a round cone of the same opening, softened to its
      // edge like the game's mask (1 - r²); its light starts at the lamp and ends at the far plane
      const t = Math.sqrt(Math.tan(THREE.MathUtils.degToRad(l.fov[0]) / 2) * Math.tan(THREE.MathUtils.degToRad(l.fov[1]) / 2));
      r.angle = Math.min(Math.atan(t), Math.PI / 2 - 0.01);
      r.reach = l.far;
      r.near = THREE.MathUtils.clamp(l.near || 0, 0.05, l.far * 0.5); // (the game's nearClipPlane: 2.6 to 7.8 m on most)
      r.sphere.set(r.pos.clone().addScaledVector(r.dir, l.far / 2), Math.max(l.far / 2, l.far * Math.min(t, 4)));
      return r;
    });
    // The pool: points first, then spots; a slot's block of the atlas (block), drawn = the lamp drawn
    // in it, ver = the map's content then.
    this.pool = [];
    const slot = (light, kind, block) => ({ light, kind, block, rec: null, weight: 0, d: 0, drawn: null, asked: null, ver: -1, time: 0 });
    for (let i = 0; i < Math.min(MAX_POINT, this.points.length); i++) this.pool.push(slot(new THREE.PointLight(0xffffff, 0), 'point', i));
    for (let i = 0; i < Math.min(MAX_SPOT, this.spots.length); i++) {
      const light = new THREE.SpotLight(0xffffff, 0);
      light.penumbra = 1;
      this.pool.push(slot(light, 'spot', POINTS + i));
    }
    for (const p of this.pool) {
      p.light.castShadow = false;
      p.light.matrixAutoUpdate = false;
    }
    this.shade = viewer.lampShadows ||= new LampShadows(viewer); // (the atlas: one per viewer, kept between maps)
    this.lightSource = () => this.litNow();
    addLights(this.lightSource);
    this.shade.queue.length = 0; // (the last map's)
    // (a lamp whose shadow was drawn in this frame lights it: packed again before anything is drawn)
    this.shade.after = this.afterShade = () => { this.apply(); packLights(); };
    this.version = 0; // the map's content (changed())
    this.shading = false; // the lamps' shadows in use (the view's shadows on, the map in view)
    this.uniforms = { uGain: { value: 0 }, uTime: { value: 0 }, ...FOG_UNIFORMS() }; // (the fog: fog.js FOG, shared)
    this.flares = this.makeFlares(list.filter((l) => l.kind === 'flare'));
    this.beams = this.makeBeams(list.filter((l) => l.kind === 'beam'));
    this.flickers = list.some((l) => l.flicker && (l.kind === 'flare' || l.kind === 'beam'));
    this.hook = () => { this.shadeStep(); this.flick(); };
    viewer.frameHooks.push(this.hook);
  }

  // The map's content changed (models or textures came in, objects were hidden, broken or shown):
  // the lamps' shadows are drawn again, a few at a time.
  changed() { this.version++; }

  // Every frame: the shadows of lamps just picked (they wait dark for them), else one drawn before the
  // map's content last changed, asked of the next frame (lampshadows.js draws them in it); then the
  // shaders' view of the pool (sync).
  shadeStep() {
    const on = !!(this.shown && this.v.shadows && this.group.parent?.visible);
    const changed = on !== this.shading;
    this.shading = on;
    if (on) {
      let n = 0;
      for (const s of this.pool) {
        if (n >= SHADE_NEW) break;
        if (s.rec?.shadows && s.weight > 0 && s.drawn !== s.rec && s.asked !== s.rec) { this.drawSlot(s); n++; }
      }
      if (!n) {
        const now = performance.now();
        const s = this.pool.find((q) => q.rec?.shadows && q.drawn === q.rec && !q.asked && q.ver < this.version && now - q.time > SHADE_AGAIN);
        if (s) this.drawSlot(s);
      }
    }
    if (changed) this.apply();
  }

  drawSlot(s) {
    const r = s.rec, ver = this.version;
    s.asked = r;
    this.shade.draw(s.block, r.pos, r.near, r.reach, () => {
      s.drawn = r;
      s.ver = ver;
      s.time = performance.now();
      s.asked = null;
    });
  }

  // The lit slots as xolights.js lists them (none while the map is out of view): each lamp's gloss,
  // and its block of the atlas while its shadow is in.
  *litNow() {
    if (!this.group.parent?.visible) return;
    for (const s of this.pool) {
      const r = s.rec;
      if (!r || !(s.light.intensity > 0)) continue;
      let shadow = null;
      if (this.shading && r.shadows && s.drawn === r) {
        const [u, v] = LampShadows.corner(s.block);
        shadow = { far: r.reach, near: r.near, u, v };
      }
      yield { light: s.light, spec: r.spec, shadow };
    }
  }

  get counts() { return { lights: this.points.length + this.spots.length, flares: this.flares?.count || 0, beams: this.beams?.count || 0 }; }

  // Flares: one instanced quad each (a sprite facing the camera).
  makeFlares(list) {
    if (!list.length) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(list.length * 3), dir = new Float32Array(list.length * 3), col = new Float32Array(list.length * 3), shape = new Float32Array(list.length * 4);
    list.forEach((l, i) => {
      const c = lin(l.color).multiplyScalar(2 ** l.ev / 8); // (luminance: EV100 -> the game's units)
      pos.set(l.pos, i * 3);
      dir.set(l.dir, i * 3);
      col.set([c.r, c.g, c.b], i * 3);
      shape.set([l.size, l.nebulosity || 0, Math.cos(THREE.MathUtils.degToRad(Math.min(l.visAngle, 360) / 2)), l.flicker ? i * 3.17 : -1], i * 4);
    });
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('iDir', new THREE.InstancedBufferAttribute(dir, 3));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 3));
    g.setAttribute('iShape', new THREE.InstancedBufferAttribute(shape, 4));
    g.instanceCount = list.length;
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: FLARE_VERT, fragmentShader: FLARE_FRAG,
      transparent: true, depthWrite: false, fog: false, ...ADDED,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'flares';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.raycast = () => {};
    this.group.add(mesh);
    return { mesh, count: list.length };
  }

  // Beams: one instanced quad each, from the lamp along its direction (size long, width across).
  makeBeams(list) {
    if (!list.length) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3)); // (across, along)
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(list.length * 3), dir = new Float32Array(list.length * 3), col = new Float32Array(list.length * 3), shape = new Float32Array(list.length * 3);
    const z = new THREE.Vector3();
    list.forEach((l, i) => {
      pos.set(l.pos, i * 3);
      dir.set(z.set(...l.dir).normalize().toArray(), i * 3);
      const c = lin(l.color).multiplyScalar(2 ** l.ev / 8);
      col.set([c.r, c.g, c.b], i * 3);
      shape.set([l.size, l.width, l.flicker ? i * 5.11 : -1], i * 3);
    });
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('iDir', new THREE.InstancedBufferAttribute(dir, 3));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 3));
    g.setAttribute('iShape', new THREE.InstancedBufferAttribute(shape, 3));
    g.instanceCount = list.length;
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, ...ADDED,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'beams';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.raycast = () => {};
    this.group.add(mesh);
    return { mesh, count: list.length };
  }

  // The environment's light levels (sky.js presetLevels), or null for the plain sky.
  setLevels(levels) {
    this.perLux = levels ? levels.exposure / PROBE_UNIT : DAY_PER_LUX; // (presetLevels' sun / eSun, which needs no sun: Crossout 2.41's overcasts and nights have none)
    // 2^EmissiveLumScale: presetLevels' glow is it at the exposure against the tuned one (F x 2^(EV - 1))
    this.lum = levels && levels.F > 0 ? (2 * levels.glow) / levels.F : 1;
    this.glow.value = this.perLux * this.lum * GLOW_GAIN;
    this.apply();
  }

  // (dark lights are left out of the shaders' loop: xolights.js)
  setShown(on) {
    this.shown = on;
    for (const x of [this.flares, this.beams]) if (x) x.mesh.visible = on;
    this.apply();
  }

  // Which lights are lit: those whose reach is nearest the camera and in view, the furthest of them
  // fading out towards the first one left out (no popping as the camera moves). A light still picked
  // keeps its slot (and the shadow drawn there); new ones take the slots let go.
  bucket(camera, frustum) {
    const p = camera.position;
    for (const [kind, recs] of [['point', this.points], ['spot', this.spots]]) {
      const slots = this.pool.filter((s) => s.kind === kind);
      if (!slots.length) continue;
      const cand = [];
      for (const r of recs) {
        const d = r.sphere.center.distanceTo(p) - r.sphere.radius;
        if (d < REACH && frustum.intersectsSphere(r.sphere)) cand.push([Math.max(0, d), r]);
      }
      cand.sort((a, b) => a[0] - b[0]);
      const cut = cand.length > slots.length ? cand[slots.length][0] : Infinity;
      const want = new Map(cand.slice(0, slots.length).map(([d, r]) => [r, d]));
      const free = [];
      for (const s of slots) {
        if (s.rec && want.has(s.rec)) { s.d = want.get(s.rec); want.delete(s.rec); } else { s.rec = null; free.push(s); }
      }
      for (const [r, d] of want) Object.assign(free.shift(), { rec: r, d });
      for (const s of slots) s.weight = !s.rec ? 0 : cut === Infinity ? 1 - THREE.MathUtils.smoothstep(s.d, REACH * 0.75, REACH) : 1 - THREE.MathUtils.smoothstep(s.d, cut * 0.6, cut);
    }
    this.apply();
  }

  // The picked lights where they are, as bright as they are now (dark while a lamp's shadow is not in).
  apply() {
    const k = this.shown ? this.perLux * this.lum : 0;
    for (const s of this.pool) {
      const L = s.light, r = s.rec;
      if (!r || !k || !s.weight || (this.shading && r.shadows && s.drawn !== r)) { L.intensity = 0; continue; }
      L.position.copy(r.pos);
      L.color.copy(r.color);
      L.decay = r.decay;
      L.distance = r.reach;
      L.intensity = r.power * k * LIGHT_GAIN * s.weight * (r.flicker < 0 ? 1 : 0.65 + 0.35 * noise(this.time * 9 + r.flicker));
      L.updateMatrix();
      L.updateMatrixWorld();
      if (s.kind === 'spot') {
        L.angle = r.angle;
        L.target.position.copy(r.pos).add(r.dir);
        L.target.updateMatrixWorld();
      }
    }
    this.uniforms.uGain.value = this.shown ? this.glow.value : 0;
    this.v.dirty = true;
  }

  // Flickering lights move on 30 times a second while one of them is lit (or a flare or beam flickers).
  flick() {
    if (!this.shown || !this.group.parent?.visible) return; // (the map not on screen)
    if (!this.flickers && !this.pool.some((s) => s.rec && s.weight && s.rec.flicker >= 0)) return;
    const now = performance.now() / 1000;
    if (now - this.ticked < 1 / 30 - 0.002) return;
    this.ticked = now;
    this.time = this.uniforms.uTime.value = now % 1000; // (small numbers: the shaders' noise keeps its detail)
    this.apply();
  }

  dispose() {
    const i = this.v.frameHooks.indexOf(this.hook);
    if (i >= 0) this.v.frameHooks.splice(i, 1);
    this.group.parent?.remove(this.group);
    for (const x of [this.flares, this.beams]) {
      if (!x) continue;
      x.mesh.geometry.dispose();
      x.mesh.material.dispose();
    }
    for (const s of this.pool) s.light.dispose();
    removeLights(this.lightSource);
    if (this.shade.after === this.afterShade) { this.shade.after = null; this.shade.queue.length = 0; } // (the atlas stays with the viewer for the next map)
  }
}

// smooth value noise, 0..1 (the same as the shaders' xoNoise)
function noise(t) {
  const i = Math.floor(t), f = t - i;
  const h = (x) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
  return h(i) + (h(i + 1) - h(i)) * f * f * (3 - 2 * f);
}
