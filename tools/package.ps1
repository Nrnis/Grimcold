# Makes the release zip, dist\Grimcold-<version>-win64.zip: what the app needs to run (Grimcold.exe,
# libzstd.dll, the ui folder) with its licence and notices, in one folder; and its SHA-256 beside it.
# Run build.cmd first (without %SENTRY_DSN%: a release sends no reports).
#   powershell -ExecutionPolicy Bypass -File tools\package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = [regex]::Match((Get-Content -Raw "$root\src\app\main.cpp"), 'kVersion\[\] = "([^"]+)"').Groups[1].Value
if (-not $version) { throw 'kVersion not found in src\app\main.cpp' }
foreach ($f in 'Grimcold.exe', 'libzstd.dll') { if (-not (Test-Path "$root\$f")) { throw "$f is missing: run build.cmd first" } }
$name = "Grimcold-$version-win64"
$out = Join-Path $root "dist\$name"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$root\Grimcold.exe", "$root\libzstd.dll" $out
Copy-Item -Recurse "$root\ui" (Join-Path $out 'ui')
foreach ($f in 'README.md', 'MANUAL.md', 'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'KNOWN_ISSUES.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md') { Copy-Item "$root\$f" $out }
Copy-Item "$root\third_party\webview2\NOTICE.txt" (Join-Path $out 'WebView2-NOTICE.txt')
$zip = Join-Path $root "dist\$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# (entry by entry: Windows PowerShell's ZipFile.CreateFromDirectory writes "ui\app.js", which unzip
# tools other than Explorer take as one file name; a zip's paths take "/")
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
$za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in Get-ChildItem -Recurse -File $out) {
    $entry = "$name/" + $f.FullName.Substring($out.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $za.Dispose(); $fs.Dispose() }
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
"$hash  $name.zip" | Set-Content -Encoding ascii "$zip.sha256"
Write-Host ("[package] {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
Write-Host "[package] SHA-256 $hash"
