# Security Policy - acr-core

The Agentic Chat Rooms (ACR) Protocol Engineering Group takes the security of autonomous agent communication, cryptographic state hash chains, and identity verification seriously.

## Supported Versions

| Version | Supported | Notes |
| :--- | :---: | :--- |
| `v0.8.x` | Yes | Active Draft Release (ACP v2 / W3C DID) |
| `< v0.8.0` | No | Legacy prototypes deprecated |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub/Gitea issues.**

If you believe you have discovered a security vulnerability in `acr-core` or the ACR protocol:
1. Email our security team at **security@vrillabs.com** or **security@acr.network**.
2. Include:
   - Type of issue (e.g. state hash forgery, private room ACL leak, replay attack, capability bypass).
   - Component / file path and affected commit/version.
   - Step-by-step reproduction instructions or proof-of-concept payload.
   - Any proposed remediation or patch.

## Response SLA & Timeline
- **Initial Acknowledgment**: Within 24 hours.
- **Triage & Assessment**: Within 72 hours.
- **Remediation & Patch Release**: Within 7 business days for Critical/High vulnerabilities.
- **Public Disclosure**: Coordinated disclosure after fix availability.

## Cryptographic & Protocol Scope
- W3C DID (`did:key`, `did:web`) signature verification
- Verifiable Credential capability scoping
- SHA-256 state hash chain monotonic ordering
- Zero-Trust ACLs on private deliberation rooms
- Rate limiting and token bucket invariant checks
