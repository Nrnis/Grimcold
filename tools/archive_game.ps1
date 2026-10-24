<#
Keeps a copy of the installed Crossout version, so the exporter can still use it after the game updates,
changes or goes offline. The game folder is only read.

  powershell -ExecutionPolicy Bypass -File tools\archive_game.ps1
      copies the install to <Dest>\Crossout <version>\ (Dest default: %USERPROFILE%\CrossoutArchive),
      checks it (SHA-256 against the install, MD5 of every archived file through build\xotest.exe),
      writes SHA256SUMS.txt and README.txt, marks the files read-only
  powershell -ExecutionPolicy Bypass -File tools\archive_game.ps1 -Verify "<snapshot folder>"
      checks a snapshot against its SHA256SUMS.txt (finds damaged or changed files later)
  ... -Readme "<snapshot folder>"   (re)writes a snapshot's README.txt

Left out: the launcher's log folders. The encrypted .pk2 packs are copied as they are (never opened).
#>
param(
    [string]$Dest = (Join-Path $env:USERPROFILE 'CrossoutArchive'),
    [string]$Game = (Join-Path $env:LOCALAPPDATA 'Crossout Launcher'),
    [string]$Verify,
    [string]$Readme,
    [string]$Checks = '- see SHA256SUMS.txt; -Verify checks the files against it'
)
$ErrorActionPreference = 'Stop'
$skipDirs = @('.launcher_log', '.start_app_logs', '.obsolete')
$xotest = Join-Path $PSScriptRoot '..\build\xotest.exe'

function Get-GameVersion([string]$root) {
    $exe = Join-Path $root 'bin\win64\Crossout.exe'
    if (-not (Test-Path -LiteralPath $exe)) { return $null }
    $v = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion # "2.40.10.361437(661aac453)"
    return ($v -replace '\s*\(', ' (').Trim()
}

