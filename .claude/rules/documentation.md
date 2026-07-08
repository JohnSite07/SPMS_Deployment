# Documentation Rule

All project documentation lives under `docs/` and follows a fixed taxonomy. Keep docs close to the work and update them in the same change that alters behaviour — documentation drift is a bug.

## Taxonomy — where things go

| Folder | Holds | Examples |
| --- | --- | --- |
| `docs/architecture/` | How the system is shaped and why; component responsibilities, diagrams, data/request flows, object model. | `overview.md`, `domain-model.md`, network boundaries |
| `docs/requirements/` | Functional and non-functional requirements — the application spec. | use cases, business rules, NFRs |
| `docs/decisions/` | Architecture Decision Records (ADRs) — one immutable record per significant decision. | `0001-platform-and-tooling.md` |
| `docs/deployment/` | CI/CD pipeline, environments, release/rollback process, GCP project setup. | pipeline stages, WIF setup, branch gating |
| `docs/runbooks/` | Step-by-step operational procedures an operator follows under time pressure. | teardown, secret rotation, stop/start Cloud SQL, cost check |
| `docs/guides/` | Developer-facing how-tos and onboarding. | local dev, running tests, contributing |
| `docs/milestones/` | Original PRG800 academic deliverables (M1–M4), kept verbatim as source of truth. Do not edit the binaries. | the milestone PDFs/DOCX |
| `docs/action_plan/` | PRDs — plans of record written and approved *before* executing substantial work. Governed by [`action-plan.md`](action-plan.md) (required sections, numbering, approval gate). Written by the main session, which assigns the agents. | `0001-terraform-foundation.md` |

`docs/README.md` is the index — every new top-level doc gets a line there.

## Conventions

- **Filenames:** kebab-case, `.md`. ADRs are numbered `NNNN-short-title.md` (zero-padded, never renumber or delete — supersede instead).
- **Every doc starts** with an H1 title and a one-line purpose statement.
- **Cross-link** related docs with relative links; link to `file:line` in code where a doc describes a specific implementation.
- **Source of truth is code/IaC, not prose.** When a doc explains *what* a resource is, point to the Terraform/source rather than restating values that will drift (e.g. machine tiers, instance counts). Document *why* and *how it fits*, which code can't express.
- **No secrets, credentials, or real project IDs/SA emails** in docs — reference Secret Manager / GitHub Actions variables by name only.

## When to write or update docs

- **Architectural decision made** → add an ADR (see `docs/decisions/_template.md`). Don't bury decisions in commit messages.
- **New component / infra module / pipeline stage** → update `docs/architecture/` and/or `docs/deployment/`.
- **New operational action becomes possible** (deploy, rollback, rotate, teardown) → add or update a runbook.
- **Behaviour, config surface, or setup steps change** → update the affected doc in the same PR.

## Ownership

The `documentation-keeper` agent owns the structure and consistency of `docs/`. Delegate documentation creation, restructuring, and audits to it. It must respect this taxonomy and the conventions above.
