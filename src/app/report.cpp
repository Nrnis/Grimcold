// Bug reports: the log, crashes kept for the next start, the machine's details, sending a report to
// Sentry. See report.h.
#include "report.h"

#include "buildinfo.h" // (build.cmd writes it: XO_SENTRY_DSN from %SENTRY_DSN%, empty for a build without one)

#include <dbghelp.h>
#include <share.h>
#include <dxgi.h>
#include <winhttp.h>
#include <wrl.h>

#include "WebView2.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <exception>
#include <mutex>
#include <random>
#include <thread>
#include <vector>

extern "C" __declspec(noreturn) void __stdcall _CxxThrowException(void *pExceptionObject, _ThrowInfo *pThrowInfo) noexcept(false);
#ifndef _DEBUG
extern "C" void __cdecl _invalid_parameter(wchar_t const *, wchar_t const *, wchar_t const *, unsigned int, uintptr_t);
#endif

namespace fs = std::filesystem;
using Microsoft::WRL::ComPtr;

namespace rep {
namespace {

std::string utf8(std::wstring_view w) {
    if (w.empty())
        return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::wstring wide(std::string_view s) {
    if (s.empty())
        return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string envUtf8(const wchar_t *name) {
    wchar_t buf[512];
    const DWORD n = GetEnvironmentVariableW(name, buf, static_cast<DWORD>(std::size(buf)));
    return n && n < std::size(buf) ? utf8(std::wstring_view(buf, n)) : std::string();
}

fs::path g_dataDir, g_logDir, g_crashDir;
std::string g_version = "0";
std::string g_profile, g_user, g_pc; // what redact() takes out

std::mutex g_logMu;
FILE *g_log = nullptr;
long long g_logSize = 0;
constexpr long long kLogMax = 1 << 20; // a log file's size before the next one starts
constexpr int kLogFiles = 5;           // grimcold.log and .1 ... .4

std::mutex g_sendMu;
std::mutex g_stateMu; // (sending.json: loaded, checked and saved under it, reports side by side included)
std::string g_dsn = XO_SENTRY_DSN;
constexpr int kSendsPerDay = 20;

// ---- redact -----------------------------------------------------------------------------------

char lower(char c) { return static_cast<unsigned char>(c) < 128 ? static_cast<char>(std::tolower(static_cast<unsigned char>(c))) : c; }

size_t ifind(const std::string &s, std::string_view n, size_t from) {
    if (n.empty() || s.size() < n.size())
        return std::string::npos;
    for (size_t i = from; i + n.size() <= s.size(); ++i) {
        size_t k = 0;
        while (k < n.size() && lower(s[i + k]) == lower(n[k]))
            ++k;
        if (k == n.size())
            return i;
    }
    return std::string::npos;
}

bool word(char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_'; }

// Every what in s (ignoring case) as with; whole: only where it stands as a word of its own.
void replaceAll(std::string &s, std::string_view what, std::string_view with, bool whole) {
    if (what.empty())
        return;
    size_t i = 0;
    while ((i = ifind(s, what, i)) != std::string::npos) {
        const size_t e = i + what.size();
        // (whole words only; and never inside a placeholder already put in, <user> or <pc>: an account
        // named "user"; any other name in brackets goes)
        const auto is = [&](std::string_view p) { return what.size() == p.size() && std::equal(what.begin(), what.end(), p.begin(), [](char a, char b) { return std::tolower(static_cast<unsigned char>(a)) == b; }); };
        const bool own = is("user") || is("pc");
        if (whole && ((i > 0 && word(s[i - 1])) || (e < s.size() && word(s[e])) || (own && i > 0 && s[i - 1] == '<' && e < s.size() && s[e] == '>'))) {
            ++i;
            continue;
        }
        s.replace(i, what.size(), with);
        i += with.size();
    }
}

// X:\Users\<anyone>\ in every spelling: as is, with forward slashes, escaped in JSON.
void redactUsersFolders(std::string &s) {
    for (std::string_view sep : {std::string_view("\\\\"), std::string_view("\\"), std::string_view("/")}) {
        const std::string key = std::string(sep) + "Users" + std::string(sep);
        size_t i = 0;
        while ((i = ifind(s, key, i)) != std::string::npos) {
            const size_t a = i + key.size();
            size_t b = a;
            while (b < s.size() && !std::strchr("\\/\"'<>|:*?\r\n\t", s[b]))
                ++b;
            const std::string name = s.substr(a, b - a);
            if (!name.empty() && name != "<user>" && ifind(name, "public", 0) != 0 && ifind(name, "default", 0) != 0)
                s.replace(a, b - a, "<user>");
            i = a;
        }
    }
}

// ---- the log ----------------------------------------------------------------------------------

fs::path logFile(int k) { return g_logDir / (k ? L"grimcold." + std::to_wstring(k) + L".log" : std::wstring(L"grimcold.log")); }

void openLog() { // (g_logMu held)
    g_log = _wfsopen(logFile(0).c_str(), L"ab", _SH_DENYNO);
    g_logSize = 0;
    if (g_log && _fseeki64(g_log, 0, SEEK_END) == 0)
        g_logSize = _ftelli64(g_log);
}

void rotateLog() { // (g_logMu held)
    if (g_log)
        std::fclose(g_log);
    g_log = nullptr;
    std::error_code ec;
    fs::remove(logFile(kLogFiles - 1), ec);
    for (int k = kLogFiles - 2; k >= 0; --k)
        fs::rename(logFile(k), logFile(k + 1), ec);
    openLog();
}

std::string stamp(bool fileName = false) {
    SYSTEMTIME t;
    GetLocalTime(&t);
    char b[64];
    if (fileName)
        std::snprintf(b, sizeof b, "%04u%02u%02u-%02u%02u%02u", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    else
        std::snprintf(b, sizeof b, "%04u-%02u-%02u %02u:%02u:%02u.%03u", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    return b;
}

// The last bytes of a file (at most max).
std::string tailOf(const fs::path &p, long long max) {
    FILE *f = _wfsopen(p.c_str(), L"rb", _SH_DENYNO);
    if (!f)
        return {};
    std::string s;
    if (_fseeki64(f, 0, SEEK_END) == 0) {
        const long long size = _ftelli64(f), from = std::max(0LL, size - max);
        _fseeki64(f, from, SEEK_SET);
        s.resize(static_cast<size_t>(size - from));
        s.resize(std::fread(s.data(), 1, s.size(), f));
        if (from > 0) { // (from the first whole line)
            const size_t nl = s.find('\n');
            s.erase(0, nl == std::string::npos ? s.size() : nl + 1);
        }
    }
    std::fclose(f);
    return s;
}

// ---- crashes ----------------------------------------------------------------------------------

constexpr DWORD kTerminate = 0xE0000001, kInvalidParameter = 0xE0000002, kPurecall = 0xE0000003, kAbort = 0xE0000004;

const char *exceptionName(DWORD code) {
    switch (code) {
    case EXCEPTION_ACCESS_VIOLATION: return "EXCEPTION_ACCESS_VIOLATION";
    case EXCEPTION_STACK_OVERFLOW: return "EXCEPTION_STACK_OVERFLOW";
    case EXCEPTION_INT_DIVIDE_BY_ZERO: return "EXCEPTION_INT_DIVIDE_BY_ZERO";
    case EXCEPTION_ILLEGAL_INSTRUCTION: return "EXCEPTION_ILLEGAL_INSTRUCTION";
    case EXCEPTION_PRIV_INSTRUCTION: return "EXCEPTION_PRIV_INSTRUCTION";
    case EXCEPTION_IN_PAGE_ERROR: return "EXCEPTION_IN_PAGE_ERROR";
    case EXCEPTION_ARRAY_BOUNDS_EXCEEDED: return "EXCEPTION_ARRAY_BOUNDS_EXCEEDED";
    case EXCEPTION_DATATYPE_MISALIGNMENT: return "EXCEPTION_DATATYPE_MISALIGNMENT";
    case 0xC0000374: return "STATUS_HEAP_CORRUPTION";
    case 0xE06D7363: return "a C++ exception";
    case kTerminate: return "std::terminate (a C++ exception nobody caught, or one through a noexcept function)";
    case kInvalidParameter: return "an invalid parameter to a C runtime function";
    case kPurecall: return "a pure virtual function call";
    case kAbort: return "abort()";
    default: return "an unhandled exception";
    }
}

wchar_t g_crashDirW[MAX_PATH * 2]; // (ready before anything can crash: the handler allocates nothing it can avoid)
wchar_t g_runningW[MAX_PATH * 2 + 32]; // (crashes\running.json: watchExit)
char g_versionA[32] = "0";
std::atomic<DWORD> g_crashThread{0}; // (the thread writing a crash's record: one at a time)
std::atomic<bool> g_testFaultInCrash{false}; // (tests: the crash catcher itself faults)
HMODULE g_system[3] = {}; // (ntdll, KERNELBASE, kernel32: where RaiseException is, never a crash's cause)
constexpr int kMaxFrames = 32;

// Milliseconds since 1970: records sort on it (several can fall in one second).
unsigned long long epochMs() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    const unsigned long long t = (static_cast<unsigned long long>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
    return (t - 116444736000000000ULL) / 10000;
}

// The module a code address is in (its file name only) and the offset into it.
void whereIs(const void *addr, char *module, size_t moduleSize, unsigned long long &offset) {
    strcpy_s(module, moduleSize, "?");
    offset = reinterpret_cast<unsigned long long>(addr);
    HMODULE m = nullptr;
    if (addr && GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, static_cast<LPCSTR>(addr), &m) && m) {
        char full[MAX_PATH];
        if (GetModuleFileNameA(m, full, MAX_PATH)) {
            const char *base = std::strrchr(full, '\\');
            strcpy_s(module, moduleSize, base ? base + 1 : full);
        }
        offset -= reinterpret_cast<unsigned long long>(m);
    }
}

// The code addresses up a crashed thread's stack, from the exception's context, by the x64 unwind
// data (a stack too broken to follow ends the list where it breaks).
int walkStack(const CONTEXT *from, void **out, int max) {
    int n = 0;
#if defined(_M_X64)
    __try {
        CONTEXT c = *from;
        while (n < max && c.Rip) {
            PVOID image = nullptr;
            if (n > 0 && !RtlPcToFileHeader(reinterpret_cast<PVOID>(c.Rip), &image)) // (a return address in no module: not code, the walk has lost its way)
                break;
            out[n++] = reinterpret_cast<void *>(c.Rip);
            const DWORD64 sp = c.Rsp;
            DWORD64 base = 0;
            if (const PRUNTIME_FUNCTION f = RtlLookupFunctionEntry(c.Rip, &base, nullptr)) {
                PVOID data = nullptr;
                DWORD64 frame = 0;
                RtlVirtualUnwind(UNW_FLAG_NHANDLER, base, c.Rip, f, &c, &data, &frame, nullptr);
            } else if (n == 1) { // (the faulting function a leaf: its return address is on top of the stack)
                c.Rip = *reinterpret_cast<const DWORD64 *>(c.Rsp);
                c.Rsp += 8;
            } else { // (code without unwind data further up: stack memory would be taken for frames)
                break;
            }
            if (c.Rsp <= sp) // (no way up: the walk would go round)
                break;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
#else
    (void)from;
    (void)out;
    (void)max;
#endif
    return n;
}

// A frame's address as code to look up: a return address points past its call, maybe into the next
// function (frame 0 is the faulting instruction itself).
const void *callSite(void *const *frames, int k) { return static_cast<const char *>(frames[k]) - (k ? 1 : 0); }

// The start of the function code is in, from the x64 unwind data (0: none).
unsigned long long functionStart(const void *pc) {
#if defined(_M_X64)
    DWORD64 base = 0;
    if (const PRUNTIME_FUNCTION f = RtlLookupFunctionEntry(reinterpret_cast<DWORD64>(pc), &base, nullptr))
        return base + f->BeginAddress;
#else
    (void)pc;
#endif
    return 0;
}

template <typename F> unsigned long long addressOf(F *f) { return reinterpret_cast<unsigned long long>(reinterpret_cast<const void *>(f)); }

bool inSystem(const void *pc) {
    PVOID base = nullptr;
    RtlPcToFileHeader(const_cast<PVOID>(pc), &base);
    return base && std::find(std::begin(g_system), std::end(g_system), static_cast<HMODULE>(base)) != std::end(g_system);
}

bool onFatalPath(const void *pc); // (raiseFatal, the handlers and the CRT's way to them: below)

struct DumpJob {
    EXCEPTION_POINTERS *ep;
    DWORD thread;
    const wchar_t *path;
    BOOL ok;
};

// The minidump, written from a thread of its own (the crashed one may have no stack left).
DWORD WINAPI dumpThread(void *p) {
    auto *j = static_cast<DumpJob *>(p);
    const HANDLE f = CreateFileW(j->path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE)
        return 1;
    MINIDUMP_EXCEPTION_INFORMATION mei{j->thread, j->ep, FALSE};
    // (module paths cut to their names, stack memory down to what a stack trace needs: the user's
    // folder is in both)
    j->ok = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), f,
                              static_cast<MINIDUMP_TYPE>(MiniDumpNormal | MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules |
                                                         MiniDumpFilterModulePaths | MiniDumpFilterMemory),
                              j->ep ? &mei : nullptr, nullptr, nullptr);
    CloseHandle(f);
    return 0;
}

void writeFileA(const wchar_t *path, const char *text, size_t n) {
    const HANDLE f = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE)
        return;
    DWORD w = 0;
    WriteFile(f, text, static_cast<DWORD>(n), &w, nullptr);
    CloseHandle(f);
}

// A crash's summary and minidump (crashes\crash-<time>-<pid>.json / .dmp). The summary goes first
// (dumped false), so a crash that ends the process while the dump is being written is still offered,
// and again once the dump is done. A second thread crashing meanwhile waits: the first finishes and
// ends the process (returning would end it at once, the dump half written, no summary), and should it
// not within 90 s (stuck behind a lock the second holds), the second ends it. A fault inside this
// catcher itself ends the process at once, with the record as far as it got.
void writeCrash(EXCEPTION_POINTERS *ep) {
    if (!g_crashDirW[0])
        return;
    const DWORD me = GetCurrentThreadId();
    DWORD owner = 0;
    if (!g_crashThread.compare_exchange_strong(owner, me)) {
        if (owner != me)
            Sleep(90000);
        TerminateProcess(GetCurrentProcess(), ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionCode : 3);
        return;
    }
    if (g_testFaultInCrash) {
        volatile int *nowhere = nullptr;
        *nowhere = 1;
    }
    SYSTEMTIME t;
    GetLocalTime(&t);
    const unsigned long long ms = epochMs();
    wchar_t id[80], dmp[MAX_PATH * 2 + 96], js[MAX_PATH * 2 + 96];
    swprintf_s(id, L"crash-%04u%02u%02u-%02u%02u%02u-%lu", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, GetCurrentProcessId());
    swprintf_s(dmp, L"%s\\%s.dmp", g_crashDirW, id);
    swprintf_s(js, L"%s\\%s.json", g_crashDirW, id);
    const EXCEPTION_RECORD *er = ep ? ep->ExceptionRecord : nullptr;
    DWORD code = er ? er->ExceptionCode : 0;
    // The crash's own stack, from its context. where: the exception's address; for abort, terminate, an
    // invalid parameter or a pure call (raised by raiseFatal: RaiseException's address, the same for
    // all) the first frame past the way to the handler, for a C++ exception the first past the throw:
    // the code that called them. The stack kept starts at where.
    void *frames[kMaxFrames];
    const int n = ep && ep->ContextRecord ? walkStack(ep->ContextRecord, frames, kMaxFrames) : 0;
    const bool raised = (code & 0xFFFFFFF0u) == 0xE0000000u, thrown = code == 0xE06D7363u;
    const void *at = er ? er->ExceptionAddress : nullptr;
    int first = 0;
    if (raised) {
        int last = -1;
        for (int k = 0; k < n && k < 16; ++k)
            if (onFatalPath(callSite(frames, k))) {
                last = k;
                if (functionStart(callSite(frames, k)) == addressOf(&std::terminate))
                    code = kTerminate; // (abort by way of std::terminate, on any thread)
            }
        if (last >= 0 && last + 1 < n)
            first = last + 1;
    }
    if (code == kTerminate || thrown) {
        // the exception itself: past its throw (terminate meets one still being dispatched when it hits
        // a noexcept function or a destructor: Windows' dispatch, RaiseException, _CxxThrowException)
        for (int k = first; k < n && k < first + 20; ++k)
            if (functionStart(callSite(frames, k)) == addressOf(&_CxxThrowException)) {
                if (k + 1 < n)
                    first = k + 1;
                break;
            }
    }
    if (first > 0)
        at = frames[first];
    char module[MAX_PATH];
    unsigned long long offset = 0;
    whereIs(at, module, sizeof module, offset);
    char stack[2048] = "";
    size_t used = 0;
    for (int k = first; k < n; ++k) {
        char m2[MAX_PATH];
        unsigned long long o2 = 0;
        whereIs(frames[k], m2, sizeof m2, o2);
        const int w = std::snprintf(stack + used, sizeof stack - used, "%s\"%s+0x%llX\"", used ? "," : "", m2, o2);
        if (w < 0 || static_cast<size_t>(w) >= sizeof stack - used)
            break;
        used += static_cast<size_t>(w);
    }
    char idA[80];
    std::snprintf(idA, sizeof idA, "%ls", id);
    const auto summary = [&](bool dumped) {
        char text[3072];
        const int len = std::snprintf(text, sizeof text,
                                    "{\"id\":\"%s\",\"kind\":\"crash\",\"time\":\"%04u-%02u-%02u %02u:%02u:%02u\",\"ms\":%llu,\"code\":\"0x%08lX\",\"what\":\"%s\","
                                    "\"module\":\"%s\",\"offset\":\"0x%llX\",\"stack\":[%s],\"version\":\"%s\",\"dumped\":%s}",
                                    idA, t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, ms, code, exceptionName(code), module, offset, stack,
                                    g_versionA, dumped ? "true" : "false");
        if (len > 0)
            writeFileA(js, text, static_cast<size_t>(std::min(len, static_cast<int>(sizeof text) - 1)));
    };
    summary(false);
    if (g_runningW[0])
        DeleteFileW(g_runningW); // (this run's end is on record: not "ended unexpectedly" too)
    DumpJob job{ep, GetCurrentThreadId(), dmp, FALSE};
    if (const HANDLE th = CreateThread(nullptr, 0, dumpThread, &job, 0, nullptr)) {
        WaitForSingleObject(th, 60000);
        CloseHandle(th);
    }
    summary(job.ok != FALSE);
}

LONG WINAPI onUnhandled(EXCEPTION_POINTERS *ep) {
    writeCrash(ep);
    return EXCEPTION_EXECUTE_HANDLER; // (the process ends here, quietly: the next start offers the report)
}

// abort, std::terminate, an invalid parameter, a pure call: raised as an exception of the app's own so
// the crash catcher records it (never inlined: its frame on the stack is where the way to it starts).
[[noreturn]] __declspec(noinline) void raiseFatal(DWORD code) {
    RaiseException(code, EXCEPTION_NONCONTINUABLE, 0, nullptr);
    std::_Exit(3);
}

void onInvalidParameter(const wchar_t *, const wchar_t *, const wchar_t *, unsigned, uintptr_t) { raiseFatal(kInvalidParameter); }
void onPurecall() { raiseFatal(kPurecall); }
// (UCRT's raise resets SIGABRT to SIG_DFL before calling this: re-armed, a second abort elsewhere meanwhile
// still comes here instead of ending the process in the middle of the first one's record)
void onAbortSignal(int) {
    std::signal(SIGABRT, onAbortSignal);
    raiseFatal(kAbort);
}

// Whether code is on the way from a fatal call to the crash catcher: raiseFatal, the handlers, the
// CRT functions between (abort -> raise; terminate -> abort; _invalid_parameter_noinfo; _purecall).
// By the function it is in, from the x64 unwind data.
bool onFatalPath(const void *pc) {
    const unsigned long long start = functionStart(pc);
    if (!start)
        return false;
    const unsigned long long path[] = {addressOf(&raiseFatal), addressOf(&onInvalidParameter), addressOf(&onPurecall), addressOf(&onAbortSignal),
                                       addressOf(&std::abort), addressOf(&std::raise), addressOf(&std::terminate), addressOf(&_invalid_parameter),
                                       addressOf(&_invalid_parameter_noinfo), addressOf(&_invalid_parameter_noinfo_noreturn), addressOf(&_purecall)};
    return std::find(std::begin(path), std::end(path), start) != std::end(path);
}

// A crash record that is no crash of the app: its page's process, or a test.
void writeRecord(const ujson::Value &rec) {
    std::error_code ec;
    fs::create_directories(g_crashDir, ec);
    const std::string text = rec.dump();
    FILE *f = _wfsopen((g_crashDir / (wide(rec["id"].str()) + L".json")).c_str(), L"wb", _SH_DENYNO);
    if (f) {
        std::fwrite(text.data(), 1, text.size(), f);
        std::fclose(f);
    }
}

bool validId(const std::string &id) {
    return !id.empty() && id.size() < 80 && std::all_of(id.begin(), id.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-'; });
}

// ---- the machine ------------------------------------------------------------------------------

std::wstring regString(HKEY root, const wchar_t *key, const wchar_t *name) {
    wchar_t buf[512];
    DWORD size = sizeof buf;
    if (RegGetValueW(root, key, name, RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS)
        return {};
    std::wstring s(buf);
    while (!s.empty() && s.back() == L' ')
        s.pop_back();
    while (!s.empty() && s.front() == L' ')
        s.erase(0, 1);
    return s;
}

DWORD regDword(HKEY root, const wchar_t *key, const wchar_t *name) {
    DWORD v = 0, size = sizeof v;
    return RegGetValueW(root, key, name, RRF_RT_REG_DWORD, nullptr, &v, &size) == ERROR_SUCCESS ? v : 0;
}

double gb(unsigned long long bytes) { return std::round(static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0) * 10) / 10; }

ujson::Value osInfo() {
    using RtlGetVersionFn = LONG(WINAPI *)(OSVERSIONINFOEXW *);
    OSVERSIONINFOEXW v{sizeof v};
    if (const HMODULE nt = GetModuleHandleW(L"ntdll.dll"))
        if (const auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void *>(GetProcAddress(nt, "RtlGetVersion"))))
            fn(&v);
    const wchar_t *key = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    const std::wstring display = regString(HKEY_LOCAL_MACHINE, key, L"DisplayVersion"), edition = regString(HKEY_LOCAL_MACHINE, key, L"EditionID");
    const DWORD ubr = regDword(HKEY_LOCAL_MACHINE, key, L"UBR");
    std::string name = v.dwMajorVersion == 10 ? (v.dwBuildNumber >= 22000 ? "Windows 11" : "Windows 10") : "Windows " + std::to_string(v.dwMajorVersion) + "." + std::to_string(v.dwMinorVersion);
    if (edition == L"Core" || edition == L"CoreSingleLanguage")
        name += " Home";
    else if (edition == L"Professional")
        name += " Pro";
    else if (!edition.empty())
        name += " " + utf8(edition);
    ujson::Value o = ujson::Value::object();
    o.set("name", name);
    o.set("version", utf8(display));
    o.set("build", std::to_string(v.dwBuildNumber) + (ubr ? "." + std::to_string(ubr) : std::string()));
    SYSTEM_INFO si;
    GetNativeSystemInfo(&si);
    o.set("arch", si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x64" : si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_ARM64 ? "arm64" : "x86");
    return o;
}

ujson::Value gpus() {
    ujson::Value list = ujson::Value::array();
    ComPtr<IDXGIFactory1> f;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(f.GetAddressOf()))))
        return list;
    ComPtr<IDXGIAdapter1> a;
    for (UINT i = 0; f->EnumAdapters1(i, a.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 d{};
        if (FAILED(a->GetDesc1(&d)) || (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE))
            continue;
        ujson::Value g = ujson::Value::object();
        g.set("name", utf8(d.Description));
        g.set("vendor", d.VendorId == 0x10DE ? "NVIDIA" : d.VendorId == 0x1002 ? "AMD" : d.VendorId == 0x8086 ? "Intel" : d.VendorId == 0x1414 ? "Microsoft" : "other");
        g.set("vram", gb(d.DedicatedVideoMemory));
        LARGE_INTEGER umd{};
        if (SUCCEEDED(a->CheckInterfaceSupport(__uuidof(IDXGIDevice), &umd))) { // (the user-mode driver's version)
            char ver[64];
            std::snprintf(ver, sizeof ver, "%u.%u.%u.%u", HIWORD(umd.HighPart), LOWORD(umd.HighPart), HIWORD(umd.LowPart), LOWORD(umd.LowPart));
            g.set("driver", ver);
        }
        list.push(std::move(g));
    }
    return list;
}

// ---- sending ----------------------------------------------------------------------------------

struct Dsn {
    bool https = true;
    std::wstring host;
    INTERNET_PORT port = 443;
    std::string key, path; // path: /<prefix>api/<project>/envelope/
};

bool parseDsn(const std::string &d, Dsn &o) {
    const size_t p = d.find("://");
    if (p == std::string::npos)
        return false;
    const std::string scheme = d.substr(0, p), rest = d.substr(p + 3);
    if (scheme != "https" && scheme != "http")
        return false;
    o.https = scheme == "https";
    const size_t at = rest.find('@'), slash = rest.find('/', at == std::string::npos ? 0 : at);
    if (at == std::string::npos || slash == std::string::npos)
        return false;
    o.key = rest.substr(0, at);
    if (const size_t colon = o.key.find(':'); colon != std::string::npos)
        o.key.resize(colon); // (an old DSN's secret: not needed)
    std::string hostport = rest.substr(at + 1, slash - at - 1), path = rest.substr(slash + 1);
    while (!path.empty() && path.back() == '/')
        path.pop_back();
    const size_t last = path.rfind('/');
    const std::string project = last == std::string::npos ? path : path.substr(last + 1), prefix = last == std::string::npos ? "" : path.substr(0, last + 1);
    if (o.key.empty() || project.empty() || hostport.empty())
        return false;
    o.port = o.https ? 443 : 80;
    if (const size_t colon = hostport.find(':'); colon != std::string::npos) {
        o.port = static_cast<INTERNET_PORT>(std::atoi(hostport.c_str() + colon + 1));
        hostport.resize(colon);
    }
    o.host = wide(hostport);
    o.path = "/" + prefix + "api/" + project + "/envelope/";
    return true;
}

std::string randomHex(int n) {
    static std::mutex mu;
    static std::mt19937_64 rng{std::random_device{}() ^ (static_cast<unsigned long long>(GetTickCount64()) << 20)};
    std::lock_guard lk(mu);
    std::string s;
    while (static_cast<int>(s.size()) < n) {
        char b[17];
        std::snprintf(b, sizeof b, "%016llx", static_cast<unsigned long long>(rng()));
        s += b;
    }
    s.resize(static_cast<size_t>(n));
    return s;
}

std::string isoUtcNow() {
    SYSTEMTIME t;
    GetSystemTime(&t);
    char b[40];
    std::snprintf(b, sizeof b, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    return b;
}

double unixNow() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    const unsigned long long t = (static_cast<unsigned long long>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
    return static_cast<double>(t - 116444736000000000ULL) / 1e7;
}

struct Http {
    int status = 0;
    std::string body, error;
    double retryAfter = 0; // seconds Sentry asked to wait (429)
};

Http post(const Dsn &d, const std::string &body, const std::wstring &headers) {
    Http r;
    const HINTERNET s = WinHttpOpen(L"Grimcold", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) {
        r.error = "no internet session (" + std::to_string(GetLastError()) + ")";
        return r;
    }
    WinHttpSetTimeouts(s, 10000, 10000, 30000, 30000);
    const HINTERNET c = WinHttpConnect(s, d.host.c_str(), d.port, 0);
    const std::wstring path = wide(d.path);
    const HINTERNET q = c ? WinHttpOpenRequest(c, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, d.https ? WINHTTP_FLAG_SECURE : 0) : nullptr;
    if (q && WinHttpSendRequest(q, headers.c_str(), static_cast<DWORD>(-1L), const_cast<char *>(body.data()), static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0) &&
        WinHttpReceiveResponse(q, nullptr)) {
        DWORD code = 0, size = sizeof code;
        WinHttpQueryHeaders(q, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &code, &size, WINHTTP_NO_HEADER_INDEX);
        r.status = static_cast<int>(code);
        wchar_t ra[64];
        DWORD raSize = sizeof ra;
        if (WinHttpQueryHeaders(q, WINHTTP_QUERY_RETRY_AFTER, WINHTTP_HEADER_NAME_BY_INDEX, ra, &raSize, WINHTTP_NO_HEADER_INDEX))
            r.retryAfter = _wtof(ra);
        DWORD avail = 0;
        while (WinHttpQueryDataAvailable(q, &avail) && avail && r.body.size() < 65536) {
            std::string chunk(avail, '\0');
            DWORD got = 0;
            if (!WinHttpReadData(q, chunk.data(), avail, &got) || !got)
                break;
            r.body.append(chunk.data(), got);
        }
    } else {
        r.error = "could not reach the report server (Windows error " + std::to_string(GetLastError()) + ")";
    }
    if (q)
        WinHttpCloseHandle(q);
    if (c)
        WinHttpCloseHandle(c);
    WinHttpCloseHandle(s);
    return r;
}

// How many reports went out today, and until when Sentry asked to wait (crashes\sending.json).
struct SendState {
    std::string day;
    int count = 0;
    double waitUntil = 0;
};

SendState loadState() {
    SendState st;
    FILE *f = _wfsopen((g_crashDir / L"sending.json").c_str(), L"rb", _SH_DENYNO);
    if (!f)
        return st;
    std::string s(4096, '\0');
    s.resize(std::fread(s.data(), 1, s.size(), f));
    std::fclose(f);
    try {
        const ujson::Value v = ujson::Value::parse(s);
        st.day = v["day"].str();
        st.count = static_cast<int>(v["count"].num(0));
        st.waitUntil = v["waitUntil"].num(0);
    } catch (...) {
    }
    return st;
}

void saveState(const SendState &st) {
    ujson::Value v = ujson::Value::object();
    v.set("day", st.day);
    v.set("count", st.count);
    v.set("waitUntil", st.waitUntil);
    const std::string s = v.dump();
    std::error_code ec;
    fs::create_directories(g_crashDir, ec);
    const fs::path tmp = g_crashDir / L"sending.json.part"; // (written whole, then put in place: never read half written)
    if (FILE *f = _wfsopen(tmp.c_str(), L"wb", _SH_DENYNO)) {
        std::fwrite(s.data(), 1, s.size(), f);
        std::fclose(f);
        MoveFileExW(tmp.c_str(), (g_crashDir / L"sending.json").c_str(), MOVEFILE_REPLACE_EXISTING);
    }
}

std::string today() { return stamp(true).substr(0, 8); }

std::string readBytes(const fs::path &p, size_t max) {
    FILE *f = _wfsopen(p.c_str(), L"rb", _SH_DENYNO);
    if (!f)
        return {};
    std::string s;
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0 && s.size() < max)
        s.append(buf, n);
    std::fclose(f);
    return s;
}

// The parts of a report the page does not give: the machine as contexts, and Sentry's own fields.
void fillEvent(ujson::Value &ev, const std::string &eventId) {
    ev.set("event_id", eventId);
    ev.set("timestamp", unixNow());
    ev.set("release", "grimcold@" + g_version);
    if (!ev.has("environment"))
        ev.set("environment", "production");
    if (!ev.has("platform"))
        ev.set("platform", "native");
    ujson::Value sdk = ujson::Value::object();
    sdk.set("name", "grimcold.report");
    sdk.set("version", g_version);
    ev.set("sdk", std::move(sdk));
    ev.erase("server_name"); // (never the computer's name)
    ujson::Value ctx = ev["contexts"].isObject() ? ev["contexts"] : ujson::Value::object();
    const ujson::Value os = osInfo();
    ujson::Value o = ujson::Value::object();
    o.set("name", os["name"].str());
    o.set("version", os["version"].str());
    o.set("build", os["build"].str());
    ctx.set("os", std::move(o));
    MEMORYSTATUSEX ms{sizeof ms};
    GlobalMemoryStatusEx(&ms);
    ujson::Value dev = ujson::Value::object();
    dev.set("arch", os["arch"].str());
    dev.set("memory_size", static_cast<double>(ms.ullTotalPhys));
    dev.set("free_memory", static_cast<double>(ms.ullAvailPhys));
    dev.set("processor_count", static_cast<double>(std::max(1u, std::thread::hardware_concurrency())));
    dev.set("cpu_description", utf8(regString(HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", L"ProcessorNameString")));
    ctx.set("device", std::move(dev));
    const ujson::Value list = gpus();
    if (list.size()) {
        const ujson::Value &g0 = list.items()[0];
        ujson::Value g = ctx["gpu"].isObject() ? ctx["gpu"] : ujson::Value::object();
        g.set("name", g0["name"].str());
        g.set("vendor_name", g0["vendor"].str());
        g.set("version", g0["driver"].str());
        g.set("memory_size", g0["vram"].num(0) * 1024); // (MB)
        ctx.set("gpu", std::move(g));
    }
    ujson::Value app = ctx["app"].isObject() ? ctx["app"] : ujson::Value::object();
    app.set("app_name", "Grimcold");
    app.set("app_version", g_version);
    ctx.set("app", std::move(app));
    ev.set("contexts", std::move(ctx));
}

// The event's strings without the user's folder and names; its keys stay as they are (an account
// named "User" turned the "user" key into "<user>").
ujson::Value redactValues(const ujson::Value &v) {
    if (v.isString())
        return ujson::Value(redact(v.str()));
    if (v.isArray()) {
        ujson::Value a = ujson::Value::array();
        for (const auto &x : v.items())
            a.push(redactValues(x));
        return a;
    }
    if (v.isObject()) {
        ujson::Value o = ujson::Value::object();
        for (const auto &m : v.members())
            o.set(m.first, redactValues(m.second));
        return o;
    }
    return v;
}

// A minidump's bytes with the user's name, the computer's and the profile folder's overwritten in
// place, as text and as UTF-16: the same length, so the dump stays readable. Only where a name stands
// as a word of its own: an account named "User" leaves USER32.dll as it is.
void scrubDump(std::string &d) {
    const auto wordAt = [&](size_t i, bool wide) { // (a letter, digit or _ at byte i)
        return i < d.size() && word(d[i]) && (!wide || (i + 1 < d.size() && d[i + 1] == '\0'));
    };
    std::vector<std::string> names;
    const size_t cut = g_profile.find_last_of('\\');
    for (const std::string &n : {g_user, g_pc, cut == std::string::npos ? std::string() : g_profile.substr(cut + 1)})
        if (n.size() >= 3 && wide(n).size() >= 2) // (one CJK letter, 3 bytes, would match all over a dump)
            names.push_back(n);
    // (the longest first: a profile folder "name.DOMAIN" whole, not "____.DOMAIN")
    std::sort(names.begin(), names.end(), [](const std::string &a, const std::string &b) { return a.size() > b.size(); });
    for (const auto &n : names) {
        for (size_t i = 0; (i = ifind(d, n, i)) != std::string::npos; ++i) {
            if ((i > 0 && wordAt(i - 1, false)) || wordAt(i + n.size(), false))
                continue;
            std::fill(d.begin() + static_cast<std::ptrdiff_t>(i), d.begin() + static_cast<std::ptrdiff_t>(i + n.size()), '_');
        }
        const std::wstring w = wide(n);
        std::string w16(reinterpret_cast<const char *>(w.data()), w.size() * sizeof(wchar_t));
        for (size_t i = 0; (i = ifind(d, w16, i)) != std::string::npos; ++i) {
            if ((i >= 2 && wordAt(i - 2, true)) || wordAt(i + w16.size(), true))
                continue;
            for (size_t k = 0; k < w16.size(); k += 2) {
                d[i + k] = '_';
                d[i + k + 1] = '\0';
            }
        }
    }
}

} // namespace

// ---- the public part ----------------------------------------------------------------------------

void init(const fs::path &dataDir, const char *version) {
    g_dataDir = dataDir;
    g_logDir = dataDir / L"logs";
    g_crashDir = dataDir / L"crashes";
    g_version = version ? version : "0";
    strcpy_s(g_versionA, g_version.c_str());
    std::error_code ec;
    fs::create_directories(g_logDir, ec);
    fs::create_directories(g_crashDir, ec);
    WIN32_FILE_ATTRIBUTE_DATA logInfo{}; // (the last run's last line: when it was last alive, for an "exit" record)
    const bool hadLog = GetFileAttributesExW(logFile(0).c_str(), GetFileExInfoStandard, &logInfo) != 0;
    wcsncpy_s(g_crashDirW, g_crashDir.wstring().c_str(), _TRUNCATE);
    wcsncpy_s(g_runningW, (g_crashDir / L"running.json").wstring().c_str(), _TRUNCATE);
    // what redact() takes out: the user's folder, the user's and the computer's names
    g_profile = envUtf8(L"USERPROFILE");
    g_user = envUtf8(L"USERNAME");
    g_pc = envUtf8(L"COMPUTERNAME");
    {
        std::lock_guard lk(g_logMu);
        openLog();
    }
    ULONG keep = 64 * 1024; // (stack kept for the crash catcher after a stack overflow on this thread)
    SetThreadStackGuarantee(&keep);
    g_system[0] = GetModuleHandleW(L"ntdll.dll");
    g_system[1] = GetModuleHandleW(L"KERNELBASE.dll");
    g_system[2] = GetModuleHandleW(L"kernel32.dll");
    SetUnhandledExceptionFilter(onUnhandled);
    // (no std::set_terminate: UCRT's terminate() swallows what its handler raises, then calls abort,
    // whose stack names the terminate)
    _set_invalid_parameter_handler(onInvalidParameter);
    _set_purecall_handler(onPurecall);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    std::signal(SIGABRT, onAbortSignal);
    // The last run left its running.json (watchExit): it ended without closing and without a crash
    // record. Fail-fast ends (heap corruption, a broken stack cookie, __fastfail) skip every handler
    // above; so do Task Manager and a power cut.
    const fs::path running = g_crashDir / L"running.json";
    if (fs::exists(running, ec)) {
        ujson::Value last;
        try {
            last = ujson::Value::parse(readBytes(running, 4096));
        } catch (...) {
        }
        ujson::Value rec = ujson::Value::object();
        rec.set("id", "crash-" + stamp(true) + "-exit" + randomHex(4));
        rec.set("kind", "exit");
        std::string time = last["time"].str(stamp().substr(0, 19));
        double ms = last["ms"].num(static_cast<double>(epochMs()));
        if (hadLog) { // (dated by the run's last line in the log, nearer its end than its start)
            const unsigned long long t = (static_cast<unsigned long long>(logInfo.ftLastWriteTime.dwHighDateTime) << 32) | logInfo.ftLastWriteTime.dwLowDateTime;
            const double logMs = static_cast<double>((t - 116444736000000000ULL) / 10000);
            FILETIME local;
            SYSTEMTIME st;
            if (logMs > ms && FileTimeToLocalFileTime(&logInfo.ftLastWriteTime, &local) && FileTimeToSystemTime(&local, &st)) {
                char b[32];
                std::snprintf(b, sizeof b, "%04u-%02u-%02u %02u:%02u:%02u", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
                time = b;
                ms = logMs;
            }
        }
        rec.set("time", time);
        rec.set("ms", ms);
        rec.set("code", "");
        rec.set("what", "Grimcold ended unexpectedly, without a crash report");
        rec.set("version", last["version"].str(g_version));
        rec.set("dumped", false);
        writeRecord(rec);
        fs::remove(running, ec);
    }
}

void watchExit() {
    ujson::Value v = ujson::Value::object();
    v.set("pid", static_cast<double>(GetCurrentProcessId()));
    v.set("version", g_version);
    v.set("time", stamp().substr(0, 19));
    v.set("ms", static_cast<double>(epochMs()));
    const std::string s = v.dump();
    if (FILE *f = _wfsopen(g_runningW, L"wb", _SH_DENYNO)) {
        std::fwrite(s.data(), 1, s.size(), f);
        std::fclose(f);
    }
}

void stopWatching() {
    if (g_runningW[0])
        DeleteFileW(g_runningW);
}

std::string redact(std::string s) {
    if (!g_profile.empty()) {
        std::string fwd = g_profile, esc;
        std::replace(fwd.begin(), fwd.end(), '\\', '/');
        for (char c : g_profile)
            esc += c == '\\' ? std::string("\\\\") : std::string(1, c);
        const size_t cut = g_profile.find_last_of('\\');
        const std::string head = cut == std::string::npos ? std::string("C:") : g_profile.substr(0, cut); // (C:\Users)
        std::string headFwd = head, headEsc;
        std::replace(headFwd.begin(), headFwd.end(), '\\', '/');
        for (char c : head)
            headEsc += c == '\\' ? std::string("\\\\") : std::string(1, c);
        replaceAll(s, esc, headEsc + "\\\\<user>", false);
        replaceAll(s, g_profile, head + "\\<user>", false);
        replaceAll(s, fwd, headFwd + "/<user>", false);
    }
    redactUsersFolders(s);
    if (g_user.size() >= 3)
        replaceAll(s, g_user, "<user>", true);
    if (g_pc.size() >= 3)
        replaceAll(s, g_pc, "<pc>", true);
    return s;
}

void log(std::string_view source, std::string_view text) {
    std::string t(text.substr(0, 4000));
    for (char &c : t)
        if (c == '\r' || c == '\n')
            c = ' ';
    const std::string line = stamp() + " [" + std::string(source) + "] " + redact(std::move(t)) + "\r\n";
    std::lock_guard lk(g_logMu);
    if (!g_log)
        return;
    std::fwrite(line.data(), 1, line.size(), g_log);
    std::fflush(g_log);
    g_logSize += static_cast<long long>(line.size());
    if (g_logSize > kLogMax)
        rotateLog();
}

fs::path logDir() { return g_logDir; }

ujson::Value logTail(int n) {
    std::string text;
    {
        std::lock_guard lk(g_logMu);
        if (g_log)
            std::fflush(g_log);
        text = tailOf(logFile(0), kLogMax + 65536);
        const int lines = static_cast<int>(std::count(text.begin(), text.end(), '\n'));
        if (lines < n) // (just after a new file started: the end of the last one too)
            text = tailOf(logFile(1), kLogMax + 65536) + text;
    }
    std::vector<std::string> all;
    size_t i = 0;
    while (i < text.size()) {
        size_t e = text.find('\n', i);
        if (e == std::string::npos)
            e = text.size();
        std::string l = text.substr(i, e - i);
        if (!l.empty() && l.back() == '\r')
            l.pop_back();
        if (!l.empty())
            all.push_back(std::move(l));
        i = e + 1;
    }
    ujson::Value out = ujson::Value::array();
    for (size_t k = all.size() > static_cast<size_t>(n) ? all.size() - static_cast<size_t>(n) : 0; k < all.size(); ++k)
        out.push(all[k]);
    return out;
}

ujson::Value system(HWND hwnd, ICoreWebView2Environment *env) {
    ujson::Value s = ujson::Value::object();
    ujson::Value app = ujson::Value::object();
    app.set("version", g_version);
    app.set("built", __DATE__);
    app.set("reports", canSend());
    s.set("app", std::move(app));
    s.set("os", osInfo());
    ujson::Value cpu = ujson::Value::object();
    cpu.set("name", utf8(regString(HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", L"ProcessorNameString")));
    cpu.set("threads", static_cast<double>(std::thread::hardware_concurrency()));
    s.set("cpu", std::move(cpu));
    MEMORYSTATUSEX ms{sizeof ms};
    GlobalMemoryStatusEx(&ms);
    ujson::Value mem = ujson::Value::object();
    mem.set("total", gb(ms.ullTotalPhys));
    mem.set("free", gb(ms.ullAvailPhys));
    s.set("memory", std::move(mem));
    s.set("gpus", gpus());
    LPWSTR ver = nullptr;
    if (env && SUCCEEDED(env->get_BrowserVersionString(&ver)) && ver) {
        s.set("webview2", utf8(ver));
        CoTaskMemFree(ver);
    }
    ujson::Value disp = ujson::Value::object();
    if (hwnd) {
        const UINT dpi = GetDpiForWindow(hwnd);
        RECT r{};
        GetClientRect(hwnd, &r);
        disp.set("dpi", static_cast<double>(dpi));
        disp.set("scale", std::round(dpi / 96.0 * 100) / 100);
        disp.set("width", static_cast<double>(r.right - r.left));
        disp.set("height", static_cast<double>(r.bottom - r.top));
    }
    s.set("display", std::move(disp));
    s.set("dataDir", redact(utf8(g_dataDir.wstring())));
    return s;
}

ujson::Value crashes() {
    std::vector<std::pair<std::string, ujson::Value>> found;
    std::vector<fs::path> dumps;
    std::error_code ec;
    for (const auto &e : fs::directory_iterator(g_crashDir, ec)) {
        if (e.path().extension() == L".dmp") {
            dumps.push_back(e.path());
            continue;
        }
        if (e.path().extension() != L".json" || e.path().filename() == L"sending.json" || e.path().filename() == L"running.json")
            continue;
        const std::string text = readBytes(e.path(), 1 << 16);
        fs::path dmp = e.path();
        dmp.replace_extension(L".dmp");
        try {
            ujson::Value v = ujson::Value::parse(text);
            const std::string id = v["id"].str();
            if (!validId(id))
                continue;
            if (!v["dumped"].boolean(false) && fs::exists(dmp, ec))
                fs::remove(dmp, ec); // (the process ended while its dump was written: half a dump is no use)
            v.set("dump", fs::exists(dmp, ec) ? static_cast<double>(fs::file_size(dmp, ec)) : 0.0);
            found.emplace_back(id, std::move(v));
        } catch (...) {
            fs::remove(e.path(), ec); // (a summary cut short as the crash ended the app)
            fs::remove(dmp, ec);      // (and its dump with it)
        }
    }
    for (const auto &d : dumps) { // a dump without a summary: gone once it is a minute old (one being written now is left)
        fs::path j = d;
        j.replace_extension(L".json");
        if (fs::exists(j, ec))
            continue;
        const auto when = fs::last_write_time(d, ec);
        if (!ec && fs::file_time_type::clock::now() - when > std::chrono::minutes(1))
            fs::remove(d, ec);
    }
    // oldest first: on their milliseconds (several fall in one second), else their time
    std::stable_sort(found.begin(), found.end(), [](const auto &a, const auto &b) {
        const double ma = a.second["ms"].num(0), mb = b.second["ms"].num(0);
        if (ma > 0 && mb > 0 && ma != mb)
            return ma < mb;
        return a.second["time"].str() < b.second["time"].str();
    });
    while (found.size() > 10) { // (the oldest go: ten waiting is plenty)
        dropCrash(found.front().first);
        found.erase(found.begin());
    }
    ujson::Value out = ujson::Value::array();
    for (auto &f : found)
        out.push(std::move(f.second));
    return out;
}

bool dropCrash(const std::string &id) {
    if (!validId(id))
        return false;
    std::error_code ec;
    const bool a = fs::remove(g_crashDir / (wide(id) + L".json"), ec);
    fs::remove(g_crashDir / (wide(id) + L".dmp"), ec);
    return a;
}

void processFailed(const char *what, int exitCode, const std::string &reason) {
    log("host", std::string("WebView2's ") + what + " process ended (exit code " + std::to_string(exitCode) + (reason.empty() ? "" : ", " + reason) + ")");
    if (std::strcmp(what, "gpu") == 0)
        return; // (WebView2 starts another; the page loses its WebGL context and notes that itself)
    ujson::Value rec = ujson::Value::object();
    const std::string id = "crash-" + stamp(true) + "-" + randomHex(6);
    rec.set("id", id);
    rec.set("kind", std::strcmp(what, "page") == 0 ? "page" : "webview");
    const std::string t = stamp();
    rec.set("time", t.substr(0, 19));
    rec.set("ms", static_cast<double>(epochMs()));
    char code[16];
    std::snprintf(code, sizeof code, "0x%08X", static_cast<unsigned>(exitCode));
    rec.set("code", code);
    rec.set("what", std::strcmp(what, "page") == 0 ? "the page's process ended" : "WebView2 ended");
    rec.set("reason", reason);
    rec.set("version", g_version);
    rec.set("dumped", false);
    writeRecord(rec);
}

bool canSend() {
    std::lock_guard lk(g_sendMu);
    Dsn d;
    return parseDsn(g_dsn, d);
}

void testDsn(const std::string &dsn) {
    std::lock_guard lk(g_sendMu);
    g_dsn = dsn;
}

void testCrashRecord() {
    ujson::Value rec = ujson::Value::object();
    rec.set("id", "crash-" + stamp(true) + "-test" + randomHex(4));
    rec.set("kind", "crash");
    rec.set("time", stamp().substr(0, 19));
    rec.set("ms", static_cast<double>(epochMs()));
    rec.set("code", "0xC0000005");
    rec.set("what", "EXCEPTION_ACCESS_VIOLATION");
    rec.set("module", "Grimcold.exe");
    rec.set("offset", "0x1234");
    rec.set("version", g_version);
    rec.set("dumped", false);
    writeRecord(rec);
}

namespace {
// (tests: a stack overflow the compiler cannot turn into a loop)
int deeper(volatile int n) {
    volatile char pad[2048];
    pad[0] = static_cast<char>(n);
    if (n >= 0)
        return deeper(n + 1) + pad[0];
    return pad[0];
}
} // namespace

ujson::Value testScrub(const std::string &text) {
    const std::wstring w = wide(text);
    std::string d = text;
    d.append(reinterpret_cast<const char *>(w.data()), w.size() * sizeof(wchar_t));
    scrubDump(d);
    std::wstring back(w.size(), L'\0');
    std::memcpy(back.data(), d.data() + text.size(), w.size() * sizeof(wchar_t));
    ujson::Value o = ujson::Value::object();
    o.set("text", d.substr(0, text.size()));
    o.set("wide", utf8(back));
    return o;
}

void testCrashNow(const std::string &kind) {
    if (kind == "stack") { // a stack overflow (the handler has the stack SetThreadStackGuarantee kept)
        deeper(0);
    } else if (kind == "cpp") { // a C++ exception nobody catches (on a thread of its own: std::terminate)
        std::thread([] { throw std::runtime_error("a test exception nobody catches"); }).join();
    } else if (kind == "abort") {
        std::abort();
    } else if (kind == "invalid") { // an invalid parameter to the C runtime
        char *nowhere = nullptr;
        strcpy_s(nowhere, 4, "abc");
    } else if (kind == "purecall") {
        _purecall();
    } else if (kind == "two") { // two threads crashing at once (the second waits for the first's dump)
        std::thread a([] { volatile int *p = nullptr; *p = 1; });
        std::thread b([] { volatile int *p = nullptr; *p = 2; });
        a.join();
        b.join();
    } else if (kind == "fastfail") { // an end no handler sees (as heap corruption ends): only watchExit tells
        __fastfail(FAST_FAIL_FATAL_APP_EXIT);
    } else if (kind == "inside") { // the crash catcher itself faults: the process must still end
        g_testFaultInCrash = true;
    }
    volatile int *nowhere = nullptr;
    *nowhere = 1; // (an access violation: the crash catcher writes its minidump and the app ends)
    std::_Exit(4);
}

ujson::Value send(const ujson::Value &event, const std::string &crashId, bool attachLog) {
    ujson::Value r = ujson::Value::object();
    r.set("ok", false);
    Dsn d;
    std::string dsn;
    {
        std::lock_guard lk(g_sendMu);
        dsn = g_dsn;
    }
    if (!parseDsn(dsn, d)) {
        r.set("error", "this build sends no reports");
        return r;
    }
    const double now = unixNow();
    { // (the day's slot is taken before sending: reports sent side by side cannot pass the limit)
        std::lock_guard lk(g_stateMu);
        SendState st = loadState();
        if (st.waitUntil > now) {
            r.set("error", "the report server asked to wait; try again later");
            return r;
        }
        if (st.day != today()) {
            st.day = today();
            st.count = 0;
        }
        if (st.count >= kSendsPerDay) {
            r.set("error", "enough reports for today (" + std::to_string(kSendsPerDay) + "); thank you");
            return r;
        }
        ++st.count;
        saveState(st);
    }
    struct Slot { // (not sent, however it ends, a throw included: the slot is free again)
        bool sent = false;
        ~Slot() {
            if (sent)
                return;
            try {
                std::lock_guard lk(g_stateMu);
                SendState st = loadState();
                if (st.count > 0 && st.day == today()) {
                    --st.count;
                    saveState(st);
                }
            } catch (...) {
            }
        }
    } slot;
    ujson::Value ev = event.isObject() ? event : ujson::Value::object();
    const std::string eventId = randomHex(32);
    fillEvent(ev, eventId);
    const std::string payload = redactValues(ev).dump();
    std::string body = "{\"event_id\":\"" + eventId + "\",\"sent_at\":\"" + isoUtcNow() + "\"}\n";
    body += "{\"type\":\"event\",\"length\":" + std::to_string(payload.size()) + ",\"content_type\":\"application/json\"}\n" + payload + "\n";
    if (attachLog) {
        std::string text;
        const ujson::Value tail = logTail(300);
        for (const auto &l : tail.items())
            text += l.str() + "\n";
        body += "{\"type\":\"attachment\",\"length\":" + std::to_string(text.size()) + ",\"filename\":\"grimcold.log\",\"content_type\":\"text/plain\"}\n" + text + "\n";
    }
    if (!crashId.empty() && validId(crashId)) {
        std::string dump = readBytes(g_crashDir / (wide(crashId) + L".dmp"), 64u << 20);
        scrubDump(dump);
        if (!dump.empty())
            body += "{\"type\":\"attachment\",\"length\":" + std::to_string(dump.size()) + ",\"filename\":\"" + crashId +
                    ".dmp\",\"attachment_type\":\"event.minidump\"}\n" + dump + "\n";
    }
    const std::wstring headers = L"Content-Type: application/x-sentry-envelope\r\nX-Sentry-Auth: Sentry sentry_version=7, sentry_client=grimcold/" + wide(g_version) +
                                 L", sentry_key=" + wide(d.key) + L"\r\n";
    const Http h = post(d, body, headers);
    r.set("status", h.status);
    if (h.status == 429) {
        {
            std::lock_guard lk(g_stateMu);
            SendState st = loadState();
            st.waitUntil = std::max(st.waitUntil, now + (h.retryAfter > 0 ? h.retryAfter : 60));
            saveState(st);
        }
        r.set("error", "the report server is busy; try again later");
        return r;
    }
    if (h.status < 200 || h.status >= 300) {
        r.set("error", h.error.empty() ? "the report server answered " + std::to_string(h.status) : h.error);
        log("host", "a report was not sent: " + r["error"].str());
        return r;
    }
    slot.sent = true;
    if (!crashId.empty())
        dropCrash(crashId);
    r.set("ok", true);
    r.set("id", eventId);
    log("host", "report sent (" + eventId + (crashId.empty() ? std::string() : ", " + crashId) + ")");
    return r;
}

} // namespace rep
