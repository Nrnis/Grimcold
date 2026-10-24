// What the game's guns, hits and blasts sound like: families of the game's own samples (its FMOD
// sound banks, listed by the host: /sounds). The FMOD events that layer them sit in the game's
// encrypted data, so the samples go by their names: a family is a name's variants (name1, name2 ...,
// with or without _p, or the name alone), one picked at random each time (sound.js).
//
// A gun: shot (every shot), start (when it starts firing), loop (held while it fires), end and tail
// (once it stops: a motor running down, the burst's echo after a machine gun's short "grains"),
// shells (its spent cases landing after the burst), gain. By weapon folder; else by the kind of round
// it fires (fxmap.js SHOTS).

const MG = (shot, tail = 'mmg_tail_close_outdoor', shells = 'mmg_shells') => ({ shot, tail, shells });
const HMG = (shot, tail = 'dshk_tail_add') => MG(shot, tail, 'hmg_shells_collision');
const ONE = (shot, tail = null, gain = 1, shells = null) => ({ shot, tail, gain, shells });
const MINI = (o) => ({ ...o, shells: 'mmg_shells' });

const BY_KIND = {
  mg: MG('mmg_grain_new'), mgHeavy: HMG('hmg_grain'), smg: MG('mg_fast_grain_far', 'mg_fast_tail_far', 'fmg_shells_end'),
  minigun: MINI({ loop: 'minigun_loop_p', start: 'minigun_motor_start_loop', end: 'minigun_motor_stop', tail: 'mc_tail_close_outdoor' }),
  autocannon: MG('cannon_30mm_shot', 'cannon_25mm_openfield_tail', 'hmg_shells_collision'), autocannonRelic: ONE('heavy_relic_shot_close', 'heavy_relic_shot_far'),
  cannon: ONE('cannon_50_shot', null, 1, '380mm_shells'), cannonBig: ONE('88mm_epic_shot', '88mm_epic_openfield_tail', 1, '380mm_shells'),
  shotgun: ONE('ls_shot_base', 'shotgun_openfield_close_tail', 1, 'shotgun_shell_collision_ground'),
  grenade: ONE('gl_shot', 'gl_openfield_close', 1, 'gl_shell'), mortar: ONE('mortar_shot_close'),
  rocket: ONE('wasp_launch'), guided: ONE('homing_epic_launch'), rocketSpiral: ONE('3x_epic_launch'),
  grenadeHeavy: ONE('gl2type_attack', 'mortar_shot_far'), stickyGrenade: ONE('sg_grenade_shot'), cannonArtillery: ONE('100mm_legend_shot_close'),
  bladesFan: ONE('saw_launcher_legend_shot_base'),
  crossbow: ONE('crossbow_shot'), crossbowSpike: ONE(['crossbow_shot', 'crossbow_shot_add']), crossbowBurst: ONE('crossbow_burst_shot'),
  ballista: ONE('crossbow_legend_shot'), railCrossbow: ONE('crossbow_legend_shot'), crossbowSticky: ONE('crossbow_shot'),
  crossbowTempo: ONE('crossbow_tempo_shot'), crossbowTempoLegend: ONE('crossbow_tempo_legend_shot'), crossbowRevolver: ONE(['crossbow_revolver_base', 'crossbow_shot']),
  plasma: ONE('plazma_shot'), fusion: ONE('fusion_shot', 'fusion_openfield_close_tail'), railgun: ONE('railgun_shot', 'railgun_openfield_tail'),
  flame: { loop: 'flamethrower_loop', end: 'flamethrower_loop_end' }, revolver: ONE('revolver_shot_close', 'revolver_tail_outdoor'),
  carabine: ONE('carabine_shot'), nail: ONE(['nailgun_shot_high', 'nailgun_shot_low']), coilgun: ONE('cg_shot', 'cg_shot_far'),
  frostArtillery: ONE('gl_rare_shot', 'gl_openfield_close'), sticky: ONE('sg_grenade_shot'), selfdamage: ONE('selfdamage_railgun_shot', 'railgun_openfield_tail'),
  frost: { start: 'frostgun_start', loop: 'frostgun_shot_loop', end: 'frostgun_end' }, plasmaCutter: ONE('plazma_cutter_shot', 'plazma_cutter_tail'),
  tesla: { loop: 'tesla_fire', end: 'tesla_fire_end' }, teslaRelic: { loop: 'tesla_relic_fire', end: 'tesla_relic_end' },
  lightning: ONE(['LightningGun_shot_high', 'LightningGun_shot_low']), laserGatling: { loop: 'laser_minigun_fire' },
  laserRevolver: ONE('lr_shot', 'lr_tail_openfield'), drill: { start: 'plazma_drill_shot_start', end: 'plazma_drill_shot_final' },
  drillLegend: { start: 'plazma_drill_legend_shot_start', loop: 'plasma_drill_legend_shot_high', end: 'plasma_drill_legend_tail2' },
  harpoon: ONE('harpoon_fire'), sawLegend: ONE('saw_launcher_legend_shot_base'), sawRelic: ONE('saw_launcher_shot'), disc: ONE('saw_launcher_shot'),
  blades: ONE('saw_launcher_legend_shot_base'), wheelBomb: ONE('wheel_rocket_fire'), wheelBombEpic: ONE('wheel_rocket_fire'), trainWheel: ONE('twl_shot'),
  barrel: ONE('catapult_fire_shot', 'catapult_add'), mine: ONE('MineLauncher_fire'), trap: ONE('trap_mine_fire'), trapArrow: ONE('trap_common', null, 0.7),
  ionShield: ONE('shield_ion_shot'), drone: ONE('quadrocopter_start'), droneLegend: ONE('quadrocopter_sputnik_start'), fence: ONE('catapult_fire_shot'),
  tntSpear: ONE('punch'),
};

