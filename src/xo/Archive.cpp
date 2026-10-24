#include "xo/Archive.h"

#include "xo/Parallel.h"
#include "xo/Zstd.h"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <fstream>
#include <mutex>

namespace xo {
namespace {

uint32_t rd32(const std::vector<uint8_t> &b, size_t p) {
    uint32_t v;
    std::memcpy(&v, b.data() + p, 4);
    return v;
}
uint64_t rd64(const std::vector<uint8_t> &b, size_t p) {
    uint64_t v;
    std::memcpy(&v, b.data() + p, 8);
    return v;
}

bool readWholeFile(const std::filesystem::path &path, std::vector<uint8_t> &out, std::string *err) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        if (err)
            *err = "cannot open " + utf8(path.filename());
        return false;
    }
    LARGE_INTEGER size{};
    GetFileSizeEx(h, &size);
    out.resize(static_cast<size_t>(size.QuadPart));
    size_t done = 0;
    bool ok = true;
    while (done < out.size()) {
        DWORD got = 0;
        const DWORD want = static_cast<DWORD>(std::min<size_t>(out.size() - done, 1u << 30));
        if (!ReadFile(h, out.data() + done, want, &got, nullptr) || got == 0) {
            ok = false;
            break;
        }
        done += got;
    }
    CloseHandle(h);
    if (!ok && err)
        *err = "read failed: " + utf8(path.filename());
    return ok;
}

// Is the open .grp still the one the index was read with (the launcher may have replaced it since)?
bool sameGrp(HANDLE h, const Pack &pk) {
    BY_HANDLE_FILE_INFORMATION fi{};
    if (!GetFileInformationByHandle(h, &fi))
        return true; // (can't tell: the reads' own checks stay)
    const uint64_t size = (static_cast<uint64_t>(fi.nFileSizeHigh) << 32) | fi.nFileSizeLow;
    const uint64_t write = (static_cast<uint64_t>(fi.ftLastWriteTime.dwHighDateTime) << 32) | fi.ftLastWriteTime.dwLowDateTime;
    return size == pk.grpSize && (pk.grpWrite == 0 || write == pk.grpWrite);
}

bool readAt(HANDLE h, uint64_t pos, void *dst, size_t size) {
    auto *p = static_cast<uint8_t *>(dst);
    while (size) {
        OVERLAPPED ov{};
        ov.Offset = static_cast<DWORD>(pos);
        ov.OffsetHigh = static_cast<DWORD>(pos >> 32);
        DWORD got = 0;
        const DWORD want = static_cast<DWORD>(std::min<size_t>(size, 1u << 30));
        if (!ReadFile(h, p, want, &got, &ov) || got == 0)
            return false;
        p += got;
        pos += got;
        size -= got;
    }
    return true;
}

} // namespace

std::string normalizeGamePath(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '\\')
            c = '/';
        else if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c - 'A' + 'a');
        out += c;
    }
    size_t start = 0;
    while (start < out.size() && (out[start] == '/' || (out[start] == '.' && start + 1 < out.size() && out[start + 1] == '/')))
        start += out[start] == '/' ? 1 : 2;
    return out.substr(start);
}

bool md5Of(const uint8_t *data, size_t size, uint8_t out[16]) {
    static BCRYPT_ALG_HANDLE alg = [] {
        BCRYPT_ALG_HANDLE h = nullptr;
        if (BCryptOpenAlgorithmProvider(&h, BCRYPT_MD5_ALGORITHM, nullptr, 0) != 0)
            h = nullptr;
        return h;
    }();
    if (!alg)
        return false;
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) != 0)
        return false;
    bool ok = true;
    while (size && ok) {
        const ULONG n = static_cast<ULONG>(std::min<size_t>(size, 1u << 30));
        ok = BCryptHashData(hash, const_cast<PUCHAR>(data), n, 0) == 0;
        data += n;
        size -= n;
    }
    ok = ok && BCryptFinishHash(hash, out, 16, 0) == 0;
    BCryptDestroyHash(hash);
    return ok;
}

