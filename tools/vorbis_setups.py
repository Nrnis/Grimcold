# Writes src/xo/VorbisSetups.inc: the Vorbis setup headers the game's sound banks need.
#
# FMOD keeps Vorbis samples without their three header packets and records the CRC32 of the setup
# header it encoded with (FSB5 sample chunk 11). The setup header is what libvorbis's encoder writes
# for the sample's channels, rate and quality: FMOD's quality q (1..100) is libvorbis's q / 100. This
# reads every *.assets.bank in the game's data\sound (read only), collects the CRC32s by channels and
# rate, and finds each one by encoding nothing at every quality with libvorbis (loaded from a local
# install: an app that ships ogg.dll, vorbis.dll and vorbisenc.dll). The game today uses three:
# mono and stereo at 48 kHz q 0.7, stereo at 48 kHz q 0.3.
#
#   python tools\vorbis_setups.py [game folder] [folder with ogg.dll, vorbis.dll, vorbisenc.dll]
import ctypes, os, struct, sys, zlib

GAME = sys.argv[1] if len(sys.argv) > 1 else os.path.expandvars(r'%LOCALAPPDATA%\Crossout Launcher')
LIBS = sys.argv[2] if len(sys.argv) > 2 else r'C:\Program Files\Maxon Autograph 2026\bin'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'xo', 'VorbisSetups.inc')
FREQ = {1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000, 10: 96000}


def bank_setups(path):
    """(channels, rate, crc) of the bank's Vorbis samples"""
    with open(path, 'rb') as f:
        d = f.read(1 << 18)
        i = d.find(b'FSB5')
        if i < 0: return set()
        ver, n, shdr, names, data, mode = struct.unpack_from('<IIIIII', d, i + 4)
        if mode != 15: return set()
        hdr = 0x3c if ver == 1 else 0x40
        f.seek(i + hdr)
        h = f.read(shdr)
    out, o = set(), 0
    for _ in range(n):
        v = struct.unpack_from('<Q', h, o)[0]
        o += 8
        nxt, rate, ch, crc = v & 1, FREQ.get((v >> 1) & 15, 0), 1 << ((v >> 5) & 1), None
        while nxt:
            c = struct.unpack_from('<I', h, o)[0]
            o += 4
            nxt, size, typ = c & 1, (c >> 1) & 0xffffff, (c >> 25) & 0x7f
            if typ == 1: ch = h[o]
            elif typ == 2: rate = struct.unpack_from('<I', h, o)[0]
            elif typ == 11: crc = struct.unpack_from('<I', h, o)[0]
            o += size
        if crc is not None: out.add((ch, rate, crc))
    return out


class OggPacket(ctypes.Structure):
    _fields_ = [('packet', ctypes.POINTER(ctypes.c_ubyte)), ('bytes', ctypes.c_long), ('b_o_s', ctypes.c_long),
                ('e_o_s', ctypes.c_long), ('granulepos', ctypes.c_int64), ('packetno', ctypes.c_int64)]


