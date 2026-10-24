#include "xo/Image.h"

#include "xo/Archive.h"
#include "xo/Texture.h"

#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <atomic>
#include <mutex>
#include <set>

using Microsoft::WRL::ComPtr;

namespace xo {
namespace {

struct ComScope {
    HRESULT hr;
    ComScope() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~ComScope() {
        if (SUCCEEDED(hr))
            CoUninitialize();
    }
};

ComPtr<IWICImagingFactory> factory() {
    ComPtr<IWICImagingFactory> f;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f))))
        CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f));
    return f;
}

bool failWith(std::string *err, const char *what, HRESULT hr) {
    if (err) {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "%s (0x%08lX)", what, static_cast<unsigned long>(hr));
        *err = buf;
    }
    return false;
}

bool decodeFrom(IWICImagingFactory *f, IWICBitmapDecoder *dec, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h,
                std::string *err) {
    ComPtr<IWICBitmapFrameDecode> frame;
    HRESULT hr = dec->GetFrame(0, &frame);
    if (FAILED(hr))
        return failWith(err, "cannot read the image frame", hr);
    ComPtr<IWICFormatConverter> conv;
    hr = f->CreateFormatConverter(&conv);
    if (SUCCEEDED(hr))
        hr = conv->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0,
                              WICBitmapPaletteTypeCustom);
    if (FAILED(hr))
        return failWith(err, "unsupported image pixel format", hr);
    UINT iw = 0, ih = 0;
    conv->GetSize(&iw, &ih);
    if (!iw || !ih || iw > 16384 || ih > 16384)
        return failWith(err, "image size not supported", E_FAIL);
    w = iw;
    h = ih;
    rgba.resize(static_cast<size_t>(w) * h * 4);
    hr = conv->CopyPixels(nullptr, w * 4, static_cast<UINT>(rgba.size()), rgba.data());
    if (FAILED(hr))
        return failWith(err, "cannot decode the image", hr);
    return true;
}

} // namespace

bool encodePng(const uint8_t *rgba, uint32_t w, uint32_t h, std::vector<uint8_t> &out, std::string *err) {
    ComScope com;
    auto f = factory();
    if (!f)
        return failWith(err, "WIC is not available", E_FAIL);
    bool opaque = true;
    const size_t px = static_cast<size_t>(w) * h;
    for (size_t i = 0; i < px && opaque; ++i)
        opaque = rgba[i * 4 + 3] == 255;
    const uint32_t bpp = opaque ? 3 : 4;
    const uint32_t stride = (w * bpp + 3) & ~3u;
    std::vector<uint8_t> bgr(static_cast<size_t>(stride) * h);
    for (uint32_t y = 0; y < h; ++y) {
        const uint8_t *s = rgba + static_cast<size_t>(y) * w * 4;
        uint8_t *d = bgr.data() + static_cast<size_t>(y) * stride;
        for (uint32_t x = 0; x < w; ++x, s += 4, d += bpp) {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
            if (bpp == 4)
                d[3] = s[3];
        }
    }
    ComPtr<IStream> stream;
    HRESULT hr = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
    ComPtr<IWICBitmapEncoder> enc;
    if (SUCCEEDED(hr))
        hr = f->CreateEncoder(GUID_ContainerFormatPng, nullptr, &enc);
    if (SUCCEEDED(hr))
        hr = enc->Initialize(stream.Get(), WICBitmapEncoderNoCache);
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> props;
    if (SUCCEEDED(hr))
        hr = enc->CreateNewFrame(&frame, &props);
    if (SUCCEEDED(hr))
        hr = frame->Initialize(props.Get());
    if (SUCCEEDED(hr))
        hr = frame->SetSize(w, h);
    WICPixelFormatGUID pf = opaque ? GUID_WICPixelFormat24bppBGR : GUID_WICPixelFormat32bppBGRA;
    if (SUCCEEDED(hr))
        hr = frame->SetPixelFormat(&pf);
    if (SUCCEEDED(hr) && pf != (opaque ? GUID_WICPixelFormat24bppBGR : GUID_WICPixelFormat32bppBGRA))
        hr = E_FAIL;
    if (SUCCEEDED(hr))
        hr = frame->WritePixels(h, stride, static_cast<UINT>(bgr.size()), bgr.data());
    if (SUCCEEDED(hr))
        hr = frame->Commit();
    if (SUCCEEDED(hr))
        hr = enc->Commit();
    if (FAILED(hr))
        return failWith(err, "PNG encoding failed", hr);
    STATSTG st{};
    stream->Stat(&st, STATFLAG_NONAME);
    out.resize(static_cast<size_t>(st.cbSize.QuadPart));
    LARGE_INTEGER zero{};
    stream->Seek(zero, STREAM_SEEK_SET, nullptr);
    ULONG got = 0;
    stream->Read(out.data(), static_cast<ULONG>(out.size()), &got);
    out.resize(got);
    return true;
}

