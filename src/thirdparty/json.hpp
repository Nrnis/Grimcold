#pragma once
// Small dependency-free JSON value, parser and writer (UTF-8 in and out).
// Grimcold's host only needs it for the bridge messages and settings.json, so it favours
// correctness and predictable output over speed:
//  * objects keep insertion order (so rewritten files diff cleanly),
//  * numbers are written in shortest round-trip form (60 stays "60", -172.5855... stays exact),
//  * dump(2) matches Python's json.dumps(indent=2, ensure_ascii=False) layout.
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ujson {

struct ParseError : std::runtime_error {
    size_t pos;
    ParseError(const std::string &what, size_t at)
        : std::runtime_error(what + " (at byte " + std::to_string(at) + ")"), pos(at) {}
};

// Appends `s` JSON-escaped (without quotes). Bytes >= 0x80 pass through, so valid UTF-8
// stays valid; only control characters and the two metacharacters are escaped.
inline void appendEscaped(std::string &out, std::string_view s) {
    static const char *hex = "0123456789abcdef";
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
            if (c < 0x20) {
                out += "\\u00";
                out += hex[c >> 4];
                out += hex[c & 15];
            } else {
                out += static_cast<char>(c);
            }
        }
    }
}

inline std::string quote(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 2);
    out += '"';
    appendEscaped(out, s);
    out += '"';
    return out;
}

inline void appendNumber(std::string &out, double d) {
    if (!std::isfinite(d)) { // JSON has no NaN/Infinity
        out += "null";
        return;
    }
    if (d == 0) { // also normalises -0
        out += '0';
        return;
    }
    char buf[64];
    auto res = std::to_chars(buf, buf + sizeof(buf), d); // shortest round-trip form
    out.append(buf, res.ptr);
}

class Value {
  public:
    enum class Type : uint8_t { Null, Bool, Number, String, Array, Object };
    using Array = std::vector<Value>;
    using Member = std::pair<std::string, Value>;
    using Object = std::vector<Member>;

