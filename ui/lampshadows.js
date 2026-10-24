// The map's lamps keep their light off what is behind walls, floors and roofs, as the game's do: its
// point lights and projectors carry shadowsEnabled (a shadow map) or enableSSCS (its screen-space
// contact shadows); 93 % of the point lights and 81 % of the projectors over all maps have one or the
// other, and a lamp with neither shines through walls in the game too. Without this a lamp inside a
// building lit everything within its reach through the floors: on tower, four 1500-power lamps inside
// two high-rises lit a dozen floors' windows orange, where the game's capture shows two or three
// small red dots.
// Every lamp the view lights (maplights.js picks them) gets the six faces of a cube of distances from
// it, drawn by three's own shadow pass (cut-outs, and the map's placements as the sun's shadows have
// them) into its block of one shared map (the atlas: a single texture, no more samplers for any
// material). A block is drawn once when its lamp is picked and again only when the map's content
// changed (models and textures coming in, objects hidden or broken), never per frame. Lit materials
// look a lamp's block up in xolights.js's light loop, for each lamp lit (XO_LAMP_SHADOWS:
// useLampShadows, called by viewer.js useLocalProbe; a lamp's block, near and far come with its light).
import * as THREE from 'three';

export const POINTS = 16, SPOTS = 8; // = maplights.js MAX_POINT, MAX_SPOT: a block for each
const TILE = 192; // texels across a cube face (a floor slab 3 m off at 40 m: 0.4 m texels)
const COLS = 4, ROWS = 6; // the atlas's blocks of 4 x 2 faces: POINTS + SPOTS of them
const W = COLS * 4 * TILE, H = ROWS * 2 * TILE;
export const POINT_NEAR = 0.5; // metres: what is nearer a point light (its own lamp, the bracket it hangs from) casts no shadow

// Shared by every material that looks lamps up (like fog.js's FOG): the atlas; a block's size in its
// UV, a face texel in a block's v (three's cubeToUV) and a face texel in direction units; the looks
// into a lamp's cube (4: a uniform, so the compiler keeps the loop and builds the lookup once).
export const LAMP = {
  xoLampAtlas: { value: null },
  xoLampInfo: { value: new THREE.Vector4((4 * TILE) / W, (2 * TILE) / H, 1 / (2 * TILE), 2 / TILE) },
  xoLampLooks: { value: 4 },
};

// A material lit by the map's lamps (onBeforeCompile; the atlas, a render target's texture, cannot
// go through ShaderLib's uniforms, which three copies).
export function useLampShadows(shader) {
  Object.assign(shader.uniforms, LAMP);
  shader.fragmentShader = '#define XO_LAMP_SHADOWS\n' + shader.fragmentShader;
}

THREE.ShaderChunk.lights_pars_begin += /* glsl */ `
#ifdef XO_LAMP_SHADOWS
uniform sampler2D xoLampAtlas;
uniform vec4 xoLampInfo;
uniform int xoLampLooks;
// three's cubeToUV (a point light's 4 x 2 faces), a face texel being xoLampInfo.z of the block's height
vec2 xoLampUv( vec3 v ) {
	vec3 absV = abs( v );
	float scaleToCube = 1.0 / max( absV.x, max( absV.y, absV.z ) );
	absV *= scaleToCube;
	v *= scaleToCube * ( 1.0 - 2.0 * xoLampInfo.z );
	vec2 planar = v.xy;
	float almostOne = 1.0 - 1.5 * xoLampInfo.z;
	if ( absV.z >= almostOne ) {
		if ( v.z > 0.0 ) planar.x = 4.0 - v.x;
	} else if ( absV.x >= almostOne ) {
		float signX = sign( v.x );
		planar.x = v.z * signX + 2.0 * signX;
	} else if ( absV.y >= almostOne ) {
		float signY = sign( v.y );
		planar.x = v.x + 2.0 * signY + 2.0;
		planar.y = v.z * signY - 2.0;
	}
	return vec2( 0.125, 0.25 ) * planar + vec2( 0.375, 0.75 );
}
float xoLampDepth( vec2 block, vec3 dir ) {
	return unpackRGBAToDepth( textureLod( xoLampAtlas, block + xoLampUv( dir ) * xoLampInfo.xy, 0.0 ) );
}
// How much of a lamp (W: its place, far; P: its block, near) reaches a point (pos, its normal; all in
// the world, as the cube's faces lie): four looks into its cube around the way to the point.
float xoLampSeen( vec4 W, vec4 P, vec3 pos, vec3 normal ) {
	if ( W.w <= 0.0 ) return 1.0;
	vec3 d = pos - W.xyz;
	float len = length( d );
	if ( len >= W.w || len <= P.z ) return 1.0;
	d += normal * ( len * xoLampInfo.w ); // (a texel off the surface: no acne)
	len = length( d );
	float dp = ( len - 0.03 - P.z ) / ( W.w - P.z );
	vec3 v = d / len;
	float o = xoLampInfo.w, seen = 0.0;
	for ( int t = 0; t < xoLampLooks; t ++ ) {
		vec3 e = t == 0 ? vec3( o, o, o ) : t == 1 ? vec3( o, - o, - o ) : t == 2 ? vec3( - o, o, - o ) : vec3( - o, - o, o );
		seen += step( dp, xoLampDepth( P.xy, v + e ) );
	}
	return 0.25 * seen;
}
#endif
`;