bool encodeJpeg(const uint8_t *rgba, uint32_t w, uint32_t h, float quality, std::vector<uint8_t> &out, std::string *err) {
    ComScope com;
    auto f = factory();
    if (!f)
        return failWith(err, "WIC is not available", E_FAIL);
    const uint32_t stride = (w * 3 + 3) & ~3u;
    std::vector<uint8_t> bgr(static_cast<size_t>(stride) * h);
    for (uint32_t y = 0; y < h; ++y) {
        const uint8_t *s = rgba + static_cast<size_t>(y) * w * 4;
        uint8_t *d = bgr.data() + static_cast<size_t>(y) * stride;
        for (uint32_t x = 0; x < w; ++x, s += 4, d += 3) {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
        }
    }
    ComPtr<IStream> stream;
    HRESULT hr = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
    ComPtr<IWICBitmapEncoder> enc;
    if (SUCCEEDED(hr))
        hr = f->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc);
    if (SUCCEEDED(hr))
        hr = enc->Initialize(stream.Get(), WICBitmapEncoderNoCache);
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> props;
    if (SUCCEEDED(hr))
        hr = enc->CreateNewFrame(&frame, &props);
    if (SUCCEEDED(hr) && props) {
        PROPBAG2 opt{};
        opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
        VARIANT v;
        VariantInit(&v);
        v.vt = VT_R4;
        v.fltVal = std::clamp(quality, 0.0f, 1.0f);
        props->Write(1, &opt, &v);
    }
    if (SUCCEEDED(hr))
        hr = frame->Initialize(props.Get());
    if (SUCCEEDED(hr))
        hr = frame->SetSize(w, h);
    WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
    if (SUCCEEDED(hr))
        hr = frame->SetPixelFormat(&pf);
    if (SUCCEEDED(hr) && pf != GUID_WICPixelFormat24bppBGR)
        hr = E_FAIL;
    if (SUCCEEDED(hr))
        hr = frame->WritePixels(h, stride, static_cast<UINT>(bgr.size()), bgr.data());
    if (SUCCEEDED(hr))
        hr = frame->Commit();
    if (SUCCEEDED(hr))
        hr = enc->Commit();
    if (FAILED(hr))
        return failWith(err, "JPEG encoding failed", hr);
    STATSTG st{};
    stream->Stat(&st, STATFLAG_NONAME);
    out.resize(static_cast<size_t>(st.cbSize.QuadPart));
    LARGE_INTEGER zero{};
    stream->Seek(zero, STREAM_SEEK_SET, nullptr);
    ULONG got = 0;
    stream->Read(out.data(), static_cast<ULONG>(out.size()), &got);
    out.resize(got);
    return true;
}

namespace {

// "cannot write x.png (the file is open in another program)"
std::string writeError(const std::filesystem::path &path, DWORD code) {
    std::string why;
    switch (code) {
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION: why = "the file is open in another program"; break;
    case ERROR_ACCESS_DENIED: why = "access denied; the file may be read-only or open in another program"; break;
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL: why = "the disk is full"; break;
    case ERROR_PATH_NOT_FOUND: why = "the folder does not exist"; break;
    case ERROR_FILENAME_EXCED_RANGE: why = "the path is too long"; break;
    case ERROR_WRITE_PROTECT: why = "the drive is write-protected"; break;
    default: {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "Windows error %lu", static_cast<unsigned long>(code));
        why = buf;
    }
    }
    return "cannot write " + utf8(path.filename()) + " (" + why + ")";
}

