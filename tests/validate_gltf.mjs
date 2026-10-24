// Structural validator for the exporter's glTF 2.0 output (.glb / .gltf).
//   node tests/validate_gltf.mjs <file.glb|file.gltf> [...]
// Checks the container, every bufferView/accessor range and alignment, POSITION min/max,
// unit normals, tangent handedness, index ranges, image data, and node/material references.
import fs from 'node:fs';
import path from 'node:path';

const COMP = { 5120: [1, 'i8'], 5121: [1, 'u8'], 5122: [2, 'i16'], 5123: [2, 'u16'], 5125: [4, 'u32'], 5126: [4, 'f32'] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function load(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.glb')) {
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('bad GLB magic');
    if (buf.readUInt32LE(4) !== 2) throw new Error('GLB version is not 2');
    if (buf.readUInt32LE(8) !== buf.length) throw new Error(`GLB length ${buf.readUInt32LE(8)} != file ${buf.length}`);
    const jl = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
    if (jl % 4) throw new Error('JSON chunk not 4-byte aligned');
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    const bo = 20 + jl;
    const bl = buf.readUInt32LE(bo);
    if (buf.readUInt32LE(bo + 4) !== 0x004e4942) throw new Error('second chunk is not BIN');
    return { json, bin: buf.subarray(bo + 8, bo + 8 + bl), dir: path.dirname(file) };
  }
  const json = JSON.parse(buf.toString('utf8'));
  const b0 = json.buffers?.[0];
  const bin = b0?.uri ? fs.readFileSync(path.join(path.dirname(file), uriPath(b0.uri))) : Buffer.alloc(0);
  return { json, bin, dir: path.dirname(file) };
}

