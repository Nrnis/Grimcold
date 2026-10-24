// The game's sky in Maps mode, from the map's environment (/mapenv: an assets/envsettings.mxml preset):
//  - the sky itself: the environment's atmosphere, as the game draws it, with Eric Bruneton's
//    "Precomputed Atmospheric Scattering" (2017; the shader functions below follow his published
//    reference implementation, BSD licence) over the tables the game ships with each atmosphere
//    (/atmosphere: transmittance, scattering); the sun's disc in it
//  - the sun: where the preset puts it (SunDirVert 90 = horizon .. 180 = zenith, SunDirHor the
//    azimuth; checked against the loading screens' shadows), its colour (the preset's, or what the
//    atmosphere lets through), and the light it gives
//  - the clouds: the preset's sky dome model (cloud cards around the horizon, with coverage, normal
//    and scattering maps), stars at night
//  - the fog: the preset's (fog.js), on everything below the sky; the sky itself is matched to the
//    probe's, fog and all (without a probe it takes the fog too)
//  - the light from the sky and the land on everything: the game's own light probe of the map
//    (/mapprobe: its HDR capture from one point, prefiltered for each roughness, and its diffuse
//    irradiance); the same sky without a probe (the main menu)
//  - how bright it all is (presetLevels): everything in the game's units of light, as the probes
//    keep them, at the game's exposure for the preset (an overcast has no sun, a night has its moon)
//  - the game's camera after that (post.js grade): white balance, tone curve and colour LUT
// Crossout 2.41's environments (Map.cpp writes the scene's entities into the preset) have, for most of
// them, a picture of the sky in place of the atmosphere (BackdropPath: loadBackdrop) with its clouds in
// it; the rest (SkyAtmosphere, worked out from the air) take the plain atmosphere the 2.40 presets used.
import * as THREE from 'three';
import { FOG_GLSL, FOG_UNIFORMS, fogLineUp, presetFog } from './fog.js';

const DATA = 'https://xo.data';
const enc = encodeURIComponent;
export const SKY_SCALE = 10; // the atmosphere's radiance -> the brightness measure() reads it at

const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
const vec3 = (s, d) => { const v = String(s || '').trim().split(/\s+/).map(Number); return v.length >= 3 && v.every(Number.isFinite) ? v.slice(0, 3) : d; };
// "0xAARRGGBB" -> { r, g, b } (sRGB 0..1), a
function argb(v) {
  const n = parseInt(String(v || '').replace(/^0x/i, ''), 16) >>> 0;
  return { a: (n >>> 24) / 255, r: ((n >>> 16) & 255) / 255, g: ((n >>> 8) & 255) / 255, b: (n & 255) / 255 };
}

// Where the sun is (glTF space, towards the sun): SunDirVert 90 = on the horizon, 180 = overhead;
// SunDirHor the azimuth (the sun lies along -(sin az, cos az) in the game's x, z).
export function sunDirection(values, rotation = [0, 0, 0]) {
  const el = THREE.MathUtils.degToRad(num(values.SunDirVert, 120) - 90);
  const az = THREE.MathUtils.degToRad(num(values.SunDirHor, 0) + (rotation[0] || 0));
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

// ---- how bright a preset is ----
// The game's unit of light: an atmosphere's radiance (its tables, with its own solar irradiance)
// times LIGHT_K per channel. Every preset's AtmosphereSunIllum is LIGHT_K x its atmosphere's sun
// through the air, the same LIGHT_K for every atmosphere (measured over 45 presets).
export const LIGHT_K = [775, 555, 537];
// The light probes keep the game's units / PROBE_UNIT (measured three ways, 14-21: sunlit and shaded
// snow in a capture, the clear sky against the atmosphere, the presets' exposure ranges). The view
// works in probe units times the exposure (presetLevels), its tone curve takes it from there.
export const PROBE_UNIT = 16;
// The sun as the probes' own captures show it: their sunlit ground has SUN_K of the preset's sun at
// PROBE_UNIT on it, against their own light from all around (which the view takes as it is). Fitted
// on 22 presets' captures, per block of terrain at the probe centre (the game's = a x the view's sunlight
// + b x the rest): bare sand, rock and snow give a = 0.72 .. 0.86, median 0.82 (13 presets: sand_valley's
// day 0.85 and sunset 0.85, arizona_silo, red_rocks, island, newyear_foray's day and night, bridge's two
// New Year snows, orbital_station's day and moon, hangar, vulkan's Halloween), for AtmosphereSunIllum and
// SunIlluminance, SunColor and the air's colour, sun and moon alike (bridge: 0.76 by day, 0.77 under the
// Halloween moon); grassy ground shows less (castle 0.64, tower 0.66, cityruin 0.71: the grass' own
// shade). The sky and the fog keep PROBE_UNIT (the clear sky against the atmosphere, the exposure ranges).
export const SUN_K = 0.82;
const LUM = [0.2126, 0.7152, 0.0722];
// The view's own lights, which the game gives no units for (glow maps and lamps at 1, a car's
// headlights), were tuned on the bridge's clear day: they follow the exposure against its 0.2102.
const TUNED_EXPOSURE = 0.2102;
// How light a scene is for the weather's particles and a car's headlights (GameSky.level): 1 on that
// clear day (its sun at SUN_K).
const TUNED_LEVEL = 1.37;
// The preset's TonemapToe (0 .. 0.2; 0.06 on the bridge's clear day) is a toe strength whose curve the
// game does not tell: here x^2 / (x + toe x TOE_K) on the exposed light (post.js xoGrade), which
// darkens the deep shadows only (at 0.06 the loading pictures' shadows are kept).
const TOE_K = 0.1;
// How bright the sun's disc is (the share of the sun's light that reaches the eye from the disc
// itself): the game's skies alone (FogLightingProbe) hold 0.099 .. 0.108 of the preset's sun in their
// disc (bridge 664236, castle 333035, arizona_silo 362592; sand_valley 702818's sunset 0.049), the
// dome's disc held 0.875 of it (its limb soft over the outer eighth of the radius). The nights'
// (halloween, night_moon, new_year_dark2, hangars/newyear_night) show none: their air's sun is under
// 0.05.
const DISC_K = 0.12;
// How much of the sun's light the cloud cards' lit sides send on (CLOUD_FRAG's sunlight): matched to
// the light probes' own skies (the bridge's thin clouds on its clear day).
const CLOUD_SUN = 0.1;
// The heights (radians) at which measure() reads the sky and the probe's sky is matched to it.
const MEASURED = [0.03, 0.12, 0.6, 1.2];
// The sky as shown is then held to the game's own capture of it direction by direction (holdToProbe),
// on a FIX_W x FIX_H panorama (1.4 degrees a texel, blurred over 3 x 3: the clouds keep the cards'
// fine shapes and take the game's brightness and colour around them). Measured on 9 environments at
// their probes (clear, overcast, sunset, snow by day and evening, sandstorm, smog, morning, dust):
// above 15 degrees the sky was up to 1.1 stops brighter than the capture's, 0.2 .. 0.6 on the clear
// days (the dome was held to the capture's median, clouds included, and the cards drew their clouds
// over it again); held, it is within 0.2 stop above 5 degrees on all of them, the colour with it.
const FIX_W = 256, FIX_H = 128, NEAR_SUN = Math.cos(THREE.MathUtils.degToRad(3)), LOW_ROW = THREE.MathUtils.degToRad(5);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lumOf = (c) => LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2];
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// The preset's light levels (vals: its values; mean: the luminance of its scene over every direction,
// in probe units: what the game's auto exposure meters, its light probe's own):
//  - the sun: AtmosphereSunIllum (what the air lets through) when UseAtmosphereSunIllum, else
//    SunIlluminance (an overcast's 3 against a clear day's 600-odd: no sun; a night's moon)
//  - the exposure: EV100 = log2(average luminance x 8) in game units, held between MinEV100 and
//    MaxEV100, less ExposureCompensation; game units / (1.2 x 2^EV) (Lagarde's convention) are what
//    the tone curve takes. Checked against the probes of every map: clear days meter inside their
//    range, dull and night presets clamp at their MinEV100 (the game keeps them dark)
//  - glowing things (lamps, lit windows): EmissiveLumScale (EV: -3 at night) at the exposure, so a
//    night's lamps shine brighter
// Returns the game's numbers (eSun, eAtm in its units, ev, eff) and the view's: exposure (probe
// units -> the view's), F (it against the tuned one), sun (the preset's sun in the view: what the
// map's lamps and the light shafts are measured against), key (the sunlight on the ground: sun x
// SUN_K), disc (x the sun disc), glow.
export function presetLevels(vals, mean) {
  const { eSun, eAtm } = sunIlluminance(vals);
  const ev = clamp(Math.log2(Math.max(mean * PROBE_UNIT * 8, 1e-6)), num(vals.MinEV100, -20), num(vals.MaxEV100, 30));
  const eff = ev - num(vals.ExposureCompensation, 0);
  const exposure = PROBE_UNIT / (1.2 * 2 ** eff), F = exposure / TUNED_EXPOSURE;
  // the sun's disc: its light against the air's own sun (an overcast hides it), DISC_K of it in the disc;
  // none where the air's own sun is gone (the nights: their skies alone show no moon)
  const ratio = eAtm ? eSun / eAtm : 1;
  const sun = (eSun / PROBE_UNIT) * exposure;
  return {
    eSun, eAtm, ev, eff, exposure, F, sun, key: sun * SUN_K,
    disc: DISC_K * ratio * THREE.MathUtils.smoothstep(ratio, 0.02, 0.15) * (eAtm == null ? 1 : THREE.MathUtils.smoothstep(eAtm, 0.5, 5)),
    glow: clamp(F * 2 ** (num(vals.EmissiveLumScale, 1) - 1), 0.25, 8),
  };
}

