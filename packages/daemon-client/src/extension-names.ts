/**
 * The two names the browser checks when the whiteboard extension starts its
 * native host (ADR-0050). Apart from the bridge's schemas so the extension,
 * which relays without reading, carries no validator it never runs.
 */

/** The native messaging host's name, as the browser looks it up. */
export const NATIVE_HOST_NAME = 'io.github.kamiazya.whiteboard'

/** The extension's id, fixed by the public key in its manifest. */
export const WHITEBOARD_EXTENSION_ID = 'ckgipndlpblkhiplhnbbdnpnibflplje'