bool parseIndex(const std::vector<uint8_t> &idx, Pack &pack, std::vector<Entry> &out, std::string *err) {
    auto fail = [&](const std::string &m) {
        if (err)
            *err = m;
        return false;
    };
    if (idx.size() < 0x40 || std::memcmp(idx.data(), "TGP2", 4) != 0)
        return fail("not a TGP2 index");
    pack.version = rd32(idx, 0x04);
    // Version 5 (Crossout 2.41, the remaster) has 64 bytes more header at 0x28 (hashes of the pack),
    // so its names block starts 0x30 later; its entries hold the same things in another order (see
    // below) and an XXH3-128 where version 4 had an MD5.
    const bool v5 = pack.version >= 5;
    pack.md5Sums = !v5;
    if (v5 && idx.size() < 0x70)
        return fail("version 5 header truncated");
    const uint32_t count = rd32(idx, 0x08);
    pack.chunkSize = rd32(idx, 0x0C);
    pack.dataOffset = rd64(idx, 0x18);
    pack.dataSize = rd64(idx, 0x20);
    if (pack.chunkSize == 0 || pack.chunkSize > (64u << 20))
        return fail("bad chunk size");
    if (count > 10'000'000)
        return fail("bad file count");

    size_t p = v5 ? 0x68 : 0x38;
    const uint32_t namesSize = rd32(idx, p), namesPacked = rd32(idx, p + 4);
    p += 8;
    if (p + namesPacked > idx.size())
        return fail("names block truncated");
    if (namesSize > (256u << 20))
        return fail("bad names block size");
    std::vector<uint8_t> names(namesSize);
    std::string zerr;
    if (namesSize && zstdDecompress(names.data(), names.size(), idx.data() + p, namesPacked, &zerr) != namesSize)
        return fail("names block: " + zerr);
    p += namesPacked;

    if (p + 4 > idx.size())
        return fail("entry block truncated");
    const uint32_t entPacked = rd32(idx, p);
    p += 4;
    if (p + entPacked > idx.size())
        return fail("entry block truncated");
    std::vector<uint8_t> ents(static_cast<size_t>(count) * 64);
    if (count && zstdDecompress(ents.data(), ents.size(), idx.data() + p, entPacked, &zerr) != ents.size())
        return fail("entry block: " + zerr);
    p += entPacked;

    if (p + 4 > idx.size())
        return fail("chunk table truncated");
    const uint32_t tableBytes = rd32(idx, p);
    p += 4;
    if (tableBytes % 3 != 0 || p + tableBytes > idx.size())
        return fail("bad chunk table");
    pack.chunks.resize(tableBytes / 3);
    for (size_t k = 0; k < pack.chunks.size(); ++k) {
        const uint8_t *c = idx.data() + p + k * 3;
        pack.chunks[k] = c[0] | (c[1] << 8) | (c[2] << 16);
    }

    pack.firstEntry = static_cast<uint32_t>(out.size());
    pack.entryCount = count;
    out.reserve(out.size() + count);
    for (uint32_t i = 0; i < count; ++i) {
        const uint8_t *e = ents.data() + static_cast<size_t>(i) * 64;
        Entry en;
        uint64_t nameOff;
        uint32_t nameLen;
        // v4: size, offset (stored bytes before its first chunk), first chunk, name offset, name
        //     length, MD5 at 40
        // v5: size, offset, name offset, name length, first chunk, 8 bytes (?), XXH3-128 at 40
        //     (little-endian), flags (1)
        std::memcpy(&en.size, e + 0, 8);
        std::memcpy(&en.offset, e + 8, 8);
        if (v5) {
            std::memcpy(&nameOff, e + 16, 8);
            std::memcpy(&nameLen, e + 24, 4);
            std::memcpy(&en.firstChunk, e + 28, 4);
        } else {
            std::memcpy(&en.firstChunk, e + 16, 4);
            std::memcpy(&nameOff, e + 24, 8);
            std::memcpy(&nameLen, e + 32, 4);
        }
        std::memcpy(en.md5, e + 40, 16);
        if (nameOff > names.size() || nameLen > names.size() - nameOff) // no overflow on corrupt offsets
            return fail("entry name out of range");
        en.name = normalizeGamePath(std::string_view(reinterpret_cast<const char *>(names.data() + nameOff), nameLen));
        if (en.size && en.firstChunk >= pack.chunks.size())
            return fail("entry chunk out of range: " + en.name);
        out.push_back(std::move(en));
    }
    return true;
}

