/**
 * A real-world shape: a four-part UCS-2 delivery notice whose split points fall mid-word
 * and mid-URL, because the sender cuts at 67 UCS-2 characters regardless of content.
 */
export const MULTIPART_UCS2_SEGMENTS = [
  'Tervi',
  'tame! Sinu pakk on teel ja jõuab kohale homme. Jälgi saadetist ning',
  ' vaata lisainfot meie äpis või veebilehel:w',
  'ww.example.com/track',
] as const;

export const MULTIPART_UCS2_TEXT = MULTIPART_UCS2_SEGMENTS.join('');

/** The sender of the fixture above: a short code. */
export const MULTIPART_UCS2_SENDER = '123';
