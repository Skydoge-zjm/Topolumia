param(
  [string]$Python = "3.12",
  [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$MvpRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Venv = Join-Path $MvpRoot ".venv-test"
$LockFile = Join-Path $MvpRoot "requirements\experiment-tracking-test.lock.txt"
$InputFile = Join-Path $MvpRoot "requirements\experiment-tracking-test.in"
$PythonExe = if ($IsWindows -or $env:OS -eq "Windows_NT") {
  Join-Path $Venv "Scripts\python.exe"
} else {
  Join-Path $Venv "bin/python"
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "uv is required to create the isolated test environment."
}

if ($Rebuild -and (Test-Path -LiteralPath $Venv)) {
  $ResolvedRoot = [System.IO.Path]::GetFullPath($MvpRoot)
  $ResolvedVenv = [System.IO.Path]::GetFullPath($Venv)
  if (-not $ResolvedVenv.StartsWith($ResolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a virtual environment outside the MVP workspace."
  }
  Remove-Item -LiteralPath $ResolvedVenv -Recurse -Force
}

if (-not (Test-Path -LiteralPath $PythonExe)) {
  & uv venv --python $Python $Venv
  if ($LASTEXITCODE -ne 0) { throw "uv venv failed" }
}

if (-not (Test-Path -LiteralPath $LockFile)) {
  & uv pip compile --python-version 3.12 --output-file $LockFile $InputFile
  if ($LASTEXITCODE -ne 0) { throw "uv pip compile failed" }
}

& uv pip sync --python $PythonExe $LockFile
if ($LASTEXITCODE -ne 0) { throw "uv pip sync failed" }

& $PythonExe (Join-Path $MvpRoot "scripts\integration\verify-experiment-test-env.py") --probe
if ($LASTEXITCODE -ne 0) { throw "experiment test environment probe failed" }

Write-Output "Experiment test environment ready: $PythonExe"
