// The scene's point and spot lights (a map's lamps and projectors, the effects' flashes, the car's
// headlights) lit by one loop in every lit shader, in place of three's own per-light code. Three writes
// every point and spot light out in full in every lit shader, and the D3D compiler builds each copy:
// a lit material took 88 ms to build under the sun alone, 156 ms under the 8 lights always there (the
// flashes, the headlights) and 404 ms under a lamp map's 32, and a map has 90 to 105 of them, so
// opening a map was mostly waiting for shaders. The loop is built once, whatever the number of lights,
// and runs only over the lights lit at the moment. Its light is three's to the letter
// (getPointLightInfo, getSpotLightInfo, then the material's RE_Direct); the map's lamps keep their
// shadows (lampshadows.js) and their specularEnabled.
// A light here is a three PointLight or SpotLight kept OUT of the scene: its owner (maplights.js,
// fxview.js, drive.js) sets its place (world), colour, intensity, distance, decay and, for a spot,
// angle, penumbra and target as before, and lists it through addLights(); packLights() writes the lit
// ones into the uniforms every lit material shares, before every frame (viewer.js render). They light
// the viewer's scene only, as three's lights lit only the scene they were in (lightScene).
import * as THREE from 'three';

export const MAX_LIGHTS = 32;

// The lit lights, shared by every lit material (ShaderLib's uniforms: three copies the uniform objects
// for each material but not typed arrays or plain objects in them). Per light: A = its place (world)
// and distance; B = its colour x intensity and decay; C = the way a spot shines (world, from its
// target to it) and the cos of its cone (-2: a point light); D = the cos of its penumbra's edge, its
// gloss (specularEnabled: 1 or 0), its shadow's far and near (far 0: none); E = its shadow's block in
// the lamp atlas (u, v).
export const XO_LIGHTS = {
  xoLtCount: { value: { x: 0, y: 0, z: 0, w: 0 } },
  xoLtA: { value: new Float32Array(4 * MAX_LIGHTS) },
  xoLtB: { value: new Float32Array(4 * MAX_LIGHTS) },
  xoLtC: { value: new Float32Array(4 * MAX_LIGHTS) },
  xoLtD: { value: new Float32Array(4 * MAX_LIGHTS) },
  xoLtE: { value: new Float32Array(4 * MAX_LIGHTS) },
};

const PARS = /* glsl */ `
uniform vec4 xoLtCount;
uniform vec4 xoLtA[ ${MAX_LIGHTS} ], xoLtB[ ${MAX_LIGHTS} ], xoLtC[ ${MAX_LIGHTS} ], xoLtD[ ${MAX_LIGHTS} ], xoLtE[ ${MAX_LIGHTS} ];
float xoSpecK = 1.0; // the light being lit: its gloss (RE_Direct_Physical)
`;

// One loop, as long as there are lights lit (a bound the compiler cannot unroll): three's point and
// spot light, then the material's own RE_Direct.
const LOOP = /* glsl */ `
#if defined( RE_Direct )
	{
		int xoLtN = int( xoLtCount.x );
		#ifdef XO_LAMP_SHADOWS
		vec3 xoW = cameraPosition + ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz, xoNw = ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz;
		#endif
		for ( int k = 0; k < xoLtN; k ++ ) {
			vec4 A = xoLtA[ k ], B = xoLtB[ k ], C = xoLtC[ k ], D = xoLtD[ k ];
			vec3 lVector = ( viewMatrix * vec4( A.xyz, 1.0 ) ).xyz - geometryPosition;
			directLight.direction = normalize( lVector );
			float lightDistance = length( lVector );
			if ( C.w < - 1.5 ) { // (getPointLightInfo)
				directLight.color = B.rgb * getDistanceAttenuation( lightDistance, A.w, B.w );
			} else { // (getSpotLightInfo)
				float angleCos = dot( directLight.direction, normalize( ( viewMatrix * vec4( C.xyz, 0.0 ) ).xyz ) );
				float spotAttenuation = getSpotAttenuation( C.w, D.x, angleCos );
				directLight.color = spotAttenuation > 0.0 ? B.rgb * spotAttenuation * getDistanceAttenuation( lightDistance, A.w, B.w ) : vec3( 0.0 );
			}
			directLight.visible = ( directLight.color != vec3( 0.0 ) );
			if ( ! directLight.visible ) continue;
			#ifdef XO_LAMP_SHADOWS
			if ( D.z > 0.0 && receiveShadow ) directLight.color *= xoLampSeen( vec4( A.xyz, D.z ), vec4( xoLtE[ k ].xy, D.w, 0.0 ), xoW, xoNw );
			#endif
			xoSpecK = D.y;
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
		xoSpecK = 1.0;
	}
#endif
`;

