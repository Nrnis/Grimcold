// Grass and trees in Maps: what the game's vegetation shaders add to the plain material (viewer.js
// makeMaterial), patched onto it here.
//   grass   lit like the ground it grows on (its cards' own normals point up, on both sides), as
//           bright as its preset's luminance_modifier says, tinted per tuft by the ground under it
//           (the host's /mapgrass tints: xo::grassTints), light shining through the blades towards
//           the camera (the gloss map's red channel: a ramp from about 0.25 at the tips to 0 at the
//           roots), only a faint sheen, and swaying in the wind; under the weather's cover on the
//           land it takes the cover's colour where the cover lies complete and sinks into it where
//           it lies deeper (COVER_* below)
//   trees   (SpeedTree 06bc377b) leaves let the sun through by their atlas' alpha squared (0 on
//           twigs, about 0.2-0.4 on broad leaves, 0.03-0.1 on conifers' needles: spruce 0.06,
//           pine 0.03-0.09, cryptomeria 0.1), also where their own crown shades them (thinned by
//           its depth), are darker inside the crown, and the whole tree sways; under a deep cover
//           (snow) the leaves of living trees (User1 = 1) take it all over, whichever way they face;
//           the far picture (billboard: four crossed vertical planes, both ways round, and a level
//           one) is cut at its mask's own edge and fades each plane out as it turns edge-on
// The wind is the environment's (WindForce, WindYaw) times each grass kind's wind_intensity; it
// moves on only while the view is redrawn anyway (the camera moving, driving), so a still view
// costs nothing.
import * as THREE from 'three';

// Tunables, fitted against the game's light-probe captures (xotest probe: each environment's HDR
// capture graded like the view, the app's camera at the capture's centre, conifers, broad leaves and
// grass measured apart by their own masks; 8 environments of 7 maps, 53 views) and loading pictures.
// Under the game's light levels (its sun about 5x the sky on a clear day) the older fit's light
// through and grass sheen were too strong where they should be weak and too weak where the crown
// shades itself: backlit conifers glowed yellow-green (periphery's sunset, lost_coast, newyear_foray:
// +0.3 to +0.7 EV against the captures' dark blue-green, with the leaves' shadows missing +1.5 to
// +1.9; now 0 to +0.4), backlit bushes' insides stayed dark (broad leaves -0.26 EV on average, now
// 0.00), the grass took a pale sheen of the sky and the sun's glint (overcast arena_football +0.5 to
// +1.3 EV, towards the sun +0.9, sunny grass 9-16 % blue against the game's 5-10 %; now +0.2 to +0.45,
// +0.1 to +0.4, 7-12 %).
const GRASS_SWAY = 0.25;    // metres at a blade's tip per unit of WindForce x wind_intensity
const TREE_SWAY = 0.02;     // a tree's top moves this share of its height at WindForce 1
const LEAF_FLUTTER = 0.05;  // metres a leaf trembles at the top of a tree, WindForce 1
const GRASS_THROUGH = 1;    // light through a blade: the gloss map's red x this (at most 1)
const GRASS_SHEEN = 0.4;    // the blades' specular (sky and sun mirrored) against a plain surface's
const LEAF_THROUGH = 6;     // light through a leaf: the atlas' alpha squared x this (at most 1)
const CROWN_DENSITY = 0.15; // of the sun's light through a crown, what each metre of it takes
const CROWN_SHADE = 0.55;   // the sky's light deep inside a crown (1 = none taken away)
const BACKLIGHT = 2;        // how narrowly the light through grass gathers around the sun
const SCATTER = 0.36;       // the light through leaves around the sun: Unreal's two-sided foliage lobe

// The weather's cover (envsettings Dust*: snow, sand, a wet film) on the vegetation. Its height rule -
// the land's (mask - 1 + DustLandHeight) / (1 - DustLandSharpness), the props' the same with DustHeight
// and DustSharpness - is 1 where the cover just lies complete; the game's captures show what it does
// past that. New Year snow (3.5 on the land, 2.95 on props) leaves no grass on bridge, castle and the
// hangar and turns their bushes white all over (the app had green tufts and leaves there); geopp's
// masked snow hides its scrub where it lies and leaves it beside; the sandstorm (1.0 on both, half
// see-through) makes sand_valley's scrub sand-coloured lumps; under Halloween's dark film (0.84),
// fix_dull_rain (0.80: drcross' tufts dark on its shining wet ground) and newyear_foray's thin snow
// (0.55) tufts and leaves stay as they are; the gloomy rains (1.07) darken the tufts with their film
// (helicopter_valley's capture: dark tufts);
// bridge's ivy (User1 0, as ferns and dead trees) stays green under the snow, its trees' leaves (User1 1) not.
const COVER_COAT = [0.9, 1.1]; // the blades take the cover's colour over this stretch of the land's rule
const COVER_SINK = [1.1, 2];   // ... and sink into it over this one (gone at twice the complete cover)
const COVER_LEAF = [1.1, 2];   // leaves of living trees take the cover all over across this stretch of the props' rule

