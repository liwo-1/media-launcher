[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PublishDirectory,

    [string]$ExecutableName = 'media-launcher-linux-agent',

    [Parameter(Mandatory = $true)]
    [ValidateSet('linux-x64', 'linux-arm64')]
    [string]$ExpectedRuntimeIdentifier,

    [string]$ExpectedVersion = '',

    [string]$ChecksumPath = '',

    [switch]$ExecuteVersionCheck
)

$ErrorActionPreference = 'Stop'

$directory = (Resolve-Path -LiteralPath $PublishDirectory).Path
$executable = Join-Path $directory $ExecutableName
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Published Linux-agent executable was not found: $executable"
}

$files = @(Get-ChildItem -LiteralPath $directory -Recurse -Force -File)
$relativeFiles = @($files | ForEach-Object {
    [System.IO.Path]::GetRelativePath($directory, $_.FullName).Replace('\', '/')
})
if ($relativeFiles.Count -ne 1 -or $relativeFiles[0] -ne $ExecutableName) {
    throw "The self-contained publish must contain exactly $ExecutableName; found: $($relativeFiles -join ', ')"
}

$item = Get-Item -LiteralPath $executable
if ($item.LinkType) {
    throw 'The published Linux agent must be a regular file, not a symbolic link.'
}
if ($item.Length -lt 10MB) {
    throw "The published executable is unexpectedly small ($($item.Length) bytes) and may not contain the runtime."
}

$bytes = [System.IO.File]::ReadAllBytes($executable)
if ($bytes.Length -lt 20 -or
    $bytes[0] -ne 0x7f -or $bytes[1] -ne 0x45 -or
    $bytes[2] -ne 0x4c -or $bytes[3] -ne 0x46) {
    throw 'The published artifact is not an ELF executable.'
}
if ($bytes[4] -ne 2 -or $bytes[5] -ne 1) {
    throw 'The published artifact must be a little-endian 64-bit ELF executable.'
}

$machine = [int]$bytes[18] + (256 * [int]$bytes[19])
$expectedMachine = if ($ExpectedRuntimeIdentifier -eq 'linux-x64') { 62 } else { 183 }
if ($machine -ne $expectedMachine) {
    throw "ELF machine '$machine' does not match $ExpectedRuntimeIdentifier (expected $expectedMachine)."
}

$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
foreach ($marker in @('libcoreclr.so', 'System.Private.CoreLib.dll', 'media-launcher-linux-agent.dll')) {
    if (-not $ascii.Contains($marker, [System.StringComparison]::Ordinal)) {
        throw "The published executable does not contain the self-contained bundle marker '$marker'."
    }
}
if ($ExpectedVersion -and -not $ascii.Contains($ExpectedVersion, [System.StringComparison]::Ordinal)) {
    throw "The published executable does not embed expected version '$ExpectedVersion'."
}
$ascii = $null
$bytes = $null

if ($IsLinux -and (($item.UnixFileMode -band [System.IO.UnixFileMode]::UserExecute) -eq 0)) {
    throw 'The published Linux agent is not executable by its owner.'
}

if ($ExecuteVersionCheck) {
    if (-not $IsLinux) {
        throw '-ExecuteVersionCheck can only run on Linux.'
    }
    $reportedVersion = (& $executable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "The published Linux agent --version command exited with $LASTEXITCODE."
    }
    if ($ExpectedVersion -and $reportedVersion -ne $ExpectedVersion) {
        throw "Artifact version '$reportedVersion' does not match expected version '$ExpectedVersion'."
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

Write-Output "Validated self-contained Linux agent: $ExecutableName ($ExpectedRuntimeIdentifier, $($item.Length) bytes, SHA256 $hash)"