    Value() = default;
    Value(std::nullptr_t) {}
    Value(bool b) : type_(Type::Bool), bool_(b) {}
    Value(int i) : type_(Type::Number), num_(static_cast<double>(i)) {}
    Value(long long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
    Value(unsigned long long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
    Value(double d) : type_(Type::Number), num_(d) {}
    Value(std::string s) : type_(Type::String), str_(std::move(s)) {}
    Value(std::string_view s) : type_(Type::String), str_(s) {}
    Value(const char *s) : type_(Type::String), str_(s ? s : "") {}

    static Value array() {
        Value v;
        v.type_ = Type::Array;
        return v;
    }
    static Value object() {
        Value v;
        v.type_ = Type::Object;
        return v;
    }

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isBool() const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray() const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    // ---- scalars (fallback when the type does not match) -----------------------------------
    const std::string &str() const {
        static const std::string empty;
        return type_ == Type::String ? str_ : empty;
    }
    std::string str(std::string_view fallback) const {
        return type_ == Type::String ? str_ : std::string(fallback);
    }
    double num(double fallback = 0) const { return type_ == Type::Number ? num_ : fallback; }
    long long integer(long long fallback = 0) const {
        return type_ == Type::Number ? static_cast<long long>(num_) : fallback;
    }
    bool boolean(bool fallback = false) const { return type_ == Type::Bool ? bool_ : fallback; }

    // ---- objects -----------------------------------------------------------------------------
    // Missing keys (or non-objects) yield a shared null, so v["a"]["b"] never throws.
    const Value &operator[](std::string_view key) const {
        const Value *v = find(key);
        return v ? *v : nullValue();
    }
    const Value *find(std::string_view key) const {
        if (type_ != Type::Object)
            return nullptr;
        for (const auto &m : obj_)
            if (m.first == key)
                return &m.second;
        return nullptr;
    }
    Value *find(std::string_view key) {
        if (type_ != Type::Object)
            return nullptr;
        for (auto &m : obj_)
            if (m.first == key)
                return &m.second;
        return nullptr;
    }
    bool has(std::string_view key) const { return find(key) != nullptr; }
    // Inserts or replaces; turns a null into an object first.
    Value &set(std::string key, Value v) {
        if (type_ == Type::Null)
            type_ = Type::Object;
        if (type_ != Type::Object)
            throw std::logic_error("ujson: set() on a non-object");
        if (Value *existing = find(key)) {
            *existing = std::move(v);
            return *existing;
        }
        obj_.emplace_back(std::move(key), std::move(v));
        return obj_.back().second;
    }
    bool erase(std::string_view key) {
        if (type_ != Type::Object)
            return false;
        for (auto it = obj_.begin(); it != obj_.end(); ++it)
            if (it->first == key) {
                obj_.erase(it);
                return true;
            }
        return false;
    }
    const Object &members() const {
        static const Object empty;
        return type_ == Type::Object ? obj_ : empty;
    }
    Object &members() { return obj_; }

    // ---- arrays ------------------------------------------------------------------------------
    const Array &items() const {
        static const Array empty;
        return type_ == Type::Array ? arr_ : empty;
    }
    Array &items() { return arr_; }
    void push(Value v) {
        if (type_ == Type::Null)
            type_ = Type::Array;
        if (type_ != Type::Array)
            throw std::logic_error("ujson: push() on a non-array");
        arr_.push_back(std::move(v));
    }
    size_t size() const {
        return type_ == Type::Array ? arr_.size() : type_ == Type::Object ? obj_.size() : 0;
    }

    // ---- parse / dump ------------------------------------------------------------------------
    static Value parse(std::string_view text, int maxDepth = 256) {
        Parser p{text, 0, maxDepth};
        if (p.s.size() >= 3 && static_cast<unsigned char>(p.s[0]) == 0xEF &&
            static_cast<unsigned char>(p.s[1]) == 0xBB && static_cast<unsigned char>(p.s[2]) == 0xBF)
            p.i = 3; // tolerate a UTF-8 BOM
        Value v = p.value(0);
        p.space();
        if (p.i != p.s.size())
            throw ParseError("Trailing characters after JSON value", p.i);
        return v;
    }

    // indent < 0: compact. indent >= 0: pretty, Python json.dumps(indent=N) layout.
    std::string dump(int indent = -1) const {
        std::string out;
        dumpTo(out, indent, 0);
        return out;
    }

    void dumpTo(std::string &out, int indent, int level) const {
        switch (type_) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += bool_ ? "true" : "false"; break;
        case Type::Number: appendNumber(out, num_); break;
        case Type::String:
            out += '"';
            appendEscaped(out, str_);
            out += '"';
            break;
        case Type::Array:
            if (arr_.empty()) {
                out += "[]";
                break;
            }
            out += '[';
            for (size_t k = 0; k < arr_.size(); ++k) {
                if (k)
                    out += ',';
                newline(out, indent, level + 1);
                arr_[k].dumpTo(out, indent, level + 1);
            }
            newline(out, indent, level);
            out += ']';
            break;
        case Type::Object:
            if (obj_.empty()) {
                out += "{}";
                break;
            }
            out += '{';
            for (size_t k = 0; k < obj_.size(); ++k) {
                if (k)
                    out += ',';
                newline(out, indent, level + 1);
                out += '"';
                appendEscaped(out, obj_[k].first);
                out += indent >= 0 ? "\": " : "\":";
                obj_[k].second.dumpTo(out, indent, level + 1);
            }
            newline(out, indent, level);
            out += '}';
            break;
        }
    }

  private:
    static const Value &nullValue() {
        static const Value v;
        return v;
    }
    static void newline(std::string &out, int indent, int level) {
        if (indent < 0)
            return;
        out += '\n';
        out.append(static_cast<size_t>(indent) * static_cast<size_t>(level), ' ');
    }

    struct Parser {
        std::string_view s;
        size_t i;
        int maxDepth;

        void space() {
            while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r'))
                ++i;
        }
        [[noreturn]] void fail(const char *what) const { throw ParseError(what, i); }

        Value value(int depth) {
            if (depth > maxDepth)
                fail("JSON nested too deeply");
            space();
            if (i >= s.size())
                fail("Unexpected end of JSON");
            const char c = s[i];
            if (c == '{')
                return object(depth);
            if (c == '[')
                return array(depth);
            if (c == '"')
                return Value(string());
            if (c == 't') {
                literal("true");
                return Value(true);
            }
            if (c == 'f') {
                literal("false");
                return Value(false);
            }
            if (c == 'n') {
                literal("null");
                return Value();
            }
            return number();
        }
        void literal(const char *word) {
            const size_t n = std::strlen(word);
            if (s.substr(i, n) != word)
                fail("Invalid literal");
            i += n;
        }
        Value number() {
            const size_t start = i;
            if (i < s.size() && s[i] == '-')
                ++i;
            if (i >= s.size())
                fail("Invalid number");
            if (s[i] == '0') {
                ++i;
            } else if (s[i] >= '1' && s[i] <= '9') {
                while (i < s.size() && s[i] >= '0' && s[i] <= '9')
                    ++i;
            } else {
                fail("Invalid number");
            }
            if (i < s.size() && s[i] == '.') {
                ++i;
                if (i >= s.size() || s[i] < '0' || s[i] > '9')
                    fail("Invalid number");
                while (i < s.size() && s[i] >= '0' && s[i] <= '9')
                    ++i;
            }
            if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
                ++i;
                if (i < s.size() && (s[i] == '+' || s[i] == '-'))
                    ++i;
                if (i >= s.size() || s[i] < '0' || s[i] > '9')
                    fail("Invalid number");
                while (i < s.size() && s[i] >= '0' && s[i] <= '9')
                    ++i;
            }
            double d = 0;
            auto res = std::from_chars(s.data() + start, s.data() + i, d);
            if (res.ec == std::errc::result_out_of_range) // huge exponents: clamp instead of failing
                d = (s[start] == '-') ? -HUGE_VAL : HUGE_VAL;
            else if (res.ec != std::errc())
                throw ParseError("Invalid number", start);
            return Value(d);
        }
        unsigned hex4() {
            if (i + 4 > s.size())
                fail("Bad \\u escape");
            unsigned v = 0;
            for (int k = 0; k < 4; ++k) {
                const char c = s[i++];
                v <<= 4;
                if (c >= '0' && c <= '9')
                    v |= static_cast<unsigned>(c - '0');
                else if (c >= 'a' && c <= 'f')
                    v |= static_cast<unsigned>(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F')
                    v |= static_cast<unsigned>(c - 'A' + 10);
                else
                    fail("Bad \\u escape");
            }
            return v;
        }
        static void utf8(std::string &out, unsigned cp) {
            if (cp <= 0x7F) {
                out += static_cast<char>(cp);
            } else if (cp <= 0x7FF) {
                out += static_cast<char>(0xC0 | (cp >> 6));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else if (cp <= 0xFFFF) {
                out += static_cast<char>(0xE0 | (cp >> 12));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else {
                out += static_cast<char>(0xF0 | (cp >> 18));
                out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            }
        }
        std::string string() {
            ++i; // opening quote
            std::string out;
            while (true) {
                if (i >= s.size())
                    fail("Unterminated string");
                const char c = s[i++];
                if (c == '"')
                    return out;
                if (static_cast<unsigned char>(c) < 0x20)
                    fail("Control character in string");
                if (c != '\\') {
                    out += c;
                    continue;
                }
                if (i >= s.size())
                    fail("Unterminated string");
                const char e = s[i++];
                switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp = hex4();
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        // High surrogate: combine with a following low surrogate if present.
                        if (i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                            const size_t save = i;
                            i += 2;
                            const unsigned lo = hex4();
                            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                i = save; // not a pair; emit replacement for the lone half
                                cp = 0xFFFD;
                            }
                        } else {
                            cp = 0xFFFD;
                        }
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        cp = 0xFFFD; // lone low surrogate
                    }
                    utf8(out, cp);
                    break;
                }
                default: fail("Bad escape in string");
                }
            }
        }
        Value array(int depth) {
            ++i; // [
            Value v = Value::array();
            space();
            if (i < s.size() && s[i] == ']') {
                ++i;
                return v;
            }
            while (true) {
                v.arr_.push_back(value(depth + 1));
                space();
                if (i >= s.size())
                    fail("Unterminated array");
                if (s[i] == ',') {
                    ++i;
                    continue;
                }
                if (s[i] == ']') {
                    ++i;
                    return v;
                }
                fail("Expected ',' or ']'");
            }
        }
        Value object(int depth) {
            ++i; // {
            Value v = Value::object();
            space();
            if (i < s.size() && s[i] == '}') {
                ++i;
                return v;
            }
            // Duplicate keys: last one wins, like Python and JS. Small objects use a linear
            // scan; big ones (e.g. thousands of nodes) switch to a hash index to stay O(n).
            std::unordered_map<std::string, size_t> index;
            while (true) {
                space();
                if (i >= s.size() || s[i] != '"')
                    fail("Expected object key");
                std::string key = string();
                space();
                if (i >= s.size() || s[i] != ':')
                    fail("Expected ':'");
                ++i;
                Value item = value(depth + 1);
                if (v.obj_.size() == 32 && index.empty())
                    for (size_t k = 0; k < v.obj_.size(); ++k)
                        index.emplace(v.obj_[k].first, k);
                if (!index.empty()) {
                    auto hit = index.find(key);
                    if (hit != index.end()) {
                        v.obj_[hit->second].second = std::move(item);
                    } else {
                        index.emplace(key, v.obj_.size());
                        v.obj_.emplace_back(std::move(key), std::move(item));
                    }
                } else if (Value *dup = v.find(key)) {
                    *dup = std::move(item);
                } else {
                    v.obj_.emplace_back(std::move(key), std::move(item));
                }
                space();
                if (i >= s.size())
                    fail("Unterminated object");
                if (s[i] == ',') {
                    ++i;
                    continue;
                }
                if (s[i] == '}') {
                    ++i;
                    return v;
                }
                fail("Expected ',' or '}'");
            }
        }
    };

    Type type_ = Type::Null;
    bool bool_ = false;
    double num_ = 0;
    std::string str_;
    Array arr_;
    Object obj_;
};

} // namespace ujson
