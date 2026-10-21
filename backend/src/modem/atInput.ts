/**
 * What may reach a modem's AT command line. User input is checked against these before it
 * is formatted into ATD / AT+CPIN / AT+CMGS, and ModemStream checks every command again
 * before it is written to the serial port.
 */

/** A dialable number: optional leading `+`, then digits only. Anything else could inject AT commands. */
export const DIALABLE_NUMBER = /^\+?\d{3,20}$/;
/** A SIM PIN: 4 to 8 digits (3GPP TS 31.101). */
export const SIM_PIN = /^\d{4,8}$/;
/**
 * Everything written to the modem as a command line: printable ASCII only. CR, LF, Ctrl-Z
 * and ESC end or abort a command, so letting one through would let a caller append their own.
 */
export const SAFE_AT_COMMAND = /^[\x20-\x7E]+$/;
/** The payload after a `> ` prompt (AT+CMGS in PDU mode) is hex and nothing else. */
export const SAFE_PROMPT_PAYLOAD = /^(?:[0-9A-Fa-f]{2})+$/;
