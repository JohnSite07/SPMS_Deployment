# Architecture Overview

How SecureVault is shaped, end to end. This page connects the application design (Milestone 3) with the cloud deployment (Milestone 4). For concrete resource configuration see the Terraform under `terraform/`; for the object model see [domain-model.md](domain-model.md).

## What SecureVault is

A web-based, **zero-knowledge** password management system: a single user stores, generates, and manages credentials and sensitive documents inside an encrypted vault, protected by AES-256 at rest, TLS in transit, and 2FA. The application is a containerised **Node.js / Express** service backed by **MySQL**.

## Zero-knowledge posture (the central design constraint)

Encryption is applied at the application layer and at rest, so the platform stores only ciphertext and never handles plaintext vault contents. Two consequences shape every decision:

- The **master password is never stored** — only its hash, used to verify login (M3 business rule 1).
- The infrastructure (Cloud SQL, Cloud Storage) holds encrypted blobs only; a compromise of the database or storage does not expose vault contents.

This posture is reinforced by the deployment's least-privilege boundaries (private DB, separate service accounts) described below.

## System context (boundary)

External entities exchanging data with the system (M3 Level-0 DFD):

- **End User** ↔ login/master password, vault commands, generator requests, file uploads; receives decrypted items, generated passwords, health scores, alerts.
- **System Administrator** ↔ deployment/config; receives audit logs, health and error reports.
- **2FA Auth Service** «external» ↔ OTP verification requests/results.
- **Email Service** «external» ↔ verification / reset / security-alert email send requests.
- **Database** — encrypted records, audit entries, sessions (an external entity at context level per DFD-0 convention; a backing service at runtime).

## Internal processes

A Level-1 decomposition splits SecureVault into: **authentication**, **vault management**, **password generator**, **health analyser**, **file storage**, and **audit logger**. These map onto the domain classes in [domain-model.md](domain-model.md) and the use cases in [requirements/functional-requirements.md](../requirements/functional-requirements.md).

## Runtime topology (Milestone 4)

The application runs on Google Cloud Platform, sized to fit the $300 free-trial credit and to be torn down with one command. Summary of the runtime path:

1. **Google Front End** terminates TLS (Google-managed cert) and forwards to **Cloud Run** (1 vCPU / 512 MiB, min 0 / max 2).
2. Cloud Run fetches secrets from **Secret Manager** on cold start under its own service account.
3. It reads/writes **Cloud SQL for MySQL** (private IP) over the VPC via **Direct VPC egress** — the DB is never publicly exposed.
4. Encrypted document blobs go to **Cloud Storage**; a second versioned bucket holds Terraform state.
5. External calls go to the **2FA** and **email** providers; logs/metrics flow to **Cloud Logging/Monitoring**.

### Security & network boundaries

- HTTPS only at the edge; database reachable only through the VPC (no public IP).
- Secrets never live in source, the Docker image, or committed env files — injected at runtime from Secret Manager.
- **Pipeline and runtime use separate least-privilege service accounts**, so compromise of one does not grant the other's access.

Region is `us-central1` (Tier-1 pricing, free-tier eligible); a one-variable change retargets `northamerica-northeast1` (Montreal) for Canadian data residency.

## Where to read more

- Application requirements → [requirements/](../requirements/)
- Object model → [domain-model.md](domain-model.md)
- Provisioning, CI/CD, rollback → [deployment/](../deployment/)
- Why these platform choices → [decisions/0001](../decisions/0001-platform-and-tooling.md)
- Full deployment spec → [M4 deployment design](../milestones/SecureVault_Milestone4_Deployment.docx)
