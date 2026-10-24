#pragma once
// Crossout game archives: every data\<pack>.index (magic "TGP2") describes the matching
// data\<pack>.grp (Dagor "GRP2" pack). Files are stored as a run of 128 KiB chunks, each either
// one zstd frame or raw (compressed size 0 in the chunk table). The .index also carries a checksum
// of every uncompressed file: its MD5 in index version 4 (Crossout up to 2.40), an XXH3-128 in
// version 5 (2.41, the remaster: Pack::md5Sums false). The encrypted *.pk2 packs are never opened.
//
// Everything here is read-only: pack files are opened per read with full sharing, so the
// launcher can update or replace them while the app runs.
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace xo {

struct Entry {
    std::string name;      // lowercase, '/'-separated, e.g. "models/weapons/kpvt/kpvt.mdl"
    uint64_t size = 0;     // uncompressed bytes
    uint64_t offset = 0;   // relative to the pack's data start
    uint32_t firstChunk = 0;
    uint32_t pack = 0;     // index into GameData::packs()
    uint8_t md5[16]{};     // MD5 of the file (index v4); v5 packs keep an XXH3-128 here (Pack::md5Sums)
};

struct Pack {
    std::filesystem::path grpPath;
    std::string name;          // "models_constructor_cabins_bell"
    uint32_t version = 0;      // .index format version (4 up to Crossout 2.40, 5 since 2.41)
    bool md5Sums = true;       // its entries' checksums are MD5s (v4); v5 lists XXH3-128s instead
    uint32_t chunkSize = 0;    // 131072
    uint64_t dataOffset = 0;   // where file data starts inside the .grp
    uint64_t dataSize = 0;
    uint64_t grpSize = 0;
    uint64_t grpWrite = 0;     // its last-write time when it was read (FILETIME): a changed .grp is refused
    std::vector<uint32_t> chunks; // compressed size per chunk (0 = stored raw)
    uint32_t firstEntry = 0, entryCount = 0;
};

class GameData {
  public:
    // Scans dataDir for *.index files that have a .grp beside them. Fails when none parse.
    bool open(const std::filesystem::path &dataDir, std::string *err);
    void close();
    bool isOpen() const { return !packs_.empty(); }

    const Entry *find(std::string_view name) const;
    bool read(const Entry &e, std::vector<uint8_t> &out, std::string *err) const;
    bool read(std::string_view name, std::vector<uint8_t> &out, std::string *err) const;
    // Bytes [offset, offset + size) of a file: only the chunks that hold them are read and
    // decompressed (a texture's small mips without the big ones before them).
    bool readRange(const Entry &e, uint64_t offset, uint64_t size, std::vector<uint8_t> &out, std::string *err) const;

    const std::vector<Entry> &entries() const { return entries_; }
    const std::vector<Pack> &packs() const { return packs_; }
    const std::filesystem::path &dataDir() const { return dataDir_; }
    const std::vector<std::string> &warnings() const { return warnings_; }
    // Never the same for two GameData objects in a run (caches key on it: an address can come back
    // for the next game folder or reload).
    uint64_t id() const { return id_; }

  private:
    static uint64_t newId();
    uint64_t id_ = newId();
    std::filesystem::path dataDir_;
    std::vector<Pack> packs_;
    std::vector<Entry> entries_;
    std::unordered_map<std::string, uint32_t> byName_;
    std::vector<std::string> warnings_;
};

// Parses one .index into pack (+ appends its entries). Exposed for tests.
bool parseIndex(const std::vector<uint8_t> &idx, Pack &pack, std::vector<Entry> &out, std::string *err);

// Normalises a game path: lowercase ASCII, '\' -> '/', no leading '/'.
std::string normalizeGamePath(std::string_view p);

// A path as UTF-8 (path::string() throws for characters outside the ANSI code page).
inline std::string utf8(const std::filesystem::path &p) {
    const std::u8string s = p.u8string();
    return std::string(s.begin(), s.end());
}

// MD5 of a buffer (Windows CNG). Returns false if CNG is unavailable.
bool md5Of(const uint8_t *data, size_t size, uint8_t out[16]);

} // namespace xo
