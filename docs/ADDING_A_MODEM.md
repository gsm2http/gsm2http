# Adding a modem

There are two ways to help with a new modem:

1. **Report it.** Try it, capture an AT log, and open a [New modem support](../.github/ISSUE_TEMPLATE/new_modem.yml) issue. A report that says "it doesn't work" is useful too.
2. **Add support in code.** Most modems need no code at all. Some need a different start-up sequence or have quirks, and those changes go in a driver.

## 1. Try it first

Many modems that use standard 3GPP AT commands work with no changes. Plug it in, start gsm2http, and look at `GET /api/modems` and the AT log in the UI.

| Check | How | What "working" looks like |
|---|---|---|
| Detected | `GET /api/modems` | It is listed with a model and IMEI |
| SIM | `simStatus` | `READY`, or `READY` after an unlock |
| Network | `POST …/query`, then look at the log | `+CREG: 0,1` (home) or `0,5` (roaming), and `+COPS` shows an operator |
| Receive SMS | Text the SIM from a phone | `+CMTI` appears in the log, then an `sms.received` event |
| Long SMS | Send 300+ characters, including an emoji | One `sms.received` event with the full text |
| Incoming call | Call the SIM | `RING` and `+CLIP`, then a `call.incoming` event |
| Dial (voice modems) | `POST …/dial` | Your phone rings and the call ends after the duration |

## 2. Capture an AT log

The UI's **AT log** panel shows every command (`> AT+…`) and response. For a log you can paste, start gsm2http with `LOG_LEVEL=debug` and use `docker compose logs gsm2http`: every line sent (`tx`) and received (`rx`) is logged with its modem ID.

To talk to the modem by hand, stop gsm2http first (only one program can use the port):

```sh
docker compose stop gsm2http
# picocom is in most distributions; exit with Ctrl-A Ctrl-X
picocom -b 115200 --omap crlf --echo /dev/ttyUSB0
```

Useful commands to include in a report:

```text
ATI                  manufacturer, model, firmware revision
AT+CGMR              firmware version
AT+CGMM              model
AT+CPIN?             SIM status
AT+CSQ               signal
AT+CREG?             network registration
AT+COPS?             operator
AT+CMGF=0            PDU mode (should answer OK)
AT+CPMS?             SMS storage
AT+CNMI=?            supported new-message indications
AT+CLIP=1            caller ID
AT^CVOICE?           Huawei voice support (ERROR = no voice firmware)
AT^SYSCFGEX=?        Huawei LTE-era network mode command
AT^SYSCFG=?          older Huawei network mode command
```

**Before you post a log, remove** the IMEI and ICCID, your phone numbers, and any PDU hex (the long hex strings after `+CMGR`/`+CMGL`, which contain the message text and sender). Replace them with `XXXX`. Keep the command names and error codes.

## 3. How drivers work

gsm2http talks to modems through **drivers**. A driver holds everything specific to one vendor or model: the init sequence, which unsolicited lines to expect, how to switch 2G/3G, whether voice works, and so on. The core (`ModemManager`, `ModemStream`, `ATParser`, `PDUParser`, `SmsReassembler`) stays vendor-neutral, so new hardware needs a driver file and one line to register it, not core changes.

```
backend/src/modem/
├── ModemManager.ts        port discovery, probing, driver selection, routing
├── ModemStream.ts         one modem: transport, FIFO AT queue, state; delegates to its driver
├── ATParser.ts            +CMTI / +CLIP → sms / call events (vendor-neutral)
├── PDUParser.ts           SMS-DELIVER decode, SMS-SUBMIT encode (vendor-neutral)
├── SmsReassembler.ts      concatenated SMS (vendor-neutral)
├── probe.ts               reads AT+CGMI / CGMM / CGMR / CGSN / CPIN? from a new port
├── drivers/
│   ├── types.ts           ModemDriver, ModemIdentity, ModemCapabilities, ModemContext
│   ├── GenericDriver.ts   3GPP TS 27.007 / 27.005 fallback, base class for vendor drivers
│   ├── HuaweiDriver.ts    E173 / E3531 / E3372 and other Huawei sticks
│   ├── registry.ts        picks a driver per port; MODEM_DRIVER override
│   └── index.ts           ← register new drivers here
├── transport/
│   ├── ModemTransport.ts  the byte-pipe interface (a real SerialPort fits it as-is)
│   └── FakeSerialPort.ts  scripted in-memory port for tests and mock mode
└── mock/
    ├── SimulatedModem.ts  stateful fake device (SIM lock, SMS storage, CMGS) on a FakeSerialPort
    └── mockFleet.ts       the modems MOCK_MODE starts with
```

