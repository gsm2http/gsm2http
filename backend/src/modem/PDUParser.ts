export interface ParsedPdu {
  sender: string;
  text: string;
  timestamp: string;
  isMultipart: boolean;
  refNumber?: number;
  totalParts?: number;
  partIndex?: number;
}

export interface EncodePduOptions {
  sender: string;
  text: string;
  timestamp?: Date;
  encoding?: '7bit' | 'ucs2';
  concat?: {
    refNumber: number;
    totalParts: number;
    partIndex: number;
    is16Bit?: boolean;
  };
}

// GSM 7-bit default alphabet, TS 23.038 §6.2.1.
const GSM_7BIT_DEFAULT = [
  '@',
  '£',
  '$',
  '¥',
  'è',
  'é',
  'ù',
  'ì',
  'ò',
  'Ç',
  '\n',
  'Ø',
  'ø',
  '\r',
  'Å',
  'å',
  'Δ',
  '_',
  'Φ',
  'Γ',
  'Λ',
  'Ω',
  'Π',
  'Ψ',
  'Σ',
  'Θ',
  'Ξ',
  '\x1B',
  'Æ',
  'æ',
  'ß',
  'É',
  ' ',
  '!',
  '"',
  '#',
  '¤',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '¡',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  'Ä',
  'Ö',
  'Ñ',
  'Ü',
  '§',
  '¿',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  'ä',
  'ö',
  'ñ',
  'ü',
  'à',
];

const GSM_7BIT_EXTENDED: Record<number, string> = {
  0x0a: '\f',
  0x14: '^',
  0x28: '{',
  0x29: '}',
  0x2f: '\\',
  0x3c: '[',
  0x3d: '~',
  0x3e: ']',
  0x40: '|',
  0x65: '€',
};

/** Positions where unpacked GSM 7-bit differs from ASCII, for decodeHexPayloadIfNeeded. */
const UNPACKED_GSM_LETTERS: Record<number, string> = {
  0x08: 'ò',
  0x5b: 'Ä',
  0x5c: 'Ö',
  0x5e: 'Ü',
  0x7b: 'ä',
  0x7c: 'ö',
  0x7e: 'ü',
};

const CHAR_TO_GSM: Record<string, number | { ext: number }> = {};
GSM_7BIT_DEFAULT.forEach((char, code) => {
  if (code !== 0x1b) CHAR_TO_GSM[char] = code;
});
for (const [codeStr, char] of Object.entries(GSM_7BIT_EXTENDED)) {
  CHAR_TO_GSM[char] = { ext: parseInt(codeStr, 10) };
}

/** Reads octets in order and fails with a field name when the PDU is cut short. */
class OctetReader {
  private pos = 0;

  constructor(private readonly bytes: number[]) {}

  public next(field: string): number {
    const byte = this.bytes[this.pos];
    if (byte === undefined) throw new Error(`Invalid PDU: truncated at ${field}`);
    this.pos++;
    return byte;
  }

