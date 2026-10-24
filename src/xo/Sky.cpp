#include "xo/Sky.h"

#include "xo/Archive.h"
#include "xo/Export.h"
#include "xo/Model.h"
#include "xo/Texture.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <thread>

namespace xo {
namespace {

constexpr double kPi = 3.14159265358979323846;

struct D3 {
    double x = 0, y = 0, z = 0;
};
D3 operator+(D3 a, D3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
D3 operator-(D3 a, D3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
D3 operator*(D3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
double dot(D3 a, D3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
D3 cross(D3 a, D3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
double length(D3 a) { return std::sqrt(dot(a, a)); }
D3 normalize(D3 a) {
    const double l = length(a);
    return l > 0 ? a * (1 / l) : a;
}

// parseFloat: the number s starts with, or d
double num(const std::string &s, double d) {
    const char *b = s.c_str();
    char *e = nullptr;
    const double v = std::strtod(b, &e);
    return e != b && std::isfinite(v) ? v : d;
}
// "a b c" -> three numbers, or d
std::array<double, 3> vec3(const std::string &s, std::array<double, 3> d) {
    std::array<double, 3> v{};
    const char *p = s.c_str();
    for (int i = 0; i < 3; ++i) {
        char *e = nullptr;
        v[i] = std::strtod(p, &e);
        if (e == p || !std::isfinite(v[i]))
            return d;
        p = e;
    }
    return v;
}
double srgbToLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }

float halfToFloat(uint16_t h) {
    const uint32_t sign = (h & 0x8000u) << 16;
    uint32_t exp = (h >> 10) & 31, mant = h & 1023, bits;
    if (exp == 0) {
        if (mant == 0) {
            bits = sign;
        } else {
            exp = 127 - 15 + 1;
            while (!(mant & 1024)) {
                mant <<= 1;
                --exp;
            }
            bits = sign | (exp << 23) | ((mant & 1023) << 13);
        }
    } else if (exp == 31) {
        bits = sign | 0x7F800000u | (mant << 13);
    } else {
        bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
    return std::bit_cast<float>(bits);
}

// Linear filtering with clamped edges, as the GPU samples the tables (texel centres at (i + 0.5) / n).
void sample2(const float *t, int w, int h, double u, double v, double o[4]) {
    const double x = u * w - 0.5, y = v * h - 0.5;
    const int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
    const double fx = x - x0, fy = y - y0;
    auto at = [&](int xi, int yi, int c) {
        xi = std::clamp(xi, 0, w - 1);
        yi = std::clamp(yi, 0, h - 1);
        return static_cast<double>(t[(static_cast<size_t>(yi) * w + xi) * 4 + c]);
    };
    for (int c = 0; c < 4; ++c)
        o[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
}
void sample3(const float *t, int w, int h, int d, double u, double v, double s, double o[4]) {
    const double x = u * w - 0.5, y = v * h - 0.5, z = s * d - 0.5;
    const int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y)), z0 = static_cast<int>(std::floor(z));
    const double fx = x - x0, fy = y - y0, fz = z - z0;
    double acc[4]{};
    for (int k = 0; k < 8; ++k) {
        const int xi = std::clamp(x0 + (k & 1), 0, w - 1), yi = std::clamp(y0 + ((k >> 1) & 1), 0, h - 1), zi = std::clamp(z0 + (k >> 2), 0, d - 1);
        const double wgt = (k & 1 ? fx : 1 - fx) * ((k >> 1) & 1 ? fy : 1 - fy) * (k >> 2 ? fz : 1 - fz);
        if (wgt == 0)
            continue;
        const float *p = &t[((static_cast<size_t>(zi) * h + yi) * w + xi) * 4];
        for (int c = 0; c < 4; ++c)
            acc[c] += p[c] * wgt;
    }
    std::memcpy(o, acc, sizeof(acc));
}

// The atmosphere's shader functions (ui/sky.js ATMOSPHERE: Bruneton's reference implementation),
// in double precision.
class AtmosphereModel {
  public:
    double bottom = 6360000, top = 6420000, g = 0.8, muSMin = -0.2, sunRadius = 0.00467;
    std::array<double, 3> solar{1.474, 1.8504, 1.91198}, rayleigh{5.8e-6, 1.35e-5, 3.31e-5}, mie{4e-6, 4e-6, 4e-6};

    bool init(const Atmosphere &a, std::string *err) {
        auto uniform = [&](const char *name) -> std::string {
            for (const auto &[k, v] : a.uniforms)
                if (k == name)
                    return v;
            return {};
        };
        bottom = num(uniform("bottom_radius"), 6360000);
        top = num(uniform("top_radius"), 6420000);
        g = num(uniform("mie_phase_function_g"), 0.8);
        muSMin = num(uniform("mu_s_min"), -0.2);
        sunRadius = num(uniform("sun_angular_radius"), 0.00467);
        solar = vec3(uniform("solar_irradiance"), {1.474, 1.8504, 1.91198});
        rayleigh = vec3(uniform("rayleigh_scattering"), {5.8e-6, 1.35e-5, 3.31e-5});
        mie = vec3(uniform("mie_scattering"), {4e-6, 4e-6, 4e-6});
        if (a.transmittance.size() != 256 * 64 * 16 || a.scattering.size() != 256 * 128 * 32 * 8 || !(top > bottom && bottom > 0)) {
            if (err)
                *err = "unexpected atmosphere tables";
            return false;
        }
        trans_.resize(256 * 64 * 4);
        std::memcpy(trans_.data(), a.transmittance.data(), a.transmittance.size());
        scat_.resize(256 * 128 * 32 * 4);
        const uint16_t *h = reinterpret_cast<const uint16_t *>(a.scattering.data());
        for (size_t i = 0; i < scat_.size(); ++i)
            scat_[i] = halfToFloat(h[i]);
        return true;
    }

    bool hitsGround(double r, double mu) const { return mu < 0 && r * r * (mu * mu - 1) + bottom * bottom >= 0; }

    // what the air lets through from height r along mu to space (the CPU lookup of ui/sky.js)
    void transmittance(double r, double mu, double out[3]) const {
        double uv[2];
        transmittanceUv(r, mu, uv);
        double o[4];
        sample2(trans_.data(), 256, 64, uv[0], uv[1], o);
        for (int c = 0; c < 3; ++c)
            out[c] = o[c];
    }

    // the light the sky sends along -ray towards a camera (scattering only: no ground, no sun disc)
    void skyRadiance(D3 camera, D3 ray, D3 sun, double out[3]) const {
        double r = length(camera), rmu = dot(camera, ray);
        const double dTop = -rmu - std::sqrt(std::max(rmu * rmu - r * r + top * top, 0.0));
        if (dTop > 0) {
            camera = camera + ray * dTop;
            r = top;
            rmu += dTop;
        } else if (r > top) {
            out[0] = out[1] = out[2] = 0;
            return;
        }
        const double mu = rmu / r, muS = dot(camera, sun) / r, nu = dot(ray, sun);
        double uvwz[4];
        scatteringUvwz(r, mu, muS, nu, hitsGround(r, mu), uvwz);
        const double tx = uvwz[0] * 7, x0 = std::floor(tx), f = tx - x0;
        double a[4], b[4], s[4];
        sample3(scat_.data(), 256, 128, 32, (x0 + uvwz[1]) / 8, uvwz[2], uvwz[3], a);
        sample3(scat_.data(), 256, 128, 32, (x0 + 1 + uvwz[1]) / 8, uvwz[2], uvwz[3], b);
        for (int c = 0; c < 4; ++c)
            s[c] = a[c] * (1 - f) + b[c] * f;
        const double pr = 3 / (16 * kPi) * (1 + nu * nu);
        const double k = 3 / (8 * kPi) * (1 - g * g) / (2 + g * g);
        const double pm = k * (1 + nu * nu) / std::pow(1 + g * g - 2 * g * nu, 1.5);
        for (int c = 0; c < 3; ++c) {
            const double m = s[0] > 0 ? s[c] * s[3] / s[0] * (rayleigh[0] / mie[0]) * (mie[c] / rayleigh[c]) : 0;
            out[c] = s[c] * pr + m * pm;
        }
    }

  private:
    std::vector<float> trans_, scat_;

    static double texCoord(double x, double n) { return 0.5 / n + x * (1 - 1 / n); }
    double distTop(double r, double mu) const { return std::max(0.0, -r * mu + std::sqrt(std::max(r * r * (mu * mu - 1) + top * top, 0.0))); }
    void transmittanceUv(double r, double mu, double uv[2]) const {
        const double H = std::sqrt(top * top - bottom * bottom), rho = std::sqrt(std::max(r * r - bottom * bottom, 0.0));
        const double d = distTop(r, mu), dMin = top - r, dMax = rho + H;
        uv[0] = texCoord((d - dMin) / (dMax - dMin), 256);
        uv[1] = texCoord(rho / H, 64);
    }
    void scatteringUvwz(double r, double mu, double muS, double nu, bool ground, double o[4]) const {
        const double H = std::sqrt(top * top - bottom * bottom), rho = std::sqrt(std::max(r * r - bottom * bottom, 0.0));
        const double uR = texCoord(rho / H, 32);
        const double rMu = r * mu, disc = rMu * rMu - r * r + bottom * bottom;
        double uMu;
        if (ground) {
            const double d = -rMu - std::sqrt(std::max(disc, 0.0)), dMin = r - bottom, dMax = rho;
            uMu = 0.5 - 0.5 * texCoord(dMax == dMin ? 0.0 : (d - dMin) / (dMax - dMin), 64);
        } else {
            const double d = -rMu + std::sqrt(std::max(disc + H * H, 0.0)), dMin = top - r, dMax = rho + H;
            uMu = 0.5 + 0.5 * texCoord((d - dMin) / (dMax - dMin), 64);
        }
        const double d = distTop(bottom, muS), dMin = top - bottom, dMax = H;
        const double a = (d - dMin) / (dMax - dMin), A = (distTop(bottom, muSMin) - dMin) / (dMax - dMin);
        const double uMuS = texCoord(std::max(1 - a / A, 0.0) / (1 + a), 32);
        o[0] = (nu + 1) / 2;
        o[1] = uMuS;
        o[2] = uMu;
        o[3] = uR;
    }
};

// Where the sun is (glTF space, towards it): SunDirVert 90 = on the horizon, 180 = overhead;
// SunDirHor the azimuth plus the map item's turn (ui/sky.js sunDirection).
D3 sunDirection(const MapEnvironment &env) {
    const double el = (num(env.value("SunDirVert"), 120) - 90) * kPi / 180;
    const double az = (num(env.value("SunDirHor"), 0) + env.rotation[0]) * kPi / 180;
    return normalize({-std::sin(az) * std::cos(el), std::sin(el), std::cos(az) * std::cos(el)});
}

// pixel centre -> direction (glTF), and back (continuous pixel coordinates)
D3 panoDir(double px, double py, int w, int h) {
    const double phi = (0.5 - (px + 0.5) / w) * 2 * kPi, el = (0.5 - (py + 0.5) / h) * kPi;
    return {std::cos(phi) * std::cos(el), std::sin(el), -std::sin(phi) * std::cos(el)};
}
void panoPixel(D3 d, int w, int h, double &px, double &py) {
    const double phi = std::atan2(-d.z, d.x), el = std::asin(std::clamp(d.y / std::max(length(d), 1e-12), -1.0, 1.0));
    px = (0.5 - phi / (2 * kPi)) * w - 0.5;
    py = (0.5 - el / kPi) * h - 0.5;
}

// A texture with its mips (box filtered), sampled with wrap-around (the view's textures repeat).
struct MipImage {
    std::vector<std::vector<uint8_t>> rgba;
    std::vector<uint32_t> w, h;
    bool ok() const { return !rgba.empty(); }

    void build(std::vector<uint8_t> px, uint32_t pw, uint32_t ph) {
        rgba.clear(), w.clear(), h.clear();
        rgba.push_back(std::move(px)), w.push_back(pw), h.push_back(ph);
        while (w.back() > 1 || h.back() > 1) {
            const uint32_t sw = w.back(), sh = h.back(), nw = std::max(1u, sw / 2), nh = std::max(1u, sh / 2);
            const std::vector<uint8_t> &s = rgba.back();
            std::vector<uint8_t> d(static_cast<size_t>(nw) * nh * 4);
            for (uint32_t y = 0; y < nh; ++y)
                for (uint32_t x = 0; x < nw; ++x)
                    for (int c = 0; c < 4; ++c) {
                        unsigned sum = 0;
                        for (int k = 0; k < 4; ++k) {
                            const uint32_t xi = std::min(sw - 1, x * 2 + (k & 1)), yi = std::min(sh - 1, y * 2 + (k >> 1));
                            sum += s[(static_cast<size_t>(yi) * sw + xi) * 4 + c];
                        }
                        d[(static_cast<size_t>(y) * nw + x) * 4 + c] = static_cast<uint8_t>((sum + 2) / 4);
                    }
            rgba.push_back(std::move(d)), w.push_back(nw), h.push_back(nh);
        }
    }
    void level(size_t l, double u, double v, double o[4]) const {
        const uint32_t W = w[l], H = h[l];
        const double x = u * W - 0.5, y = v * H - 0.5;
        const double fx0 = std::floor(x), fy0 = std::floor(y), fx = x - fx0, fy = y - fy0;
        auto wrap = [](long long i, uint32_t n) { return static_cast<uint32_t>(((i % n) + n) % n); };
        const uint32_t x0 = wrap(static_cast<long long>(fx0), W), x1 = wrap(static_cast<long long>(fx0) + 1, W);
        const uint32_t y0 = wrap(static_cast<long long>(fy0), H), y1 = wrap(static_cast<long long>(fy0) + 1, H);
        const std::vector<uint8_t> &p = rgba[l];
        for (int c = 0; c < 4; ++c) {
            const double a = p[(static_cast<size_t>(y0) * W + x0) * 4 + c], b = p[(static_cast<size_t>(y0) * W + x1) * 4 + c];
            const double cc = p[(static_cast<size_t>(y1) * W + x0) * 4 + c], dd = p[(static_cast<size_t>(y1) * W + x1) * 4 + c];
            o[c] = ((a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy) / 255.0;
        }
    }
    // trilinear: lod = log2(texels per pixel)
    void sample(double u, double v, double lod, double o[4]) const {
        lod = std::clamp(lod, 0.0, static_cast<double>(rgba.size() - 1));
        const size_t l0 = static_cast<size_t>(std::floor(lod)), l1 = std::min(rgba.size() - 1, l0 + 1);
        const double f = lod - l0;
        level(l0, u, v, o);
        if (f > 1e-3 && l1 != l0) {
            double b[4];
            level(l1, u, v, b);
            for (int c = 0; c < 4; ++c)
                o[c] = o[c] * (1 - f) + b[c] * f;
        }
    }
};

bool loadMipImage(const GameData &gd, const std::string &base, uint32_t maxSide, MipImage &out, std::string *err) {
    Texture t;
    if (!loadTexture(gd, base, t, err))
        return false;
    int lv = t.firstLevel();
    while (lv + 1 < static_cast<int>(t.info.levels.size()) && std::max(t.info.levels[lv].width, t.info.levels[lv].height) > maxSide)
        ++lv;
    std::vector<uint8_t> rgba;
    uint32_t w = 0, h = 0;
    if (!decodeLevel(t, lv, rgba, w, h, err))
        return false;
    out.build(std::move(rgba), w, h);
    return true;
}

// ---- how bright a preset is (ui/sky.js presetLevels: the same numbers) ----
// The game's unit of light: an atmosphere's radiance times kLightK per channel (every preset's
// AtmosphereSunIllum is kLightK x its atmosphere's sun through the air). The light probes keep it
// / kProbeUnit; the view works in probe units at the game's exposure.
constexpr double kLightK[3] = {775, 555, 537};
constexpr double kLum[3] = {0.2126, 0.7152, 0.0722};
constexpr double kMeasured[4] = {0.03, 0.12, 0.6, 1.2}; // (the heights the view reads its sky at, radians)
constexpr double kToe = 0.1;                             // (ui/sky.js TOE_K)
constexpr double kCloudSun = 0.1;                        // (ui/sky.js CLOUD_SUN)

// "0xAARRGGBB" -> linear RGB (sRGB in the value)
std::array<double, 3> argbLinear(std::string v) {
    if (v.size() > 2 && v[0] == '0' && (v[1] == 'x' || v[1] == 'X'))
        v = v.substr(2);
    const unsigned long argb = v.empty() ? 0xFFFFFFFFul : std::strtoul(v.c_str(), nullptr, 16);
    return {srgbToLinear(((argb >> 16) & 255) / 255.0), srgbToLinear(((argb >> 8) & 255) / 255.0), srgbToLinear((argb & 255) / 255.0)};
}

struct Levels {
    double eSun = 0;           // game units
    double ev = 0, exposure = 1, sun = 0;
    double key = 0; // the sunlight on the ground: sun x kSunK (ui/sky.js presetLevels key)
};

// mean: the luminance of the preset's scene over every direction, in probe units (its light probe's)
Levels presetLevels(const MapEnvironment &env, double mean) {
    Levels L;
    const auto asi = vec3(env.value("AtmosphereSunIllum"), {-1, -1, -1});
    const bool hasAtm = asi[0] >= 0;
    const double eAtm = hasAtm ? kLum[0] * asi[0] + kLum[1] * asi[1] + kLum[2] * asi[2] : 0;
    L.eSun = std::max(0.0, env.value("UseAtmosphereSunIllum") == "true" && hasAtm ? eAtm : num(env.value("SunIlluminance"), hasAtm ? eAtm : 600));
    L.ev = std::min(num(env.value("MaxEV100"), 30), std::max(num(env.value("MinEV100"), -20), std::log2(std::max(mean * kProbeUnit * 8, 1e-6))));
    L.exposure = kProbeUnit / (1.2 * std::pow(2.0, L.ev - num(env.value("ExposureCompensation"), 0)));
    L.sun = L.eSun / kProbeUnit * L.exposure;
    L.key = L.sun * kSunK;
    return L;
}

// The camera's white balance (ui/sky.js whiteBalance: Unreal's WhiteBalance, its tint across (u, v))
// as a 3 x 3 matrix on linear sRGB, rows first.
void whiteBalance(double temp, double tint, double out[9]) {
    const double T = std::clamp(temp, 1000.0, 25000.0);
    const double u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
    const double v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
    auto xy = [](double uu, double vv, double o[2]) {
        o[0] = 3 * uu / (2 * uu - 8 * vv + 4);
        o[1] = 2 * vv / (2 * uu - 8 * vv + 4);
    };
    double planck[2], iso[2], src[2];
    xy(u, v, planck);
    const double Td = T * 1.4388 / 1.438;
    const double dx = Td <= 7000 ? 0.244063 + (0.09911e3 + (2.9678e6 - 4.607e9 / Td) / Td) / Td : 0.23704 + (0.24748e3 + (1.9018e6 - 2.0064e9 / Td) / Td) / Td;
    src[0] = T < 4000 ? planck[0] : dx;
    src[1] = T < 4000 ? planck[1] : -3 * dx * dx + 2.87 * dx - 0.275;
    const double l = std::hypot(u, v), k = tint * 0.05;
    xy(u - v / l * k, v + u / l * k, iso);
    const double sx = src[0] + iso[0] - planck[0], sy = src[1] + iso[1] - planck[1];
    const double toXYZ[9] = {0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041};
    const double toRGB[9] = {3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252};
    const double cone[9] = {0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296};
    const double coneInv[9] = {0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867};
    auto mul = [](const double a[9], const double b[9], double o[9]) {
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    };
    const double a[3] = {sx / sy, 1, (1 - sx - sy) / sy}, b[3] = {0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329};
    double adapt[9]{};
    for (int r = 0; r < 3; ++r)
        adapt[r * 4] = (cone[r * 3] * b[0] + cone[r * 3 + 1] * b[1] + cone[r * 3 + 2] * b[2]) / (cone[r * 3] * a[0] + cone[r * 3 + 1] * a[1] + cone[r * 3 + 2] * a[2]);
    double t1[9], t2[9], t3[9];
    mul(adapt, cone, t1);
    mul(coneInv, t1, t2);
    mul(t2, toXYZ, t3);
    mul(toRGB, t3, out);
}

// The sky dome model's cards drawn over the panorama (ui/sky.js CLOUD_FRAG): coverage, normal and
// light-scattering maps, lit by the sun and the sky; stars added at night. In model order, each
// blended over what is there, as the view draws them.
void drawClouds(const GameData &gd, const std::string &path, D3 sun, const double sunLight[3], const double skyLight[3], double night, int W, int H,
                std::vector<float> &rgb, std::vector<std::string> &warnings) {
    ModelBundle b;
    std::string e;
    if (!loadBundle(gd, path, "", b, &e)) {
        warnings.push_back("sky clouds: " + e);
        return;
    }
    const double starsLevel = std::max(std::clamp((0.05 - sun.y) / 0.15, 0.0, 1.0), night) * 2; // (below the horizon, or the air's own sun gone)
    struct Tri {
        D3 p[3], n[3], t[3];
        double uv[3][2], sign = 1;
        int x0, x1, y0, y1; // pixels it may cover (x may run past the right edge: it wraps)
        double lod[3];      // per texture (cover, normal, scatter): log2 of texels per pixel
        int part;
    };
    struct Part {
        MipImage cover, normal, scatter;
        bool stars = false, tangents = false;
    };
    std::vector<Part> parts;
    std::vector<Tri> tris;
    for (const auto &me : b.model.meshes) {
        if (me.lod != 0)
            continue;
        const MaterialView *mv = me.material < b.materials.size() ? &b.materials[me.material] : nullptr;
        if (!mv)
            continue;
        auto find = [&](std::string_view param) -> const TextureRef * {
            for (const auto &t : mv->textures)
                if (t.param == param && t.exists)
                    return &t;
            return nullptr;
        };
        const TextureRef *cover = find("DiffuseSampler");
        const bool hasDiffuse = cover != nullptr;
        if (!cover)
            for (const auto &t : mv->textures)
                if (t.role == "albedo" && t.exists) {
                    cover = &t;
                    break;
                }
        if (!cover)
            continue; // (the dome itself: the atmosphere is the sky)
        std::string lowBase = cover->base;
        std::transform(lowBase.begin(), lowBase.end(), lowBase.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        Part part;
        part.stars = !hasDiffuse && lowBase.find("star") != std::string::npos;
        if (part.stars && starsLevel <= 0)
            continue; // (daytime: no stars)
        MeshGeometry g;
        if (!decodeMesh(b.model, me, g, &e) || g.uv0.empty() || g.normal.empty()) {
            if (!e.empty())
                warnings.push_back("sky clouds: " + e);
            continue;
        }
        if (!loadMipImage(gd, cover->base, 1024, part.cover, &e)) {
            warnings.push_back("sky clouds: " + e);
            continue;
        }
        if (const TextureRef *n = find("NormalSampler"))
            loadMipImage(gd, n->base, 1024, part.normal, nullptr);
        if (const TextureRef *s = find("DetailSampler"))
            loadMipImage(gd, s->base, 1024, part.scatter, nullptr);
        part.tangents = g.tangent.size() == static_cast<size_t>(g.vertexCount) * 4;
        const int pi = static_cast<int>(parts.size());
        parts.push_back(std::move(part));
        const Part &pp = parts.back();
        for (size_t k = 0; k + 2 < g.indices.size(); k += 3) {
            Tri t;
            t.part = pi;
            for (int v = 0; v < 3; ++v) {
                const uint32_t i = g.indices[k + v];
                t.p[v] = {g.position[i * 3], g.position[i * 3 + 1], g.position[i * 3 + 2]};
                t.n[v] = {g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2]};
                t.t[v] = pp.tangents ? D3{g.tangent[i * 4], g.tangent[i * 4 + 1], g.tangent[i * 4 + 2]} : D3{1, 0, 0};
                t.uv[v][0] = g.uv0[i * 2];
                t.uv[v][1] = g.uv0[i * 2 + 1];
                if (v == 0 && pp.tangents)
                    t.sign = g.tangent[i * 4 + 3] < 0 ? -1 : 1;
            }
            // the pixels it covers: its edges' points projected, across the seam, over a pole
            double xs[48], ys[48];
            int n = 0;
            for (int ed = 0; ed < 3; ++ed)
                for (int s = 0; s < 16; ++s) {
                    const double f = s / 16.0;
                    panoPixel(t.p[ed] * (1 - f) + t.p[(ed + 1) % 3] * f, W, H, xs[n], ys[n]);
                    ++n;
                }
            double xmin = 1e30, xmax = -1e30, ymin = 1e30, ymax = -1e30;
            for (int i = 0; i < n; ++i)
                xmin = std::min(xmin, xs[i]), xmax = std::max(xmax, xs[i]), ymin = std::min(ymin, ys[i]), ymax = std::max(ymax, ys[i]);
            if (xmax - xmin > W / 2.0) { // across the seam: the left part continues past the right edge
                xmin = 1e30, xmax = -1e30;
                for (int i = 0; i < n; ++i) {
                    const double x = xs[i] < W / 2.0 ? xs[i] + W : xs[i];
                    xmin = std::min(xmin, x), xmax = std::max(xmax, x);
                }
                if (xmax - xmin > W / 2.0) // (wider than half the sky either way: all of it)
                    xmin = 0, xmax = W - 1.0;
            }
            auto hitsAxis = [&](double dy) { // does the ray straight up (down) pass through it?
                const D3 e1 = t.p[1] - t.p[0], e2 = t.p[2] - t.p[0], d{0, dy, 0};
                const D3 p = cross(d, e2);
                const double det = dot(e1, p);
                if (std::abs(det) < 1e-12)
                    return false;
                const D3 s = t.p[0] * -1;
                const double u = dot(s, p) / det;
                const D3 q = cross(s, e1);
                const double v = dot(d, q) / det;
                return u >= 0 && v >= 0 && u + v <= 1 && dot(e2, q) / det > 0;
            };
            t.x0 = static_cast<int>(std::floor(xmin)) - 1;
            t.x1 = static_cast<int>(std::ceil(xmax)) + 1;
            t.y0 = std::max(0, static_cast<int>(std::floor(ymin)) - 1);
            t.y1 = std::min(H - 1, static_cast<int>(std::ceil(ymax)) + 1);
            if (hitsAxis(1))
                t.x0 = 0, t.x1 = W - 1, t.y0 = 0;
            if (hitsAxis(-1))
                t.x0 = 0, t.x1 = W - 1, t.y1 = H - 1;
            // near a pole an edge swings round in azimuth faster than its samples follow (and comes
            // closer to the pole between them): such triangles get every column, up to the pole
            const int poleRows = std::max(2, H * 8 / 180);
            if (t.y0 <= poleRows)
                t.x0 = 0, t.x1 = W - 1, t.y0 = 0;
            if (t.y1 >= H - 1 - poleRows)
                t.x0 = 0, t.x1 = W - 1, t.y1 = H - 1;
            if (t.x1 - t.x0 + 1 >= W)
                t.x0 = 0, t.x1 = W - 1;
            // texture detail: texels per pixel over the triangle (for the mip level)
            double px[3], py[3];
            for (int v = 0; v < 3; ++v)
                panoPixel(t.p[v], W, H, px[v], py[v]);
            for (int v = 1; v < 3; ++v)
                if (px[v] - px[0] > W / 2.0)
                    px[v] -= W;
                else if (px[0] - px[v] > W / 2.0)
                    px[v] += W;
            const double pixArea = std::max(0.5, std::abs((px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0])) * 0.5);
            const double uvArea = std::abs((t.uv[1][0] - t.uv[0][0]) * (t.uv[2][1] - t.uv[0][1]) - (t.uv[2][0] - t.uv[0][0]) * (t.uv[1][1] - t.uv[0][1])) * 0.5;
            const MipImage *im[3] = {&pp.cover, &pp.normal, &pp.scatter};
            for (int k2 = 0; k2 < 3; ++k2)
                t.lod[k2] = im[k2]->ok() ? 0.5 * std::log2(std::max(1e-12, uvArea * im[k2]->w[0] * im[k2]->h[0] / pixArea)) : 0;
            tris.push_back(t);
        }
    }
    if (tris.empty())
        return;
    const unsigned threads = std::clamp(std::thread::hardware_concurrency(), 1u, 16u);
    std::vector<std::thread> pool;
    const int per = (H + static_cast<int>(threads) - 1) / static_cast<int>(threads);
    for (unsigned th = 0; th < threads; ++th) {
        const int r0 = static_cast<int>(th) * per, r1 = std::min(H, r0 + per);
        if (r0 >= r1)
            break;
        pool.emplace_back([&, r0, r1] {
            for (const Tri &t : tris) {
                const int y0 = std::max(t.y0, r0), y1 = std::min(t.y1, r1 - 1);
                if (y0 > y1)
                    continue;
                const Part &pp = parts[t.part];
                const D3 e1 = t.p[1] - t.p[0], e2 = t.p[2] - t.p[0], s = t.p[0] * -1;
                for (int y = y0; y <= y1; ++y)
                    for (int xx = t.x0; xx <= t.x1; ++xx) {
                        const int x = ((xx % W) + W) % W;
                        const D3 d = panoDir(x, y, W, H);
                        const D3 p = cross(d, e2);
                        const double det = dot(e1, p);
                        if (std::abs(det) < 1e-12)
                            continue;
                        const double inv = 1 / det, u = dot(s, p) * inv;
                        if (u < 0 || u > 1)
                            continue;
                        const D3 q = cross(s, e1);
                        const double v = dot(d, q) * inv;
                        if (v < 0 || u + v > 1 || dot(e2, q) * inv <= 0)
                            continue;
                        const double w0 = 1 - u - v, w1 = u, w2 = v;
                        const double tu = t.uv[0][0] * w0 + t.uv[1][0] * w1 + t.uv[2][0] * w2, tv = t.uv[0][1] * w0 + t.uv[1][1] * w1 + t.uv[2][1] * w2;
                        double cov[4];
                        pp.cover.sample(tu, tv, t.lod[0], cov);
                        float *o = &rgb[(static_cast<size_t>(y) * W + x) * 3];
                        if (pp.stars) { // added on top
                            for (int c = 0; c < 3; ++c)
                                o[c] += static_cast<float>(cov[c] * starsLevel);
                            continue;
                        }
                        const double a = cov[0];
                        if (a < 0.004)
                            continue;
                        const D3 nn = normalize(t.n[0] * w0 + t.n[1] * w1 + t.n[2] * w2);
                        D3 n = nn;
                        if (pp.normal.ok() && pp.tangents) {
                            const D3 tt = normalize(t.t[0] * w0 + t.t[1] * w1 + t.t[2] * w2);
                            const D3 bb = cross(nn, tt) * t.sign;
                            double nm[4];
                            pp.normal.sample(tu, tv, t.lod[1], nm);
                            const double nx = nm[0] * 2 - 1, ny = nm[1] * 2 - 1, nz = std::sqrt(std::max(0.0, 1 - nx * nx - ny * ny));
                            n = normalize(tt * nx + bb * ny + nn * nz);
                        }
                        double sc[4] = {0.5, 0.5, 0, 1};
                        if (pp.scatter.ok())
                            pp.scatter.sample(tu, tv, t.lod[2], sc);
                        const double lit = std::clamp(dot(n, sun) * 0.6 + 0.4, 0.0, 1.0);
                        const double through = std::pow(std::max(dot(d, sun), 0.0), 8.0) * sc[0]; // (thin edges glow towards the sun)
                        for (int c = 0; c < 3; ++c) {
                            const double col = skyLight[c] * (0.75 + 0.4 * sc[1]) + sunLight[c] * (lit * (0.35 + 0.55 * sc[0]) + through * 1.6);
                            o[c] = static_cast<float>(o[c] * (1 - a) + col * a);
                        }
                    }
            }
        });
    }
    for (auto &th : pool)
        th.join();
}

void putRgbe(const float *c, uint8_t *o) {
    const float v = std::max({c[0], c[1], c[2]});
    if (!(v > 1e-32f)) {
        o[0] = o[1] = o[2] = o[3] = 0;
        return;
    }
    int e = 0;
    const float m = std::frexp(v, &e) * 256.0f / v;
    for (int k = 0; k < 3; ++k)
        o[k] = static_cast<uint8_t>(std::clamp(c[k] * m, 0.0f, 255.0f));
    o[3] = static_cast<uint8_t>(e + 128);
}

// one channel of a scanline, run-length encoded (Greg Ward's scheme, after Bruce Walter's rgbe.c)
void rleBytes(const uint8_t *data, int n, std::vector<uint8_t> &out) {
    int cur = 0;
    while (cur < n) {
        int beg = cur, run = 0, oldRun = 0;
        while (run < 4 && beg < n) { // the next run of at least 4
            beg += run;
            oldRun = run;
            run = 1;
            while (beg + run < n && run < 127 && data[beg] == data[beg + run])
                ++run;
        }
        if (oldRun > 1 && oldRun == beg - cur) { // a short run just before it
            out.push_back(static_cast<uint8_t>(128 + oldRun));
            out.push_back(data[cur]);
            cur = beg;
        }
        while (cur < beg) { // literal bytes up to it
            const int k = std::min(128, beg - cur);
            out.push_back(static_cast<uint8_t>(k));
            out.insert(out.end(), data + cur, data + cur + k);
            cur += k;
        }
        if (run >= 4) {
            out.push_back(static_cast<uint8_t>(128 + run));
            out.push_back(data[beg]);
            cur += run;
        }
    }
}

// ---- Crossout 2.41's sky worked out from the air (SkyAtmosphere) ---------------------------------
// The environments with no picture of their sky (17: the deserts' days, three hangars' nights) have it
// worked out from their SkyAtmosphere entity's numbers, Unreal-style (Hillaire 2020, "A Scalable and
// Production Ready Sky and Atmosphere Rendering Technique"): Rayleigh and Mie scattering in exponential
// layers, ozone in a tent 15 km either side of 25 km up, multiple scattering as the psi_ms table (the
// ground's albedo in it, its bytes sRGB as Unreal's), seen from altitudeOverSeaLevel, lit by the sun
// above the air (outerSpaceIlluminance at its colour temperature: the night skies' captures say its
// groundLevelIlluminanceScale and tint light only the ground, 0.075 of it would leave them 3.6 EV dark).
// Against the probes' own captures (FogLightingProbe) above 12 degrees it has the game's sky's shape to
// 0.02-0.07 EV (2.40's tables held to them row by row: 0.06-0.33, 1.2 EV off round sand_valley's sun)
// with its colour a constant off (the days' 0.1-0.5 EV too blue), so the sky is held to the capture by
// colour: each channel's median over the sky the capture sees.
struct AirModel {
    double Rg = 6360, Rt = 6420, r0 = 6360.1;
    double ray[3]{}, rh = 8, mieS[3]{}, mieA[3]{}, mh = 1.2, g = 0.8, oz[3]{}, alb[3]{};
    static constexpr int NR = 64, NMU = 256, NH = 32, NMS = 32;
    std::vector<double> T, psi; // transmittance to the top by (r, mu); multiple scattering for a sun of 1 by (h, mu_s)

    // Map.cpp's SkyAtmosphere: planet radius, top, the camera (km from the centre); Rayleigh rgb (per km),
    // its height (km); Mie scattering rgb, absorption rgb, its height, phase g; ozone rgb; ground albedo rgb
    bool parse(const std::string &s) {
        double v[21];
        const char *p = s.c_str();
        for (double &x : v) {
            char *e = nullptr;
            x = std::strtod(p, &e);
            if (e == p || !std::isfinite(x))
                return false;
            p = e;
        }
        Rg = v[0], Rt = v[1], r0 = std::max(v[2], v[0] + 1e-4);
        for (int c = 0; c < 3; ++c)
            ray[c] = v[3 + c], mieS[c] = v[7 + c], mieA[c] = v[10 + c], oz[c] = v[15 + c], alb[c] = v[18 + c];
        rh = std::max(0.1, v[6]), mh = std::max(0.05, v[13]), g = std::clamp(v[14], -0.999, 0.999);
        return Rg > 0 && Rt > r0;
    }
    void densities(double h, double &dr, double &dm, double &dz) const {
        h = std::max(h, 0.0);
        dr = std::exp(-h / rh), dm = std::exp(-h / mh), dz = std::max(0.0, 1 - std::abs(h - 25) / 15);
    }
    void extinction(double h, double e[3]) const {
        double dr, dm, dz;
        densities(h, dr, dm, dz);
        for (int c = 0; c < 3; ++c)
            e[c] = ray[c] * dr + (mieS[c] + mieA[c]) * dm + oz[c] * dz;
    }
    double toTop(double r, double mu) const { return -r * mu + std::sqrt(std::max(0.0, r * r * (mu * mu - 1) + Rt * Rt)); }
    double toGround(double r, double mu) const { return -r * mu - std::sqrt(std::max(0.0, r * r * (mu * mu - 1) + Rg * Rg)); }
    bool hitsGround(double r, double mu) const { return mu < 0 && r * r * (mu * mu - 1) + Rg * Rg >= 0; }
    void transmittance(double r, double mu, double out[3]) const {
        const double fr = std::sqrt(std::clamp((r - Rg) / (Rt - Rg), 0.0, 1.0)) * (NR - 1), fm = (std::clamp(mu, -1.0, 1.0) + 1) / 2 * (NMU - 1);
        const int i = std::clamp(static_cast<int>(fr), 0, NR - 2), j = std::clamp(static_cast<int>(fm), 0, NMU - 2);
        const double a = fr - i, b = fm - j;
        const double *p = &T[(static_cast<size_t>(i) * NMU + j) * 3], *q = p + NMU * 3;
        for (int c = 0; c < 3; ++c)
            out[c] = (p[c] * (1 - b) + p[c + 3] * b) * (1 - a) + (q[c] * (1 - b) + q[c + 3] * b) * a;
    }
    void psiAt(double h, double mu, double out[3]) const {
        const double fh = std::clamp(h / (Rt - Rg), 0.0, 1.0) * (NH - 1), fm = (std::clamp(mu, -1.0, 1.0) + 1) / 2 * (NMS - 1);
        const int i = std::clamp(static_cast<int>(fh), 0, NH - 2), j = std::clamp(static_cast<int>(fm), 0, NMS - 2);
        const double a = fh - i, b = fm - j;
        const double *p = &psi[(static_cast<size_t>(i) * NMS + j) * 3], *q = p + NMS * 3;
        for (int c = 0; c < 3; ++c)
            out[c] = (p[c] * (1 - b) + p[c + 3] * b) * (1 - a) + (q[c] * (1 - b) + q[c + 3] * b) * a;
    }
    // the tables: transmittance (80 steps a ray); psi_ms (Hillaire 2020, 5.5.2): the second-order light
    // gathered from 64 directions (isotropic; the ground's albedo where they meet it), every order after
    // it as 1 / (1 - f_ms)
    void build() {
        T.assign(static_cast<size_t>(NR) * NMU * 3, 0);
        for (int i = 0; i < NR; ++i) {
            const double fr = static_cast<double>(i) / (NR - 1), r = Rg + (Rt - Rg) * fr * fr;
            for (int j = 0; j < NMU; ++j) {
                const double mu = -1 + 2.0 * j / (NMU - 1);
                if (hitsGround(r, mu))
                    continue;
                const double d = toTop(r, mu);
                double tau[3]{};
                constexpr int N = 80;
                for (int k = 0; k < N; ++k) {
                    const double s = (k + 0.5) / N * d, h = std::sqrt(r * r + s * s + 2 * r * s * mu) - Rg;
                    double e[3];
                    extinction(h, e);
                    for (int c = 0; c < 3; ++c)
                        tau[c] += e[c] * d / N;
                }
                for (int c = 0; c < 3; ++c)
                    T[(static_cast<size_t>(i) * NMU + j) * 3 + c] = std::exp(-tau[c]);
            }
        }
        psi.assign(static_cast<size_t>(NH) * NMS * 3, 0);
        constexpr int ND = 64, NSTEP = 20;
        D3 dirs[ND];
        for (int k = 0; k < ND; ++k) { // (a Fibonacci sphere)
            const double y = 1 - 2 * (k + 0.5) / ND, rr = std::sqrt(std::max(0.0, 1 - y * y)), a = kPi * (1 + std::sqrt(5.0)) * (k + 0.5);
            dirs[k] = {rr * std::cos(a), y, rr * std::sin(a)};
        }
        for (int a = 0; a < NH; ++a) {
            const double r = Rg + (Rt - Rg) * a / (NH - 1);
            for (int b = 0; b < NMS; ++b) {
                const double ms = -1 + 2.0 * b / (NMS - 1);
                const D3 sd{std::sqrt(std::max(0.0, 1 - ms * ms)), ms, 0};
                double L2[3]{}, F[3]{};
                for (const D3 &v : dirs) {
                    const bool ground = hitsGround(r, v.y);
                    const double dist = ground ? toGround(r, v.y) : toTop(r, v.y), dt = dist / NSTEP;
                    double tv[3] = {1, 1, 1};
                    for (int k = 0; k < NSTEP; ++k) {
                        const D3 p = D3{0, r, 0} + v * ((k + 0.5) * dt);
                        const double rp = length(p), h = rp - Rg;
                        double e[3], ts[3], dr, dm, dz;
                        extinction(h, e);
                        densities(h, dr, dm, dz);
                        transmittance(rp, dot(p, sd) / rp, ts);
                        for (int c = 0; c < 3; ++c) {
                            const double half = std::exp(-e[c] * dt / 2), sig = ray[c] * dr + mieS[c] * dm;
                            L2[c] += tv[c] * half * sig * ts[c] / (4 * kPi) * dt;
                            F[c] += tv[c] * half * sig * dt;
                            tv[c] *= half * half;
                        }
                    }
                    if (ground) {
                        const D3 n = normalize(D3{0, r, 0} + v * dist);
                        const double mug = dot(n, sd);
                        double tg[3];
                        transmittance(Rg, mug, tg);
                        for (int c = 0; c < 3; ++c)
                            L2[c] += tv[c] * tg[c] * std::max(0.0, mug) * alb[c] / kPi;
                    }
                }
                for (int c = 0; c < 3; ++c)
                    psi[(static_cast<size_t>(a) * NMS + b) * 3 + c] = L2[c] / ND / std::max(1e-6, 1 - F[c] / ND);
            }
        }
    }
    // the sky's light towards v (unit, glTF: y up) for a sun of 1 above the air towards s (48 steps, closer
    // near the camera; each step's scattering through its own extinction, as Hillaire integrates it)
    void radiance(D3 v, D3 s, double out[3]) const {
        out[0] = out[1] = out[2] = 0;
        const double dist = hitsGround(r0, v.y) ? toGround(r0, v.y) : toTop(r0, v.y);
        const double cs = dot(v, s), pr = 3 / (16 * kPi) * (1 + cs * cs), pm = (1 - g * g) / (4 * kPi * std::pow(1 + g * g - 2 * g * cs, 1.5));
        double tacc[3] = {1, 1, 1};
        constexpr int N = 48;
        for (int i = 0; i < N; ++i) {
            const double t0 = static_cast<double>(i * i) / (N * N) * dist, t1 = static_cast<double>((i + 1) * (i + 1)) / (N * N) * dist, dt = t1 - t0;
            const D3 p = D3{0, r0, 0} + v * ((t0 + t1) / 2);
            const double rp = length(p), h = rp - Rg, mus = dot(p, s) / rp;
            double e[3], ts[3], ps[3], dr, dm, dz;
            extinction(h, e);
            densities(h, dr, dm, dz);
            transmittance(rp, mus, ts);
            psiAt(h, mus, ps);
            for (int c = 0; c < 3; ++c) {
                const double sr = ray[c] * dr, sm = mieS[c] * dm, S = (sr * pr + sm * pm) * ts[c] + (sr + sm) * ps[c], seg = std::exp(-e[c] * dt);
                out[c] += tacc[c] * S * (1 - seg) / std::max(e[c], 1e-12);
                tacc[c] *= seg;
            }
        }
    }
};
constexpr int kAirWidth = 1024; // (the picture a worked-out sky is drawn as: 0.35 degrees a pixel, the probes' own)

// ---- Crossout 2.41's sky: a picture (EnvironmentBackdrop) ----------------------------------------
// BC6H, width x width / 4: the sky above the horizon, top row straight up, elevation linear in the
// rows; its column BackdropUvShift (of the width) lies towards the sun's azimuth and its columns turn as
// the view's panorama's do; its values x BackdropLuminance are lux, / 2048 light-probe units (lux / 128
// game units, / 16). Checked on bridge against the probes' sky alone (FogLightingProbe: the picture as
// the game shows it): day, fog, cloudy and xmass, correlation 0.92, 0.86, 0.74, 0.62 at that turn, the
// sky alone 514, 506, 510 and 465 x the picture / 2048 for BackdropLuminance 512.
struct Backdrop {
    std::vector<float> rgb; // (top row first)
    int w = 0, h = 0;
    double scale = 1, shift = 0, sunAz = 0;
    double ground[4]{}; // (opacity; the colour below the horizon, game units)
    bool load(const GameData &gd, const MapEnvironment &env, D3 sun, std::string *err) {
        const std::string path = env.value("BackdropPath");
        if (path == kNoSky) {
            w = 64, h = 16;
            rgb.assign(static_cast<size_t>(w) * h * 3, 0.0f);
        } else if (path.rfind(kAirSky, 0) == 0) { // (worked out from the air: renderAirSky)
            if (!renderAirSky(gd, env, kAirWidth, rgb, err))
                return false;
            w = kAirWidth, h = kAirWidth / 4;
        } else {
            Texture t;
            uint32_t uw = 0, uh = 0;
            if (!loadTexture(gd, path, t, err) || !decodeLevelFloat(t, t.firstLevel(), rgb, uw, uh, err))
                return false;
            w = static_cast<int>(uw), h = static_cast<int>(uh);
        }
        scale = num(env.value("BackdropLuminance"), 1) / 2048;
        shift = num(env.value("BackdropUvShift"), 0);
        sunAz = std::atan2(sun.z, sun.x);
        const std::string g = env.value("BackdropGround");
        char *p = const_cast<char *>(g.c_str());
        for (double &v : ground)
            v = std::strtod(p, &p);
        return w > 0 && h > 0 && rgb.size() == static_cast<size_t>(w) * h * 3;
    }
    // the sky towards d (glTF), light-probe units; below the horizon the horizon's own
    void sample(D3 d, double out[3]) const {
        const double el = std::asin(std::clamp(d.y / std::max(length(d), 1e-12), -1.0, 1.0));
        double u = (std::atan2(d.z, d.x) - sunAz) / (2 * kPi) + shift;
        u -= std::floor(u);
        const double v = std::clamp(1 - std::max(el, 0.0) / (kPi / 2), 0.0, 1.0), x = u * w - 0.5, y = v * h - 0.5;
        const int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
        const double fx = x - x0, fy = y - y0;
        auto at = [&](int i, int j, int c) { return rgb[(static_cast<size_t>(std::clamp(j, 0, h - 1)) * w + ((i % w) + w) % w) * 3 + c]; };
        for (int c = 0; c < 3; ++c)
            out[c] = ((at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy) * scale;
    }
};

// renderSky for an environment with a sky picture (Crossout 2.41): the sun and the light levels as the
// presets' (the scene's entities are written into them: Map.cpp), the view's metering of the probe, the
// probe's capture or the picture as the panorama (below the horizon: the horizon's colour x 0.6, as the
// atmosphere's ground, under BackdropGround by its opacity).
bool renderBackdropSky(const GameData &gd, const MapEnvironment &env, int width, SkyLight &light, std::vector<float> &rgb, std::string *err, bool probeSky) {
    const D3 sun = sunDirection(env);
    light.sun[0] = static_cast<float>(sun.x), light.sun[1] = static_cast<float>(sun.y), light.sun[2] = static_cast<float>(sun.z);
    Backdrop bd;
    if (!bd.load(gd, env, sun, err))
        return false;
    double rows[4][3]{}; // (the sky round the horizon at the view's heights: ui/sky.js backdropRows)
    for (int r = 0; r < 4; ++r)
        for (int x = 0; x < 64; ++x) {
            const double az = (x + 0.5) / 64 * 2 * kPi, el = kMeasured[r];
            double L[3];
            bd.sample({std::cos(el) * std::cos(az), std::sin(el), std::cos(el) * std::sin(az)}, L);
            for (int c = 0; c < 3; ++c)
                rows[r][c] += L[c] / 64;
        }
    auto lum3 = [](const double *c) { return kLum[0] * c[0] + kLum[1] * c[1] + kLum[2] * c[2]; };
    MapProbes mp;
    CubeMap spec;
    const bool hasProbe = loadLightProbes(gd, env.map, env.id, mp, nullptr) && loadCubeMap(gd, mp.probes[0].specular, 0, spec, nullptr);
    const double up = 0.25 * lum3(rows[1]) + 0.375 * (lum3(rows[2]) + lum3(rows[3]));
    const double mean = hasProbe ? cubeLuminance(spec, false)
                                 : 0.5 * (0.35 * lum3(rows[0]) + 0.35 * lum3(rows[1]) + 0.15 * (lum3(rows[2]) + lum3(rows[3]))) +
                                       0.5 * 0.2 * (presetLevels(env, 0).eSun / kProbeUnit * std::max(sun.y, 0.0) / kPi + up);
    const Levels lv = presetLevels(env, mean);
    light.exposure = static_cast<float>(lv.exposure);
    light.ev100 = static_cast<float>(lv.ev);
    for (int c = 0; c < 3; ++c)
        light.horizon[c] = static_cast<float>(rows[0][c] * lv.exposure);
    std::array<double, 3> color = env.value("UseAtmosphereSunColor") == "true" ? vec3(env.value("AtmosphereSunIllum"), {1, 1, 1}) : argbLinear(env.value("SunColor"));
    const double cm = std::max({color[0], color[1], color[2], 1e-6});
    for (int c = 0; c < 3; ++c)
        light.color[c] = static_cast<float>(color[c] /= cm);
    const double cl = std::max(kLum[0] * color[0] + kLum[1] * color[1] + kLum[2] * color[2], 0.05);
    light.intensity = static_cast<float>(lv.key / cl * (sun.y > -0.02 ? 1 : 0.15));
    const auto f0 = vec3(env.value("HeightFog0"), {0, 0, 0}); // (the export only tells of it: its first layer)
    light.fogDensity = static_cast<float>(f0[0]);
    light.fogHeight = static_cast<float>(f0[2]);
    light.fogHalving = static_cast<float>(f0[1] != 0 ? 1 / std::abs(f0[1]) : 0);
    light.fogStart = static_cast<float>(num(env.value("HeightFogStart"), 0));
    if (width <= 0)
        return true;
    const int W = std::clamp(width, 64, 16384), H = W / 2;
    if (hasProbe && probeSky) {
        cubePanorama(spec, W, rgb);
        for (float &v : rgb)
            v *= light.exposure;
        return true;
    }
    rgb.assign(static_cast<size_t>(W) * H * 3, 0.0f);
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
            const D3 d = panoDir(x, y, W, H);
            double L[3];
            bd.sample(d, L);
            float *o = &rgb[(static_cast<size_t>(y) * W + x) * 3];
            for (int c = 0; c < 3; ++c)
                o[c] = static_cast<float>((d.y < 0 ? L[c] * 0.6 * (1 - bd.ground[0]) + bd.ground[1 + c] / kProbeUnit * bd.ground[0] : L[c]) * lv.exposure);
        }
    return true;
}

} // namespace

bool renderAirSky(const GameData &gd, const MapEnvironment &env, int width, std::vector<float> &rgb, std::string *err, double *gains) {
    const int W = std::clamp(width, 64, 4096), H = W / 4;
    const std::string key = env.map + "|" + env.id + "|" + std::to_string(W) + "|" + env.value("SkyAtmosphere") + "|" + env.value("SkyAtmosphereSun") + "|" +
                            env.value("SunDirVert") + "|" + env.value("SunDirHor");
    static std::mutex lock;
    static std::map<std::string, std::pair<std::vector<float>, std::array<double, 3>>> made; // (the view asks for it more than once)
    {
        std::lock_guard<std::mutex> g(lock);
        if (const auto it = made.find(key); it != made.end()) {
            rgb = it->second.first;
            for (int c = 0; c < 3 && gains; ++c)
                gains[c] = it->second.second[c];
            return true;
        }
    }
    AirModel m;
    if (!m.parse(env.value("SkyAtmosphere"))) {
        if (err)
            *err = "this environment has no air to work its sky out from";
        return false;
    }
    const auto E = vec3(env.value("SkyAtmosphereSun"), {0, 0, 0}); // (the sun above the air, light-probe units)
    m.build();
    const D3 sun = sunDirection(env);
    const double sunAz = std::atan2(sun.z, sun.x);
    auto dirOf = [&](int x, int y) {
        const double el = (1 - (y + 0.5) / H) * kPi / 2, az = sunAz + 2 * kPi * (x + 0.5) / W;
        return D3{std::cos(el) * std::cos(az), std::sin(el), std::cos(el) * std::sin(az)};
    };
    rgb.assign(static_cast<size_t>(W) * H * 3, 0.0f);
    const unsigned threads = std::clamp(std::thread::hardware_concurrency(), 1u, 16u);
    std::vector<std::thread> pool;
    const int per = (H + static_cast<int>(threads) - 1) / static_cast<int>(threads);
    for (unsigned th = 0; th < threads; ++th) {
        const int r0 = static_cast<int>(th) * per, r1 = std::min(H, r0 + per);
        if (r0 >= r1)
            break;
        pool.emplace_back([&, r0, r1] {
            for (int y = r0; y < r1; ++y)
                for (int x = 0; x < W; ++x) {
                    double L[3];
                    m.radiance(dirOf(x, y), sun, L);
                    float *o = &rgb[(static_cast<size_t>(y) * W + x) * 3];
                    for (int c = 0; c < 3; ++c)
                        o[c] = static_cast<float>(L[c] * E[c]);
                }
        });
    }
    for (auto &th : pool)
        th.join();
    // held to the game's capture of it (FogLightingProbe) by colour: each channel's median over the sky
    // it sees, 12 degrees up and higher, the pixels within 0.25 EV of the median brightness (not the
    // land, props or clouds standing in it)
    std::array<double, 3> gain{1, 1, 1};
    MapProbes mp;
    CubeMap fog;
    if (loadLightProbes(gd, env.map, env.id, mp, nullptr) && !mp.inscattering.empty() && loadCubeMap(gd, mp.inscattering, 0, fog, nullptr)) {
        std::vector<double> lum;
        std::vector<std::array<double, 3>> each;
        for (int y = 0; y < H; y += 2) {
            if ((1 - (y + 0.5) / H) * 90 < 12)
                continue;
            for (int x = 0; x < W; x += 2) {
                const D3 d = dirOf(x, y);
                float f[3];
                fog.sample(d.x, d.y, d.z, f);
                const float *o = &rgb[(static_cast<size_t>(y) * W + x) * 3];
                if (!(o[0] > 0 && o[1] > 0 && o[2] > 0 && f[0] > 0 && f[1] > 0 && f[2] > 0))
                    continue;
                each.push_back({std::log2(f[0] / o[0]), std::log2(f[1] / o[1]), std::log2(f[2] / o[2])});
                lum.push_back(std::log2((kLum[0] * f[0] + kLum[1] * f[1] + kLum[2] * f[2]) / (kLum[0] * o[0] + kLum[1] * o[1] + kLum[2] * o[2])));
            }
        }
        auto median = [](std::vector<double> v) {
            std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
            return v[v.size() / 2];
        };
        if (lum.size() >= 64) {
            const double m0 = median(lum);
            std::vector<double> ch[3];
            for (size_t i = 0; i < each.size(); ++i)
                if (std::abs(lum[i] - m0) < 0.25)
                    for (int c = 0; c < 3; ++c)
                        ch[c].push_back(each[i][c]);
            if (ch[0].size() >= 32) {
                for (int c = 0; c < 3; ++c)
                    gain[c] = std::exp2(std::clamp(median(ch[c]), -4.0, 4.0));
                for (size_t i = 0; i < rgb.size(); ++i)
                    rgb[i] *= static_cast<float>(gain[i % 3]);
            }
        }
    }
    for (int c = 0; c < 3 && gains; ++c)
        gains[c] = gain[c];
    std::lock_guard<std::mutex> g(lock);
    if (made.size() >= 8)
        made.clear();
    made[key] = {rgb, gain};
    return true;
}

bool renderSky(const GameData &gd, const MapEnvironment &env, int width, bool clouds, SkyLight &light, std::vector<float> &rgb,
               std::vector<std::string> &warnings, std::string *err, bool probeSky) {
    light = SkyLight{};
    rgb.clear();
    if (!env.value("BackdropPath").empty())
        return renderBackdropSky(gd, env, width, light, rgb, err, probeSky); // (Crossout 2.41: a sky picture, no atmosphere)
    const std::string guid = env.value("AtmosphereId");
    if (guid.empty()) {
        if (err)
            *err = "this environment has no atmosphere";
        return false;
    }
    Atmosphere atm;
    if (!loadAtmosphere(gd, guid, atm, err))
        return false;
    AtmosphereModel a;
    if (!a.init(atm, err))
        return false;
    const D3 sun = sunDirection(env);
    light.sun[0] = static_cast<float>(sun.x), light.sun[1] = static_cast<float>(sun.y), light.sun[2] = static_cast<float>(sun.z);

    // the sky at the horizon and higher up, as the view measures it (ui/sky.js measure(): a camera
    // 2 m up, 32 directions around at four heights; their mean and each one's median)
    const D3 low{0, a.bottom + 2, 0};
    double rows[4][3]{}, medians[4][3]{};
    for (int r = 0; r < 4; ++r) {
        std::vector<double> ch[3];
        for (int x = 0; x < 32; ++x) {
            const double az = (x + 0.5) / 32 * 2 * kPi, el = kMeasured[r];
            double L[3];
            a.skyRadiance(low, {std::cos(el) * std::cos(az), std::sin(el), std::cos(el) * std::sin(az)}, sun, L);
            for (int c = 0; c < 3; ++c) {
                rows[r][c] += L[c] / 32;
                ch[c].push_back(L[c]);
            }
        }
        for (int c = 0; c < 3; ++c) {
            std::nth_element(ch[c].begin(), ch[c].begin() + 16, ch[c].end());
            medians[r][c] = ch[c][16];
        }
    }
    // the game's light probe: what it meters, its sky that the atmosphere is held to row by row (ui/sky.js
    // skyGains: the colours and the horizon of FogLightingProbe's, the brightness of the capture's where
    // it sees the sky), and its capture for the panorama
    MapProbes mp;
    CubeMap spec, fog;
    const bool hasProbe = loadLightProbes(gd, env.map, env.id, mp, nullptr) && loadCubeMap(gd, mp.probes[0].specular, 0, spec, nullptr);
    if (hasProbe && !mp.inscattering.empty())
        loadCubeMap(gd, mp.inscattering, 0, fog, nullptr); // (none: the atmosphere as it is)
    double gains[4][3], ratio = 1;
    for (int r = 3; r >= 0; --r) {
        std::vector<double> ch[3], seen;
        for (int x = 0; x < 128 && fog.size; ++x) {
            const double az = (x + 0.5) / 128 * 2 * kPi - kPi, el = kMeasured[r], d[3] = {std::cos(az) * std::cos(el), std::sin(el), std::sin(az) * std::cos(el)};
            float f[3], sp[3];
            fog.sample(d[0], d[1], d[2], f);
            spec.sample(d[0], d[1], d[2], sp);
            for (int c = 0; c < 3; ++c)
                ch[c].push_back(f[c]);
            const double q = (kLum[0] * sp[0] + kLum[1] * sp[1] + kLum[2] * sp[2]) / std::max(kLum[0] * f[0] + kLum[1] * f[1] + kLum[2] * f[2], 1e-9);
            if (q > 0.25 && q < 4)
                seen.push_back(q);
        }
        auto median = [](std::vector<double> &v) {
            std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
            return v[v.size() / 2];
        };
        double sky[3]{};
        for (int c = 0; c < 3 && fog.size; ++c)
            sky[c] = median(ch[c]);
        if (kMeasured[r] > 0.5 && seen.size() >= 16)
            ratio = median(seen);
        const bool use = kLum[0] * sky[0] + kLum[1] * sky[1] + kLum[2] * sky[2] > 0;
        for (int c = 0; c < 3; ++c)
            gains[r][c] = use ? std::clamp(sky[c] * ratio / std::max(medians[r][c] * kLightK[c] / kProbeUnit, 1e-9), 1.0 / 64, 64.0) : 1;
    }
    auto skyLum = [&](int r) { return (kLum[0] * rows[r][0] * kLightK[0] * gains[r][0] + kLum[1] * rows[r][1] * kLightK[1] * gains[r][1] + kLum[2] * rows[r][2] * kLightK[2] * gains[r][2]) / kProbeUnit; };
    const double up = 0.25 * skyLum(1) + 0.375 * (skyLum(2) + skyLum(3));
    // (without a probe: the sky over half the view, ground of albedo 0.2 under it and the sun)
    const double mean = hasProbe ? cubeLuminance(spec, false)
                                 : 0.5 * (0.35 * skyLum(0) + 0.35 * skyLum(1) + 0.15 * (skyLum(2) + skyLum(3))) +
                                       0.5 * 0.2 * (presetLevels(env, 0).eSun / kProbeUnit * std::max(sun.y, 0.0) / kPi + up);
    const Levels lv = presetLevels(env, mean);
    light.exposure = static_cast<float>(lv.exposure);
    light.ev100 = static_cast<float>(lv.ev);
    double shownHigh[3];
    for (int c = 0; c < 3; ++c) {
        light.horizon[c] = static_cast<float>(rows[0][c] * kLightK[c] / kProbeUnit * gains[0][c] * lv.exposure);
        shownHigh[c] = (rows[2][c] + rows[3][c]) / 2 * kLightK[c] / kProbeUnit * (gains[2][c] + gains[3][c]) / 2 * lv.exposure;
    }

    // the sun's light (ui/sky.js lightFromSun()): the preset's colour as it is, or with
    // UseAtmosphereSunColor what the air lets through; as bright as the preset's sun x kSunK
    std::array<double, 3> color = vec3(env.value("AtmosphereSunIllum"), {-1, -1, -1});
    if (env.value("UseAtmosphereSunColor") != "true") {
        color = argbLinear(env.value("SunColor"));
    } else if (color[0] < 0) {
        double T[3];
        a.transmittance(a.bottom + 30, std::max(sun.y, -0.2), T);
        for (int c = 0; c < 3; ++c)
            color[c] = kLightK[c] * a.solar[c] * T[c];
    }
    const double cm = std::max({color[0], color[1], color[2], 1e-6});
    for (int c = 0; c < 3; ++c)
        light.color[c] = static_cast<float>(color[c] /= cm);
    const double cl = std::max(kLum[0] * color[0] + kLum[1] * color[1] + kLum[2] * color[2], 0.05);
    // the key light: the sunlight on the ground (lv.key; below the horizon: a little)
    light.intensity = static_cast<float>(lv.key / cl * (sun.y > -0.02 ? 1 : 0.15));
    // the fog as the view draws it (ui/fog.js presetFog: FOG_DENSITY_K 0.6, FOG_START_ADD 120 m, AIR_K 0.5)
    const double expMul = std::max(0.0, num(env.value("FogExpMul"), 0.01));
    light.fogDensity = static_cast<float>(std::max(0.0, num(env.value("FogDensity"), 0)) * expMul * 0.6);
    light.fogHeight = static_cast<float>(num(env.value("FogHeight"), 0));
    light.fogHalving = static_cast<float>(expMul > 0 ? 1 / expMul : 0);
    light.fogStart = static_cast<float>(std::max(0.0, num(env.value("FogNear"), 0)) + 120);
    light.fogAerialGain = static_cast<float>(std::max(0.0, num(env.value("FogAerialGain"), 0)) * 0.5);
    { // (the air's light is the sun's: ui/fog.js presetFog's sunK)
        const auto asi = vec3(env.value("AtmosphereSunIllum"), {-1, -1, -1});
        const double eAtm = asi[0] >= 0 ? kLum[0] * asi[0] + kLum[1] * asi[1] + kLum[2] * asi[2] : 0;
        light.fogAirSun = static_cast<float>(eAtm > 0 ? std::min(1.0, presetLevels(env, 0).eSun / eAtm) : 1.0);
    }
    if (width <= 0)
        return true;

    // the panorama, at the exposure like the view: the game's light probe (its capture of the map from
    // one point: the sky with its clouds and haze, the land around) when there is one, else the sky
    // from 30 m up (as the view's lighting sees it) with its clouds and the haze-coloured ground below
    // the horizon; no sun disc either way (the sun is a light of its own)
    const int W = std::clamp(width, 64, 16384), H = W / 2;
    if (hasProbe && probeSky) {
        cubePanorama(spec, W, rgb);
        for (float &v : rgb)
            v *= light.exposure;
        return true;
    }
    rgb.assign(static_cast<size_t>(W) * H * 3, 0.0f);
    const D3 cam{0, a.bottom + 30, 0};
    double ground[3];
    for (int c = 0; c < 3; ++c)
        ground[c] = rows[0][c] * 0.6;
    const unsigned threads = std::clamp(std::thread::hardware_concurrency(), 1u, 16u);
    std::vector<std::thread> pool;
    const int per = (H + static_cast<int>(threads) - 1) / static_cast<int>(threads);
    for (unsigned th = 0; th < threads; ++th) {
        const int r0 = static_cast<int>(th) * per, r1 = std::min(H, r0 + per);
        if (r0 >= r1)
            break;
        pool.emplace_back([&, r0, r1] {
            for (int y = r0; y < r1; ++y)
                for (int x = 0; x < W; ++x) {
                    const D3 d = panoDir(x, y, W, H);
                    double L[3];
                    a.skyRadiance(cam, d, sun, L);
                    const bool below = a.hitsGround(cam.y, d.y);
                    // (the probe's sky against the atmosphere, between the heights it was read at: ui/sky.js DOME_FRAG)
                    const double e = std::asin(std::clamp(d.y, 0.0, 1.0));
                    const int k = e < kMeasured[1] ? 0 : e < kMeasured[2] ? 1 : 2;
                    const double f = std::clamp((e - kMeasured[k]) / (kMeasured[k + 1] - kMeasured[k]), 0.0, 1.0);
                    float *o = &rgb[(static_cast<size_t>(y) * W + x) * 3];
                    for (int c = 0; c < 3; ++c)
                        o[c] = static_cast<float>((L[c] + (below ? ground[c] : 0)) * kLightK[c] / kProbeUnit * (gains[k][c] * (1 - f) + gains[k + 1][c] * f) * lv.exposure);
                }
        });
    }
    for (auto &th : pool)
        th.join();
    if (clouds) {
        const std::string dome = env.value("SkyDomeModelPath");
        if (!dome.empty()) {
            double sunLight[3], skyLight[3];
            for (int c = 0; c < 3; ++c) {
                sunLight[c] = color[c] * light.intensity * kCloudSun;
                skyLight[c] = shownHigh[c] * 0.9;
            }
            // stars where the air's own sun is gone (ui/sky.js loadClouds: AtmosphereSunIllum under 5)
            const auto asi = vec3(env.value("AtmosphereSunIllum"), {-1, -1, -1});
            const double eAtm = kLum[0] * asi[0] + kLum[1] * asi[1] + kLum[2] * asi[2];
            const double t = std::clamp((eAtm - 0.5) / 4.5, 0.0, 1.0), night = asi[0] >= 0 ? 1 - t * t * (3 - 2 * t) : 0;
            drawClouds(gd, normalizeGamePath(dome), sun, sunLight, skyLight, night, W, H, rgb, warnings);
        }
    }
    return true;
}

void CubeMap::sample(double x, double y, double z, float out[3]) const {
    out[0] = out[1] = out[2] = 0;
    if (size <= 0)
        return;
    z = -z; // (game space)
    const double ax = std::abs(x), ay = std::abs(y), az = std::abs(z);
    int face;
    double sc, tc, ma;
    if (ax >= ay && ax >= az)
        face = x > 0 ? 0 : 1, sc = x > 0 ? -z : z, tc = -y, ma = ax;
    else if (ay >= az)
        face = y > 0 ? 2 : 3, sc = x, tc = y > 0 ? z : -z, ma = ay;
    else
        face = z > 0 ? 4 : 5, sc = z > 0 ? x : -x, tc = -y, ma = az;
    if (!(ma > 0))
        return;
    const double u = (sc / ma + 1) / 2 * size - 0.5, v = (tc / ma + 1) / 2 * size - 0.5;
    const int u0 = static_cast<int>(std::floor(u)), v0 = static_cast<int>(std::floor(v));
    const double fu = u - u0, fv = v - v0;
    const float *f = &rgb[static_cast<size_t>(face) * size * size * 3];
    auto at = [&](int i, int j, int c) { return f[(static_cast<size_t>(std::clamp(j, 0, size - 1)) * size + std::clamp(i, 0, size - 1)) * 3 + c]; };
    for (int c = 0; c < 3; ++c)
        out[c] = static_cast<float>((at(u0, v0, c) * (1 - fu) + at(u0 + 1, v0, c) * fu) * (1 - fv) + (at(u0, v0 + 1, c) * (1 - fu) + at(u0 + 1, v0 + 1, c) * fu) * fv);
}

bool loadCubeMap(const GameData &gd, const std::string &base, int level, CubeMap &out, std::string *err) {
    out = CubeMap{};
    Texture t;
    if (!loadTextureHeader(gd, base, t, err))
        return false;
    if (!t.info.cube || level < 0 || level >= static_cast<int>(t.info.levels.size())) {
        if (err)
            *err = base + ": not a cube map with that level";
        return false;
    }
    if (!loadTextureLevels(gd, t, level, level, err))
        return false;
    CubeMap c;
    c.size = static_cast<int>(t.info.levels[level].width);
    c.rgb.reserve(static_cast<size_t>(c.size) * c.size * 18);
    for (int f = 0; f < 6; ++f) {
        std::vector<float> face;
        uint32_t w = 0, h = 0;
        if (!decodeLevelFloat(t, level, face, w, h, err, f))
            return false;
        if (w != h || w == 0 || static_cast<int>(w) != c.size || face.size() != static_cast<size_t>(w) * h * 3) { // (sample() and cubeLuminance() read every face as size x size)
            if (err)
                *err = base + ": cube faces are not square";
            return false;
        }
        c.rgb.insert(c.rgb.end(), face.begin(), face.end());
    }
    out = std::move(c);
    return true;
}

void cubePanorama(const CubeMap &c, int width, std::vector<float> &rgb) {
    const int W = std::max(width, 8), H = W / 2;
    rgb.assign(static_cast<size_t>(W) * H * 3, 0.0f);
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
            const D3 d = panoDir(x, y, W, H);
            c.sample(d.x, d.y, d.z, &rgb[(static_cast<size_t>(y) * W + x) * 3]);
        }
}

double cubeLuminance(const CubeMap &c, bool logAverage) {
    double sum = 0, weights = 0;
    const int n = c.size;
    for (int f = 0; f < 6; ++f)
        for (int j = 0; j < n; ++j)
            for (int i = 0; i < n; ++i) {
                const double u = (i + 0.5) / n * 2 - 1, v = (j + 0.5) / n * 2 - 1;
                const double w = 1 / std::pow(1 + u * u + v * v, 1.5); // (the texel's solid angle)
                const float *p = &c.rgb[((static_cast<size_t>(f) * n + j) * n + i) * 3];
                const double l = kLum[0] * p[0] + kLum[1] * p[1] + kLum[2] * p[2];
                sum += w * (logAverage ? std::log2(std::max(l, 1e-6)) : l);
                weights += w;
            }
    if (!(weights > 0))
        return 0;
    return logAverage ? std::exp2(sum / weights) : sum / weights;
}

bool gradeLikeView(const GameData &gd, const MapEnvironment &env, double exposure, const std::vector<float> &rgb, std::vector<uint8_t> &rgba, std::string *err) {
    // the colour LUT: 256 x 16, stored B G R A (identity without one)
    std::vector<uint8_t> lut(256 * 16 * 4);
    for (size_t i = 0; i < 256 * 16; ++i) {
        lut[i * 4] = static_cast<uint8_t>(((i % 256) / 16) * 17);
        lut[i * 4 + 1] = static_cast<uint8_t>((i / 256) * 17);
        lut[i * 4 + 2] = static_cast<uint8_t>((i % 16) * 17);
    }
    std::string path = env.value("ColorRemapPath");
    if (path.size() > 4 && path.compare(path.size() - 4, 4, ".dds") == 0)
        path.resize(path.size() - 4);
    if (!path.empty()) {
        Texture t;
        std::vector<uint8_t> px;
        uint32_t w = 0, h = 0;
        if (!loadTexture(gd, path, t, err) || !decodeLevel(t, 0, px, w, h, err))
            return false;
        if (w == 256 && h == 16)
            lut = std::move(px);
    }
    double wb[9];
    whiteBalance(num(env.value("WhiteTemperature"), 6500), num(env.value("WhiteTint"), 0), wb);
    const double toe = num(env.value("TonemapToe"), 0) * kToe;
    const double in[9] = {0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777};
    const double out[9] = {1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602};
    auto lutAt = [&](int x, int y, int c) { return lut[(static_cast<size_t>(y) * 256 + x) * 4 + 2 - c] / 255.0; };
    rgba.assign(rgb.size() / 3 * 4, 255);
    for (size_t i = 0; i < rgb.size() / 3; ++i) {
        double c[3], a[3], y[3];
        for (int k = 0; k < 3; ++k) // (ui/post.js xoGrade, step by step)
            c[k] = std::max(0.0, (wb[k * 3] * rgb[i * 3] + wb[k * 3 + 1] * rgb[i * 3 + 1] + wb[k * 3 + 2] * rgb[i * 3 + 2]) * exposure);
        for (double &v : c)
            v = v * v / std::max(v + toe, 1e-6);
        for (int k = 0; k < 3; ++k)
            a[k] = (in[k * 3] * c[0] + in[k * 3 + 1] * c[1] + in[k * 3 + 2] * c[2]) / 0.6;
        for (double &v : a)
            v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
        for (int k = 0; k < 3; ++k) {
            const double v = std::clamp(out[k * 3] * a[0] + out[k * 3 + 1] * a[1] + out[k * 3 + 2] * a[2], 0.0, 1.0);
            y[k] = (v <= 0.0031308 ? v * 12.92 : 1.055 * std::pow(v, 1 / 2.4) - 0.055) * 15;
        }
        const int s0 = std::min(14, static_cast<int>(y[2])), g0 = std::min(14, static_cast<int>(y[1])), r0 = std::min(14, static_cast<int>(y[0]));
        const double fb = y[2] - s0, fg = y[1] - g0, fr = y[0] - r0;
        for (int k = 0; k < 3; ++k) {
            double v = 0;
            for (int n = 0; n < 8; ++n)
                v += lutAt((s0 + (n >> 2)) * 16 + r0 + (n & 1), g0 + ((n >> 1) & 1), k) * ((n & 1) ? fr : 1 - fr) * ((n & 2) ? fg : 1 - fg) * ((n & 4) ? fb : 1 - fb);
            rgba[i * 4 + k] = static_cast<uint8_t>(std::lround(std::clamp(v, 0.0, 1.0) * 255));
        }
    }
    return true;
}

std::vector<uint8_t> encodeHdr(const float *rgb, int w, int h) {
    std::vector<uint8_t> out;
    const std::string head = "#?RADIANCE\n# Grimcold: the game's sky\nFORMAT=32-bit_rle_rgbe\n\n-Y " + std::to_string(h) + " +X " + std::to_string(w) + "\n";
    out.assign(head.begin(), head.end());
    std::vector<uint8_t> line(static_cast<size_t>(w) * 4), chan(static_cast<size_t>(w));
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x)
            putRgbe(&rgb[(static_cast<size_t>(y) * w + x) * 3], &line[static_cast<size_t>(x) * 4]);
        if (w < 8 || w > 32767) { // (run-length encoding needs 8 .. 32767 pixels a line)
            out.insert(out.end(), line.begin(), line.end());
            continue;
        }
        out.push_back(2);
        out.push_back(2);
        out.push_back(static_cast<uint8_t>(w >> 8));
        out.push_back(static_cast<uint8_t>(w & 255));
        for (int c = 0; c < 4; ++c) {
            for (int x = 0; x < w; ++x)
                chan[x] = line[static_cast<size_t>(x) * 4 + c];
            rleBytes(chan.data(), w, out);
        }
    }
    return out;
}

bool decodeHdr(const std::vector<uint8_t> &file, std::vector<float> &rgb, int &w, int &h, std::string *err) {
    auto fail = [&](const char *m) {
        if (err)
            *err = m;
        return false;
    };
    size_t p = 0;
    auto line = [&]() {
        std::string s;
        while (p < file.size() && file[p] != '\n')
            s += static_cast<char>(file[p++]);
        ++p;
        return s;
    };
    if (line().rfind("#?", 0) != 0)
        return fail("not a Radiance file");
    std::string s;
    while (p < file.size() && !(s = line()).empty())
        if (s.rfind("FORMAT=", 0) == 0 && s != "FORMAT=32-bit_rle_rgbe")
            return fail("not RGBE");
    if (sscanf_s(line().c_str(), "-Y %d +X %d", &h, &w) != 2 || w <= 0 || h <= 0)
        return fail("unsupported orientation");
    rgb.assign(static_cast<size_t>(w) * h * 3, 0.0f);
    std::vector<uint8_t> px(static_cast<size_t>(w) * 4);
    for (int y = 0; y < h; ++y) {
        if (p + 4 <= file.size() && file[p] == 2 && file[p + 1] == 2 && ((file[p + 2] << 8) | file[p + 3]) == w && w >= 8 && w <= 32767) {
            p += 4;
            for (int c = 0; c < 4; ++c)
                for (int x = 0; x < w;) {
                    if (p >= file.size())
                        return fail("truncated");
                    int n = file[p++];
                    if (n > 128) {
                        n -= 128;
                        if (p >= file.size() || x + n > w)
                            return fail("bad run");
                        for (int k = 0; k < n; ++k)
                            px[static_cast<size_t>(x++) * 4 + c] = file[p];
                        ++p;
                    } else {
                        if (n == 0 || p + n > file.size() || x + n > w)
                            return fail("bad literal");
                        for (int k = 0; k < n; ++k)
                            px[static_cast<size_t>(x++) * 4 + c] = file[p++];
                    }
                }
        } else {
            if (p + px.size() > file.size())
                return fail("truncated");
            std::memcpy(px.data(), &file[p], px.size());
            p += px.size();
        }
        for (int x = 0; x < w; ++x) {
            const uint8_t *q = &px[static_cast<size_t>(x) * 4];
            const float f = q[3] ? std::ldexp(1.0f, q[3] - 136) : 0.0f;
            for (int c = 0; c < 3; ++c)
                rgb[(static_cast<size_t>(y) * w + x) * 3 + c] = q[c] * f;
        }
    }
    return true;
}

} // namespace xo
