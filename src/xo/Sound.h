#pragma once
// The game's sound effects: FMOD Studio sample banks (data\sound\*.assets.bank, each a RIFF "FEV "
// bank holding one FSB5 sample bank). Every sample of the effect banks (not the voices' vo_* or the
// music's) is listed by its name, and one comes out as an Ogg Vorbis file the view can play.
//
// FMOD stores Vorbis samples as their audio packets alone, each after a 16-bit size, without the
// three header packets: the identification header is made again from the sample's channels and rate
// and the block sizes of its setup; the setup header itself comes from a table keyed by the CRC32
// FMOD records with the sample (VorbisSetups.inc, made by tools/vorbis_setups.py). Read-only: the
// banks are opened per read with full sharing.
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace xo {

struct SoundSample {
    std::string name;        // e.g. "hmg_grain3_p"
    uint32_t bank = 0;       // index into SoundBanks::banks()
    uint32_t channels = 0;
    uint32_t rate = 0;       // Hz
    uint32_t frames = 0;     // samples per channel
    uint32_t crc = 0;        // CRC32 of its Vorbis setup header
    uint32_t loopStart = 0, loopEnd = 0; // the frames it loops over while held (FMOD's loop points; both 0: none)
    uint64_t offset = 0;     // its packets in the bank file
    uint64_t size = 0;
};

class SoundBanks {
  public:
    // Lists the samples of every effect bank in soundDir. Fails when there is none.
    bool open(const std::filesystem::path &soundDir, std::string *err);
    bool isOpen() const { return !banks_.empty(); }

    const std::vector<SoundSample> &samples() const { return samples_; }
    const std::vector<std::filesystem::path> &banks() const { return banks_; }
    const std::vector<std::string> &warnings() const { return warnings_; }
    // a sample by name (the first bank's, when two banks carry one of that name)
    const SoundSample *find(std::string_view name) const;
    // can it be played (its setup header is known)?
    static bool playable(const SoundSample &s);
    // the sample as an Ogg Vorbis file
    bool readOgg(const SoundSample &s, std::vector<uint8_t> &out, std::string *err) const;

  private:
    std::vector<std::filesystem::path> banks_;
    std::vector<SoundSample> samples_;
    std::unordered_map<std::string, uint32_t> byName_;
    std::vector<std::string> warnings_;
};

// Ogg's page checksum (CRC32, polynomial 0x04c11db7, most significant bit first). Exposed for tests.
uint32_t oggCrc(const uint8_t *p, size_t n, uint32_t crc = 0);

} // namespace xo
