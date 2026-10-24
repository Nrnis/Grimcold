// The game's particle effects drawn in the 3D view (fx.js reads and moves them): camera-facing
// sprites, streaks stretched along their flight, ribbons (trails), mesh particles, flip-book
// frames, colour / fade / size curves. Sprites that add light (muzzle flashes, sparks) are added
// onto the HDR image; smoke covers what is behind it and is lit by the scene's sun through its own
// normal map; fireballs glow through the game's heat ramps; on a map they stand in its fog like
// everything else (light only dimmed by it). Heat haze (it bends what is behind) and the light a
// flash throws are left out.
import * as THREE from 'three';
import { addLights } from './xolights.js';
import { parsePsys, FxRun, ORIENT, BLEND } from './fx.js';
import { FOG_UNIFORMS } from './fog.js';
import { hitSound, boomSound, workSound, MOMENT, heardFrom } from './soundmap.js';

const DATA = 'https://xo.data';
const MAX = 400; // particles drawn per emitter (fx.js SIM.MAX: a weather's snow keeps 400 in the air)
// How far a 2.41 flip-book's motion vectors (fx.js textureRoles: *_mv) move a frame on into the next,
// in its cell's width (green up): fitted on the game's smoke, fire and explosion books, each frame
// moved by it comes 6-50% closer to the next than as it is, and the halfway blend of two frames
// 30-60% closer to the frame between them than a cross-fade.
const MV_STRENGTH = 0.015;
const ADD = new Set([BLEND.ADD]);
// (BLEND.WATER is neither: it pushes the water's surface in the game, which the view's water does not take)
const COVER = new Set([BLEND.ALPHA, BLEND.LIT, BLEND.ALPHA2, BLEND.SMOKE, BLEND.ALPHA3]);
const LIT = new Set([BLEND.LIT, BLEND.SMOKE]);

