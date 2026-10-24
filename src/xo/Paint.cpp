#include "xo/Paint.h"

#include "xo/Image.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace xo {

std::string Paint::key() const {
    char b[160];
    std::snprintf(b, sizeof(b), "%d|%.4f,%.4f,%.4f|%.4f|%.4f|%d|", static_cast<int>(kind), color[0], color[1], color[2], amount, scale, static_cast<int>(finish));
    return b + tex + "|" + normal;
}

std::string Paint::fileTag() const {
    if (kind == Kind::Color || tex.empty())
        return "paint";
    std::string s = tex.substr(tex.find_last_of('/') + 1);
    if (s.size() > 2 && s.compare(s.size() - 2, 2, "_a") == 0)
        s.resize(s.size() - 2);
    return s;
}

namespace {

struct Lin {
    float v[256];
    Lin() {
        for (int i = 0; i < 256; ++i) {
            const float c = i / 255.0f;
            v[i] = c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
        }
    }
};
const Lin &lin() {
    static const Lin l;
    return l;
}
float srgbOf(float c) { return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(std::max(c, 0.0f), 1 / 2.4f) - 0.055f; }

uint32_t wrap(int64_t i, uint32_t n) {
    const int64_t m = i % static_cast<int64_t>(n);
    return static_cast<uint32_t>(m < 0 ? m + n : m);
}

// A texture's mip chain (RGB floats: linear light for colours, as the GPU filters an sRGB texture; the
// stored values for a normal map), box-filtered, read wrapping round as the view's repeat does.
struct Mips {
    struct Level {
        uint32_t w = 0, h = 0;
        std::vector<float> px;
    };
    std::vector<Level> lv;

    Mips(const PaintImage &img, bool colour) {
        Level l0;
        l0.w = img.w, l0.h = img.h;
        l0.px.resize(static_cast<size_t>(img.w) * img.h * 3);
        const Lin &L = lin();
        for (size_t i = 0; i < static_cast<size_t>(img.w) * img.h; ++i)
            for (int c = 0; c < 3; ++c)
                l0.px[i * 3 + c] = colour ? L.v[img.rgba[i * 4 + c]] : img.rgba[i * 4 + c] / 255.0f;
        lv.push_back(std::move(l0));
        while (lv.back().w > 1 || lv.back().h > 1) {
            Level b;
            {
                const Level &a = lv.back();
                b.w = std::max(1u, a.w / 2), b.h = std::max(1u, a.h / 2);
                b.px.assign(static_cast<size_t>(b.w) * b.h * 3, 0);
                for (uint32_t y = 0; y < b.h; ++y)
                    for (uint32_t x = 0; x < b.w; ++x) {
                        float s[3] = {};
                        for (uint32_t dy = 0; dy < 2; ++dy)
                            for (uint32_t dx = 0; dx < 2; ++dx) {
                                const uint32_t sx = std::min(a.w - 1, x * 2 + dx), sy = std::min(a.h - 1, y * 2 + dy);
                                for (int c = 0; c < 3; ++c)
                                    s[c] += a.px[(static_cast<size_t>(sy) * a.w + sx) * 3 + c];
                            }
                        for (int c = 0; c < 3; ++c)
                            b.px[(static_cast<size_t>(y) * b.w + x) * 3 + c] = s[c] / 4;
                    }
            }
            lv.push_back(std::move(b));
        }
    }

    void bilinear(const Level &l, float u, float v, float out[3]) const {
        const double x = static_cast<double>(u) * l.w - 0.5, y = static_cast<double>(v) * l.h - 0.5;
        const double fx = std::floor(x), fy = std::floor(y);
        const float tx = static_cast<float>(x - fx), ty = static_cast<float>(y - fy);
        const uint32_t x0 = wrap(static_cast<int64_t>(fx), l.w), x1 = wrap(static_cast<int64_t>(fx) + 1, l.w);
        const uint32_t y0 = wrap(static_cast<int64_t>(fy), l.h), y1 = wrap(static_cast<int64_t>(fy) + 1, l.h);
        const float *p00 = &l.px[(static_cast<size_t>(y0) * l.w + x0) * 3], *p10 = &l.px[(static_cast<size_t>(y0) * l.w + x1) * 3];
        const float *p01 = &l.px[(static_cast<size_t>(y1) * l.w + x0) * 3], *p11 = &l.px[(static_cast<size_t>(y1) * l.w + x1) * 3];
        for (int c = 0; c < 3; ++c) {
            const float top = p00[c] + (p10[c] - p00[c]) * tx, bottom = p01[c] + (p11[c] - p01[c]) * tx;
            out[c] = top + (bottom - top) * ty;
        }
    }

