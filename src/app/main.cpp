// Grimcold: browse Crossout's game archives, view vehicle parts in 3D with their
// textures, recolour / retexture them, and export to glTF (.glb/.gltf), OBJ, PNG and DDS.
//
// Host: Win32 window + WebView2. The UI (ui\, served as https://xo.app/) asks for data from
// https://xo.data/... (answered on worker threads) and sends commands over postMessage.
// The game folder is only ever read.
//
// Command line (the tests use these):
//   --data-dir <dir>    settings + WebView2 profile (default %LOCALAPPDATA%\Grimcold)
//   --game-dir <dir>    Crossout folder (or its data folder) instead of the saved/detected one
//   --debug-port <n>    Chrome DevTools protocol port (test mode)
//   --headless          window is DWM-cloaked and never activated (test mode)
//   --pos X,Y  --size W,H   window placement (test mode)
//   --devtools          open DevTools
#include "thirdparty/json.hpp"
#include "xo/Anim.h"
#include "xo/Archive.h"
#include "xo/Export.h"
#include "xo/Image.h"
#include "xo/Map.h"
#include "xo/Model.h"
#include "xo/Sky.h"
#include "xo/Sound.h"
#include "xo/Texture.h"
#include "xo/Zstd.h"
#include "app/report.h"

#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <wrl.h>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <charconv>
#include <climits>
#include <cmath>
#include <cwchar>
#include <cwctype>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kAppTitle[] = L"Grimcold";
constexpr wchar_t kWindowClass[] = L"GrimcoldWindow";
constexpr wchar_t kUiHost[] = L"xo.app";
constexpr char kVersion[] = "1.0.0";
constexpr UINT WM_APP_RUN = WM_APP + 1;

// ---------------------------------------------------------------------------------------------
// Options / small utilities

struct Options {
    fs::path dataDir, gameDir;
    int debugPort = 0;
    bool headless = false, devtools = false;
    int x = INT_MIN, y = INT_MIN, w = 0, h = 0;
    bool test() const { return debugPort > 0 || headless; }
} g_opt;

HWND g_hwnd = nullptr;
fs::path g_exeDir, g_dataDir;

std::string toUtf8(std::wstring_view w) {
    if (w.empty())
        return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}
std::wstring toWide(std::string_view s) {
    if (s.empty())
        return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}
std::string pathUtf8(const fs::path &p) { return toUtf8(p.wstring()); }
fs::path pathFromUtf8(std::string_view s) { return fs::path(toWide(s)); }

// Runs fn on the UI thread (posted to the window).
void postToUi(std::function<void()> fn) {
    auto *p = new std::function<void()>(std::move(fn));
    if (!g_hwnd || !PostMessageW(g_hwnd, WM_APP_RUN, 0, reinterpret_cast<LPARAM>(p)))
        delete p;
}

// A small worker pool for decoding and exporting.
class Pool {
  public:
    explicit Pool(unsigned n) {
        for (unsigned i = 0; i < n; ++i)
            threads_.emplace_back([this] { run(); });
    }
    ~Pool() {
        {
            std::lock_guard lk(mu_);
            stop_ = true;
            q_.clear(); // work still queued when the app closes is dropped
        }
        cv_.notify_all();
        for (auto &t : threads_)
            t.join();
    }
    void submit(std::function<void()> fn) {
        {
            std::lock_guard lk(mu_);
            q_.push_back(std::move(fn));
        }
        cv_.notify_one();
    }

  private:
    void run() {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        while (true) {
            std::function<void()> fn;
            {
                std::unique_lock lk(mu_);
                cv_.wait(lk, [&] { return stop_ || !q_.empty(); });
                if (stop_)
                    break;
                fn = std::move(q_.front());
                q_.pop_front();
            }
            try {
                fn();
            } catch (...) {
            }
        }
        CoUninitialize();
    }
    std::vector<std::thread> threads_;
    std::deque<std::function<void()>> q_;
    std::mutex mu_;
    std::condition_variable cv_;
    bool stop_ = false;
};
Pool *g_pool = nullptr;     // https://xo.data requests and the start-up scan
Pool *g_taskPool = nullptr; // commands' work (exports, extracts, imports, re-reading the game), so a long export never holds up the viewer
std::atomic<bool> g_quitting{false}; // set when the window is gone: running exports stop early
std::atomic<int> g_busyTasks{0};     // exports / extracts in flight (closing asks first)
bool g_closing = false;              // the window is on its way out (UI thread): nothing starts again
HANDLE g_exitEvent = nullptr;        // set when wWinMain is done: the close watchdog stands down

// %LOCALAPPDATA%, from the known-folder API (an unset or overlong variable can't break it).
fs::path localAppData() {
    PWSTR p = nullptr;
    fs::path d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p)))
        d = p;
    CoTaskMemFree(p);
    return d;
}

// ---------------------------------------------------------------------------------------------
// Settings (settings.json in the data dir)

ujson::Value g_settings = ujson::Value::object();
std::mutex g_settingsMu;
std::mutex g_settingsFileMu; // one settings.json write at a time, so an older copy can never land last

void loadSettings() {
    std::vector<uint8_t> raw;
    HANDLE h = CreateFileW((g_dataDir / L"settings.json").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE)
        return;
    LARGE_INTEGER sz{};
    GetFileSizeEx(h, &sz);
    raw.resize(static_cast<size_t>(sz.QuadPart));
    DWORD got = 0;
    ReadFile(h, raw.data(), static_cast<DWORD>(raw.size()), &got, nullptr);
    CloseHandle(h);
    try {
        ujson::Value v = ujson::Value::parse(std::string_view(reinterpret_cast<const char *>(raw.data()), got));
        if (v.isObject())
            g_settings = std::move(v);
    } catch (...) {
    }
}

void saveSettings() {
    std::lock_guard file(g_settingsFileMu);
    std::string text;
    {
        std::lock_guard lk(g_settingsMu);
        text = g_settings.dump(2);
    }
    std::error_code ec;
    fs::create_directories(g_dataDir, ec);
    std::string err;
    xo::writeFileBytes(g_dataDir / L"settings.json", text.data(), text.size(), &err);
}

std::string settingStr(std::string_view key) {
    std::lock_guard lk(g_settingsMu);
    return g_settings[key].str();
}
void setSetting(const std::string &key, ujson::Value v) {
    {
        std::lock_guard lk(g_settingsMu);
        g_settings.set(key, std::move(v));
    }
    saveSettings();
}

// ---------------------------------------------------------------------------------------------
// Game data

// The opened archive index never changes; picking or reloading builds a new one on a worker and
// swaps the pointer, so running exports keep reading the one they started with and the window
// never waits for a lock.
std::mutex g_gameMu; // guards the four below
std::shared_ptr<const xo::GameData> g_game;
std::string g_gameError; // why the last pick/reload failed ("" after a success)
fs::path g_gameRoot;     // Crossout install folder (the data folder's parent)
uint64_t g_gameGen = 0;  // newest open attempt; an older one that finishes late is dropped

std::shared_ptr<const xo::GameData> currentGame() {
    std::lock_guard lk(g_gameMu);
    return g_game;
}
fs::path currentGameRoot() {
    std::lock_guard lk(g_gameMu);
    return g_gameRoot;
}

// Accepts the install folder, its data folder, or a folder containing "Crossout Launcher".
fs::path resolveDataDir(const fs::path &p) {
    std::error_code ec;
    auto hasIndexes = [&](const fs::path &d) {
        if (!fs::is_directory(d, ec))
            return false;
        for (const auto &e : fs::directory_iterator(d, ec))
            if (e.path().extension() == L".index")
                return true;
        return false;
    };
    for (const fs::path &c : {p, p / L"data", p / L"Crossout Launcher" / L"data", p / L"Crossout" / L"data"})
        if (hasIndexes(c))
            return c;
    return {};
}

