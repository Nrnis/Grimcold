// Final image: the scene is drawn into a multisampled HDR target with a depth texture, ambient
// occlusion is worked out from that depth at half size and blurred, and the result is tone-mapped
// onto the (transparent) canvas. Where there is no model, occlusion darkens the background instead,
// which gives parts a soft contact shadow on the floor. In Maps, bloom and the sun's light shafts
// (Post.glow) are added to the HDR colour before tone mapping.
import * as THREE from 'three';

const KERNEL = 16;

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const VIEWPOS = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 invProj;
vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 p = invProj * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}`;

// Hemisphere SSAO; normals come from the depth itself (the side with the smaller depth step, so
// silhouettes do not smear), the sample pattern turns per pixel (interleaved gradient noise).
const AO_FRAG = /* glsl */ `
${VIEWPOS}
uniform mat4 proj;
uniform vec2 texel;
uniform float radius, bias, power, fadeNear, fadeFar;
uniform vec3 kernel[${KERNEL}];
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  if (texture2D(tDepth, vUv).x >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  // only around what is on stage: far floor seen at a grazing angle would shade itself
  float fade = 1.0 - smoothstep(fadeNear, fadeFar, -P.z);
  if (fade <= 0.0) { gl_FragColor = vec4(1.0); return; }
  float bz = bias + abs(P.z) * 0.0015;
  vec3 r = viewPos(vUv + vec2(texel.x, 0.0)), l = viewPos(vUv - vec2(texel.x, 0.0));
  vec3 u = viewPos(vUv + vec2(0.0, texel.y)), b = viewPos(vUv - vec2(0.0, texel.y));
  vec3 dx = abs(r.z - P.z) < abs(P.z - l.z) ? r - P : P - l;
  vec3 dy = abs(u.z - P.z) < abs(P.z - b.z) ? u - P : P - b;
  vec3 N = normalize(cross(dx, dy));
  float a = ign(gl_FragCoord.xy) * 6.2831853;
  vec3 rv = vec3(cos(a), sin(a), 0.0);
  vec3 T = normalize(rv - N * dot(rv, N));
  mat3 TBN = mat3(T, cross(N, T), N);
  float occ = 0.0;
  for (int i = 0; i < ${KERNEL}; i++) {
    vec3 S = P + TBN * kernel[i] * radius;
    vec4 o = proj * vec4(S, 1.0);
    vec2 suv = o.xy / o.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float sz = viewPos(suv).z;
    float range = smoothstep(0.0, 1.0, radius / max(1e-4, abs(P.z - sz)));
    occ += step(S.z + bz, sz) * range;
  }
  float ao = pow(clamp(1.0 - occ / float(${KERNEL}), 0.0, 1.0), power);
  gl_FragColor = vec4(vec3(mix(1.0, ao, fade)), 1.0);
}`;

// 5x5 blur that keeps to one surface (weights fall off with the depth difference).
const BLUR_FRAG = /* glsl */ `
${VIEWPOS}
uniform sampler2D tAO;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  float z0 = viewPos(vUv).z;
  float sum = 0.0, wsum = 0.0;
  for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
    vec2 uv = vUv + vec2(float(x), float(y)) * texel;
    float w = 1.0 / (1.0 + 400.0 * abs(viewPos(uv).z - z0) / max(0.1, abs(z0)));
    sum += texture2D(tAO, uv).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(vec3(sum / wsum), 1.0);
}`;

// The garage's outline: the outlined parts alone, drawn with their line colour and 1 / view depth
// (0 = nothing there). Inverse depth is linear across a flat surface, so only real steps show.
// Cut-out materials keep their holes: XO_CUT 2 (nets, grates: the albedo's alpha) exactly; XO_CUT 1
// (foliage: a leaf mask's red) as one blob, read from a coarse mip at the object's own depth, so a tree
// is outlined around its crown instead of around every leaf.
const MASK_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying float vDepth;
varying float vFlat;
varying vec2 vXoUv;
void main() {
  vXoUv = uv;
  vec4 xoOrigin = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
    xoOrigin = instanceMatrix * xoOrigin;
  #endif
  vFlat = -(modelViewMatrix * xoOrigin).z;
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vDepth = -mvPosition.z;
}`;
const MASK_FRAG = /* glsl */ `
uniform vec3 color;
varying float vDepth;
varying float vFlat;
varying vec2 vXoUv;
#ifdef XO_CUT
uniform sampler2D cutMap;
uniform mat3 cutTransform;
uniform float cutoff;
#endif
void main() {
  float z = vDepth;
#ifdef XO_CUT
  vec2 uv = (cutTransform * vec3(vXoUv, 1.0)).xy;
  #if XO_CUT == 1
    if (texture2D(cutMap, uv, 3.0).r < cutoff * 0.5) discard;
    z = max(vFlat, 0.5);
  #else
    if (texture2D(cutMap, uv).a < cutoff) discard;
  #endif
#endif
  gl_FragColor = vec4(color, 1.0 / max(z, 1e-3));
}`;

