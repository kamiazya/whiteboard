import { documentIdSchema } from '@kamiazya/whiteboard-model'

/**
 * What `scanReferences` cannot read back inside the bracket pair:
 *
 * - `]` anywhere. The scanner stops a target at the first `]` or `|` and an
 *   alias at the first `]`, and accepts the reference only when the next
 *   character is another `]` — so one stray bracket either kills the
 *   reference or truncates it and leaves the rest as literal text.
 * - A line break, which cannot sit inside an inline reference.
 *
 * The scanner knows no escape, so none is invented here: a half that cannot
 * be written is refused rather than disguised.
 */
const UNWRITABLE = /[\]\r\n]/

/**
 * `|` ends a target, and `#` begins its fragment — both change what the
 * scanner reads as the target. In an alias they are ordinary text.
 */
const UNWRITABLE_AS_TARGET = /[|#]/

/**
 * The WRITER of the reference grammar `scanReferences` reads: `[[target]]`, or
 * `[[target|alias]]` when an alias is given. Every producer of this markup goes
 * through it, so what may sit in the brackets is decided where the reader is.
 *
 * Answers `undefined` when `target` or `alias` is something the scanner would
 * misread — never markup that reads back as a different (shorter) reference.
 * The caller chooses the fallback, because only it knows whether an alias is
 * dispensable (it is a label) and whether another address exists (an id).
 * An empty alias is no alias.
 *
 * The target is written verbatim, so its meaning to a resolver is the
 * caller's: a path shaped exactly like a document id reads as that id.
 * `documentReferenceMarkup` is the writer that handles it.
 */
export function referenceMarkup(parts: {
  readonly target: string
  readonly alias?: string | undefined
}): string | undefined {
  const { target, alias } = parts
  if (target === '' || UNWRITABLE.test(target) || UNWRITABLE_AS_TARGET.test(target)) {
    return undefined
  }
  if (alias === undefined || alias === '') return `[[${target}]]`
  return UNWRITABLE.test(alias) ? undefined : `[[${target}|${alias}]]`
}

/**
 * The markup that links to a document: its PATH, which is the written form
 * (display names are retired from resolution, and a bare `[[path]]` is labeled
 * with the target's current display name at render time), or its id when the
 * path cannot be written or would read as a different id — ids resolve first,
 * so the id spelling is the one nothing can shadow.
 *
 * `label` is the prose to display instead of that name. A label the scanner
 * cannot read, or one that repeats the path, is dropped rather than written:
 * it is only a label, and the bare reference shows the same name. When the
 * path cannot be written the id form carries `label`, or else the `name`, so
 * the opaque id still reads as something.
 */
export function documentReferenceMarkup(
  subject: { readonly id: string; readonly path: string; readonly name?: string | undefined },
  label?: string | undefined,
): string {
  const wanted = label === undefined || label === '' ? undefined : label
  if (!documentIdSchema.safeParse(subject.path).success) {
    const byPath = referenceMarkup({
      target: subject.path,
      alias: wanted === subject.path ? undefined : wanted,
    })
    if (byPath !== undefined) return byPath
    const bare = referenceMarkup({ target: subject.path })
    if (bare !== undefined) return bare
  }
  return (
    referenceMarkup({ target: subject.id, alias: wanted ?? subject.name }) ??
    referenceMarkup({ target: subject.id }) ??
    // An id never holds a bracket, so the arm above cannot refuse; this one
    // only gives the type an answer without a cast.
    `[[${subject.id}]]`
  )
}
