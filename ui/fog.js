// Maps' fog, as the game draws it: Unreal Engine 4's exponential height fog, whose settings the game's
// environments (assets/envsettings.mxml) carry one to one, and the air itself between the camera and
// what it sees:
//  - FogDensity x FogExpMul: how thick it is at FogHeight (per metre, in UE4's base-2 terms), halving
//    every 1 / FogExpMul metres up and thickening below (FogHeight is an altitude; on smoggy and sandy
//    days it lies under the ground)
//  - FogNear: no fog nearer than that many metres
//  - its colour: FogColor at FogLuminanceEv100 (the colour's alpha plays no part)
//  - FogSunPower / FogSunNear: sunlight glowing in it towards the sun, from FogSunNear metres out
//  - FogAerialGain: the air's own haze (the atmosphere's scattering, as the sky is drawn from it) as if
//    everything stood that many times further away; 0 (the overcast and rainy presets): none
// Everything drawn takes it on its way to the camera, the sky too (to no end: only the thinning with
// height stops it, so the horizon is all fog and straight up has little); the air's haze only the land
// (the sky is the air already).
// Measured on the game's own pictures of its maps (levels/maps/<map>/light_probes): the fogged sky
// against the same sky without fog (15 environments on 6 maps) gave the colour, the glow's exponent and
// the density's ratio to the falloff; the land in them (the app's distance and its land without fog at
// each probe's centre, 12 environments: clear, dust, rain, overcast, sandstorm, smog, sunset, morning,
// New Year's night, hangar day; about 300 bands of distance and height) gave the rest: the fog on the
// land is thinner and starts further out than FogDensity x FogExpMul and FogNear say (FOG_DENSITY_K,
// FOG_START_ADD), and the clear days' blue haze on far hills is the air's (AIR_K).
//
// Crossout 2.41 has a fog of its own per environment (the scene's ExponentialHeightFog, written into
// the preset as HeightFog0 / HeightFog1 by Map.cpp): two such layers, each "density per metre (base 2)
// at its height, falloff per metre (base 2), height", but none thicker than at its height (with a
// falloff below 0: thicker above it, so a sky through it is fog to no end: the Halloween nights); its
// colour is the sky's x HeightFogInscatter (the game's probeInscatteringIntesityScale: the probes'
// captures against their sky alone gave it back), from HeightFogStart metres out, the sun's glow in it x
// HeightFogSunScatter. Its line integrals are exact (the 2.40 fit's are UE4's).
import * as THREE from 'three';

export const FOG_COLOR_K = 0.68;    // the fog's colour against FogColor x 2^FogLuminanceEv100 / 8
export const FOG_GLOW_K = 0.033;    // the sun's glow against the sun's light (both in the game's units)
export const FOG_GLOW_POWER = 0.55; // the glow's exponent against FogSunPower (the game's glow is wider)
// The density against FogDensity x FogExpMul, and the metres the fog starts beyond FogNear: the land
// showed the fog's effect growing from about 100 m out (the rainy tower's ground 100 .. 400 m below
// the camera, the overcast bridge's banks, the dusty chemical plant's yards: near fog-free in the game
// where FogNear says 0 .. 25 m), then thinner per metre than the sky's fit gave. The joint fits over 11
// and 12 environments: x 0.60 .. 0.61 and + 109 .. 122 m (with the falloff free: x 0.89, + 104 m, no
// better; kept at FogExpMul). The land from 100 m out, the fog's part: 0.43 -> 0.24 stop off the game's
// (mean over the environments), the worst (the rainy tower 0.94, the overcast bridge 1.34, the hangar
// 0.71) 0.28 / 0.19 / 0.24. The scatter left is per preset (each alone wants x 0.4 .. 1.8, New Year's
// night x 1.6, the smog x 3.3), and the fog's colour on the land x 0.6 .. 1.3 of FOG_COLOR_K's, with no
// pattern in the presets' numbers (density, falloff, the camera against FogHeight, FogNear, the
// colour's alpha, FogLuminanceEv100 against the exposure, the gain).
export const FOG_DENSITY_K = 0.6;
export const FOG_START_ADD = 120;
// The air's haze: Bruneton's in-scattering to a point (the atmosphere's tables, as the sky is drawn)
// for FogAerialGain x AIR_K x the distance, here as the air's sky just over the horizon in that
// direction x (1 - what gets through), which is within 5 .. 17 % of the tables' own over the captures'
// land. Fitted with the fog above, the fog in front of the air (the sandstorm's far mesas stay in its
// dust; the air over the fog turned them lilac): 0.5 (0.35 .. 0.7 alike), the land's colour error
// 0.077 -> 0.052 (the bridge's clear day 0.069 -> 0.054, cityruin's, castle's and red_rocks' blue
// far hills); the same haze with one gain for every preset is 3x worse (the overcast and rainy
// presets, gain 0, show none).
export const AIR_K = 0.5;
const AIR_N = 16; // (azimuths)