std::vector<fs::path> detectGameDirs() {
    std::vector<fs::path> out;
    for (HKEY root : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
        for (const wchar_t *sub : {L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                                   L"Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"}) {
            HKEY k;
            if (RegOpenKeyExW(root, sub, 0, KEY_READ, &k) != ERROR_SUCCESS)
                continue;
            wchar_t name[256];
            for (DWORD i = 0;; ++i) {
                DWORD nl = 256;
                if (RegEnumKeyExW(k, i, name, &nl, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
                    break;
                HKEY app;
                if (RegOpenKeyExW(k, name, 0, KEY_READ, &app) != ERROR_SUCCESS)
                    continue;
                // RegGetValueW always ends the string (RegQueryValueExW may hand back one without the end).
                wchar_t disp[512] = {}, loc[1024] = {};
                DWORD dl = sizeof(disp), ll = sizeof(loc);
                if (RegGetValueW(app, nullptr, L"DisplayName", RRF_RT_REG_SZ, nullptr, disp, &dl) != ERROR_SUCCESS)
                    disp[0] = 0;
                if (RegGetValueW(app, nullptr, L"InstallLocation", RRF_RT_REG_SZ, nullptr, loc, &ll) != ERROR_SUCCESS)
                    loc[0] = 0;
                RegCloseKey(app);
                if (StrStrIW(disp, L"Crossout") && loc[0])
                    out.emplace_back(loc);
            }
            RegCloseKey(k);
        }
    }
    if (const fs::path local = localAppData(); !local.empty())
        out.push_back(local / L"Crossout Launcher");
    for (const wchar_t *steam : {L"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Crossout", L"C:\\Program Files\\Steam\\steamapps\\common\\Crossout"})
        out.emplace_back(steam);
    return out;
}

std::string gameVersion(const fs::path &root) {
    const fs::path exe = root / L"bin" / L"win64" / L"Crossout.exe";
    DWORD dummy = 0;
    const DWORD n = GetFileVersionInfoSizeW(exe.c_str(), &dummy);
    if (!n)
        return {};
    std::vector<uint8_t> buf(n);
    if (!GetFileVersionInfoW(exe.c_str(), 0, n, buf.data()))
        return {};
    // The version text first: the build number (361437 in 2.40.10.361437) does not fit the 16 bits
    // the binary version has for it, which would show 33757, and the text adds the source revision.
    struct LangCp {
        WORD lang, cp;
    } *tr = nullptr;
    UINT trLen = 0;
    if (VerQueryValueW(buf.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void **>(&tr), &trLen) && tr && trLen >= sizeof(LangCp)) {
        wchar_t key[64];
        std::swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\FileVersion", tr->lang, tr->cp);
        wchar_t *txt = nullptr;
        UINT tl = 0;
        if (VerQueryValueW(buf.data(), key, reinterpret_cast<void **>(&txt), &tl) && txt && tl > 1) {
            std::string v = toUtf8(std::wstring(txt, wcsnlen(txt, tl)));
            const size_t paren = v.find('(');
            if (paren != std::string::npos && paren > 0 && v[paren - 1] != ' ')
                v.insert(paren, " "); // "2.40.10.361437(661aac453)" -> "2.40.10.361437 (661aac453)"
            if (!v.empty() && std::isdigit(static_cast<unsigned char>(v[0])))
                return v;
        }
    }
    VS_FIXEDFILEINFO *fi = nullptr;
    UINT len = 0;
    if (!VerQueryValueW(buf.data(), L"\\", reinterpret_cast<void **>(&fi), &len) || !fi)
        return {};
    char s[64];
    std::snprintf(s, sizeof(s), "%u.%u.%u.%u", HIWORD(fi->dwFileVersionMS), LOWORD(fi->dwFileVersionMS), HIWORD(fi->dwFileVersionLS),
                  LOWORD(fi->dwFileVersionLS));
    return s;
}

// Any thread. On failure the previously opened data stays in use and g_gameError says why.
bool openGame(const fs::path &picked) {
    uint64_t gen;
    {
        std::lock_guard lk(g_gameMu);
        gen = ++g_gameGen;
    }
    const fs::path data = resolveDataDir(picked);
    auto gd = std::make_shared<xo::GameData>();
    std::string err;
    bool ok = false;
    if (data.empty())
        err = "No Crossout game data (data\\*.index) in " + pathUtf8(picked);
    else
        ok = gd->open(data, &err);
    std::lock_guard lk(g_gameMu);
    if (gen != g_gameGen)
        return false; // a newer pick or reload replaced this one
    if (!ok) {
        g_gameError = err;
        return false;
    }
    g_game = std::move(gd);
    g_gameError.clear();
    g_gameRoot = data.parent_path();
    return true;
}

void openGameAtStartup() {
    if (!g_opt.gameDir.empty()) {
        openGame(g_opt.gameDir);
        return;
    }
    const std::string saved = settingStr("gameDir");
    if (!saved.empty() && openGame(pathFromUtf8(saved)))
        return;
    for (const auto &c : detectGameDirs())
        if (openGame(c)) {
            setSetting("gameDir", pathUtf8(currentGameRoot()));
            return;
        }
    std::lock_guard lk(g_gameMu);
    if (!g_game)
        g_gameError = "Crossout was not found. Choose its folder.";
}

ujson::Value gameStatus() {
    std::shared_ptr<const xo::GameData> gd;
    std::string error;
    fs::path root;
    {
        std::lock_guard lk(g_gameMu);
        gd = g_game;
        error = g_gameError;
        root = g_gameRoot;
    }
    const bool ok = gd && gd->isOpen();
    ujson::Value s = ujson::Value::object();
    s.set("ok", ok);
    s.set("error", error);
    s.set("root", pathUtf8(root));
    s.set("dataDir", ok ? pathUtf8(gd->dataDir()) : std::string());
    s.set("packs", ok ? static_cast<double>(gd->packs().size()) : 0.0);
    s.set("files", ok ? static_cast<double>(gd->entries().size()) : 0.0);
    s.set("gameVersion", ok ? gameVersion(root) : std::string());
    ujson::Value w = ujson::Value::array();
    if (ok)
        for (const auto &x : gd->warnings())
            w.push(x);
    s.set("warnings", std::move(w));
    return s;
}

// ---------------------------------------------------------------------------------------------
// Imported replacement images (id -> RGBA)

std::mutex g_imgMu;
std::map<std::string, std::shared_ptr<const xo::ImageRGBA>> g_images;
int g_nextImage = 1;

std::string storeImage(xo::ImageRGBA img) {
    std::lock_guard lk(g_imgMu);
    const std::string id = "img" + std::to_string(g_nextImage++);
    g_images[id] = std::make_shared<const xo::ImageRGBA>(std::move(img));
    return id;
}
std::shared_ptr<const xo::ImageRGBA> findImage(const std::string &id) {
    std::lock_guard lk(g_imgMu);
    auto it = g_images.find(id);
    return it == g_images.end() ? nullptr : it->second;
}

// ---------------------------------------------------------------------------------------------
// https://xo.data/... requests (worker threads)

struct Response {
    int status = 200;
    std::string contentType = "application/octet-stream";
    std::vector<uint8_t> body;
};

Response errorResponse(int status, const std::string &msg) {
    Response r;
    r.status = status;
    r.contentType = "text/plain; charset=utf-8";
    r.body.assign(msg.begin(), msg.end());
    return r;
}
Response jsonResponse(const ujson::Value &v) {
    Response r;
    r.contentType = "application/json; charset=utf-8";
    const std::string s = v.dump();
    r.body.assign(s.begin(), s.end());
    return r;
}

std::map<std::string, std::string> parseQuery(const std::wstring &uri, std::string &route) {
    std::map<std::string, std::string> q;
    std::string u = toUtf8(uri);
    const size_t hostEnd = u.find('/', u.find("//") + 2);
    std::string rest = hostEnd == std::string::npos ? "/" : u.substr(hostEnd);
    const size_t qm = rest.find('?');
    route = rest.substr(0, qm);
    if (qm == std::string::npos)
        return q;
    std::string qs = rest.substr(qm + 1);
    auto dec = [](const std::string &s) {
        std::string o;
        for (size_t i = 0; i < s.size(); ++i) {
            auto hexv = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
            if (s[i] == '%' && i + 2 < s.size() && hexv(s[i + 1]) >= 0 && hexv(s[i + 2]) >= 0) {
                o += static_cast<char>(hexv(s[i + 1]) * 16 + hexv(s[i + 2]));
                i += 2;
            } else {
                o += s[i] == '+' ? ' ' : s[i];
            }
        }
        return o;
    };
    size_t p = 0;
    while (p <= qs.size()) {
        size_t amp = qs.find('&', p);
        if (amp == std::string::npos)
            amp = qs.size();
        const std::string kv = qs.substr(p, amp - p);
        const size_t eq = kv.find('=');
        if (!kv.empty())
            q[dec(kv.substr(0, eq))] = eq == std::string::npos ? "" : dec(kv.substr(eq + 1));
        p = amp + 1;
    }
    return q;
}

// A number the game wrote as text (a .model's pose range) as it was written: the float's shortest
// decimal form (0.55, not 0.550000011920929, which also ended up in the slider's min).
double asWritten(float f) {
    char buf[32];
    const auto r = std::to_chars(buf, buf + sizeof buf - 1, f);
    *r.ptr = 0;
    return std::strtod(buf, nullptr);
}

ujson::Value matrixJson(const float m[16]) {
    ujson::Value a = ujson::Value::array();
    for (int i = 0; i < 16; ++i)
        a.push(static_cast<double>(m[i]));
    return a;
}

ujson::Value vec3Json(const float v[3], bool mirrorZ) {
    ujson::Value a = ujson::Value::array();
    a.push(static_cast<double>(v[0]));
    a.push(static_cast<double>(v[1]));
    a.push(static_cast<double>(mirrorZ ? -v[2] : v[2]));
    return a;
}

ujson::Value textureInfoJson(const xo::GameData &gd, const std::string &base) {
    ujson::Value t = ujson::Value::object();
    std::string err;
    const auto kept = xo::textureHeader(gd, base, &err); // (read once: every model that shows it asks)
    if (!kept) {
        t.set("error", err);
        return t;
    }
    const xo::Texture &tex = *kept;
    if (tex.firstLevel() < 0) { // every level in the .tfd: is it there (the index knows its size; no need to read it)
        const xo::Entry *e = gd.find(tex.base + ".tfd");
        bool fits = false;
        for (const auto &m : tex.info.levels)
            fits = fits || (m.inTfd && e && static_cast<uint64_t>(m.offset) + m.size <= e->size);
        if (!fits) {
            t.set("error", tex.base + ": no mip level is available");
            return t;
        }
    }
    t.set("width", static_cast<double>(tex.info.width));
    t.set("height", static_cast<double>(tex.info.height));
    t.set("format", xo::pixelFormatName(tex.info.format));
    t.set("mips", static_cast<double>(tex.info.mipCount));
    t.set("code", static_cast<double>(tex.info.code));
    t.set("hasTfd", gd.find(base + ".tfd") != nullptr);
    return t;
}

// A model's description for the view: its nodes, meshes, materials (with their textures' sizes),
// skins, LODs and animation layers.
ujson::Value modelInfo(const xo::GameData &gd, const xo::ModelBundle &b) {
    ujson::Value v = ujson::Value::object();
    v.set("path", b.mdlPath);
    v.set("name", b.baseName);
    v.set("dir", b.dir);
    v.set("skin", b.skin);
    v.set("mdf", b.mdfPath);
    v.set("version", static_cast<double>(b.model.version));
    ujson::Value skins = ujson::Value::array();
    for (const auto &s : b.skins) {
        ujson::Value o = ujson::Value::object();
        o.set("name", s.name);
        o.set("mdf", s.mdf);
        o.set("exists", gd.find(s.mdf) != nullptr);
        skins.push(std::move(o));
    }
    v.set("skins", std::move(skins));
    v.set("lodCount", b.model.lodCount);
    ujson::Value lodDist = ujson::Value::array();
    for (float d : b.model.lodDistance)
        lodDist.push(static_cast<double>(d));
    v.set("lodDistances", std::move(lodDist));
    ujson::Value lodSwitch = ujson::Value::array(); // per LOD 1, 2, ...: the screen size it takes over below
    for (float d : b.model.lodSwitch)
        lodSwitch.push(static_cast<double>(d));
    v.set("lodSwitch", std::move(lodSwitch));
    // bbox in glTF space: z mirrored, so min/max swap on z
    float mn[3] = {b.model.bbMin[0], b.model.bbMin[1], -b.model.bbMax[2]};
    float mx[3] = {b.model.bbMax[0], b.model.bbMax[1], -b.model.bbMin[2]};
    v.set("bbMin", vec3Json(mn, false));
    v.set("bbMax", vec3Json(mx, false));
    ujson::Value meshes = ujson::Value::array();
    for (size_t k = 0; k < b.model.meshes.size(); ++k) {
        const auto &me = b.model.meshes[k];
        ujson::Value m = ujson::Value::object();
        m.set("index", static_cast<double>(k));
        m.set("lod", me.lod);
        m.set("material", static_cast<double>(me.material));
        m.set("vertexCount", static_cast<double>(me.vertexCount));
        m.set("triangleCount", static_cast<double>(me.indexCount / 3));
        m.set("halfPositions", me.positionBytes == 8);
        m.set("skinned", me.maxInfluences > 0);
        ujson::Value els = ujson::Value::array();
        for (const auto &e : me.elements)
            els.push(xo::describeElement(e));
        m.set("elements", std::move(els));
        meshes.push(std::move(m));
    }
    v.set("meshes", std::move(meshes));
    ujson::Value nodes = ujson::Value::array();
    for (const auto &n : b.model.nodes) {
        ujson::Value o = ujson::Value::object();
        o.set("name", n.name);
        o.set("parent", n.parent);
        float m[16];
        xo::toGltfMatrix(n.world, m);
        o.set("matrix", matrixJson(m));
        nodes.push(std::move(o));
    }
    v.set("nodes", std::move(nodes));
    ujson::Value slots = ujson::Value::array();
    for (const auto &s : b.model.slots) {
        ujson::Value o = ujson::Value::object();
        o.set("name", s.name);
        float m[16];
        xo::toGltfMatrix(s.matrix, m);
        o.set("matrix", matrixJson(m));
        slots.push(std::move(o));
    }
    v.set("slots", std::move(slots));
    ujson::Value mats = ujson::Value::array();
    for (const auto &mv : b.materials) {
        ujson::Value o = ujson::Value::object();
        o.set("guid", mv.guid);
        o.set("alphaTest", mv.alphaTest);
        o.set("blend", mv.blend);
        o.set("heat", mv.heat);
        o.set("invisible", mv.invisible);
        if (mv.color[0] != 1 || mv.color[1] != 1 || mv.color[2] != 1) { // a base colour (linear): the plain-colour shader
            ujson::Value c = ujson::Value::array();
            for (float f : mv.color)
                c.push(std::round(static_cast<double>(f) * 1e4) / 1e4);
            o.set("color", std::move(c));
        }
        if (mv.uvScale != 1 || mv.uvSet != 0) { // the shown texture set's tiling and UV set (/geo sends the UVs as stored)
            o.set("uvScale", static_cast<double>(mv.uvScale));
            o.set("uvSet", mv.uvSet);
        }
        if (!mv.layers.empty()) { // the further texture sets a map material blends (xo::MapLayer)
            ujson::Value ls = ujson::Value::array();
            for (const auto &L : mv.layers) {
                ujson::Value lo = ujson::Value::object(), bl = ujson::Value::array();
                lo.set("index", L.index);
                lo.set("tiling", static_cast<double>(L.tiling));
                lo.set("uv", L.uv);
                lo.set("invert", L.invert);
                for (float f : L.blend)
                    bl.push(static_cast<double>(f));
                lo.set("blend", std::move(bl));
                ls.push(std::move(lo));
            }
            o.set("layers", std::move(ls));
            o.set("weights", mv.weights == 2 ? "colormap" : mv.weights == 1 ? "vertex" : "none");
        }
        if (mv.emissiveGain != 1)
            o.set("emissiveGain", static_cast<double>(mv.emissiveGain));
        if (mv.detailTiling > 0)
            o.set("detailTiling", static_cast<double>(mv.detailTiling));
        if (mv.maskFromGloss)
            o.set("maskFromGloss", true);
        if (mv.glow.on) { // a glow shader's look (xo::GlowLook): the view draws it as light added on
            const xo::GlowLook &g = mv.glow;
            ujson::Value go = ujson::Value::object(), sc = ujson::Value::array();
            go.set("additive", g.additive);
            go.set("twoSided", g.twoSided);
            go.set("d", g.d);
            go.set("c", g.c);
            go.set("swap", g.swap);
            go.set("gain", static_cast<double>(g.gain));
            for (float f : g.scroll)
                sc.push(static_cast<double>(f));
            go.set("scroll", std::move(sc));
            go.set("spin", static_cast<double>(g.spin));
            o.set("glow", std::move(go));
        }
        ujson::Value params = ujson::Value::array();
        for (const auto &p : mv.params) {
            ujson::Value po = ujson::Value::object();
            po.set("name", p.name);
            po.set("type", p.type);
            po.set("value", p.value);
            params.push(std::move(po));
        }
        o.set("params", std::move(params));
        ujson::Value texs = ujson::Value::array();
        for (const auto &t : mv.textures) {
            ujson::Value to = t.exists ? textureInfoJson(gd, t.base) : ujson::Value::object();
            to.set("role", t.role);
            to.set("param", t.param);
            to.set("base", t.base);
            to.set("exists", t.exists);
            texs.push(std::move(to));
        }
        o.set("textures", std::move(texs));
        mats.push(std::move(o));
    }
    v.set("materials", std::move(mats));
    // animation layers from the .model file (clips come from /anim)
    ujson::Value layers = ujson::Value::array();
    for (const auto &l : b.desc.layers) {
        ujson::Value o = ujson::Value::object();
        o.set("name", l.name);
        o.set("activity", l.activity);
        o.set("file", !l.file.empty() && gd.find(l.file) ? l.file : std::string());
        ujson::Value files = ujson::Value::array();
        bool allFiles = !l.files.empty();
        for (const auto &f : l.files)
            allFiles = allFiles && gd.find(f);
        if (allFiles) // a blend needs every pose
            for (const auto &f : l.files)
                files.push(f);
        o.set("files", std::move(files));
        o.set("speed", static_cast<double>(l.speed));
        if (!l.poseParameter.empty()) {
            ujson::Value pp = ujson::Value::object();
            pp.set("name", l.poseParameter);
            pp.set("min", asWritten(l.poseMin));
            pp.set("max", asWritten(l.poseMax));
            o.set("pose", std::move(pp));
        }
        ujson::Value add = ujson::Value::array();
        for (const auto &a : l.addLayers)
            add.push(a);
        o.set("add", std::move(add));
        layers.push(std::move(o));
    }
    v.set("layers", std::move(layers));
    ujson::Value warn = ujson::Value::array();
    for (const auto &w : b.warnings)
        warn.push(w);
    v.set("warnings", std::move(warn));
    ujson::Value other = ujson::Value::array();
    for (uint32_t t : b.model.otherBlocks)
        other.push(static_cast<double>(t));
    v.set("otherBlocks", std::move(other));
    return v;
}

Response serveModel(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("path");
    if (it == q.end())
        return errorResponse(400, "missing path");
    xo::ModelBundle b;
    std::string err;
    if (!xo::loadBundle(gd, it->second, q.count("skin") ? q.at("skin") : "", b, &err))
        return errorResponse(500, err);
    return jsonResponse(modelInfo(gd, b));
}

// /model and /geo in one answer, the model read once (a map asks for both of every model):
// "XOMB" u32 jsonLen, the description's JSON, padding to 4, then /geo's answer (the default look's
// geometry, as /geo gives it: another skin is read a second time for it).
Response serveModelGeo(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("path");
    if (it == q.end())
        return errorResponse(400, "missing path");
    const std::string skin = q.count("skin") ? q.at("skin") : "";
    const int lod = q.count("lod") ? std::atoi(q.at("lod").c_str()) : 0;
    xo::ModelBundle b;
    std::string err;
    if (!xo::loadBundle(gd, it->second, skin, b, &err))
        return errorResponse(500, err);
    std::vector<uint8_t> geo;
    if (skin.empty() || skin == "default") {
        if (!xo::packGeometry(b, lod, geo, &err, true))
            return errorResponse(500, err);
    } else {
        xo::ModelBundle d;
        if (!xo::loadBundle(gd, it->second, "", d, &err) || !xo::packGeometry(d, lod, geo, &err, true))
            return errorResponse(500, err);
    }
    const std::string json = modelInfo(gd, b).dump();
    Response r;
    r.body.reserve(8 + json.size() + 3 + geo.size());
    r.body.insert(r.body.end(), {'X', 'O', 'M', 'B'});
    const uint32_t jl = static_cast<uint32_t>(json.size());
    r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    r.body.insert(r.body.end(), json.begin(), json.end());
    while (r.body.size() % 4)
        r.body.push_back(' ');
    r.body.insert(r.body.end(), geo.begin(), geo.end());
    return r;
}

Response serveGeometry(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("path");
    if (it == q.end())
        return errorResponse(400, "missing path");
    xo::ModelBundle b;
    std::string err;
    if (!xo::loadBundle(gd, it->second, "", b, &err))
        return errorResponse(500, err);
    const int lod = q.count("lod") ? std::atoi(q.at("lod").c_str()) : 0;
    Response r;
    if (!xo::packGeometry(b, lod, r.body, &err, true))
        return errorResponse(500, err);
    return r;
}

// "XOTX" u32 jsonLen, JSON {width,height,format,srgb,levels:[{w,h,offset,size}]}, pad, data.
// The first level at or below `want` whose data is there (no .tfd: the .tfh's own small mips), else
// whatever level is there; -1 for none.
int availableLevel(const xo::Texture &t, int want) {
    const uint8_t *p;
    size_t n;
    for (int lv = std::max(want, 0); lv < static_cast<int>(t.info.levels.size()); ++lv)
        if (t.levelData(lv, p, n))
            return lv;
    return t.firstLevel();
}

Response serveTextureRaw(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("base");
    if (it == q.end())
        return errorResponse(400, "missing base");
    xo::Texture t;
    std::string err;
    if (!xo::loadTextureHeader(gd, it->second, t, &err))
        return errorResponse(404, err);
    const uint32_t maxSide = q.count("max") ? static_cast<uint32_t>(std::atoi(q.at("max").c_str())) : 0;
    // the level wanted, then only the .tfd chunks of it and the smaller ones (Maps asks for 512 px of
    // 2048-4096 px textures: the big levels were read and decompressed for nothing)
    const int count = static_cast<int>(t.info.levels.size());
    int first = 0;
    while (maxSide && first + 1 < count && std::max(t.info.levels[first].width, t.info.levels[first].height) > maxSide)
        ++first;
    std::string tfdErr;
    xo::loadTextureLevels(gd, t, first, count - 1, &tfdErr); // (levels it cannot read stay unavailable)
    first = availableLevel(t, first);
    if (first < 0)
        return errorResponse(404, t.base + ": no mip level is available" + (tfdErr.empty() ? std::string() : " (" + tfdErr + ")"));
    ujson::Value levels = ujson::Value::array();
    std::vector<uint8_t> data;
    for (size_t lv = first; lv < t.info.levels.size(); ++lv) {
        const uint8_t *p;
        size_t n;
        if (!t.levelData(static_cast<int>(lv), p, n))
            break;
        while (data.size() % 16)
            data.push_back(0);
        ujson::Value l = ujson::Value::object();
        l.set("w", static_cast<double>(t.info.levels[lv].width));
        l.set("h", static_cast<double>(t.info.levels[lv].height));
        l.set("offset", static_cast<double>(data.size()));
        l.set("size", static_cast<double>(n));
        levels.push(std::move(l));
        data.insert(data.end(), p, p + n);
    }
    ujson::Value head = ujson::Value::object();
    head.set("width", static_cast<double>(t.info.levels[first].width));
    head.set("height", static_cast<double>(t.info.levels[first].height));
    head.set("format", xo::pixelFormatName(xo::baseFormat(t.info.format)));
    head.set("srgb", xo::isSrgb(t.info.format));
    head.set("levels", std::move(levels));
    if (q.count("layout")) { // normal maps: which channels hold X/Y (judged on a small mip)
        int lv = static_cast<int>(t.info.levels.size()) - 1;
        while (lv > first && std::max(t.info.levels[lv].width, t.info.levels[lv].height) < 64)
            --lv;
        std::vector<uint8_t> px;
        uint32_t w, h;
        const char *layout = "AG";
        if (xo::decodeLevel(t, lv, px, w, h, &err)) {
            const auto l = xo::guessNormalLayout(t.info.format, px);
            layout = l == xo::NormalLayout::AG ? "AG" : l == xo::NormalLayout::RG ? "RG" : "RGB";
        }
        head.set("layout", layout);
    }
    const std::string js = head.dump();
    Response r;
    r.body = {'X', 'O', 'T', 'X'};
    const uint32_t jl = static_cast<uint32_t>(js.size());
    r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    r.body.insert(r.body.end(), js.begin(), js.end());
    while (r.body.size() % 16)
        r.body.push_back(' ');
    r.body.insert(r.body.end(), data.begin(), data.end());
    return r;
}

// The texture preview's channel views: rgb (as stored), opaque (alpha forced to 255), alpha / r /
// g / b (that channel as grey), normal (packed normal map rebuilt as a standard RGB one).
// Saving a PNG from the preview applies the same view, so the file is what the preview shows.
void applyView(std::vector<uint8_t> &rgba, const std::string &view, xo::PixelFormat fmt) {
    const size_t n = rgba.size() / 4;
    if (view == "normal") {
        xo::unpackNormals(rgba, xo::guessNormalLayout(fmt, rgba), nullptr);
    } else if (view == "alpha" || view == "r" || view == "g" || view == "b") {
        const int c = view == "alpha" ? 3 : view == "r" ? 0 : view == "g" ? 1 : 2;
        for (size_t i = 0; i < n; ++i) {
            const uint8_t v = rgba[i * 4 + c];
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
            rgba[i * 4 + 3] = 255;
        }
    } else if (view == "opaque") {
        for (size_t i = 0; i < n; ++i)
            rgba[i * 4 + 3] = 255;
    }
}

// Decoded pixels of a texture or an imported image, as PNG (view: see applyView) or as raw RGBA
// ("XORG" u32 w u32 h data) for /rgba.
Response serveDecoded(const xo::GameData &gd, const std::map<std::string, std::string> &q, bool png) {
    std::vector<uint8_t> rgba;
    uint32_t w = 0, h = 0;
    std::string err;
    const uint32_t maxSide = q.count("max") ? static_cast<uint32_t>(std::atoi(q.at("max").c_str())) : 0;
    const std::string view = q.count("view") ? q.at("view") : "rgb";
    xo::PixelFormat fmt = xo::PixelFormat::RGBA8;
    if (q.count("image")) {
        auto img = findImage(q.at("image"));
        if (!img)
            return errorResponse(404, "image not found");
        rgba = img->rgba;
        w = img->w;
        h = img->h;
    } else {
        auto it = q.find("base");
        if (it == q.end())
            return errorResponse(400, "missing base");
        xo::Texture t;
        if (!xo::loadTextureHeader(gd, it->second, t, &err))
            return errorResponse(404, err);
        const int count = static_cast<int>(t.info.levels.size());
        int lv = 0; // (the one level decoded: only its .tfd chunks are read)
        while (maxSide && lv + 1 < count && std::max(t.info.levels[lv].width, t.info.levels[lv].height) > maxSide * 2)
            ++lv;
        std::string tfdErr;
        xo::loadTextureLevels(gd, t, lv, lv, &tfdErr);
        lv = availableLevel(t, lv);
        if (lv < 0)
            return errorResponse(404, t.base + ": no mip level is available" + (tfdErr.empty() ? std::string() : " (" + tfdErr + ")"));
        if (!xo::decodeLevel(t, lv, rgba, w, h, &err))
            return errorResponse(500, err);
        fmt = t.info.format;
    }
    if (maxSide)
        xo::downscaleRgba(rgba, w, h, maxSide);
    applyView(rgba, view, fmt);
    Response r;
    if (png) {
        r.contentType = "image/png";
        if (!xo::encodePng(rgba.data(), w, h, r.body, &err))
            return errorResponse(500, err);
    } else {
        r.body = {'X', 'O', 'R', 'G'};
        r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&w), reinterpret_cast<const uint8_t *>(&w) + 4);
        r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&h), reinterpret_cast<const uint8_t *>(&h) + 4);
        r.body.insert(r.body.end(), rgba.begin(), rgba.end());
    }
    return r;
}

// A folder of animation frames (a water's waves: <dir>/01, 02 ... as the game names them, "%02d"),
// each a normal map, as the normals' x and y (two bytes per texel, however the frames pack them):
// "XOFR" u32 width, u32 height, u32 frames, then the frames one after another.
Response serveFrames(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("dir");
    if (it == q.end())
        return errorResponse(400, "missing dir");
    Response r;
    r.body = {'X', 'O', 'F', 'R'};
    r.body.resize(16, 0);
    uint32_t head[3] = {0, 0, 0}; // width, height, frames
    { // (Crossout 2.41: the frames are the layers of one texture, the normal's x in alpha, y in green)
        xo::Texture t;
        std::string err;
        if (gd.find(it->second + ".tfh") && xo::loadTexture(gd, it->second, t, &err) && t.info.layers > 1 && !t.info.cube) {
            for (uint32_t layer = 0; layer < t.info.layers; ++layer) {
                std::vector<uint8_t> px;
                uint32_t w = 0, h = 0;
                if (!xo::decodeLevel(t, t.firstLevel(), px, w, h, &err, static_cast<int>(layer)) || (head[2] && (w != head[0] || h != head[1])))
                    break;
                for (size_t i = 0; i < px.size(); i += 4) {
                    r.body.push_back(px[i + 3]);
                    r.body.push_back(px[i + 1]);
                }
                head[0] = w;
                head[1] = h;
                ++head[2];
            }
            if (!head[2])
                return errorResponse(404, it->second + ": " + err);
            std::memcpy(r.body.data() + 4, head, sizeof(head));
            return r;
        }
    }
    for (int f = 1; f <= 99; ++f) {
        char num[8];
        std::snprintf(num, sizeof(num), "/%02d", f);
        xo::Texture t;
        std::vector<uint8_t> px;
        uint32_t w = 0, h = 0;
        std::string err;
        if (!xo::loadTexture(gd, it->second + num, t, &err) || !xo::decodeLevel(t, t.firstLevel(), px, w, h, &err) || (head[2] && (w != head[0] || h != head[1])))
            break;
        const bool ag = xo::guessNormalLayout(t.info.format, px) == xo::NormalLayout::AG;
        for (size_t i = 0; i < px.size(); i += 4) {
            r.body.push_back(px[i + (ag ? 3 : 0)]);
            r.body.push_back(px[i + 1]);
        }
        head[0] = w;
        head[1] = h;
        ++head[2];
    }
    if (!head[2])
        return errorResponse(404, it->second + ": no frames");
    std::memcpy(r.body.data() + 4, head, sizeof(head));
    return r;
}

// One animation clip as JSON: { duration, tracks: [{ node, bone, format, times, t, r }] }
// (local offsets from the rest pose, glTF space; t = translations x3, r = quaternions x4).
Response serveAnim(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("path");
    if (it == q.end())
        return errorResponse(400, "missing path");
    std::vector<uint8_t> raw;
    std::string err;
    xo::Animation a;
    if (!gd.read(it->second, raw, &err) || !xo::parseAnim(raw, a, &err))
        return errorResponse(404, err);
    auto arr = [](const std::vector<float> &v) {
        ujson::Value x = ujson::Value::array();
        for (float f : v)
            x.push(static_cast<double>(f));
        return x;
    };
    ujson::Value v = ujson::Value::object(), tracks = ujson::Value::array();
    v.set("duration", static_cast<double>(a.duration));
    for (const auto &t : a.tracks) {
        ujson::Value o = ujson::Value::object();
        o.set("node", t.node);
        o.set("bone", static_cast<double>(t.bone));
        o.set("format", static_cast<double>(t.format));
        o.set("times", arr(t.times));
        if (!t.translation.empty())
            o.set("t", arr(t.translation));
        if (!t.rotation.empty())
            o.set("r", arr(t.rotation));
        tracks.push(std::move(o));
    }
    v.set("tracks", std::move(tracks));
    return jsonResponse(v);
}

// ---- maps (Maps mode) -------------------------------------------------------------------------
// The scene, the terrain and the ground colour of a map are three requests; the map they come from is
// read once (the last one asked for stays, keyed by name, festival, mode and environment, and by the
// game data).
std::mutex g_mapMu;
struct {
    uint64_t gd = 0; // GameData::id() (an address can come back for other data)
    std::string key;
    std::shared_ptr<const xo::MapScene> scene;
} g_mapCache;

// The map the page loads now (set by its /mapscene request). Requests for one it has left are refused
// at once: they baked its ground and loaded its scene again, pushing the new map out of the cache, so
// browsing maps made each one seconds late. (The page drops their answers anyway.)
std::mutex g_wantMu;
std::string g_mapWanted;
std::string mapKeyOf(const std::map<std::string, std::string> &q) {
    const auto arg = [&](const char *k, const char *def) { auto it = q.find(k); return it == q.end() ? std::string(def) : it->second; };
    return arg("name", "") + "|" + arg("festival", "Empty") + "|" + arg("gameplay", "auto") + "|" + arg("environment", "");
}
bool mapLeft(const std::map<std::string, std::string> &q) {
    std::lock_guard lk(g_wantMu);
    return !g_mapWanted.empty() && g_mapWanted != mapKeyOf(q);
}