### How a driver gets chosen

1. Every `SCAN_INTERVAL_MS` (15 s) `ModemManager` lists serial ports (with USB VID:PID when the OS reports it) and opens each new port that isn't already in use.
2. `probeModem()` sends `ATE0`, `AT`, `AT+CGMI`, `AT+CGMM`, `AT+CGMR`, `AT+CGSN` and `AT+CPIN?`. Ports that don't answer are closed, and so are secondary interfaces of a stick that's already managed (same IMEI).
3. The registry checks the `MODEM_DRIVER` override for that port. If there's none, it calls `matches(identity)` on every registered driver and the highest score wins. When two scores are equal, the driver registered last wins. If nothing scores above 0, the port gets `GenericDriver`.
4. `ModemStream` runs the startup sequence through the driver: `querySimStatus`, then `init` if the SIM is READY, then `probeCapabilities`, `querySignal` and `queryNetwork`.

`GET /api/modems` shows which driver each modem got (`driver`) and what it reported (`capabilities`).

## 4. Add a driver

### Step 1: Find out what you have

Plug the modem in and start the backend. The `modem detected` log line shows what the probe found and which driver was picked:

```json
{"level":30,"component":"modem-manager","modemId":"modem-1","port":"/dev/ttyUSB2","model":"EC25","simStatus":"READY","driver":"generic","msg":"modem detected"}
```

The USB ids come from `lsusb` on Linux (e.g. `2c7c:0125`). Keep the AT command manual for your module open; you'll need it for anything vendor-specific.

### Step 2: Try the generic driver first

Many modems work fine with `GenericDriver`. It covers SIM PIN, SMS send and receive in PDU mode, signal and operator queries, `AT+WS46` network selection and `ATD`/`AT+CHUP` calls. Plain 3GPP can't tell whether a modem supports voice, so **voice is off by default**. If SMS works and you don't need calls, you're done.

Write a driver when you need one of these:

- Voice calls, or a reliable way to detect them
- Vendor commands in the init sequence (e.g. silencing periodic status URCs)
- Vendor URCs that should update state, or that leak into command responses
- A network-mode switch that `AT+WS46` doesn't handle
- Odd final result codes (Huawei answers some commands with `COMMAND NOT SUPPORT`, for example)

### Step 3: Write the driver

