import type { Request } from 'express';
import { DIALABLE_NUMBER, SAFE_PROMPT_PAYLOAD, SIM_PIN } from '../modem/atInput';
import { NETWORK_MODES, type NetworkMode } from '../modem/types';
import { badRequest } from './errors';

/** Minimum call length: the modem needs time to establish the call after ATD. */
export const MIN_CALL_DURATION_MS = 500;

/** 10 concatenated GSM 7-bit parts, as in docs/openapi.yaml. */
export const MAX_SMS_TEXT_LENGTH = 1530;

export type Body = Record<string, unknown>;

export function body(req: Request): Body {
  const value: unknown = req.body;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Body)
    : {};
}

export function optionalString(b: Body, key: string): string | undefined {
  const value = b[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`"${key}" must be a string`);
  return value;
}

export function optionalBoolean(b: Body, key: string): boolean {
  const value = b[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw badRequest(`"${key}" must be a boolean`);
  return value;
}

function optionalPositiveNumber(b: Body, key: string): number | undefined {
  const value = b[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw badRequest(`"${key}" must be a positive number`);
  }
  return value;
}

/** Accepts common formatting (spaces, dots, dashes, parentheses) and returns `+` and digits. */
export function phoneNumber(b: Body, key: string): string {
  const raw = optionalString(b, key);
  if (!raw) throw badRequest(`"${key}" is required`);
  // Only these exact characters are dropped: tabs, CR/LF and the like must fail the check.
  const number = raw.replace(/[ ().-]/g, '');
  if (!DIALABLE_NUMBER.test(number)) {
    throw badRequest(`"${key}" must be a phone number: an optional "+" followed by digits`);
  }
  return number;
}

export function simPin(b: Body): string {
  const pin = optionalString(b, 'pin');
  if (!pin) throw badRequest('"pin" is required');
  if (!SIM_PIN.test(pin)) throw badRequest('"pin" must be 4 to 8 digits');
  return pin;
}

export function networkMode(b: Body): NetworkMode {
  const type = b.type;
  if (typeof type !== 'string' || !NETWORK_MODES.includes(type as NetworkMode)) {
    throw badRequest(`"type" must be one of ${NETWORK_MODES.join(', ')}`);
  }
  return type as NetworkMode;
}

/** `durationMs` wins over `durationSeconds`; neither means the configured default. */
export function callDuration(b: Body, defaultMs: number): number {
  const ms = optionalPositiveNumber(b, 'durationMs');
  const seconds = optionalPositiveNumber(b, 'durationSeconds');
  const duration = ms ?? (seconds === undefined ? defaultMs : seconds * 1000);
  return Math.max(MIN_CALL_DURATION_MS, Math.round(duration));
}

/**
 * Control characters other than line breaks. SMS are sent in PDU mode, so text never
 * reaches the AT command line as-is, but Ctrl-Z and ESC end or cancel a text-mode
 * AT+CMGS and have no place in a message anyway.
 */
// eslint-disable-next-line no-control-regex
const SMS_FORBIDDEN_CHARS = /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/;

/** SMS text; long messages are split into concatenated parts. Line breaks are allowed. */
export function smsText(b: Body): string {
  const text = optionalString(b, 'text');
  if (!text) throw badRequest('"text" is required');
  if (text.length > MAX_SMS_TEXT_LENGTH) {
    throw badRequest(`"text" must be at most ${MAX_SMS_TEXT_LENGTH} characters`);
  }
  if (SMS_FORBIDDEN_CHARS.test(text)) {
    throw badRequest('"text" must not contain control characters other than line breaks');
  }
  return text;
}

/** An SMS PDU is at most 176 octets including the SMSC address. */
const MAX_PDU_HEX_LENGTH = 2 * 176;

export function hexPdu(value: unknown, key: string): string {
  if (
    typeof value !== 'string' ||
    !SAFE_PROMPT_PAYLOAD.test(value) ||
    value.length > MAX_PDU_HEX_LENGTH
  ) {
    throw badRequest(`"${key}" must be a hex-encoded PDU`);
  }
  return value;
}

/**
 * What a modem can be addressed by: its ID, port path or name, IMEI, model or phone
 * number. Lookups never reach the modem, but the ID is echoed into logs and responses.
 */
const MODEM_ID = /^[A-Za-z0-9_.:+/-]{1,128}$/;

export function modemId(value: string, key = 'modem id'): string {
  if (!MODEM_ID.test(value)) {
    throw badRequest(`Invalid ${key}: use letters, digits and _ . : + / - only`);
  }
  return value;
}