std::shared_ptr<const xo::MapScene> mapFor(const xo::GameData &gd, const std::map<std::string, std::string> &q, std::string *err) {
    const auto arg = [&](const char *k, const char *def) { auto it = q.find(k); return it == q.end() ? std::string(def) : it->second; };
    xo::MapFilter f;
    f.festival = arg("festival", "Empty");
    f.gameplay = arg("gameplay", "auto");
    f.environment = arg("environment", ""); // ("" = the map's own pick)
    const std::string name = arg("name", "");
    const std::string key = name + "|" + f.festival + "|" + f.gameplay + "|" + f.environment;
    std::lock_guard lk(g_mapMu); // (a second request for the same map waits for the first, then takes it)
    if (g_mapCache.gd == gd.id() && g_mapCache.key == key && g_mapCache.scene)
        return g_mapCache.scene;
    auto s = std::make_shared<xo::MapScene>();
    if (!xo::loadMap(gd, name, f, *s, err))
        return nullptr;
    g_mapCache.gd = gd.id();
    g_mapCache.key = key;
    g_mapCache.scene = s;
    return s;
}

double round4(double v) { return std::round(v * 1e4) / 1e4; }

Response serveMapList(const xo::GameData &gd) {
    ujson::Value list = ujson::Value::array();
    for (const auto &s : xo::listMapSummaries(gd)) {
        ujson::Value m = ujson::Value::object();
        m.set("name", s.name);
        m.set("terrain", s.terrain);
        m.set("sizeX", static_cast<double>(s.sizeX));
        m.set("sizeZ", static_cast<double>(s.sizeZ));
        m.set("picture", s.picture);
        m.set("hudmap", s.hudmap);
        list.push(std::move(m));
    }
    return jsonResponse(list);
}

// The map's contents for the 3D view: models with their placements (glTF space, 3 x 4 per placement:
// columns 0..2 then the position), water outlines, spawns, terrain size; glTF space throughout.
Response serveMapScene(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    {
        std::lock_guard lk(g_wantMu);
        g_mapWanted = mapKeyOf(q);
    }
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    ujson::Value v = ujson::Value::object();
    v.set("name", s->name);
    v.set("environment", s->environment);
    ujson::Value envs = ujson::Value::array();
    for (const auto &c : s->environments) {
        ujson::Value e = ujson::Value::object(), fl = ujson::Value::array();
        e.set("id", c.id);
        e.set("name", c.name);
        for (const auto &f : c.festivals)
            fl.push(f);
        e.set("festivals", std::move(fl));
        e.set("modeOk", c.modeOk);
        envs.push(std::move(e));
    }
    v.set("environments", std::move(envs));
    v.set("filteredOut", s->filteredOut);
    v.set("festival", q.count("festival") ? q.at("festival") : std::string("Empty"));
    v.set("gameplay", s->gameplay);
    for (const auto &[key, set] : {std::pair{"gameplays", &s->gameplays}, std::pair{"festivals", &s->festivals}}) {
        ujson::Value a = ujson::Value::array();
        for (const auto &x : *set)
            a.push(x);
        v.set(key, std::move(a));
    }
    if (s->hasTerrain) {
        const xo::Terrain &t = s->terrain;
        ujson::Value tv = ujson::Value::object(), surf = ujson::Value::array();
        tv.set("cellsX", t.cellsX);
        tv.set("cellsZ", t.cellsZ);
        tv.set("cellSize", static_cast<double>(t.cellSize));
        tv.set("minY", static_cast<double>(t.minY));
        tv.set("maxY", static_cast<double>(t.maxY));
        tv.set("sizeX", static_cast<double>(t.sizeX()));
        tv.set("sizeZ", static_cast<double>(t.sizeZ()));
        for (const auto &x : t.surfaces)
            surf.push(x.name);
        tv.set("surfaces", std::move(surf));
        v.set("terrain", std::move(tv));
    }
    // one entry per model + skin + group, with all of its placements and their object ids (the
    // objects' order in the map: what /mapobject, exportMapObjects and exportMap's exclude take)
    struct Entry {
        const xo::MapObject *first;
        std::vector<double> mats, ids;
    };
    std::map<std::string, size_t> index;
    std::vector<Entry> models;
    for (size_t oi = 0; oi < s->objects.size(); ++oi) {
        const auto &o = s->objects[oi];
        const std::string key = o.model + "|" + o.skin + "|" + o.group;
        auto it = index.find(key);
        if (it == index.end()) {
            it = index.emplace(key, models.size()).first;
            models.push_back({&o, {}, {}});
        }
        float m[16];
        xo::mapObjectMatrix(o, m);
        auto &e = models[it->second];
        for (int k : {0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14})
            e.mats.push_back(round4(m[k]));
        e.ids.push_back(static_cast<double>(o.uid)); // (stable: the same object in every mode and festival)
    }
    ujson::Value ml = ujson::Value::array();
    for (const auto &e : models) {
        ujson::Value mv = ujson::Value::object(), arr = ujson::Value::array(), ids = ujson::Value::array();
        mv.set("path", e.first->model);
        mv.set("skin", e.first->skin);
        mv.set("group", e.first->group);
        if (!e.first->def.empty())
            mv.set("def", e.first->def);
        for (double d : e.mats)
            arr.push(d);
        for (double d : e.ids)
            ids.push(d);
        mv.set("m", std::move(arr));
        mv.set("ids", std::move(ids));
        ml.push(std::move(mv));
    }
    v.set("models", std::move(ml));
    // the water and acid: its level, outline and look (xo::MapWater)
    ujson::Value wl = ujson::Value::array();
    for (const auto &w : s->water) {
        ujson::Value wv = ujson::Value::object(), ol = ujson::Value::array(), col = ujson::Value::array();
        auto two = [](double a, double b) {
            ujson::Value x = ujson::Value::array();
            x.push(round4(a));
            x.push(round4(b));
            return x;
        };
        wv.set("name", w.name);
        wv.set("acid", w.acid);
        wv.set("type", w.type);
        wv.set("level", round4(w.level));
        for (const auto &p : w.outline) {
            ol.push(round4(p[0]));
            ol.push(round4(-p[1])); // glTF z
        }
        for (int c = 0; c < 3; ++c)
            col.push(static_cast<double>(w.color[c]));
        wv.set("outline", std::move(ol));
        wv.set("color", std::move(col));
        wv.set("density", round4(w.density));
        wv.set("depth", round4(w.depth));
        wv.set("tiling", two(w.uvTiling[0], w.uvTiling[1]));
        wv.set("speed", two(w.uvSpeed[0], w.uvSpeed[1]));
        wv.set("dir", two(w.bumpDir[0], w.bumpDir[1]));
        wv.set("bump", two(w.bumpHeight[0], w.bumpHeight[1]));
        wv.set("noiseTiling", round4(w.noiseTiling));
        if (!w.flowFrames.empty()) { // (Crossout 2.41's water: xo::MapWater fps, flowFrames, windMul, current)
            wv.set("fps", two(w.fps[0], w.fps[1]));
            wv.set("flowFrames", w.flowFrames);
            wv.set("windMul", round4(w.windMul));
            if (w.current > 0 && !s->waterFlowMap.empty())
                wv.set("current", round4(w.current));
        }
        wv.set("user2", w.user2);
        wv.set("user3", w.user3);
        wv.set("frames", w.frames);
        ujson::Value det = ujson::Value::array();
        for (const auto &d : w.detail)
            det.push(d);
        wv.set("detail", std::move(det));
        wv.set("colorMap", w.colorMap);
        if (!w.layered.empty()) {
            ujson::Value lv = ujson::Value::object();
            for (const auto &[k, val] : w.layered)
                lv.set(k, val);
            wv.set("layered", std::move(lv));
        }
        wl.push(std::move(wv));
    }
    v.set("water", std::move(wl));
    if (!s->waterFlowMap.empty() && s->hasTerrain) { // (the rivers' currents: over the terrain's square, game x, z)
        const xo::Terrain &t = s->terrain;
        ujson::Value f = ujson::Value::object();
        f.set("map", s->waterFlowMap);
        f.set("x0", static_cast<double>(t.x0()));
        f.set("z0", static_cast<double>(t.z0()));
        f.set("sizeX", static_cast<double>(t.cellsX * t.cellSize));
        f.set("sizeZ", static_cast<double>(t.cellsZ * t.cellSize));
        v.set("waterFlow", std::move(f));
    }
    ujson::Value sp = ujson::Value::array();
    for (const auto &x : s->spawns) {
        ujson::Value o = ujson::Value::object(), p = ujson::Value::array();
        o.set("def", x.def);
        o.set("team", x.team);
        p.push(round4(x.pos[0]));
        p.push(round4(x.pos[1]));
        p.push(round4(-x.pos[2]));
        o.set("pos", std::move(p));
        o.set("yaw", round4(x.yaw));
        sp.push(std::move(o));
    }
    v.set("spawns", std::move(sp));
    // the map's sounds (glTF space) and the environment's soundscape
    ujson::Value sl = ujson::Value::array();
    for (const auto &x : s->sounds) {
        ujson::Value o = ujson::Value::object(), p = ujson::Value::array();
        o.set("event", x.event);
        for (float c : {x.pos[0], x.pos[1], -x.pos[2]})
            p.push(round4(c));
        o.set("pos", std::move(p));
        if (!x.line.empty()) {
            ujson::Value l = ujson::Value::array();
            for (const auto &pt : x.line)
                for (float c : {pt[0], pt[1], -pt[2]})
                    l.push(round4(c));
            o.set("line", std::move(l));
        }
        sl.push(std::move(o));
    }
    v.set("sounds", std::move(sl));
    v.set("soundscape", s->soundscape);
    // the map's effects and the weather's boxes: glTF matrices, 3 x 4 like the models' (an effect's
    // with its env_scale in it; a box's: the unit cube from -0.5 to 0.5 to it)
    const auto mat12 = [](const float pos[3], const float ypr[3], const float scale[3]) {
        xo::MapObject o;
        std::memcpy(o.pos, pos, sizeof(o.pos));
        std::memcpy(o.ypr, ypr, sizeof(o.ypr));
        std::memcpy(o.scale, scale, sizeof(o.scale));
        float m[16];
        xo::mapObjectMatrix(o, m);
        ujson::Value a = ujson::Value::array();
        for (int k : {0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14})
            a.push(round4(m[k]));
        return a;
    };
    ujson::Value fl = ujson::Value::array();
    for (const auto &x : s->effects) {
        ujson::Value o = ujson::Value::object();
        const float sc[3] = {x.scale, x.scale, x.scale};
        o.set("effect", x.effect);
        o.set("m", mat12(x.pos, x.ypr, sc));
        o.set("scale", round4(x.scale));
        fl.push(std::move(o));
    }
    v.set("effects", std::move(fl));
    ujson::Value al = ujson::Value::array();
    for (const auto &x : s->areas) {
        ujson::Value o = ujson::Value::object();
        o.set("effect", x.effect);
        o.set("screen", x.screen);
        o.set("stopsWeather", x.stopsWeather);
        o.set("m", mat12(x.pos, x.ypr, x.size));
        al.push(std::move(o));
    }
    v.set("areas", std::move(al));
    // the map's lights (xo::MapLight), glTF space: where, which way they shine (dir: the game's +Z)
    // and what each kind needs
    ujson::Value ll = ujson::Value::array();
    const char *const kinds[] = {"point", "spot", "flare", "beam"}; // (MapLight::Kind)
    for (const auto &x : s->lights) {
        ujson::Value o = ujson::Value::object(), p = ujson::Value::array(), d = ujson::Value::array(), c = ujson::Value::array();
        o.set("kind", kinds[x.kind]);
        xo::MapObject at;
        std::memcpy(at.ypr, x.ypr, sizeof(at.ypr));
        float m[16];
        xo::mapObjectMatrix(at, m);
        for (float k : {x.pos[0], x.pos[1], -x.pos[2]})
            p.push(round4(k));
        for (int k = 8; k < 11; ++k)
            d.push(round4(-m[k]));
        for (uint8_t k : x.color)
            c.push(static_cast<double>(k));
        o.set("pos", std::move(p));
        o.set("dir", std::move(d));
        o.set("color", std::move(c));
        if (x.kind == xo::MapLight::Point || x.kind == xo::MapLight::Projector) {
            o.set("power", round4(x.power));
            o.set("linear", x.linearFalloff);
            o.set("shadows", x.shadows);
            o.set("specular", x.specular);
        }
        if (x.kind == xo::MapLight::Point)
            o.set("radius", round4(x.radius));
        if (x.kind == xo::MapLight::Projector) {
            ujson::Value f = ujson::Value::array();
            f.push(round4(x.fov[0]));
            f.push(round4(x.fov[1]));
            o.set("fov", std::move(f));
            o.set("far", round4(x.farClip));
            o.set("near", round4(x.nearClip));
        }
        if (x.kind == xo::MapLight::Flare || x.kind == xo::MapLight::Beam) {
            o.set("ev", round4(x.luminance));
            o.set("size", round4(x.size));
        }
        if (x.kind == xo::MapLight::Flare) {
            o.set("nebulosity", round4(x.nebulosity));
            o.set("visAngle", round4(x.visAngle));
        }
        if (x.kind == xo::MapLight::Beam)
            o.set("width", round4(x.width));
        if (x.flicker)
            o.set("flicker", true);
        ll.push(std::move(o));
    }
    v.set("lights", std::move(ll));
    std::vector<std::pair<int, std::string>> un;
    for (const auto &[d, c] : s->unresolved)
        un.emplace_back(c, d);
    std::sort(un.rbegin(), un.rend());
    ujson::Value ul = ujson::Value::array();
    for (const auto &[c, d] : un) {
        ujson::Value e = ujson::Value::array();
        e.push(d);
        e.push(c);
        ul.push(std::move(e));
    }
    v.set("unresolved", std::move(ul));
    return jsonResponse(v);
}

// "XOTR", u32 json length, JSON {w, h, step, cellSize, x0, z0 (glTF), minY, maxY}, pad to 4, float heights
// w x h (row r = glTF z0 - r * step * cellSize ... i.e. the game's z going up).
Response serveMapTerrain(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    if (!s->hasTerrain)
        return errorResponse(404, "this map has no terrain");
    const xo::Terrain &t = s->terrain;
    int step = q.count("step") ? std::atoi(q.at("step").c_str()) : 0;
    if (step <= 0)
        step = std::max(1, (std::max(t.cellsX, t.cellsZ) + 1023) / 1024);
    const int w = t.cellsX / step + 1, h = t.cellsZ / step + 1;
    ujson::Value v = ujson::Value::object();
    v.set("w", w);
    v.set("h", h);
    v.set("step", step);
    v.set("cellSize", static_cast<double>(t.cellSize));
    v.set("x0", static_cast<double>(t.x0()));
    v.set("z0", static_cast<double>(t.z0())); // game z of row 0 (glTF z = -that)
    v.set("minY", static_cast<double>(t.minY));
    v.set("maxY", static_cast<double>(t.maxY));
    const std::string json = v.dump();
    Response r;
    r.body = {'X', 'O', 'T', 'R'};
    const uint32_t jl = static_cast<uint32_t>(json.size());
    r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    r.body.insert(r.body.end(), json.begin(), json.end());
    while (r.body.size() % 4)
        r.body.push_back(' ');
    const size_t at = r.body.size();
    r.body.resize(at + static_cast<size_t>(w) * h * 4);
    float *dst = reinterpret_cast<float *>(r.body.data() + at);
    for (int j = 0; j < h; ++j)
        for (int i = 0; i < w; ++i)
            dst[static_cast<size_t>(j) * w + i] = t.height[static_cast<size_t>(std::min(j * step, t.cellsZ)) * t.samplesX() + std::min(i * step, t.cellsX)];
    return r;
}

// The light the terrain's hills leave it for a sun (sun=x,y,z towards it, glTF), on /mapterrain's grid:
// "XOTL", u32 json length, JSON {w, h, step}, pad to 4, then w x h RG8 (sun in sight, sky in sight).
Response serveMapTerrainLight(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    if (!s->hasTerrain)
        return errorResponse(404, "this map has no terrain");
    float sun[3]{0, 1, 0};
    if (q.count("sun")) {
        const std::string &v = q.at("sun");
        const char *p = v.data(), *end = v.data() + v.size();
        for (int k = 0; k < 3; ++k) {
            const auto res = std::from_chars(p, end, sun[k]);
            if (res.ec != std::errc() || !std::isfinite(sun[k]) || (k < 2 && (res.ptr == end || *res.ptr != ','))) // (from_chars takes "inf" and "nan")
                return errorResponse(400, "bad sun");
            p = res.ptr + 1;
        }
    }
    const xo::Terrain &t = s->terrain;
    int step = q.count("step") ? std::atoi(q.at("step").c_str()) : 0;
    if (step <= 0)
        step = std::max(1, (std::max(t.cellsX, t.cellsZ) + 1023) / 1024); // (as /mapterrain)
    const xo::TerrainLight light = xo::bakeTerrainLight(t, step, sun);
    ujson::Value v = ujson::Value::object();
    v.set("w", light.w);
    v.set("h", light.h);
    v.set("step", light.step);
    const std::string json = v.dump();
    Response r;
    r.body = {'X', 'O', 'T', 'L'};
    const uint32_t jl = static_cast<uint32_t>(json.size());
    r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    r.body.insert(r.body.end(), json.begin(), json.end());
    while (r.body.size() % 4)
        r.body.push_back(' ');
    r.body.insert(r.body.end(), light.rg.begin(), light.rg.end());
    return r;
}

// The ground baked from the map's surfaces, as JPEG (row 0 = the game's +Z edge): its colour, or with
// layer=orm its occlusion, roughness and metal (red, green, blue; for the view beyond the surfaces).
Response serveMapGround(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    // (the same ground in every mode and festival: baked once per map and size, a 4096 px bake takes seconds)
    static std::mutex cacheMu;
    static struct {
        uint64_t gd = 0;
        std::string key;
        std::vector<uint8_t> color, orm;
    } cache;
    const int size = std::clamp(q.count("size") ? std::atoi(q.at("size").c_str()) : 4096, 256, 8192);
    const std::string key = (q.count("name") ? q.at("name") : std::string()) + "|" + std::to_string(size);
    const bool orm = q.count("layer") && q.at("layer") == "orm";
    {
        std::lock_guard lk(cacheMu);
        if (cache.gd == gd.id() && cache.key == key) {
            Response r;
            r.contentType = "image/jpeg";
            r.body = orm ? cache.orm : cache.color;
            return r;
        }
    }
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    if (!s->hasTerrain)
        return errorResponse(404, "this map has no terrain");
    xo::ImageRGBA img, mr;
    std::vector<std::string> warnings;
    if (!xo::bakeGround(gd, s->terrain, size, img, warnings, &err, {}, nullptr, &mr))
        return errorResponse(500, err);
    std::vector<uint8_t> color, ormJpeg;
    if (!xo::encodeJpeg(img.rgba.data(), img.w, img.h, 0.9f, color, &err) || !xo::encodeJpeg(mr.rgba.data(), mr.w, mr.h, 0.9f, ormJpeg, &err))
        return errorResponse(500, err);
    Response r;
    r.contentType = "image/jpeg";
    r.body = orm ? ormJpeg : color;
    std::lock_guard lk(cacheMu);
    cache.gd = gd.id();
    cache.key = key;
    cache.color = std::move(color);
    cache.orm = std::move(ormJpeg);
    return r;
}