// Guns whose samples are named for them (or as near as the names tell)
const BY_FOLDER = {
  // machine guns
  machinegun_browning: MG('lmg_grain', 'mmg_openfield_tail'), machinegun_side_browning1919: MG('lmg_grain', 'mmg_openfield_tail'),
  machinegun_kpvt: HMG('hmg_grain'), machinegun_kpvt_double: HMG('hmg_grain'), machinegun_side_kpvt_double: HMG('hmg_grain'),
  machinegun_preepic: MG('preepic_medium_grain'), machinegun_auto: MG('mmg_fast_grain'), machinegun_kmtp: MG('mmg_grain_new'),
  machinegun_frontal_preepic: MG('frontal_epic_grain', 'mmg_openfield_tail'), machinegun_frontal_legend: MG('frontal_epic_grain', 'mmg_openfield_tail'),
  machinegun_legendary: MG('legend_grain', null), machinegun_relict: MG('relic_grain', 'mmg_tail_close_outdoor', 'mg_relic_shells_end'), machinegun_2modes_legend: MG('mmg_grain_new'),
  machinegun_heavy_epic: HMG('hmg_epic_grain'), machinegun_heavy_legend: HMG('hmg_legend_grain', 'hmg_legend_tail_add'),
  machinegun_smg: MG('mg_fast_grain_far', 'mg_fast_tail_far', 'fmg_shells_end'), machinegun_smg_2: MG('fast_epic_grain_far', 'mg_fast_tail_far', 'fmg_shells_end'),
  machinegun_smg_3: MG('fast_legend_grain', 'mg_fast_tail_far', 'fmg_shells_end'),
  // miniguns
  minigun_m134: MINI({ loop: 'minigun_loop_p', start: 'minigun_motor_start_loop', end: 'minigun_motor_stop', tail: 'mc_tail_close_outdoor' }),
  minigun_gsh623: MINI({ loop: 'minigun_mc_loop_p', start: 'minigun_motor_start_loop', end: 'minigun_motor_stop', tail: 'mc_tail_close_outdoor' }),
  minigun_explosive: MINI({ loop: 'minigun_mc_loop_p', start: 'minigun_expl_motor_start_loop_p', end: 'minigun_expl_motor_stop_p', tail: 'mc_tail_close_outdoor' }),
  minigun_legendary: MINI({ shot: 'minigun_legend_grain', loop: 'minigun_legend_motor_start_loop_p', end: 'minigun_legend_motor_stop_p', tail: 'mc_tail_close_outdoor' }),
  minigun_relict: { shot: 'mng_relic_grain', loop: 'minigun_relic_motor_start_loop_p', end: 'minigun_relic_motor_stop', tail: 'mc_tail_close_outdoor', shells: 'mg_relic_shells_end' },
  // autocannons
  autocanon_cmflak: MG('cannon_30mm_shot', 'cannon_25mm_openfield_tail'), autocanon_preepic: MG('cannon_30mm_shot', '25mm_preepic_shot_far'),
  autocannon_preepic_short: MG('lcannon_preepic_grain', 'lcannon_preepic_far'), autocannon_epic: MG('cannon_30mm_shot', '25mm_epic_shot_far'),
  mark38_mod2: MG('38mm_shot', 'cannon_25mm_openfield_tail'), autocannon_legend: MG('25mm_legend_shot', '25mm_legend_shot_distant'),
  autocannon_legend_02: MG('30mm_legend_shot', '25mm_legend_shot_distant'), autocannon_airdefense: ONE('aa_epic_shot_main'),
  autocannon_closecombat: ONE('CloseCombatCannon', 'CloseCombatCannon_tail'), autocannon_middlecombat: MG('38mm_shot', 'cannon_25mm_openfield_tail'),
  autocannon_2x: MG('38mm_shot', 'cannon_25mm_openfield_tail'), autocannon_relict: ONE('heavy_relic_shot_close', 'heavy_relic_shot_far'),
  autocannon_revolver: MG('30mm_legend_shot', '25mm_legend_shot_distant'), autocannon_revolver_epic: ONE('ps_shot_close', 'ps_shot_far'),
  // cannons
  heavygun_6pounder: ONE('cannon_50_shot'), heavygun_turret_6pounder: ONE('cannon_50_shot'), ballcannon: ONE('cannon_50_shot'),
  heavygun_zis3: ONE('cannon_76mm_shot'), heavygun_turret_zis3: ONE('cannon_76mm_shot'), heavygun_preepic: ONE('76mm_preepic_shot_close'),
  heavygun_turret_preepic: ONE('76mm_turn_preepic_shot_close'), cannon_oneshot_preepic: ONE('76mm_preepic_shot_close'),
  heavygun_flak88: ONE('88mm_epic_shot', '88mm_epic_openfield_tail'), heavygun_turret_flak88: ONE('88mm_epic_shot', '88mm_epic_openfield_tail'),
  cannon_ballistic_epic: ONE('88mm_epic_shot', '88mm_epic_openfield_tail'), t_34_cannon: ONE('cannon_t34_shot'),
  cg_gun: ONE('100mm_legend_shot_close'), relict_double_gun: ONE('100mm_dbl_relic_shot'), tankgun_relict: ONE(['100mm_shot', '100mm_shot_add']),
  cannon_ship_legend: ONE('380mm_legend_shot', '380mm_legend_shot_openfield_tail', 1, '380mm_shells'), cannon_assault_legend: ONE('thl_shot'),
  corrosion_gun_legend: ONE('cc_legend_shot_tail_add'), heavygun_2types_legend: ONE('88mm_epic_shot', '88mm_epic_openfield_tail'),
  // shotguns
  shotgun_striker: ONE('hs_shot_base', 'shotgun_openfield_close_tail'), shotgun_course_legend: ONE('hs_shot_base', 'shotgun_openfield_close_tail'),
  shotgun_midrange_legend: ONE('mr_legend_shot_close', 'mr_noise_tail'), shotgun_2barrel_revolver_legend: ONE('hs_shot_base', 'shotgun_openfield_close_tail'),
  shredder_gun_01: ONE('hs_shot_base', 'shotgun_openfield_close_tail'), shotgun_relict: ONE('hs_shot_base', 'shotgun_garbage_relic_openfield_tail'),
  shotgun_piper: ONE('lsg_epic_shot', 'shotgun_epic_openfield_tail'), shotgun_preepic: ONE('lsg_epic_shot', 'shotgun_epic_openfield_tail'),
  shotgun_side_preepic: ONE('lsg_epic_shot', 'shotgun_epic_openfield_tail'),
  shotgun_garbage_epic: ONE('garbage_epic_shot_close', 'shotgun_garbage_relic_openfield_tail'), shotgun_garbage_legendary: ONE('garbage_legend_shot_close', 'shotgun_garbage_relic_openfield_tail'),
  shotgun_garbage_relict: ONE('garbage_relic_shot', 'shotgun_garbage_relic_openfield_tail'), tribal_trashgun: ONE('garbage_shot_base', 'garbage_shot_base_far'),
  shotgun_flak01: ONE('sg_grenade_shot', 'shotgun_openfield_close_tail'), shotgun_popup_legend: ONE(['sg_popup_punch', 'sg_popup_add']),
  shotgun_syfy: ONE('dl_shot'),
  // grenade launchers, mortars
  grenade_launcher: ONE('gl_rare_shot', 'gl_rare_shot_far'), grenade_launcher_epic: ONE('gl_shot', 'gl_openfield_close'), grenade_launcher_4x: ONE('gl_shot', 'gl_openfield_close'),
  grenade_launcher_burst: ONE('gl_burst_shot', 'gl_burst_shot_far'), grenade_launcher_6x_relict: ONE('sg_gr_relic_shot_base', 'gl_openfield_close'),
  grenade_launcher_2types_legend: ONE('gl2type_attack', 'gl_openfield_close'), mortar_cannon: ONE('mortar_shot_close'),
  bomb_launcher_2x_legend: ONE('bomblauncher_main'), catapult: ONE('catapult_fire_shot', 'catapult_add'), grenade_system: ONE('mortar_shot_close'),
  // rockets
  nurs_preepic: ONE('wasp_preepic_launch'), missile_3x_relict: ONE('3x_relic_launch'), missile_8x_legend: ONE(['grad_launch', 'MissileSpam_add']),
  missile_20x_legend: ONE('grad_launch'), missile_38x_legend: ONE('grad_launch'), guided_multy: ONE('hurricane_shot'),
  guided_support_epic: ONE('gm_launch'), guided_control: ONE('jav_shot_main'), missile_laser: ONE('homing_laser_launch'), missile_laser_legend: ONE('homing_laser_launch'),
  missile_plasma_epic: ONE('plasma_epic_launch'), rocket_artillery_legend: ONE('rocket_artillery_legend_launch'), rpg_rocket_launcher_legend: ONE('jav_shot_main'),
  airstike_launcher: ONE('asl_shot'), spear_rocket: ONE('wasp_launch'),
  // energy
  plasma_launcher_legendary: ONE('plazma_legend_shot'), plasma_ball_lightning: ONE('plazmball_shot_base'),
  fusiongun_epic: ONE('fusion_shot_epic', 'fusion_openfield_close_tail'), fusiongun_legendary: ONE('fusion_shot_legend', 'fusion_openfield_close_tail'),
  fusiongun_relict: ONE(['fusion_relic_shot_add', 'fusion_shot'], 'fusion_openfield_close_tail'),
  railgun_legend: ONE('railgun_legend_shot', 'railgun_openfield_tail'), railgun_ballista_epic: ONE('railgun_sniper_shot', 'railgun_openfield_tail'),
  nail_gun_epic: ONE(['nailgun_epic_shot_high', 'nailgun_epic_shot_low']), side_flamethrower: ONE('firegun'),
  // the sticky bomb launcher
  sticky_bomb_launcher: ONE('sg_grenade_shot'),
};

