/** SIM PINs are 4–8 digits (3GPP TS 31.101); the server rejects anything else. */
export const isValidPin = (pin: string) => /^\d{4,8}$/.test(pin);
