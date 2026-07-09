# Decisions (ADRs)

One Architecture Decision Record per significant decision. ADRs are **immutable**: number them sequentially (`NNNN-short-title.md`), and when a decision changes, write a new ADR that supersedes the old one and link both ways — never edit history or renumber.

Copy [`_template.md`](_template.md) to start. The first record, [0001](0001-platform-and-tooling.md), captures the foundational platform and tooling choices. [0002](0002-terraform-state-bootstrap-and-partial-backend.md) records the state-bucket bootstrap and partial backend configuration. [0003](0003-two-service-accounts-and-keyless-wif.md) records the runtime/deployer service-account split and the keyless WIF trust with GitHub Actions. [0004](0004-human-db-access-cloud-sql-studio.md) records why human database access is Cloud SQL Studio plus local MySQL rather than the Cloud SQL Auth Proxy, after a dry run proved the proxy cannot reach a private-IP-only instance from outside the VPC.