// a gun's second fire mode (fxmap.js ALT_BY_FOLDER)
const ALT_BY_FOLDER = {
  machinegun_2modes_legend: { ACT_FIRE1: ONE('sg_grenade_shot') },
  grenade_launcher_2types_legend: { FIRE_SPECIAL: ONE('gl2type_attack', 'mortar_shot_far') },
  heavygun_2types_legend: { FIRE_SPECIAL: ONE('100mm_legend_shot_close') },
};

// The sound of a gun's shot (model path, the activity firing: a second fire mode sounds its own), or
// null. kind: its round's (fxmap.js shotFor).
export function gunSound(path, act = null, kind = null) {
  const m = /^models\/weapons\/([^/]+)\//.exec(path || '');
  if (!m) return null;
  const alt = act && ALT_BY_FOLDER[m[1]]?.[act];
  return alt || BY_FOLDER[m[1]] || (kind && BY_KIND[kind]) || null;
}

// What a gun's other activities sound like (anim.js: each time their clip starts over; Viewer.onActivity):
// a melee weapon's attack is held while it plays (its motor, its spinning blade); a reload, a charge,
// a hatch opening or closing once a time. By weapon folder, else by the kind of round it fires.
const MELEE = {
  chainsaw: { start: 'melee_exhaust_res', loop: 'melee_top_p' }, chainsaw_dble: { start: 'melee_exhaust_res', loop: 'melee_top_p' },
  drill: { loop: 'exploration_drill' }, harvester: { loop: 'shnek_common' }, saw: { loop: 'saw_wheel' },
  saw_legendary: { start: 'saw_booster_start_p', loop: 'saw_booster_idle_loop_p', end: 'saw_booster_end_p' }, hidro_bucket: { loop: 'tracks_shnek_slow_p' },
  train_wheel_launcher_legend: { loop: 'twl_saw_work' },
};
const RELOAD_BY_FOLDER = {
  cannon_ship_legend: '380mm_reload_p', relict_double_gun: '100mm_dbl_relic_reload', revolver_gun: ['revolver_legend_reload_start_p', 'revolver_legend_reload_shell'],
  revolver_legend: ['revolver_legend_reload_start_p', 'revolver_legend_reload_shell'], revolver_laser_legend: 'revolver_legend_reload_end_p',
  crossbow_revolver_relict: 'crossbow_revolver_epic_reload_start_p', crossbow_ballista_legend: 'crossbow_ballista_legend_charge_end',
  saw_launcher_legend: 'saw_launcher_reload_p', train_wheel_launcher_legend: 'twl_reload', wheel_launcher_epic: 'wheel_rocket_epic_reload_p',
  rocket_artillery_legend: 'rocket_artillery_legend_reload_p', missile_3x_relict: '3x_epic_reload_p', missile_3x_spiral_legend: '3x_epic_reload_p',
  missile_20x_legend: ['rl_reload_loop_p', 'rl_reload_end_part'], autocannon_2x: ['ac_te_reload_start', 'ac_te_reload_grain'], autocannon_revolver: 'reload_start',
  autocannon_revolver_epic: 'reload_start', cannon_assault_legend: 'cannon_t34_reload', barrel_launcher: 'catapult_ready', plasma_drill: 'plazma_drill_shot_final',
  plasma_drill_legendary: 'plasma_drill_legend_tail2',
};
const RELOAD_BY_KIND = { rocket: 'rocket_reload_start_p', guided: 'rocket_reload_start_p', rocketSpiral: '3x_epic_reload_p', cannon: 'cannon_t34_reload', cannonBig: 'cannon_t34_reload', grenade: 'gl_rare_reload_start' };
const CHARGE_BY_FOLDER = {
  lightning_gun: 'LightningGun_charge_p', nail_gun: 'nailgun_charge_p', nail_gun_epic: 'nailgun_epic_charge_p', crossbow_tempo: 'crossbow_tempo_charge',
  crossbow_tempo_legend: 'crossbow_tempo_legend_charge', grenade_launcher_2types_legend: 'gl2type_charge_mech1', shotgun_midrange_legend: 'mr_legend_charge_p',
  blade_launcher_legend: 'plazma_saw_charge', railgun_legend: 'railgun_charge_p',
};

