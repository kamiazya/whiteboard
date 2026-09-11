/**
 * The shortcode vocabulary: a CLDR short name turned into the name a person
 * types between colons (user decision, 2026-09-11).
 *
 * `grinning face` -> `grinning_face`, `thumbs up` -> `thumbs_up`,
 * `flag: Japan` -> `flag_japan`. DERIVED rather than stored, because a slug
 * is a pure function of a name the generated table already carries — a
 * fourth column would be 28KB and a second place for the same fact to be
 * written differently.
 *
 * It is deliberately not GitHub's set. GitHub spells 👍 `:+1:` and `:thumbsup:`,
 * which is a second vendored table with its own coverage story and its own
 * drift; CLDR's names cover all 1914 rows, come with the data, and need no
 * curation. What is lost is muscle memory for a handful of shortcodes, and
 * the search finds those by name anyway.
 *
 * The symbol map is what keeps slugs UNIQUE, and it was found by measuring
 * rather than by reading: stripping punctuation outright collides
 * `keycap: #` with `keycap: *`, both landing on `keycap`. A shortcode that
 * names two emoji is the one defect this vocabulary must not have, so the
 * two characters that carry meaning are spelled out and
 * `catalog.test.ts` asserts every slug is distinct — over the whole table,
 * so a future Unicode release that introduces a collision fails the suite
 * instead of shipping an ambiguous `:name:`.
 */

const SYMBOL: Readonly<Record<string, string>> = {
  '#': 'hash',
  '*': 'asterisk',
  '&': 'and',
  '+': 'plus',
}

export function emojiSlug(name: string): string {
  return (
    name
      .toLowerCase()
      // An apostrophe JOINS: `man’s shoe` is `mans_shoe`, not `man_s_shoe`.
      // Both spellings appear in the data, so both are handled.
      .replace(/[’']/g, '')
      .replace(/[#*&+]/g, (char) => ` ${SYMBOL[char]} `)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  )
}