function Get-Hashes([string]$root) {
    $h = @{}
    Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).TrimStart('\')
        $top = $rel.Split('\')[0]
        if ($skipDirs -notcontains $top -and $rel -ne 'SHA256SUMS.txt' -and $rel -ne 'README.txt') {
            $h[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
        }
    }
    return $h
}

function Write-SnapshotReadme([string]$folder, [string]$version, [string]$source, [string]$made, [string]$checks) {
    $files = Get-ChildItem -LiteralPath $folder -Recurse -File -Force | Where-Object { $_.Name -ne 'README.txt' -and $_.Name -ne 'SHA256SUMS.txt' }
    $size = ($files | Measure-Object Length -Sum).Sum
    $dataDate = (Get-Item -LiteralPath (Join-Path $folder 'data')).LastWriteTime.ToString('yyyy-MM-dd')
    $text = @"
Crossout $version - a kept copy of the installed game
Made $made from $source (game data dated $dataDate).

WHAT IT IS
A byte-for-byte copy of the game folder as the Gaijin launcher installed it: the game data (data\: the
784 readable archives the exporter uses, and the encrypted .pk2 packs, copied as they are), the game
(bin\), the launcher and BattlEye. Left out: the launcher's log folders.
$($files.Count) files, $([math]::Round($size / 1GB, 2)) GB.
The launcher never touches this copy, so it keeps this version when the game updates, changes or goes
offline.

CHECKED
$checks

USE IT WITH GRIMCOLD
Click the game folder button at the top left of the app and choose this folder. The button then shows
this folder and the status bar "Crossout $version". To go back to the installed game, choose
$source the same way.
Command line: build\xotest.exe --data "$folder\data" scan | map <name> <out.glb> | ...

CHECK IT LATER (damaged or changed files)
powershell -ExecutionPolicy Bypass -File "<Grimcold>\tools\archive_game.ps1" -Verify "$folder"

NOTES
- The files are marked read-only so nothing changes them by accident.
- This copy can't be used to play online: the servers only take the current version.
- It is your own copy of the game's files: don't share or upload it (Gaijin's EULA).
"@
    $path = Join-Path $folder 'README.txt'
    if (Test-Path -LiteralPath $path) { Set-ItemProperty -LiteralPath $path -Name IsReadOnly -Value $false }
    [System.IO.File]::WriteAllText($path, ($text -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding $false))
    Set-ItemProperty -LiteralPath $path -Name IsReadOnly -Value $true
}

if ($Verify) {
    $sums = Join-Path $Verify 'SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $sums)) { throw "no SHA256SUMS.txt in $Verify" }
    $want = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($sums)) {
        if ($line -match '^([0-9a-f]{64}) \*(.+)$') { $want[$matches[2].Replace('/', '\')] = $matches[1] }
    }
    $have = Get-Hashes (Resolve-Path -LiteralPath $Verify).Path
    $bad = @($want.Keys | Where-Object { $have[$_] -ne $want[$_] })
    $extra = @($have.Keys | Where-Object { -not $want.ContainsKey($_) })
    "checked $($want.Count) files: $($bad.Count) missing or changed, $($extra.Count) not in the list"
    $bad + $extra | Select-Object -First 20
    if ($bad.Count -or $extra.Count) { exit 1 }
    'the snapshot is intact'
    exit 0
}

if ($Readme) {
    $Readme = (Resolve-Path -LiteralPath $Readme).Path
    $v = Get-GameVersion $Readme
    # (robocopy gives the folder the install's own dates; the checksum list was written when the copy was made)
    $sums = Join-Path $Readme 'SHA256SUMS.txt'
    $made = if (Test-Path -LiteralPath $sums) { (Get-Item -LiteralPath $sums).CreationTime } else { Get-Date }
    Write-SnapshotReadme $Readme $v $Game $made.ToString('yyyy-MM-dd HH:mm') ($Checks -replace '\\n', "`r`n")
    "README.txt written"
    exit 0
}

# ---- make a snapshot ----
$version = Get-GameVersion $Game
if (-not $version) { throw "Crossout.exe not found under $Game" }
if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(Crossout|Crossout-D3D11|launcher|gaijin_downloader|Crossout_BE)$' }) {
    throw 'Crossout or its launcher is running (it may be updating the files): close it first'
}
$name = 'Crossout ' + ($version -replace '\s*\(.*$', '')
$target = Join-Path $Dest $name
if (Test-Path -LiteralPath $target) { throw "$target already exists (this version is kept already; -Verify checks it)" }
New-Item -ItemType Directory -Force -Path $target | Out-Null
"copying Crossout $version to $target"
$made = (Get-Date).ToString('yyyy-MM-dd HH:mm')
$log = Join-Path $env:TEMP "crossout_archive_$PID.log"
robocopy $Game $target /E /COPY:DAT /DCOPY:DAT /R:2 /W:2 /J /XD $skipDirs /NP /NFL /NDL /LOG:$log | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE), see $log" }

"comparing every file with the install (SHA-256)"
$a = Get-Hashes $Game
$b = Get-Hashes $target
$diff = @($a.Keys | Where-Object { $b[$_] -ne $a[$_] }) + @($b.Keys | Where-Object { -not $a.ContainsKey($_) })
if ($diff.Count) { $diff | Select-Object -First 20; throw "$($diff.Count) files differ from the install" }
$lines = $b.Keys | Sort-Object | ForEach-Object { '{0} *{1}' -f $b[$_], $_.Replace('\', '/') }
[System.IO.File]::WriteAllLines((Join-Path $target 'SHA256SUMS.txt'), $lines, (New-Object System.Text.UTF8Encoding $false))
$checks = "- every file identical to the installed game (SHA-256 of all $($b.Count); the list is in SHA256SUMS.txt)"

if (Test-Path -LiteralPath $xotest) {
    "checking every file inside the archives against the MD5 the game's .index files record"
    $md5 = & $xotest --data (Join-Path $target 'data') md5 2>&1 | Select-String '^md5:'
    if ($md5 -notmatch ' 0 mismatches') { throw "archive check failed: $md5" }
    $checks += "`r`n- every file inside the readable archives matches the MD5 the game's own .index files record ($($md5 -replace '^md5: ', ''))"
    $scan = & $xotest --data (Join-Path $target 'data') scan 2>&1 | Select-String '^scan:'
    $checks += "`r`n- Grimcold reads it: $($scan -replace '^scan: ', '')"
}

Write-SnapshotReadme $target $version $Game $made $checks
Get-ChildItem -LiteralPath $target -Recurse -File -Force | ForEach-Object { $_.IsReadOnly = $true }
"done: $target"
