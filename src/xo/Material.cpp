#include "xo/Material.h"

#include "xo/Archive.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>

namespace xo {
namespace {

std::string attr(std::string_view tag, std::string_view name) {
    size_t p = 0;
    while ((p = tag.find(name, p)) != std::string_view::npos) {
        const bool boundary = p == 0 || std::isspace(static_cast<unsigned char>(tag[p - 1]));
        size_t q = p + name.size();
        while (q < tag.size() && std::isspace(static_cast<unsigned char>(tag[q])))
            ++q;
        if (boundary && q < tag.size() && tag[q] == '=') {
            ++q;
            while (q < tag.size() && std::isspace(static_cast<unsigned char>(tag[q])))
                ++q;
            if (q < tag.size() && (tag[q] == '"' || tag[q] == '\'')) {
                const char quote = tag[q];
                const size_t end = tag.find(quote, q + 1);
                if (end != std::string_view::npos)
                    return std::string(tag.substr(q + 1, end - q - 1));
            }
        }
        p += name.size();
    }
    return {};
}

std::string unescapeXml(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '&') {
            const size_t semi = s.find(';', i);
            if (semi != std::string_view::npos) {
                const std::string_view ent = s.substr(i + 1, semi - i - 1);
                const char *rep = ent == "amp" ? "&" : ent == "lt" ? "<" : ent == "gt" ? ">" : ent == "quot" ? "\"" : ent == "apos" ? "'" : nullptr;
                if (rep) {
                    out += rep;
                    i = semi;
                    continue;
                }
            }
        }
        out += s[i];
    }
    return out;
}

std::string trim(std::string_view s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a])))
        ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1])))
        --b;
    return std::string(s.substr(a, b - a));
}

bool iequals(std::string_view a, std::string_view b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
               return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
           });
}

} // namespace

const MaterialParam *Material::find(std::string_view name) const {
    for (const auto &p : params)
        if (iequals(p.name, name))
            return &p;
    return nullptr;
}

std::string Material::value(std::string_view name) const {
    const MaterialParam *p = find(name);
    return p ? p->value : std::string();
}