// The .part files being written right now, so a forced quit can remove them (removePartialFiles).
std::mutex g_partMu;
std::set<std::wstring> g_parts;
std::atomic<unsigned> g_partSerial{0}; // temp names are unique, so two writes of one file never meet

// A file another program holds open (without letting it be deleted) can't be replaced: found
// before anything is renamed, so a set of files fails whole instead of half replaced.
bool canReplace(const std::filesystem::path &p, DWORD &code) {
    HANDLE h = CreateFileW(p.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        CloseHandle(h);
        return true;
    }
    code = GetLastError();
    return code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND;
}

// Writes one .part file. It is opened with FILE_SHARE_DELETE so removePartialFiles can delete it
// even while it is being written (it then disappears when the handle closes).
bool writeTemp(const std::filesystem::path &tmp, const FileOut &f, DWORD &code) {
    {
        std::lock_guard lk(g_partMu);
        g_parts.insert(tmp.wstring());
    }
    HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, FILE_SHARE_DELETE, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        code = GetLastError();
        return false;
    }
    bool ok = true;
    auto put = [&](const void *data, size_t size) {
        const auto *p = static_cast<const uint8_t *>(data);
        while (size && ok) {
            DWORD wrote = 0;
            const DWORD n = static_cast<DWORD>(std::min<size_t>(size, 1u << 30));
            ok = WriteFile(h, p, n, &wrote, nullptr) && wrote == n;
            if (!ok)
                code = GetLastError();
            p += n;
            size -= n;
        }
    };
    put(f.data, f.size);
    for (const auto &[data, size] : f.then)
        put(data, size);
    CloseHandle(h);
    return ok;
}
void forgetTemp(const std::filesystem::path &tmp, bool remove) {
    if (remove)
        DeleteFileW(tmp.c_str());
    std::lock_guard lk(g_partMu);
    g_parts.erase(tmp.wstring());
}

} // namespace

bool writeFileBytes(const std::filesystem::path &path, const void *data, size_t size, std::string *err) {
    return writeFilesTogether({{path, data, size}}, err);
}

