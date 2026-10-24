#pragma once
// zstd decompression through libzstd.dll, loaded at runtime. The DLL ships next to the exe
// (BSD-licensed build taken from Git for Windows; it only needs KERNEL32 + msvcrt).
#include <cstddef>
#include <string>

namespace xo {

// Loads the DLL once (thread-safe). Returns false with *err set when it cannot be found.
bool zstdLoad(std::string *err);

// Decompresses one complete zstd frame into dst. Returns the number of bytes written, or
// SIZE_MAX with *err set (also when the frame does not fit into dstCap).
size_t zstdDecompress(void *dst, size_t dstCap, const void *src, size_t srcSize, std::string *err);

// "1.5.7" etc., or "" when the DLL is not loaded.
std::string zstdVersion();

} // namespace xo
