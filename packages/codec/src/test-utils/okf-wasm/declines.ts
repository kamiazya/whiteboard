/**
 * The OKF tests whose point is a value the Rust core cannot write, so the core
 * declines and the TypeScript answers (its own refusal, with the path the core
 * does not carry). Layer 1 fails any other test the core declined, and fails
 * an entry here whose test no longer provokes a decline, so a decline is
 * never absorbed by a global switch.
 *
 * The cases are the parity doc's "Declines" section
 * (docs/contributing/parity/okf-codec.md): a lone surrogate in the text, and an
 * unwritable value whose path the core loses.
 */
export const EXPECTED_DECLINES: ReadonlyMap<string, 'lone-surrogate' | 'unwritable-value'> =
  new Map([
    ['refuses a lone surrogate in the title with the typed error', 'lone-surrogate'],
    ['refuses a lone surrogate in a value with the typed error', 'lone-surrogate'],
    ['refuses a lone surrogate in a key with the typed error', 'lone-surrogate'],
    ['refuses a byte-order mark in a value with the typed error', 'unwritable-value'],
    ['refuses an integer past 2^53, naming the key', 'unwritable-value'],
    ['refuses an integer past 2^53 nested in a list, naming the key', 'unwritable-value'],
    ['throws a typed error naming the key when a facet value is not yaml-safe', 'unwritable-value'],
    [
      'rejects a preserved value that is not yaml-safe, like any other frontmatter value',
      'unwritable-value',
    ],
    ['names every offending key path in its message, joined by "; "', 'unwritable-value'],
    [
      'carries its own name, so a caller reading err.name can tell it from a serialiser defect',
      'unwritable-value',
    ],
  ])
