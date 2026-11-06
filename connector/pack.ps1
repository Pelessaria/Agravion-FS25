# Packs FS25_AgravionConnector for dedicated-server install (ZIP root = mod files).
# IMPORTANT: entry names must use forward slashes — Compress-Archive writes backslashes
# which GIANTS cannot resolve. Lua lives at ZIP root (AgravionConnector.lua).
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root "FS25_AgravionConnector"
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "FS25_AgravionConnector.zip"

if (-not (Test-Path (Join-Path $src "modDesc.xml"))) {
  throw "modDesc.xml missing in $src"
}
if (-not (Test-Path (Join-Path $src "AgravionConnector.lua"))) {
  throw "AgravionConnector.lua missing in $src (must be at mod root)"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $src -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/]src[\\/]' } |
    ForEach-Object {
      $relative = $_.FullName.Substring($src.Length).TrimStart('\', '/')
      $entryName = ($relative -replace '\\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
    }
} finally {
  $archive.Dispose()
}

# Verify forward-slash paths (fail pack if Windows backslashes leaked in).
$check = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $bad = @($check.Entries | Where-Object { $_.FullName -match '\\' })
  if ($bad.Count -gt 0) {
    throw ("ZIP has backslash entries (GIANTS will fail): " + (($bad | ForEach-Object FullName) -join ', '))
  }
  $lua = $check.GetEntry('AgravionConnector.lua')
  if ($null -eq $lua) {
    throw "ZIP missing AgravionConnector.lua at root"
  }
} finally {
  $check.Dispose()
}

# Also ship inside the Laravel tree so in-app updates / FTP deploy find the zip.
$backendPackageDir = Join-Path (Split-Path $root -Parent) "backend\resources\connector"
New-Item -ItemType Directory -Force -Path $backendPackageDir | Out-Null
Copy-Item -Force $zip (Join-Path $backendPackageDir "FS25_AgravionConnector.zip")

Write-Host "Packed: $zip"
Write-Host "Copied to backend/resources/connector/ for dashboard deploy"
Get-Item $zip | Format-List FullName, Length, LastWriteTime