// The fog every material takes (a plain object of plain objects: three's materials keep the same ones,
// so a new environment needs no recompile). a: density at the fog's height (per metre, base 2), its
// falloff (per metre, base 2), the fog's height (world y), where it starts (metres from the camera);
// b: where the sun's glow starts, its exponent; color: the fog's colour, glow: the sun's glow (the view's
// linear units); sun: towards the sun; airK: the air's extinction per metre (rgb) and 1 when there is
// one; air: what it scatters in over a long way, towards AIR_N azimuths round the horizon (rgb each).
export const FOG = {
  a: { x: 0, y: 0, z: 0, w: 0 },
  b: { x: 0, y: 1, z: 0, w: 0 },
  c: { x: 0, y: 0, z: 0, w: 0 }, // (Crossout 2.41's second layer: density, falloff, height; b.z 1: its layers)
  color: { x: 0, y: 0, z: 0 },
  glow: { x: 0, y: 0, z: 0 },
  sun: { x: 0, y: 1, z: 0 },
  airK: { x: 0, y: 0, z: 0, w: 0 },
  air: new Float32Array(AIR_N * 3),
};
export const FOG_UNIFORMS = () => ({ xoFogA: { value: FOG.a }, xoFogB: { value: FOG.b }, xoFogC: { value: FOG.c }, xoFogColor: { value: FOG.color }, xoFogGlow: { value: FOG.glow }, xoFogSun: { value: FOG.sun }, xoAirK: { value: FOG.airK }, xoAir: { value: FOG.air } });

