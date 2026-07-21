# SecureVault (SPMS) Documentation

Structured documentation for the SecureVault deployment & DevOps project. The taxonomy and conventions are defined in [`.claude/rules/documentation.md`](../.claude/rules/documentation.md); the `documentation-keeper` agent maintains this tree.

## Structure

| Folder | Purpose |
| --- | --- |
| [architecture/](architecture/) | How the system is shaped and why — components, boundaries, request/data flows, object model. |
| [requirements/](requirements/) | Functional and non-functional requirements (the application spec). |
| [decisions/](decisions/) | Architecture Decision Records (ADRs) — one immutable record per significant decision. |
| [deployment/](deployment/) | CI/CD pipeline, environments, release & rollback process, GCP setup. |
| [runbooks/](runbooks/) | Step-by-step operational procedures (teardown, secret rotation, cost checks, stop/start DB). |
| [guides/](guides/) | Developer how-tos and onboarding. |
| [milestones/](milestones/) | The original PRG800 academic deliverables (M1–M4), kept verbatim as source of truth. |
| [action_plan/](action_plan/) | PRDs — plans of record written and approved before executing substantial work (see [`.claude/rules/action-plan.md`](../.claude/rules/action-plan.md)). |

## Index

### Architecture
- [Architecture overview](architecture/overview.md) — end-to-end shape, zero-knowledge posture, runtime topology.
- [Domain model](architecture/domain-model.md) — the 14-class object model (the app data-model blueprint).
- [AUDIT_ENTRIES schema](architecture/audit-entries-schema.md) — the reconciled audit table (columns, append-only grant, `ON DELETE RESTRICT`), and its deltas from the first-created version.
- [System design summary](architecture/system-design-summary.md) — Developer-team-owned Parts I/II/IV of the M4 System Design (software design, database, test plan) at a glance, plus open cross-team items.
- [UI/UX guidelines](architecture/ui-ux-guidelines.md) — distilled from System Design Part I §2: the ten design principles, navigation map, login/2FA flow, and the six screens/wireframes.

### Requirements
- [Functional requirements](requirements/functional-requirements.md) — use cases, events, business rules.
- [Non-functional requirements](requirements/non-functional-requirements.md) — quality attributes, constraints, scope.

### Decisions
- [0001 — Cloud platform, compute, IaC, and CI/CD](decisions/0001-platform-and-tooling.md)
- [0002 — Terraform state bootstrap and partial backend configuration](decisions/0002-terraform-state-bootstrap-and-partial-backend.md)
- [0003 — Two service accounts and keyless Workload Identity Federation](decisions/0003-two-service-accounts-and-keyless-wif.md)
- [0004 — Human database access: Cloud SQL Studio, not a network path](decisions/0004-human-db-access-cloud-sql-studio.md)
- [0005 — Temporary public IP on Cloud SQL for the development phase](decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md)
- [0006 — Enforcing the append-only audit log in application code](decisions/0006-append-only-audit-log-enforcement.md)
- [0007 — Stateful session revocation for logout](decisions/0007-stateful-session-revocation.md)
- [0008 — An in-app `admin` role for the audit-history view](decisions/0008-in-app-admin-role.md)
- [0009 — Frontend stack and serving model: React/Vite served by Cloud Run, not a CDN bucket](decisions/0009-frontend-stack-and-serving-model.md)
- [0010 — In-memory session-token storage in the SPA (no localStorage/sessionStorage/cookies)](decisions/0010-in-memory-session-token-storage.md)
- [0011 — Design-system baseline: react-bootstrap + a single SASS token file](decisions/0011-design-system-baseline.md)
- [0012 — Two-factor enrollment as a separate public, pre-session surface](decisions/0012-two-factor-enrollment-separate-public-surface.md)
- [0013 — Duplicate-email disclosure on registration as a deliberate anti-enumeration exception](decisions/0013-duplicate-email-disclosure-on-registration.md)
- [0014 — Password reset proves identity via TOTP, not an emailed link](decisions/0014-totp-based-password-reset.md)
- [0015 — Vault-key derivation: direct KDF from the master password, email-derived salt](decisions/0015-vault-key-derivation-from-master-password.md)
- [ADR template](decisions/_template.md)

### Deployment
- [GCP one-time bootstrap](deployment/gcp-setup.md) — project/billing setup, API enablement, Terraform state bucket, `terraform init` pattern.
- [CI/CD pipeline](deployment/pipeline.md) — `ci.yml`/`cd.yml` stages, branch protection, Actions variables, and the platform quirks hit building it.

### Runbooks
- [Stop / start Cloud SQL](runbooks/stop-start-cloud-sql.md) — the #1 cost lever between work sessions.
- [Teardown](runbooks/teardown.md) — full environment teardown after grading.
- [Cost check](runbooks/cost-check.md) — daily/weekly spend sanity check against the $300 budget.
- [Roll back a Cloud Run revision](runbooks/rollback.md) — manual traffic re-pointing and re-running a failed CD run.
- [Rotate a secret](runbooks/secret-rotation.md) — add a Secret Manager version and get running instances to pick it up.
- [Enable / flip back Cloud SQL public IP](runbooks/db-public-access.md) — the dev-phase toggle from [ADR 0005](decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md); the flip-back is a required pre-presentation step.

### Guides
- [Developer handover](guides/developer-handover.md) — placeholder-valued onboarding guide for the Developer team: quick start, endpoints, DB access, credentials, env contract, ship process, open decisions, cost etiquette.

### Milestones
- [Milestone source documents (M1–M4)](milestones/README.md)

### Action plans
- [PRD index](action_plan/README.md) · [PRD template](action_plan/_template.md)

---

The canonical baselines are the milestone documents under [milestones/](milestones/) — the M3 Requirements Analysis (application spec) and the M4 Deployment design (infrastructure spec). Docs here distil and expand on them; where they diverge, the implemented code/IaC is the source of truth.
