// A map's own sounds (Maps mode): the ambience its environment plays all over it (the scene's
// soundscape: soundscapes.xml's event for the environment's sound zone), and the sounds placed on it
// (Sound_AmbientSoundSpot: fires, windmills, crickets, rain on a roof ...; Sound_SplineSound: rivers
// and marshes, heard from their nearest point). The map names FMOD events; the events that layer
// the game's samples are in its encrypted data, so they go by name to the samples (sound.js plays
// them): a soundscape to its air bed and its scattered calls (birds, crows, thunder), a spot to its
// loop or its calls. Only what is within earshot plays (the nearest few); everything fades out while
// the window is in the background.

// soundscapes: event (the last part of event:/ambient/soundscape/<name> or event:/ambient/air/<name>)
// -> bed: the air loop; calls: [[family, every s (min, max)], ...] heard somewhere around
const C = (fam, a, b) => [fam, a, b];
const BIRDS = C('morning_birds', 6, 16), CROWS = C('crows', 14, 30), OWL = C('owl', 14, 30), DESERT = C('desert_birds', 8, 20), GULLS = C('riverport_seagulls', 6, 14);
const CITY = C('cityruin_birds', 8, 18), THUNDER = C('thunder_long', 18, 40), DOGS = C('dogs', 25, 50), WINTER_DOG = C('dog_winter', 25, 50), CREAK = C('metal_creak', 10, 22);
const SOUNDSCAPES = {
  bridge_day: { bed: 'bridge_air_main', calls: [BIRDS, CROWS] }, bridge_cloudy: { bed: 'bridge_cloudy_main', calls: [CROWS] },
  pve_midland_cloudy: { bed: 'bridge_cloudy_main', calls: [CROWS] }, castle_day: { bed: 'country_main', calls: [BIRDS, CROWS] },
  building_yard_morning: { bed: 'building_yard_morning_air_main', calls: [BIRDS] }, line_defence_morning: { bed: 'building_yard_morning_air_main', calls: [BIRDS] },
  fieldbattle_day: { bed: 'country_main', calls: [BIRDS] }, fieldbattle_dawn: { bed: 'building_yard_morning_air_main', calls: [BIRDS] },
  fieldbattle_cloudy: { bed: 'bridge_cloudy_main', calls: [CROWS] }, iron_way_day: { bed: 'country_main', calls: [CROWS, BIRDS] },
  downtown_day: { bed: 'downtown_day', calls: [CITY] }, downtown_sunset: { bed: 'downtown_day', calls: [CITY] }, downtown_cloudy: { bed: 'downtown_day', calls: [CROWS] },
  compass_rose_sunset: { bed: 'downtown_day', calls: [CITY] }, plaza_sunset: { bed: 'cityruin_air_main', calls: [CITY] }, sinto_sunset: { bed: 'downtown_day', calls: [CITY] },
  sinto_day: { bed: 'downtown_day', calls: [CITY] }, cityruin_day: { bed: 'cityruin_air_main', calls: [CITY] },
  periphery_sunset: { bed: 'cityruin_air_main', calls: [CROWS, DOGS] }, periphery_day: { bed: 'cityruin_air_main', calls: [CITY, DOGS] },
  football_arena: { bed: 'football_arena' }, arizona_castle: { bed: 'sand_crater_air_main', calls: [DESERT] },
  bentmetall_rain: { bed: 'bridge_air_rain', calls: [THUNDER] }, big_plato_race: { bed: 'poligon_air_main', calls: [C('red_rock_wind', 10, 20)] },
  chemical_day: { bed: 'factory_air_main', calls: [C('leaves_factory', 8, 18), CREAK] }, factory_smog: { bed: 'factory_air_main', calls: [CREAK] },
  red_rock_main: { bed: 'sand_crater_air_main', calls: [C('red_rock_wind', 10, 20), DESERT] }, red_rock_arena: { bed: 'red_rock_arena' },
  red_rock_junkyard: { bed: 'red_rock_junkyard', calls: [CREAK] }, red_rock_big_metal: { bed: 'red_rock_junkyard', calls: [CREAK] },
  rockcity_2bases_day: { bed: 'rockcity_2bases_air_main', calls: [DESERT] }, rockcity_2bases_sunset: { bed: 'rockcity_2bases_air_main', calls: [DESERT] },
  rockcity_main: { bed: 'rockcity_air_main', calls: [DESERT] }, rockcity_2bases_main: { bed: 'rockcity_2bases_air_main', calls: [DESERT] },
  mountain_lake_day: { bed: 'mountain_lake_main', calls: [C('lake_birds_', 10, 22)] }, smallmap_race: { bed: 'poligon_air_main' },
  military_cloudy: { bed: 'poligon_air_main', calls: [CROWS] }, military_day: { bed: 'poligon_air_main', calls: [BIRDS] }, military_hangar: { bed: 'poligon_air_main', calls: [C('hangar_rustles', 6, 14)] },
  dunes_day: { bed: 'sand_crater_air_main', calls: [DESERT, C('sandstorm_far', 20, 40)] }, dunes_sunset: { bed: 'sand_crater_air_main', calls: [DESERT] },
  sand_crater_day: { bed: 'sand_crater_air_main', calls: [DESERT] }, quarry_day: { bed: 'sand_crater_air_main', calls: [DESERT] },
  gorge_day: { bed: 'lostcoast_air_main', calls: [C('lostcoast_rock_wind', 14, 28)] }, skyway_wind: { bed: 'lostcoast_air_main', calls: [C('lostcoast_rock_wind', 10, 22)] },
  holes: { bed: 'lostcoast_air_main', calls: [C('red_rock_wind', 12, 24)] }, lostcoast_main: { bed: 'lostcoast_air_main', calls: [GULLS] },
  geopp: { bed: 'geopp_night', calls: [OWL] }, abandoned_ship_main: { bed: 'lostcoast_air_main', calls: [GULLS, CREAK] },
  hangar_default_day: { bed: 'building_yard_air_main', calls: [C('hangar_rustles', 8, 16), BIRDS] }, hangar_default_cloudy: { bed: 'building_yard_air_main', calls: [C('hangar_rustles', 8, 16), CROWS] },
  hangar_default_sunset: { bed: 'building_yard_air_main', calls: [C('hangar_rustles', 8, 16)] }, hangar_default_sunrise: { bed: 'building_yard_morning_air_main', calls: [BIRDS] },
  hangar_default_inside: { bed: 'building_yard_air_hall' }, hangar_winter_inside: { bed: 'building_yard_air_hall' }, windy_hall: { bed: 'building_yard_air_hall' },
  miners_way_hall: { bed: 'building_yard_air_hall', calls: [CREAK] }, zombie_escape3_hall: { bed: 'building_yard_air_hall' }, zombie_escape3_corridor: { bed: 'building_yard_air_hall' },
  zombie_escape3_air: { bed: 'common_dark_winter_night', calls: [OWL] },
  '4horseman_day': { bed: '4horseman_air_main' }, '4horseman_cloudy': { bed: '4horseman_air_main', calls: [CROWS] },
  hangar_asia_day: { bed: 'mountain_lake_main', calls: [C('lake_birds_', 10, 22)] }, hangar_asia_cloudy: { bed: 'mountain_lake_fog' }, hangar_asia_sunset: { bed: 'mountain_lake_main' },
  hangar_asia_sunrise: { bed: 'mountain_lake_main', calls: [C('lake_birds_', 10, 22)] }, hangar_asia_lake: { bed: 'mountain_lake_main' },
  hangar_stadium_day: { bed: 'downtown_day', calls: [CITY] },
  common_winter_night: { bed: 'common_dark_winter_night', calls: [OWL, WINTER_DOG] }, common_winter_day: { bed: 'cemetery_highway_winter', calls: [CROWS, WINTER_DOG] },
  common_winter_day_city: { bed: 'cemetery_highway_winter', calls: [CROWS] }, hangar_common_winter: { bed: 'hangar_common_winter' }, highway: { bed: 'cemetery_highway_winter' },
  hangar_halloween23: { bed: 'bridge_cloudy_main', calls: [C('halloween_strange', 12, 26), THUNDER] }, hangar_halloween23_inside: { bed: 'building_yard_air_hall', calls: [C('halloween_strange', 12, 26)] },
  sulfur_day: { bed: 'vulkan_canyon', calls: [C('red_rock_wind', 12, 24)] }, sulfur_day_smoke: { bed: 'vulkan_canyon' }, vulkan_canyon: { bed: 'vulkan_canyon' },
  powerplant_day: { bed: 'powerplant_air_main', calls: [BIRDS] }, powerplant_rain: { bed: 'bridge_air_rain', calls: [THUNDER] }, under_bridge_rain: { bed: 'bridge_air_rain' },
  tower_rain: { bed: 'tower_rain_main', calls: [THUNDER] }, tower_sunny: { bed: 'poligon_air_main', calls: [BIRDS] },
  island_day: { bed: 'riverport_air_main', calls: [GULLS] }, island_sunset: { bed: 'riverport_air_main', calls: [GULLS] }, riverport: { bed: 'riverport_air_main', calls: [GULLS] },
  conflagration_day: { bed: 'conflagation_main_day' }, conflagration_sunset: { bed: 'conflagation_main_day' }, battleroyal: { bed: 'poligon_air_main' },
  arizona_silo_morning: { bed: 'building_yard_morning_air_main', calls: [DESERT] },
  common_dark_winter_night: { bed: 'common_dark_winter_night', calls: [OWL] }, mountain_lake_fog: { bed: 'mountain_lake_fog' },
  factory_evening: { bed: 'factory_air_main', calls: [CREAK] }, skyway_metal_creak: { bed: 'lostcoast_air_main', calls: [CREAK] },
  '4horseman_sunset': { bed: '4horseman_air_main' }, hangar_stadium_sunset: { bed: 'downtown_day' }, miners_way_air: { bed: 'building_yard_air_main', calls: [CREAK] },
  bentmetal_parking_rain: { bed: 'bridge_air_rain', calls: [C('rain_metal', 20, 40)] }, geopp_night: { bed: 'geopp_night', calls: [OWL] },
};
// a soundscape the table does not name: by words in its name
const SOUNDSCAPE_WORDS = [
  [/winter|snow|newyear/, { bed: 'hangar_common_winter' }], [/rain|storm/, { bed: 'bridge_air_rain', calls: [THUNDER] }],
  [/desert|dune|sand|canyon|rock/, { bed: 'sand_crater_air_main', calls: [DESERT] }], [/hall|inside|corridor|cave/, { bed: 'building_yard_air_hall' }],
  [/night/, { bed: 'geopp_night', calls: [OWL] }], [/wind/, { bed: 'lostcoast_air_main' }], [/./, { bed: 'poligon_air_main', calls: [BIRDS] }],
];
export function soundscapeOf(event) {
  if (!event) return null;
  const name = event.split('/').pop();
  return SOUNDSCAPES[name] || SOUNDSCAPE_WORDS.find(([re]) => re.test(name))[1];
}

