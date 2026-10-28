// 读 Crossout 的 .index / .grp 档案包（TGP2），给生成器取游戏数据用。
// 索引格式与 src/xo/Archive.cpp parseIndex() 一致：
//   v4：条目 = 大小(8) 偏移(8) 首块(4) 名偏移(8) 名长(4) MD5(16)…
//   v5（2.41 起）：条目 = 大小(8) 偏移(8) 名偏移(8) 名长(4) 首块(4) …XXH3(16) 标志(1)
// 文件数据按 chunkSize 分块存放在 .grp 里；chunk 表里 0 表示原样存放，否则是 zstd 压缩后的长度。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// 打开一个 .index，返回包里用得到的部分（条目名 → 定位信息）
export function openIndex(indexPath) {
  const buf = fs.readFileSync(indexPath);
  if (buf.length < 0x40 || buf.toString('latin1', 0, 4) !== 'TGP2') return null;
  const v5 = buf.readUInt32LE(0x04) >= 5;
  const count = buf.readUInt32LE(0x08);
  const chunkSize = buf.readUInt32LE(0x0C);
  const dataOffset = Number(buf.readBigUInt64LE(0x18));
  if (!chunkSize || chunkSize > (64 << 20) || count > 10_000_000) return null;

  let p = v5 ? 0x68 : 0x38;
  const namesSize = buf.readUInt32LE(p), namesPacked = buf.readUInt32LE(p + 4);
  p += 8;
  if (p + namesPacked > buf.length) return null;
  const names = zlib.zstdDecompressSync(buf.subarray(p, p + namesPacked));
  if (names.length !== namesSize) return null;
  p += namesPacked;

  const entPacked = buf.readUInt32LE(p);
  p += 4;
  if (p + entPacked > buf.length) return null;
  const ents = count ? zlib.zstdDecompressSync(buf.subarray(p, p + entPacked)) : Buffer.alloc(0);
  if (ents.length !== count * 64) return null;
  p += entPacked;

  const tableBytes = buf.readUInt32LE(p);
  p += 4;
  if (tableBytes % 3 || p + tableBytes > buf.length) return null;
  const chunks = new Uint32Array(tableBytes / 3);
  for (let k = 0; k < chunks.length; k++) {
    const c = p + k * 3;
    chunks[k] = buf[c] | (buf[c + 1] << 8) | (buf[c + 2] << 16);
  }

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const e = i * 64;
    const size = Number(ents.readBigUInt64LE(e));
    const offset = Number(ents.readBigUInt64LE(e + 8));
    let nameOff, nameLen, firstChunk;
    if (v5) {
      nameOff = Number(ents.readBigUInt64LE(e + 16));
      nameLen = ents.readUInt32LE(e + 24);
      firstChunk = ents.readUInt32LE(e + 28);
    } else {
      firstChunk = ents.readUInt32LE(e + 16);
      nameOff = Number(ents.readBigUInt64LE(e + 24));
      nameLen = ents.readUInt32LE(e + 32);
    }
    if (nameOff + nameLen > names.length) continue;
    const name = names.toString('utf8', nameOff, nameOff + nameLen).replace(/\\/g, '/').toLowerCase();
    entries.set(name, { size, offset, firstChunk });
  }
  return { chunkSize, dataOffset, chunks, entries };
}

// 读一个文件的内容（按 chunk 表解压）
export function readEntry(fd, pack, e) {
  if (!e || !e.size) return Buffer.alloc(0);
  if (e.size > 2 ** 31) return null; // （C++ 的 1ull << 31；JS 里 1 << 31 是负数）
  const out = Buffer.alloc(e.size);
  let pos = pack.dataOffset + e.offset;
  let done = 0, k = e.firstChunk;
  while (done < out.length) {
    const want = Math.min(pack.chunkSize, out.length - done);
    if (k >= pack.chunks.length) return null;
    const cs = pack.chunks[k++];
    if (cs === 0) {
      if (fs.readSync(fd, out, done, want, pos) !== want) return null;
      pos += want;
    } else {
      const packed = Buffer.alloc(cs);
      if (fs.readSync(fd, packed, 0, cs, pos) !== cs) return null;
      pos += cs;
      let dec;
      try { dec = zlib.zstdDecompressSync(packed); } catch { return null; }
      if (dec.length < want) return null;
      dec.copy(out, done, 0, want);
    }
    done += want;
  }
  return out;
}

// 逐包回调：cb(pack, fd, grpFileName)。读不出来的包跳过。
export function eachPack(dataDir, cb) {
  const files = fs.readdirSync(dataDir).filter((f) => f.toLowerCase().endsWith('.index')).sort();
  let packs = 0, bad = 0, entries = 0;
  for (const f of files) {
    let pack;
    try { pack = openIndex(path.join(dataDir, f)); } catch { pack = null; }
    if (!pack) { bad++; continue; }
    const grp = path.join(dataDir, f.replace(/\.index$/i, '.grp'));
    if (!fs.existsSync(grp)) { bad++; continue; }
    let fd;
    try { fd = fs.openSync(grp, 'r'); } catch { bad++; continue; }
    packs++;
    entries += pack.entries.size;
    try { cb(pack, fd, f); } finally { fs.closeSync(fd); }
  }
  return { packs, bad, entries };
}

// 游戏目录 → data 目录（settings.json 里给的可能是游戏根目录）
export function dataDirOf(gameDir) {
  return fs.existsSync(path.join(gameDir, 'data')) ? path.join(gameDir, 'data') : gameDir;
}

// Grimcold 记下的游戏目录（%LOCALAPPDATA%\Grimcold\settings.json 的 gameDir）
export function gameDirFromSettings() {
  const base = process.env.LOCALAPPDATA || process.env.HOME || process.env.USERPROFILE || '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(base, 'Grimcold', 'settings.json'), 'utf8'));
    return s.gameDir || null;
  } catch { return null; }
}
