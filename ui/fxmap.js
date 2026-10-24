// Which muzzle effect (particles/...psys) a gun fires with. The game says so in its item data,
// which sits in the encrypted packs this app does not open, so the table below matches weapon
// folders to the effects' own names (rarity words: common, rare, special / preepic, epic, legend,
// relic) and to what each gun is (cannon, autocannon, shotgun, ...). The 3D Viewer's Effects menu
// can pick any other effect for a part.

const W = 'weapons/';
const MG = W + 'machinegun/', CAN = W + 'cannon/', SG = W + 'shotgun/', MIS = W + 'missile/';
const WM = 'models/weapons/', PJ = WM + 'projectiles/', AR = WM + 'crossbow_arrow/'; // (models: what rounds fly as)

// weapon folder (models/weapons/<folder>/...) -> effect (under particles/, no extension)
const BY_FOLDER = {
  // machine guns
  machinegun_side_browning1919: MG + 'muzzle_machinegun_common',
  machinegun_browning: MG + 'muzzle_machinegun_common',
  machinegun_kpvt: MG + 'muzzle_machinegun_rare',
  machinegun_kpvt_double: MG + 'muzzle_machinegun_rare',
  machinegun_side_kpvt_double: MG + 'muzzle_machinegun_rare',
  machinegun_preepic: MG + 'muzzle_machinegun_special',
  machinegun_frontal_preepic: MG + 'muzzle_machinegun_special',
  machinegun_auto: MG + 'muzzle_machinegun_epic',
  machinegun_kmtp: MG + 'muzzle_machinegun_epic',
  machinegun_legendary: MG + 'muzzle_machinegun_legend',
  machinegun_frontal_legend: MG + 'muzzle_machinegun_legend',
  machinegun_relict: MG + 'muzzle_machinegun_relic',
  machinegun_2modes_legend: MG + 'muzzle_machinegun_2modes',
  machinegun_heavy_epic: MG + 'muzzle_machinegun_heavy',
  machinegun_heavy_legend: MG + 'muzzle_machinegun_heavy_uniq',
  machinegun_smg: MG + 'muzzle_smg_special',
  machinegun_smg_2: MG + 'muzzle_smg_epic',
  machinegun_smg_3: MG + 'muzzle_smg_leg',
  // miniguns
  minigun_m134: MG + 'muzzle_minigun',
  minigun_gsh623: MG + 'muzzle_minigun_heavy',
  minigun_explosive: MG + 'muzzle_minigun_heavy',
  minigun_legendary: MG + 'muzzle_minigun_legend',
  minigun_relict: MG + 'muzzle_minigun_relict',
  // autocannons
  autocanon_cmflak: MG + 'muzzle_auto_cannon',
  autocannon_closecombat: MG + 'muzzle_auto_cannon',
  autocanon_preepic: MG + 'muzzle_auto_cannon_preep',
  autocannon_preepic_short: MG + 'muzzle_auto_cannon_preep',
  autocannon_epic: MG + 'muzzle_auto_cannon_2',
  autocannon_2x: MG + 'muzzle_auto_cannon_2',
  autocannon_middlecombat: MG + 'muzzle_auto_cannon_2',
  autocannon_revolver_epic: MG + 'muzzle_auto_cannon_2',
  mark38_mod2: MG + 'muzzle_auto_cannon_big',
  autocannon_legend: MG + 'muzzle_auto_cannon_big',
  autocannon_legend_02: MG + 'muzzle_auto_cannon_big',
  autocannon_airdefense: MG + 'muzzle_auto_cannon_big',
  autocannon_relict: W + 'autocannon/muzzle_autocannon_long_relic',
  // cannons
  heavygun_6pounder: CAN + 'tank_cannon_muzzle',
  heavygun_zis3: CAN + 'tank_cannon_muzzle',
  heavygun_turret_6pounder: CAN + 'tank_cannon_muzzle',
  heavygun_turret_zis3: CAN + 'tank_cannon_muzzle',
  heavygun_preepic: CAN + 'tank_cannon_muzzle_preepic',
  heavygun_turret_preepic: CAN + 'tank_cannon_muzzle_preepic',
  cannon_oneshot_preepic: CAN + 'tank_cannon_muzzle_preepic',
  heavygun_flak88: CAN + 'tank_cannon_big_muzzle',
  heavygun_turret_flak88: CAN + 'tank_cannon_big_muzzle',
  cannon_ballistic_epic: CAN + 'tank_cannon_muzzle_epic',
  heavygun_2types_legend: CAN + 'gun_2type_muzzle',
  cannon_assault_legend: CAN + 'cannon_threeshot_epic_muzzle',
  autocannon_revolver: CAN + 'cannon_two_modes_muzzle',
  cg_gun: CAN + 'tank_cannon_muzzle_leg',
  tankgun_relict: CAN + 'tank_cannon_relic_muzzle',
  relict_double_gun: CAN + 'tank_relic_muzzle',
  t_34_cannon: CAN + 'tank_t34_muzzle_frost',
  ballcannon: CAN + 'tank_cannon_muzzle',
  cannon_ship_legend: W + 'cannon_ship_legend_muzzle',
  corrosion_gun_legend: CAN + 'cannon_corrosion_legend_muzzle',
  // shotguns
  shotgun_xm174: SG + 'shotgun_muzzle_rare',
  shotgun_side_xm174: SG + 'shotgun_muzzle_rare',
  shotgun_striker: SG + 'shotgun_muzzle',
  shotgun_qbz_double: SG + 'shotgun_muzzle_special',
  shotgun_side_qbz_double: SG + 'shotgun_muzzle_special',
  shotgun_preepic: SG + 'shotgun_muzzle_special',
  shotgun_side_preepic: SG + 'shotgun_muzzle_special',
  shotgun_piper: SG + 'shotgun_epic_muzzle',
  shotgun_relict: SG + 'relic_shotgun_muzzle',
  shotgun_course: SG + 'shotgun_course_muzzle_special',
  shotgun_course_epic: SG + 'shotgun_course_muzzle_special',
  shotgun_course_legend: SG + 'shotgun_muzzle_legend',
  shotgun_flak01: SG + 'canonn_shotgun_muzzle',
  shotgun_garbage_epic: SG + 'shotgun_oneshot_muzzle_epic',
  shotgun_garbage_legendary: SG + 'shotgun_oneshot_muzzle_legend',
  shotgun_garbage_relict: SG + 'shotgun_oneshot_relic_muzzle',
  shotgun_midrange_legend: SG + 'middlrange_leg_muzzle',
  shotgun_popup_legend: SG + 'shotgun_popup_leg_muzzle',
  shotgun_2barrel_revolver_legend: SG + 'shotgun_revolver_legend_muzzle',
  shotgun_spreadburst_legend: MG + 'muzzle_shotgun_spreadburst_legend',
  shredder_gun_01: SG + 'heavy_shotgun_muzzle',
  tribal_trashgun: SG + 'shotgun_muzzle_common',
  shotgun_syfy: W + 'laser_shotgun_muzzle',
  // grenade launchers, mortars
  grenade_launcher: W + 'ags_muzzle',
  grenade_launcher_4x: W + 'retcher_muzzle',
  grenade_launcher_epic: W + 'ags_4x_muzzle',
  grenade_launcher_burst: W + 'ags_4x_muzzle',
  grenade_launcher_6x_relict: W + 'ags_6x_muzzle',
  grenade_launcher_2types_legend: W + 'ags_6x_muzzle',
  grenade_system: W + 'mortar_muzzle',
  mortar_cannon: W + 'mortar_muzzle',
  catapult: W + 'mortar_muzzle',
  bomb_launcher_2x_legend: W + 'mortar_muzzle',
  sticky_bomb_launcher: W + 'sticky_launcher/sticky_launcher_muzzle',
  rpg_rocket_launcher_legend: MIS + 'missile_launch_frwrd',
  // rockets
  nurs_single: MIS + 'missile_launch',
  nurs_dble: MIS + 'missile_launch',
  nurs_multy: MIS + 'missile_launch',
  nurs_preepic: MIS + 'missile_preep_launch',
  nurs_legend: MIS + 'missile_launch',
  nurs_turret: MIS + 'missile_launch',
  nurs_turret_auto: MIS + 'missile_launch',
  missile_8x_legend: MIS + 'missile_launch',
  missile_20x_legend: MIS + 'missile_launch',
  missile_38x_legend: MIS + 'missile_launch',
  airstike_launcher: MIS + 'missile_launch',
  guided_single: MIS + 'homing_missile_launch',
  guided_multy: MIS + 'homing_missile_launch',
  guided_support_epic: MIS + 'homing_missile_launch',
  guided_lockon_oracle: MIS + 'homing_missile_launch',
  guided_control: MIS + 'missile_launch_ptur',
  missile_laser: MIS + 'missile_ptur_launch',
  missile_laser_legend: MIS + 'missile_ptur_launch',
  missile_3x_front_epic: MIS + 'tripple_missile_launch',
  missile_3x_relict: MIS + 'tripple_missile_launch',
  missile_3x_spiral_legend: MIS + 'spiral_missile_launch',
  missile_plasma_epic: MIS + 'plasmamissile_launch',
  rocket_artillery_legend: MIS + 'artillery_launch',
  frost_artillery_epic: W + 'artillery_rapidfire_muzzle',
  // energy weapons
  fusiongun: W + 'fusion/fusion_muzzle',
  fusiongun_epic: W + 'fusion/fusion_epic_muzzle',
  fusiongun_legendary: W + 'fusion/fusion_leg_muzzle',
  fusiongun_relict: W + 'fusion/fusion_relict_muzzle',
  plasma_launcher: W + 'plazma/plazma_muzzle',
  plasma_launcher_legendary: W + 'plazma/plazma_muzzle_legend',
  plasma_ball_lightning: W + 'plazma/plazmaball/plazmaball_muzzle',
  plasma_cutter: W + 'plazma/plazma_cutter_muzzle',
  plasma_drill: W + 'plasmadrill/plasmadrill_muzzle',
  plasma_drill_legendary: W + 'plasmadrill/plasmadrill_leg_muzzle',
  plasma_shield_launcher_legend: W + 'ion_shield/ion_shield_launch',
  tesla_gun: W + 'tesla/teslagun_muzzle',
  tesla_gun_relict: W + 'tesla/teslagun_relic_muzzle',
  gatling_laser: W + 'particle_beam_muzzle',
  lightning_gun: W + 'lightning_gun/lightninggun_muzzle',
  revolver_laser_legend: W + 'laser_revolver_muzzle',
  coilgun_legend: W + 'coilgun_muzzle',
  railgun_turret: W + 'railgun_muzzle',
  railgun_quadro: W + 'railgun_muzzle',
  railgun_legend: W + 'railgun/oracle_gun_muzzle',
  railgun_ballista_epic: W + 'railgun/sniper/railgun_sniper_muzzle',
  railgun_self_damage_epic: W + 'selfdamage_muzzle',
  impulse_carabine: W + 'carabine_muzzle',
  // other guns
  nail_gun: W + 'nail/nail_muzzle',
  nail_gun_epic: W + 'nail/nail_muzzle_epic',
  revolver_gun: W + 'revolver_muzzle',
  revolver_legend: W + 'revolver_muzzle_magnum',
  harpoon_epic: W + 'harpoon_muzzle',
  turret_harpoon_launcher_legendary: W + 'harpoon_muzzle',
  // crossbows
  crossbow_double01: W + 'crossbow_muzzle',
  crossbow_epic: W + 'crossbow_muzzle',
  crossbow_rocket: W + 'crossbow_muzzle',
  trible_crossbow: W + 'crossbow_muzzle',
  crossbow_burst: W + 'crossbow_burst_muzzle',
  crossbow_tempo: W + 'crossbow_tempo_muzzle',
  crossbow_tempo_legend: W + 'crossbow_speed_muzzle',
  crossbow_ballista_legend: W + 'crossbow/ballista_legend_muzzle',
  crossbow_revolver_relict: W + 'crossbow/revolver_crossbow_relict_muzzle',
  rail_crossbow: W + 'crossbow/crossbow_railgun_muzzle',
  // flamethrowers (their flow loops while they fire)
  flame_thrower: W + 'flamethrower/flamethrower_flow',
  flmthrow_course: W + 'flamethrower/flamethrower_flow',
  side_flamethrower: W + 'flamethrower_pest',
  frost_thrower_epic: W + 'frostgun/frostgun_proto',
  frost_gun_legend: W + 'frostgun/exhaust_frostgun',
  // launchers of mines, wheels, saws, blades
  barrel_launcher: W + 'barrel_mine_muzzle',
  wheel_launcher: W + 'wheel_launcher_muzzle',
  wheel_launcher_epic: W + 'wheel_launcher/wheel_launcher_epic_muzzle',
  saw_launcher_relict: W + 'saw_launcher_muzzle',
  saw_launcher_legend: W + 'saw/saw_launcher_leg_muzzle',
  blade_launcher_legend: W + 'blade_launcher_muzzle',
  train_wheel_launcher_legend: W + 'train_wheelspeed_muzzle',
  disc_gun: W + 'saw_launcher_muzzle',
};

