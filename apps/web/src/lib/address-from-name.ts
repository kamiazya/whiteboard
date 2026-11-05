import {
  type DocumentKind,
  deriveWorkspaceSegment,
  documentPathSchema,
  pathBelow,
} from '@kamiazya/whiteboard-model'

/** What an address is made for: a document of a kind, or a folder. */
export type AddressedKind = DocumentKind | 'folder'

/**
 * The word an address falls back to when its name has no Latin spelling — a
 * name in Japanese, say, or one that is only emoji. It says what the thing IS,
 * because `untitled` beside a name somebody typed reads as the name being lost.
 */
const FALLBACK_LEAF: Readonly<Record<AddressedKind, string>> = {
  markdown: 'note',
  spatial: 'canvas',
  folder: 'folder',
}

/**
 * The segment a typed name earns before any sibling is consulted: the
 * workspace segment rule (`deriveWorkspaceSegment` — Latin transliterated,
 * everything else a hyphen), or the kind's own word when that yields nothing.
 */
export function addressBaseFor(name: string, kind: AddressedKind): string {
  return deriveWorkspaceSegment(name) ?? FALLBACK_LEAF[kind]
}

/**
 * The first of `base`, `base-2`, `base-3`… that nothing directly under
 * `folder` holds, joined onto `folder`.
 *
 * A path deeper down holds its first segment too: `q3/hiring/plan` is why
 * `hiring` is taken under `q3`, so a new document cannot take a folder's
 * address and a new folder cannot take a document's. Numbered from `-2`
 * because the unsuffixed address IS the first one.
 */
function freePathIn(folder: string, base: string, existingPaths: readonly string[]): string {
  const siblings = new Set(
    existingPaths.flatMap((path) => {
      const rest = pathBelow(folder, path)
      return rest === undefined ? [] : [rest.split('/')[0] ?? rest]
    }),
  )
  let leaf = base
  for (let n = 2; siblings.has(leaf); n++) leaf = `${base}-${n}`
  return folder === '' ? leaf : `${folder}/${leaf}`
}

/**
 * The address something called `name` gets inside `folder`, numbered past
 * its siblings. A derived segment that would push the whole path past the
 * path bound gives way to the kind's word, which is short.
 */
export function addressForNameIn(
  folder: string,
  name: string,
  kind: AddressedKind,
  existingPaths: readonly string[],
): string {
  const derived = addressBaseFor(name, kind)
  const joined = folder === '' ? derived : `${folder}/${derived}`
  const base = documentPathSchema.safeParse(joined).success ? derived : FALLBACK_LEAF[kind]
  return freePathIn(folder, base, existingPaths)
}