// The sun's luminance in game units (eSun) and the air's own sun (eAtm, AtmosphereSunIllum's, or null).
export function sunIlluminance(vals) {
  const asi = vec3(vals.AtmosphereSunIllum, null);
  const eAtm = asi ? lumOf(asi) : null;
  return { eAtm, eSun: Math.max(0, vals.UseAtmosphereSunIllum === 'true' && eAtm != null ? eAtm : num(vals.SunIlluminance, eAtm ?? 600)) };
}

// The camera's white balance (WhiteTemperature K, WhiteTint), as Unreal's WhiteBalance(): the white
// it is set to (on the Planckian locus below 4000 K, else the daylight one, moved off the locus by the
// tint, across (u, v) as Unreal's code does it: a positive tint takes green out, as the loading
// pictures want) adapted to D65 (Bradford), on linear sRGB. A 3000 K camera turns warm light white
// and everything else blue (new_year_dark's night).
export function whiteBalance(temp, tint) {
  const T = clamp(temp, 1000, 25000);
  const uv = (t) => [(0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t),
    (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t)];
  const xy = ([u, v]) => [(3 * u) / (2 * u - 8 * v + 4), (2 * v) / (2 * u - 8 * v + 4)];
  const [u, v] = uv(T), planck = xy([u, v]);
  const Td = (T * 1.4388) / 1.438; // (the revised Planck constant: 6500 K is D65)
  const dx = Td <= 7000 ? 0.244063 + (0.09911e3 + (2.9678e6 - 4.607e9 / Td) / Td) / Td : 0.23704 + (0.24748e3 + (1.9018e6 - 2.0064e9 / Td) / Td) / Td;
  const src = T < 4000 ? planck : [dx, -3 * dx * dx + 2.87 * dx - 0.275];
  const l = Math.hypot(u, v), k = num(tint, 0) * 0.05;
  const iso = xy([u - (v / l) * k, v + (u / l) * k]);
  const sx = src[0] + iso[0] - planck[0], sy = src[1] + iso[1] - planck[1];
  const XYZ = (x, y) => new THREE.Vector3(x / y, 1, (1 - x - y) / y);
  const toXYZ = new THREE.Matrix3().set(0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041);
  const cone = new THREE.Matrix3().set(0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296);
  const a = XYZ(sx, sy).applyMatrix3(cone), b = XYZ(0.3127, 0.329).applyMatrix3(cone);
  const adapt = new THREE.Matrix3().set(b.x / a.x, 0, 0, 0, b.y / a.y, 0, 0, 0, b.z / a.z);
  const m = cone.clone().invert().multiply(adapt).multiply(cone);
  return toXYZ.clone().invert().multiply(m).multiply(toXYZ);
}

// ---- Bruneton's atmosphere model (lengths in metres, the planet's centre at -bottom_radius on Y) ----
const ATMOSPHERE = /* glsl */ `
uniform sampler2D xoTransmittance;
uniform highp sampler3D xoScattering;
uniform float xoBottom, xoTop, xoMieG, xoMuSMin, xoSunRadius;
uniform vec3 xoSolar, xoRayleigh, xoMie, xoWhite;
const float XO_PI = 3.14159265358979;
float xoSafeSqrt(float a) { return sqrt(max(a, 0.0)); }
float xoDistTop(float r, float mu) { return max(0.0, -r * mu + xoSafeSqrt(r * r * (mu * mu - 1.0) + xoTop * xoTop)); }
bool xoHitsGround(float r, float mu) { return mu < 0.0 && r * r * (mu * mu - 1.0) + xoBottom * xoBottom >= 0.0; }
float xoTexCoord(float x, float n) { return 0.5 / n + x * (1.0 - 1.0 / n); }
vec2 xoTransmittanceUv(float r, float mu) {
  float H = sqrt(xoTop * xoTop - xoBottom * xoBottom);
  float rho = xoSafeSqrt(r * r - xoBottom * xoBottom);
  float d = xoDistTop(r, mu), dMin = xoTop - r, dMax = rho + H;
  return vec2(xoTexCoord((d - dMin) / (dMax - dMin), 256.0), xoTexCoord(rho / H, 64.0));
}
vec3 xoTransmittanceTop(float r, float mu) { return texture(xoTransmittance, xoTransmittanceUv(r, mu)).rgb; }
float xoRayleighPhase(float nu) { return 3.0 / (16.0 * XO_PI) * (1.0 + nu * nu); }
float xoMiePhase(float g, float nu) {
  float k = 3.0 / (8.0 * XO_PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}
vec4 xoScatteringUvwz(float r, float mu, float muS, float nu, bool ground) {
  float H = sqrt(xoTop * xoTop - xoBottom * xoBottom);
  float rho = xoSafeSqrt(r * r - xoBottom * xoBottom);
  float uR = xoTexCoord(rho / H, 32.0);
  float rMu = r * mu;
  float disc = rMu * rMu - r * r + xoBottom * xoBottom;
  float uMu;
  if (ground) {
    float d = -rMu - xoSafeSqrt(disc), dMin = r - xoBottom, dMax = rho;
    uMu = 0.5 - 0.5 * xoTexCoord(dMax == dMin ? 0.0 : (d - dMin) / (dMax - dMin), 64.0);
  } else {
    float d = -rMu + xoSafeSqrt(disc + H * H), dMin = xoTop - r, dMax = rho + H;
    uMu = 0.5 + 0.5 * xoTexCoord((d - dMin) / (dMax - dMin), 64.0);
  }
  float d = xoDistTop(xoBottom, muS), dMin = xoTop - xoBottom, dMax = H;
  float a = (d - dMin) / (dMax - dMin);
  float A = (xoDistTop(xoBottom, xoMuSMin) - dMin) / (dMax - dMin);
  float uMuS = xoTexCoord(max(1.0 - a / A, 0.0) / (1.0 + a), 32.0);
  return vec4((nu + 1.0) / 2.0, uMuS, uMu, uR);
}
// the light the sky sends along -ray towards a camera at height r (scattering only; no ground, no sun disc)
vec3 xoSkyRadiance(vec3 camera, vec3 ray, vec3 sun) {
  float r = length(camera);
  float rmu = dot(camera, ray);
  float dTop = -rmu - sqrt(max(rmu * rmu - r * r + xoTop * xoTop, 0.0));
  if (dTop > 0.0) { camera += ray * dTop; r = xoTop; rmu += dTop; }
  else if (r > xoTop) return vec3(0.0);
  float mu = rmu / r, muS = dot(camera, sun) / r, nu = dot(ray, sun);
  bool ground = xoHitsGround(r, mu);
  vec4 uvwz = xoScatteringUvwz(r, mu, muS, nu, ground);
  float tx = uvwz.x * 7.0;
  float x0 = floor(tx);
  float f = tx - x0;
  vec4 s = texture(xoScattering, vec3((x0 + uvwz.y) / 8.0, uvwz.z, uvwz.w)) * (1.0 - f) +
           texture(xoScattering, vec3((x0 + 1.0 + uvwz.y) / 8.0, uvwz.z, uvwz.w)) * f;
  vec3 mie = s.r > 0.0 ? s.rgb * s.a / s.r * (xoRayleigh.r / xoMie.r) * (xoMie / xoRayleigh) : vec3(0.0);
  return s.rgb * xoRayleighPhase(nu) + mie * xoMiePhase(xoMieG, nu);
}
`;

