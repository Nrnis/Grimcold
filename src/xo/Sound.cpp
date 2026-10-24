#include "xo/Sound.h"

#include "xo/Archive.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <cstring>

namespace xo {
namespace {

struct VorbisSetup {
    uint32_t crc;
    uint8_t channels;
    uint32_t rate;
    uint8_t blocksizes; // the identification header's byte: log2 short block | log2 long block << 4
    uint8_t modes;      // how many modes the setup has
    uint8_t blockflags; // bit k: mode k uses the long block
    const uint8_t *data;
    size_t size;
};
#include "xo/VorbisSetups.inc"

const VorbisSetup *setupFor(uint32_t crc) {
    for (const auto &s : kVorbisSetups)
        if (s.crc == crc)
            return &s;
    return nullptr;
}

constexpr uint32_t kFreq[] = {0, 8000, 11000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 96000};

uint32_t rd32(const uint8_t *p) {
    uint32_t v;
    std::memcpy(&v, p, 4);
    return v;
}

// Bytes [offset, offset + size) of a file (fewer at its end). Read-only, sharing everything.
bool readAt(const std::filesystem::path &path, uint64_t offset, size_t size, std::vector<uint8_t> &out, std::string *err) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        if (err)
            *err = "cannot open " + utf8(path.filename());
        return false;
    }
    LARGE_INTEGER at{}, len{};
    GetFileSizeEx(h, &len);
    const uint64_t end = std::min<uint64_t>(static_cast<uint64_t>(len.QuadPart), offset + size);
    out.assign(end > offset ? static_cast<size_t>(end - offset) : 0, 0);
    at.QuadPart = static_cast<LONGLONG>(offset);
    bool ok = SetFilePointerEx(h, at, nullptr, FILE_BEGIN) != 0;
    size_t done = 0;
    while (ok && done < out.size()) {
        DWORD got = 0;
        if (!ReadFile(h, out.data() + done, static_cast<DWORD>(std::min<size_t>(out.size() - done, 1u << 30)), &got, nullptr) || got == 0)
            ok = false;
        done += got;
    }
    CloseHandle(h);
    if (!ok && err)
        *err = "read failed: " + utf8(path.filename());
    return ok;
}

// Writes packets as Ogg pages (each page at most 255 lacing values; a packet that does not fit goes
// on in the next page, flagged as continued). granules[i]: the granule position once packet i ends
// (a page carries the last one ending on it, -1 when none does). flags: 2 on the first page, 4 on the
// last.
struct OggWriter {
    std::vector<uint8_t> &out;
    uint32_t serial = 0x584f4e44; // "XOND"
    uint32_t seq = 0;

    void page(const std::vector<std::pair<const uint8_t *, size_t>> &packets, const std::vector<int64_t> &granules, bool first, bool last) {
        size_t k = 0, off = 0; // packet, bytes of it already written
        bool cont = false;
        while (k < packets.size()) {
            std::vector<uint8_t> lacing;
            std::vector<std::pair<const uint8_t *, size_t>> body;
            int64_t granule = -1;
            const bool wasCont = cont;
            while (k < packets.size() && lacing.size() < 255) {
                const size_t left = packets[k].second - off;
                const size_t room = (255 - lacing.size()) * 255;
                if (left < room) { // the packet ends on this page (its last lacing value under 255)
                    for (size_t n = left; n >= 255; n -= 255)
                        lacing.push_back(255);
                    lacing.push_back(static_cast<uint8_t>(left % 255));
                    body.emplace_back(packets[k].first + off, left);
                    granule = granules[k];
                    ++k;
                    off = 0;
                    cont = false;
                } else { // it goes on in the next page
                    lacing.insert(lacing.end(), room / 255, 255);
                    body.emplace_back(packets[k].first + off, room);
                    off += room;
                    cont = true;
                    break;
                }
            }
            const bool lastPage = last && k == packets.size();
            const size_t at = out.size();
            const uint8_t flags = static_cast<uint8_t>((wasCont ? 1 : 0) | (first && seq == 0 ? 2 : 0) | (lastPage ? 4 : 0));
            const uint8_t head[] = {'O', 'g', 'g', 'S', 0, flags};
            out.insert(out.end(), head, head + 6);
            for (int b = 0; b < 8; ++b)
                out.push_back(static_cast<uint8_t>(static_cast<uint64_t>(granule) >> (8 * b)));
            for (uint32_t v : {serial, seq++, 0u})
                for (int b = 0; b < 4; ++b)
                    out.push_back(static_cast<uint8_t>(v >> (8 * b)));
            out.push_back(static_cast<uint8_t>(lacing.size()));
            out.insert(out.end(), lacing.begin(), lacing.end());
            for (const auto &[p, n] : body)
                out.insert(out.end(), p, p + n);
            const uint32_t crc = oggCrc(out.data() + at, out.size() - at);
            std::memcpy(out.data() + at + 22, &crc, 4);
        }
    }
};

} // namespace

