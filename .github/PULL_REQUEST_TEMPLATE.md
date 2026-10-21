<!-- Thanks for contributing! Please keep PRs focused on a single change. -->

## What and why

<!-- What does this change, and why? Link the issue: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Modem / driver support
- [ ] Docs or recipe
- [ ] Refactor, tests or chore
- [ ] **Breaking change** (API, event payload or config)

## How was this tested?

- [ ] `npm run check` passes (format, lint, typecheck, tests)
- [ ] Tested in mock mode
- [ ] Tested on real hardware. Modem model and firmware (`AT+CGMR`): <!-- e.g. Huawei E173, 11.126.85.00.209 -->

<!-- Describe what you checked. Include anonymised AT log excerpts for driver changes. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`), following the [DCO](https://developercertificate.org/).
- [ ] **Clean-room:** no code was copied, translated or ported from GPL projects (chan_dongle, chan_quectel, Gammu, smstools3, ModemManager source). For protocol work, the sources I used are listed below.
- [ ] API or event changes are reflected in `docs/openapi.yaml`, `docs/events.md` and the README.
- [ ] User-visible changes have a line in `CHANGELOG.md` under *Unreleased*.
- [ ] No real phone numbers, IMEIs, ICCIDs, URLs, IPs, hostnames or usernames in code, tests, fixtures or docs.

## Protocol sources (if applicable)

<!-- e.g. 3GPP TS 23.040 §9.2.3.24 (UDH); Huawei E173 AT command interface spec, §… -->