// The correction that holds the sky to the probe's (holdToProbe), towards dir; 1 until it is measured.
const SKY_FIX = /* glsl */ `
uniform sampler2D xoFix;
uniform float xoFixOn;
vec3 xoSkyFix(vec3 dir) {
  if (xoFixOn < 0.5) return vec3(1.0);
  return texture2D(xoFix, vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5, asin(clamp(dir.y, -1.0, 1.0)) / 3.1415927 + 0.5)).rgb;
}`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DOME_FRAG = /* glsl */ `
${ATMOSPHERE}
${FOG_GLSL}
${SKY_FIX}
uniform vec3 xoSun;
uniform float xoAltitude, xoScale, xoSunDisc, xoFogged;
uniform vec3 xoGround, xoTint;
uniform vec3 xoBand[4]; // (the light probe's sky against this one at the heights measure() reads)
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 camera = vec3(0.0, xoBottom + max(xoAltitude, 2.0), 0.0);
  vec3 rad = xoSkyRadiance(camera, dir, xoSun), disc = vec3(0.0);
  float r = camera.y;
  if (xoHitsGround(r, dir.y)) rad += xoGround; // (below the horizon: what the haze lies on)
  else if (xoSunDisc > 0.0) {
    float c = dot(dir, xoSun), cR = cos(xoSunRadius);
    if (c > cR) disc = xoTransmittanceTop(r, dir.y) * xoSolar / (XO_PI * xoSunRadius * xoSunRadius) * smoothstep(cR, mix(cR, 1.0, 0.25), c);
  }
  float e = asin(clamp(dir.y, 0.0, 1.0));
  vec3 band = e < 0.12 ? mix(xoBand[0], xoBand[1], clamp((e - 0.03) / 0.09, 0.0, 1.0)) : e < 0.6 ? mix(xoBand[1], xoBand[2], (e - 0.12) / 0.48)
    : mix(xoBand[2], xoBand[3], min((e - 0.6) / 0.6, 1.0));
  if (xoFogged < 0.5 && xoSunDisc > 0.0) disc *= xoFogSky(dir).a; // (the disc is sky, which the game fogs to no end; the rest is held to the probe's, fog and all)
  vec3 col = (rad * xoScale * band * xoSkyFix(dir) + disc * xoSunDisc) / xoWhite * xoTint;
  if (xoFogged > 0.5) { vec4 fog = xoFogSky(dir); col = col * fog.a + fog.rgb; } // (the fog to no end: the horizon is all fog)
  gl_FragColor = vec4(col, 1.0);
}`;
// Crossout 2.41's sky picture (loadBackdrop): v = 0 at the horizon, its column xoBdShift towards
// azimuth 0 (BackdropUvShift less the sun's azimuth: that column lies towards the sun), x xoScale (its
// luminance / 2048: light-probe units, at the exposure); below the horizon its horizon's colour x 0.6
// under BackdropGround (xoGround) by its opacity; the sun's disc over it. It drifts (drift): as a cloud
// deck overhead carried along xoDrift.xy by xoDrift.z (and the pass fading out, xoDrift.w, by 1 -
// xoDriftMix) of its height, the horizon held but for xoDriftC of the zenith's speed.
const BACKDROP_FRAG = /* glsl */ `
${FOG_GLSL}
${SKY_FIX}
uniform sampler2D xoBackdrop;
uniform float xoBdShift, xoScale, xoSunDisc, xoDiscCos, xoFogged, xoGroundMix, xoDriftMix, xoDriftC;
uniform vec3 xoSun, xoGround, xoDiscColor;
uniform vec4 xoDrift;
varying vec3 vDir;
vec3 xoDrifted(vec3 dir, float o) {
  if (o == 0.0 || dir.y <= 0.0) return dir;
  vec2 p = dir.xz / (dir.y + xoDriftC) - xoDrift.xy * o;
  float q = dot(p, p), y = (sqrt(q * (1.0 - xoDriftC * xoDriftC) + 1.0) - xoDriftC * q) / (q + 1.0);
  return vec3(p.x * (y + xoDriftC), y, p.y * (y + xoDriftC));
}
vec3 xoPicture(vec3 dir) {
  return texture2D(xoBackdrop, vec2(atan(dir.z, dir.x) / 6.2831853 + xoBdShift, max(asin(clamp(dir.y, -1.0, 1.0)), 0.0) / 1.5707963)).rgb;
}
void main() {
  vec3 dir = normalize(vDir);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  vec3 col = xoPicture(xoDrifted(dir, xoDrift.z));
  if (xoDriftMix < 1.0) col = mix(xoPicture(xoDrifted(dir, xoDrift.w)), col, xoDriftMix);
  col *= xoScale;
  if (el < 0.0) col = mix(col * 0.6, xoGround, xoGroundMix);
  col *= xoSkyFix(dir);
  float c = dot(dir, xoSun);
  if (el >= 0.0 && xoSunDisc > 0.0 && c > xoDiscCos) {
    float disc = xoSunDisc * smoothstep(xoDiscCos, mix(xoDiscCos, 1.0, 0.25), c);
    if (xoFogged < 0.5) disc *= xoFogSky(dir).a; // (the disc is sky, which the fog takes; the rest is held to the probe's, fog and all)
    col += xoDiscColor * disc;
  }
  if (xoFogged > 0.5) { vec4 fog = xoFogSky(dir); col = col * fog.a + fog.rgb; }
  gl_FragColor = vec4(col, 1.0);
}`;
// the sky in a few directions (x: azimuth, y: elevation row), for the haze and the clouds' ambient light
const PROBE_FRAG = /* glsl */ `
${ATMOSPHERE}
uniform vec3 xoSun;
uniform float xoAltitude, xoScale;
uniform vec2 xoSize;
uniform float xoElev[4];
void main() {
  float az = (floor(gl_FragCoord.x) + 0.5) / xoSize.x * 6.2831853;
  int row = int(floor(gl_FragCoord.y));
  float el = row == 0 ? xoElev[0] : row == 1 ? xoElev[1] : row == 2 ? xoElev[2] : xoElev[3];
  vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 camera = vec3(0.0, xoBottom + max(xoAltitude, 2.0), 0.0);
  gl_FragColor = vec4(xoSkyRadiance(camera, dir, xoSun) / xoWhite * xoScale, 1.0);
}`;

// Cloud cards: coverage (_at), normal (_n, BC5) and light scattering (_sss: red = how much light
// gets through, green = thickness) maps, lit by the sun and the sky.
const CLOUD_VERT = /* glsl */ `
attribute vec4 tangent;
varying vec2 vUv;
varying vec3 vN, vT, vB, vDir;
void main() {
  vUv = uv;
  mat3 m = mat3(modelMatrix);
  vN = normalize(m * normal);
  vT = normalize(m * tangent.xyz);
  vB = cross(vN, vT) * (tangent.w < 0.0 ? -1.0 : 1.0);
  // (the way from the camera, normalised per fragment: the cloudy domes' low layer runs from 1 % of the
  // dome's radius out to all of it, and directions normalised at its corners bend across it, so the
  // hold to the probe and the fog were looked up tens of degrees off: arena_football's and Halloween's
  // skies came out +0.54 / -0.18 stop from the capture, with an aurora's tint on newyear_foray's horizon)
  vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const CLOUD_FRAG = /* glsl */ `
${FOG_GLSL}
${SKY_FIX}
uniform sampler2D xoCover, xoNormal, xoScatter;
uniform float xoHasNormal, xoHasScatter, xoOpacity, xoStars;
uniform vec3 xoSun, xoSunLight, xoSkyLight;
varying vec2 vUv;
varying vec3 vN, vT, vB, vDir;
void main() {
  if (xoStars > 0.0) { // the night sky's stars (added on top)
    vec3 c = texture2D(xoCover, vUv).rgb * xoStars * xoFogSky(normalize(vDir)).a;
    gl_FragColor = vec4(c, 1.0);
    return;
  }
  float a = texture2D(xoCover, vUv).r * xoOpacity;
  if (a < 0.004) discard;
  vec3 n = vN;
  if (xoHasNormal > 0.5) {
    vec2 xy = texture2D(xoNormal, vUv).rg * 2.0 - 1.0;
    n = normalize(mat3(vT, vB, vN) * vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))));
  }
  vec2 s = xoHasScatter > 0.5 ? texture2D(xoScatter, vUv).rg : vec2(0.5);
  float lit = clamp(dot(n, xoSun) * 0.6 + 0.4, 0.0, 1.0);
  float through = pow(max(dot(normalize(vDir), xoSun), 0.0), 8.0) * s.r; // thin edges glow towards the sun
  vec3 col = xoSkyLight * mix(0.75, 1.15, s.g) + xoSunLight * (lit * mix(0.35, 0.9, s.r) + through * 1.6);
  vec4 fog = xoFogSky(normalize(vDir)); // (part of the sky: fogged as it is, and held to the probe's with it)
  gl_FragColor = vec4((col * fog.a + fog.rgb) * xoSkyFix(normalize(vDir)), a);
}`;

// The map environment's light probe (/mapprobe, see main.cpp serveMapProbe), or null when the map has
// none (the main menu); with its local one as localProbe (a hangar's hall: which = 1). Its panoramas
// stay RGBA halves, rows from v = 0.
export async function fetchProbe(query, which = 0) {
  const r = await fetch(`${DATA}/mapprobe?${query}${which ? `&probe=${which}` : ''}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const jl = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
  let off = (8 + jl + 3) & ~3;
  const take = ([w, h]) => { const a = new Uint16Array(buf, off, w * h * 4); off += w * h * 8; return a; };
  const p = { ...head, specularData: take(head.specular), diffuseData: take(head.diffuse), skyData: take(head.sky) };
  // (a local probe without a real box, 1 1 1 .. 2 2 2 m, is another global one)
  if (!which && head.local > 0) p.localProbe = await fetchProbe(query, 1).then((l) => (l && Math.max(...l.halfMax) > 2 ? l : null));
  return p;
}

// A panorama's texel towards elevation el (radians) and azimuth column x of n (three's layout).
function panoTexel(data, [w, h], el, x, n) {
  const j = Math.min(h - 1, Math.max(0, Math.floor((el / Math.PI + 0.5) * h))), i = Math.floor(((x + 0.5) / n) * w) % w;
  const o = (j * w + i) * 4, f = THREE.DataUtils.fromHalfFloat;
  return [f(data[o]), f(data[o + 1]), f(data[o + 2])];
}