// The surface map, for the ground close to the camera (the baked ground is too coarse there): "XOSP",
// u32 json length, JSON {w, h, step, x0, z0 (game), sizeX, sizeZ, slice (the game's texture size),
// heightBlend (0 = off, else its strength: Map.h terrainHeightBlend), noise (the detail sets' mix
// texture), surfaces: [{name, albedo, normal, gloss, tiling, rotation, flip, blend (BlendRoughness),
// mid, amp, invert, flat, phys, standIn, detail: {albedo, normal, gloss, tiling, mid, rotation, flip,
// noise: [tiling, in min, in max, out min, out max]}}]}, pad to 4, then w x h RGBA8: the texel's three
// surfaces (u16 low | mid << 5 | high << 10) in R + G and its two blend weights in B + A. Row j lies at
// the game's z0 + (j + 0.5) * sizeZ / h. Maps finer than 4096 texels a side come every step-th texel.
Response serveMapSplat(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    const xo::Terrain &t = s->terrain;
    const int TX = t.texelsX(), TZ = t.texelsZ();
    if (!s->hasTerrain || t.surfIndex.empty() || TX <= 0 || TZ <= 0)
        return errorResponse(404, "this map has no surface map");
    const int step = std::max(1, (std::max(TX, TZ) + 4095) / 4096);
    const int w = TX / step, h = TZ / step;
    ujson::Value v = ujson::Value::object(), surf = ujson::Value::array();
    v.set("w", w);
    v.set("h", h);
    v.set("step", step);
    v.set("x0", static_cast<double>(t.x0()));
    v.set("z0", static_cast<double>(t.z0()));
    v.set("sizeX", static_cast<double>(t.sizeX()));
    v.set("sizeZ", static_cast<double>(t.sizeZ()));
    v.set("slice", t.sliceSize);
    v.set("texelOffset", static_cast<double>(t.texelOffset())); // (2.41's texels sit on the vertices: 0; mid-cell 0.5)
    v.set("heightBlend", t.heightBlend ? static_cast<double>(xo::terrainHeightBlend) : 0.0);
    v.set("noise", t.blendNoise);
    for (const auto &x : t.surfaces) {
        ujson::Value o = ujson::Value::object();
        o.set("name", x.name);
        o.set("albedo", x.albedo);
        o.set("normal", x.normal);
        o.set("gloss", x.gloss);
        o.set("tiling", static_cast<double>(x.tiling));
        o.set("rotation", x.rotation);
        o.set("flip", x.flip);
        o.set("blend", static_cast<double>(x.blendRoughness));
        o.set("mid", static_cast<double>(x.heightMid));
        o.set("amp", static_cast<double>(x.heightAmp));
        o.set("invert", x.invertBlend);
        o.set("flat", x.flatHeight);
        o.set("phys", x.physMaterial);
        o.set("standIn", x.standIn);
        if (!x.detail.albedo.empty()) {
            const xo::SurfaceDetail &d = x.detail;
            ujson::Value dv = ujson::Value::object(), nz = ujson::Value::array();
            dv.set("albedo", d.albedo);
            dv.set("normal", d.normal);
            dv.set("gloss", d.gloss);
            dv.set("tiling", static_cast<double>(d.tiling));
            dv.set("mid", static_cast<double>(d.heightMid));
            dv.set("rotation", d.rotation);
            dv.set("flip", d.flip);
            for (float f : {d.noiseTiling, d.noiseIn[0], d.noiseIn[1], d.noiseOut[0], d.noiseOut[1]})
                nz.push(static_cast<double>(f));
            dv.set("noise", std::move(nz));
            o.set("detail", std::move(dv));
        }
        surf.push(std::move(o));
    }
    v.set("surfaces", std::move(surf));
    const std::string json = v.dump();
    Response r;
    r.body = {'X', 'O', 'S', 'P'};
    const uint32_t jl = static_cast<uint32_t>(json.size());
    r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    r.body.insert(r.body.end(), json.begin(), json.end());
    while (r.body.size() % 4)
        r.body.push_back(' ');
    const size_t at = r.body.size();
    r.body.resize(at + static_cast<size_t>(w) * h * 4);
    uint8_t *dst = r.body.data() + at;
    const int half = step / 2;
    for (int j = 0; j < h; ++j)
        for (int i = 0; i < w; ++i) {
            const size_t src = static_cast<size_t>(std::min(j * step + half, TZ - 1)) * TX + std::min(i * step + half, TX - 1);
            const uint16_t ix = t.surfIndex[src];
            uint8_t *o = dst + (static_cast<size_t>(j) * w + i) * 4;
            o[0] = static_cast<uint8_t>(ix & 0xFF);
            o[1] = static_cast<uint8_t>(ix >> 8);
            o[2] = t.surfWeight[src * 2];
            o[3] = t.surfWeight[src * 2 + 1];
        }
    return r;
}

// "MAGIC", u32 json length, JSON, padding to 4, then the data (the viewer's binary replies).
void beginBlob(Response &r, const char magic[4], const ujson::Value &head) {
    const std::string json = head.dump();
    r.body.assign(magic, magic + 4);
    const uint32_t jl = static_cast<uint32_t>(json.size());
    r.body.insert(r.body.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    r.body.insert(r.body.end(), json.begin(), json.end());
    while (r.body.size() % 4)
        r.body.push_back(' ');
}
template <class T> void appendBlob(Response &r, const std::vector<T> &v) {
    const auto *p = reinterpret_cast<const uint8_t *>(v.data());
    r.body.insert(r.body.end(), p, p + v.size() * sizeof(T));
}

// One object of the map (id = its index, as /mapscene lists them): what the map says about it, in
// the game's own terms (position in metres, yaw / pitch / roll in degrees, scale per axis).
Response serveMapObject(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    const auto it = q.find("id");
    uint32_t id = 0;
    if (it == q.end() || std::from_chars(it->second.data(), it->second.data() + it->second.size(), id).ec != std::errc())
        return errorResponse(404, "no such object");
    const auto found = std::find_if(s->objects.begin(), s->objects.end(), [&](const xo::MapObject &x) { return x.uid == id; });
    if (found == s->objects.end())
        return errorResponse(404, "no such object");
    const xo::MapObject &o = *found;
    ujson::Value v = ujson::Value::object();
    auto vec = [](const float *p) {
        ujson::Value a = ujson::Value::array();
        for (int k = 0; k < 3; ++k)
            a.push(round4(p[k]));
        return a;
    };
    v.set("id", static_cast<double>(id));
    v.set("name", o.name);
    v.set("def", o.def);
    v.set("model", o.model);
    v.set("skin", o.skin);
    v.set("group", o.group);
    v.set("pos", vec(o.pos));
    v.set("ypr", vec(o.ypr));
    v.set("scale", vec(o.scale));
    return jsonResponse(v);
}

// The map's environment (sky, sun, fog): its preset's settings as they are written, for the viewer to read.
Response serveMapEnv(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    xo::MapEnvironment env;
    if (!xo::loadEnvironment(gd, s->name, s->environment, env, &err))
        return errorResponse(404, err);
    ujson::Value v = ujson::Value::object(), vals = ujson::Value::object(), rot = ujson::Value::array();
    v.set("id", env.id);
    v.set("name", env.name);
    for (float r : env.rotation)
        rot.push(static_cast<double>(r));
    v.set("rotation", std::move(rot));
    for (const auto &[k, val] : env.values)
        vals.set(k, val);
    v.set("values", std::move(vals));
    return jsonResponse(v);
}

// The map environment's light probe (xo::loadLightProbes; probe=1: its local one): "XOLP", JSON {id,
// center (glTF), halfMin, halfMax, rotation, envColor, mean (the capture's luminance over every
// direction), local (how many local probes), specular / diffuse / sky: [width, height]}, then three
// panoramas as RGBA halves, rows from v = 0 (three's equirectangular layout): the specular capture
// (its mip 0, light-probe units; glints clamped at 64 x the median, which PMREM would blur into
// fireflies), its diffuse irradiance / pi, and the sky alone (FogLightingProbe, black if none).
Response serveMapProbe(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    xo::MapProbes mp;
    if (!xo::loadLightProbes(gd, s->name, s->environment, mp, &err))
        return errorResponse(404, err);
    const size_t which = q.count("probe") ? static_cast<size_t>(std::atoi(q.at("probe").c_str())) : 0;
    if (which >= mp.probes.size())
        return errorResponse(404, "no such light probe");
    const xo::LightProbe &p = mp.probes[which];
    xo::CubeMap spec, diff, sky;
    if (!xo::loadCubeMap(gd, p.specular, 0, spec, &err) || !xo::loadCubeMap(gd, p.diffuse, 0, diff, &err))
        return errorResponse(404, err);
    if (!mp.inscattering.empty())
        xo::loadCubeMap(gd, mp.inscattering, 0, sky, nullptr); // (none: black)
    const double mean = xo::cubeLuminance(spec, false);
    const int sw = spec.size * 4, dw = 64, kw = 128;
    std::vector<float> ps, pd, pk;
    xo::cubePanorama(spec, sw, ps);
    xo::cubePanorama(diff, dw, pd);
    xo::cubePanorama(sky, kw, pk);
    std::vector<float> lum(ps.size() / 3);
    for (size_t i = 0; i < lum.size(); ++i)
        lum[i] = 0.2126f * ps[i * 3] + 0.7152f * ps[i * 3 + 1] + 0.0722f * ps[i * 3 + 2];
    std::nth_element(lum.begin(), lum.begin() + lum.size() / 2, lum.end());
    const float cap = std::max(lum[lum.size() / 2], 1e-4f) * 64;
    for (size_t i = 0; i < ps.size() / 3; ++i) {
        const float l = 0.2126f * ps[i * 3] + 0.7152f * ps[i * 3 + 1] + 0.0722f * ps[i * 3 + 2];
        if (l > cap)
            for (int c = 0; c < 3; ++c)
                ps[i * 3 + c] *= cap / l;
    }
    // RGBA halves, bottom row first
    auto halves = [](const std::vector<float> &rgb, int w) {
        const int h = w / 2;
        std::vector<uint16_t> out(static_cast<size_t>(w) * h * 4, xo::floatToHalf(1));
        for (int y = 0; y < h; ++y)
            for (int x = 0; x < w; ++x)
                for (int c = 0; c < 3; ++c)
                    out[(static_cast<size_t>(h - 1 - y) * w + x) * 4 + c] = xo::floatToHalf(rgb[(static_cast<size_t>(y) * w + x) * 3 + c]);
        return out;
    };
    auto vec = [](const float *f, bool mirrorZ) {
        ujson::Value a = ujson::Value::array();
        for (int i = 0; i < 3; ++i)
            a.push(static_cast<double>(mirrorZ && i == 2 ? -f[i] : f[i]));
        return a;
    };
    auto size = [](int w) {
        ujson::Value a = ujson::Value::array();
        a.push(static_cast<double>(w));
        a.push(static_cast<double>(w / 2));
        return a;
    };
    ujson::Value v = ujson::Value::object();
    v.set("id", p.id);
    v.set("center", vec(p.center, true));
    v.set("halfMin", vec(p.halfMin, false));
    v.set("halfMax", vec(p.halfMax, false));
    v.set("rotation", vec(p.rotation, false));
    v.set("envColor", vec(p.envColor, false));
    v.set("mean", mean);
    v.set("local", static_cast<double>(mp.probes.size() - 1));
    v.set("specular", size(sw));
    v.set("diffuse", size(dw));
    v.set("sky", size(kw));
    Response r;
    beginBlob(r, "XOLP", v);
    appendBlob(r, halves(ps, sw));
    appendBlob(r, halves(pd, dw));
    appendBlob(r, halves(pk, kw));
    return r;
}

// Crossout 2.41's sky picture (an environment's BackdropPath; Sky.cpp Backdrop): "XOBD", JSON {width,
// height}, then RGBA halves, bottom row first (three's layout: v = 0 at the horizon), as stored (x
// BackdropLuminance / 2048: light-probe units); max: no wider than that (halved till it is).
Response serveBackdrop(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("base");
    if (it == q.end())
        return errorResponse(400, "missing base");
    const std::string &base = it->second;
    std::string err;
    std::vector<float> rgb;
    uint32_t w = 0, h = 0;
    if (base == xo::kNoSky) {
        w = 64, h = 16;
        rgb.assign(static_cast<size_t>(w) * h * 3, 0.0f);
    } else if (base.rfind(xo::kAirSky, 0) == 0) { // "@air:<map>:<environment>": worked out from its air (xo::renderAirSky)
        const size_t a = base.find(':'), b = base.rfind(':');
        xo::MapEnvironment env;
        if (a == std::string::npos || b <= a)
            return errorResponse(400, "bad sky " + base);
        if (!xo::loadEnvironment(gd, base.substr(a + 1, b - a - 1), base.substr(b + 1), env, &err) || !xo::renderAirSky(gd, env, 1024, rgb, &err))
            return errorResponse(404, err);
        w = 1024, h = 256;
    } else {
        xo::Texture t;
        if (!xo::loadTexture(gd, base, t, &err) || !xo::decodeLevelFloat(t, t.firstLevel(), rgb, w, h, &err))
            return errorResponse(404, err);
    }
    const uint32_t max = q.count("max") ? static_cast<uint32_t>(std::max(16, std::atoi(q.at("max").c_str()))) : 4096;
    while (w > max && w % 2 == 0 && h % 2 == 0) {
        std::vector<float> half(static_cast<size_t>(w / 2) * (h / 2) * 3);
        for (uint32_t y = 0; y < h / 2; ++y)
            for (uint32_t x = 0; x < w / 2; ++x)
                for (int c = 0; c < 3; ++c)
                    half[(static_cast<size_t>(y) * (w / 2) + x) * 3 + c] = (rgb[((2 * y) * static_cast<size_t>(w) + 2 * x) * 3 + c] + rgb[((2 * y) * static_cast<size_t>(w) + 2 * x + 1) * 3 + c] +
                                                                            rgb[((2 * y + 1) * static_cast<size_t>(w) + 2 * x) * 3 + c] + rgb[((2 * y + 1) * static_cast<size_t>(w) + 2 * x + 1) * 3 + c]) / 4;
        rgb = std::move(half);
        w /= 2, h /= 2;
    }
    std::vector<uint16_t> out(static_cast<size_t>(w) * h * 4, xo::floatToHalf(1));
    for (uint32_t y = 0; y < h; ++y)
        for (uint32_t x = 0; x < w; ++x)
            for (int c = 0; c < 3; ++c)
                out[(static_cast<size_t>(h - 1 - y) * w + x) * 4 + c] = xo::floatToHalf(rgb[(static_cast<size_t>(y) * w + x) * 3 + c]);
    ujson::Value v = ujson::Value::object();
    v.set("width", static_cast<double>(w));
    v.set("height", static_cast<double>(h));
    Response r;
    beginBlob(r, "XOBD", v);
    appendBlob(r, out);
    return r;
}

// A precomputed atmosphere: "XOAT", JSON {guid, dir, uniforms}, then transmittance (256 x 64 RGBA32F),
// irradiance (64 x 16 RGBA32F) and scattering (256 x 128 x 32 RGBA16F), rows from v = 0.
Response serveAtmosphere(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("guid");
    if (it == q.end())
        return errorResponse(400, "missing guid");
    xo::Atmosphere a;
    std::string err;
    if (!xo::loadAtmosphere(gd, it->second, a, &err))
        return errorResponse(404, err);
    ujson::Value v = ujson::Value::object(), u = ujson::Value::object();
    v.set("guid", a.guid);
    v.set("dir", a.dir);
    for (const auto &[k, val] : a.uniforms)
        u.set(k, val);
    v.set("uniforms", std::move(u));
    Response r;
    beginBlob(r, "XOAT", v);
    appendBlob(r, a.transmittance);
    appendBlob(r, a.irradiance);
    appendBlob(r, a.scattering);
    return r;
}

// The map's grass: "XOGR", JSON {gridX, gridZ, cellSize, x0, z0 (game), count, types, cells: [cell, type,
// first, count, minY, maxY] ...}, then per instance 13 floats: its glTF matrix (3 columns, then the
// position) and its rank (0..1 within its cell: thinned out by it with distance); then per instance
// 4 bytes: the tint it takes from the ground (xo::grassTints; r g b x 127.5, so 255 = 2).
Response serveMapGrass(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    auto it = q.find("name");
    if (it == q.end())
        return errorResponse(400, "missing name");
    xo::MapGrass g;
    std::string err;
    if (!xo::loadGrass(gd, it->second, g, &err))
        return errorResponse(404, err);
    ujson::Value v = ujson::Value::object(), types = ujson::Value::array(), cells = ujson::Value::array();
    v.set("gridX", g.gridX);
    v.set("gridZ", g.gridZ);
    v.set("cellSize", static_cast<double>(g.cellSize));
    v.set("x0", static_cast<double>(g.x0));
    v.set("z0", static_cast<double>(g.z0));
    v.set("count", static_cast<double>(g.items.size()));
    for (const auto &t : g.types) {
        ujson::Value o = ujson::Value::object();
        o.set("preset", static_cast<double>(t.preset));
        o.set("name", t.name);
        o.set("model", t.model);
        o.set("distFactor", static_cast<double>(t.distFactor));
        o.set("wind", static_cast<double>(t.wind));
        o.set("luminance", static_cast<double>(t.luminance));
        o.set("cloak", static_cast<double>(t.cloak));
        o.set("align", t.alignToNormal);
        types.push(std::move(o));
    }
    v.set("types", std::move(types));
    for (const auto &c : g.cells)
        for (double x : {static_cast<double>(c.cell), static_cast<double>(c.type), static_cast<double>(c.first), static_cast<double>(c.count),
                         round4(c.minY), round4(c.maxY)})
            cells.push(x);
    v.set("cells", std::move(cells));
    std::vector<float> data;
    data.reserve(g.items.size() * 13);
    for (const auto &item : g.items) {
        float m[16];
        xo::grassMatrix(item, m);
        for (int k : {0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14})
            data.push_back(m[k]);
        data.push_back(item.rank);
    }
    std::vector<float> rgb;
    xo::grassTints(gd, it->second, g, rgb, nullptr); // (no colour map: their own colour)
    std::vector<uint32_t> tints(g.items.size());
    for (size_t i = 0; i < tints.size(); ++i) {
        for (int k = 0; k < 3; ++k)
            tints[i] |= static_cast<uint32_t>(std::lround(std::clamp(rgb[i * 3 + k] * 127.5f, 0.0f, 255.0f))) << (8 * k);
        tints[i] |= 0xFF000000u;
    }
    Response r;
    beginBlob(r, "XOGR", v);
    appendBlob(r, data);
    appendBlob(r, tints);
    return r;
}

// The map's decals, projected onto what they lie on: "XODC", JSON {decals: [{name, preset, albedo, normal,
// opacity, sharpness, height, custom, color, uniform, albedoOpacity, spec, gloss, metal, normalOpacity,
// glow, glowEv, glowFromAlbedo, layer, sublayer}], meshes: [decal, firstVertex, vertices, firstIndex,
// indices] ..., vertices, indices}, then positions (3 floats), normals (3), uvs (2), fades (1) of every
// vertex and the indices (u32). Kept for the last map asked for.
std::mutex g_decalMu;
struct {
    uint64_t gd = 0; // GameData::id()
    std::string key;
    std::vector<uint8_t> body;
} g_decalCache;

Response serveMapDecals(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    std::string err;
    const auto s = mapFor(gd, q, &err);
    if (!s)
        return errorResponse(404, err);
    const std::string key = s->name + "|" + s->gameplay + "|" + s->environment + "|" + (q.count("festival") ? q.at("festival") : "");
    {
        std::lock_guard lk(g_decalMu);
        if (g_decalCache.gd == gd.id() && g_decalCache.key == key) {
            Response r;
            r.body = g_decalCache.body;
            return r;
        }
    }
    static std::mutex presetMu;
    static std::map<uint32_t, xo::DecalPreset> presets;
    static uint64_t presetGd = 0; // GameData::id()
    std::map<uint32_t, xo::DecalPreset> pr;
    {
        std::lock_guard lk(presetMu);
        if (presetGd != gd.id()) {
            presets = xo::readDecalPresets(gd);
            presetGd = gd.id();
        }
        pr = presets;
    }
    std::vector<xo::DecalMesh> meshes;
    std::vector<std::string> warnings;
    xo::buildDecalMeshes(gd, *s, pr, 0, meshes, warnings);
    ujson::Value v = ujson::Value::object(), decals = ujson::Value::array(), ml = ujson::Value::array();
    auto rgb = [](const uint8_t c[3]) {
        ujson::Value a = ujson::Value::array();
        for (int k = 0; k < 3; ++k)
            a.push(static_cast<double>(c[k]));
        return a;
    };
    for (const auto &d : s->decals) {
        ujson::Value o = ujson::Value::object();
        o.set("name", d.name);
        o.set("preset", static_cast<double>(d.preset));
        auto p = pr.find(d.preset);
        if (p != pr.end()) {
            o.set("albedo", p->second.albedo);
            o.set("normal", p->second.normal);
            o.set("uniform", rgb(p->second.uniform));
            o.set("albedoOpacity", static_cast<double>(p->second.albedoOpacity));
            const xo::DecalPreset &x = p->second;
            o.set("spec", x.spec);
            o.set("gloss", round4(x.gloss));
            o.set("metal", round4(x.metal));
            o.set("normalOpacity", round4(x.normalOpacity));
            // its glow: the preset's colour and luminance, or the decal's own (a black one: none)
            const uint8_t *glow = d.customGlow ? d.glowColor : x.glowColor;
            if (x.glow && (glow[0] || glow[1] || glow[2])) {
                o.set("glow", rgb(glow));
                o.set("glowEv", round4(d.customGlowEv ? d.glowEv : x.glowEv));
                o.set("glowFromAlbedo", x.glowFromAlbedo && !x.albedo.empty());
            }
        }
        o.set("layer", d.layer);
        o.set("sublayer", d.sublayer);
        o.set("opacity", static_cast<double>(d.opacity));
        o.set("sharpness", static_cast<double>(d.sharpness));
        o.set("height", static_cast<double>(d.height));
        o.set("custom", d.customColor);
        o.set("color", rgb(d.color));
        decals.push(std::move(o));
    }
    v.set("decals", std::move(decals));
    std::vector<float> pos, nor, uv, fade;
    std::vector<uint32_t> idx;
    for (const auto &m : meshes) {
        const uint32_t vbase = static_cast<uint32_t>(pos.size() / 3), ibase = static_cast<uint32_t>(idx.size());
        pos.insert(pos.end(), m.position.begin(), m.position.end());
        nor.insert(nor.end(), m.normal.begin(), m.normal.end());
        uv.insert(uv.end(), m.uv.begin(), m.uv.end());
        fade.insert(fade.end(), m.fade.begin(), m.fade.end());
        for (uint32_t i : m.indices)
            idx.push_back(i); // (per mesh: drawn with its own first vertex)
        for (double x : {static_cast<double>(m.decal), static_cast<double>(vbase), static_cast<double>(m.position.size() / 3), static_cast<double>(ibase),
                         static_cast<double>(m.indices.size()),
                         m.object >= 0 && static_cast<size_t>(m.object) < s->objects.size() ? static_cast<double>(s->objects[m.object].uid) : -1.0}) // (the id of what it lies on, -1 = the ground)
            ml.push(x);
    }
    v.set("meshes", std::move(ml));
    v.set("vertices", static_cast<double>(pos.size() / 3));
    v.set("indices", static_cast<double>(idx.size()));
    ujson::Value warn = ujson::Value::array();
    for (const auto &w : warnings)
        warn.push(w);
    v.set("warnings", std::move(warn));
    Response r;
    beginBlob(r, "XODC", v);
    appendBlob(r, pos);
    appendBlob(r, nor);
    appendBlob(r, uv);
    appendBlob(r, fade);
    appendBlob(r, idx);
    {
        std::lock_guard lk(g_decalMu);
        g_decalCache.gd = gd.id();
        g_decalCache.key = key;
        g_decalCache.body = r.body;
    }
    return r;
}

Response serveFileList(const xo::GameData &gd) {
    Response r;
    r.contentType = "text/plain; charset=utf-8";
    std::string s;
    s.reserve(gd.entries().size() * 64);
    for (const auto &e : gd.entries()) {
        s += e.name;
        s += '\t';
        s += std::to_string(e.size);
        s += '\n';
    }
    r.body.assign(s.begin(), s.end());
    return r;
}

// The game's sound effects (xo/Sound.h), listed once per game folder read.
std::mutex g_soundMu;
struct {
    uint64_t gd = 0; // GameData::id()
    std::shared_ptr<const xo::SoundBanks> banks;
} g_sound;

std::shared_ptr<const xo::SoundBanks> soundsOf(const xo::GameData &gd) {
    std::lock_guard lk(g_soundMu);
    if (g_sound.gd != gd.id() || !g_sound.banks) {
        auto b = std::make_shared<xo::SoundBanks>();
        std::string err;
        b->open(gd.dataDir() / L"sound", &err); // (none: an empty list, the view plays nothing)
        g_sound.gd = gd.id();
        g_sound.banks = b;
    }
    return g_sound.banks;
}

// Every effect sample that plays, one per line: name, seconds, channels, and where it loops while
// held (start and end in seconds; none when it has no loop points) (tab-separated).
Response serveSoundList(const xo::GameData &gd) {
    const auto banks = soundsOf(gd);
    Response r;
    r.contentType = "text/plain; charset=utf-8";
    std::string s;
    s.reserve(banks->samples().size() * 40);
    char num[48];
    for (const auto &x : banks->samples()) {
        if (!xo::SoundBanks::playable(x) || banks->find(x.name) != &x)
            continue;
        const double rate = x.rate ? x.rate : 1;
        s += x.name;
        snprintf(num, sizeof num, "\t%.3f\t%u", x.frames / rate, x.channels);
        s += num;
        if (x.loopEnd > x.loopStart) {
            snprintf(num, sizeof num, "\t%.4f\t%.4f", x.loopStart / rate, (x.loopEnd + 1) / rate);
            s += num;
        }
        s += '\n';
    }
    r.body.assign(s.begin(), s.end());
    return r;
}

// One of them as an Ogg Vorbis file: ?name=
Response serveSound(const xo::GameData &gd, const std::map<std::string, std::string> &q) {
    const auto banks = soundsOf(gd);
    const xo::SoundSample *x = banks->find(q.count("name") ? q.at("name") : "");
    if (!x)
        return errorResponse(404, "no such sound");
    Response r;
    r.contentType = "audio/ogg";
    std::string err;
    if (!banks->readOgg(*x, r.body, &err))
        return errorResponse(500, err);
    return r;
}

// The bytes of a base64 data: URL (a screenshot, a recorded clip: tens of MB, room made up front; the
// accumulator keeps its low 24 bits, all the next byte needs). false when it is not one.
bool decodeDataUrl(const std::string &url, std::vector<uint8_t> &out) {
    const size_t comma = url.find(',');
    if (comma == std::string::npos)
        return false;
    out.clear();
    out.reserve((url.size() - comma) / 4 * 3 + 3);
    uint32_t val = 0;
    int bits = -8;
    for (size_t i = comma + 1; i < url.size(); ++i) {
        const char c = url[i];
        const int d = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1;
        if (d < 0)
            continue;
        val = ((val << 6) | static_cast<uint32_t>(d)) & 0xFFFFFFu;
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<uint8_t>((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return true;
}

Response serveData(const std::wstring &uri) {
    std::string route;
    const auto q = parseQuery(uri, route);
    static const xo::GameData kNoGame;
    const auto gd = currentGame(); // this request keeps its snapshot even if a reload swaps it
    const bool open = gd && gd->isOpen();
    const bool imageOnly = (route == "/png" || route == "/rgba") && q.count("image"); // imported images need no game
    if (!open && !imageOnly)
        return errorResponse(503, "game data not loaded");
    const xo::GameData &game = open ? *gd : kNoGame;
    try {
        if (route == "/files")
            return serveFileList(game);
        if (route == "/sounds")
            return serveSoundList(game);
        if (route == "/sound")
            return serveSound(game, q);
        if (route == "/model")
            return serveModel(game, q);
        if (route == "/modelgeo")
            return serveModelGeo(game, q);
        if (route == "/geo")
            return serveGeometry(game, q);
        if (route == "/tex")
            return serveTextureRaw(game, q);
        if (route == "/anim")
            return serveAnim(game, q);
        if (route == "/png")
            return serveDecoded(game, q, true);
        if (route == "/rgba")
            return serveDecoded(game, q, false);
        if (route == "/frames")
            return serveFrames(game, q);
        if (route == "/raw") {
            Response r;
            std::string err;
            if (!game.read(q.count("path") ? q.at("path") : "", r.body, &err))
                return errorResponse(404, err);
            return r;
        }
        if (route == "/maps")
            return serveMapList(game);
        if (route == "/mapscene")
            return serveMapScene(game, q);
        if (route.rfind("/map", 0) == 0 && route != "/maps" && mapLeft(q)) // (see g_mapWanted)
            return errorResponse(410, "another map was opened");
        if (route == "/mapterrain")
            return serveMapTerrain(game, q);
        if (route == "/mapterrainlight")
            return serveMapTerrainLight(game, q);
        if (route == "/mapground")
            return serveMapGround(game, q);
        if (route == "/mapsplat")
            return serveMapSplat(game, q);
        if (route == "/mapenv")
            return serveMapEnv(game, q);
        if (route == "/mapprobe")
            return serveMapProbe(game, q);
        if (route == "/mapobject")
            return serveMapObject(game, q);
        if (route == "/atmosphere")
            return serveAtmosphere(game, q);
        if (route == "/backdrop")
            return serveBackdrop(game, q);
        if (route == "/mapgrass")
            return serveMapGrass(game, q);
        if (route == "/mapdecals")
            return serveMapDecals(game, q);
    } catch (const std::exception &e) {
        return errorResponse(500, e.what());
    }
    return errorResponse(404, "unknown route " + route);
}

// ---------------------------------------------------------------------------------------------
// WebView2

ComPtr<ICoreWebView2Environment> g_env;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;

struct Pending {
    ComPtr<ICoreWebView2WebResourceRequestedEventArgs> args;
    ComPtr<ICoreWebView2Deferral> deferral;
};
std::map<uint64_t, Pending> g_pending;
uint64_t g_nextToken = 1;

void completeRequest(uint64_t token, Response r) {
    auto it = g_pending.find(token);
    if (it == g_pending.end())
        return;
    Pending p = it->second;
    g_pending.erase(it);
    if (!g_env)
        return;
    ComPtr<IStream> stream;
    stream.Attach(SHCreateMemStream(r.body.empty() ? nullptr : r.body.data(), static_cast<UINT>(r.body.size())));
    std::wstring headers = L"Content-Type: " + toWide(r.contentType) + L"\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *";
    ComPtr<ICoreWebView2WebResourceResponse> resp;
    if (SUCCEEDED(g_env->CreateWebResourceResponse(stream.Get(), r.status, r.status == 200 ? L"OK" : L"Error", headers.c_str(), &resp)))
        p.args->put_Response(resp.Get());
    p.deferral->Complete();
}

void postJson(const ujson::Value &v) {
    if (g_webview)
        g_webview->PostWebMessageAsJson(toWide(v.dump()).c_str());
}

void reply(double id, bool ok, ujson::Value result, const std::string &error = {}) {
    ujson::Value m = ujson::Value::object();
    m.set("id", id);
    m.set("ok", ok);
    if (ok)
        m.set("result", std::move(result));
    else
        m.set("error", error);
    postJson(m);
}

// Runs a command's work on the pool. Whatever happens there (an exception, running out of
// memory, the app closing) the page gets an answer, so no button stays stuck on "Exporting…".
// busy: counts as running work when the window is closed (exports and extracts).
void runTask(double id, bool busy, std::function<void()> fn) {
    if (busy)
        ++g_busyTasks;
    g_taskPool->submit([id, busy, fn = std::move(fn)] {
        std::string error;
        try {
            fn();
        } catch (const std::bad_alloc &) {
            error = "out of memory (try fewer parts, a lower LOD or no textures)";
        } catch (const std::exception &e) {
            error = e.what();
        } catch (...) {
            error = "internal error";
        }
        if (busy)
            --g_busyTasks;
        if (!error.empty())
            postToUi([id, error] { reply(id, false, {}, error); });
    });
}

struct Cancelled : std::runtime_error {
    Cancelled() : std::runtime_error("cancelled: the app is closing") {}
};

// Progress events for one command; also where a running export notices the app is closing.
xo::Progress progressFor(double id) {
    return [id](double f, const std::string &stage) {
        if (g_quitting)
            throw Cancelled();
        postToUi([id, f, stage] {
            ujson::Value e = ujson::Value::object();
            e.set("event", "progress");
            e.set("id", id);
            e.set("fraction", f);
            e.set("stage", stage);
            postJson(e);
        });
    };
}

// Game paths come from the archive index; never let one climb out of the chosen folder.
bool safeRelativePath(const std::string &p) {
    if (p.empty() || p[0] == '/' || p[0] == '\\' || p.find(':') != std::string::npos)
        return false;
    size_t start = 0;
    while (start <= p.size()) {
        size_t end = p.find_first_of("/\\", start);
        if (end == std::string::npos)
            end = p.size();
        if (p.compare(start, end - start, "..") == 0)
            return false;
        start = end + 1;
    }
    return true;
}

// ---- dialogs (UI thread) ----
bool pickFolder(const std::wstring &title, const fs::path &start, fs::path &out) {
    ComPtr<IFileOpenDialog> dlg;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg))))
        return false;
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    dlg->SetTitle(title.c_str());
    if (!start.empty()) {
        ComPtr<IShellItem> item;
        if (SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&item))))
            dlg->SetFolder(item.Get());
    }
    if (dlg->Show(g_hwnd) != S_OK)
        return false;
    ComPtr<IShellItem> res;
    PWSTR p = nullptr;
    if (FAILED(dlg->GetResult(&res)) || FAILED(res->GetDisplayName(SIGDN_FILESYSPATH, &p)))
        return false;
    out = p;
    CoTaskMemFree(p);
    return true;
}

