# Deletes the cluster and stops the hourly charge.
#
# Written in the same commit as cluster-up.ps1 and tested before the cluster is
# trusted to stay up. A teardown script nobody has run is not a teardown script;
# it is an intention.
#
# WHAT SURVIVES (deliberately):
#   - Artifact Registry images    pennies per month, and re-pushing costs minutes
#   - Pub/Sub topic and messages  free at this volume; queued work is not lost
#   - Secret Manager secrets      no charge for a handful of versions
#   - Neon Postgres               separate provider; the event history lives there
#
# WHAT IS LOST:
#   - The dependency PVC, so the first sandbox run next session re-installs.
#     ~20s for a small repository. If that ever hurts, bake the deps into an
#     image tagged by lockfile hash instead of a volume.
#
# Pass -All to remove the surviving resources too.

param(
  [switch]$All,
  [switch]$Yes
)

. "$PSScriptRoot\config.ps1"
Assert-Gcloud

$project = $SRECTL.Project
$region  = $SRECTL.Region
$cluster = $SRECTL.Cluster

Write-Host "`nAbout to delete:"
Write-Host "  cluster $cluster in $region  (this is what costs money)"
if ($All) {
  Write-Warn "  -All: also Artifact Registry, Pub/Sub topics, and the service account"
}

if (-not $Yes) {
  $answer = Read-Host "`nType the cluster name to confirm"
  if ($answer -ne $cluster) {
    Write-Host "Aborted - nothing was deleted." -ForegroundColor Yellow
    exit 1
  }
}

Write-Step "Deleting cluster (5-10 minutes)"
$exists = gcloud container clusters describe $cluster --region=$region --format="value(name)" 2>$null
if ($exists) {
  gcloud container clusters delete $cluster --region=$region --quiet
  Write-Note "deleted - the hourly charge has stopped"
} else {
  Write-Note "no cluster found; nothing to delete"
}

# Leaving a stale context behind means the next kubectl command silently talks
# to nothing, or worse, to the wrong cluster.
$context = "gke_${project}_${region}_${cluster}"
kubectl config delete-context $context 2>$null | Out-Null
kubectl config delete-cluster $context 2>$null | Out-Null
Write-Note "removed local kubectl context"

if ($All) {
  Write-Step "Removing the rest"

  # Each value goes into a plain variable first. PowerShell does not evaluate
  # property access inside a bare native-command argument, so
  # `$SRECTL.Subscription` is passed as the literal string
  # "System.Collections.Hashtable.Subscription" and the delete silently targets
  # a resource that does not exist - with 2>$null hiding the error, -All would
  # report success while removing nothing.
  $subscription = $SRECTL.Subscription
  $artifactRepo = $SRECTL.ArtifactRepo

  gcloud pubsub subscriptions delete $subscription --quiet 2>$null | Out-Null
  foreach ($topic in @($SRECTL.Topic, $SRECTL.DeadLetterTopic)) {
    gcloud pubsub topics delete $topic --quiet 2>$null | Out-Null
  }
  Write-Note "Pub/Sub removed"

  gcloud artifacts repositories delete $artifactRepo --location=$region --quiet 2>$null | Out-Null
  Write-Note "Artifact Registry removed"

  gcloud iam service-accounts delete (Get-ServiceAccountEmail) --quiet 2>$null | Out-Null
  Write-Note "service account removed"
}

Write-Host "`nRemaining billable resources:" -ForegroundColor Green
gcloud container clusters list --format="table(name,location,status)" 2>$null
Write-Host ""
Write-Host "Verify in the billing console that daily spend drops to Cloud Run and Pub/Sub only." -ForegroundColor Green
Write-Host "Bring it back with: infra\gcp\cluster-up.ps1" -ForegroundColor Green
