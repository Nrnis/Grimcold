# Grimcold manual

A "Tank Exporter" for Crossout. It reads the game's archives directly, lets you look at every
vehicle part in 3D with its real textures, recolour or retexture it, put parts together into a
whole vehicle, fly through the game's maps, and export parts, vehicles or whole maps for Blender
and friends.

It never writes into the game folder. Everything it makes goes into files you choose.

It reads Crossout 2.41 (the remaster of October 2026: its new pack index, its four times finer terrain
with ecotopes, its new ground cover and trees, its weathers set in each map: an HDR picture of the sky
that drifts or a sky worked out from the air, a height fog, a film low down; its water's own wave rates
and its rivers' currents) as well as 2.40 and a copy kept of it. What changed, and how it is read, is in
CROSSOUT_FORMATS.md.

It looks like the game: its interface is drawn with Crossout's own UI art, read from the game's
archives when it starts (like the parts; nothing of the game is copied into the tool). The modes
are the main hangar's tabs; buttons are the game's (the classic one with orange ears at its sides,
the flat one, the orange slanted Test drive and Add to garage ones); the panels' choices are the
2026 interface's arrow tabs; dialogs have the game's orange window header; sliders take the game's
diamond. Fields, check boxes, lists and the scroll bar follow the game's 2026 colours, and the type
stands in for the game's (TT Fellows) with Segoe UI Variable. Toolbar buttons show the game's own
icons (on a narrow window only the icon, the name in its tip). Without the game (the folder dialog)
the same shapes are drawn without its art. (`ui/skin.js` cuts the sprites out of the game's
atlases and keeps them per game version for the next start; `ui/skin.css` is the look.) The
second-level tabs (Parts / All files) are the hangar's quiet bookmarks, the panels' headers its
window header, list rows light up like its menu, a part's cards and tiles wear its rarity colour,
and the HUD's plates (speed, position, minimap) share its dark glass with an orange corner. The window has no Windows title bar: the top bar is it (drag it, double-click it to
maximize, its own minimize / maximize / close buttons). Tooltips, drop-down lists and questions
(Reset all, New build...) are drawn in the game's style too, and the mouse pointer is the game's.

## Using it

Run `Grimcold.exe`. It finds Crossout on its own (Crossout Launcher or Steam). Otherwise
click the folder pill at the top and pick the folder that contains Crossout's `data` folder. The
tag beside it shows which Crossout version is loaded (`Crossout 2.40.10.361437`, read from the
game's `Crossout.exe`; hover it for the full version and folder).

- **Parts** (left): a menu like the game's garage down the whole left side, with its own icons:
  All, Base (cabins and frames), Weapons, Hardware (modules), Movement parts (wheels, tracks,
  augers, legs, hovers, air cushions, rotors), Structure, Decor, then Gameplay, Other and the 10,000
  map props. A category's arrow opens its kinds, as the game splits them: light, medium and heavy
  cabins and frames; machine guns, shotguns, cannons, rocket launchers...; engines, coolers,
  generators, radars...; the structure kits by faction; decor by what it is (horns, lights,
  exhausts, flags, figures...); the map props by kit. Clicking a kind shows it alone (again: the
  whole category). The picked row is lit orange, as in the game.
- **The parts as the game's cards** (beside the menu): each part a card with its picture and its
  in-game name in its rarity's colour (white common, blue rare, teal special, purple epic, orange
  legendary, red relic; grey the plain parts), the card tinted and topped with it, framed in it
  under the mouse and while it is open. The pictures are made as the cards come into view and kept
  for the next time, the way the game pictures its parts: in a little studio of their own (not the
  view's light), seen from about 28° up with the front to the left, the side lit from above on the
  right and the front in its shade, full textures, drawn at twice the size and shrunk, and graded
  a little greyer, as the game's cards are (matched side by side with the game's Sprinter, Growl
  and Harpy). A number on a card counts the models in its folder; clicking the card opens the
  part (in the builder: puts it on the cursor) and lists those models under its line. Search with
  Ctrl+F (the box above the cards), by in-game name or file name: each category and kind then
  counts its matches. **All files** lists every file in the archives instead.
- **A folder's row shows the part as the game does**: a launcher comes with the projectiles it
  holds on its deploy points, like the Porcupine's two barrels ("With 2 × Porcupine · barrel in
  place, as in the game" under its title; **Show it alone** to see the launcher by itself). They
  ride their bones, so the reload rolls the next barrel forward. A model's own row, inside the
  folder, opens that model alone. The number on a folder row counts the models in the folder:
  the part plus its projectiles, wreck pieces and skins (the Porcupine has 6: the launcher, the
  barrel and 4 wreck pieces). While searching, `2/6` means 2 of the 6 match.
- **Names**: parts show their in-game name where it is known, with the file name in grey. About
  620 parts are named in `ui/names.json`: every cabin, nearly every weapon, module and movement
  part, plus skins ("Mauler · skin"), painted special editions ("Judge 76mm · decorated"),
  customized versions ("AC64 Joule (customized)"), old models ("Icarus VII (old model)") and the
  drones and pieces that belong to a part ("Kapkan · trap"). The names come from the game's own
  2018 item data and Crossout fan sites, and each part's 3D render was compared with its in-game
  icon on crosscalc.net. The game keeps its current name list in encrypted files, which this tool
  never opens. A name that is a best match rather than certain says so when you hover over it.
  Parts without a known name show their file name. A folder that holds several different parts
  gets a title ("Wheels") or lists them ("Stronghold / Frontier"). Click ✎ next to a part's title
  to name it yourself; your names are saved.