bool writeFilesTogether(const std::vector<FileOut> &files, std::string *err) {
    std::error_code ec;
    std::vector<std::filesystem::path> tmps;
    tmps.reserve(files.size());
    // the folders this call makes go again when it fails (a failed export left an empty _textures folder)
    std::vector<std::filesystem::path> made;
    auto unmake = [&] {
        std::error_code e2;
        for (auto it = made.rbegin(); it != made.rend(); ++it)
            std::filesystem::remove(*it, e2); // (only while empty)
    };
    for (const auto &f : files) {
        if (f.path.has_parent_path()) {
            std::vector<std::filesystem::path> missing;
            for (auto d = f.path.parent_path(); !d.empty() && !std::filesystem::exists(d, ec); d = d.parent_path()) {
                missing.push_back(d);
                if (d == d.parent_path())
                    break;
            }
            std::filesystem::create_directories(f.path.parent_path(), ec);
            made.insert(made.end(), missing.rbegin(), missing.rend());
        }
        tmps.push_back(f.path.wstring() + L"." + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(++g_partSerial) + L".part");
        DWORD code = 0;
        if (!writeTemp(tmps.back(), f, code)) {
            for (const auto &t : tmps)
                forgetTemp(t, true);
            unmake();
            if (err)
                *err = writeError(f.path, code);
            return false;
        }
    }
    for (const auto &f : files) {
        DWORD code = 0;
        if (!canReplace(f.path, code)) {
            for (const auto &t : tmps)
                forgetTemp(t, true);
            unmake();
            if (err)
                *err = writeError(f.path, code);
            return false;
        }
    }
    // Every file is complete and can go in: only now do they get their real names. A file being
    // replaced steps aside first and comes back if a later one cannot go in (another program grabbed
    // it after the check above), so a failed write still leaves the old set of files as it was.
    std::vector<std::filesystem::path> olds(files.size());
    for (size_t i = 0; i < files.size(); ++i) {
        DWORD code = 0;
        bool ok = true;
        if (GetFileAttributesW(files[i].path.c_str()) != INVALID_FILE_ATTRIBUTES) {
            olds[i] = files[i].path.wstring() + L"." + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(++g_partSerial) + L".old";
            if (!MoveFileExW(files[i].path.c_str(), olds[i].c_str(), MOVEFILE_REPLACE_EXISTING)) {
                code = GetLastError();
                olds[i].clear();
                ok = false;
            }
        }
        if (ok && !MoveFileExW(tmps[i].c_str(), files[i].path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            code = GetLastError();
            ok = false;
        }
        if (!ok) {
            for (size_t j = i; j < files.size(); ++j)
                forgetTemp(tmps[j], true);
            for (size_t j = 0; j <= i; ++j) { // the ones already in place go, the old ones come back
                if (j < i)
                    DeleteFileW(files[j].path.c_str());
                if (!olds[j].empty())
                    MoveFileExW(olds[j].c_str(), files[j].path.c_str(), MOVEFILE_REPLACE_EXISTING);
            }
            unmake();
            if (err)
                *err = writeError(files[i].path, code);
            return false;
        }
        forgetTemp(tmps[i], false);
    }
    for (const auto &o : olds)
        if (!o.empty()) {
            SetFileAttributesW(o.c_str(), FILE_ATTRIBUTE_NORMAL); // (a read-only file replaced: its old copy was left behind)
            DeleteFileW(o.c_str());
        }
    return true;
}

void removePartialFiles() {
    std::lock_guard lk(g_partMu);
    for (const auto &t : g_parts)
        DeleteFileW(t.c_str());
    g_parts.clear();
}

bool writePng(const std::filesystem::path &path, const uint8_t *rgba, uint32_t w, uint32_t h, std::string *err) {
    std::vector<uint8_t> png;
    return encodePng(rgba, w, h, png, err) && writeFileBytes(path, png.data(), png.size(), err);
}

namespace {

bool fileBytes(const std::filesystem::path &path, std::vector<uint8_t> &out, std::string *err) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        if (err)
            *err = "cannot open " + utf8(path.filename());
        return false;
    }
    LARGE_INTEGER sz{};
    GetFileSizeEx(h, &sz);
    if (sz.QuadPart > (1ll << 30)) {
        CloseHandle(h);
        if (err)
            *err = "the file is too large";
        return false;
    }
    out.resize(static_cast<size_t>(sz.QuadPart));
    DWORD got = 0;
    const bool ok = out.empty() || (ReadFile(h, out.data(), static_cast<DWORD>(out.size()), &got, nullptr) && got == out.size());
    CloseHandle(h);
    if (!ok && err)
        *err = "cannot read " + utf8(path.filename());
    return ok;
}

bool failMsg(std::string *err, const char *m) {
    if (err)
        *err = m;
    return false;
}

} // namespace