// Shared by every vegetation material (three passes uniform objects by reference).
const WIND = { xoWindTime: { value: 0 }, xoWindDir: { value: new THREE.Vector2(0, -1) }, xoWindForce: { value: 0.3 } };

// The environment's wind (its preset values: WindForce, WindYaw in degrees; null = the usual breeze).
export function setWind(values) {
  const force = Number(values?.WindForce), yaw = THREE.MathUtils.degToRad(Number(values?.WindYaw) || 0);
  WIND.xoWindForce.value = Number.isFinite(force) ? Math.max(0, force) : 0.3;
  WIND.xoWindDir.value.set(Math.sin(yaw), -Math.cos(yaw)); // (game +Z is -z here)
}

// The wind now: its force and the way it blows (game x, z).
export function windNow() { return { force: WIND.xoWindForce.value, x: WIND.xoWindDir.value.x, z: -WIND.xoWindDir.value.y }; }

// Moves the wind on by dt seconds (called for frames that are drawn anyway).
export function stepWind(dt) { WIND.xoWindTime.value += dt; }

// The sway: a lean along the wind that swells and eases, gusts running across the map, stronger
// higher up (local height / top, squared). amount: metres at the top for WindForce 1.
const SWAY_VERT = /* glsl */ `
uniform float xoWindTime, xoWindForce;
uniform vec2 xoWindDir;
uniform vec3 xoSway; // metres at the top for WindForce 1, the top (model units), leaf flutter (metres)
vec3 xoWind( vec3 local, vec3 root, float scale ) {
	float h = clamp( local.y / xoSway.y, 0.0, 1.0 );
	float gust = 0.65 + 0.35 * sin( dot( root.xz, xoWindDir ) * 0.04 - xoWindTime * 1.1 );
	float swing = 0.55 + 0.3 * sin( xoWindTime * 1.6 + dot( root.xz, vec2( 0.13, 0.21 ) ) ) + 0.15 * sin( xoWindTime * 3.7 + root.x * 0.7 );
	vec3 lean = vec3( xoWindDir.x, 0.0, xoWindDir.y ) * ( xoSway.x * scale * h * h * gust * swing );
	float f = dot( local, vec3( 3.1, 2.3, 1.7 ) ) + xoWindTime * 5.0;
	return ( lean + vec3( sin( f ), 0.5 * sin( f * 1.3 ), cos( f * 0.9 ) ) * ( xoSway.z * h ) ) * xoWindForce;
}`;
// (after the copy's own placement: the wind blows in world space)
const SWAY_PROJECT = THREE.ShaderChunk.project_vertex.replace('mvPosition = instanceMatrix * mvPosition;',
  'mvPosition = instanceMatrix * mvPosition;\n\tmvPosition.xyz += xoWind( transformed, instanceMatrix[ 3 ].xyz, length( instanceMatrix[ 1 ].xyz ) );');

