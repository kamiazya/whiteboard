/**
 * The OKF tests layer 1 does not run against the Rust core, each because its
 * only assertion reads the WORDS of a refusal at stage `yaml` — the
 * difference `OKF_TOLERATED_DIFFERENCES['yaml-refusal-message']` tolerates
 * (owner decision q25). Everything else such a refusal says (its stage, and
 * that it is a refusal at all) the live differential holds exactly.
 *
 * Exact titles, not patterns. `tolerated.rust.test.ts` fails on a title no
 * OKF test carries any more, and on one whose test no longer reads a
 * message, so an entry cannot outlive the test it names.
 */
export const TOLERATED_TESTS: readonly {
  readonly file: string
  /** The title as the source writes it, a template for an `it.each`. */
  readonly source: string
  /** The names it runs under. */
  readonly titles: readonly string[]
}[] = [
  {
    file: 'parse.test.ts',
    source: 'reads %s 32 levels deep and refuses 33 at stage yaml',
    titles: [
      'reads mappings 32 levels deep and refuses 33 at stage yaml',
      'reads lists 32 levels deep and refuses 33 at stage yaml',
    ],
  },
  {
    file: 'parse.test.ts',
    source: 'counts block-style nesting the same way',
    titles: ['counts block-style nesting the same way'],
  },
  {
    file: 'parse.test.ts',
    source: 'still writes a stored frontmatter nested deeper, and names the depth on re-import',
    titles: ['still writes a stored frontmatter nested deeper, and names the depth on re-import'],
  },
  {
    file: 'frontmatter-subset.test.ts',
    source: 'reports a refusal through parseOkf as a yaml-stage failure',
    titles: ['reports a refusal through parseOkf as a yaml-stage failure'],
  },
  {
    file: 'serialize.test.ts',
    source: 'never parses %s, so the store cannot be handed a Set, Map or bytes',
    titles: ['a !!set', 'an !!omap', 'a !!binary'].map(
      (tag) => `never parses ${tag}, so the store cannot be handed a Set, Map or bytes`,
    ),
  },
]

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every test name but those above: `setup.ts` skips the rest. */
export const runsUnderRust = new RegExp(
  `^(?!.*(?:${TOLERATED_TESTS.flatMap((t) => t.titles.map((title) => `${escapeRegExp(title)}$`)).join('|')}))`,
)