// A relative URI as a file path; null when it is not a valid URI reference (spaces, non-ASCII or
// a bare % must be percent-encoded).
function uriPath(uri) {
  if (!/^([A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/.test(uri)) return null;
  return decodeURIComponent(uri);
}

function validate(file) {
  const errors = [], warn = [];
  const E = (m) => errors.push(m);
  const { json: g, bin, dir } = load(file);
  if (g.asset?.version !== '2.0') E('asset.version must be "2.0"');
  if ((g.buffers?.[0]?.byteLength ?? 0) > bin.length) E(`buffer byteLength ${g.buffers[0].byteLength} > data ${bin.length}`);
  const views = g.bufferViews || [];
  for (const b of g.buffers || []) if (b.uri !== undefined && uriPath(b.uri) === null) E(`buffer uri "${b.uri}" is not a valid URI reference`);
  views.forEach((v, i) => {
    if (v.buffer !== 0) E(`bufferView ${i}: buffer ${v.buffer}`);
    if (!(v.byteLength >= 1)) E(`bufferView ${i}: byteLength ${v.byteLength} (must be at least 1)`);
    if ((v.byteOffset || 0) + v.byteLength > bin.length) E(`bufferView ${i} runs past the buffer`);
    if ((v.byteOffset || 0) % 4) warn.push(`bufferView ${i} not 4-byte aligned`);
  });
  const read = (ai) => {
    const a = g.accessors[ai];
    if (!a) { E(`accessor ${ai} missing`); return null; }
    if (!(a.count >= 1)) { E(`accessor ${ai}: count ${a.count} (must be at least 1)`); return null; }
    const [size, kind] = COMP[a.componentType] || [];
    if (!size) { E(`accessor ${ai}: componentType ${a.componentType}`); return null; }
    const nc = NCOMP[a.type];
    const v = views[a.bufferView];
    if (!v) { E(`accessor ${ai}: bufferView ${a.bufferView}`); return null; }
    const start = (v.byteOffset || 0) + (a.byteOffset || 0);
    const stride = v.byteStride || size * nc;
    if (start % size) E(`accessor ${ai}: offset not aligned to component size`);
    if ((a.byteOffset || 0) + stride * (a.count - 1) + size * nc > v.byteLength) E(`accessor ${ai}: runs past its bufferView`);
    const out = new Float64Array(a.count * nc);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) {
      const p = start + i * stride + c * size;
      out[i * nc + c] = kind === 'f32' ? bin.readFloatLE(p) : kind === 'u16' ? bin.readUInt16LE(p) : kind === 'u32' ? bin.readUInt32LE(p)
        : kind === 'u8' ? bin[p] : kind === 'i8' ? bin.readInt8(p) : bin.readInt16LE(p);
    }
    return { a, nc, data: out };
  };
  let tris = 0, verts = 0;
  (g.meshes || []).forEach((m, mi) => m.primitives.forEach((pr, pi) => {
    const where = `mesh ${mi} prim ${pi}`;
    const pos = read(pr.attributes.POSITION);
    if (!pos) return;
    const n = pos.a.count;
    verts += n;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      const v = pos.data[i * 3 + c];
      if (!Number.isFinite(v)) E(`${where}: non-finite position`);
      mn[c] = Math.min(mn[c], v); mx[c] = Math.max(mx[c], v);
    }
    if (!pos.a.min || !pos.a.max) E(`${where}: POSITION needs min/max`);
    else for (let c = 0; c < 3; c++) if (Math.abs(pos.a.min[c] - mn[c]) > 1e-5 || Math.abs(pos.a.max[c] - mx[c]) > 1e-5) E(`${where}: POSITION min/max wrong`);
    for (const [name, want] of Object.entries({ NORMAL: 'VEC3', TANGENT: 'VEC4', TEXCOORD_0: 'VEC2', TEXCOORD_1: 'VEC2', COLOR_0: 'VEC4' })) {
      if (pr.attributes[name] === undefined) continue;
      const acc = read(pr.attributes[name]);
      if (!acc) continue;
      if (acc.a.type !== want) E(`${where}: ${name} type ${acc.a.type}`);
      if (acc.a.count !== n) E(`${where}: ${name} count ${acc.a.count} != ${n}`);
      if (name === 'COLOR_0' && acc.a.componentType !== 5126 && !acc.a.normalized) E(`${where}: integer COLOR_0 must be normalized`);
      if (name === 'NORMAL' || name === 'TANGENT') {
        let bad = 0;
        for (let i = 0; i < n; i++) {
          const k = i * acc.nc, l = Math.hypot(acc.data[k], acc.data[k + 1], acc.data[k + 2]);
          if (Math.abs(l - 1) > 1e-3) bad++;
          if (name === 'TANGENT' && Math.abs(Math.abs(acc.data[k + 3]) - 1) > 1e-6) bad++;
        }
        if (bad) E(`${where}: ${bad} ${name} values not unit length / w not +-1`);
      }
    }
    if (pr.indices !== undefined) {
      const idx = read(pr.indices);
      if (idx) {
        if (idx.a.count % 3) E(`${where}: index count not a multiple of 3`);
        let over = 0; for (const v of idx.data) if (v >= n) over++;
        if (over) E(`${where}: ${over} indices >= vertex count`);
        tris += idx.a.count / 3;
        if (views[idx.a.bufferView].target !== undefined && views[idx.a.bufferView].target !== 34963) E(`${where}: index view target`);
      }
    }
    if (pr.material !== undefined && !g.materials?.[pr.material]) E(`${where}: material ${pr.material} missing`);
    const mat = g.materials?.[pr.material];
    if (mat) {
      const refs = [mat.pbrMetallicRoughness?.baseColorTexture, mat.pbrMetallicRoughness?.metallicRoughnessTexture, mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture].filter(Boolean);
      for (const r of refs) {
        const set = r.extensions?.KHR_texture_transform?.texCoord ?? r.texCoord ?? 0;
        if (pr.attributes[`TEXCOORD_${set}`] === undefined) E(`${where}: its material reads TEXCOORD_${set}, which it does not have`);
      }
    }
  }));
  (g.materials || []).forEach((m, i) => {
    const refs = [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture].filter(Boolean);
    for (const r of refs) if (!g.textures?.[r.index]) E(`material ${i}: texture ${r.index} missing`);
    const inRange = (v, n) => Array.isArray(v) && v.length === n && v.every((c) => c >= 0 && c <= 1);
    if (m.pbrMetallicRoughness?.baseColorFactor && !inRange(m.pbrMetallicRoughness.baseColorFactor, 4)) E(`material ${i}: baseColorFactor must be 4 values in 0..1`);
    if (m.emissiveFactor && !inRange(m.emissiveFactor, 3)) E(`material ${i}: emissiveFactor must be 3 values in 0..1`);
    const es = m.extensions?.KHR_materials_emissive_strength;
    if (es && !(es.emissiveStrength >= 0)) E(`material ${i}: emissiveStrength ${es.emissiveStrength}`);
  });
  (g.textures || []).forEach((t, i) => {
    if (!g.images?.[t.source]) E(`texture ${i}: image ${t.source} missing`);
    if (t.sampler !== undefined && !g.samplers?.[t.sampler]) E(`texture ${i}: sampler missing`);
  });
  (g.images || []).forEach((im, i) => {
    let head;
    if (im.bufferView !== undefined) {
      const v = views[im.bufferView];
      head = bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + 8);
      if (im.mimeType !== 'image/png') E(`image ${i}: mimeType`);
    } else if (im.uri) {
      const rel = uriPath(im.uri);
      if (rel === null) { E(`image ${i}: uri "${im.uri}" is not a valid URI reference`); return; }
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) { E(`image ${i}: ${im.uri} missing`); return; }
      head = fs.readFileSync(p).subarray(0, 8);
    }
    if (!head || head.toString('hex') !== '89504e470d0a1a0a') E(`image ${i}: not a PNG`);
  });
  const nodes = g.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((nd, i) => {
    if (nd.children && !nd.children.length) E(`node ${i}: an empty children list (leave it out)`);
    for (const c of nd.children || []) {
      if (!nodes[c]) E(`node ${i}: child ${c} missing`);
      else if (parent[c] !== -1) E(`node ${c} has two parents`);
      else parent[c] = i;
    }
    if (nd.matrix && nd.matrix.length !== 16) E(`node ${i}: matrix length`);
    if (nd.mesh !== undefined && !g.meshes?.[nd.mesh]) E(`node ${i}: mesh missing`);
  });
  for (const s of g.scenes || []) for (const r of s.nodes) if (!nodes[r] || parent[r] !== -1) E(`scene root ${r} invalid`);
  nodes.forEach((nd, i) => { // (a cycle: following parents never ends)
    let k = i, steps = 0;
    while (k >= 0 && steps <= nodes.length) { k = parent[k]; steps++; }
    if (steps > nodes.length) E(`node ${i} is in a cycle`);
  });

  // Extensions: every one used is declared; EXT_mesh_gpu_instancing (float TRANSLATION / ROTATION /
  // SCALE of one count, unit rotations, on mesh nodes); KHR_lights_punctual (valid lights and references).
  const used = new Set(g.extensionsUsed || []);
  const declare = (name, where) => { if (!used.has(name)) E(`${where} uses ${name}, not in extensionsUsed`); };
  for (const r of g.extensionsRequired || []) if (!used.has(r)) E(`extensionsRequired ${r} is not in extensionsUsed`);
  let copies = 0;
  const lights = g.extensions?.KHR_lights_punctual?.lights;
  if (g.extensions?.KHR_lights_punctual) {
    declare('KHR_lights_punctual', 'the file');
    if (!Array.isArray(lights) || !lights.length) E('KHR_lights_punctual: no lights');
    (lights || []).forEach((l, i) => {
      if (!['directional', 'point', 'spot'].includes(l.type)) E(`light ${i}: type ${l.type}`);
      if (l.color && (l.color.length !== 3 || l.color.some((c) => !(c >= 0 && c <= 1)))) E(`light ${i}: color must be 3 values in 0..1`);
      if (l.intensity !== undefined && !(l.intensity >= 0)) E(`light ${i}: intensity ${l.intensity}`);
    });
  }
  nodes.forEach((nd, i) => {
    for (const name of Object.keys(nd.extensions || {})) declare(name, `node ${i}`);
    const lp = nd.extensions?.KHR_lights_punctual;
    if (lp && !lights?.[lp.light]) E(`node ${i}: light ${lp.light} missing`);
    if (nd.rotation && Math.abs(Math.hypot(...nd.rotation) - 1) > 1e-4) E(`node ${i}: rotation not unit length`);
    const inst = nd.extensions?.EXT_mesh_gpu_instancing;
    if (!inst) return;
    if (nd.mesh === undefined) E(`node ${i}: EXT_mesh_gpu_instancing without a mesh`);
    let count = -1;
    for (const [name, acc] of Object.entries(inst.attributes || {})) {
      const want = { TRANSLATION: 'VEC3', ROTATION: 'VEC4', SCALE: 'VEC3' }[name];
      if (!want && !name.startsWith('_')) { E(`node ${i}: instance attribute ${name}`); continue; }
      const a = read(acc);
      if (!a) continue;
      if (want && (a.a.type !== want || a.a.componentType !== 5126)) E(`node ${i}: ${name} must be float ${want}`);
      if (count >= 0 && a.a.count !== count) E(`node ${i}: instance attributes of different counts`);
      count = a.a.count;
      let bad = 0;
      for (const v of a.data) if (!Number.isFinite(v)) bad++;
      if (name === 'ROTATION') for (let k = 0; k < a.a.count; k++) if (Math.abs(Math.hypot(...a.data.subarray(k * 4, k * 4 + 4)) - 1) > 1e-3) bad++;
      if (name === 'TRANSLATION' && a.a.min) for (let k = 0; k < a.a.count; k++) for (let c = 0; c < 3; c++) if (a.data[k * 3 + c] < a.a.min[c] - 1e-4 || a.data[k * 3 + c] > a.a.max[c] + 1e-4) bad++;
      if (bad) E(`node ${i}: ${bad} bad ${name} values`);
    }
    if (count < 0) E(`node ${i}: EXT_mesh_gpu_instancing without attributes`);
    else copies += count;
  });
  for (const name of Object.keys(g.extensions || {})) declare(name, 'the file');
  (g.materials || []).forEach((m, i) => {
    if (m.alphaMode && !['OPAQUE', 'MASK', 'BLEND'].includes(m.alphaMode)) E(`material ${i}: alphaMode ${m.alphaMode}`);
    for (const name of Object.keys(m.extensions || {})) declare(name, `material ${i}`);
  });

  // Skins: joints valid, one inverse bind matrix each, and in the rest pose (the nodes' own TRS)
  // every joint's world matrix times its inverse bind matrix is the identity.
  const compose = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
    const [x, y, z, w] = q, [sx, sy, sz] = s;
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0, 2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
      2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, t[0], t[1], t[2], 1];
  };
  const mul = (a, b) => { const r = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k]; return r; };
  const worldOf = [];
  const world = (i) => worldOf[i] || (worldOf[i] = parent[i] >= 0 ? mul(world(parent[i]), nodes[i].matrix || compose(nodes[i].translation, nodes[i].rotation, nodes[i].scale)) : (nodes[i].matrix || compose(nodes[i].translation, nodes[i].rotation, nodes[i].scale)));
  let jointsMax = 0;
  (g.skins || []).forEach((s, si) => {
    if (!s.joints?.length) { E(`skin ${si}: no joints`); return; }
    if (new Set(s.joints).size !== s.joints.length) E(`skin ${si}: a joint listed twice`);
    for (const j of s.joints) if (!nodes[j]) E(`skin ${si}: joint ${j} missing`);
    if (s.skeleton !== undefined && !nodes[s.skeleton]) E(`skin ${si}: skeleton ${s.skeleton} missing`);
    else if (s.skeleton !== undefined) {
      const under = (j) => { for (let k = j, n = 0; k >= 0 && n <= nodes.length; k = parent[k], n++) if (k === s.skeleton) return true; return false; };
      const out = s.joints.filter((j) => nodes[j] && !under(j)).length;
      if (out) E(`skin ${si}: skeleton ${s.skeleton} is not an ancestor of ${out} joint(s)`);
    }
    jointsMax = Math.max(jointsMax, s.joints.length);
    if (s.inverseBindMatrices === undefined) return;
    const ibm = read(s.inverseBindMatrices);
    if (!ibm) return;
    if (ibm.a.type !== 'MAT4' || ibm.a.count !== s.joints.length) E(`skin ${si}: inverseBindMatrices must be ${s.joints.length} MAT4`);
    let off = 0;
    s.joints.forEach((j, k) => {
      if (!nodes[j]) return;
      const m = mul(world(j), Array.from(ibm.data.subarray(k * 16, k * 16 + 16)));
      for (let e = 0; e < 16; e++) off = Math.max(off, Math.abs(m[e] - (e % 5 === 0 ? 1 : 0)));
    });
    if (off > 1e-3) E(`skin ${si}: a joint's rest world matrix times its inverse bind matrix is off identity by ${off.toFixed(4)}`);
  });
  nodes.forEach((nd, i) => {
    if (nd.skin === undefined) return;
    if (!g.skins?.[nd.skin]) { E(`node ${i}: skin ${nd.skin} missing`); return; }
    const mesh = g.meshes?.[nd.mesh];
    if (!mesh) E(`node ${i}: a skin needs a mesh`);
    for (const [pi, pr] of (mesh?.primitives || []).entries()) {
      if (pr.attributes.JOINTS_0 === undefined || pr.attributes.WEIGHTS_0 === undefined) { E(`node ${i} mesh prim ${pi}: skinned but no JOINTS_0 / WEIGHTS_0`); continue; }
      const jt = read(pr.attributes.JOINTS_0), wt = read(pr.attributes.WEIGHTS_0);
      if (!jt || !wt) continue;
      let badJ = 0, badW = 0, dupJ = 0;
      for (const v of jt.data) if (v >= g.skins[nd.skin].joints.length) badJ++;
      for (let k = 0; k < wt.a.count; k++) {
        const w4 = wt.data.subarray(k * 4, k * 4 + 4), j4 = jt.data.subarray(k * 4, k * 4 + 4);
        if (w4.some((x) => x < 0) || Math.abs(w4[0] + w4[1] + w4[2] + w4[3] - 1) > 1e-5) badW++;
        const used = [0, 1, 2, 3].filter((c) => w4[c] > 0).map((c) => j4[c]);
        if (new Set(used).size !== used.length) dupJ++;
      }
      if (badJ) E(`node ${i} mesh prim ${pi}: ${badJ} joint indices past the skin's joints`);
      if (badW) E(`node ${i} mesh prim ${pi}: ${badW} vertices whose weights don't add up to 1`);
      if (dupJ) E(`node ${i} mesh prim ${pi}: ${dupJ} vertices name one joint twice with weight`);
    }
  });

  // Animations: valid targets, strictly increasing key times with min / max, matching counts,
  // unit rotations, one channel per node and property.
  let channelsN = 0;
  (g.animations || []).forEach((an, ai) => {
    const seen = new Set();
    for (const [ci, ch] of (an.channels || []).entries()) {
      channelsN++;
      const s = an.samplers?.[ch.sampler];
      const where = `animation ${ai} ("${an.name}") channel ${ci}`;
      if (!s) { E(`${where}: sampler ${ch.sampler} missing`); continue; }
      if (!nodes[ch.target?.node]) E(`${where}: node ${ch.target?.node} missing`);
      const key = `${ch.target?.node}/${ch.target?.path}`;
      if (seen.has(key)) E(`${where}: ${key} animated twice`);
      seen.add(key);
      const want = { translation: 'VEC3', scale: 'VEC3', rotation: 'VEC4' }[ch.target?.path];
      if (!want) { E(`${where}: path ${ch.target?.path}`); continue; }
      const inp = read(s.input), out = read(s.output);
      if (!inp || !out) continue;
      if (inp.a.type !== 'SCALAR' || inp.a.componentType !== 5126) E(`${where}: input must be float scalars`);
      if (!inp.a.min || !inp.a.max) E(`${where}: input needs min / max`);
      else if (Math.abs(inp.a.min[0] - Math.min(...inp.data)) > 1e-6 || Math.abs(inp.a.max[0] - Math.max(...inp.data)) > 1e-6) E(`${where}: input min / max do not match the key times`);
      for (let k = 1; k < inp.a.count; k++) if (!(inp.data[k] > inp.data[k - 1])) { E(`${where}: key times not strictly increasing`); break; }
      if (out.a.type !== want) E(`${where}: output ${out.a.type}, want ${want}`);
      if (out.a.count !== inp.a.count) E(`${where}: ${out.a.count} values for ${inp.a.count} key times`);
      if (want === 'VEC4') for (let k = 0; k < out.a.count; k++) if (Math.abs(Math.hypot(...out.data.subarray(k * 4, k * 4 + 4)) - 1) > 1e-3) { E(`${where}: rotation not unit length`); break; }
    }
  });
  return { errors, warn, summary: `${(g.meshes || []).length} meshes, ${verts} vertices, ${tris} triangles, ${(g.materials || []).length} materials, ${(g.images || []).length} images, ${nodes.length} nodes${g.skins?.length ? `, ${jointsMax} joints` : ''}${g.animations?.length ? `, ${g.animations.length} animations (${channelsN} channels)` : ''}${copies ? `, ${copies} instanced copies` : ''}${lights?.length ? `, ${lights.length} light(s)` : ''}` };
}

let failed = 0;
// Arguments may be files or folders (every .glb/.gltf inside is checked).
const inputs = process.argv.slice(2).flatMap((a) =>
  fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((n) => /\.(glb|gltf)$/i.test(n)).map((n) => path.join(a, n)) : [a]);
let passed = 0;
process.on('exit', () => { if (inputs.length > 1) console.log(`${passed} ok, ${failed} failed`); });
for (const f of inputs) {
  try {
    const r = validate(f);
    console.log(`${r.errors.length ? 'FAIL' : 'ok  '} ${path.basename(f)}: ${r.summary}`);
    r.errors.slice(0, 20).forEach((e) => console.log('   error: ' + e));
    r.warn.slice(0, 5).forEach((w) => console.log('   warn: ' + w));
    if (r.errors.length) failed++; else passed++;
  } catch (e) { console.log(`FAIL ${path.basename(f)}: ${e.message}`); failed++; }
}
process.exit(failed ? 1 : 0);