  public take(count: number, field: string): number[] {
    if (this.pos + count > this.bytes.length) throw new Error(`Invalid PDU: truncated at ${field}`);
    const slice = this.bytes.slice(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  /** Like take(), but returns what is left when fewer octets remain (lenient for TP-OA). */
  public takeUpTo(count: number): number[] {
    const slice = this.bytes.slice(this.pos, this.pos + count);
    this.pos += slice.length;
    return slice;
  }

  public skip(count: number): void {
    this.pos += count;
  }

  public rest(): number[] {
    return this.bytes.slice(this.pos);
  }
}

const at = (bytes: number[], index: number): number => bytes[index] ?? 0;

// eslint-disable-next-line no-control-regex
const TRAILING_FILL = /[\x00@]+$/;

export class PDUParser {
  /** Decodes a hex SMS-DELIVER PDU (3GPP TS 23.040 §9.2.2.1), as read with AT+CMGR in PDU mode. */
  public static parse(rawHex: string): ParsedPdu {
    const hex = rawHex.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 4) {
      throw new Error(`PDU too short: ${rawHex}`);
    }

    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }
    const reader = new OctetReader(bytes);

    // Modems prepend the SMSC address (length octet, then type and digits).
    reader.skip(reader.next('SMSC length'));

    // TP-MTI is not checked: some modems list status reports with AT+CMGL=4, and decoding
    // them as best we can beats dropping them.
    const firstOctet = reader.next('first octet');
    const hasUdhi = (firstOctet & 0x40) !== 0;

    const addrLen = reader.next('TP-OA length');
    const toa = reader.next('TP-OA type');
    const sender = this.decodeAddress(reader, addrLen, toa);

    reader.next('TP-PID');
    const encoding = this.getEncoding(reader.next('TP-DCS'));
    const timestamp = this.decodeScts(reader.take(7, 'TP-SCTS'));
    const tpUdl = reader.next('TP-UDL');
    const tpUdBytes = reader.rest();

    let isMultipart = false;
    let refNumber: number | undefined;
    let totalParts: number | undefined;
    let partIndex: number | undefined;
    let udhl = 0;

    if (hasUdhi && tpUdBytes.length > 0) {
      udhl = at(tpUdBytes, 0);
      let iePos = 1;
      while (iePos < 1 + udhl && iePos < tpUdBytes.length) {
        const iei = at(tpUdBytes, iePos);
        const iedl = at(tpUdBytes, iePos + 1);
        const data = iePos + 2;

        if (iei === 0x00 && iedl >= 3) {
          // Concatenated SMS, 8-bit reference
          isMultipart = true;
          refNumber = at(tpUdBytes, data);
          totalParts = at(tpUdBytes, data + 1);
          partIndex = at(tpUdBytes, data + 2);
        } else if (iei === 0x08 && iedl >= 4) {
          // Concatenated SMS, 16-bit reference
          isMultipart = true;
          refNumber = (at(tpUdBytes, data) << 8) | at(tpUdBytes, data + 1);
          totalParts = at(tpUdBytes, data + 2);
          partIndex = at(tpUdBytes, data + 3);
        }

        iePos += 2 + iedl;
      }
    }

    let text: string;
    if (encoding === '7bit') {
      // TP-UDL counts septets, including those taken by the header. Text starts at the
      // next septet boundary after the header (fill bits pad the gap).
      const udhSeptets = hasUdhi ? Math.ceil(((1 + udhl) * 8) / 7) : 0;
      const septets = this.unpackSeptets(
        tpUdBytes,
        Math.max(0, tpUdl - udhSeptets),
        udhSeptets * 7,
      );
      text = this.decodeGsm7Bit(septets);
    } else {
      // For 8-bit and UCS-2, TP-UDL counts octets, including the header.
      const textBytes = tpUdBytes.slice(hasUdhi ? 1 + udhl : 0, tpUdl);
      text = encoding === 'ucs2' ? this.decodeUcs2(textBytes) : this.decode8Bit(textBytes);
    }

    text = this.decodeHexPayloadIfNeeded(text);

    return {
      sender,
      text,
      timestamp,
      isMultipart,
      refNumber,
      totalParts,
      partIndex,
    };
  }

  private static decodeAddress(reader: OctetReader, addrLen: number, toa: number): string {
    // TS 23.040 §9.1.2.5: the length counts useful semi-octets, for alphanumeric addresses too.
    const octets = reader.takeUpTo(Math.ceil(addrLen / 2));

    if ((toa & 0x70) === 0x50) {
      const septets = this.unpackSeptets(octets, Math.floor((addrLen * 4) / 7), 0);
      // Trailing fill bits decode as '@' (0x00); strip them.
      return this.decodeGsm7Bit(septets).replace(TRAILING_FILL, '').trim();
    }

    // Semi-octets are swapped within each octet; 0xF pads an odd digit count.
    let digits = '';
    for (const byte of octets) {
      const low = byte & 0x0f;
      const high = (byte >> 4) & 0x0f;
      if (digits.length < addrLen && low <= 9) digits += low.toString();
      if (digits.length < addrLen && high <= 9) digits += high.toString();
    }
    const isInternational = (toa & 0x70) === 0x10;
    return isInternational ? `+${digits}` : digits;
  }

