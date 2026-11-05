import { WORKSPACE_SEGMENT_MAX_LENGTH, workspaceSegmentSchema } from './ids.js'

/**
 * Latin letters that are letters in their own right rather than a base letter
 * plus a mark, so NFKD leaves them whole. Without this table `Straße` would
 * come out `stra-e`: dropping a letter is how `Équipe` once became `quipe`.
 */
const LATIN_LETTER_SPELLINGS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
  ħ: 'h',
  ŋ: 'ng',
}
const LATIN_LETTER = new RegExp(`[${Object.keys(LATIN_LETTER_SPELLINGS).join('')}]`, 'g')

/**
 * The ASCII a Latin-script name spells: accents dropped from their letter
 * (`É` → `e`), full-width and ligature forms folded (`Ｑ` → `q`, `ﬁ` → `fi`),
 * and the table's letters spelled out. Lower-cased FIRST, because `İ`
 * lower-cases to `i` plus a combining dot, which the mark strip then removes.
 * A script with no Latin spelling (Japanese, emoji) passes through untouched
 * for the collapse below to drop.
 */
function transliterateLatin(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(LATIN_LETTER, (letter) => LATIN_LETTER_SPELLINGS[letter] ?? letter)
}

/**
 * The address a workspace's display name yields, or `undefined` when it
 * yields none.
 *
 * ONE rule, because both keepers mint a workspace and a derivation that
 * differed between them would put the same name at two addresses. It lives in
 * model rather than beside either caller for the reason `workspaceHandle` and
 * `workspaceLabel` were pulled together: a per-site copy does not disagree
 * loudly, it disagrees quietly.
 *
 * Absent is a real answer, not a failure to try. A name written in a script
 * the segment charset cannot spell produces nothing, and ADR-0019 already
 * settled what to do about that — its migration left a legacy segment NULL
 * rather than writing a mangled approximation, and a workspace with no segment
 * is addressed by its canonical id, which is exactly why that layer stays
 * resolvable. An invented `workspace-2` would be a name nobody chose, sitting
 * in the URL for as long as the workspace lives.
 *
 * Uniqueness is NOT decided here and cannot be: what makes a segment
 * unavailable is another row holding it, which only the keeper's registry
 * knows. Callers take this candidate and ask their own registry.
 */
export function deriveWorkspaceSegment(displayName: string): string | undefined {
  // The trims take no `+`, and that is a statement rather than a shortcut: the
  // collapse replaces each maximal RUN of non-alphanumerics with one dash, so
  // the candidate can never hold two adjacent dashes and at most one can be
  // leading or trailing. Writing `^-+|-+$` claimed a run might be there — a
  // claim CodeQL reads, correctly, as polynomial backtracking on a name that
  // arrives in a request body.
  //
  // Cut to the bound before the trailing trim, since a letter the table
  // spells as two can lengthen a name the length bound admitted, and the cut
  // can land just after a dash.
  const candidate = transliterateLatin(displayName)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .slice(0, WORKSPACE_SEGMENT_MAX_LENGTH)
    .replace(/-$/, '')
  return workspaceSegmentSchema.safeParse(candidate).success ? candidate : undefined
}