// three's point-light shadow, drawn for one lamp at a time into that lamp's block of the atlas.
const PointLightShadow = new THREE.PointLight().shadow.constructor;
const FACES = [[2, 1], [0, 1], [3, 1], [1, 1], [3, 0], [1, 0]]; // (PointLightShadow's faces in its 4 x 2 map)
const _m = new THREE.Matrix4(), _t = new THREE.Vector3();
class AtlasShadow extends PointLightShadow {
  constructor() {
    super();
    this.mapSize.set(TILE, TILE);
    this._frameExtents.set(COLS * 4, ROWS * 2);
    this.autoUpdate = false;
    // a camera object of its own each time: three uploads a camera's projection and the distance
    // material's reach when the camera changes, and the next lamp's are not the last one's
    this.cams = [this.camera, this.camera.clone()];
    this.flip = 0;
    this.at = new THREE.Vector3();
  }

  // the block to draw (its scissor keeps the rest of the atlas) and the lamp drawn into it
  aim(block, at, near, far) {
    const bx = (block % COLS) * 4, by = Math.floor(block / COLS) * 2;
    this._viewports = FACES.map(([x, y]) => new THREE.Vector4(bx + x, by + y, 1, 1));
    this.camera = this.cams[(this.flip ^= 1)];
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    this.at.copy(at);
    if (this.map) {
      this.map.scissor.set(bx * TILE, by * TILE, 4 * TILE, 2 * TILE);
      this.map.scissorTest = true;
    }
  }

  updateMatrices(light, face = 0) {
    const cam = this.camera;
    cam.position.copy(this.at);
    cam.up.copy(this._cubeUps[face]);
    cam.lookAt(_t.copy(this.at).add(this._cubeDirections[face]));
    cam.updateMatrixWorld();
    this.matrix.makeTranslation(-this.at.x, -this.at.y, -this.at.z);
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(_m);
  }
}

// The atlas and its drawing (one per viewer: viewer.lampShadows). Three's shadow pass works only inside
// a frame (it needs the frame's render state), so the blocks asked for are drawn in the view's next
// frame, right after the sun's shadow and before the lights are set up: a lamp whose shadow is drawn
// lights that same frame (after: the map's lights take their slots' new state).
export class LampShadows {
  constructor(viewer) {
    this.v = viewer;
    this.light = new THREE.PointLight(0xffffff, 0); // (never in the scene: three's shadow pass draws through it)
    this.light.name = 'lamp shadows';
    this.light.castShadow = true;
    this.light.shadow = new AtlasShadow();
    this.queue = []; // { block, at, near, far, done }
    this.after = null;
    this.drawn = 0; // (blocks drawn, for tests)
    this.uniforms = LAMP; // (tests)
    this.tile = TILE;
    this.cols = COLS;
    const sm = viewer.renderer.shadowMap;
    this.base = sm.render;
    sm.render = (lights, scene, camera) => {
      this.base.call(sm, lights, scene, camera);
      if (this.queue.length && scene === viewer.scene) this.flush(scene, camera);
    };
  }

  // A lamp's cube into a block in the next frame (block: 0 .. POINTS + SPOTS - 1; near, far in metres;
  // done: called once it is drawn).
  draw(block, at, near, far, done) {
    this.queue.push({ block, at: at.clone(), near, far, done });
    this.v.dirty = true;
  }

  flush(scene, camera) {
    const sm = this.v.renderer.shadowMap, sh = this.light.shadow, was = sm.needsUpdate;
    for (const j of this.queue.splice(0)) {
      sh.aim(j.block, j.at, j.near, j.far);
      this.light.position.copy(j.at); // (the distance material measures from the light's place)
      this.light.updateMatrixWorld();
      sh.needsUpdate = true;
      sm.needsUpdate = true;
      this.base.call(sm, [this.light], scene, camera);
      if (sh.map && LAMP.xoLampAtlas.value !== sh.map.texture) LAMP.xoLampAtlas.value = sh.map.texture; // (the first draw made it, at the atlas's size)
      this.drawn++;
      j.done?.();
    }
    sm.needsUpdate = was; // (the sun's shadow keeps its own schedule: viewer.js render)
    this.after?.();
  }

  // Where block k lies in the atlas's UV (its lower left corner).
  static corner(block) {
    return [((block % COLS) * 4 * TILE) / W, (Math.floor(block / COLS) * 2 * TILE) / H];
  }
}

