// 3D view: three.js scene for one part (viewer mode) or many placed parts (build mode).
// Geometry arrives from https://xo.data/geo (already in glTF space: right-handed, Y up, CCW),
// textures from https://xo.data/tex as the game's own BC1/BC3/BC5/BC7 blocks, uploaded as-is.
// Geometry and textures are cached and reference-counted, so copies of a part share them.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { Post } from './post.js';
import { setFog } from './fog.js'; // (Maps' fog: its import patches three's fog chunks)
import { SunShadow, CASCADES } from './shadows.js'; // (Maps' cascaded sun shadows: likewise the light chunks)
import { useLampShadows } from './lampshadows.js'; // (the map's lamps' shadows: likewise)
import { packLights, lightScene } from './xolights.js'; // (point and spot lights: one shader loop; likewise)
import { weaponAim, arcObject, arcBase, ARC_SIZE, disposeArc, flushAims } from './arcs.js';
import { Animator, flushClips, gunBeat, rateOf, firePointsOf, firePointNumber, fireNumber } from './anim.js';
import { BELT_VERT_HEAD, BELT_VERT } from './belts.js';
import { flushPhys } from './phys.js';
import { FxView } from './fxview.js';
import { Sounds } from './sound.js';
import { hitSound, boomSound } from './soundmap.js';
import { normPaint, paintKey, FINISHES } from './paints.js';

const DATA = 'https://xo.data';
const TARGET = 'assets/props/bootcamp/bootcamp_target/bootcamp_target_plate.mdl'; // (the training ground's: shots land on it)
export const CELL = 0.3; // Crossout build grid: 0.3 m cubes, connection slots at face centres

// Shader helpers. xoAdjust() mirrors xo::applyColorAdjust() in src/xo/Image.cpp exactly, so the
// preview matches the exported PNG. It works on sRGB values (textures are decoded to linear by
// the GPU, so convert back and forth).
const FRAG_HEAD = /* glsl */ `
uniform float xoHue, xoSat, xoBri, xoCon, xoTintAmt, xoPaintAmt, xoHasMask;
uniform vec3 xoTint, xoPaint;
uniform sampler2D xoPaintMask;
uniform int xoNmLayout;
uniform vec3 xoOverlay;
uniform float xoOverlayAmt, xoMetal;
uniform float xoGlowAll; // (how bright glowing things are: 1, or a map weather's, Viewer.glowAll)
#if defined( XO_PAINT_PATTERN ) || defined( XO_PAINT_CHAM )
uniform sampler2D xoPaintTex; // (a paint's pattern, or a chameleon's colour ramp: PAINT_AT)
#endif
#ifdef XO_PAINT_UV
varying vec2 vXoPaintUv;
#endif
#ifdef XO_PAINT_NRM
uniform sampler2D xoPaintNrm;
uniform int xoPaintNrmLayout;
#endif
#ifdef XO_PAINT_FINISH
uniform vec2 xoPaintFinish; // (a metallic or chrome paint: its roughness, how metallic: PAINT_FINISH)
#endif
vec3 xoToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
vec3 xoToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 xoRgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn, h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, mx > 1e-6 ? d / mx : 0.0, mx);
}
vec3 xoHsv2rgb(vec3 c) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + c.x * 6.0, 6.0);
  return c.z - c.z * c.y * max(vec3(0.0), min(min(k, 4.0 - k), vec3(1.0)));
}
vec3 xoAdjustSrgb(vec3 c) {
  if (xoHue != 0.0 || xoSat != 1.0) {
    vec3 h = xoRgb2hsv(clamp(c, 0.0, 1.0));
    h.x = fract(h.x + xoHue / 360.0);
    h.y = clamp(h.y * xoSat, 0.0, 1.0);
    c = xoHsv2rgb(h);
  }
  c = (c - 0.5) * xoCon + 0.5 + xoBri;
  return c + (c * xoTint - c) * xoTintAmt;
}
#ifdef USE_MAP
// paint: the paint's colour here (sRGB): xoPaint, or a pattern's or chameleon's texel (PAINT_AT)
vec4 xoAdjust(vec4 texel, vec3 paint) {
  vec3 c = xoAdjustSrgb(xoToSrgb(texel.rgb));
  if (xoPaintAmt > 0.0 && xoHasMask > 0.5) {
    float m = texture2D(xoPaintMask, vMapUv).r * xoPaintAmt;
    float lum = clamp(dot(c, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
    vec3 o = mix(2.0 * lum * paint, 1.0 - 2.0 * (1.0 - lum) * (1.0 - paint), step(0.5, lum));
    c = c + (o - c) * m;
  }
  return vec4(xoToLinear(clamp(c, 0.0, 1.0)), texel.a);
}
#endif
vec3 xoNormalIn(vec4 s, int nmLayout) {
  if (nmLayout == 2) return s.xyz * 2.0 - 1.0;
  vec2 xy = (nmLayout == 0 ? vec2(s.a, s.g) : vec2(s.r, s.g)) * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}
vec3 xoNormal(vec4 s) { return xoNormalIn(s, xoNmLayout); }
`;

// A paint's colour where the fragment is (paints.js; in place of map_fragment's multiply, xoAdjust lays it
// over the albedo where the paint mask says): its colour (xoPaint), times a pattern's texel through the
// part's second UV set (vXoPaintUv), or a chameleon ramp's texel at the angle the surface is seen at: its
// left end where the surface faces the camera, its right end where it is seen edge-on (by the vertex
// normal, so a part's small bumps do not speckle it; the ramp's own size, LOD 0: its smaller mips would
// wrap one end into the other along edges seen side-on). A mesh without the second set (wheels, some
// decor) takes the pattern's mean colour, its smallest mip (as the export, xo::applyPaint).
const PAINT_AT = /* glsl */ `
	vec3 xoPc = xoPaint;
	#ifdef XO_PAINT_PATTERN
		#ifdef XO_PAINT_FLAT
	xoPc *= xoToSrgb( textureLod( xoPaintTex, vec2( 0.5 ), 16.0 ).rgb );
		#else
	xoPc *= xoToSrgb( texture2D( xoPaintTex, vXoPaintUv ).rgb );
		#endif
	#endif
	#ifdef XO_PAINT_CHAM
	xoPc *= xoToSrgb( textureLod( xoPaintTex, vec2( clamp( 1.0 - abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) ), 0.002, 0.998 ), 0.5 ), 0.0 ).rgb );
	#endif
	diffuseColor *= xoAdjust( sampledDiffuseColor, xoPc );`;
// A paint's finish (paints.js FINISHES): where the paint covers the surface, its roughness and metalness
// take the place of the part's own (its gloss map's), as strongly as the paint covers it.
const PAINT_FINISH = /* glsl */ `
#if defined( XO_PAINT_FINISH ) && defined( USE_MAP )
	{
		float xoFm = xoPaintAmt * xoHasMask * texture2D( xoPaintMask, vMapUv ).r;
		roughnessFactor = mix( roughnessFactor, xoPaintFinish.x, xoFm );
		metalnessFactor = mix( metalnessFactor, xoPaintFinish.y, xoFm );
	}
#endif`;
// A paint's relief (its normal map, through the second UV set as its pattern) added onto the surface's own
// normal, as strongly as the paint covers it there.
const PAINT_NORMAL = /* glsl */ `
#if defined( XO_PAINT_NRM ) && defined( USE_MAP )
	{
		float xoPm = xoPaintAmt * xoHasMask * texture2D( xoPaintMask, vMapUv ).r;
		mat3 xoPf = xoFrameOf( vXoPaintUv, normal );
		vec3 xoPn = xoNormalIn( texture2D( xoPaintNrm, vXoPaintUv ), xoPaintNrmLayout );
		normal = normalize( normal + ( xoPf[ 0 ] * xoPn.x + xoPf[ 1 ] * xoPn.y ) * xoPm );
	}
#endif`;

// three's normal-map chunk decodes the map as plain RGB in two places (object space, then the
// tangent space it actually uses); both go through xoNormal(), which knows the game's layouts
// (DXT5nm: X in alpha, Y in green; BC5: X red, Y green; Z rebuilt).
// The map props' main shader (16B15FE6 with User2) adds a fine detail normal map tiled over the base's
// UVs (xoDetailTiling, UserParam1.x: 4-32 repeats), blended in tangent space (whiteout) and faded out
// by 40 m, where its texels are far below a pixel.
const DETAIL_NORMAL = /* glsl */ `
#ifdef XO_DETAIL
	{
		vec3 xoD = xoNormalIn( texture2D( xoDetail, vNormalMapUv * xoDetailTiling ), xoDetailNm );
		xoD.xy *= normalScale * ( 1.0 - smoothstep( 20.0, 40.0, length( vViewPosition ) ) );
		mapN = vec3( mapN.xy + xoD.xy, mapN.z * xoD.z );
	}
#endif`;
const DETAIL_HEAD = /* glsl */ `
#ifdef XO_DETAIL
	uniform sampler2D xoDetail;
	uniform float xoDetailTiling;
	uniform int xoDetailNm;
#endif`;
const NORMAL_DECODE = /texture2D\( normalMap, vNormalMapUv \)\.xyz \* 2\.0 - 1\.0/g;
const NORMAL_MAPS = THREE.ShaderChunk.normal_fragment_maps.replace(NORMAL_DECODE, 'xoNormal( texture2D( normalMap, vNormalMapUv ) )')
  .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale;' + DETAIL_NORMAL);
if (!NORMAL_MAPS.includes('vec3 mapN = xoNormal(') || !NORMAL_MAPS.includes('XO_DETAIL')) console.warn('normal map patch did not apply (three.js changed?)');
// A DXT5nm normal map carries the ambient occlusion in its red: read there (as three's aomap_fragment
// would, at intensity 1) rather than binding the same texture again as an aoMap (a layered map prop's
// shader uses every texture unit there is).
const AO_FROM_NORMAL = /* glsl */ `
#if defined( USE_NORMALMAP ) && ! defined( USE_AOMAP )
	if ( xoNmLayout == 0 ) {
		float xoAo = texture2D( normalMap, vNormalMapUv ).r;
		reflectedLight.indirectDiffuse *= xoAo;
		#if defined( USE_ENVMAP ) && defined( STANDARD )
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), xoAo, material.roughness );
		#endif
	}
#endif
#include <aomap_fragment>`;

// Glow shaders (the host reads their parameters into material.glow, xo::GlowLook): the lamp shader
// F3007363 (head and tail lights, screens, signs, flashers, beacons laid over a part's own surface),
// its twin on map props and gameplay objects 644D00C3 (neon signs, garlands, candles), and layered
// materials with AdditiveBlend (parts' separate light models). They only add light: glow = d x c x
// gain (gain 1 is as bright as the other shaders' glow maps), d read through uv0 and c through uv1
// (swap: the other way round). One of the two is often a blink timeline (_anim) or plain white
// (blank_parts_e): scroll moves the d (xy) and c (zw) lookups (UV per second) and spin turns the d
// lookup around the texture's centre (degrees per second: rotating beacons). Black adds nothing, so
// most of a piece is invisible. The build-slot markers (644D00C3 with User4) are blended by their
// alpha instead. (Measured over every such material; see CROSSOUT_FORMATS.md.)
const LAMP_VERT_HEAD = /* glsl */ `
#ifndef USE_UV1
attribute vec2 uv1;
#endif
uniform float xoLampSwap, xoLampRot;
uniform vec4 xoLampOff;
varying vec2 xoUvD, xoUvC;
`;
const LAMP_VERT = /* glsl */ `
  vec2 xoUvA = xoLampSwap > 0.5 ? uv1 : uv, xoUvB = xoLampSwap > 0.5 ? uv : uv1;
  float xoRs = sin( xoLampRot ), xoRc = cos( xoLampRot );
  xoUvD = mat2( xoRc, xoRs, -xoRs, xoRc ) * ( xoUvA - 0.5 ) + 0.5 + xoLampOff.xy;
  xoUvC = xoUvB + xoLampOff.zw;
`;
const LAMP_FRAG_HEAD = /* glsl */ `
uniform sampler2D xoLampC;
uniform float xoLampGain, xoLampAlpha;
varying vec2 xoUvD, xoUvC;
`;
// (in place of map_fragment; map = the d texture) RGB adds to what is behind; alpha only fills in the
// empty background (Viewer.makeLampMaterial's blend), so the post chain's colour / alpha keeps lit
// surfaces as they are. A see-through glow (xoLampAlpha) is blended by its textures' alpha instead.
const LAMP_FRAG = /* glsl */ `
#ifdef USE_MAP
  vec4 xoTexD = texture2D( map, xoUvD ), xoTexC = texture2D( xoLampC, xoUvC );
  vec3 xoGlowD = xoToLinear( clamp( xoAdjustSrgb( xoToSrgb( xoTexD.rgb ) ), 0.0, 1.0 ) );
  vec3 xoGlow = xoGlowD * xoTexC.rgb * ( xoLampGain * xoGlowAll * ( 1.0 - xoOverlayAmt ) );
  if ( xoLampAlpha > 0.5 ) diffuseColor = vec4( xoGlow, xoTexD.a * xoTexC.a * opacity );
  else diffuseColor = vec4( xoGlow * opacity, clamp( max( xoGlow.r, max( xoGlow.g, xoGlow.b ) ) * opacity, 0.0, 1.0 ) );
#else
  diffuseColor = vec4( 0.0 );
#endif
`;
// (in place of fog_fragment: Maps' fog, fog.js) an added glow is only dimmed by the fog, a see-through
// one fogged like a surface.
const LAMP_FOG = /* glsl */ `
#ifdef USE_FOG
  vec4 xoFog = xoFogTo( vXoFogRay );
  gl_FragColor.rgb = gl_FragColor.rgb * xoFog.a + ( xoLampAlpha > 0.5 ? xoFog.rgb : vec3( 0.0 ) );
#endif
`;
const WHITE =new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
// (a texture set without a normal or gloss map of its own: flat, read as RGB; height 0.5 and as rough as
// materials without a gloss map)
const FLAT_NORMAL = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
FLAT_NORMAL.needsUpdate = true;
const PLAIN_GLOSS = new THREE.DataTexture(new Uint8Array([128, 115, 0, 255]), 1, 1);
PLAIN_GLOSS.needsUpdate = true;
// What a material shows in a texture's place while it loads (Viewer.syncMaterial): it is drawn with the
// shader it ends with from the start. Three builds a shader for every set of textures a material has,
// and a map's props are drawn before their textures come, so each built one shader after another as
// its albedo, normal and gloss maps streamed in, all but the last thrown away. They look as no texture
// does: white; flat and unshaded (read as DXT5nm, as every normal map is until its own layout is known:
// X in alpha, Y in green, occlusion in red); height 0.5, no gloss (the material's own roughness) and no
// metal; no glow.
const LOADING = Object.fromEntries(Object.entries({ albedo: [255, 255, 255, 255], normal: [255, 128, 255, 128], gloss: [128, 0, 0, 255], emissive: [0, 0, 0, 255], mask: [255, 255, 255, 255] })
  .map(([role, px]) => { const t = new THREE.DataTexture(new Uint8Array(px), 1, 1); t.needsUpdate = true; return [role, t]; }));

// Alpha maps here are tree leaves' cut-out masks (_at): one channel, in red (three reads green), and
// they replace the albedo's alpha (which holds something else on SpeedTree atlases), as in the export.
// The masks are soft ramps, like a blurred outline: about 0.5 on the leaves and needles, 0.4-0.5 in
// the gaps between them, the same in every mip level (138 masks measured). Under 0.5 an atlas holds
// only its padding, flat patches of the nearby leaves' colours (khaki polygons round every sprig of
// spruce_atlas_a). So the cut follows the mask's mip level, the mask x (1 + 0.08 x level), at most
// 1.3: a tree up close (the atlas at its own size) is cut at the 0.5 edge, needles and leaves as
// drawn (cut at 0.4, khaki shards all over a near spruce); crowns from about 50 m out (level 3-4) at
// about 0.4, as full as the game draws them - its 256 px light-probe captures of bridge show the
// coverage of the mask x 1.12-1.25 there, and the 0.5 cut thins far crowns to skeletons. Patched in
// the chunk itself so the shadow pass cuts the leaves the same way.
const ALPHAMAP_FROM = 'diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;';
const ALPHAMAP_TO = /* glsl */ `{
		vec2 xoMaskPx = vAlphaMapUv * vec2( textureSize( alphaMap, 0 ) );
		float xoMaskLod = max( 0.0, 0.5 * log2( max( dot( dFdx( xoMaskPx ), dFdx( xoMaskPx ) ), dot( dFdy( xoMaskPx ), dFdy( xoMaskPx ) ) ) ) );
		diffuseColor.a = texture2D( alphaMap, vAlphaMapUv ).r * min( 1.0 + 0.08 * xoMaskLod, 1.3 );
	}`;
if (!THREE.ShaderChunk.alphamap_fragment.includes(ALPHAMAP_FROM)) console.warn('alpha map patch did not apply (three.js changed?)');
THREE.ShaderChunk.alphamap_fragment = THREE.ShaderChunk.alphamap_fragment.replace(ALPHAMAP_FROM, ALPHAMAP_TO);

// Cut-outs by the albedo's alpha (grass, chain-link, grates): an ordinary all-or-nothing alpha whose
// smaller mips average below the cut-off, so far grass and fences would thin out to nothing (grass
// atlas: 13 % covered at mip 0, 2 % at mip 6); the alpha grows with the level it is read from, by
// about what keeps the coverage of mip 0 (measured on the grass atlases).
const MAP_ALPHA_KEEP = /* glsl */ `
#if defined( USE_ALPHATEST ) && defined( USE_MAP ) && ! defined( USE_ALPHAMAP )
	{
		vec2 xoPx = vMapUv * vec2( textureSize( map, 0 ) );
		float xoLod = max( 0.0, 0.5 * log2( max( dot( dFdx( xoPx ), dFdx( xoPx ) ), dot( dFdy( xoPx ), dFdy( xoPx ) ) ) ) );
		diffuseColor.a *= min( 1.0 + 0.09 * xoLod, 1.7 );
	}
#endif`;
// The cut-out test. With alpha to coverage (multisampled view) the edge is a one-pixel ramp centred on
// the cut-off, its width guarded (three's own smoothstep over fwidth divides by zero where the alpha
// is flat: Direct3D warns X4008).
const ALPHA_TEST = /* glsl */ `
#ifdef USE_ALPHATEST
	#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = clamp( ( diffuseColor.a - alphaTest ) / max( fwidth( diffuseColor.a ), 1e-4 ) + 0.5, 0.0, 1.0 );
	if ( diffuseColor.a == 0.0 ) discard;
	#else
	if ( diffuseColor.a < alphaTest ) discard;
	#endif
#endif`;

// Map materials whose shown texture set has a tiling or UV set of its own (layered map materials, the
// two-layer shaders' base): /geo sends the UVs as the mesh stores them, and the maps read them here.
// (a painted part's pattern and relief: its second UV set times the pattern's repeats, PAINT_AT; the first
// set for a mesh without a second)
const UV0_VERT_HEAD = /* glsl */ `
#if ( defined( XO_UV0 ) || defined( XO_LAYERS ) || defined( XO_PAINT_UV ) ) && ! defined( USE_UV1 )
	attribute vec2 uv1;
#endif
#ifdef XO_UV0
	uniform vec2 xoUv0; // tiling, UV set
#endif
#ifdef XO_PAINT_UV
	uniform vec2 xoPaintUv; // repeats, UV set
	varying vec2 vXoPaintUv;
#endif`;
const UV0_VERT = /* glsl */ `
#ifdef XO_UV0
	vec2 xoUvShown = ( xoUv0.y > 0.5 ? uv1 : uv ) * xoUv0.x;
	${THREE.ShaderChunk.uv_vertex.replace(/\b(?!USE_)[A-Z_]+_UV\b/g, 'xoUvShown')}
#else
	#include <uv_vertex>
#endif
#ifdef XO_PAINT_UV
	vXoPaintUv = ( xoPaintUv.y > 0.5 ? uv1 : uv ) * xoPaintUv.x;
#endif`;