// Maps' glow, at half size and less (Post.renderGlow):
//  - bloom: what is brighter than BLOOM_THRESHOLD (a soft knee) blurred down a chain of ever smaller
//    sizes and back up again, adding each finer level (dual filtering), BLOOM_K of it added and more
//    where the game's lens dirt lies (textures/lens_dirt over the screen)
//  - light shafts: the sky around the sun (pow(cos, the weather's LightShaftExponent), in its tint or
//    the sun's colour), smeared towards the sun's place on screen in three ever longer passes, so
//    whatever stands against the sky breaks it into rays; gone as the sun leaves the view
// The game's captures hold no post effects, so the strengths are its loading pictures' (none shows
// rays or a coloured cast towards the sun; flames and the sun's surroundings glow a little). In the
// game's units at its exposure (sky.js presetLevels) the threshold of 2 leaves sunlit ground out (its
// brightest channel up to about 1.1 at the probes) and takes the sun's disc, glints, lamps and fires. SHAFT_K is of the sun's luminance:
// 9 % of the haze's brightness on the bridge's clear day, about what it was first tuned to (7 %, as
// 0.03 x the key light in the older units, whose sun was 9 x weaker against its sky); 0.03 x the key
// light in these units (86 %) washed what stands against the sun pink (bridge 664236's ruins,
// sand_valley 702818's rocks).
const BLOOM_THRESHOLD = 2, BLOOM_KNEE = 1, BLOOM_K = 0.05, DIRT_K = 0.6, SHAFT_K = 0.005;
const BLOOM_LEVELS = 6;
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform vec2 curve; // threshold, knee
varying vec2 vUv;
void main() {
  vec3 c = 0.25 * (texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb +
                   texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb);
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - curve.x + curve.y, 0.0, 2.0 * curve.y);
  soft = soft * soft / (4.0 * curve.y + 1e-4);
  c *= max(soft, br - curve.x) / max(br, 1e-4);
  gl_FragColor = vec4(min(c, vec3(64.0)), 1.0); // (no single blinding texel)
}`;
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0 + texture2D(tSrc, vUv - texel).rgb + texture2D(tSrc, vUv + texel).rgb +
           texture2D(tSrc, vUv + vec2(texel.x, -texel.y)).rgb + texture2D(tSrc, vUv - vec2(texel.x, -texel.y)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc, tFine;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = (texture2D(tSrc, vUv + vec2(-2.0 * texel.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(2.0 * texel.x, 0.0)).rgb +
            texture2D(tSrc, vUv + vec2(0.0, -2.0 * texel.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, 2.0 * texel.y)).rgb +
            2.0 * (texture2D(tSrc, vUv + texel).rgb + texture2D(tSrc, vUv - texel).rgb +
                   texture2D(tSrc, vUv + vec2(texel.x, -texel.y)).rgb + texture2D(tSrc, vUv - vec2(texel.x, -texel.y)).rgb)) / 12.0;
  gl_FragColor = vec4(c + texture2D(tFine, vUv).rgb, 1.0);
}`;
const SKY_FRAG = /* glsl */ `
${VIEWPOS}
uniform vec3 sunView, color;
uniform float exponent;
varying vec2 vUv;
void main() {
  float sky = step(1.0, texture2D(tDepth, vUv).x);
  float lobe = pow(clamp(dot(normalize(viewPos(vUv)), sunView), 0.0, 1.0), exponent);
  gl_FragColor = vec4(color * sky * lobe, 1.0);
}`;
const SHAFT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 sunUv;
uniform float reach;
varying vec2 vUv;
void main() {
  vec2 stride = (sunUv - vUv) * reach / 12.0;
  vec3 c = vec3(0.0);
  float w = 1.0, sum = 0.0;
  for (int i = 0; i < 12; i++) {
    c += texture2D(tSrc, vUv + stride * float(i)).rgb * w;
    sum += w;
    w *= 0.92;
  }
  gl_FragColor = vec4(c / sum, 1.0);
}`;
const GLOW_FRAG = /* glsl */ `
uniform sampler2D tBloom, tShafts, tDirt;
uniform float bloomK, dirtK, dirtOn, shaftsOn;
varying vec2 vUv;
void main() {
  vec3 dirt = dirtOn > 0.5 ? texture2D(tDirt, vec2(vUv.x, 1.0 - vUv.y)).rgb : vec3(0.0);
  vec3 c = texture2D(tBloom, vUv).rgb * (bloomK + dirtK * dirt);
  if (shaftsOn > 0.5) c += texture2D(tShafts, vUv).rgb;
  gl_FragColor = vec4(c, 1.0);
}`;

// Tone mapping + sRGB (the renderer's settings; in Maps the game's camera, xoGrade), ambient
// occlusion, and the floor shadow it leaves on empty pixels; then the outline on top: where an
// outlined part's silhouette runs (holes included) or its surface steps back by more than about
// 1.5 % of the distance. The canvas takes premultiplied colour.
const COMP_FRAG = /* glsl */ `
uniform sampler2D tColor, tAO, tMask, tHaze, tLut, tGlow;
uniform float aoOn, aoStrength, floorShadow, outlineOn, hazeOn, gradeOn, gradeToe, glowOn;
uniform mat3 gradeWhite;
uniform vec2 maskStep;
varying vec2 vUv;
// The game's camera after its exposure (Maps: sky.js, Post.grade): white balance, a toe darkening
// the deep shadows by the preset's TonemapToe, the filmic curve (the ACES fit three.js uses, 1/0.6
// bright: matched to the game's loading pictures), sRGB, then the preset's colour LUT (16^3 colours
// in a 256 x 16 strip as Unreal lays them out: red along each 16-texel slice, green down, blue from
// slice to slice)
vec3 xoGrade(vec3 c) {
  c = max(gradeWhite * c, 0.0);
  c = c * c / max(c + gradeToe, 1e-6);
  const mat3 acesIn = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 acesOut = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c = acesIn * (c / 0.6);
  c = clamp(acesOut * ((c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081)), 0.0, 1.0);
  c = linearToOutputTexel(vec4(c, 1.0)).rgb * 15.0;
  float s = floor(c.b);
  vec2 uv = vec2((c.r + 0.5) / 256.0 + s / 16.0, (c.g + 0.5) / 16.0);
  return mix(texture2D(tLut, uv).rgb, texture2D(tLut, uv + vec2(min(1.0, 15.0 - s) / 16.0, 0.0)).rgb, c.b - s);
}
vec4 outline() {
  vec4 m0 = texture2D(tMask, vUv);
  bool in0 = m0.a > 0.0;
  float edge = 0.0;
  vec3 col = m0.rgb;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
    if (x == 0 && y == 0) continue;
    vec4 m = texture2D(tMask, vUv + vec2(float(x), float(y)) * maskStep);
    if ((m.a > 0.0) != in0) { edge += 1.0; if (!in0) col = m.rgb; }
  }
  if (in0 && edge == 0.0) { // inside: a step in depth (second difference of 1/z, relative)
    float l = texture2D(tMask, vUv - vec2(maskStep.x, 0.0)).a, r = texture2D(tMask, vUv + vec2(maskStep.x, 0.0)).a;
    float d = texture2D(tMask, vUv - vec2(0.0, maskStep.y)).a, u = texture2D(tMask, vUv + vec2(0.0, maskStep.y)).a;
    float lap = max(abs(l + r - 2.0 * m0.a), abs(d + u - 2.0 * m0.a)) / m0.a;
    edge = smoothstep(0.015, 0.03, lap) * 3.0;
  }
  return vec4(col, clamp(edge / 3.0, 0.0, 1.0) * 0.95);
}
void main() {
  // heat haze: what is behind it comes from a little way off (the offsets the haze drew: fxview.js)
  vec2 uv = hazeOn > 0.5 ? clamp(vUv + texture2D(tHaze, vUv).xy, vec2(0.0), vec2(1.0)) : vUv;
  vec4 c = texture2D(tColor, uv);
  float ao = aoOn > 0.5 ? mix(1.0, texture2D(tAO, vUv).r, aoStrength) : 1.0;
  vec3 col = c.a > 1e-4 ? c.rgb / c.a : vec3(0.0);
  col *= ao;
  if (glowOn > 0.5) col += texture2D(tGlow, vUv).rgb; // (Maps: bloom, light shafts)
  if (gradeOn > 0.5) col = xoGrade(col);
  else {
#ifdef TONE_MAPPING
    col = toneMapping(col);
#endif
    col = linearToOutputTexel(vec4(col, 1.0)).rgb;
  }
  float a = c.a + (1.0 - ao) * floorShadow * (1.0 - c.a);
  vec4 o = outlineOn > 0.5 ? outline() : vec4(0.0);
  gl_FragColor = vec4(col * c.a * (1.0 - o.a) + o.rgb * o.a, a + o.a * (1.0 - a));
}`;

// A weather's light shafts (vals: its envsettings preset; sunColor: the key light's colour; sunLum: the
// sun's luminance in the view, sky.js levels.sun), or null: EnableLightShaft, its tint (LightShaftTint:
// ARGB as a decimal number) or the sun's colour (LightShaftUseSunColor), LightShaftSunLuminanceScale
// stops brighter, LightShaftExponent.
export function presetShafts(vals, sunColor, sunLum) {
  if (vals.EnableLightShaft !== 'true') return null;
  const n = Number(vals.LightShaftTint) >>> 0;
  const tint = new THREE.Color().setRGB(((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255, THREE.SRGBColorSpace);
  const color = (vals.LightShaftUseSunColor === 'true' ? sunColor.clone() : tint).multiplyScalar(SHAFT_K * sunLum * 2 ** (parseFloat(vals.LightShaftSunLuminanceScale) || 0));
  return { color, exponent: Math.max(1, parseFloat(vals.LightShaftExponent) || 20) };
}

// Fixed pseudo-random sample kernel (reproducible images), denser near the centre.
function makeKernel() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < KERNEL; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 0.9 + 0.1).normalize();
    const t = (i + 0.5) / KERNEL;
    out.push(v.multiplyScalar((0.15 + 0.85 * t) * (0.7 + 0.3 * rnd())));
  }
  return out;
}

export class Post {
  constructor(renderer) {
    this.r = renderer;
    this.ao = true;
    this.radius = 0.12;   // metres (set from the size of what is shown)
    this.strength = 0.9;
    this.floorShadow = 0.55;
    this.size = new THREE.Vector2();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.fs = new THREE.Scene();
    this.fs.add(this.quad);
    const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, ...extra });
    this.aoMat = mat(AO_FRAG, {
      tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, proj: { value: new THREE.Matrix4() }, texel: { value: new THREE.Vector2() },
      radius: { value: 0.12 }, bias: { value: 0.002 }, power: { value: 1.25 }, kernel: { value: makeKernel() },
      fadeNear: { value: 1e6 }, fadeFar: { value: 2e6 },
    }, { toneMapped: false });
    this.stage = null; // { center, radius } of what is shown: occlusion fades out beyond it
    this.fade = null;  // or [near, far] metres from the camera, when nothing is "on stage" (Maps)
    this.blurMat = mat(BLUR_FRAG, { tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, tAO: { value: null }, texel: { value: new THREE.Vector2() } }, { toneMapped: false });
    this.compMat = mat(COMP_FRAG, {
      tColor: { value: null }, tAO: { value: null }, aoOn: { value: 1 }, aoStrength: { value: 0.9 }, floorShadow: { value: 0.55 },
      tMask: { value: null }, outlineOn: { value: 0 }, maskStep: { value: new THREE.Vector2() },
      tHaze: { value: null }, hazeOn: { value: 0 }, tGlow: { value: null }, glowOn: { value: 0 },
      tLut: { value: null }, gradeOn: { value: 0 }, gradeToe: { value: 0 }, gradeWhite: { value: new THREE.Matrix3() },
    });
    // Maps' glow (see BLOOM_K): null, or { shafts: presetShafts(...) | null, sun: towards the sun (world),
    // dirt: the lens dirt texture | null }
    this.glow = null;
    const glowMat = (frag, uniforms) => mat(frag, { texel: { value: new THREE.Vector2() }, ...uniforms }, { toneMapped: false });
    this.brightMat = glowMat(BRIGHT_FRAG, { tSrc: { value: null }, curve: { value: new THREE.Vector2(BLOOM_THRESHOLD, BLOOM_KNEE) } });
    this.downMat = glowMat(DOWN_FRAG, { tSrc: { value: null } });
    this.upMat = glowMat(UP_FRAG, { tSrc: { value: null }, tFine: { value: null } });
    this.skyMat = glowMat(SKY_FRAG, { tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, sunView: { value: new THREE.Vector3() }, color: { value: new THREE.Vector3() }, exponent: { value: 20 } });
    this.shaftMat = glowMat(SHAFT_FRAG, { tSrc: { value: null }, sunUv: { value: new THREE.Vector2() }, reach: { value: 1 } });
    this.glowMat = glowMat(GLOW_FRAG, { tBloom: { value: null }, tShafts: { value: null }, tDirt: { value: null }, bloomK: { value: BLOOM_K }, dirtK: { value: DIRT_K }, dirtOn: { value: 0 }, shaftsOn: { value: 0 } });
    // the game's camera in Maps: { white (THREE.Matrix3), toe, lut (the 256 x 16 strip) }, or null
    // (the renderer's tone mapping)
    this.grade = null;
    // Heat haze (fxview.js): a scene of haze sprites that draw how far to bend what is behind them
    // (screen units, added up) into hazeRT, testing the scene's depth themselves (hazeUniforms)
    this.hazeScene = null;
    this.hazeUniforms = { tDepth: { value: null }, screen: { value: new THREE.Vector2() } };
    this.maskMats = new Map(); // line colour -> material
  }

  // src: the material it stands in for (a cut-out keeps its holes in the outline)
  maskMaterial(color, src = null) {
    const cut = src && src.alphaTest > 0 ? src.alphaMap || src.map : null;
    const key = cut ? `${color}|${cut.uuid}|${src.alphaMap ? 1 : 2}|${src.alphaTest}` : color;
    let m = this.maskMats.get(key);
    if (!m) {
      const c = new THREE.Color().setHex(color, THREE.LinearSRGBColorSpace); // as given: the canvas shows these values as they are
      const uniforms = { color: { value: new THREE.Vector3(c.r, c.g, c.b) } };
      if (cut) {
        if (cut.matrixAutoUpdate) cut.updateMatrix(); // (its tiling, as the material samples it)
        Object.assign(uniforms, { cutMap: { value: cut }, cutTransform: { value: cut.matrix }, cutoff: { value: src.alphaTest } });
      }
      m = new THREE.ShaderMaterial({ vertexShader: MASK_VERT, fragmentShader: MASK_FRAG, uniforms, defines: cut ? { XO_CUT: src.alphaMap ? 1 : 2 } : {}, side: THREE.DoubleSide, toneMapped: false });
      this.maskMats.set(key, m);
      // (one per texture: it goes when the texture does, or every cut-out ever outlined stayed in memory)
      if (cut) cut.addEventListener('dispose', () => { if (this.maskMats.get(key) === m) { this.maskMats.delete(key); m.dispose(); } });
    }
    return m;
  }

  // Draws the outlined parts (only their own meshes: no firing arcs or markers) into the mask.
  // Returns false when nothing of them is visible.
  renderMask(outlines, camera) {
    const r = this.r;
    const swapped = [], hidden = [];
    for (const { object, color } of outlines) {
      if (!object?.visible) continue;
      object.traverse((o) => {
        if (!(o.isMesh || o.isLine || o.isPoints) || !o.visible) return;
        // (a part's glow layers lie on its surface and are mostly invisible: outlined only on their own)
        const lamp = o.userData.lamp && o !== object;
        if (o.isMesh && o.material?.userData?.xo && o.material.visible !== false && !lamp) { swapped.push([o, o.material]); o.material = this.maskMaterial(color, o.material); }
        else { hidden.push(o); o.visible = false; }
      });
    }
    if (!swapped.length) { for (const o of hidden) o.visible = true; return false; }
    const clear = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha(), autoClear = r.autoClear;
    try {
      r.setRenderTarget(this.maskRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.autoClear = false;
      for (const { object } of outlines) if (object?.visible) r.render(object, camera);
    } finally {
      r.autoClear = autoClear;
      r.setClearColor(clear, clearAlpha);
      for (const [o, m] of swapped) o.material = m;
      for (const o of hidden) o.visible = true;
    }
    return true;
  }

  setSize(w, h) {
    if (this.size.x === w && this.size.y === h && this.scene) return;
    this.size.set(w, h);
    this.dispose();
    const pr = this.r.getPixelRatio();
    this.scene = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: pr >= 1.75 ? 2 : 4,
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType), // 32-bit: occlusion needs the precision
    });
    const hw = Math.max(1, Math.round(w / 2)), hh = Math.max(1, Math.round(h / 2));
    this.aoRT = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false });
    this.blurRT = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false });
    this.maskRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.hazeRT = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false }); // (half size: the bend is smooth)
    // the glow's: the bloom chain down (half size, then halving) and back up, the shafts (two to ping-pong), the sum
    const rt = (k) => new THREE.WebGLRenderTarget(Math.max(1, Math.round(w / 2 ** k)), Math.max(1, Math.round(h / 2 ** k)), { type: THREE.HalfFloatType, depthBuffer: false });
    this.bloomDown = Array.from({ length: BLOOM_LEVELS }, (_, k) => rt(k + 1));
    this.bloomUp = Array.from({ length: BLOOM_LEVELS - 1 }, (_, k) => rt(k + 1));
    this.shaftRT = [rt(2), rt(2)];
    this.glowRT = rt(1);
  }

  dispose() {
    for (const t of [this.scene, this.aoRT, this.blurRT, this.maskRT, this.hazeRT, this.glowRT, ...(this.bloomDown || []), ...(this.bloomUp || []), ...(this.shaftRT || [])]) t?.dispose();
    this.scene?.depthTexture?.dispose();
    this.scene = this.aoRT = this.blurRT = this.maskRT = this.hazeRT = this.glowRT = this.bloomDown = this.bloomUp = this.shaftRT = null;
  }

  // Maps' bloom and light shafts into glowRT (see BLOOM_K).
  renderGlow(camera, depth) {
    const g = this.glow, D = this.bloomDown, U = this.bloomUp;
    const run = (m, src, target, extra = {}) => {
      m.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      if (m.uniforms.tSrc) m.uniforms.tSrc.value = src.texture;
      for (const [k, v] of Object.entries(extra)) m.uniforms[k].value = v;
      this.pass(m, target);
    };
    run(this.brightMat, this.scene, D[0]);
    for (let k = 1; k < D.length; k++) run(this.downMat, D[k - 1], D[k]);
    for (let k = U.length - 1; k >= 0; k--) run(this.upMat, k === U.length - 1 ? D[k + 1] : U[k + 1], U[k], { tFine: D[k].texture });
    // the shafts, while the sun is ahead
    const sunView = g.shafts ? g.sun.clone().transformDirection(camera.matrixWorldInverse) : null;
    const facing = sunView ? THREE.MathUtils.smoothstep(-sunView.z, 0.0, 0.35) : 0;
    if (facing > 0) {
      const s = this.skyMat.uniforms;
      s.tDepth.value = depth;
      s.invProj.value.copy(camera.projectionMatrixInverse);
      s.sunView.value.copy(sunView);
      s.color.value.set(g.shafts.color.r, g.shafts.color.g, g.shafts.color.b).multiplyScalar(facing);
      s.exponent.value = g.shafts.exponent;
      run(this.skyMat, this.shaftRT[0], this.shaftRT[1]);
      const p = sunView.clone().applyMatrix4(camera.projectionMatrix);
      this.shaftMat.uniforms.sunUv.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
      for (const [i, reach] of [0.12, 0.25, 0.5].entries()) run(this.shaftMat, this.shaftRT[(i + 1) % 2], this.shaftRT[i % 2], { reach });
    }
    const u = this.glowMat.uniforms;
    u.tBloom.value = U[0].texture;
    u.tShafts.value = this.shaftRT[0].texture;
    u.shaftsOn.value = facing > 0 ? 1 : 0;
    u.tDirt.value = g.dirt;
    u.dirtOn.value = g.dirt ? 1 : 0;
    this.pass(this.glowMat, this.glowRT);
  }

  // The haze sprites' bends into hazeRT; false when none is drawn.
  renderHaze(camera, depth) {
    const hs = this.hazeScene;
    if (!hs || !hs.children.some((m) => m.visible && m.geometry?.drawRange.count > 0)) return false;
    const r = this.r;
    this.hazeUniforms.tDepth.value = depth;
    this.hazeUniforms.screen.value.set(this.hazeRT.width, this.hazeRT.height);
    const clear = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
    try {
      r.setRenderTarget(this.hazeRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      const auto = r.autoClear;
      r.autoClear = false;
      r.render(hs, camera);
      r.autoClear = auto;
    } finally {
      r.setClearColor(clear, clearAlpha);
    }
    return true;
  }

  pass(material, target) {
    this.quad.material = material;
    this.r.setRenderTarget(target);
    this.r.render(this.fs, this.cam);
  }

  // outlines: [{ object, color }] drawn with the garage's outline (see renderMask).
  render(scene, camera, outlines = []) {
    const r = this.r;
    r.setRenderTarget(this.scene);
    r.render(scene, camera);
    const outlined = outlines.length > 0 && this.renderMask(outlines, camera);
    const depth = this.scene.depthTexture;
    const hazed = this.renderHaze(camera, depth);
    if (this.ao) {
      const u = this.aoMat.uniforms;
      u.tDepth.value = depth;
      u.invProj.value.copy(camera.projectionMatrixInverse);
      u.proj.value.copy(camera.projectionMatrix);
      u.texel.value.set(1 / this.size.x, 1 / this.size.y);
      u.radius.value = this.radius;
      u.bias.value = this.radius * 0.02;
      if (this.stage) {
        const d = camera.position.distanceTo(this.stage.center);
        u.fadeNear.value = d + this.stage.radius * 1.5;
        u.fadeFar.value = d + this.stage.radius * 3;
      } else if (this.fade) { // (Maps: a fixed range from the camera)
        u.fadeNear.value = this.fade[0];
        u.fadeFar.value = this.fade[1];
      }
      this.pass(this.aoMat, this.aoRT);
      const b = this.blurMat.uniforms;
      b.tDepth.value = depth;
      b.invProj.value.copy(camera.projectionMatrixInverse);
      b.tAO.value = this.aoRT.texture;
      b.texel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
      this.pass(this.blurMat, this.blurRT);
    }
    if (this.glow) this.renderGlow(camera, depth);
    const c = this.compMat.uniforms;
    c.glowOn.value = this.glow ? 1 : 0;
    c.tGlow.value = this.glowRT.texture;
    c.tColor.value = this.scene.texture;
    c.tAO.value = this.blurRT.texture;
    c.aoOn.value = this.ao ? 1 : 0;
    c.aoStrength.value = this.strength;
    c.floorShadow.value = this.floorShadow;
    c.tMask.value = this.maskRT.texture;
    c.outlineOn.value = outlined ? 1 : 0;
    c.tHaze.value = this.hazeRT.texture;
    c.hazeOn.value = hazed ? 1 : 0;
    const g = this.grade;
    c.gradeOn.value = g ? 1 : 0;
    if (g) {
      c.tLut.value = g.lut;
      c.gradeToe.value = g.toe;
      c.gradeWhite.value.copy(g.white);
    }
    const lw = Math.max(1, Math.round(r.getPixelRatio())); // about 2 screen pixels wide, at any scaling
    c.maskStep.value.set(lw / this.size.x, lw / this.size.y);
    this.pass(this.compMat, null);
  }
}