// The land's cover at a tuft's root, by the ground's own rule and settings (mapview.js SPLAT_MAP, the
// terrain material's xoDust uniforms: the mask at the root, off slopes with DustByNormals): how deep it
// lies there (1 = the ground just covered), how much of its colour the blades take (vXoCoat: whole
// even where the ground's cover is drawn half see-through - the sandstorm's lumps are sand-coloured;
// at a quarter, the half see-through share, they stayed dark), how far they sink into it.
const LAND_COVER_VERT = /* glsl */ `
uniform vec4 xoLandDust;   // the land's cover: height, 1 / (1 - sharpness), transparency (0: no cover), by normals (1), by height (2: not on the blades)
uniform vec2 xoLandMaskOn; // 1 / the mask's tiling (metres), on (1)
uniform sampler2D xoLandMask;
varying float vXoCoat;`;
const LAND_COVER_PROJECT = /* glsl */ `
	vXoCoat = 0.0;
	if ( xoLandDust.z > 0.0 && xoLandDust.w < 1.5 ) {
		vec3 xoRoot = ( modelMatrix * instanceMatrix[ 3 ] ).xyz;
		float xoMask = xoLandMaskOn.y > 0.5 ? textureLod( xoLandMask, vec2( xoRoot.x, - xoRoot.z ) * xoLandMaskOn.x, 0.0 ).r : 1.0;
		float xoUpF = xoLandDust.w > 0.5 ? smoothstep( 0.25, 0.65, normalize( mat3( modelMatrix ) * instanceMatrix[ 1 ].xyz ).y ) : 1.0;
		float xoDeep = ( xoMask - 1.0 + xoLandDust.x ) * xoLandDust.y * xoUpF;
		vXoCoat = smoothstep( ${COVER_COAT[0].toFixed(2)}, ${COVER_COAT[1].toFixed(2)}, xoDeep );
		float xoKeep = 1.0 - smoothstep( ${COVER_SINK[0].toFixed(2)}, ${COVER_SINK[1].toFixed(2)}, xoDeep );
		transformed = xoKeep > 0.001 ? transformed * vec3( 1.0, xoKeep, 1.0 ) : vec3( 0.0 ); // (buried: nothing left to draw)
	}
`;
// The land's cover settings for the blades, read from the terrain material each frame (they change
// with the weather and the shown sky, and its mask comes in later). land(): its uniforms, or null.
const NONE4 = new THREE.Vector4(), NONE2 = new THREE.Vector2();
function landCover(land) {
  const from = (k, none) => ({ get value() { return land?.()?.[k]?.value ?? none; } });
  return { xoLandDust: from('xoDust', NONE4), xoLandDustColor: from('xoDustColor', NONE4), xoLandMask: from('xoDustMask', null), xoLandMaskOn: from('xoDustMaskOn', NONE2) };
}

// A living tree's leaves under a deep cover take it all over, whichever way they face (on top of
// viewer.js DUST_FRAG's cover by the faces' normals, which left a snowy bush's side leaves green):
// the props' rule with the cover's mask, its colour and gloss, as see-through as DustTransparency.
const LEAF_COVER = /* glsl */ `
#ifdef XO_DUST
	if ( xoDustOn > 0.5 && xoCoatOn > 0.5 ) {
		float xoMk = xoDustShape.z > 0.5 ? texture2D( xoDustMask, vec2( vXoWorld.x, - vXoWorld.z ) * xoDustShape.w ).r : 1.0;
		float xoCoat = smoothstep( ${COVER_LEAF[0].toFixed(2)}, ${COVER_LEAF[1].toFixed(2)}, ( xoMk - 1.0 + xoDustShape.x ) / max( 1.0 - xoDustShape.y, 0.02 ) ) * xoDustLook.x;
		diffuseColor.rgb = mix( diffuseColor.rgb, xoDustColor, xoCoat );
		roughnessFactor = mix( roughnessFactor, xoDustLook.y, xoCoat );
	}
#endif
#include <lights_physical_fragment>`;

// Light through grass and leaves: the sun (and any other light) seen through them, by xoThrough (set
// before the lights; 0 = none), added to each light's diffuse. Grass gathers it around the sun
// (BACKLIGHT); leaves and the far pictures by Unreal's two-sided foliage lobe (SCATTER: GGX on the
// view against the sun, 1 towards it, an eighth from every other side - the game draws a sunlit
// bush's rim leaves, turned from the sun, lit, where the plain light left them black), and a tree's
// leaves take the sun's light through their own crown (CROWN_LIGHT). Leaves mirror the sun without
// its Fresnel rise towards grazing angles (F90 = F0 over the direct lights, treeLook; the sky's
// reflection keeps it): seen against the sun, that glint frosted chemical_plant's pines white at
// every needle tip where the game's are dark green. Crowns seen into the sun against the captures:
// those pines +1.25 EV, now +0.21, castle's morning bushes +0.19, now +0.05, bridge's backlit
// spruce -1.31, now -1.70 (too dark either way: the game lights its crown through); views not into
// the sun move by 0.04 EV at most.
const throughPars = (kind) => /* glsl */ `
float xoThrough = 0.0;
${kind === 'leaves' ? `float xoCrownSun = 1.0; // (the sun's share through the crown: CROWN_LIGHT, once a pixel)
vec3 xoCrownLight( const in IncidentLight directLight, const in vec3 geometryPosition ) { // (the sun's share is worked out at this pixel already)
#if NUM_DIR_LIGHTS > 0
	if ( dot( directLight.direction, directionalLights[ 0 ].direction ) > 0.9999 ) return directionalLights[ 0 ].color * xoCrownSun;
#endif
	return directLight.color;
}` : ''}
void RE_Direct_XoThrough( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	${kind === 'grass' ? `float back = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), ${BACKLIGHT.toFixed(1)} );`
    : `float xoVl = saturate( dot( geometryViewDir, - directLight.direction ) );
	float back = pow2( ${SCATTER.toFixed(2)} / ( ( xoVl * ${SCATTER.toFixed(2)} - xoVl ) * xoVl + 1.0 ) );`}
	reflectedLight.directDiffuse += ${kind === 'leaves' ? 'xoCrownLight( directLight, geometryPosition )' : 'directLight.color'} * material.diffuseColor * ( xoThrough * back );
}
#undef RE_Direct
#define RE_Direct RE_Direct_XoThrough`;