// Map materials that blend texture sets (the host's xo::MapLayer; CROSSOUT_FORMATS.md). Each further set
// (albedo / normal / gloss: xoAlb2 ..., xoAlb3 ...) is read through its own UVs (xoLayerUv: tiling, kind
// 0 uv0 / 1 uv1 / 2 laid over the world in metres, height map inverted, weight channel) and covers what is
// below it where its height (the gloss map's red) passes 1 - its amount, over a ramp as wide as 1 - its
// sharpness. The shaders are not in readable files: these rules were fitted to the game's own light-probe
// captures (bridge's mossy rocks, chemical_plant's rust and paint, bentmetal's grime); up = the world y of
// the surface's own normal, before any normal map (bridge's rocks: the moss lies in whole patches on the
// ledges, not in the normal map's speckle):
//   64177E0A (XO_KIND 1): weighed by the vertex colour (red layer 1, green layer 2): amount = 2 x the weight
//     - 1.15 + UserParam{k}.x + .z + 0.25 x .w x up; by a colour map (its red / green) or nothing: amount =
//     the weight - 0.5 + .x + .z - .w x up; sharpness .y, the ramp centred on 1 - amount. The vertex-colour
//     rule was fitted on 33 probe views of 9 maps (better on 22 of the 30 it changes, worse on 8, most on
//     castle, whose grassy backgroundset2 hills lose some grass): with weight - 0.5 the many models whose
//     vertex colour is a flat 0.5 were covered all over (vulkan's metal bridges in snow3 and its ice cliffs,
//     where the game shows bare rust and rock), cityruin's cliff_triangle pillar was grassed down its sides
//     and chemical_plant's mount_bg3 stayed bare of its own mount_a. The world-up term is weak once the
//     weight is right (0 to 1 x w within 1 % on every score), but + beats - on all four scores (by 0.4 to
//     1.5 % at 0.25 x w, 2 to 6 % at 1 x w): the w > 0 layers lie on the faces that look up, as 569 of the
//     574 grass, moss, sand, snow and soil layers with a w say; at 1 x w the far town houses' colour set
//     (seaside_farbuildings, w 1) tints their roofs yellow, which the captures do not show. The vertex
//     colour's blue for layer 2 was worse on 21 of 30 views. The colour-mapped ones (backgr_mount1 / 2)
//     keep the earlier rule, which their captures favour;
//   62BD5A8E (XO_KIND 2): amount = UserParam0.z + UserParam1.x - UserParam1.y x (2 up - 1), sharpness
//     UserParam0.w (UserParam1.y < 0: on the faces that look up, the moss and grass on rocks; > 0: down
//     the sides, a stack's paint, canyon walls under a flat top), the ramp ending at 1 - amount, i.e.
//     (h + amount - sharpness) / (1 - sharpness): with a centred ramp over the normal-mapped up,
//     bridge's rocks had about half the moss its light probe shows on their ledges and tops (4 views);
//   E611362B (XO_KIND 3): the two sets' heights against each other times UserParam0.z (contrast): the
//     second fills where the first is lower (wet and grime in the hollows; the BlendSampler masks it names
//     are not in the game files).
// Albedo, roughness, metalness and normals blend; a set's normal map is turned into view space by its own
// frame (three's derivative frame where it is not on the shown set's UVs).
const LAYER_VERT_HEAD = /* glsl */ `
#ifdef XO_LAYERS
	#if XO_WEIGHTS == 1
	attribute vec4 color;
	#elif XO_WEIGHTS == 2 && ! defined( USE_UV2 )
	attribute vec2 uv2;
	#endif
	varying vec2 vXoUv, vXoUv1;
	varying vec4 vXoWeights;
#endif
#if defined( XO_LAYERS ) || defined( XO_DUST )
	varying vec3 vXoWorld;
#endif`;
const LAYER_VERT = /* glsl */ `
#ifdef XO_LAYERS
	vXoUv = uv;
	vXoUv1 = uv1;
	#if XO_WEIGHTS == 1
	vXoWeights = color;
	#elif XO_WEIGHTS == 2
	vXoWeights = vec4( uv2, 0.0, 0.0 );
	#else
	vXoWeights = vec4( 0.0 );
	#endif
#endif
#if defined( XO_LAYERS ) || defined( XO_DUST )
	{
		vec4 xoWp = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
		xoWp = instanceMatrix * xoWp;
		#endif
		vXoWorld = ( modelMatrix * xoWp ).xyz;
	}
#endif`;
const LAYER_FRAG_HEAD = /* glsl */ `
#if defined( XO_LAYERS ) || defined( XO_DUST )
	varying vec3 vXoWorld;
#endif
#if defined( XO_LAYERS ) || defined( XO_DUST ) || defined( XO_PAINT_NRM )
	// three's frame from the UV derivatives, with the map's +Y up the texture (V runs down it)
	mat3 xoFrameOf( vec2 uv, vec3 n ) {
		vec3 q0 = dFdx( - vViewPosition ), q1 = dFdy( - vViewPosition );
		vec2 st0 = dFdx( uv ), st1 = dFdy( uv );
		vec3 q1perp = cross( q1, n ), q0perp = cross( n, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x, B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float s = det == 0.0 ? 0.0 : inversesqrt( det );
		return mat3( T * s, - B * s, n );
	}
#endif
#ifdef XO_LAYERS
	uniform sampler2D xoAlb2, xoNrm2, xoGls2;
	#if XO_LAYERS > 1
	uniform sampler2D xoAlb3, xoNrm3, xoGls3;
	#endif
	#ifdef XO_MASKMAP
	uniform sampler2D xoMaskMap;
	#endif
	uniform vec4 xoLayerUv[ 2 ], xoLayerBlend[ 2 ];
	uniform ivec2 xoLayerNm;
	uniform float xoLayersOn;
	varying vec2 vXoUv, vXoUv1;
	varying vec4 vXoWeights;
	struct XoSet { vec3 albedo; vec3 normal; float rough; float metal; float height; };
	vec2 xoSetUv( vec4 l ) {
		return l.y > 1.5 ? vec2( vXoWorld.x, - vXoWorld.z ) / max( l.x, 1e-3 ) : ( l.y > 0.5 ? vXoUv1 : vXoUv ) * l.x;
	}
	XoSet xoSetRead( sampler2D a, sampler2D nm, sampler2D g, vec4 l, int nmLayout, mat3 frame0, vec3 n0 ) {
		XoSet o;
		vec2 uv = xoSetUv( l );
		o.albedo = texture2D( a, uv ).rgb;
		vec4 gl = texture2D( g, uv );
		o.rough = max( xoRoughMin, 1.0 - gl.g );
		o.metal = xoMetal * gl.b;
		o.height = l.z > 0.5 ? 1.0 - gl.r : gl.r;
		mat3 f = l.y < 0.5 ? frame0 : xoFrameOf( uv, n0 );
		o.normal = normalize( f * xoNormalIn( texture2D( nm, uv ), nmLayout ) );
		return o;
	}
	// how much of a set covers what is below it (its height h over hBelow; up = the world normal's y), over
	// a ramp as wide as 1 - sharpness: centred on 1 - amount (64177E0A), ending there (62BD5A8E)
	float xoCover( float h, float hBelow, vec4 l, vec4 p, float up ) {
	#if XO_KIND == 1
		#if XO_WEIGHTS == 1
		float amount = 2.0 * ( l.w > 1.5 ? vXoWeights.g : vXoWeights.r ) - 1.15 + p.x + p.z + 0.25 * p.w * up;
		#else
		vec4 w = vXoWeights;
		#if XO_WEIGHTS == 2
		w = texture2D( xoMaskMap, vXoWeights.xy );
		#endif
		float amount = ( l.w > 1.5 ? w.g : w.r ) + p.z + p.x - 0.5 - p.w * up;
		#endif
		return clamp( ( h - ( 1.0 - amount ) ) / max( 1.0 - p.y, 0.02 ) + 0.5, 0.0, 1.0 );
	#elif XO_KIND == 2
		float amount = p.x + p.z - p.w * ( 2.0 * up - 1.0 );
		return clamp( ( h + amount - p.y ) / max( 1.0 - p.y, 0.02 ), 0.0, 1.0 );
	#else
		return clamp( ( hBelow - h ) * p.x + 0.5, 0.0, 1.0 );
	#endif
	}
#endif`;
// (after the shown set's normal map: diffuseColor, roughnessFactor, metalnessFactor and normal are its own)
const LAYER_FRAG = /* glsl */ `
#ifdef XO_LAYERS
	if ( xoLayersOn > 0.5 ) {
		vec3 xoN0 = normal;
		float xoUp = ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).y;
		#if defined( USE_TANGENT ) && defined( USE_NORMALMAP_TANGENTSPACE )
		mat3 xoFrame0 = tbn;
		#else
		mat3 xoFrame0 = xoFrameOf( vXoUv, nonPerturbedNormal );
		#endif
		#ifdef USE_ROUGHNESSMAP
		float xoH = texture2D( roughnessMap, vRoughnessMapUv ).r;
		#else
		float xoH = 0.5;
		#endif
		XoSet xoS = xoSetRead( xoAlb2, xoNrm2, xoGls2, xoLayerUv[ 0 ], xoLayerNm.x, xoFrame0, xoN0 );
		float xoT = xoCover( xoS.height, xoH, xoLayerUv[ 0 ], xoLayerBlend[ 0 ], xoUp );
		diffuseColor.rgb = mix( diffuseColor.rgb, xoS.albedo, xoT );
		roughnessFactor = mix( roughnessFactor, xoS.rough, xoT );
		metalnessFactor = mix( metalnessFactor, xoS.metal, xoT );
		normal = normalize( mix( normal, xoS.normal, xoT ) );
		xoH = mix( xoH, xoS.height, xoT );
		#if XO_LAYERS > 1
		xoS = xoSetRead( xoAlb3, xoNrm3, xoGls3, xoLayerUv[ 1 ], xoLayerNm.y, xoFrame0, xoN0 );
		xoT = xoCover( xoS.height, xoH, xoLayerUv[ 1 ], xoLayerBlend[ 1 ], xoUp );
		diffuseColor.rgb = mix( diffuseColor.rgb, xoS.albedo, xoT );
		roughnessFactor = mix( roughnessFactor, xoS.rough, xoT );
		metalnessFactor = mix( metalnessFactor, xoS.metal, xoT );
		normal = normalize( mix( normal, xoS.normal, xoT ) );
		#endif
	}
#endif`;

// Overlays (85F3A2ED) with a flat colour in an albedo without alpha show where their gloss map's red says.
const MASK_GLOSS = /* glsl */ `
#if defined( XO_MASK_GLOSS ) && defined( USE_ROUGHNESSMAP )
	diffuseColor.a *= texture2D( roughnessMap, vRoughnessMapUv ).r;
#endif`;

// The weather's cover on map props: the environment's Dust* settings (snow under the new-year skies,
// a dark wet sheen in rain, sand and ash dust). Where it lies: by how much a face looks up (DustByNormals),
// broken up by the surface's own height map and the cover's mask texture (DustMaskPath, tiled every
// DustMaskScale metres), from DustHeight on over a step DustSharpness narrows, as the decals' rule; it
// takes DustColor, DustGloss and DustMetalness, as opaque as DustTransparency says. DUST is shared by every
// map prop's material; Viewer.setDust sets it from the map's environment (and clears it for one without).
const DUST = {
  xoDustOn: { value: 0 },
  xoDustColor: { value: new THREE.Color() },
  xoDustLook: { value: new THREE.Vector4() },  // opacity, roughness, metalness, by normals (1) or by height (2: xoDustBand)
  xoDustBand: { value: new THREE.Vector2() },  // (by height) all over below .x, none from .y up (world heights)
  xoDustShape: { value: new THREE.Vector4() }, // height, sharpness, mask (1), 1 / mask tiling (metres)
  xoDustMask: { value: null },
};
const DUST_HEAD = /* glsl */ `
#ifdef XO_DUST
	uniform float xoDustOn;
	uniform vec3 xoDustColor;
	uniform vec4 xoDustLook, xoDustShape;
	uniform vec2 xoDustBand;
	uniform sampler2D xoDustMask;
#endif`;
const DUST_FRAG = /* glsl */ `
#ifdef XO_DUST
	if ( xoDustOn > 0.5 ) {
		float xoLie = xoDustLook.w > 1.5 ? ( xoDustBand.y > xoDustBand.x ? clamp( ( xoDustBand.y - vXoWorld.y ) / ( xoDustBand.y - xoDustBand.x ), 0.0, 1.0 ) : 1.0 - step( xoDustBand.x, vXoWorld.y ) )
			: xoDustLook.w > 0.5 ? ( vec4( normal, 0.0 ) * viewMatrix ).y : 1.0;
		#ifdef USE_ROUGHNESSMAP
		xoLie += ( texture2D( roughnessMap, vRoughnessMapUv ).r - 0.5 ) * 0.25;
		#endif
		if ( xoDustShape.z > 0.5 ) xoLie *= texture2D( xoDustMask, vec2( vXoWorld.x, - vXoWorld.z ) * xoDustShape.w ).r;
		float xoCov = clamp( ( xoLie - ( 1.0 - xoDustShape.x ) ) / max( 1.0 - xoDustShape.y, 0.02 ), 0.0, 1.0 ) * xoDustLook.x;
		if ( xoDustLook.w > 1.5 ) xoCov *= 1.0 - roughnessFactor; // (the film by height: as glossy as the surface under it)
		diffuseColor.rgb = mix( diffuseColor.rgb, xoDustColor, xoCov );
		roughnessFactor = mix( roughnessFactor, xoDustLook.y, xoCov );
		metalnessFactor = mix( metalnessFactor, xoDustLook.z, xoCov );
		normal = normalize( mix( normal, nonPerturbedNormal, xoCov * 0.5 ) );
	}
#endif`;

// Glass on map props keeps its whole reflection: only the light it lets through is scaled by its alpha
// (premultiplied: three multiplies by the alpha after the haze).
const GLASS_OUT = /* glsl */ `
#ifdef XO_GLASS
	gl_FragColor = vec4( ( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance ) / max( diffuseColor.a, 1e-3 ), diffuseColor.a );
#else
	#include <opaque_fragment>
#endif`;

// Ice walls and pumpkins (SubsurfaceScattering, SssSoftLight): the sun's light reaches round past their
// shadow line, a wrapped diffuse term.
const SSS_FRAG = /* glsl */ `
#if defined( XO_SSS ) && NUM_DIR_LIGHTS > 0
	{
		float xoNl = dot( normal, directionalLights[ 0 ].direction );
		reflectedLight.directDiffuse += BRDF_Lambert( material.diffuseColor ) * directionalLights[ 0 ].color * ( clamp( ( xoNl + 0.5 ) / 1.5, 0.0, 1.0 ) - clamp( xoNl, 0.0, 1.0 ) ) * 0.6;
	}
#endif`;

// Maps: the diffuse light from all around as the game's light probe has it (its irradiance as 9
// spherical harmonics, sky.js irradianceSH) instead of the environment map's roughest level, which is
// narrower than a cosine (a wall would take too much of the bright sky above it, too little of the
// ground). All zero (the other modes, a map without probes): three's own. Shared by every lit
// material, like fog.js's FOG (three copies the array, not the vectors in it).
// A hangar's hall has a local probe of its own (LOCAL_PROBE: its capture, irradiance and box): inside
// its inner box it lights and is mirrored alone, fading out to the outer one, its reflections seen
// from where they would hit the outer box's walls (box projection). Its capture is a texture, which
// three cannot share like this: a material takes it with useLocalProbe(shader) (the map's own do),
// which also gives it the map's lamps' shadows (lampshadows.js: their atlas is a texture too).
export const IRRADIANCE = Array.from({ length: 9 }, () => new THREE.Vector3());
export const LOCAL_PROBE = {
  irradiance: Array.from({ length: 9 }, () => new THREE.Vector3()),
  box: new Float32Array(12), // centre, cos yaw; inner half extents, sin yaw; outer half extents (glTF)
  env: { value: null }, on: { value: 0 },
};
export function useLocalProbe(shader) {
  shader.uniforms.xoLocalEnv = LOCAL_PROBE.env;
  shader.uniforms.xoLocalOn = LOCAL_PROBE.on;
  useLampShadows(shader);
}
for (const id of ['standard', 'physical']) {
  Object.assign(THREE.ShaderLib[id].uniforms, { xoIrradiance: { value: IRRADIANCE }, xoLocalIrradiance: { value: LOCAL_PROBE.irradiance }, xoLocalBox: { value: LOCAL_PROBE.box } });
}
{
  const IBL = 'iblIrradiance += getIBLIrradiance( geometryNormal );', RAD = 'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );';
  const C = THREE.ShaderChunk;
  if (!C.lights_fragment_maps.includes(IBL) || !C.lights_fragment_maps.includes(RAD) || !C.envmap_physical_pars_fragment.startsWith('#ifdef USE_ENVMAP')) console.warn('irradiance patch did not apply (three.js changed?)');
  C.envmap_physical_pars_fragment = C.envmap_physical_pars_fragment.replace('#ifdef USE_ENVMAP', `#ifdef USE_ENVMAP
	uniform vec3 xoIrradiance[ 9 ], xoLocalIrradiance[ 9 ];
	uniform vec4 xoLocalBox[ 3 ];
	uniform sampler2D xoLocalEnv;
	uniform float xoLocalOn;
	vec3 xoBoxTurn( vec3 v, float s ) { return vec3( xoLocalBox[ 0 ].w * v.x + s * v.z, v.y, - s * v.x + xoLocalBox[ 0 ].w * v.z ); }
	// how much of the local probe a point takes: 1 inside the inner box, 0 outside the outer one
	float xoLocalWeight( vec3 p ) {
		vec3 q = abs( xoBoxTurn( p - xoLocalBox[ 0 ].xyz, xoLocalBox[ 1 ].w ) );
		vec3 t = ( q - xoLocalBox[ 1 ].xyz ) / max( xoLocalBox[ 2 ].xyz - xoLocalBox[ 1 ].xyz, vec3( 1e-3 ) );
		return xoLocalOn > 0.5 ? 1.0 - smoothstep( 0.0, 1.0, max( max( t.x, t.y ), t.z ) ) : 0.0;
	}
	#ifdef ENVMAP_TYPE_CUBE_UV
	vec3 xoLocalRadiance( vec3 p, vec3 viewDir, vec3 normal, float roughness ) {
		vec3 r = normalize( mix( reflect( - viewDir, normal ), normal, roughness * roughness ) );
		r = xoBoxTurn( inverseTransformDirection( r, viewMatrix ), xoLocalBox[ 1 ].w );
		vec3 d = xoBoxTurn( p - xoLocalBox[ 0 ].xyz, xoLocalBox[ 1 ].w );
		vec3 f = max( ( xoLocalBox[ 2 ].xyz - d ) / r, ( - xoLocalBox[ 2 ].xyz - d ) / r );
		vec3 hit = d + r * min( min( f.x, f.y ), f.z );
		return textureCubeUV( xoLocalEnv, xoBoxTurn( hit, - xoLocalBox[ 1 ].w ), roughness ).rgb * envMapIntensity;
	}
	#endif`);
  C.lights_fragment_maps = C.lights_fragment_maps.replace(IBL, `vec3 xoWorld = ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz + cameraPosition;
		float xoLocal = xoLocalWeight( xoWorld );
		vec3 xoNormal = inverseTransformDirection( geometryNormal, viewMatrix );
		iblIrradiance += mix( xoIrradiance[ 0 ] == vec3( 0.0 ) ? getIBLIrradiance( geometryNormal ) : shGetIrradianceAt( xoNormal, xoIrradiance ) * envMapIntensity,
			shGetIrradianceAt( xoNormal, xoLocalIrradiance ) * envMapIntensity, xoLocal );`).replace(RAD, `#if defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
			vec3 xoGlobal = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ); // (once: each call is built in full)
			radiance += xoLocal > 0.0 ? mix( xoGlobal, xoLocalRadiance( xoWorld, geometryViewDir, geometryNormal, material.roughness ), xoLocal ) : xoGlobal;
		#else
			${RAD}
		#endif`);
}

const FORMATS = {
  BC1: { fmt: THREE.RGBA_S3TC_DXT1_Format, ext: 's3tc' },
  BC2: { fmt: THREE.RGBA_S3TC_DXT3_Format, ext: 's3tc' },
  BC3: { fmt: THREE.RGBA_S3TC_DXT5_Format, ext: 's3tc' },
  BC4: { fmt: THREE.RED_RGTC1_Format, ext: 'rgtc' },
  BC5: { fmt: THREE.RED_GREEN_RGTC2_Format, ext: 'rgtc' },
  BC7: { fmt: THREE.RGBA_BPTC_Format, ext: 'bptc' },
};