{
  const C = THREE.ShaderChunk;
  const DIR = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )',
    GGX = 'reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );';
  if (!C.lights_fragment_begin.includes(DIR) || !C.lights_physical_pars_fragment.includes(GGX) || !C.lights_pars_begin.includes('float getSpotAttenuation('))
    console.warn('light loop patch did not apply (three.js changed?)');
  C.lights_pars_begin += PARS;
  C.lights_fragment_begin = C.lights_fragment_begin.replace(DIR, LOOP + DIR);
  C.lights_physical_pars_fragment = C.lights_physical_pars_fragment.replace(GGX, GGX.replace('+= irradiance', '+= xoSpecK * irradiance'));
  for (const lib of Object.values(THREE.ShaderLib)) if (lib.uniforms.pointLights) Object.assign(lib.uniforms, XO_LIGHTS);
}

// The lights' owners: each a function listing its lights now, as { light, spec (false: no gloss),
// shadow: { far, near, u, v } or null }.
const sources = new Set();
export function addLights(fn) { sources.add(fn); }
export function removeLights(fn) { sources.delete(fn); }

const _d = new THREE.Vector3();
// The lit lights into the shared uniforms (the first MAX_LIGHTS of them, owners in the order they came).
export function packLights() {
  const A = XO_LIGHTS.xoLtA.value, B = XO_LIGHTS.xoLtB.value, Cv = XO_LIGHTS.xoLtC.value, D = XO_LIGHTS.xoLtD.value, E = XO_LIGHTS.xoLtE.value;
  let n = 0;
  for (const fn of sources) {
    for (const e of fn()) {
      const l = e?.light;
      if (n >= MAX_LIGHTS || !l || !(l.intensity > 0)) continue;
      const o = n * 4, p = l.position, c = l.color, s = e.shadow;
      A[o] = p.x; A[o + 1] = p.y; A[o + 2] = p.z; A[o + 3] = l.distance;
      B[o] = c.r * l.intensity; B[o + 1] = c.g * l.intensity; B[o + 2] = c.b * l.intensity; B[o + 3] = l.decay;
      if (l.isSpotLight) {
        _d.copy(p).sub(l.target.position).normalize();
        Cv[o] = _d.x; Cv[o + 1] = _d.y; Cv[o + 2] = _d.z; Cv[o + 3] = Math.cos(l.angle);
        D[o] = Math.cos(l.angle * (1 - l.penumbra));
      } else {
        Cv[o] = Cv[o + 1] = Cv[o + 2] = 0; Cv[o + 3] = -2;
        D[o] = 0;
      }
      D[o + 1] = e.spec === false ? 0 : 1;
      D[o + 2] = s ? s.far : 0; D[o + 3] = s ? s.near : 0;
      E[o] = s ? s.u : 0; E[o + 1] = s ? s.v : 0; E[o + 2] = E[o + 3] = 0;
      n++;
    }
  }
  lit = n;
  return n;
}

// The scene the lights are in: they are counted while it is drawn and are none for any other scene the
// renderer draws (the icon studio, a sky, an environment map).
let lit = 0;
export const litCount = () => lit; // (the lights the last packLights() packed)
export function lightScene(scene) {
  scene.onBeforeRender = () => { XO_LIGHTS.xoLtCount.value.x = lit; };
  scene.onAfterRender = () => { XO_LIGHTS.xoLtCount.value.x = 0; };
}
