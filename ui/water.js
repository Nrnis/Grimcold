// A map's water and acid (/mapscene water: Helpers_WaterVolume and Helpers_AcidVolume, see
// xo::MapWater), drawn the way the game's legacy water shader reads its settings:
//  - waves: the animated normal frames (/frames: 64 of them, cross-faded) and the two layers'
//    detail normal maps, each layer tiled, scrolled along its direction at its speed and as strong as
//    its bump height; the noise map makes them stronger and weaker in patches (no repeats show)
//  - the surface mirrors the sky (scene.environment) by water's Fresnel term (index 1.333) alone, as
//    strongly at grazing angles as the game's pictures show it (REFLECT), and the sun in a glint
//    along the waves, in the sun's shadows
//  - under it, the bed fades into the water's colour (the light it scatters, lit by the sun and the
//    sky) as 1 - exp(-density x the metres the view ray runs through it to the bed); the metres come
//    from a map of the water's depth baked from the terrain (bake), so the shallows show their bed (and
//    still mirror the sky and the sun), deep water is its colour, and the waterline is soft (it writes
//    depth: occlusion and haze see the surface, not the bed)
//  - acid (type 1) lets no light through: a glossy sheet of its colour, soft only at its very edge
//    (customgame_fiery_river's probe picture; the game's textures/water/acid_a, a yellow albedo,
//    turned it a yellow the picture does not have). Rusty water (type 2) is water of a rusty colour:
//    island's sea, its loading picture shows no dirt layer on it
//  - seen from below, the surface is a dark ceiling, and the view sinks into the water's colour
//    (mapview.js: the haze becomes the water's while the camera is under its level)
// The game's own tiling, frame rate, wave strength and roughness live in its encrypted shaders: the
// constants below were fitted to its light-probe pictures of bridge, customgame_mountain_lake and
// customgame_fiery_river (CROSSOUT_FORMATS.md "Water"), the light ones (WAVES, RIPPLES, ROUGH,
// BODY, the path, the reflection's weight) again under the game's own light (the probes as the
// environment, its units and exposure), measured in linear light against the same pictures and
// fieldbattle's and island's. Calm water (user3 = 1) needs
// nothing of its own: its frames and detail maps are flat.
// Crossout 2.41's water (every volume) has no detail maps: its base waves are frames as above, at their
// own rate (fps), and its flow waves a second layer of frames (XO_FLOW; their own texture on 4 volumes,
// XO_FLOW_OWN), carried by the weather's wind and, on the maps with a flow map, by the rivers' currents
// (XO_CURRENT: two phases cross-faded, as flow maps are drawn).
import * as THREE from 'three';
import { windNow } from './foliage.js';
import { builders } from './warmup.js';
import { useLocalProbe } from './viewer.js';