// The probe's diffuse light as three's spherical harmonics (viewer.js IRRADIANCE): its irradiance / pi
// projected on the 9 basis functions, then scaled so three's irradiance from them (shGetIrradianceAt,
// Ramamoorthi and Hanrahan's cosine lobe: pi, 2pi/3, pi/4 per band) gives pi x it back.
function irradianceSH({ diffuse: [w, h], diffuseData: d }) {
  const sh = Array.from({ length: 9 }, () => new THREE.Vector3());
  const f = THREE.DataUtils.fromHalfFloat, basis = new Array(9);
  for (let j = 0; j < h; j++) {
    const el = ((j + 0.5) / h - 0.5) * Math.PI, dw = Math.cos(el) * (2 * Math.PI / w) * (Math.PI / h);
    for (let i = 0; i < w; i++) {
      const ph = ((i + 0.5) / w - 0.5) * 2 * Math.PI, x = Math.cos(ph) * Math.cos(el), y = Math.sin(el), z = Math.sin(ph) * Math.cos(el);
      THREE.SphericalHarmonics3.getBasisAt(new THREE.Vector3(x, y, z), basis);
      const o = (j * w + i) * 4, r = f(d[o]) * dw, g = f(d[o + 1]) * dw, b = f(d[o + 2]) * dw;
      for (let k = 0; k < 9; k++) sh[k].x += r * basis[k], sh[k].y += g * basis[k], sh[k].z += b * basis[k];
    }
  }
  [1, 1.5, 1.5, 1.5, 4, 4, 4, 4, 4].forEach((k, i) => sh[i].multiplyScalar(k));
  return sh;
}

function halfTable(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  return out;
}

export class GameSky {
  constructor(viewer, { getInfo }) {
    this.v = viewer;
    this.getInfo = getInfo;
    this.group = new THREE.Group();
    this.group.name = 'gamesky';
    this.ready = false;
    this.disposables = [];
    this.texEntries = [];
    this.geoEntry = null;
    this.fix = { xoFix: { value: null }, xoFixOn: { value: 0 } }; // (holdToProbe: the dome's and the clouds')
  }