**Read [the clean-room rule](../CONTRIBUTING.md#clean-room-rule) first.** Work only from the vendor's AT command manual, the 3GPP specifications and your own experiments. Do not open the source of chan_dongle, chan_quectel, Gammu, smstools3 or ModemManager while writing a driver. Name your sources in the PR.

Create `backend/src/modem/drivers/<Vendor>Driver.ts`. Extend `GenericDriver` and override only the behaviour that differs. Here's a minimal but complete example for a Quectel LTE module. Treat the AT details as an illustration and check them against your module's manual:

```ts
import type { NetworkMode } from '../types';
import { GenericDriver, isOk } from './GenericDriver';
import type { ModemCapabilities, ModemContext, ModemIdentity, ModemStatePatch } from './types';

export class QuectelDriver extends GenericDriver {
  public override readonly name = 'quectel';          // used in logs, ModemInfo.driver and MODEM_DRIVER
  public override readonly label = 'Quectel LTE modules';

  // 0 = not mine, higher = better fit. Generic is 1, Huawei uses 100 / 50.
  public override matches(identity: ModemIdentity): number {
    if (identity.usbVendorId === '2c7c') return 100;
    if (identity.manufacturer && /quectel/i.test(identity.manufacturer)) return 100;
    return 0;
  }

  // Lines the modem sends unprompted must bypass the command queue,
  // or they get mixed into whatever command response is in flight.
  public override isUrc(line: string): boolean {
    return super.isUrc(line) || line.startsWith('+QIND:') || line === 'RDY';
  }

  // Pull state out of any line, solicited or not. Fall back to the 3GPP parsing.
  public override handleLine(line: string, ctx: ModemContext): ModemStatePatch | undefined {
    if (line.startsWith('+QIND: "csq"')) {
      const m = /"csq",(\d+)/.exec(line);
      if (m?.[1]) return { signalStrength: Number(m[1]) };
    }
    return super.handleLine(line, ctx);
  }

  public override async probeCapabilities(ctx: ModemContext): Promise<ModemCapabilities> {
    const caps = await super.probeCapabilities(ctx);
    return { ...caps, voice: true };
  }

  public override async setNetworkMode(ctx: ModemContext, mode: NetworkMode): Promise<void> {
    const scanMode: Record<NetworkMode, number> = { auto: 0, '2g': 1, '3g': 2 };
    const lines = await ctx.send(`AT+QCFG="nwscanmode",${scanMode[mode]},1`, 3000);
    if (!isOk(lines)) throw new Error(`nwscanmode rejected: ${lines.join(' ')}`);
  }
}
```

Rules of thumb:

- **One driver instance serves every matching modem.** Don't keep per-modem state in fields. Read what you need from `ctx` (`ctx.identity`, `ctx.getInfo()`).
- **Send every command through `ctx.send()`.** It goes through the modem's FIFO queue, so it never collides with SMS polling or another request. It resolves with all response lines, including the final result code. `ERROR` resolves too, so check for `OK` with `isOk()`. It only rejects on a timeout or a closed port.
- For prompt-style commands (`AT+CMGS`), use `ctx.sendWithPrompt(command, payload)`. Use `ctx.write()` for fire-and-forget commands and `ctx.log()` to add a line to the UI console.
- **Return state, don't set it.** `handleLine`, `querySignal` and `queryNetwork` return a `ModemStatePatch` (`simStatus`, `signalStrength` as 0–31 RSSI, `operator`, `accessTechnology`), and the stream merges it and notifies the UI.
- To change the init order, override `initCommands()` instead of `init()`. `HuaweiDriver` does this to put `AT^CURC=0` right after `AT+CFUN=1`.
- For per-model differences within one vendor, use a small lookup table keyed by `identity.model`, like `MODEL_QUIRKS` in `HuaweiDriver.ts`.

#### The full interface

| Member | Purpose | Generic behaviour |
| --- | --- | --- |
| `name`, `label` | id for logs, API and `MODEM_DRIVER`; description | `generic` |
| `matches(identity)` | score from `{manufacturer, model, revision, usbVendorId, usbProductId}` | `1` |
| `isFinalResponse(line)` | ends a command response | `OK`, `ERROR`, `+CME/+CMS ERROR`, `NO CARRIER`, `BUSY`, `NO ANSWER`, `NO DIALTONE` |
| `isUrc(line)` | unsolicited, bypasses the queue, goes to `ATParser` | `+CMTI`, `+CMT`, `+CLIP`, `+CRING`, `+CUSD`, `RING` |
| `isCallEnded(line)` | ends an outgoing call early | `NO CARRIER`, `BUSY`, `NO ANSWER` |
| `handleLine(line, ctx)` | state from any line | `+CPIN`, `+CME ERROR: 10/11/12`, `+CSQ`, `+COPS` |
| `querySimStatus(ctx)` | PIN state | `AT+CPIN?` |
| `init(ctx)` / `initCommands()` | after SIM READY | `AT+CFUN=1`, `AT+CPMS="SM","SM","SM"`, `AT+CMGF=0`, `AT+CNMI=2,1,0,0,0` |
| `probeCapabilities(ctx)` | `{sms, voice, ussd, audio}` | sms on, voice off, ussd from `AT+CUSD=?` |
| `unlock(ctx, pin)` | SIM PIN | `AT+CPIN="<pin>"` |
| `sendSms(ctx, to, text)` | SMS-SUBMIT PDUs, multipart when needed | `AT+CMGS=<len>` → `> ` → PDU + Ctrl-Z |
| `dial(ctx, number)` | start a voice call; throw on refusal | `ATD<number>;` |
| `hangup(ctx)` | end a call | `AT+CHUP`, then `ATH` 50 ms later |
| `querySignal(ctx)` | signal | `AT+CSQ` |
| `queryNetwork(ctx)` | operator / access technology | `AT+CREG?`, `AT+COPS?` |
| `setNetworkMode(ctx, '2g' \| '3g' \| 'auto')` | RAT preference | `AT+WS46=12/22/25` |

### Step 4: Register it

Add your driver to `backend/src/modem/drivers/index.ts`:

```ts
export const defaultDriverRegistry = new DriverRegistry([
  new HuaweiDriver(),
  new QuectelDriver()
], new GenericDriver());
```

### Step 5: Test it against a simulated modem

You can test without hardware. `SimulatedModem` is a stateful fake device on top of a `FakeSerialPort`. It answers the standard commands, keeps SMS storage, enforces the SIM PIN and records every PDU sent with `AT+CMGS`. For vendor commands, add rules with `port.onCommand(match, reply)`. A new rule takes priority over the existing ones. A reply can be a list of lines, a function of the regex match, or `null` to simulate a timeout.

Create `backend/src/modem/drivers/QuectelDriver.test.ts` (any `*.test.ts` under `backend/src/` is picked up by `npm test`):

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDriverRegistry } from '.';
import { QuectelDriver } from './QuectelDriver';
import { startModem } from './testUtils';

