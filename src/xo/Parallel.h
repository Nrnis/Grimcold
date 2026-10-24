#pragma once
// Work spread over the CPU's cores: a loop whose steps run on as many threads as there are cores.
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <exception>
#include <mutex>
#include <thread>
#include <vector>

namespace xo {

// (set on a parallel loop's threads while they work: a loop inside one runs on its own thread alone,
// as the cores are busy already)
inline thread_local bool tlInParallel = false;

// How many workers the free memory has room for at mbEach MB apiece (at least 2): a cap for loops
// whose steps each hold big images.
unsigned workersForMemory(unsigned mbEach);

// The threads a parallel loop gets: one per core, at most cap (0: no cap); 1 inside another loop.
inline unsigned parallelWorkers(unsigned cap = 0) {
    if (tlInParallel)
        return 1;
    const unsigned hw = std::max(1u, std::thread::hardware_concurrency());
    return cap ? std::min(hw, cap) : hw;
}

// f(i) for every i in [0, n), on up to parallelWorkers(cap) threads (the caller's among them); returns
// once all are done and rethrows the first exception one of them threw (the rest are then skipped).
// Each i runs once, in no fixed order: f must only touch what is i's own (or lock).
template <class F>
void parallelFor(size_t n, F &&f, unsigned cap = 0) {
    const unsigned workers = static_cast<unsigned>(std::min<size_t>(parallelWorkers(cap), n));
    if (workers <= 1) {
        for (size_t i = 0; i < n; ++i)
            f(i);
        return;
    }
    std::atomic<size_t> next{0};
    std::exception_ptr error;
    std::mutex errorMu;
    auto run = [&] {
        const bool was = tlInParallel;
        tlInParallel = true;
        for (size_t i; (i = next.fetch_add(1)) < n;) {
            try {
                f(i);
            } catch (...) {
                std::lock_guard lk(errorMu);
                if (!error)
                    error = std::current_exception();
                next = n;
            }
        }
        tlInParallel = was;
    };
    std::vector<std::thread> threads;
    threads.reserve(workers - 1);
    for (unsigned k = 1; k < workers; ++k)
        threads.emplace_back(run);
    run();
    for (auto &t : threads)
        t.join();
    if (error)
        std::rethrow_exception(error);
}

// Rows [0, rows) in bands, one band per thread (for per-pixel work whose rows are independent).
template <class F>
void parallelRows(size_t rows, F &&f, unsigned cap = 0) {
    const size_t bands = std::max<size_t>(1, std::min<size_t>(parallelWorkers(cap) * 4, rows / 16));
    parallelFor(bands, [&](size_t b) {
        const size_t r0 = rows * b / bands, r1 = rows * (b + 1) / bands;
        for (size_t r = r0; r < r1; ++r)
            f(r);
    }, cap);
}

} // namespace xo
