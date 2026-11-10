/**
 * The OKF tests whose point is a value the Rust core cannot write, so the core
 * declines and the TypeScript answers (its own refusal, with the path the core
 * does not carry). Layer 1 fails any other test the core declined, and fails
 * an entry here whose test no longer provokes a decline, so a decline is
 * never absorbed by a global switch.
 *
 * The case names are the parity doc's "Declines" section
 * (docs/contributing/parity/okf-codec.md): P1 a lone surrogate in the text,
 * S4 an unwritable value whose path the core loses.
 */
export const EXPECTED_DECLINES: ReadonlyMap<string, 'P1' | 'S4'> = new Map([
  ['refuses a lone surrogate in the title with the typed error', 'P1'],
  ['refuses a lone surrogate in a value with the typed error', 'P1'],
  ['refuses a lone surrogate in a key with the typed error', 'P1'],
  ['refuses a byte-order mark in a value with the typed error', 'S4'],
  ['refuses an integer past 2^53, naming the key', 'S4'],
  ['refuses an integer past 2^53 nested in a list, naming the key', 'S4'],
  ['throws a typed error naming the key when a facet value is not yaml-safe', 'S4'],
  ['rejects a preserved value that is not yaml-safe, like any other frontmatter value', 'S4'],
  ['names every offending key path in its message, joined by "; "', 'S4'],
  ['carries its own name, so a caller reading err.name can tell it from a serialiser defect', 'S4'],
])