const VERT = /* glsl */ `
attribute vec4 color;
attribute vec3 basis; // the sprite's right (x, y) on screen and whether it is lit (z)
attribute vec3 next; // the flip-book's next frame: its cell from this one's (uv), and how far on towards it
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vBasis;
varying vec3 vNext;
varying float vY;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = color;
  vBasis = basis;
  vNext = next;
  vY = position.y;
  vec4 mvPosition = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform sampler2D nmap;
uniform sampler2D ramp;
uniform sampler2D mvMap; // (2.41 flip-books: how each frame's texels move on into the next)
uniform sampler2D remap; // (2.41 fireballs: where they glow, through the ramp)
uniform float hasMap, hasNmap, hasRamp, hasMv, hasRemap, additive, lit, heatK;
uniform float naa; // (the map is an _naa: normal map in red / green, the shading in blue, the density in alpha)
uniform vec2 mvScale; // (MV_STRENGTH of a cell, in the texture's units; green up)
uniform float ready; // (its textures are in: before, it would show as a plain square)
uniform vec3 lightDir; // towards the sun, in view space
uniform vec3 sun, sky;
uniform float floorY;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vBasis;
varying vec3 vNext;
varying float vY;
#include <fog_pars_fragment>
// a flip-book texture at this frame (a) and the next (b), k of the way on
vec4 book(sampler2D tex, vec2 a, vec2 b, float k) {
  vec4 t = texture2D(tex, a);
  return k > 0.001 ? mix(t, texture2D(tex, b), k) : t;
}
void main() {
  if (ready < 0.5) discard;
  // between two frames of a 2.41 flip-book, each moved along its own motion vectors towards the
  // other: the smoke morphs from frame to frame instead of cross-fading
  float k = vNext.z;
  vec2 uvA = vUv, uvB = vUv + vNext.xy;
  if (hasMv > 0.5 && k > 0.001) {
    uvA -= (texture2D(mvMap, vUv).rg * 2.0 - 1.0) * mvScale * k;
    uvB += (texture2D(mvMap, vUv + vNext.xy).rg * 2.0 - 1.0) * mvScale * (1.0 - k);
  }
  vec4 raw = hasMap > 0.5 ? book(map, uvA, uvB, k) : vec4(1.0);
  vec4 t = naa > 0.5 ? vec4(vec3(raw.b), raw.a) : raw;
  t *= smoothstep(floorY, floorY + 0.35, vY); // (sinks softly into the ground instead of being cut off by it)
  if (additive > 0.5) {
    // light added on top; the image is composited premultiplied onto a see-through canvas
    // (post.js), so the light also gives coverage where nothing was drawn yet (see the blending)
    vec3 c = t.rgb * t.a * vColor.rgb * vColor.a;
    if (hasRamp > 0.5) { // a glow with no colour of its own (a plasma ball): the ramp's, by the heat its mask and colour give
      float m = hasRemap > 0.5 ? book(remap, uvA, uvB, k).r : hasNmap > 0.5 ? book(nmap, uvA, uvB, k).a : 1.0;
      float heat = clamp(m * vColor.r * (1.0 + vColor.g), 0.0, 1.0);
      c = texture2D(ramp, vec2(heat, 0.5)).rgb * m * t.a * vColor.a * heatK;
    }
    gl_FragColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  } else {
    // a fireball (hasRamp): colour = heat, glow, soot; plain sprites: colour
    vec3 c = t.rgb * (hasRamp > 0.5 ? vec3(vColor.b) : vColor.rgb);
    vec4 nm = naa > 0.5 ? vec4(raw.rg, 1.0, raw.a) : hasNmap > 0.5 ? book(nmap, uvA, uvB, k) : vec4(0.5, 0.5, 1.0, t.a);
    if (lit > 0.5) {
      vec3 n = vec3(0.0, 0.0, 1.0);
      if (hasNmap > 0.5 || naa > 0.5) {
        vec3 tn = nm.xyz * 2.0 - 1.0;
        if (naa > 0.5) tn.z = sqrt(max(0.0, 1.0 - dot(tn.xy, tn.xy))); // (two channels: the third follows)
        vec2 r = vBasis.xy, u = vec2(-r.y, r.x);
        n = normalize(vec3(r * tn.x + u * tn.y, max(0.0, tn.z)));
      }
      float d = 0.5 + 0.5 * dot(n, lightDir); // (half Lambert: smoke lets light through)
      c *= sky + sun * d * d;
    }
    if (hasRamp > 0.5) { // the hot parts glow through the ramp (dark red .. orange .. pale yellow)
      float m = hasRemap > 0.5 ? book(remap, uvA, uvB, k).r : nm.a;
      float heat = clamp(m * vColor.r * (1.0 + vColor.g), 0.0, 1.0);
      c += texture2D(ramp, vec2(heat, 0.5)).rgb * heatK;
    }
    gl_FragColor = vec4(c, t.a * vColor.a);
  }
  #ifdef USE_FOG
  vec4 xoFog = xoFogTo(vXoFogRay);
  gl_FragColor.rgb = additive > 0.5 ? gl_FragColor.rgb * xoFog.a : gl_FragColor.rgb * xoFog.a + xoFog.rgb;
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Heat haze (blends 4 and 6: the game's haze sprites carry only a normal map): each fragment adds
// how far to bend what is behind it, in screen units, into the post chain's haze target (post.js),
// testing the scene's depth itself. Direction: the map's red and green turned with the sprite;
// how much: its alpha (a soft mask), the particle's alpha and brightest colour, the emitter's +0xa8
// (0.1..2 on haze: its strength), fading at the sprite's own edges.
const HAZE_FRAG = /* glsl */ `
uniform sampler2D nmap;
uniform sampler2D tDepth;
uniform vec2 screen, grid;
uniform float strength, ready;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vBasis;
void main() {
  if (ready < 0.5) discard;
  if (gl_FragCoord.z > texture2D(tDepth, gl_FragCoord.xy / screen).x) discard; // (behind something solid)
  vec4 n = texture2D(nmap, vUv);
  vec2 d = n.rg * 2.0 - 1.0;
  vec2 r = vBasis.xy, u = vec2(-r.y, r.x);
  vec2 q = abs(fract(vUv * grid) - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.7, 1.0, max(q.x, q.y));
  float k = n.a * vColor.a * max(vColor.r, max(vColor.g, vColor.b)) * strength * edge * 0.012;
  gl_FragColor = vec4((r * d.x + u * d.y) * k, 0.0, 0.0);
}`;

// How many particles an emitter can have alive at once: its bursts, plus its rate over a
// particle's longest life (a machine gun's flash: 1; a flamethrower's flow: 35 a second x 0.45 s).
function capacityOf(e) {
  let n = 0;
  const life = Math.max(e.life[0], e.life[1], 0.05);
  for (const sp of e.spawners) {
    n += sp.count * (sp.interval > 0 ? Math.max(1, Math.round(sp.repeat)) : 1);
    const rate = sp.rateCurve ? Math.max(sp.rate, ...(sp.rateCurve.v || [sp.rateCurve.value || 0])) : sp.rate;
    n += rate * life;
  }
  return Math.min(MAX, Math.max(4, Math.ceil(n * 1.3) + 2));
}

// one emitter's sprites: a mesh of quads rebuilt every frame
class Draw {
  constructor(fx, e, order, { haze = false } = {}) {
    this.e = e;
    this.haze = haze;
    const cap = (this.cap = capacityOf(e));
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 12);
    this.uv = new Float32Array(cap * 8);
    this.col = new Float32Array(cap * 16);
    this.bas = new Float32Array(cap * 12);
    this.nx = new Float32Array(cap * 12);
    const idx = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('basis', new THREE.BufferAttribute(this.bas, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('next', new THREE.BufferAttribute(this.nx, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.add = ADD.has(e.blend);
    const lit = LIT.has(e.blend);
    this.lit = lit;
    this.gain = 1; // (FxView.advance: a map effect's light level)
    const u = {
      map: { value: null }, nmap: { value: null }, ramp: { value: null }, hasMap: { value: 0 }, hasNmap: { value: 0 }, hasRamp: { value: 0 },
      mvMap: { value: null }, remap: { value: null }, hasMv: { value: 0 }, hasRemap: { value: 0 }, naa: { value: 0 },
      mvScale: { value: new THREE.Vector2(MV_STRENGTH / e.grid[0], -MV_STRENGTH / e.grid[1]) },
      additive: { value: this.add ? 1 : 0 }, lit: { value: lit ? 1 : 0 }, heatK: { value: glowOf(e.glow) }, ready: { value: 0 },
      lightDir: { value: new THREE.Vector3(0, 0, 1) }, sun: fx.sun, sky: fx.sky, floorY: fx.floorY,
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...FOG_UNIFORMS(), // (Maps' fog: fog.js)
    };
    this.u = u;
    if (haze) {
      const hu = fx.v.post.hazeUniforms;
      Object.assign(u, { tDepth: hu.tDepth, screen: hu.screen, grid: { value: new THREE.Vector2(...e.grid) }, strength: { value: Math.max(0.1, Math.min(2, e.glow || 1)) } });
    }
    const m = haze ? new THREE.ShaderMaterial({ // (the bends add up, negative ones too: a half-float target)
      uniforms: u, vertexShader: VERT, fragmentShader: HAZE_FRAG, transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, side: THREE.DoubleSide,
    }) : new THREE.ShaderMaterial({
      uniforms: u, vertexShader: VERT, fragmentShader: FRAG, fog: true,
      transparent: true, depthWrite: false, depthTest: true,
      blending: this.add ? THREE.CustomBlending : THREE.NormalBlending,
      // colour adds up; coverage only fills what is still see-through (it never passes 1, which
      // would darken the part behind when post.js divides the colour by it)
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneMinusDstAlphaFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.name = 'fx';
    this.glow = this.add ? glowOf(e.glow) : 1;
    // (a ramp: a fireball's heat glows through it; a light-adding glow with no colour texture takes
    // all its colour from it, by its mask)
    const L = e.roles; // (fx.js textureRoles)
    this.rampOnly = this.add && e.heatRamp && !L.color && !L.naa && !!(L.second || L.remap) && !!L.ramp;
    this.mv = !haze && !!L.mv && e.grid[0] * e.grid[1] > 1; // (fill: the next frame and how far on)
    const need = []; // (what it cannot be drawn without: a missing one keeps it hidden)
    const mapName = haze ? null : L.color || L.naa, isNaa = !L.color; // (an _naa: linear data)
    if (mapName) need.push(fx.texture(mapName, isNaa ? 'gloss' : 'albedo').then((t) => { if (t && !this.gone) { u.map.value = t; u.hasMap.value = 1; u.naa.value = isNaa ? 1 : 0; } return !!t; }));
    if (this.mv) fx.texture(L.mv, 'gloss').then((t) => { if (t && !this.gone) { u.mvMap.value = t; u.hasMv.value = 1; } }); // (without: a cross-fade)
    const second = haze ? e.textures[1] : L.second; // (a haze's bends: whatever its second slot holds)
    if ((lit || e.heatRamp || haze) && second) {
      const nm = fx.texture(second, 'gloss').then((t) => { if (t && !this.gone) { u.nmap.value = t; u.hasNmap.value = 1; } return !!t; });
      if (this.rampOnly || haze) need.push(nm);
    }
    if (!haze && e.heatRamp && L.remap) // (a smooth mask: a quarter of its 4096 is plenty for its cells)
      need.push(fx.texture(L.remap, 'gloss', 1024).then((t) => { if (t && !this.gone) { u.remap.value = t; u.hasRemap.value = 1; } return !!t; }));
    if (e.heatRamp && L.ramp && (!this.add || this.rampOnly)) {
      const ramp = fx.texture(L.ramp, 'albedo').then((t) => {
        if (!t || this.gone) return !!t;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; // (the ramp's ends are its coldest and hottest)
        t.needsUpdate = true;
        u.ramp.value = t; u.hasRamp.value = 1;
        return true;
      });
      if (this.rampOnly) need.push(ramp);
    }
    Promise.all(need).then((got) => { if (!this.gone && got.every(Boolean)) u.ready.value = 1; });
  }

  dispose() {
    this.gone = true;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}

// mesh particles (ORIENT.MESH): the effect's own model (a dome round the muzzle, a ring ...) one
// instance per particle, textured like the sprites
const MESH_VERT = /* glsl */ `
attribute vec4 icolor;
varying vec2 vUv;
varying vec4 vColor;
varying float vY;
void main() {
  vUv = uv;
  vColor = icolor;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vY = w.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const MESH_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float hasMap, additive, floorY;
varying vec2 vUv;
varying vec4 vColor;
varying float vY;
void main() {
  if (hasMap < 0.5) discard; // (its texture is not in yet)
  vec4 t = texture2D(map, vUv);
  t *= smoothstep(floorY, floorY + 0.35, vY);
  if (additive > 0.5) {
    vec3 c = t.rgb * t.a * vColor.rgb * vColor.a;
    gl_FragColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  } else gl_FragColor = vec4(t.rgb * vColor.rgb, t.a * vColor.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class MeshDraw {
  constructor(fx, e, order) {
    this.e = e;
    this.cap = capacityOf(e);
    this.add = ADD.has(e.blend);
    this.glow = this.add ? glowOf(e.glow) : 1;
    this.u = { map: { value: null }, hasMap: { value: 0 }, additive: { value: this.add ? 1 : 0 }, floorY: fx.floorY };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: MESH_VERT, fragmentShader: MESH_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: this.add ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneMinusDstAlphaFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation,
    });
    this.mesh = new THREE.Group(); // (filled once the model is in)
    this.mesh.renderOrder = order;
    this.items = [];
    fx.texture(e.roles.color, 'albedo').then((t) => { if (t && !this.gone) { this.u.map.value = t; this.u.hasMap.value = 1; } });
    const path = /\.mdl$/i.test(e.mesh) ? e.mesh : e.mesh + '.mdl';
    this.entry = fx.v.acquireGeometry(path, 0);
    this.entry.promise.then((parts) => {
      if (this.gone) return;
      for (const p of parts) {
        const im = new THREE.InstancedMesh(p.geometry, this.mat, this.cap);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const ic = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
        im.geometry = p.geometry.clone(); // (a copy with its own instanced colour: disposing it must not free the cached model's buffers)
        im.geometry.setAttribute('icolor', ic);
        im.count = 0;
        im.frustumCulled = false;
        im.renderOrder = order;
        im.raycast = () => {};
        this.items.push({ im, ic });
        this.mesh.add(im);
      }
    }, () => {});
  }

  dispose(fx) {
    this.gone = true;
    for (const { im } of this.items) im.geometry.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
    fx.v.geo.release(this.entry);
  }
}

const _m4q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4(), _q4 = new THREE.Quaternion(), _e4 = new THREE.Euler(), _p4 = new THREE.Vector3(), _s4 = new THREE.Vector3(), _o4 = new THREE.Matrix4();

// How bright a light-adding emitter is: its +0xa8 value reads like an exposure in stops (9..21,
// most 12..18; 1 or 0 on the ones that do not glow). The view has no bloom to spread a flash's
// light, so the stops are squeezed (x0.35) from 10 up: an autocannon's flash (10) is the texture as
// it is, a machine gun's (12) 1.6 times that, sparks (18) burn white-hot.
function glowOf(v) {
  if (!(v > 1)) return 1;
  return Math.min(5, Math.max(0.8, Math.pow(2, (v - 10) * 0.35)));
}

// How bright a light is (candela, three.js's physical units: the sun here is 1.4) for its reach in
// metres: a machine gun's flash (its effect fills 2 m) lights the barrel half a metre away about
// three times as much as the sun, a cannon's or an explosion's (8 m and more) what stands a metre
// or two from it four to eight times.
const lightPower = (radius, alpha, glow) => 0.2 * alpha * Math.sqrt(glow) * Math.min(radius, 8) ** 2;

const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _cam = new THREE.Vector3(), _d = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3();

export class FxView {
  constructor(viewer) {
    this.v = viewer;
    this.root = new THREE.Group();
    this.root.name = 'effects';
    viewer.scene.add(this.root);
    this.files = new Map(); // path -> Promise<parsed effect | null>
    this.textures = new Map(); // base|role -> Promise<THREE.Texture | null>
    this.models = new Map(); // a round's model path -> Promise<{ group, nozzle } | null> (meshOf)
    this.runs = [];
    this.shots = []; // rounds in flight (fire)
    this.beams = []; // beams on (beam)
    this.hits = 0; // hit effects playing (capped: a minigun lands 21 a second)
    this.sun = { value: new THREE.Color(0.85, 0.82, 0.76) };
    this.sky = { value: new THREE.Color(0.42, 0.45, 0.5) };
    this.mapLight = null; // (Maps: the map's sun and sky light lit particles: setMapLight)
    this.order = 0;
    this.paused = false; // (tests hold the effects still and move them on with advance())
    this.floorY = { value: 0 };
    // the stage's floor writes depth (it catches shadows): drawn after the effects it does not
    // cut them off; they fade out into it instead (floorY)
    viewer.floor.renderOrder = 1e6;
    // The light flashes and explosions throw (on the gun, the floor, the target): a few point
    // lights, lit through xolights.js's one shader loop (out of the scene: no shader is built again
    // for them), dark until the brightest lights of the moment take them
    this.hazeScene = viewer.post ? new THREE.Scene() : null; // (heat haze: post.js draws it)
    if (this.hazeScene) viewer.post.hazeScene = this.hazeScene;
    this.flashes = []; // { pos, color, peak, range, t, life }
    this.lights = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1, 2);
      l.name = 'fx light';
      this.lights.push(l);
    }
    const litFx = this.lights.map((light) => ({ light }));
    addLights(() => litFx);
  }

  // the effect file (particles/...psys, with or without the extension), parsed once
  load(path) {
    const p = path.endsWith('.psys') ? path : path + '.psys';
    if (!this.files.has(p)) {
      this.files.set(p, fetch(`${DATA}/raw?path=${encodeURIComponent(p)}`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? parsePsys(b) : null))
        .then((sys) => { if (sys) (this.durations ||= new Map()).set(p, sys.duration); return sys; })
        .catch(() => null));
    }
    return this.files.get(p);
  }

  // an effect's duration once it is read (0 before)
  durationOf(path) {
    const p = path.endsWith('.psys') ? path : path + '.psys';
    if (!this.files.has(p)) this.load(p);
    return this.durations?.get(p) || 0;
  }

  texture(name, role, max = 0) {
    if (!name) return Promise.resolve(null);
    const base = name.replace(/\.dds$/i, ''); // (some effects name theirs with the extension the artist's file had)
    const key = base + '|' + role + '|' + max;
    if (!this.textures.has(key)) {
      const entry = this.v.acquireTexture(base, role, max); // (held for good: a few small textures)
      this.textures.set(key, entry.promise.then((t) => t.tex, () => null));
    }
    return this.textures.get(key);
  }

  // A round's model (fxmap.js shotFor: mesh), read once and kept: { group: the static model, nozzle:
  // where its smoke and flame come out, in its own frame (a node named nozzle, exhaust or fx_01), or
  // null }. Each round flies its own copy of the meshes (copyOf).
  meshOf(path) {
    if (!path) return Promise.resolve(null);
    if (!this.models.has(path)) {
      this.models.set(path, fetch(`${DATA}/model?path=${encodeURIComponent(path)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then(async (info) => {
          if (!info) return null;
          const group = await this.v.makeModel(info, 0, {});
          const n = (info.nodes || []).find((x) => /^(nozzle|exhaust|fx_?0?1)$/i.test(x.name));
          return { group, nozzle: n ? [n.matrix[12], n.matrix[13], n.matrix[14]] : null, nodes: info.nodes || [] };
        })
        .catch(() => null));
    }
    return this.models.get(path);
  }

  // a model's meshes again (the same geometry and materials), to fly: no shadow (the stage's shadow
  // is drawn once for what stands still), and the mouse goes through it
  copyOf(group) {
    const g = new THREE.Group();
    g.name = 'round';
    g.matrixAutoUpdate = false;
    for (const c of group.children) {
      if (!c.isMesh) continue;
      const m = new THREE.Mesh(c.geometry, c.material);
      m.castShadow = false;
      m.receiveShadow = c.receiveShadow;
      m.raycast = () => {};
      g.add(m);
    }
    return g;
  }

  // Plays an effect hung on origin() (a function giving the 4x4 world matrix elements it fires from
  // now). Resolves to the run (stop() it to end a looping one) or null when the file is not there.
  // flash: it throws a flash of light as it starts (a muzzle, a hit: flashOf), { ahead: so many metres
  // out from the origin along its axis (2: +Z, a barrel; 1: +Y, a hit's surface normal) }.
  // A map's own effects (mapfx.js): scale, its env_scale; gain() / coverGain(): how bright its
  // light-adding particles and its unlit covering ones are now (the weather's under a night sky);
  // ambient: it only sets the scene (Maps redraws them 30 times a second: calm).
  // minPx: no particle drawn smaller than so many pixels across (a weather's 2 cm snowflakes and 6 cm
  // raindrops, a few metres off, would be specks under a pixel)
  async play(path, origin, { seed = (Math.random() * 1e9) | 0, inherit = null, flash = null, loop = null, scale = 1, gain = null, coverGain = null, ambient = false, minPx = 0 } = {}) {
    const sys = await this.load(path);
    if (!sys) return null;
    const run = new FxRun(sys, { seed, origin, inherit, loop, scale });
    run.ambient = ambient;
    run.gain = gain;
    run.coverGain = coverGain;
    run.minPx = minPx;
    if (flash !== null) this.flash(sys, origin(), flash);
    const order = 50 + (this.order++ % 1000) * 16;
    const draws = sys.emitters.map((e, i) => {
      // heat haze: its own scene, drawn by the post chain (WebGL2 only)
      if ((e.blend === BLEND.HAZE || e.blend === BLEND.HAZE2) && e.textures[1] && e.orient !== ORIENT.MESH && e.orient !== ORIENT.LIGHT && this.hazeScene) {
        const d = new Draw(this, e, order + Math.min(7, i), { haze: true });
        this.hazeScene.add(d.mesh);
        return d;
      }
      if (e.orient === ORIENT.LIGHT || !(ADD.has(e.blend) || COVER.has(e.blend))) return null;
      const L = e.roles, rampOnly = ADD.has(e.blend) && e.heatRamp && !L.color && !L.naa && (L.second || L.remap) && L.ramp && e.orient !== ORIENT.MESH;
      if (!L.color && !L.naa && !rampOnly) return null; // (nothing to draw with)
      if (e.orient === ORIENT.MESH) {
        if (!e.mesh || !L.color) return null;
        const md = new MeshDraw(this, e, order + (ADD.has(e.blend) ? 8 : 0) + Math.min(7, i));
        this.root.add(md.mesh);
        return md;
      }
      // (light-adding sprites after the ones that cover: smoke born with the flash would hide it)
      const d = new Draw(this, e, order + (ADD.has(e.blend) ? 8 : 0) + Math.min(7, i));
      this.root.add(d.mesh);
      return d;
    });
    this.runs.push({ run, draws });
    this.v.dirty = true;
    return run;
  }

  // A round (fxmap.js shotFor: spec) leaving the 4x4 matrix m (column-major: where the gun's fire
  // point is, its +Y kept as the round's up) along dir: it flies spec.speed m/s, drops spec.gravity
  // m/s², carries its effect (the effect's forward, +Z, along its flight), and is gone after
  // spec.range metres or where hit(p0, p1) finds something between two of its positions:
  // { point, normal, surface: 0 the ground, 1 the target }. There it plays spec.hits[surface], set
  // up with the effect's +Y along the surface's normal. quiet: no hit effect (a stream's rounds
  // show every spec.hitEvery-th). A rocket, bolt, grenade ... flies as its model (spec.mesh, nose
  // along the flight), its effect hanging at the model's nozzle; what a throwing launcher throws
  // sticks, rolls, lands or hovers as its spec says (fxmap.js SHOTS: see fly).
  // seek(): where a guided missile (spec.homing) steers or a drone flies to, or null.
  // anchor(): the fire point's matrix now (a harpoon's rope runs back to it).
  // speed: how fast this one leaves, if not spec.speed (a lobbed shell: as fast as its arc takes).
  fire(spec, m, dir, hit, { quiet = false, seek = null, anchor = null, speed = null } = {}) {
    const v = speed || spec.speed;
    const shot = {
      spec, hit, quiet, seek, t: 0, life: spec.range / v, alive: true, run: null, obj: null, nozzle: null, nodes: [],
      state: spec.hover ? 'hover' : 'fly', stay: 0, axis: -1, bury: 0.2, radius: 0.3, roll: 0, rope: null, work: null, rest: null,
      pos: [m[12], m[13], m[14]], vel: [dir[0] * v, dir[1] * v, dir[2] * v],
      up: [m[4], m[5], m[6]], frame: new Float64Array(16), fxFrame: new Float64Array(16),
    };
    shot.home = shot.pos.slice();
    this.shots.push(shot);
    const vel = shot.vel.slice();
    const start = shot.pos.slice();
    if (spec.mesh) this.dress(shot, spec.mesh);
    if (spec.proj) {
      this.play(spec.proj, () => frameAt(shot), { inherit: vel }).then((run) => {
        if (!run) return;
        if (!shot.alive || shot.state !== 'fly' && shot.state !== 'hover' && shot.state !== 'roll') run.end(); // (it landed before its effect was read)
        run.start = start; // (where its tracers begin: see fill)
        shot.run = run;
      });
    }
    if (spec.rope && anchor) shot.rope = this.beam({ beam: spec.rope, range: 0, hits: [], sag: 0.03 }, anchor, null, { to: () => shot.pos });
    this.v.dirty = true;
    return shot;
  }

  // A round's model: its own copy in the scene (meshOf, copyOf); a spinner turns about its thinnest
  // axis (a saw's, a disc's), a roller about x (a wheel's axle, a barrel on its side), as far up as
  // its radius; what sticks goes in a third of its length.
  dress(s, path) {
    this.meshOf(path).then((t) => {
      if (!t || !s.alive) return;
      s.obj?.removeFromParent();
      s.nozzle = t.nozzle;
      s.nodes = t.nodes;
      s.obj = this.copyOf(t.group);
      const size = t.group.userData.box.getSize(new THREE.Vector3()).toArray();
      s.axis = size.indexOf(Math.min(...size));
      s.bury = 0.35 * size[2];
      s.radius = Math.max(size[1], size[2]) / 2;
      if (s.state === 'roll') s.pos[1] = this.v.groundY() + s.radius;
      this.root.add(s.obj);
      this.place(s);
    });
  }

  // a round's model where the round is now: along its flight (or as it stays), turned as it spins,
  // tumbles or rolls
  place(s) {
    if (!s.obj) return;
    _pm.fromArray(s.state === 'stay' && s.rest ? s.rest : frameAlong(s));
    let ang = 0, axis = s.axis;
    if (s.state === 'roll') { ang = s.roll; axis = 0; }
    else if (s.spec.tumble && s.state === 'fly') { ang = s.spec.tumble * 2 * Math.PI * s.t; axis = 0; }
    else if (s.spec.spin && axis >= 0) ang = s.spec.spin * 2 * Math.PI * s.t;
    if (ang) _pm.multiply(_pr.makeRotationAxis(axis === 0 ? _AX : axis === 1 ? _AY : _AZ, ang));
    s.obj.matrix.copy(_pm);
    s.obj.matrixWorldNeedsUpdate = true;
  }

  // A beam (fxmap.js shotFor: spec.beam): the game's beam effect laid along the line from a fire
  // point (at(): its matrix now, the beam along its +Z) to what that line meets within spec.range
  // (hit(p0, p1), as for rounds), aimed again every frame; where it lands, spec.hits[surface] every
  // spec.hitEvery seconds (a pulse: once). The beam effects are ribbons fed at a steady rate whose
  // particles jitter sideways (the Tesla's lightning: a table over time and age): their particles
  // are laid along the line, the oldest at the far end, keeping only that sideways jitter
  // (fillBeam). life: seconds it stays on (a pulse); a held one goes with endBeam.
  // to(): where it ends, if not where the line meets something (a harpoon's rope, a fence's bolt).
  beam(spec, at, hit, { life = Infinity, to = null } = {}) {
    const b = { spec, at, hit, life, toFn: to, t: 0, from: [0, 0, 0], to: [0, 0, 0], len: 0, frame: new Float64Array(16), mark: null, hitT: Infinity, alive: true, run: null, hits: 0 };
    this.aim(b);
    this.beams.push(b);
    this.play(spec.beam, () => b.frame, { loop: life === Infinity ? true : null }).then((run) => {
      if (!run) { b.alive = false; return; }
      run.beam = b;
      b.run = run;
      if (!b.alive) run.stop();
    });
    this.v.dirty = true;
    return b;
  }

  endBeam(b) {
    if (!b?.alive) return;
    b.alive = false;
    b.run?.stop(); // (its particles fade out)
  }

  // where a beam starts, which way it goes and where it ends now
  aim(b) {
    const m = b.at();
    const o = [m[12], m[13], m[14]];
    const t = b.toFn?.();
    let d = t ? [t[0] - o[0], t[1] - o[1], t[2] - o[2]] : [m[8], m[9], m[10]];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    d = [d[0] / dl, d[1] / dl, d[2] / dl];
    const end = t ? t.slice() : [o[0] + d[0] * b.spec.range, o[1] + d[1] * b.spec.range, o[2] + d[2] * b.spec.range];
    const h = t ? null : b.hit?.(o, end);
    b.from = o;
    b.to = h ? h.point : end;
    b.mark = h;
    b.len = Math.hypot(b.to[0] - o[0], b.to[1] - o[1], b.to[2] - o[2]);
    // its frame: +Z along it, +Y as near the fire point's up as that allows
    const up = [m[4], m[5], m[6]];
    let x = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
    const xl = Math.hypot(x[0], x[1], x[2]);
    x = xl < 1e-6 ? [1, 0, 0] : [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
    b.frame.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, d[0], d[1], d[2], 0, o[0], o[1], o[2], 1]);
  }

  // the beams move on: aimed again, their hits, their ends
  sweep(dt) {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t += dt;
      this.aim(b);
      if (b.alive && b.t >= b.life) this.endBeam(b);
      b.hitT += dt;
      const every = b.spec.pulse ? Infinity : b.spec.hitEvery || 0.15;
      if (b.alive && b.mark && (b.hits === 0 || b.hitT >= every) && this.hits < 24) {
        b.hitT = 0;
        b.hits++;
        this.impact(b.spec.hits[b.mark.surface], b.mark);
        this.hitSound(b.spec, b.mark);
      }
      if (!b.alive && (!b.run || !this.runs.some((r) => r.run === b.run))) this.beams.splice(i, 1);
    }
  }

  // The rounds move on dt seconds: in flight (drop, a guided missile turning onto its mark, what
  // they hit), rolling, staying where they stuck or landed, or hovering (a drone).
  fly(dt) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.t += dt;
      if (s.state === 'fly') this.flight(s, dt);
      else if (s.state === 'roll') this.rolling(s, dt);
      else if (s.state === 'stay') this.staying(s, dt);
      else if (s.state === 'hover') this.hovering(s, dt);
      if (s.state === 'done') { this.retire(s); this.shots.splice(i, 1); } else this.place(s);
    }
  }

  flight(s, dt) {
    const sp = s.spec;
    if (sp.homing && s.seek && dt > 0) steer(s, s.seek(), dt);
    s.vel[1] -= sp.gravity * dt;
    const p0 = s.pos;
    let p1 = [p0[0] + s.vel[0] * dt, p0[1] + s.vel[1] * dt, p0[2] + s.vel[2] * dt];
    if (sp.spiral) p1 = this.corkscrew(s, dt); // (round its line, which flies on as the round would)
    const h = dt > 0 ? this.hitRound(s, p0, p1) : null;
    s.pos = h ? h.point : p1;
    if (!h) { if (s.t >= s.life) s.state = 'done'; return; }
    if (sp.roll && h.surface === 0) return this.startRoll(s, h);
    if (sp.land && (h.surface === 0 || sp.landAny)) return this.settle(s, h, sp.land, false);
    if (!s.quiet && this.hits < 24) this.impact(sp.hits[h.surface], h);
    if (!s.quiet) this.hitSound(sp, h);
    this.v.onHit?.(h, sp); // (on a map: what breaks there breaks)
    if (sp.stick) return this.settle(s, h, sp.stick, true);
    s.state = 'done';
  }

  // the sound of a round or a beam landing (soundmap.js): where it lands, a beam's at most so often
  hitSound(spec, h) {
    const f = hitSound(spec, h.surface);
    if (f) this.sfx(f[0], h.point, { every: f[1] });
  }

  // A sound where something happens in the world: from far off it comes as the game's distant version
  // of it, as late as sound takes to get there (343 m/s), and a bullet's not at all past earshot.
  sfx(family, pos, opts = {}) {
    const snd = this.v.sounds, c = this.v.camera.position;
    if (!snd || !family) return null;
    const d = Math.hypot(pos[0] - c.x, pos[1] - c.y, pos[2] - c.z), f = heardFrom(family, d);
    return f ? snd.play(f, pos, { ...opts, delay: d > 25 ? d / 343 : 0 }) : null;
  }

  // What a round meets between two of its places. A big one (a barrel, a wheel, a saw: its model more
  // than 0.3 m across) by more than its middle: its top and its sides too (a rolling barrel's middle
  // passed under the target's car body, where the cut-out is see-through between its wheels), the
  // hit then where its middle was; the ground by its middle alone.
  hitRound(s, p0, p1) {
    const h = s.hit?.(p0, p1), r = s.radius;
    if (!s.obj || !(r > 0.15)) return h;
    const v = s.vel, l = Math.hypot(v[0], v[1], v[2]) || 1, fx = v[0] / l, fz = v[2] / l, sl = Math.hypot(fx, fz);
    const sx = sl > 1e-6 ? fz / sl : 1, sz = sl > 1e-6 ? -fx / sl : 0; // (level, across the flight)
    let best = h;
    for (const o of [[0, r * 0.8, 0], [sx * r * 0.7, 0, sz * r * 0.7], [-sx * r * 0.7, 0, -sz * r * 0.7]]) {
      const g = s.hit?.([p0[0] + o[0], p0[1] + o[1], p0[2] + o[2]], [p1[0] + o[0], p1[1] + o[1], p1[2] + o[2]]);
      if (g && g.surface !== 0 && (!best || g.dist < best.dist)) best = { ...g, point: [g.point[0] - o[0], g.point[1] - o[1], g.point[2] - o[2]] };
    }
    return best;
  }

  // A spiralling rocket: its line (s.core) flies on at its velocity, the rocket turns round it
  // (radius growing to spec.spiral[0] in its first 0.04 s, spec.spiral[1] turns a second, each rocket
  // a third of a turn on from the one fired before; the circle closing in over the last 5 m to its
  // mark, so a volley lands round the point aimed at), its nose along the helix (s.look).
  corkscrew(s, dt) {
    const [R, turns] = s.spec.spiral;
    s.core ||= s.pos.slice();
    for (let k = 0; k < 3; k++) s.core[k] += s.vel[k] * dt;
    const v = s.vel, l = Math.hypot(v[0], v[1], v[2]) || 1, z = [v[0] / l, v[1] / l, v[2] / l];
    const xl = Math.hypot(z[2], z[0]), x = xl < 1e-6 ? [1, 0, 0] : [z[2] / xl, 0, -z[0] / xl]; // (level, across the line)
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    s.phase ??= ((this.spirals = (this.spirals || 0) + 1) * 2 * Math.PI) / 3;
    const mark = s.seek?.(), near = mark ? Math.hypot(mark[0] - s.core[0], mark[1] - s.core[1], mark[2] - s.core[2]) : Infinity;
    const r = R * Math.min(1, s.t / 0.04) * Math.max(0.15, Math.min(1, near / 5)), a = s.phase + turns * 2 * Math.PI * s.t, c = Math.cos(a) * r, sn = Math.sin(a) * r;
    const p1 = [s.core[0] + x[0] * c + y[0] * sn, s.core[1] + x[1] * c + y[1] * sn, s.core[2] + x[2] * c + y[2] * sn];
    const d = [p1[0] - s.pos[0], p1[1] - s.pos[1], p1[2] - s.pos[2]], dl = Math.hypot(d[0], d[1], d[2]);
    if (dl > 1e-9) s.look = [d[0] / dl, d[1] / dl, d[2] / dl];
    return p1;
  }

  // It stays where it hit for `time` seconds: stuck (driven in along its flight) or landed (upright
  // on the surface, facing the way it flew across it). Its flight's effect stops; its stuck or landed
  // model takes the flying one's place; its working effect plays there; a trap's arrows fly out a
  // second later; a fence pole joins the one before.
  settle(s, h, time, stuck) {
    s.state = 'stay';
    s.stay = time;
    s.run?.end();
    const v = s.vel, l = Math.hypot(v[0], v[1], v[2]) || 1, d = [v[0] / l, v[1] / l, v[2] / l];
    if (stuck) {
      s.pos = [h.point[0] + d[0] * s.bury, h.point[1] + d[1] * s.bury, h.point[2] + d[2] * s.bury];
      s.rest = Float64Array.from(frameAlong(s));
    } else {
      const n = h.normal, dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      let z = [d[0] - n[0] * dn, d[1] - n[1] * dn, d[2] - n[2] * dn];
      const zl = Math.hypot(z[0], z[1], z[2]);
      z = zl < 1e-6 ? (Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [n[2], 0, -n[0]]) : [z[0] / zl, z[1] / zl, z[2] / zl];
      const x = [n[1] * z[2] - n[2] * z[1], n[2] * z[0] - n[0] * z[2], n[0] * z[1] - n[1] * z[0]];
      s.pos = h.point.slice();
      s.rest = new Float64Array([x[0], x[1], x[2], 0, n[0], n[1], n[2], 0, z[0], z[1], z[2], 0, s.pos[0], s.pos[1], s.pos[2], 1]);
    }
    if (s.spec.stuck) this.dress(s, s.spec.stuck);
    const work = workSound(s.spec.work), snd = this.v.sounds;
    if (work && snd) snd.play(work[0], s.pos, { loop: work[1], gain: 0.8 }).then((v) => { if (s.state === 'done') v?.stop(); else s.workVoice = v; });
    if (!stuck) this.sfx(MOMENT.land, s.pos, { gain: 0.7, every: 0.05 });
    if (s.rope) this.sfx(MOMENT.rope, s.pos);
    if (s.spec.work) {
      this.play(s.spec.work, () => s.rest, { loop: true }).then((run) => {
        if (!run) return;
        if (s.state === 'done') run.stop(); else s.work = run;
      });
    }
    if (s.spec.volley) s.volley = s.spec.volley;
    if (s.spec.pole) this.pole(s);
  }

  staying(s, dt) {
    if (s.volley !== undefined && (s.volley -= dt) <= 0) { s.volley = undefined; this.volley(s); }
    if ((s.stay -= dt) > 0) return;
    if (s.spec.boom) {
      this.play(s.spec.boom, () => s.rest || frameAlong(s), { flash: { ahead: 0.3, axis: 1 } });
      this.sfx(boomSound(s.spec.boom), s.pos);
      this.v.onHit?.({ point: s.pos.slice(), normal: [0, 1, 0], surface: 0 }, { ...s.spec, hit: s.spec.blastHit || 'blast' }); // (its blast)
    }
    s.state = 'done';
  }

  // a trap's arrows: one out of each of its (stuck model's) fire points, along their +Z
  volley(s) {
    const child = s.spec.child;
    if (!child || !s.rest) return;
    this.sfx(MOMENT.trap, s.pos);
    for (const n of s.nodes) {
      if (!/^fire_\d+$/i.test(n.name)) continue;
      const m = _pm.fromArray(s.rest).multiply(_pr.fromArray(n.matrix)).elements;
      const d = [m[8], m[9], m[10]], l = Math.hypot(d[0], d[1], d[2]) || 1;
      this.fire(child, Float64Array.from(m), [d[0] / l, d[1] / l, d[2] / l], s.hit);
    }
  }

  // a fence pole: the bolt of the fence runs between its top and the top of the pole before it
  pole(s) {
    const list = (this.poles ||= []).filter((p) => p.state === 'stay');
    const prev = list.filter((p) => p.spec.kind === s.spec.kind).pop();
    this.poles = [...list, s];
    if (!prev) return;
    const top = (p) => { const r = p.rest; return [r[12] + r[4] * 1.5, r[13] + r[5] * 1.5, r[14] + r[6] * 1.5]; };
    const at = () => { const r = Float64Array.from(prev.rest); const t = top(prev); r[12] = t[0]; r[13] = t[1]; r[14] = t[2]; return r; };
    s.link = this.beam({ beam: s.spec.fenceBeam, range: 0, hits: [] }, at, null, { to: () => top(s) });
    this.sfx(MOMENT.fence, top(s), { gain: 0.6 });
    s.linkFrom = prev;
  }

  // a roller: down on the ground it bowls on the way it flew, upright, as far up as its radius
  startRoll(s, h) {
    s.state = 'roll';
    s.rollT = 0;
    const v = s.vel;
    let fx = v[0], fz = v[2];
    const fl = Math.hypot(fx, fz);
    if (fl < 1e-6) { fx = 0; fz = 1; } else { fx /= fl; fz /= fl; }
    s.vel = [fx * s.spec.rollSpeed, 0, fz * s.spec.rollSpeed];
    s.up = [0, 1, 0];
    s.pos = [h.point[0], h.point[1] + s.radius, h.point[2]];
    this.sfx(MOMENT.roll, s.pos);
  }

  rolling(s, dt) {
    s.rollT += dt;
    const p0 = s.pos, p1 = [p0[0] + s.vel[0] * dt, p0[1], p0[2] + s.vel[2] * dt];
    const h = dt > 0 ? this.hitRound(s, p0, p1) : null;
    s.pos = h ? h.point : p1;
    s.roll += (Math.hypot(s.vel[0], s.vel[2]) * dt) / Math.max(0.05, s.radius);
    if (h) {
      if (this.hits < 24) this.impact(s.spec.hits[h.surface], h);
      this.hitSound(s.spec, h);
      s.state = 'done';
    } else if (s.rollT >= s.spec.roll) {
      const g = { point: [s.pos[0], s.pos[1] - s.radius, s.pos[2]], normal: [0, 1, 0], surface: 0 };
      this.impact(s.spec.hits[0], g);
      this.hitSound(s.spec, g);
      s.state = 'done';
    }
  }

  // A drone: out to a place above the way to its mark (past half way, 2.2 m up), bobbing there while it
  // shoots at it (spec.child rounds every spec.every seconds, from a second in), then away up.
  hovering(s, dt) {
    const sp = s.spec, mark = s.seek?.();
    if (!s.hoverAt) {
      const v = s.vel, l = Math.hypot(v[0], v[1], v[2]) || 1;
      const goal = mark || [s.home[0] + (v[0] / l) * 15, s.home[1], s.home[2] + (v[2] / l) * 15];
      s.hoverAt = [s.home[0] + (goal[0] - s.home[0]) * 0.55, Math.max(goal[1], this.v.groundY()) + 2.2, s.home[2] + (goal[2] - s.home[2]) * 0.55];
    }
    const snd = this.v.sounds;
    if (snd && !s.engine) s.engine = snd.play(MOMENT.droneEngine, s.pos, { loop: true, gain: 0.6 }).then((v) => { if (!s.alive) v?.stop(); return v; });
    s.engine?.then((v) => snd?.move(v, s.pos));
    if (s.t < sp.hover) {
      const k = Math.min(1, dt * 1.6), y = s.hoverAt[1] + 0.25 * Math.sin(2.2 * s.t);
      s.pos = [s.pos[0] + (s.hoverAt[0] - s.pos[0]) * k, s.pos[1] + (y - s.pos[1]) * k, s.pos[2] + (s.hoverAt[2] - s.pos[2]) * k];
      if (mark) s.vel = [mark[0] - s.pos[0], mark[1] - s.pos[1], mark[2] - s.pos[2]]; // (it faces its mark)
      s.shotT = (s.shotT ?? 1) - dt;
      if (mark && sp.child && s.shotT <= 0) {
        s.shotT = sp.every;
        const d = s.vel, l = Math.hypot(d[0], d[1], d[2]) || 1, o = [s.pos[0], s.pos[1] - 0.4, s.pos[2]];
        const j = () => (Math.random() - 0.5) * 0.04; // (a little spread)
        const dir = [d[0] / l + j(), d[1] / l + j(), d[2] / l + j()], dl = Math.hypot(...dir);
        this.fire(sp.child, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o[0], o[1], o[2], 1]), dir.map((x) => x / dl), s.hit);
        snd?.play(sp.child.mesh ? MOMENT.droneRocket : MOMENT.droneShot, o, { gain: 0.8 });
      }
    } else {
      s.pos = [s.pos[0], s.pos[1] + 7 * dt, s.pos[2]];
      if (s.t >= sp.hover + 2.5) s.state = 'done';
    }
  }

  // a round gone: its model, its effects (flight, work), its rope and fence bolts
  retire(s) {
    s.alive = false;
    s.run?.end();
    s.work?.stop();
    s.workVoice?.stop(0.15);
    s.engine?.then((v) => v?.stop(0.3));
    if (s.rope && s.state === 'done') this.sfx(MOMENT.detach, s.pos);
    if (s.rope) this.endBeam(s.rope);
    if (s.link) this.endBeam(s.link);
    for (const o of this.shots) if (o.linkFrom === s && o.link) this.endBeam(o.link);
    s.obj?.removeFromParent();
  }

  impact(path, h) {
    // the hit's frame: +Y the surface's normal, the other two any way across it
    const n = new THREE.Vector3().fromArray(h.normal).normalize();
    const a = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const x = new THREE.Vector3().crossVectors(a, n).normalize(), z = new THREE.Vector3().crossVectors(x, n);
    const m = new THREE.Matrix4().makeBasis(x, n, z).setPosition(h.point[0] + n.x * 0.02, h.point[1] + n.y * 0.02, h.point[2] + n.z * 0.02);
    const e = Float64Array.from(m.elements);
    this.hits++;
    this.play(path, () => e, { flash: { ahead: 0.3, axis: 1 } }).then((run) => { if (run) run.onEnd = () => this.hits--; else this.hits--; }); // (the light a little off the surface)
  }

  // The flash an effect throws as it starts, or null (smoke, dust: nothing in it glows). The game's
  // own light emitters are few (35 of the muzzles, 17 hits: it lights its flashes from the weapons'
  // data, out of reach): so every effect with light-adding emitters flashes in their colour (the
  // brighter ones weigh more), as wide as the space the effect fills (its stored bounds), briefly
  // (a muzzle's 1/14 s, an explosion's 1/4 s).
  flashOf(sys) {
    if (sys.flashLight !== undefined) return sys.flashLight;
    let r = 0, g = 0, b = 0, w = 0;
    for (const e of sys.emitters) {
      if (e.blend !== BLEND.ADD || !(e.glow > 1) || e.orient === ORIENT.LIGHT) continue;
      const k = glowOf(e.glow);
      r += e.color[0] * k; g += e.color[1] * k; b += e.color[2] * k; w += k;
    }
    if (!w) return (sys.flashLight = null);
    const m = Math.max(r, g, b) || 1;
    const R = Math.min(30, Math.max(0.5, ...sys.bounds.map(Math.abs)));
    return (sys.flashLight = { color: [r / m, g / m, b / m], radius: R, life: R < 2.5 ? 0.07 : 0.25 });
  }

  flash(sys, m, { ahead = 0, axis = 2 } = {}) {
    const f = this.flashOf(sys);
    if (!f) return;
    const c = axis * 4;
    const pos = m ? [m[12] + m[c] * ahead, m[13] + m[c + 1] * ahead, m[14] + m[c + 2] * ahead] : [0, 0, 0];
    this.flashes.push({ pos, color: f.color, peak: lightPower(f.radius, 1, 1), range: f.radius * 4, t: 0, life: f.life });
    if (this.flashes.length > 32) this.flashes.shift();
  }

  // The lights of the moment: the flashes, and the game's own light emitters' particles (a plasma
  // ball's blue, an explosion's); the brightest take the pool, the rest stay dark.
  light(dt) {
    const cand = [];
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      if (f.t >= f.life) { this.flashes.splice(i, 1); continue; }
      const k = 1 - f.t / f.life;
      cand.push({ pos: f.pos, color: f.color, power: f.peak * k * k, range: f.range });
    }
    for (const { run } of this.runs) {
      for (const s of run.em) {
        if (s.e.orient !== ORIENT.LIGHT || !s.parts.length) continue;
        for (const p of s.parts) {
          const o = p.out, radius = Math.abs(o.size * o.sizeX), a = Math.max(0, Math.min(1, o.alpha));
          if (!(radius > 0) || a <= 0.01) continue;
          cand.push({ pos: p.pos, color: o.rgb, power: lightPower(radius, a, glowOf(s.e.glow)), range: Math.max(1, radius * 3) });
        }
      }
    }
    cand.sort((x, y) => y.power - x.power);
    let lit = false;
    this.lights.forEach((l, i) => {
      const c = cand[i];
      if (!c) { l.intensity = 0; return; }
      l.position.set(c.pos[0], c.pos[1], c.pos[2]);
      l.color.setRGB(Math.max(0, c.color[0]), Math.max(0, c.color[1]), Math.max(0, c.color[2]));
      l.intensity = c.power;
      l.distance = c.range;
      lit = true;
    });
    if (lit || this.wasLit) this.v.dirty = true;
    this.wasLit = lit;
  }

  get busy() { return this.runs.length > 0 || this.shots.length > 0 || this.beams.length > 0 || this.flashes.length > 0 || !!this.wasLit; }

  // only a map's own effects play (no round, beam or flash): they move on 30 times a second
  get calm() { return !this.shots.length && !this.beams.length && !this.flashes.length && this.runs.every((r) => r.run.ambient); }

  // Maps: the map's sun and sky (colours as the view lights with them) light the lit particles, smoke
  // and dust; null: the studio's light again
  setMapLight(l) {
    this.mapLight = l;
    if (l) { this.sun.value.copy(l.sun); this.sky.value.copy(l.sky); } else { this.sun.value.setRGB(0.85, 0.82, 0.76); this.sky.value.setRGB(0.42, 0.45, 0.5); }
    this.v.dirty = true;
  }

  clear() {
    for (const r of this.runs) { for (const d of r.draws) d?.dispose(this); r.run.onEnd?.(); }
    this.runs = [];
    for (const s of this.shots) { s.alive = false; s.obj?.removeFromParent(); s.work?.stop(); s.workVoice?.stop(); s.engine?.then((v) => v?.stop()); }
    this.shots = [];
    this.poles = [];
    for (const b of this.beams) b.alive = false;
    this.beams = [];
    this.flashes = [];
    for (const l of this.lights) l.intensity = 0;
    this.wasLit = false;
    this.v.dirty = true;
  }

  // moves every effect on dt seconds (unless paused) and rebuilds what is drawn
  update(dt) { this.advance(this.paused ? 0 : dt); }

  advance(dt) {
    if (this.shots.length) this.fly(dt);
    if (this.beams.length) this.sweep(dt);
    if (this.flashes.length || this.wasLit || this.runs.length) this.light(dt);
    if (!this.runs.length) return;
    const cam = this.v.camera;
    cam.updateMatrixWorld();
    const m = cam.matrixWorld.elements;
    _right.set(m[0], m[1], m[2]).normalize();
    _up.set(m[4], m[5], m[6]).normalize();
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    const ld = this.v.keyDir.clone().transformDirection(cam.matrixWorldInverse);
    // (one pixel's width a metre away: for minPx)
    this.pxAt1m = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, this.v.renderer.domElement.clientHeight || 600);
    this.floorY.value = this.v.mode === 'map' ? -1e9 : this.v.floor.position.y; // (a map has no stage floor to fade into)
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const { run, draws } = this.runs[i];
      run.step(dt);
      if (run.done) {
        for (const d of draws) d?.dispose(this);
        this.runs.splice(i, 1);
        run.onEnd?.();
        continue;
      }
      const gain = run.gain ? run.gain() : 1, cover = run.coverGain ? run.coverGain() : 1;
      run.em.forEach((s, k) => {
        const d = draws[k];
        if (!d) return;
        d.gain = d.add ? gain : d.lit ? 1 : cover;
        d.minPx = run.minPx || 0;
        d.u.lightDir?.value.copy(ld);
        if (!run.beam) this.fill(d, s.parts, run.start);
        else if (d.e.orient === ORIENT.TRAIL) this.fillBeam(d, s.parts, run.beam);
        else this.fill(d, along(s.parts, run.beam)); // (its sparks and glows spread along it)
      });
    }
    this.v.dirty = true;
  }

  // start: where a round left the gun (its tracers end there: fresh from the barrel, a machine
  // gun's 13..19 m streak would otherwise reach back through the gun and out behind it)
  fill(d, parts, start = null) {
    if (d.e.orient === ORIENT.TRAIL) return this.fillTrail(d, parts);
    if (d.e.orient === ORIENT.MESH) return this.fillMesh(d, parts);
    const e = d.e, [cols, rows] = e.grid, frames = cols * rows;
    let n = 0;
    // smoke: far ones first
    const list = d.add ? parts : parts.slice().sort((a, b) => dist2(b.pos) - dist2(a.pos));
    for (const p of list) {
      if (n >= d.cap) break;
      const o = p.out;
      const a = Math.max(0, Math.min(1, o.alpha));
      if (a <= 0.002) continue;
      const size = Math.abs(o.size);
      let w = size * Math.abs(o.sizeX), h = size * Math.abs(o.sizeY);
      if (w <= 0 || h <= 0) continue;
      const P = _camPos, P0 = p.pos;
      if (d.minPx) { // (no smaller than minPx pixels where it is)
        const m = d.minPx * this.pxAt1m * Math.hypot(P0[0] - P.x, P0[1] - P.y, P0[2] - P.z);
        if (w < m) w = m;
        if (h < m && e.orient !== ORIENT.VELOCITY) h = m;
      }
      let ax, ay, az, bx, by, bz; // the quad's half-width and half-height vectors
      let cx = P0[0], cy = P0[1], cz = P0[2];
      let rx = 1, ry = 0; // the sprite's right on screen (for the lighting)
      let vk = 1; // (how much of the texture's height a cut streak keeps, from its head)
      if (e.alongFlight) {
        _v.set(p.vel[0], p.vel[1], p.vel[2]);
        let speed = _v.length();
        // (standing still, it keeps the way it last flew, or the way its spawner pointed: the
        // grenade launcher's flash has no speed at all; riding a round, it lies along the round's
        // flight, as long as its own drift makes it: fx.js ride)
        if (p.flow) _v.fromArray(p.flow);
        else if (speed < 1e-4) { _v.fromArray(p.dir); speed = 0; } else { _v.divideScalar(speed); p.dir[0] = _v.x; p.dir[1] = _v.y; p.dir[2] = _v.z; }
        _cam.set(P.x - cx, P.y - cy, P.z - cz).normalize();
        _s.crossVectors(_v, _cam);
        if (_s.lengthSq() < 1e-8) _s.copy(_right); else _s.normalize();
        let len = h;
        if (e.orient === ORIENT.VELOCITY) {
          len = e.stretch ? h * speed : h;
          if (p.flow && start) {
            const ahead = (P0[0] - start[0]) * _v.x + (P0[1] - start[1]) * _v.y + (P0[2] - start[2]) * _v.z;
            if (ahead <= 0) continue;
            if (len > ahead) { vk = ahead / len; len = ahead; }
          }
          // a streak runs back from the particle (its head) along its flight
          cx -= _v.x * len / 2; cy -= _v.y * len / 2; cz -= _v.z * len / 2;
        }
        ax = _s.x * w / 2; ay = _s.y * w / 2; az = _s.z * w / 2;
        bx = _v.x * len / 2; by = _v.y * len / 2; bz = _v.z * len / 2;
      } else {
        const c = Math.cos(p.angle), s = Math.sin(p.angle);
        rx = c; ry = s;
        _d.copy(_right).multiplyScalar(c).addScaledVector(_up, s);
        _s.copy(_up).multiplyScalar(c).addScaledVector(_right, -s);
        ax = _d.x * w / 2; ay = _d.y * w / 2; az = _d.z * w / 2;
        bx = _s.x * h / 2; by = _s.y * h / 2; bz = _s.z * h / 2;
      }
      // corners: top-left, top-right, bottom-right, bottom-left (top: the texture's first row)
      const q = n * 12;
      d.pos[q] = cx - ax + bx; d.pos[q + 1] = cy - ay + by; d.pos[q + 2] = cz - az + bz;
      d.pos[q + 3] = cx + ax + bx; d.pos[q + 4] = cy + ay + by; d.pos[q + 5] = cz + az + bz;
      d.pos[q + 6] = cx + ax - bx; d.pos[q + 7] = cy + ay - by; d.pos[q + 8] = cz + az - bz;
      d.pos[q + 9] = cx - ax - bx; d.pos[q + 10] = cy - ay - by; d.pos[q + 11] = cz - az - bz;
      const fr = p.frame * frames;
      let f = Math.floor(fr), fn = f, fk = 0;
      if (d.mv) { // (a 2.41 flip-book morphs on into the next frame; the last of a run through stays)
        if (fr >= frames - 1 && fr <= frames) f = fn = frames - 1;
        else { fn = f + 1; fk = fr - f; }
      }
      f = ((f % frames) + frames) % frames;
      fn = ((fn % frames) + frames) % frames;
      const u0 = (f % cols) / cols, v0 = Math.floor(f / cols) / rows, u1 = u0 + 1 / cols, v1 = v0 + vk / rows;
      const du = (fn % cols) / cols - u0, dv = Math.floor(fn / cols) / rows - v0;
      const t = n * 8;
      d.uv[t] = u0; d.uv[t + 1] = v0; d.uv[t + 2] = u1; d.uv[t + 3] = v0; d.uv[t + 4] = u1; d.uv[t + 5] = v1; d.uv[t + 6] = u0; d.uv[t + 7] = v1;
      const k = (d.add && !d.rampOnly ? d.glow : 1) * d.gain; // (a ramp's glow: its heat stays as it is, heatK brightens)
      const r = Math.max(0, o.rgb[0]) * k, g = Math.max(0, o.rgb[1]) * k, b = Math.max(0, o.rgb[2]) * k;
      for (let j = 0; j < 4; j++) {
        const cI = n * 16 + j * 4;
        d.col[cI] = r; d.col[cI + 1] = g; d.col[cI + 2] = b; d.col[cI + 3] = a;
        const bI = n * 12 + j * 3;
        d.bas[bI] = rx; d.bas[bI + 1] = ry; d.bas[bI + 2] = 1;
        d.nx[bI] = du; d.nx[bI + 1] = dv; d.nx[bI + 2] = fk;
      }
      n++;
    }
    this.upload(d, n);
  }

  upload(d, n) {
    const g = d.mesh.geometry;
    g.setDrawRange(0, n * 6);
    for (const name of ['position', 'uv', 'color', 'basis', 'next']) {
      const at = g.getAttribute(name);
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize * 4);
      at.needsUpdate = true;
    }
  }

  // Mesh particles: each at its place, turned by its own angles (rot3, x y z) in the frame of the
  // node it was fired from (the dome's axis is the barrel's: the spawner's turn is for its flight),
  // sized by its width, height and size (depth: the mean of width and height).
  fillMesh(d, parts) {
    for (const { im, ic } of d.items) {
      let n = 0;
      for (const p of parts) {
        if (n >= d.cap) break;
        const o = p.out, a = Math.max(0, Math.min(1, o.alpha));
        if (a <= 0.002) continue;
        const sz = Math.abs(o.size), sx = sz * Math.abs(o.sizeX), sy = sz * Math.abs(o.sizeY);
        if (sx <= 0 && sy <= 0) continue;
        _e4.set(p.rot3[0], p.rot3[1], p.rot3[2], 'XYZ');
        _q4.setFromEuler(_e4);
        if (p.origin) { _o4.fromArray(p.origin); _o4.decompose(_p4, _m4q, _s4); _q4.premultiply(_m4q); }
        _p4.set(p.pos[0], p.pos[1], p.pos[2]);
        _s4.set(sx || 1e-4, sy || 1e-4, (sx + sy) / 2 || 1e-4);
        _m4.compose(_p4, _q4, _s4);
        im.setMatrixAt(n, _m4);
        const k = (d.add ? d.glow : 1) * (d.gain ?? 1);
        ic.array.set([Math.max(0, o.rgb[0]) * k, Math.max(0, o.rgb[1]) * k, Math.max(0, o.rgb[2]) * k, a], n * 4);
        n++;
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      ic.needsUpdate = true;
    }
  }

  // A beam's ribbons (see beam): every particle of a beam's ribbon emitter is the whole beam once,
  // from the fire point to the far end, bent at its middle by how far the particle has moved across
  // the line (its jitter), facing the camera, as wide, bright and coloured as the particle, the
  // texture (its flip-book frame) once along it. They come 5 to 100 a second and fade within a few
  // hundredths: a laser revolver's shot is one, a gatling laser's beam pulses with them ten times a
  // second, a Tesla's lightning texture flickers from bolt to bolt. The newest are drawn first.
  fillBeam(d, parts, b) {
    const f = b.frame, P = _camPos, e = d.e, [cols, rows] = e.grid, frames = cols * rows;
    const list = parts.slice().sort((x, y) => y.seq - x.seq);
    const mid = [0, 0, 0], ends = [b.from, mid, b.to];
    let q = 0;
    for (const p of list) {
      if (q + 2 > d.cap) break;
      const out = p.out, a = Math.max(0, Math.min(1, out.alpha)), w = Math.abs(out.size * out.sizeX) / 2;
      if (a <= 0.002 || !(w > 0)) continue;
      let lx = 0, ly = 0;
      if (b.toFn) { // (a rope, a fence's bolt: straight, a rope sagging a little)
        ly = 0;
      } else if (p.local) { lx = p.lpos[0]; ly = p.lpos[1]; } else {
        const h = p.home || b.from, ox = p.pos[0] - h[0], oy = p.pos[1] - h[1], oz = p.pos[2] - h[2];
        lx = ox * f[0] + oy * f[1] + oz * f[2];
        ly = ox * f[4] + oy * f[5] + oz * f[6];
      }
      for (let k = 0; k < 3; k++) mid[k] = (b.from[k] + b.to[k]) / 2 + f[k] * lx + f[4 + k] * ly;
      if (b.spec.sag) mid[1] -= Math.min(0.6, b.len * b.spec.sag);
      let fr = Math.floor(p.frame * frames);
      fr = ((fr % frames) + frames) % frames;
      const u0 = (fr % cols) / cols, v0 = Math.floor(fr / cols) / rows, du = 1 / cols, dv = 1 / rows;
      const kk = (d.add && !d.rampOnly ? d.glow : 1) * (d.gain ?? 1);
      const r = Math.max(0, out.rgb[0]) * kk, g = Math.max(0, out.rgb[1]) * kk, bl = Math.max(0, out.rgb[2]) * kk;
      for (let seg = 0; seg < 2; seg++, q++) {
        const o = q * 12, t = q * 8;
        for (let j = 0; j < 2; j++) {
          const pt = ends[seg + j], along = (seg + j) / 2;
          // across the beam, facing the camera (the beam's own way at its ends, its bend's at the middle)
          const A = ends[seg], B = ends[seg + 1];
          _v.set(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
          if (_v.lengthSq() < 1e-12) _v.set(f[8], f[9], f[10]); else _v.normalize();
          _cam.set(P.x - pt[0], P.y - pt[1], P.z - pt[2]).normalize();
          _s.crossVectors(_v, _cam);
          if (_s.lengthSq() < 1e-8) _s.copy(_right); else _s.normalize();
          const c0 = j === 0 ? 0 : 2, sgn = j === 0 ? [-1, 1] : [1, -1];
          for (let m = 0; m < 2; m++) {
            const c = (c0 + m) * 3;
            d.pos[o + c] = pt[0] + _s.x * w * sgn[m];
            d.pos[o + c + 1] = pt[1] + _s.y * w * sgn[m];
            d.pos[o + c + 2] = pt[2] + _s.z * w * sgn[m];
            d.uv[t + (c0 + m) * 2] = u0 + (sgn[m] < 0 ? 0 : du);
            d.uv[t + (c0 + m) * 2 + 1] = v0 + dv * along;
            const cI = q * 16 + (c0 + m) * 4;
            d.col[cI] = r; d.col[cI + 1] = g; d.col[cI + 2] = bl; d.col[cI + 3] = a;
            const bI = q * 12 + (c0 + m) * 3;
            d.bas[bI] = 1; d.bas[bI + 1] = 0; d.bas[bI + 2] = 1;
          }
        }
      }
    }
    this.upload(d, q);
  }

  // A trail (ORIENT.TRAIL: barrel smoke wisps, rocket exhaust): a ribbon through the emitter's
  // particles in the order they were born, as wide as each one's size, facing the camera; the
  // texture runs along it by the particles' age (new at one end, old at the other).
  fillTrail(d, parts) {
    const list = parts.slice().sort((a, b) => a.seq - b.seq);
    let n = 0;
    const P = _camPos;
    for (let i = 0; i + 1 < list.length && n < d.cap; i++) {
      const ends = [list[i], list[i + 1]];
      const q = n * 12, t = n * 8;
      ends.forEach((p, j) => {
        const k = i + j, prev = list[Math.max(0, k - 1)], next = list[Math.min(list.length - 1, k + 1)];
        _v.set(next.pos[0] - prev.pos[0], next.pos[1] - prev.pos[1], next.pos[2] - prev.pos[2]);
        if (_v.lengthSq() < 1e-12) _v.copy(_up); else _v.normalize();
        _cam.set(P.x - p.pos[0], P.y - p.pos[1], P.z - p.pos[2]).normalize();
        _s.crossVectors(_v, _cam);
        if (_s.lengthSq() < 1e-8) _s.copy(_right); else _s.normalize();
        const o = p.out, w = Math.abs(o.size * o.sizeX) / 2, v = Math.min(1, p.age / p.life);
        // this end's two corners: (j = 0) top-left, top-right; (j = 1) bottom-right, bottom-left
        const c0 = j === 0 ? 0 : 2, sgn = j === 0 ? [-1, 1] : [1, -1];
        for (let m = 0; m < 2; m++) {
          const c = (c0 + m) * 3;
          d.pos[q + c] = p.pos[0] + _s.x * w * sgn[m];
          d.pos[q + c + 1] = p.pos[1] + _s.y * w * sgn[m];
          d.pos[q + c + 2] = p.pos[2] + _s.z * w * sgn[m];
          d.uv[t + (c0 + m) * 2] = sgn[m] < 0 ? 0 : 1;
          d.uv[t + (c0 + m) * 2 + 1] = v;
          const cI = n * 16 + (c0 + m) * 4, a = Math.max(0, Math.min(1, o.alpha)), kk = (d.add ? d.glow : 1) * (d.gain ?? 1);
          d.col[cI] = Math.max(0, o.rgb[0]) * kk; d.col[cI + 1] = Math.max(0, o.rgb[1]) * kk; d.col[cI + 2] = Math.max(0, o.rgb[2]) * kk; d.col[cI + 3] = a;
          const bI = n * 12 + (c0 + m) * 3;
          d.bas[bI] = 1; d.bas[bI + 1] = 0; d.bas[bI + 2] = 1;
        }
      });
      n++;
    }
    this.upload(d, n);
  }
}

const _camPos = new THREE.Vector3();
const _pm = new THREE.Matrix4(), _pr = new THREE.Matrix4(), _AX = new THREE.Vector3(1, 0, 0), _AY = new THREE.Vector3(0, 1, 0), _AZ = new THREE.Vector3(0, 0, 1);

// a round's frame now: at its place, +Z along its flight (a spiralling rocket's: along its helix),
// +Y as near its gun's up as that allows
function frameAlong(s) {
  const f = s.frame, v = (s.state === 'fly' && s.look) || s.vel, l = Math.hypot(v[0], v[1], v[2]) || 1;
  const z = [v[0] / l, v[1] / l, v[2] / l];
  let x = [s.up[1] * z[2] - s.up[2] * z[1], s.up[2] * z[0] - s.up[0] * z[2], s.up[0] * z[1] - s.up[1] * z[0]];
  let xl = Math.hypot(x[0], x[1], x[2]);
  if (xl < 1e-6) { x = [1, 0, 0]; xl = 1; }
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  f.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, s.pos[0], s.pos[1], s.pos[2], 1]);
  return f;
}
// A guided missile turns its flight towards the mark, at most so fast: spec.homing radians a second
// at launch, 4 more each second it flies, and always enough to turn in half the distance left (a
// tighter turn than its speed alone allows: it never circles the mark, the vertical launchers'
// missiles hook over and dive onto a near one, climb and fall onto a far one).
function steer(s, mark, dt) {
  if (!mark) return;
  const v = s.vel, sp = Math.hypot(v[0], v[1], v[2]);
  const w = [mark[0] - s.pos[0], mark[1] - s.pos[1], mark[2] - s.pos[2]], wl = Math.hypot(w[0], w[1], w[2]);
  if (sp < 1e-6 || wl < 1e-6) return;
  const d = [v[0] / sp, v[1] / sp, v[2] / sp];
  for (let k = 0; k < 3; k++) w[k] /= wl;
  const ang = Math.acos(Math.max(-1, Math.min(1, d[0] * w[0] + d[1] * w[1] + d[2] * w[2])));
  if (ang < 1e-5) return;
  const turn = Math.min(ang, Math.max(s.spec.homing + 4 * s.t, (2 * sp) / wl) * dt);
  const sn = Math.sin(ang);
  if (sn < 1e-4) return; // (straight away from it: any way round will do next step)
  const a = Math.sin(ang - turn) / sn, b = Math.sin(turn) / sn;
  for (let k = 0; k < 3; k++) v[k] = (d[k] * a + w[k] * b) * sp;
}

// a beam effect's sprites and streaks, each moved out along the beam by a fraction of its length it
// keeps (its last random number): views of the particles, the particles untouched
function along(parts, b) {
  const dx = b.to[0] - b.from[0], dy = b.to[1] - b.from[1], dz = b.to[2] - b.from[2];
  return parts.map((p) => {
    const u = p.ch[7], q = Object.create(p), h = p.home || b.from;
    q.pos = [p.pos[0] - h[0] + b.from[0] + dx * u, p.pos[1] - h[1] + b.from[1] + dy * u, p.pos[2] - h[2] + b.from[2] + dz * u];
    return q;
  });
}

// where a round's effect hangs: its frame, moved to its model's nozzle (a rocket's tail)
function frameAt(s) {
  const f = frameAlong(s), o = s.nozzle;
  if (!o) return f;
  const g = s.fxFrame;
  g.set(f);
  for (let k = 0; k < 3; k++) g[12 + k] = f[12 + k] + f[k] * o[0] + f[4 + k] * o[1] + f[8 + k] * o[2];
  return g;
}
const dist2 = (x) => (x[0] - _camPos.x) ** 2 + (x[1] - _camPos.y) ** 2 + (x[2] - _camPos.z) ** 2;
