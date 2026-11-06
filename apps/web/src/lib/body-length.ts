/** Ideographs and kana, and Hangul: scripts a word count cannot segment by spaces. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const WORD = /[\p{L}\p{N}]+/gu
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/**
 * How long a note's body is, in the unit its writer counts in.
 *
 * Words are runs of letters and digits, so markup and punctuation do not
 * count. That says nothing useful about Japanese or Chinese, which are not
 * written with spaces: a sentence is one "word" per change of script. When
 * the body holds more CJK characters than other words, it is counted in
 * characters (letters and digits, every script) instead — the unit a
 * Japanese writer's own tools report.
 */
export function bodyLengthLabel(value: string): string {
  const cjk = value.match(CJK)?.length ?? 0
  const words = value.replace(CJK, ' ').match(WORD)?.length ?? 0
  if (cjk > words) return plural(value.match(LETTER_OR_DIGIT)?.length ?? 0, 'character')
  return plural(words, 'word')
}