  /**
   * If a message payload contains a raw hex-encoded ASCII/GSM string (e.g. from carrier quirks
   * or legacy firmware output), automatically decodes it to a readable string.
   */
  public static decodeHexPayloadIfNeeded(text: string): string {
    const clean = text.trim().replace(/\s+/g, '');
    if (!/^[0-9A-Fa-f]{16,}$/.test(clean) || clean.length % 2 !== 0) {
      return text;
    }

    // Attempt UCS-2 decoding if length is multiple of 4
    if (clean.length % 4 === 0) {
      const ucsBytes: number[] = [];
      for (let i = 0; i < clean.length; i += 2) {
        ucsBytes.push(parseInt(clean.slice(i, i + 2), 16));
      }
      const ucsCandidate = this.decodeUcs2(ucsBytes);
      let printable = 0;
      for (const c of ucsCandidate) {
        if (c.charCodeAt(0) >= 32 || c === '\n' || c === '\r') printable++;
      }
      if (printable / ucsCandidate.length > 0.85) {
        return ucsCandidate;
      }
    }

    // Otherwise read it as unpacked GSM 7-bit (one septet per octet): ASCII-compatible
    // except for a few positions, of which the Nordic/Baltic letters are the ones seen in
    // the wild.
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 2) {
      bytes.push(parseInt(clean.slice(i, i + 2), 16));
    }

    let gsmText = '';
    let printableCount = 0;
    for (const b of bytes) {
      const mapped = UNPACKED_GSM_LETTERS[b];
      if (mapped) {
        gsmText += mapped;
        printableCount++;
      } else {
        gsmText += String.fromCharCode(b);
        if ((b >= 32 && b <= 126) || b === 10 || b === 13) printableCount++;
      }
    }

    if (printableCount / bytes.length > 0.85) {
      return gsmText;
    }

