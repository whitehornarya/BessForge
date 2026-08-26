# BESSForge — one-command complete Windows release build.
#
# Usage (from the repo root, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
# or double-click scripts\build-installer.bat
#
# Detects missing prerequisites (Node.js, Rust/MSVC toolchain, Visual Studio
# Build Tools, WebView2 runtime, NSIS, and 7-Zip) and offers to auto-install them via
# winget / rustup after ONE confirmation prompt.
#
# Output: dist\release\BESSForge_Complete_Release_<version>.zip

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Find-SevenZip {
    $command = Get-Command 7z -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:ProgramFiles\7-Zip\7z.exe",
        "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

Write-Host ''
Write-Host '=== BESSForge Windows installer build ===' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- detection
$missing = @()

$hasSupportedNode = $false
if (Test-Command node) {
    $nodeParts = (node -p "process.versions.node").Split('.')
    $nodeMajor = [int]$nodeParts[0]
    $nodeMinor = [int]$nodeParts[1]
    $hasSupportedNode = ($nodeMajor -gt 22) -or ($nodeMajor -eq 22 -and $nodeMinor -ge 12)
}
if (-not $hasSupportedNode) { $missing += 'Node.js 22.12 or newer (LTS)' }

# Rust toolchain: cargo on PATH, or installed but PATH not refreshed
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Test-Command cargo) -and -not (Test-Path (Join-Path $cargoBin 'cargo.exe'))) {
    $missing += 'Rust toolchain (rustup + MSVC target)'
}

# Visual Studio Build Tools (C++ workload) via vswhere
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVctools = $false
if (Test-Path $vswhere) {
    $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath 2>$null
    if ($found) { $hasVctools = $true }
}
if (-not $hasVctools) { $missing += 'Visual Studio Build Tools (C++ workload)' }

# WebView2 runtime (per-machine or per-user registry key)
$wv2Keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$hasWv2 = $false
foreach ($k in $wv2Keys) { if (Test-Path $k) { $hasWv2 = $true; break } }
if (-not $hasWv2) { $missing += 'Microsoft Edge WebView2 runtime' }

# NSIS compiler for the self-contained Electron installer.
$nsisCandidates = @(
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "$env:ProgramFiles\NSIS\makensis.exe"
)
$hasNsis = Test-Command makensis
foreach ($candidate in $nsisCandidates) {
    if ($candidate -and (Test-Path $candidate)) { $hasNsis = $true; break }
}
if (-not $hasNsis) { $missing += 'NSIS compiler' }

$sevenZipExe = Find-SevenZip
if (-not $sevenZipExe) { $missing += '7-Zip archive extractor' }