// Truevision TGA: true-colour, grey and colour-mapped, raw or RLE, any origin.
bool decodeTga(const uint8_t *d, size_t n, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err) {
    if (n < 18)
        return failMsg(err, "not a TGA file");
    const uint32_t idLen = d[0], cmapType = d[1], type = d[2];
    const uint32_t cmapFirst = d[3] | (d[4] << 8), cmapLen = d[5] | (d[6] << 8), cmapBits = d[7];
    w = d[12] | (d[13] << 8);
    h = d[14] | (d[15] << 8);
    const uint32_t bits = d[16], desc = d[17];
    const bool rle = type >= 9;
    const uint32_t base = rle ? type - 8 : type; // 1 colour-mapped, 2 true colour, 3 grey
    if (base < 1 || base > 3 || cmapType > 1 || !w || !h || w > 16384 || h > 16384)
        return failMsg(err, "unsupported TGA file");
    if ((base == 2 && bits != 15 && bits != 16 && bits != 24 && bits != 32) || (base == 3 && bits != 8 && bits != 16) ||
        (base == 1 && (bits != 8 || cmapType != 1)))
        return failMsg(err, "unsupported TGA pixel depth");
    const bool alphaBits = (desc & 15) != 0;
    size_t p = 18 + idLen;
    auto toRgba = [&](const uint8_t *s, uint32_t b, uint8_t *o) {
        if (b == 8) {
            o[0] = o[1] = o[2] = s[0];
            o[3] = 255;
        } else if (b == 15 || b == 16) {
            const uint32_t v = s[0] | (s[1] << 8);
            o[0] = static_cast<uint8_t>(((v >> 10) & 31) * 255 / 31);
            o[1] = static_cast<uint8_t>(((v >> 5) & 31) * 255 / 31);
            o[2] = static_cast<uint8_t>((v & 31) * 255 / 31);
            o[3] = b == 16 && alphaBits ? ((v & 0x8000) ? 255 : 0) : 255;
        } else {
            o[0] = s[2];
            o[1] = s[1];
            o[2] = s[0];
            o[3] = b == 32 ? s[3] : 255;
        }
    };
    std::vector<uint8_t> pal; // colour map as RGBA
    if (cmapType == 1) {
        const uint32_t eb = (cmapBits + 7) / 8;
        if (eb < 2 || eb > 4 || p + static_cast<size_t>(cmapLen) * eb > n)
            return failMsg(err, "bad TGA colour map");
        pal.resize(static_cast<size_t>(cmapLen) * 4);
        for (uint32_t i = 0; i < cmapLen; ++i)
            toRgba(d + p + static_cast<size_t>(i) * eb, cmapBits == 15 ? 15 : eb * 8, &pal[static_cast<size_t>(i) * 4]);
        p += static_cast<size_t>(cmapLen) * eb;
    }
    const uint32_t pb = (bits + 7) / 8;
    const size_t count = static_cast<size_t>(w) * h;
    std::vector<uint8_t> px(count * 4);
    auto emit = [&](const uint8_t *s, uint8_t *o) {
        if (base == 1) {
            const uint32_t idx = s[0];
            if (idx >= cmapFirst && idx - cmapFirst < cmapLen) {
                std::memcpy(o, &pal[static_cast<size_t>(idx - cmapFirst) * 4], 4);
            } else {
                o[0] = o[1] = o[2] = 0;
                o[3] = 255;
            }
        } else if (base == 3 && bits == 16) {
            o[0] = o[1] = o[2] = s[0];
            o[3] = s[1];
        } else {
            toRgba(s, bits, o);
        }
    };
    size_t i = 0;
    while (i < count) {
        if (!rle) {
            if (p + pb > n)
                return failMsg(err, "TGA data truncated");
            emit(d + p, &px[i * 4]);
            p += pb;
            ++i;
            continue;
        }
        if (p >= n)
            return failMsg(err, "TGA data truncated");
        const uint8_t head = d[p++];
        const size_t run = std::min<size_t>((head & 127) + 1, count - i);
        if (head & 128) {
            if (p + pb > n)
                return failMsg(err, "TGA data truncated");
            uint8_t one[4];
            emit(d + p, one);
            p += pb;
            for (size_t k = 0; k < run; ++k)
                std::memcpy(&px[(i + k) * 4], one, 4);
        } else {
            if (p + run * pb > n)
                return failMsg(err, "TGA data truncated");
            for (size_t k = 0; k < run; ++k, p += pb)
                emit(d + p, &px[(i + k) * 4]);
        }
        i += run;
    }
    if (bits == 32) { // many tools write 32-bit TGAs with an unused, all-zero alpha channel
        bool anyAlpha = false;
        for (size_t k = 0; k < count && !anyAlpha; ++k)
            anyAlpha = px[k * 4 + 3] != 0;
        if (!anyAlpha)
            for (size_t k = 0; k < count; ++k)
                px[k * 4 + 3] = 255;
    }
    // rows run bottom-up unless bit 5 is set; bit 4 mirrors horizontally
    const bool topDown = (desc & 0x20) != 0, rightToLeft = (desc & 0x10) != 0;
    rgba.resize(count * 4);
    for (uint32_t y = 0; y < h; ++y) {
        const uint32_t sy = topDown ? y : h - 1 - y;
        for (uint32_t x = 0; x < w; ++x) {
            const uint32_t sx = rightToLeft ? w - 1 - x : x;
            std::memcpy(&rgba[(static_cast<size_t>(y) * w + x) * 4], &px[(static_cast<size_t>(sy) * w + sx) * 4], 4);
        }
    }
    return true;
}

