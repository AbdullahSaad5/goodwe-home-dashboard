# Security policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch. Older releases may not receive patches.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub's private vulnerability reporting](https://github.com/AbdullahSaad5/goodwe-home-dashboard/security/advisories/new) and include:

- The affected version or commit.
- A concise description of the impact.
- Reproduction steps or a proof of concept.
- Any suggested mitigation.

Remove real inverter addresses, serial numbers, credentials, and household telemetry. You should receive an acknowledgment within seven days. The maintainer will coordinate validation, remediation, and disclosure through the advisory.

## Deployment guidance

GoodWe Home is designed for trusted local networks. It has no authentication layer and must not be exposed directly to the public internet. Keep the inverter itself isolated from untrusted networks and review firewall rules before deployment.
