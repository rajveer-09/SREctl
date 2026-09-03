# Creates the Secret Manager secrets and loads their values from .env.
#
# This step used to be manual, and it failed silently: `gcloud secrets versions
# add` errors were piped to $null and the exit code was never checked, so four
# empty secrets were reported as created. The service then failed at startup
# with "not found or has no versions", which reads like a missing secret rather
# than a missing value.
#
# So every write here is checked twice: the exit code, and a read-back compared
# against the source length. Idempotent - re-running adds a new version only
# when the value actually differs.

param([string]$EnvFile)

. "$PSScriptRoot\config.ps1"
Assert-Gcloud

$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot ".env" }
if (-not (Test-Path $EnvFile)) { throw "no .env at $EnvFile - cannot load secret values" }

# Read as UTF-8 explicitly. Get-Content defaults to the ANSI codepage, which
# corrupts any non-ASCII byte in a password before it reaches Secret Manager.
$envMap = @{}
foreach ($line in [IO.File]::ReadAllLines($EnvFile, [Text.UTF8Encoding]::new($false))) {
  if ($line -match '^\s*#') { continue }
  $i = $line.IndexOf('=')
  if ($i -lt 1) { continue }
  $envMap[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1)
}

# Mirrors SECRETS in packages/core/src/secrets.ts.
$pairs = @(
  @{ Secret = "github-webhook-secret"; Key = "GITHUB_WEBHOOK_SECRET" },
  @{ Secret = "github-token";          Key = "GITHUB_TOKEN" },
  @{ Secret = "gemini-api-key";        Key = "GEMINI_API_KEY" },
  @{ Secret = "database-url";          Key = "DATABASE_URL" }
)

Write-Step "Secret Manager secrets"
$failures = 0

foreach ($p in $pairs) {
  # Pulled into plain variables first. PowerShell does not evaluate property
  # access inside a bare native-command argument: `$p.Secret` is passed as the
  # literal "System.Collections.Hashtable.Secret".
  $secretId = $p.Secret
  $envKey   = $p.Key
  $value    = $envMap[$envKey]

  if ([string]::IsNullOrEmpty($value)) {
    Write-Host ("  MISSING  " + $envKey + " has no value in " + $EnvFile) -ForegroundColor Red
    $failures++
    continue
  }

  if (-not (Test-GcloudResource secrets describe $secretId --format="value(name)")) {
    Invoke-Gcloud secrets create $secretId --replication-policy=automatic --quiet | Out-Null
  }

  $current = (& gcloud secrets versions access latest --secret=$secretId 2>$null)
  if ($LASTEXITCODE -eq 0 -and $current -eq $value) {
    Write-Host ("  ok       " + $secretId + " already current") -ForegroundColor DarkGray
    continue
  }

  # A temp file, not --data-file=-, because piping through PowerShell appends a
  # trailing newline and re-encodes; an HMAC secret with a stray \n verifies
  # every signature as invalid.
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), [Guid]::NewGuid().ToString() + ".secret")
  try {
    [IO.File]::WriteAllText($tmp, $value, [Text.UTF8Encoding]::new($false))
    & gcloud secrets versions add $secretId --data-file="$tmp" --quiet | Out-Null
    $addCode = $LASTEXITCODE
  }
  finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }

  if ($addCode -ne 0) {
    Write-Host ("  FAILED   " + $secretId + " version add exited " + $addCode) -ForegroundColor Red
    $failures++
    continue
  }

  $readBack = (& gcloud secrets versions access latest --secret=$secretId 2>$null)
  if ($LASTEXITCODE -ne 0) {
    Write-Host ("  FAILED   " + $secretId + " stored but not readable") -ForegroundColor Red
    $failures++
  }
  elseif ($readBack -ne $value) {
    Write-Host ("  MISMATCH " + $secretId + " read back " + $readBack.Length + " chars, expected " + $value.Length) -ForegroundColor Red
    $failures++
  }
  else {
    Write-Host ("  wrote    " + $secretId + " (" + $value.Length + " chars, verified)") -ForegroundColor Green
  }
}

if ($failures -gt 0) { throw "$failures secret(s) not usable - fix these before deploying" }
Write-Note "all secrets present and verified by read-back"