// UE4's line integral of the fog along r (from the camera), from s metres out (exp2 of minus it is what
// gets through); xoFogTo: what the air and the fog in front of it add on the way to a point r away
// (rgb) and what is left of the point's own colour (a; the air's share as its luminance); xoFogTint:
// the air's colour on what is behind it (the rest of it: what gets through each channel, against a);
// xoFogSky: the fog towards the sky.
export const FOG_GLSL = /* glsl */ `
uniform vec4 xoFogA, xoFogB, xoFogC, xoAirK;
uniform vec3 xoFogColor, xoFogGlow, xoFogSun;
uniform vec3 xoAir[ ${AIR_N} ];
// Crossout 2.41's layer L (density, falloff, height) along len metres whose height runs ya -> yb: 2^g
// with g = -falloff (y - height) capped at 0, g linear along the way
float xoLayerLine( vec4 L, float ya, float yb, float len ) {
	float ga = clamp( - L.y * ( ya - L.z ), -127.0, 126.0 ), gb = clamp( - L.y * ( yb - L.z ), -127.0, 126.0 );
	float lo = min( ga, gb ), hi = max( ga, gb );
	float full = lo >= 0.0 ? 1.0 : hi > 0.0 ? hi / ( hi - lo ) : 0.0, top = min( hi, 0.0 ), span = top - lo;
	float part = span > 1e-4 ? ( exp2( top ) - exp2( lo ) ) / ( span * 0.6931472 ) : exp2( lo );
	return L.x > 0.0 && len > 0.0 ? L.x * len * ( full + ( 1.0 - full ) * part ) : 0.0;
}
// the same from height y0 up to no end, rising dy per metre
float xoLayerUp( vec4 L, float y0, float dy ) {
	float g0 = - L.y * ( y0 - L.z ), k = max( L.y, 1e-9 ) * max( dy, 1e-9 );
	float up = L.x * ( max( g0, 0.0 ) / k + exp2( clamp( min( g0, 0.0 ), -127.0, 0.0 ) ) / ( k * 0.6931472 ) );
	return L.x <= 0.0 ? 0.0 : dy < 1e-6 || L.y <= 0.0 ? 1e6 : up;
}
float xoFogLine( vec3 r, float s ) {
	float len = length( r );
	float t = clamp( s / max( len, 1e-4 ), 0.0, 1.0 );
	float line = 0.0;
	if ( xoFogB.z > 0.5 ) {
		float ya = cameraPosition.y + r.y * t, yb = cameraPosition.y + r.y, seg = len * ( 1.0 - t );
		line = xoLayerLine( xoFogA, ya, yb, seg ) + xoLayerLine( xoFogC, ya, yb, seg );
	} else {
		float rho = xoFogA.x * exp2( clamp( - xoFogA.y * ( cameraPosition.y + r.y * t - xoFogA.z ), -127.0, 126.0 ) );
		float f = max( -127.0, xoFogA.y * r.y * ( 1.0 - t ) );
		float li = abs( f ) > 0.01 ? ( 1.0 - exp2( - f ) ) / f : 0.6931472 - 0.2402265 * f;
		line = rho * li * len * ( 1.0 - t );
	}
	return line;
}
float xoFogLineUp( vec3 dir, float s ) {
	float up = dir.y * xoFogA.y, y0 = cameraPosition.y + dir.y * s;
	return xoFogB.z > 0.5 ? min( 1e6, xoLayerUp( xoFogA, y0, dir.y ) + xoLayerUp( xoFogC, y0, dir.y ) )
		: xoFogA.x <= 0.0 ? 0.0 : up < 1e-6 ? 1e6 : xoFogA.x * exp2( clamp( - xoFogA.y * ( y0 - xoFogA.z ), -127.0, 126.0 ) ) / up;
}
vec3 xoAirIn( vec3 r ) {
	float a = ( atan( r.z, r.x ) / 6.2831853 + 0.5 ) * ${AIR_N}.0 - 0.5, i = floor( a );
	return mix( xoAir[ int( mod( i, ${AIR_N}.0 ) ) ], xoAir[ int( mod( i + 1.0, ${AIR_N}.0 ) ) ], a - i );
}
vec4 xoFogTo( vec3 r ) {
	float T = exp2( - xoFogLine( r, xoFogA.w ) );
	float glow = pow( clamp( dot( normalize( r ), xoFogSun ), 0.0, 1.0 ), xoFogB.y ) * ( 1.0 - exp2( - xoFogLine( r, xoFogB.x ) ) );
	vec3 add = xoFogColor * ( 1.0 - T ) + xoFogGlow * glow;
	if ( xoAirK.w < 0.5 ) return vec4( add, T );
	vec3 Ta = exp( - xoAirK.rgb * length( r ) );
	return vec4( add + xoAirIn( r ) * ( 1.0 - Ta ) * T, T * dot( Ta, vec3( 0.2126, 0.7152, 0.0722 ) ) );
}
vec3 xoFogTint( vec3 r ) {
	if ( xoAirK.w < 0.5 ) return vec3( 1.0 );
	vec3 Ta = exp( - xoAirK.rgb * length( r ) );
	return Ta / max( dot( Ta, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
}
vec4 xoFogSky( vec3 dir ) {
	float T = exp2( - xoFogLineUp( dir, xoFogA.w ) );
	float glow = pow( clamp( dot( dir, xoFogSun ), 0.0, 1.0 ), xoFogB.y ) * ( 1.0 - exp2( - xoFogLineUp( dir, xoFogB.x ) ) );
	return vec4( xoFogColor * ( 1.0 - T ) + xoFogGlow * glow, T );
}
`;