// DDS: BC1-BC5 and BC7 (legacy FourCC or DX10 header) and 8-bit RGB(A)/luminance; the top mip.
bool decodeDds(const uint8_t *d, size_t n, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err) {
    auto u32 = [&](size_t o) {
        uint32_t v;
        std::memcpy(&v, d + o, 4);
        return v;
    };
    if (n < 128 || std::memcmp(d, "DDS ", 4) != 0 || u32(4) != 124)
        return failMsg(err, "not a DDS file");
    h = u32(12);
    w = u32(16);
    if (!w || !h || w > 16384 || h > 16384)
        return failMsg(err, "DDS size not supported");
    const uint32_t pfFlags = u32(80), fourcc = u32(84), bitCount = u32(88);
    const uint32_t masks[4] = {u32(92), u32(96), u32(100), u32(104)};
    auto cc = [](const char *s) { return static_cast<uint32_t>(s[0]) | (s[1] << 8) | (s[2] << 16) | (static_cast<uint32_t>(s[3]) << 24); };
    const char *unsupported = "this DDS format is not supported (use BC1-BC5, BC7 or 8-bit RGBA)";
    size_t off = 128;
    PixelFormat fmt = PixelFormat::Unknown;
    bool bgra = false, bgrx = false;
    if (pfFlags & 0x4) { // FourCC
        if (fourcc == cc("DXT1"))
            fmt = PixelFormat::BC1;
        else if (fourcc == cc("DXT2") || fourcc == cc("DXT3"))
            fmt = PixelFormat::BC2;
        else if (fourcc == cc("DXT4") || fourcc == cc("DXT5"))
            fmt = PixelFormat::BC3;
        else if (fourcc == cc("ATI1") || fourcc == cc("BC4U"))
            fmt = PixelFormat::BC4;
        else if (fourcc == cc("ATI2") || fourcc == cc("BC5U"))
            fmt = PixelFormat::BC5;
        else if (fourcc == cc("DX10")) {
            if (n < 148)
                return failMsg(err, "DDS header truncated");
            off = 148;
            switch (u32(128)) {
            case 71: case 72: fmt = PixelFormat::BC1; break;
            case 74: case 75: fmt = PixelFormat::BC2; break;
            case 77: case 78: fmt = PixelFormat::BC3; break;
            case 80: fmt = PixelFormat::BC4; break;
            case 83: fmt = PixelFormat::BC5; break;
            case 98: case 99: fmt = PixelFormat::BC7; break;
            case 28: case 29: fmt = PixelFormat::RGBA8; break;
            case 87: case 91: fmt = PixelFormat::RGBA8; bgra = true; break;
            case 88: case 93: fmt = PixelFormat::RGBA8; bgra = bgrx = true; break;
            default: return failMsg(err, unsupported);
            }
        } else {
            return failMsg(err, unsupported);
        }
    } else if ((pfFlags & 0x40) && (bitCount == 32 || bitCount == 24)) { // uncompressed RGB(A) with bit masks
        const uint32_t bpp = bitCount / 8;
        const size_t count = static_cast<size_t>(w) * h;
        if (off + count * bpp > n)
            return failMsg(err, "DDS data truncated");
        auto chan = [](uint32_t v, uint32_t m) -> uint8_t {
            if (!m)
                return 0;
            unsigned long shift = 0;
            _BitScanForward(&shift, m);
            const uint32_t x = (v & m) >> shift, top = m >> shift;
            return static_cast<uint8_t>(top == 255 ? x : static_cast<uint64_t>(x) * 255 / top);
        };
        const bool hasAlpha = (pfFlags & 0x1) && masks[3];
        rgba.resize(count * 4);
        for (size_t i = 0; i < count; ++i) {
            uint32_t v = 0;
            std::memcpy(&v, d + off + i * bpp, bpp);
            rgba[i * 4] = chan(v, masks[0]);
            rgba[i * 4 + 1] = chan(v, masks[1]);
            rgba[i * 4 + 2] = chan(v, masks[2]);
            rgba[i * 4 + 3] = hasAlpha ? chan(v, masks[3]) : 255;
        }
        return true;
    } else if ((pfFlags & 0x20000) && bitCount == 8) { // luminance
        const size_t count = static_cast<size_t>(w) * h;
        if (off + count > n)
            return failMsg(err, "DDS data truncated");
        rgba.resize(count * 4);
        for (size_t i = 0; i < count; ++i) {
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = d[off + i];
            rgba[i * 4 + 3] = 255;
        }
        return true;
    } else {
        return failMsg(err, unsupported);
    }
    const size_t top = fmt == PixelFormat::RGBA8 ? static_cast<size_t>(w) * h * 4
                                                 : static_cast<size_t>((w + 3) / 4) * ((h + 3) / 4) * blockBytes(fmt);
    if (off + top > n)
        return failMsg(err, "DDS data truncated");
    if (!decodePixels(fmt, d + off, top, w, h, rgba, err))
        return false;
    if (bgra)
        for (size_t i = 0; i < static_cast<size_t>(w) * h; ++i) {
            std::swap(rgba[i * 4], rgba[i * 4 + 2]);
            if (bgrx)
                rgba[i * 4 + 3] = 255;
        }
    return true;
}

