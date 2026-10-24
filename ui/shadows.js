// Maps' sun shadows over the whole view: cascaded shadow maps. The sun's shadow map is a strip of
// CASCADES squares; cascade k holds everything within its reach of the camera (50, 200 and 800 m, the
// last the view distance): a square around the camera in the sun's view, its centre on one of that
// cascade's texels, so shadows hold still while flying, and turning the camera changes nothing. A
// fragment takes the nearest cascade that reaches it and blends into the next over the last tenth.
// A square is a little larger than its reach (LAG) and is drawn again only once the camera has left
// that slack (every 2 m for the nearest, every few hundred for the farthest) or the view turned well
// away, into its own part of the map (the map's scissor keeps the others); what keeps changing near
// the camera (a car driving, a gun turning) redraws the nearest alone, and all of them once it stops.
// In the garage the light keeps three's plain shadow (no cascades).
// The terrain adds the light its own hills leave it (Map.cpp bakeTerrainLight; mapview.js puts it on
// the terrain with XO_TERRAIN_LIGHT): the sun's part as one more shadow, the sky's on its ambient light.
import * as THREE from 'three';

export const CASCADES = 4;
const REACH = [50, 200, 800]; // metres: every cascade's reach but the last's (the view distance)
const BLEND = 0.1; // the part of a cascade's reach that blends into the next
const LAG = 0.04;  // how far (of its reach) the camera may move before a cascade is drawn again
export const TURN_ANGLE = THREE.MathUtils.degToRad(15); // turned further than this: the cascades are drawn again
const TURN = Math.cos(TURN_ANGLE);

// The cascades as drawn (shared by every lit material, like fog.js's FOG): info = (cascades, blend,
// the map's width and height in texels); each cascade's reach (metres from the camera), depth bias
// and normal bias (metres); mats: world -> its square of the map (0..1).
export const CSM = {
  info: { x: 0, y: BLEND, z: 1, w: 1 },
  reach: { x: 0, y: 0, z: 0, w: 0 },
  bias: { x: 0, y: 0, z: 0, w: 0 },
  normal: { x: 0, y: 0, z: 0, w: 0 },
  mats: new Float32Array(16 * CASCADES),
};

// The terrain's own light (XO_TERRAIN_LIGHT): its texture (RG: sun, sky), where it lies (u = x * .x + .y,
// v = z * .z + .w in world metres) and whether it is on.
const TERRAIN_LIGHT_GLSL = /* glsl */ `
#ifdef XO_TERRAIN_LIGHT
uniform sampler2D xoTerrainLight;
uniform vec4 xoTerrainUv;
uniform float xoTerrainOn;
vec2 xoTerrainLightAt( vec3 world ) {
	vec2 l = texture2D( xoTerrainLight, vec2( world.x * xoTerrainUv.x + xoTerrainUv.y, world.z * xoTerrainUv.z + xoTerrainUv.w ) ).rg;
	return mix( vec2( 1.0 ), l, xoTerrainOn );
}
#endif
`;