// three's fog chunks carry it (on while scene.fog is set: Maps): the vertex passes the way from the
// camera, the fragment takes the fog on it. The fog uniforms go into every built-in material that has
// fog (they share FOG; materials of their own add FOG_UNIFORMS()). (water.js takes the last line as it
// stands.)
{
  const C = THREE.ShaderChunk;
  const MIX = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  if (!C.fog_fragment.includes(MIX) || !C.fog_vertex.includes('vFogDepth = - mvPosition.z;')) console.warn('fog patch did not apply (three.js changed?)');
  C.fog_pars_vertex = C.fog_pars_vertex.replace('varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying vec3 vXoFogRay;');
  C.fog_vertex = C.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = - mvPosition.z;\n\tvXoFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;');
  C.fog_pars_fragment = C.fog_pars_fragment.replace('varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying vec3 vXoFogRay;\n' + FOG_GLSL);
  C.fog_fragment = C.fog_fragment.replace(MIX, 'vec4 xoFog = xoFogTo( vXoFogRay );\n\tgl_FragColor.rgb *= xoFogTint( vXoFogRay );\n\tgl_FragColor.rgb = gl_FragColor.rgb * xoFog.a + xoFog.rgb;');
  for (const lib of Object.values(THREE.ShaderLib)) if (lib.uniforms.fogColor) Object.assign(lib.uniforms, FOG_UNIFORMS());
}

const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
const LUM = [0.2126, 0.7152, 0.0722];
const vec3 = (s, d) => { const v = String(s || '').trim().split(/\s+/).map(Number); return v.length >= 3 && v.every(Number.isFinite) ? v.slice(0, 3) : d; };

// The fog from height y0 up to no end, rising dy per metre, from s metres out (xoFogLineUp on the CPU):
// f a presetFog result.
export function fogLineUp(f, y0, dy, s = 0) {
  const y = y0 + dy * s;
  if (!f.layers) {
    const up = dy * f.falloff;
    return f.density <= 0 ? 0 : up < 1e-6 ? 1e6 : (f.density * 2 ** Math.max(-127, Math.min(126, -f.falloff * (y - f.height)))) / up;
  }
  const one = ({ density: d, falloff: k, height: h }) => {
    if (d <= 0) return 0;
    if (dy < 1e-6 || k <= 0) return 1e6;
    const g0 = -k * (y - h);
    return d * (Math.max(g0, 0) / (k * dy) + 2 ** Math.max(-127, Math.min(g0, 0)) / (k * Math.LN2 * dy));
  };
  return Math.min(1e6, f.layers.reduce((a, l) => a + one(l), 0));
}

