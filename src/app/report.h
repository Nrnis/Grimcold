// Bug reports (the page's Bug report page and its crash dialog, ui/support.js):
//  - the app's log (logs\grimcold.log in the data folder, 5 files of 1 MB at most), every
//    line with the Windows user's folder, name and computer name taken out
//  - crashes caught (an unhandled exception, an uncaught C++ exception, an invalid CRT parameter, a
//    pure virtual call, abort): a minidump and a short summary in crashes\, for the next start to
//    offer; the page's own process failing (WebView2) is noted there the same way
//  - the machine's details for a report: Windows, CPU, memory, graphics cards and their drivers,
//    WebView2, the display
//  - sending one report to Sentry (its envelope API), only when the build carries a DSN
//    (build.cmd: %SENTRY_DSN%) and the user asked for it or agreed to automatic reports; at most
//    20 a day, none while Sentry asks to wait. No files, names or emails go with it.
#pragma once

#include "thirdparty/json.hpp"

#include <windows.h>

#include <filesystem>
#include <string>
#include <string_view>

struct ICoreWebView2Environment;

namespace rep {

// Starts the log and the crash catcher (the data folder: logs\, crashes\; the app's version). A
// running.json the last run left (watchExit) becomes a crash record of kind "exit".
void init(const std::filesystem::path &dataDir, const char *version);

// From here until stopWatching(): a run that ends any other way (fail-fast crashes skip every handler:
// heap corruption, a broken stack cookie; Task Manager; a power cut) leaves crashes\running.json, and
// the next start records that it ended unexpectedly. stopWatching(): the app is ending normally (also
// Windows ending the session). Tests leave it off: they end the app by killing it.
void watchExit();
void stopWatching();

// One line in the log, from source ("host", "page" ...), with the user's folder and names taken out.
void log(std::string_view source, std::string_view text);

// The user's folder, user name and computer name taken out of a text (plain, with forward slashes
// and as escaped in JSON).
std::string redact(std::string text);

// The machine's details: { app, os, cpu, memory, gpus, webview2, display, dataDir }.
ujson::Value system(HWND hwnd, ICoreWebView2Environment *env);

// The log's last lines (oldest first), at most n.
ujson::Value logTail(int n);

// The folder the log is in.
std::filesystem::path logDir();

// Crashes not yet sent or dismissed, oldest first: { id, kind ("crash": the app; "page", "webview":
// its page's processes; "exit": the last run ended without one), time, ms, code, what, module, offset,
// stack (abort, terminate, invalid parameter, pure call: "module+0xoffset" frames from the handler on),
// version, dump (bytes, 0: none), reason }.
ujson::Value crashes();

// Forgets a crash (sent, or the user said not to send it).
bool dropCrash(const std::string &id);

// A WebView2 process ended (what: "page" the page's own, "browser", "gpu"), with its exit code and
// the reason WebView2 gives; the page's and the browser's are kept as crashes for the next start.
void processFailed(const char *what, int exitCode, const std::string &reason);

// Whether reports can be sent: a DSN in this build (or one a test gave).
bool canSend();

// Tests: send to this DSN instead (a local endpoint, http:// allowed).
void testDsn(const std::string &dsn);

// Tests: a crash record as the crash catcher writes it; a real crash of a kind: "native" (an access
// violation), "stack" (a stack overflow), "cpp" (an uncaught C++ exception), "abort", "invalid" (an
// invalid parameter to the C runtime), "purecall", "two" (two threads at once), "fastfail" (an end no
// handler sees), "inside" (the crash catcher itself faults). An uncaught C++ exception ("cpp") is
// recorded as std::terminate, named by where it was thrown.
void testCrashRecord();
[[noreturn]] void testCrashNow(const std::string &kind);

// Tests: text as a minidump's scrub leaves it, as bytes and as UTF-16: { text, wide }.
ujson::Value testScrub(const std::string &text);

// Sends one report: event, the page's part of it (exception or message, breadcrumbs, tags,
// contexts, extra, user: a random install id); crashId: a pending crash whose minidump goes with it
// (and which is forgotten once sent); attachLog: the log's last 300 lines go with it.
// { ok, status, id (Sentry's event id), error }.
ujson::Value send(const ujson::Value &event, const std::string &crashId, bool attachLog);

} // namespace rep
