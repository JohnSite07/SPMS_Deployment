# Action Plan Rule

Every substantial piece of work — provisioning a set of resources, standing up a pipeline stage, a migration, a teardown — gets a PRD (Plan of Record Document) under `docs/action_plan/` **before execution starts**. The PRD is written first, reviewed/approved by the user, then executed against. No PRD, no execution.

## Purpose

PRDs exist so that cost- and security-relevant work on the GCP environment is deliberate: what will change, what it costs, how we know it worked, and how we undo it — decided *before* anything runs. They also record which agents do what, so orchestration is reviewable.

## Location & naming

- Folder: `docs/action_plan/`
- Filename: `NNNN-short-title.md` — zero-padded sequence, kebab-case title (e.g. `0001-terraform-foundation.md`). Never renumber. Start from `docs/action_plan/_template.md`.
- `docs/action_plan/README.md` is the index: one line per PRD with its status.

## Required sections (every PRD)

1. **Status & metadata** — `Draft → Approved → In Progress → Done` (or `Abandoned`), date, author. Execution may only start once the user has marked/confirmed **Approved**. Update the status as work proceeds.
2. **User story** — who needs this and why, in `As a … I want … so that …` form. Keeps the work tied to a project goal, not an implementation itch.
3. **Scope** — explicitly **in scope** and **out of scope**. Out-of-scope is mandatory: it is where scope creep is caught.
4. **Success criteria** — measurable, checkable statements ("`terraform validate` passes", "Cloud Run URL returns 200", "plan shows 0 destroys"). Each one must be verifiable by a command or observation, not vibes.
5. **Resources** — what is touched or created: GCP resources (with Terraform resource types), files/modules in the repo, external references (docs, provider registry pages). State the expected **cost impact** of any new resource against the $300 budget.
6. **Scripts / commands** — the concrete commands that will be run (or added to workflows), in order. Destructive or billable commands (`terraform apply`, `gcloud … create/delete`) must be explicitly listed here — nothing billable runs that the PRD didn't name.
7. **Planned agents** — which agents (`terraform-engineer`, `pipeline-engineer`, `infra-reviewer`, `documentation-keeper`) are used, for which step, and what each hands off. If a step is done in the main session instead of an agent, say so.
8. **Testing / verification plan** — how we prove it works after execution: commands, expected outputs, smoke checks, and the infra-reviewer pass. Every success criterion from §4 must map to at least one verification step here.
9. **Additional considerations** — anything material that doesn't fit above: security posture impact, rollback/teardown path (how this work dies under `terraform destroy`), open questions, cross-team dependencies (Developer team items), timing constraints.

## Conventions

- PRDs are **plans, not documentation of record**: once executed, outcomes belong in the proper taxonomy (ADRs for decisions, `docs/deployment/` for pipeline docs, runbooks for procedures). The PRD gets a short **Outcome** note at the bottom (what actually happened, deviations from plan) and its status set to `Done` — it is not rewritten into a report.
- Deviations during execution that change scope, cost, or security posture require going back to the PRD: amend it and re-confirm with the user before continuing. Small mechanical deviations are just noted in the Outcome.
- No secrets, credentials, or real GCP project IDs/SA emails in PRDs — same rule as all docs.
- Cross-link the PRD to the ADRs/runbooks/docs it produces, and vice versa.
- The `documentation-keeper` agent respects this folder as part of the docs taxonomy; the main session (orchestrator) owns writing PRDs, since it assigns the agents.