// The air's sky just over the horizon (1 degree up) towards AIR_N azimuths (three's equirect order: u =
// atan2(z, x) / 2pi + 0.5 at the texel centres), in the tables' radiance: sky.js's xoSkyRadiance on the
// CPU (Bruneton's scattering lookup, the camera at alt metres; a: sky.js's atmosphere numbers, scat: its
// scattering table, RGBA halves 256 x 128 x 32).
function airHorizon(a, scat, sun, alt) {
  const half = THREE.DataUtils.fromHalfFloat, out = [];
  const H = Math.sqrt(a.top * a.top - a.bottom * a.bottom), r = a.bottom + Math.max(alt, 2);
  const tc = (x, n) => 0.5 / n + x * (1 - 1 / n);
  const distTop = (rr, mu) => Math.max(0, -rr * mu + Math.sqrt(Math.max(rr * rr * (mu * mu - 1) + a.top * a.top, 0)));
  const rho = Math.sqrt(Math.max(r * r - a.bottom * a.bottom, 0)), uR = tc(rho / H, 32);
  const mu = Math.sin(THREE.MathUtils.degToRad(1)), rMu = r * mu, disc = rMu * rMu - r * r + a.bottom * a.bottom;
  const uMu = 0.5 + 0.5 * tc((-rMu + Math.sqrt(Math.max(disc + H * H, 0)) - (a.top - r)) / (rho + H - (a.top - r)), 64);
  const dS = distTop(a.bottom, sun.y), dMin = a.top - a.bottom, A = (distTop(a.bottom, a.muSMin) - dMin) / (H - dMin), aa = (dS - dMin) / (H - dMin);
  const uMuS = tc(Math.max(1 - aa / A, 0) / (1 + aa), 32);
  // (a 3D texture's linear lookup, clamped to the edge)
  const tex = (u, v, w) => {
    const c = [0, 0, 0, 0], X = u * 256 - 0.5, Y = v * 128 - 0.5, Z = w * 32 - 0.5;
    const x0 = Math.floor(X), y0 = Math.floor(Y), z0 = Math.floor(Z), fx = X - x0, fy = Y - y0, fz = Z - z0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = clampI(x0 + dx, 255), y = clampI(y0 + dy, 127), z = clampI(z0 + dz, 31), wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
      const o = ((z * 128 + y) * 256 + x) * 4;
      for (let k = 0; k < 4; k++) c[k] += half(scat[o + k]) * wgt;
    }
    return c;
  };
  const g = a.g, k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  for (let i = 0; i < AIR_N; i++) {
    const ph = ((i + 0.5) / AIR_N - 0.5) * 2 * Math.PI, dir = [Math.cos(ph) * Math.cos(Math.asin(mu)), mu, Math.sin(ph) * Math.cos(Math.asin(mu))];
    const nu = dir[0] * sun.x + dir[1] * sun.y + dir[2] * sun.z, tx = ((nu + 1) / 2) * 7, x0 = Math.floor(tx), f = tx - x0;
    const s0 = tex((x0 + uMuS) / 8, uMu, uR), s1 = tex((x0 + 1 + uMuS) / 8, uMu, uR), s = s0.map((v, j) => v * (1 - f) + s1[j] * f);
    const pr = (3 / (16 * Math.PI)) * (1 + nu * nu), pm = (k * (1 + nu * nu)) / Math.pow(1 + g * g - 2 * g * nu, 1.5);
    for (let c = 0; c < 3; c++) {
      const mie = s[0] > 0 ? ((s[c] * s[3]) / s[0]) * (a.rayleigh[0] / a.mie[0]) * (a.mie[c] / a.rayleigh[c]) : 0;
      out.push(s[c] * pr + mie * pm);
    }
  }
  return out;
}
const clampI = (x, hi) => Math.min(hi, Math.max(0, x));