const DATA = 'https://xo.data';
const enc = encodeURIComponent;
// (the map export draws the water with the same TILE, WAVES, RIPPLES, ROUGH and BODY: src/xo/Map.cpp kWaterTile ...)
const TILE = 8;              // metres one repeat of the wave maps covers at tiling 1
const FPS = 15;              // the wave frames' rate (Crossout 2.41's volumes give theirs: fps)
// Crossout 2.41's flow waves go with the wind: metres a second per unit of its force (a wind of 0.3,
// bridge's, carries them 0.4 m/s: 2.40's bridge river's second layer, 0.05 tiles a second of 8 m)
const WIND_SPEED = 1.33;
const CYCLE = 1;             // seconds a phase of the currents runs before it fades out (XO_CURRENT)
// The waves' slopes per unit of bump height: the wave frames' and the detail maps'. With the sun at the
// game's strength the sun's glint off the waves, measured at the probes' resolution (0.35 degrees),
// carries about the probe's own light over the water's at these (bridge's river 1,500 against the
// game's 1,040, the mountain lake's glint-less view 370 against 0); twice as steep (1.2 / 0.6,
// fitted under the old, weaker sun) it carried 3.3 and 5.5 times as much at this gloss.
const WAVES = 0.6;
const RIPPLES = 0.3;
const NOISE_TILE = 48;       // metres the noise map covers at noiseTiling 1
const SHORE = 0.08;          // metres of depth over which the surface fades in at the waterline (no stair-stepped edge)
// Roughness looking straight down and along the surface: 1 - the gloss the legacy volumes carry
// (waterGlossF0 0.9, waterGlossF90 0.65; the 12 layered ones 0.9 / 0.9). The fiery river's acid (no
// waves to speak of) glints as the game's probe shows it with these: a peak of 656 against 599 over
// 6,650 pixels against 6,660 at the probe's resolution (0.2 / 0.4: a peak of 88 smeared over 12,370).
const ROUGH = [0.1, 0.35];
// The light the water scatters back, against a plain surface of its colour (Lambert) under the same
// light: on the fiery river's probe (HDR) its acid sends 0.74 of what the terrain beside it would
// with that albedo. With it the acid sits as far from the game's as the terrain beside it does
// (0.03-0.09 EV over, it was 0.38-0.44), and the mountain lake's deep water turns the game's teal.
const BODY = 0.74;
const ACID = 3;              // acid is this much denser than its density says
const FLAT = 'textures/nm';  // the game's flat normal map (4 x 4): no waves from it
const SEEN_TILE = 64;        // metres (at least): the tiles of a surface tested against the view (Water.seen)
const _pv = new THREE.Matrix4(), _view = new THREE.Frustum();