// a few skins and looks fire another effect than their gun
const BY_MODEL = {
  'models/weapons/autocannon_2x/autocannon_2x_cybereast.mdl': MG + 'muzzle_auto_cannon_cyberskin',
  'models/weapons/t_34_cannon/t_34_cannon.mdl': CAN + 'tank_t34_muzzle',
  'models/weapons/t_34_cannon/t_34_cannon_c1.mdl': CAN + 'tank_t34_muzzle',
  'models/weapons/shotgun_piper/shotgun_hammerfall.mdl': SG + 'shotgun_epic_muzzle',
  'models/weapons/machinegun_side_browning1919/machinegun_side_epic.mdl': MG + 'muzzle_machinegun_rare',
  'models/weapons/revolver_gun/revolver_pro.mdl': W + 'revolver_g_muzzle',
  'models/weapons/minigun_legendary/minigun_legendary_w.mdl': MG + 'muzzle_minigun_legend',
};

// ---- what a gun fires ----------------------------------------------------------------------------
// The round's own effect (its glowing dot and tracer ride it, its trail stays in the air), how fast
// it flies (m/s), how much it drops (m/s²), how far it goes (m), pellets and their spread (degrees),
// and the game's effects where it lands: on the ground, and on the training target (a vehicle's
// sheet metal, so the hits on cars). Speeds, drop and reach sit in the encrypted item data: these are
// by the kind of gun. Flamethrowers carry most of their flame on such rounds, launched every
// `stream` seconds while they fire: the three fireballs of flamethrower_projectile start 0.07 s
// apart, each placed 2 m further back, so they set off where the round was, which flies 28.6 m/s.
const HITS = {
  small: ['materials/ground/hit_ground_small', 'materials/car/hit_car_small'],
  mid: ['materials/ground/hit_ground_mid', 'materials/car/hit_car_mid'],
  big: ['materials/ground/hit_ground_big', 'materials/car/hit_car_big'],
  shell: ['materials/ground/hit_ground_big', 'materials/car/hit_car_big_explosive_shell'],
  huge: ['materials/ground/hit_ground_huge', 'materials/car/hit_car_huge_explosive_shell'],
  grenade: ['materials/ground/explosion_ground_ags', 'explosions/projectiles/explosion_small_ags'],
  rocket: ['materials/ground/explosion_ground_missile', 'explosions/projectiles/explosion_small_missile'],
  bomb: ['materials/ground/explosion_ground_big', 'explosions/projectiles/explosion_big_mortar'],
  blast: ['materials/ground/explosion_ground_missile', 'explosions/projectiles/explosion_mid'],
  flame: ['materials/ground/hit_ground_flame_small', 'materials/car/hit_car_flame_small'],
  plasma: ['weapons/plazma/plazma_hit', 'weapons/plazma/plazma_hit'],
  fusion: ['weapons/fusion/fusion_hit', 'weapons/fusion/fusion_hit'],
  bolt: ['weapons/crossbow_proj_explosion', 'weapons/crossbow_proj_explosion'],
  revolver: ['materials/ground/hit_ground_mid', 'weapons/revolver_hit'],
  coil: ['materials/ground/coilgun_hit_ground', 'materials/car/coilgun_hit'],
  frost: ['materials/ground/hit_frost_ground_big', 'materials/car/hit_car_frost_big'],
  sticky: ['weapons/sticky_launcher/sticky_bomb_hit', 'weapons/sticky_launcher/sticky_bomb_hit'],
  stickyHybrid: ['weapons/sticky_bomb_2modes_hit', 'weapons/sticky_bomb_2modes_hit'],
  tesla: ['materials/hit_beam_ground', 'materials/hit_teslagun_metal'],
  laser: ['materials/hit_beam_ground', 'materials/hit_laserbeam_car'],
  lightning: ['weapons/lightning_gun/lightninggun_hit', 'weapons/lightning_gun/lightninggun_hit'],
  drill: ['materials/plasmadrill_hit', 'materials/plasmadrill_hit'],
  ion: ['weapons/ion_shield/ion_shield_damage_detail', 'weapons/ion_shield/ion_shield_damage_detail'],
};

