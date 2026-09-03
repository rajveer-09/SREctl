# Workload Identity Federation for GitHub Actions.
#
# Creates the pool, the OIDC provider bound to one GitHub repository, and a
# deploy service account, then prints the two values the workflow needs.
#
# WHY THIS EXISTS AT ALL: the alternative is `gcloud iam service-accounts keys
# create` and a JSON key pasted into a repository secret. That key does not
# expire, is valid from anywhere on the internet, and is readable by anyone who
# can add a workflow to the repository. Federation issues a token that lives
# for minutes and is bound to a single repository, and no key ever exists to
# leak.
#
# THE LOAD-BEARING LINE IS --attribute-condition. Without it the provider
# trusts every token GitHub's issuer signs - which is every workflow run in
# every public repository on GitHub. Anyone could then federate into this
# project. gcloud refuses to create such a provider without the flag, and that
# refusal is the only thing standing between a normal setup and a wide-open
# one, so it is set explicitly here and verified again after creation.
#
# Idempotent: re-running reconciles rather than duplicating.

param(
  # Overrides SRECTL_GITHUB_REPO / the config default. "owner/repo".
  [string]$Repo
)

. "$PSScriptRoot\config.ps1"
Assert-Gcloud

if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = $SRECTL.GitHubRepo }
if ($Repo -notmatch '^[^/\s]+/[^/\s]+$') {
  throw "Repo must look like 'owner/name', got '$Repo'"
}

$project = $SRECTL.Project
$pool = $SRECTL.WifPool
$provider = $SRECTL.WifProvider
$deploySa = Get-DeployAccountEmail
$ingestSa = "srectl-ingest@$project.iam.gserviceaccount.com"

$projectNumber = (gcloud projects describe $project --format="value(projectNumber)" 2>$null)
if ([string]::IsNullOrWhiteSpace($projectNumber)) {
  throw "could not read the project number for '$project'"
}

Write-Host ""
Write-Host "  project  $project ($projectNumber)"
Write-Host "  repo     $Repo"
Write-Host "  pool     $pool / $provider"

# --- APIs --------------------------------------------------------------------
# sts is what actually exchanges the OIDC token; iamcredentials is what mints
# the short-lived access token afterwards. A missing one of these surfaces in
# Actions as a generic 403 with no hint that an API is off.
Write-Step "Enabling federation APIs"
Invoke-Gcloud services enable sts.googleapis.com iamcredentials.googleapis.com iam.googleapis.com --quiet | Out-Null
Write-Note "sts, iamcredentials, iam"

# --- Pool --------------------------------------------------------------------
Write-Step "Workload Identity pool"
if (Test-GcloudResource iam workload-identity-pools describe $pool --location=global --format="value(name)") {
  Write-Note "already exists"
} else {
  Invoke-Gcloud iam workload-identity-pools create $pool `
    --location=global `
    --display-name="GitHub Actions" `
    --description="Federated identities for GitHub Actions workflows" `
    --quiet | Out-Null
  Write-Note "created"
}

# --- Provider ----------------------------------------------------------------
Write-Step "OIDC provider bound to $Repo"

# Only the claims that are actually used downstream. Mapping more than that
# invites writing a condition against a claim GitHub does not guarantee.
$mapping = "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref"

# The gate. Restricting to the repository, not merely the owner: an owner-wide
# condition would let any repository in the account deploy this project.
$condition = "assertion.repository == '$Repo'"

$providerExists = Test-GcloudResource iam workload-identity-pools providers describe $provider `
  --location=global --workload-identity-pool=$pool --format="value(name)"

if ($providerExists) {
  # Update rather than skip: the allowed repository may have changed, and a
  # stale condition would keep trusting the old one.
  Invoke-Gcloud iam workload-identity-pools providers update-oidc $provider `
    --location=global `
    --workload-identity-pool=$pool `
    --issuer-uri="https://token.actions.githubusercontent.com" `
    --attribute-mapping=$mapping `
    --attribute-condition=$condition `
    --quiet | Out-Null
  Write-Note "updated"
} else {
  Invoke-Gcloud iam workload-identity-pools providers create-oidc $provider `
    --location=global `
    --workload-identity-pool=$pool `
    --display-name="GitHub Actions OIDC" `
    --issuer-uri="https://token.actions.githubusercontent.com" `
    --attribute-mapping=$mapping `
    --attribute-condition=$condition `
    --quiet | Out-Null
  Write-Note "created"
}

