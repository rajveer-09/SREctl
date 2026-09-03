# Builds, pushes and deploys ingest (Cloud Run) and the orchestrator (GKE).
#
# Run cluster-up.ps1 first. This script creates nothing that bills by the hour:
# Cloud Run scales to zero, and the orchestrator is one small pod on a cluster
# that already exists.
#
# Idempotent - re-running redeploys with a fresh image tag.

param([switch]$SkipBuild)

. "$PSScriptRoot\config.ps1"
Assert-Gcloud

$project = $SRECTL.Project
$region  = $SRECTL.Region
$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
$registry = Get-ArtifactHost
$tag = (Get-Date -Format "yyyyMMdd-HHmmss")

Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    Write-Step "Bundling apps"
    # Not --experimental-strip-types: this codebase uses constructor parameter
    # properties, which are not erasable syntax, so a strip-types image fails
    # at startup instead of at build time.
    & pnpm build:apps
    if ($LASTEXITCODE -ne 0) { throw "pnpm build:apps failed" }
  }

  Write-Step "Docker auth for Artifact Registry"
  Invoke-Gcloud auth configure-docker $registry --quiet | Out-Null

  $ingestImage = "$registry/$project/$($SRECTL.ArtifactRepo)/srectl-ingest:$tag"
  $orchImage   = "$registry/$project/$($SRECTL.ArtifactRepo)/srectl-orchestrator:$tag"

  Write-Step "Building and pushing images"
  # Each value is pulled into its own variable first. PowerShell does NOT do
  # property access inside a bare native-command argument: `$img.file` is
  # passed as the literal "System.Collections.Hashtable.file", and `-t $img`
  # produced the tag "System.Collections.Hashtable".
  $builds = @(
    @{ image = $ingestImage; file = "infra/docker/ingest.Dockerfile" },
    @{ image = $orchImage;   file = "infra/docker/orchestrator.Dockerfile" }
  )
  foreach ($b in $builds) {
    $image = $b.image
    $file  = $b.file

    & docker build -t $image -f $file .
    if ($LASTEXITCODE -ne 0) { throw "docker build failed for $file" }
    & docker push $image
    if ($LASTEXITCODE -ne 0) { throw "docker push failed for $image" }
    Write-Note "pushed $image"
  }

  # --- Cloud Run service account -------------------------------------------
  # Separate from the orchestrator's: ingest only needs to publish and read
  # secrets. It never touches the cluster, so it is never granted access to it.
  Write-Step "Cloud Run service account"
  $ingestSa = "srectl-ingest@$project.iam.gserviceaccount.com"
  if (-not (Test-GcloudResource iam service-accounts describe $ingestSa --format="value(email)")) {
    Invoke-Gcloud iam service-accounts create srectl-ingest --display-name="SREctl ingest" | Out-Null
  }
  Invoke-GcloudEventuallyConsistent projects add-iam-policy-binding $project --member="serviceAccount:$ingestSa" --role=roles/pubsub.publisher --condition=None --quiet | Out-Null

  # Accessor is granted per secret, not project-wide. A project-wide binding
  # would let the internet-facing service read the Gemini key and the GitHub
  # write token, neither of which it uses - see loadSecrets({ only: ... }) in
  # apps/ingest/src/server.ts. Secret Manager reports a missing binding as
  # NOT_FOUND rather than PERMISSION_DENIED, so getting this wrong looks
  # exactly like a secret that was never created.
  foreach ($secretId in @("github-webhook-secret", "database-url")) {
    Invoke-GcloudEventuallyConsistent secrets add-iam-policy-binding $secretId --member="serviceAccount:$ingestSa" --role=roles/secretmanager.secretAccessor --condition=None --quiet | Out-Null
  }
  Write-Note "pubsub.publisher; secretAccessor on github-webhook-secret, database-url"

  # --- Cloud Run -------------------------------------------------------------
  Write-Step "Deploying ingest to Cloud Run"
  # DATA_DIR=/tmp because a Cloud Run filesystem is read-only apart from /tmp,
  # and the delivery-ID dedupe log has to be writable.
  Invoke-Gcloud run deploy srectl-ingest `
    --image=$ingestImage `
    --region=$region `
    --platform=managed `
    --allow-unauthenticated `
    --service-account=$ingestSa `
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$project,SRECTL_PUBSUB_TOPIC=$($SRECTL.Topic),TARGET_REPO=$env:TARGET_REPO,DATA_DIR=/tmp,LOG_LEVEL=info" `
    --min-instances=0 `
    --max-instances=3 `
    --cpu=1 `
    --memory=512Mi `
    --timeout=60s `
    --quiet | Out-Null

  $url = (gcloud run services describe srectl-ingest --region=$region --format="value(status.url)" 2>$null)
  Write-Note "ingest: $url"

  # --- Orchestrator on GKE ---------------------------------------------------
  Write-Step "Deploying orchestrator to GKE"
  $manifest = Get-Content "$PSScriptRoot\..\k8s\gke\orchestrator.yaml" -Raw
  $manifest = $manifest.Replace("IMAGE_PLACEHOLDER", $orchImage)
  $manifest = $manifest.Replace("PROJECT_PLACEHOLDER", $project)
  $manifest = $manifest.Replace("SUBSCRIPTION_PLACEHOLDER", $SRECTL.Subscription)
  $manifest = $manifest.Replace("TOPIC_PLACEHOLDER", $SRECTL.Topic)
  $manifest = $manifest.Replace("REPO_PLACEHOLDER", $env:TARGET_REPO)
  $manifest = $manifest.Replace("RUNNER_IMAGE_PLACEHOLDER", (Get-Content "$repoRoot\.runner-image" -Raw).Trim())

  $tmp = New-TemporaryFile
  Set-Content -Path $tmp.FullName -Value $manifest -Encoding utf8
  & kubectl apply -f $tmp.FullName
  Remove-Item $tmp.FullName -Force

  & kubectl rollout status deployment/srectl-orchestrator --timeout=180s

  Write-Host "`nDeployed." -ForegroundColor Green
  Write-Host "  ingest       $url" -ForegroundColor Green
  Write-Host "  orchestrator in-cluster Deployment" -ForegroundColor Green
  Write-Host "`nPoint the GitHub webhook at $url/webhook" -ForegroundColor Green
}
finally {
  Pop-Location
}
