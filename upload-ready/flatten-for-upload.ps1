# =====================================================================
# flatten-for-upload.ps1
#
# Copies your project into a flat "upload-ready" folder, renaming each
# file to include its folder path -- so duplicate names like index.js
# become unique (e.g. src-admin-pages-index.js) and you can tell at a
# glance where each file came from.
#
# IMPORTANT: This only COPIES files. Your original project folder is
# never modified, moved, or deleted.
#
# USAGE:
#   1. Edit $SourceDir and $OutputDir below if needed
#   2. Right-click this file -> Run with PowerShell
#      (or open PowerShell in this folder and run: .\flatten-for-upload.ps1)
# =====================================================================

# ---- CONFIG: edit these two paths ----
$SourceDir = "."                 # path to your project root (default: current folder)
$OutputDir = ".\upload-ready"    # where the flattened copies will go

# Folders to skip entirely (common build/dependency junk you don't want uploaded)
$ExcludeDirs = @(
    "node_modules", ".git", ".next", "dist", "build", "out",
    "vendor", ".vscode", ".idea", "coverage", "__pycache__", ".venv", "venv"
)

# ---- SCRIPT ----
$SourceDir = (Resolve-Path $SourceDir).Path
if (Test-Path $OutputDir) {
    Write-Host "Output folder already exists: $OutputDir"
    $confirm = Read-Host "Clear it and start fresh? (y/n)"
    if ($confirm -eq 'y') {
        Remove-Item $OutputDir -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

# Build a regex to exclude unwanted directories from the walk
$excludePattern = ($ExcludeDirs | ForEach-Object { [regex]::Escape($_) }) -join '|'

$files = Get-ChildItem -Path $SourceDir -Recurse -File | Where-Object {
    $relPath = $_.FullName.Substring($SourceDir.Length).TrimStart('\','/')
    # skip if any path segment matches an excluded dir
    -not ($relPath -split '[\\/]' | Where-Object { $_ -match "^($excludePattern)$" })
}

$count = 0
$nameMap = @{}  # track collisions just in case

foreach ($file in $files) {
    $relPath = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
    $relPath = $relPath -replace '\\', '/'

    # Flatten: replace / with - to build the new filename
    $flatName = $relPath -replace '/', '-'

    # Handle the (rare) case where flattening still collides
    $finalName = $flatName
    if ($nameMap.ContainsKey($finalName)) {
        $nameMap[$finalName]++
        $ext = [System.IO.Path]::GetExtension($flatName)
        $base = [System.IO.Path]::GetFileNameWithoutExtension($flatName)
        $finalName = "$base`_$($nameMap[$flatName])$ext"
    } else {
        $nameMap[$finalName] = 0
    }

    $destPath = Join-Path $OutputDir $finalName
    Copy-Item -Path $file.FullName -Destination $destPath -Force
    $count++
}

Write-Host ""
Write-Host "Done. Copied $count files into: $OutputDir" -ForegroundColor Green
Write-Host "Your original project folder was not modified." -ForegroundColor Green
Write-Host ""
Write-Host "Next step: open the '$OutputDir' folder and drag its contents into your Claude Project's knowledge."
