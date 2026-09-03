# Creates the GKE cluster and everything it needs to run a sandbox job.
#
# THIS SCRIPT STARTS THE METER. Read it before running it.
#
# Idempotent: every step checks for the resource first, so re-running after a
# partial failure continues rather than erroring. That matters because cluster
# creation takes 10-15 minutes and failing halfway through is normal.
#
# Autopilot rather than Standard, for one reason that is not about cost:
# Dataplane V2 enforces NetworkPolicy by default, so the isolation guarantees
# proven on Minikube+Calico carry over unchanged. A Standard cluster without
# the right addon applies our policies and enforces nothing - the same silent
# failure vanilla Minikube has, which is the worst outcome available.

. "$PSScriptRoot\config.ps1"
Assert-Gcloud

$project = $SRECTL.Project
$region  = $SRECTL.Region
$cluster = $SRECTL.Cluster

Write-Host "`nProject : $project"
Write-Host "Region  : $region"
Write-Host "Cluster : $cluster"
Write-Warn "GKE bills hourly from creation until deletion. Run cluster-down.ps1 when you stop."

# --- Artifact Registry -------------------------------------------------------
# Needed before the cluster is useful: on Minikube the runner image was side-
# loaded with `minikube image load` and pulled with imagePullPolicy: Never.
# A GKE node has no such local store, so the image has to come from a registry.
Write-Step "Artifact Registry repository"
if (Test-GcloudResource artifacts repositories describe $SRECTL.ArtifactRepo --location=$region --format="value(name)") {
  Write-Note "already exists"
} else {
  Invoke-Gcloud artifacts repositories create $SRECTL.ArtifactRepo --repository-format=docker --location=$region --description="SREctl sandbox runner images"
  Write-Note "created"
}

# --- Pub/Sub -----------------------------------------------------------------
# Ingest on Cloud Run cannot reach a Postgres queue inside the cluster without
# VPC plumbing, and should not need to: the queue is the boundary between a
# request that must answer in 10s and work that takes minutes.
Write-Step "Pub/Sub topic and subscription"
foreach ($topic in @($SRECTL.Topic, $SRECTL.DeadLetterTopic)) {
  if (Test-GcloudResource pubsub topics describe $topic --format="value(name)") {
    Write-Note "topic $topic exists"
  } else {
    Invoke-Gcloud pubsub topics create $topic
    Write-Note "topic $topic created"
  }
}

if (Test-GcloudResource pubsub subscriptions describe $SRECTL.Subscription --format="value(name)") {
  Write-Note "subscription exists"
} else {
  # ackDeadline is 600s (the maximum) because a review takes minutes: a shorter
  # deadline redelivers the job while the first attempt is still running, and
  # the pull request gets reviewed twice.
  Invoke-Gcloud pubsub subscriptions create $SRECTL.Subscription --topic=$($SRECTL.Topic) --ack-deadline=600 --dead-letter-topic=$($SRECTL.DeadLetterTopic) --max-delivery-attempts=5
  Write-Note "subscription created (600s ack deadline, dead-letters after 5 attempts)"
}

# --- Secrets -----------------------------------------------------------------
# Secrets must exist before anything can be granted access to them, and a
# per-secret binding against a secret that does not exist fails the whole run.
& "$PSScriptRoot\secrets-up.ps1"
if ($LASTEXITCODE -ne 0) { throw "secrets-up.ps1 failed" }

# --- Service account ---------------------------------------------------------
Write-Step "Orchestrator service account"
$saEmail = Get-ServiceAccountEmail
if (Test-GcloudResource iam service-accounts describe $saEmail --format="value(email)") {
  Write-Note "already exists"
} else {
  Invoke-Gcloud iam service-accounts create $SRECTL.ServiceAccount --display-name="SREctl orchestrator"
  Write-Note "created"
}

# Least privilege: pull jobs, read the secrets it was given, write logs.
# No cluster admin, no storage, no ability to create infrastructure.
foreach ($role in @("roles/pubsub.subscriber", "roles/logging.logWriter")) {
  Invoke-GcloudEventuallyConsistent projects add-iam-policy-binding $project --member="serviceAccount:$saEmail" --role=$role --condition=None --quiet | Out-Null
}

# Accessor per secret rather than project-wide, matching the split in
# loadSecrets({ only: ... }). The orchestrator never needs the webhook signing
# secret: only ingest verifies signatures.
foreach ($secretId in @("database-url", "gemini-api-key", "github-token")) {
  Invoke-GcloudEventuallyConsistent secrets add-iam-policy-binding $secretId --member="serviceAccount:$saEmail" --role=roles/secretmanager.secretAccessor --condition=None --quiet | Out-Null
}
Write-Note "roles bound: pubsub.subscriber, logging.logWriter; secretAccessor on database-url, gemini-api-key, github-token"

# --- Cluster -----------------------------------------------------------------
Write-Step "GKE Autopilot cluster (this takes 10-15 minutes)"
if (Test-GcloudResource container clusters describe $cluster --region=$region --format="value(name)") {
  Write-Note "already exists - skipping creation"
} else {
  Write-Warn "creating now; billing starts here"
  # No --workload-pool here: Autopilot enables Workload Identity unconditionally
  # with pool PROJECT.svc.id.goog, and create-auto rejects the flag outright.
  # It only exists on Standard clusters, where the feature is optional.
  Invoke-Gcloud container clusters create-auto $cluster --region=$region --release-channel=regular
  Write-Note "created"
}

# Verified rather than assumed: the binding below hard-codes this pool, and a
# mismatch would fail later as an opaque permissions error rather than here.
$pool = (gcloud container clusters describe $cluster --region=$region --format="value(workloadIdentityConfig.workloadPool)" 2>$null)
$expected = $project + ".svc.id.goog"
if ($pool -ne $expected) {
  throw ("workload identity pool is '" + $pool + "', expected '" + $expected + "'")
}
Write-Note ("workload identity pool: " + $pool)

Write-Step "kubectl credentials"
Invoke-Gcloud container clusters get-credentials $cluster --region=$region | Out-Null
Write-Note "context: $(kubectl config current-context)"

# --- Namespace, policies, RBAC ----------------------------------------------
# The same manifests Minikube runs. If these behave differently here, the
# isolation suite will say so - which is why it runs again after this.
Write-Step "Applying namespace, NetworkPolicy and RBAC"
kubectl apply -f "$PSScriptRoot\..\k8s\namespace.yaml" | Out-Null
kubectl apply -f "$PSScriptRoot\..\k8s\netpol-deny-all.yaml" | Out-Null
kubectl apply -f "$PSScriptRoot\..\k8s\rbac.yaml" | Out-Null
Write-Note "applied"

# --- Workload Identity -------------------------------------------------------
# Binds the in-cluster ServiceAccount to the Google one, so the orchestrator
# gets credentials from the metadata server. No key file is created, so there
# is no key file to leak.
Write-Step "Workload Identity binding"
Invoke-GcloudEventuallyConsistent iam service-accounts add-iam-policy-binding $saEmail --role=roles/iam.workloadIdentityUser --member="serviceAccount:$project.svc.id.goog[default/srectl-orchestrator]" --condition=None --quiet | Out-Null
kubectl annotate serviceaccount srectl-orchestrator `
  --namespace default "iam.gke.io/gcp-service-account=$saEmail" --overwrite | Out-Null
Write-Note "bound (no service-account key created)"

Write-Host "`nCluster is up." -ForegroundColor Green
Write-Host "Next:  pnpm push:runner   then   pnpm test:isolation" -ForegroundColor Green
Write-Warn "When you stop for the session: infra\gcp\cluster-down.ps1"