bool GameData::open(const std::filesystem::path &dataDir, std::string *err) {
    close();
    if (!zstdLoad(err))
        return false;
    std::error_code ec;
    std::vector<std::filesystem::path> indexes;
    for (const auto &de : std::filesystem::directory_iterator(dataDir, ec)) {
        if (de.is_regular_file(ec) && de.path().extension() == L".index")
            indexes.push_back(de.path());
    }
    if (ec) {
        if (err)
            *err = "cannot list " + utf8(dataDir);
        return false;
    }
    std::sort(indexes.begin(), indexes.end());
    dataDir_ = dataDir;
    // every index read and parsed side by side (16 at once: they are files), then taken in in order
    struct Read {
        Pack pack;
        std::vector<Entry> entries;
        std::vector<std::string> warnings;
        bool ok = false;
    };
    std::vector<Read> reads(indexes.size());
    parallelFor(indexes.size(), [&](size_t k) {
        const std::filesystem::path &ip = indexes[k];
        Read &r = reads[k];
        std::error_code fec;
        std::filesystem::path grp = ip;
        grp.replace_extension(L".grp");
        if (!std::filesystem::exists(grp, fec))
            return; // .pk2 packs (encrypted game data) are skipped on purpose
        std::vector<uint8_t> idx;
        std::string e;
        if (!readWholeFile(ip, idx, &e)) {
            r.warnings.push_back(e);
            return;
        }
        r.pack.grpPath = grp;
        r.pack.name = utf8(ip.stem());
        r.pack.grpSize = std::filesystem::file_size(grp, fec);
        if (WIN32_FILE_ATTRIBUTE_DATA fa{}; GetFileAttributesExW(grp.c_str(), GetFileExInfoStandard, &fa))
            r.pack.grpWrite = (static_cast<uint64_t>(fa.ftLastWriteTime.dwHighDateTime) << 32) | fa.ftLastWriteTime.dwLowDateTime;
        if (!parseIndex(idx, r.pack, r.entries, &e)) {
            r.entries.clear();
            r.warnings.push_back(r.pack.name + ": " + e);
            return;
        }
        if (r.pack.dataOffset + r.pack.dataSize > r.pack.grpSize)
            r.warnings.push_back(r.pack.name + ": .grp is shorter than its index says (update in progress?)");
        r.ok = true;
    }, 16);
    for (Read &r : reads) {
        for (std::string &w : r.warnings)
            warnings_.push_back(std::move(w));
        if (!r.ok)
            continue;
        const uint32_t packIndex = static_cast<uint32_t>(packs_.size());
        for (Entry &en : r.entries) {
            en.pack = packIndex;
            entries_.push_back(std::move(en));
        }
        packs_.push_back(std::move(r.pack));
    }
    if (packs_.empty()) {
        dataDir_.clear();
        if (err)
            *err = "no Crossout archives (.index + .grp) found in " + utf8(dataDir);
        return false;
    }
    byName_.reserve(entries_.size());
    size_t dupes = 0;
    for (uint32_t i = 0; i < entries_.size(); ++i)
        if (!byName_.emplace(entries_[i].name, i).second)
            ++dupes;
    if (dupes)
        warnings_.push_back(std::to_string(dupes) + " file names appear in more than one pack (first one wins)");
    return true;
}

void GameData::close() {
    packs_.clear();
    entries_.clear();
    byName_.clear();
    warnings_.clear();
    dataDir_.clear();
    id_ = newId(); // (what is opened next is other data)
}

const Entry *GameData::find(std::string_view name) const {
    auto it = byName_.find(normalizeGamePath(name));
    return it == byName_.end() ? nullptr : &entries_[it->second];
}

bool GameData::read(std::string_view name, std::vector<uint8_t> &out, std::string *err) const {
    const Entry *e = find(name);
    if (!e) {
        if (err)
            *err = "not in the game archives: " + std::string(name);
        return false;
    }
    return read(*e, out, err);
}