// The sun's shadow on a fragment: three's own (a light with no cascades: radius >= 0), else its
// cascade(s) at the fragment's distance (viewPos, viewNormal: the view's frame). The shadow map is read
// in two places, the first look (plain, or the fragment's cascade) and the next cascade's it blends
// into: each getShadow written out is built in full (three of them made every map shader's build
// slower by 18 ms).
const CSM_GLSL = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform vec4 xoCsmInfo, xoCsmReach, xoCsmBias, xoCsmNormal;
uniform mat4 xoCsmMat[ ${CASCADES} ];
// cascade k's place for a point (c: in the strip), and whether the point lies in its square
bool xoCascadeAt( int k, vec3 world, vec3 n, out vec4 c ) {
	c = xoCsmMat[ k ] * vec4( world + n * xoCsmNormal[ k ], 1.0 );
	float m = 2.0 / xoCsmInfo.w; // (soft shadows read two texels around: not into the next square)
	bool inside = c.x >= m && c.x <= 1.0 - m && c.y >= m && c.y <= 1.0 - m;
	c.x = ( c.x + float( k ) ) / xoCsmInfo.x;
	return inside;
}
float xoSunShadow( sampler2D map, DirectionalLightShadow sh, vec4 coord, vec3 viewPos, vec3 viewNormal ) {
	vec4 c = coord, c2 = vec4( 0.0 );
	vec2 size = sh.shadowMapSize;
	float bias = sh.shadowBias, radius = sh.shadowRadius, bias2 = 0.0, b = 0.0, s = 1.0, s2 = 1.0;
	bool look = true, look2 = false, blend = false;
	vec3 world = vec3( 0.0 );
	if ( sh.shadowRadius < 0.0 ) {
		world = cameraPosition + ( vec4( viewPos, 0.0 ) * viewMatrix ).xyz;
		vec3 n = ( vec4( viewNormal, 0.0 ) * viewMatrix ).xyz;
		float d = length( viewPos );
		int last = int( xoCsmInfo.x ) - 1;
		int k = min( last, d < xoCsmReach.x ? 0 : d < xoCsmReach.y ? 1 : d < xoCsmReach.z ? 2 : 3 );
		look = false;
		if ( d < xoCsmReach[ k ] ) {
			look = xoCascadeAt( k, world, n, c );
			size = xoCsmInfo.zw;
			bias = xoCsmBias[ k ];
			radius = 0.0;
			b = ( d / xoCsmReach[ k ] - 1.0 ) / xoCsmInfo.y + 1.0;
			blend = b > 0.0 && k < last;
			if ( blend ) {
				look2 = xoCascadeAt( k + 1, world, n, c2 );
				bias2 = xoCsmBias[ k + 1 ];
			}
		}
	}
	if ( look ) s = getShadow( map, size, sh.shadowIntensity, bias, radius, c );
	if ( look2 ) s2 = getShadow( map, xoCsmInfo.zw, sh.shadowIntensity, bias2, 0.0, c2 );
	if ( blend ) s = mix( s, s2, b );
	#ifdef XO_TERRAIN_LIGHT
	if ( sh.shadowRadius < 0.0 ) s = min( s, xoTerrainLightAt( world ).x );
	#endif
	return s;
}
#endif
`;

{
  const C = THREE.ShaderChunk;
  const LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
  if (!C.lights_fragment_begin.includes(LINE) || !C.aomap_fragment.trim().endsWith('#endif')) console.warn('shadow patch did not apply (three.js changed?)');
  C.lights_fragment_begin = C.lights_fragment_begin.replace(LINE, 'directLight.color *= ( directLight.visible && receiveShadow ) ? ( UNROLLED_LOOP_INDEX == 0 ? xoSunShadow( directionalShadowMap[ i ], directionalLightShadow, vDirectionalShadowCoord[ i ], geometryPosition, nonPerturbedNormal ) : getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) ) : 1.0;');
  C.lights_pars_begin += TERRAIN_LIGHT_GLSL;
  C.shadowmap_pars_fragment += CSM_GLSL;
  // (the sky a hollow sees past its hills: less of its light)
  C.aomap_fragment += `
#ifdef XO_TERRAIN_LIGHT
	{
		float xoSky = xoTerrainLightAt( cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz ).y;
		reflectedLight.indirectDiffuse *= xoSky;
		reflectedLight.indirectSpecular *= xoSky;
	}
#endif`;
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (!lib.uniforms.directionalLights) continue;
    Object.assign(lib.uniforms, { xoCsmInfo: { value: CSM.info }, xoCsmReach: { value: CSM.reach }, xoCsmBias: { value: CSM.bias }, xoCsmNormal: { value: CSM.normal }, xoCsmMat: { value: CSM.mats } });
  }
}

const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const _m = new THREE.Matrix4();

// The sun's shadow (three keeps DirectionalLightShadow to itself: its class through an instance).
const DirectionalLightShadow = new THREE.DirectionalLight().shadow.constructor;
export class SunShadow extends DirectionalLightShadow {
  constructor(size) {
    super();
    this.mapSize.set(size, size);
    this.cascades = 0;
    this.tile = size;
    this.drawn = []; // per cascade: { c (centre), r (half size), texel, dist (its reach), lag, back (towards the sun), right, up, sun, dir (the view's) } as last drawn
    this.next = [];  // ... as the camera wants it now
    this.pending = 0; // cascades to draw again (always the nearest ones first)
    this.changing = 0; // frames in a row the scene changed (viewer.js shadowDirty)
    this.catchUp = false; // all to draw again once it stops
  }