// The sound of an activity of a model (anim.js activity names), or null: { shot } once, or { loop,
// start, end } held while it plays.
export function activitySound(path, act, layer = '', kind = null) {
  const m = /^models\/weapons\/([^/]+)\//.exec(path || '');
  if (!m || !act) return null;
  const f = m[1];
  if (act === 'ATTACK') return MELEE[f] || null;
  if (/^(COOLDOWN|FORCE_REFILL|RELOAD|BURST_LAST|AMMO_LOAD|SINGLE_REFILL)/.test(act) || (/^(CUSTOM1|TRANSITION)$/.test(act) && /reload|refill|beltswap/i.test(layer))) {
    const r = RELOAD_BY_FOLDER[f] || RELOAD_BY_KIND[kind] || 'reload_grain';
    return { shot: r, gain: 0.9 };
  }
  if (act === 'TENSION') return CHARGE_BY_FOLDER[f] ? { shot: CHARGE_BY_FOLDER[f] } : null;
  if (act === 'OPEN' || ((act === 'TRANSITION' || act === 'CUSTOM1') && /open|unfold/i.test(layer))) return { shot: 'ps_hatch_open_p', gain: 0.8 };
  if (act === 'CLOSE' || ((act === 'TRANSITION' || act === 'CUSTOM1') && /close/i.test(layer))) return { shot: 'ps_hatch_close_p', gain: 0.8 };
  return null;
}
export const meleeSound = (path) => MELEE[/^models\/weapons\/([^/]+)\//.exec(path || '')?.[1]] || null;

// A turret turning (its aim moving: the sliders, Look at me): the servo's whine held while it turns,
// its clunk when it stops. Heavy cannons have the T-34's and the 380 mm's, rocket turrets their own.
export function turretSound(path, yaw = true, kind = null) {
  const f = /^models\/weapons\/([^/]+)\//.exec(path || '')?.[1] || '';
  if (MELEE[f]) return null;
  const g = 0.45;
  if (f === 'cannon_ship_legend') return { loop: 'turret_380_turn_horizontal', end: 'turret_380_turn_stop', loopGain: g };
  if (f === 'railgun_legend') return { loop: yaw ? 'turret_turn_horizontal' : 'turret_turn_vertical', end: 'turret_railgun_legend_start_stop', loopGain: g };
  if (kind === 'cannonBig' || kind === 'cannon') return { loop: yaw ? 'turret_t34_turn_horizontal' : 'turret_t34_turn_vertical', end: 'turret_start_stop', loopGain: g };
  if (kind === 'rocket' || kind === 'guided' || kind === 'rocketSpiral') return { loop: 'rocket_turret_turn_horizontal', end: 'turret_start_stop', loopGain: g };
  return { loop: yaw ? 'turret_turn_horizontal' : 'turret_turn_vertical', end: 'turret_start_stop', loopGain: g * 0.8 };
}

// Hits by the effect kind of the round (fxmap.js HITS): [on the ground, on the target]; every: at most
// one this often (s), for beams that hit many times a second.
const HITS = {
  small: ['mg_bullet_ground', ['mg_bullet_car', 'mg_bullet_car_armor']], mid: ['20mm_stone', '20mm_bullet_car_metal'],
  big: ['100mm_debris_ground', 'big_cannon_hit_car'], shell: ['100mm_debris_ground', 'big_cannon_hit_car'],
  huge: [['large_explosion', '100mm_debris_ground'], ['big_cannon_hit_car', 'medium_explosion_close']],
  grenade: ['small_grenade_expl_close', 'small_grenade_expl_close'], rocket: ['medium_explosion_close', 'medium_explosion_close'],
  bomb: ['large_explosion', 'large_explosion'], blast: ['medium_explosion_close', 'medium_explosion_close'],
  flame: [null, null], plasma: ['plazma_hit_common', 'plazma_hit_common'], fusion: ['fusion_hit_common', 'fusion_hit_common'],
  bolt: ['crossbow_stone', 'crossbow_car'], revolver: ['20mm_stone', '20mm_bullet_car_metal'], coil: ['plazmaball_hit_common', 'plazmaball_hit_common'],
  frost: ['frost_gas', 'frost_gas', 0.6], sticky: ['crossbow_stone', 'harpoon_car'], stickyHybrid: ['crossbow_stone', 'harpoon_car'],
  tesla: ['tesla_hit_common', 'tesla_hit_common', 1.2], laser: ['laser_hit_common', 'laser_hit_common', 0.12],
  lightning: ['tesla_hit_common', 'tesla_hit_common', 0.3], drill: ['plasma_drill_metal', 'plasma_drill_metal', 0.25],
  ion: ['stun', 'stun', 1],
};
// what a few rounds hit with instead (by their kind)
const HITS_BY_KIND = {
  harpoon: ['harpoon_stone', 'harpoon_car'], sawLegend: ['saw_hit_common', 'saw_legend_hit_common'], sawRelic: ['saw_hit_common', 'saw_hit_common'],
  disc: ['saw_hit_common', 'saw_hit_common'], blades: ['crossbow_stone', 'crossbow_car'], bladesFan: ['crossbow_stone', 'crossbow_car'],
  nail: ['20mm_stone', 'nailgun_car'], plasma: ['plazma_hit_common', 'plazmaball_hit_common'],
};

// on water (a map's): bullets, shells, blasts splash
const WATER = { small: 'mg_bullet_water', mid: 'mg_bullet_water', revolver: 'mg_bullet_water', bolt: 'mg_bullet_water', big: '100mm_water', shell: '100mm_water', huge: '100mm_water' };

// on stone: bullets and shells crack and scatter it (wood sounds as the ground does)
const STONE = { small: '20mm_stone', mid: '20mm_stone', revolver: '20mm_stone', bolt: 'crossbow_stone', big: '100mm_debris_stone', shell: '100mm_debris_stone', huge: '100mm_debris_stone' };

// Far off (more than FAR_FROM metres), a blast sounds as the game's distant version of it; bullets and
// light hits are not heard past HEAR_SMALL metres.
export const FAR_FROM = 70, HEAR_SMALL = 130;
const FAR = {
  small_grenade_expl_close: 'small_grenade_explosion_far', medium_explosion_close: 'common_explosion_far', large_explosion: 'large_explosion_far',
  grenade_explosion_attack: 'grenade_explosion_far', big_cannon_hit_car: 'cannon_hit_explosion_distant', '100mm_debris_ground': 'cannon_hit_explosion_distant',
  barrel_mine_explosion: 'barrel_mine_explosion_far', tiny_expl: 'small_grenade_explosion_far', '100mm_debris_stone': 'cannon_hit_explosion_distant',
};
const SMALL = /^(mg_bullet|20mm_|crossbow_(car|stone)|laser_hit|ricochet|nailgun_car|harpoon_(car|stone)|plasma_drill_metal|tesla_hit|frost_gas|saw_hit|mg_rubber)/;
// what a family sounds like from d metres (null: not heard)
export function heardFrom(family, d) {
  const f = Array.isArray(family) ? family[0] : family;
  if (!f) return null;
  if (d > HEAR_SMALL && SMALL.test(f)) return null;
  return d > FAR_FROM && FAR[f] ? FAR[f] : family;
}

// [family, every] for a round of that spec landing on surface (0 the ground, 1 the target, 2 water,
// 3 stone, 4 wood: a map's)
export function hitSound(spec, surface) {
  if (surface === 2) {
    const beam = spec?.beam || spec?.stream;
    return beam ? null : [WATER[spec?.hit] || 'grenade_water', 0.05];
  }
  if (surface === 3 && STONE[spec?.hit] && !HITS_BY_KIND[spec?.kind]) return [STONE[spec.hit], 0.05];
  if (surface >= 3) surface = 0;
  const h = HITS_BY_KIND[spec?.kind] || HITS[spec?.hit];
  if (!h) return null;
  const f = h[surface ? 1 : 0];
  return f ? [f, h[2] || 0.05] : null;
}

// A round going off after it stuck or landed (spec.boom / spec.boomAt), by the effect's name
const BOOMS = [
  [/explosion_small_ags|mine/, 'small_grenade_expl_close'], [/2mode_sticky/, 'grenade_explosion_attack'],
  [/saw_launcher_proj_exp|explosion_small$/, 'tiny_expl'], [/sticky_bomb_burst|relict_sticky_bomb/, 'small_grenade_expl_close'],
  [/explosion_mid_tempo|explosion_mid$/, 'medium_explosion_close'], [/ion_shield_death/, 'shield_end_p'],
  [/explosion_small_missile/, 'large_explosion'], [/./, 'medium_explosion_close'],
];
export const boomSound = (path) => (path ? BOOMS.find(([re]) => re.test(path))[1] : null);

// What plays while a round sits stuck or landed (spec.work: a fuse, a mine's blinking): [family, loop]
const WORKS = [
  [/sticky_bomb_2mode_prepare|gameplay\/.*sticky_bomb_prepare/, 'crossbow_stickybomb_fuse', false], [/sticky_launcher\/sticky_bomb_prepare/, 'stickylauncher_bomb_beep', false],
  [/mine_active/, 'bomb_beep', false], [/ion_sphere_cooldown/, 'shield_loop_p', true], [/saw_launcher_proj_work/, 'saw_hit_common', true],
];
export function workSound(path) {
  const w = path && WORKS.find(([re]) => re.test(path));
  return w ? [w[1], w[2]] : null;
}

// a few more moments: a roller landing, a drone hovering, a harpoon's rope pulling taut and letting go
export const MOMENT = {
  roll: 'wheel_rocket_bounce', land: 'MineLauncher_mine_jump', droneEngine: 'quadrocopter_engine', droneShot: 'quadrocopter_military_shot',
  droneRocket: 'wasp_launch', rope: 'harpoon_rope', detach: 'harpoon_detach', fence: 'tesla_hit_common', trap: 'trap_common',
};