// On a map, what the rounds meet besides its ground: stone (rocks, buildings), wood (trees) and water
// (its rivers and lakes), by the same kind of hit; a kind missing here hits stone and wood as it hits
// the ground.
const STONE = {
  small: 'stone/hit_stone_small', mid: 'stone/hit_stone_mid', big: 'stone/hit_stone_big', shell: 'stone/hit_stone_big', huge: 'stone/hit_stone_huge',
  grenade: 'stone/explosion_stone_ags', rocket: 'stone/explosion_stone_missile', bomb: 'stone/explosion_stone_big', blast: 'stone/explosion_stone_mid',
  flame: 'stone/hit_stone_flame', frost: 'stone/hit_stone_frost_big', plasma: 'stone/explosion_stone_scifi_big', fusion: 'stone/explosion_stone_scifi_big',
  coil: 'stone/coilgun_hit_stone', drill: 'stone/plasmadrill_hit_stone', revolver: 'stone/hit_stone_mid', bolt: 'stone/hit_stone_small',
};
const WOOD = {
  small: 'wood/hit_wood_small', mid: 'wood/hit_wood_mid', big: 'wood/hit_wood_big', shell: 'wood/hit_wood_big', huge: 'wood/hit_wood_big',
  grenade: 'wood/hit_wood_explosive', rocket: 'wood/hit_wood_explosive', bomb: 'wood/hit_wood_explosive', blast: 'wood/hit_wood_explosive',
  frost: 'wood/hit_wood_frost_big', drill: 'wood/plasmadrill_hit_wood', revolver: 'wood/hit_wood_mid', bolt: 'wood/hit_wood_small',
};
const WATER = {
  small: 'hit_water_small', mid: 'hit_water_mid', big: 'hit_water_big', shell: 'hit_water_big', huge: 'hit_water_huge', grenade: 'explosion_water_mid',
  rocket: 'explosion_water_mid', bomb: 'explosion_water_big', blast: 'explosion_water_mid', flame: 'projectile_splash', plasma: 'explosion_water_mid_scifi',
  fusion: 'explosion_water_mid_scifi', coil: 'explosion_water_mid_scifi', frost: 'hit_water_frost_big', tesla: '../hit_beam_water', laser: '../hit_beam_water',
  lightning: '../hit_beam_water', drill: '../hit_beam_water', ion: 'explosion_water_mid_scifi',
};