    // level: the mip to read (fractions between two)
    void sample(float u, float v, float level, float out[3]) const {
        level = std::clamp(level, 0.0f, static_cast<float>(lv.size() - 1));
        const size_t l0 = static_cast<size_t>(level);
        const float t = level - static_cast<float>(l0);
        bilinear(lv[l0], u, v, out);
        if (t > 1e-3f && l0 + 1 < lv.size()) {
            float o[3];
            bilinear(lv[l0 + 1], u, v, o);
            for (int c = 0; c < 3; ++c)
                out[c] += (o[c] - out[c]) * t;
        }
    }

    const float *mean() const { return lv.back().px.data(); }
};

// The mask (a gloss map: red) at w x h.
void maskAt(const PaintImage &mask, uint32_t w, uint32_t h, std::vector<uint8_t> &m) {
    std::vector<uint8_t> src(mask.rgba, mask.rgba + static_cast<size_t>(mask.w) * mask.h * 4);
    if (mask.w == w && mask.h == h)
        m.swap(src);
    else
        resizeRgba(src, mask.w, mask.h, m, w, h);
}

// fn(x, y, b0, b1, b2) for each texel of a w x h image whose centre is inside the triangle a b c
// (texel units: texel x covers x .. x + 1); past the image's edges it wraps round. (A triangle across more
// than four repeats of the image: its first four.)
template <class F>
void raster(const double a[2], const double b[2], const double c[2], uint32_t w, uint32_t h, F &&fn) {
    const double area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (!(std::abs(area) > 1e-12))
        return;
    const double minX = std::min({a[0], b[0], c[0]}), maxX = std::max({a[0], b[0], c[0]});
    const double minY = std::min({a[1], b[1], c[1]}), maxY = std::max({a[1], b[1], c[1]});
    if (!std::isfinite(minX) || !std::isfinite(maxX) || !std::isfinite(minY) || !std::isfinite(maxY))
        return;
    const int64_t x0 = static_cast<int64_t>(std::ceil(minX - 0.5)), y0 = static_cast<int64_t>(std::ceil(minY - 0.5));
    const int64_t x1 = std::min(static_cast<int64_t>(std::floor(maxX - 0.5)), x0 + 4 * static_cast<int64_t>(w));
    const int64_t y1 = std::min(static_cast<int64_t>(std::floor(maxY - 0.5)), y0 + 4 * static_cast<int64_t>(h));
    for (int64_t y = y0; y <= y1; ++y)
        for (int64_t x = x0; x <= x1; ++x) {
            const double px = x + 0.5, py = y + 0.5;
            const double w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
            const double w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
            const double w2 = 1 - w0 - w1;
            if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7)
                continue;
            fn(wrap(x, w), wrap(y, h), w0, w1, w2);
        }
}

// Which mip of a t-texel-wide texture read through uv1 (scaled) fits a texel of a w x h one read through
// uv0, on one triangle: their areas there.
float footprint(const float *a0, const float *a1, const float *a2, uint32_t w, uint32_t h, const double b0[2], const double b1[2], const double b2[2], uint32_t tw, uint32_t th) {
    const double area0 = std::abs((double(a1[0]) - a0[0]) * (double(a2[1]) - a0[1]) - (double(a1[1]) - a0[1]) * (double(a2[0]) - a0[0])) * w * h;
    const double area1 = std::abs((b1[0] - b0[0]) * (b2[1] - b0[1]) - (b1[1] - b0[1]) * (b2[0] - b0[0])) * tw * th;
    return area0 > 1e-12 && area1 > 1e-12 ? static_cast<float>(std::max(0.0, 0.5 * std::log2(area1 / area0))) : 0.0f;
}

