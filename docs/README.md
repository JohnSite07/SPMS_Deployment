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
- [System design summary](architecture/system-design-summary.md) — Developer-team-owned Parts I/II/IV of the M4 System Design (software design, database, test plan) at a glance, plus open cross-team items.

### Requirements
- [Functional requirements](requirements/functional-requirements.md) — use cases, events, business rules.
- [Non-functional requirements](requirements/non-functional-requirements.md) — quality attributes, constraints, scope.

### Decisions
- [0001 — Cloud platform, compute, IaC, and CI/CD](decisions/0001-platform-and-tooling.md)
- [ADR template](decisions/_template.md)

### Deployment
- _(none yet)_

### Runbooks
- _(none yet)_

### Guides
- _(none yet)_

### Milestones
- [Milestone source documents (M1–M4)](milestones/README.md)

### Action plans
- [PRD index](action_plan/README.md) · [PRD template](action_plan/_template.md)

---

The canonical baselines are the milestone documents under [milestones/](milestones/) — the M3 Requirements Analysis (application spec) and the M4 Deployment design (infrastructure spec). Docs here distil and expand on them; where they diverge, the implemented code/IaC is the source of truth.
