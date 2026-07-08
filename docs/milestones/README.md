# Milestone Source Documents

The original PRG800 academic deliverables for SecureVault, kept verbatim as the project's source of truth. The structured docs elsewhere under `docs/` distil and build on these; where they diverge, these submitted documents and the implemented code are authoritative.

| # | Document | Date | Contents |
| --- | --- | --- | --- |
| M1 | [PRG800_Milestone1_SecureVault.pdf](PRG800_Milestone1_SecureVault.pdf) | 2026-05-11 | Project charter: team, roles, mission, vision, key system features, group contract. |
| M2 | [PRG800_Milestone2_SecureVault.pdf](PRG800_Milestone2_SecureVault.pdf) | 2026-05-26 | Project plan: industry analysis, SWOT, feasibility, charter, in/out scope, Agile sprint plan & Gantt. |
| M3 | [SecureVault_Milestone3-Group+2.pdf](SecureVault_Milestone3-Group+2.pdf) | 2026-06-09 | Requirements analysis: stakeholders, context DFD, use cases, domain class model, business rules, NFRs. |
| M4 | [SecureVault_Milestone4_Deployment.docx](SecureVault_Milestone4_Deployment.docx) | 2026-06-25 | Deployment-only excerpt (Part III source): GCP deployment architecture, Terraform, CI/CD, cost analysis. |
| M4 | [SecureVault_Milestone4_System_Design.pdf](SecureVault_Milestone4_System_Design.pdf) | 2026-06-30 | Full System Design (66 pages, four parts) — Part I Software Design & UI/UX, Part II Database Architecture, Part III System Architecture & Security: Cloud Deployment & DevOps, Part IV System Test Plan. Part III is a verbatim match of the docx above; Parts I, II, IV are new. |

## How the milestones map to the docs

- **M3** is the application specification → distilled into [requirements/](../requirements/) and [architecture/domain-model.md](../architecture/domain-model.md).
- **M4** is the deployment specification → reflected in [architecture/](../architecture/), [deployment/](../deployment/), and the root [CLAUDE.md](../../CLAUDE.md). The docx is the Part III (deployment) excerpt this repo builds from; the PDF is the complete four-part deliverable submitted for the milestone.
- **M4, Parts I/II/IV** (software design, database architecture, test plan) belong to the Developer team, outside this repo's DevOps scope → summarized for awareness in [architecture/system-design-summary.md](../architecture/system-design-summary.md).
- **M1–M2** provide project context (scope, team, schedule) and the [0001 platform decision](../decisions/0001-platform-and-tooling.md) rationale.

## Team & roles (M1)

Secure Vault Group, PRG800NAA.06353.2264, sponsor Prof. Miles McDonald.

| Member | Role |
| --- | --- |
| Felix Akuetteh Torto | Project Leader |
| Harmon Anthony Tuazon | Project Manager / Developer (Project Manager per M2 charter) |
| Jean Luc Sita Mbuya | Technical Lead / Database Designer; Deployment & DevOps lead (M4) |
| Akshay Nedumparambil Unnikrishnan | Research Analyst / Documentation |
| Kulsum Timol | Developer / Programmer |
| Anju Babu | Developer / QA Tester |
