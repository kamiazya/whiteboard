/**
 * Byte and bit widths the browser and the read plane must agree on, declared
 * once: a writer and a reader holding their own copy of a width disagree
 * silently the day one changes, and the failure is a key that does not open
 * what it sealed.
 */

/** What WebAuthn's `prf` extension produces for one `eval` input. */
export const PRF_OUTPUT_BYTES = 32

/** The AES-256 keys HKDF derives, for the wrapping key and each document key alike. */
export const DERIVED_KEY_BITS = 256