const VERT_HEAD = /* glsl */ `
varying vec3 vXoWater;
`;
const FRAG_HEAD = /* glsl */ `
varying vec3 vXoWater;
uniform highp sampler2DArray xoFrames;
uniform sampler2D xoDetail0, xoDetail1, xoNoise, xoDepth;
uniform vec4 xoLayer0, xoLayer1; // UV per metre, scroll offset (xy), strength
uniform vec4 xoFrame;            // the two frames shown, their mix, how strong
uniform vec4 xoFrame1;           // the same for the flow waves' (XO_FLOW)
uniform vec2 xoAG;               // the detail maps pack x in alpha (DXT5nm): 1
uniform vec4 xoDepthRect;        // the depth map: x0, z0 (glTF), 1 / its width, 1 / its depth (metres; 0: none)
uniform vec3 xoLook;             // density, depth without a map, noise UV per metre
vec2 xoSlope( vec4 s, float ag ) { return ( ag > 0.5 ? s.ag : s.rg ) * 2.0 - 1.0; }
#ifdef XO_FLOW
	#ifdef XO_FLOW_OWN
		uniform highp sampler2DArray xoFlowFrames;
		#define XO_FLOW_TEX xoFlowFrames
	#else
		#define XO_FLOW_TEX xoFrames
	#endif
	vec2 xoFlowAt( vec2 uv ) { return mix( texture( XO_FLOW_TEX, vec3( uv, xoFrame1.x ) ).rg, texture( XO_FLOW_TEX, vec3( uv, xoFrame1.y ) ).rg, xoFrame1.z ) * 2.0 - 1.0; }
#endif
#ifdef XO_CURRENT
	uniform sampler2D xoCurrent;  // the map's flow map: x in alpha, z in green
	uniform vec4 xoCurrentRect;   // its square: x0, the z of its first row (game), 1 / its width, 1 / its depth
	uniform vec4 xoCurrentPhase;  // the two phases' seconds, the first one's weight, tiles a second at a full current
#endif
float xoFresnel( float nv ) { return 0.02 + 0.98 * pow( 1.0 - nv, 5.0 ); } // (Schlick, index 1.333)
`;
// in place of normal_fragment_maps: the waves, and how rough they leave the surface
const FRAG_WAVES = /* glsl */ `
	vec2 xoG = vec2( vXoWater.x, - vXoWater.z ); // game x, z: the maps run along them
	vec2 xoUv0 = xoG * xoLayer0.x + xoLayer0.yz, xoUv1 = xoG * xoLayer1.x + xoLayer1.yz;
	vec2 xoD = xoSlope( texture2D( xoDetail0, xoUv0 ), xoAG.x ) * xoLayer0.w + xoSlope( texture2D( xoDetail1, xoUv1 ), xoAG.y ) * xoLayer1.w;
	#ifdef XO_FRAMES
		xoD += ( mix( texture( xoFrames, vec3( xoUv0, xoFrame.x ) ).rg, texture( xoFrames, vec3( xoUv0, xoFrame.y ) ).rg, xoFrame.z ) * 2.0 - 1.0 ) * xoFrame.w;
	#endif
	#ifdef XO_FLOW
		#ifdef XO_CURRENT
			vec2 xoC = ( texture2D( xoCurrent, vec2( xoG.x - xoCurrentRect.x, xoCurrentRect.y - xoG.y ) * xoCurrentRect.zw ).ag * 2.0 - 1.0 ) * xoCurrentPhase.w;
			xoD += mix( xoFlowAt( xoUv1 - xoC * xoCurrentPhase.y + 0.5 ), xoFlowAt( xoUv1 - xoC * xoCurrentPhase.x ), xoCurrentPhase.z ) * xoFrame1.w;
		#else
			xoD += xoFlowAt( xoUv1 ) * xoFrame1.w;
		#endif
	#endif
	xoD *= 0.5 + texture2D( xoNoise, xoG * xoLook.z ).r;
	normal = normalize( ( viewMatrix * vec4( normalize( vec3( xoD.x, 1.0, - xoD.y ) ), 0.0 ) ).xyz );
	roughnessFactor = mix( ${ROUGH[0].toFixed(2)}, ${ROUGH[1].toFixed(2)}, pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 5.0 ) );
`;
// in place of lights_fragment_end: the sky's mirror image (sampled as three does, at the roughness)
// weighted by water's Fresnel term alone. three's own weight (the split-sum DFGApprox) also takes off
// what a rough surface loses at grazing angles: at the 0.35 of a glancing view it mirrors 0.36 of the
// sky where the Fresnel term says 0.63 (5 degrees). The game's captures show its water at grazing
// angles brighter than that: in linear light, with the body lit as the ground beside it is (its
// error taken out), water seen 6-20 degrees down was -0.23..-0.20 EV on fieldbattle, -0.38..-0.15 on
// bridge, -0.40..-0.38 on the mountain lake and -0.38..-0.34 on island's sea; with this weight
// -0.03..+0.05, 0.00..+0.12, -0.26..-0.17 and -0.12..+0.06 (views steeper than 25 degrees within
// 0.04, the fiery river's acid within 0.02). waterReflectanceF0 / F90 (1 / 0.75 on the legacy
// volumes) read as a loss towards grazing angles came out worse on the mountain lake and bridge.
const REFLECT = /* glsl */ `
#if defined( RE_IndirectDiffuse )
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
	{
		float xoRF = xoFresnel( saturate( dot( geometryNormal, geometryViewDir ) ) );
		reflectedLight.indirectSpecular += radiance * xoRF;
		reflectedLight.indirectDiffuse += material.diffuseColor * ( 1.0 - xoRF ) * iblIrradiance * RECIPROCAL_PI;
	}
`;
// in place of opaque_fragment: the reflection over the water's body over the bed (premultiplied: the
// bed, already drawn, keeps what the water lets through). The bed is seen through as many metres of
// water as the view ray crosses to it (depth / sine of the view's elevation), as a depth-buffer water
// does, not along the ray bent into the water: on the mountain lake's probe the deep water is the
// game's teal that way (the bent ray, 1.7-2.1 times shorter at 20-25 degrees down, showed the sand
// under it and turned it grey), and bridge's shallow pool is as dark against its bank as in the game's
// picture (0.08 EV off, the bent ray 0.30).
const FRAG_OUT = /* glsl */ `
	float xoDeep = xoDepthRect.z > 0.0 ? texture2D( xoDepth, ( vXoWater.xz - xoDepthRect.xy ) * xoDepthRect.zw ).r : xoLook.y;
	float xoNV = saturate( dot( normal, normalize( vViewPosition ) ) );
	float xoF = xoFresnel( xoNV );
	float xoCosV = max( 0.02, dot( normalize( vViewPosition ), normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) ); // (the view ray against the level surface)
	float xoMurk = 1.0 - exp( - xoLook.x * xoDeep / xoCosV ); // (how much of the bed the water hides)
	float xoShore = smoothstep( 0.0, ${SHORE.toFixed(2)}, xoDeep );
	gl_FragColor = vec4( totalSpecular + totalDiffuse * ${BODY.toFixed(2)} * xoMurk, 1.0 - ( 1.0 - xoF ) * ( 1.0 - xoMurk ) ) * xoShore;
`;
// the fog (fog.js) over premultiplied colour: what is behind it was fogged already
const FOG_MIX = 'gl_FragColor.rgb * xoFog.a + xoFog.rgb;';
const FOG_OUT = THREE.ShaderChunk.fog_fragment.replace(FOG_MIX, 'gl_FragColor.rgb * xoFog.a + xoFog.rgb * gl_FragColor.a;');
if (!THREE.ShaderChunk.fog_fragment.includes(FOG_MIX)) console.warn('water fog patch did not apply (fog.js changed?)');
if (!THREE.ShaderLib.physical.fragmentShader.includes('#include <lights_fragment_end>')) console.warn('water reflection patch did not apply (three.js changed?)');