bool readImageFile(const std::filesystem::path &path, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err) {
    // WIC has no TGA codec and its DDS codec only knows BC1-BC3, so those two are read here.
    std::wstring ext = path.extension().wstring();
    for (auto &c : ext)
        c = static_cast<wchar_t>(towlower(c));
    if (ext == L".tga" || ext == L".dds") {
        std::vector<uint8_t> bytes;
        if (!fileBytes(path, bytes, err))
            return false;
        if (bytes.size() >= 4 && std::memcmp(bytes.data(), "DDS ", 4) == 0)
            return decodeDds(bytes.data(), bytes.size(), rgba, w, h, err);
        if (ext == L".tga")
            return decodeTga(bytes.data(), bytes.size(), rgba, w, h, err);
    }
    ComScope com;
    auto f = factory();
    if (!f)
        return failWith(err, "WIC is not available", E_FAIL);
    ComPtr<IWICBitmapDecoder> dec;
    const HRESULT hr = f->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &dec);
    if (FAILED(hr))
        return failWith(err, "not an image Windows can read", hr);
    return decodeFrom(f.Get(), dec.Get(), rgba, w, h, err);
}

void resizeRgba(const std::vector<uint8_t> &src, uint32_t sw, uint32_t sh, std::vector<uint8_t> &dst, uint32_t dw, uint32_t dh) {
    dst.resize(static_cast<size_t>(dw) * dh * 4);
    for (uint32_t y = 0; y < dh; ++y) {
        const float fy = std::clamp((y + 0.5f) * sh / dh - 0.5f, 0.0f, static_cast<float>(sh - 1));
        const uint32_t y0 = static_cast<uint32_t>(fy), y1 = std::min(sh - 1, y0 + 1);
        const float ty = fy - y0;
        for (uint32_t x = 0; x < dw; ++x) {
            const float fx = std::clamp((x + 0.5f) * sw / dw - 0.5f, 0.0f, static_cast<float>(sw - 1));
            const uint32_t x0 = static_cast<uint32_t>(fx), x1 = std::min(sw - 1, x0 + 1);
            const float tx = fx - x0;
            for (int c = 0; c < 4; ++c) {
                auto at = [&](uint32_t xx, uint32_t yy) { return static_cast<float>(src[(static_cast<size_t>(yy) * sw + xx) * 4 + c]); };
                const float v = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
                dst[(static_cast<size_t>(y) * dw + x) * 4 + c] = static_cast<uint8_t>(std::clamp(std::lround(v), 0L, 255L));
            }
        }
    }
}