  // Maps: n cascades of tile x tile texels each; 0: three's plain shadow of size x size.
  setCascades(n, size) {
    if (n === this.cascades && size === (n ? this.tile : this.mapSize.x)) return;
    this.cascades = n;
    this.tile = size;
    this.mapSize.set(size, size);
    this._frameExtents.set(Math.max(1, n), 1);
    this._viewports = n ? Array.from({ length: n }, (_, k) => new THREE.Vector4(k, 0, 1, 1)) : [new THREE.Vector4(0, 0, 1, 1)];
    this._viewportCount = this._viewports.length;
    this.radius = n ? -1 : 1; // (the sign the shaders know a cascaded shadow by: PCF soft reads no radius)
    if (!n) this.camera.up.set(0, 1, 0); // (three's own aims it with the world's up)
    this.drawn = [];
    this.next = [];
    this.pending = n;
    this.changing = 0; // (Maps' changes do not follow it out: the garage would draw its map every frame)
    this.catchUp = false;
    this.map?.dispose(); // (another size: three makes it again)
    this.map = null;
    Object.assign(CSM.info, { x: n, z: size * Math.max(1, n), w: size });
  }

  // The cascades this view wants (camera, view distance, towards the sun; top: the highest anything
  // stands, whose shadow may reach the view). Marks the ones that moved for drawing.
  fit(camera, far, sun, top) {
    const n = this.cascades;
    if (!n) return;
    const right = Math.abs(sun.y) > 0.999 ? new THREE.Vector3().crossVectors(Z, sun).normalize() : new THREE.Vector3().crossVectors(UP, sun).normalize();
    const up = new THREE.Vector3().crossVectors(sun, right);
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const p = camera.position;
    for (let k = 0; k < n; k++) {
      const dist = k < n - 1 ? Math.min(REACH[k], (far * (k + 1)) / n) : far, lag = dist * LAG;
      const texel = (2 * (dist + lag)) / (this.tile - 6); // (3 texels to spare at each side for the soft edge)
      const r = ((dist + lag) * this.tile) / (this.tile - 6);
      const was = this.drawn[k];
      const off = was ? p.clone().sub(was.c) : null;
      const moved = !was || was.dist !== dist || !was.sun.equals(sun) || was.dir.dot(dir) < TURN || Math.max(Math.abs(off.dot(was.right)), Math.abs(off.dot(was.up))) > lag;
      if (!moved) { this.next[k] = was; continue; }
      const a = Math.round(p.dot(right) / texel) * texel, b = Math.round(p.dot(up) / texel) * texel, z = Math.round(p.dot(sun) / texel) * texel;
      const c = right.clone().multiplyScalar(a).addScaledVector(up, b).addScaledVector(sun, z);
      const back = THREE.MathUtils.clamp((top - c.y + r) / Math.max(sun.y, 0.05), r, 20000); // (how far towards the sun casters may stand)
      this.next[k] = { c, r, texel, dist, lag, back, right, up, sun: sun.clone(), dir };
      this.pending = Math.max(this.pending, k + 1);
    }
  }

  // Before three draws the map (viewer.js render; changed: something in the scene did): the pending
  // cascades, or all of them (the rest of the map is kept by its scissor); none before the first fit.
  schedule(changed) {
    if (!this.cascades) { this.changing = 0; this.catchUp = false; return; }
    let n = this.pending;
    this.changing = changed ? this.changing + 1 : 0;
    if (changed) n = Math.max(n, this.changing > 1 ? 1 : this.cascades);
    else if (this.catchUp) n = this.cascades;
    this.catchUp = this.changing > 1;
    if (!this.map) n = this.cascades;
    n = Math.min(this.next.length, n);
    this._viewportCount = n;
    if (this.map) {
      this.map.scissor.set(0, 0, n * this.tile, this.tile);
      this.map.scissorTest = n < this.cascades;
    }
    this.pending = 0;
  }

  updateMatrices(light, k = 0) {
    if (!this.cascades) { super.updateMatrices(light); return; }
    const q = this.next[k], cam = this.camera;
    cam.position.copy(q.c).addScaledVector(q.sun, q.back);
    cam.up.copy(q.up);
    cam.lookAt(q.c);
    cam.left = cam.bottom = -q.r;
    cam.right = cam.top = q.r;
    cam.near = 0;
    cam.far = q.back + q.r;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(_m);
    this.matrix.multiplyMatrices(BIAS, _m);
    this.matrix.toArray(CSM.mats, k * 16);
    const key = ['x', 'y', 'z', 'w'][k];
    CSM.reach[key] = q.dist;
    CSM.bias[key] = -(q.texel + 0.05) / cam.far; // (a texel and 5 cm towards the sun, in the map's depth)
    CSM.normal[key] = q.texel * 1.5;
    this.drawn[k] = q;
  }
}