// The sun's light through a tree's own crown (after the shadow map's functions, shadows.js): the
// shadow map has every leaf between this one and the sun shade it whole, so a backlit bush's inner
// leaves stayed dark where the game's glow; here the leaves on the way take CROWN_DENSITY of it a
// metre (the way through the crown's box as an ellipsoid, vXoCrownC / vXoCrownR, world space) and
// only what stands past the crown (another tree, a wall, a hill) shades it as its shadow. Worked out
// once a pixel before the lights (xoCrownSun): inside every light's call, unrolled over a map's lamps
// (hangar_newyear's garlands, periphery), the shadow lookup made the leaves' program too long to
// compile and the WebGL context was lost.
const CROWN_LIGHT = /* glsl */ `
float xoCrownSunShare( const in vec3 geometryPosition ) {
	float share = 1.0;
#if NUM_DIR_LIGHTS > 0
	vec3 dir = directionalLights[ 0 ].direction;
	vec3 w = cameraPosition + ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz, l = ( vec4( dir, 0.0 ) * viewMatrix ).xyz;
	vec3 r = max( vXoCrownR, vec3( 0.3 ) ), d = ( w - vXoCrownC ) / r, e = l / r;
	float a = dot( e, e ), b = dot( d, e ), c = dot( d, d ) - 1.0;
	float depth = max( 0.0, ( - b + sqrt( max( b * b - a * c, 0.0 ) ) ) / max( a, 1e-4 ) ), past = 1.0;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	if ( receiveShadow ) past = xoSunShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ], vec4( 0.0, 0.0, 0.0, 1.0 ), ( viewMatrix * vec4( w + l * ( depth + 0.3 ), 1.0 ) ).xyz, dir );
	#endif
	share = past * exp( - ${CROWN_DENSITY.toFixed(3)} * depth );
#endif
	return share;
}`;

// Replaces each [from, to] in a shader, warning when a piece is missing (three.js or makeMaterial changed).
function patch(src, pairs, what) {
  for (const [from, to] of pairs) {
    if (!src.includes(from)) console.warn(`${what}: ${from} not found (three.js or the material changed?)`);
    src = src.replace(from, to);
  }
  return src;
}

// Wraps a material's onBeforeCompile (keeping makeMaterial's) and gives its programs their own key.
function extend(mat, key, uniforms, fn) {
  const base = mat.onBeforeCompile, ck = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, r) => {
    base(shader, r);
    Object.assign(shader.uniforms, WIND, uniforms);
    fn(shader);
  };
  mat.customProgramCacheKey = () => `${ck}-${key}`;
}