const SHOTS = {
  mg: { proj: MG + 'bullet_projectile', speed: 650, range: 160, hit: 'small' },
  mgHeavy: { proj: MG + 'bullet_heavy_projectile', speed: 600, range: 180, hit: 'mid' },
  smg: { proj: MG + 'bullet_smg_projectile', speed: 550, range: 110, hit: 'small' },
  minigun: { proj: MG + 'minigun_projectile', speed: 650, range: 160, hit: 'small' },
  autocannon: { proj: MG + 'auto_cannon_projectile', speed: 520, range: 220, gravity: 2, hit: 'mid' },
  autocannonRelic: { proj: W + 'autocannon/autocannon_long_relic_projectile', speed: 560, range: 240, gravity: 2, hit: 'mid' },
  cannon: { proj: CAN + 'tank_cannon_projectile', speed: 420, range: 320, gravity: 6, hit: 'shell' },
  cannonBig: { proj: CAN + 'tank_cannon_projectile', speed: 400, range: 340, gravity: 6, hit: 'huge' },
  shotgun: { proj: SG + 'shotgun_projectile_perk', speed: 380, range: 70, pellets: 8, spread: 3.5, hit: 'small' },
  grenade: { proj: W + 'ags_proj', speed: 75, range: 400, gravity: 9.8, hit: 'grenade' },
  mortar: { proj: W + 'mortar/mortar_projectile', speed: 55, range: 400, gravity: 9.8, hit: 'bomb' },
  rocket: { proj: MIS + 'missile_trail', speed: 130, range: 300, hit: 'rocket' },
  // guided launchers' missiles steer onto the target (homing: radians a second they turn at launch,
  // more as they fly and as they near it: FxView steer): the vertical launchers' go up and come down
  guided: { proj: MIS + 'missile_trail', speed: 80, range: 300, hit: 'rocket', homing: 2 },
  // the Waltz's rockets corkscrew round their line (radius m, turns a second: a turn every 9 m),
  // each of a volley a third of a turn on from the one before
  rocketSpiral: { proj: MIS + 'missile_trail', speed: 75, range: 300, hit: 'rocket', spiral: [0.6, 8] },
  // second fire modes (ALT_BY_FOLDER); a `lob` goes up so many degrees from the level and comes
  // down on the target (as fast as that takes: Viewer.fireRounds)
  grenadeHeavy: { proj: W + 'ags_6x_proj', speed: 45, range: 300, gravity: 9.8, hit: 'blast', lob: 40 },
  // (the Hybrid's second mode: "slow projectiles that attach to the target and explode after a
  // short time"; its own hit, fuse and blast)
  stickyGrenade: { proj: W + 'machinegun_2modes_proj', speed: 60, range: 200, gravity: 9.8, hit: 'stickyHybrid', stick: 2, work: W + 'machinegun/sticky_bomb_2mode_prepare', boom: 'explosions/projectiles/explosion_2mode_sticky_bomb' },
  cannonArtillery: { proj: CAN + 'gun_2type_projectile_2', speed: 70, range: 400, gravity: 9.8, hit: 'huge', lob: 60 },
  bladesFan: { proj: W + 'blade_trail', speed: 55, range: 60, gravity: 2, hit: 'small', spin: 12, stick: 1.5, pellets: 3, spread: 8 },
  // Crossbow bolts stay stuck where they hit; the sticky ones (the Phoenix's: they "stick to
  // surfaces and car parts and detonate after a short interval", and the game's tempo and Sovereign
  // sticky-bomb fuses and bursts) go off after their fuse (work) burns
  crossbow: { proj: W + 'crossbow_proj', speed: 140, range: 250, gravity: 3, hit: 'bolt', stick: 4 },
  crossbowSpike: { proj: W + 'crossbow_blast_proj', speed: 140, range: 250, gravity: 3, hit: 'bolt', stick: 4 },
  crossbowBurst: { proj: W + 'crossbow_burst_proj', speed: 140, range: 250, gravity: 3, hit: 'bolt', stick: 4 },
  ballista: { proj: W + 'crossbow/ballista_legend_proj', speed: 160, range: 300, gravity: 3, hit: 'bolt', stick: 4 },
  railCrossbow: { proj: W + 'crossbow/crossbow_railgun_proj', speed: 300, range: 300, gravity: 1, hit: 'bolt', stick: 4 },
  crossbowSticky: { proj: W + 'crossbow_proj', speed: 140, range: 250, gravity: 3, hit: 'bolt', stick: 2, work: 'gameplay/sticky_bomb_prepare', boom: W + 'crossbow/sticky_bomb_burst' },
  crossbowTempo: { proj: W + 'crossbow_proj', speed: 140, range: 250, gravity: 3, hit: 'bolt', stick: 2, work: 'gameplay/tempo_sticky_bomb_prepare', boom: 'explosions/projectiles/explosion_mid_tempo_small' },
  crossbowTempoLegend: { proj: W + 'crossbow_speed_proj', speed: 150, range: 250, gravity: 3, hit: 'bolt', stick: 2, work: 'gameplay/tempo_sticky_bomb_prepare', boom: 'explosions/projectiles/explosion_mid_tempo' },
  crossbowRevolver: { proj: W + 'crossbow/revolver_crossbow_relict_proj', speed: 140, range: 250, gravity: 3, hit: 'bolt', stick: 2, work: 'gameplay/revolver_crossbow_sticky_bomb_prepare', boom: W + 'crossbow/revolver_crossbow_relict_sticky_bomb' },
  plasma: { proj: W + 'plazma/plazma_projectile', speed: 60, range: 200, hit: 'plasma' },
  fusion: { proj: W + 'fusion/fusion_projectile', speed: 220, range: 220, hit: 'fusion' },
  railgun: { proj: W + 'railgun_proj', speed: 900, range: 400, hit: 'mid' },
  flame: { proj: W + 'flamethrower/flamethrower_projectile', speed: 28.6, range: 14, stream: 0.08, hit: 'flame', hitEvery: 3 },
  revolver: { proj: MG + 'bullet_heavy_projectile', speed: 600, range: 200, hit: 'revolver' },
  carabine: { proj: W + 'carabine_projectile', speed: 800, range: 300, hit: 'mid' },
  nail: { proj: W + 'nail/proj', speed: 200, range: 200, gravity: 2, hit: 'mid' },
  coilgun: { proj: W + 'coilgun_projectile', speed: 300, range: 300, hit: 'coil' },
  frostArtillery: { proj: W + 'frost_art_projectile', speed: 70, range: 400, gravity: 9.8, hit: 'frost' },
  sticky: { proj: W + 'sticky_launcher/sticky_bomb_proj', speed: 60, range: 250, gravity: 9.8, hit: 'sticky', stick: 2.5, work: W + 'sticky_launcher/sticky_bomb_prepare', boom: 'explosions/projectiles/explosion_mid' },
  selfdamage: { proj: W + 'selfdamage_projectile', speed: 400, range: 300, hit: 'mid' },
  frost: { proj: W + 'frostgun/frostgun_proj', speed: 30, range: 18, stream: 0.08, hit: 'frost', hitEvery: 3 },
  plasmaCutter: { proj: W + 'plazma/plazma_cutter_proj', speed: 150, range: 120, hit: 'plasma' },
  // Beams (their effects carry the beam flag, header +0x2c bit 1): the effect laid along the line
  // from the fire point to what it meets within `range` (FxView.beam), the hit effect where it lands
  // every `hitEvery` seconds; held while the gun fires, or one `pulse` a shot.
  tesla: { beam: W + 'tesla/teslagun_beam', range: 35, hit: 'tesla', hitEvery: 0.15 },
  teslaRelic: { beam: W + 'tesla/teslagun_relic_beam', range: 35, hit: 'tesla', hitEvery: 0.15 },
  lightning: { beam: W + 'lightning_gun/lightninggun_projectile', range: 60, hit: 'lightning', pulse: 0.35 },
  laserGatling: { beam: W + 'particle_beam_laser', range: 120, hit: 'laser', hitEvery: 0.1 },
  laserRevolver: { beam: W + 'laser_revolver_beam', range: 150, hit: 'laser', pulse: 0.25 },
  drill: { beam: W + 'plasmadrill/plasmadrill_beam', range: 25, hit: 'drill', hitEvery: 0.15 },
  drillLegend: { beam: W + 'plasmadrill/plasmadrill_leg_beam', range: 25, hit: 'drill', hitEvery: 0.15 },
  // Throwing launchers (FxView.fire): what flies (MESH_BY_FOLDER) turns `spin` times a second about
  // its thinnest axis (saws, discs, blades) or `tumble`s end over end; it sticks where it hits for
  // `stick` s (driven in, a STUCK_BY_FOLDER model in its place), its `work` effect playing there,
  // and goes off (`boom`) after; a `rope` (a beam effect) runs back to the gun meanwhile; a roller
  // (`roll` s) bowls along the ground once it lands, `rollSpeed` m/s, until it meets the target; a
  // lander lies where it lands (on the ground, or anywhere: landAny) for `land` s, working (a mine
  // blinks), then goes off; a trap's arrows fly out (`volley`); a drone (`hover` s) flies out above
  // the way to the target and shoots at it (`child` rounds every `every` s); fence `pole`s stand with
  // a `fenceBeam` between each and the one before.
  harpoon: { speed: 90, range: 80, gravity: 3, hit: 'mid', stick: 2.5, rope: W + 'harpoon_rope_beam' },
  sawLegend: { proj: W + 'saw/saw_launcher_leg_trail', speed: 40, range: 80, gravity: 3, hit: 'small', spin: 10, stick: 2.5, work: W + 'saw/saw_launcher_proj_work', boom: W + 'saw/saw_launcher_proj_exp' },
  sawRelic: { proj: W + 'saw_trail', speed: 40, range: 80, gravity: 3, hit: 'small', spin: 10, stick: 2.5, work: W + 'saw/saw_launcher_proj_work', boom: W + 'saw/saw_launcher_proj_exp' },
  disc: { proj: W + 'saw_trail', speed: 45, range: 80, gravity: 3, hit: 'mid', spin: 8, stick: 2, boom: 'explosions/projectiles/explosion_small' },
  blades: { proj: W + 'blade_trail', speed: 55, range: 60, gravity: 2, hit: 'small', spin: 12, stick: 1.5 },
  wheelBomb: { proj: W + 'wheel_bomb_fire', speed: 14, range: 80, gravity: 9.8, hit: 'rocket', roll: 6, rollSpeed: 14 },
  wheelBombEpic: { proj: W + 'wheel_launcher/wheel_launcher_epic_proj', speed: 14, range: 80, gravity: 9.8, hit: 'rocket', roll: 6, rollSpeed: 16 },
  trainWheel: { speed: 16, range: 80, gravity: 9.8, hit: 'rocket', roll: 6, rollSpeed: 18 },
  barrel: { proj: W + 'barrel_mine_proj_fire', speed: 12, range: 60, gravity: 9.8, hit: 'rocket', tumble: 1.5, roll: 4, rollSpeed: 7, loft: 15 },
  mine: { speed: 8, range: 30, gravity: 9.8, hit: 'grenade', land: 4, work: W + 'mine_active', boom: 'explosions/projectiles/explosion_small_ags', loft: 40 },
  trap: { speed: 9, range: 40, gravity: 9.8, hit: 'grenade', land: 5, work: W + 'mine_active', volley: 1, child: 'trapArrow', childMesh: WM + 'minetrap/arrow', loft: 35 },
  trapArrow: { speed: 70, range: 30, gravity: 3, hit: 'small', stick: 3 },
  ionShield: { proj: W + 'ion_shield/ion_shield_projectile', speed: 35, range: 60, hit: 'ion', land: 6, landAny: true, work: W + 'ion_shield/ion_sphere_cooldown', boom: W + 'ion_shield/ion_shield_death' },
  drone: { speed: 10, range: 400, hit: 'rocket', hover: 6, child: 'mg', every: 0.15 },
  droneLegend: { speed: 10, range: 400, hit: 'rocket', hover: 6, child: 'rocket', childMesh: PJ + 'missile_01', every: 0.8 },
  fence: { speed: 11, range: 40, gravity: 9.8, hit: 'grenade', land: 8, pole: 1, fenceBeam: W + 'tesla/tesla_trap_beam', loft: 30, fan: 25 },
  tntSpear: { boomAt: 'explosions/projectiles/explosion_small_missile', speed: 1, range: 0, hit: 'grenade' },
};

