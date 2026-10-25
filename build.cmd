@echo off
rem Builds Grimcold.
rem   build.cmd          test tool + app
rem   build.cmd core     only build\xotest.exe (core library checks, no window)
rem   build.cmd app      only the app
setlocal EnableExtensions
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [build] vswhere.exe not found. Install Visual Studio 2022 with "Desktop development with C++".
  exit /b 1
)
set "VSINSTALL="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo [build] No Visual Studio installation with the x64 C++ tools was found.
  exit /b 1
)
where cl >nul 2>nul || call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>nul
if errorlevel 1 exit /b 1

if not exist build mkdir build
if not exist build\obj mkdir build\obj
set "CFLAGS=/nologo /std:c++20 /EHsc /W4 /O2 /MT /utf-8 /permissive- /DUNICODE /D_UNICODE /DNOMINMAX /DWIN32_LEAN_AND_MEAN /Isrc /Ithird_party\webview2\include"
set "CORE=src\xo\Zstd.cpp src\xo\Archive.cpp src\xo\Model.cpp src\xo\Material.cpp src\xo\Texture.cpp src\xo\Image.cpp src\xo\Export.cpp src\xo\Anim.cpp src\xo\Map.cpp src\xo\Sky.cpp src\xo\Sound.cpp src\xo\Parallel.cpp src\xo\Paint.cpp"
set "CORELIBS=bcrypt.lib ole32.lib oleaut32.lib windowscodecs.lib uuid.lib"

if /i "%~1"=="app" goto app

echo [build] xotest.exe (core checks)
cl %CFLAGS% %CORE% tools\xotest.cpp /Fobuild\obj\ /Febuild\xotest.exe /link /SUBSYSTEM:CONSOLE %CORELIBS%
if errorlevel 1 exit /b 1
copy /y third_party\zstd\libzstd.dll build\ >nul
if /i "%~1"=="core" (
  echo [build] OK: %CD%\build\xotest.exe
  exit /b 0
)

:app
echo [build] Grimcold.exe
if not exist build\app mkdir build\app
rc /nologo /fo build\obj\app.res src\app\app.rc
if errorlevel 1 exit /b 1
rem Where crash reports go (a Sentry DSN): %SENTRY_DSN%, given by the release build, never kept in the
rem source. A build without it sends none (Bug report still copies the details and opens GitHub's form).
if not exist build\gen mkdir build\gen
set "XO_DSN=%SENTRY_DSN%"
> build\gen\buildinfo.h echo #define XO_SENTRY_DSN "%XO_DSN%"
cl %CFLAGS% /Ibuild\gen src\app\main.cpp src\app\report.cpp %CORE% build\obj\app.res /Fobuild\app\ /FeGrimcold.exe /link /MAP:build\Grimcold.map /SUBSYSTEM:WINDOWS /MANIFEST:NO third_party\webview2\x64\WebView2LoaderStatic.lib %CORELIBS% user32.lib gdi32.lib shell32.lib shlwapi.lib dwmapi.lib advapi32.lib comdlg32.lib version.lib dbghelp.lib winhttp.lib dxgi.lib
if errorlevel 1 exit /b 1
copy /y third_party\zstd\libzstd.dll . >nul
echo [build] OK: %CD%\Grimcold.exe
exit /b 0