// A grass kind's blades (pieces without tangents). kind: its /mapgrass type (luminance, wind);
// top: the model's height; land: () => the terrain material's uniforms (its weather cover), or null.
// Its meshes carry the tints as instanceColor (r g b / 2, see bucketGrass).
export function grassLook(mat, kind, top, land = null) {
  mat.side = THREE.DoubleSide; // (seen from both sides)
  // the preset's luminance_modifier (10 = as painted): the game brightens or darkens the shared
  // atlas per kind (the ferns' 4 leaves them dark, as the game shows them)
  mat.color.setScalar(Math.max(0, kind.luminance ?? 10) / 10);
  extend(mat, 'grass3', { xoSway: { value: new THREE.Vector3(GRASS_SWAY * (kind.wind || 0), Math.max(0.2, top), 0) }, ...landCover(land) }, (shader) => {
    shader.vertexShader = patch(shader.vertexShader, [
      ['#include <common>', '#include <common>\n' + SWAY_VERT + LAND_COVER_VERT],
      ['#include <project_vertex>', LAND_COVER_PROJECT + SWAY_PROJECT],
    ], 'grass');
    shader.fragmentShader = patch(shader.fragmentShader, [
      ['#include <common>', '#include <common>\nuniform vec4 xoLandDustColor;\nvarying float vXoCoat;'],
      ['#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + throughPars('grass')],
      // no brighter than white before the ground's tint (instanceColor holds half of it); then the
      // land's cover where it lies complete (its colour only: under the rains' glossy film the tufts
      // stay dark against the shining wet ground in drcross' and helicopter_valley's captures)
      ['#include <color_fragment>', '\tdiffuseColor.rgb = min( diffuseColor.rgb, vec3( 1.0 ) );\n#include <color_fragment>\n#ifdef USE_COLOR\n\tdiffuseColor.rgb *= 2.0;\n#endif\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, xoLandDustColor.rgb, vXoCoat );'],
      // lit like the ground it grows on: the back of a card as its front (three would turn the
      // normal over on back faces, leaving half the blades in the dark)
      ['#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;')],
      // (a faint sheen: the cards' upward normals made one mirror of the whole carpet, the sky's blue
      // on it everywhere and the sun's glint towards the sun, where the game's grass stays green)
      ['#include <lights_fragment_begin>', `#ifdef USE_ROUGHNESSMAP
	xoThrough = min( texture2D( roughnessMap, vRoughnessMapUv ).r * ${GRASS_THROUGH.toFixed(2)}, 1.0 );
#endif
	material.specularColor *= ${GRASS_SHEEN.toFixed(2)};
	material.specularF90 *= ${GRASS_SHEEN.toFixed(2)};
#include <lights_fragment_begin>`],
    ], 'grass');
  });
}