// The model a round flies as (rockets, bolts, grenades, mortar bombs ...; bullets and shells are too
// fast to see and fly as their tracers only). Again the game names it in its encrypted item data, so
// it goes by folder: the weapon's own projectile model where its folder has one (the one the
// assembled view loads on its deploy point), else the game's shared ones in projectiles/ and
// crossbow_arrow/. Of the two shared rockets, the finned `missile` spans 0.27 m: pods whose tubes sit
// closer (0.13..0.24 m apart) fire the slim `missile_01`. All of them point along +Z, the round's
// flight; a node named nozzle / exhaust / fx_01 is where the round's smoke and flame come out.
const MESH_BY_FOLDER = {
  // rockets
  nurs_single: PJ + 'missile_01', nurs_dble: PJ + 'missile_01', nurs_preepic: PJ + 'missile_01', nurs_multy: PJ + 'missile_01',
  missile_3x_front_epic: PJ + 'missile_01', missile_3x_relict: PJ + 'missile_01', missile_3x_spiral_legend: PJ + 'missile_01',
  missile_8x_legend: PJ + 'missile_01', missile_20x_legend: PJ + 'missile_01', missile_38x_legend: PJ + 'missile_01', guided_multy: PJ + 'missile_01',
  nurs_turret: PJ + 'missile', nurs_turret_auto: PJ + 'missile', guided_single: PJ + 'missile', missile_laser: PJ + 'missile',
  rocket_artillery_legend: PJ + 'missile', guided_lockon_oracle: PJ + 'missile',
  nurs_legend: WM + 'nurs_legend/nurs_legend_missle',
  guided_control: WM + 'guided_control/missile_control',
  guided_support_epic: WM + 'guided_support_epic/guided_support_epic_rocket',
  missile_laser_legend: WM + 'missile_laser_legend/missile_laser_legend_bullet_01',
  missile_plasma_epic: WM + 'missile_plasma_epic/missile_plasma_epic_rocket',
  airstike_launcher: WM + 'airstike_launcher/airstike_launcher_fly_projectile',
  rpg_rocket_launcher_legend: WM + 'rpg_rocket_launcher_legend/rpg_rocket_launcher_legend_missile_01',
  // crossbow bolts (the twin crossbow's two sit 6.5 cm apart: the thin one)
  crossbow_double01: AR + 'crossbow_arrow_01', rail_crossbow: AR + 'crossbow_arrow_01', crossbow_revolver_relict: AR + 'crossbow_arrow_03',
  trible_crossbow: AR + 'crossbow_arrow_02', crossbow_tempo: AR + 'crossbow_arrow_02', crossbow_rocket: AR + 'bomb_arrow',
  crossbow_burst: WM + 'crossbow_burst/crossbow_burst_projectile', crossbow_epic: WM + 'crossbow_epic/crossbow_epic_spear',
  crossbow_tempo_legend: WM + 'crossbow_tempo_legend/crossbow_tempo_legend_arrow',
  crossbow_ballista_legend: WM + 'crossbow_ballista_legend/crossbow_ballista_legend_projectille',
  // grenades, mortar bombs
  grenade_launcher: PJ + 'grenade_ags', grenade_launcher_epic: PJ + 'grenade_ags', grenade_launcher_4x: PJ + 'grenade_ags', grenade_launcher_6x_relict: PJ + 'grenade_ags',
  grenade_launcher_2types_legend: WM + 'grenade_launcher_2types_legend/grenade_launcher_2types_legend_bullet1',
  grenade_launcher_burst: WM + 'grenade_launcher_burst/grenade_launcher_burst_projectile',
  grenade_system: PJ + 'bullet_mortar', mortar_cannon: PJ + 'bomb_grenade', catapult: WM + 'catapult/canister_bomb',
  bomb_launcher_2x_legend: WM + 'bomb_launcher_2x_legend/bomb_launcher_2x_legend_bomb',
  frost_artillery_epic: WM + 'frost_artillery_epic/frost_artillery_epic_projectile',
  sticky_bomb_launcher: WM + 'sticky_bomb_launcher/sticky_bomb_launcher_projectile',
  // throwing launchers
  harpoon_epic: WM + 'harpoon_epic/harpoon_epic_arrow', turret_harpoon_launcher_legendary: WM + 'turret_harpoon_launcher_legendary/turret_harpoon_lgnd_harpoon',
  saw_launcher_legend: WM + 'saw_launcher_legend/saw_launcher_legend_fly', saw_launcher_relict: WM + 'saw_launcher_relict/saw_launcher_relict_projectile_fly',
  disc_gun: WM + 'disc_gun/disc', blade_launcher_legend: WM + 'blade_launcher_legend/blade_launcher_legend_projectile',
  wheel_launcher: WM + 'wheel_launcher/wheel_bomb', wheel_launcher_epic: WM + 'wheel_launcher_epic/wheel_launcher_epic_bomb_01',
  train_wheel_launcher_legend: WM + 'train_wheel_launcher_legend/train_wheel_launcher_legend_projectile', barrel_launcher: WM + 'barrel_launcher/barrel',
  minelayer: WM + 'minelayer/mine_projectile', minetrap: WM + 'minetrap/projectile',
  drone_launcher_epic: WM + 'drone_launcher_epic/drone_launcher_epic_drone', drone_launcher_legend: WM + 'drone_launcher_legend/drone_launcher_legend_drone',
  electric_fence_epic: WM + 'electric_fence_epic/electric_fence_epic_pole', spear_rocket: PJ + 'missile',
};
// what stays where a round sticks or lands, where it is not the flying model itself
const STUCK_BY_FOLDER = {
  saw_launcher_legend: WM + 'saw_launcher_legend/saw_launcher_legend_stuck', saw_launcher_relict: WM + 'saw_launcher_relict/saw_launcher_relict_projectile_stuck',
  crossbow_burst: WM + 'crossbow_burst/crossbow_burst_stuck', minelayer: WM + 'minelayer/mine', minetrap: WM + 'minetrap/trap',
};
// A gun's second fire mode: another round for the activity that fires it (FIRE_SPECIAL, the
// machine gun's ACT_FIRE1 "fire_alt"), with its model.
const ALT_BY_FOLDER = {
  grenade_launcher_2types_legend: { FIRE_SPECIAL: ['grenadeHeavy', WM + 'grenade_launcher_2types_legend/grenade_launcher_2types_legend_bullet2'] },
  machinegun_2modes_legend: { ACT_FIRE1: ['stickyGrenade', WM + 'machinegun_2modes_legend/machinegun_2modes_legend_grenade'] },
  heavygun_2types_legend: { FIRE_SPECIAL: ['cannonArtillery', null] },
  blade_launcher_legend: { FIRE_SPECIAL: ['bladesFan', WM + 'blade_launcher_legend/blade_launcher_legend_projectile'] },
};

