# Deployment

gsm2http runs as a single Node.js process that owns the modem's serial ports, exposes the REST API, sends webhooks and serves the web UI, all on one port (9333 by default). You can run it:

| Path | Best for | Section |
|---|---|---|
| **Docker, one container** (`docker-compose.yml`) | Most installs, including a Raspberry Pi | [Docker Compose](#docker-compose) |
| Docker, two containers (`docker-compose.split.yml`) | Putting the UI behind its own proxy | [Split deployment](#split-deployment-backend--nginx) |
| Bare metal + systemd | No Docker, smallest footprint | [Running without Docker](#running-without-docker) |
| macOS, natively | Development (Docker Desktop cannot pass USB through) | [macOS](#macos-development) |

> **Security:** gsm2http will not start without an `API_TOKEN` (at least 32 characters; `openssl rand -hex 32`). The REST API, the Socket.io stream and the web UI all require it. Everything below still binds to `127.0.0.1` by default; read [Exposing it safely](#exposing-it-safely) before changing that.

## Before you start

- **Put a prepaid SIM with a small balance in the modem** while you try things out. Check it works in a phone first, and consider removing its PIN there (Settings → SIM lock) so a bad PIN can't lock it.
- **Check your carrier's 2G/3G network availability.** 3G networks have been largely shut down across Europe, the UK, and North America. In many countries, carriers maintain legacy **2G (GSM)** networks for IoT and SMS fallback, allowing older "3G" modems (like the Huawei E173) to continue sending and receiving SMS over 2G. In regions without 2G or 3G coverage (e.g. North America), an LTE Cat-1 or Cat-4 modem is required.
- **Only one program can use an AT port at a time.** On most Linux desktops and on Raspberry Pi OS, **ModemManager** grabs USB modems as soon as they are plugged in. Either stop it:

  ```sh
  sudo systemctl disable --now ModemManager
  ```

  or keep it and tell it to ignore your stick (see [udev and ModemManager](#udev-and-modemmanager)). Also stop any `gammu-smsd`, `smsd` or Asterisk `chan_dongle` that uses the same ports. This matters on Docker hosts too: ModemManager on the **host** interferes just the same.

- Check the modem shows up as serial ports:

  ```sh
  ls -l /dev/ttyUSB* /dev/ttyACM*
  ls -l /dev/serial/by-id/
  ```

  If you see none, but `ip link` shows a new network interface (often with a web UI at `192.168.8.1`), the stick is in HiLink mode or still in storage mode. See [HiLink vs stick mode](#hilink-vs-stick-mode) and [USB mode switching](#usb-mode-switching).

## Supported platforms

Images are built for `linux/amd64`, `linux/arm64` and `linux/arm/v7`.

| Hardware | OS | Image platform |
|---|---|---|
| x86-64 PC, NUC, VM | any 64-bit Linux | `linux/amd64` |
| Raspberry Pi 3, 4, 5, Zero 2 W | 64-bit Raspberry Pi OS / Debian / Ubuntu | `linux/arm64` (recommended) |
| Raspberry Pi 2, 3, 4 | 32-bit Raspberry Pi OS (armhf) | `linux/arm/v7` |
| Raspberry Pi 1, Zero, Zero W (ARMv6) | n/a | **not supported** (no official Node.js 22 build) |

The runtime is pinned to **Node.js 22 LTS** (`node:22.23.3-bookworm-slim`). Node 22 is the newest LTS line that still ships official `linux/arm/v7` builds; Node 24 dropped them. The serial port library ships prebuilt binaries for all three platforms (glibc), so no compiler is needed.

Check what a machine is with `uname -m` (`x86_64`, `aarch64`, `armv7l`) and `dpkg --print-architecture` (`amd64`, `arm64`, `armhf`).

## Docker Compose

### Quick start

```sh
git clone https://github.com/gsm2http/gsm2http.git && cd gsm2http
cp .env.example .env            # set WEBHOOK_URL, MODEM_PORTS, ...
sed -i "s/^API_TOKEN=.*/API_TOKEN=$(openssl rand -hex 32)/" .env
# edit devices: in docker-compose.yml to list your modem's ports
docker compose up -d --build
docker compose ps               # wait for "healthy"
curl http://127.0.0.1:9333/healthz
```

Open `http://127.0.0.1:9333/` for the UI and sign in with the `API_TOKEN` from `.env` (the browser remembers it). The API is under `/api/`, and live events use Socket.IO at `/socket.io/`, all on the same origin. The UI needs no build-time API URL, so one image works on any host or port.

### Configuration

Everything lives in `.env`. Docker Compose uses the file both for its own settings and as the container's environment. Shell variables are **not** passed into the container; put them in `.env`. The README lists every gsm2http setting; these matter most for deployment:

| Variable | Default | Purpose |
|---|---|---|
| `API_TOKEN` | *(required)* | Bearer token for the API, Socket.io and UI sign-in; at least 32 characters. The container exits at startup without it. |
| `CORS_ORIGINS` | *(empty)* | Browser origins allowed to call the API from another site. Empty means same origin only. |
| `MODEM_PORTS` | `auto` | `auto` scans `/dev/ttyUSB*` and `/dev/ttyACM*`. Or a comma-separated list of ports to use **exclusively**; `*` wildcards are allowed in the last path segment, e.g. `/dev/serial/by-id/usb-HUAWEI_*-if02-port0` |
| `POLL_INTERVAL_MS` | `30000` | Fallback sweep of SIM storage for SMS (min 5000) |
| `SCAN_INTERVAL_MS` | `15000` | How often to look for newly plugged-in modems (min 5000) |
| `MOCK_MODE` | `false` | Simulated modems, no hardware |
| `GSM2HTTP_BIND` / `GSM2HTTP_PORT` | `127.0.0.1` / `9333` | Host address and port to publish on |
| `DIALOUT_GID` | `20` | Group id that owns `/dev/ttyUSB*` on the host |
| `HOST` / `PORT` | `127.0.0.1` / `9333` | Listen address (bare metal only; containers always use `0.0.0.0:9333` inside) |

### Modem access

A USB stick usually shows up as several serial ports (for example a Huawei E173 as `ttyUSB0..2`): one for data/PPP, one for diagnostics and one for AT commands. gsm2http probes each port and keeps one per physical modem, de-duplicated by IMEI. The container therefore needs access to USB serial devices, and **nothing else**. **Never use `privileged: true`**: it gives the container every device and every capability on the host.

#### Default: explicit `devices:`

`docker-compose.yml` passes through only the ports you list:

```yaml
devices:
  - /dev/serial/by-id/usb-HUAWEI_Technology_HUAWEI_Mobile-if00-port0:/dev/ttyUSB0
  - /dev/serial/by-id/usb-HUAWEI_Technology_HUAWEI_Mobile-if02-port0:/dev/ttyUSB2
group_add:
  - '${DIALOUT_GID:-20}'
```

- **Pass through every port of the stick.** Only one or two accept AT commands; gsm2http works out which.
- Docker resolves `by-id` symlinks when it creates the container, so these names survive reboots and replugs. List yours with `ls -l /dev/serial/by-id/`.
- The container sees only the device nodes that existed when it was created. After plugging in a new modem, or if the stick comes back under a different number, run `docker compose up -d --force-recreate`.

#### Hotplug: device cgroup rules

If modems come and go while gsm2http runs, replace `devices:` with the commented-out block in `docker-compose.yml`:

```yaml
device_cgroup_rules:
  - 'c 188:* rmw'   # ttyUSB* (usbserial, option, qcserial drivers)
  - 'c 166:* rmw'   # ttyACM* (cdc_acm)
volumes:
  - /dev:/dev:ro
```

- The cgroup rules let the container open **only** USB-serial and ACM character devices, plus Docker's usual `null`/`zero`/`random`/`tty` set. Every other device node is visible in the listing but cannot be opened.
- Bind-mounting the host's `/dev` read-only lets modems that are plugged in, or re-enumerate, **after** the container started appear inside it. `/dev/serial/by-id/` symlinks resolve too. Docker still mounts the container's own `/dev/pts` and `/dev/shm` on top, so host terminals are not exposed. Read-only does not stop reads and writes to a character device; it only prevents creating files in `/dev`.
- The trade-off: the container can *see* every device name on the host, and any USB-serial device (a Zigbee stick, a GPS) can be opened. Set `MODEM_PORTS` to your modem's `by-id` path so nothing else is ever sent AT commands.
- Some rootless Docker and older cgroup-v1 hosts ignore device cgroup rules (`Operation not permitted` when opening the port). Use explicit `devices:` there.

#### Both modes

- The process runs as uid `10001` (not root, and not the first host user `1000`) in the `dialout` group. `group_add` adds the **host's** gid of the tty devices in case your distribution uses a different one: check it with `stat -c %g /dev/ttyUSB0`. Arch-based systems, for example, use `uucp`.
- The container drops all capabilities, sets `no-new-privileges` and runs with a read-only root filesystem.
- Nothing inside the container can run `usb_modeswitch` or load kernel modules; both happen on the host.
- Docker Desktop (macOS/Windows) cannot pass USB devices to containers. Use mock mode there, or run natively.

### Mock mode

```sh
echo 'MOCK_MODE=true' >> .env
```

Remove the `devices:` section. You get two simulated modems: `modem-1`, a Huawei E173 that can make calls and send and receive SMS with its SIM ready, and `modem-2`, an SMS-only stick waiting for a PIN (any PIN is accepted). The `/api/mock/*` endpoints and the UI's test buttons inject incoming SMS and calls.

### Health, logs and shutdown

- `GET /healthz` returns `200` with `{status, uptimeSeconds, mockMode, modems: {total, connected}}`. It is a liveness check: a missing modem is **not** unhealthy, because the process keeps scanning and recovers on its own when the modem returns. To alert on "no modem", watch `modems.connected` or `GET /api/modems`. A Docker healthcheck does not restart a container by itself.
- The image's `HEALTHCHECK` and the compose `healthcheck` call `/healthz` with Node's built-in `fetch`, since the slim image has no curl.
- Logs are JSON lines on stdout. Compose rotates them (`json-file`, 3 × 10 MB).
- `restart: unless-stopped` brings the service back after a crash or reboot. On `docker compose down` or `stop`, the process gets `SIGTERM`, hangs up any active call, closes the serial ports and exits within about a second.

### Split deployment (backend + nginx)

```sh
docker compose -f docker-compose.split.yml up -d --build
```

- `backend` (`backend/Dockerfile`) is the API only, published on `GSM2HTTP_PORT` for automations.
- `web` (`frontend/Dockerfile`) is unprivileged nginx on port 8080 inside the container, published on `GSM2HTTP_WEB_PORT` (9334). It serves the UI and proxies `/api/`, `/healthz` and `/socket.io/` (WebSocket included) to `BACKEND_URL` (default `http://backend:9333`). Both are set at **runtime**, so one image fits every deployment.

If you host the UI somewhere that cannot proxy to the backend, override `/config.js` (for example by bind-mounting a file over `/usr/share/nginx/html/config.js`):

```js
window.__GSM2HTTP_CONFIG__ = { apiUrl: 'https://gateway.example.com' };
```

Then allow that UI's origin on the backend, for example `CORS_ORIGINS=https://ui.example.lan`. Without it the browser blocks the requests: by default the backend answers same-origin requests only.

### Building images and multi-arch

All Dockerfiles build from the repository root, because the project is an npm workspace with one lockfile:

```sh
# Native platform, loaded into the local engine
docker build -t gsm2http .                                     # all-in-one
docker build -f backend/Dockerfile -t gsm2http-backend .       # API only
docker build -f frontend/Dockerfile -t gsm2http-web .          # nginx UI

# All three platforms (needs a docker-container builder; QEMU is bundled with Docker
# Desktop, on Linux install binfmt: docker run --privileged --rm tonistiigi/binfmt --install all)
docker buildx create --name multi --driver docker-container --use
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t <registry>/gsm2http:<version> --push .
```

How the images are built:

- **Multi-stage.** TypeScript and the UI are compiled on the build host (`--platform=$BUILDPLATFORM`), since the output is platform independent. This keeps Vite's and Tailwind's native build tools off emulated ARM, and there is no `ts-node` at runtime.
- **Target-platform dependencies.** Only `npm ci --omit=dev --workspace backend` runs for the target platform, and it picks up the matching serialport prebuild.
- **Runtime.** The final stage runs `node backend/dist/index.js` as the non-root `gsm2http` user. Nearly all of the image is the `node:22-bookworm-slim` base.

To deploy to a Pi without a registry, build on the Pi itself (`docker compose up -d --build`; slow on older boards), or build elsewhere and copy:

```sh
docker buildx build --platform linux/arm64 -t gsm2http:local -o type=docker,dest=gsm2http.tar .
scp gsm2http.tar <pi>: && ssh <pi> docker load -i gsm2http.tar
```

## Stable device names

`/dev/ttyUSB0` can turn into `/dev/ttyUSB3` after a reboot or replug, especially with two sticks. Use the `/dev/serial/by-id/` links, both in `devices:` (see above) and in `MODEM_PORTS`.

If two identical sticks have the same `by-id` name, write a udev rule keyed on the USB path instead. The same rule can tell ModemManager to leave them alone:

```udev
# /etc/udev/rules.d/90-gsm2http.rules
# Find ID_PATH with: udevadm info -q property -n /dev/ttyUSB0 | grep ID_PATH
SUBSYSTEM=="tty", ENV{ID_PATH}=="platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.1:1.0", SYMLINK+="gsm2http-a-at", ENV{ID_MM_DEVICE_IGNORE}="1"
```

```sh
sudo udevadm control --reload && sudo udevadm trigger
```

### udev and ModemManager

`deploy/udev/99-gsm2http.rules` sets `ID_MM_DEVICE_IGNORE` for Huawei (`12d1`) and makes `ttyUSB*`/`ttyACM*` group `dialout`, mode `0660`. Add a line per vendor id from `lsusb` for other brands.

```sh
sudo cp deploy/udev/99-gsm2http.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

## HiLink vs stick mode

Many LTE sticks, including most Huawei E3372 units sold since about 2015, ship with **HiLink** firmware. In HiLink mode the stick works as a USB network card with its own router and web UI, and has **no AT port**. gsm2http needs **stick mode** (also called "modem" or "serial" mode), where the stick shows up as `/dev/ttyUSB*` ports.

The options, from least to most risky:

1. **Buy a stick-mode model or variant.** For the E3372, these are usually sold as `E3372s` or `E3372h` with "stick" firmware. Check the listing for "modem mode", or for "AT commands" and "ttyUSB".
2. **Switch the USB mode.** Some firmware versions expose a serial port after a `usb_modeswitch` message, or have a setting to switch mode permanently. The commands depend on the model and firmware, so look up your exact model and firmware version.
3. **Flash stick firmware.** This can work, but it can also brick the device, and the tools come from unofficial sources. Do it only on hardware you can afford to lose.

If you get a stick working in serial mode, please add the steps to the hardware table with a [New modem support](../.github/ISSUE_TEMPLATE/new_modem.yml) issue.

### USB mode switching

Most sticks first appear as a virtual CD-ROM with the Windows driver. `usb_modeswitch` (on the host) flips them into modem mode:

```sh
sudo apt install usb-modeswitch usb-modeswitch-data
lsusb            # e.g. 12d1:1f01 / 12d1:1446 = storage mode; 12d1:1001 / 12d1:1506 = modem mode
ls /dev/ttyUSB*  # serial ports appear after the switch
```

`usb-modeswitch-data` covers most common sticks automatically via udev; replug after installing. If the stick stays in storage mode, look up its ID in `/usr/share/usb_modeswitch/` and the usb_modeswitch documentation.

## Raspberry Pi

1. **Use a 64-bit OS if you can.** Docker Engine 28 was the last major release with packages for 32-bit Raspberry Pi OS; from v29 Docker points armhf users to its Debian armhf packages, and ARMv6 boards are not covered at all. The `linux/arm/v7` image still works on 32-bit installs (Pi 2, or an existing armhf system).
2. **Power.** 3G/LTE sticks can draw more than 500 mA while registering or transmitting. Brown-outs show up as the modem dropping off the bus (`dmesg`: `USB disconnect`) and coming back. gsm2http recovers from that, but SMS can be missed while it happens. A powered USB hub fixes it. `vcgencmd get_throttled` should print `throttled=0x0`.
3. Install Docker (`curl -fsSL https://get.docker.com | sh`), add your user to the `docker` group, then follow the [quick start](#quick-start).
4. Check the modem is in serial mode (`ls /dev/ttyUSB*`) and that ModemManager is not grabbing it.
5. Signal inside a metal case or near the Pi's Wi-Fi can be poor. A short USB extension cable often helps more than anything else.

`MODEM_PORTS=auto` only probes `ttyUSB*`/`ttyACM*`, never the Pi's on-board UARTs (`ttyAMA0`, `ttyS0`), which carry the serial console or Bluetooth. If you have other USB-serial devices (Zigbee or Z-Wave sticks, GPS, an Arduino), set `MODEM_PORTS` to your modem's `/dev/serial/by-id/...` path so they are never sent AT commands.

## Exposing it safely

gsm2http controls something that can spend money and read your one-time codes. Keep it local whenever you can.

| Situation | Recommendation |
|---|---|
| Automations on the same host | Keep the default `127.0.0.1` binding |
| Automations on the LAN | Set `GSM2HTTP_BIND` (or `HOST` on bare metal) to the LAN address and firewall everything else. The `API_TOKEN` protects the API, but traffic is plain HTTP: anyone who can sniff the LAN can read the token and the messages. Prefer TLS (a reverse proxy) on shared or Wi-Fi networks. |
| Access from outside your network | Use a VPN such as WireGuard or Tailscale. If you really need a public URL, put a reverse proxy with TLS in front and add authentication there as well. |
| Webhooks to a cloud automation service | Outbound only. Nothing needs to be opened inbound. |

What a default install does to be safe on a LAN:

- **Token required.** Every `/api/` route and every Socket.io connection needs `Authorization: Bearer <API_TOKEN>` (Socket.io: `auth: { token }`). Only `/healthz` and the UI's static files are public. After 20 wrong tokens in 5 minutes, further wrong tokens from that client address get `429` for the rest of the window; the correct token is always accepted, so a guesser behind the same reverse proxy can't lock out your UI or automations. `AUTH_DISABLED=true` turns this off and logs a warning at startup; use it only on `127.0.0.1`.
- **Same origin only.** No CORS headers unless you list origins in `CORS_ORIGINS`.
- **Validated input.** Phone numbers must be `+` and digits, PINs 4–8 digits, SMS text free of control characters other than line breaks, modem IDs a short safe set of characters. Every command is checked again before it is written to the serial port, so nothing can append its own AT command.
- **Rate limits** per modem: `SMS_MIN_INTERVAL_MS` (10 s), `SMS_DAILY_LIMIT` (50), `CALLS_HOURLY_LIMIT` (5) and `UNLOCK_HOURLY_LIMIT` (3). They are kept in memory, so a restart resets them.
- **The SIM cannot be PUK-locked through the API.** Before each unlock, gsm2http asks the modem how many PIN attempts are left (`AT+CPINR`, or `AT^CPIN?` on Huawei) and refuses when only one is left. If the modem can't say, it refuses after one wrong PIN until restarted.
- **Webhook and MQTT targets are configuration only** (`.env` or `CONFIG_FILE`); there is no API to change them, because whoever sets a webhook receives every SMS, one-time codes included.
- **`/api/mock/*` exists only with `MOCK_MODE=true`.**
- **HTTP hardening:** security headers (a strict Content-Security-Policy, `X-Content-Type-Options`, frame protection), a 32 KB request body limit, and error responses without stack traces. HSTS is left to your TLS proxy.

Forward `/` (or just `/api/`, `/healthz` and `/socket.io/`) to port 9333, and allow WebSocket upgrades on `/socket.io/`. Synchronous dials (`"sync": true`) hold the request open for the length of the call, so allow a read timeout longer than your longest call.

### Reverse proxy (Caddy)

```caddyfile
sms.example.internal {
    reverse_proxy 127.0.0.1:9333   # Caddy proxies Socket.io WebSockets automatically
}
```

### Reverse proxy (nginx)

```nginx
location / {
    proxy_pass http://127.0.0.1:9333;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;     # Socket.io
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;                    # dial with "sync": true can take a while
}
```

## Running without Docker

You need Node.js 20.19 or later (Node 22 LTS recommended; on `armv7l` stay on Node 22, since Node 24 has no official 32-bit ARM builds), from your distribution, [NodeSource](https://github.com/nodesource/distributions) or the official tarball.

```sh
sudo git clone https://github.com/gsm2http/gsm2http.git /opt/gsm2http
cd /opt/gsm2http
sudo cp .env.example .env && sudo nano .env
sudo scripts/build.sh --prune   # backend -> backend/dist, UI -> frontend/dist
```

- `scripts/build.sh` runs `npm ci` and the TypeScript and Vite builds. `--prune` removes dev dependencies afterwards. `--no-ui` skips the UI; `frontend/dist` is plain static files, so you can build it on a faster machine and copy it over.
- `scripts/start.sh` runs `node backend/dist/index.js` from the repository root. It reads `.env` from there and serves the UI from `frontend/dist` if present. Use it for a quick manual run.

### systemd

```sh
sudo useradd --system --home-dir /opt/gsm2http --shell /usr/sbin/nologin --groups dialout gsm2http
sudo chown root:gsm2http /opt/gsm2http/.env && sudo chmod 640 /opt/gsm2http/.env
sudo cp deploy/systemd/gsm2http.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gsm2http
systemctl status gsm2http
journalctl -u gsm2http -f
```

The unit (`deploy/systemd/gsm2http.service`) runs as the unprivileged `gsm2http` user with `SupplementaryGroups=dialout` and restarts on failure. It applies the same least-privilege idea as the container: `DevicePolicy=closed` plus `DeviceAllow=char-ttyUSB rw` / `char-ttyACM rw`, a read-only view of the system (`ProtectSystem=strict`), no capabilities and `MemoryMax=256M`. Edit `WorkingDirectory` and `STATIC_DIR` if you installed somewhere other than `/opt/gsm2http`.

## macOS (development)

Docker Desktop cannot pass USB through, so develop natively:

```sh
npm ci
AUTH_DISABLED=true MOCK_MODE=true npm run dev:backend   # API on 127.0.0.1:9333, two mock modems
npm run dev:frontend                 # UI on :5173, proxies /api and /socket.io to :9333
```

Point the Vite dev server at another backend with `GSM2HTTP_BACKEND=http://host:9333 npm run dev:frontend`.

For a real stick on macOS:

- With `MODEM_PORTS=auto`, gsm2http scans `/dev/cu.usbmodem*`, `/dev/cu.usbserial*`, `/dev/cu.wchusbserial*` and `/dev/cu.HUAWEI*`. List candidates with `ls /dev/cu.*`.
- Always use the **`/dev/cu.*`** node, not `/dev/tty.*`: opening `tty.*` blocks until the device raises carrier detect.
- Many older Huawei sticks need a vendor driver on macOS and may not appear at all on Apple Silicon. Mock mode or a Linux box is the reliable route.

## Runtime behaviour

What gsm2http does to stay stable on small machines and flaky USB:

- **One AT command at a time per port.** Each modem has a FIFO queue; a command is written only after the previous one finished (`OK`/`ERROR`/`+CME`/`+CMS`) or timed out (5 s default). Unsolicited messages (`+CMTI`, `RING`, `+CLIP`, …) are handled outside the queue. The queue holds at most 32 waiting commands; beyond that, requests fail immediately instead of piling up behind a hung modem.
- **Polling that doesn't flood the modem.** Incoming SMS arrive by the `+CMTI` notification. A fallback `AT+CMGL` sweep runs every `POLL_INTERVAL_MS` (30 s), never during a call and never when the SIM is locked. The hotplug scan (every `SCAN_INTERVAL_MS`) only probes **new** ports: a port that did not answer like a modem, or that is a second interface of an already connected stick, is left alone until its device node is recreated (replug) or 5 minutes pass. With `MODEM_PORTS` set, only the listed ports are probed.
- **Unplug and replug.** A disconnect closes the modem, fails its pending commands, ends any active call, and stops its timers. When the stick returns, it is detected again and keeps its ID (`modem-1` stays `modem-1`, matched by IMEI). IDs never move to a different stick.
- **Bounded memory.** Serial lines are capped at 16 KB (a port spewing binary cannot grow the buffer), multipart SMS reassembly gives up after 30 s without a new part, webhook requests time out after 10 s and at most 1,000 deliveries per sink wait for a retry (MQTT likewise queues at most 1,000 publishes while the broker is down), and the UI keeps the last 100 raw log lines and 200 SMS and calls.
- **Clean shutdown.** `SIGTERM`/`SIGINT` hang up active calls, give webhook requests in flight up to 2 s, publish `offline` to MQTT, then close the serial ports and the HTTP server.

## Upgrading

```sh
git pull && docker compose up -d --build
```

Read [CHANGELOG.md](../CHANGELOG.md) first. While gsm2http is in alpha (`0.x`), any minor release may break the API.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No modems found | `ls -l /dev/ttyUSB* /dev/serial/by-id/`. No ports: see [USB mode switching](#usb-mode-switching) and [HiLink](#hilink-vs-stick-mode). Ports but no modem: ModemManager or another daemon holds them (`sudo lsof /dev/ttyUSB*`), the device isn't passed into the container, or set `MODEM_PORTS` explicitly |
| `Permission denied` opening `/dev/ttyUSB0` | Device gid vs `DIALOUT_GID` (`stat -c '%g %G' /dev/ttyUSB0`); on bare metal the `gsm2http` user must be in that group |
| `Operation not permitted` in Docker | Hotplug mode on a host that ignores device cgroup rules, or `devices:` mode after a replug. Use `devices:` and recreate the container |
| Modem found, `simStatus: "SIM PIN"` | Unlock it in the UI or with `POST /api/modems/{id}/unlock`, or remove the PIN in a phone |
| `simStatus: "SIM PUK"` | Too many wrong PINs. Get the PUK from your carrier and unlock the SIM in a phone. |
| `signalStrength: 99` | No signal or not registered yet. Wait 30 s, check the antenna and placement, and check the SIM has service. |
| Calls fail on an LTE stick | Many LTE sticks have no voice support, and voice may need `2g`/`3g` mode on others (`POST …/network`) |
| SMS arrives in the UI but no webhook | Check the UI's *Notifiers* panel or `GET /api/notifiers`: no sink means `WEBHOOK_URL`/`CONFIG_FILE` is not set; failures show the HTTP status or error. `docker compose logs` has one `webhook …` line per attempt. A 401 from your receiver usually means a `WEBHOOK_SECRET` mismatch. |
| Startup fails with `config.yaml.notifiers[0]…` | A typo in the config file: the message names the setting. Unknown keys and event names are rejected on purpose. |
| Modem drops and returns every few minutes on a Pi | Power. Use a powered hub and check `vcgencmd get_throttled`. |
| UI loads but stays "disconnected" | Your proxy must forward WebSocket upgrades on `/socket.io/` |
| Container exits with `API_TOKEN is required` | Set `API_TOKEN` in `.env` (`openssl rand -hex 32`); see [Exposing it safely](#exposing-it-safely) |
| `401 Missing or invalid API token` | Send `Authorization: Bearer <API_TOKEN>`. In the UI, use **Sign out** and sign in with the current token. |
| `429` with `Retry-After` | A rate limit or the wrong-token lockout. Wait, or raise the limit in `.env`. |
| `409` "refusing to risk a PUK lock" on unlock | The SIM has one PIN attempt left (or the modem rejected a PIN and can't report the count). Check the PIN and unlock it in a phone. |

When you report a bug, include the AT log from the UI or `docker compose logs`, after removing phone numbers and message text. See the [bug template](../.github/ISSUE_TEMPLATE/bug_report.yml).
