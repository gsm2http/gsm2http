# FAQ

None of this is legal advice. If you rely on gsm2http for something that matters, check your own situation with your carrier and, where needed, a lawyer.

### Is this legal?

In most places, yes. gsm2http is software that uses a modem you own and a SIM you pay for, which is what a phone does. What you send, who you send it to, and whether your plan allows automated messages are up to you, your carrier's terms and your local laws.

### Can I use it for marketing or bulk SMS?

No, and it isn't designed for that. It sends one message to one recipient per request, with rate limits on by default (planned), and it has no contact lists, campaigns or CSV import. Carriers block consumer SIMs that send bulk traffic, and commercial (A2P) messaging belongs on registered providers. Unsolicited marketing messages are illegal in many countries.

### Is this a "SIM farm"?

No. It is built for one or two modems on something like a Raspberry Pi. It has no SIM rotation, SIM pooling or load spreading across SIMs, it never changes a modem's IMEI, and it has no VoIP side. By default it uses at most two modems (`MAX_MODEMS=2`).

**UK users:** from 29 October 2026, the Crime and Policing Act 2026 makes it an offence to possess or supply, without good reason or lawful authority, a device that can use **five or more physical SIMs** to make calls or send texts. The [Home Office guidance](https://www.gov.uk/government/publications/possession-and-supply-of-sim-farms/crime-and-policing-act-2026-guidance-offences-relating-to-the-possession-and-supply-of-sim-farms-and-legitimate-uses-of-multiple-sim-devices-accessi) describes legitimate uses. Read it before you connect five or more SIMs to one machine.

### Can it intercept someone else's SMS or 2FA codes?

No. It can only read messages sent to the SIM card in your modem, just like your phone.

### Can it replace commercial telecom APIs?

For personal and small-site use, often yes. You can receive SMS and control calls through a local REST API and webhooks, with no per-message fees. It is not a carrier network, though: one consumer SIM has the rate limits, coverage and terms of that SIM.

### Does it work with n8n, Home Assistant or Node-RED?

Yes, through REST and webhooks. See [recipes/](recipes/). An n8n community node is on the roadmap.

### Which modems work?

See the [hardware table](../README.md#supported-hardware). Huawei sticks in stick (serial) mode are the best tested. HiLink-mode sticks need a mode switch first, and voice needs voice-enabled firmware.

### Why "GSM" if my stick is LTE?

The name refers to the AT command set (3GPP TS 27.005/27.007), which started with GSM and is still used by 3G and LTE modems.

### Can it make real voice calls with audio?

Not yet. It can dial a number, keep the call up for a set time and hang up, and it reports incoming calls with caller ID. Two-way audio may come later. If you need your dongle to be a phone line now, use [chan_dongle](https://github.com/wdoekes/asterisk-chan-dongle) with Asterisk.

### How does it compare with chan_dongle?

chan_dongle makes the modem a phone line inside Asterisk, for PBX users. gsm2http makes it an HTTP API for automations. Use whichever fits your setup. They can't share a modem at the same time.

### Where are my messages stored, and for how long?

Currently they are not stored by gsm2http at all. They are forwarded to your webhook and the UI, then deleted from the SIM. From `v0.1.0` (planned), a local history is kept in `DATA_DIR` for `RETENTION_DAYS` (default 30). Setting `0` means message bodies are never stored. Nothing is sent anywhere except the webhooks and MQTT broker you configure.

### Is it safe to expose to the internet?

Avoid it. Use a VPN, or a reverse proxy with TLS and its own authentication. See [DEPLOYMENT.md](DEPLOYMENT.md#exposing-it-safely).

### Why did I get the same event twice?

A webhook whose 2xx response got lost on the way back is retried, so a receiver can see an event more than once. De-duplicate on the event's `id` (also in the `X-Gsm2http-Delivery` header). Calls don't cause duplicates: `call.incoming` is sent once per call however many times it rings, and `call.ended` follows. See [events.md](events.md#webhook-delivery).

### Why Apache-2.0?

It lets you embed gsm2http in other projects and products, it includes an explicit patent grant, and the code is written independently with no GPL-derived code. See [protocol-sources.md](protocol-sources.md).

### Was AI used to build this?

Yes. gsm2http was developed with help from AI coding assistants, with human review and testing on real hardware. Contributions are judged on the same standard however they were written. See [CONTRIBUTING.md](../CONTRIBUTING.md).