uint32_t oggCrc(const uint8_t *p, size_t n, uint32_t crc) {
    static const auto table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t r = i << 24;
            for (int k = 0; k < 8; ++k)
                r = (r & 0x80000000u) ? (r << 1) ^ 0x04c11db7u : r << 1;
            t[i] = r;
        }
        return t;
    }();
    for (size_t i = 0; i < n; ++i)
        crc = (crc << 8) ^ table[((crc >> 24) ^ p[i]) & 0xff];
    return crc;
}

bool SoundBanks::open(const std::filesystem::path &soundDir, std::string *err) {
    banks_.clear();
    samples_.clear();
    byName_.clear();
    warnings_.clear();
    std::error_code ec;
    std::vector<std::filesystem::path> files;
    for (const auto &e : std::filesystem::directory_iterator(soundDir, ec)) {
        const std::string name = utf8(e.path().filename());
        if (name.size() > 12 && name.compare(name.size() - 12, 12, ".assets.bank") == 0 && name.rfind("vo_", 0) != 0 &&
            name.find("music") == std::string::npos)
            files.push_back(e.path());
    }
    std::sort(files.begin(), files.end());
    for (const auto &path : files) {
        std::vector<uint8_t> head;
        std::string e;
        if (!readAt(path, 0, 1u << 18, head, &e)) {
            warnings_.push_back(e);
            continue;
        }
        // the FSB5 sample bank sits after the bank's small RIFF header chunks
        size_t at = std::string::npos;
        for (size_t i = 0; i + 64 <= head.size(); ++i)
            if (std::memcmp(head.data() + i, "FSB5", 4) == 0) {
                at = i;
                break;
            }
        const std::string bankName = utf8(path.filename());
        if (at == std::string::npos) {
            warnings_.push_back(bankName + ": no FSB5 sample bank");
            continue;
        }
        const uint8_t *h = head.data() + at;
        const uint32_t version = rd32(h + 4), count = rd32(h + 8), shdr = rd32(h + 12), names = rd32(h + 16), dataSize = rd32(h + 20),
                       mode = rd32(h + 24);
        if (mode != 15) { // (Vorbis: every effect bank of the game today)
            warnings_.push_back(bankName + ": codec " + std::to_string(mode) + " is not Vorbis");
            continue;
        }
        const size_t hdr = version == 1 ? 0x3c : 0x40;
        std::vector<uint8_t> meta;
        if (!readAt(path, at + hdr, static_cast<size_t>(shdr) + names, meta, &e) || meta.size() < static_cast<size_t>(shdr) + names) {
            warnings_.push_back(bankName + ": cut short");
            continue;
        }
        const uint32_t bank = static_cast<uint32_t>(banks_.size());
        banks_.push_back(path);
        const size_t first = samples_.size();
        size_t o = 0;
        std::vector<uint64_t> offs;
        for (uint32_t k = 0; k < count && o + 8 <= shdr; ++k) {
            uint64_t v;
            std::memcpy(&v, meta.data() + o, 8);
            o += 8;
            SoundSample s;
            s.bank = bank;
            bool next = v & 1;
            const uint32_t fi = static_cast<uint32_t>((v >> 1) & 0xf);
            s.rate = fi < std::size(kFreq) ? kFreq[fi] : 0;
            s.channels = ((v >> 5) & 1) ? 2 : 1;
            offs.push_back(((v >> 7) & 0x7ffffff) * 32);
            s.frames = static_cast<uint32_t>((v >> 34) & 0x3fffffff);
            while (next && o + 4 <= shdr) {
                const uint32_t c = rd32(meta.data() + o);
                o += 4;
                next = c & 1;
                const uint32_t size = (c >> 1) & 0xffffff, type = (c >> 25) & 0x7f;
                if (o + size > shdr)
                    break;
                if (type == 1 && size >= 1)
                    s.channels = meta[o];
                else if (type == 2 && size >= 4)
                    s.rate = rd32(meta.data() + o);
                else if (type == 3 && size >= 8) {
                    s.loopStart = rd32(meta.data() + o);
                    s.loopEnd = rd32(meta.data() + o + 4);
                } else if (type == 11 && size >= 4)
                    s.crc = rd32(meta.data() + o);
                o += size;
            }
            if (names) {
                const uint32_t no = k * 4 + 4 <= names ? rd32(meta.data() + shdr + k * 4) : names;
                for (size_t i = shdr + no; i < meta.size() && meta[i]; ++i)
                    s.name += static_cast<char>(meta[i]);
            }
            if (s.name.empty())
                s.name = bankName + "#" + std::to_string(k);
            samples_.push_back(std::move(s));
        }
        const uint64_t base = at + hdr + shdr + names;
        for (size_t k = 0; k < offs.size(); ++k) {
            SoundSample &s = samples_[first + k];
            const uint64_t end = k + 1 < offs.size() ? offs[k + 1] : dataSize;
            s.offset = base + offs[k];
            s.size = end > offs[k] ? end - offs[k] : 0;
            byName_.emplace(s.name, static_cast<uint32_t>(first + k));
        }
    }
    if (banks_.empty()) {
        if (err)
            *err = "no sound banks in " + utf8(soundDir);
        return false;
    }
    return true;
}