bool GameData::read(const Entry &e, std::vector<uint8_t> &out, std::string *err) const {
    auto fail = [&](const std::string &m) {
        if (err)
            *err = e.name + ": " + m;
        return false;
    };
    if (e.pack >= packs_.size())
        return fail("bad pack");
    const Pack &pk = packs_[e.pack];
    if (e.size > (1ull << 31))
        return fail("implausible file size");
    out.resize(static_cast<size_t>(e.size));
    if (e.size == 0)
        return true;
    HANDLE h = CreateFileW(pk.grpPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (h == INVALID_HANDLE_VALUE)
        return fail("cannot open " + utf8(pk.grpPath.filename()));
    if (!sameGrp(h, pk)) {
        CloseHandle(h);
        return fail(utf8(pk.grpPath.filename()) + " changed since it was read (the game updated?): reload the game folder (the ⟳ button)");
    }
    uint64_t pos = pk.dataOffset + e.offset;
    size_t done = 0;
    uint32_t k = e.firstChunk;
    std::vector<uint8_t> packed;
    bool ok = true;
    std::string msg;
    while (done < out.size()) {
        const size_t want = std::min<size_t>(pk.chunkSize, out.size() - done);
        if (k >= pk.chunks.size()) {
            ok = false;
            msg = "chunk table overrun";
            break;
        }
        const uint32_t cs = pk.chunks[k++];
        if (cs == 0) {
            if (!readAt(h, pos, out.data() + done, want)) {
                ok = false;
                msg = "read error (raw chunk)";
                break;
            }
            pos += want;
        } else {
            packed.resize(cs);
            if (!readAt(h, pos, packed.data(), cs)) {
                ok = false;
                msg = "read error";
                break;
            }
            pos += cs;
            std::string zerr;
            if (zstdDecompress(out.data() + done, want, packed.data(), cs, &zerr) != want) {
                ok = false;
                msg = zerr.empty() ? "chunk size mismatch" : zerr;
                break;
            }
        }
        done += want;
    }
    CloseHandle(h);
    if (!ok)
        return fail(msg + " (if the game just updated, reload the game folder)");
    return true;
}

uint64_t GameData::newId() {
    static std::atomic<uint64_t> next{1};
    return next++;
}

bool GameData::readRange(const Entry &e, uint64_t offset, uint64_t size, std::vector<uint8_t> &out, std::string *err) const {
    auto fail = [&](const std::string &m) {
        if (err)
            *err = e.name + ": " + m;
        return false;
    };
    if (e.pack >= packs_.size())
        return fail("bad pack");
    const Pack &pk = packs_[e.pack];
    if (offset > e.size || size > e.size - offset)
        return fail("range outside the file");
    if (size > (1ull << 31))
        return fail("implausible range");
    out.resize(static_cast<size_t>(size));
    if (size == 0)
        return true;
    const uint64_t cs = pk.chunkSize;
    if (cs == 0)
        return fail("bad chunk size");
    const uint64_t c0 = offset / cs, c1 = (offset + size - 1) / cs;
    // the chunks before the first one wanted are whole: skip their stored bytes
    uint64_t pos = pk.dataOffset + e.offset;
    for (uint64_t c = 0; c < c0; ++c) {
        const uint64_t k = e.firstChunk + c;
        if (k >= pk.chunks.size())
            return fail("chunk table overrun");
        pos += pk.chunks[k] ? pk.chunks[k] : cs;
    }
    HANDLE h = CreateFileW(pk.grpPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE)
        return fail("cannot open " + utf8(pk.grpPath.filename()));
    if (!sameGrp(h, pk)) {
        CloseHandle(h);
        return fail(utf8(pk.grpPath.filename()) + " changed since it was read (the game updated?): reload the game folder (the ⟳ button)");
    }
    std::vector<uint8_t> chunk(static_cast<size_t>(cs)), packed;
    bool ok = true;
    std::string msg;
    for (uint64_t c = c0; c <= c1 && ok; ++c) {
        const uint64_t k = e.firstChunk + c, start = c * cs;
        if (k >= pk.chunks.size()) {
            ok = false;
            msg = "chunk table overrun";
            break;
        }
        const size_t want = static_cast<size_t>(std::min<uint64_t>(cs, e.size - start));
        const uint32_t stored = pk.chunks[k];
        if (stored == 0) {
            ok = readAt(h, pos, chunk.data(), want);
            msg = "read error (raw chunk)";
            pos += want;
        } else {
            packed.resize(stored);
            ok = readAt(h, pos, packed.data(), stored);
            msg = "read error";
            pos += stored;
            std::string zerr;
            if (ok && zstdDecompress(chunk.data(), want, packed.data(), stored, &zerr) != want) {
                ok = false;
                msg = zerr.empty() ? "chunk size mismatch" : zerr;
            }
        }
        if (ok) {
            const uint64_t a = std::max(start, offset), b = std::min<uint64_t>(start + want, offset + size);
            std::memcpy(out.data() + (a - offset), chunk.data() + (a - start), static_cast<size_t>(b - a));
        }
    }
    CloseHandle(h);
    if (!ok)
        return fail(msg + " (if the game just updated, reload the game folder)");
    return true;
}

} // namespace xo