const EC25 = {
  manufacturer: 'Quectel', model: 'EC25', imei: '867000000000001',
  usbVendorId: '2c7c', simStatus: 'READY' as const, operator: 'Test Net', voice: true
};

describe('QuectelDriver', () => {
  it('is selected for Quectel hardware', () => {
    assert.equal(defaultDriverRegistry.select({ usbVendorId: '2c7c' }).name, 'quectel');
  });

  it('switches network mode with nwscanmode and tracks +QIND signal', async () => {
    const { stream, port } = await startModem(EC25, new QuectelDriver());
    port.onCommand(/^AT\+QCFG="nwscanmode"/, 'OK');

    await stream.setNetworkMode('3g');
    assert.ok(port.received.includes('AT+QCFG="nwscanmode",2,1'));

    port.inject('\r\n+QIND: "csq",17,99\r\n');
    assert.equal(stream.signalStrength, 17);
    assert.equal(stream.supportsVoice, true);

    await stream.sendSms('+15555550100', 'hello');   // the whole SMS path, on your driver
    stream.close();
  });
});
```

`startModem(profile, driver)` builds the stream, waits for the startup sequence and clears `port.received`, so assertions only see the commands your test triggered. To exercise the probe as well, call `probeModem(simulator.port, { settleMs: 0 })`.

To try the driver in the running app without hardware, add an entry with your profile to `backend/src/modem/mock/mockFleet.ts` and start with `MOCK_MODE=true`. Mock mode runs simulated modems through the same `ModemStream` + driver + `ATParser` code as real ones.

### Step 6: Run it on hardware, and override when needed

```bash
npm run check && npm run dev:backend
```

`GET /api/modems` should now show `"driver": "quectel"`. If auto-detection picks the wrong driver, or you want to compare against the generic one, force a choice per port:

```bash
MODEM_DRIVER=generic                              # every port
MODEM_DRIVER=/dev/ttyUSB2=quectel                 # one port
MODEM_DRIVER=ttyUSB2=quectel,ttyUSB5=generic      # by basename, several ports
```

If you force an unknown driver name, gsm2http logs a warning and falls back to auto-detection.

### Checklist for a driver PR

- [ ] `matches()` returns 0 for hardware that isn't yours. Test it with the identities from your probe log.
- [ ] Every unsolicited line your modem sends is listed in `isUrc()`.
- [ ] `probeCapabilities()` reports honestly; the UI and the dial endpoint rely on `voice`.
- [ ] Tests use `SimulatedModem`/`FakeSerialPort`, and `npm test` passes.
- [ ] No personal data (phone numbers, IMEIs, hostnames) in code, tests or docs. Use `+1555555xxxx` numbers and made-up IMEIs.
- [ ] A row in the README hardware table: model, network, firmware revision tested (`AT+CGMR`), SMS in/out, voice.

## Voice and audio

Currently gsm2http only controls calls: it can dial and hang up, and it reports incoming calls with caller ID. Two-way audio (for example Huawei's PCM-over-serial with `AT^CVOICE`) is a possible future feature. It is also exactly where the GPL-licensed Asterisk drivers are most distinctive, so **audio work must follow the clean-room rule strictly**. Please open a discussion before starting it.