const SoundSample *SoundBanks::find(std::string_view name) const {
    auto it = byName_.find(std::string(name));
    return it == byName_.end() ? nullptr : &samples_[it->second];
}

bool SoundBanks::playable(const SoundSample &s) {
    const VorbisSetup *v = setupFor(s.crc);
    return v && v->channels == s.channels && s.size > 0;
}

bool SoundBanks::readOgg(const SoundSample &s, std::vector<uint8_t> &out, std::string *err) const {
    const VorbisSetup *v = setupFor(s.crc);
    if (!v) {
        if (err) {
            char b[96];
            snprintf(b, sizeof b, "%s: no Vorbis setup header for CRC %08x", s.name.c_str(), s.crc);
            *err = b;
        }
        return false;
    }
    if (s.bank >= banks_.size()) {
        if (err)
            *err = "no such bank";
        return false;
    }
    std::vector<uint8_t> data;
    if (!readAt(banks_[s.bank], s.offset, static_cast<size_t>(s.size), data, err))
        return false;
    // the three headers
    std::vector<uint8_t> id = {1, 'v', 'o', 'r', 'b', 'i', 's', 0, 0, 0, 0, static_cast<uint8_t>(s.channels)};
    for (int b = 0; b < 4; ++b)
        id.push_back(static_cast<uint8_t>(s.rate >> (8 * b)));
    id.insert(id.end(), 12, 0); // (no bitrates)
    id.push_back(v->blocksizes);
    id.push_back(1);
    static const char vendor[] = "Grimcold";
    std::vector<uint8_t> comment = {3, 'v', 'o', 'r', 'b', 'i', 's', static_cast<uint8_t>(sizeof vendor - 1), 0, 0, 0};
    comment.insert(comment.end(), vendor, vendor + sizeof vendor - 1);
    comment.insert(comment.end(), {0, 0, 0, 0, 1});
    out.clear();
    out.reserve(data.size() + data.size() / 8 + 8192);
    OggWriter w{out};
    w.page({{id.data(), id.size()}}, {0}, true, false);
    w.page({{comment.data(), comment.size()}, {v->data, v->size}}, {0, 0}, false, false); // (the audio starts on a page of its own)
    // the audio packets, each after its 16-bit size (0, or the end of the sample's bytes, ends them);
    // a packet's mode (the bits after its type bit) says which block it is, and the samples it adds
    // come from it and the one before
    std::vector<std::pair<const uint8_t *, size_t>> packets;
    std::vector<int64_t> granules;
    int bits = 0; // (the mode number's width: ilog(modes - 1))
    for (uint32_t m = v->modes - 1; m; m >>= 1)
        ++bits;
    const int64_t shortBlock = int64_t(1) << (v->blocksizes & 15), longBlock = int64_t(1) << (v->blocksizes >> 4);
    int64_t prev = 0, granule = 0;
    for (size_t o = 0; o + 2 <= data.size();) {
        const size_t n = static_cast<size_t>(data[o]) | static_cast<size_t>(data[o + 1]) << 8;
        if (n == 0 || o + 2 + n > data.size())
            break;
        const uint8_t *p = data.data() + o + 2;
        o += 2 + n;
        if (p[0] & 1)
            continue; // (not an audio packet)
        const uint32_t mode = bits ? (static_cast<uint32_t>(p[0]) >> 1) & ((1u << bits) - 1) : 0;
        const int64_t block = (v->blockflags >> mode) & 1 ? longBlock : shortBlock;
        if (prev)
            granule += (prev + block) / 4;
        prev = block;
        packets.emplace_back(p, n);
        granules.push_back(granule);
    }
    if (packets.empty()) {
        if (err)
            *err = s.name + ": no audio packets";
        return false;
    }
    granules.back() = std::min<int64_t>(granules.back(), s.frames); // (the last page trims the end)
    // a page or so per packet: each audio page ends with a packet, so its granule is known
    for (size_t k = 0; k < packets.size(); ++k)
        w.page({packets[k]}, {granules[k]}, false, k + 1 == packets.size());
    return true;
}

} // namespace xo