bool pickFile(bool save, const std::wstring &title, const std::vector<std::pair<std::wstring, std::wstring>> &filters,
              const fs::path &startDir, const std::wstring &defaultName, fs::path &out) {
    ComPtr<IFileDialog> dlg;
    if (FAILED(CoCreateInstance(save ? CLSID_FileSaveDialog : CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg))))
        return false;
    std::vector<COMDLG_FILTERSPEC> specs;
    for (const auto &f : filters)
        specs.push_back({f.first.c_str(), f.second.c_str()});
    if (!specs.empty())
        dlg->SetFileTypes(static_cast<UINT>(specs.size()), specs.data());
    dlg->SetTitle(title.c_str());
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | (save ? FOS_OVERWRITEPROMPT : FOS_FILEMUSTEXIST));
    if (!defaultName.empty())
        dlg->SetFileName(defaultName.c_str());
    if (!filters.empty()) {
        std::wstring ext = filters[0].second;
        const size_t dot = ext.find(L'.');
        if (dot != std::wstring::npos)
            dlg->SetDefaultExtension(ext.substr(dot + 1, ext.find(L';') == std::wstring::npos ? std::wstring::npos : ext.find(L';') - dot - 1).c_str());
    }
    std::error_code ec;
    if (!startDir.empty() && fs::is_directory(startDir, ec)) {
        ComPtr<IShellItem> item;
        if (SUCCEEDED(SHCreateItemFromParsingName(startDir.c_str(), nullptr, IID_PPV_ARGS(&item))))
            dlg->SetFolder(item.Get());
    }
    if (dlg->Show(g_hwnd) != S_OK)
        return false;
    ComPtr<IShellItem> res;
    PWSTR p = nullptr;
    if (FAILED(dlg->GetResult(&res)) || FAILED(res->GetDisplayName(SIGDN_FILESYSPATH, &p)))
        return false;
    out = p;
    CoTaskMemFree(p);
    return true;
}

fs::path defaultExportDir() {
    const std::string saved = settingStr("exportDir");
    if (!saved.empty())
        return pathFromUtf8(saved);
    PWSTR docs = nullptr;
    fs::path d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Documents, 0, nullptr, &docs)))
        d = fs::path(docs) / L"Grimcold";
    CoTaskMemFree(docs);
    return d;
}

// Test mode lets the e2e tests skip the dialogs by passing a path.
bool testPath(const ujson::Value &args, const char *key, fs::path &out) {
    if (!g_opt.test() || !args[key].isString() || args[key].str().empty())
        return false;
    out = pathFromUtf8(args[key].str());
    return true;
}

// The game folder is only ever read: no export, extract or save may write into it (loose files
// there could be picked up by the game or trip the launcher's file check). Returns why `out` is
// refused, or "" when it is fine. Links and ".." are resolved first; case doesn't matter.
std::string refuseGameFolder(const fs::path &out) {
    auto norm = [](const fs::path &p) {
        std::error_code ec;
        fs::path c = fs::weakly_canonical(fs::absolute(p, ec), ec);
        if (ec)
            c = p.lexically_normal();
        std::wstring s = c.make_preferred().wstring();
        while (s.size() > 3 && s.back() == L'\\')
            s.pop_back();
        return s;
    };
    auto within = [](const std::wstring &child, const std::wstring &dir) {
        const size_t n = dir.size();
        return n && child.size() >= n &&
               CompareStringOrdinal(child.c_str(), static_cast<int>(n), dir.c_str(), static_cast<int>(n), TRUE) == CSTR_EQUAL &&
               (child.size() == n || child[n] == L'\\' || dir.back() == L'\\');
    };
    const std::wstring o = norm(out);
    for (const fs::path &root : {currentGameRoot(), pathFromUtf8(settingStr("gameDir"))}) {
        if (root.empty())
            continue;
        // (a game folder at the top of a drive guards only its data and bin folders, not the whole drive)
        const bool driveRoot = root.has_root_path() && root.relative_path().empty();
        for (const fs::path &d : driveRoot ? std::vector<fs::path>{root / L"data", root / L"bin"} : std::vector<fs::path>{root})
            if (within(o, norm(d)))
                return "That is inside the Crossout game folder (" + pathUtf8(root) +
                       "), which is only ever read. Please choose another folder.";
    }
    return {};
}

// A save dialog's suggested file name: the part's or build's own name with Unicode kept, minus
// what Windows doesn't allow in a file name.
std::wstring dialogName(std::string_view utf8, const wchar_t *fallback) {
    std::wstring o;
    for (wchar_t c : toWide(utf8))
        o += c < 32 || wcschr(L"<>:\"/\\|?*", c) ? L'_' : c;
    while (!o.empty() && (o.back() == L'.' || o.back() == L' '))
        o.pop_back();
    while (!o.empty() && o.front() == L' ')
        o.erase(0, 1);
    if (o.size() > 150) {
        o.resize(150);
        if (o.back() >= 0xD800 && o.back() <= 0xDBFF) // (not half of a character made of two, like an emoji)
            o.pop_back();
    }
    if (o.empty())
        o = fallback;
    // CON, PRN, AUX, NUL, COM1-9, LPT1-9 (with or without an extension) are devices, not files
    std::wstring stem = o.substr(0, o.find(L'.'));
    CharUpperBuffW(stem.data(), static_cast<DWORD>(stem.size()));
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
        (stem.size() == 4 && (stem.rfind(L"COM", 0) == 0 || stem.rfind(L"LPT", 0) == 0) && stem[3] >= L'1' && stem[3] <= L'9'))
        o = L"_" + o;
    return o;
}

// A pose from the page (the viewer's or the builder's): per model node its local translation,
// rotation quaternion x y z w and scale, 10 numbers. Anything else gives no pose (the bind pose).
std::vector<std::array<float, 10>> parsePose(const ujson::Value &v) {
    std::vector<std::array<float, 10>> out;
    for (const auto &bone : v.items()) {
        const auto &n = bone.items();
        if (n.size() != 10)
            return {};
        std::array<float, 10> a{};
        for (int i = 0; i < 10; ++i)
            a[i] = static_cast<float>(n[i].num(std::numeric_limits<double>::quiet_NaN()));
        out.push_back(a);
    }
    return out;
}

xo::ColorAdjust parseAdjust(const ujson::Value &a) {
    xo::ColorAdjust c;
    c.hue = static_cast<float>(a["hue"].num(0));
    c.saturation = static_cast<float>(a["saturation"].num(1));
    c.brightness = static_cast<float>(a["brightness"].num(0));
    c.contrast = static_cast<float>(a["contrast"].num(1));
    c.tintAmount = static_cast<float>(a["tintAmount"].num(0));
    c.paintAmount = static_cast<float>(a["paintAmount"].num(0));
    for (int i = 0; i < 3; ++i) {
        c.tint[i] = static_cast<float>(a["tint"].items().size() > static_cast<size_t>(i) ? a["tint"].items()[i].num(1) : 1);
        c.paint[i] = static_cast<float>(a["paint"].items().size() > static_cast<size_t>(i) ? a["paint"].items()[i].num(1) : 1);
    }
    return c;
}

// A paint as the page sends it (ui/paints.js normPaint): { kind, color, amount, tex, normal, scale, finish }.
xo::Paint parsePaint(const ujson::Value &v) {
    xo::Paint p;
    const std::string kind = v["kind"].str("color");
    p.tex = v["tex"].str();
    p.normal = v["normal"].str();
    p.kind = p.tex.empty() ? xo::Paint::Kind::Color : kind == "pattern" ? xo::Paint::Kind::Pattern : kind == "chameleon" ? xo::Paint::Kind::Chameleon : xo::Paint::Kind::Color;
    p.amount = static_cast<float>(std::clamp(v["amount"].num(0), 0.0, 1.0));
    const auto &c = v["color"].items();
    for (int i = 0; i < 3; ++i)
        p.color[i] = static_cast<float>(std::clamp(c.size() > static_cast<size_t>(i) ? c[i].num(1) : 1.0, 0.0, 1.0));
    p.scale = static_cast<float>(std::clamp(v["scale"].num(1), 1.0 / 16, 16.0));
    const std::string finish = v["finish"].str();
    p.finish = finish == "metallic" ? xo::Paint::Finish::Metallic : finish == "chrome" ? xo::Paint::Finish::Chrome : xo::Paint::Finish::None;
    return p;
}

void revealInExplorer(const fs::path &p) {
    std::wstring args = L"/select,\"" + p.wstring() + L"\"";
    ShellExecuteW(g_hwnd, L"open", L"explorer.exe", args.c_str(), nullptr, SW_SHOWNORMAL);
}

