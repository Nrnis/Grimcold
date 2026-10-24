#include "xo/Parallel.h"

#include <windows.h>

namespace xo {

unsigned workersForMemory(unsigned mbEach) {
    MEMORYSTATUSEX ms{};
    ms.dwLength = sizeof(ms);
    if (!GlobalMemoryStatusEx(&ms))
        return 4;
    return static_cast<unsigned>(std::clamp<unsigned long long>((ms.ullAvailPhys >> 20) / std::max(1u, mbEach), 2, 256));
}

} // namespace xo