- **View** (middle): the background is the game's garage haze by default (or Dark / Studio /
  Light). Drag to orbit, right-drag to pan, wheel to zoom, **F** frames the part,
  **W** toggles wireframe. You can switch LODs and skins, show the pivots (moving parts), and
  save a screenshot.
  - **Weld points**: the points other parts weld onto, drawn the way the game's garage draws
    them: flat squares lying on the part, a thin white frame around an even see-through fill, one
    per cell face (the game's own marker, `particles/models/weld_slot`). Like in the garage they
    are one-sided, never turn towards you, and vanish when seen nearly edge-on (about 85°).
    Each stands clear of its own part: a centimetre off the face, and just above any bump under it
    (a domed hatch, bolts, a lamp) up to 15 cm, so the part does not cut through it; a part that
    rises higher there (a gun mount) covers that point. Hover one to see its name.
  - **Firing arc** (weapons): a see-through dome showing where the weapon can aim, i.e. how far
    it turns and tilts, from the game's own aiming limits (its animation files). A turret that
    turns all the way round gets a full dome, a gun limited to ±50° a wedge, and a fixed gun
    that only tilts a flat fan. The slider next to it sets the dome's size, with its radius in
    metres shown beside it. The size scales with each weapon (the weapon's size times the
    setting, 1.2 at first), so one setting suits a small machine gun and a mortar alike.
    **Cones** takes away the cones that close the dome above its highest and below its lowest
    tilt, leaving the band between them. The builder's arcs use both settings too. Remembered.
  - **Its materials, outlined**: the piece of the part under the cursor gets the garage's white
    outline (every bit of it that uses that material, with its name, texture and triangles beside
    the cursor); a click selects that material: an orange outline, and the Materials card marks it
    and scrolls to it. Pointing at a material in the card outlines it in the view, a click on its
    name selects it. Esc or a click beside the part lets go.
  - **Lighting**: the sun casts soft shadows onto the part and onto the floor under it, and
    ambient occlusion darkens crevices and where the part meets the floor (**Shadows** turns
    both off). Bare metal is metallic, as marked in the part's gloss map.
  - Opening a part keeps the current one on screen until the new one has its textures, then
    swaps them and glides the camera over, with no flash of untextured grey. A spinner only
    shows when a part takes a while. Browsing with ↑ / ↓ loads the next part in the background,
    so it opens at once.
- **Paint** (right): the game's paints on the part, where its paint mask lets them show (its gloss
  map's red, as in the garage): plain colours, the 320 patterns of the game's `textures/patterns`
  (camouflage, carbon, flames, scales, the event and sponsor paints ...) and its 50 chameleon paints.
  - A pattern is laid over the part's second UV set, the one the game lays its paints on: on most
    parts it repeats every 1.45 m and runs on unbroken over a whole cabin, so a vehicle's parts
    match. **Size** makes it bigger or smaller (double-click: back to the game's), **Tint** colours it
    (white: as the game has it). Patterns that come with a relief (their own normal map: carbon weave,
    scales, armour plates ...) have it too. A piece without the second set (wheels, some decor) takes
    the pattern's mean colour.
  - A chameleon paint changes colour with the angle you see the surface at: the left end of its
    colour ramp where the surface faces you, the right end where you see it edge-on.
  - **Finish**: Matte (the part's own gloss), **Metallic** or **Chrome**: the painted surface shines as
    a metallic paint or as polished metal, as the game's metallic paints do; the Colours tab also has
    the game's metal materials (Chrome, Gold, Aluminium). Glass takes no paint.
  - Paints the game's text names (43, from its English strings of 2018-19: "Pattern: Lava", "Material:
    Alligator", "Pattern: Graffiti Dusk" ...) go by those names; the newer ones by their file's.
  - The paint goes over the textures' own colour edits, stays on as you open other parts, is kept in
    looks, and exports have it baked into the textures (a chameleon as the colour it shows on
    average: a file has no view angle).
- **Materials & textures** (right): every texture of the part with its size and format.
  - **PNG**: saves the texture. Normal maps are rebuilt as standard RGB normal maps.
  - **DDS**: saves the game's texture unchanged, with all mips.
  - **Replace…**: use your own image (PNG, JPG, BMP, TIFF, TGA, or DDS in BC1-BC5, BC7 or
    8-bit RGBA). Edit an exported PNG or DDS in any paint program and bring it back.
  - **Colours…** (albedo): hue, saturation, brightness, contrast, tint, and **Paint**, which
    colours only where the part's paint mask allows, like the in-game paints (on every part that
    uses the texture; the Paint card's paint covers it while it is on).
- **Animation**: parts that move in the game move here too:
  - turrets turn and guns tilt with the aim sliders, and firing spins barrels and works levers
  - wheels steer, spin and spring, tracks bend over their suspension, legs step, and covers open
  - pick what the part is doing (Idle, Fire, Open, Walk, ...), play / pause, change the speed,
    or tick "Move these on their own"
  - each activity plays only its own layers, as in the game. The sliders follow it: the
    two-mode wheel's suspension runs 0.55-1.6 standing up and 0-0.35 sitting down. A slider whose
    clip moves nothing (an empty clip in the game files) is left out. An activity's own clip plays
    first and the layers it adds go on top of it: the Porcupine's Fire rolls the next barrel
    straight in from the back slot while the idle spins it. Clips slide bones in their parent's
    frame, as the game's Maya rigs key them: recoils kick back along the barrel, a crossbow's limbs
    snap forward as mirror images (exports the same).
  - **Loaded projectiles** (a part shown from its folder's row): when firing, the round that slides
    out of its slot flies out of the launcher (the Porcupine's front barrel, the airstrike rocket, the
    burst grenade launcher's grenade), and a round resting in its slot gives way while the next one
    passes through it. A reload rolls a new one in without firing.
  - **Look at me** (for anything that aims: guns, drones, the visor, searchlights): the gun keeps
    turning to face you as you move the view, as far as it can turn, and the aim sliders follow.
    It aims the barrel itself, not just the numbers. On 28 of the 254 parts that aim, the game's
    clips turn the gun by other amounts than the slider says (the Spike-1 crossbow, drone guns,
    mortars that start pointing straight up). Remembered between sessions; moving an aim slider
    yourself, or ticking "Move these on their own", turns it off.
  - **Firing effects**: guns fire with the game's own muzzle flashes, flames, sparks and smoke
    (its `particles/` effects, read and played here: flip-book sprites, streaks stretched along
    their flight, fireballs glowing through the game's heat ramps, dome meshes round the muzzle,
    smoke lit by the sun). They come out of the gun's fire points (`fire_01`, `fire_02`, ...; Fire 2
    from the second barrel only, a rocket pod one tube after the other) with each shot: a cannon's
    single blast, a machine gun's one-frame flashes five times a second, a minigun's 21 a second (six
    per turn of its barrels), a flamethrower's stream of fireballs riding projectiles 14 m out. Smoke stays where it was blown out while the gun turns,
    and fades into the floor. The speed menu slows them down with the animation. Which effect a gun
    uses sits in the game's encrypted item data, so it is matched by name (Animation card: **Firing
    effects** shows the match; pick any other muzzle effect or Off, remembered per part).
  - **When a gun fires**: as in the game. A gun with a reload time fires once per reload and holds
    still in between (the cannons every 6 s, the Clarinet TOW and the Heather every 13 s, the King's
    mines every second; the game's own numbers, from the stats below, and shown on the builder's part
    card); a rocket pod with one fires a salvo at each, a rocket from each tube one after the other
    (the Hurricane's 8, the Cricket's 10), then waits out the rest. Guns that fire non-stop in the game
    (machine guns, autocannons, miniguns, the shotguns and grenade launchers that overheat,
    flamethrowers, beams) fire as fast as their Fire clip loops, one shot a loop (six a turn of a
    minigun's barrels); so do the few that reload in under a second (that is their pace within a
    magazine). **Shot every** (Animation card; the same setting in the builder's and Maps' **Fire**
    cards) sets your own: seconds from one shot to the next (1, 6, 13 …), for every gun, a pod's
    salvo counting as one; between shots the gun holds still and what it keeps going while it fires
    (a held beam, a flamethrower's flow, a minigun's motor) stops. Empty, the game's pace is back; the
    box then shows the gun's (*game: 6*, or *own pace*).
  - **Light and heat haze**: muzzle flashes, hits and explosions light up what stands near them
    (the gun, the floor, the target) for a moment, in the colour of their glowing parts and as far as
    the effect reaches (a machine gun's flash for a fifteenth of a second, an explosion's for a
    quarter); a plasma ball and the game's own light particles light their surroundings while they
    last. The air shimmers over blasts, flames and engines: the game's heat-haze sprites bend what
    is behind them.
  - **Rounds, tracers and hits**: every shot also sends its rounds out of the fire points along the
    barrels, carrying the game's projectile effects (a machine gun's glowing dot and the long tracer
    streak trailing it, never reaching back past the muzzle; a shell's tracer, a grenade's or
    rocket's smoke trail and flame, the plasma ball's swirl), with a shotgun's pellets spread round
    the barrel and grenades and mortar shells dropping on their arcs. Rockets, crossbow bolts,
    grenades, mortar bombs, sticky bombs and frost shells fly as the game's own models, nose first
    along their flight, their smoke and flame coming out of the rocket's nozzle (a launcher's own
    projectile where its folder has one, else the game's shared rockets and bolts; pods whose tubes
    sit too close for the finned rocket fire the slim one). Guided launchers' missiles steer onto
    the target (the vertical launchers' climb out of their tubes and dive onto it, the Swarm's and
    the Heather's rockets too). A mortar or grenade fired from a barrel pointing 30° or more up comes
    down on the target on its arc (its fixed speed would carry it hundreds of metres). Guns the game
    gives no Fire (17 models, the guided launchers and the twin bomb launcher among them; most have
    no animations at all) get a Fire of the viewer's own in the Animation card. Where a round lands
    it plays the game's hit effect: the sparks, explosions and flames it makes on a car (on the
    **training target**, the bootcamp's cut-out pickup) or on the ground. While a Fire activity is
    picked the target stands 10 m down-range (Animation card, **Shots hit**: 10, 25 or 50 m, or
    "only the ground"), placed so the barrels' lines meet it (the cut-out is see-through between its
    wheels, at the barrel height of many guns on the floor), and the camera swings behind the gun to
    see it when it is out of view. Speeds, drop and reach are by the kind of gun (the game keeps
    them in the encrypted item data); a minigun's hits are capped at 24 playing at once.
  - **Beams**: the Tesla guns' lightning, the Aurora's laser, the plasma drills' arcs (held while they
    fire, following the barrel), the Athena's laser and the Assembler's lightning (one flash a shot)
    reach out to what the barrel points at, with the game's beam effects and their hits there; the
    frost guns blow their frost out like a flamethrower's stream.
  - **Launchers that throw things**: harpoons stick into the target with their rope pulled back to
    the gun, and let go after a while; saws, discs and blades spin in flight and stick where they
    hit (the legendary saw keeps cutting there, then blows); the wheel and train-wheel bombs land and
    roll along the ground into the target; the Porcupine's barrels tumble out and roll; the King's
    mines and the Kapkan's traps land and blink (the trap's arrows fly out at the target); the
    Morta's ion shield lands and glows; drones fly out above the way to the target and shoot at it;
    the Punji's fence poles stand where they land, the fence's bolt between them; the Boom spear's
    tip goes off. Crossbow bolts stay stuck where they hit; the sticky ones (the Phoenix's, the Varun
    and Corax's, the Sovereign's, the Imugi's bombs) burn their fuse and go off, each with the game's
    own fuse and blast.
  - **Second fire modes** (the Animation card's other Fire): the Hybrid's sticky grenades stick, fuse
    and go off; the Slaughterer's heavy grenades and the Compiler's artillery shells are lobbed high
    and come down on the target. The Waltz's rockets corkscrew round their line.
  - **Sound**: the game's own sounds, from its sound banks (FMOD, read here: every one of its
    6,745 effect samples decodes): each gun's shots where it fires (a machine gun's shots and the
    echo of its burst, a minigun's motor spinning up and running down, a flamethrower's roar and a
    Tesla's crackle held while they fire), and its rounds hitting the target, the ground or water,
    blasts, fuses, drones, ropes, where they happen, fading with distance; spent cases clatter down
    after a burst. Far off, a blast sounds as the game's distant version of it and comes as late as
    sound takes to get there; a bullet's hit is not heard past earshot. Other activities sound too:
    a chainsaw's, drill's or saw's attack runs its motor while it plays, reloads clank, the lightning
    gun and the nail guns charge, launchers' hatches open and close, and a turret's servo whines while
    its aim moves (the sliders, Look at me) and clunks as it stops. Which sounds a gun uses sits in
    the game's encrypted data, so they are matched by name. Animation card: **Sound** sets how loud
    (0 is off; one setting for every gun, remembered).
  - **Record** (beside Screenshot, in the 3D Viewer, the Vehicle Builder and Maps): records the view
    as a video clip with the game's sounds, MP4 (H.264 + AAC; WebM where the WebView2 cannot write
    MP4), until you click it again (it shows the time; at most 3 minutes), then saves it where you
    pick.
  - **Barrel heat**: weapons whose barrels glow when they overheat (miniguns, many shotguns,
    Aurora, Quasar's plasma cells) are cold at rest, as in the garage. Firing heats them up
    over a few seconds and they cool down after; the slider sets a steady glow, which the
    export uses too. Lights, screens and other glowing bits always glow.
  - **Lamps**: head lights, signs, screens and flashers are glow layers laid over the part (the
    game's lamp shader, marked "glow layer" in the Materials card). They add their light onto the
    part, with the game's blink timelines: police and ambulance flashers flash, beacons turn, signs
    flicker (only while one is on screen; nothing is redrawn for still lamps). The mouse goes
    through them to the part underneath. The same goes for the other glow shaders: parts' separate
    light models (a mech leg's, a moto wheel's, the relic minigun's glow), neon signs, garlands and
    lights on map props and gameplay objects (garland strings, signs and sails the game draws from
    both sides are drawn so); the build-slot marker is a see-through layer.
  - **Belts, chains and tracks run**: the game moves them by sliding their texture along them (its
    scrolling-belt shader), at a speed its code sets. Here each one runs with the wheel, gear or
    pulley it wraps, as fast as that wheel's rim: the Porcupine's chain with its sprocket, a track
    with its road wheels (the wheel spin slider, or "Move these on their own"), engine and cabin
    belts with their pulleys (Oyabun, Cheetah, Jaguar, BWC Warrior, Mars), the Lacerator's chains,
    the Doom's belt and the legendary saw launcher's chain. A tyre that turns with its own wheel
    stays as it is. Exports keep the belt as it is modelled (the texture does not slide in the
    file).
- **Look**: save / open all colour edits and replaced textures as a `.xolook` file.
- **Export**: GLB (one file, textures inside, best for Blender), glTF (separate files) or OBJ, from
  the Export card or with **Export…** beside Add to build at the top of the panel (the card's options).
  The file holds one object named as the part is in the game (the file name when no in-game
  name is known; a part with several materials has one child object per material). Options:
  current LOD or all LODs, **Textures up to** full size / 2048 / 1024 / 512 px (the game's own
  mipmaps, for lighter files), DDS copies, extra maps (gloss, ambient occlusion), **Ambient
  occlusion in the material** (off by default), **One object per material (for Cinema 4D)** (on
  by default; see [In Cinema 4D](#in-cinema-4d)), vertex colours, **Weld points & pivots as empties** (off by default: a cabin has
  150 or more, which clutter Blender's view; for modding and rigging), and for parts that move
  **Pose as shown** (on by default: the part exactly as the viewer shows it, with its aim,
  steering, suspension or the moment of the animation playing; off: the pose the model was made
  in, which on 50 of the 264 animated weapons is more than 1 cm off what you see: a mortar's
  barrel stands straight up) and **Skeleton & animations** (GLB / glTF): the
  part's bones, its moving pieces skinned to them, and every animation it has (firing, idle,
  turret turn and tilt, wheel spin, steering, suspension ...) as glTF animations, which Blender
  imports as actions; with Pose as shown the skeleton starts in the pose you see. Your colour
  edits and replaced textures are baked into the exported textures. A part shown with its
  projectiles (opened from its folder's row) exports with them, each its own object
  (`barrel_deploy_01`, `barrel_deploy_02`); with Skeleton & animations they hang under their
  bones, so the reload moves them in Blender too. glTF and OBJ put their textures (and DDS copies / extra
  maps) in a `<name>_textures` folder beside the file, so exports sharing a folder never
  overwrite each other's textures. The `.bin` / `.mtl` / folder names are plain ASCII (a name
  like `Танк Leo.gltf` gets `Leo_8289aaae.bin`), so every importer finds them.
- **All files**: the raw archive (86,000+ files). Filter, tick, and **Extract checked…**
  saves them with their folder structure, each checked against the game's own MD5 first. Click a
  `.mdl` to open it, a `.tfh` to view it.
- If the launcher updates the game while the app is open, reading a changed archive stops with a
  message to reload the game folder (the ⟳ button) instead of returning the wrong bytes.
- A second start of the app (one click too many) brings the open window up instead of running a
  second copy on the same autosave and settings.

## Vehicle Builder

Switch to **Vehicle Builder** at the top to put parts together like in the game's garage.

- **Place**: click a part in the list and it sticks to the cursor, drawn like the garage does it:
  a see-through whitish ghost with a white outline, and the part it lands on outlined too. It
  snaps to the build grid (0.3 m cells) and to other parts' weld points (the ones it will weld
  onto turn orange). Red means it would sit inside another part: then it can't be dropped, as
  in the garage. Overlaps are judged by the parts' own collision hulls from the game (`.mdp`
  files), so a wheel tucked under a cabin's fender is fine; a few centimetres of contact count as
  touching. Wheels and other side-mounted parts turn to face the surface they go on. Click to
  drop it.
- **Hover** a part and it gets the garage's white outline (its silhouette and inner edges), with its
  name and type beside the cursor.
- **The garage's rules**: one cabin per vehicle, one engine, at most 80 parts. A part that would
  break one stays on the cursor and the status line says why.
- **Augmented reality** (**F** or the **Aug. reality** button), as in the garage:
  - the vehicle's free weld points show as white boxes, and a selected part's welded points are
    green; the points on a frame's sides, a wheel's mount and a cabin's underside are drawn with a
    round hole, like in the garage
  - every weapon shows the dome it can aim into (its firing arc), so you can see what the cabin
    or other parts are in the way of; the **Arcs** slider beside the button sizes them all (each
    in proportion to its own weapon), and **Cones** shows or hides their top and bottom cones
    (the same settings as the 3D Viewer's)
  - while you hold a part, the vehicle's weld points it will weld onto turn orange, and every
    other point stays white (the held part's own free points too)
  - every wheel shows its suspension (a coil spring between up / down arrows beside the hub), and
    a steering (ST) wheel the steering symbol in a turning arrow at its foot: the garage's own AR
    models, read from the game
  - parts that are not welded to the rest of the vehicle turn red
- **The garage HUD**, with the game's own icons (read from its archives):
  - **Energy bar** over the vehicle: what the modules and the weapons use (red), the free energy
    (the bolt; red when the vehicle needs more than it has), what the cabin gives, and what the
    generators give (greyed out without one).
  - **Part card**: the part on the cursor, under it, or selected, with its stats: energy, cabin
    speed, tonnage, mass limit, durability, mass, and a wheel's power drain.
  - **Parts list** (**H**): a picture of every part with its energy, sorted like the game
    (parts of the blueprint, structural parts, decor). Click one to select it. The vehicle's
    stats sit beside it.
  - **Vehicle stats** (also in the builder panel): durability (cabin plus armour; frames add
    none), total parts (80 is the most a vehicle can have), energy, mass and mass limit, top
    speed, and tonnage (mass over tonnage means the vehicle is overloaded and slower).
  - The stats come from crosscalc.net's item table (the game keeps its own in encrypted files),
    matched by in-game name: cabins, weapons, modules, generators, frames, wheels and other
    movement parts, and the armour it lists. About 140 armour and decor parts are named from the
    game's own 2018-19 item data (github.com/Zicore/CrossoutMarket); where crosscalc no longer
    lists them, their durability and mass come from that old data and the part card says so.
    About 715 models have stats in all; parts without any are left out of the mass (and armour
    out of the durability), which the panel says. A weapon's card adds its reload time (crosscalc's
    shooting cooldown), which is also how often it fires here. Acceleration and power score are not shown:
    the game does not publish how it works them out.
  - **Steering wheels**: a selected wheel that also comes as an "ST" version gets a **Steering
    wheel (ST)** box (same model, less tonnage, more drain on the cabin's power).
- **Camera, as in the garage**: **W A S D** move it over the ground, **Space** raises it,
  **Shift** lowers it (Shift+click and Shift+drag still select: the camera jumps back), drag to
  orbit, right-drag to pan, wheel to zoom, **Home** frames the build. **C** lifts the car so you
  can see and build underneath it (C again sets it down).
- A controls bar at the bottom lists the keys, like the one in the garage.
- **Turn / mirror while placing**: the turns go by what you see. **R** spins the part on the face
  it sits on, anticlockwise as you look at that face (on a roof about the vertical, on a wall about
  the wall's line), **T** tips its top towards you, **Y** rolls it clockwise as you look at it; Shift
  turns the other way, Q / E spin it left / right, and the part card's ↺ ↻ T− T+ Y− Y+ buttons do
  the same. Each press turns exactly 90° of what is shown, in a short turn the eye can follow. A
  turn that leaves no weld points against that face stays as you turned it (not welded) instead of
  the snap turning it back, and R then Shift+R always comes back to where it was. A selected part
  turns the same way (R about the way its weld points face). X mirrors, Esc cancels.
- **Symmetry** (M): every part you place also gets a mirrored twin on the other side. The mirror
  plane runs through the middle of the cabin (or x = 0 without one), so a base an odd number of
  cells wide is symmetric too. A twin that would overlap something is left out (the status line
  says so); moving a part takes its twin along to the mirrored spot.
- **Edit**: click a part to select it. **Drag a part** to move it, as in the garage: it comes off
  the vehicle, follows the cross cursor snapping from weld point to weld point (or along the
  grid), and stays where you let go; dragging a selected part takes the whole selection along.
  Dragging empty space still turns the camera. G picks a part up too (click to drop), and you can
  type X / Y / Z (whole 0.3 m cells), rotate, mirror, duplicate (Ctrl+D), delete (Del), pick a skin,
  or open it in the 3D Viewer. Ctrl+Z / Ctrl+Y undo and redo (right after a drop, Ctrl+Z takes the
  dropped part back and puts the copy on the cursor away). Arrow handles on the selection are off by
  default (**No handles** / Move / Rotate in the toolbar).
- **Select several parts**: Ctrl+click (or Shift+click) adds or removes a part, Shift+drag
  draws a selection box (Ctrl+drag takes parts out), Ctrl+A selects everything, Esc clears it.
  In the parts list, Ctrl+click and Shift+click (a range) work too. Every edit then acts on the
  whole selection: dragging one moves them all, the handles (if on) move or turn them together (in whole cells / 90° steps), G picks
  them up as one piece that snaps like a single big part, R / T / Y turn them around their
  middle (R about the vertical), X mirrors them in place, Ctrl+D copies the group, Del deletes them, typing X / Y / Z
  moves them all, and the skin menu changes every selected part of the same model. With
  Symmetry on, mirror twins of the selected parts follow along. Selected parts are outlined orange
  (the last one picked brighter), the twins that follow them blue, the part under the cursor white.
- **Fire** (hold **V**): every weapon on the vehicle fires at once, each at its pace as in the 3D
  Viewer (once per its reload time, a rocket pod a salvo, the rest non-stop; or all together on the
  **Fire** card's **Shot every**), out of its own fire points, with the 3D Viewer's
  effects, rounds, hits and sounds; while they fire the guns move as they do in the game (barrels
  recoil, a minigun's spin). The training target stands in front of the vehicle (the build panel's
  **Fire** card: 10, 25 or 50 m or only the ground, the same setting as the 3D Viewer's **Shots hit**)
  and the camera moves behind it when the target is out of view.
  Letting go stops them (motors run down, held beams go out).
- **Paint**: the 3D Viewer's paints (colours, patterns, chameleon paints), only where each part's
  paint mask allows, as the garage paints:
  - **Whole vehicle**: the vehicle's paint, on every part without a paint of its own (parts added
    later too). When parts have their own, the card says how many and **Paint them too** gives them
    the vehicle's.
  - **Selected parts**: paints the selected parts (and, with Symmetry on, their mirror twins);
    **Remove their paint** leaves them bare under a painted vehicle, **Use the vehicle's paint** gives
    it back. A part with a paint of its own has a small swatch in the Parts card.
  - **Brush**: click a part to paint it, or drag over several; **Alt+click** a part to take its paint,
    **Esc** to put the brush away (the camera still turns with a drag on empty space). Its **Brush
    takes paint off** makes it an eraser.
  - Copies take their part's paint, Ctrl+Z / Ctrl+Y undo and redo painting, and the paints belong to
    the build (saved in the `.xobuild`), on top of any colour edits a texture has of its own. Driving
    and firing show them too.
- The **build panel** shows the size in metres and cells, and whether every part is attached
  to the rest through weld points.
- **Save** (on the builder's toolbar and in the build panel, Ctrl+S) writes the build to its
  `.xobuild` file: the first time it asks where, then it saves to that file without asking
  (**Save as…**, Ctrl+Shift+S, picks another). An orange dot on Save and a line under the build's
  name show when the build has changes its file does not have yet. **New / Open…** (Ctrl+O) ask
  before throwing away unsaved changes. The current build is also saved automatically (and once
  more as the window closes) and is back when you restart, still tied to its file. Parts a game
  update removed stay in the file, listed greyed in the Parts card as "missing" with a ✕ to take
  them out; reference pictures and replaced textures whose image can't be read now stay in the file
  too. New and Open wait while a build is still loading.
- **Export build**: GLB, glTF or OBJ with one node per part, named as the parts are in the game,
  each part's paint baked into its textures, and each model's mesh stored once however often it is
  used (a painted part's once for each paint).
  A mirrored part gets a mirrored copy of its mesh (`<name>_mirrored`), so no object has a
  negative scale (Blender edits those inside out). **Textures up to** 2048 px by default (a
  cabin's textures alone are 37 MB at full size). Tick **Only the selected parts** to export just
  a piece of the vehicle (a turret, one side).
- Parts that move stand in the builder (and in its parts pictures and exports) in the pose the 3D
  Viewer starts them in: aim, steering and the other parameters at 0, the idle at its start. The
  pose a model was made in is often another one (a mortar's barrel stands straight up in it).

### Rebuilding a vehicle from the game

Crossout keeps builds and blueprints on its servers: nothing on your PC holds their parts and
places (the game's logs only name blueprints by number), and the only ways to read them out of
the running game (its memory or its network traffic) are what BattlEye bans for. So a vehicle is
rebuilt here once, and two things make that quick. Both are saved with the build (`.xobuild` and
the autosave).

- **Parts to place**: type or paste the vehicle's parts, one per line with how many
  (`Werewolf`, `4 Bigfoot ST`, `2x Scorpion`, `Lightweight frame 6×4 x3`, `Tusk: 3`,
  `Hurricane (2)`; commas work too), then **Make the list**. In the game, the Exhibition lists a
  design's parts when you point at it. Names are matched to parts by their in-game names, also
  short ones and small typos ("Sledge" is Sledgehammer, and the line says what you typed); a name
  that fits several parts offers them, and one no part has can be ticked off by hand or searched
  for in the parts list. Each line counts how many of that part the build has (`1/4`), and
  **clicking a line puts that part on the cursor** (an ST line a steering wheel; plain and ST
  versions of a wheel are counted apart). The header sums it up ("12 of 30 placed").
- **Reference pictures**: screenshots of the vehicle from the game, shown over the 3D view
  (see-through) or behind the parts, to place parts over them.
  1. Turn the builder's view roughly the way a screenshot looks and **Add picture…** (PNG, JPEG,
     WebP, BMP ...). It fills the view's height.
  2. **Line it up**: drag the picture, zoom it with the wheel (arrow keys and + / − for small
     steps; Shift for big ones), Enter or Esc when it fits. Turning the view or zooming the camera
     also lines it up, while it is not pinned. **Lens** sets the camera's field of view for that
     picture, for a screenshot whose perspective looks different.
  3. **Pin to this view**: the picture now belongs to the camera view. It fades out as soon as the
     view turns or moves away (it would no longer line up) and comes back with its view: click it
     in the list, **Go to its view**, or **P**. **P** shows and hides it, **Shift+P** goes to the
     next picture. Opacity and in front / behind are per picture.
  The build file keeps the pictures by file name (they are read again when the build opens; a
  missing one is named in a warning), with their views, places and settings.

## What goes into an export

What goes into a GLB: the mesh in metres (Y up, right-handed), normals and tangents, the UV set
the textures use (the model's second one is left out: no exported texture reads it), and PBR
materials:
- base colour = albedo
- normal = rebuilt normal map (OpenGL convention, what Blender expects)
- occlusion/roughness/metal = AO from the normal map + roughness from the gloss map (at least
  0.2, like the viewer, so small glossy bits do not turn into mirrors) + metal from the gloss
  map's blue channel, as the viewer shows it; the AO is in the texture but only wired up as the
  material's occlusion with **Ambient occlusion in the material** (off by default: see Cinema 4D
  below)
- emissive = glow map (a weapon's heat map is exported with the Barrel heat you set; at 0 % the
  weapon is cold and goes out without it; `extras.heatGlow` marks the material)
- lamps and other glows (head lights, signs, flashers, light models, neon, garlands) = a black
  see-through layer that glows: one `*_glow.png` (the lamp's colour times its blink timeline at
  rest; alpha = how strongly it shows) as base colour alpha and emissive, brighter ones with
  `KHR_materials_emissive_strength`, `extras.lampGlow`; the OBJ's `.mtl` says `Ke` / `map_Ke` /
  `map_d`; the ones the game draws from both sides (garland strings, signs) are `doubleSided`
- transparency like in the game: nets, grates and fences are cut out (`MASK`, only when the
  albedo really has holes), glass is see-through (`BLEND`); an opaque material's albedo PNG has
  no alpha channel (smaller, and nothing for an importer to wire up as transparency)
- paint (the 3D Viewer's, a build's parts'): baked into the albedo where the paint mask says, as the
  view shows it (`<albedo>_<paint>.png`, `_paint` for a colour; the material is named the same; a
  metallic or chrome finish goes into the roughness / metal image, `<gloss>_<paint>_orm.png`). A
  pattern is laid over each part's own second UV set texel by texel (texels between its islands take
  the nearest painted colour, so the texture's filtering finds no seams), so two parts with one
  texture get images of their own; its relief goes into the normal map (`<normal>_<paint>.png`). A
  chameleon paint is baked as the colour it shows on average (its ramp weighed by how much of a body
  is seen at each angle). Put back into the 3D Viewer in place of the part's own, the baked textures
  look as the live paint does, to within a level or two of 255

A part on its own is one object (named as in the game, `extras.source` = its file); with **One
object per material (for Cinema 4D)**, on by default, a part with several materials (glass, glows,
a second texture set) is that object as an empty with one child object per material, named
`<part> (<material>)`. Untick it for one object per part with several materials (Blender and Unreal
take both). A part also brings more when asked: with **Weld points & pivots as empties** the weld points (build slots) come along as
empties in a `slots` group and the moving-part pivots in a `pivots` group, under an empty named
for the part. A part that moves is exported in the pose the viewer shows (**Pose as shown**;
`asset.extras.pose` says so): every vertex moved by its bones as the viewer skins it, and pieces
the pose shrinks to nothing (spent shells, hidden flashes) left out. `asset.extras.gameVersion`
names the Crossout version the files came from.

With **Skeleton & animations**, the part's nodes become a glTF skeleton (a skin over all of them,
bound in the rest pose; the nodes start in the pose shown when **Pose as shown** is on), the pieces that move go into a `<name>_skinned` mesh (a rigid piece riding on
a node, like a tyre on its hub, is bound fully to that node), and each animation layer of the
part's `.model` becomes one glTF animation: an activity (FIRE, IDLE ...) over its own time, a
pose layer (AimYaw, WheelSteer ...) over the clip from the first value of its range to the second, as the `.model` declares them (often high to low: `AimPitch 60 -29` starts with the gun 60° up)
(`extras.poseParameter`, `min`, `max`), and a pose blend (wheel spin) as one key per pose, a
second apart (a bone that a pose leaves out sits at rest in it). `tools/e2e.mjs` checks that every bone of an exported clip sits exactly where the
3D Viewer puts it.

An export works on all of the CPU's cores: its models are read side by side, its textures decoded,
combined and written as PNG side by side (as many at once as the free memory has room for), a map's
decals cut and baked side by side, and the files come out the same, byte for byte, as made one by one
(bridge with its 124 textures in about 3.5 s, 24 s on one core). Opening the game's 784 archives reads
their indexes side by side too. A `.glb`'s textures go into the file from where they were made, not
copied into one block first (writing sinto's 538 MB file: 0.74 s, now 0.32 s, and 100 MB less memory).

An export's files (the model, its `.bin` / `.mtl`, textures, DDS copies) are written together:
each goes to a `.part` file first and they get their real names only once all of them are
complete, so a failed export leaves nothing behind. An existing file that another program holds
open makes the export fail before anything is replaced (close it and export again).

### In Cinema 4D

Open a GLB or glTF with File > Open (or Merge) and keep the import settings as they are. Grimcold's
export defaults are made for Cinema 4D 2026, which reads glTF differently from Blender. Each point
below was checked in Cinema 4D 2026.3, with the material graphs it builds and Redshift renders:
- **One object per material** stays on: Cinema 4D drops every glTF mesh that has more than one
  material (with normals), so without it most parts would arrive with no geometry at all.
- One UV set: Cinema 4D lays every texture over the last UV set in a file, so Grimcold writes only
  the one the textures use.
- **Ambient occlusion in the material** stays off: Cinema 4D turns a glTF occlusion map into
  Redshift's Overall Tint, which darkens the whole surface, and Crossout's baked AO is dark.
- A cold weapon has no heat map (Cinema 4D would show the barrel red-hot whatever the material says).
- Each material becomes a Redshift Standard Material: the colour map as Base Color, roughness from
  the gloss texture's green channel, metalness from its blue channel, the normal map as a
  tangent-space bump, glass and cut-outs through the colour map's alpha.
- Animations (**Skeleton & animations**) come in as Takes, one per clip: open the Take Manager and
  pick one (aim, fire, ...).
- **Weld points & pivots as empties** shows as white dots, one per empty (Cinema 4D draws Nulls as
  dots): leave it off unless you need them.
- Not read by Cinema 4D's glTF import: map grass (`EXT_mesh_gpu_instancing`), the sun
  (`KHR_lights_punctual`) and see-through water (`KHR_materials_transmission`: it arrives white,
  give it a material of your own); decals arrive but without their soft edges (vertex colours).
- OBJ: the `.mtl` names each normal map twice, as `map_Bump` (Blender) and `bump` (Cinema 4D reads
  only the lowercase name, as a normal map).
- Light: Grimcold shows a part under the game's sky. Cinema 4D's viewport starts with a single
  default light, so add a sky (an HDRI, or a map's exported sky `.hdr`) or a dome light to see the
  materials as they are.

## Maps

Switch to **Maps** at the top: the left side lists every map of the install (94, with the game's
loading pictures; a variant like "Arena canyon dronebattle" borrows its map's, and maps without one,
such as the arenas and hangars, show the game's own minimap of them). Click one and it
opens in the view: its terrain, buildings and props, trees and plants, objects, water and acid, grass,
decals, its lights, the game's own sky and the spawn points (blue team 1, red team 2, white the rest).

Opening a map is mostly the GPU building its shaders the first time (a map material's shader takes
about 0.3 s, a map asks for 25 to 35; all 92 maps with something to show use 77 between them, and
the GPU keeps the ones a map has drawn across starts). So the view builds each material's final shader at once (a texture still loading
stands in plain until it comes, rather than one shader after another as they arrive), builds them
side by side on the GPU process's threads (a model shows once its shaders are built, so no frame waits
on one), every lamp,
gun flash and headlight goes through one shared light loop in the shaders, and the shaders of the
maps opened before are built again while the app sits idle outside Maps (after an update that
changed them, the next map opened in that run finds them built; the GPU forgets a shader built that
way at the next start unless a map drew it, so these are built at every start, from its cache when
a map did). Each model is read once, its description and its
shape in one request (the second look of a model, another skin, only its description), and each
texture's header once (sinto read 7,344 of them for its 787 textures). While a map
comes in, the view is drawn 10 times a second as long as nothing moves (any key, the mouse or a drag
brings it back to full rate), so its models get the time. bridge opens in about 4 s once its shaders are built (8 s the very first
time), sinto with its 695 models in about 7 s.

Fly through it:
- **W A S D**: fly; W and S go where the camera looks (up and down too), A and D sideways
  (the arrow keys work too)
- **Space** up, **Shift** down (E / Q too); the camera never goes into the ground
- **1** to **9**: the camera speed, 2, 5, 10, 20, 35, 60, 100, 200 or 400 m/s (the number pad
  too); the mouse wheel steps it up and down; the box at the bottom left shows it in m/s and km/h
- **drag** (either mouse button): look around
- **Team 1** / **Team 2** / **Overview** (toolbar), **Home** back to the start, and the
  **minimap** (top right): click or drag on it to fly there

Pick things out of it: **click** any object (a tree, a burnt-out car, a rock, a building, a
barricade) to select it. It gets an orange outline (white while the cursor is over it, with its name
beside the cursor; trees are outlined around their crown) and a card at the top of the panel says what
it is: its model and folder (an entity's own name and game definition too), how many the map has,
where it stands (x, z, height), how it is turned and scaled, its object number.
- **Ctrl + click** adds an object to the selection (or takes it away), **Ctrl + drag** selects what
  lies in a box (not what is behind a hill), **Select all N** every copy of that model on the map;
  with several models the card lists them (a click on one keeps only those)
- **F** or a double-click flies to the selection, **H** or **Delete** hides it (**Show them** in the
  Show card brings it back; hidden objects also stay out of the map's export, and so do the decals
  on them), **Esc** lets go. Objects keep their ids in every game mode and festival, so what is
  hidden or selected stays so when you switch (also when you switch twice in a row)
- **Open in 3D Viewer**: the model on its own (looks, textures, LODs, the part export);
  **Export selection**: the selected objects as one GLB / glTF / OBJ, as they stand to each other,
  around the origin or at their place on the map (lines up with an export of the whole map)

Everything is drawn the way the game draws it, with the game's own light, fog and materials (where
its shaders, which sit in the encrypted packs, leave a formula open, it was fitted to the game's own
360° HDR captures of its maps and to its loading pictures). Models swap to their coarser levels of
detail at the sizes on screen the game's own models ask for.
- **The light** is the game's own. Every environment of a map comes with HDR captures of the map from
  a point in it (its light probes), and the view lights everything with the one of the weather shown:
  the sky, the land around (warm light off sand, green off grass, the dark side of the bridge's deck),
  what water, glass and metal mirror (the map, its clouds, the sun's glint), and the diffuse light from
  the game's own irradiance. Inside the hangar halls (12 maps have a probe of the hall's own: the
  hangars, factory, building_yard3, helicopter_downtown ...) the hall's capture lights and is mirrored,
  fading to the outdoor one at the hall's edges, so the halls are as dark as in the game. Sun, sky and
  probe are in the game's units of light, the sun at the share of it the game's captures show on
  sunlit ground: 0.82 of the weather's sun (its `SunIlluminance` or `AtmosphereSunIllum`) / 16, the
  moon the same at night, while the light from all around is the probe's own (at the full sun, sunlit
  ground came out about a third of a stop too bright). A clear day's sun is about four times its sky,
  so its shadows are crisp and dark; an overcast is soft, a night moonlit, and the sun has its
  preset's own colour (a sunset is red-orange). The view is exposed by the game's auto exposure for the
  weather (metered from the probe, held in the preset's `MinEV100`..`MaxEV100` and shifted by its
  `ExposureCompensation`: dull, rainy and night weathers are held at their lowest and stay dark, as in
  the game), then goes through the game's camera: its white balance (New Year's dark night is a deep
  blue), a filmic ACES curve with the preset's toe, and the weather's colour-grading LUT. The probes and
  the camera are Maps' only: the 3D Viewer, the garage and the part pictures keep their own light and
  look (and Maps has no garage rim light).
- **The sky** is the map's own: its environment's atmosphere (the game's precomputed scattering
  tables), the sun where the game puts it, the cloud layers of its sky dome, all held pixel by pixel,
  along each one's own direction, to the brightness and colour of the game's capture of that sky (so
  the skies with a low cloud layer, arena_football's overcast, Halloween, newyear_foray's night, match
  the captures too). The sun's disc holds the share of the sun the game's skies show (about a tenth)
  and takes the weather's fog; nights have no moon disc, as the game's skies have none, and stars only
  where the air's own sun is gone (a moonlit night, not New Year's blue evening).
- **Fog**: the game's own height fog (Unreal's exponential height fog, with the weather's density,
  falloff, height, start distance and colour), fitted to the game's captures of its maps' skies (27
  map environments) and of their land at known distances (12): a sandstorm's yellow dust swallowing
  the far mesas, smog lying low. It is thin near the camera and starts about 120 m out, as the game's
  land is nearly clear out to 100-250 m, so rainy and overcast weathers do not wash the ground below
  the camera pale. Behind it lies the air's own haze (the weather's `FogAerialGain` through its
  atmosphere's scattering tables): the blue on far hills on a clear day, a lilac tint on the
  sandstorm's tall mesas under its dust. It is as much weaker as the weather's sun is under the clear
  air's, so overcast and rainy days have none, as in the game. The fog lies over the scenery, the sky
  down to the horizon, the clouds, the map's smoke and fires and its lamps, and a low sun shines
  through it. There is no white wall at the end of the view: a map opens with a view distance that
  reaches the farthest thing placed, its backdrop mountains included (bridge 4,400 m, arizona_silo
  6,500 m, red_rocks_territory 6,900 m).
- **Shadows**: the sun's shadows cover the whole view in four cascades (out to 50, 200 and 800 m and
  the view distance), so buildings, trees and hills cast them across an overview too, and a low sun's
  run long across the valleys. They are drawn again only once the camera has moved a little (turning
  the view does not), so flying costs little. The terrain also takes the light its own hills leave it:
  an exact hill shadow, and less sky light in hollows and gorges. Ambient occlusion darkens crevices.
  The weathers the game gives no sun shadows (3 of them) have none; **Shadows** turns the shadows and
  the ambient occlusion off.
- **Bloom and light shafts**: bright things (the sun's disc, glints, lamps, fires) glow softly through
  the game's lens dirt, and looking towards the sun its light streams past what stands against the
  sky, in the weather's shaft colour.
- **The ground** is drawn from the map's own surfaces out to the view distance: each surface's albedo,
  normal map (its relief: sand ripples, stones on paths, cracks, snow crust; and its ambient occlusion)
  and gloss map (wet mud, puddles, ice and asphalt shine and mirror the sky, grass stays matte; scrap
  and metal plates are metal), at the game's own texture size (2048 px on most maps, sent to the GPU as
  the game's own compressed blocks). Where surfaces meet, the one standing higher shows (stony path
  edges break up round their stones, sand fills between ripples; the maps that switch this off keep
  plain weights); the game's detail sets are mixed in by its noise (ice on arena_football_old, oracle
  plates on red_rocks_territory), and within 40 m the displaced surfaces (scrap heaps, pebbles, mud,
  ice) have depth. Only where a pixel covers a few texels of the map's surface map does the ground hand
  over to its colour baked over the whole map, which carries roughness, metal and occlusion too, so no
  ring shows. hangar_newyear's three snow surfaces have their textures in the encrypted packs: they are
  drawn with snow/snow1's, and the panel says so. The weather's cover lies on the ground: snow in New
  Year and arctic weathers, a dark wet film in the rain, a tint in sandstorms.
- **The objects' materials** are drawn as the game blends them: every layer of the layered and
  two-layer map materials, with its tiling and height map, laid where the vertex colours, colour maps
  and heights say: moss and grass on the ledges and tops of rocks, sand on desert plateaus, rust,
  grime, paint and damage on buildings, wrecks and pipes, the forest and cliff layers of backdrop
  mountains. Rocks and cliffs painted by vertex colour keep their layers where the artists painted
  them: vulkan's rusty bridges and dark ice cliffs, chemical_plant's distant mountain with its snow
  streaks, cityruin's bare rock pillars with green caps, the red sandstone tops of arizona_silo and
  sand_valley. Railings, grates, ladders and stencilled numbers are cut out of their first layer; road
  markings and other overlays show as stripes; lamps and lit windows glow by the game's own switch at
  its brightness (windows the game leaves dark stay dark), and the glow pieces the game draws from both
  sides (garland strings, signs, sails) are drawn so, as bright as its night capture shows them (the
  New Year bulbs along eaves and gables); burnt cars and tyres get their fine detail normals up close;
  map windows are see-through and keep their whole reflection; chain-link, nets and water lilies are
  cut out, and windows whose alpha is solid throughout stay solid. A gloss map can make a map surface
  as smooth as roughness 0.05 (glass, puddles, polished metal; vehicle parts keep 0.2); leaves and
  grass without one are matte. A snowy, rainy or dusty weather covers the objects too (snow on rock
  tops, roofs and trees, a dark wet film in the rain); a summer weather takes it away again.
  **Show** > **Material layers** turns the further layers off to compare.
- **Grass**: the tufts the game places on the map (131,450 on bridge, 353,225 on castle; the five
  maps with the game's older grass file, bentmetal and the drone-battle arenas among them, too), drawn
  around the camera and thinned out in the order the game drops them, over the share of its reach the
  game thins each kind over (**Grass up to** sets how far: 40 to 400 m). The blades are cut out of
  their pictures (no solid cards), lit alike on both sides with a faint sheen (not a mirror of the
  sky), as bright as the game makes each kind (ferns and reeds dark), and take the hue and shade of the
  ground they stand on (the game's grass colour maps, with maps of their own under bridges): dry tan at
  the edges of sand and roads, green on the pitch and meadows. When the sun is behind them its light
  comes through. Under the weather's cover they go as the game's do: deep snow (New Year on bridge,
  castle and the hangar) leaves no grass, the blades sinking into it; a sandstorm leaves sand-coloured
  lumps where the scrub was; a light snow, Halloween's film and the lighter rains leave the tufts as
  they are (the gloomiest rains darken them with their wet film). Stones, bricks, snow chunks and
  other solid groundcover are drawn as plain models.
- **Trees**: leaves are cut out at their mask's own edge up close and a little fuller far out (as the
  game's crowns are), let the sun through (broad leaves much more than needles, a little from every
  side and most towards the sun, less through a thick crown), and crowns are darker inside. Leaves
  mirror the sun without a bright rim at grazing angles, so pines seen against the sun stay dark green
  (they glittered white). Under deep snow the bushes and trees turn white all over, as in the game,
  while ivy stays green. Past a model's last level of detail a tree turns into its billboard (which no
  longer stands inside the tree up close), cut at its picture's outline and faded plane by plane as
  its planes turn edge-on. Every cut-out (leaves, grass, fences, grates) has smooth edges (alpha to
  coverage) and keeps its coverage far out, and is shown, and casts its shadow, only once the textures
  that cut it are in. Grass and trees sway in the weather's wind while you fly or drive (a still view
  stays still and costs nothing). Maps with many lamps (newyear_foray at night, hangar_newyear,
  hangar_china) no longer lose the 3D view while their trees load.
- **Water and acid**: every water body and acid pool lies where the game puts it, turned with its
  object (vulkan's sea along the east coast, the pools of drcross, sinto and bentmetal in their
  basins), with the game's own settings: wind or rain waves from its 64 wave frames and detail maps,
  the sky mirrored on it (seen at a low angle as brightly as in the game, so distant rivers and lakes
  no longer read as a dark strip), the sun glinting along the waves, the bed showing through the
  shallows and fading into the water's colour with depth, a soft waterline. Acid
  (customgame_fiery_river's river, the craterarena lakes, pools on factory, the_wall, periphery and
  helicopter_cathedral) is an opaque glossy sheet of its colour; rusty water (island's orange sea) is
  water of its colour. Under the surface the view sinks into the water's colour. The waves move only
  while water is in view.
- **Lights**: the map's own lamps, fires and projectors light what is near the camera (the nearest 16
  point and 8 spot lights, as real lights): porch lamps throw warm pools on the snow, street lamps
  light the road below them, fires the ground round them, hangar lamps their workbenches, searchlights
  shine from bridge's towers. Walls, floors and roofs keep their light from what is behind them, as the
  game's lamps do (each lamp's shadow is drawn once when it comes on, not every frame), and lamps the
  game makes matte (most of them) put no glints on gloss. Every lamp shows the glow of its bulb, and street lamps and searchlights
  a faint beam of light in the air (both drawn with the game's own flare and beam pictures, and dimmed
  by the fog); flickering ones flicker. They are on in the weathers the game switches them on in
  (bridge by day has none; its projectors come with its overcast, New Year dark and Halloween weathers,
  their lamps' glass lit), as bright as the weather lets glowing things look (lost in the noon sun,
  bright at night).
- **Decals**: cracks in the asphalt, moss, ivy, soil, rubbish, dirt and puddles, projected onto the
  ground and the buildings with their relief, showing as much of themselves as the map asks for, in
  their picture's colour times their own colour (or their preset's), and only where their preset lets
  them lie (no metal plates painted over walls and ramps). Puddles, wet coast and wet rust shine,
  decals with a gloss map take their gloss and metal from it, and matte ones stay matte; lava,
  Halloween faces and the light the maps paint under their lamps glow, at the weather's brightness for
  glowing things (the light newyear_foray's garlands paint on its roofs lies on both slopes and fades
  down from the ridge, as in the game); overlapping decals are laid in the map's order. A decal's
  share on an object goes with the object (hidden, or its kind switched off), the ones on the ground
  go with the terrain; each decal stays one mesh to draw.

The panel on the right:
- the map's size, objects and models, how much is drawn now, its grass, decals, lights (with their
  flares and beams) and sky; **Game mode** and **Festival**
  (only the ones that change what is there: a mode's own spawn points and objects, a festival's
  decorations with its weather) load the map again, the camera staying where it is
- **Weather**: every environment the map has (bridge: *Day, clear*, *Overcast, no rain*, *New Year,
  bright*, *New Year, dark*, *Halloween*; the ones only for a festival or another mode say so): its
  sky, light (its own light probe and exposure), fog, cover, lamps and sounds, and the few objects only
  there in it; the map loads again, the camera staying. A weather picked stays through other modes;
  another festival brings its own.
- **Fire** (hold **V**; the panel's **Fire** card picks the gun, the Vector to start with, and its
  **Shot every** the pace, else the game's): the gun
  fires from beside the camera at whatever the middle of the view looks at (a crosshair marks it),
  with its effects, rounds and sounds. Rounds land on the ground, on water (a splash) and on the map's objects, with
  the game's hits for what they hit: rocks and buildings (stone), trees (wood), wrecks, containers
  and other metal (as far as a model's name tells); guided missiles steer to that point.
- **Drive** (toolbar; or **Test drive** in the Vehicle Builder, which opens the map last opened
  here, else the bridge, and sets the vehicle down at team 1's spawn facing team 2): the Vehicle
  Builder's vehicle on the open map, set down where the middle of the view looks at the ground.
  - Keys: **W A S D** (or the arrows) drive, **Space** brakes, drag looks around, the wheel brings
    the camera nearer or farther, **V** fires its guns, **H** sounds its horn. A click on the view
    catches the mouse, as the game has it: moving it aims, its left button fires, **Esc** lets it
    go; **Esc** again (or Drive again, Team 1 / 2, Overview) flies again. A gamepad drives it too:
    the left stick (or the triggers) drives and steers, the right stick looks round, **A** or the
    right bumper fires, **B** brakes, **Y** sounds the horn, **Back** / **Start** ends the drive.
  - How it goes: the game's numbers (its cabin's engine power and top speed, its mass against its
    tonnage (overloaded: slow to pull away), its movement parts' power penalties and speed caps, an
    engine's bonus) on arcade physics: its wheels, tracks, legs or hovers rest on the ground and on
    the map's bridges, ramps and rocks, the body tilts with them, it flies off crests and lands, and
    buildings, cliffs and walls steeper than 50° stop it. Steering (ST) wheels turn it like a car
    (no sharper than its tyres hold at speed); tracks, legs and a vehicle without ST wheels skid
    round, on the spot too.
  - Wheels roll on their own animation as in the game (only the wheel turns, not its arms and
    shocks), the ST ones steer, and each rides its spring over the ground under it, a third of the
    way out (up over a bump, down into a dip, all the way out in the air); the outer ones throw up
    the game's dust for the ground (sand, snow, mud, concrete; skid dust when they skid).
  - Tracks run: their wheels turn (the game's own rotation poses) and the belt with them, standing
    still where it lies on the ground, each side as fast as it goes (turning on the spot, one
    forward and one back), the road wheels riding their springs over the ground under each; an
    auger's screws turn as far as their thread's pitch carries it.
  - Legs walk: each foot stays where it stands until it is a stride behind, then the game's own step
    lifts it ahead, the legs in two sets by turns (diagonal pairs on four legs), each foot set down
    on the ground under it with the game's footstep; longer, quicker strides as it goes faster, and
    let go of the keys the legs stop and step back under it.
  - Hover jets tilt their exhaust back as it pulls ahead (forward to brake or reverse) and out to
    the side as it turns, their turbines turning.
  - Water: it wades, a splash going in, the game's water spray off its wheels and tracks and the
    wading sound, slower the deeper (under a third of its speed a metre deep); hovers ride over the
    water in their own spray, legs splash at each step.
  - What breaks in the game breaks as it drives into it (fences, road barriers, sheds, gun
    emplacements, smaller trees: the game's destruction effect and sound for what it is made of,
    gone until the drive ends or the map loads again; never left out of an export); bushes rustle as
    it goes through. Rounds break it too, driving or flying: a shell, a rocket or an explosive bolt
    at once (an explosion what stands within its blast as well, 2 to 6 m by the round), bullets,
    flames and beams in three hits.
  - Alive: its exhausts smoke (the game's exhaust for its cabin, from the cabin's own pipes); when
    the map's light falls (dusk, night, Halloween) its headlights come on and light the way ahead,
    from its front lamps; what moves by itself moves (a cabin's or an engine's idle: belts, fans, a
    helicopter's rotor, faster with the revs; radars, generators, stabilizers, air cushions' vents,
    a gun's own idle between shots).
  - Its turrets turn to what the middle of the view looks at, within their own limits (the game's
    aim, as Look at me), and fire from there with their Fire clip; a crosshair marks the spot. The
    camera follows behind and over it (it turns back behind a moment after you stop looking around)
    and comes in front of a rock or a wall between them. The speedometer sits where the camera speed
    was.
  - Heard: its engine (a set of the game's loops from idle to top, crossfaded and pitched through
    four gears; the game's own pick for each cabin is in its encrypted data, so a set named like the
    cabin when there is one, else one for its weight), its tyres or tracks on what is under them,
    skids, landings, brakes at speed, the horn.
- **Sounds**: the map's own, from the game's sound banks: the air of its weather and time of day (its
  soundscape for the environment shown: the bridge's day, its cloudy weather, winter nights) with the
  birds, crows, gulls or thunder of it, and what is placed on the map, where it stands: burning
  wrecks, windmills, crickets, rain on a roof, generators, rivers and marshes along their course.
  The nearest few play as you fly about. As loud as the Sound setting; off with **Show** >
  **Sounds** (remembered), quiet while the window is in the background. The info card names the
  soundscape.
- **Effects**: the map's own, from the game's particle files: fires, burning tyres, torches, smoke
  columns, steam, water leaks, sparks and antennas' signals where they stand (4,347 over the maps;
  the nearest 24 within their reach play, the ones near the camera already going; fires with a
  light of their own light what is around them), and its weather's snow, rain, ash, petals, fluff or dust around the camera
  (none under bridges and roofs the map marks); in the rain, drops on the lens too (the game's own,
  bending the view behind them). Lit by the map's light and standing in its fog; a night's lamps and
  lit windows shine brighter. They move on 30 times a second; off with **Show** > **Effects**
  (remembered), stopped while the window is in the background. The info card counts them and names
  the weather's.
- **Show**: terrain, props, trees & plants, objects, water, spawn points, grass, decals, lights,
  material layers, game sky (off: a plain sky and light, with a plain haze), sounds, effects; **View
  distance** (300 to 8,000 m; each map opens at its own, out to its farthest objects); **Grass up to**;
  **Detail** (how far out models keep their finer levels); **Textures up to** 256 / 512 / 1024 /
  2048 px (1024 at first; video memory; the map loads again)
- **Not shown**: objects the game builds from definitions in its encrypted archives with no model
  of a matching name or placement: 18,953 placements of 335 definitions over the 94 maps, every mode
  and festival counted (scrap and car-part heaps, wrecks, barrel groups, light poles ...; `mapinfo`
  lists them per map). Since that count, the brick walls of castle and castle_artillery and the fallen
  garbage columns (37 and 38 more placements) are left out too: their names had matched a 45 m
  factory wall and a 50 m monorail pillar that the game's captures do not show. Parking posts are posts
  (their name had put 144 m multi-storey garages on cityruin and six other maps). Fences and railings,
  barrel heaps, crates, taxis in their colours, bus stops, pavilions, market stalls, balconies and
  lamps are placed.
- **Selected** (with a selection): see above
- **Export map**: GLB / glTF / OBJ of the map as shown (game mode, festival, weather; hidden objects
  left out), with or without the terrain and its ground (colour, relief and roughness baked at 2048 /
  4096 / 8192 px), props, trees, objects, water, decals, grass (all of it, a half, a quarter or a
  tenth), the sun and the sky panorama (1024 / 2048 / 4096 px), at a LOD, textures up to a size. Big
  maps make big files.

The same from the command line, with `xotest`:

```
build\xotest.exe maps                              every map: size, props, trees, objects, water
build\xotest.exe mapinfo bridge [--models]         surfaces, object counts, water and acid, definitions with no model
build\xotest.exe map bridge out\bridge.glb         terrain (colour, relief, roughness) + props + trees + objects + water + decals
build\xotest.exe ground bridge out\ground.png 4096 only the baked ground colour
build\xotest.exe sky bridge out\sky.hdr 2048      only the sky panorama: the game's light probe (.png: graded like the view; --computed: worked out from the atmosphere)
build\xotest.exe probe bridge 664236 out\p.hdr     an environment's light probe as a panorama (.png: graded like the view; --diffuse, --fog, --level n, --local)
build\xotest.exe probescan [map ...]               every environment's light probes and the exposure they give against its EV100 range
build\xotest.exe envinfo bridge | grassinfo bridge | decalinfo bridge   the environment, grass, decals
build\xotest.exe envscan [map ...]                 every map's environments (the Weather menu), effects and weather boxes
build\xotest.exe envkeys AreaEffect,EmissiveLumScale  those values of every environment
node tools\glb_preview.mjs out\bridge.glb out\top.png --top        headless picture from above
node tools\glb_preview.mjs out\bridge.glb out\view.png --cam -95,40,-120 --target 5,8,-15 [--game-light]
```

`map` options: `--lod N`, `--tree-lod N`, `--ground <px>` (0 = untextured terrain), `--step N`
(every Nth height sample), `--max-tex <px>` (default 1024; maps hold hundreds of textures),
`--no-props`, `--no-objects`, `--no-trees`, `--no-water`, `--no-textures`, `--no-decals`,
`--grass <share>` (0 to 1; default none), `--no-sun`, `--sky <px>` / `--no-sky`, `--no-clouds`,
`--computed-sky` (the sky worked out from the atmosphere instead of the game's light probe), `--gameplay <mode>`
(default: the map's main mode, Assault where it has one), `--festival <name>` (default none:
`Halloween`, `NewYear` ... add their decorations and use their weather; `mapinfo` lists the ones a
map has), `--env <id>`; `.gltf` and `.obj` work too. Coordinates are the game's (metres), with Z
mirrored like the parts. What comes out:
- the terrain in 128 x 128-quad chunks with three baked textures over the whole map (4096 px): its
  colour from the map's ground textures, blended by height as the view does, a normal map of the
  surfaces' relief (`terrain_ground_n.png`) and occlusion / roughness / metal
  (`terrain_ground_orm.png`, glTF's metallic-roughness texture, and its occlusion texture with
  **Ambient occlusion in the material**); OBJ gets the colour and the normal map
- props and objects as nodes in groups (`props`, `trees`, `objects`), every model stored once. A
  two-layer material whose blend needs nothing but its textures is baked into one albedo / normal /
  ORM set (`<first>_<second>_<hash>.png`, e.g. `concrete_damaged_a_concrete_crack_a_ca2c7b58.png`);
  the others export their first layer, with every layer described in `extras.layers` (tiling, UV kind,
  inverted height, blend parameters; `layerWeights`) and named in `extras.textures`. Glow maps export
  at their brightness (`KHR_materials_emissive_strength` above 1), flat-colour overlays (road markings)
  as see-through stripes, tree leaves cut out (no billboards: those are only in an export of the tree
  alone), map-prop transparency by the materials' own switches
- water see-through by transmission (`KHR_materials_transmission`, `KHR_materials_ior` 1.333,
  `KHR_materials_volume`: as thick as the water is deep on average, its colour deepening with its
  density), its waves as a normal map; acid opaque in its colour; both turned with their objects as in
  the view. OBJ: the water's colour with `Ni 1.333` and `d 0.7`
- decals as meshes lying on the ground and the buildings (only where their presets let them lie), one
  blended material per kind with its look baked into a texture (colour, and in alpha where it shows),
  its relief as a normal map and its gloss and metal; the vertex colours' alpha fades them at the box's
  ends (OBJ: the texture's alpha, no fade)
- grass as copies of each kind's model (`EXT_mesh_gpu_instancing`), brightened per kind as the game
  does: every blade triangle is in it twice, once reversed, so both sides are lit alike in Blender too
  (which darkens the back of a double-sided face), and each copy carries the tint of the ground under
  it (`_COLOR_0`, which three.js reads; Blender ignores it); stones, bricks and snow chunks as they are.
  Small files, but Blender turns every tuft into an object of its own: keep the amount low for
  Blender. OBJ has no copies: no grass
- the sun as a glTF light (`KHR_lights_punctual`; Blender reads it as a Sun lamp) and the sky as
  `<file>_sky.hdr` beside the export: the game's own light-probe capture of the map (its sky, clouds,
  haze and far land; worked out from the atmosphere where there is none, or with `--computed-sky`),
  without the sun's disc (the lamp is the sun, at the share the view lights with). Both are the game's
  light at the view's exposure, so they match each other as in the view. In Blender: World > Color >
  Environment Texture > open the `.hdr`, strength 1; it lines up with the map as imported. The file's
  `asset.extras` names the environment, its exposure (EV100 and the factor on the game's light) and
  the view's fog in one line (the height fog's density, height, halving and start, its colour, the
  air's haze)
- not: the map's lights and the decals' glow, and the placements whose definition has no model found
  (listed by `mapinfo`)

## Donations and bug reports

The top bar's **Donations** and **Bug report** (`ui/support.js`; the host's side `src/app/report.cpp`).

- **Donations**: one page with the donation platforms' buttons (they open in the browser), the
  official download and the fan-project notice. No pop-ups or reminders anywhere else. The links
  are in `ui/support.json`: user names for GitHub Sponsors, Ko-fi, Liberapay, Open Collective,
  Patreon, Buy Me a Coffee, Polar (the keys of `.github/FUNDING.yml`) and up to four custom https://
  links; empty ones are not shown. `repo` is the official GitHub repository (the official download,
  the bug report form, the known issues).
- **Bug report**: GitHub's issue form (`.github/ISSUE_TEMPLATE/bug_report.yml`), opened with the
  version and the details filled in; the details shown and copied (version, Windows, CPU, memory,
  graphics cards and drivers, WebGL, WebView2, the display, the game's version, where in the app,
  the view's settings, the problems seen, the log's last lines); the log folder. No files, names or
  emails: the user's folder, user name and computer name are taken out of everything.
- **Anonymous reports** (only in a build with a report address): **Send report**, or by themselves
  once **Send crash reports automatically** is ticked (off until then). A report is a Sentry
  envelope: the event (the error or crash, the steps before it, the machine as contexts), the log's
  last 300 lines and, after a crash of the app, its minidump. At most 20 a day; none while Sentry
  asks to wait. No text a person typed is ever sent, so nothing abusive can arrive that way.
- **Crashes**: an unhandled exception, an uncaught C++ exception, an invalid CRT parameter, a pure
  virtual call or abort() leave a minidump and a summary in the data folder's `crashes\`; the page's
  own process ending (WebView2) leaves a summary. The next start shows the crash dialog: send,
  don't send, view what would be sent, copy, open a GitHub issue, open the log folder.
- **The log**: `%LOCALAPPDATA%\Grimcold\logs\grimcold.log`, 5 files of 1 MB at most:
  the app's start, the page's errors and warnings, WebView2's processes ending, reports sent.

To turn reports on, make a Sentry organisation in the **EU** region (it cannot be moved later) and a
project for the app. In its settings, keep data scrubbing on and turn on **Prevent Storing of IP
Addresses**; under Client Keys, set a rate limit. Then build with its DSN:

```
set SENTRY_DSN=https://<key>@o<org>.ingest.de.sentry.io/<project>
build.cmd app
```

The DSN goes into the exe only (`build\gen\buildinfo.h`), never into the source. A build without it
sends nothing. To read crashes' stacks in Sentry, upload the PDBs from the same build
(`sentry-cli debug-files upload`); do not ship them. `PRIVACY.md` says all this for users.

## Keeping a game version

The launcher updates the game in place, so the exporter always sees the newest version. To keep the
current one (for when the game changes or goes offline), copy it out:

```
powershell -ExecutionPolicy Bypass -File tools\archive_game.ps1
```

It copies the install to `%USERPROFILE%\CrossoutArchive\Crossout <version>\` (about 17 GB; the
launcher's logs left out), checks every file against the install (SHA-256) and every file inside the
archives against the game's own MD5s (`xotest md5`), writes `SHA256SUMS.txt` and `README.txt`, and
marks the copy read-only. `-Verify "<snapshot>"` checks a snapshot later. Close the game and the launcher
first (the script refuses while they run: they may be updating the files). To use a snapshot, click the
game folder button at the top left and choose its folder; the version tag beside it (and the status bar) shows the version
(`2.40.10.361437 (661aac453)`: the build number is read from the version text, the binary field
only holds 16 bits of it).

Kept so far: **2.40.10.361437 (661aac453)**, game data of 2026-09-18, made 2026-10-01.

### About putting edits back into the game

This tool deliberately does not write modified files into Crossout: exports, extracts and saves
into the game's folder are refused. The current Gaijin
EULA/Code of Conduct bans modifying the game client with no exception for cosmetic mods. Also,
the launcher verifies and repairs game files, and the game is protected by BattlEye, so
modified archives would be reverted or could get the account flagged. Recolours and retextures
live in the viewer and in your exports.

## Building

Needs Visual Studio 2022 (C++ desktop workload) and the WebView2 runtime (part of Windows 11).
Everything else is in the repo:
- WebView2 SDK headers + static loader
- `libzstd.dll` 1.5.7, BSD, from Git for Windows
- three.js r174 (MIT) in `ui/lib/three`
- the shared `ujson` header

```
build.cmd          test tool + app
build.cmd core     only build\xotest.exe
build.cmd app      only Grimcold.exe
```

To run the app, `Grimcold.exe` needs `libzstd.dll` and the `ui` folder next to it.
`powershell -ExecutionPolicy Bypass -File tools\package.ps1` puts them, with the licence and notices,
into the release zip (`dist\Grimcold-<version>-win64.zip`, and its SHA-256 beside it).

## Tests

```
build\xotest.exe scan                  parse + decode all 12,754 models
build\xotest.exe md5 models/weapons    extract files and check each against the MD5 in the .index
build\xotest.exe texscan               parse every texture, decode a mip of each (cube maps and arrays: their last layer too), count the layered ones
build\xotest.exe texsample 3 <dir>     DDS + our PNG per format (to hold against other decoders)
build\xotest.exe export <model.mdl> <out.glb|.gltf|.obj> [--all-lods] [--skin s] [--dds] [--extra]
build\xotest.exe scene <out> <path@x,y,z[,yaw[,m]]>...   several placed parts in one file
build\xotest.exe emisscan [prefix] [list]  glow-map slots by shader, suffix and parameters
build\xotest.exe lampscan [prefix] [shader]   lamp-shader (or 644d00c3) pieces: textures, pins, both UV sets, the texels they hit
build\xotest.exe matscan [prefix ...]  materials the view may draw wrong: unknown shaders, additive layers, no texture, unshown slots
build\xotest.exe flagscan [prefix ...] every material's look flags (blend, alpha test, glow, UV set), to diff two builds
build\xotest.exe geoscan [prefix ...]  mesh health: bad numbers, inside-out meshes, tangents against the UVs, LOD boxes, skins
build\xotest.exe texrole [prefix ...]  material textures by role: sRGB flags, each normal map's layout scored, gloss channels
build\xotest.exe posescan [param|*] [prefix]  pose layers (AimPitch by default; * = all): range order, how far each clip turns, bones found; with * also which layers play together (DOUBLE / NOSLIDER / RANGES)
build\xotest.exe animdump <x.anim> [keys]  a clip's tracks and keys (rotations as angle + axis)
build\xotest.exe exportall 300 <dir> [prefix]   export 300 models spread over the list, then:
node tests\validate_gltf.mjs <file|dir> structural glTF 2.0 validation, instancing and lights too (a folder checks every file)
node tools\e2e.mjs [--snap-dir d]      3D Viewer, textures, imports, exports, material outlines, firing (effects incl. 2.41's motion-vector flip-books, rounds, beams, launchers, lights, haze, sound), headless (cloaked window, DevTools protocol)
node tools\e2e_build.mjs [--snap-dir d] Vehicle Builder with real clicks and keys (V fires the vehicle), export, autosave across a restart
node tools\e2e_quit.mjs                closing the app mid-export cancels it quickly and leaves no half-written file
node tools\e2e_fixes.mjs               regression checks for the bugs a 2026-10-01 review found, each set up the way it was found
node tools\e2e_rebuild.mjs             the rebuilding aids: parts checklist and reference pictures (with a restart)
node tools\e2e_place.mjs               a held part's snap (the cursor swept over a cabin: welded, no jumps, sliding past a part, kept off the edge) and its turns (R / T / Y, Q / E and the card's arrows as seen, shown turning)
node tools\e2e_maps.mjs                Maps mode with real keys and mouse: list, flying (W A S D, Space, Shift, 1-9, wheel, drag), sky, grass, decals, toggles, modes, selecting objects (click, Ctrl, box, F, H, Esc), firing (V), exports
node tools\e2e_look_ibl.mjs            Maps' light from the game's light probes: the capture and its place, the exposure, the sun in the same units (at the captures' share), the camera (white balance, curve, LUT; Maps only), other weathers, a hangar hall's own probe, the export's sun and sky
node tools\e2e_look_atmos.mjs          the height fog (scenery, sky, particles) and the air's haze, the view distance, the sun's cascaded shadows, the terrain's own light, bloom, lens dirt and light shafts
node tools\e2e_look_terrain.mjs        the ground: the surfaces' arrays, normal and gloss maps, height blending, parallax, detail sets, the weather's cover, the export's terrain maps
node tools\e2e_look_water.mjs          water and acid: the water shader, waves, shallows, the glint, under water, turned outlines, a round hitting it, the export
node tools\e2e_look_mats.mjs           map props' materials: further layers, overlays, glow switches, detail normals, glass, snow on props, Show > Material layers, baked exports
node tools\e2e_look_veg.mjs            grass tints and brightness, light through blades and leaves, crowns, billboards, wind, the export's grass
node tools\e2e_look_scene.mjs          a map's own lights (pools, flares, beams, by weather; Show > Lights; their shadows: nothing lit behind walls, checked against rays from the lamps), the decals' preset switches, objects found for more definitions (hangar_china's parking posts)
node tools\e2e_support.mjs             Donations and Bug report: the pages, the links, the details (no user or computer name), GitHub's form filled in, the page's errors, reports to a stand-in for Sentry, a real crash and its minidump sent
node tools\e2e_reports.mjs             the reports' hard cases: every kind of crash (access violation, stack overflow, uncaught C++ exception, abort, invalid parameter, pure call), the page's and the GPU process crashing, names taken out in every spelling, the log rotating, the server down / failing / busy, 20 a day, 10 crashes kept, automatic reports at the next start
node tools\e2e_warmup.mjs              Maps' shaders built ahead: a map's shader recipes kept, built in the garage while idle after a restart (none while the mouse moves), the map then asking for none that was not
node tools\e2e_all.mjs                 all 17 suites in turn, summed up
node tools\fxcheck.mjs [filter] [--list n]   read every particle effect and play the one-shot ones: how well the space they fill matches the bounds the game stored
node tools\gunsweep.mjs [filter] [--json f]  fire every gun of the game once at the target: effects, round models and sounds found, rounds landing, hits on it, page errors
build\xotest.exe sounds [substring] | sound <name> <out.ogg> | soundscan   the sound banks' samples; one as Ogg Vorbis; every one converted and its Ogg pages checked
python tools\vorbis_setups.py         rebuild src\xo\VorbisSetups.inc (the Vorbis setup headers the banks need) with a local libvorbis
powershell -File tools\archive_game.ps1 [-Verify <snapshot>]   keep a copy of the installed game version (see above)
python tools\stats\make_stats.py       rebuild ui\stats.json from the item table saved beside it
build\xotest.exe meshes <model.mdl>    every mesh's LOD, material, layout and raw words
build\xotest.exe vdump <model.mdl> <mesh> [n]   raw vertex bytes next to the decoded position
build\xotest.exe treescan | v9scan     trees' draw ranges, version-9 LOD headers
build\xotest.exe lodscan [prefix] [n]  models' LOD switch values next to their size
build\xotest.exe shaderscan <prefix> | pinscan <prefix> <shader>   material shaders, their pins vs albedo alpha
build\xotest.exe extractall <prefix> <dir> [suffix ...]   copy game files out (for reading the map XML)
```

The app's test flags (used by the tools above): `--data-dir`, `--game-dir`, `--debug-port`,
`--headless`, `--pos x,y`, `--size w,h`, `--devtools`. The node tools share `tools\cdp.mjs`,
which starts the app on a throwaway profile and a free debugging port (suites run side by side no
longer drive each other's app) and deletes the profile once the app has exited; set
`XO_EXE` to test another build of the app sitting beside `Grimcold.exe`.

## Source map

| path | what |
|---|---|
| `src/xo/Archive.*` | `.index` / `.grp` reader (chunked zstd, MD5) |
| `src/xo/Model.*` | TCF MODEL parser, vertex decoding, glTF space conversion |
| `src/xo/Material.*` | `.mdf` / `.skins` parsing, texture roles |
| `src/xo/Texture.*` | `.tfh`/`.tfd` (layers, cube maps), format codes, BC1-5/BC6H/BC7 and R11G11B10F decoders, normal unpacking, DDS writer |
| `src/xo/Image.*` | WIC PNG writer / image reader, TGA and DDS readers, colour edits (same maths as the viewer shader) |
| `src/xo/Paint.*` | paints baked into an export's textures: a colour, a pattern over each part's second UV set (texel by texel, with its mips), a chameleon's mean colour, a pattern's relief into the normal map |
| `src/xo/Export.*` | model bundles, GLB / glTF / OBJ export of one part or a whole build (or map), viewer geometry packing |
| `src/xo/Map.*` | maps: terrain tiles, surfaces and their texture sets, ground bakes (colour, normal, occlusion / roughness / metal), the terrain's light bake, props, entities (definition -> model), water and acid, lights, filters, grass (and its tints), decals (projection, baked looks), environments, atmospheres and light probes, export |
| `src/xo/Sky.*` | the game's sky on the CPU for exports (the light probe's capture, or the view's atmosphere model and cloud cards), light levels and exposure, white balance and the view's grade, the sun's light, Radiance `.hdr` writer |
| `src/xo/Sound.*` | the FMOD sound banks: their FSB5 samples listed, one as an Ogg Vorbis file (headers rebuilt; `VorbisSetups.inc` by `tools/vorbis_setups.py`) |
| `src/app/main.cpp` | window, WebView2, `https://xo.data/` endpoints, bridge commands (only from the app's own page; files dropped on the window and navigations away are refused; writes into the game folder are refused) |
| `src/app/report.cpp` | Bug report's host side: the log (redacted, rotated), crashes caught (minidump + summary for the next start), the machine's details, reports sent as Sentry envelopes (only with a DSN built in: `build\gen\buildinfo.h` from %SENTRY_DSN%) |
| `ui/` | HTML UI; `viewer.js` is the three.js view (BC textures go to the GPU as-is, the materials (map props' further layers, glow switches, detail normals, the weather's cover, the leaves' cut), shadows, weld points, lift, part pictures, projectiles riding a launcher's deploy bones), `mapview.js` Maps mode (instanced models with LODs, the terrain's surfaces (texture arrays, height blend, detail sets, parallax, the weather's cover), grass, decals, the view distance, the flying camera, picking and selecting objects, the minimap), `sky.js` the game's sky and light (atmosphere, sun, clouds held to the light probe's capture, the probe as the map's light, how bright a weather is, its exposure and white balance), `fog.js` the game's height fog and the air's haze (on every material, the sky, the clouds, particles and lamps), `shadows.js` the sun's cascaded shadows and the light the terrain's hills leave it, `water.js` the water and acid, `foliage.js` grass and trees (tints, light through, crown shade, wind, billboards), `maplights.js` a map's own lights (real lights, flares, beams), `lampshadows.js` their shadows (a cube per lamp in one atlas) and gloss switch, `support.js` Donations, Bug report and the crash dialog (the page's errors noted, the details, reports), `weather.js` the Weather menu's names, `mapfx.js` a map's own effects and its weather's (snow, rain, ash ...), `drive.js` Drive (the builder's vehicle on a map), `drivesound.js` its engine, wheels and horn, `post.js` the ambient occlusion + tone mapping pass (in Maps the game's camera: white balance, ACES curve, LUT; bloom, lens dirt, light shafts) and the outlines (cut-outs kept, foliage as one crown), `build.js` the Vehicle Builder, `garage.js` its garage HUD (energy bar, part card, parts list, vehicle stats, camera keys), `checklist.js` and `refs.js` the rebuilding aids (parts list by name, reference pictures), `phys.js` the game's collision hulls and the overlap test, `anim.js` the animation player (and when a gun fires), `belts.js` belts, chains and tracks running with the wheels they wrap, `fx.js` the game's particle effects read and played, `fxview.js` them drawn (and the rounds flying and landing), `fxmap.js` which gun fires which and what its rounds are and hit with, `sound.js` the game's sounds played where they happen, `soundmap.js` which samples a gun's shots, hits and blasts use, `firing.js` firing in the Vehicle Builder and on maps (V), `paints.js` the game's paints (the catalog from `textures/patterns`, their names) and the paint picker, `ambience.js` a map's own sounds (its soundscape and placed sounds), `recorder.js` Record (the view and its sounds as a video clip), `arcs.js` the firing arcs, `names.json` the in-game names, `stats.json` the part stats |
| `tools/stats/` | `make_stats.py`, which builds `ui/stats.json` from crosscalc.net's item table saved there (`cc_items.json`, `cc_types.json`: not published with the source) |
| `CROSSOUT_FORMATS.md` | the file formats, as reverse-engineered for this tool |