// The fog of an environment (vals: its preset), in the view's units: viewPerGame turns the game's light
// units into the view's (as the sky is drawn: sky.js passes exposure / PROBE_UNIT, the fits were made in
// the probes' units, the game's / 16); sunLight: the sun's light in the game's units (rgb); air (or
// null: no air's haze): { atm: sky.js's atmosphere numbers, scat: its scattering table, lightK: the
// tables' radiance -> the game's units (sky.js LIGHT_K), altitude: the camera's, metres }.
// The sky's fit (bridge 664236, sand_valley 702818, halloween, new year bright, the sandstorm) gave the
// density 0.87 .. 0.93 x with the colour weakly held; held to the land as well, the skies (each its own
// brightness, from 40 degrees up) are as close at 0.6 x (mean 0.16 stop against 0.20 at 1 x). The glow
// is half the skies' fit: on the land towards the sun (0 .. 45 degrees from it, 8 environments) the air
// already brightens it, and 0.5 x gives 0.21 stop against 0.24 at 1 x.
export function presetFog(vals, sunDir, sunLight, viewPerGame, air = null) {
  if (vals.HeightFog0) {
    // (Crossout 2.41: the scene's fog; air.sky: the sky near the horizon, the view's units)
    const layer = (s) => { const [d, k, h] = vec3(s, [0, 0, 0]); return { density: Math.max(0, d), falloff: k, height: h }; };
    const layers = [layer(vals.HeightFog0), layer(vals.HeightFog1)], ins = vec3(vals.HeightFogInscatter, [1, 1, 1]), sky = air?.sky || [0, 0, 0];
    const start = Math.max(0, num(vals.HeightFogStart, 0));
    return {
      ...layers[0], layers, start, sunStart: start, sunPower: 8, color: new THREE.Color(sky[0] * ins[0], sky[1] * ins[1], sky[2] * ins[2]),
      glow: new THREE.Color(...sunLight).multiplyScalar(FOG_GLOW_K * viewPerGame * Math.max(0, num(vals.HeightFogSunScatter, 0))), sun: sunDir.clone(), airK: null, airIn: null,
    };
  }
  const k = Math.max(0, num(vals.FogExpMul, 0.01));
  const n = parseInt(String(vals.FogColor || '0xFFFFFFFF').replace(/^0x/i, ''), 16) >>> 0;
  const c = new THREE.Color().setRGB(((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255, THREE.SRGBColorSpace);
  const lum = LUM[0] * c.r + LUM[1] * c.g + LUM[2] * c.b;
  const ev = num(vals.FogLuminanceEv100, 8);
  const color = lum > 1e-6 ? c.multiplyScalar((FOG_COLOR_K * viewPerGame * 2 ** ev) / 8 / lum) : c.setRGB(0, 0, 0);
  // the air: Bruneton's extinction (Rayleigh + Mie / 0.9) over FogAerialGain x AIR_K the distance
  const gain = Math.max(0, num(vals.FogAerialGain, 0)) * AIR_K;
  let airK = null, airIn = null;
  if (air && gain > 0 && air.atm && air.scat) {
    const m = air.atm;
    airK = [0, 1, 2].map((j) => (m.rayleigh[j] + m.mie[j] / 0.9) * gain);
    // (the air's light is the sun's: as much less as the preset's sun is under the atmosphere's own -
    // fix_cloudy_dark's 15 against 610, gain 20: the game's probes show no air haze on such overcasts,
    // where the clear air's horizon laid a bright veil over arena_football)
    airIn = airHorizon(m, air.scat, sunDir, air.altitude).map((v, j) => v * air.lightK[j % 3] * viewPerGame * (air.sunK ?? 1));
  }
  return {
    density: Math.max(0, num(vals.FogDensity, 0)) * k * FOG_DENSITY_K, falloff: k, height: num(vals.FogHeight, 0), start: Math.max(0, num(vals.FogNear, 0)) + FOG_START_ADD,
    sunStart: Math.max(0, num(vals.FogSunNear, 0)), sunPower: Math.max(0.5, num(vals.FogSunPower, 8) * FOG_GLOW_POWER),
    color, glow: new THREE.Color(...sunLight).multiplyScalar(FOG_GLOW_K * viewPerGame), sun: sunDir.clone(), airK, airIn,
  };
}

// Puts a fog (presetFog's, or null: none) on every material.
export function setFog(f) {
  Object.assign(FOG.a, { x: f ? f.density : 0, y: f ? f.falloff : 0, z: f ? f.height : 0, w: f ? f.start : 0 });
  Object.assign(FOG.b, { x: f ? f.sunStart : 0, y: f ? f.sunPower : 1, z: f?.layers ? 1 : 0 });
  const l1 = f?.layers?.[1];
  Object.assign(FOG.c, { x: l1 ? l1.density : 0, y: l1 ? l1.falloff : 0, z: l1 ? l1.height : 0, w: 0 });
  Object.assign(FOG.color, f ? { x: f.color.r, y: f.color.g, z: f.color.b } : { x: 0, y: 0, z: 0 });
  Object.assign(FOG.glow, f ? { x: f.glow.r, y: f.glow.g, z: f.glow.b } : { x: 0, y: 0, z: 0 });
  if (f) Object.assign(FOG.sun, { x: f.sun.x, y: f.sun.y, z: f.sun.z });
  const air = f && f.airK && f.airIn;
  Object.assign(FOG.airK, air ? { x: f.airK[0], y: f.airK[1], z: f.airK[2], w: 1 } : { x: 0, y: 0, z: 0, w: 0 });
  FOG.air.fill(0);
  if (air) FOG.air.set(f.airIn.slice(0, AIR_N * 3));
}