// a skin that flies its own
const MESH_BY_MODEL = { 'models/weapons/harpoon_epic/harpoon_epic_china.mdl': WM + 'harpoon_epic/harpoon_epic_china_arrow' };

// the kind of round, read off the gun's matched muzzle effect (a few by folder)
const SHOT_BY_FOLDER = {
  autocannon_relict: 'autocannonRelic', flame_thrower: 'flame', flmthrow_course: 'flame',
  revolver_gun: 'revolver', revolver_legend: 'revolver', impulse_carabine: 'carabine', nail_gun: 'nail', nail_gun_epic: 'nail',
  coilgun_legend: 'coilgun', frost_artillery_epic: 'frostArtillery', sticky_bomb_launcher: 'sticky', railgun_self_damage_epic: 'selfdamage',
  heavygun_flak88: 'cannonBig', heavygun_turret_flak88: 'cannonBig', cg_gun: 'cannonBig', relict_double_gun: 'cannonBig', tankgun_relict: 'cannonBig', cannon_ship_legend: 'cannonBig',
  guided_single: 'guided', guided_multy: 'guided', guided_support_epic: 'guided', guided_lockon_oracle: 'guided', guided_control: 'guided',
  missile_laser: 'guided', missile_laser_legend: 'guided',
  // (the Swarm's rockets "home in on an area, fly on a plunging trajectory"; the Heather's artillery
  // rockets too: both launch upwards)
  missile_8x_legend: 'guided', rocket_artillery_legend: 'guided',
  tesla_gun: 'tesla', tesla_gun_relict: 'teslaRelic', lightning_gun: 'lightning', gatling_laser: 'laserGatling', revolver_laser_legend: 'laserRevolver',
  plasma_drill: 'drill', plasma_drill_legendary: 'drillLegend', plasma_cutter: 'plasmaCutter',
  frost_thrower_epic: 'frost', frost_gun_legend: 'frost', side_flamethrower: 'flame',
  harpoon_epic: 'harpoon', turret_harpoon_launcher_legendary: 'harpoon', saw_launcher_legend: 'sawLegend', saw_launcher_relict: 'sawRelic',
  disc_gun: 'disc', blade_launcher_legend: 'blades', wheel_launcher: 'wheelBomb', wheel_launcher_epic: 'wheelBombEpic',
  train_wheel_launcher_legend: 'trainWheel', barrel_launcher: 'barrel', minelayer: 'mine', minetrap: 'trap',
  plasma_shield_launcher_legend: 'ionShield', drone_launcher_epic: 'drone', drone_launcher_legend: 'droneLegend',
  electric_fence_epic: 'fence', spear_tnt: 'tntSpear', spear_rocket: 'rocket', missile_3x_spiral_legend: 'rocketSpiral',
  crossbow_rocket: 'crossbowSpike', crossbow_burst: 'crossbowBurst', crossbow_ballista_legend: 'ballista', rail_crossbow: 'railCrossbow',
  trible_crossbow: 'crossbowSticky', crossbow_tempo: 'crossbowTempo', crossbow_tempo_legend: 'crossbowTempoLegend', crossbow_revolver_relict: 'crossbowRevolver',
};
const SHOT_BY_MUZZLE = [
  [/muzzle_machinegun_heavy/, 'mgHeavy'], [/muzzle_smg/, 'smg'], [/muzzle_minigun/, 'minigun'], [/muzzle_machinegun/, 'mg'],
  [/muzzle_auto_cannon|autocannon\//, 'autocannon'], [/shotgun|spreadburst/, 'shotgun'],
  [/tank_cannon|tank_t34|tank_relic|gun_2type|cannon_two_modes|cannon_threeshot|cannon_corrosion|cannon_ship/, 'cannon'],
  [/ags_|retcher/, 'grenade'], [/mortar/, 'mortar'], [/missile\//, 'rocket'], [/crossbow|ballista/, 'crossbow'],
  [/plazma_muzzle|plazmaball/, 'plasma'], [/fusion\//, 'fusion'], [/railgun|oracle_gun/, 'railgun'],
];

// What a model fires, or null: { proj, speed, gravity, range, pellets, spread, stream, homing, hits:
// by surface [ground, target (a car's metal), water, stone, wood], mesh } (effect paths under particles/,
// no extension; mesh: the model the round
// flies as, or null). act: the activity firing it (a second fire mode fires its own: ALT_BY_FOLDER).
export function shotFor(path, act = null) {
  const m = /^models\/weapons\/([^/]+)\//.exec(path || '');
  if (!m) return null;
  const alt = act && ALT_BY_FOLDER[m[1]]?.[act];
  if (alt) return shotKind(alt[0], alt[1] ? alt[1] + '.mdl' : null);
  let kind = SHOT_BY_FOLDER[m[1]];
  if (!kind) {
    const muzzle = muzzleFor(path) || '';
    kind = SHOT_BY_MUZZLE.find(([re]) => re.test(muzzle))?.[1];
  }
  const mesh = MESH_BY_MODEL[path] || MESH_BY_FOLDER[m[1]];
  return shotKind(kind, mesh ? mesh + '.mdl' : null, STUCK_BY_FOLDER[m[1]] ? STUCK_BY_FOLDER[m[1]] + '.mdl' : null);
}

// A kind of round (SHOTS) as shotFor gives it, flying as mesh, staying as stuck (model paths); what a
// trap or a drone fires in turn comes as child.
export function shotKind(kind, mesh = null, stuck = null) {
  const s = SHOTS[kind];
  if (!s) return null;
  const fx = (p) => (p ? 'particles/' + p : null);
  return {
    kind, ...s, gravity: s.gravity || 0, pellets: s.pellets || 1, spread: s.spread || 0,
    hits: [...HITS[s.hit].map((h) => 'particles/' + h), ('particles/materials/water/' + (WATER[s.hit] || 'hit_water_mid')).replace('/water/../', '/'),
      STONE[s.hit] ? 'particles/materials/' + STONE[s.hit] : 'particles/' + HITS[s.hit][0], WOOD[s.hit] ? 'particles/materials/' + WOOD[s.hit] : 'particles/' + HITS[s.hit][0]],
    proj: fx(s.proj), beam: fx(s.beam), rope: fx(s.rope), work: fx(s.work), boom: fx(s.boom), boomAt: fx(s.boomAt), fenceBeam: fx(s.fenceBeam),
    mesh, stuck,
    child: s.child ? shotKind(s.child, s.childMesh ? s.childMesh + '.mdl' : SHOT_MESH[s.child] || null) : null,
  };
}
const SHOT_MESH = { rocket: PJ + 'missile_01.mdl' };

// The effect a model fires with, or null (melee weapons, drones, mines ...).
export function muzzleFor(path) {
  if (!path) return null;
  if (BY_MODEL[path]) return 'particles/' + BY_MODEL[path];
  const m = /^models\/weapons\/([^/]+)\//.exec(path);
  return m && BY_FOLDER[m[1]] ? 'particles/' + BY_FOLDER[m[1]] : null;
}

// effects a user may pick for a gun: names with muzzle / launch / flow in them (from the file list)
export function muzzleChoices(files) {
  return files
    .filter((n) => /^particles\/(weapons|constructor_china|perks)\/.*(muzzle|launch|_flow|exhaust_frost|frostgun_proto|flamethrower_pest)[^/]*\.psys$/i.test(n))
    .map((n) => n.replace(/\.psys$/i, ''))
    .sort();
}

export const FX_TABLE = { BY_FOLDER, BY_MODEL, SHOTS, HITS, WATER, STONE, WOOD, MESH_BY_FOLDER, STUCK_BY_FOLDER, MESH_BY_MODEL, ALT_BY_FOLDER };
