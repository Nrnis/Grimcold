# Crossout file formats (Targem Engine 2.0, game 2.40.10, 2026-09-30; 2.41.0, the remaster, 2026-10-23)

**Crossout 2.41.0.366214 (the remaster, out 2026-10-21)** changed what this tool reads in these
places: the pack index (TGP2 version 5, below), the terrain (16-bit heights at 0.5 m, ecotopes, under
Maps), the environments (sun, sky, fog and camera are entities of each map's scene now, the sky a
picture: "Environments in 2.41", under Maps), the water (every volume on the layered shader, its waves
one texture's layers: "Water and acid"), the newer trees' meshes (a second vertex stream, their
draw ranges at the block's end, their LODs only in the ranges: under `.mdl`), the ground cover's
material (shader 63BA6D0F, under materials) and the particles' version (18, laid out as 17); Stronghold's
model is renamed. Textures, sounds and the other shaders are as in 2.40 (`xotest scan`: 13,064 models,
0 errors; `soundscan`: 6,750 of 6,750 play; `texscan`: the same eight odd formats as 2.40).

Everything here was worked out from the installed game (`%LOCALAPPDATA%\Crossout Launcher\data`) and
verified against every file of its kind in the install (see "Verification" at the end). All
integers are little-endian.

The engine is Targem's own, earlier the engine of Star Conflict, and called Targem Engine 2.0 since
the "Supercharged" update (October 2022: global illumination, screen-space contact shadows and
reflections, DLSS 2); the "New Sky" update (February 2019) had added atmospheric scattering,
volumetric clouds and fog.

## Install layout

```
Crossout Launcher\
  bin\win64\Crossout.exe, Crossout-D3D11.exe      (DX12 default + DX11 build, BattlEye)
  data\<pack>.index + <pack>.grp                  784 packs, 86,329 files, 13.5 GB  (read by this tool)
                                                  2.41: 56 packs (models_constructor_01.. 07, levels_maps_01.. 15,
                                                  assets_props_01.. 07 ...), 96,029 files, 21 GB, 29.7 GB unpacked
  data\{gamedata,shaders,sound,strings,ui,video}.pk2 + .index   encrypted ("TGE" header), NOT read
  data\grp_hdr.vromfs.bin                         Gaijin VROMFS (launcher metadata), not needed
  data\sound\*.bank                               FMOD banks
  xo.yup                                          launcher torrent manifest (verifies/repairs files)
```

## `.index` ("TGP2") + `.grp` ("GRP2")

The `.grp` is a Gaijin Dagor "GRP2" resource pack (header `GRP2`, name table, resource table, data).
The game and this tool use the `.index` instead, which describes the same files plus a chunk table:

| offset | type | meaning |
|---|---|---|
| 0x00 | char[4] | `TGP2` |
| 0x04 | u32 | version (4) |
| 0x08 | u32 | file count N |
| 0x0C | u32 | chunk size (131072) |
| 0x18 | u64 | data offset inside the `.grp` |
| 0x20 | u64 | data size |
| 0x38 | u32, u32 | names block: uncompressed size, compressed size; then one zstd frame |
| ... | u32 | entries block: compressed size; then one zstd frame of N x 64 bytes |
| ... | u32 | chunk table byte length; then one u24 per chunk (compressed size, 0 = stored raw) |

Names block: repeated `u16 length, char[length], '\0'` (lowercase, `/` separators).

Entry (64 bytes): `u64 size` (uncompressed), `u64 offset` (from the data start), `u32 firstChunk`,
`u32 hash`, `u64 nameOffset` (into the names block), `u32 nameLength`, `u32 1`, `u8 md5[16]`
(MD5 of the uncompressed file), `u64 0`.

A file is `ceil(size / 131072)` consecutive chunks starting at `dataOffset + offset`: each chunk is
either one zstd frame (table value = its byte length) or raw (table value 0, stored length =
`min(131072, remaining)`).

**Version 5 (Crossout 2.41).** The header has 64 bytes more at 0x28 (hashes of the pack, not needed
to read it), so the names block's two sizes sit at 0x68 and its frame at 0x70; the rest follows as in
version 4. Each 64-byte entry holds the same things in another order, and an XXH3-128 of the file
where version 4 had its MD5:

`u64 size`, `u64 offset` (the stored bytes before its first chunk, as in v4), `u64 nameOffset`,
`u32 nameLength`, `u32 firstChunk`, `u8 ?[8]`, `u8 xxh3_128[16]` (little-endian: its low 64 bits are
XXH3-64 of the file), `u64 1`.

Checked on models_weapons_01 (1,176 files): every file read this way unpacks to its size, and the XXH3
of the first ones matches; the tool reads all 96,029 files of 2.41 and skips the MD5 check for v5
packs (`Pack::md5Sums`). Every file now starts on a chunk of its own (5,677 chunks for 1,176 files).

## `.mdl` (TCF MODEL, versions 8 and 9)

```
0x00 "TCF MODEL" (16 bytes)   0x10 u32 version   0x14 u32 blockCount   0x18 u64 directoryOffset
directory: blockCount x { u32 type, u32 size, u64 offset }
```

| type | content |
|---|---|
| 13 | header: bbox min (vec4), bbox max (vec4), `u16 lodStart[4]` (first mesh of LOD 4,3,2,1; 0 = unused), `f32 lodDistance[4]`, `u16 meshCount`, `u16 groups`. Version 9 leaves `lodStart` / `lodDistance` zero and lists the LODs at +78 instead: `u16 lodCount`, `u16 firstMesh[lodCount - 1]` (of LOD 1, 2, ...), 4-byte align, `f32 distance[lodCount - 1]` (279 vehicle parts and weapons and 329 props have several; reading only the v8 fields put all their LODs on top of each other). The "distances" fall with each LOD (`barrier01`: 0.305, 0.097, 0.022, 0.012) and grow with the model's size, so they are screen-size thresholds, not distances: they read best as the share of the screen the model covers, as an area (Maps mode switches when (radius / (distance × tan(fov / 2)))² drops below one, times a detail factor; `xotest lodscan` lists them) |
| 0 | one mesh (one material, one LOD); see below |
| 1 | nodes: `u32 count`, 44 bytes, then count x 240: `name[32]`, `i32 parent`, ..., `+0x50` local translation, `+0x60` local rotation quat (xyzw), `+0x70` world matrix, `+0xB0` inverse bind matrix |
| 6 | build slots (attachment points of the constructor grid): `u32 count`, count x { `name[32]`, matrix } |
| 16, 17 | map-prop volumes (occluders / cut volumes), not in vehicle parts |

### Build slots and the constructor grid

The garage grid has 0.3 m cells. A part's slots sit at the centres of its outer cell faces, so
in model space every slot position lies on a 0.15 m lattice, and part origins sit on cell
corners. A slot's matrix Y axis is the face's outward normal. Two parts are joined where one's
slot coincides with the other's (within 2 cm here) and their normals point at each other. The
builder uses exactly this to snap parts and to tell whether a vehicle is one connected piece.

Slot names come in two families: `slot<a>_<b>` and `cslot_<n>` / `cslot<a>_<b>`. A frame's top is
`slot`, its sides `cslot`; a wheel's mount points are `cslot`; a cabin's underside is `cslot`, its
other faces `slot`; structure, weapons and modules use `slot` only. The garage draws `cslot`
weld points as a square with a round hole (ring about 76 % of the square across, hole about 64 %)
and `slot` ones as a plain square. Both kinds weld to each other (the garage turns a frame's
side `cslot`s orange under a held bumper).

The game calls these **weld points** ("parts are connected if there is at least one weld
point"). Its garage marks them with `particles/models/weld_slot.mdl`: a 1 x 1 square pad (z = 0)
crossed by four thin fins (x = ±0.375 and y = ±0.375, reaching ±0.1 in z) so a point also shows
edge-on, with `particles/models/weld_slot` on shader `A52275F8`. That texture (128 px RGBA8) is
pure white; the shape is in its alpha: 5 transparent texels round the edge, a soft painted frame
with rounded corners, and a swirl of noise inside (alpha 0.15-0.91) that the game's shader must
use for an effect, because in the garage's augmented-reality mode the points show as a thin,
straight white frame around an even see-through fill that lightens what is behind it by about a
third (user's in-game screenshots), with no swirl and no fins in sight. The squares are flat and
one-sided, never turn towards the camera, and vanish at about 85° from straight on. While a part is
held, the vehicle's weld points it would weld onto show orange (a yellow-orange frame around a
salmon fill that tints the surface about half way); every other point stays white. The shader
behind all this is not in the readable archives. Drawn with its alpha as it is, the texture's
swirl shows and the frame wobbles; the viewer draws only the pad, with its own frame + flat fill.
The effect
file `particles/gameplay/editor_weld_slot.psys` (binary) also holds light-blue RGBA bytes
(103, 195, 255 and 126, 204, 255), apparently for a glow of its own, not the boxes. Unwelded
parts are shown in red.

The rest of the garage's augmented reality is in `models/augmented_reality/` (both on the AR
shader `A52275F8`, no textures): `spring.mdl` (a coil spring 0.07 x 0.28 m lying along +Z: the
suspension mark standing beside each wheel's hub between up / down arrows) and
`decals_locator.mdl` (a flat ring 0.3 m across with an arrowhead: the turning arrow round the
steering symbol, `ui/textures/svg/icn_steering.svg`, at the foot of a steering wheel). The part
under the cursor, the held part and the part it lands on get a thin white outline along their
silhouette and inner edges; the held part itself is a see-through, washed-out ghost. The label at
the cursor while holding a part ("4 ▤") is the number of that part in storage.

### Weapon aiming limits (firing arcs)

A weapon's `.model` has pose layers `AimYaw` (turn) and `AimPitch` (tilt), e.g.
`poseParameter AimYaw -180 180` and `poseParameter AimPitch -22 30`; many files list the pitch
high-to-low (`60 -29`), the range is the same. Of 184 weapon folders, 157 have both (117 turn
all the way round, others ±70, ±50, ±45, ±10, one -75..50), one has pitch only (Compiler) and
the rest none (fixed and melee weapons, guided launchers, projectiles). Checked by posing the
models: at rest a weapon points along +Z (glTF space), positive pitch tilts it up, positive yaw
turns it towards -X. The pivots are the top-most nodes whose rotation the two layers change
(e.g. `rot` / `joint3`, `yaw` / `pitch`, `rot_y` / `rot_x`).

Matrices are 4x4 float, row-major, translation in the last row (Direct3D). Space is left-handed,
Y up, triangles clockwise. Converting to glTF: mirror Z (positions, normals, tangents, matrices:
`M'[r][c] = s_r s_c M[r][c]`, `s = (1,1,-1,1)`), keep the index order, flip tangent handedness.

### Collision hulls: `.mdp` (TCF MODEL_PHYS)

Beside most `.mdl` files sits a `.mdp` with the part's physics shapes: one or a few convex hulls
(a frame: a box with 8 points; a cabin or a wheel: 16-20 points). They are what the game collides
with, and what the builder uses to refuse a part that would sit inside another (two hulls deeper
in each other than 3 cm; welded parts only touch: depth 0). Same TCF container as `.mdl`, one
block of type 9:

```
+0x00 u32 kind (19, 20: 4x4 matrix per shape; 21: quaternion + offset)   u32 hash   u32 shapes   u32 0
+0x10 u32 0   u32 string-table size   u32 geometry size   u32 0
+0x20 shapes x 128 bytes (96 for kind 21):
        transform: 4x4 row-major, translation in the last row (kind 21: quat xyzw, then vec3 + pad)
        then u32 type (3 convex hull; 4 a triangle mesh, not convex), +0x18 u32 material name
        offset, +0x20 u32 geometry offset, then node references (-1: none)
      string table: "\0Metal_Base\0..." (material names, node names such as "pitch", "yaw")
      geometry, per shape at its offset: vec4 box min, vec4 box max, u32 point count (16-byte
        row), u32 index count (16-byte row), points (vec4, shape space), indices (u32 triangles)
```

2,060 of the 2,066 `.mdp` files under `models/` read this way (the 6 others are one laser weapon
and its projectiles); 64 of 2,890 shapes are type 4. No vehicle part or weapon uses a rotated shape
(only offsets). The hulls sit within 1 cm of the visible mesh's box for 56 % of the models, within
15 cm for 95 %; some are bigger on purpose (a radar's sweep disc, a cabin's wide platform).

### Mesh block (type 0)

| offset | content |
|---|---|
| +0x00 | u32 flags (0x3 = float3 positions, 0x10 = half4 positions) |
| +0x04 | 14 x vertex element `{u8 format, u8 semantic, u8 index, u8 offset}`, zero-terminated |
| +0x3C | u8 streams (1), u8 0, u8 element count incl. position, u8 stride |
| +0x40 | u32 words[12]: [0] material index, [1] vertex count, [2] index count, [3] groups, [5] max influences (0 = rigid), [6] for a rigid mesh the node it rides on (a wheel's tyre on its hub; -1 or 0 = none), for a skinned mesh its first bone: a vertex's bone numbers count from this node (bone j = node [6] + j; 1,043 of 3,781 skinned meshes start past node 0, `xotest skinscan`), [7] bone count |
| +0x70 | the vertex stream's own copy of the declaration (64 bytes) |
| +0xB0 | vertices, then u16 indices (u32 if > 65535 vertices; never happens), 4-byte align, bbox (vec4 x2); trees then list their draw ranges (below) |

Position: first `offset` bytes of the vertex (12 = float3, 8 = half4 with w = 1).

Trees (SpeedTree, 135 models under `assets/props/trees/`, shader `06bc377b`): every mesh block has
material `0xFFFFFFFF` and ends with draw ranges `{u32 material, u32 lod, u32 firstIndex, u32
indexCount}` that tile its index list: bark, leaves and the billboard share one vertex buffer (the
billboard's range sits in the last LOD with the tree on 63 of the 135 models, in LOD 0 beside it on
27; Maps draws it as a LOD of its own, see Trees). `parseModel` makes one mesh per range. The stride-24 vertex: `half4` position
whose w is the **u** coordinate, `half4` LOD position (the point the vertex moves to as the tree
switches LOD) whose w is **v**, then `ubyte4` (tangent around the trunk) and `ubyte4n` (wind data);
no normal. The billboard (stride 16) has a plain `half4` position and `half4` uv.

Crossout 2.41 adds trees and ground cover of a newer kind (`assets/groundcover/`, `juniper_new`,
`pine_new`, `phoenix_palm_new`, `piceaabies_*` ...):
- 48 mesh blocks (none in 2.40) have a second vertex stream: one element of index 1 (`{0x12, 0x34, 1, 0}`:
  4 bytes a vertex, what it holds is not known), stored after the first stream's vertices; the stride
  byte (28) is the two streams together, the first steps at 24 (the tree layout above) and the indices
  follow both. Between the indices and the box these keep 64 .. 128 bytes more, so their draw ranges
  are the last `16 x n` bytes of the block and the box the 32 before them (`xotest`'s ranges: 1,314
  meshes found the old way, 48 from the end, none neither; all 453 of 2.40's the old way).
- 263 models (most of the ground cover, the newer trees; and 27 bushes in 2.40) give no LODs in their
  header (`lodStart` all 0, no version-9 list) and one mesh block per LOD whose draw ranges carry its
  LOD number: the ranges' `lod` is the LOD (0 .. 4 for `piceaabies_tiny`: bark and branches each, the
  billboard in LOD 4).

Formats: `0x02` float2, `0x05` ubyte4n, `0x06` ubyte4, `0x09` short2n, `0x0A` short4n,
`0x0F` half2, `0x10` half4, `0x14` byte4n.

Semantics (low nibble = kind, high nibble = set): `1` blend weights, `2` blend indices (node
indices), `3` normal, `4` UV (`0x14` second set, `0x24` third), `5` tangent (xyz; w sign =
handedness, `0x15` = tangent of the second UV set), `7` colour, `9` QTangent: byte4n unit
quaternion, normal = q·(0,0,1), tangent = q·(1,0,0), handedness = sign(q.w).

The bitangent the engine uses is `sign(w) · cross(N, T)`, which points along -dP/dv (towards the
top of the texture), i.e. normal maps are OpenGL-style (+Y up). A curl test over the game's
normal maps agrees (43 of 46 vote +Y up).

All 12,754 models / 85,709 meshes use 31 layouts, for example `pos12 | normal short4n @12 |
tangent short4n @20 | uv float2 @28 | stride 36` and `pos8 | qtangent byte4n @8 | tangent1
byte4n @12 | uv half2 @16 | uv1 half2 @20 | stride 24`.

Health (`xotest geoscan [prefix ...]`, 85,487 meshes / 49.9 million triangles): the tangents follow
one convention throughout; no skin points past its node list. Fixed in `decodeMesh`:
- **Bad UV numbers.** The radio tower's radar parts (`assets/props/constructions/radio_tower/radar_main_p*`)
  declare a second `half2` UV set that holds other data (infinities, 65504s on almost every vertex):
  dropped, since the game evidently never reads it. 3 to 10 vertices of bridge cranes, reward balls and
  space-station rings carry NaN or infinity in their first set: those become 0. (The export wrote them
  into glTF files.)
- **Inside-out meshes.** Mirrored copies whose triangles all turn their back on their own normals: the
  right-hand ladder of builders_town, the carrier propeller `carrier_lun_vint_r02`, carrier hull plates,
  small far LODs (14 meshes). The normals light them right, so a mesh with 90 % or more of its triangles
  against its normals gets its winding turned; the viewer had shown their inside (pale, hollow rails).
  Trees are left alone (two-sided leaf cards, normals built from the trunk), and so are mixed meshes
  (the carrier deck, 84 %, looks right).
Left as they are: far LODs that drop thin bits (antennas, debris: smaller boxes than LOD 0), backdrop
rocks and sky domes beyond 1 km, a few stray but finite UVs.

## `.mdf` materials, `.skins`, `.model`

`.mdf` is XML: `<Materials><Material guid="..."><Parameter name="..." [type="pin"]>value</Parameter>...`.
Mesh `words[0]` indexes the `<Material>` list. The main shader is `fbb75fb5-e347-4f7f-8c42-55f588a09f88`.

| parameter | meaning |
|---|---|
| DiffuseSampler | albedo `_a` (sometimes `_e` for pure glow materials) |
| NormalSampler | normal `_n` |
| SpecularColorSampler | gloss map `_g` |
| Diffuse2Sampler, ColormapSampler | mostly glow maps (`_e`, `_glow`, `_anim`), sometimes a second albedo layer |
| DetailSampler | detail normal |
| Invisible (pin) = 1 | the slot is hidden: skins switch geometry by hiding material slots |
| HasDiscard, Mat0AlphaTest | alpha test |
| UserParam0/1/2_Float4 | shader constants (tiling etc.) |

Transparency (checked against in-game screenshots of the starter buggy):
- **Cut-outs**: the game drops texels whose albedo alpha is below 0.5: nets, grates, chain-link,
  wires, torn flag edges, foliage, track links. No material switch turns it on. Such materials
  carry `User0` = 1, 2 or 3, other pins or none, so the switch is the texture itself: albedos that
  have an alpha channel (BC3; a few BC7/RGBA8) are cut out, while BC1 albedos (about 1,000 of the
  constructor's 1,200) have no alpha. `xotest mdfscan` / `alphalist` list them: 169 constructor
  models have such an albedo, 80 of them with visible holes.
- **Glass**: shader `0BA5C7A3-FF1B-420F-A506-36E4143B2602` blends by the albedo alpha (cabin
  windows, `*_glass_a`, and the propellers' motion-blur discs `*_motion_a`); 98 constructor models.

Glow (checked against the in-game item icons on crosscalc.net, which are garage renders at rest).
`xotest emisscan` lists every glow slot:
- The lamp shader `F3007363-3E56-453E-A97A-5E816E807463` is a glow layer of its own: lights, signs,
  screens, flashers, Reaper's red lamp (200 materials with geometry; see below).
- The main shader's Diffuse2Sampler `_e` (176 materials) is a plain glow map on decor, modules and
  cabins (holograms, screens), always lit. On a weapon's skinned body it is a **heat or charge
  mask**: minigun and shotgun barrels (orange), Aurora's red channels, Quasar's blue plasma cells.
  The game lights it only while the weapon fires, and the icons show it dark. Separate glow pieces
  on weapons (`DisableSkinning` = 1: Thyrsus I's glow insert, Athena's light, projectiles) are lit
  at rest. No pin or UserParam tells the two apart (`User5` = 1 appears on both kinds, and
  UserParam1 like `3.2 1.6 12 0` on both), so the rule is: weapon + main shader +
  Diffuse2Sampler + skinned. The viewer shows these at a Barrel heat level (0 at rest) and the
  export writes it as the glTF emissiveFactor (`extras.heatGlow`).

### The ground cover shader (`63BA6D0F`, Crossout 2.41)

`assets/groundcover/` (new in 2.41: grass, flowers, small stones; 185 materials, the grass system's
models) uses one shader whose parameters are named by the textures' endings, as paths in the model's
own folder: `<Parameter name="_a">*basegrass4d_a</Parameter>`, `_n`, `_g`, `_at`. `_a`: colour, BC3
sRGB (its alpha is mostly opaque: not the cut-out); `_at`: the cut-out mask, BC4 (basegrass4d: 94 %
holes); `_n`: normal, BC3 DXT5nm (x in alpha, y in green); `_g`: gloss in green (BC1, red and blue 0).
The tool maps them to albedo / mask / normal / gloss: cut out by the mask as a tree's leaves are.

### The lamp shader (`F3007363`)

Its meshes are **overlays**: every triangle lies within 2 cm of the part's own surface (measured on
8 parts), laid over head lights, signs and screens, with the layout `normal short4n, uv float2,
uv1 short2n` (`DisableSkinning` = 1, `User6` = 2 on all of them). They only add light; read as an
ordinary material (DiffuseSampler = albedo) they come out as solid white sheets over the lamps.
Worked out over all 200 lamp materials with geometry (`xotest lampscan [prefix]`: textures, pins,
both UV sets' extents and the texels they hit):

    glow = Diffuse(uvD) x Colormap(uvC) x UserParam0.x / 10      (added onto what is behind)
    uvD = uv0, uvC = uv1; the User5 pin = 1 swaps them (Diffuse on uv1, Colormap on uv0)
    uvD += UserParam1.xy x t, uvC += UserParam1.zw x t           (UV per second)
    uvD turned about (0.5, 0.5) by UserParam0.z degrees per second

- One of the two textures spreads over the piece (the colour: `_e`, `_glow_color`, `_emit`), the
  other is a **blink timeline** read along a line or at a point (`_anim`: 4x64 `taxi_light_anim`,
  32x128 `police_flasher_glow_anim` with a column per lamp) or plain white (`textures/blank_parts_e`,
  `white`). Which slot holds which varies (`military_cab05_anim` sits in Diffuse, `taxi_light_anim` in
  Colormap); the UV sets agree: the timeline's set is a point or a line, the colour's spans the
  atlas. Without the User5 swap the colour would be read along one line (taxi) or at one black
  point (military_cab5, engine_x24_legend's 8 glow sprites, scientists_cab4's lamp cluster).
- Same texture in both slots (cybereast cabs, workers_cab1): squared, and those have higher
  intensities (12-17.7 against the usual 8-12).
- Rotating beacons (`UserParam0.z` 600 or 1000 with User5): the Diffuse is a sector (kfz231's
  quarter disc), a flare (`ambul_flasher_glow_anim`) or a wedge in a black disc
  (`military_cab05_anim`, white outside the disc: military_cab5's own lamp reads it at (0.82, 0.11),
  outside, so it stays lit while `military_cab5_light.mdl` turns).
- Not used here: `UserParam0.y` (1 on most; 8 and 4 with `.w` 0.0656 and 0.4 on fht_legend and
  ball_china, apparently a pulse), `User7`, `User8` (on lights, screens and weapons alike). The
  digits of nurs_legend are 9 lamp materials with only `Invisible` = 1 (presumably switched on by
  the game). The two Fusion guns read `emit_heat` (cyan cells): shown lit like every lamp, though
  the game may light them only while charging (not checked).

The viewer draws them so (unlit, depth test without depth write, polygon offset, no shadows, not
picked, only outlined on their own) and keeps blinking ones moving at 30 frames per second while one
is on screen. An export has one texture per slot: the colour texture times the other one's mean over
the piece (texel by texel when both use the very same UVs) becomes one `*_glow.png` whose alpha is
its brightest channel, on a black, alpha-blended material (glTF emissive + `emissiveStrength` above
1, `extras.lampGlow`; OBJ `Kd 0 0 0`, `Ke`, `map_Ke`, `map_d`), with the colour's UV set moved to the
first set. No map prop uses the shader (`xotest lampscan assets/`: none).

### The other glow shaders

The host reads every glow shader into one description (`xo::GlowLook`: d and c textures, swap, gain,
scroll, spin, added or see-through, two-sided) that the viewer and the export share:

- **`644D00C3`**, the lamp shader's twin on map props, gameplay objects and helpers (227 materials,
  `xotest lampscan <prefix> 644d00c3`): neon signs (`neon_*` x `neon_timer` timelines), garlands,
  candles, window lights, projector and terminal lights, digit displays, a map police flasher (with
  User5 and the same 1000 deg/s in `UserParam0.z`). The same parameters as the lamp shader, `User1` = 1
  instead of `User6` = 2. Its glow textures' alpha is a sharper core inside the soft halo the colour
  draws (`gladiator_neon_a`, `visitor_glow`), so it is not multiplied in. The exception, and the only
  materials with `User4`: the build-slot markers `models/misc/slot` / `slot_back`, pure white with a
  55 % alpha square: blended by the alpha (they were drawn as a white slab).
- **Layered materials with `AdditiveBlend` = 1** (`39E61427` on parts' separate light models:
  `leg_vertical_epic_03_light`, `wheel_moto_military_01_light`, `minigun_relict_emission_01/02`;
  `A7516479`: 4 materials on gameplay objects and 40 on map props: garlands, pumpkin glows, window glows, sky nebulae):
  one colour texture per `MaterialLayers` index (not the map layers' albedo / normal / gloss triplets),
  layer 0 on uv0 and layer 1 on uv1 multiplied, `UserParam0.x` = intensity (3-18, like the lamps'), not
  the map layers' tiling: read as a tiling it repeated the glow map 10 times over a solid sheet.
  `StaticAnimationUv0` turns layer 0 by `UserParam0.y` deg/s (60, 1000: the same flare
  `ambul_flasher_glow_anim` the lamp shader turns at 1000), `StaticAnimationUv1` scrolls layer 1 by
  `UserParam1.zw` (garlands 0.6/s). A third layer (one sky prop) is left out. The two emission
  shaders without `AdditiveBlend` (a Halloween moon, a barrier's screen with an `@turned_off` skin at
  intensity 3 against 12, a decor lamp) are the same glow blended by its alpha: read as map layers
  they were tiled by their intensity (the moon came out as a 10 x 10 grid of moons).
- **`User2` = 1** on these two kinds marks glow pieces the game draws from both sides: 33 `644D00C3`
  materials (the garland strips `garland_w*` with `visitor_glow`, `de_vis_kiosk*`, `visitor_front*`,
  `ohra_sail`, `cyb_signs04`, `ilon_single07`) and the `A7516479` garland cards (`garland_2m` / `4m` /
  `8m` `_v1-3`, `garland_long`; `visitor_glow2` at intensity 13 on hangar_newyear's Christmas tree, hill
  strings and hangar roof arch). The `garland_w` strips are two crossed quads that both face local -Z,
  laid along eaves and gables with -Z pointing down and inward, so from above and from the street a
  one-sided view culled them as back faces, while newyear_foray's capture shows their bulbs from above
  (drawn two-sided, their light in view went up 3 x on a hut and 120 x along the long house's verge).
  They also glow about 10 times brighter than intensity / 10 gives: fitted to newyear_foray's night
  capture (958203) with the strips two-sided, x 10.2 over its views (4.6-20.7 view by view; read as an
  EV100 luminance, their intensity of 11 would give x 6.1, which fits only loosely). The view and the
  export draw them from both sides (glTF `doubleSided`) and x 10 (`Export.cpp` `kTwoSidedGlow`). The
  `garland_a` ridge bulbs (`User3`) stay one-sided: so they fit the capture at 1.24, two-sided at 0.53.

`xotest matscan [prefix ...]` lists the materials (every skin, LOD 0) that may be drawn wrong:
shaders drawn as ordinary materials, additive layers not read as glow, no texture, missing textures,
glow maps used as the main texture, second slots the view does not show. In the parts
(`models/constructor/`, `models/weapons/`: 1,849 models, 2,502 material uses) only the doll's eyes
(`98E16772`, a vehicle-style shader, drawn as one) and 22 standard materials with a second albedo
layer (`basecolor_green_a` on the big and mega trucks, sand and rust on a nomad PvE cabin, shown as
their first layer) remain. Over all of `models/` also the map-prop shaders on gameplay objects
(drawn like on the maps, further layers included) and helpers: physics primitives, AR
locators, the blender tutorial's pyramids, `a4c4de38` / `f046989b` debug and marker shapes; no
texture is missing anywhere. `xotest flagscan` prints every material's look flags, to compare two
builds.

Map props (`assets/props/`) use other shaders, and their albedo alpha mostly holds heights or masks
for blending, not holes (`xotest shaderscan assets/props/`, `pinscan`):

| shader | materials | textures | transparency |
|---|---|---|---|
| `64177e0a` layered | 16,363 | `MaterialLayers` index 3k / 3k+1 / 3k+2 = layer k's albedo / normal / gloss; `LayersCount`; `UserParam0_Float4` = the layers' tiling; `MatkUvType` 1 = layer k on the second UV set, 2 laid over the world; layers blend by vertex colour or a colour map and height (below) | solid; with `Mat0AlphaTest` / `HasDiscard` (684 materials, 672 of them with a BC3 layer-0 albedo: railings, ladders, grates, stencilled numbers) cut out by layer 0's albedo alpha |
| `62bd5a8e` | 5,041 | Diffuse / Normal / Specular + `Diffuse2Sampler` (+ `DetailSampler` normal, `AmbOcclSampler` gloss) of a second layer (moss on rocks, cracks on concrete; below) | `User0` |
| `e611362b` | 556 | the same slots as `62bd5a8e`, a second layer filling the first one's hollows (below) | `User0` |
| `16b15fe6` | 4,802 | Diffuse / Normal / Specular; `Diffuse2Sampler` a glow map with `User1` = 1, `DetailSampler` a detail normal map with `User2` = 1 (below) | `User0` |
| `85f3a2ed` | 2,287 | overlay meshes laid on other geometry: cracks, dirt, road markings, graffiti (`User2` 2 / 3, `User3` 1); a glow map only with `User1` = 1 | blends by albedo alpha, or by the gloss map's red where the albedo has none (below) |
| `98e16772` | 122 on props | windows and glass (`brocken1_a`, `window_a`, `modern_glass_a`, `wagon_coach_glass_a`), all BC3 | blends by albedo alpha: glass (on vehicle parts it is the doll's eyes, by the albedo alone) |
| `a658e182` grass | 58 | the groundcover (`mapskit/models/groundcover/`, the arctic snow chunks), no switch: 48 blade materials with a BC3 atlas, 10 solid debris kinds (stones, bricks, concrete debris, snow chunks: `User1` = 2, a normal map and a tangent stream, BC1 / BC2 albedo) | cut out by the albedo alpha (the blades' atlases: 49-95 % holes; `cover_a` 87 %); the debris solid |
| `06bc377b` SpeedTree | 289 | `*name` = a texture in the model's folder; `Type` 1 = bark, 0 = leaves (alpha-test mask in `Diffuse2Sampler`, `_at`, BC4), 2 = billboard (mask `_at` too) | leaves and billboard cut out by the mask (Maps, Trees) |

`User0` on the other prop shaders: 1 or 2 = cut out by the albedo alpha (chain-link, nets, holed
plates), 3 = see-through (windows, barbed wire) as far as the alpha really holds it (read at about
256 px, where thin wires still show as in or out): alpha 1 nearly everywhere (under 1 in 500 texels
below 250 / 255: the factory windows' band) is solid, with shadows and depth; all in or out (under
30 % of texels between 26 and 229: chain-link, grids, camouflage nets, water lilies) is cut out; the
rest (cloth, frosted wire) blends. Without `User0` the alpha is not transparency (the mapskit ground
textures keep a height there). The layered shaders' further sets are below (map materials).
These rules follow the shader, not the folder: gameplay objects and other models outside `assets/`
use the same prop shaders (scaffolding and gate tarps with `User0` = 3, overlay decals on the ex tower,
the ammo boxes' icons), while the vehicle shaders (main, scrolling belts `BA811382`, `98E16772` outside
`assets/`, `5EEF185A`) go by the albedo's alpha alone. Every cut-out is drawn with alpha to coverage,
and albedo-alpha cut-outs keep their coverage in the small mips (box-filtered mips keep the mean
alpha but lose coverage at 0.5: midland `cover_a` 0.133 at mip 0, 0.055 at mip 5). A cut-out material
is shown only once the textures that cut it have loaded: three.js builds the shadow pass's copy of a
material once, and one built before its mask kept the wrong cut for the session. In Maps a gloss map
can make a surface as smooth as roughness 0.05 (map glass, puddles, polished metal; vehicle parts keep
0.2, and so do exported textures); leaves and grass without a gloss map are matte (roughness 0.95;
other materials without one 0.55).

### Map materials that blend texture sets

The layered (`64177E0A`) and two-layer (`62BD5A8E`, `E611362B`) map shaders blend further texture sets
over the first. `/model` describes them in `layers` (`xo::MapLayer`): per further set its game layer
number, tiling, UV kind (0 uv0, 1 uv1, 2 laid over the world: game x / z divided by the tiling in
metres), inverted height map and four blend parameters; `weights` = `vertex` / `colormap` / `none`.
Their textures have the roles `albedo2` / `normal2` / `gloss2` (the first further set), `albedo3` ...
(the second). A set's height is its gloss map's red channel (ground `_g` red about 0.5 = surfaces.mxml
`HeightMid`). The shown set's own tiling and UV set are in `uvScale` / `uvSet`; `/geo` sends the UVs as
stored (the export still bakes them into uv0).

| shader | layers | weight | rule (t = how much the set covers what is below, clamped 0..1) |
|---|---|---|---|
| `64177E0A` | `MaterialLayers` 3k..3k+2 for k < `LayersCount`; tiling `UserParam0[k]`, UV kind `MatkUvType`, `MatkInvBlendMap`; params `UserParam{k}_Float4` | vertex colour R (layer 1) / G (layer 2) with `User5`; else `ColormapSampler` (`*_cm`, `*_mask`, BC1, R / G) read through the third UV set (vertex semantic `0x24`) | vertex weights: amount = 2 W - 1.15 + p.x + p.z + 0.25 x p.w x up; colour map or none: amount = W - 0.5 + p.x + p.z - p.w x up; t = (h - (1 - amount)) / (1 - p.y) + 0.5 |
| `62BD5A8E` | Diffuse2 / Detail / AmbOccl = the second set's albedo / normal / gloss; tiling `UserParam0.x` (base) and `.y` (second); `User4` = 1 second on uv1, 2 laid over the world | none (no vertex colours) | amount = UserParam0.z + UserParam1.x - UserParam1.y x (2 up - 1); t = (h + amount - UserParam0.w) / (1 - UserParam0.w): full from h = 1 - amount on |
| `E611362B` | the same slots; tilings `UserParam0.x` / `.y` | none | t = (h_first - h_second) x UserParam0.z + 0.5 |

up = the y of the surface's own world normal, before any normal map (taken after the first set's normal
map, the moss came out as speckle where the game has whole patches on the ledges). The rules are fitted
to the game's light-probe captures of bridge, chemical_plant, bentmetal and cityruin (the shaders are
encrypted): negative `UserParam1.y` puts the second set on faces that look up (moss, grass, sand and rock
tops), positive down the sides (canyon walls, paint on pipes and stacks). For 62BD5A8E a ramp ending at
1 - amount reaches the game's coverage on bridge's rocks (one centred on it gave about half); 64177E0A
keeps the centred ramp, which scores better on cityruin and chemical_plant. 64177E0A's vertex-colour
rule was fitted on 33 light-probe views of 9 maps (cityruin, vulkan, chemical_plant, bridge, castle,
sand_valley, arizona_silo, helicopter_cathedral, hangar), each rendered with the base, each layer full
and the look, so that any rule could be scored offline against the capture in linear light. With
W - 0.5 the many models whose vertex colour is a flat 0.5 (unpainted, as on vulkan's arctic bridges and
ice cliffs) were covered all over where the game shows them bare (vulkan's bridges white instead of
rusty), and chemical_plant's `mount_bg3` (flat R 0.576, w 0.606) stayed bare of its own `mount_a`; the
doubled weight puts a layer only where it is painted, 0.5 counting as none (22 views better, 8 worse;
vulkan's changed cells 4.29 -> 2.83 and 5.44 -> 2.76 in summed log2 error, chemical_plant's
`mount_bg3` chroma error 0.60 -> 0.18). Once the weight is right the world-up term is weak (0 to 1 x w
within 1 %), but + w x up beats - w x up on every score: layers with w > 0 lie on faces that look up,
as 569 of the 574 grass, moss, sand, dirt, snow, soil, ground and rock-top layers with a nonzero
`UserParam{k}.w` say. It is kept at 0.25 x w because at full strength the far town houses' colour-set
layer (`seaside_farbuildings`, `color_set_mcb_1_a`, w 1) tints their roofs yellow, which no capture
shows. Colour-mapped materials keep W - 0.5 and - w x up, which their captures favour (with the vertex
rule on them too, 22 views better and 10 worse, losing mainly on `backgr_mount1/2`'s 19,712 cells).
The vertex colour's blue is not layer 2's weight (read as it: 9 views better, 24 worse;
`cliff_detail_01` has B 0.83 on bare slopes), and its alpha is not an occlusion term (A = 0 on whole
models such as `seaside_bigstones01`). Not settled: no additive weight rule fits both castle's grassy
seaside hills (flat weight about 0.36, x + z 0.70, grassy in the game; a little worse with this rule)
and vulkan's bridges (flat 0.502, x + z 0.60, bare), and hangar's colour-mapped `stalker_rockstuff02`
wall is +0.44 EV and whiter than the game (its `rock_layed_a` layer covers too much; the vertex rule
would fix it but loses elsewhere). E611362B's second set fills where the first is lower (the other
way round, `classic_fence01` was a uniform wet-dark sheet; this way it is
sulfur's light concrete fence with dark wet hollows). `MatkUvType` = 2 occurs with tilings 8/10/12/16
(metres per repeat); `User4` = 2 on 62BD5A8E likewise (e.g. `crater_cliff1` 17 m, `hangar_4horsemen`
16 m). E611362B's `BlendSampler` (`*_b`, 16 materials) names textures that are not in the game files:
those blend by heights too. Unused: `Mat0InvBlendMap`, the vertex colour's blue and alpha (blue = 1 on
the B-52 parts, B = A on destructible rocks: unknown), 62BD5A8E's `User2` / `User5` / `User6` pins,
5EEF185A's second albedo.

Exports: a 62BD5A8E without a world-up term (`UserParam1.y` = 0) or an E611362B, both sets on uv0, is
baked into one albedo / normal (occlusion kept) / gloss over one repeat of the first set
(`<first>_<second>_<hash>.png`; exact on atlas-mapped meshes, tiled ones repeat it): 1,908 of 5,032
two-layer 62BD5A8E materials and 523 of 556 E611362B. Others keep their first set, with
`extras.layers` / `layerWeights` / `layersBaked` describing the rest and `extras.textures` naming every
layer's texture (chemical_plant: 466 materials, 158 with layers, 43 of them baked). Colour edits of the
first set's albedo are baked in before the blend.

### Glow maps, detail maps and overlays of map props

- `16B15FE6`: `Diffuse2Sampler` is a glow map exactly when `User1` = 1 (389 of 394 User1 materials have
  one; `projectors_race_*_g`, `container_house_light`, `r_buildings_light` glow whatever their name), at
  `UserParam1.z` x (1 when not given: windows; lamps 10-15; coach glass 0.1). Read with the lamps' / 10,
  the new-year houses' windows were invisible at night, while the game's night loading picture
  (`level_newyear_foray`) shows them bright orange. Without User1 the slot holds a dirt or detail layer
  (`concrete_dirtyl01_d`, `armature_a`) or a glow the game leaves off (`windows01_glow` on hangar walls);
  the game's own `chin_light5_no_glow` and `billboard_light1_nolight` are the same materials without
  User1.
- Overlays (`85F3A2ED`) follow the same switch, whatever the texture's name: only `oracle_altar`'s
  `coal_e` has `User1` and glows; the 42 `wood_detales_8m_glow` window overlays (new-year houses,
  elevator manors, west_wood_church) and the lighthouse's `windows01_glow` stay dark, as newyear_foray's
  night capture shows them. Exports: `emissiveFactor` up to 1, `KHR_materials_emissive_strength` above.
- 16B15FE6 with `User2` = 1: `DetailSampler` is a detail normal map tiled `UserParam1.x` times over the
  base UVs (4-32); blended in tangent space, faded out by 40 m. Without User2 the slot is unused.
- 85F3A2ED overlays always blend; an albedo without alpha (BC1 flat colours: `color_yellow4_a`) shows
  where the gloss map's red says (the `road_marcking_g` stripes; where both exist that red is the
  alpha, correlation 0.99); drawn with a polygon offset. Exports: BLEND with that mask in the albedo's
  alpha.
- Map glass (98E16772 on props, blended `User0` = 3 windows) outputs premultiplied: its reflection stays
  whole, only what it lets through is scaled by its alpha.
- `SubsurfaceScattering` / `SssSoftLight` (arctic ice walls, `pumpkin_glow6`): a wrapped sun term.
- `DoubleSided` (`1 0 0 0`, wagon_coach_light) draws both sides.
- Mesh semantic `0x15` (tangent of uv1) stays undecoded: the view builds frames for sets on uv1 or the
  world from UV derivatives.

Scrolling belts, shader `BA811382` (101 materials in `models/`): tracks (8 track models and the
drone tracks), engine and cabin belts (`engine_flat10`, `engine_v8_epic`, `engine_v8_legend`,
`junk_cab2`, `ravagers_cab1`, `scientists_cab2_arena`), chains (the Porcupine `barrel_launcher`,
`saw_launcher_legend`), saw teeth (the Lacerator `chainsaw_dble`), feed tapes (`shotgun_spreadburst_legend`,
`minigun_relict`), `wheel_launcher_epic`'s belt, and the tyres of many wheels. The game slides their
texture along them from its code: no `.model` or `.anim` holds a UV track, and `UserParam1_Float4`
(`1 1 0 0` on most, `0 3 0 0` on the V8 belts, `1.5 1.5` to `2.5 2.5` on broken wheels) gives no
speed. Every belt wraps a node the part's clips or pose sets turn round, and its UVs run along it:
the Porcupine's chain wraps `gears01` (r 0.086 m; 16 links per UV unit, 0.249 m per unit, 0.34 UV
per radian of the gear), a track its road wheels (the `WheelRotation` poses), an engine belt its
pulleys (idle clips). A tyre on this shader rides its own spinning node and does not slide. The
viewer (`ui/belts.js`) measures each piece's UV change per radian of the wheel it wraps (straight
runs take the rate of the wheel they leave from) and slides the texture by the wheel's turn.

Track wheels (`ui/drive.js` `rollsOf`, measured on all 8 track models): seven turn every wheel with
one `WheelRotation` (-180..180); `track_raider_01` has one parameter per wheel size,
`TrackRotation1..4` (`wheel_center_01` r 0.49 m with its two small wheels, `_02` 0.54, `_03` 0.59,
`_04` the belt's wheel, wrapped at 0.75). Their road wheels have `TrackSuspension1..N` (0..0.4, 0..0.25 on the auger), one wheel each,
down about a metre a unit (0.8 on `track_triangle`; at 0, as built, all the way up; the belt's
vertices ride the wheels, so the belt follows). On every one a parameter degree turns its wheels one
degree, and -180 and 180 are the same wheel (one full turn over the range, so it wraps without a
jump); a higher value rolls the track forward as placed, mirrored too, back when the part is turned
round. The belt's wheel and the radius the belt runs round it at: `track_2_wheel` 0.41 m,
`track_diesel_01` 0.24, `track_dow` 0.35 (`wheel_08_mesh_rotate`), `track_rhomboid` 0.34,
`track_tractor` 0.61, `track_triangle` 0.34. For the belt to stand still on the ground the wheel
turns by the distance over that radius. `shneck` is an auger: `WheelRotation` turns `rot_left` and
`WheelRotation2` `rot_right` about the part's length, two screws of opposite hand turning opposite
ways, each a four-start thread with a lead of 0.61 m and 0.58 m (from its rim's edges; the helix
phase of its outer vertices agrees to 0.99 and 0.79 with that hand, 0.02 with the other); a higher
value drives both forward. Driven, a turn of a screw carries it one lead.

Material fallbacks (`xotest matscan` over `models/` and `assets/`: 12,357 models, every skin):
- A model with no `.mdf` of its own and no `default` skin (the knight helmets placed on sulfur, the
  scoreboard digits) takes the first skin of its `.skins` file; it had no materials and showed white.
- A material with only a second colour layer (the map bulldozer's `@ocher` / `@red` / `@beige` /
  `@scientists` skins: `Diffuse2Sampler`, no `DiffuseSampler`) shows that layer.
- A layered material whose first layer's albedo is not in the game files (some mapskit grounds, snow
  on new-year props) takes the next layer, with that layer's own tiling (`UserParam0` component) and
  UV set (`MatkUvType`).
- Shader `DE4D728D` is a plain colour: no textures, the colour in `UserParam0` (linear, 0.18 = middle
  grey; arctic greybox buildings, castle and funicular details, a cooling tower's inner wall).
- Shader `A52275F8` without textures is a helper the game does not draw (physics primitives, AR
  locators, a weld clip, collision or shadow proxies inside props, 7,014 triangles of the sand valley's
  aircraft hangar): hidden when the model has anything else to show.

`.skins`: lines `skin <name> <mdf base name>`, e.g. `skin skin1 m_bumper1_skin1` (the game data
even has `skin defaukt ...`). `.model`: text descriptor (`mesh`, `skin default`, `anim` layers
with `poseParameter AimYaw -180 180`).

## Animations: `.model` + `.anim`

A part's `<name>.model` text file lists its animation layers (Source-engine style):

```
anim fire { activity FIRE  file minigun_explosive_fire.anim  speed 1.5  addLayer aim }
anim aim  { activity IDLE  file minigun_explosive_vcont.anim  poseParameter AimPitch -10 30  addLayer gun_rot }
anim rotation { files { wheel_r17_rot_01.anim ... wheel_r17_rot_04.anim }  poseParameter WheelRotation -180 180 }
jigglebone "cage_1" { ... }   // procedural wobble (not simulated here)
```

- An activity layer (IDLE, FIRE, OPEN, CLOSE, WALK, DEATH, ...) plays its clip over time. Its own
  clip goes first and the layers it adds (`addLayer`) on top: each layer's offsets are applied in
  the frame the earlier ones left the bone in, so the order shows where one clip moves a bone that
  another turns. The Porcupine's `fire` and `reload` slide `deploy_01` 0.611 m (the next barrel
  rolls in from `deploy_02`) while the added idle spins it 360 degrees per 0.375 s: idle first, the
  slide turned with the spin and swung round a circle. Of 526 animated parts only it and
  `wheel_ravager_epic`'s perk (disks sliding along their own spin axis) stack a slide after another
  layer's turn; the other 147 stacks with both are aim (pose layers, applied before the clips) then
  recoil, which must follow the aim.
- A layer with a pose parameter is not timed: the parameter's value picks the point in the clip
  (AimYaw -180..180 turns a turret; AimPitch, WheelSteer, WheelSuspension, TrackSuspensionN,
  LegX/Y/Z, ... likewise). The range maps onto the clip in the order it is written: the first number
  at the clip's start. 194 of the 256 AimPitch layers and 21 of the 255 AimYaw layers are written
  high to low (`AimPitch 60 -29`; the Browning's clip turns the gun from 60° up to 29° down and is
  level exactly at 60/89 of its length; also 20 WheelRotation, 2 User1 and 1 WheelSteer layers).
  `xotest posescan [parameter|*]` lists the 907 pose layers with how far their clips turn. Every
  bone they move exists in the model. 15 move nothing and get no slider in the viewer:
  - empty clips (the ballcannon's and catapult's yaw, wheel_launcher's pitch);
  - missing clips (track_rhomboid's suspension 9-12);
  - keys that never change (track_dow's suspension 1 and 8, shneck's 3).
- `files { }` lists single-key poses spread evenly over the range, and the value blends between
  the two around it (wheel spin: -180, -60, 60, 180; steering: -20, 20). A bone missing from a pose
  is at rest in it. 28 wheels' -180° and 180° spin poses are empty files (wheel_military: rest,
  120°, 240°, rest = one full turn), and so is minigun_relict's `fire_mode_0` pose.
- `addLayer` stacks layers. An activity plays its own layer and the layers it adds (recursively),
  not every layer in the file. Several activities may hold the same clip on the same parameter:
  - flame_thrower: `aim` (IDLE) and `fire` (FIRE) both hold the pitch clip;
  - 9 leg models: `move` (IDLE) and `move_z` (WALK, RELAX, STAND_UP) both hold LegZ;
  - saw_legendary, guided_lockon_oracle_base: the same pattern;
  - wheel_workers_2modes: the suspension runs 0.55..1.6 standing up and 0..0.35 sitting down.

  Playing them all at once turns those bones twice as far.
- The viewer's rule, with nothing picked:
  - IDLE's stack (else the first activity's), plus pose layers no activity adds;
  - a parameter that stack leaves out takes its layers from the first stack that has it (a rolling
    mech leg's wheel, the pop-up shotgun's Height).

  `posescan *` checks this rule over all 1,800 stacks: no bone is driven twice through one
  parameter, and no parameter is left without a slider. It also prints RANGES for the one model
  whose layers disagree on a range.
- Aiming (AimYaw / AimPitch, on 254 parts). The game aims by setting the target's angles in degrees
  in the part's frame: yaw turns towards -X from +Z, pitch tilts up. Measured in the viewer, with
  the barrel taken as the gun bone's +Z:
  - on 226 parts the gun turns exactly by the value;
  - mortar_cannon / mortar_mandrake and rocket_artillery_legend still follow the value, but their
    gun bone points straight up at rest;
  - the rest really differ:
    - crossbow_rocket, rail_crossbow, disc_gun, trible_crossbow: -10..24° for -29..60;
    - quadrocopter guns: a three-pose blend at -23, 0 and 11° for -11, 6 and 23;
    - turret modules: 7° high;
    - machinegun_side_epic: 60° for 52.9;
    - turret_harpoon_lgnd: pitch reversed;
    - assassins_cab1_drone: its barrel is the gun bone's -Y; it shoots down from a hover, 0 level
      to -90 straight down.

  The viewer's Look at me therefore measures each part:
  - the gun is the bone turned by both parameters that carries the most of the part, followed
    down a neck chain;
  - the barrel is its axis that best follows the game's convention (+Z on 247 parts);
  - each parameter's angle is sampled across its range and read back, with a per-frame correction
    where yaw and pitch interact.

  All 254 parts face the camera within 0.71° anywhere they can reach.
- 923 `.model` files hold 1,958 layers.
- Legs (`ui/drive.js` `gaitOf` / `placeFoot`). A walking leg's `LegX` / `LegY` / `LegZ` set where
  its foot goes from where it stands, about a metre a unit in the part's frame: LegX out (-X),
  LegY down, LegZ ahead (the spider leg `leg02`: -1.01, -0.99, 1.00 m a unit; ranges +-1.5, +-1.2 on
  `legs_new_mech_01`, +-15 on the 10x `leg02x10`). The game walks a leg by setting them (the foot
  planted, or carried to its next spot) and playing its WALK activity, `step`: a lift of the foot
  and down again (0.33 s and 0.40 m on `leg02`, 0.30 s and 0.18 m on `legs_new_mech_01`, 0.40 s
  and 0.24 m on the millipede's legs), on top of the three. Their clips bend: on the mechanical leg
  the values for a straight move put the foot up to 11 cm wide at a stride, so the viewer measures
  where the foot went and sets them once more (within 0.7 cm; 0.5 on the spider leg). The vertical
  legs (`leg_vertical_*`) have no clips (one a suspension) and do not walk; the millipede's legs
  (`leg_millipede_leg_01` / `_02`) are models of their own beside its base, the folder's part. Footsteps are in `sound_legs`: `legs_step_base1..10` (and `_add`),
  `legs_step_water1..8`, and the mechanical legs' `ml_light_step1..4`, `ml_med_base` (+ `ml_med_add`),
  `ml_heavy_base` (+ `ml_hv_add`), with `ml_landing_base1..4`, `legs_to_wheels` / `wheels_to_legs`
  and the jump jets' `ml_jets_*`.
- Wheels: 42 of the 59 wheel models have `WheelRotation` (-180..180, a degree a degree of the
  wheel, -180 and 180 one), `WheelSteer` (+-15 to +-45; about the vertical, a little tilted on some,
  a lean on the moto wheels) and `WheelSuspension` (0..0.32 to 0..0.8: metres, the hub straight down
  about a metre a unit, 1.0 to 1.2 by its linkage); 2 have only the rotation (the Ilon wheels,
  `wheel_ilon` and `wheel_ilon_high`: steered whole), 15 none (they spin whole, as before). The poses
  move the real linkage: arms, shafts, shock absorbers (`wheel_r17`: `susp_arm_lower` 60 degrees over
  its 0.32 m), and the rotation turns `wheel_center` alone. At 0, the pose the builder shows, the
  spring is all the way up (the hub highest). `ui/drive.js` `wheelRig` measures the hub's travel and
  the steering's axis on each model.
- Water on maps: `levels/maps/<name>` water areas (an outline and a level); a vehicle in it uses
  the game's `particles/materials/water/wheel_water` (`_slip` skidding), `hover_water`,
  `air_cushion_water`, `propeller_water`, `leg_water` / `leg_landing_water` and `collision_water`
  (going in), with the sounds `wheels_water_roll_p` and `wheels_water_start1..4_p`.
- Exhausts: the cabins carry nodes named `fx` / `fx1` / `fx01` ... (164 in 80 cabins, besides
  `perk_fx`), at the pipes: a particle effect goes along its node's +Y (`ui/fx.js`: a spawner throws
  its particles along its own +Y), and their +Y points out of them (the raider cab's four back from
  its rear pipes, the ravagers' back, the Mi-24's out of its sides; the diesel cab has nine, some
  sideways at its top corners, some down). Which nodes the game plays its exhaust on is in the
  encrypted data; the viewer plays it on all of them (six at most). The game's effects,
  `particles/constructor/exhaust_smoke_<x>.psys`, are named for their
  cabins and families (`diesel_cab1`, `diesel_cab2`, `military_cab`, `ravagers`, `workers`,
  `tribal_cab4`, `mi24`, ...; `engine_flat10`, `engine_v10` for engines; `a` / `b` / `c`, `light`,
  `rear` plain); which one a cabin plays is in the encrypted data, so the viewer takes the one named
  for it, else its family's, else `exhaust_smoke_a`.
- Rain on the lens: `particles/levels/raindrops_screen.psys` (no environment names it; the game
  adds it in the rain): two heat-haze emitters (blend 6, camera-facing) with
  `particles/textures/haze/drops_4x1_haze`, 25 drops a second each, born in a ball of 5 m and of
  2 m round the effect's origin, 0.5 to 2 s long; hung on the camera, the near ones bend the view.
  The rain weathers' own effect is `particles/levels/area/stalker_rain` or `area/rain_mid`.
- Hover jets (`hover_jet`, its three variants): `HoverRotPitch` (-90..90) turns `steer_x` a degree a
  unit about the part's -X (a higher value tilts its exhaust forward), `HoverRotRoll` (-20..20) turns
  `steer_z` about -Z on the part as made; mirrored, the roll goes the other way round. The game sets
  them as the vehicle pulls and turns (`ui/drive.js` `tiltOf` measures the bone each turns and which
  way); their `idle` (x3) turns the turbines.
- Idle clips: 108 of the 744 builder parts' main models have an IDLE activity that plays over time
  (19 cabins: rotors, fans, the raider cab's engine; 28 modules: the engines' belts and fans at 0.2
  to 4x, radars at 0.5x, generators, stabilizers, coolers; 36 weapons; 10 decor; the air cushions'
  vents, the hover jet's turbines and the tail propeller among the movement parts).

`.anim` ("TCF ANIM", the TCF container with u32 version 8) has one block of type 2:
`f32 ?`, `f32 duration` (s; keys are 24 fps), `u32 trackCount`, `u32 0`, a 256-bit mask of the
animated bones and one of the bones they move, then trackCount x { `name[32]`, `u32 boneIndex`,
`u32 keyCount`, `u32 format`, `u32 0` }. Key data is grouped by format:

- all format-0 tracks: per key, vec4 translation then quaternion
- format-1 tracks: vec4 translation
- format-2 tracks: quaternion (x, y, z, w)

After the key data come `u16` key times per track (0..0x7fff = 0..duration). Values are offsets
from the bone's rest pose: the rotation after the bone's rest rotation, the translation in the
PARENT's frame (as Maya keys a joint's translate), not turned by the bone's own rest rotation. Over
every clip, the 48 mirrored bone pairs (left / right) that slide come out as mirror images 34 times
in the parent's frame and 30 times in the bone's own (4 only in the parent's: the crossbow rigs'
limbs and the minetrap's pistons; none only in the bone's own); of the fire-clip slides the two
readings send apart, 22 go straight back (a recoil) only in the parent's frame and 9 only in the
bone's own (mostly one limb of those crossbows). Read in the bone's own frame, the heavy gun's
`recoil_barel` kicked 16 cm forward, the quad railgun's and the spreadburst shotgun's barrels went
down and sideways, the burst crossbow's string dropped instead of snapping forward, and the triple
crossbow's right limb swung back while the left went forward (its mesh tore 16x); the legendary saw's
8 blades are keyed pre-turned 45 degrees apart in the hub's frame. 619 tracks in 103 parts read
differently (> 1 cm). `xotest animscan` parses all 2,464 files with 0 errors, and all rotation keys
are unit quaternions.

## Textures: `.tfh` + `.tfd`

`.tfh` = header + the small mips; `.tfd` = the large mips (may hold every mip).

```
u32 a = kind(4 bits, 1 = 2D) | width(14) << 4 | height(14) << 18
u32 b = depth(4) | ...(7) | mipCount(4) << 11 | flag(1) << 15 | code(8) << 16 | shape(8) << 24
mipCount x layers x { u32 offset, u32 size, u32 rowPitch, u32 sliceSize }   smallest mip first, a mip's layers together
```

Most textures have one layer. Layered ones have layers = (first entry offset - 8) / 16 / mipCount,
every layer of a mip the same size: 1,612 R11G11B10F cube maps (the maps' light probes), 7 BC1 / BC3
cubes (`defaultcube`, the tutorial map's), 3 RGBA8 cubes (chemical_plant's `diffuseenvmap`) and the
layered water's arrays, `water_foam` (4 layers, BC3), `water_default_w` (64, BC7) and
`water_default_v` (64, BC1). A cube map has 6 layers and shape 2: faces +X -X +Y -Y +Z -Z in
Direct3D's order, in game space (glTF = game with z mirrored), rows top-down; the faces' axes: +X
u = -Z v = -Y, -X u = +Z v = -Y, +Y u = +X v = +Z, -Y u = +X v = -Z, +Z u = +X v = -Y, -Z u = -X
v = -Y.

A mip lives in the `.tfd` once its offset restarts below the header size (or drops below the
previous one). Pixel format = `code >> 3`:

| code>>3 | format | typical use |
|---|---|---|
| 5 / 6 | RGBA8 / RGBA8 sRGB | noise, UI, sky |
| 7 / 11 | BC1 / BC1 sRGB | `_g` gloss / `_a` albedo |
| 9 / 13 | BC2 / BC2 sRGB | billboards with sharp alpha |
| 10 / 14 | BC3 / BC3 sRGB | `_n` normals / `_a` albedo with alpha |
| 20 | BC4 | alpha-test masks `_at` |
| 22 | R11G11B10F (unsigned small floats) | the maps' light probes (cube maps) |
| 25 / 26 | BC7 / BC7 sRGB | newer normals and albedo |
| 27 | BC5 | normals, flow / motion vectors |
| 30 | BC6H (unsigned half floats) | sky panoramas (`assets/skies/*`: `sky_hdri/072_day`, `087`, `stars1`, `space/nebula_planet`, `screenshot`), a workshop light mask (`craftbox_light_mask`) |

BC6H (code 244, `code>>3` = 30) is decoded to sRGB bytes clamped at 1 (the viewer takes it from
the host, the GPU path does not); against Pillow's decoder of the same blocks (written as DDS with
DXGI_FORMAT_BC6H_UF16) the linear values agree within 2/255 over a 4096x2048 sky, a nebula and the mask.

R11G11B10F (codes 176 / 179): 4 bytes a texel, R in bits 0-10 and G in 11-21 (6-bit mantissa, 5-bit
exponent each), B in 22-31 (5-bit mantissa), exponent bias 15, no sign; denormals are m / 2^(mantissa
bits) x 2^-14. Like BC6H it decodes to sRGB bytes clamped at 1, and to linear floats for the light
probes; a DDS copy is DXGI 26 (layered textures get the DX10 header with their array size, cubes
flagged as such). R and G top out at 65024 (exponent 30, every mantissa bit set; B at 64512), and the
probes' brightest texels sit there (R = G = 65024 in the sun's disc of the sky-alone captures): what
lay beyond was clamped, so only low suns give the disc's true energy (Maps, light probes).

Other codes (1,646 textures, none under `models/`; `xotest texscan` lists them):
176 / 179 (`code>>3` = 22, above) are the maps' light probes (1,612 cube maps; see Maps), 128 / 136 /
184 atmosphere tables (RGBA16F 3D, RGBA32F; see Maps) and 3D lookup tables, 168 the BRDF lookup, and
0 / 5 / 12 / 27 single particle / effect textures. Read layer by layer, every texture decodes (the ten
that looked shorter than their header said, the tutorial map's probes, `defaultcube` and the layered
water's, are the layered ones).

Colour-grading LUTs (`textures/posteffects/`, named by an environment's `ColorRemapPath`): 256 x 16
RGBA8 (code 40), stored B, G, R, A (only read that way do the identity LUTs map every colour to
itself), in Unreal's strip layout: x within a 16 px slice = red, the row = green, the slice = blue.

Channel use on vehicle parts:
- `_n` (BC3, "DXT5nm"): X = alpha, Y = green, Z = sqrt(1 - x² - y²), red = ambient occlusion, blue unused.
  Not every BC3 normal map is DXT5nm and nothing in the header says which, so the layout is read off
  the texels: each of DXT5nm (X in alpha), RG and RGB is scored by the share of texels that make a
  unit normal facing out, and a near-tie goes to DXT5nm for BC3 (RGB otherwise). The old test (alpha
  varying around 128) read flat DXT5nm maps (alpha a constant 128, red 255) as RG: every normal then lay
  in the surface, lit edge-on. That hit 47 of the 1,474 normal maps of `models/`: the shared
  `textures/blank_parts_n` and `flat_n`, cabin and lamp glass, junk and buggy structure parts, the
  legendary engine, a cargo module, belts, several weapons (`xotest texrole` scores them all).
- Glass (shader `0BA5C7A3`): its gloss maps' blue is near 1 (`buggy_air_glass_g`, `ka52_glass_g`,
  `military_cab5_glass_g`...), so read as metal the windows came out as chrome; glass is never metal.
- `_g` (BC1): red = paint mask (where player paints go), green = gloss (roughness = 1 - G), blue =
  metal: ~0 on rubber, paint and rust, high on bare steel (tyres median 3/255, a minigun's steel
  82/255 with the 90th percentile at 239). The viewer uses it as metalness.
- `_e`: emissive / glow.

### Paints: `textures/patterns/`

The player paints' textures (the paints themselves, their names, prices and settings, are in the
encrypted game data): 554 textures under 391 names in 2.40.10.
- `<name>_a`, or `<name>` alone (the older ones), is a pattern's colour, 16 to 2048 px square;
  `<name>_n` its relief (a normal map, DXT5nm or RG). A relief without a colour of its own goes with
  its numbered or `_d` variants: `lava_skin_n` with `lava_skin01`, `scale_fish_n` with `scale_fish01`
  and `02`, `turtle_shell_n` with `turtle_shell01`, `crash_test_n` with `crash_test01` and `02`,
  `grid_n` with `grid_d`, `youtube_n` with `youtube01` to `03` (`bullet_holes01_n` has none). A
  16 x 16 colour with a 1024 px relief (`arachnida_01`, `cybereast_04`, `cybereast_06`) is a plain
  colour with a relief.
- `cham_*` (49) and `arena04` are chameleon paints: a colour ramp, 256 x 8 or 256 x 16 texels, every
  row the same; some have a relief too (`cham_glitter01_n`, `cham_bug01_n`, `cham_vinyl_n`,
  `cham_ravagers_01_n`, `arena04_n`). Which end of the ramp is which angle is not in the readable
  files; the tool takes the left end where the surface faces the camera.
- The developers' test textures: `test01`, `test02`, `pbr_test`, `dye_test_cham`, `dye_test_pic`,
  `delete_after_cinematic`, `td_512px_1m`, `checker_alpha`, `checker_direction_tile`. (`stress_test01`
  and `02` are paints, "Pattern: Graffiti Dusk" and "Graffiti Dawn".)
- Names: the paints' items and names are in the encrypted data; the game's English strings of 2018-19
  (`string.txt` of 0.8.25) name 43 of these textures, as `pic_<texture, no underscores>_Name` ("pic_LavaSkin01_Name"
  "Pattern: Lava") and `Dye_<name>_Name` ("Dye_Carbon_Name" "Material: Carbon", "Dye_DangerStripes_Name"
  "Pattern: Danger!"); near matches checked by eye (`camo_desert` = "Pattern: Digital Desert", `taxi_crack` =
  "Old salt", `black_crack` = "Pattern: Scorched Earth", `bullet_holes03` = "Metal fatigue"). The same strings
  list the colours as dyes with "metallic" twins ("Midnight", "Midnight metallic", ...) and the material paints
  Chrome, Gold, Aluminium, Rust, Carbon and Grid; "Paint thinner" takes paint off (ui/paints.js GAME_NAMES).
  Glass (`0BA5C7A3`) has its own shader: the tool paints no glass.
- A paint goes where a part's gloss map's red says (`_g`, above), laid over the part's second UV set:
  a camouflage read through it runs on unbroken over a cabin, through the first it breaks up into the
  texture's islands. The set is about 0.69 units a metre on most parts (raider_cab1, military_cab5,
  minigun_explosive: 0.69; decor 0.3-0.36; the older `ford_pickup` cabin 0.13), so a pattern keeps its
  size from part to part. Wheels and some decor have no second set.

## Particle effects: `particles/**/*.psys`

`particles/` holds 3,971 readable files: 2,067 effects (`.psys`), 708 `.tfh` / 512 `.tfd` textures
(flip-books such as `smoke/smoke_8x4`: 8 columns x 4 rows), and 342 `.mdl` / `.mdf` mesh particles
(`particles/models/hemisphere_muzzle`: a dome along +Z, radius 0.97, 0.51 deep). `weapons/` has 546
of them (muzzle flashes, projectiles, hits), `levels/` the maps' fires and smoke (scene entities
`Def="EffectEntity" Effect="particles/levels/fire/fire_on_ground"`, below). Which effect a
gun fires is not in any readable file (the item data sits in the encrypted packs): the 3D Viewer
matches guns to effects by name (`ui/fxmap.js`) and lets the user pick another.

Binary, little-endian, version 17 throughout; `tools/fxcheck.mjs` reads all 2,067 and nothing is
left over. Crossout 2.41 writes version 18 (all 2,113 effects), laid out the same: of the 1,505
effects the same size in both games, the bytes that changed are the version, re-rounded bounds,
re-baked hand-placed particles, floats nudged at spawner +0x4c, a few retuned values (rates, glow)
and emitter +0x63 bit 0x10, new on nearly every emitter (meaning unknown). In order:

```
header 48       u32 17, u32 emitters, u32 0, u32 0, f32 bounds min xyz, max xyz, f32 duration, u32 usage (bit 0: loops; see below)
emitters x 272
spawners x 128  each emitter's +0x28 of them, in emitter order
baked x 32      each emitter's +0x2c (particles placed by hand: holograms)
extras x 176    one per emitter whose +0x48 is not -1 (unknown)
slots x 80      each emitter's +0x30 spawn slots from index +0x50, its +0x34 life slots from +0x58
blob            names (0-terminated, 16-byte aligned) and curve keys; emitters and slots point
                into it by byte offset
```

Values are in the game's left-handed space (forward is -Z): the viewer mirrors Z, as for models.
A gun's muzzle is its `fire_01`, `fire_02` ... node (433 of them on 266 weapon models; ten skins have
`fire_fx_01` instead); the effect hangs on it. Colours are `0xAARRGGBB` (the railgun's plasma
emitter `ff2471f0` is blue).

Emitter (272 bytes; what the effects bear out, unknown fields left out):

| offset | value |
|---|---|
| +0x00 | 0..3 (5,178 / 304 / 1,141 / 3,310): a quality tier, perhaps |
| +0x08 | start delay, s: the smoke a beat after the flash; `flamethrower_projectile`'s three fireballs start 0.07 s apart, each placed 2 m further back, so all set off where the projectile was, which therefore flies 28.6 m/s |
| +0x10, +0x14 | particle life, shortest and longest (a LIFE slot picks between them, else the longest) |
| +0x1c, +0x20 | width and height when no slot sizes the particle; a streak's height is in seconds of its flight (sparks: `2 x 0.0333`, two 30 fps frames) |
| +0x24 | colour (and alpha) when no slot sets them |
| +0x28 .. +0x5c | counts and first indices (above) |
| +0x60 | how particles face: 0 camera-facing sprite, 1 a streak along its flight, 2 a trail (a ribbon through the particles in birth order), 3 a light (no texture), 4 a mesh |
| +0x62 | flags; bit 7 on a sprite turns its height along its flight (spark sprites) |
| +0x63 | bit 0: a streak's height is seconds of flight, so it lengthens with speed |
| +0x66 | blending: 1 adds light (5,274), 0 / 3 / 7 cover, 2 / 5 cover and are lit (smoke, with a normal map), 4 / 6 bend what is behind (heat haze); 8 (185, every one on `particles/textures/water/layered`: `_v` the displacement, `_w` the normal and foam, as the water volumes' own) pushes the water's surface, not drawn: ripples, splashes and wakes (`materials/water` 122 and 4 beam hits, `water_deformation` 27) and the blast of 30 cannon and 2 mortar muzzle emitters over water; drawn as sprites they showed as rainbow squares |
| +0x6f | bit 3 with a fourth texture (`explosions/emissive_ramp*`): a fireball; its colour slots then hold heat (red, read through the ramp where the normal map's alpha says), a glow boost (green) and the soot's brightness (blue) |
| +0x70, +0x71 | flip-book columns, rows |
| +0xa8 | brightness, like an exposure in stops: 9..21 on light-adding emitters (most 12..18), 1 on smoke, 0.1..2 on haze |
| +0xac | unknown: 1 on nearly every older emitter (0 on 835 of them, 629 light-adding), 2 on most 2.41 flip-books (also 1, 3, 4, 10); whole numbers, perhaps a soft fade against walls and ground (not drawn); not the motion vectors' strength (below) |
| +0xd4 | mesh name (blob offset, -1: none) |
| +0xe0 .. +0xec | textures: colour, normal map (or a glow's mask), -, ramp; since 2.41 also the flip-book layout below |

Since 2.41 (version 18) the smoke, fire and explosion sprites (`particles/textures/smoke_new`,
`fire_new`, `explosion_new`: 1,079 emitters in 329 of the 2,113 effects: hits, explosions, muzzles, maps' fires) are
flip-books with motion vectors, their textures told apart by the names' endings (`fx.js
textureRoles`):

| texture | holds |
|---|---|
| `*_mv`, BC5 (first slot) | how each frame's texels move on into the next: red / green around 0.5, green up (a haze emitter names one second, as its bends) |
| `*_naa`, BC7 (second slot; on 29 emitters the first) | a normal map in red / green (red to the right, green up), the smoke's own shading in blue, its density in alpha |
| `*_remap`, BC4 (third; 387 emitters) | where a fireball glows: read through the fourth slot's heat ramp (`explosions/emissive_ramp*`) in place of the old normal map's alpha |
| fourth | the heat ramp, as before |

Light-adding fires (42) name a mask second instead of an `_naa` (`fire_mid_ttm_8x8`, `fire_torch`: the
ramp gives all their colour); 4 name a colour texture third (`smoke_add`); 43 haze emitters name only vectors (their bends), 6 light-adding ones vectors and a `_remap`. The motion vectors'
strength is in no field: moving each frame by them warped towards the next fits best at 0.015 of a
cell (`smoke` 0.010, `default_explosion` 0.018, `flamethrower` 0.011, `smoke_superheavy_emission`
0.010; each frame then comes 6-50% closer to the next, and the halfway blend of two frames 30-60%
closer to the frame between them than a cross-fade). Before this the view took the first slot for
the colour: the motion vectors showed as a plain olive square.

Spawner (128 bytes): byte 0 the shape (0 a point, or a ball of radius +0x54 when that is set: a
map's ground fire, its fog; 1 a cone round +Y, +0x58 its half-angle in radians, +0x50 / +0x54
unknown; 5 a box; 6 / 8 / 9 rings and arcs, +0x50 the arc), byte 2 where the particles live (2
in the world, where they were born: 9,593 spawners; 3 riding whatever carries the effect, in its
frame: a round's glowing dot and tracer, 804; 0 and 1, 466, read as 2), +0x04 a burst count, +0x08 a
rate per second (the first particle comes at once: a round's tracer is "1 a second" for its whole
flight), +0x10 / +0x14 a repeat count and its interval (about 180 spawners have neither burst nor
rate, the full flamethrower's fireballs among them: they seem to emit as their effect moves, riding
something, and stay empty here), +0x18 speed and +0x1c a random extra, +0x20 position, +0x30 a
quaternion turning the spawner's +Y (its direction of flight) where it points:
`(-0.71, 0, 0, 0.71)`, down the barrel, on nearly every muzzle; +0x70 an optional rate curve over
the effect's time (the howitzer's smoke: 0 to 30 a second and off again by 1.1 s).

Slot (80 bytes): `u32 ?, u32 ?, u32 kind, u32 ?`, then for kind 0 (62,277 slots) `u8 components,
u8 mode, u8 factor flag, u8 ?, u16 parameter, u16 0x18` and up to three 16-byte value sources.
Parameters: 0 position, 1 a mesh's turn (x y z), 2 velocity, 3 colour, 4 alpha, 5 size, 6 width,
7 height, 8 ? (mostly set once at birth, on 43% of lit smoke and 71% of haze emitters; read as
gravity, drag or size it fits the bounds worse; the machine-gun tracer's is 0 on 73% of rounds and
1.14 on the rest), 9 a sprite's turn, 10 life (0..1 between the emitter's two), 11 flip-book frame
(0..1 over all frames), 12 / 13 water only. Modes: 0 sets, 1 adds so much a second (spawn slots add
once), 2 multiplies: a factor on what is shown, except on the velocity, where it is a drag per frame
(`vel *= 0.92`) unless the flag is set. Value sources (`u8 type, u8 input, u8 input2, u8 0, u32 n,
u32 offset or f32 value, u32 0`): type 2 a constant; 3 a straight line between two values (blob
`f32 a, b`) over its input; 1 a polyline (n keys `u32 time 0..65535, f32 value`); 0 a Bezier curve
(n keys `time, value, in handle, out handle`); 4 a table over two inputs (n = columns - 1 | rows - 1
<< 16, floats row by row: `absorb_haze_omnibox`'s spawn ring is cos / sin at 20 points). Inputs:
0 the effect's time (0..1 over its duration), 1 the particle's age (0..1 over its life; 30,562 life
sources use it), 2..7 random numbers the particle draws once (21,938 spawn sources use 2). Other
kinds: 1 a pull (`u32` 0 / 1 at +16, read as the effect's frame / the world's, `f32 x3` direction at
+32, `f32` strength at +48: sparks fall at 8.9..15 m/s²), 2..6 attractors, planes, vortices and wind
(not used by muzzles, not played).

The bounds in the header are what the game's editor saw the effect fill (particle places and sizes,
not a streak's length): played with the readings above, the 167 one-shot muzzle effects fill their
bounds to within 16% at the median (65% of the bound faces within 25%; `node tools/fxcheck.mjs
muzzle`; all 900 one-shot effects: 28%, 48%). Shape 0's ball took the looping map effects that use it
from 48% to 9% (`fire_on_ground`, whose spawn slot "position x= 0..8" spreads its flames over a
ball of 1 m into an 11 m patch), 26% to 7% (`fog_d`), 25% to 11%, 15% to 8%. Readings the bounds turned down: shape 1 as a ball of
radius +0x58 (21%, 54%), drag per
second instead of per frame (the howitzer's smoke would fly 40 m), every streak sized in seconds of
flight (the corrosion cannon's smoke streak, its bit clear, came out 4 km long), sign-mirroring a
velocity factor (the acid jet stopped dead), per-frame emission for spawners with neither burst nor
rate (the 49 such one-shot effects fit worse). The bounds cannot tell drag per 30 fps frame from 60
(both 19-21%), nor random input 2 from a particle's place in its burst.

Projectiles and hits. A gun's rounds carry their own effects (`weapons/machinegun/bullet_projectile`,
`weapons/cannon/tank_cannon_projectile`, `weapons/ags_proj`, `weapons/missile/missile_trail` ...),
forward -Z like the muzzles: the flamethrower's delayed fireballs sit 2 and 4 m along +Z, where its
round was when it set off, and a rocket's smoke is blown out along +Z. Which round a gun fires,
how fast and how far, is again in the encrypted item data (the viewer goes by the kind of gun,
`ui/fxmap.js`). So is how often it fires, but crosscalc.net's item table has each weapon's reload
time (`shooting_cooldown`, seconds; a rocket pod's from one salvo to the next; under a second, the
pace within a magazine), which the viewer fires on (`ui/stats.json` `reload`, `ui/anim.js`
gunBeat); weapons without one fire non-stop in the game (they overheat), here at the pace of their
Fire clip. The table's `firerate_rating` agrees for single-shot weapons (about 20 ln(60 / reload)
- 28 %) and sits above that for pods and bursts, several shots per reload. Particles of spawner space 3 ride the round; their streaks lie back from their
heads along its flight, as long as their own drift makes them: the shell's tracer is held 1.2 m
ahead of the shell and is 6.7 m long, `bullet_projectile_update`'s 3..5 m ahead and 12.9 m,
`bullet_projectile_hand`'s 18 m ahead and 53 m, all drifting back at 1..4 m/s (drawn along that
drift they would lie wholly ahead of their rounds). A streak from a world spawner rides the round too
(the minigun's tracer, 1 m ahead with 5..8 m behind it and hidden for its first 1/100 s while that
would still reach into the gun; a rocket's flame, held at it by a position slot); other world
particles stay where they were born (trails, smoke, a grenade's shed sparks) unless a spawn slot
scales their velocity (`vel *= 1`: the flamethrower's fireballs take the round's speed). Hit effects
(`materials/car/hit_car_*` on vehicles, `materials/ground/hit_ground_*`,
`explosions/projectiles/explosion_*` for grenades and rockets) spray round +Y: the surface's normal.
Light-adding fireball emitters without a colour texture (`plazma_projectile`'s swirl, `plazma_hit`)
take their colour from the ramp, by the heat their mask texture's alpha and red give.

What a slow round looks like in flight is a model: `models/weapons/projectiles/` holds the shared ones
(`missile` 0.85 m with fins 0.27 m across, `missile_01` 0.59 m and slim, `grenade_ags`, `grenade_shell`,
`bullet_mortar`, `bomb_grenade`, `bomb_disc`, shells), `models/weapons/crossbow_arrow/` the bolts
(`crossbow_arrow_01..03`, `bomb_arrow` with its charge), and launchers with their own keep them in
their folders (`…_rocket`, `…_missile_01`, `…_projectile`, `…_arrow`, `…_bomb`; `_fly` is the flying
copy where a `_turret_` one sits on the launcher, `_stuck` the one left in a hit). All point along +Z,
the round's flight (`crossbow_ballista_legend_projectille` ends at its origin, tip first); rockets
carry their exhaust as a node: `nozzle` (0.44 m behind the slim rocket's origin, 0.71 m behind the
finned one's), `exhaust`, `fx_01`. Which gun fires which is again in the encrypted item data.
17 of the models with fire points and a known round have no Fire activity: 16 have no animation
layers at all (the guided launchers `guided_single`, `guided_multy`, `guided_control` with their
skins and `guided_support_epic`, `bomb_launcher_2x_legend` and its `_bomb2`, `grenade_system`,
`shotgun_course_legend`, `shotgun_2barrel_revolver_legend_shell`, and the `_course` versions of the
flamethrower, the Vector and the Striker) and `guided_lockon_oracle_base` has only OPEN and IDLE;
the viewer gives them a Fire of its own. `guided_support_epic`'s three tubes point straight up.

The header's last word (+0x2c) sorts effects by use. Bit 0 loops; bit 1 marks a **beam**: an effect
laid along a line from the gun to what it hits (`teslagun_beam` 15, `particle_beam_laser` 11,
`laser_revolver_beam` 6, `plasmadrill_beam` 2, `harpoon_rope_beam` 2, `railgun_trace` 6 ...); hits are
4, rounds' own effects 5, the HUD's 16 and up. A beam's ribbon (orientation 2) is fed at a steady rate
and its particles jitter sideways (the Tesla's lightning by a table over time and age): drawn here,
each of its particles is one whole flash of the beam from the gun to its end, bent at the middle by
that jitter (the gatling laser's pulses show 36% of a 0.1 s loop, the laser revolver's flash 40 ms);
its sparks and glows spread along it. `tesla/tesla_trap_beam` is the fence's bolt between two poles.

Rounds that stay: what sticks or lands has its own effects beside its flight's: `…_work` while it sits
(`saw/saw_launcher_proj_work`, `mine_active` blinking, `ion_shield/ion_sphere_cooldown`), the sticky
bombs' fuses in `gameplay/` (`sticky_bomb_prepare` 3 s, `tempo_sticky_bomb_prepare` 4 s,
`revolver_crossbow_sticky_bomb_prepare`; the Hybrid's `weapons/machinegun/sticky_bomb_2mode_prepare`,
the Imugi's `weapons/sticky_launcher/sticky_bomb_prepare`), and their blasts (`crossbow/sticky_bomb_burst`,
`explosions/projectiles/explosion_2mode_sticky_bomb`, `explosion_mid_tempo(_small)`,
`saw/saw_launcher_proj_exp`). Hits on other surfaces are by material: `materials/water/hit_water_*`
and `explosion_water_*`, `materials/stone/hit_stone_*` and `explosion_stone_*`, `materials/wood/hit_wood_*`,
`materials/hit_beam_water` (the viewer uses them on maps).

Maps' effects. Scene entities `Def="EffectEntity"` with `isPlayed="1"` play all the time where
they stand (`Effect`, `PosHex`, `YPRHex`, `env_scale`: their size; `isPlayed="0"` ones are set off
by the game: a scene's explosions): 4,347 over the maps, 84 kinds (`fire_on_ground` 620,
`signal_antenna` 356 (an antenna's blinking light), `fire_on_ground_light` 305, `torch_fire` 280,
`smoke_drain_pipe` 230 ... steam, sparks, water leaks, `rain_zone_30m30m` (local rain), sand
falling, fog, geysers, birds), filtered by `GameplaysList` / `FestivalsList` / `EnvironmentsList`
like everything else. An environment's `AreaEffect` is its weather, born around the player in the
effect's frame: `snow_areal` (and `_dark`, `_faded`, the New Year's: 1..3 cm flakes in a box 20 m
across, 1..16 m up, 180 a second, falling about 5 m in their life), `area/rain_mid` / `stalker_rain`
(streaks falling 65..75 m/s from 8..10 m up over 120 m), `conflagration_areal` (ash rising),
`fuzz_areal(_2)` (fluff; `fuzz_areal` is only bending sprites), `area/asia_sakura_wind` (petals and
dust), `dust_areal`, `area/stalker_dust`, `area/arizona_sand`, `basic_areal`; `AreaScreenEffect`
(`raindrops_screen`) runs drops down the lens. `Def="EffectZone_Area"` boxes (`ScaleHex`: their
edges) change it inside: `turnOffGlobalEffect="1"` stops the weather (186 of 191: under bridges and
roofs), `areaEffect` / `screenEffect` play their own (arena_canyon's sand, zombie_escape_3's snow).
`xotest envscan` lists them all, `xotest envkeys AreaEffect,...` the environments' values.

## Sounds: `data/sound/*.assets.bank`

The sounds are FMOD Studio banks, loose files beside the archives (112 of them, 2 GB; the event
banks that say which sound plays when are not among the readable files). Each `.assets.bank` is a
RIFF `FEV ` file whose `SND ` chunk holds one FSB5 sample bank, version 1, a few kilobytes in:

```
"FSB5" u32 version (1), u32 samples, u32 sample headers' size, u32 name table's size, u32 data size, u32 codec (15: Vorbis)
then 0x3c bytes in (0x40 for version 0): the sample headers, the name table (u32 offsets, then
0-terminated names), the sample data
sample header: u64  bit 0 more chunks follow, bits 1..4 rate (1 8000, 2 11000, 3 11025, 4 16000,
                    5 22050, 6 24000, 7 32000, 8 44100, 9 48000), bit 5 stereo, bits 7..33 data
                    offset / 32, bits 34..63 frames
               chunks: u32 (bit 0 more, bits 1..24 size, bits 25..31 type), then the body.
                    1 channels (u8), 2 rate (u32), 3 loop (u32 start, u32 end frame, inclusive),
                    11 Vorbis (u32 CRC32 of its setup header, then a seek table)
```

The 63 effect banks (not the voices' `vo_*` or the music) hold 6,745 samples, all Vorbis, all at
48 kHz, with readable names (`hmg_grain3_p`: a heavy machine gun's shot, `mmg_tail_close_outdoor2` the
echo after a burst, `minigun_motor_start_loop` with loop points, `medium_explosion_close7`,
`mg_bullet_car4`, `harpoon_rope1` ...; variants numbered, `_p` on many). 105 have loop points.
FMOD keeps a Vorbis sample as its audio packets alone, each after a u16 size (0 ends them), without
the three header packets. The identification header is easy to make again (channels, rate, the
block sizes); the setup header is what libvorbis's encoder writes for the sample's channels, rate and
quality, and FMOD records its CRC32. The game uses three: mono and stereo at quality 0.7 and stereo
at 0.3 (CRC32 `c55efa16`, `a4f666fc`, `c4c30a29`); `tools/vorbis_setups.py` finds them by encoding
with a local libvorbis at every quality and keeps them in `src/xo/VorbisSetups.inc`. Each mode of
those setups is a short (256) or long (2048) block, by the bit after a packet's type bit; a page's
granule position is the frames decoded so far, the last page's the sample's frame count. Wrapped
in Ogg pages this way, every sample decodes to exactly its frame count (`xotest soundscan`).

## File names and in-game names

The archives hold no readable item names (the game's name tables are in its encrypted packs).
Found while naming parts by comparing renders with the in-game icons (`ui/names.json`):
- Rarity in folder names: `common`, `rare`, `epic`, `legend`/`legendary`, `relict` = relic,
  `preepic` = special. The in-game rarity sometimes differs (Queen is legendary, its file
  `autocannon_revolver_epic`).
- Alternative looks in a part's folder: `_china`, `_china2`, `_rdr` / `_rdrskin`, `_col`, `_arena`,
  `_workers`, `_fieldofficer`, `_fightdragon`, `_oracle` are skins; `_cybereast` is the Syndicate
  look, `_diesel` the Hyperborea look. `_fuse` is the customized version (crosscalc "(cust.)":
  `autocannon_epic_fuse` = AC64 Joule (cust.), `plasma_launcher_fuse` = Quasar (cust.)).
- A file named after the item beside the plain model (`mm5_4vector`, `shotgun_thunderbolt`,
  `heavygun_zis3_judge`, `hurricane`, ...) is a painted special edition of it.
- `_old` / `radar_old` / `q_coupler_old` folders and some main files hold older models. The old
  `hover_jet.mdl` renders scrambled even in its rest pose: it shares `hover_jet_a` with the new
  `hover_jet01/02`, whose texture was redrawn for a different UV layout.
- `_bp1`..`_bp4`, `_broken*`, `_brocken*` are debris pieces; `_projectile`, `_fly`, `_stuck`,
  `_deploy`, `_charge` are what a weapon fires.
- The game's old item definitions (`gamedata/def/ex/car_editor_*.lua`, kept by
  github.com/Zicore/CrossoutMarket up to 0.9.135; names in `strings/english/string.txt` up to
  0.8.25) give each item's model directly: `Def.CarPart_Grid_1.model =
  "models/constructor/structure/scrap_const/lattice/set_box_4x1x2"`, `.health`, `.physics.mass`,
  `.ui_part_filter`, and its name is the string `CarPart_Grid_1_Name` ("Grille 1").
  Armour and decor were named from them once (142 parts whose models are still in the game; items
  newer than 0.8.25 have no English name there).
- Names from the 2018 item data can be outdated: `shotgun_side_qbz_double` was "Banshee" in 2018
  and is Rupture today. Going by 2018 names and weights gave Ampere / Gasgen for
  `generator_danger_epic` / `_legend`, but the icons show Gasgen / Thor-6S (Ampere is
  `generator_danger_preepic`), so every name was checked against the icons.

## UI icons and part stats

The game's interface icons are plain SVG files in the readable archives, under `ui/textures/svg/`:
48 × 48 view boxes, painted `white` (the game tints them), no scripts. The builder's garage HUD
reads them through `https://xo.data/raw` at run time.
- `build/`: the garage's own buttons: `icn_showar` (augmented reality), `icn_carlifting` (lift car),
  `icn_cameramove`, `icn_cameraup`, `icn_cameradown`, `icn_steeringwheel` (test drive),
  `icn_easy_build` (assembly assistant), `icn_storage`, `icn_undo`, `icn_redo`, ...
- The energy bar: `module/icn_module_hardware` (modules), `module/icn_module_weapon` (weapons),
  `icn_energy` (the bolt: free energy), `module/icn_module_base` (cabin),
  `module/moduleicon_generator` (generators).
- Vehicle stats: `icn_health` (durability), `icn_object` (total parts), `icn_mass`, `icn_speed`,
  `icn_payload` (tonnage), `icn_acceleration`, `module/icn_module_decal` (stickers).
- Part classes: `module/moduleicon_*` (`cabin_light`, `machinegun`, `wheel`, `track`, `hover`, ...).
- Key caps: `control/character/icn_keyb_a` .. `z`, `control/control/icn_keyb_space_mid`,
  `icn_keyb_shift_mid`, `icn_keyb_control`, `control/mouse/icn_mouse_1` (left button) ... These are
  coloured (dark `#12171B` cap, light `#E6E6E6` letter, `#FFBF00` for the pressed mouse button).

Item stats (energy, durability, mass, tonnage, speed) are not in the readable archives either: the
item definitions (`gamedata/def/ex/car_editor_*.lua` in 2018-era dumps) sit in the encrypted packs.
`ui/stats.json` takes them from crosscalc.net's item table, matched by in-game name
(`ui/names.json`). A wheel and its steering version ("Array" / "Array ST") share one model.
`tools/stats/make_stats.py` rebuilds it from the table saved beside it (`cc_items.json`,
`cc_types.json`, read 2026-09-30; crosscalc's table is not published with the source: save it there
to rebuild) and refuses to write when an item's kind doesn't fit its model's
folder (a weapon's name on a wheel was how a wrong name showed up). The source lists no energy cost
for 21 weapons and modules (ammo racks, radars, scopes, the Hardcore, Hot red and Oyabun engines,
FHT-3 Flock) and no tonnage or speed for rotors; worth checking in game.

## Maps: `levels/maps/<name>/`

94 map folders (3.5 GB), all in the readable archives. 91 have a terrain; `long_time_ago` has props
and objects only; `mp_lobby` and `screenshot` are empty. `xotest maps` loads them all in 5 s.

**Terrain.** `landscape/landscape.mxml`: `<Dimensions SectorsX SectorsZ CellSize
SurfaceMapTexelsPerCell MinY MaxY>` (a sector is 16 cells; 16 to 256 sectors, cells of 0.5 to 4 m:
maps of 512 m to 1 x 4 km) and `<Surface Index PresetId>` (presets in `assets/surfaces.mxml`).
The terrain is centred on the origin. Its data are "TDNL" tile files:

```
u32 'TDNL', u32 0, u8 hash[8], u32 tilesX, u32 tilesZ, u32 1, u32 tileBytes
tilesX x tilesZ x { u64 offset, u64 size, u32 hash, u32 0 }   row-major; each tile one zstd frame
```

- `heightmap.dat`: `cells / 32 + 1` tiles per side of 32 x 32 `float` heights (the last row / column
  of tiles holds 1 x 32, 32 x 1 and 1 x 1). Sample (i, j) is at x = (i - cellsX / 2) x CellSize,
  z = (j - cellsZ / 2) x CellSize; heights span exactly MinY..MaxY. (Checked: a third of all trees and
  props stand within 0.3 m of it; with any other axis order or flip, 2 to 4 %.)
- `splatmap.dat`: `cells / 32` tiles per side of (32 x SurfaceMapTexelsPerCell)^2 `u16`: three 5-bit
  surface indices, low | mid << 5 | high << 10.
- `weightmap.dat`: the same tiles as BC5 (r, g). Weights: low = r, mid = (1 - r) g, high = (1 - r)(1 - g).
  A bake with this rule matches the game's own top-down colour of the ground (`grasslms/0000..0000`,
  see Grass); the other orders don't.

**Terrain in 2.41 (the remaster).** Four times finer: bridge is 128 x 128 sectors of 16 cells of
0.5 m (was 32 x 32 of 2 m), so 2049 x 2049 heights. `<Dimensions>` adds `CellSizeEnum`,
`SurfaceMapTexelsPerCell="1" SurfaceMapOverVertices="true"`; `<Renderer>` adds the virtual texture,
subdivision and mesh-blend settings; `<Hashes>` holds `<EcotopeToSurface><Element Ecotope Surface/>`.
- `heightmap.dat`: `cells / 32` tiles per side of 38 x 38 `u16` = 2 x 2 blocks of 19 x 19, one per
  sector: its 17 x 17 vertices and a one-sample border. Block sample (r, c), r and c from 1 to 17, is
  vertex (sector z x 16 + r - 1, sector x x 16 + c - 1), height = base + value / 65535 x range, with
  the sector's pair from
- `heightmap16_decode.dat`: `"61MH"` (HM16), u32 1, u32 sectorsX, u32 sectorsZ, u32 19, u32 count,
  u32 ?, then count x `{float base, float range}`, row-major by sector. Checked: heights span exactly
  MinY..MaxY, and the bend of the ground at the sector edges is as small as inside them (0.013 vs
  0.012 m; the other orders and offsets: 0.3 to 11 m). Bridge's ground was re-sculpted for 2.41 (it
  matches 2.40's at a correlation of 0.55, unflipped).
- `splatmap.dat` / `weightmap.dat`: one texel per vertex (32 x 32 per tile), indices as before but they
  are ECOTOPES, turned into surfaces by `<EcotopeToSurface>` (bridge: 12 -> 5 grass, 13 -> 1 swamp
  grass), 31 = none (2.40 wrote 0 with no weight). Weights count the other way: slot 0 = 1 - r,
  slot 1 = r (1 - g), slot 2 = r g (a texel of one surface keeps r = g = 0; three-surface texels have
  r + g up to 501, so it is not a plain split). With all three changes bridge's bake has no texel
  without a surface (was half the map); across the 82 maps with terrain, 3 keep under 1 %.
- New, not needed: `fallback_albedo.dat` (BC1, 16 x 16 per tile: the far colour), `overlaymap.tfd/.tfh`,
  `sectors_surface_usage.dat` (`14 DE BC 0A`). `collision.dat` is 17 times bigger.
- 85 map folders (was 94); 82 with a terrain (`long_time_ago`: props only; `mp_lobby`, `screenshot`:
  empty). Objects placed: 1,303,458 (was 807,864). Bridge's grass: 628,920 instances (was 131,450), all
  of the new ground cover (below).
- `collision.dat` (`12 DE BC 0A` + 1), `sectors.dat` (`12 DE BC 0A`): physics and streaming data, not needed.

`assets/surfaces.mxml` presets (226): `PhysMaterial` (Ground_Base, Snow_Base, Sand_Base ...),
`BlendRoughness` (0..32), `InvertBlend`, `LandscapeMeshBlendFactor`, `NoiseTiling` / `NoiseInMin` /
`NoiseInMax` / `NoiseOutMin` / `NoiseOutMax`, then `<TextureSets>`: `<Base>` and, on 79, `<Additional>`,
each with `Albedo` (BC1 sRGB), `Bump` (BC3 DXT5nm), `Spec` (BC1), `Tiling` (metres per repeat, 2 to 40),
`HeightMid`, `HeightAmplitude` (metres), `DisplacementLodClamp`, `UVFlip`, `UVRotation` (quarter turns).
- Bump: x in alpha, y in green, ambient occlusion in red. With u = game x / Tiling, v = game z / Tiling
  (row 0 at v = 0), +x points along +u (+game x) and +y towards row 0 (-game z). Verified twice: the
  maps' gloss-map heights (44 of 71 pairs agree, the rest flat or with inverted heights) and the game's
  light-probe capture of bridge (`specular_664236_2`), whose sun glint on the wet riverbed the view
  reproduces at the same place.
- Spec: red = the surface's height (the blend height; 0 throughout in `rock_top02_g`, `querry_main_g`,
  `white_sandy_g`, `asphalt_clear_g`), green = gloss (roughness = 1 - gloss, as on vehicles), blue =
  metal (`scrapmetal`, `plates02`, `oracle_plate1`, `pebbles01`).
- `UVRotation` / `UVFlip` turn a set: (u, v) mirrored (u = -u) first, then quarter turns (u, v) ->
  (-v, u); the relief is turned back the other way. Base sets never use them on maps; oracleplate's
  Additional set does.
- Additional sets are mixed with the base set by the landscape's `BlendNoiseTexture`
  (`textures/landscape/splat_map_noise`, BC5 256 px, red = cloudy low-frequency noise, mean 0.53)
  sampled every `NoiseTiling` metres: m = mix(OutMin, OutMax, clamp((noise - InMin) / (InMax - InMin))).
  Only hangar_newyear names the texture; it is the only one there is, so it is the default.
- `HeightAmplitude` > 0 (snowcrust 0.8, oracleplate 0.6, mud / pebbles / stones_background 0.5,
  icethick 0.4, scrapmetal 0.3, ...; 31 maps): the game displaces the ground by (height - `HeightMid`) x
  `HeightAmplitude`. The view gives them depth within 40 m (parallax, heights at 10 cm steps).
- Not in the readable archives: `mapskit/textures/snow/` (hangar_newyear's snowcrust, snowmelt,
  snowflat: 99.5 % of its ground). The view and the bakes lend them snow/snow1's textures (the same
  PhysMaterial, Snow_Base) and say so.

`landscape.mxml` `<Renderer>`: `TextureArraySliceSize` (the surface textures' size in the game's
texture arrays: 2048 on 65 maps, 1024 on 26), `LandscapeHeightBlendEnabled` (false on 21 newer maps;
absent = on), `BlendNoiseTexture`, `LandscapeMeshBlend*`, `LandscapeVT*`.

Height blending (the game's formula is encrypted; the view's): each surface's weight from the surface
map x 2^(K x `BlendRoughness` x (h - `HeightMid`)), h = the gloss map's red (the detail set's mixed in;
`HeightMid` where the map is one value; mid - h with `InvertBlend`), normalised; K = 1 (`Map.h`
`terrainHeightBlend`; 0, 0.5, 1 and 2 were compared with the loading pictures). Off where
`LandscapeHeightBlendEnabled="false"`. The baked ground (`xotest ground`, `/mapground`, the export)
uses the same weights. Far out the view hands over from the surfaces to the bake (which carries
occlusion, roughness and metal too) where a pixel covers 1.5-3 surface-map texels.

**Props.** `props.mxml`: `<instance Name="trees/midland/spruce/spruce_big" PosHex YPRHex ScaleHex
SkinName>` = `assets/props/<Name>.mdl` (all 399,881 placements on the 94 maps resolve). `...Hex` values
are IEEE float bits. Yaw, pitch, roll are degrees and compose as **R = Rz(roll) Rx(pitch) Ry(yaw)**
(column vectors, the game's left-handed space): yaw first. Scale is per axis, before rotating. Found
by trying all 48 axis orders and signs: trees standing above the terrain then sit on the rock under
them (76 % within 0.2 m; the usual Ry Rx Rz gives 40 %). Props carry no mode, festival or environment
lists (none of the 607,653 instances in `props.mxml` and `props_generated.mxml`; their other attributes
are `Guid`, `ClassID`, `GeneratorID`, `CollisionType`, `FadeGroup`, `DustEnabled`, `EcotopeId` and the
occluder switches): they stand in every mode and weather, and the lists exist only on scene entities.
- `props_generated.mxml` (207,772 generator placements on 72 maps, mostly trees, plus buildings,
  railroad and settlement pieces: castle 1,075 with 47 buildings and 62 railroad pieces, sand_valley 419
  with 123 `t_walls` and 63 barbed-wire coils, fieldbattle 2,306, cityruin 645), the same `<instance>`
  rows. The game reads it (Crossout.exe names it beside `props.mxml`) and the app shows it with the
  props (object ids: file 3, after props 0 and the scene files 1 and 2). It duplicates nothing loaded
  (within 0.5 m of a `props.mxml` or scene placement: 0 of cityruin's, 1 of castle's, 0 of
  sand_valley's, 4 of fieldbattle's). The biggest: brawl_spiderdiver 29,808 (19,529 yuccas, 6,543
  creosote bushes, snakeweed, burrobush, about 400 oracle canyon walls), red_rocks_territory 28,245,
  long_time_ago 14,372 (the space station's plates), helicopter_valley 10,080; they stand on the
  ground. Shown, they cost those maps 1-2 ms a frame and no loading time.

**Entities.** `scene.mxml` and `scene_generated.mxml`: `<Entity Name Def Model PosHex YPRHex ScaleHex
Skin ...>`, objects by game definition (`Breakable_Trees_Midland_SpruceSmall`). The definitions sit in
the encrypted packs (`Model="@"` = the definition's model), so models are found by name: the
definition's last word against the file names, ignoring separators, leading zeros and the `_de` /
`destructible_` of intact destructible versions (`_bp` files are their broken pieces). Definitions
that spell out their model's path are matched by their last word, or last two, against a model's name
with its folders before it (`Objects_Visitor_AssetsPropsConstructionsPipesPipe2L8m` =
`assets/props/constructions/pipes/pipe2_l_8m.mdl`, `Objects_HangarAziaMallBanner2` =
`assets/props/hangar/hangar_azia/mall_banner_2.mdl`, `Objects_Hangar_ModelsGameplayLootCargoLootCargoLoot3`
= `models/gameplay/loot/cargo_loot/cargo_loot_3.mdl`). A table in `src/xo/Map.cpp` (`knownEntity`) holds
the rest that were found (the bridge pieces, `CreosoteSmall` = `creosotebush_small`, fences, walls,
barrels, crates, city furniture, the projector lamp, the taxis), with the definition's own skin for
entities with `Skin="@"` (`Breakable_Vehicle_City_TaxiEastRed` = the breakable `taxi_east_full` with
skin `red`): fences and walls by how the maps lay them (same-turned neighbours stand a model's length
apart: `FenceMetal6m` 6.125 m against `street_mfence1_6m`'s 6.15 m, `MilitaryWall` 4.4-4.6 m against
`military_wall1/2/3_de`'s 4.5 m), the rest by placing a candidate at its definition's placements and
looking. With the definitions unreadable, the placements' names help: the map editor names a placed
entity after the model it came from (`city_rect_parking_1`, `city_rect_parking_1.1`, `.2` ...)
unless someone renamed it. So `Breakable_LifeItems_City_Parking` is
`life_items/cybereast/city_rect_parking_1`, a 2.2 m post (21 placements on 7 maps), not
`buildings/kiber/parking/parking`, the 144 x 47 x 141 m multi-storey garage its last word matched
(real garages are props; none of the captures of cityruin, hangar_china and hangar_asia shows one at
those placements). An audit of every definition-to-model match (629 pairs, 611 models, every mode and
festival, each model's box measured) turned up two more outliers besides the plausibly large ones
(bridges, the hangar gate, posters, trees, cranes): `Breakable_LifeItems_BricksWall2` had
`factory/brick_wall2`, a wall 45.4 m long and 6.4 m high, by a one-letter slip (37 placements on
castle, castle_artillery and experimental_map), and `Breakable_Garbage_Column` the 50.5 m monorail
pillar `monorails/column` (38 placements on 15 maps, tilted up to 90°). The captures show neither
(open field at castle's, nothing where the view had laid one across the_wall's 54 m from the probe),
so `knownEntity` leaves both out (an empty model: unplaced), like `BricksWall1` (laid back to back
with BricksWall2 among household debris) and `Garbage_ColumnPart1/2`, which match no model.
18,953 placements of 335 definitions stay unplaced over the 94 maps, every mode and festival counted,
as counted before those two were taken out (scrap and car-part heaps, psyco cars, wrecks, barrel
groups, box-tyre corners, light poles, container corners; `xotest maps`, default mode and no festival: 18,656); gameplay
helpers, spawn points and sounds (`Gameplay_`, `Helpers_`, `Sound_`) have nothing to show, `Lights_`
entities are lights (below) and their lamps (`Objects_Light_*`, 1,094 placements) are models.
- Filters: `GameplaysList` (modes), `FestivalsList` (`Halloween`, `NewYear`, ...; `Empty` = none),
  `EnvironmentsList` (ids of the map's `envsettings.mxml` items: time of day / weather, e.g. a frozen
  river only in the winter ones). Most lists sit on invisible helpers; of the visible objects, a
  festival's own decorations list only that festival (not `Empty`) and usually also only that
  festival's environment (the `envsettings.mxml` item whose `Festivals` names it, e.g. a snowy one
  for `NewYear`), so a festival has to switch the environment too or its decorations stay filtered
  out. Defaults: the map's main mode (Assault where it has one, else Domination, Conquer, ...), no
  festival, and the first environment used without a festival.
- `Helpers_WaterVolume` and `Helpers_AcidVolume`: water and acid (below).
- `Lights_`: the map's lights (below).
- `NewDecal`: projected decals (below).
- Sounds, by FMOD event name: `Sound_AmbientSoundSpot` (`soundname`: `event:/ambient/soundspot/wreck_fire_large`,
  `crickets_bridge`, `windmill_single`, `rain_metal` ...; `start_silent="1"` ones are set off by the
  game's scripts, `event:/explosion/bomb_explosion`), `Sound_SplineSound` (`cueName`: a river, a marsh,
  `Car_crusher`; `Positions` = x y z relative to the entity, turned by its `YPRHex`, `PointsCount`,
  `SplineType`), `Sound_SoundZone` (`tags`: `env_day`, `env_cloudy`, `env_winter_night`,
  `inside_default` ...; its `EnvironmentsList` says which environments it is for). 690 spots, 41
  splines and 287 zones over the 94 maps. The map's `soundscapes.xml` names a soundscape event per
  zone tag (`<soundscape cue-name="event:/ambient/soundscape/bridge_day" tag="env_day"/>`), so the
  environment picks the map's ambience: bridge's day plays `bridge_day`, its cloudy environment
  `bridge_cloudy`. The events' layering of samples is in the encrypted packs; the samples carry the
  names (`bridge_air_main`, `bridge_cloudy_main`, `firespot_big`, `leaves_crickets`, `marsh_loop`,
  `windmill_single_loop`: Sounds, above).

Also in a map folder: `envsettings.mxml` (the environments, below), `grass.dat`, `grasslms/` and
`colormaps.xml` (Grass, below), `hudmaps/` (minimap), `light_probes/` (below), `navmesh.rem`,
`occluders.xml`, `soundscapes.xml` (above); the loading-screen picture is
`ui/textures/levels/level_<map>`.

**Decals.** `NewDecal` entities: `decalPresetId`, `opacity`, `height`, `sharpness`,
`useCustomUniformAlbedo` + `customUniformAlbedo` (an sRGB colour of their own), `drawOnLandscape`,
`drawOnStatic`, `layer` (0 on 83,184; -1, 1, 2, 3, 5, 10 on a few hundred) and `sublayer` (0..~1,330:
the order decals are laid in, higher on top), `useCustomUniformGlow` + `customUniformGlow` ("R G B [A]",
or "Black" / "White"), `useCustomGlowEV100` + `customGlowEV100` (lava 7.5-22.6, the lamps' painted light
`light_quad` 6.8-11), and the usual `PosHex` / `YPRHex` / `ScaleHex` (and filter lists). The presets in
`assets/decals.mxml` (597): `AlbedoPath` / `NormalPath` / `SpecularPath` with `AlbedoRect` /
`NormalRect` / `SpecularRect` (u v width height: the decal's picture in a texture atlas; the specular
rectangle equals the albedo's / normal's on every preset), `UniformAlbedo` (the colour of decals without
an albedo), `DefaultSize`, `DefaultThickness`, `ZFadeFactor`, `AngleFadeFactor`, `UseFadeByNormal`,
`AlbedoOpacity`, `<DrawMask onStatic onDynamic onLandscape onGrass>`, `UniformGloss`,
`UniformMetalness`, `NormalOpacity`, `SpecularOpacity`, `UseGlow`, `UniformGlow`, `GlowLuminance`
(EV100), `UseGlowColorFromAlbedo`, `NormalBlend` (Overlay 361, Linear 226, Override 10).
- The decal is a box at the entity's place and turn, projected along its local Y: X across =
  `DefaultSize` x scale.x, Z = `DefaultSize` x scale.z x the rectangle's aspect (height x texture
  height / (width x texture width): square texels), Y = `DefaultThickness` x scale.y. It lies on the
  terrain (`drawOnLandscape`) and / or on the static objects inside the box (`drawOnStatic`; not on
  trees, glass or leaves), on the faces that look along the projection, except with the 10 presets
  whose `UseFadeByNormal` is false (`light_quad`, `volume_quad`, `volume_quad_z`, `volume_gradient`,
  `volume_asid`, `football_shadow`, `impact/soot1`, `leaking/rust1_a_nofade`, `halloween_flowers`,
  `lava/oracle_hit1_normal`), which paint every face in their box: newyear_foray's `light_quad` boxes
  stand on the roof ridges with Y across them, and the game's capture shows their glow on the slope
  facing away from Y, fading down from the ridge (painting only the faces along Y left a narrow band
  on the ridge caps). The preset's `DrawMask` is ANDed with both (`onStatic` false on 96 presets:
  21,755 placements with `drawOnStatic` 1 on 87 maps, such as arena_football's metal plates hanging
  6-13 m over the pitch, which painted its ramps and walls).
- The normal maps (BC3) carry the relief in RGB (+Y up, as glTF) and a **height mask in alpha**.
  Where it shows: coverage = clamp((mask - (1 - height)) / (1 - sharpness)) x the albedo's alpha x
  `opacity` x `AlbedoOpacity`: more height shows more of the mask, more sharpness gives harder
  edges. It fades out towards the box's ends (`ZFadeFactor`) and on faces turned away from the
  projection (`AngleFadeFactor`). Colour: the albedo times the decal's custom colour, or else the
  preset's `UniformAlbedo` (in the view and the export); without an albedo, that colour alone.
- Gloss: `UniformGloss` (puddles, wet coast and wet rust 0.85-1; roughness = 1 - gloss, so bentmetal's
  86 puddles are at 0.05) and `UniformMetalness`, or with a `SpecularPath` (BC3; red = gloss, green =
  metal, alpha 0) its texels (exports: their average over the rectangle). The relief shows by
  `NormalOpacity`. Not modelled: `NormalBlend` (a decal's relief replaces the surface's under it) and
  `SpecularOpacity` (the gloss blends by the albedo's opacity).
- Glow (`UseGlow`): `UniformGlow`, or the albedo's colour with `UseGlowColorFromAlbedo`, or the decal's
  custom glow, at a luminance of 2^EV / 8 game units (`GlowLuminance` or the custom EV) x
  2^`EmissiveLumScale`, like the map's lights, laid down like the albedo, by `opacity` x
  `AlbedoOpacity`. `light_quad` (`AlbedoOpacity` 0.169, black; the only glowing preset below 1) lies on
  newyear_foray's roofs, and the night capture shows its glow at 0.09-0.16 of its full luminance
  (6 views), about that factor; laid down by it, the capture's glow is 0.76 of the view's at night
  (median of the 6; a joint fit gives 0.68-0.71) and 1.03 at noon (4 views), so night and noon stand
  about 1.35 x apart against 2^`EmissiveLumScale` (not tuned). Lava, oracle hits, Halloween faces and
  the light strings on newyear_foray's roofs glow.
- Bridge: 274 decals (asphalt cracks, moss, ivy on the bridge, soil, rubbish); castle 376 (694,880
  triangles projected); 2.41's fuji 3,290.
- The view draws decals of one look (textures and settings) as one mesh unless a decal of another look
  laid between them in the map's order overlaps them (their boxes), so the order holds where decals
  meet: fuji's 3,290 are 543 meshes (1,117 looks by layer and sublayer), its overview 23.7 ms a frame and
  1,970 draw calls against 42-58 ms and 4,578 (a draw call costs about 9 us; the frame was bound by
  them, a quarter of the pixels drew as slowly). Their pieces on objects stay index ranges, left out
  while their object is hidden.

**Grass.** `grass.dat`, the game's grass placed in advance (91 maps). Version 15:

```
u16 15, u16 0xFFFF, u32 0, u32 2, u32 kinds, u32 tufts, u32 blocks, u32 0,
u32 gridX, u32 gridZ, f32 cellSize (32 m), u32 0, u32 0, u32 presetId[kinds]   (assets/grass.mxml)
then blocks x { u32 count, u32 cell (= row x gridX + column), u32 kind, u32 0, f32 minY, f32 maxY,
                u32 0, u32 0, count x tuft }
tuft (32 bytes): f32 x y z (game space), u16 (scale + 1) x 16384,
                 f16 rank, f16 qx qy qz (rotation; w = sqrt(1 - x² - y² - z²) >= 0), f16 scale / 2048,
                 8 zero bytes
```

The u16 at byte 12 is the scale: u16 / 16384 - 1. The half at byte 22 is that scale / 2048 on most
maps (the two agree within 0.0003 on bridge, castle_artillery, sand_valley and arena_football) but
garbage (about 200) on helicopter_asia_city and fuji, so the u16 is the one to read. Version 13
(bentmetal, arena_canyon_dronebattle, arena_plaza_dronebattle, craterarena_duel, experimental_map:
684,522 tufts):

```
u16 13, u16 0xFFFF, u32 0, u32 1 | 2, u32 kinds, u32 tufts, u32 blocks, u32 0,
u32 presetId[kinds] at byte 32; no grid; blocks as in version 15 (size: 32 + 4 kinds + 32 blocks + 32 tufts)
tuft (32 bytes): f32 x y z, u16 scale x 8192, f16 rank, f32 qx qy qz qw (a full unit quaternion)
```

Its cells are a square grid of G x G, G a power of two that is not stored, centred on the terrain
(cell = row x G + column): exactly one G puts every tuft in its own cell (32, 16, 8, 32 and 128 on
those five maps, i.e. cells of 32, 64, 64, 32 and 8 m).

Cell (0, 0) starts at x = z = -grid x cellSize / 2. Every tuft lies inside its cell; the rotation
tilts it onto the terrain (castle: 0.07° mean from the terrain's normal, a conjugated quaternion
would be 9.5° off); scales 0.625 to 0.925. `rank` = i / n within the cell: the game thins grass out
in the distance by it (drop the high ranks first). `assets/grass.mxml` presets: `model` (+ `.mdl`:
small crossed cards, 24 to 72 vertices), `dist_factor` (how far out it is drawn), `cloaking_range_max`
(the share of that reach over which it thins out: 0.5 on most, 0 on debris and snow, which stop at
once), `wind_intensity`, `luminance_modifier` (10 = as painted; the game brightens the shared atlas per
kind, up to 20.9, and darkens it below 10: the view and the export take albedo x modifier / 10 without
a clamp, as the ferns' 4.0 and the reeds' 3.1 are as dark in the game's captures), `align_to_normal`.
The grass is lit like the ground under it (its cards' own normals point up), both sides alike; solid
groundcover (pieces with a tangent stream: stones, bricks, concrete debris, snow chunks) is drawn as a
plain model, with no brightening, tint or two-sidedness. Bridge: 131,450 tufts of 4 kinds; castle
353,225 of 8. A preset's `only_in_water_volume`, `snap_on_water_surface`, `depth_underwater` and
`height_above_water` are the generator's placement rules, and `grass.dat` already obeys them: on
customgame_mountain_lake the ordinary kinds stand at most 5 cm under the lake (2 `basegrass01`, 3
`hardgrass` and 46 fern tufts), while the `*_maxdepth` cane, swamp grass and bulrush (0..100 m) cover the
lake bed (13,555 tufts in the lake, 11,415 of them 2 m or more deep). The game draws them: its capture
shows them through the shallows as dark-green patches (more of them and greener than the view, whose
reach, thinning and underwater tint differ).
- `grasslms/00000000000000000000000000000000` (BC3 sRGB, every terrain map but
  arena_line_of_defense_dronebattle) is the map's ground seen from above (props and decals in it),
  stretched over the whole terrain: 1 m per texel on 1024 m maps, 2 or 4 m on the 2048 / 4096 m maps,
  and 1024 x 1024 also on the 1024 x 4096 ones (row 0 = the +Z edge). Its alpha (0.4-1, about
  0.76-0.80 under grass on the three maps checked) is not grass density (correlation -0.03 to -0.47)
  and stays unused.
- `colormaps.xml` (17 maps): `<Colormap Guid Center HalfExtents YawDeg>` (hex floats, game space) =
  `grasslms/<guid, lower case, no dashes>`, a ground map of its own over the box: 2 x HalfExtents, row
  0 = the box's local +Z, world = Center + Ry(YawDeg) x local, only for points inside the box's height
  too. They hold the ground under bridges and overpasses where the big map sees the deck (bridge:
  135 x 30 m under the bridge, 128 x 32 px); boxes nest (building_yard3: four boxes inside a big one),
  the smallest one holding a point counts.
- The view and the export tint each tuft by (that ground colour / the mean under all the map's tufts)
  ^ 0.5, clamped 0.6..1.6 (`xo::grassTints`; the game's own rule is in the encrypted shaders, and its
  captures cannot tell an exponent of 0 from 0.5: at most 0.08 EV apart), on top of the atlas x
  `luminance_modifier` / 10.
- Grass gloss maps' red (a ramp, 0.25 at the tips to 0 at the roots) is used as light through the
  blades (x 1, towards the sun: pow(dot(view, -sun), 2)); the blades' specular is cut to 0.4 (their
  upward normals made the whole carpet one mirror of the sky's blue and the sun's glint).
- The environment's `WindForce` (0.3 on 211 of 223 presets) and `WindYaw` (degrees, 0 on all but one)
  drive the grass's and trees' sway, the grass x each kind's `wind_intensity` (the view sways trees by
  2 % of their height per unit of WindForce).

**Trees** (SpeedTree, shader `06bc377b`; their meshes under `.mdl`). A tree's billboard (Type 2) is the
far LOD of its own: the view draws it only past the model's last 3D LOD (drawn with the LOD that
holds it, it stood inside the tree, up close where that is LOD 0), one-LOD bushes switching at 0.07
(about 200 m at High detail), and map exports leave billboards out (one tree exported alone keeps
them). A billboard is
three (beardtongue: 36 vertices) or four (spruce_big, elderberry, boxelder: 54 vertices, 45° apart)
crossed vertical planes through the trunk, each twice with opposite winding and its own atlas cell (the
views from both sides), tapered towards the top (spruce_big: 7 m wide up to 8.6 m, 2 m at 18.3 m); the
four-plane ones add a level plane at mid height with the round top-view cell, wound to face down (culled
from above). The view fades each vertical plane by its turn about the trunk to the camera (smoothstep
0.25..0.6 of |cos|), the level one by the camera's height angle.
- Leaf masks (`_at`, BC4) are ramps that stop just above 0.5; below 0.5 they cover only the atlas's
  padding (flat khaki shards in the colours of the leaves next to it). The view cuts leaves at mask x
  min(1 + 0.08 x mip level, 1.3): at the mask's own 0.5 edge up close, about 0.4 for crowns from 50 m
  out, which the game's crowns need (rendered at the density of bridge's capture, the crowns cover 0.63
  of the game's crowns' area cut at x 1, 1.00 at x 1.12, 1.28 at x 1.25); the shadow pass cuts the same
  way. One texture can only take one factor, so exports write the mask x 1.125 into the albedo's alpha.
- Billboard masks (`*_billboard_at`, BC4) are distance fields: 0.5 on the tree's outline, rising inside
  to 0.53-1 (an airy crown such as `pine_small` peaks at 0.70, a dense spruce at 1) and falling over
  about 20 texels outside. They are cut at 0.5 in the view and the export; over all 90, the 0.5 level
  keeps the outline's cover down the mip chain (the cut that would keep it: 0.50 to level 4, 0.49 at 5,
  0.48 at 6; at 0.5, 96 % of the outline is kept at level 4 and 85 % at 5). Cut at 0.4 a billboard
  swells into a smooth blob (spruce_big's: 35 % covered at 0.5, 51 % at 0.4).
- The leaf atlases' albedo alpha is 0 on twigs and branches and up to about 0.5 on leaves (broad leaves
  0.3-0.4, elderberry 0.4-0.6, creosote 0.2, spruce needles about 0.06 with 0.18 on the young shoots).
  The view takes it as how much sun a leaf lets through: alpha² x 6 (at most 1), spread by Unreal's
  two-sided foliage lobe (GGX of roughness 0.36 on the view against the sun: 1 towards the sun, about
  0.13 from every other side), thinned by exp(-0.15 x the metres the light travels through the crown,
  its box taken as an ellipsoid) and shaded only by what stands beyond the crown, not its own leaves.
  The leaf normal maps (`*_atlas_n`, BC3) are the DXT5nm layout with occlusion in red. The view shades
  the crown inside (sky light x 0.55 at the trunk's foot, rising with the distance from the trunk and
  the height). These are fitted to the game's captures (bridge, periphery, castle, lost_coast,
  newyear_foray, arena_football, sand_valley); the shaders are encrypted.
- Leaves mirror the sun and the lamps without the Fresnel rise at grazing angles (F90 = F0 for the
  direct lights; the sky's reflection keeps it): with it, the glint frosted chemical_plant's pines white
  against the sun (a near crown's core +1.25 EV over the capture, +0.21 without), where the game's stay
  dark green; the views not into the sun move by 0.04 EV at most. A plain cut of the leaves' sheen did
  worse (mean error 0.42 to 0.51-0.64 EV over 13 views).
- Cost: what is the same for every light (the crown's sun share with its shadow-cascade lookup, the
  F90 swap) is worked out once per pixel, before or around the lights. Inside three's per-light
  function Direct3D inlined it into every light of the unrolled loop (16 point, 8 spot and the sun),
  and on maps with many lamps the leaves' program grew until the driver dropped the WebGL context
  (newyear_foray at night, hangar_china, building_yard3, holes, periphery; hangar_newyear and
  red_rocks_territory once the F90 swap sat in the lights too): a near spruce's leaves (a
  115,405-character fragment shader) took 97 s to link, 80 s with 12 + 6 lights, 1-2 s without the
  lookup in the loop. hangar_newyear now loads in 80 s (was 187), red_rocks_territory in 76 (was 169).

**Environments: sun, sky, light, fog.** The map's `envsettings.mxml` items (`Id`, `Name`, `Gameplays`,
`Festivals`, `RotHex`) are presets of `assets/envsettings.mxml`, flat `<Setting value="..."/>`
lists: `SunColor` (`0xAARRGGBB`, sRGB), `SunDirVert` (90 = on the horizon, 180 = overhead),
`SunDirHor` (degrees, plus the item's `RotHex` yaw), `UseAtmosphereSunColor`, the fog's `Fog*` keys,
`ExposureCompensation`, `SkyDomeModelPath` (cloud cards about 84 km out, with coverage `_at` (BC4),
normal `_n` (BC5) and light-scattering `_sss` (BC5) maps; a stars dome at night), `AtmosphereId`,
`ColorRemapPath` (the colour LUT), `TonemapToe`, `LightShaft*`, `SunShadowsEnabled`, `WindForce` /
`WindYaw` (Grass) and the weather's cover, `Dust*` (all below). `sky_cloudy_2`, `sky_cloudy_2_stars`
and `sky_cloudy_3` have a low cloud layer (`clouds_thin_4`) whose vertices run from about 1 % to 100 %
of the dome's radius, so directions bend across it if interpolated per vertex and must be taken per
pixel; `sky_cloudy_2_stars`' star dome is a `644D00C3` glow material (`starstiled_e`).
The sun lies along glTF (-sin az cos el, sin el, cos az cos el) with el = SunDirVert - 90, az =
SunDirHor (checked against the shadows in the loading pictures of bridge and cityruin).

An item's `Name` is the preset's: a region folder and the look, `_midland/day_clear_al120_az330`
(`al`/`az`: the sun's height and direction; `fix_`: a fixed copy; `_speсial` is spelt with a Cyrillic
`с`); `Festivals` is `;`-separated (`Empty` = every day; none = any), and a map can list an item twice
(island: `886789`). 108 presets over the 91 maps that have items (`xotest envscan`).

How bright a preset is: `AtmosphereSunIllum` (three numbers) is the sun through its atmosphere in the
game's unit of light, which is the atmosphere's radiance (its tables with its own `solar_irradiance`)
times about (775, 555, 537) per channel, the same for every atmosphere (45 presets over 5 atmospheres:
within about 10 %, more for a low sun, so the table lookups rather than the unit). `UseAtmosphereSunIllum` picks it, else `SunIlluminance`
is the sun (clear days 400-1300, an overcast 2-5 (`fix_cloudy_dark` 15), a moonlit night 50-100,
Halloween 3.5).
`FogLuminanceEv100` is the air's (the fog's) luminance as EV100 (game units = 2^EV / 8; clear day 8.7,
overcast 5, night -0.5 to 4); `MinEV100` / `MaxEV100` hold the camera's auto exposure (clear day 7-9,
overcast 2-4.7, Halloween 1.7-4.3), `ExposureCompensation` shifts it, `WhiteTemperature` (K) and
`WhiteTint` set its white balance, `EmissiveLumScale` scales glowing things by 2^it (EV: -3 at night,
-2 on newyear_foray's night, 0 at noon, +1 on chemical_plant's noon; the map's lights, flares, beams
and glowing decals follow it, Lights). Night presets use atmospheres whose `solar_irradiance` is 0.0001
(`AtmosphereSunIllum` about 0.03): a black sky, the moon being `SunIlluminance`.

**Environments in 2.41 (the remaster).** The maps' `envsettings.mxml` items name new presets (bridge:
447082 day, 216895 xmass, 181044 halloween, 932516 fog, 829134 cloudy), but those presets are stubs (no
atmosphere, no fog, `SunIlluminance` 1000). Each environment's look is entities of the map's
`scene.mxml`, Unreal-style, for the environments their `EnvironmentsList` names (none: all of the
map's); 1,932 of them, all in `scene.mxml`:
- `EnvironmentBackdrop`: the sky, a picture (`textureName`: `textures/background/<n>`, BC6H, 4096 x
  1024: the sky above the horizon, top row straight up, elevation linear in the rows), x
  `luminanceScale` (512: lux), turned so that its column `textureUvShift` (0.5) lies towards the sun's
  azimuth, its columns turning as a panorama's; `ground*` below the horizon. `motion*`: the game moves
  it slowly. `motionDirAngle` (0 on 137, 53.424 on 60, -90 on 28 ...: no relation to the weather's
  `windYaw`, so the picture's own), `motionZenithSpeed` (1-10, degrees a second overhead),
  `motionHorizonCorrection` (0.95), `motionRangeAngles` (-30 30 on 275, -60 60 on 28), `motionBlendTime`
  (8 s). Grimcold draws it as a cloud deck overhead carried that way (the angle turned with the picture's
  columns), each pass running over the range at that speed and fading into the next over the blend
  time, the horizon held but for 1 - the correction of the zenith's speed; on frames drawn anyway (it
  asks for no redraws), starting undrifted (ui/sky.js drift). The shader is encrypted: the way the
  angle is turned and the deck's shape are this reading's, not checked. The probes' sky alone
  (`FogLightingProbe`) is this picture: bridge's
  day, fog, cloudy and xmass correlate 0.92, 0.86, 0.74, 0.62 with it at that turn, 514, 506, 510 and
  465 / 2048 of it (`luminanceScale` 512: light-probe units = lux / 2048). 304 of the 331 environments
  have one.
- `SkyAtmosphere`: UE5's sky atmosphere numbers (`planetRadius` 6360 km, `atmosphereHeight` 60,
  `rayleighScatteringCoefficient` 45 104 255 (linear x 255, UE's default) x `rayleighScatteringScale`
  0.1, `rayleighHeight` 5 km, Mie, ozone `absorptionCoefficient` 88 255 12 x 0.001881, `planetGroundAlbedo`
  (sRGB bytes, as UE's GroundAlbedo), `altitudeOverSeaLevel` 100 m: UE's defaults but for a denser, lower
  air). 19 environments have no picture: 17 of them have one of these (14 days, 3 hangar nights), and
  Grimcold works their sky out from it as Unreal does (Hillaire 2020: Rayleigh and Mie in exponential
  layers, ozone in a tent 25 +- 15 km up, multiple scattering as the psi_ms table, the ground's albedo in
  it), lit by the sun above the air (`outerSpaceIlluminance` at its `colorTemperature`, not
  `groundLevelIlluminanceScale` or its tint: the nights' captures are 13 x brighter than their 0.075
  gives), drawn as a picture is (`BackdropPath` `@air:<map>:<envId>`, 1024 x 256: `src/xo/Sky.cpp`
  renderAirSky). Against the probes' captures above 12 degrees it has their shape to 0.02-0.07 EV (2.40's
  default atmosphere, drawn before, held to them row by row: 0.06-0.33, 1.2 EV off round sand_valley's
  sun) and its colour a constant off (the days 0.1-0.5 EV too blue, the nights within 0.2), so it is held
  to the capture by colour, each channel's median over the sky the capture sees: 0.01-0.03 EV left
  (sand_valley's rock pillars and sand_crater's clouds stand in theirs; nothing in sand_crater's files
  gives those clouds). The other two (long_time_ago's night, the screenshot map's 670839) have neither,
  and their captures are black: no sky (`@none`).
- `SkyDirectionalLight`: the sun. Towards it (game space): +Z turned about Y by the `YPRHex` yaw, then
  about X by its pitch, then about Z by its roll (checked on bridge against the sun in its captures: day
  18.4 degrees up towards -Z, xmass 13.2 degrees up towards +X with roll 13.32, fog 60 degrees).
  `outerSpaceIlluminance` (lux: 135,000 by day, 0 on overcasts and moonless nights), and with
  `ignoreAtmosphere` (252 of 330 lights) the light on the ground is that x `groundLevelIlluminanceScale`
  in `groundLevelIlluminanceColorTint` (sRGB), else what the air lets through. `colorTemperature`,
  `disk*`, `lightshafts*`, `fakeShadows*` (a cloud-shadow mask moving with the wind).
- `ExponentialHeightFog`: two layers `layer0*` / `layer1*` (`heightOffset` above the entity, `heightFalloff`,
  `baseDensity`: 1 on every map), `drawDistanceStart` (no fog nearer), its colour the sky's (the probe's
  sky alone) x `probeInscatteringIntesityScale` x `participatingMediaAlbedo`, the sun's glow in it x
  `directionalLightScatteringIntensityScale` (phase g 0.99). Fitted on 40 environments' probes (their
  capture against their sky alone from 12 degrees up, where the fog takes under 0.6 of the sky's colour:
  the fitted share came back as `probeInscatteringIntesityScale`): each layer 0.0035 x `baseDensity` per
  metre (base 2) at its height, falling off at `heightFalloff` per metre (base 2) above it and no
  thicker below it (the environments within x 1.5 of that; without that cap x 1.75, the storms whose
  fog lies 400 m deep x 10 off); a negative falloff thickens upward, so the sky is fog to no end (every
  Halloween: the capture 0.3 x the sky alone at every height). The fog entities are volumes too (406:
  356 infinite, 50 boxes), stacked as the post-processing ones below, their flags naming settings in
  another case (`layer0BaseDensity` = `layer0baseDensity`) or otherwise (`layerNBaseHeight` = the layer's
  height, its volume's own y + `heightOffset`; `environmentInscatteringScale` =
  `probeInscatteringIntesityScale`; `directionalLightScatteringScale` =
  `directionalLightScatteringIntensityScale`). The boxes are local (22 hangar environments' only listed
  fog was their hall's), and `volumeWeight` 0 is off: every storm (386174, 28 maps) has a second volume,
  layer 1, weight 0, its layer 0 at 400 m; taken (17 of them took it first) the storms' probes put the
  density constant at 0.0022 (log2 spread 1.06), left out at 0.0033 (0.60) against the others' 0.0035.
  Each layer also has `nearFadeStart` / `nearFadeLength` / `nearFadeScale` (layer 1: 0 / 500 / 0.1 on
  most) and `nearCutoff` / `farCutoff` (0 / 5000); read as the density fading towards the camera they
  fit the probes worse (the constant's log2 spread over about 60 environments 0.91 -> 1.20, within x 1.5 of
  its median 70 % -> 44 %; bridge's fog, desolate_city's and drcross' cloudy no longer fit), so they are
  left out. Layer 1 lies low (10-30 m, falloff 0.1-0.5): the probes, 30-430 m up, cannot see it.
- `PostProcessing` and `Dust` are volumes (`volumeShape`, `volumeLayer`, `volumeWeight`): the map's own
  (`infinite`, layer -10, every setting) under the environment's (layer 0), each taking the settings its
  `override_*` flags name (some flags name a setting otherwise: `exposureCompensation` = `exposureEC`,
  `exposureManualEV100` = `exposureEV100`, `exposureEmissiveAndLocalLightsLuminanceCompensation` =
  `exposureEmissiveAndLocalLightsEC`, `temperatureValue` = `temperature`, `colorLut` =
  `colorLutFilename`); `box` ones (82) are local. Exposure: `exposureMode` auto between
  `exposureMinEV100` and `exposureMaxEV100` (an environment's often equal: bridge's day 12.75, its
  Halloween 7.5), `exposureEC`; `exposureEmissiveAndLocalLightsEC` (8.25 by day, 2 at night) lifts glowing
  things and lamps against the sun; `temperature` / `temperatureTint`, `tonemapType` (ACESFilm),
  `tonemapToe`, `colorLutFilename` (`textures/posteffects/colorgrading`, 256 x 16 RGBA8 as the presets'
  LUTs), UE-style bloom, vignette, lens flare. `Dust`: `dustAlbedo`, `dustTransparency` (the cover's
  strength: 1 for snow), `dustGloss`, `dustBlendMode` (`byNormalsToUpVector`: on faces turned up, the
  presets' `DustByNormals`; `byHeightLinearGradient`: a film low down, all over below
  `dustBlendModeGradientMinMax`'s min and thinning to none at its max, world heights; 9 maps' base
  volumes, 25 everyday weathers: bridge's and helicopter_cathedral's 10 .. 20 dark and glossy, tower's and
  experimental_map's -2 .. 2 by their water, castle_artillery's 30 .. 35 light dust), `dustMask*`, `dustProps` / `Trees` /
  `Grass` / `Landscape` / `Cars`; `dustBlendModeThreshold` is the up-ness of a face above which it lies
  (the presets' `DustHeight` is 1 - that: xmass' 0.25 -> 0.75; with 0 the cover took nothing),
  `dustBlendModeSharpness` the presets' `DustSharpness`. The film's way was read off bridge's day probe:
  the capture against the view without the film, texel by texel by the height of the ground each texel
  sees, is 0.45 EV darker below 10 m than above 20 m, ramping between (its New Year, no film: no step).
  Its strength: with its rule as the other cover's (threshold 0, sharpness 1: all over) the view came
  out 1.3-1.7 EV darker than the game there; as strong as the surface under it is glossy
  (`dustBlendModeAffectsBySourceSurfaceGloss`, true on all 9; the ground's gloss, a prop's 1 - roughness)
  within 0.17 EV in every band (the rule soft instead: 0.25). Tower's ground below 2 m is 0.8-1.4 EV
  darker in its capture than in the view either way (mostly at and under its water: not fitted).
  Grass is not filmed.
- `WeatherConditions`: `windYaw`, `windForce`, `areaEffect` (the weather's particles around the camera:
  bridge's leaves, xmass' `snow_yaw_0`), `areaScreenEffect`.

Without a sun (`outerSpaceIlluminance` 0: 2.41's overcasts and moonless nights) there is no sun's light
(`SunIlluminance` 0) and no shadow of it (`SunShadowsEnabled` false; all 330 lights have `castShadows`
true); the lamps keep their light, at the exposure / 16 per game unit (2.40's `sun / eSun`, which a
sunless weather has none of).

Units: 2.41's light is in lux and nits, 2.40's game units are lux / 128 (7 EV): 2.40's sun above the
air, `LIGHT_K` x the atmospheres' `solar_irradiance` (luminance 1051.5), is 2.41's 135,000 lux / 128
(1054.7) to 0.3 %, bridge's day exposure 12.75 - 7 = 5.75 against 2.40's tuned 6.0, its sun 475 game units
against the clear days' 400-1300. Grimcold writes the entities into the preset's own settings (game
units; EV100 - 7, `EmissiveLumScale` = the emissive EC - 6) and adds `Backdrop*` and `HeightFog*` for what
the presets had no setting for (`xotest envinfo <map>` lists them; `src/xo/Map.cpp` applySceneEnvironment).

**Light probes.** `levels/maps/<map>/light_probes/<envId>.xml`, one per environment item:
`FogLightingProbe` `Inscattering` (2.40: the sky alone with the sun's disc, black below the horizon;
2.41: the map as well, its land and props where they stand in the sky),
`SkyProbe` / `GiLightingProbe`, and one or two `LightProbe` {`ProbeID`, `Center`, `Rotation` (yaw first,
degrees), `HalfExtendsMin` / `Max`, `EnvColor`, `Diffuse`, `Specular`} (hex floats, game space; "x.dds" =
the `.tfh` / `.tfd` pair x in the map's folder). The global probe is the map's `envsettings.mxml`
`<EnvSettings GlobalLightProbeID>` (else the first); the second one, on 12 maps (the hangars, factory,
building_yard3, helicopter_downtown: 63 environment files), is a local box (full weight inside its inner
half extents, none outside its outer ones; arena_line_of_defense and orbital_station have placeholder
1 1 1 / 2 2 2 ones). 104 older xmls name `reflection_` / `irradiance_` / `fog_inscattering_` captures
that the game has baked again beside them as `specular_` / `diffuse_` / `fog_inscattering_probe_` (the
newer are the ones to read); helicopter_cathedral 700045 and helicopter_guilin 163392 name files that
are gone, whose newer bake has another number (`_0`). So read, all 326 environments have their probe
(`xotest probescan`).
- `specular_*`: 256 px, 9 mips, an HDR capture of the map from `Center` (mip 0 sharp, the smaller mips
  prefiltered for roughness), with no sun disc but its glint on water; `diffuse_*`: 32 px, the Lambert
  irradiance / pi of it; `EnvColor` = that irradiance / pi averaged over the upper hemisphere. Units:
  game light units / 16 (measured 14-21; at 16 the clear days meter inside their EV range). The
  brightest texel of bridge's capture (the sun's glint on the river) lies at the preset's sun azimuth
  (equirect u 0.747 against 0.761): the orientation is right.
- `fog_inscattering(_probe)_*` is the sky without fog, not the fog's colour (castle 333035's cube has an
  orange horizon, its fogged capture a grey-blue one like `FogColor`). Under clouds its sky is up to a
  stop brighter or darker than the capture's (specular / fog at 20-70° up: 0.85-1.0 clear, 0.5-0.8 at
  sunset and on arena_football's overcast, 1.2-2.2 on `fix_dull`). It holds the sun's disc (the
  `specular_` captures never do), but its brightest texels are clamped (R = G = 65024, see Textures),
  so only low suns give the disc's true energy: 0.047 of the preset's sun (E / 16 in probe units) at
  sand_valley's sunset (702818), 0.094 on castle's morning (333035), 0.21 on fuji's sunset (248744);
  bridge 664236 and arizona_silo 362592 read 0.099-0.108 as far as the clamp lets them. The sky dome's
  cloud cards cover it where they stand (red_rocks 530955: 0.034 behind a thin cloud, 0.035 under the
  view's cards). The night presets have no moon disc (their cube maxima are 0.1-2.1, against 10k-52k
  for a day's disc). Stars: night_moon (697976) has them (1.04 % of the light above 35°),
  new_year_dark (442850) none, newyear_foray's night (958203) almost none (336 star-like texels, 0.03 %
  of the light), Halloween 3 texels.
- The view (`/mapprobe`: "XOLP", JSON {id, center, halfMin, halfMax, rotation, envColor, mean, local,
  sizes}, then three RGBA-half panoramas: the capture 1024 x 512 with its glints clamped at 64 x the
  median, its irradiance 64 x 32 and the sky alone 128 x 64; `&probe=1` the local probe) lights the map
  with the capture (reflections, box-projected inside a local probe's box, fading to the global one at
  its edge) and its irradiance (the diffuse light, as spherical harmonics). Its sky dome and clouds are
  held, direction by direction, to the capture's sky (where the capture shows land, to the fog cube
  through the preset's fog; within 3° of the sun, the capture as it is): within 0.2 stop above 5° on 10
  environments. The direction is each pixel's own: interpolated from the vertices of the cloudy domes'
  low layer (above), it was tens of degrees off, so the hold, the fog and the sun's glow on the clouds
  were looked up in the wrong place (arena_football 480746's sky +0.42..+1.43 EV over the hold's target,
  and a false cyan band low over newyear_foray's mountains). Per pixel the drawn sky is within
  -0.02..+0.01 EV of the target, and where both show sky the error went from 0.690 to 0.294 EV on
  arena_football, 0.445 to 0.341 at Halloween, 0.197 to 0.161 on New Year bright and 0.104 to 0.050 on
  bridge's clear day (the sky-alone panorama's 128 x 64, 2.8° a texel, misses some of the captures'
  cloud detail). Its sun's disc holds 0.12 of the preset's sun times the fog's transmittance (the game
  fogs the sky, disc included, to infinity; its loading pictures of building_yard3 and
  helicopter_guilin show the disc) and fades out where the air's own sun (lum `AtmosphereSunIllum`)
  drops from 5 to 0.5, and stars show only below that.
  `xotest probe <map> <envId> <out.png|.hdr> [width] [--diffuse|--fog] [--level n] [--local]` writes any
  probe as a panorama.

**Light levels and the camera** (`ui/sky.js` `presetLevels`, `Sky.cpp`; the game's camera code is not
readable). The sun's luminance E = lum(`AtmosphereSunIllum`) with `UseAtmosphereSunIllum`, else
`SunIlluminance` (game units); its colour `SunColor` (sRGB to linear, as it is) or, with
`UseAtmosphereSunColor`, the `AtmosphereSunIllum` vector. Auto exposure: EV100 = clamp(log2(L x 16 x 8),
`MinEV100`, `MaxEV100`) with L the capture's mean luminance (probe units); the light before the tone curve
= probe units x 16 / (1.2 x 2^(EV100 - `ExposureCompensation`)) (Lagarde's). Over all 326 environments
(`xotest probescan`): 172 meter inside their range (bridge 664236: 7.29 in 7..9, an exposure of x 0.2102), 125 below it
(every dull, rain, dense-fog and night preset, 1-3 EV under: bridge 523108 0.99 against 3.2, Halloween
-0.8 against 1.7; held at `MinEV100`, they stay dark), 29 above (snow).
- The sun against the probes: fitting each capture as a x the view's sunlight + b x everything else,
  over blocks of terrain at the probe centre on 22 environments, bare sand, rock and snow give a =
  0.72-0.86 (median 0.82 over 13) with b about 1: the captures' sunlit ground has 0.82 x E / 16 of
  direct light while their sky keeps game units / 16. The share is the same for `AtmosphereSunIllum`
  and `SunIlluminance` presets, for `SunColor` and the air's colour, and for the moon (bridge 0.76 by
  day, 0.77 at Halloween); grassy ground shows less (castle 0.64, tower 0.66, cityruin 0.71: the game's
  grass shades it), and the shade matches within 0.2 EV, so it is the sun's strength, not the probe
  unit. The view's key light (and the export's sun) is E / 16 x the exposure x 0.82 (`ui/sky.js`
  `SUN_K`, `Sky.h` `kSunK`): sunlit land against the captures went from +0.32 to +0.10 EV on bridge
  664236, +0.23 to 0.00 on red_rocks, +0.58 to +0.32 under bridge's Halloween moon. Dull and overcast
  presets do cast the sun's shadows in their captures (bridge 523108, arena_football 480746: both fit
  better with the view's cast shadows than without). Fitted per channel, a for blue comes out a little
  under a for red and green (0.93-0.98 of red by day, 0.81 on bridge), too weak a sign to follow.
- `levels/fake_cloud_shadows.xml` defines a moving cloud-shadow texture (`levels/cloudshadow`, 1024² BC4
  over 2048 m, mask remap 0.15..0.75, wind 5 m/s). The probe captures show no trace of it (the sun's
  share per block against the texture, at every offset and orientation, peaks at a Pearson correlation
  of 0.2, z 2.9), and the view leaves it out.
- White balance: Unreal's `WhiteBalance()`: the white at `WhiteTemperature` (the Planckian locus below
  4000 K, the daylight locus above, with the 1.4388 / 1.438 correction), moved by `WhiteTint` x 0.05
  across normalise(u, v) in CIE 1960 (Unreal's code form; a positive tint takes green out, as the
  loading pictures show: chroma error 0.440 against 0.523 the other way), Bradford-adapted to D65 on
  linear sRGB. 6500 K is no change; 5790 K x (0.93, 1.01, 1.14); 3000 K turns everything blue
  (`new_year_dark`).
- Tone curve: not in readable data. Matched to the loading pictures (bridge, sand_valley, cityruin,
  chemical_plant): ACES (Hill's RRT + ODT fit with its sRGB / AP1 matrices) on the exposed light / 0.6
  needs no exposure offset on average and has the smallest error (0.192, against 0.213 for Khronos
  Neutral; Uncharted 2 with `TonemapToe` as its toe lifts the ground far too much); `TonemapToe` (0-0.2)
  as x² / (x + toe x 0.1) before it (assumed); then the colour LUT (`ColorRemapPath`, see Textures) on
  the sRGB-encoded colour, trilinear. `xotest probe` / `sky` `.png` files are graded the same way.

**Fog.** The fog keys are UE4's ExponentialHeightFog. The density at `FogHeight` is `FogDensity` x
`FogExpMul` per metre, in base-2 optical depth; it halves every 1 / `FogExpMul` metres up and thickens
below `FogHeight`, which is an altitude (on 70 of 327 map items it lies below the ground). Transmittance
along a ray from the camera = 2^-(UE4's line integral), with no fog nearer than `FogNear` metres. The
fog's colour is `FogColor` (sRGB, normalised to luminance 1) at a luminance of 2^`FogLuminanceEv100` / 8
game units, x 0.68 measured: away from the sun a fully fogged horizon is that colour within 4 %.
`FogColor`'s alpha (0x12 to 0xFF) has no visible role. `FogSunPower` / `FogSunNear` add a glow of
sunlight, x pow(cos, 0.55 x `FogSunPower`), from `FogSunNear` metres out. The game fogs the sky too, to
infinity: T = 2^-(ρ_camera / (`FogExpMul` sin elevation)), so the horizon is pure fog colour (tau x
sin(el) = 0.071 / 0.072 / 0.076 at 6.5 / 10 / 16° on arizona_silo 362592), and where nothing stands
below the horizon the captures show the fog's colour.

Measured first on 27 map environments: each map's fogged capture (`specular_<env>_2`) against the same
sky without fog (`fog_inscattering(_probe)_<env>`), with the app's distance cube at the probe centre to
tell sky from geometry. A joint fit gave density x 1.02, falloff x 0.91, colour 0.68 and a glow of
0.0665 x the sun's light with exponent x 0.55, median log errors of 2-7 % (in probe units; the skies
alone gave density 0.87-0.93 x and colour 0.5-1.1 x). Measured again on the land, at known distances:
the view rendered at 12 environments' probe centres without fog, with every pixel's distance, binned
into the capture's texels (about 300 bands of distance x height, away from the sun), the land's own
error taken from 15-100 m, where there is no fog (bridge 664236 clear and 523108 overcast,
chemical_plant 400138 dust, hangar 394058 day, tower 577994 rain, arizona_silo 362592 sandstorm,
arena_canyon 789185 smog, sand_valley 702818 sunset, cityruin 618949, red_rocks 530955, castle 333035
morning, newyear_foray 958203 night). The game's fog on the land is thinner and starts further out,
and the view (`ui/fog.js` `presetFog`) follows that:
- Density 0.6 x `FogDensity` x `FogExpMul` (`FOG_DENSITY_K`; the fits give x 0.61 on 11 environments,
  x 0.60 on 12), on the sky too: with each sky's own brightness taken from 40° up, 0.6 matches it as
  well as 1.0 or better (0.155 against 0.202 stop). The falloff stays 1 / `FogExpMul` (fitted free,
  x 0.89 and no better), and a cap on the thickening below `FogHeight` comes out non-binding.
- No fog nearer than `FogNear` + 120 m (`FOG_START_ADD`; fitted +109 to +122 m, better than `FogNear`
  alone on 10 of the 12): the game's land is nearly fog-free out to 100-250 m where `FogNear` is 0-25 m
  (the rainy tower's ground 100-400 m below the camera has a fog depth of about 5e-4 x (d - 250 m),
  where the old rule gave it 0.1-0.3; the overcast bridge's banks alike).
- The sun's glow is 0.033 x the sun's light (`FOG_GLOW_K`, the exponent kept): towards the sun (0-45°
  from it) the air's haze brightens the land too (over 49 bands, 12 environments: 0.198 at half the
  earlier glow, 0.230 at the full one, 0.259 with none).
- `FogAerialGain` is the air's own haze: Bruneton's in-scattering from the preset's atmosphere tables,
  as if everything stood `FogAerialGain` x 0.5 times further away (`AIR_K`). Its extinction is
  (Rayleigh + Mie / 0.9) x gain x 0.5 per metre, its light the air's sky 1° above the horizon at 16
  azimuths (`airHorizon`, a port of the sky shader's lookup; on the captures' rays within 5-17 % of the
  tables' own GetSkyRadianceToPoint, and it fits as well: 0.215 at x 0.35 against 0.215 for the exact
  form at x 0.5). The height fog lies in front of it: colour x Ta x T + air x (1 - Ta) x T + fog x
  (1 - T) + glow (with the air in front, the sandstorm's far mesas turned lilac where the game keeps
  them yellow: chroma error 0.066 against 0.047). It is what turns far hills blue on clear days and
  tints the sandstorm's tall mesas lilac. The gain is 0 on most overcast and rain presets (bridge's
  dull overcast, tower's rain), whose captures show no air haze; one gain for every preset fits 3 x
  worse (0.63-0.71 against 0.215).
- The air's light follows the preset's sun: x min(1, E / lum(`AtmosphereSunIllum`)), the preset's sun
  against its atmosphere's own (`ui/sky.js` `lightFromSun` `air.sunK`). On 21 of the 108 presets the
  gain is above 0 while the preset's own sun (`SunIlluminance`, `UseAtmosphereSunIllum` false) is under
  half of the atmosphere's: field/cloudy on 7 maps, `fix_cloudy_dark` on arena_football,
  building_yard3, chemical_plant and sand_crater (gain 20, a sun of 15 against the air's 610: x 0.025),
  the cyber `fix_cloudy_dark` on 3 maps, hangars/asia_cloudy_dark, hangars/dull_norain, zombie_escape,
  halloween2021_balloons. The game's captures show no air haze on them; with the clear air's light, the
  horizon laid a bright lilac veil over arena_football's stands and far pitch (+1.25..+1.88 EV over its
  capture; with the factor, +0.21..+0.30). The factor is 1 on the clear days the fog was fitted on,
  0.29 on hangar's day and 0.67 on chemical_plant's dust.

Over the land of the 12 environments (the fog's part only, from 100 m out) the error went from 0.425
stop (chroma error 0.077) to 0.294 / 0.086 with density and start alone (clear days worse: bridge
0.36, cityruin 0.38) and 0.241 / 0.052 with the air. Fitted alone, each environment still scatters
around these numbers (density x 0.4-1.8, a start of 30-290 m, colour x 0.6-1.3; arena_canyon's smog
x 3.3), and nothing in its keys says why (`FogDensity`, `FogExpMul`, the camera against `FogHeight`,
`FogNear`, the colour's alpha, `FogLuminanceEv100` against the exposure, the gain). Known differences:
newyear_foray's night fog (958203) beyond 300 m is about 1.3 x brighter than this colour (0.08 against
0.062 in view units) and hides the far hills, which still show in the view (a brighter colour
everywhere would break the others: tower wants x 0.63, hangar x 0.64); the rainy tower loses its far
mountains in a bright horizon band (0.58-0.72 against the colour's 0.49) and thins its fog faster with
height than `FogExpMul` says, arena_canyon's smog far slower (fitted alone: falloff x 0.23).

**Light shafts, lens dirt, sun shadows.** `EnableLightShaft` (true on 236 of 327 map items),
`LightShaftTint` (ARGB as a decimal uint32, e.g. 4294939489 = 0xFFFF9361), `LightShaftUseSunColor`,
`LightShaftSunLuminanceScale` (stops) and `LightShaftExponent` (the falloff of the sky's brightness
around the sun). Their strength is not in the data: the view uses 0.005 x the sun's luminance (9 % of the
fog's brightness on bridge's clear day; at 0.03 x the key light, in the game's units, they washed what
stands against the sun pink, which no loading picture shows). `textures/lens_dirt`: 960 x 600 BC3, a
bokeh dirt mask; the view multiplies its bloom by it (bloom of what is brighter than 2 in its brightest
channel: the sun's disc, glints, lamps and fires, not sunlit ground, which reaches about 1.1).
`SunShadowsEnabled` = false: arena_football_china 706447, fuji 855469, helicopter_downtown 902103.

The light the terrain's own hills leave it is baked on the host (the view's terrain takes the sun as the
lesser of its cascaded shadows and the bake, and its sky light and reflections times the sky share):
`/mapterrainlight` (`?<map query>&sun=x,y,z[&step=n]`, towards the sun in glTF space): "XOTL", u32 JSON
length, JSON {w, h, step}, padding to 4, then w x h RG8 on `/mapterrain`'s grid (row 0 = the game's z0
edge).
- R: how much of the sun's disc the terrain's hills leave in sight, from a march towards it, soft over
  the sun's radius + 1°.
- G: the cosine-weighted share of the sky above the hills' horizon, from 8 directions out to 300 m,
  smoothed over 5 x 5 samples.
- Bake: `xo::bakeTerrainLight`, 0.2 s median and 2.2 s at most for 1025 x 1025.

**Weather cover (`Dust*`).** On the land when `DustEnabled` and `DustEnabledOnLand` are both true
(bridge's capture with `fix_dull_norain`, `DustEnabled` false / OnLand true, shows a dry ground):
coverage = clamp((mask - (1 - `DustLandHeight`)) / (1 - `DustLandSharpness`)) x `DustTransparency`, the
decals' height rule, with mask = the red of `DustMaskPath` every `DustMaskScale` metres when
`DustMaskEnabled`, else 1; with `DustByNormals` it fades out on slopes steeper than about 50°. Colour
`DustColor` (sRGB, 0xRRGGBB or 0xAARRGGBB; read as linear it fits the captures 0.2 EV worse), gloss
`DustGloss`, no metal. Checked against bridge's captures: `new_year_bright` (0.53 / 0.85) and
`new_year_dark` (0.56 / 0.83) cover all of the ground in snow; tower's `fix_dull_rain` (0.45 / 0.44,
0.9) turns it dark and wet. `DustLandscapeMaterial` names a PhysMaterial (Snow_Base, Water_Thin,
Mud_Tower, Sand_Base, Ice_Base: two of them have no surface preset), i.e. what the covered ground is to
the physics. On props (`DustEnabled`): cover = clamp((up' - (1 - `DustHeight`)) / (1 - `DustSharpness`))
x `DustTransparency`, up' = the world normal's y (`DustByNormals`; else 1) + (the surface's height - 0.5)
x 0.25, times `DustMaskPath`'s red at world x / z / `DustMaskScale` when `DustMaskEnabled`; albedo ->
`DustColor`, roughness -> 1 - `DustGloss`, metalness -> `DustMetalness`, the normal map half flattened.
Snow (`new_year_*`: E1E1EF, height 0.59, sharpness 0.8), rain (373B41, gloss 0.95, height 0.45,
sharpness 0.06), sand and ash dust by their mask. Unused: `DustMin` / `DustMax` (1000 / 1000 on snow,
1 / 20 in rain, 0 / 10 on dust: not an altitude band), `DustGlossDriven`, the `*Car*` variants
(vehicles).

On the vegetation, the game's captures show what lies past the cover's rule (mask - 1 + height) /
(1 - sharpness) = 1, the cover just complete (the land's rule for grass, the props' for leaves, before
`DustTransparency`). New Year snow is 3.5 on the land and 2.95 on props; under it the grass is gone
(bridge, castle, hangar_newyear) and bushes are white all over, but bridge's ivy stays green. geopp's
masked snow hides its scrub only where it lies. The sandstorm (1.0, half see-through) turns
sand_valley's scrub into sand-coloured lumps. Halloween's film (0.84), `fix_dull_rain` (0.80) and
`new_year_dark2` (0.55) leave tufts and leaves as they are; drcross' rain capture shows dark tufts on a
shining wet ground. The view (fitted to these 7 weathers' captures; the game's shaders would settle it):
- Grass reads the land's rule at each tuft's root (with `DustByNormals`' slope factor), takes
  `DustColor` (not its gloss) by smoothstep(0.9, 1.1, rule) and sinks into the cover, its height x
  (1 - smoothstep(1.1, 2, rule)), gone at 2. The coat ignores `DustTransparency`: at the sandstorm's
  quarter coat (0.5 x 0.5) its scrub stayed dark, at 0.5 it matches the capture's lumps. New Year
  bridge's ground band went from -0.46 / +0.23 / -0.25 EV to -0.03 / +0.30 / -0.01, castle's from
  -0.39 / -0.35 / -0.28 to +0.05 / +0.10 / +0.04 (white-coated tufts instead left a grey speckled carpet
  the captures do not have). The gloomiest rains (rule 1.07) darken the tufts with their film's colour
  (0.84 of it); helicopter_valley's dark rain capture shows dark tufts but cannot measure how dark.
  Solid groundcover is not buried (no capture showed it).
- Leaves of living trees (SpeedTree pin `User1` = 1; 0 on ivy, ferns and dead trees, a meaning
  inferred from bridge's capture, where the ivy stays green) and their billboards take the props'
  cover all over, whichever way they face: by smoothstep(1.1, 2, rule) x `DustTransparency`, the rule
  being (mask - 1 + `DustHeight`) / (1 - `DustSharpness`) without the face's normal. Bridge's snowy
  willow went from -0.82 to -0.02 EV against the capture (applied to every leaf, it turned the pillar
  ivy white).
- Exports carry no weather cover at all (land, props and grass are exported dry).

The atmospheres (`levels/atmospheres/<name>/`) are Eric Bruneton's precomputed atmospheric
scattering (2017): `atmosphere.xml` (`<Atmosphere Guid>`, `<Uniforms bottom_radius top_radius
mie_phase_function_g mu_s_min sun_angular_radius solar_irradiance rayleigh_scattering mie_scattering
...>`, lengths in metres) and its tables as textures: `transmittance` 256 x 64 RGBA32F (code 136),
`scattering` 256 x 128 x 32 RGBA16F (code 128: 8 view-sun angles x 32 sun heights across, 128 view
heights (ground half, sky half), 32 altitudes deep; the single Mie scattering's red in alpha),
`irradiance` 64 x 16 RGBA32F (inside its `.tfh`, at byte 24). Row 0 of each is the bottom.
`atmosphere_dense` and `bright_moon` keep `scattering` as RGBA32F (16 MB) instead.

**Water and acid.** `Helpers_WaterVolume` (157 entities, 56 maps) and `Helpers_AcidVolume` (21, 8 maps:
craterarena_duel 3, customgame_craterarena 4, customgame_fiery_river 1, drcross 2, factory 3,
helicopter_cathedral 2, periphery 1, the_wall 5) are the same liquid surface with the same settings. The
look comes from `waterType` (0 water, 1 acid, 2 rusty), not the definition: 14 of the 20 AcidVolumes in
their maps' default environments are type 0 (blue-grey lakes and pools); the 6 of type 1 are drcross's
AcidVolume.5, the fiery river and the craterarena maps' upper lakes. `xotest mapinfo` lists them (136
volumes on 60 maps in their default environments).
- Placement: `Points` = x y z -1 -1 per point in the entity's space, turned by `YPRHex` like props
  (R = Rz(roll) Rx(pitch) Ry(yaw)); world point = PosHex + R p, the outline is its (x, z). Unturned,
  vulkan's 19 km² sea lay 3.4 km off the map and the pools of drcross, sinto, bentmetal and others hung
  over dry ground (over the 66 turned volumes, the share of the ground inside the outlines that lies under
  the water goes from 26.5 % to 42.2 %; many basins sit on props). The surface is level at PosHex.y,
  tilted entities included (their turned y = 0 plane meets the ground 4-55 m further from the outline on
  arizona_silo and zombie_escape_3). The points' y only follow the ground.
- Settings on every volume: `user_param0_hex` = uv0Tiling, uv1Tiling, uv0Speed, uv1Speed;
  `user_param1_hex` = bump0Height, bump1Height, density, noiseTiling; `depth_hex` (1 on most, 100 on
  island's sea; meaning unknown, used as the depth where there is no terrain); `bump0/1Direction_hex` =
  scroll angle in degrees (about a third hold junk, denormals, NaN, 9.4e12: read as 0 unless finite and
  0.001 < |v| <= 360); `user2` (holes_halloween; unknown); `user3` = 1 on the 5 calm volumes; `color`
  (sRGB) = the light the water scatters; `density` per metre (fog = 1 - exp(-density x metres seen
  through): bridge's river, median depth 0.25 m at density 3, is half see-through, island's sea opaque
  orange over 14 m at 0.25); `waterGlossF0` / `waterGlossF90` 0.9 / 0.65 (0.9 / 0.9 on the 12 layered
  volumes, whose `waterFogColor` / `waterFogDensity` equal the colour and density);
  `waterReflectanceF0` / `F90` 1 / 0.75 (1 / 1 on the layered ones; unused: read as a loss of the
  reflection towards grazing angles it fits worse, mountain lake 0.202 against 0.162 EV).
- Wave frames: `BumpAnimationFramesDirectory` + `/%02d` = 01..64, 256² BC3 DXT5nm (x in alpha, y in
  green): `textures/water/medium_waves` (wind), `textures/water/rain_ripples` (the rain twins, picked by
  `EnvironmentsList`), or the flat `textures/nm` on the calm ones (their detail map the nearly flat
  `waterflow_nm`). Slopes (rms x / y): medium_waves 0.090 / 0.080, water_nm 0.162 / 0.121, rain_ripples
  0.057 / 0.058, waterflow_nm 0.016 / 0.022. The app's `/frames?dir=<folder>` answers "XOFR", u32 width,
  height, count, then RG8 (normal x, y) per texel, frame after frame; 404 when the folder has no frame 01.
- Crossout 2.41: all 137 volumes are the layered shader's (`water_material_version` 3), with none of the
  settings above: `baseWave*` / `flowWave*` (the 12 layered volumes' `bigwave*` / `medwave*`), their
  `*SamplerPath`s on `textures/water/layered/` (`water_default_w`: BC7, 256 px, 64 layers, the normal's x
  in alpha and y in green as the legacy frames', red and blue other data, about 2.5 x as steep: rms 25
  against 10 of 255; `_v` its displacement), `waterScatterColor` / `waterScatterDensity`,
  `waterAbsorbtionColor` (spelt so) / `waterAbsorbtionDensity`, foam, caustics, coastline waves. Grimcold
  draws them as the legacy volumes: the frames are `BaseWaveWaterSamplerPath`'s layers (`/frames` takes a
  layered texture's), tiled at `baseWaveTiling` per metre, as strong as `baseWaveNormalStrength` (bridge
  0.214 x 2.5 against 2.40's 0.6), the colour and density the scatter's. Each layer's flipbook runs at
  15 fps x its `AnimSpeed` / 0.1333 (the layered default the 12 volumes with both shaders kept while the
  view ran their legacy flipbook at 15: base 0.133 -> 15 fps, flow 0.356 -> 40). The flow waves are a
  second layer of frames (`FlowWaveWaterSamplerPath`: `water_default_w` on 133 volumes, `water_rainy_w`
  on 4) tiled at `flowWaveTiling` per metre, 0.3 x `flowWaveNormalStrength` strong (the legacy second
  layer's: the 12 hold `medwaveNormalStrength` equal to its bump), carried by the weather's wind
  (`WindForce` x 1.33 m/s along `WindYaw`: bridge's 0.3 carries them 0.4 m/s, its 2.40 river's second
  layer) x `windSpeedMultiplier` where `flowWaveAffectedByWind` (129 volumes). A layer with
  `baseWaveEnabled` / `flowWaveEnabled` false (15 calm volumes) is flat; the base waves do not drift.
- Currents (2.41): a map's `settings.mxml` names its flow map, `<Water FlowMapTexture=...>` (5 maps:
  `textures/water/layered/flowmaps/<map>/flowmap_w`, 512² BC3; customgame_mountain_lake's holds no
  current, island's volumes do not use theirs). The current's x is in alpha and its z in green (127.5 =
  none; red 0, blue some other mask), laid over the terrain's square with its rows running -z:
  fieldbattle's, desolate_city's and shipyard_battle's lie on their rivers (93 / 95 / 81 % of the water
  has a current; IoU 0.77 / 0.40 / 0.45, the 7 other ways of laying it 0.03-0.35), and read so the
  vectors run along the banks (|cos| to the bank normal 0.25-0.30; the other readings 0.60-0.93). Where
  `flowWaveFlowEnabled` (49 volumes, those 3 maps' rivers the ones with a current) the flow waves run
  along it at `flowWaveFlowSpeed` x `flowMapStrength` of their tiles a second where the current is full
  (fieldbattle and shipyard_battle 15 x 0.1, desolate_city 3 x 0.5: 1.5 each), drawn as flow maps are:
  two phases of a second each, cross-faded. Which way the water runs cannot be told from the files
  (fieldbattle's river either comes in from the north edge and splits at the bend, or two branches meet
  there and run north; its bed is deepest at the bend): the view takes the vector as where the water goes.
  The 2.40 volumes had an empty `FlowMapSamplerPath`.
- How the view draws it (`ui/water.js`; fitted, the shader is encrypted): UV = game (x, z) / 8 m x tiling
  + direction x speed x t; slope = Σ detail x bump x 0.3 + flipbook x bump0 x 0.6, x (0.5 + noise(xz /
  48 m x noiseTiling)); the flipbook at 15 fps (2.41: each layer at its own rate), cross-faded; roughness 0.1 -> 0.35 with (1 - n·v)^5 (1 -
  the volumes' gloss F0 / F90); F0 0.02; the sky's mirror image weighted by Schlick's term of the wave
  normal alone, F = 0.02 + 0.98 (1 - n·v)^5, and the diffuse by 1 - F (three's split-sum weight also
  takes off what a rough surface loses at grazing angles: at 5° and roughness 0.35 it gave 0.36 of the
  sky where Schlick gives 0.63; the captures need Schlick for water seen 6-20° down, mean error over
  the water 0.169 -> 0.149 EV on fieldbattle 858779, 0.180 -> 0.162 on bridge 664236, 0.331 -> 0.220 on
  the mountain lake, 0.236 -> 0.178 on island 967041; views steeper than 25° moved by 0.04 at most);
  the light the water scatters = 0.74 x a Lambert surface of its colour (on customgame_fiery_river's
  HDR capture, water radiance / its colour = 0.74 x terrain radiance
  / its baked albedo); the murk over the view ray's path through the water (depth / sine of the view's
  elevation) from a depth map baked from the terrain; acid at density x 3, an opaque glossy sheet of its
  colour; the waterline faded over 0.08 m (0.2 m hid the glint and the sky on bridge's shallows). Fitted
  against the captures of bridge (664236), customgame_mountain_lake (585423) and customgame_fiery_river
  (603566, probe 0): the sun's glint at the probes' resolution, the lake's colour, the acid's brightness
  beside the terrain.
- Acid is not `acid_a` x its colour: the fiery river's capture shows a terracotta sheet (its colour,
  144 86 57) with a sharp sun glint, no yellow, and `acid_g` would leave it matte. `acid_a` / `acid_g` and
  `textures/water/layered/dirt/*` are not used by these volumes (island's rusty sea has no dirt in its
  loading picture). The 12 layered volumes (cemetery_highway 3, lost_coast 1, zombie_escape_3 3,
  chemical_plant 5) are drawn the same way, by their colour and density; their own textures
  (`water_default_w` with 64 layers, `water_foam` with 4, caustics, flow maps) are left out.

**Lights.** `Lights_` entities in `scene.mxml` (94 maps: 5,392 point lights, 1,127 projectors, 1,477
flares, 1,340 beams, 16 directional), filtered by mode, festival and environment like the other
entities. They shine along their local +Z (game space, the placement's YPR as for objects).
- Point lights: `Lights_PointLight` and its kin with the same attributes (`Lights_HugeLight`,
  `Lights_FlameGoal`, `Lights_Flame_trophy`, `Lights_SkyLaser`, `Lights_LaserShow`, the flickering
  `Lights_BentMetal_LightFlicker1/2/3`, `Lights_PointLightFlicker`, `Lights_PointLightFlickeringOdd`):
  `rad` (metres), `power`, `color` (sRGB R G B), `linearFalloff`, `specularEnabled` (0 on 79 %),
  `shadowsEnabled`, `castDynamicShadows`, `enableSSCS`, `volumetricScatteringScale`, `lightPresetId`,
  `isTurnedOn` (0 on 7), `overrideFlickering`. `Lights_Lightning*` are the storms' flashes (power
  150-550, set off by the game).
- What stands in a lamp's way: `shadowsEnabled` (a shadow map), `enableSSCS` (the engine's
  screen-space contact shadows) and `castDynamicShadows`. Over every map's scene files 5,057 of the
  5,404 point lights (94 %: 4,847 with contact shadows alone, 188 with a shadow map) and 914 of the 1,128
  projectors (81 %: 558 with a shadow map) have one or the other; 347 point lights and 214 projectors
  have neither and light through walls in the game too. `specularEnabled` is 0 on 4,249 point lights
  (79 %) and 212 projectors. The view gives every lamp with either a shadow (`ui/lampshadows.js`: a
  cube of distances per picked lamp, drawn once, in one shared atlas) and leaves gloss alone where
  `specularEnabled` is 0. Without them tower's four 1500-power lamps (`rad` 40) inside two high-rises lit
  a dozen floors' windows through the floors; the game's capture shows two or three red dots near the
  lamps. With them the lamps' own floors stay dark from outside, as checked against rays from the lamps
  (98 % of points agree); what is left lit is the broken top floors the lamps see directly, which the
  capture does not show either (the game's contact shadows, being screen-space, can also hide light whose
  way to the lamp runs behind nearer things on screen).
- `Lights_Projector`: `fovX`, `fovY` (degrees, a rectangular frustum, turned by the placement's roll),
  `nearClipPlane` (up to 28.7 m on newyear_foray's street lamps), `farClipPlane`, `power`,
  `angleAffectsBrightness`, `linearFalloff`, the rest as point lights.
- `Lights_Flare`: `size` (metres, read as a diameter: the hangar capture's halo, about 4° round a
  2.43 m flare at 31 m, may mean a radius, which the capture's resolution cannot settle), `nebulosity`
  (0 or 0.47 on every map), `vis_angle` (degrees around +Z it shows in), `color`,
  `luminanceEv100`, `start_disabled`. It sits at the lamp's glass (bridge: 0.73 m ahead of its
  projector along +Z, whose lamp model `projector_de` stands 0.3 m behind the light).
- `Lights_Beam`: `size` (length along +Z), `width` (across at its end), `luminanceEv100`, `color`,
  `flicker` / `flicker_fps` (empty on all), `has_halo1/2` (0 on all) and the halos' size, nebulosity, vis
  angle, colour, EV.
- `Lights_DirectionalLight` (hangar_newyear, 16): `illuminance`, a `directional_multi_proj` mask, in a
  box (ScaleHex): light through windows (not drawn).
- `assets/lights.mxml` (18 presets, by `lightPresetId`): `MaskXY` / `MaskZ` textures, `Type` (Point,
  Projector, Directional) and defaults. `textures/lights/pointlight_pow2_xy` is 1 - (x² + y²) over the
  square [-1, 1]² (BC4 256²), `pointlight_pow2_z` 1 - z² over [-1, 1], `projector_pow2_z` 1 - z² from the
  near plane (0) to the far plane (1); projector cookies (`indus1_lamp`, `multi_proj`, `white_circle`,
  ...) shape the frustum (the view draws a round, softly fading cone).
- How strong: the light at distance d is `power` / d² x the mask with `linearFalloff` 0, `power` x the
  mask with `linearFalloff` 1, in the unit of the sun's illuminance, times 2^`EmissiveLumScale` (the same
  porch lamp in newyear_foray's captures is 15.19 at noon, `EmissiveLumScale` 0, and 3.625 at night, -2:
  x 4 once the noon ambient is taken off); flares and beams have a luminance (2^EV / 8) with the same
  2^`EmissiveLumScale`. Fitted to 17 views of newyear_foray (night and noon), bentmetal and chemical_plant:
  view intensity = power x 160 x the view's sun factor per unit of sunlight x 2^`EmissiveLumScale`;
  flares and beams x 1. A light's colour is its `color` linearised (in the capture, sRGB 255 125 45 lights
  as (1, 0.15, 0)).
- Shapes: the game's flare sprite `textures/flare` (uncompressed 8-bit, the round top 64 px) is (1 -
  r)^2.15 x (1 + 1.5 r) (rms 1.3 %), `nebulosity` blending it towards (1 - r²)²; its beam sprite
  `textures/beam`, a quad along the lamp facing the camera, has a round full-bright head about a fifth of
  its width, then along it 1 for the first fifth and exp(-3.2 (t - 0.2)) after, across 1 - x² / R² with R
  = 1.41 (0.06 + 0.32 t^0.8) (rms 2.7 %).
- On or off: the game switches lamps with the environments; a light lists the weathers it is on in
  (`EnvironmentsList`, e.g. bridge's projectors, flares and beams only for 442850, 523108, 704569); lamps
  without a list are on in every weather. Lamp models (`Objects_Light_Projector1`, `Objects_Light_Lantern`,
  `Objects_Light_WallLamp`, `Objects_Light_LampLine01`, `Objects_Light_FlareMini`; 1,094 placements) come
  in pairs per weather: `Skin="yellow"` (lit glass) in the dark ones, `Skin="default"` by day.
  `Objects_Light_Projector1` is `assets/props/settlement/lunatics/projector_de/projector_de.mdl` (not
  projector01, an 11 m stand).

`xotest map <name> <out.glb>` exports a map (`node tools\glb_preview.mjs --game-light` renders such a
file headless with its own sun and sky):
- the terrain in 128 x 128-quad chunks (at most 1024 quads per side) with three baked images: its
  colour from the surfaces, height-blended like the view (4096 px; `xotest ground` writes it alone), a
  tangent-space normal map of the surfaces' relief over the height grid's normals (`terrain_ground_n.png`,
  +Y = the game's +Z) and `terrain_ground_orm.png` (occlusion, roughness, metal: glTF's
  `occlusionTexture` + `metallicRoughnessTexture`); OBJ gets the normal map as `map_Bump`;
- props and entities as nodes in groups (terrain, water, props, trees, objects) sharing one mesh per
  model, the map materials baked or described (`.mdf`, map materials), leaves with their mask x 1.125
  in the albedo's alpha, no tree billboards;
- water: `KHR_materials_transmission` 1 + `KHR_materials_ior` 1.333 + `KHR_materials_volume`
  (thickness = the mean depth inside the outline over the terrain, attenuationDistance = 1 / density,
  attenuationColor = the colour's hue at full brightness), base colour white, normal texture = wave
  frame 01 (else the detail map) at UV = xz / 8 m x uv0Tiling with scale bump x 0.6 (0.3 for a detail
  map), roughness 0.1; acid opaque, its colour x 0.74; the vertices turned with their outlines. OBJ: Kd =
  the colour x 0.74, `Ni 1.333`, `d 0.7` (OBJ has no transmission);
- the decals as meshes on what they lie on (their preset's `DrawMask` applied; their look baked into one
  texture per kind: colour, and in alpha where they show; their relief as a normal map; roughness 1 -
  gloss and their metal, from their gloss map's average over its rectangle where they have one; the fade
  at their corners in the vertex colours' alpha);
- the grass as copies of each kind's model (`EXT_mesh_gpu_instancing`, `--grass <share>`): blades with
  each triangle a second time reversed and single-sided (glTF flips a double-sided back face's normal, so
  half the blades went dark in Blender), each copy tinted by `_COLOR_0` (float VEC3; three.js's GLTFLoader
  reads it as the copy's colour, Blender ignores it);
- the sun as a `KHR_lights_punctual` light (the view's key light, 0.82 of the preset's sun: `kSunK`)
  and the sky as an equirectangular Radiance `.hdr` beside the file, both the game's light x the
  view's exposure: the sky is the environment's light-probe capture
  (sky, clouds, haze, far land; no sun disc), or the sky worked out from its atmosphere and clouds with
  `--computed-sky` (or without a probe), mapped the way Blender's Environment Texture and three.js read
  it; `asset.extras` names the environment and the exposure (EV100, and the factors on the game's light
  and on light-probe units) beside a `haze` line with the view's fog (`Sky.cpp` `renderSky`): "UE4
  exponential height fog: <density> per m (base 2) at <FogHeight> m altitude, halving every
  <1 / FogExpMul> m up, none nearer than <FogNear + 120> m; colour FogColor x 0.68 x 2^FogLuminanceEv100
  / 8; the air's own haze (Bruneton's in-scattering) over <FogAerialGain x 0.5> x the distance", the
  density being `FogDensity` x `FogExpMul` x 0.6 (tower 577994: 0.000216 per m at 224 m, halving every
  83 m, from 145 m; the air's factor for a preset's weaker sun is not in it);
- not: the map's lights and the decals' glow.

Bridge with a quarter of its grass: 5,906 objects, 274 decals, 33,552 grass copies, 393 MB with textures
capped at 1024 px, 18 s (measured before the objects found since, the terrain's normal and ORM images,
which add about 7 s and 37 MB on arena_football, and the layer bakes; chemical_plant now: 735 MB,
58-75 s).

## Verification

- `build\xotest.exe md5 <prefix>`: extraction matches the index MD5 for every file (6,043 files / 4.2 GB checked; 0 mismatches).
- `build\xotest.exe scan`: all 12,754 models parse and decode (0 errors, 5.9 s).
- `build\xotest.exe texscan`: 17,655 textures, 0 errors (cube maps and arrays read layer by layer);
  `xotest rangecheck`: 13,688 textures, 1,101,978 level / layer reads of only the `.tfd` chunks they
  need against a whole read, 0 bad.
- DDS round trip: a texture saved as DDS by the app and imported back decodes pixel-identical
  (BC1, BC3, BC4, BC5, BC7 sRGB; `tools\e2e.mjs`). BC1-BC5 and RGBA8 are written with the classic
  header, which every DDS reader opens but which can't say "sRGB" (the DX10 header can, but many
  readers, Pillow 12 included, can't open BC1/BC3 written that way); BC7 needs the DX10 header and
  keeps its sRGB flag.
- Checked once against Pillow's own DDS decoder (`xotest texsample`'s files): BC1-BC5 within 1 level, BC7 and RGBA8 bit-exact.
- `node tests\validate_gltf.mjs`: exported files pass structural glTF 2.0 checks.