// placed sounds: event name (its last part) -> { fam, loop (else calls every [a, b] s), ref (metres
// at full loudness), gain }
const L = (fam, ref = 4, gain = 1) => ({ fam, loop: true, ref, gain });
const N = (fam, a, b, ref = 6, gain = 1) => ({ fam, every: [a, b], ref, gain });
const SPOTS = {
  wreck_fire_large: L('firespot_big', 5), wreck_fire_small: L('firespot_small', 3), wreck_fire_metal: L('firespot_metal', 4), wreck_fire_metal_large: L('firespot_metal', 6),
  wreck_fire_big: L('firespot_large', 6), wreck_house_fire: L('firespot_large', 8), barrel_fire: L('firespot_barrel', 3), barrel_fire_hangar: L('firespot_barrel', 3),
  red_rock_fire_tower: L('fire_tower_close', 8), red_rock_fire_tower_small: L('fire_tower_close', 5, 0.8), base_fire: L('base_fire_loop', 5),
  rain_metal: L('rain_metal', 5, 0.8), crickets_bridge: L('leaves_crickets', 4, 0.7), crickets_country: L('leaves_crickets', 4, 0.7), crickets_tower: L('crickets_tower', 4, 0.7),
  windmill: L('windmill_loop', 8), windmill_low: L('windmill_loop', 6, 0.6), windmill_single: L('windmill_single_loop', 8), windmill_single_low: L('windmill_single_loop', 6, 0.6),
  windmill_single_large: L('windmill_large_loop', 12), metal_creak_mid: N('metal_creak', 8, 18, 6), metal_creak_large: N('metal_creak', 8, 18, 10),
  metal_creak_large_short: N('metal_creak', 6, 14, 10), ship_creak: N('metal_creak', 8, 18, 10), '4horseman_metal': N('metal_creak', 8, 18, 8),
  neon_hum: L('neon_hum', 2, 0.6), transform_hum: L('neon_hum', 3, 0.7), leaves_factory: N('leaves_factory', 4, 10, 6, 0.8), leaves_powerplant: N('leaves_factory', 4, 10, 6, 0.8),
  hw_storm_loop: N('thunder_long', 15, 35, 60), bridge_thunder: N('thunder_long', 15, 35, 80), thunder_short: N('thunder_short', 12, 30, 60),
  truck_idle: L('big_truck_idle', 4), water_pipe: L('water_pipe', 4, 0.8), water_pipe_small: L('water_pipe', 3, 0.6), red_rock_water_tank: L('water_pipe', 4, 0.7),
  holes_wind: L('pipe_wind_factory', 8, 0.8), lostcoast_wind: L('lostcoast_rock_wind', 10, 0.8), flag_flapping: L('cloth_flapping', 4, 0.8), flag_small_flapping: L('cloth_flapping', 3, 0.6),
  large_fan: N('big_fan_metal_oneshot', 0.5, 2, 8), generator: L('generator_idle', 4), projector_hangar: L('projector_loop', 4, 0.7), ventilation: L('ventilation_loop', 5),
  asian_street_voice1: N('asian_street_vo', 2, 6, 5), asian_street_voice2: N('asian_street_vo1_', 2, 6, 5), steam1: L('steam_loop', 4), factory_pipe: L('factory_pipe_loop', 5),
  waterfall: L('waterfall', 10), water_tower_idle: L('water_tower_idle', 5), military_hangar_random: N('hangar_rustles', 3, 8, 6), force_shield_gate: L('energy_gate_shield', 5),
  football_torch: L('football_torch', 4), shock_puddle: L('ElectricSpike_work_loop', 4), broken_oracle: N('OracleSentinel_ping', 2, 5, 6), quary_mining_station: L('exploration_drill', 8),
  // along a line
  marsh: L('marsh_loop', 10, 0.8), fieldbattle_river: L('medium_river_loop', 10), hangar_asia_river: L('medium_river_loop', 10), hangar_stadium_river: L('medium_river_loop', 10),
  island_boiling_water: L('geyser_base_loop', 8), Car_crusher: L('CarCrusher_idle', 6),
};
export function spotOf(event) {
  if (!event || /^event:\/(music|explosion)\//.test(event)) return null;
  return SPOTS[event.split('/').pop()] || null;
}
// a placed sound that is a whole soundscape (an air bed set down on the map: rockcity's)
export const isBedEvent = (event) => /^event:\/ambient\/(air|soundscape)\//.test(event || '') && !SPOTS[event.split('/').pop()];

const HEAR = 14;   // a placed sound plays within this many times its full-loudness distance
const MOST = 10;   // at most this many placed sounds at once (the nearest)
const BED_GAIN = 0.32, CALL_GAIN = 0.5;

export class Ambience {
  // sounds: sound.js Sounds; sceneOf(): the map scene to play (null: nothing); listener(): the camera
  constructor(sounds, { sceneOf, camera }) {
    this.s = sounds;
    this.sceneOf = sceneOf;
    this.camera = camera;
    this.scene = null;
    this.bed = null;
    this.calls = [];
    this.spots = []; // { def, pos, line, voice, next (one-shot calls: when), playing }
    this.next = 0;
    this.away = false; // (the window in the background)
    window.addEventListener('blur', () => { this.away = true; this.stop(); });
    window.addEventListener('focus', () => { this.away = false; });
  }

  // the scene to play now (called every frame: cheap unless something changed)
  tick() {
    const want = this.away || document.hidden ? null : this.sceneOf();
    if (want !== this.scene) {
      this.stop();
      if (want) this.start(want);
    }
    if (!this.scene) return;
    const t = performance.now() / 1000;
    if (t < this.next) return;
    this.next = t + 0.25;
    this.update(t);
  }

  start(scene) {
    this.scene = scene;
    const bedEvent = scene.soundscape || scene.sounds?.find((x) => isBedEvent(x.event))?.event || null;
    const sc = soundscapeOf(bedEvent);
    this.bedEvent = bedEvent;
    this.bedFam = sc?.bed || null;
    this.calls = (sc?.calls || []).map(([fam, a, b]) => ({ fam, a, b, at: performance.now() / 1000 + a * Math.random() }));
    this.spots = (scene.sounds || []).map((x) => ({ event: x.event, def: spotOf(x.event), pos: x.pos, line: x.line || null, voice: null, asking: false, at: 0 })).filter((x) => x.def);
    this.s.preload(this.bedFam, ...this.calls.map((c) => c.fam), ...new Set(this.spots.map((x) => x.def.fam)));
  }

  stop() {
    this.bed?.stop(1);
    this.bed = null;
    this.bedFam = null;
    this.bedAsking = false;
    for (const p of this.spots) { p.voice?.stop(0.8); p.voice = null; }
    this.spots = [];
    this.calls = [];
    this.scene = null;
  }

  // where the listener hears a placed sound from: its spot, or a line's nearest point
  where(p, cam) {
    if (!p.line) return p.pos;
    let best = p.line.slice(0, 3), bd = Infinity;
    for (let i = 0; i + 5 < p.line.length; i += 3) {
      const ax = p.line[i], ay = p.line[i + 1], az = p.line[i + 2], dx = p.line[i + 3] - ax, dy = p.line[i + 4] - ay, dz = p.line[i + 5] - az;
      const l2 = dx * dx + dy * dy + dz * dz;
      const k = l2 > 0 ? Math.max(0, Math.min(1, ((cam.x - ax) * dx + (cam.y - ay) * dy + (cam.z - az) * dz) / l2)) : 0;
      const q = [ax + dx * k, ay + dy * k, az + dz * k], d = (q[0] - cam.x) ** 2 + (q[1] - cam.y) ** 2 + (q[2] - cam.z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  update(t) {
    const cam = this.camera().position;
    // the bed (asked again while the browser still held audio back, or after everything was stopped)
    if (this.bed?.ended) this.bed = null;
    if (this.bedFam && !this.bed && !this.bedAsking) {
      const scene = this.scene;
      this.bedAsking = true;
      this.s.play(this.bedFam, null, { loop: true, gain: BED_GAIN, fade: 2, offset: 'random' }).then((v) => { this.bedAsking = false; if (this.scene === scene) this.bed = v; else v?.stop(); });
    }
    // the soundscape's calls: somewhere around the listener, now and then
    for (const c of this.calls) {
      if (t < c.at) continue;
      c.at = t + c.a + Math.random() * (c.b - c.a);
      const a = Math.random() * 2 * Math.PI, r = 25 + Math.random() * 45;
      this.s.play(c.fam, [cam.x + Math.cos(a) * r, cam.y + 6 + Math.random() * 10, cam.z + Math.sin(a) * r], { gain: CALL_GAIN, ref: 20, rolloff: 0.6 });
    }
    // the placed sounds: the nearest within earshot play, the rest are let go
    const near = this.spots.map((p) => { const w = this.where(p, cam); return { p, w, d: Math.hypot(w[0] - cam.x, w[1] - cam.y, w[2] - cam.z) }; })
      .filter((x) => x.d < x.p.def.ref * HEAR).sort((a, b) => a.d - b.d).slice(0, MOST);
    const keep = new Set(near.map((x) => x.p));
    for (const p of this.spots) if (!keep.has(p) && p.voice) { p.voice.stop(1.2); p.voice = null; }
    for (const { p, w } of near) {
      const def = p.def, opts = { gain: def.gain, ref: def.ref, rolloff: 1 };
      if (p.voice?.ended) p.voice = null;
      if (def.loop) {
        if (p.voice) this.s.move(p.voice, w);
        else if (!p.asking) {
          p.asking = true;
          this.s.play(def.fam, w, { ...opts, loop: true, fade: 1.5, offset: 'random' }).then((v) => { p.asking = false; if (this.spots.includes(p) && keep.has(p)) p.voice = v; else v?.stop(); });
        }
      } else if (t >= p.at) {
        p.at = t + def.every[0] + Math.random() * (def.every[1] - def.every[0]);
        this.s.play(def.fam, w, opts);
      }
    }
  }
}
