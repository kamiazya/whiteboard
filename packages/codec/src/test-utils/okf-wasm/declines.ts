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
export type DeclineCase = 'lone-surrogate' | 'unwritable-value'

/**
 * What each case looks like when the core declines it: the serialiser, and the
 * reason it gives. An allowed test whose decline reads otherwise fails, so an
 * entry excuses the decline it names and no other.
 */
export const DECLINE_SHAPE: Readonly<Record<DeclineCase, { fn: string; reason: RegExp }>> = {
  'lone-surrogate': { fn: 'serializeOkf', reason: /refused its input: malformed$/ },
  'unwritable-value': { fn: 'serializeOkf', reason: /has no YAML spelling: / },
}

/** The suite every entry below names a test of. */
export const DECLINES_FILE = 'src/okf/serialize.test.ts'

export const EXPECTED_DECLINES: ReadonlyMap<string, DeclineCase> = new Map([
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