def main():
    want = set()
    snd = os.path.join(GAME, 'data', 'sound')
    for fn in sorted(os.listdir(snd)):
        if fn.endswith('.assets.bank'):
            want |= bank_setups(os.path.join(snd, fn))
    print('setups in the banks:', ', '.join('%dch %d Hz %08x' % w for w in sorted(want)))

    os.add_dll_directory(LIBS)
    ctypes.CDLL(os.path.join(LIBS, 'ogg.dll'))
    vorbis = ctypes.CDLL(os.path.join(LIBS, 'vorbis.dll'))
    venc = ctypes.CDLL(os.path.join(LIBS, 'vorbisenc.dll'))
    venc.vorbis_encode_init_vbr.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_long, ctypes.c_float]

    def headers(ch, rate, q):
        vi, vc = ctypes.create_string_buffer(256), ctypes.create_string_buffer(256)
        vd, vb = ctypes.create_string_buffer(1 << 14), ctypes.create_string_buffer(1 << 14)
        vorbis.vorbis_info_init(vi)
        if venc.vorbis_encode_init_vbr(vi, ch, rate, ctypes.c_float(q)) != 0:
            vorbis.vorbis_info_clear(vi)
            return None
        vorbis.vorbis_comment_init(vc)
        vorbis.vorbis_analysis_init(vd, vi)
        vorbis.vorbis_block_init(vd, vb)
        p = [OggPacket(), OggPacket(), OggPacket()]
        vorbis.vorbis_analysis_headerout(vd, vc, *[ctypes.byref(x) for x in p])
        out = [bytes(ctypes.string_at(x.packet, x.bytes)) for x in p]
        vorbis.vorbis_block_clear(vb)
        vorbis.vorbis_dsp_clear(vd)
        vorbis.vorbis_comment_clear(vc)
        vorbis.vorbis_info_clear(vi)
        return out

    def modes(idh, setup):
        """the setup's mode blockflags, as libvorbis reads them back"""
        vi, vc = ctypes.create_string_buffer(256), ctypes.create_string_buffer(256)
        vorbis.vorbis_info_init(vi)
        vorbis.vorbis_comment_init(vc)
        for k, pk in enumerate((idh, b'\x03vorbis' + struct.pack('<I', 0) + struct.pack('<I', 0) + b'\x01', setup)):
            buf = ctypes.create_string_buffer(pk, len(pk))
            op = OggPacket(ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)), len(pk), int(k == 0), 0, 0, k)
            if vorbis.vorbis_synthesis_headerin(vi, vc, ctypes.byref(op)) != 0:
                raise RuntimeError('libvorbis refused header %d' % k)
        cs = ctypes.cast(vi, ctypes.POINTER(ctypes.c_void_p))[4]  # vorbis_info.codec_setup (after 7 x 4-byte fields + pad)
        n = ctypes.cast(cs + 8, ctypes.POINTER(ctypes.c_int))[0]  # codec_setup_info.modes (after blocksizes[2])
        params = ctypes.cast(cs + 32, ctypes.POINTER(ctypes.c_void_p))  # mode_param[64]
        flags = [ctypes.cast(params[k], ctypes.POINTER(ctypes.c_int))[0] for k in range(n)]
        vorbis.vorbis_comment_clear(vc)
        vorbis.vorbis_info_clear(vi)
        return flags

    found = {}
    for ch, rate, crc in sorted(want):
        for i in range(-10, 101):
            h = headers(ch, rate, i / 100)
            if h and (zlib.crc32(h[2]) & 0xffffffff) == crc:
                found[crc] = (ch, rate, i / 100, h)
                break
        print('  %dch %d Hz %08x:' % (ch, rate, crc), 'q %.2f' % found[crc][2] if crc in found else 'NOT FOUND')

    lines = ['// Generated by tools/vorbis_setups.py: the Vorbis setup headers of the game\'s sound banks (libvorbis',
             '// encoder output for the channels, rate and quality FMOD encoded with), by the CRC32 FMOD records.',
             '// blocksizes: the identification header\'s byte (log2 of the short and long block); modes: each',
             '// mode\'s blockflag.', '']
    for crc, (ch, rate, q, h) in sorted(found.items()):
        lines.append('const uint8_t kSetup%08x[] = {' % crc)
        b = h[2]
        for k in range(0, len(b), 24):
            lines.append('    ' + ', '.join('0x%02x' % x for x in b[k:k + 24]) + ',')
        lines.append('};')
    lines.append('')
    lines.append('const VorbisSetup kVorbisSetups[] = {')
    for crc, (ch, rate, q, h) in sorted(found.items()):
        fl = modes(h[0], h[2])
        assert len(fl) <= 8
        lines.append('    {0x%08x, %d, %d, 0x%02x, %d, 0x%02x, kSetup%08x, sizeof(kSetup%08x)}, // q %.2f' % (
            crc, ch, rate, h[0][28], len(fl), sum(f << k for k, f in enumerate(fl)), crc, crc, q))
    lines.append('};')
    with open(OUT, 'w', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print('wrote', os.path.normpath(OUT), len(found), 'setups')


if __name__ == '__main__':
    main()
