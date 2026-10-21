# Security policy

gsm2http controls hardware that can spend money (calls and SMS) and receive one-time passcodes. We take vulnerabilities seriously and appreciate responsible disclosure.

## Supported versions

gsm2http is alpha software. Security fixes go into the latest release only.

| Version | Supported |
|---|---|
| Latest `0.x` release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue, discussion or PR for security problems.**

Report privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Please include:

- the affected version or commit, and how you run it (Docker, bare metal, behind a proxy…)
- steps to reproduce, or a proof of concept
- what an attacker could do: send SMS, place calls, read messages, run code, or something else
- whether real hardware is needed, or whether it reproduces in mock mode

Remove real phone numbers, IMEIs and message contents from anything you send.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | within 3 working days |
| First assessment and severity | within 10 working days |
| Fix or mitigation for high or critical issues | as soon as practical, usually within 30 days |
| Public advisory (GitHub Security Advisory, with CVE if warranted) | after a fixed release is available |

We'll keep you informed and credit you in the advisory unless you would rather stay anonymous. We don't currently offer a bug bounty.

## Scope

In scope:

- authentication or authorisation bypass on the REST API or Socket.io
- ways to send SMS or place calls without a valid token, outside the rate limits, or outside `ALLOWED_PREFIXES` (once implemented)
- ways to make gsm2http spend a SIM's last PIN attempt
- ways to change webhook or MQTT targets over the API
- leaks of message contents, PINs or tokens through the API, logs, the UI or webhooks
- webhook signature bypass or replay (once implemented)
- SSRF through webhook configuration
- injection into the AT command stream through API input (for example, a crafted phone number or PIN that runs extra AT commands)
- vulnerabilities in the published container image

Out of scope:

- deployments that ignore the documented defaults, such as exposing an instance to the internet with no token, or running with `privileged: true`
- weaknesses of SMS or the cellular network themselves (SMS spoofing, SS7, and so on)
- attacks that need physical access to the host or modem
- denial of service by flooding a self-hosted instance you can already reach on the LAN

## Hardening

See [Security notes](README.md#security-notes) in the README and [Exposing it safely](docs/DEPLOYMENT.md#exposing-it-safely).