bool ColorAdjust::isIdentity() const {
    return hue == 0 && saturation == 1 && brightness == 0 && contrast == 1 && tintAmount == 0 && paintAmount == 0;
}

namespace {
void rgb2hsv(const float c[3], float o[3]) {
    const float mx = std::max({c[0], c[1], c[2]}), mn = std::min({c[0], c[1], c[2]}), d = mx - mn;
    float h = 0;
    if (d > 1e-6f) {
        if (mx == c[0])
            h = (c[1] - c[2]) / d + (c[1] < c[2] ? 6.0f : 0.0f);
        else if (mx == c[1])
            h = (c[2] - c[0]) / d + 2;
        else
            h = (c[0] - c[1]) / d + 4;
        h /= 6;
    }
    o[0] = h;
    o[1] = mx > 1e-6f ? d / mx : 0;
    o[2] = mx;
}
void hsv2rgb(const float c[3], float o[3]) {
    for (int i = 0; i < 3; ++i) {
        const float k = std::fmod(static_cast<float>(i == 0 ? 5 : i == 1 ? 3 : 1) + c[0] * 6, 6.0f);
        o[i] = c[2] - c[2] * c[1] * std::max(0.0f, std::min({k, 4 - k, 1.0f}));
    }
}
} // namespace

void applyColorAdjust(std::vector<uint8_t> &rgba, uint32_t w, uint32_t h, const ColorAdjust &a,
                      const std::vector<uint8_t> *mask, uint32_t mw, uint32_t mh) {
    if (a.isIdentity())
        return;
    std::vector<uint8_t> m;
    if (a.paintAmount > 0 && mask && mw && mh) {
        if (mw == w && mh == h)
            m = *mask;
        else
            resizeRgba(*mask, mw, mh, m, w, h);
    }
    const size_t n = static_cast<size_t>(w) * h;
    for (size_t i = 0; i < n; ++i) {
        uint8_t *p = &rgba[i * 4];
        float c[3] = {p[0] / 255.0f, p[1] / 255.0f, p[2] / 255.0f};
        if (a.hue != 0 || a.saturation != 1) {
            float hsv[3];
            rgb2hsv(c, hsv);
            hsv[0] = hsv[0] + a.hue / 360.0f;
            hsv[0] -= std::floor(hsv[0]);
            hsv[1] = std::clamp(hsv[1] * a.saturation, 0.0f, 1.0f);
            hsv2rgb(hsv, c);
        }
        for (int k = 0; k < 3; ++k) {
            c[k] = (c[k] - 0.5f) * a.contrast + 0.5f + a.brightness;
            c[k] = c[k] + (c[k] * a.tint[k] - c[k]) * a.tintAmount;
        }
        if (!m.empty()) {
            const float mk = m[i * 4] / 255.0f * a.paintAmount;
            const float lum = std::clamp(0.299f * c[0] + 0.587f * c[1] + 0.114f * c[2], 0.0f, 1.0f);
            for (int k = 0; k < 3; ++k) {
                const float o = lum < 0.5f ? 2 * lum * a.paint[k] : 1 - 2 * (1 - lum) * (1 - a.paint[k]);
                c[k] = c[k] + (o - c[k]) * mk;
            }
        }
        for (int k = 0; k < 3; ++k)
            p[k] = static_cast<uint8_t>(std::clamp(std::lround(c[k] * 255.0f), 0L, 255L));
    }
}

} // namespace xo
