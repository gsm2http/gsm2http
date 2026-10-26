# Contributing to gsm2http

Thanks for helping! Bug reports, hardware reports, docs fixes, recipes and code are all welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Ways to help

- **Test a modem** and report the result, whether it works or not: [New modem support](.github/ISSUE_TEMPLATE/new_modem.yml). This is the most useful contribution right now.
- **Report a bug** with an AT log: [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Add a recipe** for your automation tool in [`docs/recipes/`](docs/recipes/).
- **Pick up an issue** labelled `good first issue` or `help wanted`.

For anything bigger than a small fix, please open an issue or discussion first, so we can agree on the approach before you put in the work.

## Development setup

You need Node.js 20.19 or later (see `.nvmrc`), npm and git. You do **not** need a modem: mock mode simulates two.

The repository is an npm workspace with two packages, `backend` and `frontend`. Install once at the root:

```sh
git clone https://github.com/gsm2http/gsm2http.git
cd gsm2http
npm ci

# Backend: API, Socket.io and drivers, restarted on change, with readable logs
AUTH_DISABLED=true MOCK_MODE=true npm run dev:backend   # no token needed on localhost

# Frontend: React UI. Run this in a second terminal.
npm run dev:frontend
```

Open the URL Vite prints, usually <http://localhost:5173>. The dev server proxies `/api` and `/socket.io` to `http://localhost:9333`; set `GSM2HTTP_BACKEND` to use another backend.

| Command (from the root) | What it does |
|---|---|
| `npm run check` | Everything CI runs: format check, lint, typecheck and tests |
| `npm test` | Backend tests |
| `npm run lint` | ESLint (backend) and oxlint (frontend) |
| `npm run typecheck` | `tsc` for both packages |
| `npm run format` | Prettier, in place |
| `npm run build` | Compile the backend to `backend/dist` and bundle the UI to `frontend/dist` |

| Path | What's there |
|---|---|
| `backend/src/index.ts` | Entry point: reads config, starts the modem manager and the HTTP server |
| `backend/src/config.ts` | Environment variables → typed config |
| `backend/src/server.ts` | Wires REST routes, Socket.io and webhooks to the modem manager |
| `backend/src/http/` | Routers (`routes/`), request validation and error responses |
| `backend/src/events.ts`, `webhook.ts` | Event names and payloads; webhook delivery |
| `backend/src/modem/ModemManager.ts` | Port discovery, hot-plug, IMEI de-duplication, finding a modem by ID |
| `backend/src/modem/ModemStream.ts` | Serial I/O, AT command queue, init sequence, dial/hang-up, mock responses |
| `backend/src/modem/ATParser.ts` | Unsolicited result codes (`+CMTI`, `RING`, `+CLIP`) → events |
| `backend/src/modem/PDUParser.ts` | SMS-DELIVER PDU decoding (3GPP TS 23.040) |
| `backend/src/modem/SmsReassembler.ts` | Puts multi-part SMS back together |
| `backend/src/mock/` | Mock SMS/call injection and test fixtures |
| `frontend/src/api/` | Typed REST client and the API's types |
| `frontend/src/hooks/`, `components/` | Socket.io state, actions and the UI's components |
| `docs/openapi.yaml` | API contract. **Update it in the same PR as any API change.** |

### Mock mode

`MOCK_MODE=true` starts two simulated modems:

| ID | Profile | SIM |
|---|---|---|
| `modem-1` | Huawei E173: voice and SMS | `READY` |
| `modem-2` | Huawei E3531: SMS only | `SIM PIN` (any PIN unlocks it) |

The mock modems answer the same AT commands as real hardware. Incoming events are injected as raw modem output, so they go through the real parsing path:

```sh
# Plain text (split into a multi-part SMS automatically if long)
# These routes only exist when MOCK_MODE=true. Run the backend with AUTH_DISABLED=true
# for local development, or add -H "Authorization: Bearer $API_TOKEN".
curl -X POST localhost:9333/api/mock/sms -H 'Content-Type: application/json' \
  -d '{"sender":"+12025550199","text":"hello"}'

# A raw PDU you captured (please anonymise it first)
curl -X POST localhost:9333/api/mock/sms -H 'Content-Type: application/json' \
  -d '{"pdu":"00040B912120550591F900006201419140210005E8329BFD06"}'

# The built-in four-part UCS-2 reassembly test
curl -X POST localhost:9333/api/mock/sms -H 'Content-Type: application/json' \
  -d '{"testCase":"multipart-ucs2"}'

# An incoming call
curl -X POST localhost:9333/api/mock/call -H 'Content-Type: application/json' \
  -d '{"number":"+12025550199"}'
```

### Tests

```sh
npm test
```

Tests use Node's built-in test runner (run through `tsx`) and run entirely against mock modems. A bug fix should come with a test that fails without the fix. For PDU bugs, the best test is the (anonymised) PDU that broke it.

## Adding a driver

See [docs/ADDING_A_MODEM.md](docs/ADDING_A_MODEM.md). In short: extend the generic driver, override only what differs, add a mock profile built from a real AT log, add tests for the quirks, and add a row to the README's hardware table.

## Clean-room rule

gsm2http is Apache-2.0 and must stay free of GPL-derived code. Several well-known modem projects are GPL-licensed: chan_dongle, chan_quectel, Gammu, smstools3 and the ModemManager daemon.

- **Do not copy, translate or port code from them**, and do not keep their source open while you write equivalent code for gsm2http.
- Work from the **public specifications** (3GPP TS 27.007, 27.005, 23.040, 23.038), **vendor AT command manuals**, and your **own experiments** with hardware. [docs/protocol-sources.md](docs/protocol-sources.md) lists them.
- In PRs that implement protocol behaviour (PDU encoding, new URCs, init sequences, and especially **SMS sending** and **voice/audio**), say which sources you used.
- Using these projects as *users*, for example to check what a modem does, is fine. Reading their *documentation* is fine. Their source code is off limits.

Third-party dependencies must use a licence compatible with Apache-2.0 (MIT, BSD, ISC, Apache-2.0 and similar). No GPL, LGPL or AGPL dependencies.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Add a `Signed-off-by` line to each commit:

```sh
git commit -s -m "fix(pdu): decode alphanumeric senders with odd length"
```

By signing off, you confirm that you wrote the change, or otherwise have the right to submit it under Apache-2.0, and that it follows the clean-room rule above.

## AI-assisted contributions

You may use AI tools. You are still the author: make sure you understand every line, that the change has been tested, and that it follows the clean-room rule. That rule applies to generated code too, so don't ask a tool to reproduce or port code from the GPL projects above.

## Pull requests

- Keep each PR to one change. Separate refactors from behaviour changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit and PR titles: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`, `build:`, `deps:`. Mark breaking changes with `!` (`feat(api)!: …`) or a `BREAKING CHANGE:` footer. The release changelog is generated from these titles, so write them for users.
- Update `docs/openapi.yaml`, `docs/events.md` and the README together with any API or event change.
- **Never commit real data.** Use fake numbers (`+1 202 555 0100` to `0199`), IMEIs like `000000000000001`, and `example.com` or `.example` hostnames. Don't commit real phone numbers, IMEIs, ICCIDs, webhook URLs, IP addresses, hostnames or usernames. Check AT logs and PDUs for these too.

## Releases

Releases follow [SemVer](https://semver.org/). Before `1.0.0`, any minor version may break the API.

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Every push to `main` updates an open **release PR** that bumps the version in the root, `backend` and `frontend` `package.json` files and adds a section to [CHANGELOG.md](CHANGELOG.md) built from the Conventional Commit titles since the last release (`feat` → Added, `fix` → Fixed, `refactor`/`perf` → Changed, `deps` → Dependencies; `docs`, `chore`, `ci`, `build`, `test` are left out). Before `1.0.0`, `feat` and breaking changes bump the minor version and `fix` bumps the patch.
2. A maintainer reviews the release PR, edits the changelog wording on its branch if needed, and merges it.
3. release-please tags `vX.Y.Z` and creates the GitHub Release with that changelog section. The same workflow then builds `ghcr.io/gsm2http/gsm2http` for `linux/amd64`, `linux/arm64` and `linux/arm/v7` and pushes it as `X.Y.Z` and `X.Y`, plus `X` from `1.0.0` on, and `latest` for releases without a pre-release suffix. Images carry SBOM and build-provenance attestations.

Pushing a `vX.Y.Z` tag by hand also publishes the image, but skips the changelog and GitHub Release. Prefer the release PR.
