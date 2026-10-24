// Maps mode: a whole Crossout map in the 3D view, flown through with a free camera.
//   W A S D   fly: W / S where the camera looks, A / D sideways (the arrow keys too)
//   Space     up            Shift   down (E / Q too)
//   1 .. 9    camera speed, 2 m/s .. 400 m/s; the mouse wheel steps it up and down
//   drag      look around (either mouse button)
//   click     select the object under the cursor (Ctrl + click adds or takes away; Ctrl + drag selects
//             what lies in a box); F flies to the selection, H / Delete hides it, Esc lets go
// The map comes from https://xo.data in parts: /mapscene (every placed model, the water, the spawn
// points), /mapterrain (heights), /mapground (the ground colour baked over the whole map, for the
// distance and the minimap) and /mapsplat (the surface map: up close the ground is drawn from its
// own tiled textures, like the game does).
// Models are drawn instanced: one InstancedMesh per model, LOD and piece, the pieces of one LOD
// sharing its placements. Whenever the camera moves, every placement is culled (view distance, view
// frustum) and given the LOD the game's own switch sizes call for at its size on screen.
// Also from the map: its grass (/mapgrass: the game's own placements, per 32 m cell, drawn near the
// camera and thinned out with distance like the game does), its decals (/mapdecals: projected onto
// the ground and the objects by the host, blended by their height masks), its sky (sky.js) and its
// lights (maplights.js: lamps, projectors, their flares and beams).
// Grass and trees get the game's vegetation look on top of their materials (foliage.js).
import * as THREE from 'three';
import { GameSky, fetchProbe } from './sky.js';
import { useLocalProbe, parseXotx, parseXorg } from './viewer.js';
import { presetShafts } from './post.js';
import { setFog } from './fog.js';
import { Water } from './water.js';
import { grassLook, treeLook, setWind, stepWind } from './foliage.js';
import { MapLights } from './maplights.js';
import { TURN_ANGLE } from './shadows.js';
import { noteShaders, builders } from './warmup.js';

const DATA = 'https://xo.data';
const enc = encodeURIComponent;
export const SPEEDS = [2, 5, 10, 20, 35, 60, 100, 200, 400]; // m/s on the keys 1 .. 9
// Detail: how far out the finer LODs stay, as a factor on the switch sizes (smaller = further).
export const DETAIL = { low: 1, medium: 0.75, high: 0.5, ultra: 0.3 };
const FOV = 60;
const CHUNK = 64; // terrain quads per chunk side at least (chunks out of view are not drawn): about 8 x 8 chunks
// a map (Crossout 2.41's finer grids: 128), so the shadow cascades and the view do not draw hundreds
const MIN_SIZE = 0.0012; // placements smaller than this on screen (about a pixel) are left out
const MAX_VIEW = 8000; // metres: the longest view distance (as far as index.html's slider goes)
const UP = new THREE.Vector3(0, 1, 0);
const SEL_COLOR = 0xffa43c, HOVER_COLOR = 0xffffff; // outlines: the selection, the object under the cursor

async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return r;
}

// "XOTR" / "XOSP": magic, u32 JSON length, JSON, padding to 4 bytes, then the data.
function parseBlob(buf, magic) {
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== magic) throw new Error(`bad ${magic} data`);
  const jl = new DataView(buf).getUint32(4, true);
  return { head: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl))), offset: (8 + jl + 3) & ~3 };
}