// "XOFR": u32 width, height, frames, then two bytes (the normal's x, y) per texel
function parseFrames(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x52464f58) throw new Error('bad frames data');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), n = dv.getUint32(12, true);
  const t = new THREE.DataArrayTexture(new Uint8Array(buf, 16, w * h * 2 * n), w, h, n);
  t.format = THREE.RGFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const MID = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1); // (a flat normal, mid noise, until the maps are in)
MID.needsUpdate = true;
const NO_FRAMES = new THREE.DataArrayTexture(new Uint8Array([128, 128]), 1, 1, 1);
NO_FRAMES.format = THREE.RGFormat;
NO_FRAMES.needsUpdate = true;

// A water's material and its uniforms (the maps stand in until they come: MID, NO_FRAMES). XO_FRAMES
// from the start when it has wave frames (flat until they come, at strength 0): the shader it ends with;
// Crossout 2.41's flow waves (XO_FLOW, their own frames XO_FLOW_OWN) and currents (XO_CURRENT: flow, the
// map's flow map's square) likewise.
function waterMaterial(w, flow = null) {
  const [r, gr, b] = w.color || [52, 51, 50];
  const color = new THREE.Color().setRGB(r / 255, gr / 255, b / 255, THREE.SRGBColorSpace);
  const per = (tiling) => (tiling > 0 ? tiling : 1) / TILE;
  const u = {
    xoFrames: { value: NO_FRAMES }, xoDetail0: { value: MID }, xoDetail1: { value: MID }, xoNoise: { value: MID }, xoDepth: { value: MID },
    xoLayer0: { value: new THREE.Vector4(per(w.tiling?.[0]), 0, 0, 0) }, xoLayer1: { value: new THREE.Vector4(per(w.tiling?.[1]), 0, 0, 0) },
    xoFrame: { value: new THREE.Vector4(0, 1, 0, 0) }, xoAG: { value: new THREE.Vector2(1, 1) },
    xoFrame1: { value: new THREE.Vector4(0, 1, 0, 0) }, xoFlowFrames: { value: NO_FRAMES }, xoCurrent: { value: MID },
    xoCurrentRect: { value: flow ? new THREE.Vector4(flow.x0, flow.z0 + flow.sizeZ, 1 / flow.sizeX, 1 / flow.sizeZ) : new THREE.Vector4() },
    xoCurrentPhase: { value: new THREE.Vector4(0, 0, 1, w.current || 0) },
    xoDepthRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    xoLook: { value: new THREE.Vector3((w.density || 1) * (w.type === 1 ? ACID : 1), Math.max(0.5, w.depth || 1), (w.noiseTiling > 0 ? w.noiseTiling : 1) / NOISE_TILE) },
  };
  const m = new THREE.MeshStandardMaterial({ color, roughness: ROUGH[0], metalness: 0 });
  m.transparent = true;
  m.depthWrite = true; // (ambient occlusion and haze see the surface, not the bed under it)
  m.blending = THREE.CustomBlending; // premultiplied: FRAG_OUT
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    useLocalProbe(shader); // (a hangar's basin mirrors the hall: viewer.js LOCAL_PROBE)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvXoWater = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <normal_fragment_maps>', FRAG_WAVES)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n\tmaterial.specularColor = vec3( 0.02 ); // (water: index 1.333)')
      .replace('#include <lights_fragment_end>', REFLECT)
      .replace('#include <opaque_fragment>', FRAG_OUT)
      .replace('#include <fog_fragment>', FOG_OUT);
  };
  m.customProgramCacheKey = () => 'xo-water-4';
  const frames = !!(w.frames && w.frames !== FLAT), flows = frames && !!w.flowFrames;
  const own = flows && w.flowFrames !== w.frames, current = flows && !!flow && w.current > 0;
  if (frames) m.defines = { XO_FRAMES: '', ...(flows ? { XO_FLOW: '' } : {}), ...(own ? { XO_FLOW_OWN: '' } : {}), ...(current ? { XO_CURRENT: '' } : {}) };
  m.userData.warmKind = 'water'; // (warmup.js)
  m.userData.warmArgs = { frames, flows, own, current };
  return { m, u, color };
}
// seen from below: the underside of a water's surface, dark with its colour
const underMaterial = (color) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.BackSide });
  m.userData.warmKind = 'under';
  return m;
};
builders.water = (a) => waterMaterial({ frames: a.frames ? 'frames' : null, flowFrames: a.flows ? (a.own ? 'own' : 'frames') : null, current: a.current ? 1 : 0 },
  a.current ? { x0: 0, z0: 0, sizeX: 1, sizeZ: 1 } : null).m;
