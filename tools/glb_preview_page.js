// Page side of tools/glb_preview.mjs: a small loader for the exporter's own .glb files (meshes,
// PBR materials with embedded PNGs, node matrices) and one render with sun, sky and fog.
import * as THREE from '/lib/three/three.module.min.js';

const q = new URLSearchParams(location.search);
window.__state = 'loading';
const vec = (s) => (s ? s.split(',').map(Number) : null);

try {
  const buf = await (await fetch('/model.glb')).arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a .glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;

  const accessor = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
    const off = binStart + (v.byteOffset || 0) + (a.byteOffset || 0);
    const arr = off % T.BYTES_PER_ELEMENT === 0 ? new T(buf, off, a.count * comps) : new T(buf.slice(off, off + a.count * comps * T.BYTES_PER_ELEMENT));
    return new THREE.BufferAttribute(arr, comps, !!a.normalized);
  };

  // textures (embedded PNGs)
  const bitmaps = await Promise.all((json.images || []).map(async (im) => {
    const v = json.bufferViews[im.bufferView];
    const blob = new Blob([new Uint8Array(buf, binStart + (v.byteOffset || 0), v.byteLength)], { type: im.mimeType });
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); // (as stored: three.js expects straight alpha)
  }));
  const texCache = new Map();
  const texture = (ref, srgb) => {
    if (!ref) return null;
    const key = ref.index + (srgb ? 's' : 'l');
    if (texCache.has(key)) return texCache.get(key);
    const t = new THREE.Texture(bitmaps[json.textures[ref.index].source]);
    t.flipY = false;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
    texCache.set(key, t);
    return t;
  };

  // A Radiance .hdr (the map export's sky) -> an equirectangular half-float texture.
  const parseHdr = (ab) => {
    const b = new Uint8Array(ab);
    let p = 0;
    const line = () => { let s = ''; while (p < b.length && b[p] !== 10) s += String.fromCharCode(b[p++]); p++; return s; };
    if (!line().startsWith('#?')) throw new Error('not a Radiance .hdr');
    while (p < b.length && line() !== '') { /* header */ }
    const m = /-Y (\d+) \+X (\d+)/.exec(line());
    if (!m) throw new Error('unsupported .hdr orientation');
    const h = +m[1], w = +m[2], data = new Uint16Array(w * h * 4), px = new Uint8Array(w * 4);
    for (let y = 0; y < h; y++) {
      if (b[p] === 2 && b[p + 1] === 2 && ((b[p + 2] << 8) | b[p + 3]) === w) {
        p += 4;
        for (let c = 0; c < 4; c++) for (let x = 0; x < w;) {
          let n = b[p++];
          if (n > 128) { n -= 128; const v = b[p++]; while (n--) px[(x++) * 4 + c] = v; } else { while (n--) px[(x++) * 4 + c] = b[p++]; }
        }
      } else { px.set(b.subarray(p, p + w * 4)); p += w * 4; }
      for (let x = 0; x < w; x++) {
        const e = px[x * 4 + 3], f = e ? 2 ** (e - 136) : 0, o = ((h - 1 - y) * w + x) * 4; // (row 0 of a DataTexture is the bottom)
        for (let c = 0; c < 3; c++) data[o + c] = THREE.DataUtils.toHalfFloat(px[x * 4 + c] * f);
        data[o + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.LinearSRGBColorSpace;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };

  const materials = (json.materials || []).map((m) => {
    const pbr = m.pbrMetallicRoughness || {};
    const f = pbr.baseColorFactor || [1, 1, 1, 1];
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(f[0], f[1], f[2], THREE.LinearSRGBColorSpace),
      opacity: f[3],
      metalness: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      map: texture(pbr.baseColorTexture, true),
      normalMap: texture(m.normalTexture, false),
      side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    const orm = texture(pbr.metallicRoughnessTexture, false);
    if (orm) mat.roughnessMap = mat.metalnessMap = orm;
    if (m.alphaMode === 'BLEND') { mat.transparent = true; mat.depthWrite = false; }
    if (m.alphaMode === 'MASK') mat.alphaTest = m.alphaCutoff ?? 0.5;
    if (m.emissiveTexture) {
      mat.emissiveMap = texture(m.emissiveTexture, true);
      const e = m.emissiveFactor || [1, 1, 1];
      mat.emissive = new THREE.Color().setRGB(e[0], e[1], e[2], THREE.LinearSRGBColorSpace);
    }
    return mat;
  });
  const fallback = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
  const colored = new Map(); // (materials of meshes with COLOR_0: vertex colours on, alpha too)
  const withColors = (mat) => {
    if (!colored.has(mat)) { const c = mat.clone(); c.vertexColors = true; colored.set(mat, c); }
    return colored.get(mat);
  };

  const meshes = (json.meshes || []).map((me) => me.primitives.map((p) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', accessor(p.attributes.POSITION));
    if (p.attributes.NORMAL !== undefined) g.setAttribute('normal', accessor(p.attributes.NORMAL));
    if (p.attributes.TEXCOORD_0 !== undefined) g.setAttribute('uv', accessor(p.attributes.TEXCOORD_0));
    if (p.attributes.TANGENT !== undefined) g.setAttribute('tangent', accessor(p.attributes.TANGENT));
    if (p.attributes.COLOR_0 !== undefined) g.setAttribute('color', accessor(p.attributes.COLOR_0));
    if (p.indices !== undefined) g.setIndex(accessor(p.indices));
    if (p.attributes.NORMAL === undefined) g.computeVertexNormals();
    const mat = p.material !== undefined ? materials[p.material] : fallback;
    return { g, mat: p.attributes.COLOR_0 !== undefined ? withColors(mat) : mat };
  }));

  let instances = 0;
  const lightNodes = [];
  const objects = (json.nodes || []).map((n, ni) => {
    const o = new THREE.Object3D();
    if (n.matrix) {
      const m = new THREE.Matrix4().fromArray(n.matrix);
      m.decompose(o.position, o.quaternion, o.scale);
    } else {
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
    }
    const inst = n.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (n.mesh !== undefined)
      for (const { g, mat } of meshes[n.mesh]) {
        let mesh;
        if (inst) { // copies (a map's grass)
          const T = accessor(inst.TRANSLATION).array, R = accessor(inst.ROTATION).array, S = accessor(inst.SCALE).array, count = T.length / 3;
          mesh = new THREE.InstancedMesh(g, mat, count);
          const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          for (let i = 0; i < count; i++) mesh.setMatrixAt(i, m.compose(p.fromArray(T, i * 3), q.fromArray(R, i * 4), s.fromArray(S, i * 3)));
          if (inst._COLOR_0 !== undefined) mesh.instanceColor = new THREE.InstancedBufferAttribute(accessor(inst._COLOR_0).array, 3); // (the tint from the ground)
          mesh.computeBoundingSphere();
          instances += count;
          mesh.castShadow = false;
          mesh.receiveShadow = true;
        } else {
          mesh = new THREE.Mesh(g, mat);
          mesh.castShadow = mesh.receiveShadow = true;
        }
        o.add(mesh);
      }
    if (n.extensions?.KHR_lights_punctual) lightNodes.push({ o, light: json.extensions?.KHR_lights_punctual?.lights?.[n.extensions.KHR_lights_punctual.light] });
    return o;
  });
  (json.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => objects[i].add(objects[c])));
  const scene = new THREE.Scene();
  for (const r of json.scenes[json.scene || 0].nodes) scene.add(objects[r]);

  const W = innerWidth, H = innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // the file's own sun and sky (--game-light: as Blender shows it with the .hdr as its World), or a plain outdoor light
  const gameLight = q.get('gamelight') && lightNodes.length && lightNodes[0].light;
  let sun, sunDir = new THREE.Vector3(-0.5, 0.75, 0.42).normalize();
  if (gameLight) {
    const L = lightNodes[0].light, c = L.color || [1, 1, 1];
    sun = new THREE.DirectionalLight(new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace), L.intensity ?? 1);
    scene.updateMatrixWorld(true);
    sunDir = new THREE.Vector3(0, 0, -1).applyQuaternion(lightNodes[0].o.getWorldQuaternion(new THREE.Quaternion())).negate(); // (towards the sun)
    renderer.toneMapping = THREE.NeutralToneMapping; // (as the app)
    const hdr = await fetch('/sky.hdr');
    if (hdr.ok) {
      const tex = parseHdr(await hdr.arrayBuffer());
      scene.background = tex;
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromEquirectangular(tex).texture;
      pmrem.dispose();
      console.log(`sky ${tex.image.width}x${tex.image.height} from the .hdr; sun ${L.intensity} towards ${sunDir.toArray().map((v) => v.toFixed(3)).join(' ')}`);
    } else {
      scene.background = new THREE.Color(0xa9c3dc);
      scene.add(new THREE.HemisphereLight(0xc8dcf0, 0x5a5444, 1.3));
      console.log('no .hdr beside the file: plain sky');
    }
  } else {
    const sky = new THREE.Color(0xa9c3dc);
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 400, 3000);
    scene.add(new THREE.HemisphereLight(0xc8dcf0, 0x5a5444, 1.3));
    sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  }
  scene.add(sun, sun.target);

  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const camera = new THREE.PerspectiveCamera(+q.get('fov') || 50, W / H, 0.5, 20000);
  let target;
  if (q.get('top') || !q.get('cam')) {
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const terrain = scene.getObjectByName('terrain');
    const tb = terrain ? new THREE.Box3().setFromObject(terrain) : box;
    const tc = tb.getCenter(new THREE.Vector3()), ts = tb.getSize(new THREE.Vector3());
    target = tc;
    const d = Math.max(ts.x, ts.z) / 2 / Math.tan((camera.fov * Math.PI) / 360) * 1.02;
    camera.position.set(tc.x, tb.max.y + d, tc.z + 0.001);
    camera.far = d * 4 + s.y;
    if (scene.fog) scene.fog.far = 1e7;
  } else {
    camera.position.fromArray(vec(q.get('cam')));
    target = new THREE.Vector3().fromArray(vec(q.get('target')) || [0, 0, 0]);
  }
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  // the sun (the file's, or from the upper left of the view), shadows around the target
  sun.position.copy(target).add(sunDir.clone().multiplyScalar(800));
  sun.target.position.copy(target);
  sun.castShadow = true;
  const r = Math.min(400, camera.position.distanceTo(target) * 1.2);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 2000 });
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  sun.shadow.camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  await new Promise((res) => requestAnimationFrame(res));
  renderer.render(scene, camera);
  console.log(`nodes ${json.nodes.length}, meshes ${json.meshes.length}, materials ${materials.length}, images ${bitmaps.length}, copies ${instances}, draw calls ${renderer.info.render.calls}, triangles ${renderer.info.render.triangles}`);
  window.__state = 'done';
} catch (e) {
  console.error(e.stack || e.message);
  window.__state = 'error ' + e.message;
}