  // env: /mapenv; probe: its light probe (fetchProbe; null on a map without). Resolves once the sky
  // and its lighting are ready (clouds follow).
  async load(env, probe, isCurrent = () => true) {
    const vals = env.values || {};
    this.env = env;
    this.probe = probe;
    this.sun = sunDirection(vals, env.rotation);
    if (vals.BackdropPath) return this.loadBackdrop(env, probe, isCurrent); // (Crossout 2.41: a picture of the sky)
    const guid = vals.AtmosphereId;
    if (!guid) throw new Error('this environment has no atmosphere');
    const [r, grade] = await Promise.all([fetch(`${DATA}/atmosphere?guid=${enc(guid)}`), this.loadGrade(vals)]);
    this.grade = grade;
    if (!r.ok) throw new Error((await r.text()) || 'atmosphere not found');
    const buf = await r.arrayBuffer();
    if (!isCurrent()) return false;
    const jl = new DataView(buf).getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
    const off = (8 + jl + 3) & ~3;
    const trans = new Float32Array(buf, off, 256 * 64 * 4);
    const scat = new Uint16Array(buf, off + 262144 + 16384, 256 * 128 * 32 * 4);
    const u = head.uniforms || {};
    this.atm = {
      bottom: num(u.bottom_radius, 6360000), top: num(u.top_radius, 6420000), g: num(u.mie_phase_function_g, 0.8), muSMin: num(u.mu_s_min, -0.2),
      sunRadius: num(u.sun_angular_radius, 0.00467), solar: vec3(u.solar_irradiance, [1.474, 1.8504, 1.91198]),
      rayleigh: vec3(u.rayleigh_scattering, [5.8e-6, 1.35e-5, 3.31e-5]), mie: vec3(u.mie_scattering, [4e-6, 4e-6, 4e-6]), trans,
    };
    const a = this.atm;
    const white = new THREE.Vector3(...a.solar).multiplyScalar(3 / (a.solar[0] + a.solar[1] + a.solar[2]));
    this.white = white;
    const tT = new THREE.DataTexture(halfTable(trans), 256, 64, THREE.RGBAFormat, THREE.HalfFloatType);
    const tS = new THREE.Data3DTexture(scat, 256, 128, 32);
    tS.format = THREE.RGBAFormat;
    tS.type = THREE.HalfFloatType;
    for (const t of [tT, tS]) {
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.disposables.push(t);
    }
    this.uniforms = {
      xoTransmittance: { value: tT }, xoScattering: { value: tS }, xoBottom: { value: a.bottom }, xoTop: { value: a.top }, xoMieG: { value: a.g },
      xoMuSMin: { value: a.muSMin }, xoSunRadius: { value: a.sunRadius }, xoSolar: { value: new THREE.Vector3(...a.solar) },
      xoRayleigh: { value: new THREE.Vector3(...a.rayleigh) }, xoMie: { value: new THREE.Vector3(...a.mie) }, xoWhite: { value: white },
      xoSun: { value: this.sun.clone() }, xoAltitude: { value: 2 }, xoScale: { value: SKY_SCALE }, xoSunDisc: { value: SKY_SCALE }, xoGround: { value: new THREE.Vector3() },
      xoTint: { value: new THREE.Vector3(1, 1, 1) }, xoBand: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(1, 1, 1)) },
      xoFogged: { value: probe ? 0 : 1 }, ...FOG_UNIFORMS(), // (a probe's sky has the game's fog in it already: xoBand, xoFix)
      ...this.fix,
    };
    // the dome around the camera
    const domeMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), domeMat);
    this.dome.name = 'atmosphere';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -3;
    this.group.add(this.dome);
    this.disposables.push(this.dome.geometry, domeMat);
    this.measure();
    this.applyLevels();
    this.makeEnvironment();
    this.lightFromSun();
    this.target = this.skyTarget();
    this.holdToProbe(); // (the dome alone; again once the clouds are in)
    // (its panoramas are in the light now: only its numbers are read from here on, and the views kept
    // the whole /mapprobe buffer, its local one's too, alive with the map)
    const slim = (q) => q && { ...q, specularData: null, diffuseData: null, skyData: null };
    this.probe = probe && { ...slim(probe), localProbe: slim(probe.localProbe) };
    this.ready = true;
    this.loadClouds(vals.SkyDomeModelPath, isCurrent).catch((e) => console.warn('clouds:', e.message));
    return true;
  }

  // Crossout 2.41's sky: the environment's picture of it above the horizon (/backdrop, Sky.cpp Backdrop:
  // the game's captures show it that way), its column BackdropUvShift towards the sun, BackdropLuminance /
  // 2048 light-probe units. Its clouds are in it, the sun's disc is drawn over it, and it is held to the
  // probe's capture as the atmosphere is (holdToProbe); no tables, no cloud cards.
  async loadBackdrop(env, probe, isCurrent) {
    const vals = env.values || {};
    const [r, grade] = await Promise.all([fetch(`${DATA}/backdrop?base=${enc(vals.BackdropPath)}`), this.loadGrade(vals)]);
    this.grade = grade;
    if (!r.ok) throw new Error((await r.text()) || 'sky picture not found');
    const buf = await r.arrayBuffer();
    if (!isCurrent()) return false;
    const jl = new DataView(buf).getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
    const W = head.width, H = head.height, data = new Uint16Array(buf, (8 + jl + 3) & ~3, W * H * 4);
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.disposables.push(tex);
    const scale = num(vals.BackdropLuminance, 1) / 2048, ground = String(vals.BackdropGround || '').trim().split(/\s+/).map(Number);
    // the picture round the horizon at the MEASURED heights (probe units): the haze's and the fog's
    // colour, the clouds' light, what the game meters without a probe
    const f = THREE.DataUtils.fromHalfFloat;
    this.bdRows = MEASURED.map((el) => {
      const y = Math.min(H - 1, Math.floor((el / (Math.PI / 2)) * H)), c = [0, 0, 0];
      for (let x = 0; x < W; x += 4) for (let k = 0; k < 3; k++) c[k] += (f(data[(y * W + x) * 4 + k]) * scale) / (W / 4);
      return c;
    });
    const r0 = THREE.MathUtils.degToRad(num(vals.SunDiscDiameter, 0.54) / 2);
    this.backdrop = { scale, ground: [0, 1, 2, 3].map((k) => (Number.isFinite(ground[k]) ? ground[k] : 0)), discCos: Math.cos(r0), discArea: Math.PI * r0 * r0, disc: vals.SunDiscVisible !== 'false' };
    this.uniforms = {
      xoBackdrop: { value: tex }, xoBdShift: { value: num(vals.BackdropUvShift, 0) - Math.atan2(this.sun.z, this.sun.x) / (2 * Math.PI) }, xoScale: { value: scale },
      xoDrift: { value: new THREE.Vector4() }, xoDriftMix: { value: 1 }, xoDriftC: { value: 0.05 },
      xoSun: { value: this.sun.clone() }, xoSunDisc: { value: 0 }, xoDiscCos: { value: this.backdrop.discCos }, xoDiscColor: { value: new THREE.Vector3(1, 1, 1) },
      xoGround: { value: new THREE.Vector3() }, xoGroundMix: { value: 0 }, xoAltitude: { value: 2 }, xoFogged: { value: probe ? 0 : 1 }, ...FOG_UNIFORMS(), ...this.fix,
    };
    // its drift (Map.cpp BackdropMotion: angle in the picture's own turn, degrees a second at the zenith,
    // horizon correction, blend time, range): each pass runs over the range at that speed and fades into
    // the next over the blend time; it starts where the picture lies undrifted
    const mo = String(vals.BackdropMotion || '').trim().split(/\s+/).map(Number);
    this.drift = null;
    if (mo.length >= 6 && mo.every(Number.isFinite) && mo[1] > 0 && mo[5] > mo[4]) {
      const [angle, speed, hc, blend, lo, hi] = mo, T = (hi - lo) / speed, B = clamp(blend, 0, T / 2), phi = THREE.MathUtils.degToRad(angle) - this.uniforms.xoBdShift.value * 2 * Math.PI;
      const t0 = T - B + -lo / speed;
      this.drift = { lo, speed, B, P: T - B, t: t0, t0 };
      this.uniforms.xoDrift.value.set(Math.cos(phi), Math.sin(phi), 0, 0);
      this.uniforms.xoDriftC.value = clamp(1 - hc, 0, 1);
      this.stepDrift(0);
    }
    const domeMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: BACKDROP_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), domeMat);
    this.dome.name = 'sky picture';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -3;
    this.group.add(this.dome);
    this.disposables.push(this.dome.geometry, domeMat);
    this.backdropLevels();
    this.makeEnvironment();
    this.lightFromSun();
    this.target = this.skyTarget();
    this.holdToProbe();
    this.target = null; // (no clouds to come)
    const slim = (q) => q && { ...q, specularData: null, diffuseData: null, skyData: null };
    this.probe = probe && { ...slim(probe), localProbe: slim(probe.localProbe) };
    this.ready = true;
    return true;
  }

  // The sky picture's drift moves on by dt seconds (mapview.js tick: on the frames drawn anyway, as the
  // wind's sway).
  stepDrift(dt) {
    const d = this.drift, u = this.uniforms;
    if (!d || !u?.xoDrift) return;
    d.t += dt;
    const k = Math.floor(d.t / d.P), tau = d.t - k * d.P, rad = Math.PI / 180;
    u.xoDrift.value.z = (d.lo + d.speed * tau) * rad;
    u.xoDrift.value.w = (d.lo + d.speed * (tau + d.P)) * rad;
    u.xoDriftMix.value = d.B > 0 ? Math.min(1, tau / d.B) : 1;
  }

  // The light levels on the picture (presetLevels, as applyLevels does for the atmosphere): its scale at
  // the exposure, the sun's disc (presetLevels disc of the sun's light over the disc, in its colour), the
  // colours of the haze and the clouds' light from it.
  backdropLevels() {
    const vals = this.env.values || {}, p = this.probe, u = this.uniforms, b = this.backdrop, rows = this.bdRows;
    const up = 0.25 * lumOf(rows[1]) + 0.375 * (lumOf(rows[2]) + lumOf(rows[3]));
    const mean = p ? p.mean : 0.5 * (0.35 * lumOf(rows[0]) + 0.35 * lumOf(rows[1]) + 0.15 * (lumOf(rows[2]) + lumOf(rows[3])))
      + 0.5 * 0.2 * ((sunIlluminance(vals).eSun / PROBE_UNIT) * Math.max(this.sun.y, 0) / Math.PI + up);
    const L = (this.levels = presetLevels(vals, mean));
    u.xoScale.value = L.exposure * b.scale;
    const s = argb(vals.SunColor || '0xFFFFFFFF'), col = new THREE.Color().setRGB(s.r, s.g, s.b, THREE.SRGBColorSpace), cl = Math.max(lumOf(col.toArray()), 1e-6);
    u.xoDiscColor.value.set(col.r / cl, col.g / cl, col.b / cl);
    u.xoSunDisc.value = b.disc ? (L.sun * L.disc) / b.discArea : 0;
    u.xoGround.value.set(b.ground[1], b.ground[2], b.ground[3]).multiplyScalar(L.exposure / PROBE_UNIT);
    u.xoGroundMix.value = clamp(b.ground[0], 0, 1);
    const shown = (c) => new THREE.Color(...c.map((v) => v * L.exposure));
    this.horizon = shown(rows[0]);
    this.low = shown(rows[1]);
    this.high = shown(rows[2].map((v, k) => (v + rows[3][k]) / 2));
  }

  // The game's camera after the exposure (post.js xoGrade): its white balance, toe and colour LUT
  // (ColorRemapPath: 256 x 16 RGBA8, stored B G R A; without one, the identity).
  async loadGrade(vals) {
    const lut = new Uint8Array(256 * 16 * 4);
    for (let i = 0; i < 256 * 16; i++) lut.set([(i % 16) * 17, ((i / 256) | 0) * 17, (((i % 256) / 16) | 0) * 17, 255], i * 4);
    const path = String(vals.ColorRemapPath || '').replace(/\.dds$/i, '');
    const r = path ? await fetch(`${DATA}/rgba?base=${enc(path)}`) : null;
    const b = r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    if (b?.length === 12 + lut.length) for (let i = 12; i < b.length; i += 4) lut.set([b[i + 2], b[i + 1], b[i], 255], i - 12);
    else if (path) console.warn(`colour LUT ${path}: ${r ? r.status : ''} not used`);
    const tex = new THREE.DataTexture(lut, 256, 16, THREE.RGBAFormat);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.disposables.push(tex);
    return { white: whiteBalance(num(vals.WhiteTemperature, 6500), vals.WhiteTint), toe: num(vals.TonemapToe, 0) * TOE_K, lut: tex };
  }

  // the transmittance table on the CPU (bilinear), for the sun's colour
  transmittance(r, mu) {
    const a = this.atm, H = Math.sqrt(a.top * a.top - a.bottom * a.bottom), rho = Math.sqrt(Math.max(r * r - a.bottom * a.bottom, 0));
    const d = Math.max(0, -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + a.top * a.top, 0)));
    const dMin = a.top - r, dMax = rho + H;
    const tc = (x, n) => 0.5 / n + x * (1 - 1 / n);
    const u = tc((d - dMin) / (dMax - dMin), 256) * 256 - 0.5, v = tc(rho / H, 64) * 64 - 0.5;
    const x0 = THREE.MathUtils.clamp(Math.floor(u), 0, 255), y0 = THREE.MathUtils.clamp(Math.floor(v), 0, 63);
    const x1 = Math.min(255, x0 + 1), y1 = Math.min(63, y0 + 1), fx = THREE.MathUtils.clamp(u - x0, 0, 1), fy = THREE.MathUtils.clamp(v - y0, 0, 1);
    const T = a.trans, at = (x, y, c) => T[(y * 256 + x) * 4 + c];
    return [0, 1, 2].map((c) => (at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx) * (1 - fy) + (at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx) * fy);
  }

  // The sky at the horizon (the haze's colour, what lies below the horizon) and higher up (the
  // clouds' ambient light), read back from a tiny render of the same sky: around the horizon on
  // average, and the median of each row (MEASURED heights) to hold it to the light probe's sky.
  measure() {
    const R = this.v.renderer, W = 32, Hh = 4;
    const rt = new THREE.WebGLRenderTarget(W, Hh, { type: THREE.FloatType, depthBuffer: false });
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, xoScale: { value: SKY_SCALE }, xoSize: { value: new THREE.Vector2(W, Hh) }, xoElev: { value: MEASURED } }, // (unscaled: applyLevels scales)
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: PROBE_FRAG, depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const px = new Float32Array(W * Hh * 4);
    const prev = R.getRenderTarget();
    try {
      R.setRenderTarget(rt);
      R.render(scene, cam);
      R.readRenderTargetPixels(rt, 0, 0, W, Hh, px);
    } finally {
      R.setRenderTarget(prev);
      rt.dispose();
      mat.dispose();
      quad.geometry.dispose();
    }
    const row = (y) => {
      const c = [0, 0, 0];
      for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) c[k] += px[(y * W + x) * 4 + k] / W;
      return new THREE.Color(c[0], c[1], c[2]);
    };
    this.raw = { horizon: row(0), low: row(1), high: row(2).lerp(row(3), 0.5) };
    this.medians = [0, 1, 2, 3].map((y) => [0, 1, 2].map((k) => median(Array.from({ length: W }, (_, x) => px[(y * W + x) * 4 + k]))));
    const h = this.raw.horizon;
    this.uniforms.xoGround.value.set(h.r, h.g, h.b).multiplyScalar(0.6 / SKY_SCALE).multiply(this.white);
  }

  // The preset's light levels (presetLevels) on the sky: the atmosphere in the game's units
  // (LIGHT_K) at the exposure, held row by row to the light probe's sky (skyGains: the dome is the air
  // alone, the game's sky has its clouds and haze, and at night the air's tables are all but black),
  // the sun's disc; and the sky's colours as the view shows them (the haze, the clouds' light).
  applyLevels() {
    const vals = this.env.values || {}, p = this.probe, u = this.uniforms, w = this.white;
    const unit = new THREE.Vector3(LIGHT_K[0] * w.x, LIGHT_K[1] * w.y, LIGHT_K[2] * w.z).multiplyScalar(1 / PROBE_UNIT); // (radiance / white -> probe units)
    const pu = (c) => [c[0] * unit.x, c[1] * unit.y, c[2] * unit.z].map((v) => v / SKY_SCALE); // (measure()'s rows -> probe units)
    const gains = this.skyGains(pu);
    // what the game meters: its probe, or the sky over half the view and ground of albedo 0.2 under it and the sun
    const sky = (c, g) => lumOf(pu([c.r, c.g, c.b]).map((v, i) => v * [g.x, g.y, g.z][i]));
    const up = 0.25 * sky(this.raw.low, gains[1]) + 0.75 * sky(this.raw.high, gains[2]);
    const mean = p ? p.mean : 0.5 * (0.35 * sky(this.raw.horizon, gains[0]) + 0.35 * sky(this.raw.low, gains[1]) + 0.3 * sky(this.raw.high, gains[2]))
      + 0.5 * 0.2 * ((sunIlluminance(vals).eSun / PROBE_UNIT) * Math.max(this.sun.y, 0) / Math.PI + up);
    const L = (this.levels = presetLevels(vals, mean));
    u.xoScale.value = L.exposure;
    u.xoSunDisc.value = L.exposure * L.disc;
    u.xoTint.value.copy(unit);
    u.xoBand.value.forEach((v, k) => v.copy(gains[k]));
    const shown = (c, g) => new THREE.Color(...pu([c.r, c.g, c.b]).map((v, i) => v * [g.x, g.y, g.z][i] * L.exposure));
    this.horizon = shown(this.raw.horizon, gains[0]);
    this.low = shown(this.raw.low, gains[1]);
    this.high = shown(this.raw.high, gains[2].clone().add(gains[3]).multiplyScalar(0.5));
  }

  // The probe's sky against the dome's, row by row (pu: measure()'s rows -> probe units; a gain of 1
  // where the probe has no sky). The sky alone (FogLightingProbe) gives each row's colour and how it
  // brightens towards the horizon; the capture gives its brightness, as the game shows it (the fog's
  // sky is up to a stop brighter than the capture's under clouds, at sunset), where it sees the sky:
  // from about 30 degrees up (lower down the land stands in it), texels within 4x of the fog's (no
  // roofs or lamps); the rows below, and a row without enough of them, take the row above's.
  skyGains(pu) {
    const p = this.probe, gains = MEASURED.map(() => new THREE.Vector3(1, 1, 1));
    let ratio = 1;
    for (let k = MEASURED.length - 1; k >= 0 && p; k--) {
      const row = Array.from({ length: 128 }, (_, x) => [panoTexel(p.skyData, p.sky, MEASURED[k], x, 128), panoTexel(p.specularData, p.specular, MEASURED[k], x, 128)]);
      const sky = [0, 1, 2].map((c) => median(row.map(([f]) => f[c])));
      if (!(lumOf(sky) > 0)) continue;
      const seen = row.map(([f, s]) => lumOf(s) / Math.max(lumOf(f), 1e-9)).filter((r) => r > 0.25 && r < 4);
      if (MEASURED[k] > 0.5 && seen.length >= 16) ratio = median(seen);
      const dome = pu(this.medians[k]);
      gains[k].set(...[0, 1, 2].map((c) => clamp((sky[c] * ratio) / Math.max(dome[c], 1e-9), 1 / 64, 64)));
    }
    return gains;
  }

  // The sky as the game shows it around its probe, on the FIX_W x FIX_H panorama (rows from the nadir
  // up, probe units; null without a probe): the sky alone (FogLightingProbe, clouds and all) through the
  // preset's fog (fog.js, as fitted on these captures), held to the capture's sky around each texel;
  // within 3 degrees of the sun the capture itself (the sky alone has the sun's disc in it, the capture
  // only its glow).
  skyTarget() {
    const p = this.probe, f = this.fog, e = this.levels.exposure;
    if (!p?.specularData || !p.skyData || !f) return null;
    const H = THREE.DataUtils.fromHalfFloat, [cw, ch] = p.specular, [sw, sh] = p.sky, N = FIX_W * FIX_H;
    const cap = new Float32Array(N * 3), sky = new Float32Array(N * 3), fog = new Float32Array(N * 3), near = new Uint8Array(N);
    const line = (s, sin) => fogLineUp(f, p.center[1], sin, s); // (fog.js xoFogLineUp)
    const sun = this.sun, fc = [f.color.r, f.color.g, f.color.b], gc = [f.glow.r, f.glow.g, f.glow.b];
    const span = (a, n, w) => [Math.floor((a * w) / n), Math.floor(((a + 1) * w) / n)];
    const ratios = [];
    for (let j = 0; j < FIX_H; j++) {
      const e0 = ((j + 0.5) / FIX_H - 0.5) * Math.PI, sin = Math.sin(e0), [y0, y1] = span(j, FIX_H, ch);
      for (let i = 0; i < FIX_W; i++) {
        const t = j * FIX_W + i, o = t * 3, [x0, x1] = span(i, FIX_W, cw);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let k = 0; k < 3; k++) cap[o + k] += H(p.specularData[(y * cw + x) * 4 + k]) / ((y1 - y0) * (x1 - x0));
        if (sin <= 0.01) continue;
        // the sky alone through the fog: what gets through, and the fog's own colour and glow (probe units)
        const fy = ((j + 0.5) / FIX_H) * sh - 0.5, fx = ((i + 0.5) / FIX_W) * sw - 0.5, ya = clamp(Math.floor(fy), 0, sh - 1), yb = Math.min(sh - 1, ya + 1);
        const xa = (Math.floor(fx) + sw) % sw, xb = (xa + 1) % sw, wy = clamp(fy - ya, 0, 1), wx = fx - Math.floor(fx);
        const at = (y, x, k) => H(p.skyData[(y * sw + x) * 4 + k]);
        const T = 2 ** -line(f.start, sin), Ts = 2 ** -line(f.sunStart, sin);
        const ph = ((i + 0.5) / FIX_W - 0.5) * 2 * Math.PI;
        const cs = Math.cos(ph) * Math.cos(e0) * sun.x + sin * sun.y + Math.sin(ph) * Math.cos(e0) * sun.z, glow = Math.max(0, cs) ** f.sunPower * (1 - Ts);
        near[t] = cs > NEAR_SUN ? 1 : 0;
        for (let k = 0; k < 3; k++) {
          sky[o + k] = ((at(ya, xa, k) * (1 - wx) + at(ya, xb, k) * wx) * (1 - wy) + (at(yb, xa, k) * (1 - wx) + at(yb, xb, k) * wx) * wy) * T;
          fog[o + k] = (fc[k] * (1 - T) + gc[k] * glow) / e;
        }
        // (high up, where little land stands: how bright the capture's sky is against the sky alone)
        const sl = lumOf([sky[o], sky[o + 1], sky[o + 2]]);
        if (e0 > 0.5 && sl > 1e-9) {
          const r = (lumOf([cap[o], cap[o + 1], cap[o + 2]]) - lumOf([fog[o], fog[o + 1], fog[o + 2]])) / sl;
          if (r > 0.25 && r < 4) ratios.push(r);
        }
      }
    }
    const ratio = ratios.length >= 16 ? median(ratios) : 1;
    // The model, held row by row (each channel) to the capture where the two are about as bright (from 5
    // degrees up: lower down the land fills the rows; the rows below take the 5 degrees row's).
    const mdl = new Float32Array(N * 3), h0 = FIX_H / 2, lum3 = (a, o) => lumOf([a[o], a[o + 1], a[o + 2]]);
    for (let t = 0; t < N * 3; t++) mdl[t] = sky[t] * ratio + fog[t];
    let rr = [1, 1, 1];
    for (let j = FIX_H - 1; j >= h0; j--) {
      const rows = [[], [], []], e0 = ((j + 0.5) / FIX_H - 0.5) * Math.PI;
      for (let i = 0; i < FIX_W; i++) {
        const t = j * FIX_W + i, o = t * 3, q = lum3(cap, o) / Math.max(lum3(mdl, o), 1e-9);
        if (!near[t] && q > 0.7 && q < 1.4) for (let k = 0; k < 3; k++) rows[k].push(cap[o + k] / Math.max(mdl[o + k], 1e-9));
      }
      if (rows[0].length >= 6 && e0 >= LOW_ROW) rr = rows.map(median);
      for (let i = 0; i < FIX_W; i++) for (let k = 0; k < 3; k++) mdl[(j * FIX_W + i) * 3 + k] *= rr[k];
    }
    // The capture's sky: about as bright as that and of its colour (each channel's share within
    // 0.8 .. 1.25), above the land, which rises from the horizon up to the first 3 texels in a column
    // that are (a red rock against a red sunset can pass, the shadowed foot below it does not).
    const pass = new Uint8Array(N);
    for (let j = h0; j < FIX_H; j++) for (let i = 0; i < FIX_W; i++) {
      const t = j * FIX_W + i, o = t * 3, lc = lum3(cap, o), lm = Math.max(lum3(mdl, o), 1e-9), q = lc / lm;
      let ok = !near[t] && q > 0.7 && q < 1.4;
      for (let k = 0; k < 3 && ok; k++) { const c = cap[o + k] / Math.max(lc, 1e-9) / Math.max(mdl[o + k] / lm, 1e-9); ok = c > 0.8 && c < 1.25; }
      pass[t] = ok ? 1 : 0;
    }
    const top = Math.floor(FIX_H * (0.5 + 45 / 180));
    for (let i = 0; i < FIX_W; i++) {
      let j = h0, run = 0;
      for (; j < top && run < 3; j++) run = pass[j * FIX_W + i] ? run + 1 : 0;
      for (let k = h0; k < j - run; k++) pass[k * FIX_W + i] = 0;
    }
    // The target: the model (its clouds are the game's, its fog the preset's) x the capture against it,
    // smoothed over the sky the capture shows (normalised convolution, 4 degrees; 17 where the land
    // leaves little sky near by). The capture's land never enters it, and the sky behind the land is the
    // sky around it.
    const wgt = new Float32Array(N), rq = new Float32Array(N * 3);
    for (let t = 0; t < N; t++) if (pass[t]) { wgt[t] = 1; for (let k = 0; k < 3; k++) rq[t * 3 + k] = clamp(cap[t * 3 + k] / Math.max(mdl[t * 3 + k], 1e-9), 1 / 16, 16); }
    const gauss = (src, n, sigma) => {
      const r = Math.ceil(sigma * 3), w = Array.from({ length: 2 * r + 1 }, (_, d) => Math.exp(-((d - r) ** 2) / (2 * sigma * sigma)));
      const tmp = new Float32Array(src.length), dst = new Float32Array(src.length);
      for (let j = 0; j < FIX_H; j++) for (let i = 0; i < FIX_W; i++) for (let c = 0; c < n; c++) {
        let a = 0;
        for (let d = -r; d <= r; d++) a += w[d + r] * src[(j * FIX_W + ((i + d + FIX_W) % FIX_W)) * n + c];
        tmp[(j * FIX_W + i) * n + c] = a;
      }
      for (let j = 0; j < FIX_H; j++) for (let i = 0; i < FIX_W; i++) for (let c = 0; c < n; c++) {
        let a = 0;
        for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < FIX_H) a += w[d + r] * tmp[(jj * FIX_W + i) * n + c]; }
        dst[(j * FIX_W + i) * n + c] = a;
      }
      return dst;
    };
    for (let t = 0; t < N; t++) for (let k = 0; k < 3; k++) rq[t * 3 + k] *= wgt[t];
    const w3 = gauss(wgt, 1, 3), r3 = gauss(rq, 3, 3), w12 = gauss(wgt, 1, 12), r12 = gauss(rq, 3, 12);
    const out = new Float32Array(N * 3);
    for (let t = h0 * FIX_W; t < N; t++) {
      const a = clamp(w3[t] / 0.3, 0, 1);
      for (let k = 0; k < 3; k++) {
        const wide = w12[t] > 1e-3 ? r12[t * 3 + k] / w12[t] : 1, local = w3[t] > 1e-6 ? r3[t * 3 + k] / w3[t] : wide;
        out[t * 3 + k] = near[t] ? cap[t * 3 + k] : mdl[t * 3 + k] * (a * local + (1 - a) * wide);
      }
    }
    return out;
  }

  // Holds the sky as drawn (the dome and the clouds) to skyTarget: the sky is drawn without the
  // correction and the sun's disc from the probe's centre into a cube, read back on the same panorama,
  // and the correction (target / drawn, each blurred over 3 x 3 texels, 1/16 .. 16; below the horizon
  // the horizon row's median) goes to the dome and the clouds (xoFix). The game's clouds stand where
  // the cards stand, so the cards keep their shapes and take the game's brightness and colour around
  // them.
  holdToProbe() {
    const t = this.target;
    if (!t || !this.dome) return;
    const R = this.v.renderer, y = this.probe.center[1], S = 1000;
    const cube = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(1, S * 2, cube);
    cam.position.set(0, y, 0);
    const rt = new THREE.WebGLRenderTarget(FIX_W, FIX_H, { type: THREE.FloatType, depthBuffer: false });
    const mat = new THREE.ShaderMaterial({
      uniforms: { tCube: { value: cube.texture } }, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform samplerCube tCube; varying vec2 vUv;
        void main() { float ph = (vUv.x - 0.5) * 6.2831853, el = (vUv.y - 0.5) * 3.1415927;
          gl_FragColor = vec4(textureCube(tCube, vec3(cos(ph) * cos(el), sin(el), sin(ph) * cos(el))).rgb, 1.0); }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const px = new Float32Array(FIX_W * FIX_H * 4);
    const u = this.uniforms, c = this.clouds;
    const saved = { dome: [this.dome.position.clone(), this.dome.scale.clone()], clouds: c && [c.position.clone(), c.scale.clone()], alt: u.xoAltitude.value, disc: u.xoSunDisc.value, on: this.fix.xoFixOn.value,
      drift: u.xoDrift && [u.xoDrift.value.clone(), u.xoDriftMix.value] };
    const stars = c ? c.children.filter((m) => m.material.uniforms.xoStars.value > 0 && m.material.visible) : [];
    const prev = R.getRenderTarget(), clear = R.getClearColor(new THREE.Color()), clearAlpha = R.getClearAlpha(), auto = R.autoClear;
    try {
      this.dome.position.set(0, y, 0);
      this.dome.scale.setScalar(S);
      if (c) { c.position.set(0, y, 0); c.scale.setScalar((S * 0.85) / 0.9 / this.cloudRadius); }
      u.xoAltitude.value = Math.max(2, y);
      u.xoSunDisc.value = 0;
      this.fix.xoFixOn.value = 0;
      if (saved.drift) { u.xoDrift.value.z = u.xoDrift.value.w = 0; u.xoDriftMix.value = 1; } // (held to the probe as the picture lies)
      for (const m of stars) m.material.visible = false;
      R.setClearColor(0x000000, 1);
      R.autoClear = true;
      this.group.updateMatrixWorld(true);
      cam.update(R, this.group);
      const scene = new THREE.Scene();
      scene.add(quad);
      R.setRenderTarget(rt);
      R.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      R.readRenderTargetPixels(rt, 0, 0, FIX_W, FIX_H, px);
    } finally {
      this.dome.position.copy(saved.dome[0]);
      this.dome.scale.copy(saved.dome[1]);
      if (c) { c.position.copy(saved.clouds[0]); c.scale.copy(saved.clouds[1]); }
      u.xoAltitude.value = saved.alt;
      u.xoSunDisc.value = saved.disc;
      this.fix.xoFixOn.value = saved.on;
      if (saved.drift) { u.xoDrift.value.copy(saved.drift[0]); u.xoDriftMix.value = saved.drift[1]; }
      for (const m of stars) m.material.visible = true;
      R.setRenderTarget(prev);
      R.setClearColor(clear, clearAlpha);
      R.autoClear = auto;
      cube.dispose();
      rt.dispose();
      mat.dispose();
      quad.geometry.dispose();
    }
    // target / drawn, both blurred (3 x 3, around in azimuth); the rows below the horizon take the
    // median of the horizon row's (no streaks where the dome shows past the land's edge)
    const e = this.levels.exposure, blur = (get) => {
      const out = new Float32Array(FIX_W * FIX_H * 3);
      for (let j = 0; j < FIX_H; j++) for (let i = 0; i < FIX_W; i++) for (let k = 0; k < 3; k++) {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= FIX_H) continue;
          for (let di = -1; di <= 1; di++) { s += get(jj * FIX_W + ((i + di + FIX_W) % FIX_W), k); n++; }
        }
        out[(j * FIX_W + i) * 3 + k] = s / n;
      }
      return out;
    };
    const bt = blur((q, k) => t[q * 3 + k] * e), bd = blur((q, k) => px[q * 4 + k]);
    const half = new Uint16Array(FIX_W * FIX_H * 4), h0 = FIX_H / 2, fixAt = (q, k) => clamp(bt[q * 3 + k] / Math.max(bd[q * 3 + k], 1e-6), 1 / 16, 16);
    const below = [0, 1, 2].map((k) => median(Array.from({ length: FIX_W }, (_, i) => fixAt(h0 * FIX_W + i, k))));
    for (let j = 0; j < FIX_H; j++) for (let i = 0; i < FIX_W; i++) {
      const o = (j * FIX_W + i) * 4;
      for (let k = 0; k < 3; k++) half[o + k] = THREE.DataUtils.toHalfFloat(j < h0 ? below[k] : fixAt(j * FIX_W + i, k));
      half[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    const tex = new THREE.DataTexture(half, FIX_W, FIX_H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.fix.xoFix.value?.dispose();
    this.disposables.push(tex);
    this.fix.xoFix.value = tex;
    this.fix.xoFixOn.value = 1;
    this.v.dirty = true;
  }

  // The light from all around: the game's light probe, prefiltered for each roughness (in probe
  // units: envIntensity is the exposure), and its diffuse irradiance (spherical harmonics, used for
  // the diffuse light in place of the prefiltered map's roughest level, which is narrower than a
  // cosine); a hangar's local probe the same (local). Without a probe the same sky lights the map
  // (no sun disc in it: the sun is the key light).
  makeEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.v.renderer);
    const scene = new THREE.Scene(), p = this.probe;
    const mat = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, xoSunDisc: { value: 0 }, xoAltitude: { value: 30 }, xoFogged: { value: 0 }, xoFixOn: { value: 0 }, xoDrift: { value: new THREE.Vector4() }, xoDriftMix: { value: 1 } }, vertexShader: DOME_VERT, fragmentShader: this.backdrop ? BACKDROP_FRAG : DOME_FRAG, side: THREE.BackSide, depthWrite: false }); // (no disc: the sun is the key light; no fog; the picture undrifted)
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat);
    const prefilter = (q) => {
      const tex = new THREE.DataTexture(q.specularData, q.specular[0], q.specular[1], THREE.RGBAFormat, THREE.HalfFloatType);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const target = pmrem.fromEquirectangular(tex);
      tex.dispose();
      this.disposables.push(target);
      return target.texture;
    };
    try {
      if (p) {
        this.envMap = prefilter(p);
      } else {
        scene.add(mesh);
        const target = pmrem.fromScene(scene, 0, 0.1, 100);
        this.disposables.push(target);
        this.envMap = target.texture;
      }
      // a hangar's hall: its own probe inside its box (viewer.js LOCAL_PROBE; turned by its yaw, which
      // mirrors with z into glTF)
      const q = p?.localProbe;
      if (q) {
        const yaw = THREE.MathUtils.degToRad(q.rotation[0]);
        this.local = { envMap: prefilter(q), irradiance: irradianceSH(q), box: [...q.center, Math.cos(yaw), ...q.halfMin, Math.sin(yaw), ...q.halfMax, 0] };
      }
    } finally {
      pmrem.dispose();
      mat.dispose();
      mesh.geometry.dispose();
    }
    this.envIntensity = p ? this.levels.exposure : 1;
    this.irradiance = p ? irradianceSH(p) : null;
  }

  // The sun's light: the preset's luminance x SUN_K (presetLevels key) at the exposure, in the preset's SunColor as
  // it is (the camera's white balance comes after, in post.js), or with UseAtmosphereSunColor in the
  // colour the air lets through (AtmosphereSunIllum's, else the atmosphere's sun at its height).
  lightFromSun() {
    const vals = this.env.values || {}, a = this.atm, L = this.levels;
    let c = vec3(vals.AtmosphereSunIllum, null);
    if (vals.UseAtmosphereSunColor !== 'true') {
      const s = argb(vals.SunColor || '0xFFFFFFFF');
      const col = new THREE.Color().setRGB(s.r, s.g, s.b, THREE.SRGBColorSpace);
      c = [col.r, col.g, col.b];
    } else if (!c) {
      const T = this.transmittance(a.bottom + 30, Math.max(this.sun.y, -0.2));
      c = [0, 1, 2].map((k) => LIGHT_K[k] * a.solar[k] * T[k]);
    }
    const cm = Math.max(c[0], c[1], c[2], 1e-6);
    this.sunColor = new THREE.Color(c[0] / cm, c[1] / cm, c[2] / cm);
    // the key light: the sunlight on the ground (L.key; below the horizon: a little, as before)
    this.sunIntensity = (L.key / Math.max(lumOf(this.sunColor.toArray()), 0.05)) * (this.sun.y > -0.02 ? 1 : 0.15);
    // the light lit particles take (smoke, dust: fxview.js setMapLight), as a face turned to it gets
    // it: the sun's / pi and the sky's (the probe's EnvColor: its irradiance / pi from above); and
    // how bright the weather's unlit ones may be (level: 1 on the bridge's clear day, low at night)
    const fs = this.sunColor.clone().multiplyScalar(this.sunIntensity / Math.PI);
    const fk = this.probe ? new THREE.Color(...this.probe.envColor).multiplyScalar(L.exposure) : this.high.clone();
    this.fxLight = { sun: fs, sky: fk };
    const lum = (col) => 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
    this.level = clamp((0.5 * lum(fs) + lum(fk)) / TUNED_LEVEL, 0.05, 1.5); // (the sun's half and the sky's)
    // the fog (fog.js), in the view's units (probe units at the exposure: the game's / PROBE_UNIT x
    // exposure), its glow in the sun's light (eSun, the game's units), the air's haze from this
    // atmosphere's tables (seen from the probe's height)
    const sunLight = this.sunColor.toArray().map((c) => (c * L.eSun) / Math.max(lumOf(this.sunColor.toArray()), 1e-6));
    const air = { atm: a, scat: this.uniforms?.xoScattering?.value?.image?.data, lightK: LIGHT_K, altitude: this.probe ? this.probe.center[1] : 30,
      sunK: Math.min(1, L.eAtm ? L.eSun / L.eAtm : 1), // (the air's light follows the preset's sun: fog.js presetFog)
      sky: [0, 1, 2].map((k) => (this.horizon.toArray()[k] + this.low.toArray()[k]) / 2) }; // (Crossout 2.41's fog takes the sky's colour near the horizon)
    this.fog = presetFog(vals, this.sun, sunLight, L.exposure / PROBE_UNIT, air);
  }

  // The preset's sky dome model: cloud cards (and stars), drawn around the camera at its own angles.
  async loadClouds(path, isCurrent) {
    if (!path) return;
    const info = await this.getInfo(path, '');
    if (!isCurrent()) return;
    const entry = this.v.acquireGeometry(info.path, 0);
    this.geoEntry = entry;
    const parts = await entry.promise;
    if (!isCurrent()) return;
    let radius = 1;
    for (const p of parts) { p.geometry.computeBoundingSphere(); radius = Math.max(radius, p.geometry.boundingSphere.radius + p.geometry.boundingSphere.center.length()); }
    this.cloudRadius = radius;
    const clouds = new THREE.Group();
    clouds.name = 'clouds';
    const tex = (t, role) => {
      if (!t || !t.exists) return null;
      const e = this.v.acquireTexture(t.base, role, 1024);
      this.texEntries.push(e);
      return e.promise.then((x) => x.tex);
    };
    const sunLight = new THREE.Color(this.sunColor).multiplyScalar(this.sunIntensity * CLOUD_SUN);
    // stars: below the horizon, or where the air's own sun is gone (AtmosphereSunIllum under 5: the
    // game's skies alone show them on night_moon, not on new_year_dark's dark blue evening, which a dark
    // sky alone had lit them on)
    const eAtm = this.levels.eAtm, night = eAtm == null ? 0 : 1 - THREE.MathUtils.smoothstep(eAtm, 0.5, 5);
    const starLight = Math.max(THREE.MathUtils.clamp((0.05 - this.sun.y) / 0.15, 0, 1), night) * 2;
    const jobs = [];
    for (const p of parts) {
      const mi = info.materials[p.material] || {};
      const find = (param) => (mi.textures || []).find((t) => t.param === param && t.exists);
      const cover = find('DiffuseSampler') || (mi.textures || []).find((t) => t.role === 'albedo' && t.exists);
      if (!cover) continue; // (the dome itself: the atmosphere draws it)
      const stars = !find('DiffuseSampler') && /star/i.test(cover.base);
      const tangents = !!p.geometry.getAttribute('tangent');
      const u = {
        xoCover: { value: null }, xoNormal: { value: null }, xoScatter: { value: null }, xoHasNormal: { value: 0 }, xoHasScatter: { value: 0 },
        xoOpacity: { value: 1 }, xoStars: { value: 0 }, xoSun: { value: this.sun.clone() }, xoSunLight: { value: new THREE.Vector3(sunLight.r, sunLight.g, sunLight.b) },
        xoSkyLight: { value: new THREE.Vector3(this.high.r, this.high.g, this.high.b).multiplyScalar(0.9) }, ...FOG_UNIFORMS(), ...this.fix,
      };
      if (stars) u.xoStars.value = starLight;
      // part of the background: drawn right after the sky and before everything else, without depth
      // (the cards are scaled into the view distance with the dome, so some would land in front of
      // far scenery); blended as they go
      const mat = new THREE.ShaderMaterial({
        uniforms: u, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: false, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide,
        blending: stars ? THREE.AdditiveBlending : THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      });
      mat.visible = false; // (until its coverage map is in)
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(p.geometry, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -2;
      clouds.add(mesh);
      jobs.push(Promise.all([tex(cover, 'decal'), tex(find('NormalSampler'), 'gloss'), tex(find('DetailSampler'), 'gloss')]).then(([c, n, s]) => {
        u.xoCover.value = c;
        u.xoNormal.value = n;
        u.xoHasNormal.value = n && tangents ? 1 : 0;
        u.xoScatter.value = s;
        u.xoHasScatter.value = s ? 1 : 0;
        mat.visible = !!c && (!stars || u.xoStars.value > 0);
        this.v.dirty = true;
      }));
    }
    if (!isCurrent()) return;
    this.clouds = clouds;
    this.group.add(clouds);
    await Promise.allSettled(jobs);
    if (isCurrent() && this.ready) this.holdToProbe(); // (now with the clouds as drawn)
    this.target = null;
  }

  // Keeps the sky around the camera (inside the far plane), and its height for the air's thickness.
  follow(camera) {
    if (!this.ready) return;
    const far = camera.far;
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(far * 0.9);
    this.uniforms.xoAltitude.value = Math.max(2, camera.position.y);
    if (this.clouds) {
      this.clouds.position.copy(camera.position);
      this.clouds.scale.setScalar((far * 0.85) / this.cloudRadius);
    }
  }

  dispose() {
    this.ready = false;
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) d.dispose?.();
    for (const e of this.texEntries) this.v.tex.release(e);
    if (this.geoEntry) this.v.geo.release(this.geoEntry);
    this.disposables = [];
    this.texEntries = [];
    this.geoEntry = null;
  }
}