# --- Deploy service account --------------------------------------------------
Write-Step "Deploy service account"
if (Test-GcloudResource iam service-accounts describe $deploySa --format="value(email)") {
  Write-Note "already exists"
} else {
  Invoke-Gcloud iam service-accounts create $SRECTL.DeployAccount `
    --display-name="SREctl CI deployer" `
    --description="Impersonated by GitHub Actions via Workload Identity Federation" `
    --quiet | Out-Null
  Write-Note "created"
}

# Deploy-time permissions only. Notably absent: secretAccessor, because CI
# never reads a secret - it deploys services that read their own at runtime.
Write-Step "Roles for the deployer"
foreach ($role in @(
    "roles/artifactregistry.writer",  # push images
    "roles/run.admin",                # deploy the Cloud Run service
    "roles/container.developer"       # kubectl against the cluster
  )) {
  Invoke-GcloudEventuallyConsistent projects add-iam-policy-binding $project `
    --member="serviceAccount:$deploySa" --role=$role --condition=None --quiet | Out-Null
}
Write-Note "artifactregistry.writer, run.admin, container.developer"

# `gcloud run deploy --service-account=srectl-ingest` is an act-as, and it is
# refused without this. Scoped to the ingest account rather than granted
# project-wide, so the deployer cannot act as the orchestrator or as itself
# with different permissions.
Write-Step "Act-as on the ingest runtime account"
if (Test-GcloudResource iam service-accounts describe $ingestSa --format="value(email)") {
  Invoke-GcloudEventuallyConsistent iam service-accounts add-iam-policy-binding $ingestSa `
    --member="serviceAccount:$deploySa" --role=roles/iam.serviceAccountUser --condition=None --quiet | Out-Null
  Write-Note "serviceAccountUser on srectl-ingest"
} else {
  Write-Warn "srectl-ingest does not exist yet - deploy.ps1 creates it."
  Write-Warn "Re-run this script afterwards, or the first CI deploy fails on act-as."
}

# --- The binding that lets the repository impersonate the deployer -----------
Write-Step "Binding $Repo to the deployer"

# principalSet, not principal: this matches every token whose repository claim
# is this repository, rather than one specific subject. A `principal://...`
# binding on google.subject would break the moment the workflow ran from a tag
# instead of a branch, because the subject encodes the ref.
$principalSet = "principalSet://iam.googleapis.com/projects/$projectNumber/locations/global/workloadIdentityPools/$pool/attribute.repository/$Repo"

Invoke-GcloudEventuallyConsistent iam service-accounts add-iam-policy-binding $deploySa `
  --member=$principalSet --role=roles/iam.workloadIdentityUser --condition=None --quiet | Out-Null
Write-Note "workloadIdentityUser granted to attribute.repository/$Repo"

# --- Verify ------------------------------------------------------------------
# The condition is the whole security model, so it is read back from the server
# rather than assumed from the exit code of the command that set it.
Write-Step "Verifying"

$readCondition = (gcloud iam workload-identity-pools providers describe $provider `
    --location=global --workload-identity-pool=$pool `
    --format="value(attributeCondition)" 2>$null)

if ([string]::IsNullOrWhiteSpace($readCondition)) {
  throw "PROVIDER HAS NO ATTRIBUTE CONDITION - any GitHub repository could impersonate $deploySa. Delete the provider and re-run."
}
if ($readCondition -notlike "*$Repo*") {
  throw "provider condition does not mention '$Repo': $readCondition"
}
Write-Note "attribute condition: $readCondition"

$boundMembers = (gcloud iam service-accounts get-iam-policy $deploySa `
    --flatten="bindings[].members" `
    --filter="bindings.role=roles/iam.workloadIdentityUser" `
    --format="value(bindings.members)" 2>$null)
if ($boundMembers -notlike "*attribute.repository/$Repo*") {
  throw "no workloadIdentityUser binding for $Repo on $deploySa"
}
Write-Note "impersonation binding present"

$wifProviderPath = "projects/$projectNumber/locations/global/workloadIdentityPools/$pool/providers/$provider"

# --- Output ------------------------------------------------------------------
Write-Host ""
Write-Host "Set these as repository VARIABLES (Settings > Secrets and variables > Actions > Variables)." -ForegroundColor Green
Write-Host "Variables, not secrets: they are resource identifiers, not credentials, and a" -ForegroundColor DarkGray
Write-Host "masked value is far harder to debug when a deploy fails on the auth step." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  WIF_PROVIDER  $wifProviderPath" -ForegroundColor Cyan
Write-Host "  DEPLOY_SA     $deploySa" -ForegroundColor Cyan
Write-Host "  TARGET_REPO   <the repository the agent reviews, e.g. owner/name>" -ForegroundColor Cyan
Write-Host ""
Write-Host "Or with the gh CLI:" -ForegroundColor Green
Write-Host "  gh variable set WIF_PROVIDER --repo $Repo --body `"$wifProviderPath`""
Write-Host "  gh variable set DEPLOY_SA    --repo $Repo --body `"$deploySa`""
Write-Host ""
Write-Host "No service-account key was created, and none is needed." -ForegroundColor Green