// Texels no triangle covers take the colour of the nearest one that does (up to far texels away, each
// step to a side, never round the image's edge), the rest fill: a texture filtered across its islands'
// edges finds the paint's colours there, and its smaller mips do not darken it.
void fillOut(std::vector<float> &col, const std::vector<uint8_t> &cov, uint32_t w, uint32_t h, int far, const float fill[3]) {
    const size_t n = static_cast<size_t>(w) * h;
    std::vector<uint8_t> dist(n, 255);
    std::vector<uint32_t> q;
    q.reserve(n);
    for (size_t i = 0; i < n; ++i)
        if (cov[i]) {
            dist[i] = 0;
            q.push_back(static_cast<uint32_t>(i));
        }
    for (size_t k = 0; k < q.size(); ++k) {
        const uint32_t i = q[k];
        if (dist[i] >= far)
            continue;
        const uint32_t x = i % w, y = i / w;
        const uint32_t nb[4] = {x > 0 ? i - 1 : i, x + 1 < w ? i + 1 : i, y > 0 ? i - w : i, y + 1 < h ? i + w : i};
        for (uint32_t j : nb) {
            if (dist[j] != 255)
                continue;
            dist[j] = static_cast<uint8_t>(dist[i] + 1);
            for (int c = 0; c < 3; ++c)
                col[static_cast<size_t>(j) * 3 + c] = col[static_cast<size_t>(i) * 3 + c];
            q.push_back(j);
        }
    }
    for (size_t i = 0; i < n; ++i)
        if (dist[i] == 255)
            for (int c = 0; c < 3; ++c)
                col[i * 3 + c] = fill[c];
}

// A chameleon's colour as an export shows it (sRGB): its ramp's middle row, each texel weighed by how
// much of a surface seen from anywhere shows it - u = 1 - the cosine of the angle it is seen at, which
// over a body's visible surface runs evenly from 0 to 1, each bit of surface as big on screen as its
// cosine: weight 1 - u.
void rampMean(const PaintImage &t, float out[3]) {
    const Lin &L = lin();
    const uint32_t row = t.h / 2;
    double s[3] = {}, ws = 0;
    for (uint32_t x = 0; x < t.w; ++x) {
        const double u = (x + 0.5) / t.w, wt = 1 - u;
        const uint8_t *px = &t.rgba[(static_cast<size_t>(row) * t.w + x) * 4];
        for (int c = 0; c < 3; ++c)
            s[c] += L.v[px[c]] * wt;
        ws += wt;
    }
    for (int c = 0; c < 3; ++c)
        out[c] = std::clamp(srgbOf(static_cast<float>(s[c] / ws)), 0.0f, 1.0f);
}

