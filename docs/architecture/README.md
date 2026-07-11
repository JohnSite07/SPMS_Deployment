# Architecture

How SecureVault is shaped and why: component responsibilities, network & security boundaries, runtime request/data flows, and the object model.

- [overview.md](overview.md) — end-to-end shape: zero-knowledge posture, system context, internal processes, and the GCP runtime topology.
- [domain-model.md](domain-model.md) — the 14-class domain model (the application's data-model blueprint).
- [system-design-summary.md](system-design-summary.md) — awareness summary of the Developer-team-owned Parts I, II, IV of the M4 System Design, and open cross-team items.
- [ui-ux-guidelines.md](ui-ux-guidelines.md) — distilled from System Design Part I §2: the ten design principles, navigation map, login/2FA flow, and the six screens/wireframes.

Document the *reasoning* and *relationships*; point to Terraform under `terraform/` for concrete resource configuration rather than restating values that drift.