    return text;
  }

  /**
   * Helper to unpack 7-bit septets from a byte array starting at a specific bit offset.
   */
  public static unpackSeptets(bytes: number[], count: number, bitOffset: number = 0): number[] {
    const septets: number[] = [];
    for (let i = 0; i < count; i++) {
      const bitStart = bitOffset + i * 7;
      const byteIdx = Math.floor(bitStart / 8);
      const bitInByte = bitStart % 8;

      if (byteIdx >= bytes.length) break;

      let septet = (at(bytes, byteIdx) >> bitInByte) & 0x7f;
      const bitsRemainingInByte = 8 - bitInByte;

      if (bitsRemainingInByte < 7 && byteIdx + 1 < bytes.length) {
        septet |= (at(bytes, byteIdx + 1) << bitsRemainingInByte) & 0x7f;
      }

      septets.push(septet & 0x7f);
    }
    return septets;
  }

  /**
   * Pack 7-bit septets into a byte array starting at a specific bit offset.
   */
  public static packSeptets(septets: number[], bitOffset: number = 0): number[] {
    const totalBits = bitOffset + septets.length * 7;
    const totalBytes = Math.ceil(totalBits / 8);
    const bytes = new Array<number>(totalBytes).fill(0);

    for (let i = 0; i < septets.length; i++) {
      const bitStart = bitOffset + i * 7;
      const byteIdx = Math.floor(bitStart / 8);
      const bitInByte = bitStart % 8;
      const septet = at(septets, i) & 0x7f;

      bytes[byteIdx] = at(bytes, byteIdx) | ((septet << bitInByte) & 0xff);
      const bitsRemainingInByte = 8 - bitInByte;
      if (bitsRemainingInByte < 7 && byteIdx + 1 < totalBytes) {
        bytes[byteIdx + 1] = at(bytes, byteIdx + 1) | ((septet >> bitsRemainingInByte) & 0xff);
      }
    }
    return bytes;
  }

  /**
   * Decodes an array of GSM 7-bit septets into a JavaScript string.
   */
  public static decodeGsm7Bit(septets: number[]): string {
    let result = '';
    let isEscaped = false;

    for (const septet of septets) {
      if (isEscaped) {
        result += GSM_7BIT_EXTENDED[septet] ?? GSM_7BIT_DEFAULT[septet] ?? '?';
        isEscaped = false;
      } else if (septet === 0x1b) {
        isEscaped = true;
      } else {
        result += GSM_7BIT_DEFAULT[septet] ?? '?';
      }
    }
    return result;
  }

  /**
   * Decodes UCS-2 / UTF-16 BE bytes into a JavaScript string.
   */
  public static decodeUcs2(bytes: number[]): string {
    let result = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code1 = (at(bytes, i) << 8) | at(bytes, i + 1);
      // UCS-2 proper has no surrogates, but phones send UTF-16 so emoji survive.
      if (code1 >= 0xd800 && code1 <= 0xdbff && i + 3 < bytes.length) {
        const code2 = (at(bytes, i + 2) << 8) | at(bytes, i + 3);
        if (code2 >= 0xdc00 && code2 <= 0xdfff) {
          result += String.fromCodePoint(((code1 - 0xd800) << 10) + (code2 - 0xdc00) + 0x10000);
          i += 2;
          continue;
        }
      }
      result += String.fromCharCode(code1);
    }
    return result;
  }

  /** Decodes 8-bit user data as UTF-8, or as Latin-1 when it isn't valid UTF-8. */
  public static decode8Bit(bytes: number[]): string {
    const buf = Uint8Array.from(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('latin1').decode(buf);
    }
  }

  /**
   * Classifies TP-DCS byte into character encoding scheme.
   */
  private static getEncoding(dcs: number): '7bit' | '8bit' | 'ucs2' {
    const group = (dcs >> 4) & 0x0f;
    if (group <= 0x03) {
      // General Data Coding scheme
      const alphabet = (dcs >> 2) & 0x03;
      if (alphabet === 0x00) return '7bit';
      if (alphabet === 0x01) return '8bit';
      if (alphabet === 0x02) return 'ucs2';
      return '7bit';
    }
    if (group >= 0x04 && group <= 0x07) {
      // Automatic deletion group
      const alphabet = (dcs >> 2) & 0x03;
      if (alphabet === 0x02) return 'ucs2';
      if (alphabet === 0x01) return '8bit';
      return '7bit';
    }
    if (group === 0x0e) {
      // UCS2 Message Waiting Indication
      return 'ucs2';
    }
    if (group === 0x0f) {
      // Data coding / message class
      return (dcs & 0x04) === 0x04 ? '8bit' : '7bit';
    }
    // General fallback check on bits 3-2
    const alphabet = (dcs >> 2) & 0x03;
    if (alphabet === 0x02) return 'ucs2';
    if (alphabet === 0x01) return '8bit';
    return '7bit';
  }

  /**
   * Decodes Service Centre Time Stamp (7 semi-octet bytes) into ISO 8601 string.
   */
  private static decodeScts(bytes: number[]): string {
    // Each octet holds two BCD digits with the semi-octets swapped.
    const bcd = (i: number) => (at(bytes, i) & 0x0f) * 10 + ((at(bytes, i) >> 4) & 0x0f);
    const yrNum = bcd(0);
    const fullYear = yrNum >= 70 ? 1900 + yrNum : 2000 + yrNum;
    const pad = (n: number) => String(n).padStart(2, '0');
    const month = pad(bcd(1));
    const day = pad(bcd(2));
    const hour = pad(bcd(3));
    const minute = pad(bcd(4));
    const second = pad(bcd(5));

    // Time zone offset in quarter hours; bit 3 of the swapped octet is the sign.
    const tzByte = at(bytes, 6);
    const isNegative = (tzByte & 0x08) !== 0;
    const tzTens = tzByte & 0x07;
    const tzUnits = (tzByte >> 4) & 0x0f;
    const quarters = tzTens * 10 + tzUnits;
    const totalMinutes = quarters * 15;
    const tzH = Math.floor(totalMinutes / 60);
    const tzM = totalMinutes % 60;
    const tzSign = isNegative ? '-' : '+';
    const tzStr = `${tzSign}${String(tzH).padStart(2, '0')}:${String(tzM).padStart(2, '0')}`;
    const isoStr = `${fullYear}-${month}-${day}T${hour}:${minute}:${second}${tzStr}`;

    const parsedTime = Date.parse(isoStr);
    if (!isNaN(parsedTime)) {
      return isoStr;
    }
    return new Date().toISOString();
  }

  /**
   * Utility to encode an SMS-DELIVER PDU hex string.
   * Useful for testing, mocks, and hardware simulation.
   */
  public static encodeDeliverPdu(options: EncodePduOptions): string {
    const bytes: number[] = [];

    // 1. SMSC Length: 00 (no SMSC info prepended)
    bytes.push(0x00);

    // 2. First Octet: TP-MTI = 00 (SMS-DELIVER), TP-UDHI = (options.concat ? 0x40 : 0x00)
    const hasUdhi = !!options.concat;
    bytes.push(0x04 | (hasUdhi ? 0x40 : 0x00)); // TP-MMS = 1 (no more messages) + UDHI

    // 3. Sender (TP-OA)
    bytes.push(...this.encodeAddress(options.sender));

    // 4. TP-PID
    bytes.push(0x00);

    // 5. Encoding & TP-DCS
    const encoding = options.encoding ?? this.pickEncoding(options.text);
    bytes.push(encoding === 'ucs2' ? 0x08 : 0x00);

    // 6. TP-SCTS (timestamp)
    const date = options.timestamp || new Date();
    const yr = date.getUTCFullYear() % 100;
    const mo = date.getUTCMonth() + 1;
    const da = date.getUTCDate();
    const hr = date.getUTCHours();
    const mi = date.getUTCMinutes();
    const se = date.getUTCSeconds();

    const encodeBcd = (num: number) => {
      const tens = Math.floor(num / 10);
      const units = num % 10;
      return tens | (units << 4);
    };

    bytes.push(encodeBcd(yr));
    bytes.push(encodeBcd(mo));
    bytes.push(encodeBcd(da));
    bytes.push(encodeBcd(hr));
    bytes.push(encodeBcd(mi));
    bytes.push(encodeBcd(se));
    bytes.push(0x00); // GMT +0

    // 7. TP-UDL & TP-UD (with concatenation UDH)
    bytes.push(...this.encodeUserData(options.text, encoding, this.concatUdh(options.concat)));

    return this.toHex(bytes);
  }

  /**
   * Encodes an outgoing message as one or more SMS-SUBMIT PDUs (3GPP TS 23.040 §9.2.2.2),
   * splitting into concatenated parts when it does not fit a single SMS.
   * Each part is ready for `AT+CMGS=<tpduLength>` followed by `<pdu><Ctrl-Z>`.
   */
  public static encodeSubmitPdus(options: EncodeSubmitOptions): SubmitPdu[] {
    const recipient = options.recipient.trim();
    if (!/^\+?\d{1,20}$/.test(recipient)) {
      throw new Error(`Invalid recipient number: ${options.recipient}`);
    }

    const encoding = options.encoding ?? this.pickEncoding(options.text);
    const chunks = this.splitForSms(options.text, encoding);
    const refNumber = options.refNumber ?? Math.floor(Math.random() * 256);

    return chunks.map((chunk, i) => {
      const concat =
        chunks.length > 1 ? { refNumber, totalParts: chunks.length, partIndex: i + 1 } : undefined;

      const bytes: number[] = [];
      bytes.push(0x00); // SMSC length: use the SMSC stored on the SIM
      bytes.push(0x01 | 0x10 | (concat ? 0x40 : 0x00)); // TP-MTI = SMS-SUBMIT, TP-VPF = relative, TP-UDHI
      bytes.push(0x00); // TP-MR: assigned by the modem
      bytes.push(...this.encodeAddress(recipient));
      bytes.push(0x00); // TP-PID
      bytes.push(encoding === 'ucs2' ? 0x08 : 0x00); // TP-DCS
      bytes.push(0xaa); // TP-VP: 4 days
      bytes.push(...this.encodeUserData(chunk, encoding, this.concatUdh(concat)));

      return { pdu: this.toHex(bytes), tpduLength: bytes.length - 1 };
    });
  }

  private static toHex(bytes: number[]): string {
    return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  }

  /** UCS-2 if any character is outside the GSM 7-bit alphabet. */
  private static pickEncoding(text: string): '7bit' | 'ucs2' {
    for (const char of text) {
      if (CHAR_TO_GSM[char] === undefined) return 'ucs2';
    }
    return '7bit';
  }

  private static toSeptets(text: string): number[] {
    const septets: number[] = [];
    for (const char of text) {
      const mapping = CHAR_TO_GSM[char] ?? 0x3f;
      if (typeof mapping === 'number') {
        septets.push(mapping);
      } else {
        septets.push(0x1b, mapping.ext);
      }
    }
    return septets;
  }

  /** Address field (length, type of address, value) for TP-OA / TP-DA. */
  private static encodeAddress(address: string): number[] {
    const bytes: number[] = [];
    const clean = address.trim();
    const isPlus = clean.startsWith('+');
    const digitsOnly = clean.replace(/\D/g, '');

    if (digitsOnly.length > 0 && clean.replace(/^\+/, '') === digitsOnly) {
      // Numeric address
      bytes.push(digitsOnly.length); // number of digits
      bytes.push(isPlus ? 0x91 : 0x81); // 0x91 = international, 0x81 = unknown
      for (let i = 0; i < digitsOnly.length; i += 2) {
        const low = Number(digitsOnly[i]);
        const high = i + 1 < digitsOnly.length ? Number(digitsOnly[i + 1]) : 0x0f;
        bytes.push(low | (high << 4));
      }
    } else {
      // Alphanumeric address
      const septets = this.toSeptets(clean);
      const packed = this.packSeptets(septets, 0);
      // In 3GPP TS 23.040, addrLen for alphanumeric is the number of semi-octets (nibbles)
      const semiOctets = Math.ceil((septets.length * 7) / 4);
      bytes.push(semiOctets);
      bytes.push(0xd0); // Alphanumeric TOA
      bytes.push(...packed);
    }
    return bytes;
  }

  private static concatUdh(concat?: EncodePduOptions['concat']): number[] {
    if (!concat) return [];
    if (concat.is16Bit) {
      return [
        0x06, // UDHL = 6 (IEI 0x08 + IEDL 4 + 4 bytes data)
        0x08, // IEI 0x08
        0x04, // IEDL = 4
        (concat.refNumber >> 8) & 0xff,
        concat.refNumber & 0xff,
        concat.totalParts & 0xff,
        concat.partIndex & 0xff,
      ];
    }
    return [
      0x05, // UDHL = 5 (IEI 0x00 + IEDL 3 + 3 bytes data)
      0x00, // IEI 0x00
      0x03, // IEDL = 3
      concat.refNumber & 0xff,
      concat.totalParts & 0xff,
      concat.partIndex & 0xff,
    ];
  }

  /** TP-UDL followed by TP-UD (UDH + text). */
  private static encodeUserData(
    text: string,
    encoding: '7bit' | 'ucs2',
    udhBytes: number[],
  ): number[] {
    const bytes: number[] = [];

    if (encoding === 'ucs2') {
      const textBytes: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        textBytes.push((code >> 8) & 0xff, code & 0xff);
      }
      bytes.push(udhBytes.length + textBytes.length);
      bytes.push(...udhBytes);
      bytes.push(...textBytes);
      return bytes;
    }

    // 7-bit
    const septets = this.toSeptets(text);
    if (udhBytes.length > 0) {
      const udhSeptets = Math.ceil((udhBytes.length * 8) / 7);
      bytes.push(udhSeptets + septets.length);

      // Pack text septets starting after udhSeptets * 7 bits
      const packed = this.packSeptets(septets, udhSeptets * 7);

      // Merge UDH bytes into front of packed bytes
      udhBytes.forEach((byte, i) => (packed[i] = byte));
      bytes.push(...packed);
    } else {
      bytes.push(septets.length);
      bytes.push(...this.packSeptets(septets, 0));
    }
    return bytes;
  }

  /**
   * Splits text into SMS-sized chunks: 160 septets / 70 UCS-2 units for a single SMS,
   * 153 / 67 per part when a concatenation header is needed. Never splits a GSM escape
   * sequence or a UTF-16 surrogate pair.
   */
  private static splitForSms(text: string, encoding: '7bit' | 'ucs2'): string[] {
    if (encoding === 'ucs2') {
      if (text.length <= 70) return [text];
      const chunks: string[] = [];
      let i = 0;
      while (i < text.length) {
        let end = Math.min(i + 67, text.length);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
        chunks.push(text.slice(i, end));
        i = end;
      }
      return chunks;
    }

    if (this.toSeptets(text).length <= 160) return [text];
    const chunks: string[] = [];
    let current = '';
    let currentSeptets = 0;
    for (const char of text) {
      const size = this.toSeptets(char).length;
      if (currentSeptets + size > 153) {
        chunks.push(current);
        current = '';
        currentSeptets = 0;
      }
      current += char;
      currentSeptets += size;
    }
    if (current) chunks.push(current);
    return chunks;
  }
}

export interface EncodeSubmitOptions {
  /** Destination number, digits with optional leading '+'. */
  recipient: string;
  text: string;
  encoding?: '7bit' | 'ucs2';
  /** Concatenation reference for multipart messages; random if omitted. */
  refNumber?: number;
}

export interface SubmitPdu {
  /** Hex PDU including the leading SMSC length octet (00). */
  pdu: string;
  /** Octet count excluding the SMSC part: the <length> argument of AT+CMGS. */
  tpduLength: number;
}