struct V3 {
    double x = 0, y = 0, z = 0;
};
V3 sub(const float *a, const float *b) { return {double(a[0]) - b[0], double(a[1]) - b[1], double(a[2]) - b[2]}; }
V3 cross(const V3 &a, const V3 &b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
double dot(const V3 &a, const V3 &b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
V3 axpy(const V3 &a, double s, const V3 &b) { return {a.x + s * b.x, a.y + s * b.y, a.z + s * b.z}; } // a + s b
bool unit(V3 &a) {
    const double l = std::sqrt(dot(a, a));
    if (!(l > 1e-12))
        return false;
    a = {a.x / l, a.y / l, a.z / l};
    return true;
}

// A triangle's texture frame for one UV set, in the plane of its normal n: t along +u, up along -v (the
// maps' +Y runs up the texture, V down it; ui/viewer.js xoFrameOf).
bool frameOf(const V3 &e1, const V3 &e2, const double d1[2], const double d2[2], const V3 &n, V3 &t, V3 &up) {
    const double det = d1[0] * d2[1] - d2[0] * d1[1];
    if (!(std::abs(det) > 1e-14))
        return false;
    t = {(e1.x * d2[1] - e2.x * d1[1]) / det, (e1.y * d2[1] - e2.y * d1[1]) / det, (e1.z * d2[1] - e2.z * d1[1]) / det};
    V3 b = {(e2.x * d1[0] - e1.x * d2[0]) / det, (e2.y * d1[0] - e1.y * d2[0]) / det, (e2.z * d1[0] - e1.z * d2[0]) / det};
    t = axpy(t, -dot(n, t), n);
    if (!unit(t))
        return false;
    up = {-b.x, -b.y, -b.z};
    up = axpy(axpy(up, -dot(n, up), n), -dot(t, up), t);
    return unit(up);
}

} // namespace

void applyPaint(std::vector<uint8_t> &rgba, uint32_t w, uint32_t h, const Paint &p, const PaintImage &mask,
                const PaintImage &tex, const std::vector<PaintMesh> &meshes) {
    const size_t n = static_cast<size_t>(w) * h;
    if (!p.on() || !mask || !n || rgba.size() < n * 4)
        return;
    std::vector<uint8_t> m;
    maskAt(mask, w, h, m);
    float one[3] = {p.color[0], p.color[1], p.color[2]}; // (the paint's colour everywhere: sRGB)
    std::vector<float> col;                              // (or one a texel)
    if (p.kind == Paint::Kind::Chameleon && tex) {
        float c[3];
        rampMean(tex, c);
        for (int k = 0; k < 3; ++k)
            one[k] *= c[k];
    } else if (p.kind == Paint::Kind::Pattern && tex) {
        const Mips mips(tex, true);
        float mean[3];
        for (int k = 0; k < 3; ++k)
            mean[k] = std::clamp(srgbOf(mips.mean()[k]), 0.0f, 1.0f) * p.color[k];
        col.assign(n * 3, 0.0f);
        std::vector<uint8_t> cov(n, 0);
        const double s = p.scale > 0 ? p.scale : 1;
        for (const PaintMesh &pm : meshes) {
            if (!pm.uv0 || !pm.idx)
                continue;
            for (size_t t = 0; t < pm.triangles; ++t) {
                const uint32_t i[3] = {pm.idx[t * 3], pm.idx[t * 3 + 1], pm.idx[t * 3 + 2]};
                double a[3][2];
                for (int k = 0; k < 3; ++k)
                    a[k][0] = double(pm.uv0[i[k] * 2]) * w, a[k][1] = double(pm.uv0[i[k] * 2 + 1]) * h;
                if (!pm.uv1) { // (no second set: the pattern's mean colour, as the view shows it)
                    raster(a[0], a[1], a[2], w, h, [&](uint32_t x, uint32_t y, double, double, double) {
                        const size_t at = static_cast<size_t>(y) * w + x;
                        std::copy(mean, mean + 3, &col[at * 3]);
                        cov[at] = 1;
                    });
                    continue;
                }
                double b[3][2];
                for (int k = 0; k < 3; ++k)
                    b[k][0] = pm.uv1[i[k] * 2] * s, b[k][1] = pm.uv1[i[k] * 2 + 1] * s;
                const float level = footprint(&pm.uv0[i[0] * 2], &pm.uv0[i[1] * 2], &pm.uv0[i[2] * 2], w, h, b[0], b[1], b[2], tex.w, tex.h);
                raster(a[0], a[1], a[2], w, h, [&](uint32_t x, uint32_t y, double w0, double w1, double w2) {
                    const float u = static_cast<float>(w0 * b[0][0] + w1 * b[1][0] + w2 * b[2][0]);
                    const float v = static_cast<float>(w0 * b[0][1] + w1 * b[1][1] + w2 * b[2][1]);
                    float c[3];
                    mips.sample(u, v, level, c);
                    const size_t at = static_cast<size_t>(y) * w + x;
                    for (int k = 0; k < 3; ++k)
                        col[at * 3 + k] = std::clamp(srgbOf(c[k]), 0.0f, 1.0f) * p.color[k];
                    cov[at] = 1;
                });
            }
        }
        fillOut(col, cov, w, h, 16, mean);
    }
    // the overlay where the mask says, as applyColorAdjust's paint
    for (size_t i = 0; i < n; ++i) {
        const float mk = m[i * 4] / 255.0f * p.amount;
        if (mk <= 0)
            continue;
        uint8_t *px = &rgba[i * 4];
        float c[3] = {px[0] / 255.0f, px[1] / 255.0f, px[2] / 255.0f};
        const float *pc = col.empty() ? one : &col[i * 3];
        const float lum = std::clamp(0.299f * c[0] + 0.587f * c[1] + 0.114f * c[2], 0.0f, 1.0f);
        for (int k = 0; k < 3; ++k) {
            const float o = lum < 0.5f ? 2 * lum * pc[k] : 1 - 2 * (1 - lum) * (1 - pc[k]);
            c[k] += (o - c[k]) * mk;
            px[k] = static_cast<uint8_t>(std::clamp(std::lround(c[k] * 255.0f), 0L, 255L));
        }
    }
}

void applyPaintRelief(std::vector<uint8_t> &rgba, uint32_t w, uint32_t h, const Paint &p, const PaintImage &mask,
                      const PaintImage &relief, const std::vector<PaintMesh> &meshes) {
    const size_t n = static_cast<size_t>(w) * h;
    if (!p.on() || !mask || !relief || !n || rgba.size() < n * 4)
        return;
    std::vector<uint8_t> m;
    maskAt(mask, w, h, m);
    const Mips mips(relief, false);
    const double s = p.kind == Paint::Kind::Pattern && p.scale > 0 ? p.scale : 1;
    std::vector<uint8_t> done(n, 0); // (a texel two triangles share takes the relief once)
    for (const PaintMesh &pm : meshes) {
        if (!pm.uv0 || !pm.uv1 || !pm.idx || !pm.pos)
            continue;
        for (size_t t = 0; t < pm.triangles; ++t) {
            const uint32_t i[3] = {pm.idx[t * 3], pm.idx[t * 3 + 1], pm.idx[t * 3 + 2]};
            const V3 e1 = sub(&pm.pos[i[1] * 3], &pm.pos[i[0] * 3]), e2 = sub(&pm.pos[i[2] * 3], &pm.pos[i[0] * 3]);
            V3 nrm = cross(e1, e2);
            if (!unit(nrm))
                continue;
            double a[3][2], b[3][2];
            for (int k = 0; k < 3; ++k) {
                a[k][0] = double(pm.uv0[i[k] * 2]) * w, a[k][1] = double(pm.uv0[i[k] * 2 + 1]) * h;
                b[k][0] = pm.uv1[i[k] * 2] * s, b[k][1] = pm.uv1[i[k] * 2 + 1] * s;
            }
            const double da1[2] = {double(pm.uv0[i[1] * 2]) - pm.uv0[i[0] * 2], double(pm.uv0[i[1] * 2 + 1]) - pm.uv0[i[0] * 2 + 1]};
            const double da2[2] = {double(pm.uv0[i[2] * 2]) - pm.uv0[i[0] * 2], double(pm.uv0[i[2] * 2 + 1]) - pm.uv0[i[0] * 2 + 1]};
            const double db1[2] = {b[1][0] - b[0][0], b[1][1] - b[0][1]}, db2[2] = {b[2][0] - b[0][0], b[2][1] - b[0][1]};
            V3 t0, up0, t1, up1;
            if (!frameOf(e1, e2, da1, da2, nrm, t0, up0) || !frameOf(e1, e2, db1, db2, nrm, t1, up1))
                continue;
            const float level = footprint(&pm.uv0[i[0] * 2], &pm.uv0[i[1] * 2], &pm.uv0[i[2] * 2], w, h, b[0], b[1], b[2], relief.w, relief.h);
            raster(a[0], a[1], a[2], w, h, [&](uint32_t x, uint32_t y, double w0, double w1, double w2) {
                const size_t at = static_cast<size_t>(y) * w + x;
                if (done[at])
                    return;
                done[at] = 1;
                const float mk = m[at * 4] / 255.0f * p.amount;
                if (mk <= 0)
                    return;
                float r[3];
                mips.sample(static_cast<float>(w0 * b[0][0] + w1 * b[1][0] + w2 * b[2][0]), static_cast<float>(w0 * b[0][1] + w1 * b[1][1] + w2 * b[2][1]), level, r);
                const double rx = r[0] * 2 - 1, ry = r[1] * 2 - 1;
                const V3 d = axpy(V3{t1.x * rx, t1.y * rx, t1.z * rx}, ry, up1); // (its tilt, on the part)
                uint8_t *px = &rgba[at * 4];
                V3 nn = {px[0] / 127.5 - 1 + dot(d, t0) * mk, px[1] / 127.5 - 1 + dot(d, up0) * mk, px[2] / 127.5 - 1};
                if (!unit(nn))
                    return;
                px[0] = static_cast<uint8_t>(std::clamp(std::lround((nn.x * 0.5 + 0.5) * 255), 0L, 255L));
                px[1] = static_cast<uint8_t>(std::clamp(std::lround((nn.y * 0.5 + 0.5) * 255), 0L, 255L));
                px[2] = static_cast<uint8_t>(std::clamp(std::lround((nn.z * 0.5 + 0.5) * 255), 0L, 255L));
            });
        }
    }
}

} // namespace xo