// ---- commands ----
// The game is indexed on a worker while the window and WebView2 start, so "init" may have to
// wait for it (UI thread only).
bool g_startupScan = false;
std::vector<double> g_initWaiting;

void replyInit(double id) {
    ujson::Value r = ujson::Value::object();
    r.set("version", kVersion);
    r.set("zstd", xo::zstdVersion());
    r.set("test", g_opt.test());
    r.set("game", gameStatus());
    r.set("crashes", rep::crashes()); // (Bug report: crashes since the last start, for its dialog)
    r.set("reports", rep::canSend());
    {
        std::lock_guard lk(g_settingsMu);
        r.set("settings", g_settings);
    }
    reply(id, true, std::move(r));
}

// The builder's autosave. Its first write in a session keeps the last session's build beside it
// (autosave.previous.xobuild), in case the first thing done was to replace it by mistake.
// A file as read against the MD5 the game's index lists for it (an all-zero MD5, or a pack whose
// index lists XXH3-128s instead, as Crossout 2.41's do: none to check).
bool md5Matches(const xo::GameData &gd, const std::string &path, const std::vector<uint8_t> &data, std::string *err) {
    const xo::Entry *e = gd.find(path);
    if (!e || (e->pack < gd.packs().size() && !gd.packs()[e->pack].md5Sums) ||
        std::all_of(std::begin(e->md5), std::end(e->md5), [](uint8_t b) { return b == 0; }))
        return true;
    uint8_t sum[16];
    if (!xo::md5Of(data.data(), data.size(), sum) || std::memcmp(sum, e->md5, 16) == 0)
        return true;
    if (err)
        *err = path + ": its bytes do not match the game's checksum (the game updated? reload the game folder)";
    return false;
}

bool writeAutosave(const std::string &text, std::string *err) {
    const fs::path p = g_dataDir / L"autosave.xobuild";
    static bool keptPrevious = false;
    if (!keptPrevious) {
        // the build the last session left is kept as autosave.previous.xobuild; until that copy is made
        // (another program may hold the file a moment), it is not written over: the next autosave tries again
        if (!CopyFileW(p.c_str(), (g_dataDir / L"autosave.previous.xobuild").c_str(), FALSE)) {
            const DWORD code = GetLastError();
            if (code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND) {
                if (err)
                    *err = "the last saved build could not be kept aside (Windows error " + std::to_string(code) + "); it is not written over yet";
                return false;
            }
        }
        keptPrevious = true;
    }
    return xo::writeFileBytes(p, text.data(), text.size(), err);
}