builders.under = () => underMaterial(new THREE.Color());

export class Water {
  // list: /mapscene water; flow: /mapscene waterFlow (Crossout 2.41: the rivers' currents, or null)
  constructor(viewer, list, flow = null) {
    this.v = viewer;
    this.flow = flow;
    this.group = new THREE.Group();
    this.group.name = 'water';
    this.entries = [];       // the viewer's texture cache entries held
    this.frames = new Map(); // folder -> Promise<DataArrayTexture>
    this.depths = [];        // baked depth maps
    this.items = [];         // { w, mesh, m: its material, u: its uniforms, dir: its layers' directions }
    this.t0 = performance.now();
    this.seen = -Infinity;   // when water was last drawn with its surface in view
    this.last = 0;
    this.disposed = false;
    for (const w of list) this.add(w);
  }

  add(w) {
    const pts = [];
    for (let i = 0; i + 1 < w.outline.length; i += 2) pts.push(new THREE.Vector2(w.outline[i], w.outline[i + 1]));
    if (pts.length < 3) return;
    const pos = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = w.level; pos[i * 3 + 2] = p.y; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pts.length * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    // (wound to face up, whichever way the outline runs: only the top is the water's surface)
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    let up = 0;
    for (const [a, b, c] of tris) up += (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x) - (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y);
    g.setIndex(tris.flatMap(([a, b, c]) => (up >= 0 ? [a, b, c] : [a, c, b])));
    g.computeBoundingSphere();
    // where the surface lies, as the boxes of its triangles by tile (at most 16 x 16): a long river's
    // bounding sphere holds the camera, so it is in view from almost anywhere, looking at the sky too
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.y); z1 = Math.max(z1, p.y); }
    const tx = Math.max(SEEN_TILE, (x1 - x0) / 16), tz = Math.max(SEEN_TILE, (z1 - z0) / 16), tiles = new Map();
    for (const t of tris) {
      const k = Math.floor(((pts[t[0]].x + pts[t[1]].x + pts[t[2]].x) / 3 - x0) / tx) * 64 + Math.floor(((pts[t[0]].y + pts[t[1]].y + pts[t[2]].y) / 3 - z0) / tz);
      let b = tiles.get(k);
      if (!b) tiles.set(k, (b = new THREE.Box3(new THREE.Vector3(Infinity, w.level - 0.1, Infinity), new THREE.Vector3(-Infinity, w.level + 0.1, -Infinity))));
      for (const i of t) {
        b.min.x = Math.min(b.min.x, pts[i].x); b.max.x = Math.max(b.max.x, pts[i].x);
        b.min.z = Math.min(b.min.z, pts[i].y); b.max.z = Math.max(b.max.z, pts[i].y);
      }
    }
    const boxes = [...tiles.values()];
    const { m, u, color } = waterMaterial(w, this.flow);
    const dir = (deg) => [Math.cos(THREE.MathUtils.degToRad(deg)), Math.sin(THREE.MathUtils.degToRad(deg))];
    const mesh = new THREE.Mesh(g, m);
    mesh.name = w.name || 'water';
    mesh.renderOrder = 2; // (after the decals: those on the bed show through it)
    mesh.receiveShadow = true;
    mesh.onBeforeRender = (r, s, cam) => { // (drawn: three found its bounding sphere in view; is some of its surface?)
      _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _view.setFromProjectionMatrix(_pv);
      if (boxes.some((b) => _view.intersectsBox(b))) this.seen = performance.now();
    };
    const under = new THREE.Mesh(g, underMaterial(color.clone().multiplyScalar(0.6)));
    under.name = 'underside';
    mesh.add(under);
    this.group.add(mesh);
    const item = { w, mesh, u, m, dir: [dir(w.dir?.[0] || 0), dir(w.dir?.[1] || 0)] };
    this.items.push(item);
    this.textures(item);
  }

  // the maps a water draws with (shared through the viewer's texture cache)
  textures(item) {
    const { w, u, m } = item;
    const tex = (base, role, slot, then) => {
      if (!base) return;
      const e = this.v.acquireTexture(base, role, 0);
      this.entries.push(e);
      e.promise.then(({ tex: t, head }) => {
        if (this.disposed) return;
        u[slot].value = t;
        then?.(head);
        this.v.dirty = true;
      }, () => {});
    };
    w.detail?.forEach((base, k) => {
      if (base === FLAT) return;
      u[k ? 'xoLayer1' : 'xoLayer0'].value.w = RIPPLES * (w.bump?.[k] ?? 1);
      tex(base, 'normal', k ? 'xoDetail1' : 'xoDetail0', (head) => (u.xoAG.value.setComponent(k, head.layout === 'AG' ? 1 : 0)));
    });
    tex(w.colorMap, 'noise', 'xoNoise');
    if (w.frames && w.frames !== FLAT) {
      if (!this.frames.has(w.frames))
        this.frames.set(w.frames, fetch(`${DATA}/frames?dir=${enc(w.frames)}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b && !this.disposed ? parseFrames(b) : null)));
      this.frames.get(w.frames).then((t) => {
        if (!t || this.disposed) return;
        u.xoFrames.value = t;
        u.xoFrame.value.w = WAVES * (w.bump?.[0] ?? 1); // (XO_FRAMES all along: waterMaterial)
        this.v.dirty = true;
      }, () => {});
    }
    // Crossout 2.41's flow waves: the legacy second layer's strength (the 2.40 volumes with both shaders
    // hold flowWaveNormalStrength equal to that layer's bump), from their own frames or the base waves'
    const ff = w.flowFrames;
    if (ff && ff !== FLAT && w.frames && w.frames !== FLAT) {
      if (!this.frames.has(ff))
        this.frames.set(ff, fetch(`${DATA}/frames?dir=${enc(ff)}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b && !this.disposed ? parseFrames(b) : null)));
      this.frames.get(ff).then((t) => {
        if (!t || this.disposed) return;
        u.xoFlowFrames.value = t;
        u.xoFrame1.value.w = RIPPLES * (w.bump?.[1] ?? 1);
        this.v.dirty = true;
      }, () => {});
    }
    if (this.flow && w.current > 0 && ff) tex(this.flow.map, 'flow', 'xoCurrent', () => {
      const t = u.xoCurrent.value; // (the currents past the square's edge are its edge's)
      if (t.wrapS !== THREE.ClampToEdgeWrapping) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; }
    });
  }

  // How deep the water is under each point (level - ground: heightAt(x, z), glTF), one map per
  // water; texels about as far apart as the ground's heights, at most 512 a side.
  bake(heightAt, step) {
    for (const { w, u } of this.items) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i + 1 < w.outline.length; i += 2) {
        x0 = Math.min(x0, w.outline[i]); x1 = Math.max(x1, w.outline[i]);
        z0 = Math.min(z0, w.outline[i + 1]); z1 = Math.max(z1, w.outline[i + 1]);
      }
      const texel = Math.max(step, (x1 - x0) / 512, (z1 - z0) / 512);
      const nx = Math.max(2, Math.ceil((x1 - x0) / texel)), nz = Math.max(2, Math.ceil((z1 - z0) / texel));
      const data = new Uint16Array(nx * nz);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const d = w.level - heightAt(x0 + (i + 0.5) * texel, z0 + (j + 0.5) * texel); // (off the terrain: deep)
          data[j * nx + i] = THREE.DataUtils.toHalfFloat(Math.min(64, Math.max(0, d)));
        }
      }
      const t = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      this.depths.push(t);
      u.xoDepth.value = t;
      u.xoDepthRect.value.set(x0, z0, 1 / (nx * texel), 1 / (nz * texel));
    }
    this.v.dirty = true;
  }

  // The waves move on, 30 times a second, while water is on screen; true when they did.
  tick() {
    const now = performance.now();
    if (now - this.seen > 500 || now - this.last < 1000 / 30) return false;
    this.last = now;
    this.setTime((now - this.t0) / 1000);
    return true;
  }

  // Every water as it is t seconds in (the offsets wrapped here, where the numbers are exact). Crossout
  // 2.41's flow waves go with the weather's wind (WIND_SPEED m/s per unit of its force) x the volume's
  // windSpeedMultiplier, each layer's flipbook at its own rate, the currents' two phases CYCLE apart.
  setTime(t) {
    const wrap = (v) => v - Math.floor(v), wind = windNow();
    const frame = (F, f, n) => { F.x = Math.floor(f); F.y = (Math.floor(f) + 1) % n; F.z = f - Math.floor(f); };
    const p = wrap(t / CYCLE), q = wrap(t / CYCLE + 0.5);
    for (const { w, u, dir } of this.items) {
      for (const [k, L] of [[0, u.xoLayer0.value], [1, u.xoLayer1.value]]) {
        const s = w.speed?.[k] || 0;
        L.y = wrap(dir[k][0] * s * t);
        L.z = wrap(dir[k][1] * s * t);
      }
      if (w.windMul) {
        const L = u.xoLayer1.value, s = WIND_SPEED * wind.force * w.windMul * L.x; // (tiles a second)
        L.y = wrap(-wind.x * s * t);
        L.z = wrap(-wind.z * s * t);
      }
      const fps = w.fps || [FPS, FPS], n = u.xoFrames.value.image.depth, n1 = u.xoFlowFrames.value.image.depth;
      frame(u.xoFrame.value, (t * fps[0]) % n, n);
      frame(u.xoFrame1.value, (t * fps[1] + n1 / 2) % n1, n1);
      if (w.current) u.xoCurrentPhase.value.set(p * CYCLE, q * CYCLE, 1 - Math.abs(2 * p - 1), w.current);
    }
  }

  dispose() {
    this.disposed = true;
    for (const e of this.entries) this.v.tex.release(e);
    for (const p of this.frames.values()) p.then((t) => t?.dispose(), () => {});
    for (const t of this.depths) t.dispose();
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.group.parent?.remove(this.group);
  }
}