# ------------------------------------------------------------- installation
if ($missing.Count -gt 0) {
    Write-Host 'Missing prerequisites:' -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  - $_" }
    Write-Host ''
    Write-Host 'First-time setup downloads roughly 2-4 GB.'
    $answer = Read-Host 'Install all of the above automatically now? [Y/n]'
    if ($answer -and $answer -notmatch '^[Yy]') {
        Write-Host ''
        Write-Host 'Manual install links:' -ForegroundColor Yellow
        Write-Host '  Node.js LTS:        https://nodejs.org/'
        Write-Host '  Rust (rustup):      https://rustup.rs/'
        Write-Host '  VS Build Tools:     https://visualstudio.microsoft.com/visual-cpp-build-tools/  (select "Desktop development with C++")'
        Write-Host '  WebView2 runtime:   https://developer.microsoft.com/microsoft-edge/webview2/'
        Write-Host '  NSIS:               https://nsis.sourceforge.io/'
        Write-Host '  7-Zip:              https://www.7-zip.org/'
        exit 1
    }

    $winget = Test-Command winget
    if (-not $winget) {
        Write-Host ''
        Write-Host 'winget is not available (blocked by policy or not installed).' -ForegroundColor Red
        Write-Host 'Install the prerequisites manually, then re-run this script:'
        Write-Host '  Node.js LTS:        https://nodejs.org/'
        Write-Host '  Rust (rustup):      https://rustup.rs/'
        Write-Host '  VS Build Tools:     https://visualstudio.microsoft.com/visual-cpp-build-tools/  (select "Desktop development with C++")'
        Write-Host '  WebView2 runtime:   https://developer.microsoft.com/microsoft-edge/webview2/'
        Write-Host '  NSIS:               https://nsis.sourceforge.io/'
        Write-Host '  7-Zip:              https://www.7-zip.org/'
        exit 1
    }

    foreach ($item in $missing) {
        switch -Wildcard ($item) {
            'Node.js*' {
                Write-Host '-> Installing Node.js LTS (winget)...' -ForegroundColor Cyan
                winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
                if ($LASTEXITCODE -ne 0) { throw 'Node.js install failed. Manual: https://nodejs.org/' }
            }
            'Rust*' {
                Write-Host '-> Installing Rust toolchain (winget rustup)...' -ForegroundColor Cyan
                winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
                if ($LASTEXITCODE -ne 0) { throw 'Rustup install failed. Manual: https://rustup.rs/' }
            }
            'Visual Studio*' {
                Write-Host '-> Installing VS Build Tools + C++ workload (winget, needs admin elevation)...' -ForegroundColor Cyan
                winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
                if ($LASTEXITCODE -ne 0) { throw 'VS Build Tools install failed. Manual: https://visualstudio.microsoft.com/visual-cpp-build-tools/ (select "Desktop development with C++")' }
            }
            'Microsoft Edge WebView2*' {
                Write-Host '-> Installing WebView2 runtime (winget)...' -ForegroundColor Cyan
                winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
                if ($LASTEXITCODE -ne 0) { throw 'WebView2 install failed. Manual: https://developer.microsoft.com/microsoft-edge/webview2/' }
            }
            'NSIS*' {
                Write-Host '-> Installing NSIS (winget)...' -ForegroundColor Cyan
                winget install --id NSIS.NSIS -e --accept-source-agreements --accept-package-agreements
                if ($LASTEXITCODE -ne 0) { throw 'NSIS install failed. Manual: https://nsis.sourceforge.io/' }
            }
            '7-Zip*' {
                Write-Host '-> Installing 7-Zip (winget)...' -ForegroundColor Cyan
                winget install --id 7zip.7zip -e --accept-source-agreements --accept-package-agreements
                if ($LASTEXITCODE -ne 0) { throw '7-Zip install failed. Manual: https://www.7-zip.org/' }
            }
        }
    }

    # Refresh PATH for tools installed in this session
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }

    if (-not (Test-Command cargo)) {
        Write-Host ''
        Write-Host 'cargo is still not on PATH. Close this window, open a NEW terminal, and re-run the script.' -ForegroundColor Yellow
        exit 1
    }
    $sevenZipExe = Find-SevenZip
    if (-not $sevenZipExe) {
        Write-Host ''
        Write-Host '7-Zip is still unavailable. Close this window, open a NEW terminal, and re-run the script.' -ForegroundColor Yellow
        exit 1
    }
    # Make sure the MSVC toolchain is the default target
    rustup default stable-x86_64-pc-windows-msvc 2>$null | Out-Null
}

# ---------------------------------------------------------------------- build
Write-Host ''
Write-Host 'Prerequisites OK:' -ForegroundColor Green
Write-Host "  node  $(node --version)"
Write-Host "  cargo $(cargo --version)"
& $sevenZipExe i | Out-Null
if ($LASTEXITCODE -ne 0) { throw '7-Zip verification failed' }
Write-Host "  7-Zip $sevenZipExe"
Write-Host ''

if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Host '-> npm ci (first run)...' -ForegroundColor Cyan
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}

Write-Host '-> Building and auditing every release format...' -ForegroundColor Cyan
npm run package:complete
if ($LASTEXITCODE -ne 0) { throw 'complete release build failed' }

Write-Host ''
Write-Host '=== Build complete ===' -ForegroundColor Green
Get-ChildItem (Join-Path $RepoRoot 'dist\release') -Include *.zip, *.sha256 |
    ForEach-Object { Write-Host "  $($_.FullName)  ($([math]::Round($_.Length / 1MB, 1)) MB)" }
Write-Host ''
Write-Host 'Distribute the complete ZIP; it contains every installer and package.'