void handleCommand(double id, const std::string &cmd, const ujson::Value &args) {
    if (cmd == "init") {
        { // a page starting over (the first one, or after a crash the host reloaded it) holds no imported
          // images: the old page's would stay in memory until the app quit (up to 1 GB each)
            std::lock_guard lk(g_imgMu);
            g_images.clear();
        }
        if (g_startupScan) { // the archives are still being indexed: answer when that is done
            g_initWaiting.push_back(id);
            return;
        }
        replyInit(id);
        return;
    }
    if (cmd == "pickGameDir" || cmd == "reload") { // indexing runs on a worker; the window stays responsive
        fs::path dir = currentGameRoot();
        if (cmd == "reload") {
            if (dir.empty())
                dir = pathFromUtf8(settingStr("gameDir"));
        } else if (!testPath(args, "dir", dir)) {
            if (!pickFolder(L"Choose the Crossout folder (the one that contains \"data\")", currentGameRoot(), dir)) {
                reply(id, true, ujson::Value());
                return;
            }
        }
        const bool remember = cmd == "pickGameDir";
        runTask(id, false, [id, dir, remember] {
            const bool ok = openGame(dir);
            postToUi([id, ok, remember] {
                if (ok && remember)
                    setSetting("gameDir", pathUtf8(currentGameRoot()));
                ujson::Value s = gameStatus();
                s.set("changed", ok); // false: nothing was replaced, "error" says why
                reply(id, true, std::move(s));
            });
        });
        return;
    }
    // ---- Bug report (ui/support.js; report.h) ----
    if (cmd == "diagnostics") { // the machine's details, the game's, the log's last lines, crashes waiting
        ujson::Value d = rep::system(g_hwnd, g_env.Get());
        const ujson::Value g = gameStatus();
        ujson::Value game = ujson::Value::object();
        game.set("found", g["ok"].boolean(false));
        game.set("version", g["gameVersion"].str());
        game.set("files", g["files"].num(0));
        d.set("game", std::move(game));
        d.set("log", rep::logTail(std::clamp(static_cast<int>(args["lines"].num(200)), 0, 1000)));
        d.set("crashes", rep::crashes());
        reply(id, true, std::move(d));
        return;
    }
    if (cmd == "log") { // the page's errors and notes, into the app's log
        for (const auto &l : args["lines"].items())
            rep::log("page", l.str());
        reply(id, true, ujson::Value(true));
        return;
    }
    if (cmd == "report") { // one report to the report server (only with a DSN in this build)
        ujson::Value ev = args["event"];
        const std::string crash = args["crash"].str();
        const bool withLog = args["log"].boolean(true);
        runTask(id, false, [id, ev = std::move(ev), crash, withLog] {
            ujson::Value r = rep::send(ev, crash, withLog);
            postToUi([id, r = std::move(r)]() mutable { reply(id, true, std::move(r)); });
        });
        return;
    }
    if (cmd == "dropCrash") {
        reply(id, true, ujson::Value(rep::dropCrash(args["id"].str())));
        return;
    }
    if (cmd == "openLogs") {
        if (!g_opt.test()) // (tests never open windows)
            ShellExecuteW(g_hwnd, L"open", rep::logDir().c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        reply(id, true, ujson::Value(pathUtf8(rep::logDir())));
        return;
    }
    if (cmd == "testReport" && g_opt.test()) { // tests: a local report server, a crash record, a real crash
        if (args.has("dsn"))
            rep::testDsn(args["dsn"].str());
        const std::string crash = args["crash"].str();
        if (crash == "record")
            rep::testCrashRecord();
        reply(id, true, ujson::Value(true));
        if (!crash.empty() && crash != "record") // (native, stack, cpp, abort, invalid, purecall: after the reply)
            postToUi([crash] { rep::testCrashNow(crash); });
        return;
    }
    if (cmd == "setSettings") {
        {
            std::lock_guard lk(g_settingsMu);
            for (const auto &m : args.members())
                g_settings.set(m.first, m.second);
        }
        saveSettings();
        reply(id, true, ujson::Value(true));
        return;
    }
    if (cmd == "reveal") {
        const std::string p = args["path"].str();
        if (p.find('"') == std::string::npos) // (a quote would end explorer's argument early)
            revealInExplorer(pathFromUtf8(p));
        reply(id, true, ujson::Value(true));
        return;
    }
    if (cmd == "importImage") {
        fs::path file;
        if (!testPath(args, "file", file) &&
            !pickFile(false, toWide(args["title"].str("Choose a replacement image")),
                      {{L"Images", L"*.png;*.jpg;*.jpeg;*.bmp;*.tif;*.tiff;*.tga;*.dds;*.webp;*.gif"}, {L"All files", L"*.*"}},
                      pathFromUtf8(settingStr("importDir")), L"", file)) {
            reply(id, true, ujson::Value());
            return;
        }
        runTask(id, false, [id, file] { // a big image takes a moment to decode: not on the window's thread
            xo::ImageRGBA img;
            std::string err;
            if (!xo::readImageFile(file, img.rgba, img.w, img.h, &err)) {
                postToUi([id, file, err] { reply(id, false, {}, pathUtf8(file.filename()) + ": " + err); });
                return;
            }
            const double w = img.w, h = img.h;
            const std::string imageId = storeImage(std::move(img));
            postToUi([id, file, w, h, imageId] {
                setSetting("importDir", pathUtf8(file.parent_path()));
                ujson::Value r = ujson::Value::object();
                r.set("w", w);
                r.set("h", h);
                r.set("file", pathUtf8(file));
                r.set("name", pathUtf8(file.filename()));
                r.set("id", imageId);
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "releaseImage") { // the page stopped using an imported image
        {
            std::lock_guard lk(g_imgMu);
            g_images.erase(args["id"].str());
        }
        reply(id, true, ujson::Value(true));
        return;
    }
    if (cmd == "exportTexture") {
        const auto gd = currentGame();
        if (!gd || !gd->isOpen()) {
            reply(id, false, {}, "game data not loaded");
            return;
        }
        const std::string base = args["base"].str();
        const std::string as = args["as"].str("png");
        const std::string view = args["view"].str("rgb");
        const std::string leaf = base.substr(base.rfind('/') + 1);
        fs::path out;
        if (!testPath(args, "outPath", out)) {
            const bool dds = as == "dds";
            std::wstring name = dialogName(leaf + (view == "normal" ? "_rgbnormal" : view == "rgb" || view == "opaque" ? "" : "_" + view), L"texture");
            if (!pickFile(true, L"Save texture", {{dds ? L"DDS texture" : L"PNG image", dds ? L"*.dds" : L"*.png"}}, defaultExportDir(),
                          name + (dds ? L".dds" : L".png"), out)) {
                reply(id, true, ujson::Value());
                return;
            }
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        const std::string imageId = args["image"].str(), maskImageId = args["maskImage"].str();
        const auto image = imageId.empty() ? nullptr : findImage(imageId), maskImage = maskImageId.empty() ? nullptr : findImage(maskImageId);
        if ((!imageId.empty() && !image) || (!maskImageId.empty() && !maskImage)) {
            reply(id, false, {}, "the replacement image is no longer loaded: replace the texture again, then save");
            return;
        }
        runTask(id, true, [id, gd, base, as, view, out, adjust = args["adjust"], image, mask = args["mask"].str(), maskImage] {
            auto checkQuit = [] {
                if (g_quitting)
                    throw Cancelled();
            };
            std::string err;
            bool ok = false;
            std::string warning; // (H9: the full size is missing from the game files: a smaller one is saved, and said so)
            auto smaller = [&](const xo::Texture &t) {
                const int lv = t.firstLevel();
                if (lv > 0 && lv < static_cast<int>(t.info.levels.size()))
                    warning = "the game files lack its full size: saved a smaller one (" + std::to_string(t.info.levels[lv].width) + " x " +
                              std::to_string(t.info.levels[lv].height) + ")";
            };
            if (as == "dds") {
                xo::Texture t;
                std::vector<uint8_t> dds;
                ok = xo::loadTexture(*gd, base, t, &err) && xo::makeDds(t, dds, &err);
                if (ok)
                    smaller(t);
                checkQuit();
                ok = ok && xo::writeFileBytes(out, dds.data(), dds.size(), &err);
            } else {
                std::vector<uint8_t> rgba;
                uint32_t w = 0, h = 0;
                xo::PixelFormat fmt = xo::PixelFormat::RGBA8;
                if (image) {
                    rgba = image->rgba;
                    w = image->w;
                    h = image->h;
                    ok = true;
                } else {
                    xo::Texture t;
                    ok = xo::loadTexture(*gd, base, t, &err) && xo::decodeLevel(t, t.firstLevel(), rgba, w, h, &err);
                    fmt = t.info.format;
                    if (ok)
                        smaller(t);
                }
                checkQuit();
                if (ok) {
                    if (adjust.isObject()) { // colours as in the viewer, paint only where the part's paint mask says
                        std::vector<uint8_t> maskPx;
                        uint32_t mw = 0, mh = 0;
                        if (maskImage) {
                            maskPx = maskImage->rgba;
                            mw = maskImage->w;
                            mh = maskImage->h;
                        } else if (!mask.empty()) {
                            xo::Texture mt;
                            std::string merr;
                            if (!xo::loadTexture(*gd, mask, mt, &merr) || !xo::decodeLevel(mt, mt.firstLevel(), maskPx, mw, mh, &merr))
                                maskPx.clear();
                        }
                        xo::applyColorAdjust(rgba, w, h, parseAdjust(adjust), maskPx.empty() ? nullptr : &maskPx, mw, mh);
                    }
                    applyView(rgba, view, fmt);
                    checkQuit();
                    ok = xo::writePng(out, rgba.data(), w, h, &err);
                }
            }
            postToUi([id, ok, err, out, warning] {
                if (!ok) {
                    reply(id, false, {}, err);
                    return;
                }
                setSetting("exportDir", pathUtf8(out.parent_path()));
                ujson::Value r = ujson::Value::object();
                r.set("path", pathUtf8(out));
                if (!warning.empty())
                    r.set("warning", warning);
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "export") {
        const auto gd = currentGame();
        if (!gd || !gd->isOpen()) {
            reply(id, false, {}, "game data not loaded");
            return;
        }
        const std::string path = args["path"].str();
        xo::ExportOptions opt;
        const std::string format = args["format"].str("glb");
        opt.format = format == "gltf" ? xo::ExportOptions::Format::GLTF : format == "obj" ? xo::ExportOptions::Format::OBJ
                                                                                             : xo::ExportOptions::Format::GLB;
        opt.lod = static_cast<int>(args["lod"].num(0));
        opt.skin = args["skin"].str();
        opt.textures = args["textures"].boolean(true);
        opt.ddsCopies = args["dds"].boolean(false);
        opt.extraMaps = args["extraMaps"].boolean(false);
        opt.occlusion = args["ao"].boolean(false);
        opt.splitMaterials = args["split"].boolean(true);
        opt.slots = args["slots"].boolean(false);
        opt.vertexColors = args["vertexColors"].boolean(false);
        opt.tangents = args["tangents"].boolean(true);
        opt.animations = args["animations"].boolean(false);
        opt.heat = static_cast<float>(std::clamp(args["heat"].num(0), 0.0, 1.0));
        opt.maxTextureSize = std::clamp(static_cast<int>(args["maxTex"].num(0)), 0, 16384);
        opt.name = args["name"].str();
        opt.gameVersion = gameVersion(currentGameRoot());
        opt.pose = parsePose(args["pose"]);
        for (const auto &a : args["attachments"].items()) { // (what the viewer shows on the part's nodes)
            xo::Attachment at;
            at.path = a["path"].str();
            at.node = static_cast<int>(a["node"].num(-1));
            at.pose = parsePose(a["pose"]);
            if (!at.path.empty() && at.node >= 0 && opt.attachments.size() < 256)
                opt.attachments.push_back(std::move(at));
        }
        for (const auto &m : args["adjust"].members())
            opt.adjust[m.first] = parseAdjust(m.second);
        if (args["paint"].isObject()) { // (the 3D Viewer's paint on the part)
            opt.paint = parsePaint(args["paint"]);
            opt.hasPaint = true;
        }
        for (const auto &m : args["replace"].members())
            if (auto img = findImage(m.second.str()))
                opt.replace[m.first] = img;
            else { // (it went before the export started: the game's own texture is used, and said so)
                reply(id, false, {}, "a replaced texture's image is no longer loaded (" + m.first + "): replace it again, then export");
                return;
            }
        const std::string stem = path.substr(path.rfind('/') + 1, path.size() - path.rfind('/') - 5);
        fs::path out;
        if (!testPath(args, "outPath", out)) {
            const std::wstring ext = format == "gltf" ? L".gltf" : format == "obj" ? L".obj" : L".glb";
            const std::wstring label = format == "gltf" ? L"glTF (separate files)" : format == "obj" ? L"Wavefront OBJ" : L"glTF binary";
            std::wstring name = dialogName(stem + (opt.skin.empty() || opt.skin == "default" ? "" : "_" + opt.skin), L"model");
            if (!pickFile(true, L"Export model", {{label, L"*" + ext}}, defaultExportDir(), name + ext, out)) {
                reply(id, true, ujson::Value());
                return;
            }
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        runTask(id, true, [id, gd, path, opt, out] {
            std::vector<fs::path> written;
            std::vector<std::string> warnings;
            std::string err;
            const bool ok = xo::exportModel(*gd, path, out, opt, written, warnings, &err, progressFor(id));
            postToUi([id, ok, err, written, warnings, out] {
                if (!ok) {
                    reply(id, false, {}, err);
                    return;
                }
                setSetting("exportDir", pathUtf8(out.parent_path()));
                ujson::Value r = ujson::Value::object();
                ujson::Value files = ujson::Value::array(), warn = ujson::Value::array();
                for (const auto &f : written)
                    files.push(pathUtf8(f));
                for (const auto &w : warnings)
                    warn.push(w);
                r.set("files", std::move(files));
                r.set("warnings", std::move(warn));
                r.set("path", pathUtf8(out));
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "exportMap") { // a whole map -> one file (terrain + ground colour, props, trees, objects, water)
        const auto gd = currentGame();
        if (!gd || !gd->isOpen()) {
            reply(id, false, {}, "game data not loaded");
            return;
        }
        const std::string name = args["name"].str();
        xo::MapFilter filter;
        filter.festival = args["festival"].str("Empty");
        filter.gameplay = args["gameplay"].str("auto");
        filter.environment = args["environment"].str(""); // (the weather the view shows; "" = the map's own)
        filter.props = args["props"].boolean(true);
        filter.entities = args["objects"].boolean(true);
        filter.trees = args["trees"].boolean(true);
        filter.water = args["water"].boolean(true);
        filter.decals = args["decals"].boolean(true);
        xo::ExportOptions opt;
        const std::string format = args["format"].str("glb");
        opt.format = format == "gltf" ? xo::ExportOptions::Format::GLTF : format == "obj" ? xo::ExportOptions::Format::OBJ
                                                                                             : xo::ExportOptions::Format::GLB;
        opt.lod = static_cast<int>(args["lod"].num(0));
        opt.textures = args["textures"].boolean(true);
        opt.maxTextureSize = static_cast<int>(args["maxTex"].num(1024));
        opt.occlusion = args["ao"].boolean(false);
        opt.slots = false;
        opt.tangents = true;
        opt.gameVersion = gameVersion(currentGameRoot());
        xo::MapExportOptions mo;
        mo.groundTexture = args["terrain"].boolean(true) ? static_cast<int>(args["ground"].num(4096)) : 0;
        mo.treeLod = static_cast<int>(args["treeLod"].num(-1));
        mo.decals = filter.decals;
        mo.grass = args["grass"].boolean(false) ? static_cast<float>(std::clamp(args["grassAmount"].num(0.25), 0.0, 1.0)) : 0.0f;
        mo.sun = args["sun"].boolean(true);
        mo.sky = args["sky"].boolean(true) ? static_cast<int>(std::clamp(args["skySize"].num(2048), 256.0, 8192.0)) : 0;
        mo.clouds = args["clouds"].boolean(true);
        mo.probeSky = args["probeSky"].boolean(true);
        const bool withTerrain = args["terrain"].boolean(true);
        // objects hidden in the view (ids as /mapscene numbers them: every kind loaded, so the map is
        // read whole and the kinds the export leaves out are dropped afterwards)
        std::set<uint32_t> exclude; // (object ids, as /mapscene gives them)
        for (const auto &x : args["exclude"].items())
            if (x.isNumber() && x.num() >= 0 && x.num() <= 4294967295.0)
                exclude.insert(static_cast<uint32_t>(x.num()));
        const bool wantProps = filter.props, wantObjects = filter.entities, wantTrees = filter.trees;
        if (!exclude.empty())
            filter.props = filter.entities = filter.trees = true;
        fs::path out;
        if (!testPath(args, "outPath", out)) {
            const std::wstring ext = format == "gltf" ? L".gltf" : format == "obj" ? L".obj" : L".glb";
            const std::wstring label = format == "gltf" ? L"glTF (separate files)" : format == "obj" ? L"Wavefront OBJ" : L"glTF binary";
            if (!pickFile(true, L"Export map", {{label, L"*" + ext}}, defaultExportDir(), dialogName(name, L"map") + ext, out)) {
                reply(id, true, ujson::Value());
                return;
            }
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        runTask(id, true, [id, gd, name, filter, opt, mo, withTerrain, out, exclude, wantProps, wantObjects, wantTrees] {
            std::vector<fs::path> written;
            std::vector<std::string> warnings;
            std::string err;
            xo::MapScene s;
            bool ok = xo::loadMap(*gd, name, filter, s, &err);
            if (ok && !exclude.empty()) {
                std::vector<xo::MapObject> kept;
                kept.reserve(s.objects.size());
                for (size_t i = 0; i < s.objects.size(); ++i) {
                    const xo::MapObject &o = s.objects[i];
                    // (the kinds as loadMap's filter takes them: props.mxml needs Props, trees Trees, the other entities Objects)
                    const bool kind = (o.def.empty() ? wantProps : true) && (o.group == "trees" ? wantTrees : o.def.empty() || wantObjects);
                    if (kind && !exclude.count(o.uid))
                        kept.push_back(std::move(s.objects[i]));
                }
                s.objects = std::move(kept);
            }
            if (ok && !withTerrain)
                s.hasTerrain = false;
            if (ok) {
                warnings = s.warnings;
                ok = xo::exportMap(*gd, s, out, opt, mo, written, warnings, &err, progressFor(id));
            }
            size_t unresolved = 0;
            for (const auto &[d, c] : s.unresolved)
                unresolved += c;
            postToUi([id, ok, err, written, warnings, out, unresolved] {
                if (!ok) {
                    reply(id, false, {}, err);
                    return;
                }
                setSetting("exportDir", pathUtf8(out.parent_path()));
                ujson::Value r = ujson::Value::object(), files = ujson::Value::array(), warn = ujson::Value::array();
                for (const auto &f : written)
                    files.push(pathUtf8(f));
                for (const auto &w : warnings)
                    warn.push(w);
                r.set("files", std::move(files));
                r.set("warnings", std::move(warn));
                r.set("path", pathUtf8(out));
                r.set("unresolved", static_cast<double>(unresolved));
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "exportMapObjects") { // objects picked on a map -> one file, as they stand to each other
        const auto gd = currentGame();
        if (!gd || !gd->isOpen()) {
            reply(id, false, {}, "game data not loaded");
            return;
        }
        const std::string name = args["name"].str();
        std::map<std::string, std::string> q{{"name", name}, {"festival", args["festival"].str("Empty")}, {"gameplay", args["gameplay"].str("auto")}};
        if (const std::string env = args["environment"].str(""); !env.empty())
            q.emplace("environment", env);
        std::vector<uint32_t> ids; // (object ids, as /mapscene gives them)
        for (const auto &x : args["ids"].items())
            if (x.isNumber() && x.num() >= 0 && x.num() <= 4294967295.0)
                ids.push_back(static_cast<uint32_t>(x.num()));
        if (ids.empty()) {
            reply(id, false, {}, "nothing selected");
            return;
        }
        xo::ExportOptions opt;
        const std::string format = args["format"].str("glb");
        opt.format = format == "gltf" ? xo::ExportOptions::Format::GLTF : format == "obj" ? xo::ExportOptions::Format::OBJ
                                                                                             : xo::ExportOptions::Format::GLB;
        opt.lod = static_cast<int>(args["lod"].num(0));
        opt.textures = args["textures"].boolean(true);
        opt.maxTextureSize = static_cast<int>(args["maxTex"].num(2048));
        opt.occlusion = args["ao"].boolean(false);
        opt.slots = false;
        opt.tangents = true;
        opt.gameVersion = gameVersion(currentGameRoot());
        const bool keepPosition = args["keepPosition"].boolean(false);
        fs::path out;
        if (!testPath(args, "outPath", out)) {
            const std::wstring ext = format == "gltf" ? L".gltf" : format == "obj" ? L".obj" : L".glb";
            const std::wstring label = format == "gltf" ? L"glTF (separate files)" : format == "obj" ? L"Wavefront OBJ" : L"glTF binary";
            if (!pickFile(true, L"Export selected objects", {{label, L"*" + ext}}, defaultExportDir(), dialogName(args["fileName"].str(name + "_selection"), L"selection") + ext,
                          out)) {
                reply(id, true, ujson::Value());
                return;
            }
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        runTask(id, true, [id, gd, name, q, ids, opt, keepPosition, out] {
            std::vector<fs::path> written;
            std::vector<std::string> warnings;
            std::string err;
            bool ok = false;
            const auto s = mapFor(*gd, q, &err); // (the map as the view has it: the same object ids)
            if (s) {
                std::vector<xo::SceneItem> items;
                std::unordered_map<uint32_t, size_t> byId;
                for (size_t i = 0; i < s->objects.size(); ++i)
                    byId.emplace(s->objects[i].uid, i);
                for (uint32_t uid : ids) {
                    const auto at = byId.find(uid);
                    if (at == byId.end())
                        continue;
                    const xo::MapObject &o = s->objects[at->second];
                    xo::SceneItem it;
                    it.path = o.model;
                    it.skin = o.skin;
                    it.name = o.name.find('/') != std::string::npos ? o.name.substr(o.name.rfind('/') + 1) : o.name;
                    it.group = ids.size() > 1 ? o.group : std::string();
                    xo::mapObjectMatrix(o, it.matrix);
                    items.push_back(std::move(it));
                }
                if (items.empty()) {
                    err = "the selected objects are not on this map";
                } else {
                    if (!keepPosition) { // the group's middle at the origin, standing on it (each keeps its turn)
                        double cx = 0, cz = 0, y = 1e30;
                        for (const auto &it : items) {
                            cx += it.matrix[12] / items.size();
                            cz += it.matrix[14] / items.size();
                            y = std::min(y, static_cast<double>(it.matrix[13]));
                        }
                        for (auto &it : items) {
                            it.matrix[12] -= static_cast<float>(cx);
                            it.matrix[13] -= static_cast<float>(y);
                            it.matrix[14] -= static_cast<float>(cz);
                        }
                    }
                    ok = xo::exportScene(*gd, items, std::vector<xo::CustomMesh>{}, name + " (selected objects)", out, opt, written, warnings, &err, progressFor(id));
                }
            }
            postToUi([id, ok, err, written, warnings, out] {
                if (!ok) {
                    reply(id, false, {}, err);
                    return;
                }
                setSetting("exportDir", pathUtf8(out.parent_path()));
                ujson::Value r = ujson::Value::object(), files = ujson::Value::array(), warn = ujson::Value::array();
                for (const auto &f : written)
                    files.push(pathUtf8(f));
                for (const auto &w : warnings)
                    warn.push(w);
                r.set("files", std::move(files));
                r.set("warnings", std::move(warn));
                r.set("path", pathUtf8(out));
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "exportBuild") { // several placed parts -> one file
        const auto gd = currentGame();
        if (!gd || !gd->isOpen()) {
            reply(id, false, {}, "game data not loaded");
            return;
        }
        std::vector<xo::SceneItem> items;
        for (const auto &p : args["parts"].items()) {
            xo::SceneItem it;
            it.path = p["path"].str();
            it.skin = p["skin"].str();
            it.name = p["name"].str();
            const auto &m = p["matrix"].items();
            if (m.size() == 16)
                for (int i = 0; i < 16; ++i)
                    it.matrix[i] = static_cast<float>(m[i].num(i % 5 == 0 ? 1 : 0));
            it.pose = parsePose(p["pose"]); // (as the builder shows the part)
            if (p["paint"].isObject()) { // (the paint it shows: its own, else the vehicle's)
                it.paint = parsePaint(p["paint"]);
                it.hasPaint = true;
            }
            if (!it.path.empty())
                items.push_back(std::move(it));
        }
        if (items.empty()) {
            reply(id, false, {}, "the build is empty");
            return;
        }
        xo::ExportOptions opt;
        const std::string format = args["format"].str("glb");
        opt.format = format == "gltf" ? xo::ExportOptions::Format::GLTF : format == "obj" ? xo::ExportOptions::Format::OBJ
                                                                                             : xo::ExportOptions::Format::GLB;
        opt.lod = static_cast<int>(args["lod"].num(0));
        opt.textures = args["textures"].boolean(true);
        opt.ddsCopies = args["dds"].boolean(false);
        opt.extraMaps = args["extraMaps"].boolean(false);
        opt.occlusion = args["ao"].boolean(false);
        opt.splitMaterials = args["split"].boolean(true);
        opt.slots = false;
        opt.vertexColors = args["vertexColors"].boolean(false);
        opt.tangents = true;
        opt.heat = static_cast<float>(std::clamp(args["heat"].num(0), 0.0, 1.0));
        opt.maxTextureSize = std::clamp(static_cast<int>(args["maxTex"].num(0)), 0, 16384);
        opt.gameVersion = gameVersion(currentGameRoot());
        for (const auto &m : args["adjust"].members())
            opt.adjust[m.first] = parseAdjust(m.second);
        for (const auto &m : args["replace"].members())
            if (auto img = findImage(m.second.str()))
                opt.replace[m.first] = img;
            else {
                reply(id, false, {}, "a replaced texture's image is no longer loaded (" + m.first + "): replace it again, then export");
                return;
            }
        const std::string buildName = args["name"].str("build");
        fs::path out;
        if (!testPath(args, "outPath", out)) {
            const std::wstring ext = format == "gltf" ? L".gltf" : format == "obj" ? L".obj" : L".glb";
            const std::wstring label = format == "gltf" ? L"glTF (separate files)" : format == "obj" ? L"Wavefront OBJ" : L"glTF binary";
            if (!pickFile(true, L"Export build", {{label, L"*" + ext}}, defaultExportDir(), dialogName(buildName, L"build") + ext, out)) {
                reply(id, true, ujson::Value());
                return;
            }
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        runTask(id, true, [id, gd, items, buildName, opt, out] {
            std::vector<fs::path> written;
            std::vector<std::string> warnings;
            std::string err;
            const bool ok = xo::exportScene(*gd, items, buildName, out, opt, written, warnings, &err, progressFor(id));
            postToUi([id, ok, err, written, warnings, out] {
                if (!ok) {
                    reply(id, false, {}, err);
                    return;
                }
                setSetting("exportDir", pathUtf8(out.parent_path()));
                ujson::Value r = ujson::Value::object(), files = ujson::Value::array(), warn = ujson::Value::array();
                for (const auto &f : written)
                    files.push(pathUtf8(f));
                for (const auto &w : warnings)
                    warn.push(w);
                r.set("files", std::move(files));
                r.set("warnings", std::move(warn));
                r.set("path", pathUtf8(out));
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "extract") {
        const auto gd = currentGame();
        if (!gd || !gd->isOpen()) {
            reply(id, false, {}, "game data not loaded");
            return;
        }
        fs::path dir;
        if (!testPath(args, "dir", dir) && !pickFolder(L"Extract the selected files to...", defaultExportDir(), dir)) {
            reply(id, true, ujson::Value());
            return;
        }
        if (const std::string why = refuseGameFolder(dir); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        std::vector<std::string> paths;
        for (const auto &p : args["paths"].items())
            paths.push_back(p.str());
        runTask(id, true, [id, gd, paths, dir] {
            size_t ok = 0;
            std::vector<std::string> errors;
            std::vector<uint8_t> buf;
            for (size_t k = 0; k < paths.size(); ++k) {
                const std::string &p = paths[k];
                if (g_quitting)
                    throw Cancelled();
                std::string err;
                if (!safeRelativePath(p))
                    errors.push_back(p + ": not a plain game path, skipped");
                else if (gd->read(p, buf, &err) && md5Matches(*gd, p, buf, &err) && xo::writeFileBytes(dir / pathFromUtf8(p), buf.data(), buf.size(), &err))
                    ++ok;
                else
                    errors.push_back(err);
                if (paths.size() > 20 && k % 16 == 15)
                    progressFor(id)(static_cast<double>(k + 1) / paths.size(), "Extracting " + std::to_string(k + 1) + "/" + std::to_string(paths.size()));
            }
            postToUi([id, ok, errors, dir] {
                ujson::Value r = ujson::Value::object(), e = ujson::Value::array();
                r.set("written", static_cast<double>(ok));
                r.set("dir", pathUtf8(dir));
                for (const auto &x : errors)
                    e.push(x);
                r.set("errors", std::move(e));
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "saveText") { // looks (*.xolook) and other small text files
        fs::path out;
        const std::string ext = args["ext"].str("xolook");
        // "path": save again where this file was saved or opened from, without asking (the builder's
        // Save); only a file of this kind, in a folder that is still there
        bool again = false;
        if (const std::string p = args["path"].str(); !p.empty()) {
            const fs::path f = pathFromUtf8(p);
            std::wstring e = f.extension().wstring();
            for (auto &c : e)
                if (c >= L'A' && c <= L'Z')
                    c = static_cast<wchar_t>(c - L'A' + L'a');
            std::error_code ec;
            if (f.is_absolute() && e == L"." + toWide(ext) && fs::is_directory(f.parent_path(), ec)) {
                out = f;
                again = true;
            }
        }
        if (!again && !testPath(args, "outPath", out) &&
            !pickFile(true, toWide(args["title"].str("Save")), {{toWide(args["label"].str("Grimcold look")), L"*." + toWide(ext)}},
                      defaultExportDir(), dialogName(args["name"].str("look"), L"look") + L"." + toWide(ext), out)) {
            reply(id, true, ujson::Value());
            return;
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        const std::string text = args["text"].str();
        std::string err;
        if (!xo::writeFileBytes(out, text.data(), text.size(), &err)) {
            reply(id, false, {}, err);
            return;
        }
        ujson::Value r = ujson::Value::object();
        r.set("path", pathUtf8(out));
        reply(id, true, std::move(r));
        return;
    }
    if (cmd == "openText") {
        fs::path in;
        const std::string ext = args["ext"].str("xolook");
        if (!testPath(args, "file", in) &&
            !pickFile(false, toWide(args["title"].str("Open")), {{toWide(args["label"].str("Grimcold look")), L"*." + toWide(ext)}},
                      defaultExportDir(), L"", in)) {
            reply(id, true, ujson::Value());
            return;
        }
        HANDLE h = CreateFileW(in.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            reply(id, false, {}, "cannot open " + pathUtf8(in));
            return;
        }
        LARGE_INTEGER sz{};
        GetFileSizeEx(h, &sz);
        std::string text(static_cast<size_t>(std::min<LONGLONG>(sz.QuadPart, 64ll << 20)), '\0');
        DWORD got = 0;
        ReadFile(h, text.data(), static_cast<DWORD>(text.size()), &got, nullptr);
        CloseHandle(h);
        text.resize(got);
        ujson::Value r = ujson::Value::object();
        r.set("path", pathUtf8(in));
        r.set("text", text);
        reply(id, true, std::move(r));
        return;
    }
    if (cmd == "autosave") { // the vehicle builder keeps its current build in the data dir
        std::string err;
        const bool ok = writeAutosave(args["text"].str(), &err);
        reply(id, ok, ujson::Value(ok), err);
        return;
    }
    if (cmd == "autoload") {
        const fs::path p = g_dataDir / L"autosave.xobuild";
        HANDLE h = INVALID_HANDLE_VALUE;
        DWORD code = 0;
        for (int attempt = 0; attempt < 10; ++attempt) { // (a sync tool or a virus scanner may hold it a moment)
            h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
            code = h == INVALID_HANDLE_VALUE ? GetLastError() : 0;
            if (h != INVALID_HANDLE_VALUE || (code != ERROR_SHARING_VIOLATION && code != ERROR_LOCK_VIOLATION))
                break;
            Sleep(100);
        }
        if (h == INVALID_HANDLE_VALUE) {
            if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND)
                reply(id, true, ujson::Value()); // no saved build
            else // (an error, not "none": the page must not save over a build it could not read)
                reply(id, false, {}, "the saved build could not be read (Windows error " + std::to_string(code) + ")");
            return;
        }
        LARGE_INTEGER sz{};
        GetFileSizeEx(h, &sz);
        std::string text(static_cast<size_t>(std::min<LONGLONG>(sz.QuadPart, 64ll << 20)), '\0');
        DWORD got = 0;
        const BOOL read = ReadFile(h, text.data(), static_cast<DWORD>(text.size()), &got, nullptr);
        code = read ? 0 : GetLastError();
        CloseHandle(h);
        if (!read) {
            reply(id, false, {}, "the saved build could not be read (Windows error " + std::to_string(code) + ")");
            return;
        }
        text.resize(got);
        ujson::Value r = ujson::Value::object();
        r.set("text", text);
        reply(id, true, std::move(r));
        return;
    }
    if (cmd == "loadImagePath") { // re-import an image a saved look points at
        const fs::path file = pathFromUtf8(args["file"].str());
        const std::wstring fw = file.wstring();
        const bool network = fw.size() >= 2 && (fw[0] == L'\\' || fw[0] == L'/') && (fw[1] == L'\\' || fw[1] == L'/');
        if (network || !file.is_absolute()) { // (a shared look or build file must not make Windows connect to a server and offer the user's sign-in)
            reply(id, false, {}, network ? "a network path is not opened from a look or build file: " + pathUtf8(file) : "not a full path: " + pathUtf8(file));
            return;
        }
        runTask(id, false, [id, file] {
            xo::ImageRGBA img;
            std::string err;
            if (!xo::readImageFile(file, img.rgba, img.w, img.h, &err)) {
                postToUi([id, err] { reply(id, false, {}, err); });
                return;
            }
            const double w = img.w, h = img.h;
            const std::string imageId = storeImage(std::move(img));
            postToUi([id, w, h, imageId] {
                ujson::Value r = ujson::Value::object();
                r.set("w", w);
                r.set("h", h);
                r.set("id", imageId);
                reply(id, true, std::move(r));
            });
        });
        return;
    }
    if (cmd == "saveScreenshot") {
        std::vector<uint8_t> png;
        if (!decodeDataUrl(args["dataUrl"].str(), png)) {
            reply(id, false, {}, "bad image data");
            return;
        }
        fs::path out;
        if (!testPath(args, "outPath", out) &&
            !pickFile(true, L"Save screenshot", {{L"PNG image", L"*.png"}}, defaultExportDir(), dialogName(args["name"].str("screenshot"), L"screenshot") + L".png", out)) {
            reply(id, true, ujson::Value());
            return;
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        std::string err;
        if (!xo::writeFileBytes(out, png.data(), png.size(), &err)) {
            reply(id, false, {}, err);
            return;
        }
        ujson::Value r = ujson::Value::object();
        r.set("path", pathUtf8(out));
        reply(id, true, std::move(r));
        return;
    }
    if (cmd == "saveVideo") { // a recorded clip of the view (ui/recorder.js): mp4 or webm
        std::vector<uint8_t> bytes;
        if (!decodeDataUrl(args["dataUrl"].str(), bytes) || bytes.empty()) {
            reply(id, false, {}, "bad video data");
            return;
        }
        const bool mp4 = args["ext"].str("mp4") == "mp4";
        fs::path out;
        if (!testPath(args, "outPath", out) &&
            !pickFile(true, L"Save recording", {mp4 ? std::pair<std::wstring, std::wstring>{L"MP4 video", L"*.mp4"} : std::pair<std::wstring, std::wstring>{L"WebM video", L"*.webm"}},
                      defaultExportDir(), dialogName(args["name"].str("recording"), L"recording") + (mp4 ? L".mp4" : L".webm"), out)) {
            reply(id, true, ujson::Value());
            return;
        }
        if (const std::string why = refuseGameFolder(out); !why.empty()) {
            reply(id, false, {}, why);
            return;
        }
        std::string err;
        if (!xo::writeFileBytes(out, bytes.data(), bytes.size(), &err)) {
            reply(id, false, {}, err);
            return;
        }
        ujson::Value r = ujson::Value::object();
        r.set("path", pathUtf8(out));
        r.set("bytes", static_cast<double>(bytes.size()));
        reply(id, true, std::move(r));
        return;
    }
    if (cmd == "window") { // the title bar's buttons (the page draws them): minimize, maximize / restore, close
        const std::string op = args["op"].str();
        if (op == "min")
            ShowWindow(g_hwnd, SW_MINIMIZE);
        else if (op == "max")
            ShowWindow(g_hwnd, IsZoomed(g_hwnd) ? SW_RESTORE : SW_MAXIMIZE);
        else if (op == "close")
            PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
        ujson::Value r = ujson::Value::object();
        r.set("maximized", IsZoomed(g_hwnd) != FALSE);
        reply(id, true, std::move(r));
        return;
    }
    if (cmd == "quit" && g_opt.test()) { // tests: close the window the way the user would
        reply(id, true, ujson::Value(true));
        PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
        return;
    }
    reply(id, false, {}, "unknown command: " + cmd);
}

void onWebMessage(const std::string &text) {
    ujson::Value msg;
    try {
        msg = ujson::Value::parse(text);
    } catch (...) {
        return;
    }
    const double id = msg["id"].num(0);
    try {
        handleCommand(id, msg["cmd"].str(), msg["args"]);
    } catch (const std::exception &e) {
        reply(id, false, {}, e.what());
    }
}

void resizeWebView() {
    if (!g_controller)
        return;
    RECT rc;
    GetClientRect(g_hwnd, &rc);
    g_controller->put_Bounds(rc);
}

void initWebView();
void restartWebView();

HRESULT onControllerCreated(HRESULT result, ICoreWebView2Controller *controller) {
    if (FAILED(result) || !controller) {
        MessageBoxW(g_hwnd, L"WebView2 could not start.", kAppTitle, MB_OK | MB_ICONERROR);
        PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
        return result;
    }
    g_controller = controller;
    g_controller->get_CoreWebView2(&g_webview);
    ComPtr<ICoreWebView2Controller2> c2;
    if (SUCCEEDED(g_controller.As(&c2))) {
        COREWEBVIEW2_COLOR bg{255, 0x0b, 0x0e, 0x12}; // (the page's backdrop: ui/skin.css --xo-bg)
        c2->put_DefaultBackgroundColor(bg);
    }
    ComPtr<ICoreWebView2Controller4> c4;
    if (SUCCEEDED(g_controller.As(&c4)))
        c4->put_AllowExternalDrop(FALSE); // a file dropped on the window must not replace the app's page
    ComPtr<ICoreWebView2Settings> settings;
    g_webview->get_Settings(&settings);
    settings->put_AreDevToolsEnabled(g_opt.devtools || g_opt.test() ? TRUE : FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(g_opt.devtools ? TRUE : FALSE);
    ComPtr<ICoreWebView2Settings3> s3;
    if (SUCCEEDED(settings.As(&s3)))
        s3->put_AreBrowserAcceleratorKeysEnabled(g_opt.devtools ? TRUE : FALSE);
    ComPtr<ICoreWebView2Settings9> s9; // the page draws the title bar (the game's top bar): its drag areas
    if (SUCCEEDED(settings.As(&s9)))   // move the window, a double click maximizes, a right click: the system menu
        s9->put_IsNonClientRegionSupportEnabled(TRUE);

    ComPtr<ICoreWebView2_3> w3;
    if (SUCCEEDED(g_webview.As(&w3)))
        w3->SetVirtualHostNameToFolderMapping(kUiHost, (g_exeDir / L"ui").c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
    g_webview->AddWebResourceRequestedFilter(L"https://xo.data/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_webview->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>([](ICoreWebView2 *, ICoreWebView2WebResourceRequestedEventArgs *args) -> HRESULT {
            ComPtr<ICoreWebView2WebResourceRequest> req;
            args->get_Request(&req);
            LPWSTR uri = nullptr;
            req->get_Uri(&uri);
            std::wstring u = uri ? uri : L"";
            CoTaskMemFree(uri);
            ComPtr<ICoreWebView2Deferral> deferral;
            args->GetDeferral(&deferral);
            const uint64_t token = g_nextToken++;
            g_pending[token] = {args, deferral};
            g_pool->submit([token, u] {
                Response r;
                try {
                    r = serveData(u);
                } catch (const std::exception &e) {
                    r = errorResponse(500, e.what());
                } catch (...) {
                    r = errorResponse(500, "internal error");
                }
                postToUi([token, r = std::move(r)]() mutable { completeRequest(token, std::move(r)); });
            });
            return S_OK;
        }).Get(),
        nullptr);
    g_webview->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
                                          // Only the app's own page may use the bridge.
                                          LPWSTR src = nullptr, raw = nullptr;
                                          args->get_Source(&src);
                                          const bool ours = src && wcsncmp(src, L"https://xo.app/", 15) == 0;
                                          CoTaskMemFree(src);
                                          if (ours && SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw) {
                                              // Handled from the window's own queue, not inside this event: commands
                                              // can open file dialogs, and a modal loop in here is unsupported.
                                              postToUi([text = toUtf8(raw)] { onWebMessage(text); });
                                          }
                                          CoTaskMemFree(raw);
                                          return S_OK;
                                      }).Get(),
                                      nullptr);
    // The page never leaves https://xo.app/: a web link opens in the real browser, anything else
    // (a file dropped on the window, a stray location change) is cancelled.
    g_webview->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *a) -> HRESULT {
                                          LPWSTR uri = nullptr;
                                          a->get_Uri(&uri);
                                          const std::wstring u = uri ? uri : L"";
                                          CoTaskMemFree(uri);
                                          if (u.rfind(L"https://xo.app/", 0) != 0) {
                                              a->put_Cancel(TRUE);
                                              if (u.rfind(L"https://", 0) == 0)
                                                  ShellExecuteW(nullptr, L"open", u.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                                          }
                                          return S_OK;
                                      }).Get(),
                                      nullptr);
    // A crashed page is loaded again (the build comes back from its autosave); if WebView2 itself
    // died, it is started again.
    g_webview->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>([](ICoreWebView2 *, ICoreWebView2ProcessFailedEventArgs *a) -> HRESULT {
                                     COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
                                     a->get_ProcessFailedKind(&kind);
                                     { // (kept for Bug report: the page's and WebView2's own ends are crashes too)
                                         int exitCode = 0;
                                         std::string why;
                                         ComPtr<ICoreWebView2ProcessFailedEventArgs2> a2;
                                         if (SUCCEEDED(a->QueryInterface(IID_PPV_ARGS(&a2)))) {
                                             a2->get_ExitCode(&exitCode);
                                             COREWEBVIEW2_PROCESS_FAILED_REASON r{};
                                             if (SUCCEEDED(a2->get_Reason(&r))) {
                                                 const char *const names[] = {"unexpected", "unresponsive", "terminated", "crashed", "launch failed", "out of memory", "profile deleted", "normal exit"};
                                                 why = static_cast<size_t>(r) < std::size(names) ? names[r] : "reason " + std::to_string(static_cast<int>(r));
                                             }
                                         }
                                         if (!g_closing) {
                                             if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED)
                                                 rep::processFailed("page", exitCode, why);
                                             else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED)
                                                 rep::processFailed("browser", exitCode, why);
                                             else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED)
                                                 rep::processFailed("gpu", exitCode, why);
                                             else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE)
                                                 rep::log("host", "the page stopped responding");
                                         }
                                     }
                                     if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) {
                                         // (three crashes within a minute: a page that crashes as it loads would reload forever)
                                         static std::deque<ULONGLONG> crashes;
                                         const ULONGLONG now = GetTickCount64();
                                         crashes.push_back(now);
                                         while (!crashes.empty() && now - crashes.front() > 60000)
                                             crashes.pop_front();
                                         if (g_webview && !g_closing && crashes.size() <= 3)
                                             g_webview->Reload();
                                         else if (!g_closing && !g_opt.test())
                                             postToUi([] { MessageBoxW(g_hwnd, L"The page keeps crashing, so it was not loaded again.\n\nPlease restart Grimcold.", kAppTitle, MB_OK | MB_ICONERROR); });
                                     } else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
                                         postToUi(restartWebView);
                                     }
                                     return S_OK;
                                 }).Get(),
                                 nullptr);
    // Links in the page open in the real browser, never inside the app.
    g_webview->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *a) -> HRESULT {
                                          LPWSTR uri = nullptr;
                                          a->get_Uri(&uri);
                                          if (uri && (wcsncmp(uri, L"https://", 8) == 0))
                                              ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
                                          CoTaskMemFree(uri);
                                          a->put_Handled(TRUE);
                                          return S_OK;
                                      }).Get(),
                                      nullptr);
    resizeWebView();
    g_controller->put_IsVisible(TRUE);
    g_webview->Navigate(L"https://xo.app/index.html");
    if (g_opt.devtools)
        g_webview->OpenDevToolsWindow();
    return S_OK;
}

void initWebView() {
    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    fs::path userData = g_dataDir / L"WebView2";
    std::wstring browserArgs = L"--disable-features=CalculateNativeWinOcclusion";
    if (g_opt.test()) {
        browserArgs += L" --mute-audio";
        if (g_opt.debugPort > 0)
            browserArgs += L" --remote-debugging-port=" + std::to_wstring(g_opt.debugPort);
    }
    options->put_AdditionalBrowserArguments(browserArgs.c_str());
    const HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, userData.c_str(), options.Get(),
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT result, ICoreWebView2Environment *env) -> HRESULT {
            if (FAILED(result) || !env) {
                MessageBoxW(g_hwnd,
                            L"The Microsoft Edge WebView2 Runtime could not be started.\n\nInstall it from "
                            L"https://developer.microsoft.com/microsoft-edge/webview2/ and try again.",
                            kAppTitle, MB_OK | MB_ICONERROR);
                PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
                return result;
            }
            g_env = env;
            return env->CreateCoreWebView2Controller(g_hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(onControllerCreated).Get());
        }).Get());
    if (FAILED(hr)) {
        MessageBoxW(g_hwnd,
                    L"The Microsoft Edge WebView2 Runtime is not installed.\n\nInstall it from "
                    L"https://developer.microsoft.com/microsoft-edge/webview2/ and try again.",
                    kAppTitle, MB_OK | MB_ICONERROR);
        PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
    }
}

// WebView2's browser process died: let go of everything that belonged to it and start a new one.
// After three restarts the app gives up and closes.
void restartWebView() {
    static int restarts = 0;
    if (g_closing)
        return;
    g_pending.clear(); // those requests died with it
    if (g_controller)
        g_controller->Close();
    g_controller.Reset();
    g_webview.Reset();
    g_env.Reset();
    if (++restarts > 3) {
        MessageBoxW(g_hwnd, L"WebView2 keeps stopping, so Grimcold has to close.", kAppTitle, MB_OK | MB_ICONERROR);
        PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
        return;
    }
    initWebView();
}

// ---------------------------------------------------------------------------------------------
// Window

void saveWindowPlacement() {
    if (g_opt.test())
        return;
    WINDOWPLACEMENT wp{sizeof(wp)};
    if (!GetWindowPlacement(g_hwnd, &wp))
        return;
    ujson::Value w = ujson::Value::object();
    w.set("x", static_cast<double>(wp.rcNormalPosition.left));
    w.set("y", static_cast<double>(wp.rcNormalPosition.top));
    w.set("w", static_cast<double>(wp.rcNormalPosition.right - wp.rcNormalPosition.left));
    w.set("h", static_cast<double>(wp.rcNormalPosition.bottom - wp.rcNormalPosition.top));
    w.set("maximized", wp.showCmd == SW_SHOWMAXIMIZED);
    setSetting("window", std::move(w));
}

// Closing: the builder autosaves 0.6 s after the last edit, so the page is asked for anything
// newer first (window.__xoFlush returns the build file, or null while nothing needs saving).
// A page that doesn't answer within 1.5 s is not waited for.
constexpr UINT_PTR kCloseTimer = 1;

void finishClose() {
    static bool done = false;
    if (done)
        return;
    done = true;
    KillTimer(g_hwnd, kCloseTimer);
    saveWindowPlacement();
    DestroyWindow(g_hwnd);
}

void flushThenClose() {
    const HRESULT hr = g_webview ? g_webview->ExecuteScript(
                                       L"window.__xoFlush ? window.__xoFlush() : null",
                                       Callback<ICoreWebView2ExecuteScriptCompletedHandler>([](HRESULT res, LPCWSTR json) -> HRESULT {
                                           try {
                                               const ujson::Value v = SUCCEEDED(res) && json ? ujson::Value::parse(toUtf8(json)) : ujson::Value();
                                               if (v.isString() && !v.str().empty()) {
                                                   std::string err;
                                                   writeAutosave(v.str(), &err);
                                               }
                                           } catch (...) {
                                           }
                                           finishClose();
                                           return S_OK;
                                       }).Get())
                                 : E_FAIL;
    if (SUCCEEDED(hr))
        SetTimer(g_hwnd, kCloseTimer, 1500, nullptr);
    else
        finishClose();
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_NCCALCSIZE:
        if (wp) {
            auto *p = reinterpret_cast<NCCALCSIZE_PARAMS *>(lp);
            const LONG top = p->rgrc[0].top;
            const LRESULT r = DefWindowProcW(hwnd, msg, wp, lp);
            if (IsZoomed(hwnd)) {
                const UINT dpi = GetDpiForWindow(hwnd);
                p->rgrc[0].top = top + GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
            } else {
                p->rgrc[0].top = top;
            }
            return r;
        }
        return DefWindowProcW(hwnd, msg, wp, lp);
    case WM_SIZE: {
        resizeWebView();
        static int lastZoomed = -1; // (the page shows maximize or restore on its button)
        const int zoomed = wp == SIZE_MAXIMIZED ? 1 : wp == SIZE_RESTORED ? 0 : lastZoomed;
        if (zoomed != lastZoomed && wp != SIZE_MINIMIZED) {
            lastZoomed = zoomed;
            ujson::Value m = ujson::Value::object();
            m.set("event", "window");
            m.set("maximized", zoomed == 1);
            postJson(m);
        }
        return 0;
    }
    case WM_APP_RUN: {
        std::unique_ptr<std::function<void()>> fn(reinterpret_cast<std::function<void()> *>(lp));
        try { // nothing may escape into the window procedure
            (*fn)();
        } catch (...) {
        }
        return 0;
    }
    case WM_GETMINMAXINFO: {
        auto *mm = reinterpret_cast<MINMAXINFO *>(lp);
        const UINT dpi = GetDpiForWindow(hwnd);
        mm->ptMinTrackSize.x = MulDiv(900, dpi, 96);
        mm->ptMinTrackSize.y = MulDiv(560, dpi, 96);
        return 0;
    }
    case WM_DPICHANGED: {
        const RECT *r = reinterpret_cast<const RECT *>(lp);
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    case WM_CLOSE:
        if (g_closing) // already on the way out
            return 0;
        if (g_busyTasks > 0 && !g_opt.test() &&
            MessageBoxW(hwnd, L"An export is still running.\n\nQuit anyway? The export will be cancelled.", kAppTitle,
                        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) != IDYES)
            return 0;
        g_closing = true;
        flushThenClose();
        return 0;
    case WM_TIMER:
        if (wp == kCloseTimer) {
            finishClose();
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wp, lp);
    case WM_DESTROY:
        if (g_controller)
            g_controller->Close();
        g_controller.Reset();
        g_webview.Reset();
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

void parseArgs() {
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; ++i) {
        const std::wstring a = argv[i];
        auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
        if (a == L"--data-dir")
            g_opt.dataDir = next();
        else if (a == L"--game-dir")
            g_opt.gameDir = next();
        else if (a == L"--debug-port")
            g_opt.debugPort = _wtoi(next().c_str());
        else if (a == L"--headless")
            g_opt.headless = true;
        else if (a == L"--devtools")
            g_opt.devtools = true;
        else if (a == L"--pos")
            swscanf_s(next().c_str(), L"%d,%d", &g_opt.x, &g_opt.y);
        else if (a == L"--size")
            swscanf_s(next().c_str(), L"%d,%d", &g_opt.w, &g_opt.h);
    }
    LocalFree(argv);
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int show) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    parseArgs();
    wchar_t exe[MAX_PATH * 2];
    GetModuleFileNameW(nullptr, exe, static_cast<DWORD>(std::size(exe)));
    g_exeDir = fs::path(exe).parent_path();
    std::error_code ec;
    if (!g_opt.dataDir.empty()) {
        g_dataDir = g_opt.dataDir;
    } else {
        fs::path base = localAppData();
        if (base.empty())
            base = fs::temp_directory_path(ec);
        g_dataDir = base / L"Grimcold";
    }
    fs::create_directories(g_dataDir, ec);
    // One window per data folder: a second start (one click too many) brings the first window up
    // instead of running beside it on the same autosave and settings (whichever closed last won).
    // The first one's window handle is in a small named block of shared memory beside the mutex.
    HANDLE singleMutex = nullptr, singleMap = nullptr;
    HWND *singleWnd = nullptr;
    {
        std::wstring key = g_dataDir.lexically_normal().wstring();
        for (auto &c : key)
            c = static_cast<wchar_t>(std::towlower(c));
        uint64_t hsh = 1469598103934665603ull;
        for (wchar_t c : key)
            hsh = (hsh ^ static_cast<uint64_t>(c)) * 1099511628211ull;
        wchar_t name[64];
        std::swprintf(name, 64, L"Local\\Grimcold-%016llx", static_cast<unsigned long long>(hsh));
        singleMutex = CreateMutexW(nullptr, FALSE, name);
        const bool second = singleMutex && GetLastError() == ERROR_ALREADY_EXISTS;
        wcscat_s(name, L"-wnd");
        singleMap = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(HWND), name);
        if (singleMap)
            singleWnd = static_cast<HWND *>(MapViewOfFile(singleMap, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(HWND)));
        if (second) {
            HWND other = singleWnd ? *singleWnd : nullptr;
            if (other && IsWindow(other)) {
                if (IsIconic(other))
                    ShowWindow(other, SW_RESTORE);
                SetForegroundWindow(other);
            }
            return 0;
        }
    }
    loadSettings();
    rep::init(g_dataDir, kVersion); // (the log, and crashes kept for Bug report from here on)
    rep::log("host", std::string("Grimcold ") + kVersion + " started" + (g_opt.test() ? " (test)" : ""));

    std::string zerr;
    if (!xo::zstdLoad(&zerr)) {
        MessageBoxW(nullptr, (L"libzstd.dll is missing next to Grimcold.exe.\n\n" + toWide(zerr)).c_str(), kAppTitle, MB_OK | MB_ICONERROR);
        return 1;
    }
    std::optional<Pool> pool, tasks; // (ended explicitly at the end, before the close watchdog stands down)
    pool.emplace(3); // (more serve a map no faster: 3 to 16 threads all opened sinto in 7.0-7.6 s, 2026-10-10)
    tasks.emplace(2);
    g_pool = &*pool;
    g_taskPool = &*tasks;

    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = wndProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = CreateSolidBrush(RGB(0x0b, 0x0e, 0x12));
    wc.lpszClassName = kWindowClass;
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    wc.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0));
    RegisterClassExW(&wc);

    HWND owner = nullptr;
    if (g_opt.headless)
        owner = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
    int x = CW_USEDEFAULT, y = CW_USEDEFAULT, w = 1440, h = 900;
    bool maximized = false;
    {
        std::lock_guard lk(g_settingsMu);
        const ujson::Value &wv = g_settings["window"];
        if (wv.isObject() && !g_opt.test()) {
            x = static_cast<int>(wv["x"].num(CW_USEDEFAULT));
            y = static_cast<int>(wv["y"].num(CW_USEDEFAULT));
            w = static_cast<int>(wv["w"].num(1440));
            h = static_cast<int>(wv["h"].num(900));
            maximized = wv["maximized"].boolean(false);
            RECT r{x, y, x + w, y + h};
            if (!MonitorFromRect(&r, MONITOR_DEFAULTTONULL)) {
                x = y = CW_USEDEFAULT;
            }
        }
    }
    if (g_opt.x != INT_MIN) {
        x = g_opt.x;
        y = g_opt.y;
    }
    if (g_opt.w > 0) {
        w = g_opt.w;
        h = g_opt.h;
    }
    g_hwnd = CreateWindowExW(g_opt.headless ? WS_EX_NOACTIVATE : 0, kWindowClass, kAppTitle, WS_OVERLAPPEDWINDOW, x, y, w, h, owner, nullptr, instance, nullptr);
    if (singleWnd && !g_opt.headless) // (a second start brings this window up; a hidden test window stays hidden)
        *singleWnd = g_hwnd;
    if (!g_hwnd)
        return 1;
    const BOOL dark = TRUE;
    DwmSetWindowAttribute(g_hwnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, &dark, sizeof(dark));
    const COLORREF edge = RGB(0x2b, 0x32, 0x3b); // (Windows 11: the window's thin edge in the game's slate)
    DwmSetWindowAttribute(g_hwnd, 34 /*DWMWA_BORDER_COLOR*/, &edge, sizeof(edge));
    SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE); // (no caption: WM_NCCALCSIZE)
    if (g_opt.headless) {
        const BOOL cloak = TRUE;
        DwmSetWindowAttribute(g_hwnd, DWMWA_CLOAK, &cloak, sizeof(cloak));
        ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
    } else {
        ShowWindow(g_hwnd, g_opt.test() ? SW_SHOWNOACTIVATE : (maximized ? SW_SHOWMAXIMIZED : show));
    }
    UpdateWindow(g_hwnd);
    // Index the game archives (about a second) while WebView2 starts instead of before the window.
    g_startupScan = true;
    g_pool->submit([] {
        try {
            openGameAtStartup();
        } catch (...) {
        }
        postToUi([] {
            g_startupScan = false;
            for (double id : g_initWaiting)
                replyInit(id);
            g_initWaiting.clear();
        });
    });
    initWebView();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    // Running exports stop at their next step; one stuck in a long step (a huge PNG) must not keep
    // an invisible process alive, so give the workers a few seconds and then end regardless.
    // Files are written as .part and renamed, so nothing half-written is left under a real name.
    g_quitting = true;
    g_exitEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::thread([] {
        if (WaitForSingleObject(g_exitEvent, 5000) == WAIT_OBJECT_0)
            return; // wWinMain finished normally: the process is ending anyway
        xo::removePartialFiles(); // whatever was still being written goes, not just its name
        TerminateProcess(GetCurrentProcess(), 0);
    }).detach();
    g_env.Reset();
    g_pending.clear();
    g_pool = nullptr;
    g_taskPool = nullptr;
    tasks.reset(); // waits for running work (which stops at its next step: g_quitting)
    pool.reset();
    SetEvent(g_exitEvent);
    CoUninitialize();
    return 0;
}