bool parseMdf(std::string_view xml, std::vector<Material> &out, std::string *err) {
    out.clear();
    size_t p = 0;
    while (true) {
        const size_t open = xml.find("<Material", p);
        if (open == std::string_view::npos)
            break;
        const char after = open + 9 < xml.size() ? xml[open + 9] : '\0';
        if (after == 's') { // <Materials>
            p = open + 10;
            continue;
        }
        const size_t tagEnd = xml.find('>', open);
        if (tagEnd == std::string_view::npos)
            break;
        Material m;
        const std::string_view tag = xml.substr(open, tagEnd - open);
        m.guid = attr(tag, "guid");
        std::transform(m.guid.begin(), m.guid.end(), m.guid.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        size_t close = xml.find("</Material>", tagEnd);
        const bool selfClosing = tagEnd > 0 && xml[tagEnd - 1] == '/';
        if (selfClosing || close == std::string_view::npos)
            close = tagEnd;
        const std::string_view body = xml.substr(tagEnd + 1, close > tagEnd ? close - tagEnd - 1 : 0);
        size_t q = 0;
        while (true) {
            const size_t po = body.find("<Parameter", q);
            if (po == std::string_view::npos)
                break;
            const size_t pe = body.find('>', po);
            if (pe == std::string_view::npos)
                break;
            const std::string_view ptag = body.substr(po, pe - po);
            MaterialParam mp;
            mp.name = attr(ptag, "name");
            mp.type = attr(ptag, "type");
            if (const std::string ix = attr(ptag, "index"); !ix.empty() && std::isdigit(static_cast<unsigned char>(ix[0])))
                mp.index = std::atoi(ix.c_str());
            if (pe > 0 && body[pe - 1] == '/') {
                mp.value = unescapeXml(attr(ptag, "value"));
                q = pe + 1;
            } else {
                const size_t vend = body.find("</Parameter>", pe);
                if (vend == std::string_view::npos)
                    break;
                mp.value = trim(unescapeXml(body.substr(pe + 1, vend - pe - 1)));
                q = vend + 12;
            }
            m.params.push_back(std::move(mp));
        }
        out.push_back(std::move(m));
        p = close + 1;
    }
    if (out.empty() && xml.find("<Materials") == std::string_view::npos) {
        if (err)
            *err = "not a material file";
        return false;
    }
    return true;
}

std::vector<Skin> parseSkins(std::string_view text, std::string_view dir) {
    std::vector<Skin> out;
    size_t p = 0;
    while (p < text.size()) {
        size_t e = text.find('\n', p);
        if (e == std::string_view::npos)
            e = text.size();
        std::string line = trim(text.substr(p, e - p));
        p = e + 1;
        if (line.rfind("skin", 0) != 0 || line.size() < 6 || !std::isspace(static_cast<unsigned char>(line[4])))
            continue;
        std::vector<std::string> tok;
        size_t a = 4;
        while (a < line.size()) {
            while (a < line.size() && std::isspace(static_cast<unsigned char>(line[a])))
                ++a;
            size_t b = a;
            while (b < line.size() && !std::isspace(static_cast<unsigned char>(line[b])))
                ++b;
            if (b > a)
                tok.emplace_back(line.substr(a, b - a));
            a = b;
        }
        if (tok.size() < 2)
            continue;
        Skin s;
        s.name = tok[0];
        std::string base = normalizeGamePath(tok[1]);
        if (base.size() > 4 && base.compare(base.size() - 4, 4, ".mdf") == 0)
            base.resize(base.size() - 4);
        s.mdf = base.find('/') != std::string::npos ? base + ".mdf" : std::string(dir) + "/" + base + ".mdf";
        // "default" may be listed more than once; keep the first of each name
        if (std::none_of(out.begin(), out.end(), [&](const Skin &k) { return k.name == s.name; }))
            out.push_back(std::move(s));
    }
    return out;
}

std::string textureRole(std::string_view n, std::string_view shader) {
    auto is = [&](std::string_view s) { return iequals(n, s); };
    auto shaderIs = [&](std::string_view prefix) { return shader.size() >= prefix.size() && iequals(shader.substr(0, prefix.size()), prefix); };
    // Crossout 2.41's ground cover (assets/groundcover: grass, flowers, small stones) names its slots
    // by the textures' endings: _a colour, _n normal, _g gloss, _at the cut-out mask (its colour's alpha
    // is not the cut-out).
    if (shaderIs("63ba6d0f")) {
        if (is("_a"))
            return "albedo";
        if (is("_n"))
            return "normal";
        if (is("_g"))
            return "gloss";
        if (is("_at"))
            return "mask";
        return {};
    }
    if (shaderIs("62bd5a8e") || shaderIs("e611362b")) {
        if (is("DetailSampler"))
            return "normal2";
        if (is("AmbOcclSampler"))
            return "gloss2";
    }
    if (is("DiffuseSampler"))
        return "albedo";
    if (is("NormalSampler"))
        return "normal";
    if (is("SpecularColorSampler"))
        return "gloss";
    if (is("AmbOcclSampler"))
        return "ao";
    if (is("DetailSampler"))
        return "detail";
    if (is("ColormapSampler"))
        return "colormap";
    if (is("Diffuse2Sampler"))
        return "albedo2";
    if (n.size() > 7 && iequals(n.substr(n.size() - 7), "Sampler"))
        return normalizeGamePath(n.substr(0, n.size() - 7));
    return {};
}

std::string textureBase(std::string_view value) {
    std::string v = normalizeGamePath(trim(value));
    if (v.empty() || v.find('/') == std::string::npos)
        return {};
    for (const char *ext : {".tfh", ".tfd", ".dds", ".tga", ".png"}) {
        const size_t n = std::char_traits<char>::length(ext);
        if (v.size() > n && v.compare(v.size() - n, n, ext) == 0) {
            v.resize(v.size() - n);
            break;
        }
    }
    return v;
}

} // namespace xo
