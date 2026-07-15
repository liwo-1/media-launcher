[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PublishDirectory,

    [string]$ExecutableName = 'MediaLauncherPlayerAgent.exe',

    [string]$ExpectedVersion = '',

    [string]$ChecksumPath = ''
)

$ErrorActionPreference = 'Stop'

$directory = (Resolve-Path -LiteralPath $PublishDirectory).Path
$executable = Join-Path $directory $ExecutableName
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Published player-agent executable was not found: $executable"
}

$files = @(Get-ChildItem -LiteralPath $directory -Recurse -Force -File)
$relativeFiles = @($files | ForEach-Object {
    [System.IO.Path]::GetRelativePath($directory, $_.FullName).Replace('\', '/')
})
if ($relativeFiles.Count -ne 1 -or $relativeFiles[0] -ne $ExecutableName) {
    throw "The self-contained publish must contain exactly $ExecutableName; found: $($relativeFiles -join ', ')"
}

$item = Get-Item -LiteralPath $executable
if ($item.Length -lt 10MB) {
    throw "The published executable is unexpectedly small ($($item.Length) bytes) and may not contain the runtime."
}

$stream = [System.IO.File]::OpenRead($executable)
try {
    $first = $stream.ReadByte()
    $second = $stream.ReadByte()
} finally {
    $stream.Dispose()
}
if ($first -ne 0x4d -or $second -ne 0x5a) {
    throw 'The published artifact is not a Windows PE executable.'
}

# A framework-dependent apphost does not embed CoreLib or the application assembly and is also far
# smaller than the size guard above. .NET 8 can compress native bundle entries, so the literal
# `coreclr.dll` filename is not guaranteed to survive even though the CoreCLR payload does. The
# runtime payload still contains `coreclr`, while the managed bundle manifest preserves the other
# two exact assembly names. Together these checks catch accidental removal of SelfContained or
# PublishSingleFile without rejecting a valid compressed single-file bundle.
$bytes = [System.IO.File]::ReadAllBytes($executable)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
foreach ($marker in @('coreclr', 'System.Private.CoreLib.dll', 'MediaLauncherPlayerAgent.dll')) {
    if (-not $ascii.Contains($marker, [System.StringComparison]::Ordinal)) {
        throw "The published executable does not contain the self-contained bundle marker '$marker'."
    }
}
$ascii = $null
$bytes = $null

if ($ExpectedVersion) {
    $productVersion = $item.VersionInfo.ProductVersion
    if (-not $productVersion -or -not $productVersion.StartsWith($ExpectedVersion, [System.StringComparison]::Ordinal)) {
        throw "Artifact version '$productVersion' does not match expected version '$ExpectedVersion'."
    }
}

$hash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ChecksumPath) {
    $checksumFullPath = [System.IO.Path]::GetFullPath($ChecksumPath)
    $checksumParent = Split-Path -Parent $checksumFullPath
    if (-not (Test-Path -LiteralPath $checksumParent)) {
        New-Item -ItemType Directory -Path $checksumParent -Force | Out-Null
    }
    Set-Content -LiteralPath $checksumFullPath -Value "$hash *$ExecutableName" -Encoding ascii
}

Write-Output "Validated self-contained player agent: $ExecutableName ($($item.Length) bytes, SHA256 $hash)"
