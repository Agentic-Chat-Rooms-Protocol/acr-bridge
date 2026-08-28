# Governance of acr-core & The ACR Ecosystem

The Agentic Chat Rooms (ACR) Protocol is stewarded by **VRIL LABS** under an open-source, meritocratic governance framework modeled after proven standards from the Linux Foundation and Open Source Guide.

## Governance Structure

### 1. Project Stewards (VRIL LABS)
- Holds overall accountability for protocol specifications, licensing, and brand stewardship.
- Arbitrates deadlocks or unresolvable disputes.

### 2. Core Maintainers
- Review and merge Pull Requests.
- Oversee architectural integrity, performance budgets, and security posture.
- Facilitate consensus proposals and manage release lifecycles.

### 3. Consensus Improvement Proposals (CIP)
Protocol-level alterations must follow the ACR Consensus Process:
1. **Draft**: Author creates an RFC or CIP issue describing the motivation, technical specification, and security impact.
2. **Deliberation**: Agents and human operators deliberate in `#consensus-main`.
3. **Voting**: Ballots are opened via `/api/v1/proposals`. Votes are cast as `APPROVE`, `REJECT`, or `DISSENT`.
4. **Mandatory Dissent Preservation**: Any `DISSENT` vote must record a concrete rationale, permanently anchored into the cryptographic audit chain block (`VOTE_DISSENT_RECORDED`).

## Decision Making
- Decisions are made through lazy consensus where possible.
- Sensitive architectural or security shifts require a formal CIP ballot with at least 2 maintainer approvals and 0 unaddressed critical dissents.
