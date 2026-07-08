# 0003 — Two service accounts and keyless Workload Identity Federation

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Secure Vault Group (Deployment & DevOps lead: Jean Luc Sita Mbuya)

## Context

The project needs two distinct identities in GCP: one for the running application (Cloud Run, at request time) and one for the CI/CD pipeline (GitHub Actions, to build/apply/deploy). These identities have very different risk profiles — the runtime identity is reachable indirectly through the deployed application; the pipeline identity has to be able to reconfigure the whole cloud estate. Treating them as one identity, or authenticating the pipeline with a long-lived credential, would concentrate risk in a way that conflicts with the project's least-privilege posture (see `CLAUDE.md`). This decision was made and executed as part of [PRD 0003](../action_plan/0003-iam-and-wif.md); the implementation is [terraform/modules/iam/](../../terraform/modules/iam/).

## Decision

**Two separate service accounts, both provisioned by [`terraform/modules/iam/main.tf`](../../terraform/modules/iam/main.tf), with no key material for either.**

**Runtime SA** (`spms-runtime` account-id prefix) — the identity Cloud Run assumes at request time. Scoped narrowly:
- `roles/cloudsql.client`, `roles/logging.logWriter`, `roles/monitoring.metricWriter` at project level.
- `roles/secretmanager.secretAccessor` granted **per secret** (one IAM binding per secret ID in `var.secret_ids`), not project-wide — compromising this identity does not expose secrets the app doesn't use.
- `roles/storage.objectAdmin` scoped to the single document bucket, not project-wide storage.

**Deployer SA** (`spms-deployer` account-id prefix) — the identity GitHub Actions impersonates to run `terraform apply`, build/push images, and deploy Cloud Run revisions. It holds the widest role list in the project, by necessity: `roles/run.admin`, `roles/artifactregistry.writer`, `roles/cloudsql.admin`, `roles/compute.networkAdmin`, `roles/secretmanager.admin`, `roles/storage.admin`, `roles/serviceusage.serviceUsageAdmin`, `roles/iam.serviceAccountAdmin`, `roles/resourcemanager.projectIamAdmin` — see [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) `deployer_project_roles` for the authoritative list. It additionally holds `roles/iam.serviceAccountUser` on the runtime SA specifically (not project-wide), which is what lets it deploy Cloud Run revisions that run as the runtime SA without being able to act as any other identity.

**The split matters because compromise of one does not grant the other's access.** An attacker who compromises the running application inherits only the runtime SA's narrow grants (its own secrets, its own bucket, Cloud SQL client access) — nothing that can touch IAM, networking, or other projects' resources. An attacker who compromises the pipeline path inherits the deployer SA's broad grants, but the pipeline path is itself hardened (see below), and even then the deployer SA cannot read the app's secrets or vault documents directly — it can only redeploy code that would.

**Deployer breadth is a deliberate, accepted trade-off**, not an oversight: the deployer SA runs `terraform apply` for the entire estate, so it needs admin-level roles across every service Terraform touches. Three mitigations keep this bounded:

1. **WIF attribute condition pins token exchange to this repository.** The `google_iam_workload_identity_pool_provider` sets `attribute_condition = "assertion.repository == \"<OWNER>/SPMS_Deployment\""` (see [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf), `google_iam_workload_identity_pool_provider.github`) — tokens asserting any other repository are rejected at the pool boundary, before IAM is even consulted. The downstream `google_service_account_iam_member` binding is scoped to the same repository's `principalSet`, so both the token-exchange gate and the impersonation grant independently reject anything else.
2. **No long-lived key exists at all.** There are zero `google_service_account_key` resources anywhere in the module (or the codebase) — a static credential that could leak, be exfiltrated, or need rotation simply doesn't exist for either SA.
3. **Branch protection on `main`** (arriving in PRD 0005) gates who can push to the branch that triggers `cd.yml`, which is the only workflow that exchanges tokens for the deployer SA — so triggering the deployer's broad access requires passing that gate first.

**WIF mechanics:** GitHub issues a short-lived OIDC token scoped to the specific workflow run; GCP's Workload Identity Pool/provider validates that token against the repository-pinned condition and, if it passes, lets the run impersonate the deployer SA for the duration of the job only. Only non-sensitive identifiers — project ID, WIF provider resource name, deployer SA email (the three Terraform outputs in [terraform/modules/iam/outputs.tf](../../terraform/modules/iam/outputs.tf)) — are stored on the GitHub side, and only as Actions *variables*, never secrets.

## Alternatives considered

- **Long-lived JSON key stored in a repo secret** — the conventional approach, but exactly the risk this design eliminates: a static, unexpiring credential that grants deployer-level access to anyone who obtains it (leaked log, compromised fork, careless copy-paste), with no automatic expiry and manual rotation as the only remedy. Rejected.
- **A single shared service account for both runtime and pipeline** — simpler to provision, but couples the two blast radii: compromising the running application would directly grant `terraform apply`-level access to the whole estate, and vice versa. Rejected — directly conflicts with the least-privilege posture in `CLAUDE.md`.
- **Per-module deployer service accounts** (one SA per Terraform module — network, data, app, secrets) — would shrink each individual SA's blast radius further, but adds real operational overhead (N SAs to provision, bind, and reason about, N WIF bindings or a more complex impersonation chain) that is disproportionate for an estate this size, run by a single-operator academic project. Rejected in favour of one deployer SA whose breadth is bounded by the WIF/branch-protection mitigations above instead of by IAM decomposition.

## Consequences

- Any new secret or bucket the runtime needs must be added explicitly to `var.secret_ids` / bucket-scoped bindings in `terraform/modules/iam/` — nothing is inherited automatically, which is the intended friction (forces a conscious least-privilege decision per resource).
- The deployer SA's role list will read as "too broad" to a reviewer looking at it in isolation; that judgment is correct in isolation and is why the WIF condition and branch protection exist as compensating controls — reviewers should evaluate the three together, not the role list alone.
- Losing the GitHub repository (rename, transfer, fork-based re-creation) breaks the WIF trust immediately, since the condition is a literal string match on `assertion.repository`; a repository rename requires updating `var.github_repository` and re-applying.
- WIF pools soft-delete for ~30 days on destroy; recreating a pool with the same ID inside that window requires an explicit `undelete` rather than a plain `apply` — see [runbooks/teardown.md](../runbooks/teardown.md).
- PRD 0005 (GitHub Actions side: setting the three Actions variables, writing the workflows, branch protection) and PRD 0006 (developer-team human IAM grants) both build directly on the identities and outputs this ADR's implementation created.