// Runs fn over items, n at a time.
async function inPool(items, n, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

// The game's LOD switch values (per LOD 1, 2, ...) look like fractions of the screen a model covers:
// a LOD takes over when the model's size on screen (radius / (distance * tan(fov / 2)), squared, as an
// area) drops below its value. Models without values get a plain ladder.
// what a map object is made of, for its hits (MapView.segmentHit): 1 metal, 3 stone, 4 wood
const METAL = /wreck|car|truck|bus|tank|container|metal|pipe|crane|plane|heli|train|wagon|barrel|cistern|tower|antenna|lamp|sign|fence|ship|boat|rail/i;
const surfaceOf = (rec) => (rec.group === 'trees' ? 4 : METAL.test(rec.path) ? 1 : 3);

// is (x, z) inside an outline (x0, z0, x1, z1 ...)? (even-odd)
function insideOutline(o, x, z) {
  let inside = false;
  for (let i = 0, j = o.length - 2; i + 1 < o.length; j = i, i += 2) {
    const xi = o[i], zi = o[i + 1], xj = o[j], zj = o[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function lodSwitches(info) {
  const n = Math.max(1, info.lodCount || 1);
  const sw = [];
  for (let k = 1; k < n; k++) {
    const v = info.lodSwitch?.[k - 1];
    sw.push(Math.sqrt(v > 0 && v < 4 ? v : 0.25 / Math.pow(3, k - 1)));
  }
  return sw;
}

// ---- the ground: the map's surfaces, the baked colour where they are too fine to draw ---------------------
// The surface map holds, per texel, three surfaces (5 bits each) and two weights: low = r,
// mid = (1 - r) g, high = (1 - r)(1 - g). Each surface has a texture set (albedo, normal map, gloss map)
// repeating every `tiling` metres, and perhaps a second one mixed in by a tiling noise (its detail set).
// The texels' surfaces are merged first, so each is sampled once, then weighed by how high it stands
// (height blending: the gloss map's red over the preset's HeightMid, sharpened by its BlendRoughness).
// The baked ground (xo::bakeGround) does the same blend; it takes over where a pixel covers more than a
// texel or two of the surface map (whose weights alias there), with its own roughness, metal and AO.
//   textures: albedo (sRGB); normal DXT5nm: x in alpha, y in green (towards the texture's row 0), AO in
//   red (plain normal maps: x, y in red, green); gloss: height in red, gloss in green, metal in blue.
const SPLAT_HEAD = /* glsl */ `
varying vec3 vXoWorld;
float xoNear = 0.0;                     // how much the surfaces show (0: the baked ground alone)
vec3 xoSurfNrm = vec3(0.0, 0.0, 1.0); // the ground's relief (x along +x, y along +z) and occlusion
vec3 xoSurfGls = vec3(0.5, 0.07, 0.0); // its height, gloss and metal
uniform sampler2D xoBakeOrm;            // the baked ground's occlusion, roughness, metal
uniform float xoRoughMin;
uniform float xoMetal;
#ifdef XO_SPLAT
uniform float xoSplatIn;    // the surfaces' textures are in (1); until then they stand in, unread: the baked ground alone
uniform highp usampler2D xoSplat;
uniform highp sampler2DArray xoSurf, xoSurfN, xoSurfG;
uniform sampler2D xoNoise;  // the detail sets' mix (red)
uniform vec4 xoSplatRect;   // game x0, z0, size x, size z
uniform vec2 xoSplatSize;   // texels
uniform float xoSplatOffset; // where texel 0 sits: 0.5 mid-cell, 0 on the vertices (Crossout 2.41)
uniform int xoSurfCount;
uniform vec4 xoSplatFade;   // the surfaces fade out over .x .. .y metres from the camera, and over .z .. .w surface-map texels a pixel
uniform vec4 xoSet[64];     // texture sets (surface s: s, its detail set: s + 32): 1 / tiling, layer (-1: none), turn (rotation + 4 flip), HeightMid
uniform vec4 xoBlend[32];   // per surface: height blending's sharpness, inverted (1), one height (1), the detail noise's out max
uniform vec4 xoMix[32];     // per surface: the detail noise's 1 / tiling, in min, 1 / (in max - in min), out min
uniform float xoAmp[32];    // per surface: its relief in metres (HeightAmplitude: the game displaces the ground by it)
uniform vec4 xoLayer[32];   // per layer: the levels its albedo, normal and gloss sit below the arrays' top (smaller textures), plain normals (1)
uniform vec4 xoArrays;      // log2 of the albedo, normal and gloss arrays' sizes, 1 / anisotropy
uniform vec4 xoDust;        // the weather's cover on the ground: land height, 1 / (1 - sharpness), transparency, by normals (1) or by height (2)
uniform vec2 xoDustBand;    // (by height) all over below .x, none from .y up (world heights)
uniform vec4 xoDustColor;   // its colour (linear) and gloss
uniform sampler2D xoDustMask;
uniform vec2 xoDustMaskOn;  // 1 / the mask's tiling (metres), on (1)
// a set's coordinates: mirrored, then turned by quarter turns (Map.cpp turnUv)
vec2 xoTurn(vec2 p, float code) {
  if (code >= 4.0) p.x = -p.x;
  float r = mod(code, 4.0);
  return r < 0.5 ? p : r < 1.5 ? vec2(-p.y, p.x) : r < 2.5 ? -p : vec2(p.y, -p.x);
}
// a set's relief turned back into the world (the texture's y points to its row 0, which is -z in game terms)
vec2 xoTurnBack(vec2 n, float code) {
  vec2 d = vec2(n.x, -n.y);
  float r = mod(code, 4.0);
  d = r < 0.5 ? d : r < 1.5 ? vec2(d.y, -d.x) : r < 2.5 ? -d : vec2(-d.y, d.x);
  if (code >= 4.0) d.x = -d.x;
  return vec2(d.x, -d.y);
}
void xoSample(vec4 set, vec2 g, vec2 gx, vec2 gy, out vec3 a, out vec3 n, out vec3 h) {
  vec3 uvw = vec3(xoTurn(g * set.x, set.z), set.y);
  vec2 dx = xoTurn(gx * set.x, set.z), dy = xoTurn(gy * set.x, set.z);
  vec4 L = xoLayer[int(set.y)];
  // A texture smaller than its array fills the top levels with copies of its pixels: magnified
  // further than its own top level, the gradients are stretched so that level is the one sampled.
  float lx = length(dx), ly = length(dy);
  float lod = log2(max(min(lx, ly), max(lx, ly) * xoArrays.w));
  vec3 k = exp2(max(L.xyz - lod - xoArrays.xyz, 0.0));
  a = textureGrad(xoSurf, uvw, dx * k.x, dy * k.x).rgb;
  vec4 nm = textureGrad(xoSurfN, uvw, dx * k.y, dy * k.y);
  h = textureGrad(xoSurfG, uvw, dx * k.z, dy * k.z).rgb;
  n = L.w > 0.5 ? vec3(nm.rg * 2.0 - 1.0, 1.0) : vec3(nm.ag * 2.0 - 1.0, nm.r);
  n.xy = xoTurnBack(n.xy, set.z);
}
// A displaced surface's relief in depth (parallax occlusion): where the view ray through the point
// first meets its height field ((height - mid) x amp metres over the ground), marched from the top in
// more steps the flatter the view. The heights come from a level of 10 cm texels or coarser, the
// lumps a tessellated ground can show (full-size pebbles came out as spikes). view: towards the
// camera, along the ground (game x, z) and up it (.z), then how much it applies (.w).
vec2 xoParallax(vec4 set, float amp, vec2 g, vec2 gx, vec2 gy, vec4 view) {
  vec2 along = view.xy / view.z;
  float lod = max(log2(max(length(gx), length(gy)) * set.x) + xoArrays.z, log2(0.1 * set.x) + xoArrays.z);
  lod = max(lod, xoLayer[int(set.y)].z);
  float top = amp * (1.0 - set.w), H0 = top, d0 = 0.0, H1 = top, d1 = 0.0, steps = floor(mix(32.0, 8.0, view.z));
  for (int i = 0; i <= 32; i++) {
    if (float(i) > steps) break;
    H1 = mix(top, top - amp, float(i) / steps);
    d1 = (textureLod(xoSurfG, vec3(xoTurn((g + along * H1) * set.x, set.z), set.y), lod).r - set.w) * amp;
    if (d1 >= H1) break;
    H0 = H1;
    d0 = d1;
  }
  float f = clamp((H0 - d0) / max(1e-4, (H0 - d0) - (H1 - d1)), 0.0, 1.0); // (between the last two steps)
  return g + along * mix(H0, H1, f) * view.w;
}
vec3 xoGround(vec2 g, vec2 gx, vec2 gy, vec3 fallback, vec4 view) {
  // the four surface texels around the point, their surfaces merged
  vec2 t = (g - xoSplatRect.xy) / xoSplatRect.zw * xoSplatSize - xoSplatOffset;
  vec2 b = floor(t), f = t - b;
  ivec2 i0 = ivec2(b), hi = ivec2(xoSplatSize) - 1;
  int ids[8];
  float ws[8];
  int n = 0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    float wk = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    uvec4 s = texelFetch(xoSplat, clamp(i0 + o, ivec2(0), hi), 0);
    uint idx = s.r | (s.g << 8u);
    float r = float(s.b) / 255.0, q = float(s.a) / 255.0;
    vec3 w3 = vec3(r, (1.0 - r) * q, (1.0 - r) * (1.0 - q));
    for (int l = 0; l < 3; l++) {
      float wl = wk * w3[l];
      int si = int((idx >> uint(5 * l)) & 31u);
      if (wl < 1e-3 || si >= xoSurfCount) continue;
      int j = 0;
      for (; j < n; j++) if (ids[j] == si) break;
      if (j == n) {
        if (n == 8) continue;
        ids[n] = si;
        ws[n] = 0.0;
        n++;
      }
      ws[j] += wl;
    }
  }
  if (n == 0) return fallback;
  // the surface with the most relief here (by its share) is seen in depth; all are looked up there
  vec2 gs = g;
  if (view.w > 0.0) {
    int pj = 0;
    for (int j = 1; j < 8; j++) if (j < n && ws[j] * xoAmp[ids[j]] > ws[pj] * xoAmp[ids[pj]]) pj = j;
    float amp = ws[pj] * xoAmp[ids[pj]];
    if (amp > 0.0) gs = xoParallax(xoSet[ids[pj]], amp, g, gx, gy, view);
  }
  // each surface once, weighed by how high it stands over its mid
  vec3 col = vec3(0.0), nrm = vec3(0.0), gls = vec3(0.0);
  float tot = 0.0;
  for (int j = 0; j < 8; j++) {
    if (j >= n) break;
    int si = ids[j];
    vec4 base = xoSet[si], extra = xoSet[si + 32], bl = xoBlend[si];
    vec3 a, nm, h;
    xoSample(base, gs, gx, gy, a, nm, h);
    float hr = h.r - base.w;
    if (extra.y >= 0.0) {
      vec4 mx = xoMix[si];
      float m = mix(mx.w, bl.w, clamp((textureGrad(xoNoise, gs * mx.x, gx * mx.x, gy * mx.x).r - mx.y) * mx.z, 0.0, 1.0));
      if (m > 0.0) {
        vec3 a2, n2, h2;
        xoSample(extra, gs, gx, gy, a2, n2, h2);
        a = mix(a, a2, m);
        nm = mix(nm, n2, m);
        h.gb = mix(h.gb, h2.gb, m);
        hr = mix(hr, h2.r - extra.w, m);
      }
    }
    if (bl.y > 0.5) hr = -hr;
    if (bl.z > 0.5) hr = 0.0;
    float w = ws[j] * exp2(bl.x * hr);
    col += w * a;
    nrm += w * nm;
    gls += w * vec3(hr + 0.5, h.g, h.b);
    tot += w;
  }
  xoSurfNrm = nrm / tot;
  xoSurfGls = gls / tot;
  return col / tot;
}
#endif
`;
const SPLAT_MAP = /* glsl */ `
vec3 xoCol = vec3( 0.5 ); // (the bake's colour for a surface without textures, until it is in)
vec3 xoOrm = vec3( 1.0, 0.93, 0.0 );
#ifdef USE_MAP
  xoCol = texture2D( map, vMapUv ).rgb;
  xoOrm = texture2D( xoBakeOrm, vMapUv ).rgb;
#endif
xoSurfNrm.z = xoOrm.r;
xoSurfGls.yz = vec2( 1.0 - xoOrm.g, xoOrm.b );
#ifdef XO_SPLAT
  vec2 xoG = vec2( vXoWorld.x, - vXoWorld.z ); // game x, z
  vec2 xoGx = dFdx( xoG ), xoGy = dFdy( xoG );
  vec3 xoUp = inverseTransformDirection( normalize( vNormal ), viewMatrix ); // (the height grid's)
  float xoDist = distance( vXoWorld, cameraPosition );
  float xoTexels = max( length( xoGx ), length( xoGy ) ) * xoSplatSize.x / xoSplatRect.z;
  xoNear = xoSplatIn * ( 1.0 - smoothstep( xoSplatFade.x, xoSplatFade.y, xoDist ) ) * ( 1.0 - smoothstep( xoSplatFade.z, xoSplatFade.w, xoTexels ) );
  if ( xoNear > 0.0 ) {
    // the view for the displaced surfaces' depth (within 40 m; gentler at grazing angles)
    vec3 xoV = ( cameraPosition - vXoWorld ) / xoDist;
    float xoVn = dot( xoV, xoUp );
    vec3 xoVt = xoV - xoUp * xoVn;
    vec4 xoView = vec4( xoVt.x, - xoVt.z, max( xoVn, 0.3 ), 1.0 - smoothstep( 25.0, 40.0, xoDist ) );
    vec3 xoFar = xoCol, xoFarN = xoSurfNrm, xoFarG = xoSurfGls;
    xoCol = mix( xoFar, xoGround( xoG, xoGx, xoGy, xoFar, xoView ), xoNear );
    xoSurfNrm = mix( xoFarN, xoSurfNrm, xoNear );
    xoSurfGls = mix( xoFarG, xoSurfGls, xoNear );
  }
  // the weather's cover (snow, a wet film, dust): its mask's height rule, as the decals' (all over
  // without a mask), off steep slopes, or below its band (by height); it keeps a third of the relief under it
  if ( xoDust.z > 0.0 && xoSplatIn > 0.5 ) {
    float up = xoDust.w > 1.5 ? ( xoDustBand.y > xoDustBand.x ? clamp( ( xoDustBand.y - vXoWorld.y ) / ( xoDustBand.y - xoDustBand.x ), 0.0, 1.0 ) : 1.0 - step( xoDustBand.x, vXoWorld.y ) )
      : xoDust.w > 0.5 ? smoothstep( 0.25, 0.65, xoUp.y ) : 1.0;
    float mask = xoDustMaskOn.y > 0.5 ? texture2D( xoDustMask, xoG * xoDustMaskOn.x ).r : 1.0;
    float cov = clamp( ( mask - 1.0 + xoDust.x ) * xoDust.y, 0.0, 1.0 ) * up * xoDust.z;
    if ( xoDust.w > 1.5 ) cov *= xoSurfGls.y; // (the film by height: as glossy as the ground under it)
    xoCol = mix( xoCol, xoDustColor.rgb, cov );
    xoSurfGls.yz = mix( xoSurfGls.yz, vec2( xoDustColor.a, 0.0 ), cov );
    xoSurfNrm = vec3( xoSurfNrm.xy * ( 1.0 - 0.65 * cov ), mix( xoSurfNrm.z, 1.0, cov ) );
  }
#endif
diffuseColor.rgb *= xoCol;
`;
// The terrain's material (its uniforms in userData.splat): the surfaces' blend (SPLAT_*), the baked
// ground (map) and the light its hills leave it (shadows.js XO_TERRAIN_LIGHT: host Map.cpp
// bakeTerrainLight, for the game sky's sun; the sun's part as one more shadow, the sky's on its ambient
// light, off until it is in and under the plain sky). The bake and the surfaces' textures stand in
// (grey, none: xoSplatIn 0) until they are in, so the shader is the one it ends with from the start.
export function terrainMaterial(viewer, viewDistance) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0 });
  const v4 = (n, x = 0, y = 0, z = 0, w = 0) => Array.from({ length: n }, () => new THREE.Vector4(x, y, z, w));
  const u = {
    xoSplat: { value: SPLAT_NONE }, xoSurf: { value: SURF_NONE }, xoSurfN: { value: SURF_NONE }, xoSurfG: { value: SURF_NONE }, xoNoise: { value: null }, xoSplatIn: { value: 0 },
    xoSplatRect: { value: new THREE.Vector4() }, xoSplatSize: { value: new THREE.Vector2() }, xoSplatOffset: { value: 0.5 }, xoSurfCount: { value: 0 },
    xoSplatFade: { value: new THREE.Vector4(viewDistance * SPLAT_FADE[0], viewDistance * SPLAT_FADE[1], SPLAT_FADE[2], SPLAT_FADE[3]) },
    xoSet: { value: v4(64, 0.125, -1, 0, 0.5) }, xoBlend: { value: v4(32) }, xoMix: { value: v4(32) }, xoAmp: { value: new Array(32).fill(0) }, xoLayer: { value: v4(32) },
    xoArrays: { value: new THREE.Vector4(10, 10, 10, 1 / 16) },
    xoBakeOrm: { value: NO_ORM }, xoRoughMin: { value: 0.05 }, xoMetal: viewer.metal, // (as the map's other materials)
    xoDust: { value: new THREE.Vector4() }, xoDustBand: { value: new THREE.Vector2() }, xoDustColor: { value: new THREE.Vector4() }, xoDustMask: { value: null }, xoDustMaskOn: { value: new THREE.Vector2() },
    xoTerrainLight: { value: null }, xoTerrainUv: { value: new THREE.Vector4() }, xoTerrainOn: { value: 0 },
  };
  mat.userData.splat = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    useLocalProbe(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vXoWorld;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvXoWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SPLAT_HEAD)
      .replace('#include <map_fragment>', SPLAT_MAP)
      .replace('#include <roughnessmap_fragment>', SPLAT_ROUGH)
      .replace('#include <metalnessmap_fragment>', SPLAT_METAL)
      .replace('#include <normal_fragment_maps>', SPLAT_NORMAL)
      .replace('#include <aomap_fragment>', SPLAT_AO);
  };
  mat.customProgramCacheKey = () => 'xo-terrain-2';
  mat.defines = { XO_TERRAIN_LIGHT: '', XO_SPLAT: '' };
  mat.map = GROUND_NONE;
  mat.shadowSide = THREE.FrontSide; // (an open surface: drawn as it faces the sun, hills shade valleys)
  mat.userData.warmKind = 'terrain'; // (warmup.js)
  return mat;
}
// (a decal's texture while it loads: it is hidden till then, decalMaterial)
const DECAL_STAND_IN = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
DECAL_STAND_IN.needsUpdate = true;
// (what stands in: the bake's grey, exactly 0.5; a surface map of surface 0; one empty texture set)
const GROUND_NONE = new THREE.DataTexture(new Float32Array([0.5, 0.5, 0.5, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
GROUND_NONE.minFilter = GROUND_NONE.magFilter = THREE.NearestFilter;
GROUND_NONE.needsUpdate = true;
const SPLAT_NONE = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedByteType);
SPLAT_NONE.internalFormat = 'RGBA8UI';
SPLAT_NONE.minFilter = SPLAT_NONE.magFilter = THREE.NearestFilter;
SPLAT_NONE.generateMipmaps = false;
SPLAT_NONE.needsUpdate = true;
const SURF_NONE = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
SURF_NONE.needsUpdate = true;

// Where the surfaces give way to the baked ground: over these shares of the view distance, and over
// these many surface-map texels a pixel (further out their weights alias; the bake is filtered).
const SPLAT_FADE = [0.8, 1, 1.5, 3];
// the baked ground's occlusion, roughness and metal until /mapground has sent them: none, 0.93, none
const NO_ORM = new THREE.DataTexture(new Uint8Array([255, 237, 0, 255]), 1, 1);
NO_ORM.needsUpdate = true;
// roughness = 1 - gloss (no smoother than the map's other materials), metal by the shared metal factor
const SPLAT_ROUGH = /* glsl */ `
float roughnessFactor = max( xoRoughMin, 1.0 - xoSurfGls.y );
`;
const SPLAT_METAL = /* glsl */ `
float metalnessFactor = xoSurfGls.z * xoMetal;
`;
// the surfaces' relief on the height grid's normal (tangent +x, bitangent +z: the textures' frame)
const SPLAT_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
if ( dot( xoSurfNrm.xy, xoSurfNrm.xy ) > 0.0 ) {
  vec3 xoNw = inverseTransformDirection( normal, viewMatrix );
  vec3 xoT = normalize( vec3( 1.0, 0.0, 0.0 ) - xoNw * xoNw.x ), xoB = cross( xoT, xoNw );
  vec3 xoN = xoT * xoSurfNrm.x + xoB * xoSurfNrm.y + xoNw * sqrt( max( 0.0, 1.0 - dot( xoSurfNrm.xy, xoSurfNrm.xy ) ) );
  normal = normalize( ( viewMatrix * vec4( xoN, 0.0 ) ).xyz );
}
`;
// their occlusion (the normal maps' red) on the light from the sky
const SPLAT_AO = /* glsl */ `
#include <aomap_fragment>
reflectedLight.indirectDiffuse *= xoSurfNrm.z;
reflectedLight.indirectSpecular *= xoSurfNrm.z;
`;

// The surface textures' arrays: what the game stores each as, and a layer's fill where a texture is
// missing (the bake's grey; a flat normal without occlusion; height at its mid, gloss 0.07, no metal).
const SURF_ROLES = ['albedo', 'normal', 'gloss'];
const SURF_FORMAT = { albedo: { format: 'BC1', srgb: true }, normal: { format: 'BC3', srgb: false }, gloss: { format: 'BC1', srgb: false } };
const SURF_FALLBACK = { albedo: [188, 188, 188, 255], normal: [255, 128, 255, 128], gloss: [128, 18, 0, 255] };

// count bytes of BC1 (B = 8) or BC3 (B = 16) blocks of one colour
function fillBlocks([r, g, b, a], B, count) {
  const c = ((r * 31 / 255 + 0.5) << 11) | ((g * 63 / 255 + 0.5) << 5) | (b * 31 / 255 + 0.5);
  const block = new Uint8Array(B);
  if (B === 16) block.set([a, a]); // (alpha: both ends the same, every index 0)
  block.set([c & 255, c >> 8, c & 255, c >> 8], B - 8); // (colour: both ends the same, every index 0)
  const out = new Uint8Array(count);
  for (let o = 0; o < count; o += B) out.set(block, o);
  return out;
}

// A BC1 / BC3 picture w pixels a side made f times bigger (f = 2, 4, 8 ...) without decoding it: each
// new block keeps the end colours of the block its pixels come from and repeats their indices (2 bits a
// pixel for the colour, 3 for BC3's alpha), so every pixel becomes f x f of the same.
function upscaleBlocks(src, w, B, f) {
  const sb = w >> 2, db = (w * f) >> 2, out = new Uint8Array(db * db * B);
  for (let by = 0; by < db; by++) {
    for (let bx = 0; bx < db; bx++) {
      const x0 = (bx * 4) / f, y0 = (by * 4) / f; // (the block's first source pixel)
      const s = ((y0 >> 2) * sb + (x0 >> 2)) * B, d = (by * db + bx) * B;
      const px = (c) => (Math.floor(x0 + c / f) & 3), py = (r) => (Math.floor(y0 + r / f) & 3);
      if (B === 16) { // (the alpha's 48 index bits as two halves of 8 pixels)
        out[d] = src[s];
        out[d + 1] = src[s + 1];
        const half = [src[s + 2] | (src[s + 3] << 8) | (src[s + 4] << 16), src[s + 5] | (src[s + 6] << 8) | (src[s + 7] << 16)];
        const bits = [0, 0];
        for (let i = 0; i < 16; i++) {
          const j = py(i >> 2) * 4 + px(i & 3);
          bits[i >> 3] |= ((half[j >> 3] >> (3 * (j & 7))) & 7) << (3 * (i & 7));
        }
        for (let k = 0; k < 6; k++) out[d + 2 + k] = (bits[k >= 3 ? 1 : 0] >> (8 * (k % 3))) & 255;
      }
      const cs = s + B - 8, cd = d + B - 8;
      out.set(src.subarray(cs, cs + 4), cd);
      for (let r = 0; r < 4; r++) {
        let row = 0;
        for (let c = 0; c < 4; c++) row |= ((src[cs + 4 + py(r)] >> (2 * px(c))) & 3) << (2 * c);
        out[cd + 4 + r] = row;
      }
    }
  }
  return out;
}

// ---- the camera ------------------------------------------------------------------------------------------
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class FlyCamera {
  // onClick(event): a left click that didn't drag; onBox(x0, y0, x1, y1, done): Ctrl + left drag
  // draws a box instead of turning the view (client coordinates; done on letting go)
  constructor(viewer, { enabled = () => true, groundAt = () => -Infinity, onSpeed = () => {}, onMove = () => {}, onClick = () => {}, onBox = () => {} } = {}) {
    this.v = viewer;
    this.enabled = enabled;
    this.groundAt = groundAt;
    this.onSpeed = onSpeed;
    this.onMove = onMove;
    this.onClick = onClick;
    this.onBox = onBox;
    this.keys = new Set();
    this.level = 3; // index into SPEEDS (20 m/s)
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.drag = null;
    this.press = null; // the button press: was it a click, a look-around drag or a box?
    this.clock = 0;
    const c = viewer.canvas;
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', (e) => {
      if (this.press?.box) this.onBox(0, 0, 0, 0, 'cancel');
      this.press = null; // (no click, no box)
      this.pointerUp(e);
    });
    // the wheel steps the speed: a notch one step; a touchpad's small deltas add up to one; Shift +
    // wheel arrives sideways (deltaX), and a delta of 0 is no step (it used to count as slower)
    this.wheelAcc = 0;
    c.addEventListener('wheel', (e) => {
      if (!this.enabled()) return;
      e.preventDefault();
      const d = e.deltaY || e.deltaX;
      if (!d) return;
      if (Math.abs(d) >= 40) { this.wheelAcc = 0; this.setLevel(this.level + (d < 0 ? 1 : -1)); return; }
      this.wheelAcc += d;
      if (Math.abs(this.wheelAcc) >= 100) { this.setLevel(this.level + (this.wheelAcc < 0 ? 1 : -1)); this.wheelAcc = 0; }
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => { if (this.enabled()) e.preventDefault(); });
    window.addEventListener('blur', () => this.clear());
    viewer.frameHooks.push(() => this.tick());
  }

  get speed() { return SPEEDS[this.level]; }

  // the camera is being moved (keys held, a drag) or still gliding
  active() { return this.keys.size > 0 || !!this.drag || !!this.press || this.vel.lengthSq() > 1e-6; }

  setLevel(i) {
    const l = THREE.MathUtils.clamp(Math.round(i), 0, SPEEDS.length - 1);
    if (l === this.level) return;
    this.level = l;
    this.onSpeed(l);
  }

  // keydown / keyup from the page: true when the key is the camera's (then it does nothing else)
  key(e, down) {
    if (!down) { const had = this.keys.delete(e.code); return had || MOVE.has(e.code); }
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const d = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (d) { this.setLevel(+d[1] - 1); return true; }
    if (!MOVE.has(e.code)) return false;
    this.keys.add(e.code);
    return true;
  }

  clear() {
    this.keys.clear();
    this.vel.set(0, 0, 0);
    this.drag = null;
    if (this.press?.box) this.onBox(0, 0, 0, 0, 'cancel');
    this.press = null;
  }

  // Points the camera from pos towards target (yaw and pitch: the camera never rolls).
  setPose(pos, target) {
    const cam = this.v.camera;
    cam.position.copy(pos);
    const d = target.clone().sub(pos);
    if (d.lengthSq() < 1e-8) d.set(0, 0, -1);
    d.normalize();
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    this.apply();
    this.vel.set(0, 0, 0);
  }

  // yaw / pitch back from wherever the camera points now (after another mode moved it)
  sync() {
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(this.v.camera.quaternion);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    this.apply();
  }

  apply() {
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.55, 1.55);
    this.v.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.v.camera.updateMatrixWorld();
    this.v.dirty = true;
  }

  pointerDown(e) {
    if (!this.enabled() || (e.button !== 0 && e.button !== 2)) return;
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: 0, box: e.button === 0 && (e.ctrlKey || e.metaKey) };
    try { this.v.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    if (this.press.box) return; // (Ctrl: a box, or a click that adds to the selection)
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.v.canvas.style.cursor = 'grabbing';
  }

  pointerMove(e) {
    const p = this.press;
    if (p && p.id === e.pointerId) {
      p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.x, e.clientY - p.y));
      if (p.box) { if (p.moved >= 5 && this.enabled()) this.onBox(p.x, p.y, e.clientX, e.clientY, false); return; }
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId || !this.enabled()) return;
    const k = 0.0032 * (this.v.camera.fov / FOV); // radians per pixel (finer when zoomed in)
    this.yaw -= (e.clientX - d.x) * k;
    this.pitch -= (e.clientY - d.y) * k;
    d.x = e.clientX;
    d.y = e.clientY;
    this.apply();
    this.onMove();
  }

  pointerUp(e) {
    const p = this.press;
    if (p && p.id === e.pointerId) {
      this.press = null;
      if (this.enabled()) {
        if (p.box && p.moved >= 5) this.onBox(p.x, p.y, e.clientX, e.clientY, true);
        else if (p.button === 0 && p.moved < 5 && performance.now() - p.t < 800) this.onClick(e); // (not a drag to look around)
      }
    }
    if (!this.drag || this.drag.id !== e.pointerId) return;
    this.drag = null;
    this.v.canvas.style.cursor = '';
  }

  get moving() { return this.keys.size > 0 || this.vel.lengthSq() > 1e-6; }

  tick() {
    const now = performance.now();
    const dt = this.clock ? Math.min(0.05, (now - this.clock) / 1000) : 0;
    this.clock = now;
    if (!this.enabled()) { if (this.keys.size || this.drag) this.clear(); return; }
    const k = this.keys;
    const on = (...codes) => (codes.some((c) => k.has(c)) ? 1 : 0);
    const fwdIn = on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown');
    const sideIn = on('KeyD', 'ArrowRight') - on('KeyA', 'ArrowLeft');
    const upIn = on('Space', 'KeyE') - on('ShiftLeft', 'ShiftRight', 'KeyQ');
    const cam = this.v.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); // W flies where the camera looks
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    side.y = 0;
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    const want = fwd.multiplyScalar(fwdIn).addScaledVector(side, sideIn);
    if (want.lengthSq() > 1) want.normalize();
    want.addScaledVector(UP, upIn).multiplyScalar(this.speed);
    const idle = want.lengthSq() === 0;
    if (idle && this.vel.lengthSq() < 0.0004 * this.speed * this.speed) { this.vel.set(0, 0, 0); return; } // stops crisply
    this.vel.lerp(want, 1 - Math.exp(-(idle ? 12 : 7) * dt));
    const p = cam.position.clone().addScaledVector(this.vel, dt);
    const floor = this.groundAt(p.x, p.z) + 1.2; // never into the ground
    if (p.y < floor) { p.y = floor; if (this.vel.y < 0) this.vel.y = 0; }
    if (p.distanceToSquared(cam.position) === 0) return;
    cam.position.copy(p);
    cam.updateMatrixWorld();
    this.v.dirty = true;
    this.onMove();
  }
}

// One placement (i of rec) onto a LOD's list (bucket()), its sphere into the list's bounds.
function place(lod, rec, i) {
  const dst = lod.arr, M = rec.mats, o = lod.count * 16, so = i * 16;
  for (let k = 0; k < 16; k++) dst[o + k] = M[so + k];
  lod.count++;
  const b = lod.bounds, C = rec.centers, r = rec.radii[i];
  for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k], C[i * 3 + k] - r);
    b[k + 3] = Math.max(b[k + 3], C[i * 3 + k] + r);
  }
}

// ---- the map ------------------------------------------------------------------------------------------
export class MapView {
  // getInfo(path, skin): the /model description (shared cache); getModel(path, skin, lod): it and its
  // geometry ({ info, entry }), in one request when neither is in yet; onChange(): stats or progress changed;
  // onSelect(): the selection (or what is hidden) changed
  constructor(viewer, { getInfo, getModel, onChange = () => {}, onSpeed = () => {}, onSelect = () => {}, minimap = null } = {}) {
    this.v = viewer;
    this.getInfo = getInfo;
    this.getModel = getModel || (async (path, skin, lod) => { const info = await getInfo(path, skin); return { info, entry: viewer.acquireGeometry(info.path, lod) }; });
    builders.terrain = () => terrainMaterial(viewer, 1000); // (warmup.js: the ground's and the decals' shaders built ahead)
    builders.decal = (a) => this.decalMaterial(a, null, null, null);
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.sel = new Map();    // object id -> { rec, i }: the selected placements, in the order picked
    this.hover = null;       // { rec, i }: the one under the cursor
    this.hidden = new Map(); // object id -> { rec, i }: hidden from the view (and left out of the map export)
    this.outlined = { sel: null, hover: null }; // their outlines (instanced copies, drawn only into the outline mask)
    this.root = viewer.mapRoot;
    this.scene = null;     // /mapscene
    this.models = [];      // per model + skin + group: placements, LOD meshes
    this.terrain = null;   // heights (for the camera and the minimap)
    this.show = { terrain: true, props: true, trees: true, objects: true, water: true, spawns: true, grass: true, decals: true, sky: true, lights: true };
    this.grassRange = 150; // metres: how far the grass reaches (each kind scaled by its own dist_factor)
    this.sky = null;       // GameSky
    this.grass = null;     // { head, data, types }
    this.decals = null;    // { group, textures }
    this.lights = null;    // MapLights
    this.water = null;     // water.js Water
    this.under = null;     // the water the camera is under (underwater)
    this.detail = 'high';
    this.texMax = 1024;    // largest texture side for the map's models (video memory; most of the game's are 1024)
    this.viewDistance = 1500;
    this.token = 0;
    this.loading = null;   // { models, done, failed, terrain, ground }
    this.drawn = { placements: 0, triangles: 0 };
    this.needsBucket = false;
    this.lastCam = { pos: new THREE.Vector3(NaN, 0, 0), quat: new THREE.Quaternion(), fov: 0, aspect: 0 };
    this.frustum = new THREE.Frustum();
    this.pv = new THREE.Matrix4();
    this.wide = new THREE.Frustum(); // (the view widened by the sun's cascades' turn: bucket())
    this.widePv = new THREE.Matrix4();
    this.minimap = minimap;
    this.mini = null; // { img: canvas with the ground, scale }
    this.fly = new FlyCamera(viewer, {
      enabled: () => viewer.mode === 'map' && !!this.scene && !this.driving, // (Drive has the keys and the mouse)
      groundAt: (x, z) => this.heightAt(x, z),
      onSpeed: (l) => onSpeed(l),
      onMove: () => {},
      onClick: (e) => this.clickAt(e),
      onBox: (x0, y0, x1, y1, done) => this.boxSelect(x0, y0, x1, y1, done),
    });
    if (minimap) this.bindMinimap(minimap);
    viewer.mapHover = (e) => this.hoverAt(e);
    viewer.canvas.addEventListener('dblclick', (e) => { if (this.active && this.scene && e.button === 0 && this.sel.size) this.focusSelection(); });
    viewer.frameHooks.push(() => this.tick());
  }

  get active() { return this.v.mode === 'map'; }

  // Entering / leaving Maps mode (after viewer.setMode).
  modeChanged(mode) {
    if (mode !== 'map') { this.fly.clear(); this.hover = null; this.v.setOutlines([], 'map'); this.underwater(null); return; }
    this.refreshOutlines();
    const cam = this.v.camera;
    cam.fov = FOV;
    cam.near = 0.3;
    cam.updateProjectionMatrix();
    if (this.scene) {
      this.fly.sync();
      this.v.setMapSky(this.viewDistance);
      this.needsBucket = true;
      const pc = this.pendingCam;
      this.pendingCam = null;
      if (pc === 'start') this.goTo('start');
      else if (pc) { this.v.camera.position.copy(pc.pos); this.v.camera.quaternion.copy(pc.quat); this.fly.sync(); }
    }
    this.v.dirty = true;
  }

  // ---- loading ----
  // Resolves when the map's layout is in (models keep arriving afterwards: see this.loading).
  // environment: an envsettings Item id ('' = the map's own pick for the festival and mode).
  async load(name, { festival = 'Empty', gameplay = 'auto', environment = '', keepCamera = false } = {}) {
    const token = ++this.token;
    // The same map again (another mode, festival or texture size) keeps the camera and what was hidden
    // or selected (by object id: the same object in every mode). A reload started before the last
    // one was in keeps what that one was keeping (the scene and the sets are already cleared then).
    let carry = null;
    if (keepCamera && this.scene?.name === name)
      carry = { name, cam: { pos: this.v.camera.position.clone(), quat: this.v.camera.quaternion.clone() }, hidden: [...this.hidden.keys()], sel: [...this.sel.keys()] };
    else if (keepCamera && this.carry?.name === name) carry = this.carry;
    this.carry = carry;
    const camBefore = carry?.cam || null;
    this.clear();
    const q = `name=${enc(name)}&festival=${enc(festival)}&gameplay=${enc(gameplay)}` + (environment ? `&environment=${enc(environment)}` : '');
    this.query = q;
    this.request = { festival, gameplay, environment }; // (as asked: the host keeps one map, keyed by these; "auto" stays "auto")
    this.loading = { models: 0, done: 0, failed: 0, errors: [], terrain: true, ground: true, sky: true, grass: true, decals: true, t0: performance.now() };
    this.onChange();
    let scene;
    try {
      scene = await (await fetchOk(`${DATA}/mapscene?${q}`)).json();
    } catch (e) {
      if (token === this.token) { this.loading = null; this.onChange(); }
      throw e;
    }
    if (token !== this.token) return null;
    this.scene = scene;
    const t = scene.terrain;
    // where the map is: the terrain (centred on the origin), else wherever its objects stand
    const b = MapView.placementBounds(scene);
    this.size = t ? Math.max(t.sizeX, t.sizeZ) : Math.max(200, b.max[0] - b.min[0], b.max[2] - b.min[2]);
    this.centre = t ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3((b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2);
    this.miniRect = { cx: this.centre.x, cz: this.centre.z, span: t ? this.size : this.size * 1.1 };
    this.loading.models = scene.models.length;
    this.loading.terrain = this.loading.ground = !!t;
    this.models = scene.models.map((m) => this.record(m));
    this.top = Math.max(b.max[1], t ? t.maxY : -Infinity) + 50; // (the highest anything stands, about: whose shadow reaches furthest)
    this.viewDistance = this.autoViewDistance();
    this.viewAuto = true;
    if (carry) this.restoreIds(carry);
    this.carry = null;
    this.buildWater();
    this.buildSpawns();
    // (its lights before any model is drawn: their number is part of every shader)
    this.lights = new MapLights(this.v, scene.lights || []);
    this.lights.setShown(this.show.lights);
    this.root.add(this.lights.group);
    if (!t) this.makeMinimap(null); // (its objects as dots: there is no ground to show)
    // the camera: now, or on coming back to Maps when the map was opened from another view (it
    // stayed wherever it was, perhaps under the ground)
    this.pendingCam = camBefore || 'start';
    if (this.active) this.modeChanged('map');
    this.v.prepare(this.waterGroup); // (its shaders built while the rest comes in: under the map's fog, set just now)
    this.onChange();
    const jobs = [];
    if (t) jobs.push(this.loadTerrain(token).catch((e) => {
      if (token !== this.token) return;
      this.loading.errors.push(`terrain: ${e.message}`);
      this.loading.terrain = this.loading.ground = false;
    }));
    // the sky first (it lights everything), grass and decals beside the models
    const part = (key, job) => jobs.push(job.catch((e) => { if (token === this.token) this.loading.errors.push(`${key}: ${e.message}`); }).finally(() => {
      if (token !== this.token) return;
      this.loading[key] = false;
      this.onChange();
    }));
    part('sky', this.loadSky(token));
    part('grass', this.loadGrass(token));
    part('decals', this.loadDecals(token));
    // big things first: what has the most placements is the most of the view
    const order = [...this.models].sort((a, b) => b.n - a.n);
    jobs.push(inPool(order, 6, (rec) => this.loadModel(rec, token)));
    Promise.all(jobs).then(() => {
      if (token !== this.token) return;
      if (this.viewAuto) this.setViewDistance(this.autoViewDistance(), true); // (now with the models' sizes)
      this.loading.finished = performance.now();
      this.onChange();
      this.v.collect();
      setTimeout(() => { if (token === this.token) noteShaders(this.v, this.root); }, 8000); // (warmup.js: what it drew by then)
    });
    return scene;
  }

  // How far the view reaches: from anywhere on the map out to the farthest thing placed (the backdrop
  // mountains stand kilometres out; the models' own sizes once they are in), in 100 m steps.
  autoViewDistance() {
    const c = this.centre, half = this.size / 2;
    let reach = half;
    for (const rec of this.models) {
      for (let i = 0; i < rec.n; i++) {
        const x = rec.centers ? rec.centers[i * 3] : rec.mats[i * 16 + 12], z = rec.centers ? rec.centers[i * 3 + 2] : rec.mats[i * 16 + 14];
        reach = Math.max(reach, Math.hypot(x - c.x, z - c.z) + (rec.radii ? rec.radii[i] : 0));
      }
    }
    return THREE.MathUtils.clamp(Math.ceil((reach + half) / 100) * 100, 800, MAX_VIEW);
  }

  // the box the placements' positions fill
  static placementBounds(scene) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const r of scene.models) {
      for (let i = 9; i + 2 < r.m.length; i += 12) {
        for (let k = 0; k < 3; k++) { const v = r.m[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
      }
    }
    if (min[0] > max[0]) return { min: [-100, 0, -100], max: [100, 0, 100] };
    return { min, max };
  }

  // Drops the map (and stops its loads).
  unload() {
    this.token++;
    this.carry = null;
    this.clear();
    this.loading = null;
  }

  clear() {
    if (this.models.length) noteShaders(this.v, this.root); // (warmup.js: everything it drew)
    this.grid = null;
    this.sel.clear();
    this.selVersion = (this.selVersion || 0) + 1;
    this.hidden.clear();
    this.broken?.clear();
    this.groupOf = this.groupOfModels = null; // (syncDecals' table: it kept the old map's records)
    this.hover = null;
    this.refreshOutlines();
    this.onSelect();
    for (const rec of this.models) {
      for (const lod of rec.lods) for (const m of lod.meshes) { m.parent?.remove(m); m.dispose(); }
      for (const m of rec.materials || []) this.v.disposeMaterial(m);
      if (rec.geoEntry) this.v.geo.release(rec.geoEntry);
    }
    this.models = [];
    // (their geometry and textures belong to the caches: let go of them before the rest is disposed)
    if (this.grass) {
      for (const t of this.grass.types) {
        for (const m of t.meshes) { m.parent?.remove(m); m.dispose(); }
        for (const m of t.materials || []) this.v.disposeMaterial(m);
        if (t.geoEntry) this.v.geo.release(t.geoEntry);
      }
      this.grass = null;
    }
    if (this.decals) {
      this.decals.group.parent?.remove(this.decals.group);
      this.decals.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      for (const e of this.decals.textures) this.v.tex.release(e);
      this.decals = null;
    }
    if (this.sky) {
      this.sky.dispose();
      this.sky = null;
    }
    this.lights?.dispose();
    this.lights = null;
    this.water?.dispose(); // (its textures belong to the caches too)
    this.water = null;
    this.under = null;
    this.v.setMapLight(null);
    this.v.setDust(null);
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      c.traverse((o) => {
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        if (o.material) for (const m of [].concat(o.material)) m.dispose();
      });
    }
    for (const g of this.spawnGeos || []) g.dispose();
    this.spawnGeos = null;
    if (this.splat) { for (const t of this.splat.textures) t.dispose(); this.splat = null; }
    this.terrainLight?.u.xoTerrainLight.value?.dispose();
    this.terrainLight = null;
    this.dustMask?.tex?.dispose();
    this.dustMask = null;
    for (const t of [this.groundTex, this.groundOrm]) {
      t?.image?.close?.(); // (the 4096 px ground pictures: 64 MB each, let go at once rather than whenever)
      t?.dispose();
    }
    this.groundTex = this.groundOrm = null;
    this.env = null; // (a next map whose sky does not load must not show this one's)
    setWind(null);
    this.pendingCam = null;
    this.terrain = null;
    this.terrainMat = null;
    this.scene = null;
    this.mini = null;
    this.drawn = { placements: 0, triangles: 0 };
    this.v.collect({ texBytes: 256e6 });
    this.v.shadowDirty = true;
    this.v.dirty = true;
  }

  record(m) {
    const n = m.m.length / 12;
    const mats = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) {
      const s = m.m, a = i * 12, o = i * 16;
      mats[o] = s[a]; mats[o + 1] = s[a + 1]; mats[o + 2] = s[a + 2];
      mats[o + 4] = s[a + 3]; mats[o + 5] = s[a + 4]; mats[o + 6] = s[a + 5];
      mats[o + 8] = s[a + 6]; mats[o + 9] = s[a + 7]; mats[o + 10] = s[a + 8];
      mats[o + 12] = s[a + 9]; mats[o + 13] = s[a + 10]; mats[o + 14] = s[a + 11]; mats[o + 15] = 1;
    }
    return {
      path: m.path, skin: m.skin, group: m.group, def: m.def || '', ids: m.ids || null, n, mats, centers: null, radii: null, box: null,
      hide: null, // (placements hidden by the user: 1)
      lods: [], sw: [], materials: [], ready: false, tris: 0,
    };
  }

  async loadModel(rec, token) {
    if (token !== this.token) return; // (another map was opened: the rest of this one's pool drains without asking the host)
    try {
      const { info, entry } = await this.getModel(rec.path, rec.skin, -1); // (with its geometry: one request)
      if (token !== this.token) { this.v.geo.release(entry); return; }
      rec.geoEntry = entry;
      const parts = await entry.promise;
      if (token !== this.token) return; // (clear() let go of the geometry)
      // each placement's bounding sphere, for culling and LOD choice
      const a = info.bbMin || [0, 0, 0], b = info.bbMax || [0, 0, 0];
      const lc = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const lr = Math.max(0.1, 0.5 * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
      rec.box = new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b)).expandByScalar(0.05); // (for picking, in the model's frame)
      rec.centers = new Float32Array(rec.n * 3);
      rec.radii = new Float32Array(rec.n);
      for (let i = 0; i < rec.n; i++) {
        const m = rec.mats, o = i * 16;
        rec.centers[i * 3] = m[o] * lc[0] + m[o + 4] * lc[1] + m[o + 8] * lc[2] + m[o + 12];
        rec.centers[i * 3 + 1] = m[o + 1] * lc[0] + m[o + 5] * lc[1] + m[o + 9] * lc[2] + m[o + 13];
        rec.centers[i * 3 + 2] = m[o + 2] * lc[0] + m[o + 6] * lc[1] + m[o + 10] * lc[2] + m[o + 14];
        const sc = Math.max(Math.hypot(m[o], m[o + 1], m[o + 2]), Math.hypot(m[o + 4], m[o + 5], m[o + 6]), Math.hypot(m[o + 8], m[o + 9], m[o + 10]));
        rec.radii[i] = lr * sc;
      }
      const lodCount = Math.max(1, info.lodCount || 1);
      rec.sw = lodSwitches(info);
      // A tree's billboard (SpeedTree Type 2: six pictures of it on three crossed planes) is what the
      // game shows in place of the tree far away; the model keeps it beside the tree in a LOD, so it
      // gets a LOD of its own after the last one (the switch a step further out than the last; a
      // bush of one LOD switches where the trees' pictures do, about 0.07: nearer, 50 m for a
      // creosote, the picture showed as it popped in)
      const billboard = (mi) => (mi.guid || '').startsWith('06bc377b') && (mi.params || []).some((q) => q.name === 'Type' && +q.value === 2);
      const hasBillboard = parts.some((p) => billboard(info.materials[p.material] || {}));
      if (hasBillboard) rec.sw.push(rec.sw.length ? rec.sw[rec.sw.length - 1] / 1.5 : 0.07);
      rec.lods = Array.from({ length: lodCount + (hasBillboard ? 1 : 0) }, () => ({ meshes: [], attr: null, arr: null, count: 0, view: 0, tris: 0, bounds: new Float64Array(6), sphere: new THREE.Sphere() }));
      const mats = new Map();
      for (const p of parts) {
        const mi = info.materials[p.material] || {};
        if (mi.invisible) continue;
        const L = billboard(mi) ? lodCount : THREE.MathUtils.clamp(p.lod || 0, 0, lodCount - 1);
        const key = `${p.material}|${p.hasTangent}`;
        let mat = mats.get(key);
        if (!mat) { mat = this.v.makeMaterial(mi, p.hasTangent, { texMax: this.texMax, roughMin: 0.05, prop: true }); mats.set(key, mat); rec.materials.push(mat); }
        const lod = rec.lods[L];
        if (!lod.attr) {
          lod.arr = new Float32Array(rec.n * 16);
          lod.attr = new THREE.InstancedBufferAttribute(lod.arr, 16);
          lod.attr.setUsage(THREE.DynamicDrawUsage);
        }
        const mesh = new THREE.InstancedMesh(p.geometry, mat, 0);
        mesh.instanceMatrix = lod.attr; // (every piece of a LOD shares its placements)
        mesh.boundingSphere = lod.sphere; // (culled per placement in bucket(); as a whole by the sphere around them, per shadow cascade too)
        mesh.matrixAutoUpdate = false;
        mesh.castShadow = !mi.blend && !mat.userData.xo.lamp; // (glow layers: see viewer.js LAMP_VERT)
        if (mesh.castShadow) { // (the view draws the placements in it, the sun's shadows those after them too: bucket())
          mesh.onBeforeShadow = () => { mesh.count = lod.count; };
          mesh.onAfterShadow = () => { mesh.count = lod.view; };
        }
        mesh.receiveShadow = !mat.userData.xo.lamp;
        mesh.userData.mapGroup = rec.group;
        if (mat.userData.xo.lamp) this.v.markLampMesh(mesh);
        lod.meshes.push(mesh);
        lod.tris += p.triangles;
        this.root.add(mesh);
      }
      for (const [key, mat] of mats) { // trees: the game's look of leaves, bark and far pictures
        const mi = info.materials[parseInt(key, 10)] || {};
        if ((mi.guid || '').startsWith('06bc377b')) treeLook(mat, mi, { min: a, max: b });
      }
      // (shown once its shaders are built, side by side with the other models': no frame waits on one)
      await this.v.prepare(rec.lods.flatMap((l) => l.meshes));
      if (token !== this.token) return;
      rec.ready = true;
      this.needsBucket = true;
      this.lights?.changed();
      this.loading.done++;
      if (this.sel.size && [...this.sel.values()].some((p) => p.rec === rec)) { // (outlines and minimap dots skip models not in yet)
        this.selVersion = (this.selVersion || 0) + 1;
        this.refreshOutlines();
        this.drawMinimap();
      }
      this.onChange();
      Promise.all(rec.materials.map((m) => this.v.loadMaterialTextures(m))).then((errs) => {
        const e = errs.flat();
        if (e.length && token === this.token) this.loading.errors.push(`${rec.path}: ${e[0]}`);
        this.v.shadowDirty = true; // (cut-outs: leaves and fences shadow by their textures)
        this.lights?.changed(); // (the lamps' shadows too)
      });
    } catch (e) {
      if (token !== this.token) return;
      this.loading.done++;
      this.loading.failed++;
      this.loading.errors.push(`${rec.path}: ${e.message}`);
      this.onChange();
    }
  }

  // ---- the terrain ----
  async loadTerrain(token) {
    const buf = await (await fetchOk(`${DATA}/mapterrain?${this.query}`)).arrayBuffer();
    if (token !== this.token) return;
    const { head: t, offset } = parseBlob(buf, 'XOTR');
    const H = new Float32Array(buf, offset, t.w * t.h);
    const st = this.scene.terrain;
    const step = t.step * t.cellSize;
    this.terrain = { ...t, H, stepM: step };
    const mat = terrainMaterial(this.v, this.viewDistance);
    this.terrainMat = mat;
    this.terrainLight = { u: mat.userData.splat, asked: false };
    const group = new THREE.Group();
    group.name = 'terrain';
    group.visible = this.show.terrain;
    const h = (i, j) => H[Math.min(t.h - 1, Math.max(0, j)) * t.w + Math.min(t.w - 1, Math.max(0, i))];
    const indexCache = new Map();
    const indices = (nx, nz) => {
      const k = nx + ',' + nz;
      if (!indexCache.has(k)) {
        const idx = new Uint16Array(nx * nz * 6);
        let o = 0;
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
          const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 2, d = a + nx + 1;
          // counter-clockwise seen from above (game z is -z here), split along b-d like the export
          // (decals lie on exactly these triangles)
          idx[o++] = a; idx[o++] = b; idx[o++] = d;
          idx[o++] = b; idx[o++] = c; idx[o++] = d;
        }
        const attr = new THREE.BufferAttribute(idx, 1);
        indexCache.set(k, attr);
      }
      return indexCache.get(k);
    };
    const chunk = Math.min(255, Math.max(CHUNK, Math.ceil((Math.max(t.w, t.h) - 1) / 8))); // ((chunk + 1)^2 vertices: 16-bit indices)
    for (let cz = 0; cz < t.h - 1; cz += chunk) {
      for (let cx = 0; cx < t.w - 1; cx += chunk) {
        const nx = Math.min(chunk, t.w - 1 - cx), nz = Math.min(chunk, t.h - 1 - cz);
        const nv = (nx + 1) * (nz + 1);
        const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
        let v = 0;
        for (let j = 0; j <= nz; j++) {
          for (let i = 0; i <= nx; i++, v++) {
            const gi = cx + i, gj = cz + j;
            const x = t.x0 + gi * step, zg = t.z0 + gj * step;
            pos[v * 3] = x; pos[v * 3 + 1] = h(gi, gj); pos[v * 3 + 2] = -zg;
            const sx = (h(gi + 1, gj) - h(gi - 1, gj)) / (2 * step), sz = (h(gi, gj + 1) - h(gi, gj - 1)) / (2 * step);
            const l = Math.hypot(sx, 1, sz);
            nor[v * 3] = -sx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = sz / l; // (game z mirrored)
            uv[v * 2] = (x - t.x0) / st.sizeX;
            uv[v * 2 + 1] = 1 - (zg - t.z0) / st.sizeZ; // the baked ground's top row is the +Z edge
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(indices(nx, nz));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
      }
    }
    this.root.add(group);
    this.terrainGroup = group;
    this.v.prepare(group); // (its shader built while the rest comes in)
    this.water?.bake((x, z) => this.heightAt(x, z), step); // (how deep the water is over the ground)
    this.loading.terrain = false;
    // the camera may have started under the ground before the heights were in
    const cam = this.v.camera, floor = this.heightAt(cam.position.x, cam.position.z) + 1.2;
    if (this.active && cam.position.y < floor) cam.position.y = floor;
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.lights?.changed();
    this.onChange();
    this.loadTerrainLight(token);
    await Promise.all([this.loadGround(token), this.loadSplat(token)]);
  }

  // (asked for once both the terrain and the sky are in)
  loadTerrainLight(token) {
    const L = this.terrainLight, t = this.terrain, s = this.sky;
    if (!L || L.asked || !t || !s?.ready) return;
    L.asked = true;
    (async () => {
      const buf = await (await fetchOk(`${DATA}/mapterrainlight?${this.query}&step=${t.step}&sun=${s.sun.toArray().map((x) => x.toFixed(5)).join(',')}`)).arrayBuffer();
      if (token !== this.token) return;
      const { head, offset } = parseBlob(buf, 'XOTL');
      const tex = new THREE.DataTexture(new Uint8Array(buf, offset, head.w * head.h * 2), head.w, head.h, THREE.RGFormat, THREE.UnsignedByteType);
      tex.unpackAlignment = 1;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      // (sample i lies at x0 + i * stepM; its row j at the game's z0 + j * stepM, glTF z = -that)
      const w = head.w * t.stepM, h = head.h * t.stepM;
      L.u.xoTerrainUv.value.set(1 / w, -t.x0 / w + 0.5 / head.w, -1 / h, -t.z0 / h + 0.5 / head.h);
      L.u.xoTerrainLight.value = tex;
      this.applySky();
    })().catch((e) => { if (token === this.token && this.loading) this.loading.errors.push(`terrain light: ${e.message}`); });
  }

  async loadGround(token) {
    const picture = async (layer) => {
      const blob = await (await fetchOk(`${DATA}/mapground?${this.query}&size=4096${layer}`)).blob();
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      if (token !== this.token) { bmp.close(); return null; }
      const tex = new THREE.Texture(bmp);
      tex.anisotropy = Math.min(8, this.v.support.anisotropy);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      return tex;
    };
    try {
      const tex = await picture('');
      if (!tex) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.groundTex = tex;
      this.terrainMat.map = tex;
      this.terrainMat.needsUpdate = true;
      this.makeMinimap(tex.image);
      // (then its roughness, metal and occlusion: the same bake, kept by the host)
      const orm = await picture('&layer=orm');
      if (!orm) return;
      this.groundOrm = orm;
      this.terrainMat.userData.splat.xoBakeOrm.value = orm;
    } catch (e) {
      if (token === this.token && this.loading) this.loading.errors.push(`ground colour: ${e.message}`);
    }
    if (token !== this.token) return;
    this.loading.ground = false;
    this.v.dirty = true;
    this.onChange();
  }

  // The surface map and the surfaces' textures: three texture arrays (albedos, normal maps, gloss maps)
  // with a layer per texture set, of the game's own blocks (BC1 / BC3) at the game's size for them.
  async loadSplat(token) {
    try {
      const buf = await (await fetchOk(`${DATA}/mapsplat?${this.query}`)).arrayBuffer();
      if (token !== this.token) return;
      const { head, offset } = parseBlob(buf, 'XOSP');
      const surfs = head.surfaces.slice(0, 32);
      // the layers: one per set of textures (a detail set with its surface's textures shares its layer;
      // a surface without textures gets the bake's grey)
      const layers = [], layerOf = new Map();
      const layer = (set) => {
        const key = `${set.albedo}|${set.normal}|${set.gloss}`;
        if (!layerOf.has(key)) {
          if (layers.length === 32) return -1;
          layerOf.set(key, layers.length);
          layers.push({ set, tex: {} });
        }
        return layerOf.get(key);
      };
      const bases = surfs.map((s) => layer(s));
      const details = surfs.map((s) => (s.detail ? layer(s.detail) : -1));
      const jobs = [];
      for (const L of layers) for (const role of SURF_ROLES) if (L.set[role]) jobs.push({ L, role });
      await inPool(jobs, 6, async ({ L, role }) => {
        L.tex[role] = await this.surfaceTexture(L.set[role], role, head.slice).catch(() => null);
      });
      const noise = details.some((d) => d >= 0) ? await this.surfaceNoise(head.noise).catch(() => null) : null;
      if (token !== this.token) return;
      const index = new THREE.DataTexture(new Uint8Array(buf, offset, head.w * head.h * 4), head.w, head.h, THREE.RGBAIntegerFormat, THREE.UnsignedByteType);
      index.internalFormat = 'RGBA8UI';
      index.minFilter = index.magFilter = THREE.NearestFilter;
      index.generateMipmaps = false;
      index.flipY = false;
      index.needsUpdate = true;
      const aniso = Math.min(16, this.v.support.anisotropy);
      const arrays = await Promise.all(SURF_ROLES.map((role) => this.surfaceArray(layers, role, head.slice, aniso)));
      if (token !== this.token) return; // (never drawn: nothing on the GPU yet)
      this.splat = { index, head, arrays: arrays.map((a) => a.info), textures: [index, ...arrays.map((a) => a.tex), ...(noise ? [noise] : [])] };
      const u = this.terrainMat.userData.splat;
      u.xoSplat.value = index;
      [u.xoSurf.value, u.xoSurfN.value, u.xoSurfG.value] = arrays.map((a) => a.tex);
      u.xoNoise.value = noise;
      u.xoSplatRect.value.set(head.x0, head.z0, head.sizeX, head.sizeZ);
      u.xoSplatSize.value.set(head.w, head.h);
      u.xoSplatOffset.value = typeof head.texelOffset === 'number' ? head.texelOffset : 0.5;
      u.xoArrays.value.set(...arrays.map((a) => Math.log2(a.info.size)), 1 / aniso);
      layers.forEach((L, l) => u.xoLayer.value[l].set(...arrays.map((a) => a.drop[l]), L.tex.normal && L.tex.normal.layout !== 'AG' ? 1 : 0));
      const setOf = (v, s, l) => v.set(1 / (s.tiling > 0 ? s.tiling : 8), l, (s.rotation & 3) + (s.flip ? 4 : 0), s.mid ?? 0.5);
      surfs.forEach((s, k) => {
        setOf(u.xoSet.value[k], s, bases[k]);
        const d = noise && details[k] >= 0 ? s.detail : null;
        if (d) setOf(u.xoSet.value[k + 32], d, details[k]);
        else u.xoSet.value[k + 32].y = -1;
        const n = d ? d.noise : [1, 0, 1, 0, 1];
        u.xoBlend.value[k].set((s.blend || 0) * head.heightBlend, s.invert ? 1 : 0, s.flat ? 1 : 0, n[4]);
        u.xoMix.value[k].set(1 / n[0], n[1], 1 / Math.max(1e-3, n[2] - n[1]), n[3]);
        u.xoAmp.value[k] = s.amp || 0;
      });
      // (surfaces whose textures sit in the game's encrypted files: Map.cpp lends them a readable preset's)
      const lent = new Map();
      for (const s of surfs) if (s.standIn) lent.set(s.standIn, [...(lent.get(s.standIn) || []), s.name]);
      for (const [by, names] of lent) this.loading.errors.push(`ground textures of ${names.join(', ')} are not in the game's readable files: shown with ${by}'s`);
      u.xoSurfCount.value = surfs.length;
      u.xoSplatIn.value = 1; // (the shader has had them all along: stand-ins till now)
      this.applyDust();
      this.v.dirty = true;
    } catch (e) {
      if (token === this.token) this.loading.errors.push(`ground textures: ${e.message}`);
    }
  }

  // One surface texture as the game has it (/tex: its blocks, levels from the largest up to max).
  async surfaceTexture(base, role, max) {
    return parseXotx(await (await fetchOk(`${DATA}/tex?base=${enc(base)}&max=${max}${role === 'normal' ? '&layout=1' : ''}`)).arrayBuffer());
  }

  // The detail sets' mix: its noise texture (two channels; red is the one used), decoded.
  async surfaceNoise(base) {
    const img = parseXorg(await (await fetchOk(`${DATA}/rgba?base=${enc(base)}`)).arrayBuffer());
    const t = new THREE.DataTexture(img.data, img.w, img.h);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  }

  // One role's texture array: { tex, info: { size, compressed }, drop: per layer, how many levels below
  // the top its own top level sits }. The size is the game's slice size or the largest texture's, if
  // smaller; a smaller texture's levels above its own are its pixels repeated (in its own blocks, so
  // the array stays compressed). A texture of another format, or a GPU without BC textures, makes the
  // role's array plain RGBA (decoded by the host; at most 1024 pixels, a layer).
  async surfaceArray(layers, role, slice, aniso) {
    const { format, srgb } = SURF_FORMAT[role];
    const sup = this.v.support;
    const heads = layers.map((L) => L.tex[role] || null);
    const pow2 = (n) => n >= 4 && (n & (n - 1)) === 0;
    const blocks = sup.s3tc && (!srgb || sup.s3tcSrgb) &&
      heads.every((h) => !h || (h.format === format && !!h.srgb === srgb && h.width === h.height && pow2(h.width)));
    const largest = Math.max(4, ...heads.map((h) => (h ? h.width : 0)));
    let tex, size;
    const drop = heads.map(() => 0);
    if (blocks) {
      size = Math.min(slice, largest);
      const B = format === 'BC1' ? 8 : 16, top = Math.log2(size);
      heads.forEach((h, l) => (drop[l] = h ? Math.log2(size / h.width) : 0));
      // (every layer down to where the one with the fewest levels ends)
      const count = Math.min(top + 1, ...heads.map((h, l) => (h ? drop[l] + h.mipmaps.length : top + 1)));
      const mipmaps = [];
      for (let lv = 0; lv < count; lv++) {
        const s = Math.max(1, size >> lv), per = Math.max(1, s >> 2) ** 2 * B;
        const data = new Uint8Array(per * layers.length);
        heads.forEach((h, l) => {
          if (!h) return data.set(fillBlocks(SURF_FALLBACK[role], B, per), l * per);
          const m = lv >= drop[l] ? h.mipmaps[lv - drop[l]].data : upscaleBlocks(h.mipmaps[0].data, h.width, B, 2 ** (drop[l] - lv));
          data.set(m.subarray(0, per), l * per);
        });
        mipmaps.push({ data, width: s, height: s });
      }
      tex = new THREE.CompressedArrayTexture(mipmaps, size, size, layers.length, B === 8 ? THREE.RGB_S3TC_DXT1_Format : THREE.RGBA_S3TC_DXT5_Format);
      tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    } else {
      size = Math.min(1024, slice, largest);
      const per = size * size * 4, data = new Uint8Array(per * layers.length);
      await Promise.all(layers.map(async (L, l) => {
        const px = L.set[role] ? await this.surfacePixels(L.set[role], size).catch(() => null) : null;
        if (px) data.set(px, l * per);
        else for (let i = 0; i < per; i += 4) data.set(SURF_FALLBACK[role], l * per + i);
      }));
      tex = new THREE.DataArrayTexture(data, size, size, layers.length);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
    }
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = aniso;
    tex.needsUpdate = true;
    return { tex, drop, info: { size, compressed: blocks } };
  }

  // One surface texture as S x S RGBA, as stored (smaller ones repeat their pixels).
  async surfacePixels(base, S) {
    const img = parseXorg(await (await fetchOk(`${DATA}/rgba?base=${enc(base)}&max=${S}`)).arrayBuffer());
    if (img.w === S && img.h === S) return img.data;
    const out = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      const row = Math.floor((y * img.h) / S) * img.w;
      for (let x = 0; x < S; x++) {
        const i = (row + Math.floor((x * img.w) / S)) * 4;
        out.set(img.data.subarray(i, i + 4), (y * S + x) * 4);
      }
    }
    return out;
  }

  // The water's surface over (x, z): the highest water area whose outline holds it, or null (what a
  // vehicle wades through, shown or not)
  waterAt(x, z) { return this.waterOver(x, z)?.level ?? null; }

  // ... that water area itself (/mapscene water), or null
  waterOver(x, z) {
    let top = null;
    for (const w of this.scene?.water || []) if ((!top || w.level > top.level) && insideOutline(w.outline, x, z)) top = w;
    return top;
  }

  // Ground height under a point (bilinear between the samples); -Infinity off the terrain's grid.
  heightAt(x, z) {
    const t = this.terrain;
    if (!t) return -Infinity;
    const fi = (x - t.x0) / t.stepM, fj = (-z - t.z0) / t.stepM;
    if (!(fi >= -1 && fj >= -1 && fi <= t.w && fj <= t.h)) return -Infinity;
    const i = THREE.MathUtils.clamp(Math.floor(fi), 0, t.w - 2), j = THREE.MathUtils.clamp(Math.floor(fj), 0, t.h - 2);
    const a = THREE.MathUtils.clamp(fi - i, 0, 1), b = THREE.MathUtils.clamp(fj - j, 0, 1);
    const H = t.H, w = t.w;
    return (H[j * w + i] * (1 - a) + H[j * w + i + 1] * a) * (1 - b) + (H[(j + 1) * w + i] * (1 - a) + H[(j + 1) * w + i + 1] * a) * b;
  }

  // ---- water and spawn points ----
  // The water and acid (water.js); its depths come with the terrain (loadTerrain).
  buildWater() {
    this.water = new Water(this.v, this.scene.water || [], this.scene.waterFlow || null);
    const group = this.water.group;
    group.visible = this.show.water;
    this.root.add(group);
    this.waterGroup = group;
  }

  // Under the water the view sinks into it: the haze becomes the water's own (its colour as the light
  // it scatters, its density), until the camera comes up again. w: the water the camera is in, or null.
  underwater(w) {
    if (w === this.under) return;
    this.under = w;
    if (!w) { this.applySky(); return; }
    const v = this.v, c = w.color || [52, 51, 50];
    // (the game sky's light in the view's units, sky.js fxLight: its sun's / pi and its sky's; the
    // environment's intensity is its exposure, highest at night)
    const fl = v.gameSky?.fxLight;
    const light = fl ? fl.sun.clone().multiplyScalar(Math.PI * 0.25).add(fl.sky) : v.key.color.clone().multiplyScalar(v.key.intensity * 0.25).addScalar(0.3 * v.scene.environmentIntensity);
    // (fog.js: as thick everywhere, no thinning with height; its density in its base-2 terms, so the
    // light falls by e every 1 / density metres)
    setFog({ density: (w.density || 1) / (Math.LN2 * Math.LN2), falloff: 0, height: 0, start: 0, sunStart: 0, sunPower: 1,
      color: new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace).multiply(light), glow: new THREE.Color(0, 0, 0), sun: v.keyDir });
    v.dirty = true;
  }

  buildSpawns() {
    const group = new THREE.Group();
    group.name = 'spawns';
    group.visible = this.show.spawns;
    const colours = { 1: 0x4cc3ff, 2: 0xff5a4a, 0: 0xf2f2f2 };
    const pole = new THREE.CylinderGeometry(0.18, 0.18, 7, 8).translate(0, 3.5, 0);
    const head = new THREE.ConeGeometry(0.9, 1.8, 16).rotateX(Math.PI).translate(0, 8.2, 0);
    const ring = new THREE.TorusGeometry(1.6, 0.12, 6, 32).rotateX(Math.PI / 2).translate(0, 0.25, 0);
    for (const g of [pole, head, ring]) g.userData.shared = true;
    this.spawnGeos = [pole, head, ring];
    const mats = {};
    for (const s of this.scene.spawns || []) {
      const mat = mats[s.team] || (mats[s.team] = new THREE.MeshBasicMaterial({ color: colours[s.team] ?? colours[0], fog: false }));
      const m = new THREE.Group();
      m.position.set(s.pos[0], s.pos[1], s.pos[2]);
      for (const g of this.spawnGeos) m.add(new THREE.Mesh(g, mat));
      m.userData = { team: s.team, def: s.def };
      group.add(m);
    }
    this.root.add(group);
    this.spawnGroup = group;
  }

  // ---- where the camera goes ----
  spawnsOf(team) { return (this.scene?.spawns || []).filter((s) => s.team === team); }

  static centreOf(list) {
    const c = new THREE.Vector3();
    for (const s of list) c.add(new THREE.Vector3(...s.pos));
    return c.multiplyScalar(1 / Math.max(1, list.length));
  }

  // 'start' (behind team 1's spawn, looking at team 2), 'team1', 'team2', 'overview'
  goTo(where) {
    if (!this.scene) return;
    const t1 = this.spawnsOf(1), t2 = this.spawnsOf(2), any = this.scene.spawns || [];
    const centre = this.centre.clone();
    centre.y = this.groundOr(centre.x, centre.z, centre.y);
    const from = where === 'team2' ? t2 : where === 'overview' ? [] : t1.length ? t1 : any;
    if (!from.length) {
      const s = this.size || 1000;
      const pos = new THREE.Vector3(centre.x, centre.y + s * 0.32, centre.z + s * 0.55);
      this.fly.setPose(pos, centre);
    } else {
      const at = MapView.centreOf(from);
      const other = where === 'team2' ? t1 : t2;
      const look = other.length ? MapView.centreOf(other) : centre;
      const dir = look.clone().sub(at).setY(0);
      if (dir.lengthSq() < 1) dir.set(0, 0, -1);
      dir.normalize();
      const pos = at.clone().addScaledVector(dir, -18);
      pos.y = Math.max(this.groundOr(pos.x, pos.z, at.y), at.y) + 9;
      this.fly.setPose(pos, at.clone().addScaledVector(dir, 60).setY(at.y + 2));
    }
    this.needsBucket = true;
  }

  groundOr(x, z, def) { const h = this.heightAt(x, z); return Number.isFinite(h) ? h : def; }

  // The minimap: a click flies the camera there (same height over the ground).
  flyTo(x, z) {
    const cam = this.v.camera;
    const here = this.heightAt(cam.position.x, cam.position.z), there = this.heightAt(x, z);
    // (a map without terrain has no ground under either point: the camera keeps its height, it went
    // to 20 m over 0 whatever the map's floor was)
    const y = Number.isFinite(there) ? there + Math.max(4, Number.isFinite(here) ? cam.position.y - here : cam.position.y - there) : cam.position.y;
    cam.position.set(x, y, z);
    cam.updateMatrixWorld();
    this.fly.vel.set(0, 0, 0);
    this.needsBucket = true;
    this.v.dirty = true;
  }

  // ---- options ----
  setShow(key, on) {
    this.show[key] = on;
    if (key === 'terrain' && this.terrainGroup) this.terrainGroup.visible = on;
    if (key === 'terrain') this.syncDecals(); // (decals on the ground: not left hanging in the air)
    if (key === 'water' && this.waterGroup) this.waterGroup.visible = on;
    if (key === 'spawns' && this.spawnGroup) this.spawnGroup.visible = on;
    if (key === 'decals' && this.decals) this.decals.group.visible = on;
    if (key === 'lights') this.lights?.setShown(on);
    if (key === 'sky') this.applySky();
    if (key === 'layers') this.v.setOption('layers', on); // (the props' further texture sets: to compare with their first alone)
    if (key in { props: 1, trees: 1, objects: 1 }) { this.refreshOutlines(); this.syncDecals(); this.lights?.changed(); }
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.v.dirty = true;
  }

  // auto: worked out from the map (autoViewDistance), else the user's
  setViewDistance(d, auto = false) {
    this.viewDistance = d;
    this.viewAuto = auto;
    this.terrainMat?.userData.splat.xoSplatFade.value.setX(d * SPLAT_FADE[0]).setY(d * SPLAT_FADE[1]); // (the surfaces to the view's end)
    if (this.active && this.scene) {
      this.v.setMapSky(d);
      this.under = null; // (under the water, its fog comes back with the next frame)
    }
    this.needsBucket = true;
  }

  setDetail(level) {
    if (!(level in DETAIL)) return;
    this.detail = level;
    this.needsBucket = true;
  }

  // ---- every frame ----
  tick() {
    if (!this.active || !this.scene) return;
    // the grass and the trees sway on by the frames drawn anyway, and the sky picture drifts: a still
    // view stays still (neither asks for redraws of its own)
    const now = performance.now();
    if (this.v.frames !== this.windFrame) {
      const dt = Math.min(0.05, (now - (this.windClock ?? now)) / 1000);
      stepWind(dt);
      this.sky?.stepDrift(dt);
    }
    this.windFrame = this.v.frames;
    this.windClock = now;
    if (this.water?.tick()) this.v.dirty = true; // (the waves move on while water is in view)
    const flying = this.fly.moving;
    if (this.wasFlying && !flying) this.v.hoverDirty = true; // (stopped: what is under the cursor now)
    this.wasFlying = flying;
    const cam = this.v.camera, lc = this.lastCam;
    const moved = !cam.position.equals(lc.pos) || !cam.quaternion.equals(lc.quat) || cam.fov !== lc.fov || cam.aspect !== lc.aspect;
    if (moved || this.needsBucket) this.v.hoverDirty = true; // (the object under a still cursor changes as the camera moves)
    if (!moved && !this.needsBucket) return;
    lc.pos.copy(cam.position);
    lc.quat.copy(cam.quaternion);
    lc.fov = cam.fov;
    lc.aspect = cam.aspect;
    this.needsBucket = false;
    const wet = this.show.water ? this.waterOver(cam.position.x, cam.position.z) : null;
    this.underwater(wet && cam.position.y < wet.level ? wet : null);
    cam.updateMatrixWorld();
    this.updateSun(); // (first: bucket() keeps what casts shadows into its square)
    this.bucket();
    this.bucketGrass();
    this.lights?.bucket(cam, this.frustum);
    if (this.v.skyDome) this.v.skyDome.position.copy(cam.position);
    this.sky?.follow(cam);
    this.drawMinimap();
    this.v.dirty = true;
  }

  // Which placements are drawn, and at which LOD.
  bucket() {
    const cam = this.v.camera;
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const pl = this.frustum.planes.map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const far = this.viewDistance;
    const bias = DETAIL[this.detail] || 0.5;
    // the sun's shadows (updateSun): a placement outside the view still casts into it when its shadow,
    // laid along the sun's rays about as long as it falls on level ground (at most 400 m), reaches it;
    // and into what turning shows before the cascades are drawn again (shadows.js TURN_ANGLE each way),
    // so those are picked in a view that much wider. A LOD lists the placements in view first (the
    // view draws them), then these (the shadows draw them all: the meshes' onBeforeShadow).
    const sun = this.v.key.castShadow ? this.v.keyDir : null;
    const fall = sun ? 1 / Math.max(sun.y, 0.08) : 0;
    let wide = null;
    if (sun) {
      const half = THREE.MathUtils.degToRad(cam.fov) / 2, across = Math.atan(tanHalf * cam.aspect);
      const t = cam.near * Math.tan(Math.min(half + TURN_ANGLE, 1.5)), w = cam.near * Math.tan(Math.min(across + TURN_ANGLE, 1.5));
      this.widePv.makePerspective(-w, w, t, -t, cam.near, cam.far).multiply(cam.matrixWorldInverse);
      wide = this.wide.setFromProjectionMatrix(this.widePv).planes.map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
    }
    const cast = this.castList || (this.castList = []); // (the casters out of view: placement, LOD)
    let placements = 0, triangles = 0;
    for (const rec of this.models) {
      if (!rec.ready) continue;
      const lods = rec.lods, L = lods.length, sw = rec.sw;
      for (const lod of lods) { lod.count = 0; lod.bounds.fill(Infinity, 0, 3).fill(-Infinity, 3, 6); }
      cast.length = 0;
      if (this.show[rec.group] !== false) {
        const C = rec.centers, R = rec.radii, hide = rec.hide;
        for (let i = 0; i < rec.n; i++) {
          if (hide && hide[i]) continue;
          const cx = C[i * 3], cy = C[i * 3 + 1], cz = C[i * 3 + 2], r = R[i];
          const dx = cx - px, dy = cy - py, dz = cz - pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d - r > far) continue;
          let out = false;
          for (let k = 0; k < 6; k++) {
            const p = pl[k];
            if (p[0] * cx + p[1] * cy + p[2] * cz + p[3] < -r) { out = true; break; }
          }
          if (out) { // (its shadow may still fall into the view, the wider one)
            if (!wide) continue;
            const half = Math.min(400, (2 * r + 5) * fall) / 2;
            const sx = cx - sun.x * half, sy = cy - sun.y * half, sz = cz - sun.z * half;
            let gone = false;
            for (let k = 0; k < 6; k++) {
              const p = wide[k];
              if (p[0] * sx + p[1] * sy + p[2] * sz + p[3] < -r - half) { gone = true; break; }
            }
            if (gone) continue;
          }
          const s = d > r ? r / (d * tanHalf) : 1e9; // (inside the sphere: as big as it gets)
          if (s < MIN_SIZE) continue;
          let l = 0;
          while (l < L - 1 && s < sw[l] * bias) l++;
          while (l > 0 && !lods[l].attr) l--; // (a LOD with nothing visible: the finer one)
          if (!lods[l].attr) continue;
          if (out) cast.push(i, l);
          else place(lods[l], rec, i);
        }
      }
      for (const lod of lods) lod.view = lod.count;
      for (let j = 0; j < cast.length; j += 2) place(lods[cast[j + 1]], rec, cast[j]);
      for (const lod of lods) {
        if (!lod.attr) continue;
        for (const m of lod.meshes) { m.count = lod.view; m.visible = lod.count > 0; }
        if (lod.count) {
          lod.attr.clearUpdateRanges();
          lod.attr.addUpdateRange(0, lod.count * 16);
          lod.attr.needsUpdate = true;
          // (three culls the meshes by the sphere around all of them, for the view and for each
          // shadow cascade: a LOD is a band of distances, its far clusters drop out of the near ones)
          const b = lod.bounds;
          lod.sphere.center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
          lod.sphere.radius = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
        }
        placements += lod.view;
        triangles += lod.view * lod.tris;
      }
    }
    this.drawn = { placements, triangles };
  }

  // The sun's shadows over the whole view (shadows.js: cascades around the camera, out to the view
  // distance); none where the weather turns them off (SunShadowsEnabled).
  updateSun() {
    const v = this.v, L = v.key, cam = v.camera;
    L.target.position.copy(cam.position);
    L.position.copy(cam.position).addScaledVector(v.keyDir, 100); // (the light's direction)
    L.target.updateMatrixWorld();
    L.updateMatrixWorld();
    L.castShadow = v.shadows && v.gameSky?.sunShadows !== false;
    if (L.castShadow) L.shadow.fit(cam, this.viewDistance, v.keyDir, this.top);
  }

  // ---- the sky (sky.js) ----
  async loadSky(token) {
    const [env, probe] = await Promise.all([fetchOk(`${DATA}/mapenv?${this.query}`).then((r) => r.json()), fetchProbe(this.query)]);
    if (token !== this.token) return;
    this.env = env;
    this.applyDust(); // (the weather's snow, wet or dust, on the props too: whether the sky loads or not)
    setWind(env.values); // (the grass and the trees sway with it)
    const sky = new GameSky(this.v, { getInfo: this.getInfo });
    let ok = false;
    try {
      ok = await sky.load(env, probe, () => token === this.token);
    } catch (e) {
      sky.dispose();
      throw e;
    }
    if (!ok || token !== this.token) { sky.dispose(); return; }
    this.sky = sky;
    this.root.add(sky.group);
    this.applySky();
    this.loadTerrainLight(token);
  }

  // The game's sky, its sun and its fog on the view (or the plain outdoor light without them).
  applySky() {
    const s = this.sky;
    if (s) s.group.visible = this.show.sky;
    if (!s || !s.ready || !this.show.sky) {
      this.v.setMapLight(null);
    } else {
      this.v.setMapLight({
        sunDir: s.sun, sunColor: s.sunColor, sunIntensity: s.sunIntensity, sunShadows: s.env.values?.SunShadowsEnabled !== 'false', // (sky.js: the preset's light levels)
        envMap: s.envMap, envIntensity: s.envIntensity, irradiance: s.irradiance, local: s.local, grade: s.grade, glow: s.levels.glow, fxLight: s.fxLight,
        fog: s.fog, shafts: presetShafts(s.env.values || {}, s.sunColor, s.levels.sun),
      });
    }
    if (this.terrainLight) { const u = this.terrainLight.u; u.xoTerrainOn.value = s?.ready && this.show.sky && u.xoTerrainLight.value ? 1 : 0; }
    this.lights?.setLevels(s && s.ready && this.show.sky ? s.levels : null); // (as bright as the sun's light is at that exposure)
    if (this.active && this.scene) this.v.setMapSky(this.viewDistance);
    this.under = null; // (under the water, its fog comes back with the next frame)
    this.applyDust();
    this.needsBucket = true;
  }

  // The weather's cover on the ground (envsettings Dust*: snow, a wet film, sand): its colour and gloss
  // where its mask (DustMaskPath, every DustMaskScale metres; none: everywhere) clears DustLandHeight,
  // as a decal's height mask does (DustLandSharpness: how hard the edge), times DustTransparency, off
  // steep slopes with DustByNormals. Checked against the game's captures of bridge: snow all over
  // with new_year_bright (height 0.53, sharpness 0.85); fix_dull_norain (DustEnabled false, on land
  // true) leaves the ground dry, so DustEnabled switches it all. The props' cover (viewer.js DUST) goes
  // with it: on with the weather shown.
  applyDust() {
    this.v.setDust(this.show.sky ? this.env?.values : null);
    const u = this.terrainMat?.userData.splat;
    if (!u) return;
    const v = this.env?.values || {}, num = (k, d = 0) => (Number.isFinite(parseFloat(v[k])) ? parseFloat(v[k]) : d);
    const on = v.DustEnabled === 'true' && v.DustEnabledOnLand === 'true' && this.show.sky; // (the weather's, with the weather shown)
    const rgb = parseInt(String(v.DustColor || '0').replace(/^0x/i, ''), 16) & 0xffffff;
    const c = new THREE.Color().setRGB((rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, THREE.SRGBColorSpace);
    const band = String(v.DustByHeight || '').trim().split(/\s+/).map(Number), byHeight = band.length >= 2 && band.every(Number.isFinite);
    u.xoDust.value.set(num('DustLandHeight'), 1 / Math.max(0.02, 1 - num('DustLandSharpness')), on ? num('DustTransparency', 1) : 0, byHeight ? 2 : v.DustByNormals === 'true' ? 1 : 0);
    u.xoDustBand.value.set(byHeight ? band[0] : 0, byHeight ? band[1] : 0);
    u.xoDustColor.value.set(c.r, c.g, c.b, num('DustGloss'));
    const path = on && v.DustMaskEnabled === 'true' ? v.DustMaskPath || '' : '';
    u.xoDustMaskOn.value.set(1 / Math.max(1, num('DustMaskScale', 128)), path && this.dustMask?.path === path ? 1 : 0);
    if (path && this.dustMask?.path !== path) {
      const token = this.token;
      this.dustMask?.tex?.dispose();
      this.dustMask = { path, tex: null };
      fetchOk(`${DATA}/rgba?base=${enc(path)}&max=1024`).then((r) => r.arrayBuffer()).then((buf) => {
        if (token !== this.token || this.dustMask?.path !== path) return;
        const img = parseXorg(buf);
        const t = new THREE.DataTexture(img.data, img.w, img.h);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = true;
        t.needsUpdate = true;
        this.dustMask.tex = t;
        u.xoDustMask.value = t;
        u.xoDustMaskOn.value.y = 1;
        this.v.dirty = true;
      }).catch((e) => { if (token === this.token) this.loading?.errors.push(`weather cover mask: ${e.message}`); });
    }
    this.v.dirty = true;
  }

  // ---- grass ----
  async loadGrass(token) {
    const r = await fetch(`${DATA}/mapgrass?${this.query}`); // (the whole query: the host refuses one for another festival, mode or weather as a map it left)
    if (r.status === 404) return; // (no grass on this map)
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (token !== this.token) return;
    const { head, offset } = parseBlob(buf, 'XOGR');
    const data = new Float32Array(buf, offset, head.count * 13);
    const tints = new Uint32Array(buf, offset + head.count * 52, head.count); // (r g b x 127.5: the tint each tuft takes from the ground)
    const types = head.types.map((t) => ({ ...t, cells: [], total: 0, meshes: [], materials: [], arr: null, attr: null, tints: null, tint: null, count: 0, ready: false }));
    const cs = head.cellSize;
    for (let i = 0; i + 5 < head.cells.length; i += 6) {
      const cell = head.cells[i], type = head.cells[i + 1], first = head.cells[i + 2], count = head.cells[i + 3];
      const col = cell % head.gridX, row = Math.floor(cell / head.gridX);
      const t = types[type];
      if (!t) continue;
      t.cells.push({ first, count, minY: head.cells[i + 4], maxY: head.cells[i + 5], cx: head.x0 + (col + 0.5) * cs, cz: -(head.z0 + (row + 0.5) * cs) });
      t.total += count;
    }
    this.grass = { head, data, tints, types };
    await Promise.all(types.map((t) => this.loadGrassKind(t, token).catch((e) => { if (token === this.token) this.loading.errors.push(`grass ${t.name}: ${e.message}`); })));
    if (token !== this.token) return;
    this.needsBucket = true;
  }

  async loadGrassKind(t, token) {
    if (!t.model || !t.total) return;
    const { info, entry } = await this.getModel(t.model, '', 0); // (with its geometry: one request)
    if (token !== this.token) { this.v.geo.release(entry); return; }
    t.geoEntry = entry;
    const parts = await entry.promise;
    if (token !== this.token) return;
    t.arr = new Float32Array(t.total * 16);
    t.attr = new THREE.InstancedBufferAttribute(t.arr, 16);
    t.attr.setUsage(THREE.DynamicDrawUsage);
    t.tints = new Uint32Array(t.total);
    t.tint = new THREE.InstancedBufferAttribute(new Uint8Array(t.tints.buffer), 4, true);
    t.tint.setUsage(THREE.DynamicDrawUsage);
    const mats = new Map();
    for (const p of parts) {
      const mi = info.materials[p.material] || {};
      if (mi.invisible) continue;
      const key = `${p.material}|${p.hasTangent}`;
      let mat = mats.get(key);
      if (!mat) {
        mat = this.v.makeMaterial(mi, p.hasTangent, { texMax: this.texMax, roughMin: 0.05 });
        // Stones, bricks, debris and snow chunks are solid little models with their own normal maps
        // (a tangent stream): drawn as they are. Blades and leaves get the game's grass look, and the
        // weather's cover on the land with it (the terrain material's, as the ground shows it).
        if (!p.hasTangent) grassLook(mat, t, info.bbMax?.[1] ?? 1, () => this.terrainMat?.userData.splat);
        mats.set(key, mat);
        t.materials.push(mat);
      }
      const mesh = new THREE.InstancedMesh(p.geometry, mat, 0);
      mesh.instanceMatrix = t.attr;
      if (!p.hasTangent) mesh.instanceColor = t.tint; // (the ground's tint, see grassLook)
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.visible = false;
      mesh.userData.mapGroup = 'grass';
      t.meshes.push(mesh);
      this.root.add(mesh);
    }
    await this.v.prepare(t.meshes); // (its shaders built first, as the models')
    if (token !== this.token) return;
    t.ready = true;
    for (const m of t.materials) this.v.loadMaterialTextures(m);
  }

  // The grass near the camera: whole 32 m cells culled first, then each blade by distance, thinned
  // out towards the end of its reach by its rank (the game's own order of what goes first).
  bucketGrass() {
    const g = this.grass;
    if (!g) return;
    const cam = this.v.camera, px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    const pl = this.frustum.planes.map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
    const data = g.data, tints = g.tints, cellR = g.head.cellSize * 0.75;
    let drawn = 0;
    for (const t of g.types) {
      if (!t.ready) continue;
      let n = 0;
      if (this.show.grass && this.show.terrain) {
        // (thinned out over the preset's cloaking range, the share of its reach: debris pops at the end)
        const D = this.grassRange * THREE.MathUtils.clamp(t.distFactor / 0.25, 0.5, 1.6), fadeFrom = D * (1 - THREE.MathUtils.clamp(t.cloak ?? 0.45, 0.05, 0.95));
        const dst = t.arr, tdst = t.tints;
        for (const c of t.cells) {
          const cy = (c.minY + c.maxY) / 2, r = cellR + (c.maxY - c.minY) / 2 + 2;
          const dx = c.cx - px, dy = cy - py, dz = c.cz - pz;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) - r > D) continue;
          let out = false;
          for (let k = 0; k < 6 && !out; k++) { const p = pl[k]; out = p[0] * c.cx + p[1] * cy + p[2] * c.cz + p[3] < -r; }
          if (out) continue;
          for (let i = c.first, e = c.first + c.count; i < e; i++) {
            const o = i * 13;
            const ex = data[o + 9] - px, ey = data[o + 10] - py, ez = data[o + 11] - pz;
            const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (d > D || (d > fadeFrom && data[o + 12] > 1 - (d - fadeFrom) / (D - fadeFrom))) continue;
            const w = n * 16;
            dst[w] = data[o]; dst[w + 1] = data[o + 1]; dst[w + 2] = data[o + 2]; dst[w + 3] = 0;
            dst[w + 4] = data[o + 3]; dst[w + 5] = data[o + 4]; dst[w + 6] = data[o + 5]; dst[w + 7] = 0;
            dst[w + 8] = data[o + 6]; dst[w + 9] = data[o + 7]; dst[w + 10] = data[o + 8]; dst[w + 11] = 0;
            dst[w + 12] = data[o + 9]; dst[w + 13] = data[o + 10]; dst[w + 14] = data[o + 11]; dst[w + 15] = 1;
            tdst[n] = tints[i];
            n++;
          }
        }
      }
      t.count = n;
      for (const m of t.meshes) { m.count = n; m.visible = n > 0; }
      if (n) {
        t.attr.clearUpdateRanges();
        t.attr.addUpdateRange(0, n * 16);
        t.attr.needsUpdate = true;
        t.tint.clearUpdateRanges();
        t.tint.addUpdateRange(0, n * 4);
        t.tint.needsUpdate = true;
      }
      drawn += n;
    }
    this.drawn.grass = drawn;
  }

  setGrassRange(m) {
    this.grassRange = m;
    this.needsBucket = true;
  }

  // ---- decals ----
  async loadDecals(token) {
    const r = await fetch(`${DATA}/mapdecals?${this.query}`);
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (token !== this.token) return;
    const { head, offset } = parseBlob(buf, 'XODC');
    const V = head.vertices, I = head.indices;
    let o = offset;
    const pos = new Float32Array(buf, o, V * 3); o += V * 12;
    const nor = new Float32Array(buf, o, V * 3); o += V * 12;
    const uv = new Float32Array(buf, o, V * 2); o += V * 8;
    const fade = new Float32Array(buf, o, V); o += V * 4;
    const idx = new Uint32Array(buf, o, I);
    const group = new THREE.Group();
    group.name = 'decals';
    group.visible = this.show.decals;
    const textures = [];
    const tex = (base, role) => {
      if (!base) return null;
      const e = this.v.acquireTexture(base, role, this.texMax);
      textures.push(e);
      return e;
    };
    const texOf = new Map(); // (one fetch per texture: decals share atlases)
    const getTex = (base, role) => {
      const k = `${base}|${role}`;
      if (!texOf.has(k)) texOf.set(k, tex(base, role));
      return texOf.get(k);
    };
    // The host sends a decal in pieces, one per surface it lies on (the ground, then each object), one
    // after another. Decals of one look (the same textures and settings) are drawn as one mesh, unless a
    // decal of another look drawn between them lies over them (their boxes): the map's order holds where
    // decals meet, and a map's thousands of decals take about as many draw calls as their looks (fuji:
    // 3,290 decals, 2,984 draw calls on its overview before). The pieces on objects are kept as index
    // ranges, which syncDecals leaves out while their object is hidden.
    // They are laid in the map's order (layer, then sublayer: a higher one on top), all before the water.
    const order = head.decals.map((d, i) => i).sort((a, b) => (head.decals[a].layer || 0) - (head.decals[b].layer || 0) || (head.decals[a].sublayer || 0) - (head.decals[b].sublayer || 0) || a - b);
    const rank = new Map(order.map((di, k) => [di, 0.5 + (0.5 * k) / Math.max(1, order.length)]));
    // every decal, its pieces as the host sent them, and its box
    const list = [];
    let cur = null;
    for (let i = 0; i + 5 < head.meshes.length; i += 6) {
      const di = head.meshes[i], d = head.decals[di];
      const v0 = head.meshes[i + 1], vn = head.meshes[i + 2], i0 = head.meshes[i + 3], ni = head.meshes[i + 4], object = head.meshes[i + 5];
      if (!d || !vn || !ni) continue;
      if (cur && (cur.di !== di || cur.v1 !== v0)) { list.push(cur); cur = null; }
      if (!cur) cur = { di, d, v0, v1: v0, n: 0, pieces: [] };
      cur.pieces.push({ object, v0, i0, ni });
      cur.v1 = v0 + vn;
      cur.n += ni;
    }
    if (cur) list.push(cur);
    for (const c of list) {
      const bx = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let v = c.v0; v < c.v1; v++) for (let k = 0; k < 3; k++) { const x = pos[v * 3 + k]; if (x < bx[k]) bx[k] = x; if (x > bx[k + 3]) bx[k + 3] = x; }
      c.box = bx;
    }
    list.sort((a, b) => rank.get(a.di) - rank.get(b.di));
    // the batches, in the map's order: a decal joins its look's latest one when nothing of another look
    // drawn since that one began lies over it (a 32 m grid of the decals so far)
    const lookOf = (d) => JSON.stringify([d.albedo, d.normal, d.spec, d.custom || !d.uniform ? d.color : d.uniform, d.height, d.sharpness, d.opacity, d.albedoOpacity,
      d.gloss, d.metal, d.normalOpacity, d.glow, d.glowEv, d.glowFromAlbedo]);
    const GRID = 32, grid = new Map(), open = new Map(), batches = [];
    const cellsOf = (bx) => {
      const out = [];
      for (let x = Math.floor(bx[0] / GRID); x <= Math.floor(bx[3] / GRID); x++) for (let z = Math.floor(bx[2] / GRID); z <= Math.floor(bx[5] / GRID); z++) out.push(x + ',' + z);
      return out;
    };
    const meets = (p, q) => p[0] <= q[3] && q[0] <= p[3] && p[1] <= q[4] && q[1] <= p[4] && p[2] <= q[5] && q[2] <= p[5];
    for (const c of list) {
      const look = lookOf(c.d), r = rank.get(c.di), cells = cellsOf(c.box);
      let batch = open.get(look);
      if (batch) {
        check: for (const k of cells) for (const o of grid.get(k) || []) if (o.look !== look && o.rank > batch.first && meets(o.box, c.box)) { batch = null; break check; }
      }
      if (!batch) { batch = { look, first: r, members: [] }; open.set(look, batch); batches.push(batch); }
      batch.members.push(c);
      const entry = { look, rank: r, box: c.box };
      for (const k of cells) { let at = grid.get(k); if (!at) grid.set(k, (at = [])); at.push(entry); }
    }
    let count = 0;
    const split = []; // { mesh, full: the whole index, pieces: [{ object, start, count }], state }
    const make = (batch) => {
      let nv = 0, ni = 0;
      for (const c of batch.members) { nv += c.v1 - c.v0; ni += c.n; }
      const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), F = new Float32Array(nv), full = new Uint32Array(ni), pieces = [];
      let vo = 0, at = 0;
      for (const c of batch.members) {
        P.set(pos.subarray(c.v0 * 3, c.v1 * 3), vo * 3);
        N.set(nor.subarray(c.v0 * 3, c.v1 * 3), vo * 3);
        UV.set(uv.subarray(c.v0 * 2, c.v1 * 2), vo * 2);
        F.set(fade.subarray(c.v0, c.v1), vo);
        for (const p of c.pieces) { // (each piece's indices count from its own first vertex)
          const src = idx.subarray(p.i0, p.i0 + p.ni), shift = p.v0 - c.v0 + vo;
          for (let k = 0; k < src.length; k++) full[at + k] = src[k] + shift;
          pieces.push({ object: p.object, start: at, count: p.ni });
          at += p.ni;
        }
        vo += c.v1 - c.v0;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
      g.setAttribute('fade', new THREE.BufferAttribute(F, 1));
      const onObjects = pieces.some((p) => p.object >= 0);
      g.setIndex(new THREE.BufferAttribute(onObjects ? full.slice() : full, 1));
      g.computeBoundingSphere();
      const d = batch.members[0].d;
      const mat = this.decalMaterial(d, getTex(d.albedo, 'albedo'), getTex(d.normal, 'decal'), getTex(d.spec, 'gloss'));
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = d.name || 'decal';
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = batch.first;
      mesh.userData.decals = batch.members.length;
      group.add(mesh);
      if (onObjects) {
        mesh.userData.split = true;
        split.push({ mesh, full, pieces, state: '' });
      }
    };
    for (const batch of batches) make(batch);
    count = list.length;
    if (token !== this.token) {
      group.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); });
      for (const e of textures) this.v.tex.release(e);
      return;
    }
    this.decals = { group, textures, count, split };
    this.root.add(group);
    this.v.prepare(group); // (their shaders built while their textures come: they stand in till then)
    this.syncDecals();
    if (head.warnings?.length) this.loading.errors.push(...head.warnings.slice(0, 3).map((w) => `decals: ${w}`));
    this.v.dirty = true;
  }

  // A decal's pieces on objects show only while their object does: not hidden (H), its kind (props,
  // objects) switched on. (Hidden objects and kinds switched off are left out of the export, and so
  // are the decals on them: nothing floats where an object was.)
  syncDecals() {
    const split = this.decals?.split;
    if (!this.decals) return;
    // the decals that lie on the ground alone show with the terrain
    const ground = this.show.terrain !== false;
    for (const m of this.decals.group.children) if (!m.userData.split) m.visible = ground;
    if (!split?.length) { this.v.dirty = true; return; }
    if (!this.groupOf || this.groupOfModels !== this.models) { // object id -> its kind
      this.groupOf = new Map();
      this.groupOfModels = this.models;
      for (const rec of this.models) if (rec.ids) for (const id of rec.ids) this.groupOf.set(id, rec.group);
    }
    const shown = (id) => { const kind = this.groupOf.get(id); return !this.hidden.has(id) && (kind === undefined || this.show[kind] !== false); };
    for (const s of split) {
      const on = s.pieces.map((p) => (p.object < 0 ? ground : shown(p.object)));
      const state = on.map(Number).join('');
      if (state === s.state) continue;
      s.state = state;
      // the shares shown, written to the front of the index the mesh draws (no new GPU buffer)
      const index = s.mesh.geometry.index;
      let n = 0;
      s.pieces.forEach((p, k) => { if (on[k]) { index.array.set(s.full.subarray(p.start, p.start + p.count), n); n += p.count; } });
      s.mesh.geometry.setDrawRange(0, n);
      s.mesh.visible = n > 0;
      index.needsUpdate = true;
    }
    this.v.dirty = true;
  }

  // A decal's look: its albedo (or a plain colour), its normal map's relief, and where it shows: the
  // normal map's alpha is a height mask, and the decal's height / sharpness pick how much of it
  // (more height = more of the mask, more sharpness = harder edges), faded at the box's ends and on
  // steep surfaces. How glossy and metallic it is (the preset's, or its spec map: red the gloss,
  // green the metal: wet puddles and coasts shine), how much of its relief shows, and its glow (lava,
  // hits, painted light: its luminance at the view's exposure and the weather's EmissiveLumScale,
  // maplights.js glow: newyear_foray's light_quad decals glow 4 times brighter in its noon capture than
  // in its night's, -2 EV, like its lamps).
  decalMaterial(d, albedo, normal, spec) {
    const lin = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
    let color;
    // the colour (the preset's, or the decal's own) times the texture: coloured presets' albedos are
    // near-white detail (rust leaks and plates, scorch and impact marks, the football's shadow)
    const c = d.custom || !d.uniform ? d.color : d.uniform;
    color = c ? lin(c) : new THREE.Color(1, 1, 1);
    // coverage = (mask - (1 - height)) / (1 - sharpness): the decal starts where its mask passes the
    // height threshold and is solid a sharpness-wide step above it
    const t = 1 - THREE.MathUtils.clamp(d.height ?? 1, 0, 1), w = 1 / Math.max(0.02, 1 - THREE.MathUtils.clamp(d.sharpness ?? 0.5, 0, 1));
    const m = new THREE.MeshStandardMaterial({
      color, roughness: 1 - (d.gloss ?? 0), metalness: d.metal ?? 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    const n = d.normalOpacity ?? 1;
    m.normalScale.set(n, -n); // (no tangents: the frame comes from the UVs, whose V runs down)
    const opacity = (d.opacity ?? 1) * (d.albedoOpacity ?? 1);
    // (its luminance laid down like its albedo, by the decal's opacity x AlbedoOpacity: light_quad,
    // AlbedoOpacity 0.169 and the only glowing preset under 1, lies on both slopes of newyear_foray's
    // roofs (a volume decal, Map.cpp buildDecalMeshes), and its glow over them is 0.09-0.16 of its
    // full luminance in the night capture, 0.14 at the median of 6 views: about that 0.169)
    if (d.glow) {
      m.emissive.copy(lin(d.glow));
      m.emissiveIntensity = 2 ** (d.glowEv ?? 0) / 8;
    }
    const u = {
      xoMask: { value: null }, xoHasMask: { value: 0 }, xoDecal: { value: new THREE.Vector3(t, w, opacity) },
      xoSpec: { value: null }, xoHasSpec: { value: 0 }, xoGlow: this.lights?.glow || { value: 0 },
    };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      useLocalProbe(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float fade;\nvarying float vXoFade;\nvarying vec2 vXoUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvXoFade = fade;\n\tvXoUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D xoMask, xoSpec;\nuniform float xoHasMask, xoHasSpec, xoGlow;\nuniform vec3 xoDecal;\nvarying float vXoFade;\nvarying vec2 vXoUv;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n\tfloat xoH = xoHasMask > 0.5 ? texture2D( xoMask, vXoUv ).a : 1.0;\n\tdiffuseColor.a *= clamp( ( xoH - xoDecal.x ) * xoDecal.y, 0.0, 1.0 ) * vXoFade * xoDecal.z;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\tvec4 xoSpecTexel = xoHasSpec > 0.5 ? texture2D( xoSpec, vXoUv ) : vec4( 1.0 - roughness, metalness, 0.0, 0.0 );\n\troughnessFactor = 1.0 - xoSpecTexel.r;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = xoSpecTexel.g;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= xoGlow;');
    };
    m.customProgramCacheKey = () => 'xo-decal-2';
    m.userData.warmKind = 'decal'; // (warmup.js: its textures and this make its shader)
    m.userData.warmArgs = { glowFromAlbedo: !!d.glowFromAlbedo };
    m.visible = false; // (until its textures are in)
    // (its textures stand in till they come, so its shader is the one it ends with: none if one cannot be read)
    if (albedo) m.map = DECAL_STAND_IN;
    if (albedo && d.glowFromAlbedo) m.emissiveMap = DECAL_STAND_IN;
    if (normal) m.normalMap = DECAL_STAND_IN;
    const jobs = [];
    if (albedo) jobs.push(albedo.promise.then(({ tex }) => { m.map = tex; if (d.glowFromAlbedo) m.emissiveMap = tex; }, (e) => { m.map = m.emissiveMap = null; throw e; }));
    if (normal) jobs.push(normal.promise.then(({ tex }) => { m.normalMap = tex; u.xoMask.value = tex; u.xoHasMask.value = 1; }, (e) => { m.normalMap = null; throw e; }));
    if (spec) jobs.push(spec.promise.then(({ tex }) => { u.xoSpec.value = tex; u.xoHasSpec.value = 1; }));
    Promise.allSettled(jobs).then(() => { m.needsUpdate = true; m.visible = true; this.v.dirty = true; });
    return m;
  }

  // ---- the minimap ----
  // The minimap's picture: the baked ground, or (no terrain) every placement as a dot.
  makeMinimap(bmp) {
    const st = this.scene?.terrain;
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    if (bmp && st) {
      const k = N / Math.max(st.sizeX, st.sizeZ);
      const w = st.sizeX * k, h = st.sizeZ * k;
      g.drawImage(bmp, (N - w) / 2, (N - h) / 2, w, h);
    } else {
      const { cx, cz, span } = this.miniRect, k = N / span;
      const colours = { props: 'rgba(200, 200, 200, .55)', trees: 'rgba(110, 170, 90, .6)', objects: 'rgba(242, 160, 80, .6)' };
      for (const r of this.scene.models) {
        g.fillStyle = colours[r.group] || colours.props;
        for (let i = 9; i + 2 < r.m.length; i += 12) g.fillRect(N / 2 + (r.m[i] - cx) * k - 1, N / 2 + (r.m[i + 2] - cz) * k - 1, 2, 2);
      }
    }
    this.mini = { img: c };
    this.drawMinimap();
  }

  // map metres (glTF x, z) <-> minimap pixels
  miniScale() { return this.minimap.width / (this.miniRect?.span || 1000); }

  drawMinimap() {
    const cv = this.minimap;
    if (!cv || !this.scene || cv.offsetParent === null) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(14, 15, 18, .85)';
    g.fillRect(0, 0, W, H);
    if (this.mini) g.drawImage(this.mini.img, 0, 0, W, H);
    const k = this.miniScale(), { cx, cz } = this.miniRect;
    const toPx = (x, z) => [W / 2 + (x - cx) * k, H / 2 + (z - cz) * k];
    if (this.show.spawns) {
      for (const s of this.scene.spawns || []) {
        const [x, y] = toPx(s.pos[0], s.pos[2]);
        g.fillStyle = s.team === 1 ? '#4cc3ff' : s.team === 2 ? '#ff5a4a' : '#f2f2f2';
        g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
      }
    }
    if (this.sel.size) { // the selection: orange dots, drawn into a layer of their own when it changes
      // (after Select all, thousands of dots: not again on every frame the camera moves)
      const key = `${this.selVersion}|${W}x${H}|${k}|${cx},${cz}`;
      if (this.selLayer?.key !== key) {
        const layer = this.selLayer?.canvas || document.createElement('canvas');
        layer.width = W;
        layer.height = H;
        const s = layer.getContext('2d');
        s.fillStyle = '#ffa43c';
        s.strokeStyle = '#1a1208';
        s.lineWidth = 1;
        const many = this.sel.size > 300;
        for (const p of this.sel.values()) {
          if (!p.rec.centers) continue;
          const [sx, sy] = toPx(p.rec.centers[p.i * 3], p.rec.centers[p.i * 3 + 2]);
          if (many) { s.fillRect(sx - 1.5, sy - 1.5, 3, 3); continue; }
          s.beginPath(); s.arc(sx, sy, 3, 0, Math.PI * 2); s.fill(); s.stroke();
        }
        this.selLayer = { key, canvas: layer };
      }
      g.drawImage(this.selLayer.canvas, 0, 0);
    }
    const cam = this.v.camera;
    const [x, y] = toPx(cam.position.x, cam.position.z);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const ang = Math.atan2(f.z, f.x), half = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect);
    const reach = Math.min(W, this.viewDistance * k);
    g.fillStyle = 'rgba(255, 178, 102, .18)';
    g.beginPath(); g.moveTo(x, y); g.arc(x, y, reach, ang - half, ang + half); g.closePath(); g.fill();
    g.fillStyle = '#f28c28';
    g.strokeStyle = '#1a1208';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x + Math.cos(ang) * 8, y + Math.sin(ang) * 8);
    g.lineTo(x + Math.cos(ang + 2.5) * 6, y + Math.sin(ang + 2.5) * 6);
    g.lineTo(x + Math.cos(ang - 2.5) * 6, y + Math.sin(ang - 2.5) * 6);
    g.closePath(); g.fill(); g.stroke();
  }

  bindMinimap(cv) {
    const at = (e) => {
      const r = cv.getBoundingClientRect(), k = this.miniScale(), { cx, cz } = this.miniRect;
      return [cx + ((e.clientX - r.left) / r.width * cv.width - cv.width / 2) / k, cz + ((e.clientY - r.top) / r.height * cv.height - cv.height / 2) / k];
    };
    let down = false;
    cv.addEventListener('pointerdown', (e) => { if (!this.scene || e.button !== 0) return; down = true; try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ } this.flyTo(...at(e)); });
    cv.addEventListener('pointermove', (e) => { if (down) this.flyTo(...at(e)); });
    const end = () => (down = false);
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  // ---- picking and selection ----
  // An object is a placement: a record (model + skin + group) and its index there. Its id is the
  // host's (the object's place in the map: /mapobject, exportMapObjects, the map export's exclude).
  idOf(rec, i) { return rec.ids ? rec.ids[i] : `${rec.path}|${i}`; }

  // What to call it: its model's file name; the kind of thing it is (an entity's game definition,
  // a prop's folder).
  static nameOf(rec) { return rec.path.split('/').pop().replace(/\.mdl$/i, '').replace(/_/g, ' '); }
  static kindOf(rec) {
    if (rec.def) return rec.def.replace(/^Breakable_/, '').replace(/_/g, ' ');
    return rec.path.replace(/^assets\/props\//i, '').split('/').slice(0, -1).join(' / ').replace(/_/g, ' ');
  }
  labelOf(rec) { const k = MapView.kindOf(rec); return k ? `${MapView.nameOf(rec)} · ${k}` : MapView.nameOf(rec); }

  rayAt(clientX, clientY) {
    const r = this.v.canvas.getBoundingClientRect();
    const rc = this.raycaster || (this.raycaster = new THREE.Raycaster());
    rc.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.v.camera);
    return rc.ray;
  }

  // The object under a point of the view (client coordinates): the nearest one the ray meets, by
  // bounding spheres first, then the triangles of its finest LOD; nothing behind the ground or past
  // the view distance. { rec, i, dist } or null.
  pickAt(clientX, clientY) {
    if (!this.scene) return null;
    const ray = this.rayAt(clientX, clientY), o = ray.origin, d = ray.direction;
    let far = this.viewDistance;
    const ground = this.groundHit(ray, far);
    if (ground !== null) far = ground + 0.05;
    const cand = [];
    for (const rec of this.models) {
      if (!rec.ready || !rec.centers || this.show[rec.group] === false) continue;
      const C = rec.centers, R = rec.radii, hide = rec.hide;
      for (let i = 0; i < rec.n; i++) {
        if (hide && hide[i]) continue;
        const cx = C[i * 3] - o.x, cy = C[i * 3 + 1] - o.y, cz = C[i * 3 + 2] - o.z, r = R[i];
        const t = cx * d.x + cy * d.y + cz * d.z; // (along the ray to the sphere's centre)
        const q = cx * cx + cy * cy + cz * cz - t * t;
        if (q > r * r || t + r < 0) continue;
        const enter = Math.max(0, t - Math.sqrt(r * r - q));
        if (enter <= far) cand.push({ rec, i, enter });
      }
    }
    cand.sort((a, b) => a.enter - b.enter);
    let best = null;
    for (const c of cand) {
      if (best && c.enter > best.dist) break; // (nothing further on can be nearer)
      const t = this.hitPlacement(c.rec, c.i, ray, best ? best.dist : far);
      if (t !== null) best = { rec: c.rec, i: c.i, dist: t };
    }
    return best;
  }

  // Where the ray (world, unit direction) first meets this placement's triangles (finest LOD), or null.
  hitPlacement(rec, i, ray, maxT) {
    const lod = rec.lods.find((l) => l.meshes.length);
    if (!lod) return null;
    const M = this.pickM || (this.pickM = new THREE.Matrix4()), inv = this.pickInv || (this.pickInv = new THREE.Matrix4());
    const n3 = this.pickN || (this.pickN = new THREE.Matrix3()), lr = this.pickRay || (this.pickRay = new THREE.Ray());
    M.fromArray(rec.mats, i * 16);
    inv.copy(M).invert();
    lr.origin.copy(ray.origin).applyMatrix4(inv);
    lr.direction.copy(ray.direction).applyMatrix3(n3.setFromMatrix4(inv)); // (not normalised: its t is the world's)
    if (rec.box && !lr.intersectsBox(rec.box)) return null;
    const ox = lr.origin.x, oy = lr.origin.y, oz = lr.origin.z, dx = lr.direction.x, dy = lr.direction.y, dz = lr.direction.z;
    let best = maxT;
    for (const mesh of lod.meshes) {
      const P = mesh.geometry.attributes.position, idx = mesh.geometry.index;
      if (!P || P.isInterleavedBufferAttribute || mesh.userData.lamp) continue;
      const pa = P.array, ia = idx ? idx.array : null, n = ia ? ia.length : P.count;
      for (let k = 0; k + 2 < n; k += 3) { // Möller-Trumbore, both faces (leaves and cards are seen from both sides)
        const a = (ia ? ia[k] : k) * 3, b = (ia ? ia[k + 1] : k + 1) * 3, c = (ia ? ia[k + 2] : k + 2) * 3;
        const e1x = pa[b] - pa[a], e1y = pa[b + 1] - pa[a + 1], e1z = pa[b + 2] - pa[a + 2];
        const e2x = pa[c] - pa[a], e2y = pa[c + 1] - pa[a + 1], e2z = pa[c + 2] - pa[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const f = 1 / det, sx = ox - pa[a], sy = oy - pa[a + 1], sz = oz - pa[a + 2];
        const u = (sx * px + sy * py + sz * pz) * f;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * f;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * f;
        if (t > 0 && t < best) best = t;
      }
    }
    return best < maxT ? best : null;
  }

  // How far along a ray (unit direction) the ground stops it (null: it doesn't within maxT).
  groundHit(ray, maxT) {
    const t = this.terrain;
    if (!t || !this.show.terrain) return null;
    const o = ray.origin, d = ray.direction, step = Math.max(0.5, t.stepM), top = this.scene?.terrain?.maxY ?? Infinity;
    const below = (s) => o.y + d.y * s < this.heightAt(o.x + d.x * s, o.z + d.z * s);
    if (below(0)) return null; // (the camera in the ground: nothing to hide behind)
    let prev = 0;
    for (let s = step; s <= maxT + step; s += step) {
      if (d.y >= 0 && o.y + d.y * s > top) return null; // (climbing above every hill)
      if (below(s)) {
        let a = prev, b = s;
        for (let k = 0; k < 10; k++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m; }
        return b;
      }
      prev = s;
    }
    return null;
  }

  // What a round meets between two points (Viewer.hitTest on a map: firing.js): the ground, water or a
  // shown object, whichever comes first; { dist, point, normal, surface }, or null. surface: 0 the
  // ground, 2 water, and an object's by what it is made of (as far as its name tells): 1 metal (wrecks,
  // containers, pipes ...), 4 wood (trees and plants), else 3 stone (rocks, buildings); an object's
  // normal faces back along the round.
  // water: false: the water's surface does not count (a driven vehicle's wheels go through it);
  // skip(rec, i): placements to go through (a driven vehicle: bushes, small props)
  segmentHit(p0, p1, { water = true, skip = null } = {}) {
    if (!this.scene) return null;
    const d = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), len = d.length();
    if (len < 1e-9) return null;
    d.divideScalar(len);
    const ray = (this.segRay ||= new THREE.Ray());
    ray.origin.set(p0[0], p0[1], p0[2]);
    ray.direction.copy(d);
    let best = null;
    const g = this.groundHit(ray, len);
    if (g !== null && g <= len) {
      const x = p0[0] + d.x * g, z = p0[2] + d.z * g, e = 0.5;
      const n = new THREE.Vector3(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e)).normalize();
      best = { dist: g, point: [x, this.heightAt(x, z), z], normal: n.toArray(), surface: 0 };
    }
    // water: where the segment goes down through a water area's surface, inside its outline
    for (const w of (water && this.show.water && this.scene.water) || []) {
      const L = w.level;
      if (!(p0[1] >= L && p1[1] < L)) continue;
      const k = (p0[1] - L) / (p0[1] - p1[1]), x = p0[0] + (p1[0] - p0[0]) * k, z = p0[2] + (p1[2] - p0[2]) * k;
      if ((!best || k * len < best.dist) && insideOutline(w.outline, x, z)) best = { dist: k * len, point: [x, L, z], normal: [0, 1, 0], surface: 2 };
    }
    // the objects: their bounding spheres along the segment (those in the grid cells it crosses),
    // then their finest LOD's triangles
    const o = ray.origin, grid = this.placementGrid();
    let near = best ? best.dist : len, hit = null, hitI = -1;
    const stamp = ++grid.stamp, G = grid.cell;
    const steps = Math.max(1, Math.ceil(near / (G / 4)));
    for (let k = -1; k <= steps; k++) {
      const s = (near * k) / steps, x = o.x + d.x * s, z = o.z + d.z * s;
      const list = grid.cells.get(k < 0 ? 'big' : Math.floor(x / G) * 65536 + Math.floor(z / G));
      if (!list) continue;
      for (let j = 0; j < list.length; j += 2) {
        const rec = this.models[list[j]], i = list[j + 1];
        if (grid.seen[rec.gridBase + i] === stamp) continue;
        grid.seen[rec.gridBase + i] = stamp;
        if (!rec.ready || this.show[rec.group] === false || (rec.hide && rec.hide[i])) continue;
        const C = rec.centers, cx = C[i * 3] - o.x, cy = C[i * 3 + 1] - o.y, cz = C[i * 3 + 2] - o.z, r = rec.radii[i];
        const t = cx * d.x + cy * d.y + cz * d.z;
        if (t + r < 0 || t - r > near || cx * cx + cy * cy + cz * cz - t * t > r * r) continue;
        if (skip && skip(rec, i)) continue;
        const h = this.hitPlacement(rec, i, ray, near);
        if (h !== null) { near = h; hit = rec; hitI = i; }
      }
    }
    if (hit) best = { dist: near, point: [o.x + d.x * near, o.y + d.y * near, o.z + d.z * near], normal: [-d.x, -d.y, -d.z], surface: surfaceOf(hit), path: hit.path, rec: hit, index: hitI };
    return best;
  }

  // The placements by 16 m squares of the ground (x, z), each square listing the ones whose bounding
  // sphere reaches into it (the few wider than 300 m on a list of their own): a round's segment tests
  // only the objects of the squares it crosses (11,511 on castle were all tested for every step of
  // every round). Made again as more models finish loading (their spheres come with them).
  placementGrid() {
    const ready = this.models.reduce((n, r) => n + (r.centers ? 1 : 0), 0);
    if (this.grid?.ready === ready) return this.grid;
    const G = 16, cells = new Map(), big = [];
    let base = 0;
    this.models.forEach((rec, ri) => {
      rec.gridBase = base;
      base += rec.n;
      if (!rec.centers) return;
      const C = rec.centers, R = rec.radii;
      for (let i = 0; i < rec.n; i++) {
        const r = R[i], x0 = Math.floor((C[i * 3] - r) / G), x1 = Math.floor((C[i * 3] + r) / G), z0 = Math.floor((C[i * 3 + 2] - r) / G), z1 = Math.floor((C[i * 3 + 2] + r) / G);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) { big.push(ri, i); continue; } // (wider than 300 m: tested every time)
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          const key = x * 65536 + z;
          let l = cells.get(key);
          if (!l) cells.set(key, (l = []));
          l.push(ri, i);
        }
      }
    });
    if (big.length) cells.set('big', big);
    this.grid = { ready, cell: G, cells, seen: new Uint32Array(base), stamp: 0 };
    return this.grid;
  }

  // the object under the cursor: a white outline and its name beside the cursor (viewer.mapHover)
  hoverAt(e) {
    if (!this.active) { // (another mode: its cursor and tooltip are its own)
      if (this.hover) { this.hover = null; this.refreshOutlines({ hoverOnly: true }); }
      return;
    }
    let hit = null;
    if (e && this.scene && !this.fly.drag && !this.fly.press && !this.fly.moving) hit = this.pickAt(e.clientX, e.clientY);
    if ((hit?.rec ?? null) !== (this.hover?.rec ?? null) || (hit && hit.i !== this.hover.i)) {
      this.hover = hit ? { rec: hit.rec, i: hit.i } : null;
      this.refreshOutlines({ hoverOnly: true }); // (a big selection's outline is not rebuilt on every hover)
    }
    if (hit) {
      const r = this.v.canvas.getBoundingClientRect();
      this.v.onHover({ x: e.clientX - r.left, y: e.clientY - r.top, text: this.labelOf(hit.rec) });
    } else {
      this.v.onHover(null);
    }
    if (!this.fly.drag) this.v.canvas.style.cursor = hit ? 'pointer' : '';
  }

  // a click: select what is under it (Ctrl: add it, or take it away again); on nothing, let go
  clickAt(e) {
    if (!this.scene) return;
    const hit = this.pickAt(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) { if (hit) this.toggle(hit.rec, hit.i); return; }
    this.selectOnly(hit ? [hit] : []);
  }

  // Ctrl + drag: a box; what is drawn inside it (its middle on screen in the box, within reach and
  // not behind the ground) joins the selection
  boxSelect(x0, y0, x1, y1, done) {
    let el = this.boxEl;
    if (!el) {
      el = this.boxEl = document.createElement('div');
      el.className = 'map-box';
      el.hidden = true;
      this.v.canvas.parentElement.appendChild(el);
    }
    if (done === 'cancel') { el.hidden = true; return; }
    const r = this.v.canvas.getBoundingClientRect();
    const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (!done) {
      el.hidden = false;
      Object.assign(el.style, { left: `${l - r.left}px`, top: `${t - r.top}px`, width: `${w}px`, height: `${h}px` });
      return;
    }
    el.hidden = true;
    if (!this.scene) return;
    const cam = this.v.camera;
    cam.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const nx0 = ((l - r.left) / r.width) * 2 - 1, nx1 = ((l + w - r.left) / r.width) * 2 - 1;
    const ny0 = 1 - ((t + h - r.top) / r.height) * 2, ny1 = 1 - ((t - r.top) / r.height) * 2;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), cp = cam.position, seg = new THREE.Ray();
    let added = 0;
    for (const rec of this.models) {
      if (!rec.ready || !rec.centers || this.show[rec.group] === false) continue;
      const C = rec.centers;
      for (let i = 0; i < rec.n; i++) {
        if (rec.hide?.[i]) continue;
        const x = C[i * 3], y = C[i * 3 + 1], z = C[i * 3 + 2], rad = rec.radii[i];
        const dist = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
        if (dist - rad > this.viewDistance || (dist > rad && rad / (dist * tanHalf) < MIN_SIZE)) continue;
        const cw = pv[3] * x + pv[7] * y + pv[11] * z + pv[15];
        if (cw <= 1e-6) continue; // (behind the camera)
        const sx = (pv[0] * x + pv[4] * y + pv[8] * z + pv[12]) / cw, sy = (pv[1] * x + pv[5] * y + pv[9] * z + pv[13]) / cw;
        if (sx < nx0 || sx > nx1 || sy < ny0 || sy > ny1) continue;
        seg.origin.copy(cp);
        seg.direction.set(x - cp.x, y - cp.y, z - cp.z).normalize();
        const g = this.groundHit(seg, dist);
        if (g !== null && g < dist - rad) continue; // (behind a hill)
        const id = this.idOf(rec, i);
        if (!this.sel.has(id)) { this.sel.set(id, { rec, i }); added++; }
      }
    }
    if (added) this.selectionChanged();
  }

  selected() { return [...this.sel.values()]; }
  isSelected(rec, i) { return this.sel.has(this.idOf(rec, i)); }
  selectedIds() { return [...this.sel.keys()].filter((id) => Number.isInteger(id)); }
  hiddenIds() { return [...this.hidden.keys()].filter((id) => Number.isInteger(id)); }

  // After the same map is loaded again (another texture size, game mode or festival): what the user
  // had hidden is hidden again and the selection comes back, by object id (those not on the map now
  // are let go).
  restoreIds({ hidden = [], sel = [] } = {}) {
    if (!hidden.length && !sel.length) return;
    const want = new Set([...hidden, ...sel]), at = new Map();
    for (const rec of this.models) for (let i = 0; i < rec.n; i++) { const id = this.idOf(rec, i); if (want.has(id)) at.set(id, { rec, i }); }
    for (const id of hidden) {
      const p = at.get(id);
      if (!p) continue;
      (p.rec.hide ||= new Uint8Array(p.rec.n))[p.i] = 1;
      this.hidden.set(id, p);
    }
    for (const id of sel) { const p = at.get(id); if (p && !this.hidden.has(id)) this.sel.set(id, p); }
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.lights?.changed();
    this.syncDecals();
    this.selectionChanged();
  }

  selectOnly(list) {
    if (!list.length && !this.sel.size) return;
    this.sel.clear();
    for (const p of list) this.sel.set(this.idOf(p.rec, p.i), { rec: p.rec, i: p.i });
    this.selectionChanged();
  }

  toggle(rec, i) {
    const id = this.idOf(rec, i);
    if (this.sel.has(id)) this.sel.delete(id);
    else this.sel.set(id, { rec, i });
    this.selectionChanged();
  }

  // every placement of one model (but the hidden ones): instead of the selection, or added to it
  selectKind(rec, add = false) {
    if (!add) this.sel.clear();
    for (let i = 0; i < rec.n; i++) if (!rec.hide?.[i]) this.sel.set(this.idOf(rec, i), { rec, i });
    this.selectionChanged();
  }

  selectionChanged() {
    this.selVersion = (this.selVersion || 0) + 1; // (the minimap's selection layer is drawn again)
    this.refreshOutlines();
    this.drawMinimap();
    this.onSelect();
    this.v.dirty = true;
  }

  // The placements whose bounding spheres reach within r of p (keep(rec, i): which count), nearest
  // first: { rec, i, d, center, surface }
  placementsNear(p, r, keep = null) {
    if (!this.scene) return [];
    const grid = this.placementGrid(), G = grid.cell, out = [], seen = new Set();
    const lists = [grid.cells.get('big')];
    for (let x = Math.floor((p[0] - r) / G); x <= Math.floor((p[0] + r) / G); x++)
      for (let z = Math.floor((p[2] - r) / G); z <= Math.floor((p[2] + r) / G); z++) lists.push(grid.cells.get(x * 65536 + z));
    for (const list of lists) {
      if (!list) continue;
      for (let j = 0; j < list.length; j += 2) {
        const rec = this.models[list[j]], i = list[j + 1], key = rec.gridBase + i;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!rec.ready || !rec.centers || this.show[rec.group] === false || rec.hide?.[i]) continue;
        const C = rec.centers, c = [C[i * 3], C[i * 3 + 1], C[i * 3 + 2]], d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
        if (d > r + rec.radii[i] || (keep && !keep(rec, i))) continue;
        out.push({ rec, i, d, center: c, surface: surfaceOf(rec) });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // A placement a driven vehicle ran through and broke (drive.js): gone from the view (not from the
  // export, unlike H) until the drive ends (mendBroken) or the map loads again.
  breakPlacement(rec, i) {
    if (rec.hide?.[i]) return false;
    (rec.hide ||= new Uint8Array(rec.n))[i] = 1;
    (this.broken ||= new Map()).set(this.idOf(rec, i), { rec, i });
    if (this.sel.delete(this.idOf(rec, i))) this.selectionChanged();
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.lights?.changed();
    this.syncDecals();
    return true;
  }

  mendBroken() {
    if (!this.broken?.size) return;
    for (const [id, p] of this.broken) if (!this.hidden.has(id) && p.rec.hide) p.rec.hide[p.i] = 0;
    this.broken.clear();
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.lights?.changed();
    this.syncDecals();
  }

  // H / Delete: the selection goes from the view (and from the map's export) until Show hidden
  hideSelected() {
    if (!this.sel.size) return;
    for (const [id, p] of this.sel) {
      (p.rec.hide ||= new Uint8Array(p.rec.n))[p.i] = 1;
      this.hidden.set(id, p);
    }
    this.sel.clear();
    this.hover = null;
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.lights?.changed();
    this.syncDecals();
    this.selectionChanged();
  }

  showHidden() {
    if (!this.hidden.size) return;
    for (const p of this.hidden.values()) if (p.rec.hide) p.rec.hide[p.i] = 0;
    this.hidden.clear();
    this.needsBucket = true;
    this.v.shadowDirty = true;
    this.lights?.changed();
    this.syncDecals();
    this.selectionChanged();
  }

  // F / double-click: the camera comes to the selection, looking at it from where it was (a little
  // from above), close enough for it to fill the view
  focusSelection() {
    const list = this.selected().filter((p) => p.rec.centers);
    if (!list.length) return;
    const c = new THREE.Vector3();
    for (const p of list) c.add(new THREE.Vector3().fromArray(p.rec.centers, p.i * 3));
    c.multiplyScalar(1 / list.length);
    let r = 0.5;
    for (const p of list) r = Math.max(r, c.distanceTo(new THREE.Vector3().fromArray(p.rec.centers, p.i * 3)) + p.rec.radii[p.i]);
    const cam = this.v.camera;
    const dir = c.clone().sub(cam.position);
    if (dir.lengthSq() < 1e-6) dir.set(0, -0.3, -1);
    dir.normalize();
    if (dir.y > -0.3) { dir.y = -0.3; dir.normalize(); } // (from a little above)
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(cam.fov) / 2)) * 1.1;
    const pos = c.clone().addScaledVector(dir, -dist);
    const floor = this.groundOr(pos.x, pos.z, -Infinity) + 1.5;
    if (pos.y < floor) pos.y = floor;
    this.fly.setPose(pos, c);
    this.needsBucket = true;
  }

  // The outlines: the selection orange, the object under the cursor white. Instanced copies of the
  // finest LOD at the placements, drawn only into the outline mask (post.js), so the outline runs
  // where the view shows the object, cut-out leaves included.
  refreshOutlines({ hoverOnly = false } = {}) {
    const make = (list, old) => {
      old?.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
      const byRec = new Map();
      for (const p of list) {
        if (p.rec.hide?.[p.i] || !p.rec.ready || this.show[p.rec.group] === false) continue; // (its group switched off: no outline in the air)
        if (!byRec.has(p.rec)) byRec.set(p.rec, []);
        byRec.get(p.rec).push(p.i);
      }
      const g = new THREE.Group();
      for (const [rec, is] of byRec) {
        const lod = rec.lods.find((l) => l.meshes.length);
        if (!lod) continue;
        for (const piece of lod.meshes) {
          if (piece.userData.lamp) continue; // (a lamp's glow card would be outlined as a rectangle)
          const im = new THREE.InstancedMesh(piece.geometry, piece.material, is.length);
          is.forEach((i, k) => im.instanceMatrix.array.set(rec.mats.subarray(i * 16, i * 16 + 16), k * 16));
          im.instanceMatrix.needsUpdate = true;
          im.frustumCulled = false;
          g.add(im);
        }
      }
      return g.children.length ? g : null;
    };
    const on = this.active && !!this.scene;
    if (!hoverOnly) this.outlined.sel = make(on ? this.selected() : [], this.outlined.sel);
    const hov = on && this.hover && !this.isSelected(this.hover.rec, this.hover.i) ? [this.hover] : [];
    this.outlined.hover = make(hov, this.outlined.hover);
    const list = [];
    if (this.outlined.sel) list.push({ object: this.outlined.sel, color: SEL_COLOR });
    if (this.outlined.hover) list.push({ object: this.outlined.hover, color: HOVER_COLOR });
    this.v.setOutlines(list, 'map');
  }

  // ---- for the panel ----
  stats() {
    const s = this.scene;
    if (!s) return null;
    let placed = 0;
    for (const r of this.models) placed += r.n;
    return {
      name: s.name, size: s.terrain ? [s.terrain.sizeX, s.terrain.sizeZ] : null, models: this.models.length, placed,
      water: (s.water || []).length, spawns: (s.spawns || []).length, unresolved: s.unresolved || [], filteredOut: s.filteredOut || 0,
      gameplay: s.gameplay, gameplays: s.gameplays || [], festival: s.festival, festivals: s.festivals || [],
      drawn: this.drawn, loading: this.loading,
      grass: this.grass ? { kinds: this.grass.types.length, placed: this.grass.data.length / 13, drawn: this.drawn.grass || 0 } : null,
      decals: this.decals ? this.decals.count : 0, lights: this.lights ? this.lights.counts : null,
      environment: this.env ? this.env.name : '', sky: !!(this.sky && this.sky.ready),
      environmentId: s.environment || '', environments: s.environments || [],
      selected: this.sel.size, hidden: this.hidden.size,
      soundscape: s.soundscape || '', sounds: (s.sounds || []).length,
      effects: (s.effects || []).length, weatherFx: this.env?.values?.AreaEffect || '',
    };
  }
}