// A static copy of a mesh in a pose: every vertex moved by its bones' skin matrices (column-major,
// as three.js keeps them), blended by weight as the viewer's skinning does (a vertex on no bone goes
// with the first node), its normal by their inverse transpose, its tangent along. Triangles the pose
// shrinks to nothing (bones scaled away) are left out of the index. The exporter bakes a pose the
// same way (src/xo/Export.cpp poseGeometry), so a part looks alike in the builder and in its file.
function bakePose(src, skin, maxJoint) {
  const g = src.clone();
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  if (!si || !sw || maxJoint < 0 || maxJoint >= skin.length) return g; // (a piece that does not move)
  const P = g.attributes.position.array, rest = src.attributes.position.array, N = g.attributes.normal?.array, T = g.attributes.tangent?.array;
  const J = si.array, W = sw.array, n = g.attributes.position.count, m = new Float64Array(16);
  for (let v = 0; v < n; v++) {
    m.fill(0);
    let sum = 0;
    for (let c = 0; c < 4; c++) {
      const w = W[v * 4 + c], j = J[v * 4 + c];
      if (!(w > 0) || j >= skin.length) continue;
      const s = skin[j];
      for (let e = 0; e < 16; e++) m[e] += w * s[e];
      sum += w;
    }
    if (sum < 1e-6) m.set(skin[0]);
    else if (Math.abs(sum - 1) > 1e-4) for (let e = 0; e < 16; e++) m[e] /= sum;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    P[v * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    P[v * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    P[v * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (N) { // (the inverse transpose of the 3x3: its cofactors; the length is normalised away)
      const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], gg = m[2], h = m[6], i = m[10];
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      const ox = (e * i - f * h) * nx - (d * i - f * gg) * ny + (d * h - e * gg) * nz;
      const oy = -(b * i - c * h) * nx + (a * i - c * gg) * ny - (a * h - b * gg) * nz;
      const oz = (b * f - c * e) * nx - (a * f - c * d) * ny + (a * e - b * d) * nz;
      const det = a * (e * i - f * h) - b * (d * i - f * gg) + c * (d * h - e * gg), l = Math.hypot(ox, oy, oz) * Math.sign(det);
      if (Math.abs(det) > 1e-12 && Math.abs(l) > 1e-12) { N[v * 3] = ox / l; N[v * 3 + 1] = oy / l; N[v * 3 + 2] = oz / l; } // (a bone scaled to nothing: the normal stays)
    }
    if (T) {
      const tx = T[v * 4], ty = T[v * 4 + 1], tz = T[v * 4 + 2];
      const ox = m[0] * tx + m[4] * ty + m[8] * tz, oy = m[1] * tx + m[5] * ty + m[9] * tz, oz = m[2] * tx + m[6] * ty + m[10] * tz, l = Math.hypot(ox, oy, oz);
      if (l > 1e-6) { T[v * 4] = ox / l; T[v * 4 + 1] = oy / l; T[v * 4 + 2] = oz / l; }
    }
  }
  const idx = g.index.array, kept = [];
  const area2 = (q, a, b, c) => {
    const ux = q[b * 3] - q[a * 3], uy = q[b * 3 + 1] - q[a * 3 + 1], uz = q[b * 3 + 2] - q[a * 3 + 2];
    const wx = q[c * 3] - q[a * 3], wy = q[c * 3 + 1] - q[a * 3 + 1], wz = q[c * 3 + 2] - q[a * 3 + 2];
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx;
    return x * x + y * y + z * z;
  };
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2], before = area2(rest, a, b, c);
    if (before > 0 && area2(P, a, b, c) < before * 1e-8) continue; // (less than 1/10,000 of its area left)
    kept.push(a, b, c);
  }
  if (kept.length !== idx.length) g.setIndex(new THREE.BufferAttribute(new idx.constructor(kept), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function parseXogm(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x4d474f58) throw new Error('bad geometry data');
  const jl = dv.getUint32(4, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
  const base = (8 + jl + 3) & ~3;
  const f32 = (a) => (a ? new Float32Array(buf, base + a[0], a[1] / 4) : null);
  return json.meshes.map((m) => ({
    ...m,
    position: f32(m.position), normal: f32(m.normal), tangent: f32(m.tangent), uv0: f32(m.uv0), uv1: f32(m.uv1), uv2: f32(m.uv2),
    color: m.color ? new Uint8Array(buf, base + m.color[0], m.color[1]) : null, // (the weights of a layered map material's sets)
    joints: m.joints ? new Uint8Array(buf, base + m.joints[0], m.joints[1]) : null, weights: f32(m.weights),
    indices: m.indices[2] === 2 ? new Uint16Array(buf, base + m.indices[0], m.indices[1] / 2) : new Uint32Array(buf, base + m.indices[0], m.indices[1] / 4),
  }));
}

export function parseXotx(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x58544f58) throw new Error('bad texture data');
  const jl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
  const base = (8 + jl + 15) & ~15;
  head.mipmaps = head.levels.map((l) => ({ data: new Uint8Array(buf, base + l.offset, l.size), width: l.w, height: l.h }));
  return head;
}

export function parseXorg(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x47524f58) throw new Error('bad image data');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
  return { w, h, data: new Uint8Array(buf, 12, w * h * 4) };
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return r.arrayBuffer();
}

// Weld points named "cslot..." (a frame's sides, a wheel's mount, a cabin's underside) are drawn
// in the garage as a square with a round hole; the others ("slot...") as a plain square.
export const ringSlot = (name) => /^cslot/i.test(name || '');

// Slot matrix (glTF space, column-major) -> { pos, normal }. A slot's +Y axis points out of the part.
export function slotFrame(m) {
  const pos = new THREE.Vector3(m[12], m[13], m[14]);
  const normal = new THREE.Vector3(m[4], m[5], m[6]).normalize();
  return { pos, normal };
}

// ---------------------------------------------------------------------------------------------
// Caches

class RefCache {
  constructor(limitFn, disposeFn) { this.map = new Map(); this.limitFn = limitFn; this.disposeFn = disposeFn; }
  // Forget everything (after the game data changed): idle entries are freed now, entries still
  // in use are freed when their last user lets go; new requests load fresh copies.
  flush() {
    for (const e of this.map.values()) {
      if (e.refs === 0) { if (e.value) this.disposeFn(e.value); } else e.stale = true;
    }
    this.map.clear();
  }
  get(key, make) {
    let e = this.map.get(key);
    if (!e) {
      e = { key, refs: 0, used: 0, size: 0, value: null, promise: null };
      e.promise = make(e).then((v) => (e.value = v), (err) => { if (this.map.get(key) === e) this.map.delete(key); throw err; });
      this.map.set(key, e);
    }
    e.refs++;
    e.used = performance.now();
    return e;
  }
  release(e) {
    if (!e || e.refs <= 0) return;
    e.refs--;
    if (e.refs === 0 && e.stale && e.value) { this.disposeFn(e.value); e.value = null; }
  }
  // over: is the cache still too big? (the cache's own limit unless given another)
  collect(over = this.limitFn) {
    const idle = [...this.map.values()].filter((e) => e.refs === 0 && e.value).sort((a, b) => a.used - b.used);
    for (const e of idle) {
      if (!over(this)) break;
      this.map.delete(e.key);
      this.disposeFn(e.value);
    }
  }
  total() { let s = 0; for (const e of this.map.values()) s += e.size; return s; }
}

// ---------------------------------------------------------------------------------------------

// How the icon studio (Viewer.iconPicture) pictures a part: the camera's height and turn (degrees;
// turned from the front, +z, to the left, +x) and distance (the part's radii: a short lens), the
// key, fill and rim lights ([colour, strength]; each moved off the camera's line by its Up/Right,
// in the camera's terms), the room's light, the exposure, how metallic bare metal shows (×), the
// tone mapping (null: the view's), and the grade of the finished picture (saturation, contrast,
// brightness: as CSS's filters). Matched to the game's own cards (Sprinter, Growl, Harpy beside
// the game's): seen from about 28° up, the side turned to the right lit from above it, the front
// in its shade, the metal greyer than the view shows it. viewer.iconLook = { ... } overrides any
// of it (trials, the e2e).
const ICON_LOOK = {
  elev: 28, azim: 40.3, dist: 4,
  key: [0xffffff, 2.8], fill: [0xdce6ff, 0.45], rim: [0xffffff, 1.2], keyUp: 1.2, keyRight: 0.9, fillRight: -1, rimRight: -0.35,
  env: 0.7, exposure: 1, metal: 0.35, tone: null,
  grade: { saturate: 0.7, contrast: 1.1, brightness: 1.1 },
};

export class Viewer {
  constructor(canvas, { onHover } = {}) {
    this.canvas = canvas;
    this.onHover = onHover || (() => {});
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })); // (a laptop's own GPU, not its integrated one)
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false; // redrawn when something changed (shadowDirty), not on every camera move
    this.shadowDirty = true;
    // a GPU driver reset loses every texture and shader: reload (the build comes back from the autosave)
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.onContextLost?.(); });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    const ext = (n) => !!r.extensions.get(n);
    this.support = {
      s3tc: ext('WEBGL_compressed_texture_s3tc'), s3tcSrgb: ext('WEBGL_compressed_texture_s3tc_srgb'),
      rgtc: ext('EXT_texture_compression_rgtc'), bptc: ext('EXT_texture_compression_bptc'),
      anisotropy: r.capabilities.getMaxAnisotropy(), maxTexture: r.capabilities.maxTextureSize,
    };
    this.scene = new THREE.Scene();
    lightScene(this.scene); // (the point and spot lights light this scene only)
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envs = {};
    // The key light (the sun) casts soft shadows onto the part itself and onto an invisible floor
    // that only shows shadow; its shadow camera is fitted to whatever is on stage (setStage).
    this.key = new THREE.DirectionalLight(0xffffff, 1.4);
    this.key.position.set(4, 7, 5);
    this.key.castShadow = true;
    const sm = this.support.maxTexture >= 8192 ? 4096 : 2048;
    this.key.shadow = new SunShadow(sm); // (in Maps: CASCADES squares of half that side, see setMode)
    this.shadowSize = sm;
    this.keyDir = new THREE.Vector3(4, 7, 5).normalize();
    this.rim = new THREE.DirectionalLight(0xffe2c4, 0.5);
    this.rim.position.set(-5, 3, -6);
    this.scene.add(this.key, this.key.target, this.rim);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: true }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.name = 'floor';
    this.scene.add(this.floor);
    this.stages = {};
    this.shadows = true;
    this.post = r.capabilities.isWebGL2 ? new Post(r) : null;
    this.setLighting('outdoor');
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 2000);
    this.camera.position.set(3, 2, 4);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.partRoot = new THREE.Group();
    this.buildRoot = new THREE.Group();
    this.mapRoot = new THREE.Group(); // Maps mode (mapview.js)
    this.mapRoot.visible = false;
    this.helpers = new THREE.Group(); // part-mode slot/pivot markers
    this.scene.add(this.partRoot, this.buildRoot, this.mapRoot, this.helpers);
    this.grid = null;
    this.mode = 'part';
    this.cameras = { part: null, build: null, map: null };

    this.geo = new RefCache((c) => c.map.size > 40, (parts) => parts.forEach((p) => p.geometry.dispose()));
    this.restPoses = new Map(); // part path -> Promise<its default pose or null> (restPose)
    this.tex = new RefCache((c) => c.total() > 1.2e9, (t) => t.tex.dispose());
    this.live = new Set(); // every material in the scene (for option toggles and colour edits)
    this.lampAnims = new Set(); // lamp materials that blink, scroll or turn (stepLamps)
    this.lampSeen = -Infinity;  // when one of them was last drawn
    this.lampEpoch = performance.now();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.dirty = true; }); // (one frame wakes blinking lamps up again)
    this.adjust = new Map(); // albedo base -> colour edit
    this.replace = new Map(); // texture base -> { id }
    this.options = { textures: true, wireframe: false, slots: false, pivots: false, grid: true, heat: 0, arcs: true, layers: true }; // (layers: map materials' further texture sets, Maps' switch)
    this.arcSize = ARC_SIZE.def; // firing arcs: radius = this x the part's size (setArcSize)
    this.arcCones = true; // firing arcs: the cones above and below (setArcCones)
    this.metal = { value: 1 };
    // Glowing materials' brightness (lamps, lit windows, screens: a lamp's gain, an emissive map):
    // 1, and in Maps the weather's (sky.js presetLevels glow: the game's EmissiveLumScale at its
    // exposure, lamps bright at night). Shared by every material, like metal.
    this.glowAll = { value: 1 };
    this.part = null; // current viewer-mode model group
    this.partToken = 0;

    this.dirty = true;
    this.outlines = []; // parts drawn with the garage's outline (setOutlines)
    this.raycaster = new THREE.Raycaster();
    this.pointer = null;
    this.hoverEnabled = true;
    canvas.addEventListener('pointermove', (e) => { this.pointer = e; this.hoverDirty = true; });
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.onHover(null); this.mapHover?.(null); this.setPartHover(null); });
    // 3D Viewer: a click on the part (not a drag, which turns the view) selects the material under it
    this.partHover = null; // the material under the cursor (white outline), or null
    this.partSel = null;   // the selected material (orange outline), or null
    this.onPartSelect = null;
    canvas.addEventListener('pointerdown', (e) => { this.partPress = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
    canvas.addEventListener('pointerup', (e) => {
      const p = this.partPress;
      this.partPress = null;
      if (!p || e.button !== 0 || this.mode !== 'part' || !this.part) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4 || performance.now() - p.t > 600) return;
      const hit = this.partMeshAt(e);
      this.selectPartMaterial(hit ? hit.object.userData.material : null);
    });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.frameHooks = [];
    // the game's particle effects (muzzle flashes, smoke, sparks when a gun fires: onShot)
    this.fx = new FxView(this);
    this.fxFor = null; // model path -> its muzzle effect (particles/...), or null: set by the app
    this.fxSpeed = 1; // (the animation's speed: effects slow down with it)
    this.fxLoops = new Map(); // fire node -> its looping effect (a flamethrower's flow)
    this.beamLoops = new Map(); // fire node -> its held beam (FxView.beam)
    // the game's sounds (sound.js): a gun's shots where it fires, hits and blasts where they happen
    this.sounds = new Sounds();
    this.soundFor = null; // (model path, activity) -> its gun sound (soundmap.js), or null: set by the app
    this.fxClock = performance.now();
    this.tween = null; // camera glide to a new framing
    this.lift = 0; // build mode: how far the car is lifted off the floor (C in the garage)
    this.liftTween = null;
    this.controls.addEventListener('start', () => (this.tween = null)); // the user takes over
    // At most one frame every slowFrames() ms (0: every one) while nothing is being done: Maps draws a
    // map coming in 10 times a second, its frames' time going to its models (input keeps it full rate).
    this.slowFrames = () => 0;
    this.lastInput = 0;
    this.lastFrame = 0;
    for (const t of ['pointerdown', 'pointermove', 'keydown', 'keyup', 'wheel']) addEventListener(t, () => { this.lastInput = performance.now(); }, { passive: true, capture: true });
    const loop = () => {
      requestAnimationFrame(loop);
      if (document.hidden) return;
      this.stepTween();
      this.stepLift();
      const moved = this.mode === 'map' ? false : this.controls.update(); // (Maps flies its own camera)
      for (const h of this.frameHooks) h();
      // (a map's own fires and weather alone move on 30 times a second: no full-rate redraws for them)
      const now = performance.now();
      if (!this.fx.busy) this.fxClock = now;
      else if (!this.fx.calm || now - this.fxClock >= 1000 / 30 - 2) {
        const fxDt = Math.min(0.1, (now - this.fxClock) / 1000);
        this.fxClock = now;
        this.fx.update(fxDt * this.fxSpeed);
      }
      this.sounds.listen(this.camera);
      this.stepLamps();
      if (this.hoverDirty && this.pointer && this.hoverEnabled) { this.hoverDirty = false; this.pick(); }
      if ((moved || this.dirty) && (moved || now - this.lastFrame >= this.slowFrames() || now - this.lastInput < 500)) {
        this.dirty = false;
        this.lastFrame = now;
        this.render();
        this.frames = (this.frames || 0) + 1;
      }
    };
    loop();
  }

  // Blinking, scrolling and turning lamps (see LAMP_VERT) move on, 30 times a second, while one of
  // them is on screen (their meshes note when they are drawn); otherwise nothing is redrawn for them.
  stepLamps() {
    if (this.lampHold != null || !this.lampAnims.size) return;
    const now = performance.now();
    if (now - this.lampSeen > 500 || now - (this.lampFrame || 0) < 1000 / 30) return;
    this.lampFrame = now;
    this.setLampTime((now - this.lampEpoch) / 1000);
  }

  // Every animated lamp as it is t seconds in (the offsets are wrapped here, where the numbers are exact).
  setLampTime(t) {
    const wrap = (v) => v - Math.floor(v);
    for (const m of this.lampAnims) {
      const { scroll: s, spin } = m.userData.xo.lamp, u = m.userData.xo.u;
      u.xoLampOff.value.set(wrap(s[0] * t), wrap(s[1] * t), wrap(s[2] * t), wrap(s[3] * t));
      u.xoLampRot.value = wrap((spin * t) / 360) * 2 * Math.PI;
    }
    this.dirty = true;
  }

  // Stops the lamps at t seconds (tests); null lets them run again.
  holdLamps(t) {
    this.lampHold = t;
    if (t != null) this.setLampTime(t);
  }

  // One frame: through the post chain (ambient occlusion, tone mapping, outlines) when WebGL2 allows it.
  render() {
    const r = this.renderer;
    packLights(); // (the lights lit now: xolights.js)
    if (this.shadowDirty || this.key.shadow.pending || this.key.shadow.catchUp) { // (Maps: only the cascades that moved, unless something else changed)
      this.key.shadow.schedule(this.shadowDirty);
      r.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    if (this.post && this.post.scene) this.post.render(this.scene, this.camera, this.outlines);
    else { r.setRenderTarget(null); r.render(this.scene, this.camera); }
  }

  // The garage's outline around parts: [{ object, color }] (colours as they should look on screen).
  // Each user keeps its own list (key): the builder's, the map's selection.
  setOutlines(list, key = 'build') {
    (this.outlineSets ||= new Map()).set(key, list);
    const all = [...this.outlineSets.values()].flat();
    const same = all.length === this.outlines.length && all.every((o, i) => o.object === this.outlines[i].object && o.color === this.outlines[i].color);
    this.outlines = all;
    if (!same) this.dirty = true;
  }

  // Soft shadows and ambient occlusion on / off (both are part of the lighting).
  setShadows(on) {
    this.shadows = on;
    this.key.castShadow = on;
    this.floor.visible = on && this.mode !== 'map'; // (a map has its own ground)
    if (this.post) this.post.ao = on;
    this.shadowDirty = true;
    this.dirty = true;
  }

  // The floor's height: under the part (3D Viewer), or under the whole build (whatever hangs lowest,
  // like wheels below the frame), lowered by the lift. Floor, grid and the camera keys all use it.
  groundLevel(mode = this.mode) {
    const box = this.stages[mode];
    if (mode !== 'build') return box ? box.min.y : 0;
    return Math.min(0, box && !box.isEmpty() ? box.min.y : 0) - this.lift;
  }

  // What is on stage (the part, or the whole build): the floor goes under it, the sun's shadow
  // camera wraps it, and ambient occlusion reaches about a tenth of its size. A lifted car
  // (build mode) has the floor that much further down, still inside the shadow camera.
  setStage(box, mode = this.mode || 'part') {
    if (mode === 'map') return; // (Maps: the sun's shadow follows the camera, see mapview.js)
    if (!box || box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-1.5, 0, -1.5), new THREE.Vector3(1.5, 1, 1.5));
    this.stages[mode] = box.clone();
    if (mode !== this.mode) return;
    const lift = mode === 'build' ? this.lift : 0;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2);
    const y = this.groundLevel(mode);
    this.floor.position.set(c.x, y - 0.002, c.z); // (just under the grid: no flicker between them)
    if (this.grid && mode === 'build') this.grid.position.y = y - 0.001;
    this.shadowDirty = true;
    this.floor.scale.setScalar(r * 14 + lift * 4);
    this.floor.updateMatrixWorld();
    const fit = box.clone();
    if (lift > 0) fit.min.y = Math.min(fit.min.y, y);
    const cf = fit.getCenter(new THREE.Vector3());
    const rf = Math.max(0.3, fit.getSize(new THREE.Vector3()).length() / 2);
    const L = this.key, e = rf * 1.4;
    L.target.position.copy(cf);
    L.position.copy(cf).addScaledVector(this.keyDir, rf * 4);
    L.target.updateMatrixWorld();
    L.updateMatrixWorld();
    const cam = L.shadow.camera;
    cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
    cam.near = rf * 1.5; cam.far = rf * 7;
    cam.updateProjectionMatrix();
    L.shadow.bias = -0.0002;
    L.shadow.normalBias = (2 * e / L.shadow.mapSize.x) * 1.5;
    L.shadow.needsUpdate = true;
    if (this.post) {
      this.post.radius = THREE.MathUtils.clamp(r * 0.12, 0.04, 0.35);
      this.post.stage = { center: c, radius: r };
    }
    this.dirty = true;
  }

  // 'outdoor': soft sky + sun (Crossout is lit outdoors). 'studio': three's RoomEnvironment, whose
  // very bright area lights make polished bolts sparkle.
  setLighting(kind) {
    if (!this.envs[kind]) {
      if (kind === 'studio') {
        this.envs[kind] = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      } else {
        const sky = new THREE.Scene();
        const sun = new THREE.Vector3(0.45, 0.72, 0.35).normalize();
        const mat = new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false,
          uniforms: { sunDir: { value: sun } },
          vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
            void main() {
              vec3 d = normalize(vDir);
              float h = d.y;
              vec3 zenith = vec3(0.36, 0.48, 0.64) * 1.25, horizon = vec3(0.92, 0.84, 0.72) * 1.35, ground = vec3(0.24, 0.21, 0.18) * 0.7;
              vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.55)) : mix(horizon * 0.55, ground, pow(-h, 0.45));
              float s = max(dot(d, sunDir), 0.0);
              col += vec3(1.0, 0.93, 0.82) * (pow(s, 900.0) * 12.0 + pow(s, 24.0) * 0.6);
              gl_FragColor = vec4(col, 1.0);
            }`,
        });
        sky.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), mat));
        this.envs[kind] = this.pmrem.fromScene(sky, 0).texture;
        mat.dispose();
      }
    }
    this.lighting = kind;
    this.scene.environment = this.envs[kind];
    this.scene.environmentIntensity = kind === 'studio' ? 0.85 : 1.0;
    this.key.intensity = kind === 'studio' ? 1.4 : 1.7;
    this.key.color.set(kind === 'studio' ? 0xffffff : 0xfff1dc);
    // The sun sits above and to the left of the default view, so shadows fall to the right where
    // they can be seen (a light behind the camera hides every shadow behind the part).
    this.keyDir.set(kind === 'studio' ? -3 : -3.5, kind === 'studio' ? 7.5 : 7.2, kind === 'studio' ? 5.5 : 5).normalize();
    this.rim.position.set(6, 4, -5);
    this.rim.intensity = this.mode === 'map' ? 0 : kind === 'studio' ? 0.5 : 0.35; // (a map has one sun: no garage rim light)
    this.rim.visible = this.mode !== 'map'; // (and out of its shaders: a light there, dark or not, is built into every one)
    this.floor.material.opacity = kind === 'studio' ? 0.24 : 0.32;
    this.setStage(this.stages[this.mode]);
  }

  resize() {
    const p = this.canvas.parentElement;
    const w = Math.max(1, p.clientWidth), h = Math.max(1, p.clientHeight);
    const pr = Math.min(2, window.devicePixelRatio || 1); // (moved to a screen with another scale)
    if (pr !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    if (this.post) {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.post.setSize(s.x, s.y);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.camera) this.render(); // now, not on the next frame: no blank flash while resizing
    this.dirty = true;
  }

  // ---- mode ----------------------------------------------------------------------------------
  setMode(mode) {
    if (mode === this.mode) return;
    this.cameras[this.mode] = { pos: this.camera.position.clone(), target: this.controls.target.clone(), quat: this.camera.quaternion.clone(), near: this.camera.near, far: this.camera.far };
    const wasMap = this.mode === 'map';
    this.mode = mode;
    if (this.options.wireframe || !this.options.layers) for (const m of this.live) this.syncMaterial(m); // (wireframe is the 3D Viewer's only, the layers' switch Maps')
    this.partRoot.visible = mode === 'part';
    this.helpers.visible = mode === 'part';
    // (shots, their effects and sounds, and the target belong to the mode that fired them)
    this.stopShots(); this.fx.clear(); this.sounds.silence();
    if (this.target) { this.target.visible = false; this.targetKey = null; }
    this.buildRoot.visible = mode === 'build';
    this.mapRoot.visible = mode === 'map';
    this.tween = null;
    // Maps flies its own camera (mapview.js); the other modes orbit
    this.controls.enabled = mode !== 'map';
    const saved = this.cameras[mode];
    if (saved) {
      this.camera.position.copy(saved.pos);
      this.controls.target.copy(saved.target);
      this.camera.near = saved.near;
      this.camera.far = saved.far;
      this.camera.updateProjectionMatrix();
      if (mode === 'map') this.camera.quaternion.copy(saved.quat);
      else this.controls.update();
    }
    // A map has its own ground, sky and haze, and is lit outdoors: no floor or grid, and occlusion
    // only near the camera (it would shade far hillsides seen at a grazing angle).
    if (mode === 'map' || wasMap) {
      const map = mode === 'map';
      this.floor.visible = !map && this.shadows;
      if (this.post) {
        this.post.floorShadow = map ? 0 : 0.55;
        this.post.fade = map ? [60, 200] : null;
        if (map) { this.post.stage = null; this.post.radius = 0.6; }
      }
      this.key.shadow.setCascades(map ? CASCADES : 0, map ? this.shadowSize / 2 : this.shadowSize);
      if (map) {
        this.litBefore = this.lighting;
        this.setLighting('outdoor');
        // a sunny day: less light from the sky than the garage gets, a stronger sun, so shadows show
        this.scene.environmentIntensity = 0.6;
        this.key.intensity = 2.5;
        if (this.gameSky) this.setMapLight(this.gameSky); // (the map's own sky, when it has one)
      } else {
        this.setLighting(this.litBefore || this.lighting); // (back to that lighting's own levels)
        this.glowAll.value = 1; // (lamps, smoke and dust as the studio has them)
        this.fx.setMapLight(null);
        for (const v of IRRADIANCE) v.set(0, 0, 0); // (the garage's own light and camera)
        LOCAL_PROBE.on.value = 0;
        LOCAL_PROBE.env.value = null;
        if (this.post) this.post.grade = null;
      }
      this.key.castShadow = this.shadows; // (the user's switch: a map's weather may have turned the sun's off, mapview.js updateSun)
      this.shadowDirty = true;
      this.mapGlow();
      this.scene.fog = map ? this.mapFog || null : null;
      if (this.skyDome) this.skyDome.visible = map;
    }
    this.updateGrid();
    if (mode !== 'map') this.setStage(this.stages[mode]);
    this.partOutlines();
    this.dirty = true;
  }

  // Maps mode: a sky dome around the camera (the same sky the outdoor lighting comes from) and the
  // fog (fog.js): the game sky's, or with the plain sky a haze that has taken most of the view by
  // the view distance. scene.fog turns the fog on, its colour and start the fog's, its far the view's.
  setMapSky(far) {
    if (!this.skyDome) {
      const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { sunDir: { value: new THREE.Vector3(0.45, 0.72, 0.35).normalize() } },
        vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 zenith = vec3(0.36, 0.48, 0.64) * 1.25, horizon = vec3(0.92, 0.84, 0.72) * 1.1, ground = vec3(0.30, 0.28, 0.25);
            vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.5)) : mix(horizon, ground, pow(min(1.0, -h * 4.0), 0.6));
            float s = max(dot(d, sunDir), 0.0);
            col += vec3(1.0, 0.93, 0.82) * (pow(s, 900.0) * 10.0 + pow(s, 24.0) * 0.45);
            gl_FragColor = vec4(col, 1.0);
          }`,
      });
      this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
      this.skyDome.name = 'sky';
      this.skyDome.frustumCulled = false;
      this.skyDome.renderOrder = -1;
      this.skyDome.castShadow = this.skyDome.receiveShadow = false;
      this.scene.add(this.skyDome);
      this.mapFog = new THREE.Fog(new THREE.Color(0.92, 0.84, 0.72).multiplyScalar(1.1), 1, 2); // (the sky's horizon colour)
    }
    this.skyDome.material.uniforms.sunDir.value.copy(this.keyDir); // the sun where the shadows say it is
    this.skyDome.visible = this.mode === 'map' && !this.gameSky;
    this.skyDome.scale.setScalar(far * 0.9);
    this.skyDome.position.copy(this.camera.position);
    const fog = this.mapHaze || { density: 3 / far, falloff: 0, height: 0, start: 0, sunStart: 0, sunPower: 1, color: new THREE.Color(0.92, 0.84, 0.72).multiplyScalar(1.1), glow: new THREE.Color(0, 0, 0), sun: this.keyDir };
    setFog(fog);
    this.mapFog.color.copy(fog.color);
    this.mapFog.near = fog.start;
    this.mapFog.far = far;
    if (this.mode === 'map') this.scene.fog = this.mapFog;
    this.camera.far = far * 1.05;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // Maps: the game's sky (mapview.js / sky.js) - its sun (direction, colour, strength, shadows or
  // not), the light from all around (a prefiltered environment map, its diffuse irradiance), its fog
  // (fog.js presetFog) and the game's camera (post.js grade). null = the plain outdoor light.
  setMapLight(l) {
    this.gameSky = l;
    this.mapHaze = l?.fog || null;
    if (this.mode !== 'map') return;
    if (l) {
      this.keyDir.copy(l.sunDir).normalize();
      this.key.color.copy(l.sunColor);
      this.key.intensity = l.sunIntensity;
      this.scene.environment = l.envMap;
      this.scene.environmentIntensity = l.envIntensity;
    } else {
      this.setLighting('outdoor');
      this.scene.environmentIntensity = 0.6;
      this.key.intensity = 2.5;
    }
    IRRADIANCE.forEach((v, i) => (l?.irradiance ? v.copy(l.irradiance[i]) : v.set(0, 0, 0)));
    const lp = l?.local;
    LOCAL_PROBE.on.value = lp ? 1 : 0;
    LOCAL_PROBE.env.value = lp?.envMap || null;
    if (lp) {
      LOCAL_PROBE.box.set(lp.box);
      LOCAL_PROBE.irradiance.forEach((v, i) => v.copy(lp.irradiance[i]));
    }
    if (this.post) this.post.grade = l?.grade || null;
    this.glowAll.value = l?.glow ?? 1; // (the weather's lamps)
    this.fx.setMapLight(l?.fxLight || null); // (and its smoke and dust)
    if (this.skyDome) this.skyDome.visible = !l;
    this.mapGlow();
    this.shadowDirty = true;
    this.dirty = true;
  }

  // Maps' bloom and light shafts (post.js Post.glow): the game's lens dirt over the bloom, the
  // weather's shafts towards the sun. None in the other modes.
  mapGlow() {
    if (!this.post) return;
    if (this.mode !== 'map') { this.post.glow = null; return; }
    if (!this.lensDirt) {
      this.lensDirt = this.acquireTexture('textures/lens_dirt', 'albedo', 0);
      this.lensDirt.promise.then(() => this.mapGlow(), () => {});
    }
    this.post.glow = { shafts: this.gameSky?.shafts || null, sun: this.keyDir, dirt: this.lensDirt.value?.tex || null };
    this.dirty = true;
  }

  // Maps: the weather's cover on the props (DUST_FRAG) from the environment's Dust* values (strings, as
  // /mapenv sends them); null = none.
  setDust(values) {
    if ((values || null) === this.dustValues) return; // (the same again: Maps sets it with every change of its sky)
    this.dustValues = values || null;
    const d = values || {}, on = d.DustEnabled === 'true' && d.DustEnabledOnProps !== 'false'; // (2.40's presets have no OnProps: on)
    const num = (k, def) => (Number.isFinite(parseFloat(d[k])) ? parseFloat(d[k]) : def);
    if (this.dustMask) this.tex.release(this.dustMask);
    this.dustMask = null;
    DUST.xoDustMask.value = null;
    DUST.xoDustOn.value = on ? 1 : 0;
    if (on) {
      const mask = d.DustMaskEnabled === 'true' && d.DustMaskPath ? d.DustMaskPath.replace(/\\/g, '/').toLowerCase() : '';
      DUST.xoDustColor.value.setHex(parseInt(d.DustColor, 16) & 0xffffff, THREE.SRGBColorSpace);
      const band = String(d.DustByHeight || '').trim().split(/\s+/).map(Number);
      const byHeight = band.length >= 2 && band.every(Number.isFinite);
      DUST.xoDustLook.value.set(THREE.MathUtils.clamp(num('DustTransparency', 1), 0, 1), 1 - THREE.MathUtils.clamp(num('DustGloss', 0.5), 0, 1), num('DustMetalness', 0), byHeight ? 2 : d.DustByNormals === 'true' ? 1 : 0);
      DUST.xoDustBand.value.set(byHeight ? band[0] : 0, byHeight ? band[1] : 0);
      DUST.xoDustShape.value.set(num('DustHeight', 0.5), num('DustSharpness', 0.5), mask ? 1 : 0, 1 / Math.max(1, num('DustMaskScale', 128)));
      if (mask) {
        const e = (this.dustMask = this.acquireTexture(mask, 'gloss', 512));
        e.promise.then(({ tex }) => { if (this.dustMask === e) { DUST.xoDustMask.value = tex; this.dirty = true; } }, () => {});
      }
    }
    this.dirty = true;
  }

  // ---- geometry + textures ------------------------------------------------------------------
  // (fetched: /geo's answer when it came already, with /modelgeo's)
  acquireGeometry(path, lod, fetched = null) {
    return this.geo.get(`${path}|${lod}`, async (entry) => {
      const parts = parseXogm(fetched || await fetchBuf(`${DATA}/geo?path=${encodeURIComponent(path)}&lod=${lod}`));
      let bytes = 0;
      const out = parts.map((p) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
        if (p.normal) g.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3));
        const hasTangent = !!(p.tangent && p.normal);
        if (hasTangent) g.setAttribute('tangent', new THREE.BufferAttribute(p.tangent, 4));
        if (p.uv0) g.setAttribute('uv', new THREE.BufferAttribute(p.uv0, 2));
        if (p.uv1) g.setAttribute('uv1', new THREE.BufferAttribute(p.uv1, 2));
        if (p.uv2) g.setAttribute('uv2', new THREE.BufferAttribute(p.uv2, 2));
        if (p.color) g.setAttribute('color', new THREE.BufferAttribute(p.color, 4, true));
        let maxJoint = -1;
        if (p.joints && p.weights) { // skinned to the part's nodes (only used when the part is animated)
          g.setAttribute('skinIndex', new THREE.BufferAttribute(p.joints, 4));
          g.setAttribute('skinWeight', new THREE.BufferAttribute(p.weights, 4));
          for (let i = 0; i < p.joints.length; i++) if (p.weights[i] > 0 && p.joints[i] > maxJoint) maxJoint = p.joints[i];
        } else if (p.node > 0) { // rigid mesh riding on one node: every vertex fully on that bone
          const n = p.vertexCount, idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) { idx[i * 4] = p.node; w[i * 4] = 1; }
          g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
          g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
          maxJoint = p.node;
        }
        g.setIndex(new THREE.BufferAttribute(p.indices, 1));
        if (!p.normal) g.computeVertexNormals();
        g.computeBoundingBox();
        g.computeBoundingSphere();
        bytes += p.position.byteLength * 4;
        return { geometry: g, material: p.material, meshIndex: p.index, lod: p.lod, vertexCount: p.vertexCount, triangles: p.indexCount / 3, hasTangent, maxJoint };
      });
      entry.size = bytes;
      return out;
    });
  }

  acquireTexture(base, role, max) {
    const rep = this.replace.get(base);
    const key = `${rep ? 'img:' + rep.id : 'tex:' + base}|${role}|${max || 0}`;
    return this.tex.get(key, async (entry) => {
      const t = await this.fetchTexture(base, role, rep, max);
      entry.size = t.bytes;
      return t;
    });
  }

  async fetchTexture(base, role, rep, max) {
    const color = role === 'albedo' || role === 'albedo2' || role === 'emissive';
    let tex, head, bytes = 0;
    const cpu = (img) => {
      const t = new THREE.DataTexture(img.data, img.w, img.h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      bytes = img.w * img.h * 4 * 1.34;
      return t;
    };
    if (rep) {
      const img = parseXorg(await fetchBuf(`${DATA}/rgba?image=${encodeURIComponent(rep.id)}${max ? '&max=' + max : ''}`));
      tex = cpu(img);
      head = { width: img.w, height: img.h, format: 'RGBA8', layout: 'RGB', replaced: true };
    } else {
      head = parseXotx(await fetchBuf(`${DATA}/tex?base=${encodeURIComponent(base)}${role === 'normal' ? '&layout=1' : ''}${max ? '&max=' + max : ''}`));
      const f = FORMATS[head.format];
      const blockOk = head.width % 4 === 0 && head.height % 4 === 0; // WebGL wants whole BC blocks on the top level
      const srgbOk = !color || f?.ext !== 's3tc' || this.support.s3tcSrgb; // sRGB BC1-3 needs its own extension
      // three.js r174 cannot upload BC4: its format lookup checks the BC7 constant where it means
      // RED_RGTC1, finds nothing and leaves the texture empty (tree leaf masks are BC4)
      const threeOk = head.format !== 'BC4';
      if (f && (!this.support[f.ext] || !blockOk || !srgbOk || !threeOk)) {
        tex = cpu(parseXorg(await fetchBuf(`${DATA}/rgba?base=${encodeURIComponent(base)}${max ? '&max=' + max : ''}`)));
      } else if (f) {
        tex = new THREE.CompressedTexture(head.mipmaps, head.width, head.height, f.fmt, THREE.UnsignedByteType);
        tex.minFilter = head.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        bytes = head.mipmaps.reduce((a, m) => a + m.data.byteLength, 0);
      } else if (head.format === 'RGBA8') {
        tex = new THREE.DataTexture(head.mipmaps[0].data, head.width, head.height, THREE.RGBAFormat, THREE.UnsignedByteType);
        if (head.mipmaps.length > 1) { tex.mipmaps = head.mipmaps; tex.minFilter = THREE.LinearMipmapLinearFilter; } else { tex.minFilter = THREE.LinearFilter; }
        bytes = head.mipmaps.reduce((a, m) => a + m.data.byteLength, 0);
      } else { // formats the GPU path does not take (BC6H sky panoramas, a light mask): decoded by the host
        tex = cpu(parseXorg(await fetchBuf(`${DATA}/rgba?base=${encodeURIComponent(base)}${max ? '&max=' + max : ''}`)));
      }
    }
    tex.name = base;
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(8, this.support.anisotropy);
    tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return { tex, head, bytes };
  }

  // ---- materials ----------------------------------------------------------------------------
  // roughMin: the smoothest a gloss map may make a surface (map glass and polished metal reach 0.05;
  // vehicle parts keep 0.2). prop: a map prop (the weather's cover, glass that keeps its reflection).
  makeMaterial(mi, hasTangent, { texMax = 0, ghost = false, roughMin = 0.2, prop = false } = {}) {
    if (Viewer.isLamp(mi)) return this.makeLampMaterial(mi, { texMax, ghost });
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 1 });
    const guid = mi.guid || '';
    const glass = guid.startsWith('0ba5c7a3') || (mi.blend && guid.startsWith('98e16772'));
    const kind = Viewer.layerKind(mi), sets = kind ? mi.layers.slice(0, 2) : [];
    const set = (k) => sets[k] || { tiling: 1, uv: 0, invert: false, index: k + 1, blend: [0, 0, 0, 0] };
    const pin = (name) => parseFloat((mi.params || []).find((q) => q.name === name)?.value) || 0;
    const u = {
      xoHue: { value: 0 }, xoSat: { value: 1 }, xoBri: { value: 0 }, xoCon: { value: 1 },
      xoTint: { value: new THREE.Color(1, 1, 1) }, xoTintAmt: { value: 0 },
      xoPaint: { value: new THREE.Color(1, 1, 1) }, xoPaintAmt: { value: 0 },
      xoPaintMask: { value: null }, xoHasMask: { value: 0 }, xoNmLayout: { value: 0 },
      xoOverlay: { value: new THREE.Color(1, 1, 1) }, xoOverlayAmt: { value: 0 },
      // shared: how strongly the gloss map's blue channel makes a texel metallic; glass is never metal
      // (its gloss maps' blue is near 1: windows came out as chrome)
      xoMetal: glass ? { value: 0 } : this.metal,
      xoGlowAll: this.glowAll,
      xoRoughMin: { value: roughMin },
      xoUv0: { value: new THREE.Vector2(mi.uvScale ?? 1, mi.uvSet ?? 0) },
      xoAlb2: { value: null }, xoNrm2: { value: FLAT_NORMAL }, xoGls2: { value: PLAIN_GLOSS },
      xoAlb3: { value: null }, xoNrm3: { value: FLAT_NORMAL }, xoGls3: { value: PLAIN_GLOSS }, xoMaskMap: { value: null },
      xoLayerUv: { value: [0, 1].map((k) => new THREE.Vector4(set(k).tiling, set(k).uv, set(k).invert ? 1 : 0, set(k).index)) },
      xoLayerBlend: { value: [0, 1].map((k) => new THREE.Vector4(...set(k).blend)) },
      xoLayerNm: { value: [2, 2] }, xoLayersOn: { value: 0 },
      xoDetail: { value: FLAT_NORMAL }, xoDetailTiling: { value: mi.detailTiling || 0 }, xoDetailNm: { value: 2 },
      // a paint's pattern or ramp, its relief, and its repeats and UV set (syncPaint)
      xoPaintTex: { value: WHITE }, xoPaintNrm: { value: FLAT_NORMAL }, xoPaintNrmLayout: { value: 2 }, xoPaintUv: { value: new THREE.Vector2(1, 1) },
      xoPaintFinish: { value: new THREE.Vector2(1, 0) },
      ...(prop ? DUST : {}),
    };
    // (leaves and grass have no gloss map: matte, not the 0.55 that made crowns glitter with the sky)
    const roughNoMap = guid.startsWith('06bc377b') || guid.startsWith('a658e182') || guid.startsWith('63ba6d0f') ? 0.95 : 0.55;
    // (noPaint: glass takes no model's paint: the game draws it with a shader of its own)
    m.userData.xo = { u, info: mi, hasTangent, texMax, entries: {}, maps: {}, layouts: {}, roughNoMap, sets: sets.length, noPaint: glass };
    // What the shader adds (see UV0_VERT, LAYER_FRAG, DETAIL_NORMAL, MASK_GLOSS, DUST_FRAG, GLASS_OUT, SSS_FRAG).
    if ((mi.uvScale ?? 1) !== 1 || mi.uvSet) m.defines.XO_UV0 = '';
    if (sets.length) {
      Object.assign(m.defines, { XO_LAYERS: sets.length, XO_KIND: kind, XO_WEIGHTS: kind !== 1 ? 0 : mi.weights === 'vertex' ? 1 : mi.weights === 'colormap' ? 2 : 0 });
      if (this.layerMask(mi)) m.defines.XO_MASKMAP = '';
    }
    if (m.defines.XO_UV0 !== undefined || sets.length) m.defaultAttributeValues = { uv1: [0, 0], uv2: [0, 0], color: [0, 0, 0, 0] }; // (a mesh without them)
    if (mi.detailTiling > 0 && this.texFor('detail', mi)) m.defines.XO_DETAIL = '';
    if (mi.maskFromGloss) m.defines.XO_MASK_GLOSS = '';
    if (prop) m.defines.XO_DUST = '';
    if (prop && mi.blend && !guid.startsWith('85f3a2ed')) { m.defines.XO_GLASS = ''; m.premultipliedAlpha = true; }
    if (pin('SubsurfaceScattering') || pin('SssSoftLight')) m.defines.XO_SSS = '';
    if (pin('DoubleSided')) m.side = THREE.DoubleSide; // (a coach's lamp glass)
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      useLocalProbe(shader);
      // Mirrored parts (negative scale) would flip the normal map's Y; correct it per object.
      shader.vertexShader = shader.vertexShader.replace('#include <normal_vertex>',
        THREE.ShaderChunk.normal_vertex.replace('cross( vNormal, vTangent ) * tangent.w', 'cross( vNormal, vTangent ) * tangent.w * sign( determinant( mat3( modelMatrix ) ) )'))
        // belts, chains and tracks: their texture slides (XO_BELT, set by belts.js in the 3D Viewer)
        .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\n' + BELT_VERT_HEAD + UV0_VERT_HEAD + LAYER_VERT_HEAD)
        .replace('#include <uv_vertex>', UV0_VERT + '\n' + BELT_VERT)
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + LAYER_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\n' + FRAG_HEAD + '\nuniform float xoRoughMin;' + DETAIL_HEAD + LAYER_FRAG_HEAD + DUST_HEAD)
        .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace('diffuseColor *= sampledDiffuseColor;', PAINT_AT) + MAP_ALPHA_KEEP + MASK_GLOSS)
        .replace('#include <alphatest_fragment>', ALPHA_TEST)
        .replace('#include <normal_fragment_maps>', NORMAL_MAPS + PAINT_NORMAL + LAYER_FRAG + DUST_FRAG)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + SSS_FRAG)
        .replace('#include <aomap_fragment>', AO_FROM_NORMAL)
        .replace('#include <opaque_fragment>', GLASS_OUT)
        .replace('#include <roughnessmap_fragment>', THREE.ShaderChunk.roughnessmap_fragment.replace('texelRoughness.g', 'max( xoRoughMin, 1.0 - texelRoughness.g )'))
        // The gloss map's blue channel marks bare metal (high on gun steel, ~0 on rubber and paint).
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n#ifdef USE_ROUGHNESSMAP\n\tmetalnessFactor = xoMetal * texture2D( roughnessMap, vRoughnessMapUv ).b;\n#endif' + PAINT_FINISH)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= xoGlowAll;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, xoOverlay, xoOverlayAmt );');
    };
    m.customProgramCacheKey = () => 'xo-standard-13';
    // Without tangents three builds the frame from UV derivatives; our UVs have V down.
    if (!hasTangent) m.normalScale.set(1, -1);
    if (mi.alphaTest) { // nets, grates, fences, grass, leaves: cut out where the alpha is low
      m.alphaTest = 0.5;
      m.alphaToCoverage = true; // (soft edges in the multisampled view, no stair-steps or shimmer)
    }
    if (mi.blend) { // glass: see-through by the albedo alpha
      m.transparent = true;
      m.depthWrite = false;
    }
    if (guid.startsWith('85f3a2ed')) { // overlays lie on the surface they mark (0-5 mm off it): drawn over it
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -4;
    }
    if (ghost) { // the held part in the builder: see-through, like the garage's
      m.transparent = true;
      m.opacity = 0.5;
      m.depthWrite = false;
    }
    if (Array.isArray(mi.color)) m.color.setRGB(mi.color[0], mi.color[1], mi.color[2], THREE.LinearSRGBColorSpace); // (the plain-colour shader)
    this.live.add(m);
    const alb = this.texFor('albedo', mi);
    if (alb) this.applyAdjustTo(m, this.adjust.get(alb.base));
    this.syncMaterial(m);
    return m;
  }

  // a glow shader's material (see LAMP_VERT): its look comes from the host (material.glow)
  static isLamp(mi) { return !!mi?.glow; }

  // An overlay's (85F3A2ED) glow map is lit by User1 = 1, as the map props' main shader's is (whose
  // "_no_glow" / "_nolight" variants are the same materials without User1): the new-year houses' and
  // the elevator manors' wood_detales_8m_glow windows (42 overlays in assets/props, and the
  // lighthouse's windows01_glow, none with User1) stay dark in the game's night capture of
  // newyear_foray (new_year_dark2: the barn's windows 8/4/10 against 53/48/42 lit); the one overlay
  // with User1 (oracle_altar's coal_e) keeps its glow.
  static glowOff(mi) {
    if (!(mi?.guid || '').startsWith('85f3a2ed')) return false;
    return parseFloat((mi.params || []).find((q) => q.name === 'User1')?.value) !== 1;
  }

  // A map material that blends texture sets (LAYER_FRAG): 1 the layered shader, 2 and 3 the two-layer
  // ones; 0 for any other.
  static layerKind(mi) {
    const g = mi?.guid || '';
    return !mi?.layers?.length ? 0 : g.startsWith('64177e0a') ? 1 : g.startsWith('62bd5a8e') ? 2 : g.startsWith('e611362b') ? 3 : 0;
  }

  // ... the colour map that weighs the layers of a layered one (read through uv2)
  layerMask(mi) { return Viewer.layerKind(mi) === 1 && mi.weights === 'colormap' ? this.texFor('colormap', mi) : undefined; }

  // A glow piece (see LAMP_VERT): unlit, added onto whatever is behind it, never in shadows, picking
  // or outlines of whole parts. Its textures arrive as maps.d (shown as its map) and maps.c.
  makeLampMaterial(mi, { texMax = 0, ghost = false } = {}) {
    const g = mi.glow, num = (x) => (Number.isFinite(+x) ? +x : 0);
    const scroll = [0, 1, 2, 3].map((i) => num(g.scroll?.[i])), additive = g.additive !== false;
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false, opacity: ghost ? 0.5 : 1,
      // added: colour onto what is behind, alpha "over" (stays 1 on surfaces, the glow's strength on
      // the background); see-through: plain "over" for both
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: additive ? THREE.OneFactor : THREE.SrcAlphaFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, // (laid onto the surface: no z-fighting)
      side: g.twoSided ? THREE.DoubleSide : THREE.FrontSide, // (pin User2: garland strings, signs)
    });
    const u = {
      xoHue: { value: 0 }, xoSat: { value: 1 }, xoBri: { value: 0 }, xoCon: { value: 1 },
      xoTint: { value: new THREE.Color(1, 1, 1) }, xoTintAmt: { value: 0 },
      xoPaint: { value: new THREE.Color(1, 1, 1) }, xoPaintAmt: { value: 0 },
      xoPaintMask: { value: null }, xoHasMask: { value: 0 }, xoNmLayout: { value: 0 },
      xoOverlay: { value: new THREE.Color(1, 1, 1) }, xoOverlayAmt: { value: 0 }, xoMetal: this.metal, xoGlowAll: this.glowAll,
      xoLampC: { value: WHITE }, xoLampGain: { value: Math.max(0, num(g.gain)) }, xoLampAlpha: { value: additive ? 0 : 1 },
      xoLampSwap: { value: g.swap ? 1 : 0 }, xoLampRot: { value: 0 }, xoLampOff: { value: new THREE.Vector4() },
    };
    const lamp = { scroll, spin: num(g.spin), swap: !!g.swap, gain: num(g.gain), additive };
    m.userData.xo = { u, info: mi, hasTangent: false, texMax, entries: {}, maps: {}, lamp };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\n' + LAMP_VERT_HEAD)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + LAMP_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\n' + FRAG_HEAD + LAMP_FRAG_HEAD)
        .replace('#include <map_fragment>', LAMP_FRAG)
        .replace('#include <fog_fragment>', LAMP_FOG);
    };
    m.customProgramCacheKey = () => 'xo-lamp-3';
    if (lamp.spin || scroll.some((v) => v)) this.lampAnims.add(m);
    this.live.add(m);
    const d = this.lampTexture(mi, 'd');
    if (d) this.applyAdjustTo(m, this.adjust.get(d.base));
    this.syncMaterial(m);
    return m;
  }

  // A mesh drawn with a lamp material: the mouse goes through it (its glow covers only bits of it) and
  // drawing it keeps the lamps moving (stepLamps).
  markLampMesh(mesh) {
    mesh.userData.lamp = true;
    mesh.raycast = () => {};
    if (this.lampAnims.has(mesh.material)) mesh.onBeforeRender = () => { this.lampSeen = performance.now(); };
  }

  // a glow material's d or c texture, if the game has it
  lampTexture(mi, which) { const base = mi?.glow?.[which]; return base ? (mi.textures || []).find((t) => t.base === base && t.exists) : undefined; }

  // The textures a material shows: [{ slot, t, role }] (role: how the texture is fetched and cached).
  materialTextures(mi) {
    if (Viewer.isLamp(mi)) {
      const out = [];
      for (const slot of ['d', 'c']) {
        const t = this.lampTexture(mi, slot);
        if (t) out.push({ slot, t, role: 'albedo' }); // (both colour: sRGB, shared with albedo uses)
      }
      return out;
    }
    const out = [];
    for (const role of ['albedo', 'normal', 'gloss', 'emissive', 'mask']) {
      const t = this.texFor(role, mi);
      if (t && (role !== 'mask' || mi.alphaTest) && !(role === 'emissive' && Viewer.glowOff(mi))) out.push({ slot: role, t, role });
    }
    // a map material's further texture sets and what weighs them (LAYER_FRAG), its detail normal map
    for (const k of [2, 3].slice(0, Viewer.layerKind(mi) ? mi.layers.length : 0))
      for (const role of ['albedo', 'normal', 'gloss']) {
        const t = this.texFor(role + k, mi);
        if (t) out.push({ slot: role + k, t, role });
      }
    const mask = this.layerMask(mi), detail = mi.detailTiling > 0 && this.texFor('detail', mi);
    if (mask) out.push({ slot: 'layerMask', t: mask, role: 'gloss' });
    if (detail) out.push({ slot: 'detail', t: detail, role: 'normal' });
    return out;
  }

  texFor(role, mi) { return (mi?.textures || []).find((t) => t.role === role && t.exists); }

  // Starts (or restarts, for one base) the texture loads of a material.
  loadMaterialTextures(m, onlyBase = null) {
    const x = m.userData.xo;
    const jobs = [];
    for (const { slot: role, t, role: fetchRole } of this.materialTextures(x.info)) {
      if (onlyBase && t.base !== onlyBase) continue;
      const old = x.entries[role];
      const entry = this.acquireTexture(t.base, fetchRole, x.texMax);
      x.entries[role] = entry;
      if (old && old !== entry) this.tex.release(old);
      else if (old === entry) this.tex.release(old); // acquired twice: drop the extra reference
      jobs.push(entry.promise.then(({ tex, head }) => {
        if (x.disposed || x.entries[role] !== entry) return;
        x.maps[role] = tex;
        if (role === 'normal') {
          x.u.xoNmLayout.value = head.layout === 'RG' ? 1 : head.layout === 'RGB' ? 2 : 0; // (AG: its occlusion read with it, AO_FROM_NORMAL)
        } else if (fetchRole === 'normal') {
          x.layouts[role] = head.layout === 'RG' ? 1 : head.layout === 'RGB' ? 2 : 0; // (a further set's, the detail map's)
        }
        if (role === 'gloss') { x.u.xoPaintMask.value = tex; x.u.xoHasMask.value = 1; }
        this.syncMaterial(m);
      }, (e) => {
        if (!x.disposed && x.entries[role] === entry) { (x.failed ||= {})[role] = true; this.syncMaterial(m); } // (a cut-out waits no more for it)
        throw e;
      }));
    }
    return Promise.allSettled(jobs).then((rs) => rs.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason)));
  }

  disposeMaterial(m) {
    const x = m.userData.xo;
    x.disposed = true;
    for (const e of Object.values(x.entries)) this.tex.release(e);
    for (const h of Object.values(x.paintTex || {})) this.tex.release(h.entry);
    this.live.delete(m);
    this.lampAnims.delete(m);
    m.dispose();
  }

  syncMaterial(m) {
    const x = m.userData.xo, on = this.options.textures;
    if (x.lamp) { // a glow needs its texture: none while it loads, or with textures off
      const map = on ? x.maps.d || null : null;
      if (m.map !== map) { m.map = map; m.needsUpdate = true; }
      x.u.xoLampC.value = x.maps.c || WHITE;
      m.visible = !!map;
      m.wireframe = this.options.wireframe && this.mode === 'part';
      this.dirty = true;
      return;
    }
    // (a texture still loading: its stand-in, LOADING; none for one that failed; a cut-out stays hidden
    // till its albedo and mask are in, see below)
    x.slots ||= new Set(this.materialTextures(x.info).map((s) => s.slot));
    const standIn = (role) => (x.slots.has(role) && !x.failed?.[role] ? LOADING[role] : null);
    const slot = (role) => !on ? null : x.maps[role] || standIn(role);
    const want = {
      map: slot('albedo'), normalMap: slot('normal'), roughnessMap: slot('gloss'), emissiveMap: slot('emissive'),
      alphaMap: x.maps.mask || standIn('mask'), // tree leaves: cut out by their own mask (_at), not the albedo's alpha
    };
    let changed = false;
    for (const k of Object.keys(want)) if (m[k] !== want[k]) { m[k] = want[k]; changed = true; }
    // A cut-out shows once what cuts it is in (its albedo, a tree's leaf mask): three makes the shadow
    // pass's copy of a material the first time it casts with a cut-out map and never rebuilds that
    // copy's shader, so a tree that cast before its mask came kept its leaves' shadows cut by the wrong map.
    const waits = (role) => !x.maps[role] && !x.failed?.[role] && (role !== 'albedo' || on) && !!this.texFor(role, x.info);
    m.visible = !(x.info.alphaTest && (waits('mask') || waits('albedo')));
    m.roughness = on && x.maps.gloss ? 1 : x.roughNoMap ?? 0.55;
    const e = want.emissiveMap ? (x.info.heat ? this.options.heat : 1) * (x.info.emissiveGain ?? 1) : 0;
    m.emissive.setRGB(e, e, e);
    const u = x.u;
    if (x.sets) { // the further texture sets (LAYER_FRAG), drawn once every texture they read is in
      for (const k of [2, 3]) {
        u[`xoAlb${k}`].value = x.maps[`albedo${k}`] || null;
        u[`xoNrm${k}`].value = x.maps[`normal${k}`] || FLAT_NORMAL;
        u[`xoGls${k}`].value = x.maps[`gloss${k}`] || PLAIN_GLOSS;
      }
      u.xoLayerNm.value = [2, 3].map((k) => (x.maps[`normal${k}`] ? x.layouts[`normal${k}`] ?? 0 : 2));
      u.xoMaskMap.value = x.maps.layerMask || null;
      const ready = this.materialTextures(x.info).every(({ slot }) => !/\d$|^layerMask$/.test(slot) || x.maps[slot]);
      u.xoLayersOn.value = on && (this.options.layers || this.mode !== 'map') && ready ? 1 : 0; // (Maps' switch: the other modes always draw them)
    }
    u.xoDetail.value = x.maps.detail || FLAT_NORMAL;
    u.xoDetailNm.value = x.maps.detail ? x.layouts.detail ?? 0 : 2;
    m.wireframe = this.options.wireframe && this.mode === 'part'; // (the 3D Viewer's switch: the builder and Maps have none)
    if (changed) m.needsUpdate = true;
    this.dirty = true;
  }

  applyAdjustTo(m, a) {
    const x = m.userData.xo, u = x.u;
    a = a || {};
    u.xoHue.value = a.hue || 0;
    u.xoSat.value = a.saturation ?? 1;
    u.xoBri.value = a.brightness || 0;
    u.xoCon.value = a.contrast ?? 1;
    u.xoTintAmt.value = a.tintAmount || 0;
    u.xoTint.value.setRGB(...(a.tint || [1, 1, 1]), THREE.NoColorSpace);
    x.adj = a; // (its paint shows unless the model has a paint of its own: syncPaint)
    this.syncPaint(m);
    this.dirty = true;
  }

  // ---- paint (paints.js) -------------------------------------------------------------------------
  // A model's own paint: the builder's (the vehicle's, or a part's own) and the 3D Viewer's. It takes the
  // place of the paint its textures' colour edits have (Colours…) on each of its materials; null: none of
  // its own (the textures' paint shows), amount 0: none at all. Its models shown on its nodes (a
  // launcher's loaded rounds) are left as they are.
  setModelPaint(group, paint) {
    if (!group) return;
    const p = paint ? normPaint(paint) : null;
    if (group.userData.paint !== undefined && paintKey(group.userData.paint) === paintKey(p)) return;
    group.userData.paint = p;
    for (const m of group.userData.materials || []) {
      const x = m.userData.xo;
      if (x.lamp) continue;
      x.paint = p;
      this.syncPaint(m);
    }
    this.dirty = true;
  }

  // The paint a model was given (a copy sharing its materials: theirs); null for none.
  paintOf(group) {
    if (!group) return null;
    if (group.userData.paint !== undefined) return group.userData.paint;
    let p = null;
    group.traverse((o) => { if (!p && o.isMesh && o.material?.userData?.xo?.paint) p = o.material.userData.xo.paint; });
    return p;
  }

  // The 3D Viewer's paint: on the part shown, and on the next one opened.
  setPartPaint(paint) {
    this.partPaint = paint ? normPaint(paint) : null;
    if (this.part) this.setModelPaint(this.part, this.partPaint);
  }

  // A material's paint as the shader draws it: the model's own, else its albedo's colour edit's; a
  // pattern or chameleon builds the shader with their code (XO_PAINT_*), a plain colour or none without.
  syncPaint(m) {
    const x = m.userData.xo, u = x.u;
    if (x.lamp || !u.xoPaintUv) return;
    const a = x.adj || {};
    const p = (x.noPaint ? null : x.paint) || (a.paintAmount > 0 ? { kind: 'color', color: a.paint || [1, 1, 1], amount: a.paintAmount } : null);
    const on = !!p && p.amount > 0;
    const tex = on && p.kind !== 'color' ? p.tex || '' : '';
    const pattern = !!tex && p.kind === 'pattern', cham = !!tex && p.kind === 'chameleon';
    // (a mesh without the second UV set: a pattern's mean colour, no relief)
    const flat = pattern && !!x.noUv1, nrm = tex && p.normal && !x.noUv1 ? p.normal : '';
    u.xoPaintAmt.value = on ? p.amount : 0;
    u.xoPaint.value.setRGB(...(on && p.color ? p.color : [1, 1, 1]), THREE.NoColorSpace);
    u.xoPaintUv.value.set(pattern && p.scale > 0 ? p.scale : 1, x.noUv1 ? 0 : 1);
    const fin = on && FINISHES[p.finish];
    if (fin) u.xoPaintFinish.value.set(fin.rough, fin.metal);
    const want = { XO_PAINT_PATTERN: pattern, XO_PAINT_FLAT: flat, XO_PAINT_CHAM: cham, XO_PAINT_NRM: !!nrm, XO_PAINT_UV: (pattern && !flat) || !!nrm, XO_PAINT_FINISH: !!fin };
    let changed = false;
    for (const [k, w] of Object.entries(want)) {
      if (w === (m.defines[k] !== undefined)) continue;
      if (w) m.defines[k] = ''; else delete m.defines[k];
      changed = true;
    }
    if (want.XO_PAINT_UV && !m.defaultAttributeValues?.uv1) m.defaultAttributeValues = { ...(m.defaultAttributeValues || {}), uv1: [0, 0] }; // (a mesh without the set)
    this.paintTexture(m, 'tex', pattern || cham ? tex : '', 'albedo');
    this.paintTexture(m, 'nrm', nrm, 'normal');
    if (changed) m.needsUpdate = true;
    this.dirty = true;
  }

  // A material's paint texture (slot tex: the pattern or the chameleon's ramp, nrm: its relief), held
  // while the material shows it; white and flat until it is in.
  paintTexture(m, slot, base, role) {
    const x = m.userData.xo, held = (x.paintTex ||= {}), cur = held[slot];
    if ((cur?.base || '') === base) return;
    if (cur) this.tex.release(cur.entry);
    delete held[slot];
    const uni = slot === 'tex' ? x.u.xoPaintTex : x.u.xoPaintNrm;
    uni.value = slot === 'tex' ? WHITE : FLAT_NORMAL;
    if (slot === 'nrm') x.u.xoPaintNrmLayout.value = 2;
    if (!base) return;
    const entry = this.acquireTexture(base, role, x.texMax);
    held[slot] = { base, entry };
    entry.promise.then(({ tex, head }) => {
      if (x.disposed || held[slot]?.entry !== entry) return;
      uni.value = tex;
      if (slot === 'nrm') x.u.xoPaintNrmLayout.value = head.layout === 'RG' ? 1 : head.layout === 'RGB' ? 2 : 0;
      this.dirty = true;
    }, () => {});
  }

  // Live colour edits for every material (any part, any mode) that uses this albedo texture.
  setAdjust(albedoBase, a) {
    if (a) this.adjust.set(albedoBase, a); else this.adjust.delete(albedoBase);
    for (const m of this.live) {
      const alb = this.texFor('albedo', m.userData.xo.info);
      if (alb && alb.base === albedoBase) this.applyAdjustTo(m, a);
    }
  }

  // Swap a texture for an imported image (rep = { id }) or back to the game's (rep = null).
  async setReplacement(base, rep) {
    const cur = this.replace.get(base);
    if ((cur && rep && cur.id === rep.id) || (!cur && !rep)) return;
    if (rep) this.replace.set(base, rep); else this.replace.delete(base);
    const jobs = [];
    for (const m of this.live)
      if (this.materialTextures(m.userData.xo.info).some((s) => s.t.base === base)) jobs.push(this.loadMaterialTextures(m, base));
    await Promise.all(jobs);
    this.tex.collect();
  }

  // ---- model groups (shared by viewer and build mode) ----------------------------------------
  // Bones for a part's nodes. Rest transforms come from the nodes' world matrices, so the rest
  // pose is exactly the pose the mesh was bound in.
  static makeSkeleton(nodes) {
    const root = new THREE.Group();
    root.name = 'skeleton';
    const world = nodes.map((n) => new THREE.Matrix4().fromArray(n.matrix));
    const bones = nodes.map((n) => Object.assign(new THREE.Bone(), { name: n.name }));
    const rest = [];
    nodes.forEach((n, i) => {
      const parent = n.parent >= 0 && n.parent < nodes.length && n.parent !== i ? n.parent : -1;
      const local = parent >= 0 ? world[parent].clone().invert().multiply(world[i]) : world[i].clone();
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      local.decompose(p, q, s);
      bones[i].position.copy(p);
      bones[i].quaternion.copy(q);
      bones[i].scale.copy(s);
      rest.push({ p, q: q.clone() });
      (parent >= 0 ? bones[parent] : root).add(bones[i]);
    });
    return { root, bones, rest, skeleton: new THREE.Skeleton(bones, world.map((m) => m.clone().invert())) };
  }

  // The pose a part shows by itself in the 3D Viewer: its idle at the start, every aim, steering and
  // other parameter at 0 (a wheel's spring at the height it was made at: Animator.restSprings). The bind pose a model was made in is often another (a mortar's barrel stands
  // straight up in it, 50 of the 264 moving weapons are more than 1 cm off), so static copies (the
  // builder's parts, their pictures, a build's export) are baked in this one. Resolves to { trs: per
  // node its local translation, rotation and scale (what an export takes), skin: per node the matrix
  // that takes a bound vertex there } or null (the part does not move, or this pose is its bind pose).
  restPose(info) {
    let p = this.restPoses.get(info.path); // (skins share the skeleton and the clips)
    if (!p) this.restPoses.set(info.path, (p = this.measureRestPose(info).catch(() => null)));
    return p;
  }

  async measureRestPose(info) {
    const nodes = info.nodes || [];
    if (!nodes.length || !(info.layers || []).some((l) => l.file || l.files?.length > 1)) return null;
    const skel = Viewer.makeSkeleton(nodes), group = new THREE.Group();
    group.userData.skeleton = skel;
    group.add(skel.root);
    const anim = new Animator(this, info, group);
    await anim.load(); // (and puts the default on: the viewer's starting pose)
    group.updateMatrixWorld(true);
    const skin = skel.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skel.skeleton.boneInverses[i]).elements.slice());
    skel.skeleton.dispose();
    if (!skin.some((m) => m.some((e, k) => Math.abs(e - (k % 5 === 0 ? 1 : 0)) > 1e-5))) return null;
    const r = (v) => Math.round(v * 1e7) / 1e7;
    return { trs: skel.bones.map((b) => [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()].map(r)), skin };
  }

  // A part's meshes baked in its rest pose (restPose), cached like the plain ones.
  acquirePosedGeometry(path, lod, pose) {
    return this.geo.get(`${path}|${lod}|posed`, async (entry) => {
      const base = this.acquireGeometry(path, lod);
      try {
        const parts = await base.promise;
        let bytes = 0;
        const out = parts.map((p) => {
          const geometry = bakePose(p.geometry, pose.skin, p.maxJoint);
          bytes += geometry.attributes.position.array.byteLength * 4;
          return { ...p, geometry, triangles: geometry.index.count / 3 };
        });
        entry.size = bytes;
        return out;
      } finally {
        this.geo.release(base);
      }
    });
  }

  // animate: skinned meshes on a skeleton (3D Viewer); otherwise plain static meshes, in the part's
  // rest pose (restPose). paint: its own paint (setModelPaint), when it has one.
  async makeModel(info, lod, { texMax = 0, ghost = false, animate = false, paint } = {}) {
    const pose = animate ? null : await this.restPose(info);
    const geoEntry = pose ? this.acquirePosedGeometry(info.path, lod, pose) : this.acquireGeometry(info.path, lod);
    let parts;
    try { parts = await geoEntry.promise; } catch (e) { this.geo.release(geoEntry); throw e; }
    const group = new THREE.Group();
    const mats = new Map();
    let tris = 0, verts = 0;
    const nodes = info.nodes || [];
    const skel = animate && (info.layers || []).some((l) => l.file || l.files?.length > 1) && parts.some((p) => p.maxJoint >= 0 && p.maxJoint < nodes.length)
      ? Viewer.makeSkeleton(nodes) : null;
    for (const p of parts) {
      const mi = info.materials[p.material] || {};
      if (mi.invisible) continue; // this skin hides the slot
      const k = `${p.material}|${p.hasTangent}`;
      let mat = mats.get(k);
      if (!mat) { mat = this.makeMaterial(mi, p.hasTangent, { texMax, ghost }); mats.set(k, mat); }
      if (!p.geometry.attributes.uv1 && !mat.userData.xo.noUv1) { // (a paint's pattern goes over its first set: syncPaint)
        mat.userData.xo.noUv1 = true;
        mat.userData.xo.u.xoPaintUv?.value.setY(0);
      }
      const skinned = skel && p.maxJoint >= 0 && p.maxJoint < nodes.length;
      const mesh = skinned ? new THREE.SkinnedMesh(p.geometry, mat) : new THREE.Mesh(p.geometry, mat);
      if (skinned) {
        mesh.bind(skel.skeleton, new THREE.Matrix4());
        mesh.frustumCulled = false; // bounds move with the bones
      }
      const lamp = mat.userData.xo.lamp;
      mesh.castShadow = !ghost && !mi.blend && !lamp; // glass lets the light through
      mesh.receiveShadow = !ghost && !lamp;
      mesh.userData = { material: p.material, triangles: p.triangles, vertexCount: p.vertexCount };
      if (lamp) this.markLampMesh(mesh);
      group.add(mesh);
      tris += p.triangles;
      verts += p.vertexCount;
    }
    const materials = [...mats.values()];
    const box = new THREE.Box3();
    for (const c of group.children) box.union(c.geometry.boundingBox);
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.15, 0, -0.15), new THREE.Vector3(0.15, 0.3, 0.15));
    if (skel) group.add(skel.root);
    // the weld points in the model's frame; each one's lift off the part (weldLifts) is worked out
    // the first time a marker needs it
    const slots = (info.slots || []).map((s) => ({ name: s.name, ring: ringSlot(s.name), ...slotFrame(s.matrix) }));
    const liftKey = `${info.path}|${info.skin || ''}|${lod}`;
    slots.forEach((s, i) => Object.defineProperty(s, 'lift', { enumerable: false, get: () => this.weldLifts(liftKey, group, slots)[i] }));
    group.userData = {
      info, lod, geoEntry, materials, tris, verts, box, skeleton: skel, slots, pose, // (pose: the rest pose its meshes are baked in)
      ready: Promise.all(materials.map((m) => this.loadMaterialTextures(m))).then((l) => l.flat()),
    };
    if (paint) this.setModelPaint(group, paint);
    this.dirty = true;
    return group;
  }

  // Models the game shows on a part's nodes (a launcher's loaded projectiles on its deploy points):
  // each one rides its node's bone, so the clips move it (the Porcupine's next barrel rolls forward
  // with the reload); without a skeleton it stands at the node. They count in the framing box, their
  // textures in the part's "ready", and they go with the part. attachments: [{ info, node, nodeName,
  // label }] (label: its name, for the tooltip).
  async attach(group, attachments, lod) {
    const made = await Promise.all(attachments.map((a) => this.makeModel(a.info, Math.min(lod, Math.max(0, (a.info.lodCount || 1) - 1)), { texMax: 0 })
      .then((g) => ({ g, a }), () => null)));
    const skel = group.userData.skeleton, nodes = group.userData.info.nodes || [];
    const box = group.userData.box.clone();
    group.userData.attached = [];
    for (const m of made) {
      if (!m) continue;
      const { g, a } = m, at = nodes[a.node];
      if (!at) { this.disposeModel(g); continue; }
      const world = new THREE.Matrix4().fromArray(at.matrix);
      if (skel?.bones[a.node]) {
        skel.bones[a.node].add(g); // (its own frame is the bone's: the clips carry it)
      } else {
        g.matrixAutoUpdate = false;
        g.matrix.copy(world);
        group.add(g);
      }
      g.userData.attachedTo = a.node;
      g.userData.label = a.label || a.info.path.split('/').pop().replace(/\.mdl$/, '');
      g.userData.nodeName = a.nodeName || at.name || '';
      g.userData.home = new THREE.Vector3().setFromMatrixPosition(world); // (its slot, in the part's frame: syncAttached)
      g.userData.radius = g.userData.box.getSize(new THREE.Vector3()).length() / 2;
      group.userData.attached.push(g);
      box.union(g.userData.box.clone().applyMatrix4(world));
    }
    group.userData.box = box;
    const own = group.userData.ready;
    group.userData.ready = Promise.all([own, ...group.userData.attached.map((g) => g.userData.ready)]).then((l) => l.flat());
  }

  // The models shown on a part's nodes as its clips move them (after every pose: Animator.apply).
  // Two loaded projectiles never sit inside each other: the Porcupine's FIRE and reload roll the next
  // barrel in from the back slot, so the barrel resting there is that one and gives way until the slot
  // is free again. While the part fires (firing), one that jumps out of its own slot in a single step
  // (fired: the clip starts over with the next round) flies on out of the part, the way the next one
  // comes in (stepShots).
  syncAttached(group, firing = false) {
    const att = group.userData.attached;
    if (!att?.length) return;
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const skel = group.userData.skeleton;
    for (const g of att) {
      const u = g.userData;
      u.rel ||= new THREE.Matrix4();
      u.lastRel ||= new THREE.Matrix4();
      u.lastRel.copy(u.rel);
      u.rel.multiplyMatrices(inv, g.matrixWorld);
      const p = new THREE.Vector3().setFromMatrixPosition(u.rel);
      u.away = p.distanceTo(u.home) > 0.01;
      u.inBox = (u.inBox || new THREE.Box3()).copy(u.box).applyMatrix4(u.rel);
      // Fired: its own node slid it out of its slot, lengthwise, in one step (the clip starts over with
      // the next round coming in from there); a drum turning or an arm swinging it round is no shot.
      const bone = skel?.bones[u.attachedTo], rest = skel?.rest[u.attachedTo];
      if (!bone || !rest) continue;
      const off = bone.position.clone().sub(rest.p), along = off.clone().applyQuaternion(rest.q.clone().invert());
      // (not when the gun's rounds fly as this model all the way: FxView.fire)
      if (firing && u.lastOff && u.lastOff.lengthSq() < 1e-4 && off.length() > 0.5 * u.radius && Math.abs(along.z) > 0.9 * along.length()
        && !this.shotFor?.(group.userData.info?.path)?.mesh) {
        const parentRel = new THREE.Matrix4().multiplyMatrices(inv, bone.parent.matrixWorld);
        this.launch(group, g, u.lastRel, off.clone().negate().transformDirection(parentRel));
      }
      u.lastOff = off;
    }
    const shrunk = (b) => { const s = b.getSize(new THREE.Vector3()).multiplyScalar(-0.15); return b.clone().expandByVector(s); };
    for (const g of att) {
      const u = g.userData;
      const show = u.away || !att.some((o) => o !== g && o.userData.away && shrunk(o.userData.inBox).intersectsBox(shrunk(u.inBox)));
      if (g.visible !== show) { g.visible = show; this.shadowDirty = true; this.dirty = true; }
    }
  }

  // A fired model: a copy (same geometry and materials) leaves from where it stood, 2 m out along
  // dir in 0.3 s (Animator.tick moves it with the animation's clock), then goes.
  launch(group, g, rel, dir) {
    const shot = new THREE.Group();
    shot.matrixAutoUpdate = false;
    shot.userData.shot = { base: rel.clone(), dir: dir.clone(), t: 0 };
    for (const c of g.children) {
      if (!c.isMesh) continue;
      const m = new THREE.Mesh(c.geometry, c.material);
      m.matrixAutoUpdate = false;
      m.matrix.copy(c.matrix);
      m.castShadow = c.castShadow;
      m.receiveShadow = c.receiveShadow;
      m.raycast = () => {}; // (not a part of the part: the mouse goes through it)
      shot.add(m);
    }
    shot.matrix.copy(rel);
    group.add(shot);
    (group.userData.shots ||= []).push(shot);
    this.dirty = true;
  }

  // A shot (Animator.checkShot): the gun's muzzle effect at its fire points, the fire_01, fire_02 ...
  // nodes. ACT_FIRE2 fires from fire_02 alone; a plain FIRE from both barrels of a twin gun, and
  // from one tube after the other of a rocket pod (more than two fire points). The effect hangs on
  // the node as each particle is born and then flies on in the world; a looping one (a
  // flamethrower's flow) plays until the gun stops firing (stopShots).
  onShot(group, act, k, info) {
    if (group !== this.part || this.mode !== 'part') return;
    this.shoot(group, act, k, info);
  }

  // One shot of any gun in the scene: the 3D Viewer's part, a weapon on the builder's vehicle, the
  // gun Maps fires from beside the camera (firing.js): its sound, its rounds or beam, its muzzle effect.
  shoot(group, act, k, info) {
    const mode = this.mode;
    const use = this.firePoints(group, act, k);
    if (!use.length) return;
    const spec = this.shotFor?.(info?.path, act); // (a second fire mode fires its own round)
    use[0].updateWorldMatrix(true, false);
    const at = [12, 13, 14].map((k) => use[0].matrixWorld.elements[k]);
    if (spec?.boomAt) { // (the TNT spear: its tip goes off)
      for (const b of use) { b.updateWorldMatrix(true, false); const e = Float64Array.from(b.matrixWorld.elements); this.fx.play(spec.boomAt, () => e, { flash: { ahead: 0 } }); }
      this.sounds.play(boomSound(spec.boomAt), at);
      return;
    }
    this.sounds.gun(use[0], this.soundFor?.(info?.path, act), at); // (its shot; a minigun's motor and a flamethrower's roar held while it fires)
    if (spec?.beam) this.fireBeams(use, spec);
    else if (spec && !spec.stream) this.fireRounds(use, spec, false, k);
    const path = this.fxFor?.(info?.path);
    if (!path) return;
    this.fx.load(path).then((sys) => {
      if (!sys || this.mode !== mode || (mode === 'part' && group !== this.part)) return;
      for (const b of use) {
        const was = sys.loop ? this.fxLoops.get(b) : null;
        if (was && !was.stopped) continue;
        const origin = () => { b.updateWorldMatrix(true, false); return b.matrixWorld.elements; };
        this.fx.play(path, origin, { flash: sys.loop ? null : { ahead: 0.25 } }).then((run) => { if (run && sys.loop) this.fxLoops.set(b, run); }); // (a flash of light just out of the barrel)
      }
    });
  }

  // Another activity of the 3D Viewer's part starts its clip (Animator.checkShot): its sound
  // (soundmap.js activitySound: a reload, a charge, a hatch once; a melee weapon's attack held while
  // it plays), at the part.
  onActivity(group, act, k, info, layer) {
    if (group !== this.part || this.mode !== 'part') return;
    const snd = this.activitySoundFor?.(info?.path, act, layer);
    if (!snd) return;
    const at = group.userData.box.getCenter(new THREE.Vector3()).toArray();
    if (snd.loop) this.sounds.gun(group, snd, at);
    else this.sounds.play(snd.shot, at, { gain: snd.gain || 1 });
  }

  // A part's fire points: the fire_01, fire_02 ... bones (fire_fx_01 ... on the skins that name them so:
  // anim.js firePointsOf); on a part that does not move (no skeleton: the guided rocket launchers), its
  // fire nodes, each worked out from the part's place when asked (updateWorldMatrix, matrixWorld, like a
  // bone's)
  fireBones(group) {
    const bones = firePointsOf(group.userData.skeleton?.bones);
    if (bones.length || group.userData.skeleton) return bones;
    return (group.userData.fireNodes ||= firePointsOf(group.userData.info?.nodes).map((n) => {
      const local = new THREE.Matrix4().fromArray(n.matrix);
      const at = { name: n.name, matrixWorld: new THREE.Matrix4() };
      at.updateWorldMatrix = () => { group.updateWorldMatrix(true, false); at.matrixWorld.multiplyMatrices(group.matrixWorld, local); };
      return at;
    }));
  }

  // The fire points a shot leaves from (see onShot)
  firePoints(group, act, k) {
    const bones = this.fireBones(group).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const n = fireNumber(act); // (Fire 1, Fire 2 ... however the .model spells them: its own barrel)
    return n != null ? bones.filter((b) => firePointNumber(b.name) === n) : bones.length > 2 ? (bones.length ? [bones[k % bones.length]] : []) : bones;
  }

  // The rounds of a shot (fxmap.js shotFor: spec): out of each fire point along its +Z (the barrel),
  // a shotgun's pellets spread round it; they fly, drop and land (hitTest) with the game's effects.
  // (k: the shot's number. A lobbed throw (spec.loft: a mine's, a trap's, a fence pole's) goes up so
  // many degrees from the barrel; fence poles fan out left, ahead and right in turn (spec.fan), so a
  // fence stands between them. An artillery shell (spec.lob) goes up so many degrees from the level,
  // the way the barrel points, as fast as it takes to come down on the target: lobArc.)
  fireRounds(points, spec, quiet = false, k = 0) {
    for (const b of points) {
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      const z = new THREE.Vector3(e[8], e[9], e[10]).normalize(), x = new THREE.Vector3(e[0], e[1], e[2]).normalize(), y = new THREE.Vector3().crossVectors(z, x);
      if (spec.fan) z.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(((k % 3) - 1) * spec.fan));
      if (spec.loft) { const side = new THREE.Vector3().crossVectors(z, new THREE.Vector3(0, 1, 0)); if (side.lengthSq() > 1e-6) z.applyAxisAngle(side.normalize(), THREE.MathUtils.degToRad(spec.loft)); }
      // (a lob: the artillery modes; and a plain mortar bomb or grenade (not a thrown mine, pole or
      // barrel) fired from a barrel pointing 30° or more up, whose fixed speed would carry it far out of
      // sight: its arc comes down on the target)
      const steep = !spec.lob && !spec.loft && !spec.land && !spec.roll && !spec.pole && spec.gravity >= 9 && z.y > 0.5 ? { ...spec, lob: THREE.MathUtils.radToDeg(Math.asin(Math.min(1, z.y))) } : null;
      const lob = spec.lob || steep ? this.lobArc(new THREE.Vector3(e[12], e[13], e[14]), z, steep || spec) : null;
      if (lob) z.copy(lob.dir);
      for (let i = 0; i < spec.pellets; i++) {
        const d = z.clone();
        if (spec.spread) { // (uniform over the cone of that half-angle)
          const a = THREE.MathUtils.degToRad(spec.spread) * Math.sqrt(Math.random()), ph = Math.random() * 2 * Math.PI;
          d.multiplyScalar(Math.cos(a)).addScaledVector(x, Math.sin(a) * Math.cos(ph)).addScaledVector(y, Math.sin(a) * Math.sin(ph));
        }
        const anchor = () => { b.updateWorldMatrix(true, false); return b.matrixWorld.elements; };
        this.fx.fire(spec, e, d.toArray(), this.hitTest, { quiet, seek: this.seekMark, anchor, speed: lob?.speed });
      }
    }
  }

  // An artillery shell's arc from o (the barrel along z): spec.lob degrees up from the level, the way
  // the barrel points, and as fast as it takes to come down where that way meets the target's middle
  // (seekMark); { dir, speed }. With no target: those degrees up at its own speed.
  lobArc(o, z, spec) {
    const flat = new THREE.Vector3(z.x, 0, z.z);
    if (flat.lengthSq() < 1e-8) return null; // (straight up or down: as the barrel points)
    flat.normalize();
    const th = THREE.MathUtils.degToRad(spec.lob);
    const dir = flat.clone().multiplyScalar(Math.cos(th)).setY(Math.sin(th));
    const mark = this.seekMark();
    if (!mark || !(spec.gravity > 0)) return { dir, speed: spec.speed };
    const to = new THREE.Vector3().fromArray(mark).sub(o);
    const D = to.x * flat.x + to.z * flat.z, H = to.y, rise = D * Math.tan(th) - H;
    if (!(D > 0.5) || !(rise > 0.05)) return { dir, speed: spec.speed };
    const speed = Math.sqrt((spec.gravity * D * D) / (2 * Math.cos(th) ** 2 * rise));
    return { dir, speed: Math.min(speed, spec.speed * 3) };
  }

  // what a gun's shots use (its muzzle effect, its rounds' effect, hits and model), read before the
  // first shot goes out
  preloadShots(info) {
    const spec = this.shotFor?.(info?.path), muzzle = this.fxFor?.(info?.path);
    for (const p of [muzzle, spec?.proj, ...(spec?.hits || [])]) if (p) this.fx.load(p);
    if (spec?.mesh) this.fx.meshOf(spec.mesh);
    const snd = this.soundFor?.(info?.path);
    if (snd) this.sounds.preload(snd.shot, snd.start, snd.loop, snd.end, snd.tail, hitSound(spec, 0)?.[0], hitSound(spec, 1)?.[0], boomSound(spec?.boom));
  }

  // A beam weapon's shot (fxmap.js: spec.beam): a pulse (the laser revolver, the lightning gun) flashes
  // out for spec.pulse seconds; a held beam (Tesla, the gatling laser, plasma drills) comes on with
  // the first shot and stays on, following the barrel, until the gun stops firing (stopShots).
  fireBeams(points, spec) {
    for (const b of points) {
      const at = () => { b.updateWorldMatrix(true, false); return b.matrixWorld.elements; };
      if (spec.pulse) { this.fx.beam(spec, at, this.hitTest, { life: spec.pulse }); continue; }
      const was = this.beamLoops.get(b);
      if (was?.alive) continue;
      this.beamLoops.set(b, this.fx.beam(spec, at, this.hitTest));
    }
  }

  // a flamethrower's rounds (Animator.checkShot): launched every spec.stream seconds while it fires;
  // every spec.hitEvery-th lands with a hit effect
  projectileOf(info) {
    const spec = this.shotFor?.(info?.path);
    return spec?.stream ? { every: spec.stream, spec } : null;
  }

  onProjectile(group, act, k, info, proj) {
    if (group !== this.part || this.mode !== 'part') return;
    this.shootStream(group, act, k, proj.spec);
  }

  shootStream(group, act, k, spec) {
    this.fireRounds(this.firePoints(group, act, k), spec, k % (spec.hitEvery || 1) !== 0);
  }

  // Where a guided missile steers (FxView.fire seek): the middle of the training target while it
  // stands, on a map what the view's middle looks at (mapAim: firing.js), else nowhere (it flies on
  // as it was fired).
  seekMark = () => {
    if (this.mode === 'map') return this.mapAim?.() || null;
    const g = this.target;
    if (!g?.visible) return null;
    if (!g.userData.mark) {
      const box = new THREE.Box3();
      g.updateMatrixWorld(true);
      g.traverse((o) => { if (o.isMesh && o.name !== 'targetShadow') box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); });
      g.userData.mark = box.getCenter(new THREE.Vector3());
    }
    return g.userData.mark.toArray();
  };

  // What a round meets between two of its positions (FxView.fire): the floor under the part, and the
  // training target while it stands (setTarget); the nearest one, its normal facing the round. On a
  // map: its ground and objects (mapHit: MapView.segmentHit).
  hitTest = (p0, p1) => {
    if (this.mode === 'map') return this.mapHit?.(p0, p1) || null;
    const d = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), len = d.length();
    if (len < 1e-9) return null;
    d.divideScalar(len);
    let best = null;
    const fy = this.groundY();
    if (p0[1] >= fy && p1[1] < fy) {
      const t = (p0[1] - fy) / (p0[1] - p1[1]);
      best = { dist: t * len, point: [p0[0] + (p1[0] - p0[0]) * t, fy, p0[2] + (p1[2] - p0[2]) * t], normal: [0, 1, 0], surface: 0 };
    }
    if (this.target?.visible) {
      const rc = (this.shotRay ||= new THREE.Raycaster());
      rc.set(new THREE.Vector3().fromArray(p0), d);
      rc.far = best ? best.dist : len;
      const h = rc.intersectObject(this.target, true)[0];
      if (h) {
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        if (n.dot(d) > 0) n.negate();
        best = { dist: h.distance, point: h.point.toArray(), normal: n.toArray(), surface: 1 };
      }
    }
    return best;
  };

  // What the target stands in front of: the 3D Viewer's part, or the builder's vehicle while it
  // fires (rangeSubject, set by firing.js): { box, groups (the guns), key (it moves when that changes) }.
  rangeOf() {
    if (this.mode === 'part') return this.part ? { box: this.part.userData.box, groups: [this.part], key: this.part.uuid } : null;
    if (this.mode === 'build') return this.rangeSubject?.() || null;
    return null;
  }

  // The game's training-ground target (assets/props/bootcamp/...: a cut-out pickup with a bullseye,
  // 5.5 m wide) stood dist metres beyond the front of the part (or the vehicle), on its floor, facing
  // it; 0 takes it away.
  async setTarget(dist) {
    this.targetDist = dist || 0;
    const want = this.targetDist > 0 && !!this.rangeOf();
    if (!want) {
      if (this.target?.visible) { this.target.visible = false; this.shadowDirty = true; this.dirty = true; }
      return;
    }
    this.targetLoad ||= fetch(`${DATA}/model?path=${encodeURIComponent(TARGET)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => (info ? this.makeModel(info, 0, {}) : null))
      .then((g) => {
        if (!g) return null;
        g.name = 'target';
        for (const m of g.userData.materials || []) { m.side = THREE.DoubleSide; m.needsUpdate = true; } // (shots hit it from either side)
        // a soft shadow under it: it stands beyond the stage's floor, whose shadows stop at the part
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const cx = cv.getContext('2d'), grad = cx.createRadialGradient(32, 32, 4, 32, 32, 32);
        grad.addColorStop(0, 'rgba(0,0,0,0.55)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        cx.fillStyle = grad;
        cx.fillRect(0, 0, 64, 64);
        const blob = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
        blob.rotation.x = -Math.PI / 2;
        blob.position.y = 0.004;
        blob.raycast = () => {}; // (shots go through it to the floor)
        blob.name = 'targetShadow';
        g.add(blob);
        this.scene.add(g);
        return g;
      })
      .catch(() => null);
    const g = (this.target = await this.targetLoad);
    if (!g) return;
    const subj = this.rangeOf();
    if (!(this.targetDist > 0) || !subj) { g.visible = false; return; } // (taken away meanwhile)
    const key = `${this.mode}|${subj.key}|${this.targetDist}|${this.groundY().toFixed(2)}`; // (the floor: the lift moves it)
    if (g.visible && this.targetKey === key) return; // (it stays put while it stands)
    this.targetKey = key;
    this.placeTarget(g, subj);
    g.visible = true;
    this.shadowDirty = true;
    this.dirty = true;
  }

  // Where the target stands: dist metres beyond the part, on its floor, its bullseye side facing it,
  // and as far to one side as it takes for the gun's rounds to meet it. The cut-out is see-through
  // between its wheels at 0.55..0.85 m, the barrel height of many guns standing on the floor, so the
  // rounds' paths (out of the fire points along their +Z as the gun is posed now, dropping as the
  // gun's rounds drop: a saw falls 11 cm over 10 m) are tried against it from the middle out; the
  // first place that stops them all wins (the middle when nothing would).
  placeTarget(g, subj = this.rangeOf()) {
    const box = subj.box, c = box.getCenter(new THREE.Vector3());
    const y = this.groundY(), z = box.max.z + this.targetDist;
    g.rotation.set(0, Math.PI, 0);
    const reach = this.targetDist + box.getSize(new THREE.Vector3()).length() + 10;
    // each path as a polyline of 1 m steps (every gun of a vehicle: as many as can meet it)
    const paths = subj.groups.flatMap((group) => {
      const spec = this.shotFor?.(group.userData.info?.path);
      const speed = spec?.speed || 1000, drop = spec?.beam || spec?.roll || spec?.hover || spec?.lob ? 0 : spec?.gravity || 0;
      return this.fireBones(group).map((b) => {
        b.updateWorldMatrix(true, false);
        const e = b.matrixWorld.elements, o = new THREE.Vector3(e[12], e[13], e[14]), d = new THREE.Vector3(e[8], e[9], e[10]).normalize();
        const pts = [];
        for (let s = 0; s <= reach; s += 1) { const t = s / speed; pts.push(o.clone().addScaledVector(d, s).add(new THREE.Vector3(0, -0.5 * drop * t * t, 0))); }
        return pts;
      });
    });
    const rc = new THREE.Raycaster();
    // (with 4 cm to spare above and below: a path that only grazes an edge misses it in flight; a
    // corkscrewing rocket's whole circle round its line)
    const spiral = subj.groups.map((gr) => this.shotFor?.(gr.userData.info?.path)?.spiral?.[0] || 0).reduce((a, b) => Math.max(a, b), 0);
    const meetsAt = (pts, dy, dx = 0) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const p0 = pts[i].clone(), seg = pts[i + 1].clone().sub(pts[i]), len = seg.length();
        p0.y += dy;
        p0.x += dx;
        rc.set(p0, seg.divideScalar(len));
        rc.far = len;
        if (rc.intersectObject(g, true).length) return true;
      }
      return false;
    };
    const meets = (pts) => meetsAt(pts, 0) && meetsAt(pts, 0.04) && meetsAt(pts, -0.04) &&
      (!spiral || (meetsAt(pts, spiral) && meetsAt(pts, -spiral) && meetsAt(pts, 0, spiral) && meetsAt(pts, 0, -spiral)));
    let best = 0, most = 0;
    for (let k = 0; k <= 20 && paths.length; k++) {
      const dx = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.25; // 0, 0.25, -0.25, 0.5 ... 2.5 m
      g.position.set(c.x + dx, y, z);
      g.updateMatrixWorld(true);
      const n = paths.filter(meets).length;
      if (n > most) { most = n; best = dx; }
      if (n === paths.length) break;
    }
    g.position.set(c.x + best, y, z);
    g.updateMatrixWorld(true);
    g.userData.mark = null; // (seekMark: measured again where it stands now)
  }

  // The range (a gun firing at the target): the camera behind the gun (the builder's vehicle), a
  // little up and to its right, looking down-range, as near as it can be with the whole gun and the
  // target's middle in view. unseen: only when the target is out of view now (the 3D Viewer's first
  // view of a gun looks back at it from in front, with the target behind the camera).
  async frameRange({ animate = true, unseen = false } = {}) {
    await this.targetLoad; // (placed first: setTarget waits on the same load)
    const subj = this.rangeOf(); // (the part, or the builder's vehicle)
    if (!subj || !(this.targetDist > 0)) return;
    const box = subj.box, c = box.getCenter(new THREE.Vector3());
    const y0 = this.groundY(), tz = box.max.z + this.targetDist, tx = this.target?.visible ? this.target.position.x : c.x;
    if (unseen) {
      this.camera.updateMatrixWorld();
      const p = new THREE.Vector3(tx, y0 + 1.2, tz).applyMatrix4(this.camera.matrixWorldInverse);
      if (p.z < 0 && (p.applyMatrix4(this.camera.projectionMatrix), Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95)) return;
    }
    const far = new THREE.Box3(new THREE.Vector3(tx - 1.5, y0, tz - 0.6), new THREE.Vector3(tx + 1.5, y0 + 2.6, tz + 0.6)); // (its middle: the cut-out is 5.5 m long)
    const look = new THREE.Vector3((c.x + tx) / 2, y0 + 0.8, c.z + (tz - c.z) * 0.55);
    const dir = new THREE.Vector3(0.2, 0.35, -1).normalize(); // (from the gun to the camera)
    const r = Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = this.camera.clone();
    const pts = [];
    for (const b of [box, far]) for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    const q = new THREE.Vector3();
    let s = 1.2 * r;
    for (let i = 0; i < 90; i++, s *= 1.05) {
      cam.position.copy(c).addScaledVector(dir, s);
      cam.lookAt(look);
      cam.updateMatrixWorld();
      const fits = pts.every((p) => {
        q.copy(p).applyMatrix4(cam.matrixWorldInverse);
        if (q.z > -0.05) return false; // (behind the camera)
        q.applyMatrix4(cam.projectionMatrix);
        return Math.abs(q.x) < 0.9 && Math.abs(q.y) < 0.88;
      });
      if (fits) break;
    }
    const d = cam.position.distanceTo(look);
    const near = Math.max(0.005, d / 200), farClip = Math.max(d * 60, this.targetDist * 6);
    this.camera.near = Math.min(this.camera.near, near);
    this.camera.far = Math.max(this.camera.far, farClip);
    this.camera.updateProjectionMatrix();
    this.tween = { from: this.camera.position.clone(), fromT: this.controls.target.clone(), to: cam.position.clone(), toT: look, near, far: farClip, t0: performance.now(), dur: animate ? 600 : 0 };
    this.stepTween();
  }

  // How long a gun whose Fire has no clip of its own waits between shots: its effect's length (a
  // flamethrower's flow is a second long: one after the other they make a steady stream).
  shotPeriod(info) {
    const path = this.fxFor?.(info?.path);
    return path ? this.fx.durationOf(path) : 0;
  }

  // When a gun's shots go out while it fires (anim.js gunBeat): on the shot timer (fireEvery, seconds;
  // 0: off), else once per the game's reload time (reloadOf: stats.json), a rocket pod's tubes one
  // after another; null: at its own pace. act: the Fire activity (ACT_FIRE2 fires one barrel alone).
  beatOf(group, info, act, period) {
    const tubes = fireNumber(act) != null ? 1 : this.fireBones(group).length;
    return gunBeat({ every: this.fireEvery || 0, reload: this.reloadOf?.(info?.path) || 0, tubes, period, rate: rateOf(this.shotFor?.(info?.path, act)) });
  }

  // the gun stopped firing (group: that gun alone; else all): looping effects end (their particles
  // fade out on their own)
  stopShots(group = null) {
    const only = group ? new Set([group, ...this.fireBones(group)]) : null; // (its sounds, loops and beams hang on its fire points; a saw's on the part)
    for (const [b, run] of [...this.fxLoops]) if (!only || only.has(b)) { run.stop(); this.fxLoops.delete(b); }
    if (only) for (const b of only) this.sounds.gunStop(b); // (a minigun's motor runs down, a machine gun's burst echoes)
    else this.sounds.gunStop();
    for (const [b, beam] of [...this.beamLoops]) if (!only || only.has(b)) { this.fx.endBeam(beam); this.beamLoops.delete(b); }
  }

  stepShots(group, dt) {
    const shots = group.userData.shots;
    if (!shots?.length) return;
    const LIFE = 0.3, SPEED = 2 / LIFE;
    for (const shot of [...shots]) {
      const s = shot.userData.shot;
      s.t += dt;
      if (s.t >= LIFE) {
        group.remove(shot);
        shots.splice(shots.indexOf(shot), 1);
      } else {
        shot.matrix.makeTranslation(s.dir.x * SPEED * s.t, s.dir.y * SPEED * s.t, s.dir.z * SPEED * s.t).multiply(s.base);
      }
    }
    this.shadowDirty = true;
    this.dirty = true;
  }

  disposeModel(group) {
    if (!group || group.userData.disposed) return; // (twice would release its geometry twice: another user's could go)
    for (const a of group.userData.attached || []) this.disposeModel(a); // (models shown on its nodes)
    group.userData.disposed = true;
    this.shadowDirty = true;
    group.parent?.remove(group);
    for (const c of [...group.children]) if (c.name === 'arc') disposeArc(c);
    group.userData.skeleton?.skeleton.dispose();
    for (const m of group.userData.materials || []) this.disposeMaterial(m);
    this.geo.release(group.userData.geoEntry);
    group.userData.materials = [];
    this.dirty = true;
  }

  // texBytes: trim the idle textures down to this (a map just closed: its up to 1.2 GB need not sit
  // on the GPU while the next one loads)
  collect({ texBytes } = {}) { this.geo.collect(); this.tex.collect(texBytes ? (c) => c.total() > texBytes : undefined); }
  flushCaches() { this.geo.flush(); this.tex.flush(); flushAims(); flushClips(); flushPhys(); this.weldLiftCache?.clear(); this.restPoses.clear(); }

  // ---- viewer mode -----------------------------------------------------------------------------
  // info: /model JSON. Returns stats for the loaded LOD (after its textures arrive).
  // onShown: called the moment the part goes on screen (its textures may still be arriving).
  // onShown: the part has just gone on screen; onPlaced({ verts, tris, meshes }): it is framed and
  // set up (the textures may still be coming: the promise resolves once they are in, up to 15 s).
  // attachments: [{ info, node }]: models the game shows on the part's nodes (attach()).
  async load(info, lod, { keepCamera = false, onShown = null, onPlaced = null, attachments = [] } = {}) {
    const token = ++this.partToken;
    const group = await this.makeModel(info, lod, { texMax: 0, animate: true, paint: this.partPaint }); // (painted before its shaders are built: warmUp)
    if (token !== this.partToken) { this.disposeModel(group); return null; }
    if (attachments.length) {
      await this.attach(group, attachments, lod);
      if (token !== this.partToken) { this.disposeModel(group); return null; }
    }
    // The part on screen stays until the new one has its textures (up to 1.5 s), and the new one's
    // textures are uploaded and shaders compiled first: the swap neither flashes white nor stutters.
    await Promise.race([group.userData.ready, new Promise((res) => setTimeout(res, 1500))]);
    if (token !== this.partToken) { this.disposeModel(group); return null; }
    await this.warmUp(group);
    if (token !== this.partToken) { this.disposeModel(group); return null; }
    const old = this.part;
    this.part = group;
    this.partRoot.add(group);
    this.stopShots();
    this.fx.clear(); // (the last part's smoke goes with it)
    this.shadowDirty = true;
    if (old) this.disposeModel(old);
    onShown?.();
    this.info = info;
    this.lod = lod;
    this.partHover = null;
    this.hoverDirty = true; // (the last part's material tooltip went along with the arrow keys)
    this.selectPartMaterial(null, { force: true });
    this.buildHelpers();
    this.updateGrid();
    this.setStage(group.userData.box, 'part');
    if (!keepCamera) this.framePart({ animate: !!old && this.mode === 'part' });
    this.applyOptions();
    this.addArc(group);
    onPlaced?.({ verts: group.userData.verts, tris: group.userData.tris, meshes: group.children.filter((c) => c.isMesh).length, errors: [] });
    const errors = await Promise.race([group.userData.ready, new Promise((res) => setTimeout(() => res([]), 15000))]);
    this.collect();
    this.dirty = true;
    return { verts: group.userData.verts, tris: group.userData.tris, meshes: group.children.filter((c) => c.isMesh).length, errors };
  }

  // Fetches a model's geometry and textures into the caches without showing it (they stay until
  // the caches need the room).
  prefetch(info, lod) {
    const keep = (cache, e) => e.promise.then(() => cache.release(e), () => cache.release(e));
    keep(this.geo, this.acquireGeometry(info.path, lod));
    for (const mi of info.materials || []) {
      if (mi.invisible) continue;
      for (const { t, role } of this.materialTextures(mi)) if (role !== 'mask') keep(this.tex, this.acquireTexture(t.base, role, 0));
    }
  }

  // Uploads a model's textures and compiles its shaders (for the frame buffer it will be drawn into)
  // before it goes on screen.
  // Starts building the shaders the objects' materials draw with in this view (its lights and fog, into
  // the post chain's target, as its frames do), all at once: the GPU process builds them side by side on
  // its threads (KHR_parallel_shader_compile). Resolves once all are built; a frame that draws one
  // before then waits for that one.
  prepare(objects) {
    const list = (Array.isArray(objects) ? objects : [objects]).filter(Boolean);
    const r = this.renderer, prev = r.getRenderTarget();
    let mats;
    try {
      if (this.post?.scene) r.setRenderTarget(this.post.scene);
      mats = r.compile({ traverse: (fn) => { for (const o of list) o.traverse(fn); }, traverseVisible: () => {} }, this.camera, this.scene);
    } catch {
      return Promise.resolve(); // (built on its first frame instead)
    } finally {
      r.setRenderTarget(prev);
    }
    return new Promise((resolve) => {
      const check = () => {
        for (const m of mats) if (r.properties.get(m).currentProgram?.isReady() !== false) mats.delete(m);
        if (mats.size) setTimeout(check, 10); else resolve();
      };
      check();
    });
  }

  async warmUp(group) {
    const r = this.renderer;
    for (const m of group.userData.materials)
      for (const t of Object.values(m.userData.xo.maps)) if (t) r.initTexture(t);
    const prev = r.getRenderTarget();
    try {
      if (this.post?.scene) r.setRenderTarget(this.post.scene);
      const job = r.compileAsync(group, this.camera, this.scene);
      r.setRenderTarget(prev);
      await job;
    } catch { r.setRenderTarget(prev); /* compiled on the first frame instead */ }
  }

  get meshes() { return this.part ? this.part.children.filter((c) => c.isMesh) : []; }
  get materials() { return this.part ? this.part.userData.materials : []; }

  // A weapon's firing arc, as a child of its model (it stays put while the turret animates).
  // Resolves to the arc group, or null for parts that cannot aim.
  async addArc(group, { force = false } = {}) {
    const aim = await weaponAim(group.userData.info);
    if (!aim || group.userData.materials.length === 0 || group.children.some((c) => c.name === 'arc')) return null;
    const arc = arcObject(aim);
    arc.userData.base = arcBase(group.userData.box);
    arc.scale.setScalar(arc.userData.base * this.arcSize);
    if (arc.userData.cones) arc.userData.cones.visible = this.arcCones;
    arc.visible = force || this.options.arcs;
    group.add(arc);
    this.dirty = true;
    return arc;
  }

  get arc() { return this.part ? this.part.children.find((c) => c.name === 'arc') || null : null; }

  // Arc size (ARC_SIZE: times each part's size), for every firing arc on screen: the 3D Viewer's
  // and the builder's (garage augmented reality, placing ghosts included).
  setArcSize(f) {
    this.arcSize = f;
    this.scene.traverse((o) => { if (o.name === 'arc' && o.userData.base) o.scale.setScalar(o.userData.base * f); });
    this.dirty = true;
  }

  // The cones that close every firing arc above its highest and below its lowest tilt, on or off.
  setArcCones(on) {
    this.arcCones = on;
    this.scene.traverse((o) => { if (o.name === 'arc' && o.userData.cones) o.userData.cones.visible = on; });
    this.dirty = true;
  }

  setOption(k, v) {
    this.options[k] = v;
    if (k === 'textures' || k === 'wireframe' || k === 'layers') { for (const m of this.live) this.syncMaterial(m); this.shadowDirty = true; } // (cut-out shadows follow the textures)
    if (k === 'slots' || k === 'pivots') this.applyOptions();
    if (k === 'arcs' && this.arc) this.arc.visible = v;
    if (k === 'grid' && this.grid) this.grid.visible = v;
    this.dirty = true;
  }

  // Weapon heat glow, 0 (cold, as in the garage) .. 1 (overheated). Only heat-mask materials follow it;
  // other glow maps (lights, screens) always glow.
  setHeat(v) {
    if (v === this.options.heat) return;
    this.options.heat = v;
    for (const m of this.live) {
      if (!m.userData.xo.info.heat) continue;
      const e = m.emissiveMap ? v : 0;
      m.emissive.setRGB(e, e, e);
    }
    this.dirty = true;
  }

  applyOptions() {
    for (const c of this.helpers.children) c.visible = !!this.options[c.name];
    if (this.grid) this.grid.visible = this.options.grid;
    this.dirty = true;
  }

  clearHelpers() {
    for (const c of [...this.helpers.children]) {
      this.helpers.remove(c);
      Viewer.disposeHelper(c);
    }
  }

  // Frees a helper's own geometry and materials (the shared weld-point ones stay).
  static disposeHelper(obj) {
    obj.traverse((o) => {
      if (o.userData.sharedGeometry !== true) o.geometry?.dispose();
      if (o.userData.sharedMaterial !== true) o.material?.dispose?.();
      if (o.isInstancedMesh) o.dispose();
    });
  }

  // ---- weld points --------------------------------------------------------------------------------
  // Crossout's garage (augmented reality mode) shows a part's weld points (its connection slots) as
  // flat squares lying on the part, nearly a whole cell face each: a thin white frame around an even
  // see-through fill. They are one-sided (seen only from outside the part), never turn towards the
  // camera, and vanish when seen at about 85° from straight on. While a part is held, the weld points
  // where it would weld on turn orange; all others stay white. The game's marker model
  // (particles/models/weld_slot) also has four fins standing across the pad, which the garage never
  // shows; only the pad is drawn here.
  static WELD = { free: 0xffffff, welded: 0x74e08c };
  static WELD_SIZE = 0.27; // metres: a 0.3 m cell face with a small gap
  // A pad stands just clear of its own part: above the highest bit of the part under its square
  // within WELD_REACH of the face (bolts, lamps, a domed hatch), at least a hair off the face. A part
  // that rises more than WELD_LIFT_MAX there (a gun mount) covers the point; that pad stays put.
  static WELD_REACH = 0.25;
  static WELD_LIFT_MAX = 0.15;
  static WELD_BASE = 0.01; // (a centimetre off the face at least: clear of slight unevenness)
  // Fill opacity (the frame is nearly opaque). In the garage a white pad lightens what is behind it
  // by about a third and an orange one tints it about half way, blended in gamma space; this view
  // blends in linear light, where a bit less gives the same look.
  static WELD_KINDS = {
    free: { frame: [255, 255, 255], fill: [255, 255, 255], fillAlpha: 0.24 },
    mate: { frame: [255, 168, 46], fill: [255, 128, 70], fillAlpha: 0.42 }, // where the held part would weld
  };

  static weldGeometry() {
    if (Viewer.weldGeo) return Viewer.weldGeo;
    const g = new THREE.BufferGeometry(); // the pad: 1 x 1 in the XY plane, facing +Z (out of the part)
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    g.computeBoundingSphere();
    return (Viewer.weldGeo = g);
  }

  // The marker's picture, drawn: a thin frame (about 4 % of the pad, slightly rounded corners) around
  // a flat fill, set in from the edge like the frame in the game's texture (5 of 128 texels). The
  // 'ring' shape (cslot weld points) adds a ring of the frame's colour around a clear hole, sized
  // from the garage (ring about 76 % of the square across, hole about 64 %). The game's own
  // weld_slot texture is a soft painted frame with a swirl of noise in its alpha, meant for its
  // shader; drawn as it is, the noise shows as a cloudy swirl and the frame wobbles.
  static weldTexture(kind = 'free', shape = 'square', size = 256) {
    const K = Viewer.WELD_KINDS[kind];
    const ring = shape === 'ring', ringOut = 45, ringIn = 38.5; // radii, 128-texel units
    const data = new Uint8Array(size * size * 4);
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const k = 128 / size; // measured in 128-texel units (the game's texture size)
    const half = 64 - 5, r = 6, band = 5, aa = 0.6; // outer edge, corner radius, frame width, edge softness
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const qx = Math.abs((x + 0.5) * k - 64) - (half - r), qy = Math.abs((y + 0.5) * k - 64) - (half - r);
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; // < 0 inside
      const outer = 1 - smooth(-aa, aa, dist), inner = 1 - smooth(-band - aa, -band + aa, dist);
      let frame = outer - inner, fill = inner;
      if (ring) {
        const rr = Math.hypot((x + 0.5) * k - 64, (y + 0.5) * k - 64);
        const band = smooth(ringIn - aa, ringIn + aa, rr) * (1 - smooth(ringOut - aa, ringOut + aa, rr));
        frame = Math.max(frame, band);
        fill *= smooth(ringOut - aa, ringOut + aa, rr); // the fill stops at the ring; inside it a hole
      }
      const a = frame + (1 - frame) * fill * K.fillAlpha;
      const w = a > 0 ? frame / a : 1; // colour: the frame's where the frame is, the fill's inside
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(K.frame[c] * w + K.fill[c] * (1 - w));
      data[o + 3] = Math.round(a * 255);
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.name = (kind === 'free' ? 'weld point' : `weld point (${kind})`) + (ring ? ' ring' : '');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  // One material per kind of weld point: 'free' (white, tinted by the instance colour) or 'mate' (orange).
  weldMaterial(kind = 'free') {
    this.weldMats ||= {};
    if (!this.weldMats[kind]) {
      this.weldMats[kind] = new THREE.ShaderMaterial({
        uniforms: { map: { value: Viewer.weldTexture(kind) }, ringMap: { value: Viewer.weldTexture(kind, 'ring') }, opacity: { value: 0.92 } },
        vertexShader: /* glsl */ `
          attribute float aShape; // 0: square, 1: ring
          varying vec2 vUv;
          varying vec3 vColor;
          varying float vFacing, vShape;
          void main() {
            vUv = uv;
            vShape = aShape;
            mat4 m = modelMatrix;
          #ifdef USE_INSTANCING
            m = m * instanceMatrix;
          #endif
            vec4 wp = m * vec4(position, 1.0);
            vFacing = dot(normalize(mat3(m) * normal), normalize(cameraPosition - wp.xyz)); // cos of the viewing angle
          #ifdef USE_INSTANCING_COLOR
            vColor = instanceColor;
          #else
            vColor = vec3(1.0);
          #endif
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map, ringMap;
          uniform float opacity;
          varying vec2 vUv;
          varying vec3 vColor;
          varying float vFacing, vShape;
          void main() {
            vec4 t = vShape > 0.5 ? texture2D(ringMap, vUv) : texture2D(map, vUv);
            float vis = smoothstep(0.07, 0.14, vFacing); // all there up to about 82 degrees off straight on, gone by 86
            gl_FragColor = vec4(vColor * t.rgb, t.a * opacity * vis);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true, depthWrite: false, side: THREE.FrontSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      });
    }
    return this.weldMats[kind];
  }

  // items: [{ pos, normal, color?, name? }] -> instanced pads lying on the surface, facing out.
  // into: a mesh made here before, refilled in place when it has room (markers that follow the cursor).
  weldMarkers(name, items, size = Viewer.WELD_SIZE, into = null, { kind = 'free' } = {}) {
    let mesh = into;
    if (!mesh || mesh.instanceMatrix.count < items.length || mesh.userData.weldKind !== kind) {
      const cap = Math.max(into ? 64 : 1, items.length);
      const geo = Viewer.weldGeometry().clone(); // its own copy: the shape per instance lives on it
      geo.setAttribute('aShape', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
      mesh = new THREE.InstancedMesh(geo, this.weldMaterial(kind), cap);
      mesh.userData.sharedMaterial = true;
      mesh.userData.weldKind = kind;
      mesh.name = name;
    }
    mesh.count = items.length;
    mesh.userData.items = items;
    mesh.userData.size = size;
    const c = new THREE.Color();
    const shape = mesh.geometry.getAttribute('aShape');
    items.forEach((it, i) => {
      shape.setX(i, it.ring ? 1 : 0);
      this.placeWeld(mesh, i, true);
      mesh.setColorAt(i, c.set(it.color ?? Viewer.WELD.free));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    shape.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = kind === 'free' ? 5 : 6;
    mesh.userData.kind = name;
    return mesh;
  }

  // Puts marker i of a weld mesh on its point (shown) or shrinks it to nothing (hidden).
  placeWeld(mesh, i, shown) {
    const it = mesh.userData.items[i], size = mesh.userData.size;
    if (!it) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), it.normal);
    const p = it.pos.clone().addScaledVector(it.normal, it.lift ?? Viewer.WELD_BASE); // (lift: clear of its own part, see weldLifts)
    const s = shown ? size : 0;
    mesh.setMatrixAt(i, new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s, s)));
    mesh.instanceMatrix.needsUpdate = true;
    this.dirty = true;
  }

  // How far each weld pad of a model stands off its face (see WELD_REACH): per point, the highest bit
  // of the model's own surface over the pad's square, plus a hair. slots: [{ pos, normal }] in the
  // model's frame; group: its meshes (the model's own, not the firing arc). Worked out once per key.
  weldLifts(key, group, slots, size = Viewer.WELD_SIZE) {
    const cache = (this.weldLiftCache ||= new Map());
    const known = cache.get(key);
    if (known && known.length === slots.length) return known;
    const base = Viewer.WELD_BASE, half = size / 2, REACH = Viewer.WELD_REACH, G = 0.3;
    const tri = []; // the model's triangles, xyz x 3 each
    for (const m of group.children) {
      if (!m.isMesh || !m.material?.userData?.xo || m.userData.lamp) continue; // (glow layers lie on the surface)
      const P = m.geometry.attributes.position, I = m.geometry.index;
      if (!P) continue;
      const n = I ? I.count : P.count;
      for (let k = 0; k + 2 < n; k += 3) for (let j = 0; j < 3; j++) { const v = I ? I.getX(k + j) : k + j; tri.push(P.getX(v), P.getY(v), P.getZ(v)); }
    }
    const nt = tri.length / 9, cells = new Map(), cellKey = (i, j, k) => ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
    for (let t = 0; t < nt; t++) { // (in a 0.3 m grid: a pad looks only at what is near it)
      const o = t * 9;
      const lo = [0, 1, 2].map((c) => Math.floor(Math.min(tri[o + c], tri[o + 3 + c], tri[o + 6 + c]) / G));
      const hi = [0, 1, 2].map((c) => Math.floor(Math.max(tri[o + c], tri[o + 3 + c], tri[o + 6 + c]) / G));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
        const ck = cellKey(i, j, k);
        let list = cells.get(ck);
        if (!list) cells.set(ck, (list = []));
        list.push(t);
      }
    }
    const out = new Float32Array(slots.length), seen = new Int32Array(nt).fill(-1);
    const Z = new THREE.Vector3(0, 0, 1), q = new THREE.Quaternion(), U = new THREE.Vector3(), V = new THREE.Vector3();
    const u = [0, 0, 0], v = [0, 0, 0], h = [0, 0, 0], S = 5;
    slots.forEach((sl, si) => {
      const p = sl.pos, n = sl.normal;
      q.setFromUnitVectors(Z, n);
      U.set(1, 0, 0).applyQuaternion(q);
      V.set(0, 1, 0).applyQuaternion(q);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const a of [-half, half]) for (const b of [-half, half]) for (const c of [0, REACH]) {
        const x = [p.x + U.x * a + V.x * b + n.x * c, p.y + U.y * a + V.y * b + n.y * c, p.z + U.z * a + V.z * b + n.z * c];
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], x[k]); hi[k] = Math.max(hi[k], x[k]); }
      }
      let top = 0; // the highest bit of the part over the pad's square
      const consider = (hh, uu, vv) => { if (hh > 0 && hh <= REACH && Math.abs(uu) <= half && Math.abs(vv) <= half && hh > top) top = hh; };
      for (let i = Math.floor(lo[0] / G); i <= Math.floor(hi[0] / G); i++) for (let j = Math.floor(lo[1] / G); j <= Math.floor(hi[1] / G); j++) for (let k = Math.floor(lo[2] / G); k <= Math.floor(hi[2] / G); k++) {
        for (const t of cells.get(cellKey(i, j, k)) || []) {
          if (seen[t] === si) continue;
          seen[t] = si;
          const o = t * 9;
          for (let c = 0; c < 3; c++) { // the triangle in the pad's frame
            const dx = tri[o + c * 3] - p.x, dy = tri[o + c * 3 + 1] - p.y, dz = tri[o + c * 3 + 2] - p.z;
            u[c] = dx * U.x + dy * U.y + dz * U.z;
            v[c] = dx * V.x + dy * V.y + dz * V.z;
            h[c] = dx * n.x + dy * n.y + dz * n.z;
          }
          if (Math.max(h[0], h[1], h[2]) <= 0.001 || Math.min(h[0], h[1], h[2]) > REACH) continue;
          if (Math.max(u[0], u[1], u[2]) < -half || Math.min(u[0], u[1], u[2]) > half || Math.max(v[0], v[1], v[2]) < -half || Math.min(v[0], v[1], v[2]) > half) continue;
          for (let c = 0; c < 3; c++) { // its corners and edges over the square (walls standing on it show only there)
            const d = (c + 1) % 3;
            for (let e = 0; e <= 8; e++) { const f = e / 8; consider(h[c] + (h[d] - h[c]) * f, u[c] + (u[d] - u[c]) * f, v[c] + (v[d] - v[c]) * f); }
          }
          const den = (v[1] - v[2]) * (u[0] - u[2]) + (u[2] - u[1]) * (v[0] - v[2]);
          if (Math.abs(den) < 1e-12) continue;
          for (let gx = 0; gx < S; gx++) for (let gy = 0; gy < S; gy++) { // and a 5 x 5 grid of the square under it
            const su = -half + ((gx + 0.5) / S) * size, sv = -half + ((gy + 0.5) / S) * size;
            const w0 = ((v[1] - v[2]) * (su - u[2]) + (u[2] - u[1]) * (sv - v[2])) / den, w1 = ((v[2] - v[0]) * (su - u[2]) + (u[0] - u[2]) * (sv - v[2])) / den;
            if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
            consider(w0 * h[0] + w1 * h[1] + (1 - w0 - w1) * h[2], su, sv);
          }
        }
      }
      out[si] = top > Viewer.WELD_LIFT_MAX ? base : Math.max(base, top + 0.008); // (covered by a tall bit: as before)
    });
    cache.set(key, out);
    return out;
  }

  // Octahedron markers + local axes for a list of { name, matrix } in `group`.
  static markers(name, items, color, size) {
    const g = new THREE.Group();
    g.name = name;
    if (!items.length) return g;
    const inst = new THREE.InstancedMesh(new THREE.OctahedronGeometry(size, 0), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }), items.length);
    inst.renderOrder = 10;
    const pos = new Float32Array(items.length * 18), col = new Float32Array(items.length * 18);
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    items.forEach((it, i) => {
      m4.fromArray(it.matrix).decompose(p, q, s);
      inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      [[1, 0, 0, 1, 0.3, 0.3], [0, 1, 0, 0.3, 1, 0.3], [0, 0, 1, 0.3, 0.5, 1]].forEach(([x, y, z, r, gg, b], k) => {
        const e = new THREE.Vector3(x, y, z).applyQuaternion(q).multiplyScalar(size * 3).add(p);
        pos.set([p.x, p.y, p.z, e.x, e.y, e.z], (i * 3 + k) * 6);
        col.set([r, gg, b, r, gg, b], (i * 3 + k) * 6);
      });
    });
    inst.userData.items = items;
    inst.userData.kind = name;
    g.add(inst);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    lines.renderOrder = 11;
    g.add(lines);
    return g;
  }

  buildHelpers() {
    this.clearHelpers();
    const info = this.info;
    const box = this.part.userData.box;
    const s = Math.min(0.045, Math.max(0.012, box.getSize(new THREE.Vector3()).length() * 0.005));
    const welds = new THREE.Group();
    welds.name = 'slots';
    const items = this.part.userData.slots; // (with their lift off the part)
    if (items.length) welds.add(this.weldMarkers('slots', items));
    this.helpers.add(welds);
    this.helpers.add(Viewer.markers('pivots', (info.nodes || []).length > 1 ? info.nodes : [], 0x4cc3ff, s));
  }

  // Ground grid. Viewer mode: sized to the part; build mode: the 0.3 m build grid.
  updateGrid() {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); this.grid = null; }
    if (this.mode === 'map') { this.dirty = true; return; } // (a map has its own ground)
    if (this.mode === 'build') {
      const cells = 60;
      this.grid = new THREE.GridHelper(cells * CELL, cells, 0x5a616b, 0x30343b);
      this.grid.position.set(0, this.groundLevel('build') - 0.001, 0);
    } else {
      const box = this.part ? this.part.userData.box : new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(2, Math.ceil(Math.max(size.x, size.z) * 1.6));
      this.grid = new THREE.GridHelper(span, Math.max(4, Math.round(span / 0.25)), 0x4a5058, 0x30343b);
      this.grid.position.set((box.min.x + box.max.x) / 2, box.min.y - 0.001, (box.min.z + box.max.z) / 2); // (the floor is 1 mm lower)
    }
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.visible = this.options.grid;
    this.scene.add(this.grid);
    this.dirty = true;
  }

  // animate: glide there (ease-out, a bit under half a second) instead of jumping.
  frameBox(box, { animate = false } = {}) {
    if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.1, box.getSize(new THREE.Vector3()).length() / 2);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect); // a tall, narrow view is the tighter one
    const d = r / Math.sin(Math.min(vfov, hfov) / 2) * 1.05;
    const dir = new THREE.Vector3(0.9, 0.55, 1.1).normalize();
    const pos = c.clone().addScaledVector(dir, d);
    this.camera.near = Math.max(0.005, Math.min(this.camera.near, d / 200));
    this.camera.far = Math.max(this.camera.far, d * 60);
    this.camera.updateProjectionMatrix();
    this.tween = { from: this.camera.position.clone(), fromT: this.controls.target.clone(), to: pos, toT: c, near: Math.max(0.005, d / 200), far: d * 60, t0: performance.now(), dur: animate ? 420 : 0 };
    this.stepTween();
  }

  stepTween() {
    const tw = this.tween;
    if (!tw) return;
    const k = tw.dur > 0 ? Math.min(1, (performance.now() - tw.t0) / tw.dur) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    this.camera.position.lerpVectors(tw.from, tw.to, e);
    this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
    if (k >= 1) {
      this.camera.near = tw.near;
      this.camera.far = tw.far;
      this.camera.updateProjectionMatrix();
      this.tween = null;
    }
    this.controls.update();
    this.dirty = true;
  }

  // ---- the garage lift (build mode) --------------------------------------------------------------
  // C in Crossout's garage lifts the car so you can see and build underneath. Here the floor, grid
  // and shadows go down while the camera goes down with them, which looks the same as the car going
  // up, and the builder keeps working at the car's own level (y = 0 is still where it stands).
  static LIFT = 1.2; // metres

  setLift(on) {
    const to = on ? Viewer.LIFT : 0;
    if ((this.liftTween ? this.liftTween.to : this.lift) === to) return;
    this.tween = null;
    this.liftTween = { from: this.lift, to, t0: performance.now(), dur: 650 };
  }

  get lifted() { return (this.liftTween ? this.liftTween.to : this.lift) > 0; }

  stepLift() {
    const tw = this.liftTween;
    if (!tw) return;
    const k = Math.min(1, (performance.now() - tw.t0) / tw.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in and out
    const L = tw.from + (tw.to - tw.from) * e;
    const d = L - this.lift;
    this.lift = L;
    if (this.mode === 'build') {
      this.camera.position.y -= d;
      this.controls.target.y -= d;
      this.setStage(this.stages.build, 'build'); // (moves the floor and the grid)
      if (this.target?.visible) { this.target.position.y -= d; this.target.updateMatrixWorld(true); this.target.userData.mark = null; } // (it stands on the floor: it hung in the air)
    } else if (this.cameras.build) { // switched away mid-lift: the builder's camera still follows
      this.cameras.build.pos.y -= d;
      this.cameras.build.target.y -= d;
    }
    if (k >= 1) this.liftTween = null;
    this.dirty = true;
  }

  // Floor height: under the part (3D Viewer) or the build's floor, lifted or not.
  groundY() { return this.groundLevel(); }

  // ---- part pictures (the garage's parts list, the cards) ------------------------------------------
  // A part's picture for its card, made the way the game pictures its parts (ICON_LOOK): in a
  // little studio of its own (a room's soft light all round, a white key light from above on the
  // right that casts the part's shadows on itself, a cool fill from the left, a rim light from
  // behind on its edges), from above and in front to the left, framed tight on its box, with its
  // full textures, drawn at twice the size it is kept at (then cut to the part and shrunk: sharp),
  // graded like the game's. Not the view's light: a dim map or a moody background would dull every
  // card. PNG data URL ('' nothing to picture, null not ready yet: its textures still loading).
  iconPicture(info, opts) {
    const job = (this.iconJob || Promise.resolve()).then(() => this.drawIconPicture(info, opts));
    this.iconJob = job.catch(() => {}); // (one at a time: the studio holds one part)
    return job;
  }

  async drawIconPicture(info, { size = 300, texMax = 1024 } = {}) {
    const g = await this.makeModel(info, 0, { texMax });
    const st = (this.iconStudio ||= this.makeIconStudio());
    try {
      let ready = false;
      await Promise.race([g.userData.ready.then(() => (ready = true)), new Promise((res) => setTimeout(res, 8000))]);
      if (g.userData.materials.length === 0) return '';
      if (!ready) return null;
      const box = g.userData.box, c = box.getCenter(new THREE.Vector3());
      g.position.copy(c).negate(); // (its middle at the studio's origin)
      st.scene.add(g);
      g.updateMatrixWorld(true);
      const R = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
      const L = { ...ICON_LOOK, ...this.iconLook }, deg = THREE.MathUtils.degToRad;
      // the camera: in front and to the side, above, looking at its middle (L.dist its radius away);
      // then the lens narrowed until the box's corners just fit
      const dir = new THREE.Vector3(Math.cos(deg(L.elev)) * Math.sin(deg(L.azim)), Math.sin(deg(L.elev)), Math.cos(deg(L.elev)) * Math.cos(deg(L.azim))), cam = st.cam;
      cam.position.copy(dir).multiplyScalar(R * L.dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
      cam.near = R * (L.dist - 1.2);
      cam.far = R * (L.dist + 6);
      cam.updateMatrixWorld(true);
      const inv = cam.matrixWorldInverse.copy(cam.matrixWorld).invert(), p = new THREE.Vector3();
      let t = 0.01;
      for (let k = 0; k < 8; k++) {
        p.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).sub(c).applyMatrix4(inv);
        t = Math.max(t, Math.abs(p.x) / -p.z, Math.abs(p.y) / -p.z);
      }
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(t * 1.04));
      cam.aspect = 1;
      cam.updateProjectionMatrix();
      // the lights, placed from the camera's side: key upper left, fill right, rim behind and above
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().negate(), up = new THREE.Vector3(0, 1, 0);
      st.key.position.copy(dir).addScaledVector(up, L.keyUp).addScaledVector(right, L.keyRight).normalize().multiplyScalar(R * 5);
      st.fill.position.copy(dir).addScaledVector(right, L.fillRight).addScaledVector(up, -0.1).normalize().multiplyScalar(R * 5);
      st.rim.position.copy(dir).negate().addScaledVector(up, 0.9).addScaledVector(right, L.rimRight).normalize().multiplyScalar(R * 5);
      st.key.color.set(L.key[0]); st.key.intensity = L.key[1];
      st.fill.color.set(L.fill[0]); st.fill.intensity = L.fill[1];
      st.rim.color.set(L.rim[0]); st.rim.intensity = L.rim[1];
      st.scene.environmentIntensity = L.env;
      const sc = st.key.shadow.camera;
      sc.left = sc.bottom = -R * 1.1;
      sc.right = sc.top = R * 1.1;
      sc.near = R * 2;
      sc.far = R * 9;
      sc.updateProjectionMatrix();
      for (const l of [st.key, st.fill, st.rim]) { l.target.position.set(0, 0, 0); l.updateMatrixWorld(true); l.target.updateMatrixWorld(true); }
      const Rr = this.renderer, full = Rr.getSize(new THREE.Vector2()), buf = Rr.getDrawingBufferSize(new THREE.Vector2());
      const css = Math.max(64, Math.min(size * 2, full.x, full.y)), px = Math.round(css * Rr.getPixelRatio());
      const prev = Rr.getRenderTarget(), exposure = Rr.toneMappingExposure, clear = Rr.getClearColor(new THREE.Color()), clearA = Rr.getClearAlpha();
      const metal = this.metal.value, tone = Rr.toneMapping;
      Rr.setRenderTarget(null);
      // (its shaders built in the background first; never waited on for long: compiled when drawn)
      try { await Promise.race([Rr.compileAsync(st.scene, cam), new Promise((res) => setTimeout(res, 4000))]); } catch { /* compiled when drawn */ }
      const irradiance = IRRADIANCE.map((v) => v.clone()), local = LOCAL_PROBE.on.value; // (as they are now: a map may have come in meanwhile)
      try {
        Rr.toneMappingExposure = L.exposure;
        this.metal.value = metal * L.metal;
        for (const v of IRRADIANCE) v.set(0, 0, 0); // (the studio's room lights it, not a map's probes)
        LOCAL_PROBE.on.value = 0;
        if (L.tone) Rr.toneMapping = L.tone;
        Rr.setViewport(0, 0, css, css);
        Rr.setScissor(0, 0, css, css);
        Rr.setScissorTest(true);
        Rr.setClearColor(0x000000, 0);
        Rr.clear(true, true, true);
        Rr.shadowMap.needsUpdate = true; // (the key light's own shadow, of the part on itself)
        Rr.render(st.scene, cam);
        const out = document.createElement('canvas');
        out.width = out.height = px;
        const og = out.getContext('2d', { willReadFrequently: !!L.grade });
        og.drawImage(Rr.domElement, 0, Rr.getDrawingBufferSize(new THREE.Vector2()).y - px, px, px, 0, 0, px, px);
        if (L.grade) Viewer.gradePicture(og, px, L.grade);
        return out.toDataURL('image/png');
      } finally {
        Rr.toneMappingExposure = exposure;
        this.metal.value = metal;
        IRRADIANCE.forEach((v, i) => v.copy(irradiance[i]));
        LOCAL_PROBE.on.value = local;
        Rr.toneMapping = tone;
        Rr.setClearColor(clear, clearA);
        Rr.setScissorTest(false);
        { const now = Rr.getSize(new THREE.Vector2()); Rr.setViewport(0, 0, now.x, now.y); } // (the view may have changed size while it waited)
        Rr.setRenderTarget(prev);
        st.scene.remove(g);
        this.shadowDirty = true; // (the view's own shadows drawn again)
        this.render();
      }
    } finally {
      st.scene.remove(g);
      this.disposeModel(g);
    }
  }

  // A picture's grade, in place: saturation (as CSS's saturate()), then contrast about mid-grey,
  // then brightness, on its sRGB values (the part only: the clear around it stays clear).
  static gradePicture(g, px, { saturate: s = 1, contrast: k = 1, brightness: b = 1 }) {
    if (s === 1 && k === 1 && b === 1) return;
    const id = g.getImageData(0, 0, px, px), d = id.data;
    const m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
    const f = (v) => Math.min(255, Math.max(0, Math.min(255, Math.max(0, (v - 127.5) * k + 127.5)) * b));
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const r = d[i], gg = d[i + 1], bb = d[i + 2];
      d[i] = f(m[0] * r + m[1] * gg + m[2] * bb);
      d[i + 1] = f(m[3] * r + m[4] * gg + m[5] * bb);
      d[i + 2] = f(m[6] * r + m[7] * gg + m[8] * bb);
    }
    g.putImageData(id, 0, 0);
  }

  makeIconStudio() {
    const scene = new THREE.Scene();
    scene.environment = this.envs.studio || (this.envs.studio = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
    const key = new THREE.DirectionalLight(), fill = new THREE.DirectionalLight(), rim = new THREE.DirectionalLight(); // (set per picture: ICON_LOOK)
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 2;
    scene.add(key, key.target, fill, fill.target, rim, rim.target);
    return { scene, key, fill, rim, cam: new THREE.PerspectiveCamera(20, 1, 0.01, 1000) };
  }

  // A picture of a part, lit like the scene, seen from the front-left like the game's item icons.
  // The model goes far below the stage (out of every other view), is drawn straight into a corner
  // of the canvas, copied out, and the view is redrawn in the same task, so nothing flashes.
  async thumbnail(info, { size = 96, texMax = 0 } = {}) {
    const g = await this.makeModel(info, 0, { texMax });
    try {
      let ready = false;
      await Promise.race([g.userData.ready.then(() => (ready = true)), new Promise((res) => setTimeout(res, 3000))]);
      if (g.userData.materials.length === 0) return ''; // nothing visible to picture
      if (!ready) return null; // textures still loading: ask again later
      const box = g.userData.box, c = box.getCenter(new THREE.Vector3());
      const at = new THREE.Vector3(0, -5000, 0);
      g.position.copy(at).sub(c);
      const cam = this.thumbCam || (this.thumbCam = new THREE.PerspectiveCamera(26, 1, 0.01, 100));
      const rad = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
      const d = (rad / Math.sin(THREE.MathUtils.degToRad(cam.fov) / 2)) * 1.02;
      cam.position.copy(at).addScaledVector(new THREE.Vector3(0.9, 0.55, 1.1).normalize(), d);
      cam.near = d / 50;
      cam.far = d * 4;
      cam.lookAt(at);
      cam.updateProjectionMatrix();
      this.scene.add(g);
      g.updateMatrixWorld(true);
      const R = this.renderer, full = R.getSize(new THREE.Vector2()), buf = R.getDrawingBufferSize(new THREE.Vector2());
      const css = Math.min(size, full.x, full.y), px = Math.round(css * R.getPixelRatio());
      // the canvas needs its own shader variants (tone mapping + sRGB): compiled first, not mid-frame
      const prev = R.getRenderTarget();
      R.setRenderTarget(null);
      try { await R.compileAsync(g, cam, this.scene); } catch { /* compiled when drawn */ }
      R.setRenderTarget(prev);
      // (the sun's shadow map is not redrawn: the model is far outside its camera anyway)
      try {
        R.setRenderTarget(null);
        R.setViewport(0, 0, css, css);
        R.setScissor(0, 0, css, css);
        R.setScissorTest(true);
        R.clear(true, true, true);
        R.render(this.scene, cam);
        const out = document.createElement('canvas');
        out.width = out.height = px;
        out.getContext('2d').drawImage(R.domElement, 0, R.getDrawingBufferSize(new THREE.Vector2()).y - px, px, px, 0, 0, px, px);
        return out.toDataURL('image/png');
      } finally {
        R.setScissorTest(false);
        { const now = R.getSize(new THREE.Vector2()); R.setViewport(0, 0, now.x, now.y); }
        this.scene.remove(g);
        this.render();
      }
    } finally {
      this.disposeModel(g);
    }
  }

  frameObject(obj, opts) { this.frameBox(new THREE.Box3().setFromObject(obj), opts); }
  // The part's rest-pose bounds. (Box3.setFromObject measures a skinned mesh through its bones, which
  // have no world matrices before the first render: it would miss whatever rides on them, like tyres.)
  framePart(opts) { this.frameBox(this.part ? this.part.userData.box.clone() : new THREE.Box3(), opts); }
  frame() { if (this.mode === 'build') this.frameObject(this.buildRoot, { animate: true }); else this.framePart({ animate: true }); }

  ndc(e) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  pick() {
    const e = this.pointer;
    if (this.mode === 'map' && this.mapHover) { this.mapHover(e); return; } // (Maps: the object under the cursor, mapview.js)
    if (this.mode === 'build') return; // (the builder names the part under the cursor itself, build.js hover())
    if (this.mode !== 'part' || !this.part) { this.onHover(null); return; }
    if (e.buttons) { this.onHover(null); this.setPartHover(null); return; } // (turning the view)
    // An animating part (an idle loop, Look at me) is skinned on the CPU to be picked: while its
    // pose keeps changing, at most 20 times a second (the next frame tries again)
    const skel = this.part.userData.skeleton, now = performance.now();
    if (skel && skel.version !== this.pickVersion && now - (this.pickAt || 0) < 50) { this.hoverDirty = true; return; }
    this.pickAt = now;
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const helpers = this.helpers.children.filter((g) => g.visible).flatMap((g) => g.children.filter((c) => c.isInstancedMesh));
    const dir = this.raycaster.ray.direction;
    // (a weld point seen nearly edge-on is not drawn, so it is not picked either)
    let hit = this.raycaster.intersectObjects(helpers, false).find((h) => h.object.userData.kind !== 'slots' || -h.object.userData.items[h.instanceId].normal.dot(dir) > 0.14);
    if (hit && hit.object.userData.kind === 'slots') { // a pad hidden behind the part's own body is not the one under the cursor
      this.refreshSkinBounds(); // (as posed now: a turned turret)
      const body = this.raycaster.intersectObjects(this.part.children.filter((c) => c.isMesh), false)[0];
      if (body && body.distance < hit.distance - 0.01) hit = null;
    }
    if (hit) {
      const it = hit.object.userData.items[hit.instanceId];
      this.onHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: `${hit.object.userData.kind === 'slots' ? 'Weld point' : 'Pivot'}: ${it.name}` });
      this.setPartHover(null);
      return;
    }
    hit = this.partMeshAt(e);
    const att = !hit && this.attachedAt(); // (the ray partMeshAt set)
    if (att) { // a model shown on it (the Porcupine's barrel): its name, none of the part's materials
      const u = att.group.userData;
      this.onHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: `${u.label}${u.nodeName ? ' · on ' + u.nodeName : ''} · shown with the part` });
      this.setPartHover(null);
      return;
    }
    if (hit) {
      const m = hit.object.userData.material;
      const mi = this.info.materials[m] || {};
      const alb = this.texFor('albedo', mi);
      const tris = this.partMeshes(m).reduce((a, c) => a + c.userData.triangles, 0);
      this.onHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: `Material ${m}${alb ? ' · ' + alb.base.split('/').pop() : ''} · ${tris.toLocaleString()} tris` });
      this.setPartHover(m);
      return;
    }
    this.onHover(null);
    this.setPartHover(null);
  }

  // The part's mesh under the cursor (3D Viewer), or null (also when a model shown on it is in
  // front: a click on the Porcupine's barrel picks none of the launcher's materials).
  partMeshAt(e) {
    if (!this.part) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.refreshSkinBounds();
    const hit = this.raycaster.intersectObjects(this.part.children.filter((c) => c.isMesh), false)[0] || null;
    const att = hit && this.attachedAt();
    return att && att.distance < hit.distance ? null : hit;
  }

  // The model shown on the part (attach()) that the raycaster's ray meets first: { group, distance }, or null.
  attachedAt() {
    const list = this.part?.userData.attached;
    if (!list?.length) return null;
    const h = this.raycaster.intersectObjects(list, true).find((x) => x.object.isMesh && x.object.visible);
    if (!h) return null;
    let g = h.object;
    while (g && !list.includes(g)) g = g.parent;
    return g ? { group: g, distance: h.distance } : null;
  }

  // Skinned bounds follow the pose: measured once per pose, so the raycast's box test can skip misses
  // instead of skinning every triangle.
  refreshSkinBounds() {
    const skel = this.part?.userData.skeleton;
    if (!skel || (skel === this.pickSkel && skel.version === this.pickVersion)) return;
    this.pickSkel = skel;
    this.pickVersion = skel.version;
    this.part.updateMatrixWorld(true);
    for (const c of this.part.children) if (c.isSkinnedMesh) { c.computeBoundingBox(); c.computeBoundingSphere(); }
  }

  // ---- the part's materials outlined, as the builder outlines parts (3D Viewer) ----
  partMeshes(material) { return this.part ? this.part.children.filter((c) => c.isMesh && c.userData.material === material) : []; }

  // the selected material orange, the one under the cursor (or under the mouse in the panel) white
  partOutlines() {
    const list = [];
    if (this.mode === 'part' && this.part) {
      if (this.partSel != null) for (const m of this.partMeshes(this.partSel)) list.push({ object: m, color: 0xffa43c });
      if (this.partHover != null && this.partHover !== this.partSel) for (const m of this.partMeshes(this.partHover)) list.push({ object: m, color: 0xffffff });
    }
    this.setOutlines(list, 'part');
  }

  setPartHover(material) {
    material ??= null;
    if (material === this.partHover) return;
    this.partHover = material;
    this.partOutlines();
  }

  // a material of the part selected (null: none); onPartSelect tells the page
  selectPartMaterial(material, { force = false } = {}) {
    material ??= null;
    if (material === this.partSel && !force) return;
    this.partSel = material;
    this.partOutlines();
    this.onPartSelect?.(material);
  }

  screenshot() {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  // World point -> page coordinates (used by the end-to-end tests to aim real mouse clicks).
  project(x, y, z) {
    this.camera.updateMatrixWorld();
    const p = new THREE.Vector3(x, y, z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, inFront: p.z < 1 };
  }

  stats() {
    let gpu = 0;
    for (const e of this.tex.map.values()) gpu += e.size;
    return { textures: this.tex.map.size, textureMB: Math.round(gpu / 1048576), geometries: this.geo.map.size, materials: this.live.size };
  }
}
