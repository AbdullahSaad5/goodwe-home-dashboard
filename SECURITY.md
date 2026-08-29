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

The desktop oracle is designed for trusted local networks and must not be exposed directly to the
public Internet. The production Vercel deployment is protected by Turnstile, throttled passphrase
login, and a signed `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. Rotate the session secret to
revoke every browser.

Never expose the inverter or ESP32 to the public Internet. Keep Worker, Wi-Fi, HMAC, session,
passphrase, coordinates, inverter identifiers, and telemetry values out of Git and logs. Do not burn
irreversible ESP32 security eFuses for the v1 household deployment.
