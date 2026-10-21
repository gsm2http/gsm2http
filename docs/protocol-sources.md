# Protocol sources

gsm2http is written from public specifications and vendor documentation, not from the code of other modem projects. This page lists those sources. PRs that implement protocol behaviour should cite them, or add new ones here.

| Area | Source |
|---|---|
| AT command syntax, call control, SIM PIN, signal (`+CSQ`), registration (`+CREG`), operator (`+COPS`), caller ID (`+CLIP`) | 3GPP TS 27.007, *AT command set for User Equipment (UE)* |
| SMS commands: `+CMGF`, `+CPMS`, `+CNMI`, `+CMTI`, `+CMGR`, `+CMGL`, `+CMGD`, `+CMGS` | 3GPP TS 27.005, *Use of DTE-DCE interface for SMS and CBS* |
| PDU layout: SMS-DELIVER, SMS-SUBMIT, TP-DCS, TP-SCTS, user data header, concatenation | 3GPP TS 23.040, *Technical realization of the Short Message Service* |
| GSM 7-bit default alphabet and extension table, UCS-2 | 3GPP TS 23.038, *Alphabets and language-specific information* |
| Huawei-specific commands: `^CURC`, `^SYSCFG`, `^SYSCFGEX`, `^CVOICE`, `^CEND` | Huawei AT command interface specifications for the relevant product lines (public PDFs) |
| Modem behaviour and quirks | Hands-on testing on the hardware listed in the README; ModemManager's published D-Bus API *documentation* (not its source) |

3GPP specifications are free to download from [3gpp.org](https://www.3gpp.org/specifications-technologies).

## Clean-room rule

Do not read, copy or port code from GPL-licensed modem projects (chan_dongle, chan_quectel, Gammu, smstools3, ModemManager's source) when working on gsm2http. This matters most for **SMS encoding** and any future **voice/audio** work. Details are in [CONTRIBUTING.md](../CONTRIBUTING.md#clean-room-rule).