// A SpeedTree material (06bc377b) on a map: mi its material (Type 0 leaves, 1 bark, 2 billboard,
// none: leaves with masks), box the model's bounds ({ min, max }: the crown and its height).
export function treeLook(mat, mi, box) {
  const type = Number((mi.params || []).find((q) => q.name === 'Type')?.value);
  const height = Math.max(1, box.max[1]);
  // leaves and the far picture let the sun through by their atlas' alpha squared: broad leaves
  // (alpha 0.3-0.4: elderberry, sakura, hazel) take a half to all of it, conifers' needles (spruce
  // 0.06) next to nothing - by the alpha itself a spruce's deep shade took a fifth of the sun and
  // glowed yellow-green where the game's stay dark blue-green
  // (and a deep cover lies on the leaves of living trees, LEAF_COVER: the pin User1 is 1 on them, 0 on
  // ivy, ferns and dead trees)
  const through = (kind) => [
    ['#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\nuniform float xoCoatOn;\n' + throughPars(kind)],
    ['#include <lights_physical_fragment>', LEAF_COVER],
    // (the sun and lamps mirrored without the Fresnel rise, the sky's reflection after them with it:
    // set once around the lights' loop - a copy of the material in each light's call made the leaves'
    // program, unrolled over a map's many lamps, too long to compile and lost the WebGL context on
    // red_rocks_territory)
    ['#include <lights_fragment_begin>', `#ifdef USE_MAP
	xoThrough = min( pow( texture2D( map, vMapUv ).a, 2.0 ) * ${LEAF_THROUGH.toFixed(2)}, 1.0 );
#endif
	float xoF90 = material.specularF90;
	material.specularF90 = max( max( material.specularColor.r, material.specularColor.g ), material.specularColor.b );${kind === 'leaves' ? `
#if NUM_DIR_LIGHTS > 0
	xoCrownSun = xoCrownSunShare( - vViewPosition );
#endif` : ''}
#include <lights_fragment_begin>`],
    ['#include <lights_fragment_end>', '\tmaterial.specularF90 = xoF90;\n#include <lights_fragment_end>'],
  ];
  const coat = { xoCoatOn: { value: Number((mi.params || []).find((q) => q.name === 'User1')?.value) === 1 ? 1 : 0 } };
  if (type === 2) { // the far picture: each plane fades out as it turns edge-on to the view
    extend(mat, 'board1', coat, (shader) => {
      shader.vertexShader = patch(shader.vertexShader, [
        ['#include <common>', '#include <common>\nvarying vec3 vXoBoard;'],
        ['#include <worldpos_vertex>', '#include <worldpos_vertex>\n#ifdef USE_INSTANCING\n\tvXoBoard = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;\n#else\n\tvXoBoard = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n#endif'],
      ], 'billboard');
      shader.fragmentShader = patch(shader.fragmentShader, [
        ...through('board'),
        ['#include <common>', '#include <common>\nvarying vec3 vXoBoard;'],
        // its mask is a distance field: 0.5 on the tree's outline, rising inside (to 0.53-1: an
        // airy crown such as pine_small's peaks at 0.70, a dense spruce's at 1) and falling outside
        // over some 20 texels, so it is cut at 0.5 (unlike the leaves' ramps: viewer.js
        // ALPHAMAP_FROM). Over all 90 billboards the 0.5 level keeps the outline's cover down the
        // mip chain (the cut that would keep it: 0.50 to level 4, 0.49 at 5, 0.48 at 6); at the
        // leaves' 0.4 a spruce's picture swells into a smooth blob
        ['#include <alphamap_fragment>', '#ifdef USE_ALPHAMAP\n\tdiffuseColor.a = texture2D( alphaMap, vAlphaMapUv ).r;\n#endif'],
        // (the side views by the turn about the trunk only: seen from high up the tree stays; the
        // level plane, wound to face down, shows from below)
        ['#include <alphahash_fragment>', `#include <alphahash_fragment>
	{
		vec3 xoN = normalize( cross( dFdx( vXoBoard ), dFdy( vXoBoard ) ) ), xoV = normalize( cameraPosition - vXoBoard );
		float xoFacing = abs( xoN.y ) > 0.7 ? abs( xoV.y ) : abs( dot( normalize( xoN.xz ), normalize( xoV.xz + 1e-6 ) ) );
		diffuseColor.a *= smoothstep( 0.25, 0.6, xoFacing );
	}`],
      ], 'billboard');
    });
    return;
  }
  const leaves = type !== 1;
  const r = Math.max(0.5, Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2);
  // (the crown's box: its middle and half its height, for the light through it)
  const mid = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2), half = Math.max(0.5, (box.max[1] - box.min[1]) / 2);
  const u = { xoSway: { value: new THREE.Vector3(TREE_SWAY * height, height, leaves ? LEAF_FLUTTER : 0) }, xoCrown: { value: new THREE.Vector2(r, height) },
    xoCrownBox: { value: new THREE.Vector4(mid[0], mid[1], mid[2], half) }, ...(leaves ? coat : {}) };
  extend(mat, leaves ? 'leaves1' : 'bark1', u, (shader) => {
    shader.vertexShader = patch(shader.vertexShader, [
      ['#include <common>', '#include <common>\n' + SWAY_VERT + (leaves ? '\nuniform vec2 xoCrown;\nuniform vec4 xoCrownBox;\nvarying float vXoShade;\nvarying vec3 vXoCrownC, vXoCrownR;' : '')],
      ['#include <project_vertex>', SWAY_PROJECT + (leaves
        // deep inside the crown (near the trunk, low down) the sky is hidden by the leaves around
        ? `\n\tvXoShade = mix( ${CROWN_SHADE.toFixed(2)}, 1.0, clamp( length( transformed.xz ) / xoCrown.x * 0.75 + transformed.y / xoCrown.y * 0.4, 0.0, 1.0 ) );
	vXoCrownC = ( modelMatrix * instanceMatrix * vec4( xoCrownBox.xyz, 1.0 ) ).xyz;
	vXoCrownR = vec3( xoCrown.x, xoCrownBox.w, xoCrown.x ) * length( instanceMatrix[ 1 ].xyz );`
        : '')],
    ], 'tree');
    if (!leaves) return;
    shader.fragmentShader = patch(shader.fragmentShader, [
      ...through('leaves'),
      ['#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n' + CROWN_LIGHT],
      ['#include <common>', '#include <common>\nvarying float vXoShade;\nvarying vec3 vXoCrownC, vXoCrownR;'],
      ['#include <aomap_fragment>', '#include <aomap_fragment>\n\treflectedLight.indirectDiffuse *= vXoShade;\n\treflectedLight.indirectSpecular *= vXoShade;'],
    ], 'tree');
  });
}
