#include "xo/Zstd.h"

#include <windows.h>

#include <cstdint>
#include <filesystem>
#include <iterator>
#include <mutex>
#include <vector>

namespace xo {
namespace {

using FnDecompress = size_t (*)(void *, size_t, const void *, size_t);
using FnIsError = unsigned (*)(size_t);
using FnErrorName = const char *(*)(size_t);
using FnVersion = const char *(*)();

struct Api {
    HMODULE dll = nullptr;
    FnDecompress decompress = nullptr;
    FnIsError isError = nullptr;
    FnErrorName errorName = nullptr;
    FnVersion version = nullptr;
    std::string loadError;
};

Api &api() {
    static Api a;
    return a;
}

std::filesystem::path exeDir() {
    wchar_t buf[MAX_PATH * 2];
    const DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
    return std::filesystem::path(std::wstring(buf, n)).parent_path();
}

void loadOnce() {
    Api &a = api();
    std::vector<std::filesystem::path> candidates = {exeDir() / L"libzstd.dll"};
    wchar_t pf[MAX_PATH];
    if (GetEnvironmentVariableW(L"ProgramFiles", pf, MAX_PATH))
        candidates.push_back(std::filesystem::path(pf) / L"Git" / L"mingw64" / L"bin" / L"libzstd.dll");
    for (const auto &c : candidates) {
        a.dll = LoadLibraryExW(c.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
        if (a.dll)
            break;
    }
    if (!a.dll) {
        a.loadError = "libzstd.dll not found next to the program";
        return;
    }
    a.decompress = reinterpret_cast<FnDecompress>(GetProcAddress(a.dll, "ZSTD_decompress"));
    a.isError = reinterpret_cast<FnIsError>(GetProcAddress(a.dll, "ZSTD_isError"));
    a.errorName = reinterpret_cast<FnErrorName>(GetProcAddress(a.dll, "ZSTD_getErrorName"));
    a.version = reinterpret_cast<FnVersion>(GetProcAddress(a.dll, "ZSTD_versionString"));
    if (!a.decompress || !a.isError) {
        a.loadError = "libzstd.dll is missing ZSTD_decompress";
        FreeLibrary(a.dll);
        a.dll = nullptr;
        a.decompress = nullptr;
    }
}

} // namespace

bool zstdLoad(std::string *err) {
    static std::once_flag once;
    std::call_once(once, loadOnce);
    if (!api().decompress) {
        if (err)
            *err = api().loadError;
        return false;
    }
    return true;
}

size_t zstdDecompress(void *dst, size_t dstCap, const void *src, size_t srcSize, std::string *err) {
    if (!zstdLoad(err))
        return SIZE_MAX;
    const Api &a = api();
    const size_t r = a.decompress(dst, dstCap, src, srcSize);
    if (a.isError(r)) {
        if (err)
            *err = std::string("zstd: ") + (a.errorName ? a.errorName(r) : "error");
        return SIZE_MAX;
    }
    return r;
}

std::string zstdVersion() {
    std::string ignored;
    if (!zstdLoad(&ignored) || !api().version)
        return {};
    return api().version();
}

} // namespace xo
