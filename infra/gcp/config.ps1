# Shared settings for every GCP script.
#
# One place, because a region typo spread across four scripts creates resources
# in two regions and bills for both until someone notices.
#
# Targets Windows PowerShell 5.1, which is what ships with Windows and what is
# actually installed here. That rules out `??`, `?:` and `?.` - they are a
# parse error, not a runtime one, so a script using them fails before it prints
# anything.

$ErrorActionPreference = "Stop"

function Get-EnvOr {
  param([string]$Name, [string]$Default)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}

$SRECTL = @{
  Project = Get-EnvOr "SRECTL_PROJECT" "srectl"

  # Mumbai: closest to the operator, so kubectl and image pushes are not
  # crossing an ocean. Every resource pins this explicitly rather than
  # inheriting a gcloud default that may differ.
  Region = Get-EnvOr "SRECTL_REGION" "asia-south1"

  Cluster         = "srectl"
  ArtifactRepo    = "srectl"
  RunnerImageName = "srectl-runner"

  # Pub/Sub replaces the Postgres queue once ingest runs on Cloud Run and the
  # orchestrator runs in-cluster.
  Topic           = "srectl-jobs"
  Subscription    = "srectl-jobs-orchestrator"
  DeadLetterTopic = "srectl-jobs-dead"

  ServiceAccount  = "srectl-orchestrator"
}

function Get-ArtifactHost {
  return ($SRECTL.Region + "-docker.pkg.dev")
}

function Get-RunnerImageBase {
  return ((Get-ArtifactHost) + "/" + $SRECTL.Project + "/" + $SRECTL.ArtifactRepo + "/" + $SRECTL.RunnerImageName)
}

function Get-ServiceAccountEmail {
  return ($SRECTL.ServiceAccount + "@" + $SRECTL.Project + ".iam.gserviceaccount.com")
}

function Assert-Gcloud {
  if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw "gcloud is not on PATH. Open a new shell after installing the SDK."
  }
  $current = (gcloud config get-value project 2>$null)
  if ($current -ne $SRECTL.Project) {
    throw ("gcloud project is '" + $current + "', expected '" + $SRECTL.Project + "'. Run: gcloud config set project " + $SRECTL.Project)
  }
}

<#
  Runs gcloud and fails on a non-zero exit code.

  Windows PowerShell 5.1 treats a native command's stderr as an error stream,
  and gcloud writes ordinary progress there ("Listing items under project...").
  With ErrorActionPreference = Stop that can abort a script in the middle of
  creating a cluster, leaving half-built infrastructure and a bill. The exit
  code is the only reliable signal, so that is what is checked.
#>
function Invoke-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)

  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & gcloud @Args
    if ($LASTEXITCODE -ne 0) {
      throw ("gcloud " + ($Args -join " ") + " failed with exit code " + $LASTEXITCODE)
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

<# Probe: returns $true when the resource exists, never throws. #>
function Test-GcloudResource {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)

  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & gcloud @Args 2>$null
    return ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($out | Out-String)))
  } finally {
    $ErrorActionPreference = $previous
  }
}

<#
  Runs a gcloud command that may fail purely because IAM has not caught up.

  Google's IAM is eventually consistent: a service account created one line
  earlier can still return "Service account ... does not exist" when it is used
  as a binding member. That is not a real error and retrying fixes it, but
  without this the whole deploy aborts after successfully pushing two images.
#>
function Invoke-GcloudEventuallyConsistent {
  # ValueFromRemainingArguments must be the ONLY parameter here. Adding a
  # second one made PowerShell bind the first gcloud word positionally to it -
  # "Cannot convert value 'projects' to type System.Int32".
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GcloudArgs)

  $attempts = 6
  for ($i = 1; $i -le $attempts; $i++) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & gcloud @GcloudArgs 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { return }
    } finally {
      $ErrorActionPreference = $previous
    }

    if ($i -eq $attempts) {
      throw ("gcloud " + ($GcloudArgs -join " ") + " still failing after " + $attempts + " attempts")
    }
    Write-Note ("IAM not settled yet, retrying in " + (2 * $i) + "s")
    Start-Sleep -Seconds (2 * $i)
  }
}

function Write-Step { param([string]$Text) Write-Host ("`n>> " + $Text) -ForegroundColor Cyan }
function Write-Note { param([string]$Text) Write-Host ("   " + $Text) -ForegroundColor DarkGray }
function Write-Warn { param([string]$Text) Write-Host ("   " + $Text) -ForegroundColor Yellow }
